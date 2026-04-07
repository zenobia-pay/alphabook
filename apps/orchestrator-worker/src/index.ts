import { createD1Db } from "@alphabook/db";
import {
  buildPlannerPrompt,
  buildRouterPrompt,
  buildSynthesizerPrompt,
  getImplementationConfig,
} from "@alphabook/implementations";
import type { ChatRequest } from "@alphabook/shared";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

import { createApp, finalizeStaleRun, reapExpiredRuntimeInstances, reapStaleRuns, runOrchestrator, type ActiveRunState, type AppDeps, type ResearchTaskQueueMessage } from "./app";
import { WorkOSAuth } from "./auth";
import { createBillingService } from "./billing";
import { GoogleAIEmbedder, OpenAIEmbedder } from "./embeddings";
import { createSemanticSearchJob, fetchHermesArtifact, fetchHermesJob, fetchHermesJobLogs } from "./hermes-job-client";
import { OpenAIPlanner } from "./planner";
import { CloudflareR2Store } from "./r2";
import { OpenAIRouter } from "./router";
import { FlyMachinesRuntimeGateway, HttpRuntimeGateway } from "./runtime";
import { AlphaloopSemanticSearchService, Context1SemanticSearchService, DelegatingSemanticSearchService } from "./semantic-search";
import { D1AppStore } from "./d1-store";
import type { AppStore } from "./store";
import { OpenAISynthesizer } from "./synthesizer";
import { CloudflareVectorizeIndex, QdrantVectorIndex, type VectorSearchIndex } from "./vectorize";

const RESEARCH_TASK_LEASE_MS = 90_000;
const RESEARCH_TASK_LEASE_RENEW_INTERVAL_MS = 30_000;
const REMOTE_SEMANTIC_JOB_POLL_INTERVAL_MS = 1_500;

export interface WorkersAiBinding {
  run<ModelInput extends Record<string, unknown>, ModelOutput = unknown>(
    model: string,
    input: ModelInput,
    options?: Record<string, unknown>,
  ): Promise<ModelOutput>;
}

export interface Env {
  APP_DB: D1Database;
  ORIGIN_PROXY_URL?: string;
  AI?: WorkersAiBinding;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_SYNTH_MODEL?: string;
  HERMES_JOB_API_URL?: string;
  HERMES_JOB_API_TOKEN?: string;
  SEMANTIC_JOB_API_URL?: string;
  SEMANTIC_JOB_API_TOKEN?: string;
  HERMES_MODEL?: string;
  HERMES_MAX_TURNS?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  OPENAI_EMBEDDING_DIMENSIONS?: string;
  EMBEDDING_PROVIDER?: string;
  GOOGLE_AI_API_KEY?: string;
  GOOGLE_EMBEDDING_MODEL?: string;
  GOOGLE_EMBEDDING_DIMENSIONS?: string;
  VECTOR_PROVIDER?: string;
  QDRANT_URL?: string;
  QDRANT_API_KEY?: string;
  QDRANT_COLLECTION?: string;
  QDRANT_QUERY_TIMEOUT_MS?: string;
  CONTEXT1_BASE_URL?: string;
  CONTEXT1_API_KEY?: string;
  CONTEXT1_MODEL?: string;
  CONTEXT1_MAX_TURNS?: string;
  CONTEXT1_TOTAL_TOKEN_BUDGET?: string;
  CONTEXT1_SOFT_TOKEN_BUDGET?: string;
  CONTEXT1_HARD_TOKEN_BUDGET?: string;
  CONTEXT1_PER_TOOL_TOKEN_BUDGET?: string;
  RUNTIME_TOOL_TIMEOUT_SECONDS?: string;
  TOOL_STREAM_CLEANUP_MODEL?: string;
  BILLING_MONTHLY_LIMIT_USD?: string;
  BILLING_MODEL_PRICING_JSON?: string;
  RUNTIME_AGENT_MODEL?: string;
  RUNTIME_R2_BUCKET_NAME?: string;
  RUNTIME_SERVICE_URL?: string;
  RUNTIME_SERVICE_TOKEN?: string;
  CODEX_AUTH_JSON?: string;
  FLY_API_TOKEN?: string;
  FLY_RUNTIME_APP_NAME?: string;
  FLY_RUNTIME_APP_URL?: string;
  FLY_RUNTIME_IMAGE?: string;
  FLY_RUNTIME_REGION?: string;
  FLY_RUNTIME_SHARED_TOKEN?: string;
  FLY_RUNTIME_MACHINE_CPU_KIND?: string;
  FLY_RUNTIME_MACHINE_CPUS?: string;
  FLY_RUNTIME_MACHINE_MEMORY_MB?: string;
  RUNTIME_OPENAI_PROXY_UPSTREAM_BASE_URL?: string;
  RUNTIME_CODEX_OPENAI_BASE_URL?: string;
  R2_BUCKET_NAME?: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  QUEUE_INGEST_NAME?: string;
  QUEUE_JOBS_NAME?: string;
  WORKOS_API_KEY?: string;
  WORKOS_CLIENT_ID?: string;
  AUTH_COOKIE_PASSWORD?: string;
  ADMIN_ALLOWED_EMAIL?: string;
  ERROR_ALERT_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  IMPLEMENTATION_ID?: string;
  SITE_ORIGIN?: string;
  API_ORIGIN?: string;
  SEMANTIC_BACKEND?: string;
  X402_ENABLED?: string;
  X402_PAY_TO?: string;
  X402_NETWORK?: string;
  X402_ASSET?: string;
  X402_MAX_AMOUNT_USD?: string;
  X402_DESCRIPTION?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  CORPUS_BUCKET: R2Bucket;
  INGEST_QUEUE: Queue;
  JOBS_QUEUE: Queue;
  VECTOR_INDEX?: VectorizeIndex;
  COMPREHENSIVE_JOB_DO: DurableObjectNamespace;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`));
        }, ms);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function createResearchTaskLeaseRenewer(
  renewLease: () => Promise<void>,
  intervalMs = RESEARCH_TASK_LEASE_RENEW_INTERVAL_MS,
) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let inFlight = Promise.resolve();

  const tick = () => {
    if (stopped) {
      return;
    }
    inFlight = inFlight.then(async () => {
      if (stopped) {
        return;
      }
      await renewLease();
    }).catch(() => {});
  };

  return {
    start() {
      if (timer || stopped) {
        return;
      }
      timer = setInterval(tick, Math.max(1, intervalMs));
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await inFlight;
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonLines<T extends Record<string, unknown>>(content: string): T[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as T;
        return parsed && typeof parsed === "object" ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function excerptFromRemotePacket(packet: Record<string, unknown>) {
  const excerpt = typeof packet.packet_excerpt === "string" ? packet.packet_excerpt.trim() : "";
  if (excerpt.length > 0) {
    return excerpt;
  }
  const text = typeof packet.packet_text === "string" ? packet.packet_text.trim() : "";
  return text.slice(0, 900);
}

function normalizeRemoteLogSourceName(sourceName: string) {
  return sourceName.replace(/^inner\//u, "").replace(/^wrapper\//u, "");
}

function isUsefulRemoteSemanticLogSource(sourceName: string) {
  const normalized = normalizeRemoteLogSourceName(sourceName);
  return normalized === "launcher"
    || normalized === "launcher.log"
    || normalized.endsWith("/launcher.log")
    || normalized === "run_log"
    || normalized === "run.log"
    || normalized.endsWith("/run.log")
    || normalized === "inner_status"
    || normalized === "status.json"
    || normalized.endsWith("/status.json")
    || normalized === "timing_log"
    || normalized === "timing-log.jsonl"
    || normalized.endsWith("/timing-log.jsonl")
    || normalized === "query_expansion"
    || normalized === "query-expansion.json"
    || normalized.endsWith("/query-expansion.json");
}

function formatRemoteSemanticLogLine(sourceName: string, line: string) {
  const normalized = normalizeRemoteLogSourceName(sourceName);
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (normalized === "timing_log" || normalized === "timing-log.jsonl" || normalized.endsWith("/timing-log.jsonl")) {
    try {
      const payload = JSON.parse(trimmed) as Record<string, unknown>;
      const event = typeof payload.event === "string" ? payload.event : "";
      const variant = typeof payload.variant === "string" ? payload.variant : "";
      const variantIndex = typeof payload.variant_index === "number" ? payload.variant_index : null;
      const totalVariants = typeof payload.total_variants === "number" ? payload.total_variants : null;
      const matchCount = typeof payload.match_count === "number" ? payload.match_count : null;
      const elapsedSeconds = typeof payload.elapsed_seconds === "number" ? payload.elapsed_seconds : null;
      switch (event) {
        case "variant_started":
          return `Qdrant variant ${variantIndex ?? "?"}/${totalVariants ?? "?"} started: ${variant}`;
        case "variant_completed":
          return `Qdrant variant ${variantIndex ?? "?"}/${totalVariants ?? "?"} completed with ${matchCount ?? 0} matches in ${elapsedSeconds ?? 0}s: ${variant}`;
        case "rerank_started":
          return "Remote semantic retrieval is reranking the best candidate packets.";
        case "rerank_completed":
          return `Remote semantic reranking kept ${typeof payload.kept_packets === "number" ? payload.kept_packets : "some"} packets.`;
        case "summary_written":
          return "Remote semantic retrieval wrote its summary artifacts.";
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  if (normalized === "query_expansion" || normalized === "query-expansion.json" || normalized.endsWith("/query-expansion.json")) {
    try {
      const payload = JSON.parse(trimmed) as Record<string, unknown>;
      const variants = Array.isArray(payload.variants)
        ? payload.variants.filter((value): value is string => typeof value === "string")
        : [];
      if (variants.length > 0) {
        return `Remote semantic retrieval expanded the query into ${variants.length} variants.`;
      }
    } catch {
      return null;
    }
  }

  if (normalized === "inner_status" || normalized === "status.json" || normalized.endsWith("/status.json")) {
    try {
      const payload = JSON.parse(trimmed) as Record<string, unknown>;
      const phase = typeof payload.phase === "string" ? payload.phase : "";
      const detail = typeof payload.detail === "string" ? payload.detail : "";
      if (phase || detail) {
        return `${phase ? `Remote semantic phase: ${phase}. ` : ""}${detail}`.trim();
      }
    } catch {
      return null;
    }
  }

  return trimmed;
}

function resolveSemanticJobApiConfig(env: Env) {
  const url = (env.SEMANTIC_JOB_API_URL ?? env.HERMES_JOB_API_URL ?? "").trim();
  if (!url) {
    return null;
  }
  const token = (env.SEMANTIC_JOB_API_TOKEN ?? env.HERMES_JOB_API_TOKEN ?? "").trim();
  return {
    url,
    token: token.length > 0 ? token : undefined,
  };
}

async function buildRemoteSemanticSearchResult(
  env: Env,
  input: {
    query: string;
    maxResults: number;
    packetJsonl: string;
  },
) {
  const packets = parseJsonLines<Record<string, unknown>>(input.packetJsonl);
  const topPackets = packets.slice(0, Math.max(4, Math.min(input.maxResults, 12)));

  const chunks = topPackets.map((packet, index) => {
    const gutenbergId = String(packet.gutenberg_id ?? "").trim();
    const chunkIndex = typeof packet.start_chunk_index === "number" ? packet.start_chunk_index : index;
    const id = Array.isArray(packet.source_ids) && typeof packet.source_ids[0] === "string"
      ? String(packet.source_ids[0])
      : `gutenberg:${gutenbergId}:${chunkIndex}`;
    const title = typeof packet.title === "string" && packet.title.trim().length > 0
      ? packet.title.trim()
      : `Project Gutenberg ${gutenbergId}`;
    const excerpt = excerptFromRemotePacket(packet);
    const score = typeof packet.rerank_score === "number"
      ? packet.rerank_score
      : typeof packet.max_score === "number"
        ? packet.max_score
        : 0;
    return {
      id,
      workId: `gutenberg:${gutenbergId || index}`,
      chunkIndex,
      text: typeof packet.packet_text === "string" ? packet.packet_text : excerpt,
      excerpt,
      score,
      readerPath: gutenbergId ? `/${gutenbergId}` : null,
      label: title,
    };
  });

  const evidence = chunks.map((chunk, index) => [
    `[${index + 1}] ${chunk.label}`,
    chunk.excerpt,
  ].join("\n")).join("\n\n");

  let briefing: string;
  if (env.OPENAI_API_KEY) {
    const modelName = env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2";
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
    const response = await generateText({
      model: openai.responses(modelName),
      prompt: [
        "You are writing AlphaBook semantic-search answers from remote retrieval results.",
        "Use only the supplied evidence packets.",
        "Answer directly in 2-4 short paragraphs.",
        "Name standout works and say why they matter.",
        "If the evidence is thin, say so plainly.",
        "",
        `User question: ${input.query}`,
        "",
        "Evidence packets:",
        evidence,
      ].join("\n"),
    });
    briefing = response.text.trim();
  } else {
    briefing = chunks.length > 0
      ? `I found ${chunks.length} strong packets for this semantic search. The clearest matches were ${chunks.map((chunk) => chunk.label).slice(0, 3).join(", ")}.`
      : "I couldn’t find strong semantic matches for that question in the indexed corpus yet.";
  }

  return {
    briefing,
    citations: chunks.slice(0, 8).map((chunk) => ({
      workId: chunk.workId,
      chunkId: chunk.id,
      label: `${chunk.label}#${chunk.chunkIndex}`,
      excerpt: chunk.excerpt,
      readerPath: chunk.readerPath,
    })),
    chunks,
    rankedChunks: chunks,
    alphaloopEvents: [],
    iterations: [],
    totalChunksConsidered: packets.length,
  } satisfies Record<string, unknown>;
}

