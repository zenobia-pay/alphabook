import { readFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";

import { createPostgresDb, createWranglerD1Db, loadLocalDevVars, type DbClient } from "@alphabook/db";
import {
  buildPlannerPrompt,
  buildRouterPrompt,
  buildSynthesizerPrompt,
  getImplementationConfig,
} from "@alphabook/implementations";
import PgBoss from "pg-boss";

import { createApp, type AppDeps, type ResearchTaskQueueMessage } from "./app";
import { WorkOSAuth } from "./auth";
import { createBillingService } from "./billing";
import { GoogleAIEmbedder, OpenAIEmbedder } from "./embeddings";
import { OpenAIPlanner } from "./planner";
import { OpenAIRouter } from "./router";
import { S3BlobStore } from "./s3-store";
import { AlphaloopSemanticSearchService, Context1SemanticSearchService, DelegatingSemanticSearchService } from "./semantic-search";
import { D1AppStore } from "./d1-store";
import { OpenAISynthesizer } from "./synthesizer";
import { QdrantVectorIndex } from "./vectorize";
import { FlyMachinesRuntimeGateway, HttpRuntimeGateway } from "./runtime";

type LinuxEnv = Record<string, string | undefined>;

async function loadEnvFile(path: string) {
  try {
    const envText = await readFile(path, "utf8");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/u);
      if (!match) {
        continue;
      }
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) {
        continue;
      }
      process.env[key] = rawValue.trim().replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
    }
  } catch {
    // Optional file.
  }
}

export async function loadLinuxEnv(cwd = process.cwd()) {
  await loadEnvFile(resolve(cwd, ".env"));
  await loadLocalDevVars(cwd);
  return process.env as LinuxEnv;
}

function buildImplementationConfig(env: LinuxEnv) {
  const base = getImplementationConfig(env.IMPLEMENTATION_ID);
  return {
    ...base,
    siteOrigin: env.SITE_ORIGIN ?? base.siteOrigin,
    apiOrigin: env.API_ORIGIN ?? base.apiOrigin,
  };
}

function buildQueueNames(env: LinuxEnv, implementationId: string) {
  return {
    ingestName: env.QUEUE_INGEST_NAME ?? `${implementationId}-ingest`,
    jobsName: env.QUEUE_JOBS_NAME ?? `${implementationId}-jobs`,
  };
}

function resolveDb(env: LinuxEnv): DbClient {
  if (env.DATABASE_URL) {
    return createPostgresDb({ connectionString: env.DATABASE_URL });
  }
  return createWranglerD1Db({
    databaseName: env.D1_DATABASE_NAME ?? "alphabook-app",
    wranglerConfig: env.D1_WRANGLER_CONFIG ?? "apps/orchestrator-worker/wrangler.toml",
  });
}

function resolveBlobStore(env: LinuxEnv) {
  const bucketName = env.SPACES_BUCKET_NAME ?? env.S3_BUCKET_NAME ?? env.R2_BUCKET_NAME;
  const endpoint = env.SPACES_ENDPOINT ?? env.S3_ENDPOINT ?? env.R2_ENDPOINT;
  const accessKeyId = env.SPACES_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID ?? env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.SPACES_SECRET_ACCESS_KEY ?? env.S3_SECRET_ACCESS_KEY ?? env.R2_SECRET_ACCESS_KEY;
  if (!bucketName || !endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("SPACES/S3 configuration is required for the Linux deployment path.");
  }
  return new S3BlobStore({
    bucketName,
    endpoint,
    accessKeyId,
    secretAccessKey,
    region: env.SPACES_REGION ?? env.S3_REGION ?? "us-east-1",
  });
}

function resolveRuntimeGateway(
  env: LinuxEnv,
  store: D1AppStore,
  blobStore: ReturnType<typeof resolveBlobStore>,
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
      machineCpuKind: env.FLY_RUNTIME_MACHINE_CPU_KIND === "performance" ? "performance" : "shared",
      machineCpus: env.FLY_RUNTIME_MACHINE_CPUS ? Number(env.FLY_RUNTIME_MACHINE_CPUS) : undefined,
      machineMemoryMb: env.FLY_RUNTIME_MACHINE_MEMORY_MB ? Number(env.FLY_RUNTIME_MACHINE_MEMORY_MB) : undefined,
      codexOpenAIBaseUrl: env.RUNTIME_CODEX_OPENAI_BASE_URL,
      codexProxyUpstreamBaseUrl: env.RUNTIME_OPENAI_PROXY_UPSTREAM_BASE_URL,
      workspaceDownloadBaseUrl: apiOrigin,
      r2BucketName: env.RUNTIME_R2_BUCKET_NAME ?? env.R2_BUCKET_NAME ?? env.SPACES_BUCKET_NAME ?? "alphabook",
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

function resolveEmbedder(env: LinuxEnv, billing: ReturnType<typeof createBillingService>) {
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

function resolveVectorIndex(env: LinuxEnv) {
  if (env.VECTOR_PROVIDER === "qdrant" && env.QDRANT_URL) {
    return new QdrantVectorIndex(
      env.QDRANT_URL,
      env.QDRANT_COLLECTION ?? "alphabook-semantic",
      env.QDRANT_API_KEY,
      env.QDRANT_QUERY_TIMEOUT_MS ? Number(env.QDRANT_QUERY_TIMEOUT_MS) : 10_000,
    );
  }
  return null;
}

export function buildLinuxAppDeps(env: LinuxEnv, options: { boss?: PgBoss } = {}): AppDeps {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required.");
  }
  const implementation = buildImplementationConfig(env);
  const queueNames = buildQueueNames(env, implementation.id);
  const db = resolveDb(env);
  const blobStore = resolveBlobStore(env);
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
    enqueueJob: options.boss
      ? async (message: ResearchTaskQueueMessage) => {
          await options.boss!.send(queueNames.jobsName, message);
        }
      : undefined,
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
    queues: queueNames,
    adminAllowedEmail: env.ADMIN_ALLOWED_EMAIL,
    openAIApiKey: env.OPENAI_API_KEY,
    openAIModel: env.OPENAI_SYNTH_MODEL ?? env.OPENAI_MODEL ?? "gpt-5.2",
    hermesJobApiUrl: env.HERMES_JOB_API_URL,
    hermesJobApiToken: env.HERMES_JOB_API_TOKEN,
    hermesModel: env.HERMES_MODEL ?? "gpt-5.4",
    hermesMaxTurns: env.HERMES_MAX_TURNS ? Number(env.HERMES_MAX_TURNS) : undefined,
    runtimeSharedToken: env.FLY_RUNTIME_SHARED_TOKEN ?? env.RUNTIME_SERVICE_TOKEN,
    toolStreamCleanupModel: env.TOOL_STREAM_CLEANUP_MODEL,
    errorAlertWebhookUrl: env.ERROR_ALERT_WEBHOOK_URL,
    resendApiKey: env.RESEND_API_KEY,
    resendFromEmail: env.RESEND_FROM_EMAIL,
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
  };
}

export function createLinuxApp(env: LinuxEnv, options: { boss?: PgBoss } = {}) {
  return createApp(buildLinuxAppDeps(env, options));
}
