import { readFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";

import { createPostgresDb, type DbClient } from "@alphabook/db";
import {
  buildPlannerPrompt,
  buildRouterPrompt,
  buildSynthesizerPrompt,
  getImplementationConfig,
} from "@alphabook/implementations";
import PgBoss from "pg-boss";
import Stripe from "stripe";

import { createApp, type AppDeps, type ResearchTaskQueueMessage } from "./app";
import { WorkOSAuth } from "./auth";
import { createBillingService } from "./billing";
import { GoogleAIEmbedder, OpenAIEmbedder } from "./embeddings";
import type { ModelTextGenerationBinding } from "./model-binding";
import { OpenAIPlanner } from "./planner";
import { OpenAIRouter } from "./router";
import { S3BlobStore } from "./s3-store";
import { AlphaloopSemanticSearchService, Context1SemanticSearchService, DelegatingSemanticSearchService } from "./semantic-search";
import { SqlAppStore } from "./sql-store";
import { OpenAISynthesizer } from "./synthesizer";
import { QdrantVectorIndex } from "./vectorize";
import { HttpRuntimeGateway } from "./runtime";

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
  await loadEnvFile(resolve(cwd, ".env.local"));
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

function parseCsvEnv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function resolveDb(env: LinuxEnv): DbClient {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the Linux deployment path.");
  }
  return createPostgresDb({ connectionString: env.DATABASE_URL });
}

function resolveBlobStore(env: LinuxEnv) {
  const bucketName = env.SPACES_BUCKET_NAME ?? env.S3_BUCKET_NAME;
  const endpoint = env.SPACES_ENDPOINT ?? env.S3_ENDPOINT;
  const accessKeyId = env.SPACES_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.SPACES_SECRET_ACCESS_KEY ?? env.S3_SECRET_ACCESS_KEY;
  if (!bucketName || !endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("S3-compatible object storage configuration is required for the Linux deployment path.");
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
) {
  if (env.RUNTIME_SERVICE_URL && env.RUNTIME_SERVICE_TOKEN) {
    return new HttpRuntimeGateway(env.RUNTIME_SERVICE_URL, env.RUNTIME_SERVICE_TOKEN);
  }
  throw new Error("RUNTIME_SERVICE_URL and RUNTIME_SERVICE_TOKEN are required for the Linux deployment path.");
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
  return undefined;
}

function resolveAiBinding(env: LinuxEnv): ModelTextGenerationBinding {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }
  const defaultModel = env.OPENAI_MODEL ?? "gpt-5.2";
  const binding: ModelTextGenerationBinding = {
    async run<ModelInput extends Record<string, unknown>, ModelOutput = unknown>(model: string, input: ModelInput, _options?: Record<string, unknown>) {
      const resolvedModel = model.startsWith("@cf/") ? defaultModel : model;
      const body = "messages" in input && Array.isArray(input.messages)
        ? {
            model: resolvedModel,
            messages: input.messages,
          }
        : "prompt" in input && typeof input.prompt === "string"
          ? {
              model: resolvedModel,
              messages: [
                {
                  role: "user" as const,
                  content: input.prompt,
                },
              ],
            }
          : null;
      if (!body) {
        throw new Error("Linux AI binding only supports prompt or messages inputs.");
      }
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`AI binding request failed: ${detail || response.statusText}`);
      }
      const payload = await response.json() as {
        choices?: Array<{
          message?: {
            content?: string;
          };
        }>;
      };
      const content = payload.choices?.[0]?.message?.content?.trim() ?? "";
      return {
        response: content,
      } as ModelOutput;
    },
  };
  return binding;
}

export function buildLinuxAppDeps(env: LinuxEnv, options: { boss?: PgBoss } = {}): AppDeps {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required.");
  }
  const implementation = buildImplementationConfig(env);
  const queueNames = buildQueueNames(env, implementation.id);
  const db = resolveDb(env);
  const blobStore = resolveBlobStore(env);
  const store = new SqlAppStore(db, {
    adapterId: implementation.adapterId,
    blobStore,
    feedLabels: implementation.feedLabels,
  });
  const runtimeGateway = resolveRuntimeGateway(env);
  const billing = createBillingService(store, {
    freeMonthlyCredits: env.BILLING_FREE_MONTHLY_CREDITS ? Number(env.BILLING_FREE_MONTHLY_CREDITS) : undefined,
    studioMonthlyCredits: env.BILLING_STUDIO_MONTHLY_CREDITS ? Number(env.BILLING_STUDIO_MONTHLY_CREDITS) : undefined,
    creditsPerUsdCost: env.BILLING_CREDITS_PER_USD_COST ? Number(env.BILLING_CREDITS_PER_USD_COST) : undefined,
    testMonthlyCredits: env.BILLING_TEST_MONTHLY_CREDITS ? Number(env.BILLING_TEST_MONTHLY_CREDITS) : undefined,
    testUserIds: parseCsvEnv(env.BILLING_TEST_USER_IDS),
    testUserEmails: parseCsvEnv(env.BILLING_TEST_USER_EMAILS),
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
  const ai = resolveAiBinding(env);
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
    ai,
    router,
    planner,
    semanticSearch,
    embedder,
    vectorIndex,
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
              apiOrigin: implementation.apiOrigin,
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
    runtimeSharedToken: env.RUNTIME_SERVICE_TOKEN,
    toolStreamCleanupModel: env.TOOL_STREAM_CLEANUP_MODEL,
    errorAlertWebhookUrl: env.ERROR_ALERT_WEBHOOK_URL,
    resendApiKey: env.RESEND_API_KEY,
    resendFromEmail: env.RESEND_FROM_EMAIL,
    stripe:
      env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID && env.STRIPE_PRODUCT_ID
        ? {
            client: new Stripe(env.STRIPE_SECRET_KEY, {
              apiVersion: "2025-08-27.basil",
            }),
            publishableKey: env.STRIPE_PUBLISHABLE_KEY,
            webhookSecret: env.STRIPE_WEBHOOK_SECRET,
            priceId: env.STRIPE_PRICE_ID,
            productId: env.STRIPE_PRODUCT_ID,
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
  };
}

export function createLinuxApp(env: LinuxEnv, options: { boss?: PgBoss } = {}) {
  return createApp(buildLinuxAppDeps(env, options));
}