export async function runQueuedRemoteSemanticSearch(
  env: Env,
  store: Pick<AppStore, "getWorkMetadata">,
  input: {
    query: string;
    workIds?: string[];
    maxResults: number;
    backend?: "alphaloop" | "context1";
    sessionId: string;
    runId: string;
    progressReporter: (text: string, detail?: Record<string, unknown>) => Promise<void>;
  },
) {
  const api = resolveSemanticJobApiConfig(env);
  if (!api) {
    throw new Error("Remote semantic job API is not configured.");
  }

  const scopedMetadata = input.workIds?.length ? await store.getWorkMetadata(input.workIds) : [];
  const gutenbergIds = scopedMetadata
    .filter((work) => work.gutenbergId != null)
    .map((work) => String(work.gutenbergId));

  await input.progressReporter("Forwarding semantic retrieval to the DigitalOcean search box.", {
    type: "semantic.remote",
    phase: "job_launch",
    backend: input.backend ?? "alphaloop",
    scopedWorkCount: input.workIds?.length ?? 0,
  });

  const launch = await createSemanticSearchJob(api.url, api.token, {
    query: input.query,
    maxResults: input.maxResults,
    backend: input.backend,
    gutenbergIds,
    alphabookSessionId: input.sessionId,
    alphabookRunId: input.runId,
  });

  const jobId = launch.job.id;
  let cursor: string | undefined;

  await input.progressReporter("Semantic retrieval job started on the DigitalOcean search box.", {
    type: "semantic.remote",
    phase: "job_started",
    jobId,
  });

  while (true) {
    const [jobState, logs] = await Promise.all([
      fetchHermesJob(api.url, api.token, jobId),
      fetchHermesJobLogs(api.url, api.token, jobId, cursor, 120, "all"),
    ]);
    cursor = logs.nextCursor;
    for (const source of logs.sources) {
      if (!isUsefulRemoteSemanticLogSource(source.name)) {
        continue;
      }
      for (const line of source.lines) {
        const text = formatRemoteSemanticLogLine(source.name, line);
        if (!text) {
          continue;
        }
        await input.progressReporter(text, {
          type: "semantic.remote_log",
          source: source.name,
          updatedAt: source.updatedAt,
          jobId,
        });
      }
    }

    const job = jobState.job;
    if (!job.running && job.state !== "running" && job.state !== "launching") {
      if (job.state !== "completed") {
        throw new Error(job.detail || `Remote semantic job ended with state ${job.state}.`);
      }
      break;
    }
    await sleep(REMOTE_SEMANTIC_JOB_POLL_INTERVAL_MS);
  }

  const packetArtifact = await fetchHermesArtifact(api.url, api.token, jobId, "reranked-packets.jsonl")
    .catch(async () => await fetchHermesArtifact(api.url, api.token, jobId, "review-packets.jsonl"));

  const result = await buildRemoteSemanticSearchResult(env, {
    query: input.query,
    maxResults: input.maxResults,
    packetJsonl: packetArtifact.artifact.content,
  });

  await input.progressReporter("Remote semantic retrieval finished. Writing the AlphaBook answer now.", {
    type: "semantic.remote",
    phase: "answer_ready",
    jobId,
  });

  return {
    ...result,
    remoteJobId: jobId,
    remoteJobType: "semantic_search",
  };
}

