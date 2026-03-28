import { createD1Db } from "@alphabook/db";
import {
  buildPlannerPrompt,
  buildRouterPrompt,
  buildSynthesizerPrompt,
  getImplementationConfig,
} from "@alphabook/implementations";

import { createApp, reapExpiredRuntimeInstances, reapStaleRuns, type ResearchTaskQueueMessage } from "./app";
import { WorkOSAuth } from "./auth";
import { createBillingService } from "./billing";
import { GoogleAIEmbedder, OpenAIEmbedder } from "./embeddings";
import { OpenAIPlanner } from "./planner";
import { CloudflareR2Store } from "./r2";
import { OpenAIRouter } from "./router";
import { FlyMachinesRuntimeGateway, HttpRuntimeGateway } from "./runtime";
import { AlphaloopSemanticSearchService } from "./semantic-search";
import { D1AppStore } from "./d1-store";
import { OpenAISynthesizer } from "./synthesizer";
import { CloudflareVectorizeIndex } from "./vectorize";

export interface WorkersAiBinding {
  run<ModelInput extends Record<string, unknown>, ModelOutput = unknown>(
    model: string,
    input: ModelInput,
    options?: Record<string, unknown>,
  ): Promise<ModelOutput>;
}

export interface Env {
  APP_DB: D1Database;
  AI?: WorkersAiBinding;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_SYNTH_MODEL?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  EMBEDDING_PROVIDER?: string;
  GOOGLE_AI_API_KEY?: string;
  GOOGLE_EMBEDDING_MODEL?: string;
  GOOGLE_EMBEDDING_DIMENSIONS?: string;
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
      codexAuthJson: env.CODEX_AUTH_JSON,
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
  runtimeGateway: FlyMachinesRuntimeGateway | HttpRuntimeGateway,
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
      env.GOOGLE_EMBEDDING_MODEL ?? "gemini-embedding-2-preview",
      env.GOOGLE_EMBEDDING_DIMENSIONS ? Number(env.GOOGLE_EMBEDDING_DIMENSIONS) : 1536,
    );
  }
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required unless EMBEDDING_PROVIDER=google with GOOGLE_AI_API_KEY configured.");
  }
  return new OpenAIEmbedder(
    env.OPENAI_API_KEY,
    env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    undefined,
    billing,
  );
}

function buildFetchHandler(env: Env) {
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
  const ingestQueueName = env.QUEUE_INGEST_NAME ?? `${implementation.id}-ingest`;
  const jobsQueueName = env.QUEUE_JOBS_NAME ?? `${implementation.id}-jobs`;
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
  const semanticSearch = env.VECTOR_INDEX
    ? new AlphaloopSemanticSearchService({
        store,
        embedder,
        vectorIndex: new CloudflareVectorizeIndex(env.VECTOR_INDEX as never),
        openAIApiKey: env.OPENAI_API_KEY,
        openAIModel: env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
        googleAIApiKey: env.GOOGLE_AI_API_KEY,
      })
    : undefined;
  const synthesizer = new OpenAISynthesizer(
    env.OPENAI_API_KEY,
    env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
    undefined,
    billing,
    buildSynthesizerPrompt(implementation),
  );

  const app = createApp({
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
      ingestName: ingestQueueName,
      jobsName: jobsQueueName,
    },
    adminAllowedEmail: env.ADMIN_ALLOWED_EMAIL,
    openAIApiKey: env.OPENAI_API_KEY,
    openAIModel: env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
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
  });

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
  const semanticSearch = env.VECTOR_INDEX
    ? new AlphaloopSemanticSearchService({
        store,
        embedder,
        vectorIndex: new CloudflareVectorizeIndex(env.VECTOR_INDEX as never),
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
  const leaseExpiresAt = new Date(Date.now() + 90_000).toISOString();
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
      leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    });
  };

  try {
    await store.updateResearchTask(task.id, {
      status: "starting",
      startedAt: task.startedAt ?? new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
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
      if (!semanticSearch) {
        throw new Error("Semantic search is not configured.");
      }
      const query = typeof task.taskSpecJson.query === "string" ? task.taskSpecJson.query : "";
      const workIds = Array.isArray(task.taskSpecJson.workIds)
        ? task.taskSpecJson.workIds.filter((value): value is string => typeof value === "string")
        : undefined;
      const maxResults = typeof task.taskSpecJson.maxResults === "number" ? task.taskSpecJson.maxResults : 8;
      result = await withTimeout(
        semanticSearch.search({
          query,
          workIds,
          maxResults,
          billingContext: {
            userId: session.userId,
            sessionId: session.id,
            runId: run.id,
            source: "semantic_search",
          },
          onProgress: async (text, detail) => {
            await reportProgress("semantic_deep_search", text, detail);
          },
        }),
        researchTaskTimeoutMs,
        "Semantic research task",
      );
    }

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

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
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
