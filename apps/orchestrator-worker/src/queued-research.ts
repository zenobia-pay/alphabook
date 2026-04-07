import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

import { createSemanticSearchJob, fetchHermesArtifact, fetchHermesJob, fetchHermesJobLogs } from "./hermes-job-client";
import type { AppStore } from "./store";

const REMOTE_SEMANTIC_JOB_POLL_INTERVAL_MS = 1_500;

export interface RemoteSemanticSearchEnv {
  SEMANTIC_JOB_API_URL?: string;
  SEMANTIC_JOB_API_TOKEN?: string;
  HERMES_JOB_API_URL?: string;
  HERMES_JOB_API_TOKEN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_SYNTH_MODEL?: string;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function resolveSemanticJobApiConfig(env: RemoteSemanticSearchEnv) {
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
  env: RemoteSemanticSearchEnv,
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
  env: RemoteSemanticSearchEnv,
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