function resolveRuntimeGateway(
  env: Env,
  store: D1AppStore,
  blobStore: CloudflareR2Store,
  apiOrigin: string,
) {
  if (
    env.FLY_API_TOKEN &&
    env.FLY_RUNTIME_APP_NAME &&
    env.FLY_RUNTIME_IMAGE &&
    env.FLY_RUNTIME_REGION &&
    env.FLY_RUNTIME_SHARED_TOKEN &&
    env.R2_ENDPOINT &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY
  ) {
    return new FlyMachinesRuntimeGateway(store, blobStore, {
      apiToken: env.FLY_API_TOKEN,
      appName: env.FLY_RUNTIME_APP_NAME,
      runtimeAppUrl: env.FLY_RUNTIME_APP_URL,
      openAIApiKey: env.OPENAI_API_KEY,
      runtimeAgentModel: env.RUNTIME_AGENT_MODEL,
      image: env.FLY_RUNTIME_IMAGE,
      region: env.FLY_RUNTIME_REGION,
      runtimeSharedToken: env.FLY_RUNTIME_SHARED_TOKEN,
      machineCpuKind:
        env.FLY_RUNTIME_MACHINE_CPU_KIND === "performance"
          ? "performance"
          : "shared",
      machineCpus: env.FLY_RUNTIME_MACHINE_CPUS ? Number(env.FLY_RUNTIME_MACHINE_CPUS) : undefined,
      machineMemoryMb: env.FLY_RUNTIME_MACHINE_MEMORY_MB ? Number(env.FLY_RUNTIME_MACHINE_MEMORY_MB) : undefined,
      codexOpenAIBaseUrl: env.RUNTIME_CODEX_OPENAI_BASE_URL,
      codexProxyUpstreamBaseUrl: env.RUNTIME_OPENAI_PROXY_UPSTREAM_BASE_URL,
      workspaceDownloadBaseUrl: apiOrigin,
      r2BucketName: env.RUNTIME_R2_BUCKET_NAME ?? env.R2_BUCKET_NAME ?? "alphabook",
      r2Endpoint: env.R2_ENDPOINT,
      r2AccessKeyId: env.R2_ACCESS_KEY_ID,
      r2SecretAccessKey: env.R2_SECRET_ACCESS_KEY,
    });
  }
  if (env.RUNTIME_SERVICE_URL && env.RUNTIME_SERVICE_TOKEN) {
    return new HttpRuntimeGateway(env.RUNTIME_SERVICE_URL, env.RUNTIME_SERVICE_TOKEN);
  }
  throw new Error("Runtime gateway is not configured.");
}

export async function runQueuedWorkspaceResearchTask(
  runtimeGateway: {
    runWorkspaceTask(args: Record<string, unknown>): Promise<Record<string, unknown>>;
    runSpriteFanoutResearch?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  },
  input: {
    runtimeId: string;
    taskSpec: Record<string, unknown>;
    sessionId: string;
    runId: string;
    implementationId: string;
    progressReporter: (text: string, detail?: Record<string, unknown>) => Promise<void>;
  },
) {
  const taskIntensity = input.taskSpec.intensity === "maximum" || input.taskSpec.intensity === "high" || input.taskSpec.intensity === "normal"
    ? input.taskSpec.intensity
    : "normal";
  if (input.taskSpec.mode === "sprite_fanout") {
    if (!runtimeGateway.runSpriteFanoutResearch) {
      throw new Error("Sprite fanout research is not configured for this environment.");
    }
    return runtimeGateway.runSpriteFanoutResearch({
      runtimeId: input.runtimeId,
      query:
        typeof input.taskSpec.question === "string" && input.taskSpec.question.trim().length > 0
          ? input.taskSpec.question
          : typeof input.taskSpec.researchObjective === "string" && input.taskSpec.researchObjective.trim().length > 0
            ? input.taskSpec.researchObjective
            : "",
      workIds: Array.isArray(input.taskSpec.workIds)
        ? input.taskSpec.workIds.filter((value): value is string => typeof value === "string")
        : [],
      intensity: taskIntensity,
      implementationId: input.implementationId,
      sessionId: input.sessionId,
      runId: input.runId,
      __progressReporter: input.progressReporter,
    });
  }
  return runtimeGateway.runWorkspaceTask({
    runtimeId: input.runtimeId,
    taskSpec: input.taskSpec,
    sessionId: input.sessionId,
    runId: input.runId,
    __progressReporter: input.progressReporter,
  });
}

function resolveEmbedder(env: Env, billing: ReturnType<typeof createBillingService>) {
  if (env.EMBEDDING_PROVIDER === "google" && env.GOOGLE_AI_API_KEY) {
    return new GoogleAIEmbedder(
      env.GOOGLE_AI_API_KEY,
      env.GOOGLE_EMBEDDING_MODEL ?? "gemini-embedding-001",
      env.GOOGLE_EMBEDDING_DIMENSIONS ? Number(env.GOOGLE_EMBEDDING_DIMENSIONS) : 768,
    );
  }
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required unless EMBEDDING_PROVIDER=google with GOOGLE_AI_API_KEY configured.");
  }
  return new OpenAIEmbedder(
    env.OPENAI_API_KEY,
    env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    env.OPENAI_EMBEDDING_DIMENSIONS ? Number(env.OPENAI_EMBEDDING_DIMENSIONS) : 768,
    undefined,
    billing,
  );
}

function resolveVectorIndex(env: Env): VectorSearchIndex | null {
  if (env.VECTOR_PROVIDER === "qdrant" && env.QDRANT_URL) {
    return new QdrantVectorIndex(
      env.QDRANT_URL,
      env.QDRANT_COLLECTION ?? "alphabook-semantic",
      env.QDRANT_API_KEY,
      env.QDRANT_QUERY_TIMEOUT_MS ? Number(env.QDRANT_QUERY_TIMEOUT_MS) : 10_000,
    );
  }
  if (env.VECTOR_INDEX) {
    return new CloudflareVectorizeIndex(env.VECTOR_INDEX as never);
  }
  return null;
}

function buildImplementationConfig(env: Env) {
  const base = getImplementationConfig(env.IMPLEMENTATION_ID);
  return {
    ...base,
    siteOrigin: env.SITE_ORIGIN ?? base.siteOrigin,
    apiOrigin: env.API_ORIGIN ?? base.apiOrigin,
  };
}

function buildQueueNames(env: Env, implementationId: string) {
  return {
    ingestName: env.QUEUE_INGEST_NAME ?? `${implementationId}-ingest`,
    jobsName: env.QUEUE_JOBS_NAME ?? `${implementationId}-jobs`,
  };
}

