import { createNeonDb } from "@alphabook/db";

import { createApp } from "./app";
import { WorkOSAuth } from "./auth";
import { createBillingService } from "./billing";
import { OpenAIEmbedder } from "./embeddings";
import { OpenAIPlanner } from "./planner";
import { CloudflareR2Store } from "./r2";
import { FlyMachinesRuntimeGateway, HttpRuntimeGateway } from "./runtime";
import { NeonAppStore } from "./store";
import { OpenAISynthesizer } from "./synthesizer";

export interface Env {
  DATABASE_URL: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_SYNTH_MODEL?: string;
  OPENAI_EMBEDDING_MODEL?: string;
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
  CORPUS_BUCKET: R2Bucket;
  INGEST_QUEUE: Queue;
  JOBS_QUEUE: Queue;
}

function resolveRuntimeGateway(env: Env, store: NeonAppStore, blobStore: CloudflareR2Store) {
  if (
    env.FLY_API_TOKEN &&
    env.FLY_RUNTIME_APP_NAME &&
    env.FLY_RUNTIME_IMAGE &&
    env.FLY_RUNTIME_REGION &&
    env.R2_ENDPOINT &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY
  ) {
    return new FlyMachinesRuntimeGateway(store, blobStore, {
      apiToken: env.FLY_API_TOKEN,
      appName: env.FLY_RUNTIME_APP_NAME,
      runtimeAppUrl: env.FLY_RUNTIME_APP_URL,
      databaseUrl: env.DATABASE_URL,
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
      r2BucketName: env.RUNTIME_R2_BUCKET_NAME ?? env.R2_BUCKET_NAME ?? "alphabook",
      r2Endpoint: env.R2_ENDPOINT,
      r2AccessKeyId: env.R2_ACCESS_KEY_ID,
      r2SecretAccessKey: env.R2_SECRET_ACCESS_KEY,
    });
  }
  if (env.RUNTIME_SERVICE_URL) {
    return new HttpRuntimeGateway(env.RUNTIME_SERVICE_URL, env.RUNTIME_SERVICE_TOKEN);
  }
  throw new Error("Runtime gateway is not configured.");
}

function buildFetchHandler(env: Env) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required.");
  }
  const db = createNeonDb(env.DATABASE_URL);
  const store = new NeonAppStore(db);
  const blobStore = new CloudflareR2Store(env.CORPUS_BUCKET);
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
  const embedder = new OpenAIEmbedder(
    env.OPENAI_API_KEY,
    env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    undefined,
    billing,
  );
  const synthesizer = new OpenAISynthesizer(
    env.OPENAI_API_KEY,
    env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
    undefined,
    billing,
  );

  const app = createApp({
    store,
    billing,
    planner,
    embedder,
    synthesizer,
    blobStore,
    runtimeGateway: resolveRuntimeGateway(env, store, blobStore),
    auth:
      env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID && env.AUTH_COOKIE_PASSWORD
        ? new WorkOSAuth(
            {
              workosApiKey: env.WORKOS_API_KEY,
              workosClientId: env.WORKOS_CLIENT_ID,
              cookiePassword: env.AUTH_COOKIE_PASSWORD,
            },
            store,
          )
        : undefined,
    queues: {
      ingestName: env.QUEUE_INGEST_NAME ?? "alphabook-ingest",
      jobsName: env.QUEUE_JOBS_NAME ?? "alphabook-jobs",
    },
    adminAllowedEmail: env.ADMIN_ALLOWED_EMAIL,
    openAIApiKey: env.OPENAI_API_KEY,
    openAIModel: env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
  });

  return app.fetch;
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext) {
    return buildFetchHandler(env)(request, env, executionCtx);
  },
  async queue(batch: MessageBatch<unknown>) {
    for (const message of batch.messages) {
      message.ack();
    }
  },
};