export function buildAppDeps(env: Env): AppDeps {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required.");
  }
  const implementation = buildImplementationConfig(env);
  const queueNames = buildQueueNames(env, implementation.id);
  const db = createD1Db(env.APP_DB);
  const blobStore = new CloudflareR2Store(env.CORPUS_BUCKET);
  const store = new D1AppStore(db, {
    adapterId: implementation.adapterId,
    blobStore,
    feedLabels: implementation.feedLabels,
  });
  const runtimeGateway = resolveRuntimeGateway(env, store, blobStore, implementation.apiOrigin);
  const billing = createBillingService(store, {
    monthlyLimitUsd: env.BILLING_MONTHLY_LIMIT_USD ? Number(env.BILLING_MONTHLY_LIMIT_USD) : undefined,
    modelPricing: env.BILLING_MODEL_PRICING_JSON
      ? JSON.parse(env.BILLING_MODEL_PRICING_JSON) as Record<string, {
        inputPerMillionUsd: number;
        outputPerMillionUsd: number;
        cachedInputPerMillionUsd?: number;
      }>
      : undefined,
  });
  const router = new OpenAIRouter(
    env.OPENAI_API_KEY,
    env.OPENAI_MODEL ?? "gpt-5.2",
    undefined,
    billing,
    buildRouterPrompt(implementation),
  );
  const planner = new OpenAIPlanner(
    env.OPENAI_API_KEY,
    env.OPENAI_MODEL ?? "gpt-5.2",
    undefined,
    billing,
    buildPlannerPrompt(implementation),
  );
  const embedder = resolveEmbedder(env, billing);
  const vectorIndex = resolveVectorIndex(env);
  const semanticSearch = vectorIndex
    ? new DelegatingSemanticSearchService(
        {
          alphaloop: new AlphaloopSemanticSearchService({
            store,
            embedder,
            vectorIndex,
            openAIApiKey: env.OPENAI_API_KEY,
            openAIModel: env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
            googleAIApiKey: env.GOOGLE_AI_API_KEY,
          }),
          context1:
            env.CONTEXT1_API_KEY && env.CONTEXT1_MODEL
              ? new Context1SemanticSearchService({
                  store,
                  embedder,
                  vectorIndex,
                  apiKey: env.CONTEXT1_API_KEY,
                  model: env.CONTEXT1_MODEL,
                  baseUrl: env.CONTEXT1_BASE_URL,
                  maxTurns: env.CONTEXT1_MAX_TURNS ? Number(env.CONTEXT1_MAX_TURNS) : undefined,
                  totalTokenBudget: env.CONTEXT1_TOTAL_TOKEN_BUDGET ? Number(env.CONTEXT1_TOTAL_TOKEN_BUDGET) : undefined,
                  softTokenBudget: env.CONTEXT1_SOFT_TOKEN_BUDGET ? Number(env.CONTEXT1_SOFT_TOKEN_BUDGET) : undefined,
                  hardTokenBudget: env.CONTEXT1_HARD_TOKEN_BUDGET ? Number(env.CONTEXT1_HARD_TOKEN_BUDGET) : undefined,
                  perToolTokenBudget: env.CONTEXT1_PER_TOOL_TOKEN_BUDGET ? Number(env.CONTEXT1_PER_TOOL_TOKEN_BUDGET) : undefined,
                  billing,
                })
              : undefined,
        },
        env.SEMANTIC_BACKEND === "context1" ? "context1" : "alphaloop",
      )
    : undefined;
  const synthesizer = new OpenAISynthesizer(
    env.OPENAI_API_KEY,
    env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
    undefined,
    billing,
    buildSynthesizerPrompt(implementation),
  );

  return {
    store,
    billing,
    router,
    planner,
    semanticSearch,
    embedder,
    synthesizer,
    blobStore,
    runtimeGateway,
    enqueueJob: async (message) => {
      await env.JOBS_QUEUE.send(message);
    },
    auth:
      env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID && env.AUTH_COOKIE_PASSWORD
        ? new WorkOSAuth(
            {
              workosApiKey: env.WORKOS_API_KEY,
              workosClientId: env.WORKOS_CLIENT_ID,
              cookiePassword: env.AUTH_COOKIE_PASSWORD,
              cookiePrefix: implementation.id,
              frontendOrigin: implementation.siteOrigin,
              allowedHosts: [new URL(implementation.siteOrigin).hostname, "127.0.0.1", "localhost"],
              defaultReaderName: implementation.defaultReaderName,
            },
            store,
          )
        : undefined,
    queues: {
      ingestName: queueNames.ingestName,
      jobsName: queueNames.jobsName,
    },
    adminAllowedEmail: env.ADMIN_ALLOWED_EMAIL,
    openAIApiKey: env.OPENAI_API_KEY,
    openAIModel: env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
    hermesJobApiUrl: env.HERMES_JOB_API_URL,
    hermesJobApiToken: env.HERMES_JOB_API_TOKEN,
    hermesModel: env.HERMES_MODEL ?? "gpt-5.4",
    hermesMaxTurns: env.HERMES_MAX_TURNS ? Number(env.HERMES_MAX_TURNS) : undefined,
    runtimeSharedToken: env.FLY_RUNTIME_SHARED_TOKEN,
    ai: env.AI,
    toolStreamCleanupModel: env.TOOL_STREAM_CLEANUP_MODEL,
    errorAlertWebhookUrl: env.ERROR_ALERT_WEBHOOK_URL,
    resendApiKey: env.RESEND_API_KEY,
    resendFromEmail: env.RESEND_FROM_EMAIL,
    x402:
      env.X402_ENABLED === "true"
      && env.X402_PAY_TO
      && env.X402_NETWORK
      && env.X402_ASSET
      && env.X402_MAX_AMOUNT_USD
      && env.CDP_API_KEY_ID
      && env.CDP_API_KEY_SECRET
        ? {
            enabled: true,
            payTo: env.X402_PAY_TO,
            network: env.X402_NETWORK,
            asset: env.X402_ASSET,
            maxAmountUsd: env.X402_MAX_AMOUNT_USD,
            description: env.X402_DESCRIPTION,
            cdpApiKeyId: env.CDP_API_KEY_ID,
            cdpApiKeySecret: env.CDP_API_KEY_SECRET,
          }
        : undefined,
    implementation: {
      id: implementation.id,
      productName: implementation.productName,
      siteOrigin: implementation.siteOrigin,
      apiOrigin: implementation.apiOrigin,
      contentOrigin: implementation.contentOrigin,
      allowedWebOrigins: [implementation.siteOrigin, `https://www.${new URL(implementation.siteOrigin).hostname.replace(/^www\./, "")}`],
      defaultUserName: implementation.defaultUserName,
      defaultReaderName: implementation.defaultReaderName,
    },
    comprehensiveJobs: env.COMPREHENSIVE_JOB_DO,
  };
}

function buildFetchHandler(env: Env) {
  const app = createApp(buildAppDeps(env));
  return app.fetch;
}

async function runScheduledJanitor(env: Env) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required.");
  }
  const implementation = getImplementationConfig(env.IMPLEMENTATION_ID);
  const ingestQueueName = env.QUEUE_INGEST_NAME ?? `${implementation.id}-ingest`;
  const jobsQueueName = env.QUEUE_JOBS_NAME ?? `${implementation.id}-jobs`;
  const db = createD1Db(env.APP_DB);
  const blobStore = new CloudflareR2Store(env.CORPUS_BUCKET);
  const store = new D1AppStore(db, {
    adapterId: implementation.adapterId,
    blobStore,
    feedLabels: implementation.feedLabels,
  });
  const billing = createBillingService(store, {
    monthlyLimitUsd: env.BILLING_MONTHLY_LIMIT_USD ? Number(env.BILLING_MONTHLY_LIMIT_USD) : undefined,
    modelPricing: env.BILLING_MODEL_PRICING_JSON
      ? JSON.parse(env.BILLING_MODEL_PRICING_JSON) as Record<string, {
        inputPerMillionUsd: number;
        outputPerMillionUsd: number;
        cachedInputPerMillionUsd?: number;
      }>
      : undefined,
  });
  const planner = new OpenAIPlanner(env.OPENAI_API_KEY, env.OPENAI_MODEL ?? "gpt-5.2", undefined, billing);
  const embedder = resolveEmbedder(env, billing);
  const synthesizer = new OpenAISynthesizer(
    env.OPENAI_API_KEY,
    env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
    undefined,
    billing,
  );
  const runtimeGateway = resolveRuntimeGateway(env, store, blobStore, implementation.apiOrigin);

  if (typeof runtimeGateway.cleanupStaleSpriteMachines === "function") {
    await runtimeGateway.cleanupStaleSpriteMachines("");
  }

  await store.refreshExploreFeedSnapshot();

  await reapExpiredRuntimeInstances(
    {
      store,
      billing,
      planner,
      embedder,
      synthesizer,
      blobStore,
      runtimeGateway,
      queues: {
        ingestName: ingestQueueName,
        jobsName: jobsQueueName,
      },
      openAIApiKey: env.OPENAI_API_KEY,
      openAIModel: env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
      ai: env.AI,
      toolStreamCleanupModel: env.TOOL_STREAM_CLEANUP_MODEL,
      errorAlertWebhookUrl: env.ERROR_ALERT_WEBHOOK_URL,
      resendApiKey: env.RESEND_API_KEY,
      resendFromEmail: env.RESEND_FROM_EMAIL,
    },
    {
      runId: `scheduled-janitor-${new Date().toISOString()}`,
    },
  );
  await reapStaleRuns(
    {
      store,
      billing,
      planner,
      embedder,
      synthesizer,
      blobStore,
      runtimeGateway,
      queues: {
        ingestName: ingestQueueName,
        jobsName: jobsQueueName,
      },
      openAIApiKey: env.OPENAI_API_KEY,
      openAIModel: env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
      ai: env.AI,
      toolStreamCleanupModel: env.TOOL_STREAM_CLEANUP_MODEL,
      errorAlertWebhookUrl: env.ERROR_ALERT_WEBHOOK_URL,
      resendApiKey: env.RESEND_API_KEY,
      resendFromEmail: env.RESEND_FROM_EMAIL,
    },
    {
      runId: `scheduled-janitor-${new Date().toISOString()}`,
    },
  );

  const claimableResearchTasks = await store.listClaimableResearchTasks(100);
  for (const task of claimableResearchTasks) {
    await env.JOBS_QUEUE.send({
      type: "research_task_requested",
      taskId: task.id,
      queuedAt: new Date().toISOString(),
    } satisfies ResearchTaskQueueMessage);
  }
}

async function processResearchTaskMessage(env: Env, message: ResearchTaskQueueMessage) {
  if (message.type !== "research_task_requested") {
    return;
  }
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required.");
  }
  const implementation = (() => {
    const base = getImplementationConfig(env.IMPLEMENTATION_ID);
    return {
      ...base,
      siteOrigin: env.SITE_ORIGIN ?? base.siteOrigin,
      apiOrigin: env.API_ORIGIN ?? base.apiOrigin,
    };
  })();
  const db = createD1Db(env.APP_DB);
  const blobStore = new CloudflareR2Store(env.CORPUS_BUCKET);
  const store = new D1AppStore(db, {
    adapterId: implementation.adapterId,
    blobStore,
    feedLabels: implementation.feedLabels,
  });
  const billing = createBillingService(store, {
    monthlyLimitUsd: env.BILLING_MONTHLY_LIMIT_USD ? Number(env.BILLING_MONTHLY_LIMIT_USD) : undefined,
    modelPricing: env.BILLING_MODEL_PRICING_JSON
      ? JSON.parse(env.BILLING_MODEL_PRICING_JSON) as Record<string, {
        inputPerMillionUsd: number;
        outputPerMillionUsd: number;
        cachedInputPerMillionUsd?: number;
      }>
      : undefined,
  });
  const embedder = resolveEmbedder(env, billing);
  const runtimeGateway = resolveRuntimeGateway(env, store, blobStore, implementation.apiOrigin);
  const researchTaskTimeoutMs = Math.max(
    30_000,
    Number(env.RUNTIME_TOOL_TIMEOUT_SECONDS ?? "1500") * 1000,
  );
  const vectorIndex = resolveVectorIndex(env);
  const semanticSearch = vectorIndex
    ? new AlphaloopSemanticSearchService({
        store,
        embedder,
        vectorIndex,
        openAIApiKey: env.OPENAI_API_KEY,
        openAIModel: env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
        googleAIApiKey: env.GOOGLE_AI_API_KEY,
      })
    : null;

  const task = await store.getResearchTask(message.taskId);
  if (!task) {
    return;
  }
  const heartbeatAt = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + RESEARCH_TASK_LEASE_MS).toISOString();
  const leaseOwner = `queue:${message.taskId}:${Date.now()}`;
  const claimed = await store.claimResearchTaskLease(task.id, {
    leaseOwner,
    lastHeartbeatAt: heartbeatAt,
    leaseExpiresAt,
  });
  if (!claimed) {
    return;
  }

  const run = await store.getRun(task.runId);
  const session = await store.getSession(task.sessionId);
  if (!run || !session) {
    await store.updateResearchTask(task.id, {
      status: "failed",
      errorJson: { error: "Research task lost its run or session context." },
      completedAt: new Date().toISOString(),
    });
    return;
  }
  const toolCall = (await store.listToolCalls(run.id)).find((candidate) => candidate.id === task.toolCallId) ?? null;
  if (!toolCall) {
    await store.updateResearchTask(task.id, {
      status: "failed",
      errorJson: { error: "Research task lost its tool call context." },
      completedAt: new Date().toISOString(),
    });
    return;
  }

  let progressSeq = task.progressSeq;
  const refreshResearchTaskLease = async (updates?: {
    status?: "starting" | "running";
    startedAt?: string | null;
  }) => {
    const heartbeatAtIso = new Date().toISOString();
    await store.updateResearchTask(task.id, {
      status: "running",
      lastHeartbeatAt: heartbeatAtIso,
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + RESEARCH_TASK_LEASE_MS).toISOString(),
      ...updates,
    });
  };
  const leaseRenewer = createResearchTaskLeaseRenewer(async () => {
    await refreshResearchTaskLease();
  });
  const reportProgress = async (
    toolName: "semantic_deep_search" | "run_workspace_task",
    text: string,
    detail?: Record<string, unknown>,
    runtimeId?: string | null,
  ) => {
    progressSeq += 1;
    const currentHeartbeat = new Date().toISOString();
    await store.appendRunEvent(run.id, session.id, "tool.progress", {
      runId: run.id,
      toolCallId: toolCall.id,
      toolName,
      ...(runtimeId ? { runtimeId } : {}),
      text,
      ...(detail ? { detail } : {}),
    });
    await store.updateResearchTask(task.id, {
      status: "running",
      progressSeq,
      runtimeId: runtimeId ?? task.runtimeId ?? null,
      lastHeartbeatAt: currentHeartbeat,
      checkpointJson: detail ?? task.checkpointJson,
      startedAt: task.startedAt ?? currentHeartbeat,
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + RESEARCH_TASK_LEASE_MS).toISOString(),
    });
  };

  try {
    leaseRenewer.start();
    await store.updateResearchTask(task.id, {
      status: "starting",
      startedAt: task.startedAt ?? new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + RESEARCH_TASK_LEASE_MS).toISOString(),
    });

    let result: Record<string, unknown>;
    if (task.kind === "workspace_research") {
      const runtimeId = typeof task.taskSpecJson.runtimeId === "string" ? task.taskSpecJson.runtimeId : null;
      const taskSpec =
        task.taskSpecJson.taskSpec && typeof task.taskSpecJson.taskSpec === "object"
          ? task.taskSpecJson.taskSpec as Record<string, unknown>
          : {};
      if (!runtimeId) {
        throw new Error("Workspace research task is missing its runtime id.");
      }
      result = await runQueuedWorkspaceResearchTask(runtimeGateway, {
        runtimeId,
        taskSpec,
        sessionId: session.id,
        runId: run.id,
        implementationId: implementation.id,
        progressReporter: async (text: string, detail?: Record<string, unknown>) => {
          await reportProgress("run_workspace_task", text, detail, runtimeId);
        },
      });
    } else {
      const query = typeof task.taskSpecJson.query === "string" ? task.taskSpecJson.query : "";
      const workIds = Array.isArray(task.taskSpecJson.workIds)
        ? task.taskSpecJson.workIds.filter((value): value is string => typeof value === "string")
        : undefined;
      const maxResults = typeof task.taskSpecJson.maxResults === "number" ? task.taskSpecJson.maxResults : 8;
      const backend =
        task.taskSpecJson.backend === "context1" || task.taskSpecJson.backend === "alphaloop"
          ? task.taskSpecJson.backend
          : undefined;
      if (resolveSemanticJobApiConfig(env)) {
        result = await withTimeout(
          runQueuedRemoteSemanticSearch(env, store, {
            query,
            workIds,
            maxResults,
            backend,
            sessionId: session.id,
            runId: run.id,
            progressReporter: async (text, detail) => {
              await reportProgress("semantic_deep_search", text, detail);
            },
          }),
          researchTaskTimeoutMs,
          "Remote semantic research task",
        );
      } else {
        if (!semanticSearch) {
          throw new Error("Semantic search is not configured.");
        }
        result = await withTimeout(
          semanticSearch.search({
            query,
            workIds,
            maxResults,
            backend,
            billingContext: {
              userId: session.userId,
              sessionId: session.id,
              runId: run.id,
              source: "semantic_search",
            },
            onProgress: async (text, detail) => {
              await reportProgress("semantic_deep_search", text, detail);
            },
            auditLog: (event, payload) => {
              void store.appendRunEvent(run.id, session.id, "tool.audit", {
                runId: run.id,
                toolCallId: toolCall.id,
                toolName: "semantic_deep_search",
                text: event,
                detail: {
                  type: "semantic.audit",
                  event,
                  ...payload,
                },
              });
            },
          }),
          researchTaskTimeoutMs,
          "Semantic research task",
        );
      }
    }

    await leaseRenewer.stop();
    await store.finishToolCall(toolCall.id, "completed", result);
    await store.updateResearchTask(task.id, {
      status: "succeeded",
      runtimeId: typeof result.runtimeId === "string" ? result.runtimeId : task.runtimeId ?? null,
      resultArtifactKey:
        Array.isArray(result.artifacts)
          ? ((result.artifacts as Array<Record<string, unknown>>).find((artifact) => typeof artifact.r2Key === "string")?.r2Key as string | undefined) ?? null
          : null,
      errorJson: null,
      completedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      leaseOwner,
      leaseExpiresAt: null,
    });
  } catch (error) {
    await leaseRenewer.stop();
    const messageText = error instanceof Error ? error.message : "Durable research task failed.";
    await store.finishToolCall(toolCall.id, "failed", {
      ok: false,
      error: messageText,
    });
    await store.updateResearchTask(task.id, {
      status: "failed",
      errorJson: { error: messageText },
      completedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      leaseOwner,
      leaseExpiresAt: null,
    });
  }
}

type ComprehensiveJobRecord = {
  id: string;
  ownerUserId: string;
  prompt: string;
  mode: "comprehensive" | "semantic";
  chatRequest: ChatRequest;
  state: "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelling" | "cancelled";
  running: boolean;
  attemptCount: number;
  previousRunIds: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sessionId: string | null;
  runId: string | null;
  lastObservedRunEventSeq: number;
  knownRuntimeIds: string[];
  detail: string | null;
  error: string | null;
  cancelRequestedAt: string | null;
  lastEventAt: string | null;
};

type ComprehensiveJobLogEntry = {
  seq: number;
  createdAt: string;
  event: string;
  line: string;
  data: Record<string, unknown>;
};

type ComprehensiveLogCursor = {
  sources: Record<string, number>;
};

type ComprehensiveLogStreamMode = "raw" | "all";

function summarizeComprehensiveJobEvent(event: string, data: Record<string, unknown>) {
  switch (event) {
    case "session.created":
      return `session=${typeof data.sessionId === "string" ? data.sessionId : "unknown"}`;
    case "run.started":
      return `run=${typeof data.runId === "string" ? data.runId : "unknown"} status=running`;
    case "assistant.plan":
      return typeof data.text === "string" ? data.text : "assistant planned the job";
    case "tool.started":
      return `tool=${typeof data.toolName === "string" ? data.toolName : "unknown"} started`;
    case "tool.progress":
      return typeof data.text === "string" ? data.text : "tool progress";
    case "tool.completed":
      return `tool=${typeof data.toolName === "string" ? data.toolName : "unknown"} completed`;
    case "assistant.completed":
      return typeof data.content === "string" ? data.content : "assistant completed";
    case "run.completed":
      return `run=${typeof data.runId === "string" ? data.runId : "unknown"} status=${typeof data.status === "string" ? data.status : "completed"}`;
    case "error":
      return typeof data.message === "string" ? data.message : "job failed";
    default:
      return JSON.stringify(data);
  }
}

function isInterestingRuntimeLogPath(path: string) {
  if (!path.startsWith("output/")) {
    return false;
  }
  return /\.(?:md|txt|json|jsonl|log)$/iu.test(path);
}

function isRawRuntimeLogPath(path: string, filename?: string) {
  const normalized = path.trim();
  const name = (filename ?? normalized.split("/").at(-1) ?? "").trim();
  if (normalized === "output/runtime-stdout.log" || normalized === "output/runtime-stderr.log") {
    return true;
  }
  if (normalized === "output/codex-progress.jsonl" || normalized === "output/openai-proxy.jsonl") {
    return true;
  }
  if (/^output\/.+\.log(?:\.txt)?$/iu.test(normalized)) {
    return true;
  }
  return /^(?:runtime-(?:stdout|stderr)\.log|codex-progress\.jsonl|openai-proxy\.jsonl|.+\.log(?:\.txt)?)$/iu.test(name);
}

function isInterestingArtifactLogPath(path: string, filename: string) {
  if (path && isInterestingRuntimeLogPath(path)) {
    return true;
  }
  return /(?:stdout|stderr|progress|usage|stream|briefing|evidence|summary|\.log(?:\.txt)?|\.jsonl)$/iu.test(filename);
}

function splitLogLines(content: string) {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function decodeLogCursor(raw: string | null): ComprehensiveLogCursor {
  if (!raw) {
    return { sources: {} };
  }
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ComprehensiveLogCursor;
    return decoded && decoded.sources && typeof decoded.sources === "object"
      ? { sources: Object.fromEntries(Object.entries(decoded.sources).map(([key, value]) => [key, Number(value) || 0])) }
      : { sources: {} };
  } catch {
    return { sources: {} };
  }
}

function encodeLogCursor(cursor: ComprehensiveLogCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function isTextArtifact(filename: string, mimeType: string) {
  return mimeType.startsWith("text/") || mimeType.includes("json") || /\.(md|txt|json|log)$/iu.test(filename);
}

function collectRuntimeIdsFromRunEvents(runEvents: Array<{ runtimeId?: string | null }>) {
  const runtimeIds = new Set<string>();
  for (const runEvent of runEvents) {
    if (typeof runEvent.runtimeId === "string" && runEvent.runtimeId.length > 0) {
      runtimeIds.add(runEvent.runtimeId);
    }
  }
  return runtimeIds;
}

function artifactBelongsToRun(
  artifact: { runtimeId: string | null; metadata: Record<string, unknown> },
  runId: string,
  runtimeIdSet: Set<string>,
) {
  if (typeof artifact.runtimeId === "string" && artifact.runtimeId.length > 0) {
    return runtimeIdSet.has(artifact.runtimeId);
  }
  return typeof artifact.metadata.runId === "string" && artifact.metadata.runId === runId;
}

export class ComprehensiveJobDurableObject {
  private executionPromise: Promise<void> | null = null;
  private readonly activeRuns = new Map<string, ActiveRunState>();
  private static readonly ALARM_INTERVAL_MS = 15_000;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private async getJob() {
    return await this.state.storage.get<ComprehensiveJobRecord>("job");
  }

  private async putJob(job: ComprehensiveJobRecord) {
    await this.state.storage.put("job", job);
    return job;
  }

  private async getLogs() {
    return (await this.state.storage.get<ComprehensiveJobLogEntry[]>("logs")) ?? [];
  }

  private async appendLog(event: string, data: Record<string, unknown>) {
    const logs = await this.getLogs();
    const entry: ComprehensiveJobLogEntry = {
      seq: logs.length,
      createdAt: new Date().toISOString(),
      event,
      line: summarizeComprehensiveJobEvent(event, data),
      data,
    };
    logs.push(entry);
    await this.state.storage.put("logs", logs.slice(-10_000));
  }

  private async ensureAlarm() {
    const current = await this.state.storage.getAlarm();
    const target = Date.now() + ComprehensiveJobDurableObject.ALARM_INTERVAL_MS;
    if (current == null || current > target + 1_000 || current < Date.now()) {
      await this.state.storage.setAlarm(target);
    }
  }

  private async clearAlarm() {
    await this.state.storage.deleteAlarm();
  }

  private async mirrorPersistedRunEvents(job: ComprehensiveJobRecord, deps: AppDeps) {
    if (!job.runId) {
      return job;
    }
    const runEvents = await deps.store.listRunEvents(job.runId);
    const newEvents = runEvents.filter((event) => event.sequence > job.lastObservedRunEventSeq);
    if (newEvents.length === 0) {
      const knownRuntimeIds = Array.from(collectRuntimeIdsFromRunEvents(runEvents));
      if (knownRuntimeIds.join(",") === job.knownRuntimeIds.join(",")) {
        return job;
      }
      return {
        ...job,
        knownRuntimeIds,
      };
    }
    const existingLogs = await this.getLogs();
    const existingKeys = new Set(existingLogs.map((entry) => `${entry.event}:${entry.createdAt}:${entry.line}`));
    const appended: ComprehensiveJobLogEntry[] = [];
    let nextJob = { ...job };
    for (const runEvent of newEvents) {
      const line = summarizeComprehensiveJobEvent(runEvent.event, runEvent.dataJson);
      const dedupeKey = `${runEvent.event}:${runEvent.createdAt}:${line}`;
      if (!existingKeys.has(dedupeKey)) {
        appended.push({
          seq: existingLogs.length + appended.length,
          createdAt: runEvent.createdAt,
          event: runEvent.event,
          line,
          data: runEvent.dataJson,
        });
        existingKeys.add(dedupeKey);
      }
      nextJob.lastObservedRunEventSeq = Math.max(nextJob.lastObservedRunEventSeq, runEvent.sequence);
      nextJob.lastEventAt = runEvent.createdAt;
      if (runEvent.event === "session.created" && typeof runEvent.dataJson.sessionId === "string") {
        nextJob.sessionId = runEvent.dataJson.sessionId;
      }
      if (runEvent.event === "run.started" && typeof runEvent.dataJson.runId === "string") {
        nextJob.runId = runEvent.dataJson.runId;
      }
      if (runEvent.event === "tool.progress" && typeof runEvent.dataJson.text === "string") {
        nextJob.detail = runEvent.dataJson.text.slice(0, 500);
      }
      if (runEvent.event === "assistant.completed" && typeof runEvent.dataJson.content === "string") {
        nextJob.detail = runEvent.dataJson.content.slice(0, 500);
      }
      if (runEvent.event === "run.completed") {
        const status = runEvent.dataJson.status === "completed" || runEvent.dataJson.status === "failed" || runEvent.dataJson.status === "timed_out"
          ? runEvent.dataJson.status
          : "failed";
        nextJob.state = nextJob.cancelRequestedAt && status === "failed" ? "cancelled" : status;
        nextJob.running = false;
        nextJob.finishedAt = runEvent.createdAt;
        nextJob.error = typeof runEvent.dataJson.error === "string" ? runEvent.dataJson.error : null;
        nextJob.detail = typeof runEvent.dataJson.error === "string"
          ? runEvent.dataJson.error
          : nextJob.detail;
      }
    }
    nextJob.knownRuntimeIds = Array.from(collectRuntimeIdsFromRunEvents(runEvents));
    if (appended.length > 0) {
      await this.state.storage.put("logs", [...existingLogs, ...appended].slice(-10_000));
    }
    return nextJob;
  }

  private async cancelPersistedRun(job: ComprehensiveJobRecord, deps: AppDeps) {
    if (!job.runId || !job.sessionId) {
      return;
    }
    const run = await deps.store.getRun(job.runId);
    const session = await deps.store.getSession(job.sessionId);
    if (!run || !session) {
      return;
    }
    const [toolCalls, runEvents] = await Promise.all([
      deps.store.listToolCalls(job.runId),
      deps.store.listRunEvents(job.runId),
    ]);
    const runtimeIds = new Set<string>([
      ...job.knownRuntimeIds,
      ...Array.from(collectRuntimeIdsFromRunEvents(runEvents)),
    ]);
    await Promise.all(
      Array.from(runtimeIds).map((runtimeId) =>
        deps.runtimeGateway.cancelWorkspaceTask?.({ runtimeId }).catch(() => {}),
      ),
    );
    await Promise.all(
      toolCalls
        .filter((toolCall) => toolCall.status === "running" || toolCall.status === "queued")
        .map((toolCall) => deps.store.finishToolCall(toolCall.id, "failed", {
          ok: false,
          error: "Run cancelled by comprehensive job API.",
        })),
    );
    await finalizeStaleRun(deps, new Request("https://comprehensive-job.internal/cancel"), run, this.activeRuns);
  }

  private async launchAttempt(job: ComprehensiveJobRecord, options: { recovery: boolean }) {
    if (this.executionPromise) {
      return this.executionPromise;
    }
    this.executionPromise = (async () => {
      const startedAt = new Date().toISOString();
      let nextJob: ComprehensiveJobRecord = {
        ...job,
        state: job.cancelRequestedAt ? "cancelling" : "running",
        running: true,
        startedAt: job.startedAt ?? startedAt,
        finishedAt: null,
        error: null,
        detail: options.recovery ? "Recovering comprehensive run after lease expiry." : "Starting comprehensive run.",
        attemptCount: options.recovery ? job.attemptCount + 1 : Math.max(job.attemptCount, 1),
      };
      await this.putJob(nextJob);
      await this.ensureAlarm();
      if (options.recovery) {
        await this.appendLog("job.recovery.restarted", {
          previousRunId: job.runId,
          sessionId: job.sessionId,
          attemptCount: nextJob.attemptCount,
        });
      }
      try {
        const deps = buildAppDeps(this.env);
        await runOrchestrator(
          deps,
          new Request(options.recovery ? "https://comprehensive-job.internal/recover" : "https://comprehensive-job.internal/run"),
          {
            ...job.chatRequest,
            sessionId: job.sessionId ?? job.chatRequest.sessionId,
          },
          async (event, data) => {
            const current = await this.getJob();
            if (!current) {
              return;
            }
            let updated: ComprehensiveJobRecord = {
              ...current,
              lastEventAt: new Date().toISOString(),
            };
            if (event === "session.created" && typeof data.sessionId === "string") {
              updated.sessionId = data.sessionId;
            }
            if (event === "run.started" && typeof data.runId === "string") {
              if (updated.runId && updated.runId !== data.runId && !updated.previousRunIds.includes(updated.runId)) {
                updated.previousRunIds = [...updated.previousRunIds, updated.runId];
              }
              updated.runId = data.runId;
              updated.detail = options.recovery ? "Recovery attempt started." : updated.detail;
            }
            if (event === "run.completed") {
              const status = data.status === "completed" || data.status === "failed" || data.status === "timed_out"
                ? data.status
                : "failed";
              updated.state = updated.cancelRequestedAt && status === "failed" ? "cancelled" : status;
              updated.running = false;
              updated.finishedAt = new Date().toISOString();
              updated.error = typeof data.error === "string" ? data.error : null;
            }
            await this.putJob(updated);
            if (updated.running) {
              await this.ensureAlarm();
            }
          },
          this.activeRuns,
          options.recovery
            ? {
                recovery: {
                  skipUserMessageAppend: true,
                },
              }
            : {},
        );
      } catch (error) {
        const current = await this.getJob();
        if (current) {
          await this.putJob({
            ...current,
            state: current.cancelRequestedAt ? "cancelled" : "failed",
            running: false,
            finishedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
            detail: error instanceof Error ? error.message : String(error),
          });
          await this.appendLog("error", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        this.executionPromise = null;
        const current = await this.getJob();
        if (current?.running) {
          await this.ensureAlarm();
        } else {
          await this.clearAlarm();
        }
      }
    })();
    return this.executionPromise;
  }

  private async reconcileJobState(reason: "request" | "alarm" | "cancel" = "request") {
    const job = await this.getJob();
    if (!job) {
      await this.clearAlarm();
      return null;
    }
    let nextJob = job;
    const deps = buildAppDeps(this.env);
    if (nextJob.runId) {
      nextJob = await this.mirrorPersistedRunEvents(nextJob, deps);
      const activeRunId = nextJob.runId;
      if (!activeRunId) {
        await this.putJob(nextJob);
        await this.ensureAlarm();
        return nextJob;
      }
      const run = await deps.store.getRun(activeRunId);
      if (!run) {
        nextJob = {
          ...nextJob,
          state: "failed",
          running: false,
          finishedAt: new Date().toISOString(),
          detail: "The underlying run could not be found.",
          error: "Underlying run missing.",
        };
      } else if (run.status === "completed" || run.status === "failed" || run.status === "timed_out") {
        nextJob = {
          ...nextJob,
          state: nextJob.cancelRequestedAt && run.status === "failed" ? "cancelled" : run.status,
          running: false,
          finishedAt: run.completedAt ?? nextJob.finishedAt ?? new Date().toISOString(),
        };
      } else {
        const leaseExpired = !run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= Date.now();
        if (nextJob.cancelRequestedAt) {
          await this.cancelPersistedRun(nextJob, deps);
          nextJob = await this.mirrorPersistedRunEvents(nextJob, deps);
          const refreshedRunId = nextJob.runId;
          const refreshedRun = refreshedRunId ? await deps.store.getRun(refreshedRunId) : null;
          if (!refreshedRun || refreshedRun.status === "failed" || refreshedRun.status === "timed_out") {
            nextJob = {
              ...nextJob,
              state: "cancelled",
              running: false,
              finishedAt: new Date().toISOString(),
              detail: "Cancellation completed.",
            };
          }
        } else if (leaseExpired && !this.executionPromise) {
          if (!nextJob.previousRunIds.includes(activeRunId)) {
            nextJob = {
              ...nextJob,
              previousRunIds: [...nextJob.previousRunIds, activeRunId],
            };
          }
          await this.putJob(nextJob);
          this.state.waitUntil(this.launchAttempt(nextJob, { recovery: true }));
          await this.ensureAlarm();
          return nextJob;
        }
      }
    }
    await this.putJob(nextJob);
    if (nextJob.running || nextJob.state === "cancelling") {
      await this.ensureAlarm();
    } else {
      await this.clearAlarm();
    }
    if (reason === "request" && nextJob.running && !nextJob.runId && !this.executionPromise) {
      this.state.waitUntil(this.launchAttempt(nextJob, { recovery: false }));
    }
    return nextJob;
  }

  private async cancelJob() {
    const job = await this.reconcileJobState("cancel");
    if (!job) {
      return null;
    }
    const nextState: ComprehensiveJobRecord = {
      ...job,
      state: job.running ? "cancelling" : "cancelled",
      running: job.running,
      cancelRequestedAt: job.cancelRequestedAt ?? new Date().toISOString(),
      detail: "Cancellation requested.",
    };
    await this.putJob(nextState);
    await this.appendLog("job.cancel_requested", {
      runId: job.runId,
      sessionId: job.sessionId,
    });
    if (nextState.runId) {
      const activeRun = this.activeRuns.get(nextState.runId);
      if (activeRun) {
        activeRun.cancelRequested = true;
      }
      const deps = buildAppDeps(this.env);
      await this.cancelPersistedRun(nextState, deps).catch(() => {});
    }
    return await this.reconcileJobState("cancel");
  }

  private async listArtifacts(job: ComprehensiveJobRecord) {
    if (!job.sessionId || !job.runId) {
      return [];
    }
    const deps = buildAppDeps(this.env);
    const [artifacts, runEvents] = await Promise.all([
      deps.store.listArtifacts(job.sessionId),
      deps.store.listRunEvents(job.runId),
    ]);
    const runtimeIds = collectRuntimeIdsFromRunEvents(runEvents);
    return artifacts
      .filter((artifact) => artifactBelongsToRun(artifact, job.runId!, runtimeIds))
      .map((artifact) => ({
        name: artifact.filename,
        updatedAt: artifact.createdAt,
        mimeType: artifact.mimeType,
        byteSize: artifact.byteSize ?? null,
        runtimeId: artifact.runtimeId ?? null,
        path: typeof artifact.metadata.path === "string" ? artifact.metadata.path : artifact.filename,
      }));
  }

  private async collectRuntimeLogSources(
    job: ComprehensiveJobRecord,
    deps: AppDeps,
    mode: ComprehensiveLogStreamMode,
  ) {
    if (!job.sessionId || !job.runId) {
      return [] as Array<{ name: string; lines: string[] }>;
    }
    const [artifacts, runEvents, runtimeInstances] = await Promise.all([
      deps.store.listArtifacts(job.sessionId),
      deps.store.listRunEvents(job.runId),
      deps.store.listRuntimeInstances(job.sessionId),
    ]);
    const runtimeIds = new Set<string>([
      ...job.knownRuntimeIds,
      ...Array.from(collectRuntimeIdsFromRunEvents(runEvents)),
    ]);
    const relatedRuntimeIds = new Set(
      runtimeInstances
        .filter((instance) => runtimeIds.has(instance.runtimeId))
        .map((instance) => instance.runtimeId),
    );
    for (const runtimeId of runtimeIds) {
      relatedRuntimeIds.add(runtimeId);
    }

    const persistedSources = await Promise.all(
      artifacts
        .filter((artifact) =>
          artifactBelongsToRun(artifact, job.runId!, runtimeIds)
          && (mode === "all" || isRawRuntimeLogPath(
            typeof artifact.metadata.path === "string" ? artifact.metadata.path : artifact.filename,
            artifact.filename,
          ))
          && isInterestingArtifactLogPath(
            typeof artifact.metadata.path === "string" ? artifact.metadata.path : "",
            artifact.filename,
          )
          && isTextArtifact(artifact.filename, artifact.mimeType),
        )
        .map(async (artifact) => {
          const content = await deps.blobStore.getText(artifact.r2Key).catch(() => null);
          if (!content) {
            return null;
          }
          const path = typeof artifact.metadata.path === "string" ? artifact.metadata.path : artifact.filename;
          return {
            name: `${artifact.runtimeId ?? "session"}:${path}`,
            lines: splitLogLines(content),
          };
        }),
    );

    const liveSources = !deps.runtimeGateway.listWorkspaceFiles
      ? []
      : await Promise.all(
          Array.from(relatedRuntimeIds).map(async (runtimeId) => {
            try {
              const listing = await deps.runtimeGateway.listWorkspaceFiles!({
                runtimeId,
                sessionId: job.sessionId!,
                runId: job.runId!,
              });
              const files = Array.isArray(listing.files)
                ? listing.files.filter((value): value is string =>
                  typeof value === "string"
                  && isInterestingRuntimeLogPath(value)
                  && (mode === "all" || isRawRuntimeLogPath(value)),
                )
                : [];
              const fileSources = await Promise.all(
                files.map(async (path) => {
                  try {
                    const file = await deps.runtimeGateway.readWorkspaceFile({
                      runtimeId,
                      path,
                      sessionId: job.sessionId!,
                      runId: job.runId!,
                    });
                    const content = typeof file.content === "string" ? file.content : "";
                    if (!content.trim()) {
                      return null;
                    }
                    return {
                      name: `${runtimeId}:${path}`,
                      lines: splitLogLines(content),
                    };
                  } catch {
                    return null;
                  }
                }),
              );
              return fileSources.filter(Boolean) as Array<{ name: string; lines: string[] }>;
            } catch {
              return [];
            }
          }),
        ).then((groups) => groups.flat());

    const merged = new Map<string, { name: string; lines: string[] }>();
    for (const source of [...persistedSources.filter(Boolean) as Array<{ name: string; lines: string[] }>, ...liveSources]) {
      const existing = merged.get(source.name);
      if (!existing || source.lines.length >= existing.lines.length) {
        merged.set(source.name, source);
      }
    }
    return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private async readLogSources(
    job: ComprehensiveJobRecord,
    limit: number,
    cursorRaw: string | null,
    options: {
      mode: ComprehensiveLogStreamMode;
      includeEvents: boolean;
    },
  ) {
    const cursor = decodeLogCursor(cursorRaw);
    const deps = buildAppDeps(this.env);
    const runtimeSources = await this.collectRuntimeLogSources(job, deps, options.mode);
    const allSources = options.includeEvents
      ? [{
          name: "events",
          lines: (await this.getLogs()).map((entry) => entry.line),
        }, ...runtimeSources]
      : runtimeSources;
    const nextCursor: ComprehensiveLogCursor = {
      sources: { ...cursor.sources },
    };
    const responseSources = allSources.map((source) => {
      const offset = Math.max(0, cursor.sources[source.name] ?? 0);
      const lines = source.lines.slice(offset, offset + limit);
      nextCursor.sources[source.name] = offset + lines.length;
      return {
        name: source.name,
        lines,
      };
    }).filter((source) => source.lines.length > 0);
    return {
      jobId: job.id,
      sources: responseSources,
      nextCursor: encodeLogCursor(nextCursor),
    };
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/start") {
      const payload = await request.json() as {
        jobId: string;
        ownerUserId: string;
        chatRequest: ChatRequest;
      };
      const existing = await this.getJob();
      if (existing) {
        const reconciled = await this.reconcileJobState("request");
        if (reconciled && reconciled.running && !this.executionPromise && (!reconciled.runId || reconciled.state === "queued")) {
          this.state.waitUntil(this.launchAttempt(reconciled, { recovery: false }));
        }
        return Response.json({ job: reconciled ?? existing });
      }
      const job: ComprehensiveJobRecord = {
        id: payload.jobId,
        ownerUserId: payload.ownerUserId,
        prompt: payload.chatRequest.message,
        mode: payload.chatRequest.mode === "semantic" ? "semantic" : "comprehensive",
        chatRequest: payload.chatRequest,
        state: "running",
        running: true,
        attemptCount: 0,
        previousRunIds: [],
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        sessionId: payload.chatRequest.sessionId ?? null,
        runId: null,
        lastObservedRunEventSeq: 0,
        knownRuntimeIds: [],
        detail: "Queued comprehensive run.",
        error: null,
        cancelRequestedAt: null,
        lastEventAt: null,
      };
      await this.putJob(job);
      await this.ensureAlarm();
      this.state.waitUntil(this.launchAttempt(job, { recovery: false }));
      return Response.json({ job });
    }
    if (request.method === "GET" && url.pathname === "/job") {
      const job = await this.reconcileJobState("request");
      if (!job) {
        return Response.json({ error: "Job not found." }, { status: 404 });
      }
      return Response.json({ job });
    }
    if (request.method === "GET" && url.pathname === "/logs") {
      const job = await this.reconcileJobState("request");
      if (!job) {
        return Response.json({ error: "Job not found." }, { status: 404 });
      }
      const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200));
      const mode = url.searchParams.get("stream") === "all" ? "all" : "raw";
      const includeEvents = ["1", "true", "yes", "on"].includes((url.searchParams.get("include_events") ?? "").toLowerCase());
      return Response.json(await this.readLogSources(job, limit, url.searchParams.get("cursor"), { mode, includeEvents }));
    }
    if (request.method === "GET" && url.pathname === "/artifacts") {
      const job = await this.reconcileJobState("request");
      if (!job) {
        return Response.json({ error: "Job not found." }, { status: 404 });
      }
      const artifacts = await this.listArtifacts(job);
      return Response.json({ artifacts });
    }
    if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
      const job = await this.reconcileJobState("request");
      if (!job) {
        return Response.json({ error: "Job not found." }, { status: 404 });
      }
      if (!job.sessionId || !job.runId) {
        return Response.json({ error: "Job artifacts are not ready yet." }, { status: 404 });
      }
      const targetName = decodeURIComponent(url.pathname.slice("/artifacts/".length));
      const deps = buildAppDeps(this.env);
      const [artifacts, runEvents] = await Promise.all([
        deps.store.listArtifacts(job.sessionId),
        deps.store.listRunEvents(job.runId),
      ]);
      const runtimeIds = collectRuntimeIdsFromRunEvents(runEvents);
      const artifact = artifacts.find((candidate) =>
        candidate.filename === targetName && artifactBelongsToRun(candidate, job.runId!, runtimeIds)
      );
      if (!artifact) {
        return Response.json({ error: "Artifact not found." }, { status: 404 });
      }
      if (!isTextArtifact(artifact.filename, artifact.mimeType)) {
        return Response.json({ error: "Artifact is not a text artifact." }, { status: 415 });
      }
      const content = await deps.blobStore.getText(artifact.r2Key);
      return Response.json({
        artifact: {
          name: artifact.filename,
          content: content ?? "",
          updatedAt: artifact.createdAt,
          mimeType: artifact.mimeType,
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/cancel") {
      const job = await this.cancelJob();
      if (!job) {
        return Response.json({ error: "Job not found." }, { status: 404 });
      }
      return Response.json({ job });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  async alarm() {
    await this.reconcileJobState("alarm");
  }
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    if (env.ORIGIN_PROXY_URL) {
      const requestUrl = new URL(request.url);
      const upstreamUrl = new URL(env.ORIGIN_PROXY_URL);
      upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/$/, "")}${requestUrl.pathname}` || "/";
      upstreamUrl.search = requestUrl.search;
      return fetch(new Request(upstreamUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      }));
    }
    return buildFetchHandler(env)(request, env, executionCtx);
  },
  async scheduled(_controller: ScheduledController, env: Env, executionCtx: ExecutionContext) {
    executionCtx.waitUntil(runScheduledJanitor(env));
  },
  async queue(batch: MessageBatch<unknown>, env: Env) {
    for (const message of batch.messages) {
      try {
        const payload = message.body as ResearchTaskQueueMessage;
        if (payload && typeof payload === "object" && payload.type === "research_task_requested") {
          await processResearchTaskMessage(env, payload);
        }
        message.ack();
      } catch (error) {
        console.error("queue processing failed", error);
        message.retry();
      }
    }
  },
};
