import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { artifactKeys, HARD_LIMITS } from "@alphabook/corpus-core";
import {
  PlatformChatRequestSchema,
  toLegacyChatRequest,
  toPlatformToolName,
  workDetailToDocumentDetail,
  workSourceToDocumentSource,
  workSummaryToDocumentSummary,
} from "@alphabook/platform";
import { ChatRequestSchema, ToolArgsSchemas, getToolLabel, type ChatRequest, type ChunkSearchResult, type Citation, type NotificationType, type PlannerDecision, type ToolName, type WorkSummary } from "@alphabook/shared";
import { createFacilitatorConfig } from "@coinbase/x402";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { type Network, type PaymentPayload, type PaymentRequired, type PaymentRequirements, type SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ZodError, z } from "zod";

import type { WorkOSAuth } from "./auth";
import type { BillingService } from "./billing";
import { HashEmbedder, type Embedder } from "./embeddings";
import {
  cancelHermesJob,
  createHermesJob,
  fetchHermesArtifact,
  fetchHermesJobArtifacts,
  fetchHermesJob,
  fetchHermesJobLogs,
  type HermesJobSummary,
} from "./hermes-job-client";
import { MemoryBlobStore, type BlobStore } from "./r2";
import type { Planner, PlannerContext } from "./planner";
import { FallbackPlanner, parseToolCall } from "./planner";
import type { Router, RouterDecision } from "./router";
import type { SemanticSearchService } from "./semantic-search";
import { cleanupToolStreamWithWorkersAi, type ToolStreamCleanupLine } from "./tool-stream-cleanup";
import type { Synthesizer, ToolHistoryEntry } from "./synthesizer";
import type { AgentIdentityRecord, AnalyticsEventRecord, AppStore, ArtifactRecord, BackgroundJobRecord, MessageRecord, NotificationRecord, PassageSearchFilters, RunEventRecord, RunRecord, RuntimeInstanceRecord, SessionRecord, ToolCallRecord, UserRecord, WorkDetailRecord } from "./store";
import { parseModelJsonObject } from "./json";
import type { ModelTextGenerationBinding } from "./model-binding";

export interface WorkerQueues {
  ingestName: string;
  jobsName: string;
}

export interface ResearchTaskQueueMessage {
  type: "research_task_requested";
  taskId: string;
  queuedAt: string;
}

export interface RuntimeToolGateway {
  createWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  runWorkspaceTask(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  runSpriteFanoutResearch?(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  cleanupStaleSpriteMachines?(sessionId?: string): Promise<number>;
  listSpriteSessionMachines?(sessionId: string): Promise<Array<Record<string, unknown>>>;
  cancelWorkspaceTask?(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  getWorkspaceTaskStatus?(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  readWorkspaceFile(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  listWorkspaceFiles?(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  destroyWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AppDeps {
  store: AppStore;
  billing: BillingService;
  router?: Router;
  planner: Planner;
  semanticSearch?: SemanticSearchService;
  embedder: Embedder;
  synthesizer: Synthesizer;
  blobStore: BlobStore;
  runtimeGateway: RuntimeToolGateway;
  queues: WorkerQueues;
  enqueueJob?: (message: ResearchTaskQueueMessage) => Promise<void>;
  auth?: WorkOSAuth;
  now?: () => number;
  adminAllowedEmail?: string;
  openAIApiKey?: string;
  openAIModel?: string;
  hermesJobApiUrl?: string;
  hermesJobApiToken?: string;
  hermesModel?: string;
  hermesMaxTurns?: number;
  runtimeSharedToken?: string;
  ai?: ModelTextGenerationBinding;
  toolStreamCleanupModel?: string;
  errorAlertWebhookUrl?: string;
  resendApiKey?: string;
  resendFromEmail?: string;
  x402?: {
    enabled: boolean;
    payTo: string;
    network: string;
    asset: string;
    maxAmountUsd: string;
    description?: string;
    cdpApiKeyId?: string;
    cdpApiKeySecret?: string;
    facilitatorConfig?: {
      url?: string;
      createAuthHeaders?: () => Promise<{
        verify: Record<string, string>;
        settle: Record<string, string>;
        supported: Record<string, string>;
      }>;
    };
  };
  implementation?: {
    id: string;
    productName: string;
    siteOrigin: string;
    apiOrigin: string;
    contentOrigin?: string;
    allowedWebOrigins?: string[];
    defaultUserName?: string;
    defaultReaderName?: string;
  };
  comprehensiveJobs?: DurableObjectNamespace;
}

type CreateAppInput = Partial<Omit<AppDeps, "store" | "billing">> & Pick<AppDeps, "store" | "billing">;

function formatDisplayLanguage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) {
    return null;
  }
  if (/\b(fiction|poetry|stories|story|drama|novel|novels|essays|letters|adventure|fantasy|humorous|romance|biography|speeches|literature|history|philosophy|mythology|religion|politics)\b/iu.test(normalized)) {
    return null;
  }
  if (/--|\d/u.test(normalized)) {
    return null;
  }
  if (!/^[A-Za-z][A-Za-z -]{0,39}$/u.test(normalized)) {
    return null;
  }
  if (normalized.split(/\s+/u).length > 3) {
    return null;
  }
  return normalized;
}

const AgentRegistrationRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});

type AgentRegistrationRequest = z.infer<typeof AgentRegistrationRequestSchema>;

type AuthPrincipal =
  | {
      kind: "user";
      user: UserRecord;
    }
  | {
      kind: "agent";
      user: UserRecord;
      agent: AgentIdentityRecord;
    };

const VERIFICATION_CODE_WORDS = [
  "folio",
  "quill",
  "citadel",
  "vellum",
  "atlas",
  "ledger",
  "ember",
  "signal",
];
const DEFAULT_SESSION_TITLE_MODEL = "@cf/zai-org/glm-4.7-flash";
const ORPHANED_RUN_GRACE_MS = 30_000;
const PLANNER_STALL_GRACE_MS = HARD_LIMITS.MAX_TOOL_TIMEOUT_SECONDS * 1000 + 30_000;

function randomToken(length = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let value = "";
  for (const byte of bytes) {
    value += alphabet[byte % alphabet.length];
  }
  return value;
}

async function sha256Hex(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createAgentApiKey() {
  return `abk_${randomToken(40)}`;
}

function createClaimToken() {
  return `abclaim_${randomToken(24)}`;
}

function createVerificationCode() {
  const word = VERIFICATION_CODE_WORDS[Math.floor(Math.random() * VERIFICATION_CODE_WORDS.length)] ?? "folio";
  return `${word}-${randomToken(4).toUpperCase()}`;
}

function apiKeyPrefix(apiKey: string) {
  return apiKey.slice(0, 12);
}

function bearerTokenFromRequest(request: Request) {
  const header = request.headers.get("authorization");
  if (!header) {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function publicAgentIdentity(agent: AgentIdentityRecord) {
  return {
    id: agent.id,
    userId: agent.userId,
    ownerUserId: agent.ownerUserId,
    name: agent.name,
    description: agent.description,
    apiKeyPrefix: agent.apiKeyPrefix,
    status: agent.status,
    verificationCode: agent.verificationCode,
    createdAt: agent.createdAt,
    claimedAt: agent.claimedAt,
    lastUsedAt: agent.lastUsedAt,
    metadata: agent.metadata,
  };
}

function agentClaimUrl(request: Request, claimToken: string) {
  const url = new URL(request.url);
  return `${url.origin}/claim/${claimToken}`;
}

function encodeBase64Json(value: unknown) {
  return btoa(JSON.stringify(value));
}

function x402Price(maxAmountUsd: string) {
  return maxAmountUsd.startsWith("$") ? maxAmountUsd : `$${maxAmountUsd}`;
}

function paymentSignatureHeaderFromRequest(request: Request) {
  return request.headers.get("payment-signature") ?? request.headers.get("x-payment");
}

async function createX402Server(config: NonNullable<AppDeps["x402"]>) {
  return new x402ResourceServer(
    new HTTPFacilitatorClient(
      config.facilitatorConfig
        ?? createFacilitatorConfig(config.cdpApiKeyId, config.cdpApiKeySecret),
    ),
  ).register(config.network as Network, new ExactEvmScheme());
}

async function createX402PaymentRequired(
  deps: AppDeps,
  request: Request,
  error?: string,
) {
  if (!deps.x402?.enabled) {
    return null;
  }
  const server = deps.x402.facilitatorConfig || (deps.x402.cdpApiKeyId && deps.x402.cdpApiKeySecret)
    ? await createX402Server(deps.x402)
    : null;
  const paymentRequired = {
    x402Version: 1,
    error,
    resource: {
      url: request.url,
      description: deps.x402.description ?? `${productName(deps)} CLI research access`,
      mimeType: "text/event-stream",
    },
    accepts: [
      {
        scheme: "exact",
        network: deps.x402.network as Network,
        asset: deps.x402.asset,
        amount: deps.x402.maxAmountUsd,
        payTo: deps.x402.payTo,
        maxTimeoutSeconds: 300,
        extra: {
          quotedPrice: x402Price(deps.x402.maxAmountUsd),
        },
      },
    ],
  } satisfies PaymentRequired;
  return { server, paymentRequired };
}

async function createX402PaymentRequirements(
  deps: AppDeps,
  request: Request,
  billingCheck: { limitUsd: number; spendUsd: number; windowStartedAt: string },
  error?: string,
) {
  const x402 = await createX402PaymentRequired(deps, request, error);
  if (!x402) {
    return null;
  }
  return {
    x402Version: x402.paymentRequired.x402Version,
    resource: x402.paymentRequired.resource,
    accepts: x402.paymentRequired.accepts.map((accept: PaymentRequirements) => ({
      ...accept,
      assetSymbol: deps.x402?.asset ?? null,
      maxAmountRequired: accept.amount,
    })),
    billing: billingCheck,
  };
}

async function verifyAndSettleX402Payment(
  deps: AppDeps,
  request: Request,
  billingCheck: { limitUsd: number; spendUsd: number; windowStartedAt: string },
) {
  const paymentHeader = paymentSignatureHeaderFromRequest(request);
  if (!paymentHeader) {
    return { ok: false as const, response: null };
  }
  const x402 = await createX402PaymentRequired(deps, request);
  if (!x402?.server) {
    return { ok: false as const, response: null };
  }

  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = decodePaymentSignatureHeader(paymentHeader);
  } catch {
    const paymentRequirements = await createX402PaymentRequirements(
      deps,
      request,
      billingCheck,
      "Invalid PAYMENT-SIGNATURE header.",
    );
    return {
      ok: false as const,
      response: new Response(JSON.stringify({
        error: "Invalid PAYMENT-SIGNATURE header.",
        code: "x402_payment_invalid",
        paymentRequirements,
      }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          ...(x402 ? {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(x402.paymentRequired),
            "x-payment-required": encodeBase64Json(paymentRequirements),
          } : {}),
        },
      }),
    };
  }

  const matchingRequirements = x402.server.findMatchingRequirements(
    x402.paymentRequired.accepts,
    paymentPayload,
  );
  if (!matchingRequirements) {
    const paymentRequirements = await createX402PaymentRequirements(
      deps,
      request,
      billingCheck,
      `Payment does not match ${productName(deps)}'s current x402 requirements.`,
    );
    return {
      ok: false as const,
      response: new Response(JSON.stringify({
        error: `Payment does not match ${productName(deps)}'s current x402 requirements.`,
        code: "x402_payment_mismatch",
        paymentRequirements,
      }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(x402.paymentRequired),
          "x-payment-required": encodeBase64Json(paymentRequirements),
        },
      }),
    };
  }

  const verification = await x402.server.verifyPayment(paymentPayload, matchingRequirements);
  if (!verification.isValid) {
    const paymentRequirements = await createX402PaymentRequirements(
      deps,
      request,
      billingCheck,
      verification.invalidReason ?? verification.invalidMessage ?? "Payment verification failed.",
    );
    return {
      ok: false as const,
      response: new Response(JSON.stringify({
        error: verification.invalidMessage ?? "Payment verification failed.",
        code: "x402_payment_invalid",
        paymentRequirements,
      }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(x402.paymentRequired),
          "x-payment-required": encodeBase64Json(paymentRequirements),
        },
      }),
    };
  }

  const settlement = await x402.server.settlePayment(paymentPayload, matchingRequirements);
  if (!settlement.success) {
    return {
      ok: false as const,
      response: new Response(JSON.stringify({
        error: settlement.errorMessage ?? settlement.errorReason ?? "x402 payment settlement failed.",
        code: "x402_payment_settlement_failed",
      }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
          "x-payment-response": encodeBase64Json(settlement),
        },
      }),
    };
  }

  return {
    ok: true as const,
    settlement,
  };
}

async function registerAgentIdentity(
  deps: AppDeps,
  request: Request,
  payload: AgentRegistrationRequest,
  ownerUserId?: string | null,
) {
  const apiKey = createAgentApiKey();
  const record = await deps.store.createAgentIdentity({
    name: payload.name,
    description: payload.description ?? null,
    ownerUserId: ownerUserId ?? null,
    apiKeyPrefix: apiKeyPrefix(apiKey),
    apiKeyHash: await sha256Hex(apiKey),
    verificationCode: createVerificationCode(),
    claimToken: createClaimToken(),
    metadata: {
      registrationSource: ownerUserId ? "account" : "cli",
    },
  });
  return {
    apiKey,
    claimUrl: agentClaimUrl(request, record.claimToken),
    agent: record,
  };
}

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function allowedWebOrigins(deps: AppDeps) {
  return new Set([
    ...(deps.implementation?.allowedWebOrigins ?? [
      "https://alpha-book.org",
      "https://www.alpha-book.org",
    ]),
    "http://127.0.0.1:4193",
    "http://localhost:4193",
    "http://127.0.0.1:4293",
    "http://localhost:4293",
  ]);
}

function isAllowedWebOrigin(deps: AppDeps, origin: string | null | undefined): boolean {
  if (!origin) {
    return false;
  }
  return allowedWebOrigins(deps).has(origin);
}

function applyCorsHeaders(deps: AppDeps, c: Context, response: Response): Response {
  const origin = c.req.header("origin");
  if (!origin || !isAllowedWebOrigin(deps, origin)) {
    return response;
  }
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Allow-Credentials", "true");
  response.headers.append("Vary", "Origin");
  return response;
}

function analyticsKey(eventName: string) {
  const date = new Date().toISOString().slice(0, 10);
  const safeEvent = eventName.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  return `analytics/${date}/${Date.now()}-${crypto.randomUUID()}-${safeEvent}.json`;
}

function productName(deps: AppDeps) {
  return deps.implementation?.productName ?? "AlphaBook";
}

function siteOrigin(deps: AppDeps) {
  return deps.implementation?.siteOrigin ?? "https://alpha-book.org";
}

function apiOrigin(deps: AppDeps, request?: Request) {
  if (deps.implementation?.apiOrigin) {
    return deps.implementation.apiOrigin;
  }
  return request ? new URL(request.url).origin : "https://api.alpha-book.org";
}

async function persistAnalyticsEvent(
  deps: AppDeps,
  eventName: string,
  payload: Record<string, unknown> = {},
  request?: Request,
) {
  const forwardedFor = request?.headers.get("cf-connecting-ip") ?? request?.headers.get("x-forwarded-for");
  const userAgent = request?.headers.get("user-agent");
  const properties: Record<string, unknown> = {
    source: `${deps.implementation?.id ?? "alphabook"}-web`,
    userAgent,
    ip: forwardedFor ?? null,
    ...payload,
  };
  await deps.store.saveAnalyticsEvent({
    event: eventName,
    userId: typeof properties.userId === "string" ? properties.userId : null,
    sessionId: typeof properties.sessionId === "string" ? properties.sessionId : null,
    properties,
  });
  await deps.blobStore.putJson(analyticsKey(eventName), {
    event: eventName,
    timestamp: new Date().toISOString(),
    ...properties,
  });
}

async function recordAnalyticsEvent(
  deps: AppDeps,
  request: Request,
  eventName: string,
  payload: Record<string, unknown> = {},
) {
  await persistAnalyticsEvent(deps, eventName, payload, request);
}

function normalizeUnexpectedError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }
  return {
    name: "Error",
    message: typeof error === "string" ? error : JSON.stringify(error),
    stack: null,
  };
}

function incidentFingerprint(input: {
  service: string;
  source?: string | null;
  route?: string | null;
  toolName?: string | null;
  statusCode?: number | null;
  message: string;
}) {
  return [
    input.service,
    input.source ?? "",
    input.route ?? "",
    input.toolName ?? "",
    input.statusCode ?? "",
    input.message.slice(0, 240),
  ].join("::");
}

type UnexpectedErrorOptions = {
  request?: Request;
  service?: string;
  route?: string;
  method?: string;
  source?: string;
  toolName?: string;
  statusCode?: number;
  severity?: "error" | "critical";
  userId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  extra?: Record<string, unknown>;
};

async function shouldSendIncidentAlert(deps: AppDeps, fingerprint: string) {
  if (!deps.errorAlertWebhookUrl) {
    return false;
  }
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const recent = await deps.store.listAnalyticsEvents({ since, limit: 200 });
  return !recent.some((event) => {
    if (event.event !== "unexpected_error") {
      return false;
    }
    const details =
      event.properties.details && typeof event.properties.details === "object"
        ? event.properties.details as Record<string, unknown>
        : event.properties;
    return details.fingerprint === fingerprint;
  });
}

async function sendIncidentAlert(productLabel: string, webhookUrl: string, incident: Record<string, unknown>) {
  const text = [
    `${productLabel} unexpected error`,
    typeof incident.service === "string" ? `service: ${incident.service}` : null,
    typeof incident.route === "string" ? `route: ${incident.route}` : null,
    typeof incident.toolName === "string" ? `tool: ${incident.toolName}` : null,
    typeof incident.message === "string" ? `message: ${incident.message}` : null,
    typeof incident.runId === "string" ? `run: ${incident.runId}` : null,
    typeof incident.sessionId === "string" ? `session: ${incident.sessionId}` : null,
  ].filter((value): value is string => Boolean(value)).join("\n");
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text,
      incident,
    }),
  });
  if (!response.ok) {
    throw new Error(`Alert webhook failed (${response.status}): ${await response.text()}`);
  }
}

async function recordUnexpectedError(
  deps: AppDeps,
  error: unknown,
  options: UnexpectedErrorOptions = {},
) {
  const normalized = normalizeUnexpectedError(error);
  const incident = {
    service: options.service ?? "orchestrator-worker",
    severity: options.severity ?? "error",
    source: options.source ?? "server",
    route: options.route ?? null,
    method: options.method ?? options.request?.method ?? null,
    toolName: options.toolName ?? null,
    statusCode: options.statusCode ?? 500,
    message: normalized.message,
    errorName: normalized.name,
    stack: normalized.stack,
    runId: options.runId ?? null,
    sessionId: options.sessionId ?? null,
    userId: options.userId ?? null,
    fingerprint: incidentFingerprint({
      service: options.service ?? "orchestrator-worker",
      source: options.source ?? "server",
      route: options.route ?? null,
      toolName: options.toolName ?? null,
      statusCode: options.statusCode ?? 500,
      message: normalized.message,
    }),
    alertWebhookConfigured: Boolean(deps.errorAlertWebhookUrl),
    ...options.extra,
  };

  let alertDelivered = false;
  try {
    if (await shouldSendIncidentAlert(deps, incident.fingerprint)) {
      if (deps.errorAlertWebhookUrl) {
        await sendIncidentAlert(productName(deps), deps.errorAlertWebhookUrl, incident);
        alertDelivered = true;
      }
    }
  } catch {
    alertDelivered = false;
  }

  await persistAnalyticsEvent(
    deps,
    "unexpected_error",
    {
      alertDelivered,
      ...incident,
    },
    options.request,
  );
}

function readIncidentDetails(properties: Record<string, unknown>) {
  return properties.details && typeof properties.details === "object"
    ? properties.details as Record<string, unknown>
    : properties;
}

function normalizeTimestamp(value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === "object" && typeof (value as { toString?: () => string }).toString === "function") {
    const normalized = (value as { toString: () => string }).toString();
    if (normalized) {
      const parsed = new Date(normalized);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
  }
  return new Date().toISOString();
}

async function listAdminIncidents(deps: AppDeps, days = 7) {
  const query = "";
  const limit = 25;
  const eventLimit = 200;
  return listAdminIncidentsWithFilters(deps, { days, query, limit, eventLimit });
}

async function listAdminIncidentsWithFilters(
  deps: AppDeps,
  options: {
    days?: number;
    query?: string;
    limit?: number;
    eventLimit?: number;
  } = {},
) {
  const days = Math.max(1, Math.min(30, options.days ?? 7));
  const query = (options.query ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const eventLimit = Math.max(limit, Math.min(1000, options.eventLimit ?? 400));
  const since = daysAgoIso(days);
  const events = await deps.store.listAnalyticsEvents({ since, limit: 5000 });
  const incidents = events
    .filter((event) => event.event === "unexpected_error")
    .map((event) => {
      const details = readIncidentDetails(event.properties);
      const createdAt = normalizeTimestamp(event.createdAt);
      return {
        id: event.id,
        createdAt,
        service: typeof details.service === "string" ? details.service : "unknown",
        severity: typeof details.severity === "string" ? details.severity : "error",
        source: typeof details.source === "string" ? details.source : "server",
        route: typeof details.route === "string" ? details.route : null,
        toolName: typeof details.toolName === "string" ? details.toolName : null,
        method: typeof details.method === "string" ? details.method : null,
        message: typeof details.message === "string" ? details.message : "Unknown error",
        statusCode: typeof details.statusCode === "number" ? details.statusCode : null,
        runId: typeof details.runId === "string" ? details.runId : null,
        sessionId: typeof details.sessionId === "string" ? details.sessionId : null,
        userId: typeof details.userId === "string" ? details.userId : null,
        fingerprint: typeof details.fingerprint === "string" ? details.fingerprint : event.id,
        alertDelivered: details.alertDelivered === true,
        stack: typeof details.stack === "string" ? details.stack : null,
        extra: details,
      };
    })
    .filter((incident) => {
      if (!query) {
        return true;
      }
      return [
        incident.message,
        incident.service,
        incident.source,
        incident.route,
        incident.toolName,
        incident.method,
        incident.runId,
        incident.sessionId,
        incident.userId,
        incident.fingerprint,
        incident.stack,
      ].some((value) => typeof value === "string" && value.toLowerCase().includes(query));
    });

  const grouped = new Map<string, {
    fingerprint: string;
    service: string;
    severity: string;
    source: string;
    route: string | null;
    toolName: string | null;
    method: string | null;
    message: string;
    statusCode: number | null;
    runId: string | null;
    sessionId: string | null;
    userId: string | null;
    count: number;
    lastSeenAt: string;
    firstSeenAt: string;
    alertDelivered: boolean;
  }>();

  for (const incident of incidents) {
    const existing = grouped.get(incident.fingerprint);
    if (!existing) {
      grouped.set(incident.fingerprint, {
        ...incident,
        count: 1,
        lastSeenAt: incident.createdAt,
        firstSeenAt: incident.createdAt,
      });
      continue;
    }
    existing.count += 1;
    if (incident.createdAt > existing.lastSeenAt) {
      existing.lastSeenAt = incident.createdAt;
      existing.runId = incident.runId;
      existing.sessionId = incident.sessionId;
      existing.userId = incident.userId;
      existing.alertDelivered = incident.alertDelivered;
    }
    if (incident.createdAt < existing.firstSeenAt) {
      existing.firstSeenAt = incident.createdAt;
    }
  }

  const recentHourThreshold = Date.now() - 60 * 60 * 1000;
  const recentDayThreshold = Date.now() - 24 * 60 * 60 * 1000;

  return {
    query,
    inspectedDays: days,
    summary: {
      total: incidents.length,
      lastHour: incidents.filter((incident) => Date.parse(incident.createdAt) >= recentHourThreshold).length,
      last24Hours: incidents.filter((incident) => Date.parse(incident.createdAt) >= recentDayThreshold).length,
      openFingerprints: [...grouped.values()].length,
      alertWebhookConfigured: Boolean(deps.errorAlertWebhookUrl),
    },
    incidents: [...grouped.values()]
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, limit),
    events: incidents
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, eventLimit),
  };
}

function uniqueWorkIds(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    seen.add(value);
  }
  return [...seen];
}

async function recordBookAnalyticsEvents(
  deps: AppDeps,
  request: Request,
  eventName: string,
  context: {
    userId: string;
    sessionId: string;
    runId?: string;
    source: string;
    toolName?: ToolName | string;
    query?: string;
    status?: string;
  },
  workIds: Array<string | null | undefined>,
) {
  const uniqueIds = uniqueWorkIds(workIds);
  await Promise.all(
    uniqueIds.map((workId, index) =>
      recordAnalyticsEvent(deps, request, eventName, {
        userId: context.userId,
        sessionId: context.sessionId,
        runId: context.runId ?? null,
        workId,
        source: context.source,
        toolName: context.toolName ?? null,
        query: context.query ?? null,
        status: context.status ?? null,
        rank: index + 1,
      }).catch(() => {}),
    ),
  );
}

function extractCandidateWorkIds(
  toolName: ToolName,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  switch (toolName) {
    case "semantic_deep_search": {
      const chunks = Array.isArray(result.chunks) ? result.chunks as Array<Record<string, unknown>> : [];
      return uniqueWorkIds(chunks.map((chunk) => (typeof chunk.workId === "string" ? chunk.workId : null)));
    }
    case "estimate_research_scope":
      return [];
    case "search_works": {
      const frontier = result.frontier && typeof result.frontier === "object"
        ? result.frontier as Record<string, unknown>
        : null;
      const works = Array.isArray(frontier?.works)
        ? frontier.works as Array<Record<string, unknown>>
        : Array.isArray(result.works)
          ? result.works as Array<Record<string, unknown>>
          : [];
      return uniqueWorkIds(works.map((work) => (typeof work.id === "string" ? work.id : null)));
    }
    case "get_work_metadata": {
      return Array.isArray(args.workIds) ? uniqueWorkIds(args.workIds.filter((value): value is string => typeof value === "string")) : [];
    }
    case "get_relevant_chunks": {
      const chunks = Array.isArray(result.chunks) ? result.chunks as Array<Record<string, unknown>> : [];
      return uniqueWorkIds(chunks.map((chunk) => (typeof chunk.workId === "string" ? chunk.workId : null)));
    }
    case "classify_candidate_chunks": {
      const workIds = Array.isArray(result.relevantWorkIds)
        ? result.relevantWorkIds.filter((value): value is string => typeof value === "string")
        : [];
      const chunks = Array.isArray(result.chunks) ? result.chunks as Array<Record<string, unknown>> : [];
      return uniqueWorkIds([
        ...workIds,
        ...chunks.map((chunk) => (typeof chunk.workId === "string" ? chunk.workId : null)),
      ]);
    }
    case "create_workspace": {
      return Array.isArray(args.workIds) ? uniqueWorkIds(args.workIds.filter((value): value is string => typeof value === "string")) : [];
    }
    case "run_workspace_task": {
      const taskSpec = args.taskSpec && typeof args.taskSpec === "object" ? args.taskSpec as Record<string, unknown> : null;
      return Array.isArray(taskSpec?.frontierWorkIds)
        ? uniqueWorkIds((taskSpec.frontierWorkIds as unknown[]).filter((value): value is string => typeof value === "string"))
        : Array.isArray(taskSpec?.candidateWorkIds)
          ? uniqueWorkIds((taskSpec.candidateWorkIds as unknown[]).filter((value): value is string => typeof value === "string"))
          : Array.isArray(taskSpec?.workIds)
            ? uniqueWorkIds((taskSpec.workIds as unknown[]).filter((value): value is string => typeof value === "string"))
        : [];
    }
    default:
      return [];
  }
}

function latestScopeEstimateFromHistory(
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>,
) {
  for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
    const entry = toolHistory[index];
    if (entry.toolName === "estimate_research_scope") {
      return entry.result;
    }
  }
  return null;
}

function searchPlanFromEstimate(
  estimate: Record<string, unknown> | null,
  fallbackBroadCorpusQuery: boolean,
  intensityOverride?: "normal" | "high" | "maximum",
) {
  const estimatedIntensity = typeof estimate?.recommendedIntensity === "string"
    ? estimate.recommendedIntensity
    : fallbackBroadCorpusQuery
      ? "high"
      : "normal";
  const estimatedWallClockMinutes = typeof estimate?.recommendedWallClockMinutes === "number"
    ? estimate.recommendedWallClockMinutes
    : fallbackBroadCorpusQuery
      ? 15
      : 5;
  const estimatedParallelism = typeof estimate?.recommendedParallelism === "number"
    ? estimate.recommendedParallelism
    : fallbackBroadCorpusQuery
      ? 3
      : 1;
  const estimatedShardAxis = typeof estimate?.recommendedShardAxis === "string"
    ? estimate.recommendedShardAxis
    : fallbackBroadCorpusQuery
      ? "work_id_hash"
      : "none";
  const estimatedFrontierWorks = typeof estimate?.recommendedFrontierWorks === "number"
    ? estimate.recommendedFrontierWorks
    : fallbackBroadCorpusQuery
      ? 72
      : 24;
  const intensity = intensityOverride ?? estimatedIntensity;
  let wallClockMinutes = estimatedWallClockMinutes;
  let parallelism = estimatedParallelism;
  let shardAxis = estimatedShardAxis;
  let frontierWorks = estimatedFrontierWorks;
  switch (intensity) {
    case "normal":
      wallClockMinutes = 5;
      parallelism = 1;
      shardAxis = "none";
      frontierWorks = 32;
      break;
    case "high":
      wallClockMinutes = 15;
      parallelism = Math.max(2, Math.min(4, estimatedParallelism || 4));
      shardAxis = estimatedShardAxis === "none" ? "work_id_hash" : estimatedShardAxis;
      frontierWorks = Math.max(72, Math.min(96, estimatedFrontierWorks || 72));
      break;
    case "maximum":
      wallClockMinutes = 60;
      parallelism = Math.max(8, estimatedParallelism || 8);
      shardAxis = estimatedShardAxis === "none" ? "work_id_hash" : estimatedShardAxis;
      frontierWorks = Math.max(128, estimatedFrontierWorks || 128);
      break;
  }
  const estimatedWorkBreadth =
    typeof estimate?.metadataWorkEstimate === "number" && estimate.metadataWorkEstimate > 0
      ? estimate.metadataWorkEstimate
      : typeof estimate?.chunkWorkEstimate === "number" && estimate.chunkWorkEstimate > 0
        ? estimate.chunkWorkEstimate
        : frontierWorks;
  const estimatedShards = Array.isArray(estimate?.recommendedShards)
    ? estimate.recommendedShards
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .slice(0, 24)
    : [];
  const fallbackShards = (() => {
    if (parallelism <= 1 || shardAxis === "none") {
      return [];
    }
    const totalBuckets = 256;
    const targetWorkCount = Math.max(8, Math.ceil(frontierWorks / parallelism));
    const estimatedCoveragePercent = Math.max(0, Math.min(100, Math.round((frontierWorks / Math.max(estimatedWorkBreadth, 1)) * 100)));
    return Array.from({ length: parallelism }, (_, index) => {
      if (shardAxis === "publication_year") {
        const yearStart = 1800;
        const yearEnd = 1899;
        const span = yearEnd - yearStart + 1;
        const sliceStart = yearStart + Math.floor((index * span) / parallelism);
        const sliceEnd = yearStart + Math.floor((((index + 1) * span)) / parallelism) - 1;
        return {
          shardId: `publication-year-${index + 1}`,
          index,
          totalShards: parallelism,
          axis: "publication_year",
          label: `Years ${sliceStart}-${Math.max(sliceStart, sliceEnd)}`,
          targetWorkCount,
          estimatedCoveragePercent,
          yearStart: sliceStart,
          yearEnd: Math.max(sliceStart, sliceEnd),
        };
      }
      if (shardAxis === "author_initial") {
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
        const startIndex = Math.floor((index * letters.length) / parallelism);
        const endIndex = Math.min(letters.length - 1, Math.floor(((index + 1) * letters.length) / parallelism) - 1);
        return {
          shardId: `author-initial-${index + 1}`,
          index,
          totalShards: parallelism,
          axis: "author_initial",
          label: `Authors ${letters[startIndex]}-${letters[endIndex]}`,
          targetWorkCount,
          estimatedCoveragePercent,
          authorInitialStart: letters[startIndex],
          authorInitialEnd: letters[endIndex],
        };
      }
      if (shardAxis === "retrieval_strategy") {
        const strategies = [
          "metadata_expansion",
          "semantic_chunk_search",
          "lexical_regex_search",
          "neighbor_expansion",
          "verification_rerank",
          "gap_fill",
        ];
        const strategy = strategies[index] ?? `strategy_${index + 1}`;
        return {
          shardId: `retrieval-strategy-${index + 1}`,
          index,
          totalShards: parallelism,
          axis: "retrieval_strategy",
          label: strategy.replaceAll("_", " "),
          targetWorkCount,
          estimatedCoveragePercent,
          strategy,
        };
      }
      const hashBucketStart = Math.floor((index * totalBuckets) / parallelism);
      const hashBucketEnd = Math.floor(((index + 1) * totalBuckets) / parallelism) - 1;
      return {
        shardId: `work-hash-${index + 1}`,
        index,
        totalShards: parallelism,
        axis: "work_id_hash",
        label: `Work hash ${hashBucketStart}-${hashBucketEnd}`,
        targetWorkCount,
        estimatedCoveragePercent,
        hashBucketStart,
        hashBucketEnd,
      };
    });
  })();
  const shards =
    intensity === "normal"
      ? []
      : (estimatedShards.length > 0 ? estimatedShards : fallbackShards)
        .slice(0, parallelism)
        .map((entry, index) => ({
          ...entry,
          index,
          total: parallelism,
        }));
  return {
    intensity,
    wallClockMinutes,
    parallelism,
    shardAxis,
    frontierWorks,
    shards,
    estimate,
  };
}

function requestedAssistantMode(input: {
  mode?: "semantic" | "comprehensive" | "agentic";
  workflow?: "auto" | "search" | "design_experiment";
  researchMode?: "default" | "sprite_fanout";
}): "semantic" | "comprehensive" | "agentic" {
  if (input.mode === "agentic") {
    return "agentic";
  }
  if (input.mode === "comprehensive" || input.researchMode === "sprite_fanout") {
    return "comprehensive";
  }
  if (input.workflow === "search") {
    return "agentic";
  }
  return "semantic";
}

function inferExplicitAssistantMode(message: string): "semantic" | "comprehensive" | "agentic" | undefined {
  const normalized = message.toLowerCase();
  if (/\bagentic\b/u.test(normalized)) {
    return "agentic";
  }
  if (/\b(comprehensive|deep research|deeper research|sprite fanout|sprite_fanout)\b/u.test(normalized)) {
    return "comprehensive";
  }
  if (/\bsemantic\b/u.test(normalized)) {
    return "semantic";
  }
  return undefined;
}

function requestedIntensityOverride(input: {
  mode?: "semantic" | "comprehensive" | "agentic";
  workflow?: "auto" | "search" | "design_experiment";
  intensityOverride?: "normal" | "high" | "maximum";
  researchMode?: "default" | "sprite_fanout";
}): "normal" | "high" | "maximum" | undefined {
  if (input.intensityOverride) {
    return input.intensityOverride;
  }
  if (requestedAssistantMode(input) === "comprehensive") {
    return "maximum";
  }
  return undefined;
}

function hermesSearchEffort(input: {
  workflow?: "auto" | "search" | "design_experiment";
  intensityOverride?: "normal" | "high" | "maximum";
  mode?: "semantic" | "comprehensive" | "agentic";
  researchMode?: "default" | "sprite_fanout";
}): number | undefined {
  if (input.workflow !== "search") {
    return undefined;
  }
  switch (requestedIntensityOverride(input) ?? "normal") {
    case "high":
      return 25;
    case "maximum":
      return 50;
    case "normal":
    default:
      return 10;
  }
}

function inferSearchExecutionMode(query: string, scopedWorkCount = 0): "semantic" | "comprehensive" {
  return isBroadCorpusResearchQuery(query, scopedWorkCount) ? "comprehensive" : "semantic";
}

async function deriveScopeEstimateFromSearchResult(
  deps: AppDeps,
  query: string,
  result: Record<string, unknown>,
  filters: PassageSearchFilters = {},
) {
  const visibleWorks = Array.isArray(result.works)
    ? result.works.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    : [];
  const frontier = result.frontier && typeof result.frontier === "object"
    ? result.frontier as Record<string, unknown>
    : null;
  const frontierWorks = Array.isArray(frontier?.works)
    ? frontier.works.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    : visibleWorks;
  const frontierWorkIds = uniqueWorkIds(frontierWorks.map((work) => (typeof work.id === "string" ? work.id : null)));
  const metadataWorkEstimate = typeof frontier?.workCount === "number"
    ? Math.max(frontierWorkIds.length, frontier.workCount as number)
    : frontierWorkIds.length;
  const broad = isBroadCorpusResearchQuery(query, frontierWorkIds.length);
  const workload = broad
    ? await deps.store.estimateWorkSetSize(undefined, filters)
    : await deps.store.estimateWorkSetSize(frontierWorkIds, filters);
  const totalWorkEstimate = Math.max(workload.workCount, frontierWorkIds.length, visibleWorks.length);
  const totalChunkEstimate = Math.max(
    workload.totalChunkCount,
    totalWorkEstimate * (broad ? 6 : 3),
  );
  const scopeMode = broad ? "corpus_wide" : frontierWorkIds.length <= 12 ? "focused" : "subset_wide";
  const recommendedIntensity =
    totalChunkEstimate > 18_000 || workload.totalTextBytes > 64_000_000 || totalWorkEstimate > 128
      ? "maximum"
      : totalChunkEstimate > 6_000 || workload.totalTextBytes > 24_000_000 || totalWorkEstimate > 48
        ? "high"
        : scopeMode === "focused"
          ? "normal"
          : totalWorkEstimate > 12
            ? "high"
            : "normal";
  const recommendedWallClockMinutes = recommendedIntensity === "maximum" ? 60 : recommendedIntensity === "high" ? 15 : 5;
  const recommendedParallelism =
    recommendedIntensity === "maximum"
      ? totalChunkEstimate > 48_000 || totalWorkEstimate > 320 ? 12 : 8
      : recommendedIntensity === "high"
        ? totalChunkEstimate > 10_000 || totalWorkEstimate > 72 ? 4 : 2
        : 1;
  const recommendedShardAxis = recommendedParallelism > 1 ? "work_id_hash" : "none";
  const chunkWorkEstimate = Math.max(visibleWorks.length, Math.min(totalWorkEstimate, Math.round(totalWorkEstimate * (broad ? 0.7 : 0.5))));
  const chunkMatchEstimate = Math.max(visibleWorks.length, Math.min(totalChunkEstimate, chunkWorkEstimate * (broad ? 4 : 3)));
  const recommendedFrontierWorks =
    recommendedIntensity === "maximum"
      ? Math.min(Math.max(scopeMode === "corpus_wide" ? 160 : 128, frontierWorkIds.length), Math.max(totalWorkEstimate, 1))
      : recommendedIntensity === "high"
        ? Math.min(Math.max(scopeMode === "focused" ? 24 : 72, frontierWorkIds.length), Math.max(totalWorkEstimate, 1))
        : Math.min(Math.max(scopeMode === "focused" ? 12 : 24, frontierWorkIds.length), Math.max(totalWorkEstimate, 1));
  return {
    query,
    scopeMode,
    metadataWorkEstimate,
    chunkMatchEstimate,
    chunkWorkEstimate,
    totalWorkEstimate,
    totalChunkEstimate,
    totalTextBytesEstimate: workload.totalTextBytes,
    breadthBand:
      totalWorkEstimate >= 320 || totalChunkEstimate >= 48_000 ? "huge"
        : totalWorkEstimate >= 128 || totalChunkEstimate >= 18_000 ? "large"
          : totalWorkEstimate >= 48 || totalChunkEstimate >= 6_000 ? "medium"
            : totalWorkEstimate >= 12 || totalChunkEstimate >= 1_500 ? "small"
              : "tiny",
    recommendedIntensity,
    recommendedWallClockMinutes,
    recommendedParallelism,
    recommendedShardAxis,
    recommendedVmWorkBudget: recommendedIntensity === "maximum" ? 48 : recommendedIntensity === "high" ? 24 : 12,
    recommendedFrontierWorks,
    estimatedCoveragePercent: {
      normal: Math.max(15, Math.min(55, Math.round((24 / Math.max(totalWorkEstimate, 1)) * 100))),
      high: Math.max(35, Math.min(80, Math.round((72 / Math.max(totalWorkEstimate, 1)) * 100))),
      maximum: Math.max(60, Math.min(100, Math.round((128 / Math.max(totalWorkEstimate, 1)) * 100))),
    },
    probeWorks: visibleWorks.slice(0, 12).map((work) => ({
      id: typeof work.id === "string" ? work.id : "",
      title: typeof work.title === "string" ? work.title : "",
      authors: Array.isArray(work.authors) ? work.authors.filter((value): value is string => typeof value === "string") : [],
    })),
    recommendedShards: [],
    rationale: `Sized from the ${scopeMode === "corpus_wide" ? "filtered corpus" : "metadata frontier subset"} using ${totalWorkEstimate} books, ${totalChunkEstimate} indexed passages, and ${(workload.totalTextBytes / 1_000_000).toFixed(1)} MB of text.`,
  } as Record<string, unknown>;
}

function latestSearchWorksResultFromHistory(
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>,
) {
  for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
    const entry = toolHistory[index];
    if (entry.toolName === "search_works") {
      return entry.result;
    }
  }
  return null;
}

function hasCompletedSearchWorks(
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>,
) {
  return toolHistory.some((entry) =>
    entry.toolName === "search_works" && (Array.isArray(entry.result.works) || typeof entry.result.error === "string"),
  );
}

function hasCompletedChunkSearch(
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>,
) {
  for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
    const entry = toolHistory[index];
    if (entry.toolName !== "get_relevant_chunks") {
      continue;
    }
    if (Array.isArray(entry.result.chunks) || Array.isArray(entry.result.verifiedWorkIds)) {
      return true;
    }
    if (typeof entry.result.ok === "boolean" || typeof entry.result.error === "string") {
      return true;
    }
  }
  return false;
}

function latestCandidateWorkIdsFromHistory(
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>,
) {
  for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
    const entry = toolHistory[index];
    if (entry.toolName !== "search_works" && entry.toolName !== "get_work_metadata" && entry.toolName !== "get_relevant_chunks" && entry.toolName !== "classify_candidate_chunks") {
      continue;
    }
    const workIds = extractCandidateWorkIds(entry.toolName, entry.args, entry.result);
    if (workIds.length > 0) {
      return workIds.slice(0, 80);
    }
  }
  return [];
}

function searchFrontierWorksFromHistory(
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>,
) {
  for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
    const entry = toolHistory[index];
    if (entry.toolName !== "search_works") {
      continue;
    }
    const frontier = entry.result.frontier && typeof entry.result.frontier === "object"
      ? entry.result.frontier as Record<string, unknown>
      : null;
    if (Array.isArray(frontier?.works)) {
      return frontier.works as Array<Record<string, unknown>>;
    }
    if (Array.isArray(entry.result.works)) {
      return entry.result.works as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function augmentToolArgsFromHistory(
  toolName: ToolName,
  args: Record<string, unknown>,
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>,
) {
  if (toolName !== "get_relevant_chunks") {
    return args;
  }
  const candidateWorkIds = latestCandidateWorkIdsFromHistory(toolHistory);
  if (candidateWorkIds.length === 0) {
    return args;
  }
  if (Array.isArray(args.workIds) && args.workIds.length > 0) {
    return {
      ...args,
      workIds: uniqueWorkIds([
        ...args.workIds.filter((value): value is string => typeof value === "string"),
        ...candidateWorkIds,
      ]).slice(0, 80),
    };
  }
  return {
    ...args,
    workIds: candidateWorkIds,
  };
}

const SCOPED_CHUNK_QUERY_STOP_WORDS = new Set([
  "about",
  "across",
  "after",
  "again",
  "among",
  "because",
  "between",
  "book",
  "books",
  "find",
  "from",
  "into",
  "like",
  "many",
  "passage",
  "passages",
  "people",
  "quote",
  "quotes",
  "search",
  "their",
  "them",
  "they",
  "where",
  "which",
  "with",
]);

function looksLikeProperNamePhrase(phrase: string) {
  const words = phrase
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length === 0) {
    return false;
  }
  const lowercaseCount = words.filter((word) => /^[a-z]/u.test(word)).length;
  if (lowercaseCount > 0) {
    return false;
  }
  return words.every((word) => /^[A-Z][A-Za-z.'-]*$/u.test(word));
}

function simplifyScopedChunkQuery(query: string) {
  const quotedPhrases = [...query.matchAll(/"([^"]+)"/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((phrase) => phrase.length > 0)
    .filter((phrase) => !looksLikeProperNamePhrase(phrase));
  const lowered = query
    .replace(/"[^"]+"/gu, " ")
    .replace(/\b(?:AND|OR|NOT)\b/giu, " ")
    .replace(/[()]/gu, " ");
  const thematicTokens = lowered
    .split(/[^A-Za-z]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => /^[a-z]+$/u.test(token))
    .filter((token) => !SCOPED_CHUNK_QUERY_STOP_WORDS.has(token));
  const uniqueParts = Array.from(new Set([...quotedPhrases, ...thematicTokens])).slice(0, 20);
  return uniqueParts.join(" ");
}

function chunkSeedLimitForTaskMode(mode: unknown) {
  return mode === "exhaustive_corpus_search" ? 24 : 12;
}

function minimumVerifiedChunkFloorForTask(mode: unknown, intensity: "normal" | "high" | "maximum") {
  const base = mode === "exhaustive_corpus_search" ? 8 : 4;
  if (intensity === "maximum") {
    return base + 4;
  }
  if (intensity === "high") {
    return base + 2;
  }
  return base;
}

function buildWorkspaceSeedPassageQuery(taskSpec: Record<string, unknown>) {
  const searchHints = taskSpec.searchHints && typeof taskSpec.searchHints === "object"
    ? taskSpec.searchHints as Record<string, unknown>
    : null;
  const passageSearchFocus = typeof searchHints?.passageSearchFocus === "string" ? searchHints.passageSearchFocus : "";
  const question = typeof taskSpec.question === "string" ? taskSpec.question : "";
  const researchObjective = typeof taskSpec.researchObjective === "string" ? taskSpec.researchObjective : "";
  const fallback = passageSearchFocus || question || researchObjective;
  return simplifyScopedChunkQuery(fallback).trim() || fallback.trim();
}

function buildPassageQueryVariants(query: string, scopedWorkCount = 0, maxVariants = 3) {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const simplified = simplifyScopedChunkQuery(trimmed).trim();
  const base = simplified || trimmed;
  const broadQuery = isBroadCorpusResearchQuery(trimmed, scopedWorkCount);
  const tokens = Array.from(new Set(base.split(/\s+/u).map((token) => token.trim()).filter((token) => token.length >= 4)));
  const variants = new Set<string>([base]);
  if (broadQuery && tokens.length > 6) {
    variants.add(tokens.slice(0, 6).join(" "));
    if (tokens.length > 10) {
      variants.add(tokens.slice(6, 12).join(" "));
    } else {
      variants.add(tokens.slice(-6).join(" "));
    }
  }
  if (variants.size < maxVariants) {
    variants.add(trimmed);
  }
  return [...variants]
    .map((value) => value.replace(/\s+/gu, " ").trim())
    .filter((value) => value.length > 0)
    .slice(0, maxVariants);
}

function collectConfirmedWorkIds(
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
    progressDetails?: Array<Record<string, unknown>>;
  }>,
) {
  const workIds = new Set<string>();
  for (const entry of toolHistory) {
    if (entry.toolName === "get_relevant_chunks" && Array.isArray(entry.result.verifiedWorkIds)) {
      for (const workId of entry.result.verifiedWorkIds) {
        if (typeof workId === "string" && workId.trim().length > 0) {
          workIds.add(workId);
        }
      }
    }
    if (entry.toolName === "get_relevant_chunks" && Array.isArray(entry.result.chunks)) {
      for (const chunk of entry.result.chunks as Array<Record<string, unknown>>) {
        if (typeof chunk?.workId === "string" && chunk.workId.trim().length > 0) {
          workIds.add(chunk.workId);
        }
      }
    }
    if (!Array.isArray(entry.progressDetails)) {
      continue;
    }
    for (const detail of entry.progressDetails) {
      if (!detail || typeof detail !== "object") {
        continue;
      }
      if (
        (detail.type === "research.work" || detail.type === "research.chunk")
        && typeof detail.workId === "string"
        && detail.workId.trim().length > 0
      ) {
        workIds.add(detail.workId);
      }
    }
  }
  return [...workIds];
}

function mergeChunkSearchResults(results: ChunkSearchResult[][], limit: number): ChunkSearchResult[] {
  const byId = new Map<string, ChunkSearchResult>();
  for (const batch of results) {
    for (const chunk of batch) {
      const existing = byId.get(chunk.id);
      if (!existing || chunk.score > existing.score) {
        byId.set(chunk.id, chunk);
      }
    }
  }
  return [...byId.values()]
    .sort((left, right) => right.score - left.score || left.workId.localeCompare(right.workId) || left.chunkIndex - right.chunkIndex)
    .slice(0, limit);
}

type PriorRunEvidence = {
  frontierWorkIds: string[];
  verifiedWorkIds: string[];
  chunkIds: string[];
  citations: Citation[];
  priorAnswer: string | null;
};

function sanitizeAppCitations(input: unknown): Citation[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.workId !== "string" || typeof record.label !== "string" || typeof record.excerpt !== "string") {
      return [];
    }
    return [{
      workId: record.workId,
      label: record.label,
      excerpt: record.excerpt,
      ...(typeof record.chunkId === "string" ? { chunkId: record.chunkId } : {}),
      ...(typeof record.r2Key === "string" ? { r2Key: record.r2Key } : {}),
      ...(typeof record.readerPath === "string" ? { readerPath: record.readerPath } : {}),
    }];
  });
}

function looksLikeFollowUpMessage(message: string) {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.split(/\s+/u).length <= 12) {
    return true;
  }
  return /\b(that|those|these|them|it|this|previous|prior|before|earlier|follow up|follow-up|more examples|go deeper|expand|refine|counterexample|against that|for that)\b/i.test(trimmed);
}

function extractPriorRunEvidence(messages: MessageRecord[], currentRunId: string): PriorRunEvidence | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    if (typeof message.metadata?.runId === "string" && message.metadata.runId === currentRunId) {
      continue;
    }
    const toolCalls = Array.isArray(message.metadata?.toolCalls)
      ? message.metadata.toolCalls as Array<Record<string, unknown>>
      : [];
    if (toolCalls.length === 0) {
      continue;
    }
    const frontierWorkIds = new Set<string>();
    const verifiedWorkIds = new Set<string>();
    const chunkIds = new Set<string>();
    const citations = Array.isArray(message.metadata?.citations)
      ? sanitizeAppCitations(message.metadata.citations)
      : [];
    for (const entry of toolCalls) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const toolName = typeof entry.toolName === "string" ? entry.toolName : null;
      const args = entry.args && typeof entry.args === "object" ? entry.args as Record<string, unknown> : null;
      const result = entry.result && typeof entry.result === "object" ? entry.result as Record<string, unknown> : null;
      if (toolName === "run_workspace_task" && args?.taskSpec && typeof args.taskSpec === "object") {
        const taskSpec = args.taskSpec as Record<string, unknown>;
        const frontier = Array.isArray(taskSpec.frontierWorkIds) ? taskSpec.frontierWorkIds : [];
        const verified = Array.isArray(taskSpec.verifiedWorkIds) ? taskSpec.verifiedWorkIds : [];
        const chunks = Array.isArray(taskSpec.verifiedChunkIds) ? taskSpec.verifiedChunkIds : [];
        for (const workId of frontier) {
          if (typeof workId === "string" && workId.trim().length > 0) {
            frontierWorkIds.add(workId);
          }
        }
        for (const workId of verified) {
          if (typeof workId === "string" && workId.trim().length > 0) {
            verifiedWorkIds.add(workId);
          }
        }
        for (const chunkId of chunks) {
          if (typeof chunkId === "string" && chunkId.trim().length > 0) {
            chunkIds.add(chunkId);
          }
        }
      }
      if (toolName === "get_relevant_chunks") {
        const verified = Array.isArray(result?.verifiedWorkIds) ? result.verifiedWorkIds : [];
        const chunks = Array.isArray(result?.chunks) ? result.chunks as Array<Record<string, unknown>> : [];
        for (const workId of verified) {
          if (typeof workId === "string" && workId.trim().length > 0) {
            verifiedWorkIds.add(workId);
            frontierWorkIds.add(workId);
          }
        }
        for (const chunk of chunks) {
          if (!chunk || typeof chunk !== "object") {
            continue;
          }
          if (typeof chunk.workId === "string" && chunk.workId.trim().length > 0) {
            verifiedWorkIds.add(chunk.workId);
            frontierWorkIds.add(chunk.workId);
          }
          if (typeof chunk.id === "string" && chunk.id.trim().length > 0) {
            chunkIds.add(chunk.id);
          }
        }
      }
    }
    if (frontierWorkIds.size === 0 && verifiedWorkIds.size === 0 && chunkIds.size === 0 && citations.length === 0) {
      continue;
    }
    return {
      frontierWorkIds: [...frontierWorkIds],
      verifiedWorkIds: [...verifiedWorkIds],
      chunkIds: [...chunkIds],
      citations,
      priorAnswer: typeof message.content === "string" && message.content.trim().length > 0
        ? message.content.trim()
        : null,
    };
  }
  return null;
}

function shouldReusePriorEvidence(taskSpec: Record<string, unknown>, inputMessage: string) {
  const taskIntent = typeof taskSpec.taskIntent === "string" ? taskSpec.taskIntent : null;
  if (taskIntent === "follow_up_refinement" || taskIntent === "verification" || taskIntent === "counterexample_search") {
    return true;
  }
  return looksLikeFollowUpMessage(inputMessage);
}

function mergeTaskSpecWithPriorEvidence(taskSpec: Record<string, unknown>, priorEvidence: PriorRunEvidence | null, inputMessage: string) {
  if (!priorEvidence || !shouldReusePriorEvidence(taskSpec, inputMessage)) {
    return taskSpec;
  }
  const merged = { ...taskSpec };
  const existingFrontier = Array.isArray(taskSpec.frontierWorkIds) ? taskSpec.frontierWorkIds : [];
  const existingVerified = Array.isArray(taskSpec.verifiedWorkIds) ? taskSpec.verifiedWorkIds : [];
  const existingChunkIds = Array.isArray(taskSpec.chunkIds) ? taskSpec.chunkIds : [];
  const existingVerifiedChunkIds = Array.isArray(taskSpec.verifiedChunkIds) ? taskSpec.verifiedChunkIds : [];
  merged.frontierWorkIds = uniqueWorkIds([
    ...priorEvidence.frontierWorkIds,
    ...priorEvidence.verifiedWorkIds,
    ...existingFrontier.filter((value): value is string => typeof value === "string"),
  ]).slice(0, 160);
  merged.verifiedWorkIds = uniqueWorkIds([
    ...priorEvidence.verifiedWorkIds,
    ...existingVerified.filter((value): value is string => typeof value === "string"),
  ]).slice(0, 80);
  merged.chunkIds = uniqueWorkIds([
    ...priorEvidence.chunkIds,
    ...existingChunkIds.filter((value): value is string => typeof value === "string"),
  ]).slice(0, 128);
  merged.verifiedChunkIds = uniqueWorkIds([
    ...priorEvidence.chunkIds,
    ...existingVerifiedChunkIds.filter((value): value is string => typeof value === "string"),
  ]).slice(0, 128);
  merged.workIds = uniqueWorkIds([
    ...(Array.isArray(merged.verifiedWorkIds) ? merged.verifiedWorkIds as string[] : []),
    ...(Array.isArray(taskSpec.workIds) ? taskSpec.workIds.filter((value): value is string => typeof value === "string") : []),
  ]).slice(0, 64);
  merged.candidateWorkIds = uniqueWorkIds([
    ...(Array.isArray(merged.verifiedWorkIds) ? merged.verifiedWorkIds as string[] : []),
    ...(Array.isArray(taskSpec.candidateWorkIds) ? taskSpec.candidateWorkIds.filter((value): value is string => typeof value === "string") : []),
    ...(Array.isArray(merged.frontierWorkIds) ? merged.frontierWorkIds as string[] : []),
  ]).slice(0, 64);
  const followUpContext = merged.followUpContext && typeof merged.followUpContext === "object"
    ? { ...(merged.followUpContext as Record<string, unknown>) }
    : {};
  if (!followUpContext.priorAssistantSummary && priorEvidence.priorAnswer) {
    followUpContext.priorAssistantSummary = priorEvidence.priorAnswer.slice(0, 400);
  }
  merged.followUpContext = followUpContext;
  merged.followUpReuseMetrics = {
    frontierWorkCount: priorEvidence.frontierWorkIds.length,
    verifiedWorkCount: priorEvidence.verifiedWorkIds.length,
    chunkCount: priorEvidence.chunkIds.length,
    citationCount: priorEvidence.citations.length,
  };
  return merged;
}

function frontierWorkMetadataById(taskSpec: Record<string, unknown>) {
  const retrieval = taskSpec.retrieval && typeof taskSpec.retrieval === "object"
    ? taskSpec.retrieval as Record<string, unknown>
    : null;
  const frontierWorks = Array.isArray(retrieval?.frontierWorks)
    ? retrieval.frontierWorks as Array<Record<string, unknown>>
    : [];
  return new Map(
    frontierWorks
      .filter((work) => work && typeof work === "object" && typeof work.id === "string")
      .map((work) => [String(work.id), work]),
  );
}

function shardWorkerLimitForIntensity(intensity: unknown) {
  if (intensity === "maximum") {
    return 6;
  }
  if (intensity === "high") {
    return 3;
  }
  return 1;
}

function shouldExecuteShardedWorkspaceTask(taskSpec: Record<string, unknown>) {
  if (taskSpec.shardWorker === true || taskSpec.shardReducer === true) {
    return false;
  }
  if (taskSpec.mode !== "exhaustive_corpus_search") {
    return false;
  }
  const parallelism = typeof taskSpec.parallelism === "number" ? taskSpec.parallelism : 1;
  const shardPlan = Array.isArray(taskSpec.shardPlan) ? taskSpec.shardPlan : [];
  return parallelism > 1 && shardPlan.length > 1;
}

function hashBucketForWorkId(workId: string) {
  let hash = 0;
  for (let index = 0; index < workId.length; index += 1) {
    hash = (hash * 31 + workId.charCodeAt(index)) >>> 0;
  }
  return hash % 1000;
}

function selectShardWorkIds(taskSpec: Record<string, unknown>, shard: Record<string, unknown>, fallbackIndex: number, fallbackTotal: number) {
  const retrieval = taskSpec.retrieval && typeof taskSpec.retrieval === "object"
    ? taskSpec.retrieval as Record<string, unknown>
    : null;
  const verifiedWorkIds = Array.isArray(taskSpec.verifiedWorkIds)
    ? uniqueWorkIds(taskSpec.verifiedWorkIds.filter((value): value is string => typeof value === "string"))
    : [];
  const retrievalFrontierIds = Array.isArray(retrieval?.frontierWorks)
    ? uniqueWorkIds(
        (retrieval.frontierWorks as Array<Record<string, unknown>>).map((work) =>
          typeof work?.id === "string" ? work.id : null),
      )
    : [];
  const frontierWorkIds = uniqueWorkIds([
    ...verifiedWorkIds,
    ...(Array.isArray(taskSpec.frontierWorkIds)
      ? taskSpec.frontierWorkIds.filter((value): value is string => typeof value === "string")
      : []),
    ...(Array.isArray(taskSpec.candidateWorkIds)
      ? taskSpec.candidateWorkIds.filter((value): value is string => typeof value === "string")
      : []),
    ...(Array.isArray(taskSpec.workIds)
      ? taskSpec.workIds.filter((value): value is string => typeof value === "string")
      : []),
    ...retrievalFrontierIds,
  ]);
  const metadataById = frontierWorkMetadataById(taskSpec);
  const fallbackShardWorkIds = frontierWorkIds.filter((_, index) => index % Math.max(1, fallbackTotal) === fallbackIndex);
  const axis = typeof shard.axis === "string" ? shard.axis : null;
  if (axis === "work_id_hash") {
    const start = typeof shard.hashBucketStart === "number" ? shard.hashBucketStart : 0;
    const end = typeof shard.hashBucketEnd === "number" ? shard.hashBucketEnd : 1000;
    const matched = frontierWorkIds.filter((workId) => {
      const bucket = hashBucketForWorkId(workId);
      return bucket >= start && bucket < end;
    });
    return matched.length > 0 ? matched : fallbackShardWorkIds;
  }
  if (axis === "author_initial") {
    const start = typeof shard.authorInitialStart === "string" ? shard.authorInitialStart.toUpperCase() : "A";
    const end = typeof shard.authorInitialEnd === "string" ? shard.authorInitialEnd.toUpperCase() : "Z";
    const matched = frontierWorkIds.filter((workId) => {
      const work = metadataById.get(workId);
      const authors = Array.isArray(work?.authors) ? work.authors : [];
      const firstAuthor = authors.find((author): author is string => typeof author === "string" && author.trim().length > 0) ?? "";
      const initial = firstAuthor.trim().charAt(0).toUpperCase();
      return initial >= start && initial <= end;
    });
    return matched.length > 0 ? matched : fallbackShardWorkIds;
  }
  if (axis === "publication_year") {
    const start = typeof shard.yearStart === "number" ? shard.yearStart : -Infinity;
    const end = typeof shard.yearEnd === "number" ? shard.yearEnd : Infinity;
    const matched = frontierWorkIds.filter((workId) => {
      const work = metadataById.get(workId);
      const year = typeof work?.firstPublishedYear === "number"
        ? work.firstPublishedYear
        : typeof work?.publicationYear === "number"
          ? work.publicationYear
          : null;
      return year !== null && year >= start && year <= end;
    });
    return matched.length > 0 ? matched : fallbackShardWorkIds;
  }
  return fallbackShardWorkIds;
}

function buildShardTaskSpec(baseTaskSpec: Record<string, unknown>, shard: Record<string, unknown>, shardWorkIds: string[]) {
  const shardTaskSpec = structuredClone(baseTaskSpec);
  const shardWorkIdSet = new Set(shardWorkIds);
  shardTaskSpec.shardWorker = true;
  shardTaskSpec.parallelism = 1;
  shardTaskSpec.currentShard = shard;
  shardTaskSpec.workIds = shardWorkIds.slice(0, 32);
  shardTaskSpec.candidateWorkIds = shardWorkIds.slice(0, 32);
  shardTaskSpec.frontierWorkIds = shardWorkIds.slice(0, 48);
  if (Array.isArray(shardTaskSpec.verifiedWorkIds)) {
    shardTaskSpec.verifiedWorkIds = uniqueWorkIds(
      shardTaskSpec.verifiedWorkIds.filter((value): value is string => typeof value === "string" && shardWorkIdSet.has(value)),
    );
  }
  if (Array.isArray(shardTaskSpec.chunkIds)) {
    const retrieval = shardTaskSpec.retrieval && typeof shardTaskSpec.retrieval === "object"
      ? shardTaskSpec.retrieval as Record<string, unknown>
      : null;
    const shardChunkIds = new Set<string>();
    for (const key of ["seedChunks", "verifiedChunks"] as const) {
      const chunks = Array.isArray(retrieval?.[key]) ? retrieval[key] as Array<Record<string, unknown>> : [];
      for (const chunk of chunks) {
        if (typeof chunk?.id === "string" && typeof chunk?.workId === "string" && shardWorkIdSet.has(chunk.workId)) {
          shardChunkIds.add(chunk.id);
        }
      }
    }
    if (shardChunkIds.size > 0) {
      shardTaskSpec.chunkIds = shardTaskSpec.chunkIds.filter((value): value is string => typeof value === "string" && shardChunkIds.has(value));
    }
  }
  if (shardTaskSpec.retrieval && typeof shardTaskSpec.retrieval === "object") {
    const retrieval = { ...(shardTaskSpec.retrieval as Record<string, unknown>) };
    const filterWorks = (input: unknown) =>
      Array.isArray(input)
        ? (input as Array<Record<string, unknown>>).filter((work) => typeof work?.id === "string" && shardWorkIdSet.has(work.id))
        : input;
    const filterChunks = (input: unknown) =>
      Array.isArray(input)
        ? (input as Array<Record<string, unknown>>).filter((chunk) => typeof chunk?.workId === "string" && shardWorkIdSet.has(chunk.workId))
        : input;
    retrieval.frontierWorks = filterWorks(retrieval.frontierWorks);
    retrieval.searchWorks = filterWorks(retrieval.searchWorks);
    retrieval.metadataWorks = filterWorks(retrieval.metadataWorks);
    retrieval.seedChunks = filterChunks(retrieval.seedChunks);
    retrieval.verifiedChunks = filterChunks(retrieval.verifiedChunks);
    shardTaskSpec.retrieval = retrieval;
  }
  const searchHints = shardTaskSpec.searchHints && typeof shardTaskSpec.searchHints === "object"
    ? { ...(shardTaskSpec.searchHints as Record<string, unknown>) }
    : {};
  const strategy = typeof shard.strategy === "string" ? shard.strategy : null;
  if (strategy === "supporting_evidence") {
    searchHints.passageSearchFocus = "Find the strongest passages that support the hypothesis or claim.";
    searchHints.synthesisMode = "verdict_supporting";
  } else if (strategy === "opposing_evidence") {
    searchHints.passageSearchFocus = "Find the strongest passages that challenge, weaken, or contradict the hypothesis or claim.";
    searchHints.synthesisMode = "verdict_opposing";
  } else if (strategy === "verification") {
    searchHints.passageSearchFocus = "Find passages that directly verify whether the prior claim is actually supported.";
    searchHints.synthesisMode = "verification";
  } else if (strategy === "gap_fill") {
    searchHints.passageSearchFocus = "Find missing categories, underrepresented evidence, and gaps left by earlier retrieval.";
  }
  searchHints.frontierDiscipline = "Only inspect the supplied shard-local books and shard-local seed passages. Do not open or touch unrelated titles unless a new title is directly justified by a verified grief-relevant passage.";
  shardTaskSpec.searchHints = searchHints;
  return shardTaskSpec;
}

function normalizeSearchLanguageFilter(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (/^[a-z]{2,3}$/u.test(normalized)) {
    return normalized;
  }
  return undefined;
}

function normalizeYearRangeFilter(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) {
    return undefined;
  }
  const first = Number(value[0]);
  const second = Number(value[1]);
  if (!Number.isInteger(first) || !Number.isInteger(second)) {
    return undefined;
  }
  return [Math.min(first, second), Math.max(first, second)];
}

function normalizeDateRangeFilter(value: unknown): [number, number] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const from = Number(record.from ?? record.start ?? record.gte ?? record.min);
  const to = Number(record.to ?? record.end ?? record.lte ?? record.max);
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return undefined;
  }
  return [Math.min(from, to), Math.max(from, to)];
}

function normalizePublicationYearFilter(value: unknown): [number, number] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const from = Number(record.from ?? record.start ?? record.gte ?? record.min);
  const to = Number(record.to ?? record.end ?? record.lte ?? record.max);
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return undefined;
  }
  return [Math.min(from, to), Math.max(from, to)];
}

function normalizeGenreFilter(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const genres = value
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim().toLowerCase())
    .filter((candidate) => candidate.length > 0)
    .slice(0, 8);
  return genres.length > 0 ? genres : undefined;
}

function inferGenreFilterFromQuery(value: unknown): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (/\b(fiction|novel|novels|story|stories|tale|tales)\b/u.test(normalized)) {
    return ["fiction"];
  }
  return undefined;
}

function inferFictionGenreFromContext(...values: Array<unknown>): string[] | undefined {
  for (const value of values) {
    const inferred = inferGenreFilterFromQuery(value);
    if (inferred) {
      return inferred;
    }
  }
  return undefined;
}

function normalizeMetadataSearchQuery(query: unknown, filters: Record<string, unknown>): string | undefined {
  if (typeof query !== "string") {
    return typeof query === "undefined" ? undefined : String(query);
  }
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  const normalizedGenre = normalizeGenreFilter(filters.genre);
  const wantsFiction = normalizedGenre?.includes("fiction")
    || inferGenreFilterFromQuery(trimmed)?.includes("fiction")
    || false;
  const lower = trimmed.toLowerCase();
  const wantsGrief = /\b(grief|mourning|bereavement|funeral|lament|sorrow|weep|wept|weeping|tears|consolation|despair)\b/u.test(lower);
  if (!wantsFiction || !wantsGrief) {
    return trimmed;
  }

  const sanitized = trimmed
    .replace(/\b(?:OR\s+)?"dead"(?:\s+OR)?\b/giu, " ")
    .replace(/\b(?:OR\s+)?"death"(?:\s+OR)?\b/giu, " ")
    .replace(/\b(?:OR\s+)?dead\*?(?:\s+OR)?\b/giu, " ")
    .replace(/\b(?:OR\s+)?death\*?(?:\s+OR)?\b/giu, " ")
    .replace(/\b(?:OR\s+)?(?:revenge|travel|religion|work|denial|illness|confession|artistic|expression|remarriage|acceptance|stoicism|resignation|self-destruction|self destruction)(?:\s+OR)?\b/giu, " ")
    .replace(/\(\s*OR\s+/giu, "(")
    .replace(/\s+OR\s+\)/giu, ")")
    .replace(/\(\s*\)/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .replace(/\(\s+/gu, "(")
    .replace(/\s+\)/gu, ")")
    .trim();

  return sanitized.length > 0 ? sanitized : trimmed;
}

function normalizeToolArgs(toolName: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...args };
  switch (toolName) {
    case "semantic_deep_search":
      if (normalized.workIds === null) {
        delete normalized.workIds;
      }
      if (normalized.workIds === undefined && normalized.work_ids !== undefined) {
        normalized.workIds = normalized.work_ids;
      }
      if (normalized.maxResults === undefined && normalized.max_results !== undefined) {
        normalized.maxResults = normalized.max_results;
      }
      if (typeof normalized.maxResults === "number") {
        normalized.maxResults = Math.max(1, Math.min(12, Math.trunc(normalized.maxResults)));
      }
      if (normalized.backend !== "alphaloop" && normalized.backend !== "context1") {
        delete normalized.backend;
      }
      break;
    case "estimate_research_scope":
    case "search_works":
      if (toolName === "estimate_research_scope") {
        if (normalized.workIds === undefined && normalized.work_ids !== undefined) {
          normalized.workIds = normalized.work_ids;
        }
        if (normalized.chunkIds === undefined && normalized.chunk_ids !== undefined) {
          normalized.chunkIds = normalized.chunk_ids;
        }
      }
      if (normalized.filters && typeof normalized.filters === "object") {
        const filters = { ...(normalized.filters as Record<string, unknown>) };
        const language = normalizeSearchLanguageFilter(filters.language);
        if (language) {
          filters.language = language;
        } else {
          delete filters.language;
        }
        if (toolName === "search_works" && typeof filters.limit === "number") {
          filters.limit = Math.max(1, Math.min(80, Math.trunc(filters.limit)));
        } else if (toolName !== "search_works") {
          delete filters.limit;
        }
        const yearRange = normalizeYearRangeFilter(filters.yearRange)
          ?? normalizeDateRangeFilter(filters.dateRange)
          ?? normalizePublicationYearFilter(filters.publicationYear);
        if (yearRange) {
          filters.yearRange = yearRange;
        } else {
          delete filters.yearRange;
        }
        delete filters.dateRange;
        delete filters.publicationYear;
        const genre = normalizeGenreFilter(filters.genre) ?? inferGenreFilterFromQuery(normalized.query);
        if (genre) {
          filters.genre = genre;
        } else {
          delete filters.genre;
        }
        normalized.query = normalizeMetadataSearchQuery(normalized.query, filters);
        normalized.filters = filters;
      }
      break;
    case "classify_candidate_chunks":
      if (normalized.chunkIds === undefined && normalized.chunk_ids !== undefined) {
        normalized.chunkIds = normalized.chunk_ids;
      }
      if (normalized.maxRelevantChunks === undefined && normalized.max_relevant_chunks !== undefined) {
        normalized.maxRelevantChunks = normalized.max_relevant_chunks;
      }
      if (normalized.maxRelevantWorks === undefined && normalized.max_relevant_works !== undefined) {
        normalized.maxRelevantWorks = normalized.max_relevant_works;
      }
      break;
    case "get_work_metadata":
      if (normalized.workIds === null) {
        delete normalized.workIds;
      }
      if (normalized.workIds === undefined && normalized.work_ids !== undefined) {
        normalized.workIds = normalized.work_ids;
      }
      break;
    case "get_relevant_chunks":
      if (normalized.workIds === null) {
        delete normalized.workIds;
      }
      if (normalized.work_ids === null) {
        delete normalized.work_ids;
      }
      if (normalized.workIds === undefined && normalized.work_ids !== undefined) {
        normalized.workIds = normalized.work_ids;
      }
      if (normalized.filters && typeof normalized.filters === "object") {
        const filters = { ...(normalized.filters as Record<string, unknown>) };
        const language = normalizeSearchLanguageFilter(filters.language);
        if (language) {
          filters.language = language;
        } else {
          delete filters.language;
        }
        if (filters.limit === null) {
          delete filters.limit;
        }
        if (typeof filters.limit === "number") {
          filters.limit = Math.max(1, Math.min(80, Math.trunc(filters.limit)));
        }
        const yearRange = normalizeYearRangeFilter(filters.yearRange);
        if (yearRange) {
          filters.yearRange = yearRange;
        } else {
          delete filters.yearRange;
        }
        const genre = normalizeGenreFilter(filters.genre);
        if (genre) {
          filters.genre = genre;
        } else {
          delete filters.genre;
        }
        normalized.filters = filters;
      }
      if (typeof normalized.query === "string" && Array.isArray(normalized.workIds) && normalized.workIds.length > 0) {
        const simplifiedScopedQuery = simplifyScopedChunkQuery(normalized.query);
        if (simplifiedScopedQuery.length > 0) {
          normalized.query = simplifiedScopedQuery;
        }
      }
      break;
    case "get_work_text":
      if (normalized.workId === undefined && normalized.work_id !== undefined) {
        normalized.workId = normalized.work_id;
      }
      break;
    case "create_workspace":
      if (normalized.workIds === undefined && normalized.work_ids !== undefined) {
        normalized.workIds = normalized.work_ids;
      }
      if (normalized.chunkIds === undefined && normalized.chunk_ids !== undefined) {
        normalized.chunkIds = normalized.chunk_ids;
      }
      if (normalized.taskContext === undefined && normalized.task_context !== undefined) {
        normalized.taskContext = normalized.task_context;
      }
      if (typeof normalized.taskContext === "string") {
        normalized.taskContext = {
          prompt: normalized.taskContext,
        };
      } else if (Array.isArray(normalized.taskContext)) {
        normalized.taskContext = {
          items: normalized.taskContext,
        };
      } else if (!normalized.taskContext || typeof normalized.taskContext !== "object") {
        normalized.taskContext = {};
      }
      break;
    case "run_workspace_task":
      if (normalized.runtimeId === undefined && normalized.runtime_id !== undefined) {
        normalized.runtimeId = normalized.runtime_id;
      }
      if (normalized.taskSpec === undefined && normalized.task_spec !== undefined) {
        normalized.taskSpec = normalized.task_spec;
      }
      if (typeof normalized.taskSpec === "string") {
        normalized.taskSpec = {
          prompt: normalized.taskSpec,
        };
      }
      break;
    case "read_workspace_file":
      if (normalized.runtimeId === undefined && normalized.runtime_id !== undefined) {
        normalized.runtimeId = normalized.runtime_id;
      }
      break;
    case "destroy_workspace":
      if (normalized.runtimeId === undefined && normalized.runtime_id !== undefined) {
        normalized.runtimeId = normalized.runtime_id;
      }
      break;
    default:
      break;
  }
  return normalized;
}

function augmentSearchWorksArgsFromContext(
  toolName: ToolName,
  args: Record<string, unknown>,
  rationale: string | null | undefined,
  routedQuery: string,
) {
  if (toolName !== "search_works") {
    return args;
  }
  const filters = args.filters && typeof args.filters === "object"
    ? { ...(args.filters as Record<string, unknown>) }
    : {};
  if (!Array.isArray(filters.genre) || filters.genre.length === 0) {
    const inferredGenre = inferFictionGenreFromContext(args.query, rationale, routedQuery);
    if (inferredGenre) {
      filters.genre = inferredGenre;
    }
  }
  return {
    ...args,
    filters,
  };
}

function zodErrorIncludesPath(error: ZodError, path: string[]) {
  return error.issues.some((issue) =>
    issue.path.length === path.length && issue.path.every((part, index) => part === path[index]),
  );
}

function formatToolExecutionError(toolName: ToolName, error: unknown) {
  if (error instanceof ZodError) {
    if (toolName === "get_relevant_chunks") {
      if (zodErrorIncludesPath(error, ["filters", "limit"])) {
        return "Passage search requested more than the allowed number of passages at once.";
      }
      return "Passage search received invalid arguments.";
    }
    if (toolName === "search_works") {
      return "Corpus search requested too many results at once.";
    }
    return "This research step received invalid arguments.";
  }
  return error instanceof Error ? error.message : "Unknown tool error";
}

function streamResponse(
  executor: (send: (event: string, data: Record<string, unknown>) => Promise<void>) => Promise<void>,
  onError?: (error: unknown) => Promise<void>,
  onClose?: () => void | Promise<void>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let streamClosed = false;
      let closeNotified = false;
      const notifyClose = async () => {
        if (closeNotified) {
          return;
        }
        closeNotified = true;
        await onClose?.();
      };
      const send = async (event: string, data: Record<string, unknown>) => {
        if (streamClosed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(sseEvent(event, data)));
        } catch {
          streamClosed = true;
          await notifyClose();
        }
      };

      try {
        await executor(send);
      } catch (error) {
        if (onError) {
          await onError(error);
        }
        if (!streamClosed) {
          await send("error", {
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      } finally {
        if (!streamClosed) {
          controller.close();
        }
      }
    },
    async cancel() {
      await onClose?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

type QueuedStreamItem =
  | {
      type: "event";
      event: string;
      data: Record<string, unknown>;
    }
  | {
      type: "error";
      error: unknown;
    }
  | {
      type: "close";
    };

function streamQueuedEventsResponse(
  start: (relaySend: (event: string, data: Record<string, unknown>) => Promise<void>) => Promise<void> | void,
  onError?: (error: unknown) => Promise<void>,
) {
  const queue: QueuedStreamItem[] = [];
  let pendingResolve: ((item: QueuedStreamItem) => void) | null = null;
  let streamClosed = false;

  const push = (item: QueuedStreamItem) => {
    if (streamClosed) {
      return;
    }
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(item);
      return;
    }
    queue.push(item);
  };

  const nextItem = async (): Promise<QueuedStreamItem> => {
    if (queue.length > 0) {
      return queue.shift()!;
    }
    return await new Promise<QueuedStreamItem>((resolve) => {
      pendingResolve = resolve;
    });
  };

  const relaySend = async (event: string, data: Record<string, unknown>) => {
    push({
      type: "event",
      event,
      data,
    });
  };

  void Promise.resolve(start(relaySend))
    .then(() => {
      push({
        type: "close",
      });
    })
    .catch((error) => {
      push({
        type: "error",
        error,
      });
    });

  return streamResponse(
    async (send) => {
      while (true) {
        const item = await nextItem();
        if (item.type === "close") {
          return;
        }
        if (item.type === "error") {
          throw item.error;
        }
        await send(item.event, item.data);
      }
    },
    onError,
    async () => {
      streamClosed = true;
      pendingResolve?.({
        type: "close",
      });
      pendingResolve = null;
    },
  );
}

function isTerminalRunStatus(status: string | null | undefined): status is "completed" | "failed" | "timed_out" {
  return status === "completed" || status === "failed" || status === "timed_out";
}

export type ActiveRunState = {
  sessionId: string;
  userId: string;
  runtimeIds: Set<string>;
  cancelRequested: boolean;
  rawLog: ToolRunRawLogEntry[];
  subscribers: Map<string, (event: string, data: Record<string, unknown>) => Promise<void>>;
};

export type RunOrchestratorOptions = {
  precomputedRouteDecision?: RouterDecision;
  recovery?: {
    skipUserMessageAppend?: boolean;
  };
};

type AuditLogger = (event: string, payload: Record<string, unknown>) => void;

function decorateWork(c: Context, work: WorkSummary): WorkSummary {
  const metadata = "metadata" in work && work.metadata && typeof work.metadata === "object"
    ? (work.metadata as Record<string, unknown>)
    : null;
  const coverImageKey = metadata && typeof metadata.coverImageKey === "string" ? metadata.coverImageKey : null;
  if (work.coverImageUrl || !coverImageKey) {
    return work;
  }
  return {
    ...work,
    coverImageUrl: new URL(`/works/${work.id}/cover`, c.req.url).toString(),
  };
}

function decorateCorpusDocument(c: Context, document: {
  id: string;
  title: string;
  externalId?: string | number | null;
  subtitle?: string | null;
  coverImageUrl?: string | null;
  hasCoverImage?: boolean;
  language?: string | null;
  publishedAt?: string | null;
  rightsStatus?: string | null;
  summary?: string | null;
  publisher?: string | null;
  contributors?: string[];
  subjects?: string[];
  score?: number;
  metadata?: Record<string, unknown>;
}) {
  const metadata = document.metadata && typeof document.metadata === "object"
    ? document.metadata as Record<string, unknown>
    : null;
  const coverImageKey = metadata && typeof metadata.coverImageKey === "string" ? metadata.coverImageKey : null;
  if (document.coverImageUrl || !coverImageKey) {
    return document;
  }
  return {
    ...document,
    coverImageUrl: new URL(`/api/v1/documents/${document.id}/cover`, c.req.url).toString(),
  };
}

function decorateDocumentDetail(c: Context, work: WorkDetailRecord) {
  const metadata = work.metadata && typeof work.metadata === "object" ? work.metadata as Record<string, unknown> : null;
  const document = workDetailToDocumentDetail(work);
  const coverImageKey = metadata && typeof metadata.coverImageKey === "string" ? metadata.coverImageKey : null;
  if (document.coverImageUrl || !coverImageKey) {
    return document;
  }
  return {
    ...document,
    coverImageUrl: new URL(`/api/v1/documents/${work.id}/cover`, c.req.url).toString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeWorkSummary(value: unknown): value is WorkSummary {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string";
}

function looksLikeWorkDetail(value: unknown): value is WorkDetailRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.title === "string"
    && isRecord(value.metadata);
}

const PLATFORM_EVENT_KEY_ALIASES: Record<string, string> = {
  work: "document",
  works: "documents",
  workId: "documentId",
  workIds: "documentIds",
  workTitle: "documentTitle",
  verifiedWorkIds: "verifiedDocumentIds",
  relevantWorkIds: "relevantDocumentIds",
  candidateWorkIds: "candidateDocumentIds",
  scopedWorkIds: "scopedDocumentIds",
  frontierWorks: "frontierDocuments",
};

function toPlatformEventPayload(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    if (parentKey === "works" || parentKey === "frontierWorks") {
      return value.map((entry) => (looksLikeWorkSummary(entry) ? workSummaryToDocumentSummary(entry) : toPlatformEventPayload(entry)));
    }
    if (parentKey === "citations") {
      return value.map((entry) => toPlatformEventPayload(entry));
    }
    return value.map((entry) => toPlatformEventPayload(entry));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (parentKey === "work" && looksLikeWorkDetail(value)) {
    return workDetailToDocumentDetail(value);
  }
  if (parentKey === "work" && looksLikeWorkSummary(value)) {
    return workSummaryToDocumentSummary(value);
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const nextKey = PLATFORM_EVENT_KEY_ALIASES[key] ?? key;
    if ((key === "toolName" || key === "tool_name") && typeof entry === "string") {
      result[nextKey] = toPlatformToolName(entry) ?? entry;
      continue;
    }
    if (key === "works" && Array.isArray(entry)) {
      result[nextKey] = entry.map((item) => (looksLikeWorkSummary(item) ? workSummaryToDocumentSummary(item) : toPlatformEventPayload(item)));
      continue;
    }
    if (key === "work" && isRecord(entry)) {
      result[nextKey] = looksLikeWorkDetail(entry)
        ? workDetailToDocumentDetail(entry)
        : looksLikeWorkSummary(entry)
          ? workSummaryToDocumentSummary(entry)
          : toPlatformEventPayload(entry, key);
      continue;
    }
    result[nextKey] = toPlatformEventPayload(entry, key);
  }
  return result;
}

function escapeBookHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeStoredBookHtml(content: string) {
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const extracted = bodyMatch?.[1] ?? content;
  return extracted
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<(?:link|meta|base|iframe|object|embed|form|input|button)[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\1/gi, "");
}

function buildFallbackBookHtml(work: WorkDetailRecord, content: string, format: "html" | "text") {
  const metadata = work.metadata && typeof work.metadata === "object" ? work.metadata as Record<string, unknown> : {};
  const byline = Array.isArray(work.authors) ? work.authors.join(" · ") : "";
  const sourceMarkup = format === "html"
    ? sanitizeStoredBookHtml(content)
    : content
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${escapeBookHtml(paragraph).replace(/\n/g, "<br />")}</p>`)
      .join("\n");
  const meta = [
    work.gutenbergId ? `Project Gutenberg #${work.gutenbergId}` : null,
    formatDisplayLanguage(work.language)?.toUpperCase() ?? null,
    work.releaseDate ? work.releaseDate.slice(0, 4) : null,
  ].filter(Boolean).join(" · ");
  const subtitle = typeof metadata.subtitle === "string" ? metadata.subtitle : null;
  const bookshelves = Array.isArray(metadata.bookshelves)
    ? metadata.bookshelves.filter((value): value is string => typeof value === "string").slice(0, 12)
    : [];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeBookHtml(work.title)} | alpha book</title>
    <meta name="robots" content="noindex,nofollow" />
    <style>
      :root {
        color-scheme: light;
        --bg:#f6f3ee;
        --ink:#171717;
        --muted:rgba(23,23,23,0.62);
        --accent:rgba(37,99,235,0.16);
        --accent-strong:rgba(37,99,235,0.24);
      }
      * { box-sizing:border-box; }
      html { scroll-behavior:smooth; }
      body {
        margin:0;
        font-family:"Newsreader", Georgia, serif;
        color:var(--ink);
        background:transparent;
        text-rendering:optimizeLegibility;
        -webkit-font-smoothing:antialiased;
        -moz-osx-font-smoothing:grayscale;
      }
      a { color:inherit; text-decoration-thickness:0.06em; text-underline-offset:0.14em; }
      .page { width:min(84ch, calc(100vw - 12px)); margin:0 auto; padding:4px 0 14px; }
      .hero { display:grid; gap:6px; margin-bottom:1.2rem; }
      .eyebrow,.byline,.summary,.meta-list { margin:0; color:var(--muted); font-size:0.96rem; line-height:1.5; }
      h1 { margin:0; font-size:clamp(2rem, 4vw, 3.25rem); line-height:0.96; letter-spacing:-0.04em; font-weight:600; }
      .meta-list span + span::before { content:" · "; }
      .reader-body { font-size:1.14rem; line-height:1.72; }
      .reader-body h1,.reader-body h2,.reader-body h3,.reader-body h4,.reader-body h5,.reader-body h6 { font-size:1.18em; line-height:1.18; margin:1.7em 0 0.45em; letter-spacing:-0.02em; }
      .reader-body p,.reader-body li,.reader-body blockquote,.reader-body pre { margin:0 0 1em; }
      .reader-body blockquote { margin-left:0; padding-left:0; color:var(--muted); font-style:italic; }
      .reader-body pre { white-space:pre-wrap; font:inherit; line-height:1.65; }
      .reader-body [data-passage-id],.reader-body [data-anchor-id] { scroll-margin-top:24px; }
      .reader-body [data-passage-id]:target { text-decoration-line:underline; text-decoration-color:var(--accent-strong); text-decoration-thickness:0.14em; text-underline-offset:0.14em; outline:none; }
      @media (max-width:780px) {
        .page { width:min(100vw - 8px, 100%); padding:2px 0 12px; }
        .reader-body { font-size:1.06rem; line-height:1.66; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero">
        ${meta ? `<p class="eyebrow">${escapeBookHtml(meta)}</p>` : ""}
        <h1>${escapeBookHtml(work.title)}</h1>
        ${subtitle ? `<p class="summary">${escapeBookHtml(subtitle)}</p>` : ""}
        ${byline ? `<p class="byline">${escapeBookHtml(byline)}</p>` : ""}
        ${work.summary ? `<p class="summary">${escapeBookHtml(work.summary)}</p>` : ""}
        ${bookshelves.length > 0 ? `<p class="meta-list">${bookshelves.map((value) => `<span>${escapeBookHtml(value)}</span>`).join("")}</p>` : ""}
      </section>
      <div class="reader-body">${sourceMarkup || "<p>No stored source content yet.</p>"}</div>
    </main>
  </body>
</html>`;
}

async function executeTool(
  deps: AppDeps,
  toolName: ToolName,
  args: Record<string, unknown>,
  context: {
    userId: string;
    sessionId: string;
    runId: string;
    auditLog?: AuditLogger;
    progressReporter?: (text: string, detail?: Record<string, unknown>) => Promise<void>;
  },
): Promise<Record<string, unknown>> {
  const normalizedArgs = normalizeToolArgs(toolName, args);
  switch (toolName) {
    case "semantic_deep_search": {
      if (!deps.semanticSearch) {
        throw new Error("Semantic search is not configured.");
      }
      const parsed = ToolArgsSchemas.semantic_deep_search.parse(normalizedArgs);
      const result = await deps.semanticSearch.search({
        query: parsed.query,
        workIds: parsed.workIds,
        maxResults: parsed.maxResults ?? 8,
        backend: parsed.backend,
        billingContext: {
          userId: context.userId,
          sessionId: context.sessionId,
          runId: context.runId,
          source: "semantic_search",
        },
        onProgress: context.progressReporter,
        auditLog: context.auditLog,
      });
      return structuredClone(result) as Record<string, unknown>;
    }
    case "estimate_research_scope": {
      const parsed = ToolArgsSchemas.estimate_research_scope.parse(normalizedArgs);
      if ((Array.isArray(parsed.workIds) && parsed.workIds.length > 0) || (Array.isArray(parsed.chunkIds) && parsed.chunkIds.length > 0)) {
        const sizedChunks = Array.isArray(parsed.chunkIds) && parsed.chunkIds.length > 0
          ? await deps.store.getChunksByIds(parsed.chunkIds)
          : [];
        const sizedWorkIds = uniqueWorkIds([
          ...(Array.isArray(parsed.workIds) ? parsed.workIds : []),
          ...sizedChunks.map((chunk) => chunk.workId),
        ]);
        const workload = await deps.store.estimateWorkSetSize(sizedWorkIds, parsed.filters);
        const estimate = {
          query: parsed.query,
          scopeMode: sizedWorkIds.length <= 12 ? "focused" : isBroadCorpusResearchQuery(parsed.query, sizedWorkIds.length) ? "corpus_wide" : "subset_wide",
          metadataWorkEstimate: sizedWorkIds.length,
          chunkMatchEstimate: sizedChunks.length,
          chunkWorkEstimate: new Set(sizedChunks.map((chunk) => chunk.workId)).size,
          totalWorkEstimate: workload.workCount,
          totalChunkEstimate: workload.totalChunkCount,
          totalTextBytesEstimate: workload.totalTextBytes,
          breadthBand:
            workload.workCount >= 320 || workload.totalChunkCount >= 48_000 ? "huge"
              : workload.workCount >= 128 || workload.totalChunkCount >= 18_000 ? "large"
                : workload.workCount >= 48 || workload.totalChunkCount >= 6_000 ? "medium"
                  : workload.workCount >= 12 || workload.totalChunkCount >= 1_500 ? "small"
                    : "tiny",
          recommendedIntensity:
            workload.totalChunkCount >= 18_000 || workload.workCount >= 128 ? "maximum"
              : workload.totalChunkCount >= 6_000 || workload.workCount >= 48 ? "high"
                : sizedWorkIds.length <= 12 ? "normal" : "high",
          recommendedWallClockMinutes:
            workload.totalChunkCount >= 18_000 || workload.workCount >= 128 ? 60
              : workload.totalChunkCount >= 6_000 || workload.workCount >= 48 ? 15
                : 5,
          recommendedParallelism:
            workload.totalChunkCount >= 48_000 || workload.workCount >= 320 ? 12
              : workload.totalChunkCount >= 18_000 || workload.workCount >= 128 ? 8
                : workload.totalChunkCount >= 6_000 || workload.workCount >= 48 ? 4
                  : sizedWorkIds.length <= 12 ? 1 : 2,
          recommendedShardAxis:
            workload.totalChunkCount >= 1_500 || workload.workCount >= 12 ? "work_id_hash" : "none",
          recommendedVmWorkBudget:
            workload.totalChunkCount >= 18_000 || workload.workCount >= 128 ? 48
              : workload.totalChunkCount >= 6_000 || workload.workCount >= 48 ? 32
                : 20,
          recommendedFrontierWorks:
            workload.workCount >= 128 ? Math.min(workload.workCount, 128)
              : workload.workCount >= 48 ? Math.min(workload.workCount, 72)
                : Math.max(8, Math.min(workload.workCount, 24)),
          estimatedCoveragePercent: {
            normal: Math.max(15, Math.min(55, Math.round((24 / Math.max(workload.workCount, 1)) * 100))),
            high: Math.max(35, Math.min(80, Math.round((72 / Math.max(workload.workCount, 1)) * 100))),
            maximum: Math.max(60, Math.min(100, Math.round((128 / Math.max(workload.workCount, 1)) * 100))),
          },
          probeWorks: [],
          recommendedShards: [],
          rationale: `Sized from ${sizedChunks.length} vetted relevant chunks across ${sizedWorkIds.length} works, covering ${(workload.totalTextBytes / 1_000_000).toFixed(1)} MB of source text.`,
        };
        return structuredClone(estimate) as Record<string, unknown>;
      }
      const estimate = await deps.store.estimateResearchScope(parsed.query, parsed.filters);
      return structuredClone(estimate) as unknown as Record<string, unknown>;
    }
    case "search_works": {
      const parsed = ToolArgsSchemas.search_works.parse(normalizedArgs);
      const requestedLimit = typeof parsed.filters?.limit === "number" ? parsed.filters.limit : 8;
      const broadSurveyQuery = isBroadCorpusResearchQuery(parsed.query);
      const frontierLimit = broadSurveyQuery
        ? Math.max(requestedLimit * 3, Math.min(128, requestedLimit * 4))
        : Math.max(requestedLimit, Math.min(80, requestedLimit * 2));
      const rawFrontierWorks = await deps.store.searchWorks(parsed.query, {
        ...(parsed.filters ?? {}),
        limit: frontierLimit,
      });
      const frontierWorks = rankWorkspaceCandidateWorks(rawFrontierWorks, parsed.query, new Set<string>())
        .filter(({ work, totalScore }, index) => shouldSeedWorkspaceWork(work, parsed.query, new Set<string>(), totalScore, index))
        .map(({ work }) => work);
      const visibleLimit = broadSurveyQuery
        ? Math.min(frontierLimit, Math.max(requestedLimit, 24))
        : Math.min(20, frontierLimit);
      return {
        works: frontierWorks.slice(0, visibleLimit),
        frontier: {
          workCount: frontierWorks.length,
          works: frontierWorks,
        },
      };
    }
    case "get_work_metadata": {
      const parsed = ToolArgsSchemas.get_work_metadata.parse(normalizedArgs);
      const works = await deps.store.getWorkMetadata(parsed.workIds);
      return { works };
    }
    case "get_relevant_chunks": {
      const parsed = ToolArgsSchemas.get_relevant_chunks.parse(normalizedArgs);
      const resultLimit = parsed.filters?.limit ?? 8;
      const queryVariants = buildPassageQueryVariants(parsed.query, Array.isArray(parsed.workIds) ? parsed.workIds.length : 0, 3);
      const chunkBatches: ChunkSearchResult[][] = [];
      for (const variant of queryVariants.length > 0 ? queryVariants : [parsed.query]) {
        let embedding: number[] | undefined;
        try {
          context.auditLog?.("internal.embedding.started", {
            toolName,
            query: variant,
            scopedWorkCount: Array.isArray(parsed.workIds) ? parsed.workIds.length : 0,
          });
          embedding = await deps.embedder.embedQuery(variant, {
            userId: context.userId,
            sessionId: context.sessionId,
            runId: context.runId,
            source: "embedder",
          });
          context.auditLog?.("internal.embedding.completed", {
            toolName,
            dimensions: Array.isArray(embedding) ? embedding.length : 0,
          });
        } catch {
          context.auditLog?.("internal.embedding.failed", {
            toolName,
            error: "Embedding generation failed; continuing without semantic query embedding.",
          });
          embedding = undefined;
        }
        const perQueryLimit = queryVariants.length > 1
          ? Math.min(Math.max(resultLimit, 12), Math.max(resultLimit * 2, 24))
          : resultLimit;
        const chunks = await deps.store.getRelevantChunks(
          variant,
          parsed.workIds,
          perQueryLimit,
          embedding,
          parsed.filters,
        );
        chunkBatches.push(chunks);
      }
      const chunks = mergeChunkSearchResults(chunkBatches, resultLimit);
      return {
        chunks,
        frontierWorkIds: Array.isArray(parsed.workIds) ? parsed.workIds : [],
        verifiedWorkIds: uniqueWorkIds(
          chunks.map((chunk) => (typeof chunk.workId === "string" ? chunk.workId : null)),
        ),
      };
    }
    case "classify_candidate_chunks": {
      const parsed = ToolArgsSchemas.classify_candidate_chunks.parse(normalizedArgs);
      if (!deps.openAIApiKey) {
        throw new Error("OPENAI_API_KEY is required for candidate chunk classification.");
      }
      const candidates = await deps.store.getChunksByIds(parsed.chunkIds);
      const orderedCandidates = parsed.chunkIds
        .map((chunkId) => candidates.find((chunk) => chunk.id === chunkId))
        .filter((chunk): chunk is ChunkSearchResult => Boolean(chunk));
      const maxRelevantChunks = parsed.maxRelevantChunks ?? 96;
      const maxRelevantWorks = parsed.maxRelevantWorks ?? 24;
      const batchSize = 12;
      const scored = new Map<string, { score: number; reason?: string }>();
      for (let index = 0; index < orderedCandidates.length; index += batchSize) {
        const batch = orderedCandidates.slice(index, index + batchSize);
        await context.progressReporter?.(
          `Classifying candidate passages ${index + 1}-${Math.min(index + batch.length, orderedCandidates.length)} of ${orderedCandidates.length}.`,
        );
        const body = {
          model: deps.openAIModel ?? "gpt-5.2",
          response_format: { type: "json_object" as const },
          messages: [
            {
              role: "system",
              content: [
                "You are classifying literary passages for research relevance.",
                "Return one JSON object only.",
                "Do not use markdown fences.",
                "Do not use prose before or after the JSON.",
              ].join("\n"),
            },
            {
              role: "user",
              content: JSON.stringify({
                query: parsed.query,
                scoringGuidance: [
                  "Score for whether the passage is directly useful for answering the user query.",
                  "High scores require clear topical relevance, not just loose keyword overlap.",
                  "Down-rank incidental mentions and generic emotional language.",
                  `Return exactly ${batch.length} items, one per passage id in the same order.`,
                ],
                passages: batch.map((chunk) => ({
                  id: chunk.id,
                  workId: chunk.workId,
                  chunkIndex: chunk.chunkIndex,
                  excerpt: (chunk.excerpt ?? chunk.text).replace(/\s+/gu, " ").slice(0, 700),
                })),
                outputShape: {
                  items: [{ id: "string", score: "number 0-1", reason: "string" }],
                },
              }),
            },
          ],
        };
        let response: Response;
        try {
          response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${deps.openAIApiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(HARD_LIMITS.MAX_TOOL_TIMEOUT_SECONDS * 1000),
          });
        } catch (error) {
          if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
            throw new Error("Candidate chunk classification timed out before the model returned scores.");
          }
          throw error;
        }
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(`Candidate chunk classification request failed: ${detail}`);
        }
        const payload = (await response.json()) as {
          choices?: Array<{
            message?: {
              content?: string;
            };
          }>;
        };
        const text = payload.choices?.[0]?.message?.content?.trim();
        if (!text) {
          throw new Error("Candidate chunk classifier returned an empty response.");
        }
        let parsedPayload: { items?: Array<{ id?: string; score?: number; reason?: string }> };
        try {
          parsedPayload = parseModelJsonObject<{ items?: Array<{ id?: string; score?: number; reason?: string }> }>(text);
        } catch {
          throw new Error(`Candidate chunk classifier returned invalid JSON: ${text.replace(/\s+/gu, " ").slice(0, 240)}`);
        }
        const items = Array.isArray(parsedPayload.items) ? parsedPayload.items : [];
        for (const item of items) {
          if (typeof item?.id !== "string" || typeof item?.score !== "number") {
            continue;
          }
          scored.set(item.id, { score: Math.max(0, Math.min(1, item.score)), reason: typeof item.reason === "string" ? item.reason : undefined });
        }
      }
      const relevantChunks = orderedCandidates
        .map((chunk) => ({
          ...chunk,
          relevanceScore: scored.get(chunk.id)?.score ?? 0,
          relevanceReason: scored.get(chunk.id)?.reason,
        }))
        .filter((chunk) => chunk.relevanceScore >= 0.45)
        .sort((left, right) => right.relevanceScore - left.relevanceScore)
        .slice(0, maxRelevantChunks);
      const relevantWorkIds = uniqueWorkIds(relevantChunks.map((chunk) => chunk.workId)).slice(0, maxRelevantWorks);
      return {
        chunks: relevantChunks.filter((chunk) => relevantWorkIds.includes(chunk.workId)),
        relevantChunkIds: relevantChunks.map((chunk) => chunk.id),
        relevantWorkIds,
        candidateChunkCount: orderedCandidates.length,
      };
    }
    case "get_work_text": {
      const parsed = ToolArgsSchemas.get_work_text.parse(normalizedArgs);
      const workFile = await deps.store.getWorkTextFile(parsed.workId);
      if (!workFile?.r2Key) {
        return { workId: parsed.workId, found: false };
      }
      const text = await deps.blobStore.getText(workFile.r2Key);
      return {
        workId: parsed.workId,
        r2Key: workFile.r2Key,
        found: Boolean(text),
        text: text?.slice(0, 20000) ?? null,
      };
    }
    case "create_workspace":
      return deps.runtimeGateway.createWorkspace({
        ...ToolArgsSchemas.create_workspace.parse(normalizedArgs),
        sessionId: context.sessionId,
        runId: context.runId,
      });
    case "run_workspace_task":
      {
        const parsed = ToolArgsSchemas.run_workspace_task.parse(normalizedArgs);
        const taskSpec = parsed.taskSpec && typeof parsed.taskSpec === "object"
          ? { ...(parsed.taskSpec as Record<string, unknown>) }
          : {};
        const workIds = Array.isArray(taskSpec.workIds)
          ? taskSpec.workIds.filter((value): value is string => typeof value === "string")
          : [];
        const frontierWorkIds = Array.isArray(taskSpec.frontierWorkIds)
          ? taskSpec.frontierWorkIds.filter((value): value is string => typeof value === "string")
          : workIds;
        const existingChunkIds = Array.isArray(taskSpec.chunkIds)
          ? taskSpec.chunkIds.filter((value): value is string => typeof value === "string")
          : [];
        const existingVerifiedChunkIds = Array.isArray(taskSpec.verifiedChunkIds)
          ? taskSpec.verifiedChunkIds.filter((value): value is string => typeof value === "string")
          : [];
        const taskIntensity = taskSpec.intensity === "maximum" || taskSpec.intensity === "high" || taskSpec.intensity === "normal"
          ? taskSpec.intensity
          : "normal";
        const desiredSeedChunkCount = (() => {
          const base = chunkSeedLimitForTaskMode(taskSpec.mode);
          if (taskIntensity === "maximum") {
            return Math.max(base, Math.min(base * 2, 96));
          }
          if (taskIntensity === "high") {
            return Math.max(base, Math.min(Math.round(base * 1.5), 72));
          }
          return base;
        })();
        const minimumVerifiedChunkCount = minimumVerifiedChunkFloorForTask(taskSpec.mode, taskIntensity);
        if (frontierWorkIds.length > 0 && existingVerifiedChunkIds.length < minimumVerifiedChunkCount) {
          const seedQuery = buildWorkspaceSeedPassageQuery(taskSpec);
          if (seedQuery.length > 0) {
            const variantCount = taskIntensity === "maximum" ? 5 : taskIntensity === "high" ? 4 : 4;
            const seedQueries = buildPassageQueryVariants(seedQuery, frontierWorkIds.length, variantCount);
            const seedChunkBatches: ChunkSearchResult[][] = [];
            for (const variant of seedQueries.length > 0 ? seedQueries : [seedQuery]) {
              let embedding: number[] | undefined;
              try {
                context.auditLog?.("internal.workspace_seed_embedding.started", {
                  toolName,
                  query: variant,
                  scopedWorkCount: frontierWorkIds.length,
                });
                embedding = await deps.embedder.embedQuery(variant, {
                  userId: context.userId,
                  sessionId: context.sessionId,
                  runId: context.runId,
                  source: "embedder",
                });
              } catch {
                embedding = undefined;
              }
              const seedChunks = await deps.store.getRelevantChunks(
                variant,
                frontierWorkIds.slice(0, 120),
                Math.min(Math.max(desiredSeedChunkCount, 12), Math.max(desiredSeedChunkCount * 2, 24)),
                embedding,
              );
              seedChunkBatches.push(seedChunks);
            }
            const seedChunks = mergeChunkSearchResults(seedChunkBatches, desiredSeedChunkCount);
            if (seedChunks.length > 0) {
              const verifiedWorkIds = uniqueWorkIds(
                seedChunks.map((chunk) => (typeof chunk.workId === "string" ? chunk.workId : null)),
              );
              const workLimit = taskSpec.mode === "exhaustive_corpus_search"
                ? (taskIntensity === "maximum" ? 64 : taskIntensity === "high" ? 48 : 32)
                : 12;
              taskSpec.chunkIds = uniqueWorkIds([
                ...existingChunkIds,
                ...seedChunks
                  .map((chunk) => chunk.id)
                  .filter((value): value is string => typeof value === "string"),
              ]).slice(0, desiredSeedChunkCount);
              taskSpec.frontierWorkIds = uniqueWorkIds([
                ...frontierWorkIds,
                ...verifiedWorkIds,
              ]).slice(0, 160);
              taskSpec.verifiedWorkIds = verifiedWorkIds;
              taskSpec.verifiedChunkIds = seedChunks
                .map((chunk) => chunk.id)
                .filter((value): value is string => typeof value === "string")
                .concat(existingVerifiedChunkIds)
                .filter((value, index, all) => all.indexOf(value) === index)
                .slice(0, desiredSeedChunkCount);
              taskSpec.workIds = uniqueWorkIds([
                ...verifiedWorkIds,
                ...workIds,
              ]).slice(0, taskSpec.mode === "exhaustive_corpus_search" ? Math.max(workLimit, 40) : workLimit);
              taskSpec.candidateWorkIds = Array.isArray(taskSpec.candidateWorkIds)
                ? uniqueWorkIds([
                    ...verifiedWorkIds,
                    ...(taskSpec.candidateWorkIds as unknown[]).filter((value): value is string => typeof value === "string"),
                  ]).slice(0, taskSpec.mode === "exhaustive_corpus_search" ? Math.max(workLimit, 40) : workLimit)
                : taskSpec.workIds;
              const retrieval = taskSpec.retrieval && typeof taskSpec.retrieval === "object"
                ? { ...(taskSpec.retrieval as Record<string, unknown>) }
                : {};
              retrieval.verifiedChunks = seedChunks.slice(0, chunkSeedLimitForTaskMode(taskSpec.mode)).map((chunk) => ({
                id: chunk.id,
                workId: chunk.workId,
                chunkIndex: chunk.chunkIndex,
                excerpt: chunk.excerpt,
                r2Key: chunk.r2Key ?? null,
              }));
              retrieval.seedChunks = seedChunks.slice(0, chunkSeedLimitForTaskMode(taskSpec.mode)).map((chunk) => ({
                id: chunk.id,
                workId: chunk.workId,
                chunkIndex: chunk.chunkIndex,
                excerpt: chunk.excerpt,
                r2Key: chunk.r2Key ?? null,
              }));
              taskSpec.retrieval = retrieval;
            }
          }
        }
        if (shouldExecuteShardedWorkspaceTask(taskSpec)) {
          return executeShardedWorkspaceTask(
            deps,
            {
              runtimeId: parsed.runtimeId,
              taskSpec,
            },
            context,
          );
        }
        if (taskSpec.mode === "sprite_fanout") {
          if (!deps.runtimeGateway.runSpriteFanoutResearch) {
            throw new Error("Sprite fanout research is not configured for this environment.");
          }
          return deps.runtimeGateway.runSpriteFanoutResearch({
            runtimeId: parsed.runtimeId,
            query:
              typeof taskSpec.question === "string" && taskSpec.question.trim().length > 0
                ? taskSpec.question
                : typeof taskSpec.researchObjective === "string" && taskSpec.researchObjective.trim().length > 0
                  ? taskSpec.researchObjective
                  : "",
            workIds: Array.isArray(taskSpec.workIds)
              ? taskSpec.workIds.filter((value): value is string => typeof value === "string")
              : [],
            intensity: taskIntensity,
            implementationId: deps.implementation?.id,
            progressReporter: context.progressReporter,
            sessionId: context.sessionId,
            runId: context.runId,
          });
        }
        return deps.runtimeGateway.runWorkspaceTask({
          ...parsed,
          taskSpec,
          sessionId: context.sessionId,
          runId: context.runId,
        });
      }
    case "read_workspace_file":
      return deps.runtimeGateway.readWorkspaceFile({
        ...ToolArgsSchemas.read_workspace_file.parse(normalizedArgs),
        sessionId: context.sessionId,
        runId: context.runId,
      });
    case "destroy_workspace":
      return deps.runtimeGateway.destroyWorkspace({
        ...ToolArgsSchemas.destroy_workspace.parse(normalizedArgs),
        sessionId: context.sessionId,
        runId: context.runId,
      });
    default:
      return { ok: false, error: `Unsupported tool: ${toolName}` };
  }
}

async function executeShardedWorkspaceTask(
  deps: AppDeps,
  parsed: { runtimeId: string; taskSpec: Record<string, unknown> },
  context: {
    userId: string;
    sessionId: string;
    runId: string;
    auditLog?: AuditLogger;
    progressReporter?: (text: string, detail?: Record<string, unknown>) => Promise<void>;
  },
) {
  const taskSpec = parsed.taskSpec;
  const shardPlan = Array.isArray(taskSpec.shardPlan)
    ? taskSpec.shardPlan.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"))
    : [];
  const selectedShards = shardPlan.slice(
    0,
    Math.min(
      shardPlan.length,
      Math.max(1, typeof taskSpec.parallelism === "number" ? taskSpec.parallelism : 1),
      shardWorkerLimitForIntensity(taskSpec.intensity),
    ),
  );
  const chunkIds = Array.isArray(taskSpec.chunkIds)
    ? taskSpec.chunkIds.filter((value): value is string => typeof value === "string")
    : [];
  const shardResults = await Promise.all(selectedShards.map(async (shard, index) => {
    const shardWorkIds = selectShardWorkIds(taskSpec, shard, index, selectedShards.length).slice(0, 20);
    const shardId = typeof shard.shardId === "string" ? shard.shardId : `shard-${index + 1}`;
    const label = typeof shard.label === "string" ? shard.label : `Shard ${index + 1}`;
    const strategy = typeof shard.strategy === "string" ? shard.strategy : null;
    if (shardWorkIds.length === 0) {
      return { ok: false, shardId, label, strategy, error: "No works matched this shard." };
    }
    const shardTaskSpec = buildShardTaskSpec(taskSpec, shard, shardWorkIds);
    const workspace = await deps.runtimeGateway.createWorkspace({
      workIds: shardWorkIds,
      chunkIds: chunkIds.slice(0, 100),
      taskContext: {
        question: typeof taskSpec.question === "string" ? taskSpec.question : "",
        researchObjective: typeof taskSpec.researchObjective === "string" ? taskSpec.researchObjective : "",
        taskIntent: typeof taskSpec.taskIntent === "string" ? taskSpec.taskIntent : null,
        followUpContext: taskSpec.followUpContext && typeof taskSpec.followUpContext === "object" ? taskSpec.followUpContext : null,
        shard,
      },
      sessionId: context.sessionId,
      runId: context.runId,
    });
    const shardRuntimeId = typeof workspace.runtimeId === "string" ? workspace.runtimeId : null;
    if (!shardRuntimeId) {
      return { ok: false, shardId, label, strategy, error: typeof workspace.error === "string" ? workspace.error : "Shard workspace startup failed." };
    }
    const shardProgressEmitter = context.progressReporter
      ? startRuntimeTaskProgressEmitter(
          deps.runtimeGateway,
          async (_eventName, data) => {
            if (typeof data.text !== "string") {
              return;
            }
            const detail =
              data.detail && typeof data.detail === "object"
                ? {
                    ...(data.detail as Record<string, unknown>),
                    shardId,
                    shardLabel: label,
                    ...(strategy ? { shardStrategy: strategy } : {}),
                  }
                : {
                    type: "research.note",
                    shardId,
                    shardLabel: label,
                    ...(strategy ? { shardStrategy: strategy } : {}),
                  };
            await context.progressReporter?.(data.text, detail);
          },
          {
            sessionId: context.sessionId,
            runId: context.runId,
          },
          context.runId,
          `${parsed.runtimeId}:${shardId}`,
          "run_workspace_task",
          shardRuntimeId,
          { initialText: `Starting ${label}.` },
        )
      : null;
    try {
      const result = await deps.runtimeGateway.runWorkspaceTask({
        runtimeId: shardRuntimeId,
        taskSpec: shardTaskSpec,
        sessionId: context.sessionId,
        runId: context.runId,
      });
      return { ok: result.ok !== false, shardId, label, strategy, result };
    } finally {
      await shardProgressEmitter?.stop();
      await deps.runtimeGateway.destroyWorkspace({
        runtimeId: shardRuntimeId,
        sessionId: context.sessionId,
        runId: context.runId,
      }).catch(() => {});
    }
  }));

  const successful = shardResults.filter((entry) => entry.ok && "result" in entry) as Array<{
    ok: true;
    shardId: string;
    label: string;
    strategy: string | null;
    result: Record<string, unknown>;
  }>;
  const mergedCitations = dedupeAppCitations(
    successful.flatMap((entry) => sanitizeAppCitations(Array.isArray(entry.result.citations) ? entry.result.citations : [])),
  ).slice(0, 16);
  const mergedBillingEvents = successful.flatMap((entry) =>
    Array.isArray(entry.result.billingEvents) ? entry.result.billingEvents as Array<Record<string, unknown>> : [],
  );
  const combinedBriefing = successful
    .map((entry) => {
      const briefing = typeof entry.result.briefing === "string" ? entry.result.briefing.trim() : "";
      return briefing ? `## ${entry.label}\n\n${briefing}` : null;
    })
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  let reducedBriefing = combinedBriefing;
  if (combinedBriefing) {
    try {
      const reduced = await deps.synthesizer.synthesize({
        userMessage: typeof taskSpec.question === "string" ? taskSpec.question : "",
        conversationHistory: [],
        plannerDraft: combinedBriefing,
        plannerCitations: mergedCitations,
        toolHistory: [],
        runtimeBriefing: combinedBriefing,
        runtimeEvidenceNotes: null,
        researchDocument: null,
        exactCitationLinks: [],
        billingContext: {
          userId: context.userId,
          sessionId: context.sessionId,
          runId: context.runId,
          source: "synthesizer",
        },
      });
      reducedBriefing = reduced.answer;
    } catch {
      // Fall back to the combined shard briefing.
    }
  }
  return {
    ok: successful.length > 0,
    runtimeId: parsed.runtimeId,
    briefing: reducedBriefing,
    citations: mergedCitations,
    shardResults: shardResults.map((entry) => ({
      shardId: entry.shardId,
      label: entry.label,
      strategy: entry.strategy,
      ok: entry.ok,
      ...("error" in entry ? { error: entry.error } : {}),
    })),
    billingEvents: mergedBillingEvents,
  };
}

function workspaceProgressSteps(args: Record<string, unknown>): string[] {
  if ("taskContext" in args && !("taskSpec" in args)) {
    return [
      "Preparing the deeper research run.",
      "Connecting the research engine to the corpus search tools.",
      "Getting the full search ready.",
    ];
  }
  const taskSpec = args.taskSpec && typeof args.taskSpec === "object" ? args.taskSpec as Record<string, unknown> : null;
  const phase = typeof taskSpec?.phase === "string" ? taskSpec.phase : null;
  const workCount = Array.isArray(taskSpec?.workIds) ? taskSpec.workIds.length : 0;
  const scope = workCount > 0 ? `${workCount} books` : "the corpus";
  if (phase === "collect_evidence") {
    return [
      `Searching ${scope} for likely matches.`,
      "Pulling candidate passages into the evidence set.",
      "Keeping the strongest quotations and source references.",
    ];
  }
  if (phase === "collect_and_brief") {
    return [
      `Searching ${scope} for direct evidence.`,
      "Running regex, metadata, and context searches across the corpus.",
      "Writing the quoted briefing with linked citations.",
    ];
  }
  if (phase === "write_briefing") {
    return [
      "Turning the evidence into a quoted briefing.",
      "Linking each quotation back to its source text.",
      "Finishing the briefing.",
    ];
  }
  return [
    `Searching ${scope}.`,
    "Reviewing the strongest passages.",
  ];
}

function genericProgressEmitter(
  send: (event: string, data: Record<string, unknown>) => Promise<void>,
  runId: string,
  toolCallId: string,
  toolName: ToolName,
  args: Record<string, unknown>,
) {
  if (toolName !== "run_workspace_task") {
    if (toolName !== "create_workspace") {
      return {
        stop() {},
      };
    }
  }

  const steps = workspaceProgressSteps(args);
  let stepIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const emitStep = () => {
    if (stepIndex >= steps.length) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return;
    }
    const text = steps[stepIndex % steps.length];
    stepIndex += 1;
    void send("tool.progress", {
      runId,
      toolCallId,
      toolName,
      text,
    });
  };
  emitStep();
  timer = setInterval(() => {
    emitStep();
  }, 3000);

  return {
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

function candidateWorkHaystack(work: Record<string, unknown>) {
  const title = typeof work.title === "string" ? work.title : "";
  const summary = typeof work.summary === "string" ? work.summary : "";
  const subjects = Array.isArray(work.subjects) ? work.subjects.filter((value): value is string => typeof value === "string") : [];
  const authors = Array.isArray(work.authors) ? work.authors.filter((value): value is string => typeof value === "string") : [];
  return [title, summary, ...subjects, ...authors].join(" ").toLowerCase();
}

function rankWorkspaceCandidateWorks(
  works: Array<Record<string, unknown>>,
  query: string,
  seededWorkIds: Set<string>,
) {
  const asksForJuvenile = /\b(children|child|juvenile|girl|girls|boy|boys|school|orphan|orphans)\b/iu.test(query);
  const griefQuery = /\b(grief|mourning|bereavement|funeral|sorrow|lament|weep|wept|tears?|loss|consolation|despair)\b/iu.test(query);
  const explicitGriefMatch = /\b(grief|mourning|bereavement|funeral|sorrow|lament|weep|wept|weeping|tears?|loss|consolation|despair)\b/iu;
  const broadCorpusQuery = isBroadCorpusResearchQuery(query, 0);
  return [...works]
    .map((work, index) => {
      const haystack = candidateWorkHaystack(work);
      let bonus = 0;
      if (seededWorkIds.has(typeof work.id === "string" ? work.id : "")) {
        bonus += 1.5;
      }
      if (griefQuery) {
        const hasExplicitGriefMatch = explicitGriefMatch.test(haystack);
        if (hasExplicitGriefMatch) {
          bonus += 0.9;
        } else {
          bonus -= 0.8;
        }
        if (!asksForJuvenile) {
          if (/\b(juvenile|children|child|girls|boys|school|schools|pz)\b/iu.test(haystack)) {
            bonus -= 0.8;
          }
          if (/\borphans?\b/iu.test(haystack)) {
            bonus -= 0.45;
          }
        }
        if (/\b(dead|death)\b/iu.test(haystack) && !hasExplicitGriefMatch) {
          bonus -= 1.1;
        }
        if (/\b(science fiction|robots?|wireless|war tank|uncle sam|poster advertising|helpful robots)\b/iu.test(haystack)) {
          bonus -= 1.3;
        }
      }
      if (broadCorpusQuery) {
        bonus += Math.max(0, 0.45 - index * 0.03);
      }
      const baseScore = typeof work.score === "number" && Number.isFinite(work.score) ? work.score : 0;
      return {
        work,
        totalScore: baseScore + bonus,
        index,
      };
    })
    .sort((left, right) =>
      right.totalScore - left.totalScore
      || left.index - right.index)
    .map(({ work, totalScore }) => ({
      work,
      totalScore,
    }));
}

function shouldSeedWorkspaceWork(
  work: Record<string, unknown>,
  query: string,
  seededWorkIds: Set<string>,
  totalScore: number,
  index = 0,
) {
  const workId = typeof work.id === "string" ? work.id : "";
  if (seededWorkIds.has(workId)) {
    return true;
  }
  const haystack = candidateWorkHaystack(work);
  const griefQuery = /\b(grief|mourning|bereavement|funeral|sorrow|lament|weep|wept|tears?|loss|consolation|despair)\b/iu.test(query);
  const asksForJuvenile = /\b(children|child|juvenile|girl|girls|boy|boys|school|orphan|orphans)\b/iu.test(query);
  const broadCorpusQuery = isBroadCorpusResearchQuery(query, 0);
  const hasExplicitGriefMatch = /\b(grief|mourning|bereavement|funeral|sorrow|lament|weep|wept|weeping|tears?|loss|consolation|despair)\b/iu.test(haystack);
  if (
    griefQuery
    && !asksForJuvenile
    && /\b(juvenile|children|child|girls|boys|school|schools|pz|orphans?)\b/iu.test(haystack)
    && !/\b(grief|mourning|bereavement|funeral|sorrow|lament|weep|wept|weeping|tears?|loss|consolation|despair)\b/iu.test(haystack.replace(/\bjuvenile fiction\b/giu, ""))
  ) {
    return false;
  }
  if (griefQuery && !hasExplicitGriefMatch && /\b(dead|death)\b/iu.test(haystack)) {
    return false;
  }
  if (griefQuery && !hasExplicitGriefMatch && /\b(science fiction|robots?|wireless|war tank|uncle sam|poster advertising|helpful robots)\b/iu.test(haystack)) {
    return false;
  }
  if (broadCorpusQuery && !griefQuery && index < 24) {
    return true;
  }
  return totalScore > 0;
}

function normalizeRuntimeUuid(value: string): string {
  const compact = value.replace(/[^a-f0-9]/giu, "").toLowerCase();
  if (compact.length !== 32) {
    return value.trim();
  }
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

function parseRuntimeChunkProgressLine(line: string): Record<string, unknown> | null {
  const match = line.match(
    /^([a-f0-9]{8}(?:[- ][a-f0-9]{4}){3}[- ][a-f0-9]{12})\s+(\d+):([^:]+):(.+)$/iu,
  );
  if (!match) {
    return null;
  }
  const [, rawWorkId, rawChunkIndex, rawTitle, rawExcerpt] = match;
  return {
    type: "research.chunk",
    workId: normalizeRuntimeUuid(rawWorkId),
    workTitle: rawTitle.trim(),
    chunkIndex: Number(rawChunkIndex),
    excerpt: rawExcerpt.trim(),
    message: `Reviewed a passage from ${rawTitle.trim() || normalizeRuntimeUuid(rawWorkId)}.`,
  };
}

function parseRuntimeProgressMarker(line: string): Record<string, unknown> | null {
  const match = line.match(/^ALPHABOOK[ _]PROGRESS\s+(\{.+\})$/u);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeRuntimeProgressLine(event: Record<string, unknown>): {
  text: string | null;
  detail?: Record<string, unknown>;
} {
  const rawMessage = typeof event.message === "string" ? event.message.trim() : "";
  if (!rawMessage) {
    return { text: null };
  }

  const type = typeof event.type === "string" ? event.type : "";
  const line = typeof event.line === "string" ? event.line.trim() : "";
  const title = typeof event.workTitle === "string" ? event.workTitle.trim() : "";
  const authors = Array.isArray(event.authors)
    ? event.authors.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const chunkIndex = typeof event.chunkIndex === "number" ? event.chunkIndex : null;
  const noteDetail = (note: string): Record<string, unknown> => ({
    type: "research.note",
    note,
    message: note,
  });
  const isRuntimeNoiseLine = (value: string) => (
    /^(OpenAI Codex v|workdir:|model:|provider:|approval:|sandbox:|reasoning effort:|reasoning summaries:|session id:|user|--------)$/iu.test(value)
    || /^(You are |You operate |Your goal is |Goal:|Constraints:|Research objective:|Task spec:|Workspace manifest summary:|Seed evidence from the orchestrator:|When finished,|Only use local files under |Start from |If the task spec already includes |Keep the search bounded:|Guaranteed tools in this runtime image:|It also supports |Always copy chunk IDs exactly |Use repeated regex, keyword, metadata|Hydrate local book files only |Use shell tools like |To pull files into the workspace|Expand across more books |Create a focused local corpus |Your required deliverable is |The briefing should |Every quote should |Prefer primary-source quotations |Once you have 2 to 8 |If the evidence is thin|You may optionally write helper notes |Do not stop after searching\.)/iu.test(value)
    || /^(node \/workspace\/context\/|node \/research run\/context\/|\/bin\/bash\b|#!\/usr\/bin\/env\b|import\s|mcp startup:)/iu.test(value)
    || /^(?:[-*•]\s+|[→✓]\s+)/u.test(value)
    || /^(?:#|##|\*\*)/u.test(value)
    || /^(?:Briefing saved to|Briefing written to|EOF$)/iu.test(value)
    || /(?:in \/research run succeeded in|\/research run\/output\/briefing\.md)/iu.test(value)
    || /^(?:os\.|with open\(|f\.write\(|briefing\s*=|quotes\s*=)/iu.test(value)
    || /^[\[\]{}]+,?$/u.test(value)
    || /^".*":\s*(?:.+)?$/u.test(value)
    || /^".*",?$/u.test(value)
  );
  const maybeResearchNote = (value: string): Record<string, unknown> | undefined => {
    const note = sanitizeUserFacingToolText(value)?.replace(/\s+/g, " ").trim() ?? "";
    if (!note || note.length < 24 || note.length > 180) {
      return undefined;
    }
    if (
      /^(Touched|Reviewed|OpenAI deep research|provider:|session id:|You are |Goal:|Question:|Task spec:|Seed evidence|research run manifest summary:|exec|error:|!\/usr\/bin\/env|import |node \/research run|\/bin\/bash|mcp startup)/iu.test(note)
      || /^(?:[-*•]\s+|[→✓]\s+|#|##|\*\*)/u.test(note)
      || /^(?:Briefing saved to|Briefing written to|EOF$)/iu.test(note)
      || /\b(?:gutenberg\/|context\/search|context\/load|rg\b|jq\b|sed\b|awk\b|grep\b|cat\b)\b/iu.test(note)
      || /[{}[\]]/u.test(note)
      || /^".*":\s*(?:.+)?$/u.test(note)
      || /[a-f0-9]{8}(?:[- ][a-f0-9]{4}){3}[- ][a-f0-9]{12}/iu.test(note)
    ) {
      return undefined;
    }
    return noteDetail(note);
  };

  if (type === "codex.stdout" || type === "codex.stderr") {
    const parsedMarkerDetail = line ? parseRuntimeProgressMarker(line) : null;
    if (parsedMarkerDetail) {
      const detailType = typeof parsedMarkerDetail.type === "string" ? parsedMarkerDetail.type : "";
      if (detailType === "research.work") {
        const workTitle = typeof parsedMarkerDetail.workTitle === "string"
          ? parsedMarkerDetail.workTitle.trim()
          : typeof parsedMarkerDetail.title === "string"
            ? parsedMarkerDetail.title.trim()
            : typeof parsedMarkerDetail.workId === "string"
              ? parsedMarkerDetail.workId
              : "book";
        const authors = Array.isArray(parsedMarkerDetail.authors)
          ? parsedMarkerDetail.authors.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : [];
        return {
          text: `Touched ${workTitle}${authors.length > 0 ? ` by ${authors.join(", ")}` : ""}.`,
          detail: parsedMarkerDetail,
        };
      }
      if (detailType === "research.chunk") {
        const workTitle = typeof parsedMarkerDetail.workTitle === "string"
          ? parsedMarkerDetail.workTitle.trim()
          : typeof parsedMarkerDetail.title === "string"
            ? parsedMarkerDetail.title.trim()
            : typeof parsedMarkerDetail.workId === "string"
              ? parsedMarkerDetail.workId
              : "book";
        const markerChunkIndex = typeof parsedMarkerDetail.chunkIndex === "number" ? parsedMarkerDetail.chunkIndex : null;
        return {
          text: `Touched a passage in ${workTitle}${markerChunkIndex !== null ? ` around passage ${markerChunkIndex}` : ""}.`,
          detail: parsedMarkerDetail,
        };
      }
      return { text: null, detail: parsedMarkerDetail };
    }
    const parsedChunkDetail = line ? parseRuntimeChunkProgressLine(line) : null;
    if (parsedChunkDetail) {
      return {
        text: `Reviewed a passage from ${String(parsedChunkDetail.workTitle ?? parsedChunkDetail.workId)}${typeof parsedChunkDetail.chunkIndex === "number" ? ` around passage ${parsedChunkDetail.chunkIndex}` : ""}.`,
        detail: parsedChunkDetail,
      };
    }
    if (!line) {
      return { text: null };
    }
    if (
      isRuntimeNoiseLine(line)
      || line === "exec"
      || /^\/bin\/bash\b/iu.test(line)
      || /^at\s+/u.test(line)
      || /^node:internal\//u.test(line)
      || /^Error \[ERR_MODULE_NOT_FOUND\]/u.test(line)
    ) {
      return { text: null };
    }
    if (/invalid input syntax for type uuid/iu.test(line)) {
      return {
        text: "A corpus neighbor lookup failed because the VM passed a malformed chunk id.",
      };
    }
    if (/statement timeout/iu.test(line)) {
      return {
        text: "A corpus-wide search inside the VM timed out and needs a narrower follow-up query.",
      };
    }
    const note = maybeResearchNote(line);
    return note
      ? { text: note.note as string, detail: note }
      : { text: null };
  }
  if (type === "research.work") {
    return {
      text: title
        ? `Surfaced ${title}${authors.length > 0 ? ` by ${authors.join(", ")}` : ""}.`
        : rawMessage,
      detail: event,
    };
  }
  if (type === "research.chunk") {
    return {
      text: title
        ? `Reviewed a passage from ${title}${chunkIndex !== null ? ` around passage ${chunkIndex}` : ""}.`
        : rawMessage,
      detail: event,
    };
  }
  if (type === "research.seed_summary") {
    return { text: rawMessage, detail: event };
  }
  if (type === "research.briefing_line") {
    const line = typeof event.line === "string" ? event.line.trim() : "";
    if (!line) {
      return { text: null, detail: event };
    }
    return {
      text: /^(?:#{1,6}\s+|[-*]\s+)/u.test(line) ? "Updating the briefing draft." : line,
      detail: event,
    };
  }

  if (type === "codex.step.prepared") {
    return { text: "The deeper research pass is ready to run." };
  }
  if (type === "codex.step.attempt") {
    return { text: "Starting the deeper research pass." };
  }
  if (type === "codex.step.completed") {
    return { text: "The deeper research pass finished writing the briefing." };
  }
  if (type === "codex.step.attempt_failed") {
    return { text: "The deeper research pass hit an error and is retrying." };
  }
  if (type === "codex.step.failed") {
    return { text: "The deeper research pass failed." };
  }
  if (type === "workspace.local_chunks.missing") {
    const text = "Starting from the best current evidence and searching the full corpus directly.";
    return { text, detail: noteDetail(text) };
  }

  const normalizedText = rawMessage
    .replace(/^codex-briefing:\s*/i, "")
    .replace(/\bCodex corpus briefing\b/gi, "Deep research")
    .replace(/\bCodex step\b/gi, "Research step")
    .replace(/\bCodex\b/gi, "the research engine");
  const note = maybeResearchNote(normalizedText);
  return note
    ? { text: normalizedText, detail: note }
    : { text: normalizedText };
}

function sanitizeUserFacingToolText(text: string | null | undefined): string | null {
  if (!text || !text.trim()) {
    return null;
  }
  const sanitized = text
    .replace(/\bCodex\b/gi, "deep research")
    .replace(/\bcodex\b/gi, "deep research")
    .replace(/\bhydrat(?:e|ed|ing)\b/gi, "load")
    .replace(/\b(?<!(?:deep|deeper) research )workspace\b/giu, "research run")
    .trim();
  if (!sanitized || containsSensitiveUserFacingText(sanitized) || isCodeLikeUserFacingText(sanitized)) {
    return null;
  }
  return sanitized;
}

function userFacingRunFailureMessage(error: unknown) {
  const rawMessage = error instanceof Error ? error.message.trim() : "";
  if (/insufficient_quota|exceeded your current quota|billing details/i.test(rawMessage)) {
    return "The assistant is temporarily unavailable because our AI provider quota was exceeded. Please try again later.";
  }
  if (/authentication required/i.test(rawMessage)) {
    return "You need to sign in before this run can continue.";
  }
  if (/not authorized|access denied|forbidden/i.test(rawMessage)) {
    return "You do not have access to that run.";
  }
  if (/payment required|\b402\b|x402/i.test(rawMessage)) {
    return "This request needs payment before the assistant can continue.";
  }
  if (/context_length_exceeded|maximum context length|too many tokens|too long for messages/i.test(rawMessage)) {
    return "This run tried to carry too much prior search state into the next planning step, so I stopped it instead of continuing with a broken context window.";
  }
  if (/cancelled by user/i.test(rawMessage)) {
    return "This run was cancelled.";
  }
  if (/runtime|fly/i.test(rawMessage) && /timed out|timeout/i.test(rawMessage)) {
    return "The assistant took too long to hear back from its research runtime. Please try again.";
  }
  if (/planner timed out before choosing the next step/i.test(rawMessage)) {
    return "The assistant stalled while choosing the next research step.";
  }
  if (/timed out|timeout/i.test(rawMessage)) {
    return "This run timed out before it produced an answer.";
  }
  const cleaned = sanitizeUserFacingToolText(rawMessage);
  if (!cleaned) {
    return "This run failed before it produced an answer.";
  }
  if (/planner|router|synthesis|openai|chat completions/i.test(cleaned)) {
    return "This run hit an internal planning error before it produced an answer.";
  }
  return `This run failed before it produced an answer. ${cleaned}`;
}

type ToolRunRawLogEntry = {
  seq: number;
  timestamp: string;
  event: string;
  payload: Record<string, unknown>;
};

type RunMetricsSnapshot = {
  status: string;
  completionMode: string;
  startedAt: string;
  completedAt: string;
  timeToFirstBookMentionMs: number | null;
  timeToFirstPrimarySourceMs: number | null;
  timeToWorkspaceReadyMs: number | null;
  timeToFirstCodexCliStartMs: number | null;
  timeToCompletionMs: number | null;
  totalBooksMentioned: number;
  totalCandidateBooks: number;
  totalVmTouchedBooks: number;
  totalPassagesMentioned: number;
  totalSelectedWorkspaceBooks: number;
  totalActiveBooksInFinalAnswer: number;
  estimatedTrueBreadthBooks: number;
  probeBooksShown: number;
  verifiedChunksAtVmHandoff: number;
  verifiedWorksAtVmHandoff: number;
  actualShardRuns: number;
  successfulShardRuns: number;
  reusedPriorFrontierWorks: number;
  reusedPriorVerifiedWorks: number;
  reusedPriorChunks: number;
  plannedParallelShards: number;
  plannedFrontierWorks: number;
  booksMentioned: string[];
  selectedWorkspaceBooks: string[];
  activeBooksInFinalAnswer: string[];
};

type LiveRunMetricsState = {
  startedAtMs: number;
  startedAtIso: string;
  firstBookMentionAtMs: number | null;
  firstPrimarySourceAtMs: number | null;
  workspaceReadyAtMs: number | null;
  firstCodexCliStartAtMs: number | null;
  completionAtMs: number | null;
  documentBookIds: Set<string>;
  candidateBookIds: Set<string>;
  vmTouchedBookIds: Set<string>;
  mentionedChunkIds: Set<string>;
  selectedWorkspaceBookIds: Set<string>;
  activeBookIds: Set<string>;
  estimatedTrueBreadthBooks: number;
  probeBooksShown: number;
  verifiedChunksAtVmHandoff: number;
  verifiedWorksAtVmHandoff: number;
  actualShardRuns: number;
  successfulShardRuns: number;
  reusedPriorFrontierWorks: number;
  reusedPriorVerifiedWorks: number;
  reusedPriorChunks: number;
  plannedParallelShards: number;
  plannedFrontierWorks: number;
  completionMode: string;
  recorded: boolean;
};

function createLiveRunMetricsState(startedAtMs: number): LiveRunMetricsState {
  return {
    startedAtMs,
    startedAtIso: new Date(startedAtMs).toISOString(),
    firstBookMentionAtMs: null,
    firstPrimarySourceAtMs: null,
    workspaceReadyAtMs: null,
    firstCodexCliStartAtMs: null,
    completionAtMs: null,
    documentBookIds: new Set<string>(),
    candidateBookIds: new Set<string>(),
    vmTouchedBookIds: new Set<string>(),
    mentionedChunkIds: new Set<string>(),
    selectedWorkspaceBookIds: new Set<string>(),
    activeBookIds: new Set<string>(),
    estimatedTrueBreadthBooks: 0,
    probeBooksShown: 0,
    verifiedChunksAtVmHandoff: 0,
    verifiedWorksAtVmHandoff: 0,
    actualShardRuns: 0,
    successfulShardRuns: 0,
    reusedPriorFrontierWorks: 0,
    reusedPriorVerifiedWorks: 0,
    reusedPriorChunks: 0,
    plannedParallelShards: 0,
    plannedFrontierWorks: 0,
    completionMode: "standard",
    recorded: false,
  };
}

function markMetricOnce(target: { value: number | null }, nowMs: number) {
  if (target.value === null) {
    target.value = nowMs;
  }
}

function collectWorkIdsFromWorks(input: unknown) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((candidate) =>
      candidate && typeof candidate === "object" && typeof (candidate as Record<string, unknown>).id === "string"
        ? (candidate as Record<string, unknown>).id as string
        : null)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function collectWorkIdsFromFrontier(input: unknown) {
  if (!input || typeof input !== "object" || !Array.isArray((input as Record<string, unknown>).works)) {
    return [];
  }
  return collectWorkIdsFromWorks((input as Record<string, unknown>).works);
}

function collectWorkIdsFromManifest(input: unknown) {
  if (!input || typeof input !== "object" || !Array.isArray((input as Record<string, unknown>).works)) {
    return [];
  }
  return ((input as Record<string, unknown>).works as Array<Record<string, unknown>>)
    .map((work) => {
      if (typeof work.workId === "string" && work.workId.length > 0) {
        return work.workId;
      }
      if (typeof work.id === "string" && work.id.length > 0) {
        return work.id;
      }
      return null;
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function collectWorkIdsFromChunks(input: unknown) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((candidate) =>
      candidate && typeof candidate === "object" && typeof (candidate as Record<string, unknown>).workId === "string"
        ? (candidate as Record<string, unknown>).workId as string
        : null)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function collectChunkIds(input: unknown) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((candidate) =>
      candidate && typeof candidate === "object" && typeof (candidate as Record<string, unknown>).id === "string"
        ? (candidate as Record<string, unknown>).id as string
        : null)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function isBroadCorpusResearchQuery(query: string, scopedWorkCount = 0) {
  if (scopedWorkCount > 0) {
    return false;
  }
  return /\b(all|every|compare|comparison|trace|theme|pattern|survey|synthesize|search|find|why|how|where|when|corpus|across)\b/i.test(query);
}

function buildRunMetricsSnapshot(
  state: LiveRunMetricsState,
  status: string,
  completedAtMs: number,
): RunMetricsSnapshot {
  state.completionAtMs = completedAtMs;
  const delta = (value: number | null) => (value === null ? null : Math.max(0, value - state.startedAtMs));
  return {
    status,
    completionMode: state.completionMode,
    startedAt: state.startedAtIso,
    completedAt: new Date(completedAtMs).toISOString(),
    timeToFirstBookMentionMs: delta(state.firstBookMentionAtMs),
    timeToFirstPrimarySourceMs: delta(state.firstPrimarySourceAtMs),
    timeToWorkspaceReadyMs: delta(state.workspaceReadyAtMs),
    timeToFirstCodexCliStartMs: delta(state.firstCodexCliStartAtMs),
    timeToCompletionMs: delta(completedAtMs),
    totalBooksMentioned: state.documentBookIds.size,
    totalCandidateBooks: state.candidateBookIds.size,
    totalVmTouchedBooks: state.vmTouchedBookIds.size,
    totalPassagesMentioned: state.mentionedChunkIds.size,
    totalSelectedWorkspaceBooks: state.selectedWorkspaceBookIds.size,
    totalActiveBooksInFinalAnswer: state.activeBookIds.size,
    estimatedTrueBreadthBooks: state.estimatedTrueBreadthBooks,
    probeBooksShown: state.probeBooksShown,
    verifiedChunksAtVmHandoff: state.verifiedChunksAtVmHandoff,
    verifiedWorksAtVmHandoff: state.verifiedWorksAtVmHandoff,
    actualShardRuns: state.actualShardRuns,
    successfulShardRuns: state.successfulShardRuns,
    reusedPriorFrontierWorks: state.reusedPriorFrontierWorks,
    reusedPriorVerifiedWorks: state.reusedPriorVerifiedWorks,
    reusedPriorChunks: state.reusedPriorChunks,
    plannedParallelShards: state.plannedParallelShards,
    plannedFrontierWorks: state.plannedFrontierWorks,
    booksMentioned: [...state.documentBookIds],
    selectedWorkspaceBooks: [...state.selectedWorkspaceBookIds],
    activeBooksInFinalAnswer: [...state.activeBookIds],
  };
}

function buildRunMetricsAnalyticsSummary(
  sessionId: string,
  runId: string,
  userId: string,
  metrics: RunMetricsSnapshot,
) {
  return {
    userId,
    sessionId,
    runId,
    status: metrics.status,
    completionMode: metrics.completionMode,
    startedAt: metrics.startedAt,
    completedAt: metrics.completedAt,
    timeToFirstBookMentionMs: metrics.timeToFirstBookMentionMs,
    timeToFirstPrimarySourceMs: metrics.timeToFirstPrimarySourceMs,
    timeToWorkspaceReadyMs: metrics.timeToWorkspaceReadyMs,
    timeToFirstCodexCliStartMs: metrics.timeToFirstCodexCliStartMs,
    timeToCompletionMs: metrics.timeToCompletionMs,
    totalBooksMentioned: metrics.totalBooksMentioned,
    totalCandidateBooks: metrics.totalCandidateBooks,
    totalVmTouchedBooks: metrics.totalVmTouchedBooks,
    totalPassagesMentioned: metrics.totalPassagesMentioned,
    totalSelectedWorkspaceBooks: metrics.totalSelectedWorkspaceBooks,
    totalActiveBooksInFinalAnswer: metrics.totalActiveBooksInFinalAnswer,
    estimatedTrueBreadthBooks: metrics.estimatedTrueBreadthBooks,
    probeBooksShown: metrics.probeBooksShown,
    verifiedChunksAtVmHandoff: metrics.verifiedChunksAtVmHandoff,
    verifiedWorksAtVmHandoff: metrics.verifiedWorksAtVmHandoff,
    actualShardRuns: metrics.actualShardRuns,
    successfulShardRuns: metrics.successfulShardRuns,
    reusedPriorFrontierWorks: metrics.reusedPriorFrontierWorks,
    reusedPriorVerifiedWorks: metrics.reusedPriorVerifiedWorks,
    reusedPriorChunks: metrics.reusedPriorChunks,
    plannedParallelShards: metrics.plannedParallelShards,
    plannedFrontierWorks: metrics.plannedFrontierWorks,
  };
}

function extractRecordedRunMetrics(rawLog: Array<ToolRunRawLogEntry | Record<string, unknown>>): RunMetricsSnapshot | null {
  for (let index = rawLog.length - 1; index >= 0; index -= 1) {
    const entry = rawLog[index];
    if (!entry || typeof entry !== "object" || entry.event !== "run.metrics") {
      continue;
    }
    const payload = "payload" in entry ? entry.payload : null;
    if (!payload || typeof payload !== "object") {
      continue;
    }
    return payload as unknown as RunMetricsSnapshot;
  }
  return null;
}

async function withToolExecutionDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function normalizedScopeEstimateFilters(input: unknown): PassageSearchFilters {
  if (!input || typeof input !== "object") {
    return {};
  }
  const filters = input as Record<string, unknown>;
  const yearRange = Array.isArray(filters.yearRange)
    && filters.yearRange.length >= 2
    && typeof filters.yearRange[0] === "number"
    && typeof filters.yearRange[1] === "number"
      ? [filters.yearRange[0], filters.yearRange[1]] as [number, number]
      : undefined;
  return {
    ...(typeof filters.language === "string" ? { language: filters.language } : {}),
    ...(typeof filters.rightsStatus === "string" ? { rightsStatus: filters.rightsStatus } : {}),
    ...(Array.isArray(filters.genre)
      ? { genre: filters.genre.filter((value): value is string => typeof value === "string") }
      : {}),
    ...(yearRange ? { yearRange } : {}),
  };
}

function scopeEstimateCacheKey(query: string, filters: PassageSearchFilters): string {
  return JSON.stringify({
    query,
    language: filters.language ?? null,
    rightsStatus: filters.rightsStatus ?? null,
    genre: Array.isArray(filters.genre) ? [...filters.genre] : [],
    yearRange: Array.isArray(filters.yearRange) ? [...filters.yearRange] : null,
  });
}

function backgroundToolDeadlineMs(toolName: "create_workspace" | "run_workspace_task", normalizedToolArgs: Record<string, unknown>) {
  if (toolName === "create_workspace") {
    return {
      timeoutMs: 70_000,
      message: "Workspace startup exceeded the orchestrator deadline.",
    };
  }
  const taskSpec = normalizedToolArgs.taskSpec && typeof normalizedToolArgs.taskSpec === "object"
    ? normalizedToolArgs.taskSpec as Record<string, unknown>
    : null;
  const requestedMinutes = typeof taskSpec?.timeBudgetMinutes === "number"
    ? taskSpec.timeBudgetMinutes
    : 5;
  const boundedMinutes = Math.max(5, Math.min(requestedMinutes, HARD_LIMITS.MAX_RUN_WALL_CLOCK_SECONDS / 60));
  return {
    timeoutMs: Math.min(HARD_LIMITS.MAX_RUN_WALL_CLOCK_SECONDS * 1000, boundedMinutes * 60_000 + 30_000),
    message: `Corpus briefing exceeded the ${boundedMinutes}-minute task budget.`,
  };
}

function looksSensitiveKey(key: string) {
  return /(secret|token|password|cookie|authorization|api[-_]?key|session[-_]?id)/iu.test(key);
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\b(sk|rk|pk)_[a-z0-9_-]{12,}\b/giu, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/giu, "Bearer [redacted]")
    .replace(/\b(?:R2|AWS|OPENAI|CLOUDFLARE|ALPHABOOK)_[A-Z0-9_]*?(?:KEY|TOKEN|SECRET|COOKIE|PASSWORD)\s*=\s*[^\s]+/gu, "[redacted]")
    .replace(/\b(?:R2|AWS|OPENAI|CLOUDFLARE|ALPHABOOK)\s+(?:ACCESS KEY ID|SECRET ACCESS KEY|SESSION COOKIE|API KEY)\s*=\s*[^\s]+/giu, "[redacted]")
    .replace(/\bhttps?:\/\/[A-Za-z0-9.-]+\.(?:digitaloceanspaces\.com|amazonaws\.com)\b/giu, "[redacted]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/gu, "[redacted]")
    .replace(/([A-Za-z0-9+/]{32,}={0,2})/gu, "[redacted]");
}

function containsSensitiveUserFacingText(text: string): boolean {
  return (
    /\b(?:access key|secret access key|api key|session cookie|authorization token|bearer token)\b/iu.test(text)
    || /\b(?:R2|AWS|OPENAI|CLOUDFLARE|ALPHABOOK)_[A-Z0-9_]*?(?:KEY|TOKEN|SECRET|COOKIE|PASSWORD)\b/u.test(text)
    || /\b(?:R2|AWS|OPENAI|CLOUDFLARE|ALPHABOOK)\s+(?:ACCESS KEY ID|SECRET ACCESS KEY|SESSION COOKIE|API KEY)\b/iu.test(text)
    || /\bhttps?:\/\/[A-Za-z0-9.-]+\.(?:digitaloceanspaces\.com|amazonaws\.com)\b/iu.test(text)
  );
}

function isCodeLikeUserFacingText(text: string): boolean {
  const value = text.trim();
  if (!value) {
    return false;
  }
  return (
    /^(?:const|let|var|function|import|export|return)\b/u.test(value)
    || /^(?:if|for|while|switch|catch)\s*\(/u.test(value)
    || /^(?:try\s*\{|finally\s*\{|else\b)/u.test(value)
    || /\bspawn\(/u.test(value)
    || /\bprocess\.(?:env|kill|exit|pid)\b/u.test(value)
    || /\bchild\.on\(/u.test(value)
    || /\bstdio:\s*["'][^"']+["']/u.test(value)
    || /\benv:\s*process\.env\b/u.test(value)
    || /\bJSON\.parse\(/u.test(value)
    || /\b(?:readFileSync|writeFileSync)\(/u.test(value)
    || /^\s*["'][^"']+["']:\s*/u.test(value)
    || /^\s*[}\])][,;]?\s*$/u.test(value)
    || /=>\s*\{?/u.test(value)
  );
}

function fallbackNormalizeToolLines(lines: ToolStreamCleanupLine[]): string[] {
  const normalized: string[] = [];
  for (const line of lines) {
    let value = redactSensitiveText(line.value)
      .replace(/[`*_#>-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!value) {
      continue;
    }
    const sanitized = sanitizeUserFacingToolText(value);
    if (!sanitized || isCodeLikeUserFacingText(sanitized)) {
      continue;
    }
    value = sanitized;
    if (looksSensitiveKey(line.key)) {
      value = "[redacted]";
    }
    if (normalized[normalized.length - 1] === value) {
      continue;
    }
    const previous = normalized[normalized.length - 1];
    const isShortOrVague = value.length < 28 || /^(starting|working|running|loading|checking|reviewing|searching)\b/iu.test(value);
    const shouldKeepSeparate =
      line.toolName === "run_workspace_task"
      || line.key.startsWith("research.")
      || line.key.startsWith("codex.")
      || line.key === "progress";
    if (!shouldKeepSeparate && previous && isShortOrVague && previous.length < 160) {
      normalized[normalized.length - 1] = `${previous} ${value}`.trim();
      continue;
    }
    normalized.push(value);
  }
  return normalized;
}

function flattenValueForCleanup(
  value: unknown,
  keyPrefix = "",
  lines: ToolStreamCleanupLine[] = [],
): ToolStreamCleanupLine[] {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (keyPrefix) {
      lines.push({ toolName: "", key: keyPrefix, value: String(value) });
    }
    return lines;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (keyPrefix) {
        lines.push({ toolName: "", key: keyPrefix, value: "[]" });
      }
      return lines;
    }
    value.slice(0, 12).forEach((entry, index) => {
      flattenValueForCleanup(entry, keyPrefix ? `${keyPrefix}[${index}]` : `[${index}]`, lines);
    });
    if (value.length > 12 && keyPrefix) {
      lines.push({ toolName: "", key: `${keyPrefix}[+]`, value: `${value.length - 12} more` });
    }
    return lines;
  }
  if (!value || typeof value !== "object") {
    return lines;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextKey = keyPrefix ? `${keyPrefix}.${key}` : key;
    if (looksSensitiveKey(nextKey)) {
      lines.push({ toolName: "", key: nextKey, value: "[redacted]" });
      continue;
    }
    flattenValueForCleanup(child, nextKey, lines);
  }
  return lines;
}

async function normalizeToolLinesForUser(
  deps: AppDeps,
  input: {
    toolName: ToolName;
    lines: ToolStreamCleanupLine[];
    allowModelCleanup?: boolean;
  },
  auditLog?: AuditLogger,
) {
  const fallback = fallbackNormalizeToolLines(input.lines);
  const fallbackSummary = fallback[0] ?? "";
  const isEphemeralProgressBatch = input.lines.every((line) =>
    line.key === "progress"
    || line.key.startsWith("research.")
    || line.key.startsWith("codex.")
    || line.key === "workspace.local_chunks.missing",
  );
  const cleanupLines = (() => {
    const lines = input.lines.filter((line) => line.value.trim().length > 0);
    if (input.toolName !== "run_workspace_task") {
      return lines.slice(0, 36);
    }
    const preferred = lines.filter((line) =>
      line.key === "rationale"
      || line.key === "taskSpec.mode"
      || line.key === "taskSpec.researchObjective"
      || line.key === "taskSpec.goal"
      || line.key === "taskSpec.query"
      || line.key === "taskSpec.retrievalQuery"
      || /^taskSpec\.(candidateWorkIds|workIds|chunkIds)\[(?:0|1|2|3|4|\+)\]$/u.test(line.key)
      || /^taskSpec\.retrieval\.searchWorks\[(?:0|1|2|3|4)\]\.(title|authors\[\d+\]|summary)$/u.test(line.key),
    );
    return (preferred.length > 0 ? preferred : lines).slice(0, 28);
  })();
  if (
    input.allowModelCleanup === false
    || !deps.ai
    || cleanupLines.length === 0
    || input.toolName === "create_workspace"
    || isEphemeralProgressBatch
  ) {
    return {
      summary: fallbackSummary,
      normalizedLines: fallback,
    };
  }
  auditLog?.("internal.glm_cleanup.started", {
    toolName: input.toolName,
    model: deps.toolStreamCleanupModel ?? DEFAULT_SESSION_TITLE_MODEL,
    lineCount: cleanupLines.length,
  });
  try {
    const cleaned = await cleanupToolStreamWithWorkersAi(deps.ai, {
      model: deps.toolStreamCleanupModel,
      toolName: input.toolName,
      lines: cleanupLines,
    });
    auditLog?.("internal.glm_cleanup.completed", {
      toolName: input.toolName,
      model: deps.toolStreamCleanupModel ?? DEFAULT_SESSION_TITLE_MODEL,
      normalizedLineCount: cleaned.normalizedLines.length,
      summary: cleaned.summary || null,
    });
    const normalized = fallbackNormalizeToolLines(
      cleaned.normalizedLines.map((line) => ({
        toolName: input.toolName,
        key: "normalized",
        value: line,
      })),
    );
    return {
      summary: typeof cleaned.summary === "string" && cleaned.summary.trim().length > 0
        ? cleaned.summary.trim()
        : fallbackSummary,
      normalizedLines: normalized.length > 0 ? normalized : fallback,
    };
  } catch (error) {
    auditLog?.("internal.glm_cleanup.failed", {
      toolName: input.toolName,
      model: deps.toolStreamCleanupModel ?? DEFAULT_SESSION_TITLE_MODEL,
      error: error instanceof Error ? error.message : "Unknown cleanup error",
    });
    return {
      summary: fallbackSummary,
      normalizedLines: fallback,
    };
  }
}

async function persistRunStreamArtifact(
  deps: AppDeps,
  sessionId: string,
  runId: string,
  rawEntries: ToolRunRawLogEntry[],
) {
  const filename = `${runId}-tool-stream.jsonl`;
  const r2Key = artifactKeys.sessionArtifact(sessionId, filename);
  const content = rawEntries.map((entry) => JSON.stringify(entry)).join("\n");
  await deps.blobStore.putText(r2Key, content, "application/x-ndjson; charset=utf-8");
  await deps.store.saveArtifact({
    sessionId,
    runtimeId: null,
    r2Key,
    filename,
    mimeType: "application/x-ndjson",
    metadata: {
      kind: "tool_stream_raw",
      runId,
      lineCount: rawEntries.length,
    },
  });
}

function startRuntimeTaskProgressEmitter(
  runtimeGateway: RuntimeToolGateway,
  send: (event: string, data: Record<string, unknown>) => Promise<void>,
  context: { sessionId: string; runId: string },
  runId: string,
  toolCallId: string,
  toolName: ToolName,
  runtimeId: string,
  options?: { initialText?: string | null },
) {
  let stopped = false;
  let inFlight = false;
  let seenLines = 0;
  let seenBriefingLines = 0;

  const emit = async (text: string, detail?: Record<string, unknown>) => {
    await send("tool.progress", {
      runId,
      toolCallId,
      toolName,
      runtimeId,
      text,
      ...(detail ? { detail } : {}),
    });
  };

  const poll = async () => {
    if ((stopped && !inFlight) || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const result = await runtimeGateway.readWorkspaceFile({
        runtimeId,
        path: "output/codex-progress.jsonl",
        sessionId: context.sessionId,
        runId: context.runId,
      });
      const content = typeof result.content === "string" ? result.content : "";
      const lines = content.split("\n").filter((line) => line.trim().length > 0);
      if (seenLines > lines.length) {
        seenLines = 0;
      }
      for (let index = seenLines; index < lines.length; index += 1) {
        try {
          const event = JSON.parse(lines[index]) as Record<string, unknown>;
          const { text, detail } = normalizeRuntimeProgressLine(event);
          if (text) {
            await emit(text, detail ?? event);
          }
        } catch {
          continue;
        }
      }
      seenLines = lines.length;
      const briefingResult = await runtimeGateway.readWorkspaceFile({
        runtimeId,
        path: "output/briefing.md",
        sessionId: context.sessionId,
        runId: context.runId,
      }).catch(() => null);
      const briefingContent = briefingResult && typeof briefingResult.content === "string"
        ? briefingResult.content
        : "";
      const briefingLines = briefingContent
        .split(/\r?\n/u)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
      if (seenBriefingLines > briefingLines.length) {
        seenBriefingLines = 0;
      }
      for (let index = seenBriefingLines; index < briefingLines.length; index += 1) {
        const line = briefingLines[index]?.trim();
        if (!line) {
          continue;
        }
        await emit(
          /^(?:#{1,6}\s+|[-*]\s+)/u.test(line) ? "Updating the briefing draft." : line,
          {
            type: "research.briefing_line",
            line,
            lineIndex: index,
          },
        );
      }
      seenBriefingLines = briefingLines.length;
    } catch {
      // Runtime progress is best-effort while the task is still starting up.
    } finally {
      inFlight = false;
    }
  };

  if (options?.initialText !== null) {
    void emit(options?.initialText ?? "Starting the deeper research run.");
  }
  void poll();
  const timer = setInterval(() => {
    void poll();
  }, 750);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await poll();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await poll();
    },
  };
}

function startToolProgressEmitter(
  runtimeGateway: RuntimeToolGateway,
  send: (event: string, data: Record<string, unknown>) => Promise<void>,
  context: { sessionId: string; runId: string },
  runId: string,
  toolCallId: string,
  toolName: ToolName,
  args: Record<string, unknown>,
) {
  if (toolName === "run_workspace_task") {
    const runtimeId = typeof args.runtimeId === "string" ? args.runtimeId : null;
    if (runtimeId) {
      return startRuntimeTaskProgressEmitter(runtimeGateway, send, context, runId, toolCallId, toolName, runtimeId);
    }
    return {
      async stop() {},
    };
  }
  return genericProgressEmitter(send, runId, toolCallId, toolName, args);
}

function extractCompletedBriefing(
  toolName: ToolName,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): { answer: string; citations: Citation[] } | null {
  if (
    toolName === "semantic_deep_search"
    && typeof result.briefing === "string"
    && result.briefing.trim().length > 0
  ) {
    return {
      answer: result.briefing.trim(),
      citations: Array.isArray(result.citations) ? result.citations as Citation[] : [],
    };
  }

  if (
    toolName === "run_workspace_task"
    && typeof result.briefing === "string"
    && result.briefing.trim().length > 0
  ) {
    return {
      answer: result.briefing.trim(),
      citations: Array.isArray(result.citations) ? result.citations as Citation[] : [],
    };
  }

  if (
    toolName === "read_workspace_file"
    && typeof args.path === "string"
    && /briefing\.md$/u.test(args.path)
    && typeof result.content === "string"
    && result.content.trim().length > 0
  ) {
    return {
      answer: result.content.trim(),
      citations: [],
    };
  }

  return null;
}

function latestCompletedBriefing(
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>,
): { answer: string; citations: Citation[] } | null {
  for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
    const candidate = toolHistory[index];
    const briefing = extractCompletedBriefing(candidate.toolName, candidate.args, candidate.result);
    if (briefing) {
      return briefing;
    }
  }
  return null;
}

function sanitizeCitationRecords(input: unknown): Citation[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const citations: Citation[] = [];
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.workId !== "string" || typeof record.label !== "string" || typeof record.excerpt !== "string") {
      continue;
    }
    citations.push({
      workId: record.workId,
      label: record.label,
      excerpt: record.excerpt,
      ...(typeof record.chunkId === "string" ? { chunkId: record.chunkId } : {}),
      ...(typeof record.r2Key === "string" ? { r2Key: record.r2Key } : {}),
      ...(typeof record.readerPath === "string" ? { readerPath: record.readerPath } : {}),
    });
  }
  return citations;
}

function collectSynthesisCitations(
  plannerCitations: Citation[],
  toolHistory: ToolHistoryEntry[],
): Citation[] {
  const deduped = new Map<string, Citation>();
  const pushCitation = (citation: Citation) => {
    const key = `${citation.workId}:${citation.chunkId ?? citation.label}`;
    if (!deduped.has(key)) {
      deduped.set(key, citation);
    }
  };

  for (const citation of plannerCitations) {
    pushCitation(citation);
  }
  for (const entry of toolHistory) {
    for (const citation of sanitizeCitationRecords(entry.result.citations)) {
      pushCitation(citation);
    }
    if (Array.isArray(entry.result.chunks)) {
      for (const chunk of entry.result.chunks as ChunkSearchResult[]) {
        if (!chunk || typeof chunk !== "object" || typeof chunk.workId !== "string" || typeof chunk.excerpt !== "string") {
          continue;
        }
        pushCitation({
          workId: chunk.workId,
          chunkId: chunk.id,
          label: `${chunk.workId}#${chunk.chunkIndex}`,
          excerpt: chunk.excerpt,
          r2Key: chunk.r2Key ?? undefined,
          readerPath: chunk.readerPath ?? undefined,
        });
      }
    }
  }
  return [...deduped.values()];
}

function dedupeAppCitations(citations: Citation[]) {
  const deduped = new Map<string, Citation>();
  for (const citation of citations) {
    const key = `${citation.workId}:${citation.chunkId ?? citation.label}`;
    if (!deduped.has(key)) {
      deduped.set(key, citation);
    }
  }
  return [...deduped.values()];
}

function minimumCitationBreadthForRun(userMessage: string, citations: Citation[]) {
  const distinctWorkIds = uniqueWorkIds(citations.map((citation) => citation.workId));
  if (distinctWorkIds.length <= 1) {
    return distinctWorkIds.length;
  }
  const broadCorpusQuery = isBroadCorpusResearchQuery(userMessage, 0);
  if (!broadCorpusQuery) {
    return Math.min(2, distinctWorkIds.length);
  }
  return Math.min(4, distinctWorkIds.length);
}

function ensureCitationBreadth(
  userMessage: string,
  chosenCitations: Citation[],
  availableCitations: Citation[],
) {
  const minimumBreadth = minimumCitationBreadthForRun(userMessage, availableCitations);
  if (minimumBreadth <= 1) {
    return chosenCitations;
  }
  const selected = dedupeAppCitations(chosenCitations);
  const selectedWorkIds = new Set(selected.map((citation) => citation.workId));
  if (selectedWorkIds.size >= minimumBreadth) {
    return selected;
  }
  const additions = availableCitations.filter((citation) => !selectedWorkIds.has(citation.workId));
  for (const citation of additions) {
    selected.push(citation);
    selectedWorkIds.add(citation.workId);
    if (selectedWorkIds.size >= minimumBreadth || selected.length >= 8) {
      break;
    }
  }
  return dedupeAppCitations(selected).slice(0, 8);
}

export async function finalizeStaleRun(
  deps: AppDeps,
  _request: Request,
  run: Awaited<ReturnType<AppStore["getRun"]>>,
  activeRuns?: Map<string, ActiveRunState>,
) {
  if (!run) {
    return run;
  }

  const session = await deps.store.getSession(run.sessionId);
  if (!session) {
    return run;
  }
  const runEvents = await deps.store.listRunEvents(run.id);
  const researchTasks = await deps.store.listResearchTasksForRun(run.id);

  const cancelLiveExecution = async () => {
    const activeRun = activeRuns?.get(run.id);
    if (activeRun) {
      activeRun.cancelRequested = true;
    }
    const persistedRuntimeIds = await listPersistedRunRuntimeIds(deps, session.id, run.id);
    const runtimeIds = new Set<string>([
      ...Array.from(activeRun?.runtimeIds ?? []),
      ...persistedRuntimeIds,
    ]);
    await Promise.all(
      Array.from(runtimeIds).map((runtimeId) =>
        deps.runtimeGateway.cancelWorkspaceTask?.({ runtimeId }).catch(() => {}),
      ),
    );
  };

  const closeDanglingToolCalls = async (message: string) => {
    const toolCalls = await deps.store.listToolCalls(run.id);
    const dangling = toolCalls.filter((toolCall) => toolCall.status === "running" || toolCall.status === "queued");
    if (dangling.length === 0) {
      return;
    }
    await Promise.all(
      dangling.map((toolCall) => deps.store.finishToolCall(toolCall.id, "failed", {
        ok: false,
        error: message,
        runtimeId: runtimeIdFromToolResult(toolCall.resultJson, toolCall.argsJson) ?? undefined,
      })),
    );
  };

  if (run.status === "completed") {
    return run;
  }
  if (run.status !== "running" && run.status !== "queued") {
    await closeDanglingToolCalls("The run ended before this step finished.");
    await cancelLiveExecution();
    return run;
  }

  const terminalRunEvent = terminalRunStatusFromRunEvents(runEvents);
  if (terminalRunEvent) {
    await closeDanglingToolCalls("The run reached a terminal state before this step finished.");
    await deps.store.updateRun(run.id, terminalRunStateUpdate(terminalRunEvent.status, terminalRunEvent.completedAt));
    await cancelLiveExecution();
    return deps.store.getRun(run.id);
  }

  const activeResearchTask = researchTasks.some((task) => {
    return task.status === "queued" || task.status === "starting" || task.status === "running";
  });
  if (activeResearchTask) {
    return run;
  }

  const activeBackgroundJob = await deps.store.getLatestBackgroundJobForRun(run.id);
  if (activeBackgroundJob && activeBackgroundJob.provider === "hermes" && backgroundJobIsActive(activeBackgroundJob.status)) {
    try {
      await syncHermesBackgroundJob(deps, activeRuns ?? new Map(), { session, run });
      const refreshedRun = await deps.store.getRun(run.id);
      if (refreshedRun && (refreshedRun.status === "running" || refreshedRun.status === "queued")) {
        return refreshedRun;
      }
      return refreshedRun ?? run;
    } catch {
      return run;
    }
  }

  const failureMessage = "This run stopped before it wrote a terminal event.";
  await appendRunLifecycleEvent(deps, run, "run.recovery.failed", {
    reason: "lease_expired_without_terminal_event",
    message: failureMessage,
  });
  await closeDanglingToolCalls(failureMessage);
  await writeTerminalRunState(deps, run.id, "failed");
  await appendRunErrorMessageOnce(deps, session.id, run.id, failureMessage, {
    runId: run.id,
    phase: "error",
  });
  await cancelLiveExecution();
  return deps.store.getRun(run.id);
}

function normalizeGeneratedSessionTitle(value: string): string | null {
  const normalized = value
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/^#+\s*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
  return normalized || null;
}

function fallbackSessionTitleFromMessage(message: string): string {
  const normalized = normalizeGeneratedSessionTitle(message);
  if (!normalized) {
    return "Untitled chat";
  }
  const truncated = normalized.slice(0, 64).trim();
  return truncated || "Untitled chat";
}

function normalizeWorkersAiText(payload: unknown): string {
  const extract = (value: unknown, depth = 0): string => {
    if (depth > 4 || value == null) {
      return "";
    }
    if (typeof value === "string") {
      return value.trim();
    }
    if (Array.isArray(value)) {
      return value
        .map((entry) => extract(entry, depth + 1))
        .filter((entry) => entry.length > 0)
        .join(" ")
        .trim();
    }
    if (typeof value !== "object") {
      return "";
    }
    const record = value as Record<string, unknown>;
    return extract(
      record.response
      ?? record.output_text
      ?? record.text
      ?? record.result
      ?? record.message
      ?? record.content
      ?? (Array.isArray(record.choices) ? record.choices[0] : null),
      depth + 1,
    );
  };

  return extract(payload);
}

function toolNeedsForegroundHeartbeat(toolName: ToolName) {
  return toolName === "run_workspace_task" || toolName === "semantic_deep_search";
}

function toolUsesDurableResearchQueue(toolName: ToolName) {
  return toolName === "run_workspace_task" || toolName === "semantic_deep_search";
}

function foregroundHeartbeatText(toolName: ToolName, runStartedAt: string) {
  const elapsedMinutes = Math.max(1, Math.floor((Date.now() - Date.parse(runStartedAt)) / 60_000));
  if (toolName === "semantic_deep_search") {
    return elapsedMinutes <= 1
      ? "Still reviewing and ranking the strongest passages from the semantic search."
      : `Still reviewing and ranking passages. About ${elapsedMinutes} minutes have passed so far.`;
  }
  return elapsedMinutes <= 1
    ? "Still loading books and comparing passages across the library."
    : `Still searching across the library. About ${elapsedMinutes} minutes have passed so far.`;
}

function terminalResearchTaskError(task: { checkpointJson?: unknown; errorJson?: unknown }): string | null {
  const checkpoint = task.checkpointJson;
  if (checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)) {
    const record = checkpoint as Record<string, unknown>;
    if (record.type === "semantic.error" && typeof record.error === "string" && record.error.trim().length > 0) {
      return record.error.trim();
    }
  }
  const errorJson = task.errorJson;
  if (errorJson && typeof errorJson === "object" && !Array.isArray(errorJson)) {
    const record = errorJson as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim().length > 0) {
      return record.error.trim();
    }
  }
  return null;
}

function normalizedComparisonText(value: string) {
  return value
    .toLowerCase()
    .replace(/^#+\s*/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleLooksLikeMessagePrefix(title: string, message: string) {
  const normalizedTitle = normalizedComparisonText(title);
  const normalizedMessage = normalizedComparisonText(message);
  if (!normalizedTitle || !normalizedMessage) {
    return false;
  }
  if (normalizedTitle.length < 18) {
    return false;
  }
  return normalizedMessage.startsWith(normalizedTitle);
}

async function createSessionTitle(deps: AppDeps, message: string, auditLog?: AuditLogger): Promise<string> {
  if (!deps.ai) {
    auditLog?.("internal.session_title.skipped", {
      model: DEFAULT_SESSION_TITLE_MODEL,
      reason: "workers_ai_unavailable",
    });
    return fallbackSessionTitleFromMessage(message);
  }

  auditLog?.("internal.session_title.started", {
    model: DEFAULT_SESSION_TITLE_MODEL,
    messagePreview: message.trim().slice(0, 180),
  });
  const payload = await deps.ai.run<{ messages: Array<{ role: "system" | "user"; content: string }> }, unknown>(DEFAULT_SESSION_TITLE_MODEL, {
    messages: [
      {
        role: "system",
        content: [
          "Write a short, specific title for a new literary research session.",
          "Use the user's first message only.",
          "Return plain text only.",
          "Make it feel like a real heading, not a truncation.",
          "Prefer 3 to 7 words.",
          "Do not simply repeat the opening words of the message.",
          "Do not use quotes, markdown, trailing punctuation, or a generic label like Research or New Chat.",
        ].join("\n"),
      },
      {
        role: "user",
        content: message.trim(),
      },
    ],
  });
  const title = normalizeGeneratedSessionTitle(normalizeWorkersAiText(payload));
  if (!title) {
    auditLog?.("internal.session_title.failed", {
      model: DEFAULT_SESSION_TITLE_MODEL,
      error: "Session title generation returned an empty response.",
      payload,
    });
    throw new Error("Session title generation returned an empty response.");
  }
  if (titleLooksLikeMessagePrefix(title, message)) {
    auditLog?.("internal.session_title.failed", {
      model: DEFAULT_SESSION_TITLE_MODEL,
      error: "Session title generation returned a truncated copy of the opening message.",
      title,
    });
    throw new Error("Session title generation returned a truncated copy of the opening message.");
  }
  auditLog?.("internal.session_title.completed", {
    model: DEFAULT_SESSION_TITLE_MODEL,
    title,
  });
  return title;
}

function chunkTextForStream(text: string): string[] {
  const cleaned = text.trim();
  if (!cleaned) {
    return [];
  }
  const chunks: string[] = [];
  const words = cleaned.split(/(\s+)/u).filter((part) => part.length > 0);
  let current = "";

  for (const part of words) {
    if (current.length > 0 && current.length + part.length > 48) {
      chunks.push(current);
      current = part;
      continue;
    }
    current += part;
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

async function streamAssistantText(
  answer: string,
  send: (event: string, data: Record<string, unknown>) => Promise<void>,
) {
  for (const text of chunkTextForStream(answer)) {
    await send("assistant.delta", {
      text,
    });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

type ToolTraceName = ToolName | "search" | "design_experiment";

function labelForToolCall(toolName: ToolTraceName, args: Record<string, unknown>) {
  if (toolName === "run_workspace_task") {
    const taskSpec = args.taskSpec;
    if (taskSpec && typeof taskSpec === "object") {
      const phase = typeof (taskSpec as Record<string, unknown>).phase === "string"
        ? (taskSpec as Record<string, unknown>).phase
        : null;
      if (phase === "collect_evidence") {
        return "Evidence Search";
      }
      if (phase === "collect_and_brief") {
        return "Corpus Briefing";
      }
      if (phase === "write_briefing") {
        return "Quoted Briefing";
      }
      const mode = typeof (taskSpec as Record<string, unknown>).mode === "string"
        ? (taskSpec as Record<string, unknown>).mode
        : null;
      if (mode === "sprite_fanout" || mode === "sprite_shard_search" || mode === "sprite_aggregate") {
        return "Sprite Fanout Research";
      }
    }
  }
  if (toolName === "read_workspace_file") {
    const path = typeof args.path === "string" ? args.path : "";
    if (/briefing\.md$/u.test(path)) {
      return "Briefing Import";
    }
    if (/evidence-notes\.md$/u.test(path)) {
      return "Search Notes";
    }
  }
  return getToolLabel(toolName);
}

function clientSafeToolResult(toolName: ToolTraceName, result: Record<string, unknown>): Record<string, unknown> {
  if (toolName === "semantic_deep_search") {
    const chunks = Array.isArray(result.chunks) ? result.chunks : [];
    const alphaloopEvents = Array.isArray(result.alphaloopEvents) ? result.alphaloopEvents : [];
    const iterations = Array.isArray(result.iterations) ? result.iterations : [];
    return {
      chunkCount: chunks.length,
      totalChunksConsidered: typeof result.totalChunksConsidered === "number" ? result.totalChunksConsidered : undefined,
      alphaloopEvents: alphaloopEvents.slice(0, 24).map((candidate) => (
        candidate && typeof candidate === "object" ? candidate : null
      )).filter((candidate): candidate is Record<string, unknown> => Boolean(candidate)),
      iterations: iterations.slice(0, 6).map((candidate) => (
        candidate && typeof candidate === "object" ? candidate : null
      )).filter((candidate): candidate is Record<string, unknown> => Boolean(candidate)),
      chunks: chunks.slice(0, 12).map((candidate) => {
        if (!candidate || typeof candidate !== "object") {
          return candidate;
        }
        const chunk = candidate as Record<string, unknown>;
        return {
          id: typeof chunk.id === "string" ? chunk.id : undefined,
          workId: typeof chunk.workId === "string" ? chunk.workId : undefined,
          chunkIndex: typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : undefined,
          score: typeof chunk.score === "number" ? chunk.score : undefined,
          relevance: typeof chunk.score === "number" ? chunk.score : undefined,
          text:
            typeof chunk.text === "string"
              ? chunk.text
              : typeof chunk.excerpt === "string"
                ? chunk.excerpt
                : undefined,
          excerpt:
            typeof chunk.excerpt === "string"
              ? chunk.excerpt
                : typeof chunk.text === "string"
                ? chunk.text.slice(0, 280)
                : undefined,
          r2Key: typeof chunk.r2Key === "string" ? chunk.r2Key : undefined,
        };
      }),
      citations: sanitizeCitationRecords(result.citations),
      briefing: typeof result.briefing === "string" ? result.briefing : undefined,
      error: typeof result.error === "string" ? result.error : undefined,
    };
  }

  if (toolName === "estimate_research_scope") {
    const probeWorks = Array.isArray(result.probeWorks) ? result.probeWorks : [];
    const metadataWorkEstimate = typeof result.metadataWorkEstimate === "number" ? result.metadataWorkEstimate : undefined;
    const chunkWorkEstimate = typeof result.chunkWorkEstimate === "number" ? result.chunkWorkEstimate : undefined;
    const trueBreadthEstimate =
      typeof metadataWorkEstimate === "number" || typeof chunkWorkEstimate === "number"
        ? Math.max(metadataWorkEstimate ?? 0, chunkWorkEstimate ?? 0, probeWorks.length)
        : undefined;
    return {
      scopeMode: typeof result.scopeMode === "string" ? result.scopeMode : undefined,
      metadataWorkEstimate,
      chunkMatchEstimate: typeof result.chunkMatchEstimate === "number" ? result.chunkMatchEstimate : undefined,
      chunkWorkEstimate,
      totalWorkEstimate: typeof result.totalWorkEstimate === "number" ? result.totalWorkEstimate : undefined,
      totalChunkEstimate: typeof result.totalChunkEstimate === "number" ? result.totalChunkEstimate : undefined,
      totalTextBytesEstimate: typeof result.totalTextBytesEstimate === "number" ? result.totalTextBytesEstimate : undefined,
      trueBreadthEstimate,
      probeWorkCount: probeWorks.length,
      probeWorks: probeWorks.slice(0, 12).map((candidate) => {
        if (!candidate || typeof candidate !== "object") {
          return candidate;
        }
        const work = candidate as Record<string, unknown>;
        return {
          id: typeof work.id === "string" ? work.id : undefined,
          title: typeof work.title === "string" ? work.title : undefined,
          authors: Array.isArray(work.authors) ? work.authors.slice(0, 3) : undefined,
        };
      }),
      breadthBand: typeof result.breadthBand === "string" ? result.breadthBand : undefined,
      recommendedIntensity: typeof result.recommendedIntensity === "string" ? result.recommendedIntensity : undefined,
      recommendedWallClockMinutes: typeof result.recommendedWallClockMinutes === "number" ? result.recommendedWallClockMinutes : undefined,
      recommendedParallelism: typeof result.recommendedParallelism === "number" ? result.recommendedParallelism : undefined,
      recommendedShardAxis: typeof result.recommendedShardAxis === "string" ? result.recommendedShardAxis : undefined,
      recommendedFrontierWorks: typeof result.recommendedFrontierWorks === "number" ? result.recommendedFrontierWorks : undefined,
      rationale: typeof result.rationale === "string" ? result.rationale : undefined,
    };
  }

  if (toolName === "search_works" || toolName === "get_work_metadata") {
    const frontier = result.frontier && typeof result.frontier === "object"
      ? result.frontier as Record<string, unknown>
      : null;
    const works = Array.isArray(result.works) ? result.works : [];
    const frontierWorks = Array.isArray(frontier?.works) ? frontier.works : works;
    return {
      workCount: frontierWorks.length,
      frontierWorkCount: frontierWorks.length,
      visibleCandidateWorkCount: Math.min(frontierWorks.length, 12),
      works: frontierWorks.slice(0, 12).map((candidate) => {
        if (!candidate || typeof candidate !== "object") {
          return candidate;
        }
        const work = candidate as Record<string, unknown>;
        return {
          id: typeof work.id === "string" ? work.id : undefined,
          score: typeof work.score === "number" ? work.score : undefined,
          title: typeof work.title === "string" ? work.title : undefined,
          authors: Array.isArray(work.authors) ? work.authors.slice(0, 3) : undefined,
          subjects: Array.isArray(work.subjects) ? work.subjects.slice(0, 5) : undefined,
          language: typeof work.language === "string" ? work.language : undefined,
          rightsStatus: typeof work.rightsStatus === "string" ? work.rightsStatus : undefined,
          gutenbergId: typeof work.gutenbergId === "number" ? work.gutenbergId : undefined,
        };
      }),
      error: typeof result.error === "string" ? result.error : undefined,
    };
  }

  if (toolName === "get_relevant_chunks") {
    const chunks = Array.isArray(result.chunks) ? result.chunks : [];
    const verifiedWorkIds = Array.isArray(result.verifiedWorkIds) ? result.verifiedWorkIds : [];
    return {
      chunkCount: chunks.length,
      verifiedWorkCount: verifiedWorkIds.length,
      chunks: chunks.slice(0, 12).map((candidate) => {
        if (!candidate || typeof candidate !== "object") {
          return candidate;
        }
        const chunk = candidate as Record<string, unknown>;
        return {
          id: typeof chunk.id === "string" ? chunk.id : undefined,
          workId: typeof chunk.workId === "string" ? chunk.workId : undefined,
          chunkIndex: typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : undefined,
          score: typeof chunk.score === "number" ? chunk.score : undefined,
          excerpt:
            typeof chunk.excerpt === "string"
              ? chunk.excerpt
              : typeof chunk.text === "string"
                ? chunk.text.slice(0, 280)
                : undefined,
          r2Key: typeof chunk.r2Key === "string" ? chunk.r2Key : undefined,
        };
      }),
      error: typeof result.error === "string" ? result.error : undefined,
    };
  }

  if (toolName === "classify_candidate_chunks") {
    const chunks = Array.isArray(result.chunks) ? result.chunks : [];
    const relevantWorkIds = Array.isArray(result.relevantWorkIds) ? result.relevantWorkIds : [];
    return {
      relevantChunkCount: chunks.length,
      relevantWorkCount: relevantWorkIds.length,
      candidateChunkCount: typeof result.candidateChunkCount === "number" ? result.candidateChunkCount : undefined,
      chunks: chunks.slice(0, 12).map((candidate) => {
        if (!candidate || typeof candidate !== "object") {
          return candidate;
        }
        const chunk = candidate as Record<string, unknown>;
        return {
          id: typeof chunk.id === "string" ? chunk.id : undefined,
          workId: typeof chunk.workId === "string" ? chunk.workId : undefined,
          chunkIndex: typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : undefined,
          relevanceScore: typeof chunk.relevanceScore === "number" ? chunk.relevanceScore : undefined,
          excerpt:
            typeof chunk.excerpt === "string"
              ? chunk.excerpt
              : typeof chunk.text === "string"
                ? chunk.text.slice(0, 280)
                : undefined,
          r2Key: typeof chunk.r2Key === "string" ? chunk.r2Key : undefined,
        };
      }),
      error: typeof result.error === "string" ? result.error : undefined,
    };
  }

  if (toolName === "create_workspace") {
    const manifest = result.manifest && typeof result.manifest === "object"
      ? result.manifest as Record<string, unknown>
      : null;
    const bookCount = manifest && Array.isArray(manifest.works) ? manifest.works.length : 0;
    return {
      ok: result.ok === true,
      reused: result.reused === true,
      runtimeId: typeof result.runtimeId === "string" ? result.runtimeId : undefined,
      bookCount,
      manifest: bookCount > 0 ? { works: new Array(bookCount).fill(null) } : undefined,
      error: typeof result.error === "string" ? result.error : undefined,
    };
  }

  if (toolName === "run_workspace_task") {
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    const citations = Array.isArray(result.citations) ? result.citations : [];
    const codexRuns = Array.isArray(result.codexRuns) ? result.codexRuns : [];
    const shardResults = Array.isArray(result.shardResults) ? result.shardResults : [];
    const evidenceCount =
      result.evidence && typeof result.evidence === "object" && Array.isArray((result.evidence as Record<string, unknown>).items)
        ? ((result.evidence as Record<string, unknown>).items as unknown[]).length
        : undefined;
    return {
      exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined,
      runtimeId: typeof result.runtimeId === "string" ? result.runtimeId : undefined,
      artifactCount: artifacts.length,
      citationCount: citations.length,
      codexRunCount: codexRuns.length,
      shardCount: shardResults.length,
      successfulShardCount: shardResults.filter((value) => value && typeof value === "object" && (value as Record<string, unknown>).ok === true).length,
      evidenceCount: typeof evidenceCount === "number" ? evidenceCount : undefined,
      briefing: typeof result.briefing === "string" ? result.briefing : undefined,
      briefingLength: typeof result.briefing === "string" ? result.briefing.length : undefined,
      usedFallback: artifacts.some((artifact) =>
        artifact && typeof artifact === "object" && typeof (artifact as Record<string, unknown>).path === "string"
          ? String((artifact as Record<string, unknown>).path).includes("codex-fallback")
          : false,
      ),
      error: typeof result.error === "string" ? result.error : undefined,
    };
  }

  if (toolName === "read_workspace_file") {
    return {
      path: typeof result.path === "string" ? result.path : undefined,
      size: typeof result.size === "number" ? result.size : undefined,
      contentPreview: typeof result.content === "string" ? result.content.slice(0, 280) : undefined,
      error: typeof result.error === "string" ? result.error : undefined,
    };
  }

  return result;
}

function summarizeToolHistory(toolHistory: ToolHistoryEntry[]) {
  return toolHistory.map((entry, index) => ({
    id: `${entry.toolName}-${index}`,
    toolName: entry.toolName,
    label: labelForToolCall(entry.toolName, entry.args),
    rationale: entry.rationale,
    args: entry.args,
    result: entry.result,
    state: entry.result.ok === false ? "error" : "completed",
    isError: entry.result.ok === false,
  }));
}

function latestPriorAssistantSummaryFromConversation(
  conversationHistory: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
  }>,
) {
  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    const entry = conversationHistory[index];
    if (entry.role === "assistant" && entry.content.trim().length > 0) {
      return entry.content.trim().slice(0, 400);
    }
  }
  return null;
}

type LiveToolTraceEntry = {
  id: string;
  toolName: ToolTraceName;
  label: string;
  rationale?: string;
  progress: string[];
  progressDetails?: Array<Record<string, unknown>>;
  sourceArgs: Record<string, unknown>;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  state: "running" | "completed" | "error";
  isError?: boolean;
};

const PERSISTED_TRACE_STRING_MAX_LENGTH = 280;
const PERSISTED_TRACE_ARRAY_MAX_ITEMS = 12;
const PERSISTED_TRACE_OBJECT_MAX_KEYS = 24;

function compactTraceInlineValue(value: unknown, depth = 0): unknown {
  if (depth > 3) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.length > PERSISTED_TRACE_STRING_MAX_LENGTH
      ? `${value.slice(0, PERSISTED_TRACE_STRING_MAX_LENGTH)}…`
      : value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, PERSISTED_TRACE_ARRAY_MAX_ITEMS)
      .map((entry) => compactTraceInlineValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, PERSISTED_TRACE_OBJECT_MAX_KEYS)
        .map(([key, entry]) => [key, compactTraceInlineValue(entry, depth + 1)])
        .filter(([, entry]) => entry !== undefined),
    );
  }
  return value;
}

function compactProgressDetailsForPersistence(progressDetails?: Array<Record<string, unknown>>) {
  if (!Array.isArray(progressDetails) || progressDetails.length === 0) {
    return undefined;
  }
  const compacted = progressDetails
    .slice(-PERSISTED_TRACE_ARRAY_MAX_ITEMS)
    .map((detail) => compactTraceInlineValue(detail))
    .filter((detail): detail is Record<string, unknown> => Boolean(detail) && typeof detail === "object");
  return compacted.length > 0 ? compacted : undefined;
}

function compactToolResultForPersistence(
  toolName: ToolTraceName,
  result: Record<string, unknown> | undefined,
  state: LiveToolTraceEntry["state"],
) {
  if (!result) {
    return undefined;
  }
  const compacted = canonicalToolResult(toolName, result, {
    ok: state !== "error",
  });
  const preferredScalarFields = [
    "__summary",
    "status",
    "error",
    "exit_code",
    "bytes_written",
    "dirs_created",
    "total_lines",
    "file_size",
    "truncated",
    "hint",
    "is_binary",
    "is_image",
    "path",
    "size",
    "success",
  ] as const;
  for (const field of preferredScalarFields) {
    const value = result[field];
    if (
      typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      compacted[field] = compactTraceInlineValue(value);
    }
  }
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

export function compactPlanToolTraceEntriesForPersistence(toolCalls: LiveToolTraceEntry[]) {
  return toolCalls.map((entry) => {
    const progress = entry.progress
      .slice(-PERSISTED_TRACE_ARRAY_MAX_ITEMS)
      .map((line) => truncateHermesText(line, PERSISTED_TRACE_STRING_MAX_LENGTH));
    const progressDetails = compactProgressDetailsForPersistence(entry.progressDetails);
    const compacted: Record<string, unknown> = {
      id: entry.id,
      toolName: entry.toolName,
      label: entry.label,
      progress,
      args: compactTraceInlineValue(entry.args),
      state: entry.state,
    };
    if (entry.rationale) {
      compacted.rationale = truncateHermesText(entry.rationale, PERSISTED_TRACE_STRING_MAX_LENGTH);
    }
    if (progressDetails) {
      compacted.progressDetails = progressDetails;
    }
    if (entry.isError === true) {
      compacted.isError = true;
    }
    const result = compactToolResultForPersistence(entry.toolName, entry.result, entry.state);
    if (result) {
      compacted.result = result;
    }
    return compacted;
  });
}

function canonicalToolArgs(
  toolName: ToolTraceName,
  sourceArgs: Record<string, unknown>,
  rationale?: string,
  progress: string[] = [],
  progressDetails?: Array<Record<string, unknown>>,
) {
  const args: Record<string, unknown> = {
    __toolName: toolName,
  };
  const query = typeof sourceArgs.query === "string" && sourceArgs.query.trim().length > 0 ? sourceArgs.query.trim() : null;
  const path = typeof sourceArgs.path === "string" && sourceArgs.path.trim().length > 0 ? sourceArgs.path.trim() : null;
  const workIds = Array.isArray(sourceArgs.workIds) ? sourceArgs.workIds : [];
  const chunkIds = Array.isArray(sourceArgs.chunkIds) ? sourceArgs.chunkIds : [];
  const taskSpec = sourceArgs.taskSpec && typeof sourceArgs.taskSpec === "object"
    ? sourceArgs.taskSpec as Record<string, unknown>
    : null;
  const taskQuery = typeof taskSpec?.query === "string" && taskSpec.query.trim().length > 0 ? taskSpec.query.trim() : null;
  const goal = typeof taskSpec?.goal === "string" && taskSpec.goal.trim().length > 0 ? taskSpec.goal.trim() : null;
  const phase = typeof taskSpec?.phase === "string" && taskSpec.phase.trim().length > 0 ? taskSpec.phase.trim() : null;

  if (query) {
    args.query = query;
  }
  if (taskQuery && taskQuery !== query) {
    args.taskQuery = taskQuery;
  }
  if (goal) {
    args.goal = goal;
  }
  if (phase) {
    args.phase = phase;
  }
  if (path) {
    args.path = path;
  }
  if (workIds.length > 0) {
    args.candidateBookCount = workIds.length;
  }
  if (chunkIds.length > 0) {
    args.candidatePassageCount = chunkIds.length;
  }
  if (rationale && rationale.trim().length > 0) {
    args.__rationale = rationale.trim();
  }
  if (progress.length > 0) {
    args.__progress = [...progress];
  }
  if (Array.isArray(progressDetails) && progressDetails.length > 0) {
    const alphaloopEvents = progressDetails
      .map((detail) => detail.type === "semantic.alphaloop" && detail.event && typeof detail.event === "object" ? detail.event : null)
      .filter((detail): detail is Record<string, unknown> => Boolean(detail));
    if (alphaloopEvents.length > 0) {
      args.__alphaloopEvents = alphaloopEvents;
    }
  }

  return args;
}

function canonicalToolResult(
  toolName: ToolTraceName,
  result: Record<string, unknown> | undefined,
  options: {
    ok: boolean;
    logLines?: string[];
  },
) {
  if (!result) {
    return { ok: options.ok };
  }

  const safe: Record<string, unknown> = {};
  const logLines = Array.isArray(options.logLines)
    ? options.logLines.filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    : [];
  if (logLines.length > 0) {
    safe.__logLines = logLines;
  }

  const countFields = [
    "workCount",
    "chunkCount",
    "bookCount",
    "artifactCount",
    "citationCount",
    "codexRunCount",
    "evidenceCount",
    "briefingLength",
    "exitCode",
  ] as const;
  for (const field of countFields) {
    const value = result[field];
    if (typeof value === "number") {
      safe[field] = value;
    }
  }
  if (typeof result.runtimeId === "string" && result.runtimeId.trim().length > 0) {
    safe.runtimeId = result.runtimeId.trim();
  }
  if (result.usedFallback === true) {
    safe.usedFallback = true;
  }
  if (typeof result.error === "string" && result.error.trim().length > 0) {
    safe.error = result.error.trim();
  }
  if (typeof result.briefing === "string" && result.briefing.trim().length > 0) {
    safe.briefing = result.briefing.trim();
  }
  if (Array.isArray(result.alphaloopEvents) && result.alphaloopEvents.length > 0) {
    safe.__alphaloopEvents = result.alphaloopEvents;
  }
  if (Array.isArray(result.works) && result.works.length > 0) {
    safe.workCount = typeof safe.workCount === "number" ? safe.workCount : result.works.length;
  }
  if (Array.isArray(result.chunks) && result.chunks.length > 0) {
    safe.chunkCount = typeof safe.chunkCount === "number" ? safe.chunkCount : result.chunks.length;
    if (toolName === "semantic_deep_search") {
      const rankedChunks = Array.isArray(result.rankedChunks) ? result.rankedChunks : [];
      if (rankedChunks.length > 0) {
        safe.rankedChunkCount = rankedChunks.length;
      }
      safe.chunks = result.chunks
        .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object")
        .map((chunk) => ({
          id: typeof chunk.id === "string" ? chunk.id : undefined,
          text:
            typeof chunk.text === "string"
              ? chunk.text
              : typeof chunk.excerpt === "string"
                ? chunk.excerpt
                : "",
          relevance:
            typeof chunk.relevance === "number"
              ? chunk.relevance
              : typeof chunk.score === "number"
                ? chunk.score
                : 0,
          rationale: typeof chunk.rationale === "string" ? chunk.rationale : undefined,
          metadata: {
            workId: typeof chunk.workId === "string" ? chunk.workId : undefined,
            chunkIndex: typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : undefined,
            r2Key: typeof chunk.r2Key === "string" ? chunk.r2Key : undefined,
          },
        }));
    }
  }
  if (Object.keys(safe).length === 0) {
    safe.ok = options.ok;
  }
  return safe;
}

function normalizeToolProgressText(toolName: ToolTraceName, text: string) {
  const sanitized = sanitizeUserFacingToolText(text)?.replace(/\s+/gu, " ").trim() ?? "";
  if (sanitized) {
    return sanitized;
  }
  const fallback = fallbackNormalizeToolLines([{
    toolName,
    key: "progress",
    value: text,
  }])[0];
  return typeof fallback === "string" && fallback.trim().length > 0 ? fallback.trim() : null;
}

function appendToolProgress(
  entry: LiveToolTraceEntry,
  nextText: string,
  detail?: Record<string, unknown>,
): LiveToolTraceEntry {
  const progress = entry.progress.includes(nextText) ? entry.progress : [...entry.progress, nextText];
  const progressDetails = detail
    ? [...(entry.progressDetails ?? []), structuredClone(detail)]
    : entry.progressDetails;
  return {
    ...entry,
    rationale: progress[progress.length - 1] ?? entry.rationale,
    progress,
    ...(progressDetails ? { progressDetails } : {}),
    args: canonicalToolArgs(
      entry.toolName,
      entry.sourceArgs,
      progress[progress.length - 1] ?? entry.rationale,
      progress,
      progressDetails,
    ),
  };
}

function cloneLiveToolTraceEntries(toolCalls: LiveToolTraceEntry[]): LiveToolTraceEntry[] {
  return toolCalls.map((entry) => ({
    ...entry,
    progress: [...entry.progress],
    ...(Array.isArray(entry.progressDetails)
      ? {
          progressDetails: entry.progressDetails.map((detail) => structuredClone(detail)),
        }
      : {}),
    sourceArgs: structuredClone(entry.sourceArgs),
    args: structuredClone(entry.args),
    result: entry.result ? structuredClone(entry.result) : undefined,
  }));
}

function readPersistedPlanToolTrace(metadata: Record<string, unknown> | null | undefined): LiveToolTraceEntry[] {
  const rawEntries = Array.isArray(metadata?.toolCalls) ? metadata.toolCalls : [];
  return rawEntries.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const rawToolName = typeof record.toolName === "string" ? record.toolName : null;
    if (!rawToolName) {
      return [];
    }
    const sourceArgs = record.sourceArgs && typeof record.sourceArgs === "object"
      ? structuredClone(record.sourceArgs as Record<string, unknown>)
      : {};
    const args = record.args && typeof record.args === "object" ? structuredClone(record.args as Record<string, unknown>) : {};
    const result = record.result && typeof record.result === "object"
      ? structuredClone(record.result as Record<string, unknown>)
      : undefined;
    const progress = Array.isArray(record.progress)
      ? record.progress.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const progressDetails = Array.isArray(record.progressDetails)
      ? record.progressDetails.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
        .map((value) => structuredClone(value))
      : [];
    const rawState = record.state;
    const state: LiveToolTraceEntry["state"] =
      rawState === "running" || rawState === "completed" || rawState === "error"
        ? rawState
        : result?.ok === false
          ? "error"
          : "completed";
    return [{
      id: typeof record.id === "string" && record.id.trim().length > 0 ? record.id : `${rawToolName}-${index}`,
      toolName: rawToolName as ToolTraceName,
      label: typeof record.label === "string" && record.label.trim().length > 0 ? record.label : labelForToolCall(rawToolName as ToolTraceName, args),
      rationale: typeof record.rationale === "string" && record.rationale.trim().length > 0 ? record.rationale : undefined,
      progress,
      ...(progressDetails.length > 0 ? { progressDetails } : {}),
      sourceArgs,
      args,
      ...(result ? { result } : {}),
      state,
      ...(typeof record.isError === "boolean" ? { isError: record.isError } : state === "error" ? { isError: true } : {}),
    }];
  });
}

function collectRuntimeIdsFromRunEvents(runEvents: RunEventRecord[]) {
  const runtimeIds = new Set<string>();
  for (const runEvent of runEvents) {
    if (typeof runEvent.runtimeId === "string" && runEvent.runtimeId.length > 0) {
      runtimeIds.add(runEvent.runtimeId);
    }
  }
  return runtimeIds;
}

function terminalRunStatusFromRunEvents(runEvents: RunEventRecord[]) {
  for (let index = runEvents.length - 1; index >= 0; index -= 1) {
    const runEvent = runEvents[index];
    if (runEvent.event !== "run.completed") {
      continue;
    }
    const status = runEvent.dataJson?.status;
    if (status === "completed" || status === "failed" || status === "timed_out") {
      return {
        status: status as "completed" | "failed" | "timed_out",
        completedAt: runEvent.createdAt,
      };
    }
  }
  return null;
}

function summarizeRunFailure(
  runEvents: RunEventRecord[],
  rawLog: Array<ToolRunRawLogEntry | Record<string, unknown>>,
) {
  for (let index = runEvents.length - 1; index >= 0; index -= 1) {
    const runEvent = runEvents[index];
    const data = runEvent.dataJson ?? {};
    const failedEvent =
      /(?:[._])failed$/u.test(runEvent.event)
      || (runEvent.event === "run.completed" && typeof data.status === "string" && data.status !== "completed")
      || (typeof data.status === "string" && data.status === "failed")
      || (typeof data.ok === "boolean" && data.ok === false);
    if (!failedEvent) {
      continue;
    }
    const message =
      typeof data.error === "string" && data.error.trim().length > 0
        ? data.error.trim()
        : typeof data.message === "string" && data.message.trim().length > 0
          ? data.message.trim()
          : null;
    return {
      source: "run_event" as const,
      event: runEvent.event,
      message,
      phase: runEvent.phase,
      status: runEvent.status,
      toolCallId: runEvent.toolCallId,
      runtimeId: runEvent.runtimeId,
      createdAt: runEvent.createdAt,
    };
  }

  for (let index = rawLog.length - 1; index >= 0; index -= 1) {
    const entry = rawLog[index];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const event = typeof entry.event === "string" ? entry.event : null;
    const payload = entry.payload && typeof entry.payload === "object"
      ? entry.payload as Record<string, unknown>
      : {};
    if (!event) {
      continue;
    }
    const failedEvent =
      /(?:[._])failed$/u.test(event)
      || (typeof payload.status === "string" && payload.status === "failed")
      || (typeof payload.ok === "boolean" && payload.ok === false);
    if (!failedEvent) {
      continue;
    }
    const message =
      typeof payload.error === "string" && payload.error.trim().length > 0
        ? payload.error.trim()
        : typeof payload.message === "string" && payload.message.trim().length > 0
          ? payload.message.trim()
          : null;
    return {
      source: "raw_log" as const,
      event,
      message,
      phase: typeof payload.phase === "string" ? payload.phase : null,
      status: typeof payload.status === "string" ? payload.status : null,
      toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : null,
      runtimeId: typeof payload.runtimeId === "string" ? payload.runtimeId : null,
      createdAt: typeof entry.timestamp === "string" ? entry.timestamp : null,
    };
  }

  return null;
}

function summarizeDetailedRunOutputLines(
  run: RunRecord,
  backgroundJob: BackgroundJobRecord | null,
  bridge: HermesBridgeRecord | null,
  runEvents: RunEventRecord[],
  rawLog: Array<ToolRunRawLogEntry | Record<string, unknown>>,
) {
  const lines: string[] = [];
  lines.push(`run_id=${run.id}`);
  lines.push(`status=${run.status}`);
  if (backgroundJob?.status) {
    lines.push(`background_job_status=${backgroundJob.status}`);
  }
  if (bridge) {
    if (bridge.externalJobId) lines.push(`externalJobId=${bridge.externalJobId}`);
    if (bridge.wrapperRunDir) lines.push(`wrapperRunDir=${bridge.wrapperRunDir}`);
    if (bridge.innerRunDir) lines.push(`innerRunDir=${bridge.innerRunDir}`);
    if (bridge.innerRunId) lines.push(`innerRunId=${bridge.innerRunId}`);
    if (bridge.archivePrefix) lines.push(`archivePrefix=${bridge.archivePrefix}`);
    if (bridge.hermesSessionId) lines.push(`hermesSessionId=${bridge.hermesSessionId}`);
  }

  const textLines: string[] = [];
  const seen = new Set<string>();
  for (const event of runEvents) {
    const data = event.dataJson && typeof event.dataJson === "object"
      ? event.dataJson as Record<string, unknown>
      : null;
    if (!data) {
      continue;
    }
    const text =
      event.event === "tool.progress" || event.event === "tool.progress.raw" || event.event === "job.log"
        ? (typeof data.text === "string" ? data.text.trim() : "")
        : "";
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    textLines.push(`${event.createdAt} ${text}`);
  }

  for (const entry of rawLog) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const payload = entry.payload && typeof entry.payload === "object"
      ? entry.payload as Record<string, unknown>
      : null;
    const text = payload && typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
    textLines.push(`${timestamp ? `${timestamp} ` : ""}${text}`);
  }

  if (textLines.length > 0) {
    lines.push("");
    lines.push(...textLines);
  }
  return lines.join("\n").trim();
}

function checkpointFromToolProgressDetail(detail: Record<string, unknown> | undefined) {
  if (!detail || typeof detail !== "object") {
    return null;
  }
  return {
    type: typeof detail.type === "string" ? detail.type : null,
    step: typeof detail.step === "string" ? detail.step : null,
    phase: typeof detail.phase === "string" ? detail.phase : null,
    note: typeof detail.note === "string" ? detail.note : null,
    event:
      detail.event && typeof detail.event === "object"
        ? structuredClone(detail.event as Record<string, unknown>)
        : null,
  };
}

async function appendRunErrorMessageOnce(
  deps: AppDeps,
  sessionId: string,
  runId: string,
  content: string,
  metadata: Record<string, unknown>,
) {
  const messages = await deps.store.listMessages(sessionId);
  const existing = [...messages].reverse().find((message) => (
    message.role === "assistant"
    && message.content === content
    && message.metadata?.runId === runId
    && message.metadata?.phase === "error"
  ));
  if (existing) {
    return existing;
  }
  return deps.store.appendMessage(sessionId, "assistant", content, metadata);
}

function describePlannerAction(
  toolName: ToolName,
  _rationale: string | undefined,
  userMessage: string,
) {
  const normalizedMessage = userMessage.trim();
  switch (toolName) {
    case "semantic_deep_search":
      return normalizedMessage
        ? `I’m running AlphaLoop for “${normalizedMessage}” and writing from the strongest passages it finds.`
        : "I’m running AlphaLoop now and writing from the strongest passages it finds.";
    case "estimate_research_scope":
      return normalizedMessage
        ? `I’m estimating how broad “${normalizedMessage}” is so I can choose the right time budget and search intensity.`
        : "I’m estimating the search breadth so I can choose the right time budget and search intensity.";
    case "search_works":
      return normalizedMessage
        ? `I’m going to search the corpus for “${normalizedMessage},” pull the strongest passages, and then run a deeper research pass if the quick evidence is thin.`
        : "I’m going to search the corpus, pull the strongest passages, and then run a deeper research pass if the quick evidence is thin.";
    case "get_relevant_chunks":
      return normalizedMessage
        ? `I found some likely matches for “${normalizedMessage}.” Now I’m pulling the strongest passages before I write the answer.`
        : "I found some likely matches. Now I’m pulling the strongest passages before I write the answer.";
    case "classify_candidate_chunks":
      return normalizedMessage
        ? `I’ve got a broad passage pool for “${normalizedMessage}.” Now I’m filtering it down to the passages that are actually relevant.`
        : "I’ve got a broad passage pool. Now I’m filtering it down to the passages that are actually relevant.";
    case "get_work_metadata":
      return "I found a few likely books. Let me pull in their context before I go further.";
    case "get_work_text":
      return "I’m opening the source text directly so I can check the wording.";
    case "create_workspace":
      return "I’m starting the deeper research pass now so it can search broadly while I keep narrowing the evidence.";
    case "run_workspace_task":
      return "I’m running the deeper search now and gathering the strongest evidence.";
    case "read_workspace_file":
      return "The search finished, and I’m pulling the results back into the chat.";
    case "destroy_workspace":
      return "I’m cleaning up the workspace.";
    default:
      return "I’m working through this now and I’ll bring back the strongest results.";
  }
}

function initialAssistantPlan(userMessage: string) {
  const normalizedMessage = userMessage.trim();
  return normalizedMessage
    ? `I’m going to search broadly for “${normalizedMessage},” pull the strongest passages, and bring back a quoted briefing.`
    : "I’m going to search broadly, pull the strongest passages, and bring back a quoted briefing.";
}

function initialSemanticAssistantPlan(userMessage: string) {
  const normalizedMessage = userMessage.trim();
  return normalizedMessage
    ? `I’m running AlphaLoop for “${normalizedMessage}” and will answer from the strongest passages it finds.`
    : "I’m running AlphaLoop now and will answer from the strongest passages it finds.";
}

function fallbackExperimentProposalFromAnswer(answer: string, userMessage: string) {
  const normalizedAnswer = answer.trim() || "Experiment proposal ready for approval.";
  const normalizedRequest = userMessage.trim() || normalizedAnswer;
  return {
    title: "Experiment Proposal",
    summary: normalizedAnswer,
    approvalPrompt: `I approve this experiment plan. Build the scripts, run the labels and aggregation, and produce the paper draft and charts.\n\nApproved experiment request:\n${normalizedRequest}\n\nApproved plan:\n${normalizedAnswer}`,
  };
}

function initialWorkflowPlan(intent: {
  workflow: "search" | "design_experiment";
  routedQuery: string;
  executionMode?: "semantic" | "comprehensive" | "agentic";
}) {
  const normalizedMessage = intent.routedQuery.trim();
  if (intent.workflow === "design_experiment") {
    return normalizedMessage
      ? `I’ve locked the experiment design. I’m setting up the run for “${normalizedMessage},” then I’ll write the analysis scripts, execute them, and bring back the paper draft and artifacts.`
      : "I’ve locked the experiment design. I’m setting up the run, then I’ll write the analysis scripts, execute them, and bring back the paper draft and artifacts.";
  }
  if (intent.executionMode === "comprehensive") {
    return normalizedMessage
      ? `I’ve selected Search for “${normalizedMessage}.” I’m going broad, pulling the strongest passages, and building a grounded briefing.`
      : "I’ve selected Search. I’m going broad, pulling the strongest passages, and building a grounded briefing.";
  }
  if (intent.executionMode === "agentic") {
    return normalizedMessage
      ? `I’ve selected Agentic search for “${normalizedMessage}.” I’m starting with the agentic evidence pass and will expand from there.`
      : "I’ve selected Agentic search. I’m starting with the agentic evidence pass and will expand from there.";
  }
  return normalizedMessage
    ? `I’ve selected Search for “${normalizedMessage}.” I’m starting with the fast evidence pass and will widen if the query needs more depth.`
    : "I’ve selected Search. I’m starting with the fast evidence pass and will widen if the query needs more depth.";
}

function isTextArtifact(filename: string, mimeType: string) {
  return mimeType.startsWith("text/") || mimeType.includes("json") || /\.(md|txt|json|log)$/iu.test(filename);
}

async function trackRuntimeBillingEvents(
  deps: AppDeps,
  session: { userId: string; id: string },
  run: { id: string },
  billingEvents: unknown,
) {
  if (!Array.isArray(billingEvents)) {
    return;
  }
  for (const event of billingEvents) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const usage = event as Record<string, unknown>;
    if (typeof usage.provider !== "string" || typeof usage.model !== "string" || typeof usage.operation !== "string") {
      continue;
    }
    await deps.billing.track(
      {
        userId: session.userId,
        sessionId: session.id,
        runId: run.id,
        source: "runtime-proxy",
      },
      {
        provider: usage.provider,
        model: usage.model,
        operation: usage.operation,
        inputTokens: Number(usage.inputTokens ?? 0),
        outputTokens: Number(usage.outputTokens ?? 0),
        totalTokens: Number(usage.totalTokens ?? 0),
        cachedInputTokens: Number(usage.cachedInputTokens ?? 0),
        requestId: typeof usage.requestId === "string" ? usage.requestId : null,
        metadata: usage.metadata && typeof usage.metadata === "object"
          ? usage.metadata as Record<string, unknown>
          : {},
        createdAt: typeof usage.createdAt === "string" ? usage.createdAt : undefined,
      },
    );
  }
}

async function resolveRunRuntimeContext(
  deps: AppDeps,
  sessionId: string,
  run: RunRecord,
  _toolCalls: Awaited<ReturnType<AppStore["listToolCalls"]>>,
  options: {
    runEventLimit?: number | null;
  } = {},
) {
  const runEventLimit = typeof options.runEventLimit === "number" && options.runEventLimit >= 0
    ? Math.floor(options.runEventLimit)
    : null;
  const [runtimeInstances, runEvents, researchTasks] = await Promise.all([
    deps.store.listRuntimeInstances(sessionId),
    runEventLimit === 0
      ? Promise.resolve([])
      : runEventLimit === null
        ? deps.store.listRunEvents(run.id)
        : deps.store.listRecentRunEvents(run.id, runEventLimit),
    deps.store.listResearchTasksForRun(run.id),
  ]);
  const runtimeIds = collectRuntimeIdsFromRunEvents(runEvents);
  const relatedRuntimeInstances = runtimeInstances.filter((instance) => runtimeIds.has(instance.runtimeId));
  for (const runtime of relatedRuntimeInstances) {
    runtimeIds.add(runtime.runtimeId);
  }
  return {
    runEvents,
    runtimeIds: Array.from(runtimeIds),
    runtimeInstances: relatedRuntimeInstances,
    researchTasks,
  };
}

function artifactRunId(artifact: RunArtifactLike) {
  return typeof artifact.metadata?.runId === "string" && artifact.metadata.runId.trim().length > 0
    ? artifact.metadata.runId
    : null;
}

function artifactBelongsToRun(artifact: RunArtifactLike, runId: string, runtimeIdSet: Set<string>) {
  if (typeof artifact.runtimeId !== "string" || artifact.runtimeId.length === 0) {
    return artifactRunId(artifact) === runId;
  }
  return runtimeIdSet.has(artifact.runtimeId);
}

function hasUserFacingHermesArtifacts(artifacts: RunArtifactLike[]) {
  return artifacts.some((artifact) => isUserFacingHermesArtifact(artifact.filename));
}

async function loadSupplementalHermesRunArtifacts(
  deps: AppDeps,
  sessionId: string,
  runId: string,
) {
  const backgroundJob = await deps.store.getLatestBackgroundJobForRun(runId);
  if (!backgroundJob || backgroundJob.provider !== "hermes") {
    return [];
  }
  const externalJobId =
    typeof backgroundJob.externalJobId === "string" && backgroundJob.externalJobId.trim().length > 0
      ? backgroundJob.externalJobId.trim()
      : null;
  const archivePrefix =
    typeof backgroundJob.metadata?.archivePrefix === "string" && backgroundJob.metadata.archivePrefix.trim().length > 0
      ? backgroundJob.metadata.archivePrefix.trim()
      : null;
  if (archivePrefix) {
    const manifestText = await deps.blobStore.getText(`${archivePrefix}/archive-manifest.json`).catch(() => null);
    const manifest = parseHermesArchiveManifest(manifestText);
    if (manifest?.files?.length) {
      const synthesized = manifest.files
        .filter((file) => isUserFacingHermesArtifact(file.relativePath))
        .map((file) => {
          const relativePath = normalizeHermesArtifactFilename(file.relativePath);
          const mimeType =
            typeof file.mimeType === "string" && file.mimeType.trim().length > 0
              ? file.mimeType
              : defaultMimeTypeForHermesArtifact(relativePath);
          return {
            id: `synthetic:${file.r2Key}`,
            sessionId,
            runtimeId: null,
            r2Key: file.r2Key,
            blobRef: file.r2Key,
            filename: relativePath,
            mimeType,
            byteSize: typeof file.byteSize === "number" ? file.byteSize : null,
            summaryText: titleForHermesArtifact(relativePath),
            metadata: {
              kind: kindForHermesArtifact(relativePath),
              title: titleForHermesArtifact(relativePath),
              runId,
              hermesJobId: backgroundJob.externalJobId,
              relativePath,
              sourcePath: typeof file.sourcePath === "string" ? file.sourcePath : null,
              archivePrefix,
              previewable: isTextArtifact(relativePath, mimeType),
              synthesizedFromArchiveManifest: true,
            },
            createdAt: typeof file.uploadedAt === "string" ? file.uploadedAt : null,
          } satisfies RunArtifactLike;
        });
      if (synthesized.length > 0) {
        return synthesized;
      }
    }
  }
  if (!externalJobId || !deps.hermesJobApiUrl) {
    return [];
  }
  const remote = await fetchHermesJob(deps.hermesJobApiUrl, deps.hermesJobApiToken, externalJobId).catch(() => null);
  const remoteArtifacts = Array.isArray(remote?.job?.artifacts) ? remote.job.artifacts : [];
  const userFacingRemote = remoteArtifacts
    .map((entry) => {
      const name = typeof entry.name === "string" ? normalizeHermesArtifactFilename(entry.name) : "";
      const relativePath = name.startsWith("inner/") ? name : `inner/${name}`;
      return {
        entry,
        relativePath,
      };
    })
    .filter(({ relativePath }) => isUserFacingHermesArtifact(relativePath));
  const hydrated = await Promise.all(userFacingRemote.map(async ({ entry, relativePath }) => {
    const artifactName = typeof entry.name === "string" ? entry.name : "";
    const content = artifactName
      ? await fetchHermesArtifact(
        deps.hermesJobApiUrl!,
        deps.hermesJobApiToken,
        externalJobId,
        artifactName,
      ).then((response) => response.artifact.content).catch(() => null)
      : null;
    const mimeType = defaultMimeTypeForHermesArtifact(relativePath);
    return {
      id: `remote:${externalJobId}:${relativePath}`,
      sessionId,
      runtimeId: null,
      r2Key: `remote:${externalJobId}:${relativePath}`,
      blobRef: null,
      filename: relativePath,
      mimeType,
      byteSize: typeof entry.bytes === "number" ? entry.bytes : null,
      summaryText: titleForHermesArtifact(relativePath),
      metadata: {
        kind: kindForHermesArtifact(relativePath),
        title: titleForHermesArtifact(relativePath),
        runId,
        hermesJobId: externalJobId,
        relativePath,
        sourcePath: typeof entry.path === "string" ? entry.path : null,
        archivePrefix,
        previewable: true,
        synthesizedFromHermesJobApi: true,
      },
      createdAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
      content,
    } satisfies RunArtifactLike;
  }));
  return hydrated;
}

const INLINE_ARTIFACT_PREVIEW_MAX_BYTES = 96_000;

function shouldInlineArtifactContent(artifact: RunArtifactLike) {
  if (!isTextArtifact(artifact.filename, artifact.mimeType)) {
    return false;
  }
  if (typeof artifact.byteSize === "number" && artifact.byteSize > INLINE_ARTIFACT_PREVIEW_MAX_BYTES) {
    return false;
  }
  return true;
}

async function loadRunArtifacts(
  deps: AppDeps,
  sessionId: string,
  runId: string,
  runtimeIds: string[],
) {
  const runtimeIdSet = new Set(runtimeIds);
  const artifacts = await deps.store.listArtifacts(sessionId);
  const filtered = artifacts.filter((artifact) => artifactBelongsToRun(artifact, runId, runtimeIdSet));
  const supplemental = hasUserFacingHermesArtifacts(filtered)
    ? []
    : await loadSupplementalHermesRunArtifacts(deps, sessionId, runId);
  const effective = supplemental.length > 0 ? supplemental : filtered;
  const hydrated = await Promise.all(
    effective.map(async (artifact) => ({
      ...artifact,
      content: "content" in artifact && typeof artifact.content === "string"
        ? artifact.content
        : shouldInlineArtifactContent(artifact)
        ? await deps.blobStore.getText(artifact.r2Key).catch(() => null)
        : null,
    })),
  );
  return synthesizeReferenceArtifacts(hydrated);
}

async function loadRunArtifactSummaries(
  deps: AppDeps,
  sessionId: string,
  runId: string,
  runtimeIds: string[],
) {
  const runtimeIdSet = new Set(runtimeIds);
  const artifacts = await deps.store.listArtifacts(sessionId);
  const filtered = artifacts.filter((artifact) => artifactBelongsToRun(artifact, runId, runtimeIdSet));
  if (hasUserFacingHermesArtifacts(filtered)) {
    return filtered;
  }
  const supplemental = await loadSupplementalHermesRunArtifacts(deps, sessionId, runId);
  return supplemental.length > 0 ? supplemental : filtered;
}

async function loadRunDocumentArtifacts(
  deps: AppDeps,
  sessionId: string,
  runId: string,
  runtimeIds: string[],
) {
  return loadRunArtifacts(deps, sessionId, runId, runtimeIds);
}

function queryFlag(value: string | undefined, defaultValue = false): boolean {
  if (value == null) {
    return defaultValue;
  }
  return /^(?:1|true|yes|on)$/iu.test(value.trim());
}

function summarizeRuntimeInstances(runtimeInstances: RuntimeInstanceRecord[]) {
  return runtimeInstances.map((instance) => ({
    id: instance.id,
    sessionId: instance.sessionId,
    runtimeId: instance.runtimeId,
    provider: instance.provider,
    providerMachineId: instance.providerMachineId,
    status: instance.status,
    lastUsedAt: instance.lastUsedAt,
    expiresAt: instance.expiresAt,
    createdAt: instance.createdAt,
  }));
}

async function buildRunLogsPayload(
  c: Context,
  deps: AppDeps,
  session: SessionRecord,
  run: RunRecord,
  toolCalls: ToolCallRecord[],
  options: {
    owner?: Awaited<ReturnType<AppStore["getUserProfile"]>> | null;
    requestedBy?: { id: string; email: string | null; name: string | null };
  } = {},
) {
  const includeArtifacts = queryFlag(c.req.query("includeArtifacts"), false);
  const includeArtifactContents = queryFlag(c.req.query("includeArtifactContents"), false);
  const includeRuntimeInstances = queryFlag(c.req.query("includeRuntimeInstances"), false);
  const includeLiveRuntime = queryFlag(c.req.query("includeLiveRuntime"), false);

  const [messages, runContext] = await Promise.all([
    deps.store.listMessages(session.id),
    resolveRunRuntimeContext(deps, session.id, run, toolCalls),
  ]);
  const backgroundJob = await deps.store.getLatestBackgroundJobForRun(run.id);
  const bridge = await resolveHermesBridgeRecord(deps, backgroundJob);

  const artifacts = includeArtifacts
    ? (includeArtifactContents
      ? await loadRunArtifacts(deps, session.id, run.id, runContext.runtimeIds)
      : await loadRunArtifactSummaries(deps, session.id, run.id, runContext.runtimeIds))
    : [];
  const persistedRawLog = await loadPersistedRawRunLog(deps, session.id, run.id);
  const rawLog = persistedRawLog;
  const metrics = extractRecordedRunMetrics(rawLog);
  const failureSummary = summarizeRunFailure(runContext.runEvents, rawLog);
  const liveRuntime = includeLiveRuntime
    ? await loadLiveRuntimeLogs(deps, session.id, run.id, runContext.runtimeIds)
    : [];

  return {
    ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
    ...(options.owner ? { owner: options.owner } : {}),
    session,
    run,
    backgroundJob,
    bridge,
    messages,
    toolCalls,
    runEvents: runContext.runEvents,
    rawLog,
    ...(failureSummary ? { failureSummary } : {}),
    metrics,
    runtimeIds: runContext.runtimeIds,
    runtimeCount: runContext.runtimeInstances.length,
    researchTaskCount: runContext.researchTasks.length,
    artifactCount: includeArtifacts ? artifacts.length : (await loadRunArtifactSummaries(deps, session.id, run.id, runContext.runtimeIds)).length,
    researchTasks: runContext.researchTasks,
    ...(includeRuntimeInstances ? { runtimeInstances: runContext.runtimeInstances } : { runtimeInstances: summarizeRuntimeInstances(runContext.runtimeInstances) }),
    ...(includeArtifacts ? { artifacts } : {}),
    ...(includeLiveRuntime ? { liveRuntime } : {}),
  };
}

function parseHermesBridgeRecord(
  input: Record<string, unknown> | null | undefined,
  externalJobIdFallback?: string | null,
): HermesBridgeRecord | null {
  if (!input) {
    return externalJobIdFallback
      ? {
          externalJobId: externalJobIdFallback,
          wrapperRunDir: null,
          innerRunDir: null,
          innerRunId: null,
          archivePrefix: null,
          hermesSessionId: null,
        }
      : null;
  }
  const externalJobId = typeof input.externalJobId === "string" && input.externalJobId.trim().length > 0
    ? input.externalJobId.trim()
    : (externalJobIdFallback?.trim() ?? "");
  if (!externalJobId) {
    return null;
  }
  const readNullable = (value: unknown) => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  return {
    externalJobId,
    wrapperRunDir: readNullable(input.wrapperRunDir),
    innerRunDir: readNullable(input.innerRunDir),
    innerRunId: readNullable(input.innerRunId),
    archivePrefix: readNullable(input.archivePrefix),
    hermesSessionId: readNullable(input.hermesSessionId),
  };
}

function hermesBridgeNeedsHydration(bridge: HermesBridgeRecord | null) {
  return !bridge
    || !bridge.wrapperRunDir
    || !bridge.innerRunDir
    || !bridge.archivePrefix
    || !bridge.hermesSessionId;
}

async function resolveHermesBridgeRecord(
  deps: AppDeps,
  backgroundJob: BackgroundJobRecord | null,
): Promise<HermesBridgeRecord | null> {
  if (!backgroundJob || backgroundJob.provider !== "hermes") {
    return null;
  }
  const existing = parseHermesBridgeRecord(backgroundJob.metadata, backgroundJob.externalJobId);
  if (!hermesBridgeNeedsHydration(existing) || !deps.hermesJobApiUrl) {
    return existing;
  }
  try {
    const { job } = await fetchHermesJob(deps.hermesJobApiUrl, deps.hermesJobApiToken, backgroundJob.externalJobId);
    const hydrated = buildHermesBridgeRecord(job);
    await deps.store.updateBackgroundJob(backgroundJob.id, {
      metadata: {
        ...backgroundJob.metadata,
        ...hydrated,
      },
    });
    return hydrated;
  } catch {
    return existing;
  }
}

async function buildSessionBridgePayload(
  deps: AppDeps,
  session: SessionRecord,
) {
  const runs = await deps.store.listRuns(session.id);
  const bridges = await Promise.all(
    runs.map(async (run) => {
      const [toolCalls, backgroundJob] = await Promise.all([
        deps.store.listToolCalls(run.id),
        deps.store.getLatestBackgroundJobForRun(run.id),
      ]);
      const runContext = await resolveRunRuntimeContext(deps, session.id, run, toolCalls);
      const artifactSummaries = await loadRunArtifactSummaries(deps, session.id, run.id, runContext.runtimeIds);
      const documentArtifacts = await loadRunDocumentArtifacts(deps, session.id, run.id, runContext.runtimeIds);
      const bridge = await resolveHermesBridgeRecord(deps, backgroundJob);
      return {
        run,
        backgroundJob,
        bridge,
        artifactCount: artifactSummaries.length,
        artifacts: artifactSummaries,
        documents: documentArtifacts,
      };
    }),
  );
  return {
    session,
    runs: bridges,
  };
}

function isAdminUser(user: Awaited<ReturnType<AppStore["getUserProfile"]>>, allowedEmail?: string) {
  if (!allowedEmail || !user?.email) {
    return false;
  }
  return user.email.trim().toLowerCase() === allowedEmail.trim().toLowerCase();
}

function toolStatusToNotificationType(status: string): NotificationType {
  if (status === "failed") {
    return "tool_failed";
  }
  if (status === "timed_out") {
    return "tool_timed_out";
  }
  return "tool_completed";
}

function runStatusToNotificationType(status: string): NotificationType {
  if (status === "failed") {
    return "run_failed";
  }
  if (status === "timed_out") {
    return "run_timed_out";
  }
  return "run_completed";
}

function describeRunTarget(session: SessionRecord, sessionTitle?: string | null) {
  const title = sessionTitle?.trim();
  return title ? `"${title}"` : "your research thread";
}

function buildToolNotification(input: {
  session: SessionRecord;
  sessionTitle?: string | null;
  runId: string;
  toolCallId: string;
  toolName: ToolName;
  label?: string | null;
  status: "started" | "completed" | "failed" | "timed_out";
}): Omit<NotificationRecord, "id" | "metadata" | "readAt" | "emailedAt" | "createdAt"> & {
  dedupeKey: string;
  metadata: Record<string, unknown>;
} {
  const label = input.label?.trim() || getToolLabel(input.toolName);
  const target = describeRunTarget(input.session, input.sessionTitle);
  const type =
    input.status === "started"
      ? "tool_started"
      : toolStatusToNotificationType(input.status);
  const title =
    input.status === "started"
      ? "Research step started"
      : input.status === "failed"
        ? "Research step failed"
        : input.status === "timed_out"
          ? "Research step timed out"
          : "Research step completed";
  const body =
    input.status === "started"
      ? `${label} started for ${target}.`
      : input.status === "failed"
        ? `${label} failed while working on ${target}.`
        : input.status === "timed_out"
          ? `${label} timed out while working on ${target}.`
          : `${label} finished for ${target}.`;
  return {
    userId: input.session.userId,
    sessionId: input.session.id,
    runId: input.runId,
    toolCallId: input.toolCallId,
    type,
    title,
    body,
    dedupeKey:
      input.status === "started"
        ? `tool-start:${input.toolCallId}`
        : `tool-end:${input.toolCallId}:${input.status}`,
    metadata: {
      toolName: input.toolName,
      label,
      status: input.status,
    },
  };
}

function buildRunNotification(input: {
  session: SessionRecord;
  sessionTitle?: string | null;
  runId: string;
  status: "completed" | "failed" | "timed_out";
  completionMode?: string | null;
}): Omit<NotificationRecord, "id" | "metadata" | "readAt" | "emailedAt" | "createdAt"> & {
  dedupeKey: string;
  metadata: Record<string, unknown>;
} {
  const target = describeRunTarget(input.session, input.sessionTitle);
  const type = runStatusToNotificationType(input.status);
  const title =
    input.status === "completed"
      ? "Research complete"
      : input.status === "failed"
        ? "Research failed"
        : "Research timed out";
  const body =
    input.status === "completed"
      ? `Your research run for ${target} is ready.`
      : input.status === "failed"
        ? `Your research run for ${target} ended with an error.`
        : `Your research run for ${target} timed out before it finished.`;
  return {
    userId: input.session.userId,
    sessionId: input.session.id,
    runId: input.runId,
    toolCallId: null,
    type,
    title,
    body,
    dedupeKey: `run-end:${input.runId}:${input.status}`,
    metadata: {
      status: input.status,
      completionMode: input.completionMode ?? null,
    },
  };
}

function terminalRunStateUpdate(status: "completed" | "failed" | "timed_out", completedAt = new Date().toISOString()) {
  return {
    status,
    completedAt,
    activeToolCallId: null,
  } satisfies Partial<Pick<RunRecord, "status" | "completedAt" | "activeToolCallId">>;
}

function backgroundJobIsTerminal(status: BackgroundJobRecord["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function backgroundJobIsActive(status: BackgroundJobRecord["status"]) {
  return status === "queued" || status === "starting" || status === "running";
}

function backgroundJobStatusFromHermesJob(job: HermesJobSummary): BackgroundJobRecord["status"] {
  if (job.state === "completed" && (job.exitCode == null || job.exitCode === 0)) {
    return "completed";
  }
  if (job.state === "cancelled" || job.state === "cancelling") {
    return "cancelled";
  }
  if (job.state === "failed" || (job.finishedAt && job.exitCode != null && job.exitCode !== 0)) {
    return "failed";
  }
  if (job.state === "launching") {
    return "starting";
  }
  return "running";
}

async function writeTerminalRunState(
  deps: AppDeps,
  runId: string,
  status: "completed" | "failed" | "timed_out",
) {
  await deps.store.updateRun(runId, terminalRunStateUpdate(status));
}

async function appendRunLifecycleEvent(
  deps: AppDeps,
  run: Pick<RunRecord, "id" | "sessionId">,
  event: string,
  data: Record<string, unknown>,
) {
  await deps.store.appendRunEvent(run.id, run.sessionId, event, data);
}

async function sendRunCompletionEmail(
  deps: AppDeps,
  input: {
    email: string;
    runId: string;
    session: SessionRecord;
    sessionTitle?: string | null;
    status: "completed" | "failed" | "timed_out";
  },
): Promise<{ emailedAt?: string; metadata: Record<string, unknown> }> {
  if (!deps.resendApiKey || !deps.resendFromEmail) {
    return {
      metadata: {
        emailStatus: "skipped",
        emailReason: "resend_not_configured",
      },
    };
  }

  const target = describeRunTarget(input.session, input.sessionTitle);
  const subject =
    input.status === "completed"
      ? `${productName(deps)} research complete: ${input.sessionTitle?.trim() || "your thread"}`
      : input.status === "failed"
        ? `${productName(deps)} research failed: ${input.sessionTitle?.trim() || "your thread"}`
        : `${productName(deps)} research timed out: ${input.sessionTitle?.trim() || "your thread"}`;
  const text =
    input.status === "completed"
      ? `Your ${productName(deps)} research run for ${target} has completed.\n\nRun ID: ${input.runId}\n\nOpen ${productName(deps)} to review the result.`
      : input.status === "failed"
        ? `Your ${productName(deps)} research run for ${target} failed.\n\nRun ID: ${input.runId}\n\nOpen ${productName(deps)} to inspect the session and retry if needed.`
        : `Your ${productName(deps)} research run for ${target} timed out.\n\nRun ID: ${input.runId}\n\nOpen ${productName(deps)} to inspect the session and retry if needed.`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.resendApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: deps.resendFromEmail,
      to: [input.email],
      subject,
      text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend email failed: ${response.status} ${errorText}`.trim());
  }

  const emailedAt = new Date().toISOString();
  return {
    emailedAt,
    metadata: {
      emailStatus: "sent",
    },
  };
}

type RunArtifactLike = {
  filename: string;
  mimeType: string;
  byteSize?: number | null;
  metadata?: Record<string, unknown> | null;
  content?: string | null;
  createdAt?: string | null;
  id?: string;
  sessionId?: string;
  runtimeId?: string | null;
  r2Key?: string;
  blobRef?: string | null;
  summaryText?: string | null;
};

function synthesizeReferenceArtifacts(artifacts: RunArtifactLike[]) {
  const hasReferenceMarkdown = artifacts.some((artifact) => artifact.filename === "every-single-reference.md");
  if (hasReferenceMarkdown) {
    return artifacts;
  }

  const viewedChunks = artifacts.find((artifact) => artifact.filename === "viewed-chunks.json");
  if (!viewedChunks || typeof viewedChunks.content !== "string") {
    return artifacts;
  }

  const synthesized = renderReferenceMarkdownFromViewedChunks(viewedChunks.content);
  if (!synthesized) {
    return artifacts;
  }

  return [{
    id: viewedChunks.id ? `${viewedChunks.id}:synthetic-reference` : undefined,
    runtimeId: viewedChunks.runtimeId ?? null,
    r2Key: viewedChunks.r2Key,
    filename: "every-single-reference.md",
    mimeType: "text/markdown",
    metadata: {
      ...(viewedChunks.metadata ?? {}),
      kind: "reference_file",
      title: "Every Single Reference",
      synthesized: true,
      sourceFilename: viewedChunks.filename,
    },
    createdAt: viewedChunks.createdAt ?? null,
    content: synthesized,
  }, ...artifacts];
}

function renderReferenceMarkdownFromViewedChunks(raw: string) {
  try {
    const parsed = JSON.parse(raw) as {
      generatedAt?: unknown;
      chunks?: Array<Record<string, unknown>>;
    };
    const chunks = Array.isArray(parsed.chunks) ? parsed.chunks : [];
    if (chunks.length === 0) {
      return null;
    }
    return [
      "# Every Single Reference",
      "",
      typeof parsed.generatedAt === "string" ? `Generated: ${parsed.generatedAt}` : null,
      ...chunks.flatMap((chunk) => {
        const title = typeof chunk.workTitle === "string" && chunk.workTitle.trim()
          ? chunk.workTitle
          : typeof chunk.workId === "string"
            ? chunk.workId
            : "Unknown work";
        const workId = typeof chunk.workId === "string" ? chunk.workId : "unknown";
        const chunkId = typeof chunk.chunkId === "string" ? chunk.chunkId : "unknown";
        const chunkIndex = typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : chunk.chunkIndex;
        const authors = Array.isArray(chunk.authors)
          ? chunk.authors.filter((author): author is string => typeof author === "string" && author.trim().length > 0)
          : [];
        const viewedIn = Array.isArray(chunk.viewedIn)
          ? chunk.viewedIn.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          : [];
        const excerpt = typeof chunk.excerpt === "string" ? chunk.excerpt.trim() : "";
        return [
          `## ${title}`,
          "",
          `- Work ID: ${workId}`,
          `- Chunk: ${chunkId}${chunkIndex !== undefined && chunkIndex !== null ? `#${String(chunkIndex)}` : ""}`,
          ...(authors.length > 0 ? [`- Authors: ${authors.join(", ")}`] : []),
          ...(viewedIn.length > 0 ? [`- Seen in: ${viewedIn.join(", ")}`] : []),
          ...(excerpt ? ["", `> ${excerpt}`] : []),
          "",
        ];
      }),
    ].filter((line): line is string => typeof line === "string").join("\n");
  } catch {
    return null;
  }
}

function parseRawRunLogEntries(artifacts: RunArtifactLike[]) {
  const rawArtifact = artifacts.find((artifact) =>
    artifact.metadata?.kind === "tool_stream_raw" && typeof artifact.content === "string",
  );
  if (!rawArtifact || typeof rawArtifact.content !== "string") {
    return [];
  }
  return rawArtifact.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

async function loadPersistedRawRunLog(
  deps: AppDeps,
  sessionId: string,
  runId: string,
) {
  const artifacts = await deps.store.listArtifacts(sessionId);
  const rawArtifact = artifacts.find((artifact) =>
    artifact.metadata?.kind === "tool_stream_raw"
    && artifact.metadata?.runId === runId,
  );
  if (!rawArtifact) {
    return [];
  }
  let content: string | null = null;
  try {
    content = await deps.blobStore.getText(rawArtifact.r2Key);
  } catch {
    return [];
  }
  if (!content) {
    return [];
  }
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

async function loadPersistedResearchDocumentHtml(
  deps: AppDeps,
  sessionId: string,
  runId: string,
) {
  const artifacts = await deps.store.listArtifacts(sessionId);
  const researchDocument = [...artifacts]
    .filter((artifact) => artifact.metadata?.kind === "research_document" && artifact.metadata?.runId === runId)
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))[0];
  if (!researchDocument) {
    return null;
  }
  try {
    const content = await deps.blobStore.getText(researchDocument.r2Key);
    return typeof content === "string" && content.trim().length > 0 ? content : null;
  } catch {
    return null;
  }
}

async function listPersistedRunRuntimeIds(
  deps: AppDeps,
  sessionId: string,
  runId: string,
) {
  const run = await deps.store.getRun(runId);
  if (!run || run.sessionId !== sessionId) {
    return [];
  }
  const { runtimeIds } = await resolveRunRuntimeContext(deps, sessionId, run, []);
  return runtimeIds;
}

function addRuntimeIds(runtimeIds: Set<string>, ...payloads: Array<Record<string, unknown> | undefined>) {
  for (const payload of payloads) {
    if (typeof payload?.runtimeId === "string" && payload.runtimeId.length > 0) {
      runtimeIds.add(payload.runtimeId);
    }
  }
}

async function destroyTrackedRuntimes(
  deps: AppDeps,
  context: { sessionId: string; runId: string },
  runtimeIds: Iterable<string>,
) {
  for (const runtimeId of runtimeIds) {
    try {
      await deps.runtimeGateway.destroyWorkspace({
        runtimeId,
        sessionId: context.sessionId,
        runId: context.runId,
      });
    } catch {
      // Leave the runtime record intact so a later janitor pass can retry it.
    }
  }
}

export async function reapExpiredRuntimeInstances(
  deps: AppDeps,
  context: { runId: string },
  limit = 25,
) {
  const expiredRuntimes = await deps.store.listExpiredRuntimeInstances(limit);
  for (const runtime of expiredRuntimes) {
    try {
      await deps.runtimeGateway.destroyWorkspace({
        runtimeId: runtime.runtimeId,
        sessionId: runtime.sessionId,
        runId: context.runId,
      });
    } catch {
      // Best-effort janitor; another run can retry this runtime later.
    }
  }
}

export async function reapStaleRuns(
  deps: AppDeps,
  _context: { runId: string },
  limit = 100,
) {
  const allRuns = await deps.store.listAllRuns();
  const staleRuns = allRuns
    .filter((run) => run.status === "running" || run.status === "queued")
    .slice(0, limit);
  for (const run of staleRuns) {
    const runRecord = await deps.store.getRun(run.id);
    if (!runRecord) {
      continue;
    }
    const backgroundJob = await deps.store.getLatestBackgroundJobForRun(run.id);
    if (backgroundJob && backgroundJob.provider === "hermes" && backgroundJobIsActive(backgroundJob.status)) {
      const session = await deps.store.getSession(runRecord.sessionId);
      if (!session) {
        continue;
      }
      try {
        await syncHermesBackgroundJob(deps, undefined, { session, run: runRecord });
      } catch {
        // Best-effort sync for active delegated jobs.
      }
    }
  }
}

function shouldReadLiveRuntimeFile(path: string) {
  if (path === "context/manifest.json" || path === "context/task.json" || path === "context/selected-chunks.json") {
    return true;
  }
  if (!path.startsWith("output/")) {
    return false;
  }
  return /\.(?:md|txt|json|jsonl|log)$/iu.test(path);
}

async function loadLiveRuntimeLogs(
  deps: AppDeps,
  sessionId: string,
  runId: string,
  runtimeIds: string[],
) {
  if (!deps.runtimeGateway.listWorkspaceFiles) {
    return [];
  }
  return Promise.all(
    runtimeIds.map(async (runtimeId) => {
      try {
        const listing = await deps.runtimeGateway.listWorkspaceFiles!({
          runtimeId,
          sessionId,
          runId,
        });
        const filePaths = Array.isArray(listing.files)
          ? listing.files.filter((value): value is string => typeof value === "string")
          : [];
        const interestingFiles = filePaths.filter(shouldReadLiveRuntimeFile);
        const files = await Promise.all(
          interestingFiles.map(async (path) => {
            try {
              const file = await deps.runtimeGateway.readWorkspaceFile({
                runtimeId,
                path,
                sessionId,
                runId,
              });
              return {
                path,
                size: typeof file.size === "number" ? file.size : undefined,
                content: typeof file.content === "string" ? file.content : "",
              };
            } catch (error) {
              return {
                path,
                error: error instanceof Error ? error.message : "Failed to read workspace file.",
              };
            }
          }),
        );
        return {
          runtimeId,
          files,
        };
      } catch (error) {
        return {
          runtimeId,
          error: error instanceof Error ? error.message : "Failed to read live runtime logs.",
        };
      }
    }),
  );
}

function daysAgoIso(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function dayKey(value: unknown) {
  if (typeof value === "string") {
    return value.slice(0, 10);
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (value && typeof value === "object" && typeof (value as { toString?: () => string }).toString === "function") {
    const normalized = (value as { toString: () => string }).toString();
    if (normalized) {
      return normalized.slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

interface AnalyticsEntityBucket {
  id: string;
  count: number;
  event: string;
  workId?: string;
  chunkId?: string;
  passageId?: string;
  label?: string;
  query?: string;
}

function stringProperty(properties: Record<string, unknown>, key: string) {
  const value = properties[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildAnalyticsEntityBreakdown(events: AnalyticsEventRecord[]) {
  const buckets = new Map<string, AnalyticsEntityBucket>();

  for (const event of events) {
    const properties = event.properties ?? {};
    const day = dayKey(event.createdAt);
    const workId = stringProperty(properties, "workId") ?? undefined;
    const chunkId = stringProperty(properties, "chunkId") ?? undefined;
    const passageId = stringProperty(properties, "passageId") ?? undefined;
    const label = stringProperty(properties, "label") ?? undefined;
    const query = stringProperty(properties, "query") ?? undefined;
    const entityId = chunkId ?? passageId ?? workId ?? label ?? query;
    if (!entityId) {
      continue;
    }
    const key = [day, event.event, entityId].join(":");
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    buckets.set(key, {
      id: entityId,
      count: 1,
      event: event.event,
      ...(workId ? { workId } : {}),
      ...(chunkId ? { chunkId } : {}),
      ...(passageId ? { passageId } : {}),
      ...(label ? { label } : {}),
      ...(query ? { query } : {}),
    });
  }

  return [...buckets.entries()].reduce<Record<string, Record<string, AnalyticsEntityBucket[]>>>((accumulator, [key, bucket]) => {
    const [day, eventName] = key.split(":", 2);
    const dayBucket = accumulator[day] ?? {};
    const eventBucket = dayBucket[eventName] ?? [];
    eventBucket.push(bucket);
    dayBucket[eventName] = eventBucket
      .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id))
      .slice(0, 20);
    accumulator[day] = dayBucket;
    return accumulator;
  }, {});
}

async function recordPassageCitationEvents(
  deps: AppDeps,
  request: Request,
  context: {
    userId: string;
    sessionId: string;
    runId?: string;
    source: string;
    status?: string;
  },
  citations: Citation[],
) {
  await Promise.all(
    citations.map((citation, index) =>
      recordAnalyticsEvent(deps, request, "passage_cited", {
        userId: context.userId,
        sessionId: context.sessionId,
        runId: context.runId ?? null,
        workId: citation.workId,
        chunkId: citation.chunkId ?? null,
        label: citation.label,
        excerpt: citation.excerpt,
        source: context.source,
        status: context.status ?? null,
        rank: index + 1,
      }).catch(() => {}),
    ),
  );
}

async function runAnalyticsQuery(
  deps: AppDeps,
  params: {
    query: string;
    days: number;
  },
) {
  const days = Math.max(1, Math.min(30, params.days));
  const since = daysAgoIso(days);
  const [events, userMessages] = await Promise.all([
    deps.store.listAnalyticsEvents({ since, limit: 5000 }),
    deps.store.listUserMessages({ since, limit: 1200 }),
  ]);

  const eventsByDay = events.reduce<Record<string, Record<string, number>>>((accumulator, event) => {
    const key = dayKey(event.createdAt);
    const dayBucket = accumulator[key] ?? {};
    dayBucket[event.event] = (dayBucket[event.event] ?? 0) + 1;
    accumulator[key] = dayBucket;
    return accumulator;
  }, {});

  const queriesByDay = userMessages.reduce<Record<string, string[]>>((accumulator, message) => {
    const key = dayKey(message.createdAt);
    const bucket = accumulator[key] ?? [];
    bucket.push(message.content);
    accumulator[key] = bucket;
    return accumulator;
  }, {});
  const eventEntitiesByDay = buildAnalyticsEntityBreakdown(events);

  if (!deps.openAIApiKey || !deps.openAIModel) {
    return {
      title: "Analytics unavailable",
      summary: "OpenAI is not configured for analytics queries in this environment.",
      metrics: [],
      series: [],
      hashtags: [],
      inspectedDays: days,
      events,
      eventEntitiesByDay,
      userMessages,
    };
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${deps.openAIApiKey}`,
    },
    body: JSON.stringify({
      model: deps.openAIModel,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            `You are the ${productName(deps)} analytics model.`,
            "Answer the admin's analytics question using only the supplied analytics events and user message corpus.",
            "Return JSON with this exact shape:",
            "{",
            '  "title": string,',
            '  "summary": string,',
            '  "metrics": [{"label": string, "value": string}],',
            '  "series": [{"label": string, "points": [{"date": "YYYY-MM-DD", "value": number, "tag"?: string}]}],',
            '  "hashtags": [{"tag": string, "count": number}],',
            '  "notes": [string]',
            "}",
            "When the user asks for topic or vibe analytics, infer a small set of hashtag-like topic labels from the user messages.",
            "Prefer daily time series over prose-only answers whenever the question mentions recent activity or day-by-day trends.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            query: params.query,
            days,
            since,
            analyticsEventsByDay: eventsByDay,
            analyticsEventEntitiesByDay: eventEntitiesByDay,
            analyticsEventsSample: events.slice(0, 500),
            userMessagesByDay: queriesByDay,
            userMessagesSample: userMessages.slice(0, 300),
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    if (detail.includes("invalid_api_key") || detail.includes("Incorrect API key provided")) {
      throw new Error("Analytics is temporarily unavailable because the server-side OpenAI key is invalid.");
    }
    throw new Error(`Analytics query failed: ${detail}`);
  }

  const payload = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Analytics response was empty.");
  }

  const parsed = JSON.parse(content) as Record<string, unknown>;
  return {
    title: typeof parsed.title === "string" ? parsed.title : "Analytics result",
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    metrics: Array.isArray(parsed.metrics) ? parsed.metrics : [],
    series: Array.isArray(parsed.series) ? parsed.series : [],
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    inspectedDays: days,
    eventsSample: events.slice(0, 200),
    userMessagesSample: userMessages.slice(0, 120),
  };
}

async function persistFinalArtifact(deps: AppDeps, sessionId: string, runId: string, answer: string, citations: Array<Record<string, unknown>>) {
  const key = artifactKeys.sessionArtifact(sessionId, `${runId}-final-answer.json`);
  await deps.blobStore.putJson(key, {
    answer,
    citations,
  });
  return key;
}

const MODEL_HISTORY_MAX_MESSAGES = 10;
const MODEL_HISTORY_MAX_MESSAGE_CHARS = 1200;
const MODEL_HISTORY_MAX_TOTAL_CHARS = 6000;

function truncateModelText(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatConversationHistory(messages: MessageRecord[]) {
  const recentMessages = messages.slice(-MODEL_HISTORY_MAX_MESSAGES);
  const trimmed = recentMessages.map((message) => ({
    role: message.role,
    content: truncateModelText(message.content, MODEL_HISTORY_MAX_MESSAGE_CHARS),
  }));
  const bounded: typeof trimmed = [];
  let totalChars = 0;
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const candidate = trimmed[index];
    if (totalChars + candidate.content.length > MODEL_HISTORY_MAX_TOTAL_CHARS) {
      continue;
    }
    bounded.unshift(candidate);
    totalChars += candidate.content.length;
  }

  const omittedCount = Math.max(0, messages.length - bounded.length);
  if (omittedCount > 0) {
    bounded.unshift({
      role: "system",
      content: `${omittedCount} earlier chat message${omittedCount === 1 ? "" : "s"} omitted for brevity.`,
    });
  }
  return bounded;
}

function decodeCitationText(input: string) {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, "\"")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function canonicalizeSearchCharacter(character: string) {
  if (/\s/u.test(character)) {
    return " ";
  }
  switch (character) {
    case "’":
    case "‘":
      return "'";
    case "“":
    case "”":
      return "\"";
    case "—":
    case "–":
      return "-";
    default:
      return character.toLowerCase();
  }
}

function buildNormalizedSearchIndex(raw: string) {
  let normalized = "";
  let previousWasSpace = false;
  for (let index = 0; index < raw.length; index += 1) {
    const next = canonicalizeSearchCharacter(raw[index]);
    if (next === " ") {
      if (previousWasSpace) {
        continue;
      }
      previousWasSpace = true;
    } else {
      previousWasSpace = false;
    }
    normalized += next;
  }
  return normalized.trim();
}

function stripGutenbergBoilerplate(text: string) {
  let normalized = text.replace(/\r\n/g, "\n");
  const startMatch = normalized.match(/^[^\n]*\*\*\*\s*START OF[\s\S]*?\*\*\*[^\n]*\n?/im);
  if (startMatch && typeof startMatch.index === "number") {
    normalized = normalized.slice(startMatch.index + startMatch[0].length);
  }
  const endMatch = normalized.match(/\n?[^\n]*\*\*\*\s*END OF[\s\S]*?\*\*\*[^\n]*$/im);
  if (endMatch && typeof endMatch.index === "number") {
    normalized = normalized.slice(0, endMatch.index);
  }
  return normalized
    .replace(/^\s*(?:start of )?the project gutenberg e(?:book|text).*$\n?/gim, "")
    .replace(/^\s*project gutenberg(?:'s)? e(?:book|text).*$\n?/gim, "")
    .trim();
}

function normalizeReaderText(input: string, preserveLineBreaks = false) {
  const normalized = decodeCitationText(input)
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (preserveLineBreaks) {
    return normalized.replace(/\n{3,}/g, "\n\n").trim();
  }
  return normalized.replace(/\s+/g, " ").trim();
}

function hashText(value: string) {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function createReaderPassageId(index: number, text: string) {
  return `passage-${index + 1}-${hashText(text).slice(0, 6)}`;
}

function buildExcerptCandidates(excerpt: string) {
  const decodedExcerpt = decodeCitationText(excerpt).replace(/\s+/g, " ").trim();
  const cleanedExcerpt = decodedExcerpt.replace(/^[`"'“”‘’]+|[`"'“”‘’.,;:!?]+$/g, "").trim();
  const excerptSegments = cleanedExcerpt
    .split(/[.;!?]\s+|\s+[—–-]\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 24);
  const candidates = [decodedExcerpt, cleanedExcerpt, ...excerptSegments]
    .filter((candidate, index, values) => candidate.length >= 12 && values.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);
  return candidates.length > 0 ? candidates : decodedExcerpt ? [decodedExcerpt] : [];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildWorkPassages(content: string) {
  const cleaned = stripGutenbergBoilerplate(content);
  return cleaned
    .split(/\n{2,}/)
    .map((chunk) => normalizeReaderText(chunk, true))
    .filter((text) => text.length > 0)
    .map((text, index) => ({
      id: createReaderPassageId(index, text),
      searchText: buildNormalizedSearchIndex(text),
    }));
}

type ReaderPassageKind = "heading" | "paragraph" | "list-item" | "quote" | "preformatted";

function finalizeWorkPassages(passages: Array<{ kind: ReaderPassageKind; text: string }>) {
  let started = false;
  let ended = false;
  const cleaned: Array<{ kind: ReaderPassageKind; text: string }> = [];

  for (const passage of passages) {
    if (ended) {
      break;
    }

    let text = passage.text;
    const startMatch = text.match(/\*\*\*\s*START OF[\s\S]*?\*\*\*/i);
    if (startMatch) {
      started = true;
      text = text.slice(startMatch.index! + startMatch[0].length).trim();
    }

    const endMatch = text.match(/\*\*\*\s*END OF[\s\S]*?\*\*\*/i);
    if (endMatch) {
      text = text.slice(0, endMatch.index).trim();
      ended = true;
    }

    const shouldKeep = started || !/project gutenberg/i.test(text);
    const normalized = normalizeReaderText(text, passage.kind === "preformatted");
    if (!shouldKeep || !normalized) {
      continue;
    }

    cleaned.push({
      kind: passage.kind,
      text: normalized,
    });
  }

  const fallback = stripGutenbergBoilerplate(cleaned.map((passage) => passage.text).join("\n\n"));
  const output = cleaned.length > 0
    ? cleaned
    : fallback
      ? fallback.split(/\n{2,}/).map((text) => ({
          kind: "paragraph" as const,
          text: normalizeReaderText(text, true),
        })).filter((passage) => passage.text.length > 0)
      : [];

  return output.map((passage, index) => ({
    id: createReaderPassageId(index, passage.text),
    searchText: buildNormalizedSearchIndex(passage.text),
  }));
}

function buildTextWorkPassages(content: string) {
  const cleaned = stripGutenbergBoilerplate(content);
  return finalizeWorkPassages(
    cleaned
      .split(/\n{2,}/)
      .map((chunk) => normalizeReaderText(chunk, true))
      .filter(Boolean)
      .map((text) => ({
        kind: "paragraph" as const,
        text,
      })),
  );
}

function buildHtmlWorkPassages(content: string) {
  const domParserCtor = (globalThis as { DOMParser?: new () => { parseFromString: (input: string, mimeType: string) => any } }).DOMParser;
  if (!domParserCtor) {
    return buildTextWorkPassages(content);
  }

  const doc = new domParserCtor().parseFromString(content, "text/html");
  for (const node of Array.from(doc.querySelectorAll("script, style, link, meta, base, noscript, iframe") as Iterable<any>)) {
    node.remove();
  }
  for (const anchor of Array.from(doc.querySelectorAll("a") as Iterable<any>)) {
    anchor.replaceWith(...Array.from(anchor.childNodes));
  }

  const selector = "h1, h2, h3, h4, h5, h6, p, li, blockquote, pre";
  const blocks = Array.from(doc.body.querySelectorAll(selector) as Iterable<any>).filter((element) => !element.parentElement?.closest(selector));
  const passages = blocks
    .map((element) => {
      const tagName = element.tagName.toLowerCase();
      const rawText = tagName === "pre"
        ? element.textContent ?? ""
        : element.textContent?.replace(/\s+/g, " ") ?? "";
      const text = normalizeReaderText(rawText, tagName === "pre");
      if (!text) {
        return null;
      }

      const kind: ReaderPassageKind =
        /^h[1-6]$/.test(tagName)
          ? "heading"
          : tagName === "blockquote"
            ? "quote"
            : tagName === "li"
              ? "list-item"
              : tagName === "pre"
                ? "preformatted"
                : "paragraph";

      return {
        kind,
        text: kind === "list-item" ? `• ${text}` : text,
      };
    })
    .filter((passage): passage is { kind: ReaderPassageKind; text: string } => Boolean(passage));

  if (passages.length === 0) {
    return buildTextWorkPassages(doc.body.textContent ?? "");
  }

  return finalizeWorkPassages(passages);
}

async function buildCitationPassageUrl(
  deps: AppDeps,
  sessionId: string,
  citation: Citation,
): Promise<string> {
  if (typeof citation.readerPath === "string" && citation.readerPath.trim().length > 0) {
    return buildResearchDocumentReaderUrl(siteOrigin(deps), sessionId, citation.workId, citation.readerPath);
  }
  if (typeof citation.chunkId === "string" && citation.chunkId.trim().length > 0) {
    const resolvedUrl = await buildChunkIdPassageUrl(deps, sessionId, citation.chunkId);
    return resolvedUrl ?? buildResearchDocumentWorkUrl(siteOrigin(deps), sessionId, citation.workId);
  }
  return buildResearchDocumentWorkUrl(siteOrigin(deps), sessionId, citation.workId);
}

async function buildChunkIndexPassageUrl(
  deps: AppDeps,
  sessionId: string,
  workId: string,
  chunkIndex: number,
): Promise<string | null> {
  const chunk = await deps.store.getChunkByWorkAndIndex(workId, chunkIndex);
  if (!chunk) {
    return null;
  }
  return buildChunkPassageUrlFromChunk(deps, sessionId, chunk);
}

async function buildChunkIdPassageUrl(
  deps: AppDeps,
  sessionId: string,
  chunkId: string,
): Promise<string | null> {
  const [chunk] = await deps.store.getChunksByIds([chunkId]);
  if (!chunk) {
    return null;
  }
  return buildChunkPassageUrlFromChunk(deps, sessionId, chunk);
}

async function buildChunkPassageUrlFromChunk(
  deps: AppDeps,
  sessionId: string,
  chunk: Pick<ChunkSearchResult, "workId" | "readerPath">,
): Promise<string> {
  if (typeof chunk.readerPath === "string" && chunk.readerPath.trim().length > 0) {
    return buildResearchDocumentReaderUrl(siteOrigin(deps), sessionId, chunk.workId, chunk.readerPath);
  }
  return buildResearchDocumentWorkUrl(siteOrigin(deps), sessionId, chunk.workId);
}

async function rewriteAnswerWithCitationLinks(
  deps: AppDeps,
  sessionId: string,
  answer: string,
  citations: Citation[],
) {
  const formatPassageLink = (link: string) => `[Open passage](${link})`;
  const citationLinks = await Promise.all(citations.map((citation) => buildCitationPassageUrl(deps, sessionId, citation)));
  let rewritten = answer;
  let citationIndex = 0;
  rewritten = rewritten.replace(/\[(?:work\s*id|workId)\s*:[^\]]+\]/giu, () => {
    const nextLink = citationLinks[citationIndex] ?? null;
    citationIndex += 1;
    return nextLink ? formatPassageLink(nextLink) : "";
  });

  for (const [index, citation] of citations.entries()) {
    const link = citationLinks[index];
    if (!link || rewritten.includes(`](${link})`)) {
      continue;
    }

    const candidates = buildExcerptCandidates(citation.excerpt);
    let linked = false;
    for (const candidate of candidates) {
      if (!candidate || candidate.length < 12) {
        continue;
      }
      const pattern = new RegExp(`(${escapeRegExp(candidate)})`, "u");
      if (!pattern.test(rewritten)) {
        continue;
      }
      rewritten = rewritten.replace(pattern, `$1 ${formatPassageLink(link)}`);
      linked = true;
      break;
    }

    if (linked) {
      continue;
    }

    const labelPattern = typeof citation.label === "string" && citation.label.trim().length > 0
      ? new RegExp(`(${escapeRegExp(citation.label.trim())})`, "u")
      : null;
    if (labelPattern?.test(rewritten)) {
      rewritten = rewritten.replace(labelPattern, `$1 (${formatPassageLink(link)})`);
      continue;
    }

    const chunkMarkers = typeof citation.chunkId === "string"
      ? [citation.chunkId, citation.chunkId.replace(`${citation.workId}#`, "#")]
      : [];
    for (const chunkMarker of chunkMarkers) {
      if (!chunkMarker) {
        continue;
      }
      const chunkPattern = new RegExp(`(${escapeRegExp(chunkMarker)})`, "u");
      if (chunkPattern.test(rewritten)) {
        rewritten = rewritten.replace(chunkPattern, `$1 ${formatPassageLink(link)}`);
        break;
      }
    }
  }

  const chunkUuidLineMatches = [...rewritten.matchAll(/\(([^()\n]+),\s*chunk\s+([0-9a-f-]{36})\)/giu)];
  for (const match of chunkUuidLineMatches) {
    const [fullMatch, title, chunkId] = match;
    const link = await buildChunkIdPassageUrl(deps, sessionId, chunkId);
    if (!link) {
      continue;
    }
    rewritten = rewritten.replace(fullMatch, `(${title.trim()}, ${formatPassageLink(link)})`);
  }

  const workChunkRefMatches = [...rewritten.matchAll(/\(([0-9a-f-]{36})#(\d+)\)/giu)];
  for (const match of workChunkRefMatches) {
    const [fullMatch, workId, chunkIndexRaw] = match;
    const chunkIndex = Number.parseInt(chunkIndexRaw, 10);
    if (!Number.isFinite(chunkIndex)) {
      continue;
    }
    const link = await buildChunkIndexPassageUrl(deps, sessionId, workId, chunkIndex);
    if (!link) {
      continue;
    }
    rewritten = rewritten.replace(fullMatch, `(${formatPassageLink(link)})`);
  }

  const chunkLineMatches = [...rewritten.matchAll(/(^|\n)([^\n]+?)\s+—\s+workId\s+([0-9a-f-]{36}),\s*chunk\s+#(\d+)(?=\n|$)/giu)];
  for (const match of chunkLineMatches) {
    const [fullMatch, linePrefix, title, workId, chunkIndexRaw] = match;
    const chunkIndex = Number.parseInt(chunkIndexRaw, 10);
    if (!Number.isFinite(chunkIndex)) {
      continue;
    }
    const link = await buildChunkIndexPassageUrl(deps, sessionId, workId, chunkIndex);
    if (!link) {
      continue;
    }
    const replacement = `${linePrefix}${title} — ${formatPassageLink(link)}`;
    rewritten = rewritten.replace(fullMatch, replacement);
  }

  return rewritten;
}

async function synthesizeAnswer(
  deps: AppDeps,
  params: {
    request: Request;
    userId: string;
    sessionId: string;
    runId: string;
    userMessage: string;
    conversationHistory: Array<{
      role: "user" | "assistant" | "system" | "tool";
      content: string;
    }>;
    plannerDraft?: string;
    plannerCitations: Citation[];
    toolHistory: ToolHistoryEntry[];
    auditLog?: AuditLogger;
  },
  send: (event: string, data: Record<string, unknown>) => Promise<void>,
) {
  params.auditLog?.("internal.synthesis.started", {
    citationCount: params.plannerCitations.length,
    toolHistoryCount: params.toolHistory.length,
    hasPlannerDraft: typeof params.plannerDraft === "string" && params.plannerDraft.trim().length > 0,
  });
  try {
    await send("synthesis.started", {
      runId: params.runId,
      sessionId: params.sessionId,
    });

    const availableSynthesisCitations = collectSynthesisCitations(params.plannerCitations, params.toolHistory);
    const exactCitationLinks = await Promise.all(
      availableSynthesisCitations
        .slice(0, 16)
        .map(async (citation) => ({
          workId: citation.workId,
          ...(citation.chunkId ? { chunkId: citation.chunkId } : {}),
          label: citation.label,
          excerpt: citation.excerpt,
          url: await buildCitationPassageUrl(deps, params.sessionId, citation),
        })),
    );

    const latestBriefing = latestCompletedBriefing(params.toolHistory);
    const runtimeEvidenceNotes = latestWorkspaceFileContent(params.toolHistory, /evidence-notes\.md$/u);
    const researchDocument = buildSynthesisResearchDocument(params.toolHistory);

    const synthesis = await deps.synthesizer.synthesize({
      userMessage: params.userMessage,
      conversationHistory: params.conversationHistory,
      plannerDraft: params.plannerDraft,
      plannerCitations: params.plannerCitations,
      toolHistory: params.toolHistory,
      runtimeBriefing: latestBriefing?.answer ?? null,
      runtimeEvidenceNotes,
      researchDocument,
      exactCitationLinks,
      priorAnswerSummary: latestPriorAssistantSummaryFromConversation(params.conversationHistory),
      billingContext: {
        userId: params.userId,
        sessionId: params.sessionId,
        runId: params.runId,
        source: "synthesizer",
      },
    });
    synthesis.citations = ensureCitationBreadth(params.userMessage, synthesis.citations, availableSynthesisCitations);
    const answerEvaluation = typeof deps.synthesizer.evaluateAnswer === "function"
      ? await deps.synthesizer.evaluateAnswer({
          userMessage: params.userMessage,
          answer: synthesis.answer,
          citations: synthesis.citations,
          priorAnswerSummary: latestPriorAssistantSummaryFromConversation(params.conversationHistory),
          billingContext: {
            userId: params.userId,
            sessionId: params.sessionId,
            runId: params.runId,
            source: "synthesizer-eval",
          },
        }).catch(() => null)
      : null;
    if (answerEvaluation) {
      params.auditLog?.("answer.evaluation", answerEvaluation as unknown as Record<string, unknown>);
      void recordAnalyticsEvent(deps, params.request, "answer_quality_summary", {
        userId: params.userId,
        sessionId: params.sessionId,
        runId: params.runId,
        ...answerEvaluation,
      }).catch(() => {});
    }
    params.auditLog?.("internal.synthesis.completed", {
      citationCount: synthesis.citations.length,
      answerLength: synthesis.answer.length,
    });

    const completedAnswer = await persistCompletedAssistantAnswer(deps, {
      sessionId: params.sessionId,
      runId: params.runId,
      answer: synthesis.answer,
      citations: synthesis.citations,
      toolHistory: params.toolHistory,
      send,
      auditLog: params.auditLog,
      extraMetadata: { answerEvaluation },
    });

    const citedWorkIds = uniqueWorkIds(synthesis.citations.map((citation) => citation.workId));
    void recordPassageCitationEvents(
      deps,
      params.request,
      {
        userId: params.userId,
        sessionId: params.sessionId,
        runId: params.runId,
        source: "synthesizer",
        status: "completed",
      },
      synthesis.citations,
    );
    void recordBookAnalyticsEvents(
      deps,
      params.request,
      "book_cited",
      {
        userId: params.userId,
        sessionId: params.sessionId,
        runId: params.runId,
        source: "synthesizer",
        status: "completed",
      },
      citedWorkIds,
    );
    void recordBookAnalyticsEvents(
      deps,
      params.request,
      "book_used_in_successful_answer",
      {
        userId: params.userId,
        sessionId: params.sessionId,
        runId: params.runId,
        source: "synthesizer",
        status: "completed",
      },
      citedWorkIds,
    );

    void completedAnswer;
  } catch (error) {
    params.auditLog?.("internal.synthesis.failed", {
      error: error instanceof Error ? error.message : "Unknown synthesis error",
    });
    throw error;
  }
}

function latestWorkspaceFileContent(
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>,
  pathPattern: RegExp,
): string | null {
  for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
    const candidate = toolHistory[index];
    if (
      candidate.toolName === "read_workspace_file"
      && typeof candidate.args.path === "string"
      && pathPattern.test(candidate.args.path)
      && typeof candidate.result.content === "string"
      && candidate.result.content.trim().length > 0
    ) {
      return candidate.result.content.trim();
    }
  }
  return null;
}

function buildSynthesisResearchDocument(
  toolHistory: Array<{
    toolName: ToolName;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }>,
) {
  const lines: string[] = [];
  const verifiedWorkIds = new Set<string>();
  for (const entry of toolHistory) {
    if (entry.toolName === "get_relevant_chunks" && Array.isArray(entry.result.verifiedWorkIds)) {
      for (const workId of entry.result.verifiedWorkIds) {
        if (typeof workId === "string" && workId.trim().length > 0) {
          verifiedWorkIds.add(workId);
        }
      }
    }
  }
  for (const entry of toolHistory) {
    if ((entry.toolName === "search_works" || entry.toolName === "get_work_metadata") && Array.isArray(entry.result.works)) {
      const works = (entry.result.works as Array<Record<string, unknown>>)
        .filter((work) => {
          const workId = typeof work.id === "string" ? work.id : null;
          return workId ? verifiedWorkIds.has(workId) : false;
        })
        .slice(0, 10)
        .map((work) => {
          const title = typeof work.title === "string" ? work.title.trim() : "Untitled work";
          const authors = Array.isArray(work.authors)
            ? work.authors.filter((author): author is string => typeof author === "string" && author.trim().length > 0).slice(0, 2)
            : [];
          return authors.length > 0 ? `${title} by ${authors.join(", ")}` : title;
        });
      if (works.length > 0) {
        lines.push(`Verified books: ${works.join("; ")}`);
      }
    }

    if (entry.toolName === "get_relevant_chunks" && Array.isArray(entry.result.chunks)) {
      const chunks = (entry.result.chunks as Array<Record<string, unknown>>)
        .filter((chunk) => {
          const workId = typeof chunk.workId === "string" ? chunk.workId : null;
          return workId ? verifiedWorkIds.has(workId) : false;
        })
        .slice(0, 10)
        .map((chunk) => {
          const title = typeof chunk.title === "string" ? chunk.title.trim() : null;
          const author = typeof chunk.author === "string" ? chunk.author.trim() : null;
          const chunkIndex = typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : null;
          const excerpt = typeof chunk.excerpt === "string"
            ? chunk.excerpt.replace(/\s+/g, " ").trim().slice(0, 180)
            : null;
          const source = title
            ? (author ? `${title} by ${author}` : title)
            : (typeof chunk.workId === "string" ? chunk.workId : "unknown work");
          const location = chunkIndex !== null ? `around passage ${chunkIndex}` : "passage surfaced";
          return `${source} (${location})${excerpt ? `: ${excerpt}` : ""}`;
        });
      if (chunks.length > 0) {
        lines.push(`Passages surfaced: ${chunks.join(" | ")}`);
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function normalizeDocumentText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function escapeResearchHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isUsefulPersistedExcerpt(value: string) {
  if (value.length < 40) {
    return false;
  }
  if (/^(Touched|Reviewed|Starting|Seeded|Surfaced)\b/iu.test(value)) {
    return false;
  }
  if (/[{}[\]]/u.test(value)) {
    return false;
  }
  return !/^(error:|exec\b|\/bin\/bash\b|node \/)/iu.test(value);
}

function normalizeDocumentEnding(text: string | null | undefined) {
  if (typeof text !== "string") {
    return "";
  }
  const cleaned = text
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*]\s+/gmu, "")
    .trim();
  if (!cleaned) {
    return "";
  }
  return cleaned
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter((paragraph) => paragraph.length > 0)
    .slice(0, 2)
    .join("\n\n");
}

function runtimeIdFromToolArgs(args: Record<string, unknown> | null | undefined) {
  return typeof args?.runtimeId === "string" && args.runtimeId.trim().length > 0 ? args.runtimeId : null;
}

function runtimeIdFromToolResult(
  result: Record<string, unknown> | null | undefined,
  args?: Record<string, unknown> | null,
) {
  if (typeof result?.runtimeId === "string" && result.runtimeId.trim().length > 0) {
    return result.runtimeId;
  }
  return runtimeIdFromToolArgs(args);
}

function persistedPassageLocation(chunkIndex: number | null) {
  if (chunkIndex === null || !Number.isFinite(chunkIndex)) {
    return "roughly mid-book";
  }
  return `around passage ${chunkIndex}`;
}

function buildResearchDocumentWorkUrl(siteBaseOrigin: string, sessionId: string, workId: string) {
  const url = new URL(`${siteBaseOrigin}/works/${encodeURIComponent(workId)}`);
  url.searchParams.set("session", sessionId);
  return url.toString();
}

function buildResearchDocumentReaderUrl(
  siteBaseOrigin: string,
  sessionId: string,
  workId: string,
  readerPath: string | null | undefined,
) {
  const normalizedReaderPath = typeof readerPath === "string" ? readerPath.trim() : "";
  if (!normalizedReaderPath) {
    return buildResearchDocumentWorkUrl(siteBaseOrigin, sessionId, workId);
  }
  const url = new URL(`${siteBaseOrigin}/works/${encodeURIComponent(workId)}`);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("reader", normalizedReaderPath);
  return url.toString();
}

function buildResearchDocumentPassageUrl(
  siteBaseOrigin: string,
  sessionId: string,
  workId: string,
  passageId: string,
  gutenbergId: string | number | null | undefined,
) {
  if (!passageId || gutenbergId == null || String(gutenbergId).trim().length === 0) {
    return null;
  }
  const url = new URL(`${siteBaseOrigin}/works/${encodeURIComponent(workId)}`);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("reader", `/${encodeURIComponent(String(gutenbergId))}/passages/${encodeURIComponent(passageId)}`);
  return url.toString();
}

function buildResearchDocumentLink(label: string, href: string) {
  return `<a class="assistant-document-link" href="${escapeResearchHtml(href)}">${escapeResearchHtml(label)}</a>`;
}

const BRIEFING_REFERENCE_TOKEN_RE = /\b([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)(?:#(\d+(?:-\d+)?))?\b/giu;

async function resolveBriefingReferenceMap(
  deps: AppDeps,
  tokens: string[],
) {
  const normalizedTokens = [...new Set(tokens.map((token) => token.trim().toLowerCase()).filter(Boolean))];
  const resolved = new Map<string, WorkDetailRecord>();
  const fullIds = normalizedTokens.filter((token) => token.length > 8);
  const prefixes = normalizedTokens.filter((token) => token.length === 8);

  for (const workId of fullIds) {
    const work = await deps.store.getWorkById(workId);
    if (work) {
      resolved.set(workId, work);
    }
  }

  if (prefixes.length > 0) {
    const prefixMatches = await deps.store.getWorksByIdPrefixes(prefixes);
    for (const match of prefixMatches) {
      resolved.set(match.prefix, match.work);
    }
  }

  return resolved;
}

function buildBriefingReferenceLabel(
  line: string,
  matchIndex: number,
  workTitle: string,
  location: string | null,
) {
  const priorText = line.slice(Math.max(0, matchIndex - 120), matchIndex);
  const titleAlreadyVisible = /\*[^*]+\*\s*,?\s*$/u.test(priorText.trim());
  if (location) {
    return titleAlreadyVisible ? location : `${workTitle}, ${location}`;
  }
  return titleAlreadyVisible ? "work" : workTitle;
}

async function renderBriefingInlineHtml(
  deps: AppDeps,
  sessionId: string,
  value: string,
) {
  const matches = [...value.matchAll(BRIEFING_REFERENCE_TOKEN_RE)];
  const resolvedByToken = await resolveBriefingReferenceMap(
    deps,
    matches.map((match) => String(match[1]).toLowerCase()),
  );

  let withPlaceholders = value;
  const replacements = new Map<string, string>();
  for (const [index, match] of matches.entries()) {
    const token = String(match[1]);
    const tokenKey = token.toLowerCase();
    const range = typeof match[2] === "string" ? match[2] : null;
    const resolved = resolvedByToken.get(tokenKey);
    if (!resolved) {
      continue;
    }
    const location = range ? `passage${range.includes("-") ? "s" : ""} ${range}` : null;
    const label = buildBriefingReferenceLabel(value, match.index ?? 0, resolved.title, location);
    const href = range
      ? await buildChunkIndexPassageUrl(
          deps,
          sessionId,
          resolved.id,
          Number.parseInt(range.split("-")[0] ?? range, 10),
        ) ?? buildResearchDocumentWorkUrl(siteOrigin(deps), sessionId, resolved.id)
      : buildResearchDocumentWorkUrl(siteOrigin(deps), sessionId, resolved.id);
    const placeholder = `@@BRIEFING_REF_${index}@@`;
    withPlaceholders = withPlaceholders.replace(match[0], placeholder);
    replacements.set(placeholder, buildResearchDocumentLink(label, href));
  }

  let html = escapeResearchHtml(withPlaceholders)
    .replace(/\*\*(.+?)\*\*/gu, "<strong>$1</strong>")
    .replace(/(^|[\\s(])\*(.+?)\*(?=[$\\s).,;:!?])/gmu, "$1<em>$2</em>");
  for (const [placeholder, replacement] of replacements.entries()) {
    html = html.replace(placeholder, replacement);
  }
  return html;
}

function appendResearchDocumentFragment(currentHtml: string, fragment: string) {
  return fragment.trim().length > 0 ? `${currentHtml}${fragment}` : currentHtml;
}

async function renderStreamingBriefingLineHtml(
  deps: AppDeps,
  sessionId: string,
  line: string,
) {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }
  if (
    /^(?:#{1,4}\s*)?Early Evidence$/iu.test(trimmed)
    || /^Question:\s+/iu.test(trimmed)
    || /^(?:#{1,4}\s*)?Seed Passages$/iu.test(trimmed)
    || /^(?:#{1,4}\s*)?Strong Local Matches$/iu.test(trimmed)
  ) {
    return "";
  }
  const markdownHeadingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/u);
  if (markdownHeadingMatch) {
    const level = Math.min(4, markdownHeadingMatch[1].length);
    const headingHtml = await renderBriefingInlineHtml(deps, sessionId, markdownHeadingMatch[2].trim());
    return `<h${level}>${headingHtml}</h${level}>`;
  }
  const headingMatch = trimmed.match(/^\*\*(.+)\*\*$/u);
  if (headingMatch) {
    return `<h3>${escapeResearchHtml(headingMatch[1].trim())}</h3>`;
  }
  if (trimmed.startsWith("- ")) {
    const itemHtml = await renderBriefingInlineHtml(deps, sessionId, trimmed.slice(2).trim());
    return `<ul class="assistant-document-briefing-list"><li>${itemHtml}</li></ul>`;
  }
  const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/u);
  if (orderedMatch) {
    const itemHtml = await renderBriefingInlineHtml(deps, sessionId, orderedMatch[2].trim());
    return `<ol class="assistant-document-briefing-list"><li value="${escapeResearchHtml(orderedMatch[1])}">${itemHtml}</li></ol>`;
  }
  if (trimmed.startsWith("> ")) {
    const quoteHtml = await renderBriefingInlineHtml(deps, sessionId, trimmed.slice(2).trim());
    return `<blockquote class="assistant-document-entry is-chunk"><p class="assistant-document-quote">${quoteHtml}</p></blockquote>`;
  }
  const paragraphHtml = await renderBriefingInlineHtml(deps, sessionId, trimmed);
  return `<p class="assistant-document-entry is-log">${paragraphHtml}</p>`;
}

type ResearchDocumentSectionOptions = {
  className?: string;
  meta?: string;
  open?: boolean;
};

function buildResearchDocumentSectionMarker(sectionKey: string) {
  return `<!--assistant-document-section:${encodeURIComponent(sectionKey)}-->`;
}

function buildResearchDocumentSectionHeader(title: string, summary: string) {
  const normalizedSummary = normalizeDocumentText(summary);
  const summaryHtml =
    normalizedSummary && !isLowValueDocumentSummary(normalizedSummary)
      ? `<p class="assistant-document-section-kicker">${escapeResearchHtml(normalizedSummary)}</p>`
      : "";
  return [
    `<section class="assistant-document-stream-section">`,
    `<h2 class="assistant-document-stream-title">${escapeResearchHtml(title)}</h2>`,
    summaryHtml,
    `</section>`,
  ].join("");
}

function buildResearchDocumentLogEntry(text: string) {
  return `<p class="assistant-document-entry is-log">${escapeResearchHtml(text)}</p>`;
}

function buildResearchDocumentRunShell(question: string) {
  const normalizedQuestion = normalizeDocumentText(question);
  const summary = normalizedQuestion
    ? `Looking for direct evidence about: ${normalizedQuestion}`
    : "Searching broadly for direct evidence across the library.";
  return buildResearchDocumentSectionHeader("Search Underway", summary);
}

function persistedSectionLabel(entry: ToolHistoryEntry) {
  return labelForToolCall(entry.toolName, entry.args);
}

function persistedSectionSummary(entry: ToolHistoryEntry) {
  const rationale = normalizeDocumentText(entry.rationale);
  if (rationale) {
    return rationale.endsWith(".") ? rationale : `${rationale}.`;
  }
  const resultSummary = normalizeDocumentText(entry.result.__summary);
  if (resultSummary && !isLowValueDocumentSummary(resultSummary)) {
    return resultSummary;
  }
  const argsSummary = normalizeDocumentText(entry.args.__summary);
  if (argsSummary && !isLowValueDocumentSummary(argsSummary)) {
    return argsSummary;
  }
  return `${persistedSectionLabel(entry)} completed.`.trim();
}

function isLowValueDocumentSummary(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized === "running" || normalized === "done" || normalized === "failed" || normalized === "summary") {
    return true;
  }
  if (
    /^\d+(?:\.\d+)?$/u.test(normalized)
    || /^\d+(?:\s+\d+)+$/u.test(normalized)
    || /^\d+(?:\s*[-–]\s*\d+)+$/u.test(normalized)
  ) {
    return true;
  }
  return /^\d+\s+(book|books|passage|passages|workspace book|workspace books)$/u.test(normalized);
}

function formatResearchDocumentBookLine(titleText: string, authors: string[]) {
  return authors.length > 0 ? `- ${titleText} by ${authors.join(", ")}` : `- ${titleText}`;
}

function appendResearchDocumentHtmlSection(
  htmlSections: string[],
  title: string,
  summary: string,
  bodyHtml: string[],
  options: ResearchDocumentSectionOptions = {},
) {
  const filtered = bodyHtml.filter((line) => line.trim().length > 0);
  const kicker = summary && !isLowValueDocumentSummary(summary)
    ? `<span class="assistant-document-section-kicker">${escapeResearchHtml(summary)}</span>`
    : "";
  const meta = normalizeDocumentText(options.meta)
    ? `<span class="assistant-document-section-meta">${escapeResearchHtml(normalizeDocumentText(options.meta))}</span>`
    : "";
  if (!kicker && filtered.length === 0) {
    return;
  }
  htmlSections.push([
    `<details class="${["assistant-document-section", options.className].filter(Boolean).join(" ")}"${options.open === false ? "" : " open"}>`,
    `<summary class="assistant-document-section-summary">`,
    `<span class="assistant-document-section-title-row">`,
    `<span class="assistant-document-section-title">${escapeResearchHtml(title)}</span>`,
    meta,
    `</span>`,
    kicker,
    `</summary>`,
    filtered.length > 0
      ? [`<div class="assistant-document-section-body">`, ...filtered, `</div>`].join("")
      : "",
    `</details>`,
  ].join(""));
}

function appendResearchDocumentHtml(
  existingHtml: string | null | undefined,
  title: string,
  summary: string,
  bodyHtml: string[],
  options?: ResearchDocumentSectionOptions,
) {
  const nextSections: string[] = [];
  appendResearchDocumentHtmlSection(nextSections, title, summary, bodyHtml, options);
  if (nextSections.length === 0) {
    return existingHtml ?? "";
  }
  return `${existingHtml ?? ""}${nextSections.join("")}`;
}

function appendResearchDocumentSectionFragment(
  existingHtml: string | null | undefined,
  sectionKey: string,
  title: string,
  summary: string,
  fragment: string,
  options: ResearchDocumentSectionOptions = {},
) {
  const trimmedFragment = fragment.trim();
  if (!trimmedFragment) {
    return existingHtml ?? "";
  }
  const currentHtml = existingHtml ?? "";
  const marker = buildResearchDocumentSectionMarker(sectionKey);
  if (currentHtml.includes(marker)) {
    return currentHtml.replace(marker, `${trimmedFragment}${marker}`);
  }
  return appendResearchDocumentHtml(
    currentHtml,
    title,
    summary,
    [trimmedFragment, marker],
    options,
  );
}

async function renderBriefingHtml(
  deps: AppDeps,
  sessionId: string,
  briefing: string,
) {
  const lines = briefing
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""));
  const html: string[] = [];
  let listItems: string[] = [];
  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }
    html.push(`<ul class="assistant-document-briefing-list">${listItems.join("")}</ul>`);
    listItems = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      continue;
    }
    const markdownHeadingMatch = trimmed.match(/^(#{2,4})\s+(.+)$/u);
    if (markdownHeadingMatch) {
      flushList();
      const level = Math.min(4, markdownHeadingMatch[1].length + 1);
      const headingHtml = await renderBriefingInlineHtml(deps, sessionId, markdownHeadingMatch[2].trim());
      html.push(`<h${level}>${headingHtml}</h${level}>`);
      continue;
    }
    const headingMatch = trimmed.match(/^\*\*(.+)\*\*$/u);
    if (headingMatch) {
      flushList();
      html.push(`<h3>${escapeResearchHtml(headingMatch[1].trim())}</h3>`);
      continue;
    }
    if (trimmed.startsWith("- ")) {
      listItems.push(`<li>${await renderBriefingInlineHtml(deps, sessionId, trimmed.slice(2))}</li>`);
      continue;
    }
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/u);
    if (orderedMatch) {
      flushList();
      html.push(`<ol class="assistant-document-briefing-list"><li value="${escapeResearchHtml(orderedMatch[1])}">${await renderBriefingInlineHtml(deps, sessionId, orderedMatch[2].trim())}</li></ol>`);
      continue;
    }
    if (trimmed.startsWith("> ")) {
      flushList();
      html.push(`<blockquote class="assistant-document-entry is-chunk"><p class="assistant-document-quote">${await renderBriefingInlineHtml(deps, sessionId, trimmed.slice(2).trim())}</p></blockquote>`);
      continue;
    }
    flushList();
    html.push(`<p class="assistant-document-entry is-log">${await renderBriefingInlineHtml(deps, sessionId, trimmed)}</p>`);
  }
  flushList();
  return html.join("");
}

async function appendFinalAnswerResearchDocumentHtml(
  deps: AppDeps,
  sessionId: string,
  existingHtml: string | null | undefined,
  _citations: Citation[],
  ending: string,
) {
  let html = existingHtml ?? "";
  const renderedAnswer = await renderBriefingHtml(deps, sessionId, ending);
  if (renderedAnswer.trim()) {
    html = appendResearchDocumentHtml(
      html,
      "Answer",
      "",
      [renderedAnswer],
    );
  }
  return html;
}

async function persistResearchDocumentArtifact(
  deps: AppDeps,
  sessionId: string,
  runId: string,
  html: string,
) {
  const filename = `${runId}-research-document.html`;
  const r2Key = artifactKeys.sessionArtifact(sessionId, filename);
  await deps.blobStore.putText(r2Key, html, "text/html; charset=utf-8");
  await deps.store.saveArtifact({
    sessionId,
    runtimeId: null,
    r2Key,
    filename,
    mimeType: "text/html",
    metadata: {
      kind: "research_document",
      runId,
      format: "html",
    },
  });
  return r2Key;
}

async function persistCompletedAssistantAnswer(
  deps: AppDeps,
  params: {
    sessionId: string;
    runId: string;
    answer: string;
    citations: Citation[];
    toolHistory: ToolHistoryEntry[];
    send: (event: string, data: Record<string, unknown>) => Promise<void>;
    auditLog?: AuditLogger;
    extraMetadata?: Record<string, unknown>;
  },
) {
  const linkedAnswer = await rewriteAnswerWithCitationLinks(
    deps,
    params.sessionId,
    params.answer,
    params.citations,
  );
  const existingResearchDocumentHtml = await loadPersistedResearchDocumentHtml(
    deps,
    params.sessionId,
    params.runId,
  );
  const researchDocumentHtml = await appendFinalAnswerResearchDocumentHtml(
    deps,
    params.sessionId,
    existingResearchDocumentHtml,
    params.citations,
    linkedAnswer,
  );
  const artifactKey = await persistFinalArtifact(
    deps,
    params.sessionId,
    params.runId,
    linkedAnswer,
    params.citations,
  );
  await persistResearchDocumentArtifact(deps, params.sessionId, params.runId, researchDocumentHtml);
  await deps.store.appendMessage(params.sessionId, "assistant", linkedAnswer, {
    runId: params.runId,
    phase: "answer",
    citations: params.citations,
    artifactKey,
    ...(params.extraMetadata ?? {}),
  });
  await streamAssistantText(linkedAnswer, params.send);
  await params.send("assistant.completed", {
    answer: linkedAnswer,
    citations: params.citations,
    artifactKey,
    ...(params.extraMetadata ?? {}),
  });
  params.auditLog?.("assistant.completed", {
    answerLength: linkedAnswer.length,
    citationCount: params.citations.length,
    artifactKey,
    ...(params.extraMetadata ?? {}),
  });
  return { answer: linkedAnswer, citations: params.citations, artifactKey, researchDocumentHtml };
}

type HermesSessionMessage = {
  role?: string;
  content?: string | null;
  reasoning?: string | null;
  finish_reason?: string | null;
  tool_calls?: Array<{
    id?: string;
    call_id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
  tool_call_id?: string;
};

type HermesSessionSnapshot = {
  session_id?: string;
  message_count?: number;
  messages?: HermesSessionMessage[];
  last_updated?: string;
};

type HermesArchiveManifestFile = {
  relativePath: string;
  r2Key: string;
  sourcePath?: string | null;
  byteSize?: number | null;
  mimeType?: string | null;
  uploadedAt?: string | null;
};

type HermesArchiveManifest = {
  version?: number;
  jobId?: string;
  sessionId?: string;
  runId?: string;
  archivePrefix?: string;
  uploadedAt?: string;
  files?: HermesArchiveManifestFile[];
};

type HermesBridgeRecord = {
  externalJobId: string;
  wrapperRunDir: string | null;
  innerRunDir: string | null;
  innerRunId: string | null;
  archivePrefix: string | null;
  hermesSessionId: string | null;
};

function shouldUseHermesBackend(
  deps: AppDeps,
  input: {
    mode?: "semantic" | "comprehensive" | "agentic";
    researchMode?: "default" | "sprite_fanout";
  },
) {
  return requestedAssistantMode(input) === "agentic"
    && typeof deps.hermesJobApiUrl === "string"
    && deps.hermesJobApiUrl.trim().length > 0;
}

function normalizeHermesArtifactName(input: string) {
  return input.trim().replace(/^\/+/u, "");
}

function parseHermesJsonRecord(input: string | null | undefined) {
  if (typeof input !== "string") {
    return null;
  }
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseHermesArchiveManifest(input: string | null | undefined): HermesArchiveManifest | null {
  const parsed = parseHermesJsonRecord(input);
  if (!parsed) {
    return null;
  }
  const files = Array.isArray(parsed.files)
    ? parsed.files.filter((entry): entry is HermesArchiveManifestFile =>
        Boolean(entry)
        && typeof entry === "object"
        && typeof (entry as HermesArchiveManifestFile).relativePath === "string"
        && typeof (entry as HermesArchiveManifestFile).r2Key === "string",
      )
    : [];
  return {
    version: typeof parsed.version === "number" ? parsed.version : undefined,
    jobId: typeof parsed.jobId === "string" ? parsed.jobId : undefined,
    sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
    runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
    archivePrefix: typeof parsed.archivePrefix === "string" ? parsed.archivePrefix : undefined,
    uploadedAt: typeof parsed.uploadedAt === "string" ? parsed.uploadedAt : undefined,
    files,
  };
}

function defaultMimeTypeForHermesArtifact(relativePath: string) {
  const normalized = relativePath.toLowerCase();
  if (normalized.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }
  if (normalized.endsWith(".json") || normalized.endsWith(".jsonl")) {
    return "application/json; charset=utf-8";
  }
  if (normalized.endsWith(".csv") || normalized.endsWith(".tsv")) {
    return "text/csv; charset=utf-8";
  }
  if (normalized.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (normalized.endsWith(".log") || normalized.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

function loadHermesArchiveSummary(job: HermesJobSummary) {
  const archive = job.archive && typeof job.archive === "object" ? job.archive : null;
  return {
    status: typeof archive?.status === "string" ? archive.status : null,
    prefix: typeof archive?.prefix === "string" ? archive.prefix : null,
    manifestKey: typeof archive?.manifestKey === "string" ? archive.manifestKey : null,
    fileCount: typeof archive?.fileCount === "number" ? archive.fileCount : null,
    updatedAt: typeof archive?.updatedAt === "string" ? archive.updatedAt : null,
  };
}

function canonicalHermesSessionId(
  job: Pick<HermesJobSummary, "hermesSessionId">,
  finalSnapshot?: HermesSessionSnapshot | null,
) {
  const fromJob = typeof job.hermesSessionId === "string" ? job.hermesSessionId.trim() : "";
  if (fromJob) {
    return fromJob;
  }
  const fromSnapshot = typeof finalSnapshot?.session_id === "string" ? finalSnapshot.session_id.trim() : "";
  return fromSnapshot || null;
}

function buildHermesBridgeRecord(
  job: HermesJobSummary,
  options?: {
    archivePrefix?: string | null;
    finalSnapshot?: HermesSessionSnapshot | null;
  },
): HermesBridgeRecord {
  const archiveSummary = loadHermesArchiveSummary(job);
  const wrapperRunDir =
    typeof job.wrapperRunDir === "string" && job.wrapperRunDir.trim().length > 0
      ? job.wrapperRunDir.trim()
      : typeof job.runDir === "string" && job.runDir.trim().length > 0
        ? job.runDir.trim()
        : null;
  const archivePrefix =
    typeof options?.archivePrefix === "string" && options.archivePrefix.trim().length > 0
      ? options.archivePrefix.trim()
      : typeof job.archivePrefix === "string" && job.archivePrefix.trim().length > 0
        ? job.archivePrefix.trim()
        : archiveSummary.prefix;
  return {
    externalJobId: job.id,
    wrapperRunDir,
    innerRunDir: typeof job.innerRunDir === "string" && job.innerRunDir.trim().length > 0 ? job.innerRunDir.trim() : null,
    innerRunId: typeof job.innerRunId === "string" && job.innerRunId.trim().length > 0 ? job.innerRunId.trim() : null,
    archivePrefix: archivePrefix ?? null,
    hermesSessionId: canonicalHermesSessionId(job, options?.finalSnapshot),
  };
}

async function loadHermesArchiveManifest(
  deps: AppDeps,
  job: HermesJobSummary,
) {
  const archive = loadHermesArchiveSummary(job);
  if (!archive.manifestKey) {
    return null;
  }
  const text = await deps.blobStore.getText(archive.manifestKey).catch(() => null);
  return parseHermesArchiveManifest(text);
}

function findHermesArchiveFile(
  manifest: HermesArchiveManifest | null,
  predicate: (file: HermesArchiveManifestFile) => boolean,
) {
  return manifest?.files?.find(predicate) ?? null;
}

async function loadHermesArchiveText(
  deps: AppDeps,
  manifest: HermesArchiveManifest | null,
  predicate: (file: HermesArchiveManifestFile) => boolean,
) {
  const file = findHermesArchiveFile(manifest, predicate);
  if (!file) {
    return null;
  }
  return await deps.blobStore.getText(file.r2Key).catch(() => null);
}

function truncateHermesText(input: string, maxChars = 400) {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function summarizeHermesTodos(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }
  const todos = value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
  const inProgress = todos.find((todo) => todo.status === "in_progress" && typeof todo.content === "string");
  if (typeof inProgress?.content === "string" && inProgress.content.trim().length > 0) {
    return inProgress.content.trim();
  }
  const completed = todos.filter((todo) => todo.status === "completed").length;
  if (todos.length > 0) {
    return `${completed} of ${todos.length} planned steps completed.`;
  }
  return null;
}

function summarizeHermesCommandIntent(command: string) {
  const normalized = command.replace(/\s+/gu, " ").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("run-ripgrep-progress.sh") || /\brg\b/u.test(normalized)) {
    return {
      label: "Search corpus",
      summary: "Searching the corpus for relevant passages.",
    };
  }
  if (normalized.includes("briefing.md")) {
    return {
      label: "Write briefing",
      summary: "Writing the briefing.",
    };
  }
  if (normalized.includes("dataset.jsonl") || normalized.includes("citation-index.json")) {
    return {
      label: "Build dataset",
      summary: "Building the dataset and citation index.",
    };
  }
  if (normalized.includes("scoped-text-files.tsv")) {
    return {
      label: "Scope corpus files",
      summary: "Deriving the scoped file list.",
    };
  }
  if (
    normalized.includes("manifest.json")
    || normalized.includes("run.log")
    || normalized.includes("run_dir")
    || normalized.includes("initialized corpus research run")
  ) {
    return {
      label: "Initialize run",
      summary: "Creating the run directory and manifest.",
    };
  }
  return null;
}

function summarizeHermesCodeIntent(code: string) {
  const normalized = code.replace(/\s+/gu, " ").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("manifest.json") || normalized.includes("run.log")) {
    return {
      label: "Initialize run",
      summary: "Creating the run directory and manifest.",
    };
  }
  if (normalized.includes("dataset.jsonl") || normalized.includes("citation-index.json")) {
    return {
      label: "Build dataset",
      summary: "Building the dataset and citation index.",
    };
  }
  if (normalized.includes("briefing.md")) {
    return {
      label: "Write briefing",
      summary: "Writing the briefing.",
    };
  }
  return {
    label: "Execute code",
    summary: "Running a scripted processing step.",
  };
}

function summarizeHermesOutputText(output: string, sourceArgs: Record<string, unknown>) {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const tracebackLine = [...lines].reverse().find((line) => /(?:error|exception|traceback|keyerror|valueerror|typeerror|runtimeerror)/iu.test(line));
  if (tracebackLine) {
    return truncateHermesText(tracebackLine, 180);
  }

  const scopedFiles = [...lines].reverse().find((line) => /scoped-text-files\.tsv/iu.test(line));
  const zeroCount = [...lines].reverse().find((line) => /^0$/u.test(line));
  if (scopedFiles && zeroCount) {
    return "Prepared the manifest, but found 0 scoped files.";
  }

  const pathOnly = lines.every((line) => line.startsWith("/"));
  if (pathOnly) {
    if (typeof sourceArgs.command === "string") {
      return summarizeHermesCommandIntent(sourceArgs.command)?.summary ?? "Wrote files for the next step.";
    }
    if (typeof sourceArgs.code === "string") {
      return summarizeHermesCodeIntent(sourceArgs.code)?.summary ?? "Wrote files for the next step.";
    }
  }

  const informative = lines.find((line) => !/^<stdin>:/u.test(line) && !line.startsWith("/"));
  return informative ? truncateHermesText(informative, 180) : truncateHermesText(lines[0]!, 180);
}

function describeHermesToolCall(name: string, sourceArgs: Record<string, unknown>) {
  const normalizedName = name.trim().toLowerCase();
  if (normalizedName === "skills_list") {
    return {
      label: "Inspect available tools",
      summary: "Checking which Hermes tools and skills are available.",
    };
  }
  if (normalizedName === "skill_view") {
    const skillName = typeof sourceArgs.name === "string" ? sourceArgs.name.trim() : "";
    return {
      label: "Read skill guide",
      summary: skillName ? `Reading the ${skillName} instructions.` : "Reading a skill guide.",
    };
  }
  if (normalizedName === "todo") {
    return {
      label: "Update plan",
      summary: summarizeHermesTodos(sourceArgs.todos) ?? "Updating the research plan.",
    };
  }
  if (normalizedName === "terminal") {
    const command = typeof sourceArgs.command === "string" ? sourceArgs.command : "";
    return summarizeHermesCommandIntent(command) ?? {
      label: "Run terminal step",
      summary: "Running a shell step on the research box.",
    };
  }
  if (normalizedName === "execute_code") {
    const code = typeof sourceArgs.code === "string" ? sourceArgs.code : "";
    return summarizeHermesCodeIntent(code) ?? {
      label: "Execute code",
      summary: "Running a scripted processing step.",
    };
  }
  if (normalizedName.includes("search")) {
    const query = typeof sourceArgs.query === "string" && sourceArgs.query.trim().length > 0
      ? truncateHermesText(sourceArgs.query.trim(), 96)
      : null;
    const cleaned = name.replace(/[_-]+/gu, " ").trim();
    return {
      label: cleaned.length > 0
        ? cleaned.replace(/\b\w/gu, (char) => char.toUpperCase())
        : "Search",
      summary: query ? `Searching for ${query}.` : "Running a search step.",
    };
  }
  const cleaned = name.replace(/[_-]+/gu, " ").trim();
  return {
    label: cleaned.length > 0
      ? cleaned.replace(/\b\w/gu, (char) => char.toUpperCase())
      : "Hermes Step",
    summary: null,
  };
}

function summarizeHermesToolResult(
  content: string | null | undefined,
  functionName?: string,
  sourceArgs: Record<string, unknown> = {},
) {
  if (typeof content !== "string" || content.trim().length === 0) {
    return { text: null, result: {} as Record<string, unknown> };
  }
  const parsed = parseHermesJsonRecord(content);
  if (!parsed) {
    const fallbackText = truncateHermesText(content);
    return {
      text: fallbackText,
      result: {
        output: truncateHermesText(content, 800),
        __summary: fallbackText,
      },
    };
  }
  const normalizedName = typeof functionName === "string" ? functionName.trim().toLowerCase() : "";
  const explicitError =
    typeof parsed.error === "string" && parsed.error.trim().length > 0
      ? parsed.error.trim()
      : typeof parsed.stderr === "string" && parsed.stderr.trim().length > 0
        ? parsed.stderr.trim()
        : null;
  if (explicitError) {
    const errorLine = explicitError
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
      .find((line) => /(?:error|exception|traceback|keyerror|valueerror|typeerror|runtimeerror)/iu.test(line))
      ?? explicitError;
    const text = truncateHermesText(errorLine, 180);
    return {
      text,
      result: {
        ...parsed,
        __summary: text,
      },
    };
  }

  if (normalizedName === "todo") {
    const text = summarizeHermesTodos(parsed.todos) ?? summarizeHermesTodos(sourceArgs.todos);
    return {
      text,
      result: {
        ...parsed,
        ...(text ? { __summary: text } : {}),
      },
    };
  }

  if (normalizedName === "skills_list") {
    const count = typeof parsed.count === "number" ? parsed.count : Array.isArray(parsed.skills) ? parsed.skills.length : null;
    const categories = Array.isArray(parsed.categories) ? parsed.categories.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
    const text = count !== null
      ? `Loaded ${count} available ${categories.length > 0 ? categories[0] : "Hermes"} skills.`
      : "Loaded the available Hermes skills.";
    return {
      text,
      result: {
        ...parsed,
        __summary: text,
      },
    };
  }

  if (normalizedName === "skill_view") {
    const name = typeof sourceArgs.name === "string" && sourceArgs.name.trim().length > 0 ? sourceArgs.name.trim() : "the selected skill";
    const text = `Read the ${name} instructions.`;
    return {
      text,
      result: {
        ...parsed,
        __summary: text,
      },
    };
  }

  if ((normalizedName === "terminal" || normalizedName === "execute_code") && typeof parsed.output === "string") {
    const presentation = describeHermesToolCall(normalizedName, sourceArgs);
    const text = summarizeHermesOutputText(parsed.output, sourceArgs)
      ?? presentation.summary
      ?? truncateHermesText(parsed.output, 180);
    return {
      text,
      result: {
        ...parsed,
        __summary: text,
      },
    };
  }

  const preferredText =
    typeof parsed.stdout === "string" && parsed.stdout.trim().length > 0
      ? parsed.stdout
      : typeof parsed.stderr === "string" && parsed.stderr.trim().length > 0
        ? parsed.stderr
        : typeof parsed.content === "string" && parsed.content.trim().length > 0
          ? parsed.content
          : typeof parsed.text === "string" && parsed.text.trim().length > 0
            ? parsed.text
            : typeof parsed.message === "string" && parsed.message.trim().length > 0
              ? parsed.message
            : typeof parsed.summary === "string" && parsed.summary.trim().length > 0
              ? parsed.summary
              : null;
  const text = preferredText ? truncateHermesText(preferredText) : truncateHermesText(content);
  return {
    text,
    result: {
      ...parsed,
      __summary: text,
    },
  };
}

async function fanOutActiveRunSubscribers(
  activeRuns: Map<string, ActiveRunState>,
  runId: string,
  event: string,
  data: Record<string, unknown>,
) {
  const activeRun = activeRuns.get(runId);
  if (!activeRun || activeRun.subscribers.size === 0) {
    return;
  }
  const subscribers = [...activeRun.subscribers.values()];
  await Promise.all(subscribers.map(async (subscriber) => {
    try {
      await subscriber(event, data);
    } catch {
      // Ignore subscriber disconnect races.
    }
  }));
}

async function publishPersistedHermesEvent(
  deps: AppDeps,
  activeRuns: Map<string, ActiveRunState>,
  runId: string,
  sessionId: string,
  event: string,
  data: Record<string, unknown>,
  send?: (event: string, data: Record<string, unknown>) => Promise<void>,
) {
  await deps.store.appendRunEvent(runId, sessionId, event, data);
  if (send) {
    await send(event, data);
  }
  await fanOutActiveRunSubscribers(activeRuns, runId, event, data);
}

function normalizeHermesArtifactFilename(relativePath: string) {
  return relativePath.replace(/^\/+/u, "").trim();
}

function titleForHermesArtifact(relativePath: string) {
  const normalized = normalizeHermesArtifactFilename(relativePath);
  const base = normalized.split("/").at(-1) ?? normalized;
  if (base === "final-answer.md") {
    return "Final Answer";
  }
  if (base === "final-answer.json") {
    return "Final Answer JSON";
  }
  if (base === "scope-report.json") {
    return "Scope Report";
  }
  if (normalized.endsWith("hits/index.json")) {
    return "Search Hits Index";
  }
  if (/\/hits\/hit-\d+\.md$/u.test(normalized) || /^hits\/hit-\d+\.md$/u.test(normalized)) {
    return base.replace(/\.md$/u, "").replace(/-/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
  }
  if (base === "briefing.md") {
    return "Briefing";
  }
  if (base === "citation-index.json") {
    return "Citation Index";
  }
  if (base === "dataset.csv") {
    return "Dataset CSV";
  }
  if (base === "dataset.jsonl") {
    return "Dataset JSONL";
  }
  if (base === "run.log") {
    return "Run Log";
  }
  if (base === "hermes.session.json") {
    return "Hermes Session Snapshot";
  }
  return base;
}

function kindForHermesArtifact(relativePath: string) {
  const normalized = normalizeHermesArtifactFilename(relativePath);
  const base = normalized.split("/").at(-1) ?? "";
  if (base === "final-answer.md") {
    return "final_answer_markdown";
  }
  if (base === "final-answer.json") {
    return "final_answer_json";
  }
  if (base === "scope-report.json") {
    return "scope_report_json";
  }
  if (normalized.endsWith("hits/index.json")) {
    return "hermes_search_hits_index";
  }
  if (/\/hits\/hit-\d+\.md$/u.test(normalized) || /^hits\/hit-\d+\.md$/u.test(normalized)) {
    return "hermes_search_hit";
  }
  if (base === "briefing.md") {
    return "briefing_markdown";
  }
  if (base === "every-single-reference.md") {
    return "reference_file";
  }
  if (base === "hermes.session.json") {
    return "hermes_session_snapshot";
  }
  if (base === "archive-manifest.json") {
    return "hermes_archive_manifest";
  }
  return "hermes_run_artifact";
}

function isUserFacingHermesArtifact(relativePath: string) {
  const normalized = normalizeHermesArtifactFilename(relativePath).toLowerCase();
  if (
    normalized === "inner/manifest.json"
    || normalized === "inner/scope-report.json"
    || normalized === "inner/final-answer.md"
    || normalized === "inner/final-answer.json"
    || normalized === "inner/run.log"
    || normalized === "inner/scoped-files.tsv"
    || normalized === "inner/briefing.md"
    || normalized === "inner/dataset.csv"
    || normalized === "inner/dataset.jsonl"
    || normalized === "inner/citation-index.json"
    || normalized === "inner/status.json"
    || normalized === "inner/hits/index.json"
  ) {
    return true;
  }
  return /^inner\/hits\/hit-\d+\.md$/u.test(normalized);
}

async function persistHermesArchiveArtifacts(
  deps: AppDeps,
  sessionId: string,
  runId: string,
  job: HermesJobSummary,
  manifest: HermesArchiveManifest,
) {
  const existing = new Set(
    (await deps.store.listArtifacts(sessionId))
      .filter((artifact) => artifactRunId(artifact) === runId)
      .map((artifact) => artifact.r2Key),
  );
  const imported: Array<ArtifactRecord> = [];
  for (const file of manifest.files ?? []) {
    const r2Key = typeof file.r2Key === "string" ? file.r2Key.trim() : "";
    const relativePath = typeof file.relativePath === "string" ? normalizeHermesArtifactFilename(file.relativePath) : "";
    if (!r2Key || !relativePath || !isUserFacingHermesArtifact(relativePath)) {
      continue;
    }
    const mimeType = typeof file.mimeType === "string" && file.mimeType.trim().length > 0
      ? file.mimeType
      : defaultMimeTypeForHermesArtifact(relativePath);
    const record = await deps.store.saveArtifact({
      sessionId,
      runtimeId: null,
      r2Key,
      blobRef: r2Key,
      filename: relativePath,
      mimeType,
      byteSize: typeof file.byteSize === "number" ? file.byteSize : null,
      metadata: {
        kind: kindForHermesArtifact(relativePath),
        title: titleForHermesArtifact(relativePath),
        runId,
        hermesJobId: job.id,
        relativePath,
        sourcePath: typeof file.sourcePath === "string" ? file.sourcePath : null,
        archivePrefix: manifest.archivePrefix ?? null,
        hermesArchiveStatus: loadHermesArchiveSummary(job).status,
        previewable: isTextArtifact(relativePath, mimeType),
      },
      createdAt: typeof file.uploadedAt === "string" ? file.uploadedAt : undefined,
    });
    if (!existing.has(r2Key)) {
      imported.push(record);
      existing.add(r2Key);
    }
  }
  return imported;
}

async function persistHermesFallbackArtifacts(
  deps: AppDeps,
  sessionId: string,
  runId: string,
  job: HermesJobSummary,
) {
  const imported: Array<ArtifactRecord> = [];
  const response = await fetchHermesJobArtifacts(
    deps.hermesJobApiUrl!,
    deps.hermesJobApiToken,
    job.id,
  ).catch(() => null);
  const artifacts = Array.isArray(response?.artifacts) ? response.artifacts : [];
  for (const entry of artifacts) {
    const name = typeof entry.name === "string" ? normalizeHermesArtifactFilename(entry.name) : "";
    if (!name) {
      continue;
    }
    const relativePath = name.startsWith("wrapper/") || name.startsWith("inner/") ? name : `inner/${name}`;
    if (!isUserFacingHermesArtifact(relativePath)) {
      continue;
    }
    const mimeType = defaultMimeTypeForHermesArtifact(relativePath);
    if (!isTextArtifact(relativePath, mimeType)) {
      continue;
    }
    const artifact = await fetchHermesArtifact(
      deps.hermesJobApiUrl!,
      deps.hermesJobApiToken,
      job.id,
      normalizeHermesArtifactName(name),
    ).catch(() => null);
    const content = artifact?.artifact.content ?? null;
    if (typeof content !== "string") {
      continue;
    }
    const r2Key = artifactKeys.sessionArtifact(sessionId, `runs/${runId}/hermes-import/${relativePath}`);
    await deps.blobStore.putText(r2Key, content, mimeType);
    imported.push(await deps.store.saveArtifact({
      sessionId,
      runtimeId: null,
      r2Key,
      blobRef: r2Key,
      filename: relativePath,
      mimeType,
      byteSize: typeof entry.bytes === "number" ? entry.bytes : new TextEncoder().encode(content).byteLength,
      metadata: {
        kind: kindForHermesArtifact(relativePath),
        title: titleForHermesArtifact(relativePath),
        runId,
        hermesJobId: job.id,
        relativePath,
        sourcePath: typeof entry.path === "string" ? entry.path : null,
        previewable: true,
        fallbackImported: true,
      },
      createdAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
    }));
  }
  return imported;
}

function buildHermesCompletionAnswer(
  compiledAnswerText: string | null,
  finalSnapshot: HermesSessionSnapshot | null,
  archiveManifest: HermesArchiveManifest | null,
  hitsIndexText?: string | null,
) {
  if (typeof compiledAnswerText === "string" && compiledAnswerText.trim().length > 0) {
    return compiledAnswerText.trim();
  }
  const finalMessages = Array.isArray(finalSnapshot?.messages) ? finalSnapshot.messages : [];
  const finalAssistantMessage = [...finalMessages]
    .reverse()
    .find((message) => message.role === "assistant" && typeof message.content === "string" && message.content.trim().length > 0);
  if (typeof finalAssistantMessage?.content === "string" && finalAssistantMessage.content.trim().length > 0) {
    return finalAssistantMessage.content.trim();
  }
  const parsedHits = parseHermesJsonRecord(hitsIndexText ?? "");
  const keptHitCount =
    typeof parsedHits?.kept_hit_count === "number"
      ? parsedHits.kept_hit_count
      : Array.isArray(parsedHits?.hits)
        ? parsedHits.hits.length
        : null;
  if (keptHitCount !== null) {
    return keptHitCount > 0
      ? `Completed. Open the files panel to inspect \`inner/hits/index.json\` and ${keptHitCount} saved evidence hits.`
      : "Completed. Open the files panel to inspect `inner/hits/index.json`.";
  }
  const importantFiles = (archiveManifest?.files ?? [])
    .map((file) => normalizeHermesArtifactFilename(file.relativePath))
    .filter((path) =>
      path.endsWith("final-answer.md")
      || path.endsWith("scope-report.json")
      || path.endsWith("briefing.md")
      || path.endsWith("hits/index.json")
      || path.endsWith("dataset.csv")
      || path.endsWith("citation-index.json"),
    )
    .slice(0, 3);
  if (importantFiles.length > 0) {
    return `Completed. Open the files panel to inspect ${importantFiles.map((file) => `\`${file}\``).join(", ")}.`;
  }
  return "Completed. Open the files panel to inspect the run artifacts.";
}

async function finalizeHermesRun(
  deps: AppDeps,
  activeRuns: Map<string, ActiveRunState>,
  params: {
    session: SessionRecord;
    runId: string;
    job: HermesJobSummary;
    send?: (event: string, data: Record<string, unknown>) => Promise<void>;
  },
) {
  const currentRun = await deps.store.getRun(params.runId);
  const backgroundJob = await deps.store.getLatestBackgroundJobForRun(params.runId);
  if (!currentRun || currentRun.sessionId !== params.session.id) {
    return { finalized: false, reason: "run_not_found" as const };
  }
  if (isTerminalRunStatus(currentRun.status)) {
    return { finalized: false, reason: "already_terminal" as const };
  }

  const archiveManifest = await loadHermesArchiveManifest(deps, params.job);
  const importedArtifacts = archiveManifest
    ? await persistHermesArchiveArtifacts(deps, params.session.id, currentRun.id, params.job, archiveManifest)
    : await persistHermesFallbackArtifacts(deps, params.session.id, currentRun.id, params.job);

  for (const artifact of importedArtifacts) {
    await publishPersistedHermesEvent(
      deps,
      activeRuns ?? new Map(),
      currentRun.id,
      params.session.id,
      "artifact.created",
      {
        runId: currentRun.id,
        sessionId: params.session.id,
        artifact,
      },
      params.send,
    );
  }

  if (importedArtifacts.length > 0) {
    await publishPersistedHermesEvent(
      deps,
      activeRuns ?? new Map(),
      currentRun.id,
      params.session.id,
      "artifacts.updated",
      {
        runId: currentRun.id,
        sessionId: params.session.id,
        count: importedArtifacts.length,
      },
      params.send,
    );
  }

  const briefingMarkdown =
    await loadHermesArchiveText(deps, archiveManifest, (file) => normalizeHermesArtifactFilename(file.relativePath).endsWith("briefing.md"))
    ?? await fetchHermesArtifact(
      deps.hermesJobApiUrl!,
      deps.hermesJobApiToken,
      params.job.id,
      normalizeHermesArtifactName("briefing.md"),
    ).then((response) => response.artifact.content.trim()).catch(() => "");

  const hitsIndexText =
    await loadHermesArchiveText(deps, archiveManifest, (file) => normalizeHermesArtifactFilename(file.relativePath).endsWith("hits/index.json"))
    ?? await fetchHermesArtifact(
      deps.hermesJobApiUrl!,
      deps.hermesJobApiToken,
      params.job.id,
      normalizeHermesArtifactName("hits/index.json"),
    ).then((response) => response.artifact.content).catch(() => null);

  if (briefingMarkdown) {
    const briefingHtml = await renderBriefingHtml(deps, params.session.id, briefingMarkdown);
    await persistResearchDocumentArtifact(deps, params.session.id, currentRun.id, briefingHtml);
  }

  const compiledAnswerMarkdown =
    await loadHermesArchiveText(deps, archiveManifest, (file) => normalizeHermesArtifactFilename(file.relativePath).endsWith("final-answer.md"))
    ?? await fetchHermesArtifact(
      deps.hermesJobApiUrl!,
      deps.hermesJobApiToken,
      params.job.id,
      normalizeHermesArtifactName("final-answer.md"),
    ).then((response) => response.artifact.content.trim()).catch(() => "");

  const sessionArtifactText =
    await loadHermesArchiveText(deps, archiveManifest, (file) => normalizeHermesArtifactFilename(file.relativePath).endsWith("hermes.session.json"))
    ?? await fetchHermesArtifact(
      deps.hermesJobApiUrl!,
      deps.hermesJobApiToken,
      params.job.id,
      normalizeHermesArtifactName("hermes.session.json"),
    ).then((response) => response.artifact.content).catch(() => null);
  const finalSnapshot = parseHermesJsonRecord(sessionArtifactText ?? "") as HermesSessionSnapshot | null;
  const finalAnswer = buildHermesCompletionAnswer(compiledAnswerMarkdown || null, finalSnapshot, archiveManifest, hitsIndexText);

  const archiveSummary = loadHermesArchiveSummary(params.job);
  const bridge = buildHermesBridgeRecord(params.job, {
    finalSnapshot,
  });
  const manifestStatus = typeof params.job.manifestStatus === "string" ? params.job.manifestStatus.trim() : "";
  const runSucceeded =
    params.job.state === "completed"
    && (params.job.exitCode == null || params.job.exitCode === 0)
    && (
      Boolean(compiledAnswerMarkdown)
      || Boolean(briefingMarkdown)
      || Boolean(hitsIndexText)
      || /^completed/iu.test(manifestStatus)
      || (archiveSummary.fileCount ?? 0) > 0
    );

  if (!runSucceeded) {
    const failureMessage =
      finalAnswer && finalAnswer !== "Completed. Open the files panel to inspect the run artifacts."
        ? finalAnswer
        : "Hermes finished without producing the expected artifacts.";
    if (backgroundJob) {
      await deps.store.updateBackgroundJob(backgroundJob.id, {
        status: "failed",
        completedAt: params.job.finishedAt ?? new Date().toISOString(),
        lastHeartbeatAt: params.job.heartbeatAt ?? null,
        phase: params.job.phase ?? null,
        detail: params.job.detail ?? null,
        progressPct: params.job.phaseProgressPct ?? null,
        error: failureMessage,
        metadata: {
          ...bridge,
          manifestStatus: params.job.manifestStatus ?? null,
        },
      });
    }
    await deps.store.appendMessage(params.session.id, "assistant", failureMessage, {
      phase: "error",
      runId: currentRun.id,
      hermes: {
        jobId: params.job.id,
        sessionId: bridge.hermesSessionId,
        model: params.job.model ?? deps.hermesModel ?? null,
        wrapperRunDir: bridge.wrapperRunDir,
        innerRunId: bridge.innerRunId,
        innerRunDir: bridge.innerRunDir,
        archivePrefix: bridge.archivePrefix,
        estimatedCostUsd: params.job.cost?.estimatedCostUsd ?? null,
        archive: archiveSummary,
      },
    });
    await deps.store.updateRun(currentRun.id, terminalRunStateUpdate("failed", new Date().toISOString()));
    await publishPersistedHermesEvent(
      deps,
      activeRuns ?? new Map(),
      currentRun.id,
      params.session.id,
      "run.completed",
      {
        runId: currentRun.id,
        sessionId: params.session.id,
        status: "failed",
        completionMode: "agentic",
        error: failureMessage,
        hermes: {
          jobId: params.job.id,
          sessionId: bridge.hermesSessionId,
          model: params.job.model ?? deps.hermesModel ?? null,
          wrapperRunDir: bridge.wrapperRunDir,
          innerRunId: bridge.innerRunId,
          innerRunDir: bridge.innerRunDir,
          archivePrefix: bridge.archivePrefix,
          estimatedCostUsd: params.job.cost?.estimatedCostUsd ?? null,
          manifestStatus: manifestStatus || null,
          archive: archiveSummary,
        },
      },
      params.send,
    );
    return { finalized: true, status: "failed" as const };
  }

  if (backgroundJob) {
    await deps.store.updateBackgroundJob(backgroundJob.id, {
      status: "completed",
      completedAt: params.job.finishedAt ?? new Date().toISOString(),
      lastHeartbeatAt: params.job.heartbeatAt ?? null,
      phase: params.job.phase ?? null,
      detail: params.job.detail ?? null,
      progressPct: params.job.phaseProgressPct ?? null,
      error: null,
      metadata: {
        ...bridge,
        manifestStatus: params.job.manifestStatus ?? null,
      },
    });
  }
  await persistCompletedAssistantAnswer(deps, {
    sessionId: params.session.id,
    runId: currentRun.id,
    answer: finalAnswer,
    citations: [],
    toolHistory: [],
    send: params.send ?? (async () => {}),
    extraMetadata: {
      hermes: {
        jobId: params.job.id,
        sessionId: bridge.hermesSessionId,
        model: params.job.model ?? deps.hermesModel ?? null,
        wrapperRunDir: bridge.wrapperRunDir,
        innerRunId: bridge.innerRunId,
        innerRunDir: bridge.innerRunDir,
        archivePrefix: bridge.archivePrefix,
        estimatedCostUsd: params.job.cost?.estimatedCostUsd ?? null,
        archive: archiveSummary,
      },
    },
  });
  await deps.store.updateRun(currentRun.id, terminalRunStateUpdate("completed", new Date().toISOString()));
  await publishPersistedHermesEvent(
    deps,
    activeRuns,
    currentRun.id,
    params.session.id,
    "run.completed",
    {
      runId: currentRun.id,
      sessionId: params.session.id,
      status: "completed",
      completionMode: "agentic",
      hermes: {
        jobId: params.job.id,
        sessionId: bridge.hermesSessionId,
        model: params.job.model ?? deps.hermesModel ?? null,
        wrapperRunDir: bridge.wrapperRunDir,
        innerRunId: bridge.innerRunId,
        innerRunDir: bridge.innerRunDir,
        archivePrefix: bridge.archivePrefix,
        estimatedCostUsd: params.job.cost?.estimatedCostUsd ?? null,
        archive: archiveSummary,
      },
    },
    params.send,
  );
  return { finalized: true, status: "completed" as const };
}

async function syncHermesBackgroundJob(
  deps: AppDeps,
  activeRuns: Map<string, ActiveRunState> | undefined,
  params: {
    session: SessionRecord;
    run: RunRecord;
    send?: (event: string, data: Record<string, unknown>) => Promise<void>;
  },
) {
  if (!deps.hermesJobApiUrl) {
    return null;
  }
  const backgroundJob = await deps.store.getLatestBackgroundJobForRun(params.run.id);
  if (!backgroundJob || backgroundJob.provider !== "hermes" || backgroundJobIsTerminal(backgroundJob.status)) {
    return backgroundJob;
  }

  const [{ job }, logUpdate] = await Promise.all([
    fetchHermesJob(deps.hermesJobApiUrl, deps.hermesJobApiToken, backgroundJob.externalJobId),
    fetchHermesJobLogs(
      deps.hermesJobApiUrl,
      deps.hermesJobApiToken,
      backgroundJob.externalJobId,
      backgroundJob.logCursor ?? undefined,
      120,
      "curated",
    ),
  ]);

  const nextStatus = backgroundJobStatusFromHermesJob(job);
  const bridge = buildHermesBridgeRecord(job);
  const nextMetadata = {
    ...bridge,
    manifestStatus: job.manifestStatus ?? null,
    chosenScope: job.chosenScope ?? null,
    scopeRationale: job.scopeRationale ?? null,
  } satisfies Record<string, unknown>;

  await deps.store.updateBackgroundJob(backgroundJob.id, {
    status: nextStatus,
    phase: job.phase ?? null,
    detail: job.detail ?? null,
    progressPct: job.phaseProgressPct ?? null,
    logCursor: logUpdate.nextCursor || backgroundJob.logCursor,
    lastHeartbeatAt: job.heartbeatAt ?? null,
    error: nextStatus === "failed" ? (job.detail ?? "Background job failed.") : null,
    startedAt: job.startedAt ?? backgroundJob.startedAt,
    completedAt: backgroundJobIsTerminal(nextStatus) ? (job.finishedAt ?? new Date().toISOString()) : null,
    metadata: nextMetadata,
  });

  if (backgroundJob.status !== nextStatus) {
    await publishPersistedHermesEvent(
      deps,
      activeRuns ?? new Map(),
      params.run.id,
      params.session.id,
      nextStatus === "running" || nextStatus === "starting" ? "job.started" : "job.updated",
      {
        runId: params.run.id,
        sessionId: params.session.id,
        jobId: backgroundJob.id,
        provider: backgroundJob.provider,
        status: nextStatus,
        phase: job.phase ?? null,
        detail: job.detail ?? null,
        progressPct: job.phaseProgressPct ?? null,
      },
      params.send,
    );
  } else if (
    backgroundJob.phase !== job.phase
    || backgroundJob.detail !== job.detail
    || backgroundJob.progressPct !== job.phaseProgressPct
  ) {
    await publishPersistedHermesEvent(
      deps,
      activeRuns ?? new Map(),
      params.run.id,
      params.session.id,
      "job.progress",
      {
        runId: params.run.id,
        sessionId: params.session.id,
        jobId: backgroundJob.id,
        provider: backgroundJob.provider,
        status: nextStatus,
        phase: job.phase ?? null,
        detail: job.detail ?? null,
        progressPct: job.phaseProgressPct ?? null,
      },
      params.send,
    );
  }

  for (const source of logUpdate.sources) {
    for (const line of source.lines) {
      const text = truncateHermesText(line.trim(), 280);
      if (!text) {
        continue;
      }
      await publishPersistedHermesEvent(
        deps,
        activeRuns ?? new Map(),
        params.run.id,
        params.session.id,
        "job.log",
        {
          runId: params.run.id,
          sessionId: params.session.id,
          jobId: backgroundJob.id,
          provider: backgroundJob.provider,
          source: source.name,
          updatedAt: source.updatedAt,
          text,
        },
        params.send,
      );
    }
  }

  if (backgroundJobIsTerminal(nextStatus)) {
    await finalizeHermesRun(deps, activeRuns ?? new Map(), {
      session: params.session,
      runId: params.run.id,
      job,
      send: params.send,
    });
  }

  return await deps.store.getBackgroundJob(backgroundJob.id);
}

async function buildHermesUserPrompt(
  deps: AppDeps,
  input: ChatRequest,
) {
  const basePrompt = input.message.trim();
  if (!Array.isArray(input.workIds) || input.workIds.length === 0) {
    return basePrompt;
  }
  const workMetadata = await deps.store.getWorkMetadata(input.workIds.slice(0, 12)).catch(() => []);
  if (!Array.isArray(workMetadata) || workMetadata.length === 0) {
    return basePrompt;
  }
  const contextLines = workMetadata.map((work) => {
    const authors = Array.isArray(work.authors) && work.authors.length > 0 ? work.authors.join(", ") : "Unknown author";
    return `- ${work.title} by ${authors} (${work.id})`;
  });
  return [
    basePrompt,
    "",
    "AlphaBook context:",
    "The user currently has these works selected. Treat them as a strong prior when deciding scope and evidence:",
    ...contextLines,
  ].join("\n");
}

async function runHermesConversation(
  deps: AppDeps,
  request: Request,
  input: ChatRequest,
  send: (event: string, data: Record<string, unknown>) => Promise<void>,
  activeRuns: Map<string, ActiveRunState>,
) {
  if (!input.userId) {
    throw new Error("A userId is required to start an Agentic search run.");
  }
  if (!deps.hermesJobApiUrl) {
    throw new Error("Agentic search job API is not configured.");
  }

  await deps.store.ensureUser(input.userId);
  let session: SessionRecord | null = input.sessionId ? await deps.store.getSession(input.sessionId) : null;
  if (session && session.userId !== input.userId) {
    throw new Error("Not authorized for this session.");
  }

  if (!session) {
    session = await deps.store.createSession(input.userId, fallbackSessionTitleFromMessage(input.message));
    await send("session.created", {
      sessionId: session.id,
      title: session.title,
    });
    void (async () => {
      try {
        const generatedTitle = await createSessionTitle(deps, input.message);
        await deps.store.updateSessionTitle(session!.id, generatedTitle);
        await send("session.updated", {
          sessionId: session!.id,
          title: generatedTitle,
        });
      } catch {
        // Ignore title-generation failures for Hermes sessions.
      }
    })();
  }

  const activeSession = session;
  const effectiveHermesWorkflow: "search" = "search";
  const baselineHermesMessageCount = 0;
  await deps.store.appendMessage(activeSession.id, "user", input.message, {
    phase: "user",
  });

  let run = await deps.store.createRun(activeSession.id);
  activeRuns.set(run.id, {
    sessionId: activeSession.id,
    userId: activeSession.userId,
    runtimeIds: new Set<string>(),
    cancelRequested: false,
    rawLog: [],
    subscribers: new Map(),
  });
  let planMessageId: string | null = null;
  let latestPlanTraceVersion = 0;
  let persistedPlanTraceVersion = 0;
  let planTracePersistChain = Promise.resolve();
  let liveToolTrace: LiveToolTraceEntry[] = [];
  let currentToolCallId: string | null = null;
  const hermesProgressToolCallId = "hermes_progress";

  const writeHermesTerminalRunState = async (status: "completed" | "failed" | "timed_out") => {
    const completedAt = new Date().toISOString();
    await deps.store.updateRun(run.id, terminalRunStateUpdate(status, completedAt));
    run = {
      ...run,
      status,
      completedAt,
      activeToolCallId: null,
    };
  };

  const failHermesRun = async (message: string) => {
    const currentRun = await deps.store.getRun(run.id);
    if (currentRun && isTerminalRunStatus(currentRun.status)) {
      return;
    }
    const backgroundJob = await deps.store.getLatestBackgroundJobForRun(run.id);
    if (backgroundJob && !backgroundJobIsTerminal(backgroundJob.status)) {
      await deps.store.updateBackgroundJob(backgroundJob.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: message,
      });
    }
    await deps.store.appendMessage(activeSession.id, "assistant", message, {
      phase: "error",
      runId: run.id,
    });
    await writeHermesTerminalRunState("failed");
    await emit("run.completed", {
      runId: run.id,
      sessionId: activeSession.id,
      status: "failed",
      completionMode: "agentic",
      error: message,
    });
  };

  const persistLatestPlanToolTrace = async () => {
    if (!planMessageId) {
      return;
    }
    const version = ++latestPlanTraceVersion;
    const snapshot = compactPlanToolTraceEntriesForPersistence(cloneLiveToolTraceEntries(liveToolTrace));
    const queuedWrite = planTracePersistChain.then(async () => {
      if (version <= persistedPlanTraceVersion || version !== latestPlanTraceVersion) {
        return;
      }
      await deps.store.updateMessageMetadata(planMessageId!, {
        phase: "plan",
        runId: run.id,
        toolCalls: snapshot,
      });
      persistedPlanTraceVersion = version;
    });
    planTracePersistChain = queuedWrite.catch(() => {});
    await queuedWrite;
  };

  const emit = async (event: string, data: Record<string, unknown>) => {
    const persistable = new Set([
      "run.started",
      "assistant.plan",
      "job.started",
      "job.progress",
      "job.log",
      "job.updated",
      "tool.started",
      "tool.progress",
      "tool.completed",
      "assistant.completed",
      "run.completed",
    ]);
    if (persistable.has(event)) {
      await deps.store.appendRunEvent(run.id, activeSession.id, event, data);
    }
    await send(event, data);
    const activeRun = activeRuns.get(run.id);
    if (!activeRun || activeRun.subscribers.size === 0) {
      return;
    }
    const subscribers = [...activeRun.subscribers.values()];
    await Promise.all(subscribers.map(async (subscriber) => {
      try {
        await subscriber(event, data);
      } catch {
        // Ignore subscriber disconnect races.
      }
    }));
  };

  const planText = "Starting an Agentic search run on this thread and streaming the tool activity here.";
  const planMessage = await deps.store.appendMessage(activeSession.id, "assistant", planText, {
    phase: "plan",
    runId: run.id,
  });
  planMessageId = planMessage.id;
  await persistLatestPlanToolTrace();

  await emit("run.started", {
    runId: run.id,
    sessionId: activeSession.id,
  });
  await emit("assistant.plan", {
    runId: run.id,
    sessionId: activeSession.id,
    messageId: planMessage.id,
    text: planText,
  });

  let job: HermesJobSummary;

  const updateHermesPlanMetadata = async () => {
    if (!planMessageId) {
      return;
    }
    const bridge = buildHermesBridgeRecord(job);
    await deps.store.updateMessageMetadata(planMessageId, {
      phase: "plan",
      runId: run.id,
      hermes: {
        jobId: job.id,
        sessionId: bridge.hermesSessionId,
        model: job.model,
        wrapperRunDir: bridge.wrapperRunDir,
        innerRunId: bridge.innerRunId,
        innerRunDir: bridge.innerRunDir,
        archivePrefix: bridge.archivePrefix,
        estimatedCostUsd: job.cost?.estimatedCostUsd ?? null,
      },
      toolCalls: compactPlanToolTraceEntriesForPersistence(cloneLiveToolTraceEntries(liveToolTrace)),
    });
  };

  const ensureHermesProgressTool = async () => {
    const existing = liveToolTrace.find((entry) => entry.id === hermesProgressToolCallId);
    if (existing) {
      return existing;
    }
    const entry: LiveToolTraceEntry = {
      id: hermesProgressToolCallId,
      toolName: "run_workspace_task",
      label: "Agentic Search Progress",
      rationale: "Streaming wrapper and inner-run progress while agentic search is running.",
      progress: ["Agentic search launched."],
      sourceArgs: {
        __toolName: "run_workspace_task",
        __hermesSyntheticProgress: true,
      },
      args: canonicalToolArgs(
        "run_workspace_task",
        {
          __toolName: "run_workspace_task",
          __hermesSyntheticProgress: true,
        },
        "Streaming wrapper and inner-run progress while agentic search is running.",
        ["Agentic search launched."],
      ),
      state: "running",
    };
    liveToolTrace = [...liveToolTrace, entry];
    await persistLatestPlanToolTrace();
    await emit("tool.started", {
      runId: run.id,
      sessionId: activeSession.id,
      toolCallId: entry.id,
      toolName: entry.toolName,
      label: entry.label,
      args: entry.args,
    });
    return entry;
  };

  let backgroundJobId: string | null = null;

  try {
    const hermesUserPrompt = await buildHermesUserPrompt(deps, input);
    const archivePrefix = artifactKeys.sessionArtifact(activeSession.id, `runs/${run.id}/hermes`);
    const launchPayload = {
      userPrompt: hermesUserPrompt,
      workflow: effectiveHermesWorkflow,
      effort: hermesSearchEffort({
        ...input,
        workflow: effectiveHermesWorkflow,
      }),
      model: deps.hermesModel,
      maxTurns: deps.hermesMaxTurns,
      alphabookSessionId: activeSession.id,
      alphabookRunId: run.id,
      archivePrefix,
    };
    const launchResult = await createHermesJob(deps.hermesJobApiUrl, deps.hermesJobApiToken, launchPayload);
    job = launchResult.job;
    const bridge = buildHermesBridgeRecord(job, {
      archivePrefix,
    });
    const backgroundJob = await deps.store.createBackgroundJob({
      runId: run.id,
      sessionId: activeSession.id,
      provider: "hermes",
      externalJobId: job.id,
      status: backgroundJobStatusFromHermesJob(job),
      phase: job.phase ?? null,
      detail: job.detail ?? null,
      progressPct: job.phaseProgressPct ?? null,
      lastHeartbeatAt: job.heartbeatAt ?? null,
      startedAt: job.startedAt ?? null,
      metadata: {
        ...bridge,
        manifestStatus: job.manifestStatus ?? null,
      },
    });
    backgroundJobId = backgroundJob.id;
    await emit("job.started", {
      runId: run.id,
      sessionId: activeSession.id,
      provider: "hermes",
      externalJobId: job.id,
      status: backgroundJobStatusFromHermesJob(job),
      phase: job.phase ?? null,
      detail: job.detail ?? null,
      progressPct: job.phaseProgressPct ?? null,
    });
    await updateHermesPlanMetadata();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hermes run failed before launch.";
    await failHermesRun(message);
    activeRuns.delete(run.id);
    return;
  }

  const seenToolCallIds = new Set<string>();
  const completedToolCallIds = new Set<string>();
  let logCursor: string | undefined;
  let lastSessionMessageCount = baselineHermesMessageCount;

  const appendToolProgress = async (text: string, detail?: Record<string, unknown>, toolCallId?: string | null) => {
    const targetToolCallId = toolCallId ?? currentToolCallId;
    let toolEntry = targetToolCallId
      ? liveToolTrace.find((entry) => entry.id === targetToolCallId)
      : null;
    if (!toolEntry && !targetToolCallId) {
      toolEntry = await ensureHermesProgressTool();
    }
    if (!toolEntry) {
      return;
    }
    const normalizedText = truncateHermesText(text, 280);
    if (!normalizedText) {
      return;
    }
    if (toolEntry.progress[toolEntry.progress.length - 1] !== normalizedText) {
      toolEntry.progress.push(normalizedText);
    }
    if (detail) {
      toolEntry.progressDetails = [...(toolEntry.progressDetails ?? []), detail];
    }
    await persistLatestPlanToolTrace();
    await emit("tool.progress", {
      runId: run.id,
      sessionId: activeSession.id,
      toolCallId: toolEntry.id,
      toolName: toolEntry.toolName,
      text: normalizedText,
      ...(detail ? { detail } : {}),
    });
  };

  const syncHermesSessionSnapshot = async () => {
    let snapshotText: string | null = null;
    try {
      const artifact = await fetchHermesArtifact(
        deps.hermesJobApiUrl!,
        deps.hermesJobApiToken,
        job.id,
        normalizeHermesArtifactName("hermes.session.json"),
      );
      snapshotText = artifact.artifact.content;
    } catch {
      return;
    }
    if (!snapshotText) {
      return;
    }
    const snapshot = parseHermesJsonRecord(snapshotText) as HermesSessionSnapshot | null;
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
    if (messages.length === 0 || messages.length <= lastSessionMessageCount) {
      if (typeof snapshot?.session_id === "string" && snapshot.session_id.trim().length > 0 && !job.hermesSessionId) {
        job = { ...job, hermesSessionId: snapshot.session_id.trim() };
        await updateHermesPlanMetadata();
      }
      return;
    }
    const newMessages = messages.slice(lastSessionMessageCount);
    lastSessionMessageCount = messages.length;
    if (typeof snapshot?.session_id === "string" && snapshot.session_id.trim().length > 0) {
      job = { ...job, hermesSessionId: snapshot.session_id.trim() };
      await updateHermesPlanMetadata();
    }

    for (const message of newMessages) {
      if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          const toolCallId = typeof toolCall.call_id === "string" && toolCall.call_id.length > 0
            ? toolCall.call_id
            : typeof toolCall.id === "string" && toolCall.id.length > 0
              ? toolCall.id
              : null;
          if (!toolCallId || seenToolCallIds.has(toolCallId)) {
            continue;
          }
          seenToolCallIds.add(toolCallId);
          currentToolCallId = toolCallId;
          const functionName = typeof toolCall.function?.name === "string" ? toolCall.function.name : "hermes_step";
          const sourceArgs = {
            ...(parseHermesJsonRecord(toolCall.function?.arguments ?? "") ?? {}),
            __hermesFunctionName: functionName,
          };
          const presentation = describeHermesToolCall(functionName, sourceArgs);
          const entry: LiveToolTraceEntry = {
            id: toolCallId,
            toolName: "run_workspace_task",
            label: presentation.label,
            ...(presentation.summary ? { rationale: presentation.summary } : {}),
            ...(presentation.summary ? { progress: [presentation.summary] } : { progress: [] }),
            sourceArgs,
            args: canonicalToolArgs(
              "run_workspace_task",
              sourceArgs,
              presentation.summary ?? undefined,
              presentation.summary ? [presentation.summary] : [],
            ),
            state: "running",
          };
          liveToolTrace = [...liveToolTrace, entry];
          await persistLatestPlanToolTrace();
          await emit("tool.started", {
            runId: run.id,
            sessionId: activeSession.id,
            toolCallId,
            toolName: entry.toolName,
            label: entry.label,
            args: entry.args,
          });
        }
      }
      if (message.role === "tool" && typeof message.tool_call_id === "string" && message.tool_call_id.length > 0) {
        const toolCallId = message.tool_call_id;
        if (completedToolCallIds.has(toolCallId)) {
          continue;
        }
        const toolEntry = liveToolTrace.find((entry) => entry.id === toolCallId);
        if (!toolEntry) {
          continue;
        }
        const summarized = summarizeHermesToolResult(
          message.content,
          typeof toolEntry.sourceArgs.__hermesFunctionName === "string" ? toolEntry.sourceArgs.__hermesFunctionName : undefined,
          toolEntry.sourceArgs,
        );
        if (summarized.text) {
          toolEntry.progress.push(summarized.text);
        }
        toolEntry.result = summarized.result;
        toolEntry.state = "completed";
        currentToolCallId = null;
        completedToolCallIds.add(toolCallId);
        await persistLatestPlanToolTrace();
        if (summarized.text) {
          await emit("tool.progress", {
            runId: run.id,
            sessionId: activeSession.id,
            toolCallId,
            toolName: toolEntry.toolName,
            text: summarized.text,
          });
        }
        await emit("tool.completed", {
          runId: run.id,
          sessionId: activeSession.id,
          toolCallId,
          toolName: toolEntry.toolName,
          label: toolEntry.label,
          status: "completed",
          result: summarized.result,
        });
      }
    }
  };

  const heartbeatProgressSources = new Set(["launcher", "heartbeat", "run_log", "stream_log", "hermes_stdout", "hermes_stderr"]);
  const isHeartbeatProgressSource = (name: string) =>
    heartbeatProgressSources.has(name)
    || name.startsWith("ripgrep_progress:")
    || name.startsWith("ripgrep_status:");

  try {
    while (true) {
      const persistedRun = await deps.store.getRun(run.id);
      if (!persistedRun || persistedRun.sessionId !== activeSession.id) {
        throw new Error("Hermes run disappeared while it was still active.");
      }
      run = persistedRun;
      if (isTerminalRunStatus(run.status)) {
        return;
      }
      const activeRun = activeRuns.get(run.id);
      if (activeRun?.cancelRequested) {
        await cancelHermesJob(deps.hermesJobApiUrl, deps.hermesJobApiToken, job.id).catch(() => {});
        throw new Error("Hermes run cancelled by user.");
      }
      const [jobState, logUpdate] = await Promise.all([
        fetchHermesJob(deps.hermesJobApiUrl, deps.hermesJobApiToken, job.id),
        fetchHermesJobLogs(deps.hermesJobApiUrl, deps.hermesJobApiToken, job.id, logCursor, 120),
      ]);
      job = jobState.job;
      logCursor = logUpdate.nextCursor;
      if (backgroundJobId) {
        await deps.store.updateBackgroundJob(backgroundJobId, {
          status: backgroundJobStatusFromHermesJob(job),
          phase: job.phase ?? null,
          detail: job.detail ?? null,
          progressPct: job.phaseProgressPct ?? null,
          logCursor: logCursor ?? null,
          lastHeartbeatAt: job.heartbeatAt ?? null,
          startedAt: job.startedAt ?? null,
          completedAt: backgroundJobIsTerminal(backgroundJobStatusFromHermesJob(job))
            ? (job.finishedAt ?? new Date().toISOString())
            : null,
          metadata: {
            ...buildHermesBridgeRecord(job),
            manifestStatus: job.manifestStatus ?? null,
            chosenScope: job.chosenScope ?? null,
            scopeRationale: job.scopeRationale ?? null,
          },
        });
        await emit("job.progress", {
          runId: run.id,
          sessionId: activeSession.id,
          jobId: backgroundJobId,
          provider: "hermes",
          status: backgroundJobStatusFromHermesJob(job),
          phase: job.phase ?? null,
          detail: job.detail ?? null,
          progressPct: job.phaseProgressPct ?? null,
        });
      }
      await updateHermesPlanMetadata();

      for (const source of logUpdate.sources) {
        if (!isHeartbeatProgressSource(source.name)) {
          continue;
        }
        for (const line of source.lines) {
          const text = line.trim();
          if (!text) {
            continue;
          }
          if (backgroundJobId) {
            await emit("job.log", {
              runId: run.id,
              sessionId: activeSession.id,
              jobId: backgroundJobId,
              provider: "hermes",
              source: source.name,
              updatedAt: source.updatedAt,
              text: truncateHermesText(text, 280),
            });
          }
          await appendToolProgress(text, {
            source: source.name,
            updatedAt: source.updatedAt,
          }, currentToolCallId);
        }
      }

      await syncHermesSessionSnapshot();

      if (!job.running && job.state !== "running" && job.state !== "launching") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    const hermesProgressEntry = liveToolTrace.find((entry) => entry.id === hermesProgressToolCallId);
    if (hermesProgressEntry && hermesProgressEntry.state !== "completed") {
      hermesProgressEntry.state = "completed";
      hermesProgressEntry.result = {
        ok: true,
        __summary: "Agentic search progress stream completed.",
      };
      await persistLatestPlanToolTrace();
      await emit("tool.completed", {
        runId: run.id,
        sessionId: activeSession.id,
        toolCallId: hermesProgressToolCallId,
        toolName: hermesProgressEntry.toolName,
        label: hermesProgressEntry.label,
        status: "completed",
        result: hermesProgressEntry.result,
      });
    }

    await syncHermesSessionSnapshot();
    await finalizeHermesRun(deps, activeRuns, {
      session: activeSession,
      runId: run.id,
      job,
      send,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hermes run failed.";
    await failHermesRun(message);
  } finally {
    activeRuns.delete(run.id);
  }
}

export async function runOrchestrator(
  deps: AppDeps,
  request: Request,
  input: ChatRequest,
  send: (event: string, data: Record<string, unknown>) => Promise<void>,
  activeRuns: Map<string, ActiveRunState>,
  options: RunOrchestratorOptions = {},
): Promise<void> {
  const originalSend = send;
  let rawLogSequence = 0;
  const rawRunLog: ToolRunRawLogEntry[] = [];
  let session: SessionRecord | null = input.sessionId ? await deps.store.getSession(input.sessionId) : null;
  let run!: Awaited<ReturnType<AppStore["createRun"]>>;
  let runCreated = false;
  const recordRawLog = (event: string, payload: Record<string, unknown>) => {
    rawRunLog.push({
      seq: rawLogSequence,
      timestamp: new Date().toISOString(),
      event,
      payload,
    });
    rawLogSequence += 1;
    scheduleRawLogPersist(false);
  };
  async function maybeCreateToolLifecycleNotification(event: string, data: Record<string, unknown>) {
    if (!session || !runCreated) {
      return;
    }
    if (event !== "tool.started" && event !== "tool.completed") {
      return;
    }
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : null;
    const toolName = typeof data.toolName === "string" ? data.toolName as ToolName : null;
    if (!toolCallId || !toolName) {
      return;
    }
    const status =
      event === "tool.started"
        ? "started"
        : typeof data.status === "string" && (data.status === "completed" || data.status === "failed" || data.status === "timed_out")
          ? data.status
          : "completed";
    await deps.store.createNotification(
      buildToolNotification({
        session,
        sessionTitle: session.title,
        runId: run.id,
        toolCallId,
        toolName,
        label: typeof data.label === "string" ? data.label : null,
        status,
      }),
    );
  }
  async function maybeCreateRunCompletionNotification(data: Record<string, unknown>) {
    if (!session || !runCreated) {
      return;
    }
    const status =
      typeof data.status === "string" && (data.status === "completed" || data.status === "failed" || data.status === "timed_out")
        ? data.status
        : null;
    if (!status) {
      return;
    }
    const notification = await deps.store.createNotification(
      buildRunNotification({
        session,
        sessionTitle: session.title,
        runId: run.id,
        status,
        completionMode: typeof data.completionMode === "string" ? data.completionMode : null,
      }),
    );
    if (notification.emailedAt || notification.metadata.emailStatus === "sent" || notification.metadata.emailStatus === "skipped") {
      return;
    }
    const user = await deps.store.getUserProfile(session.userId);
    if (!user?.email) {
      await deps.store.updateNotification(notification.id, notification.userId, {
        metadata: {
          ...notification.metadata,
          emailStatus: "skipped",
          emailReason: "missing_email",
        },
      });
      return;
    }
    try {
      const emailResult = await sendRunCompletionEmail(deps, {
        email: user.email,
        runId: run.id,
        session,
        sessionTitle: session.title,
        status,
      });
      await deps.store.updateNotification(notification.id, notification.userId, {
        metadata: {
          ...notification.metadata,
          ...emailResult.metadata,
        },
        emailedAt: emailResult.emailedAt ?? null,
      });
    } catch (error) {
      recordRawLog("notification.email_failed", {
        notificationId: notification.id,
        runId: run.id,
        userId: notification.userId,
        error: error instanceof Error ? error.message : "Unknown notification email error",
      });
      await deps.store.updateNotification(notification.id, notification.userId, {
        metadata: {
          ...notification.metadata,
          emailStatus: "failed",
          emailError: error instanceof Error ? error.message : "Unknown notification email error",
        },
      });
    }
  }
  async function fanOutNotifications(event: string, data: Record<string, unknown>) {
    try {
      await maybeCreateToolLifecycleNotification(event, data);
      if (event === "run.completed") {
        await maybeCreateRunCompletionNotification(data);
      }
    } catch (error) {
      recordRawLog("notification.dispatch_failed", {
        event,
        runId: run?.id ?? null,
        error: error instanceof Error ? error.message : "Unknown notification dispatch error",
      });
    }
  }
  const started = deps.now?.() ?? Date.now();
  const runMetrics = createLiveRunMetricsState(started);
  const captureTaskSpecRunMetrics = (taskSpec: Record<string, unknown>) => {
    const workIds = Array.isArray(taskSpec.workIds) ? taskSpec.workIds : [];
    if (typeof taskSpec.parallelism === "number" && taskSpec.parallelism > 0) {
      runMetrics.plannedParallelShards = Math.max(runMetrics.plannedParallelShards, taskSpec.parallelism);
    }
    const verifiedChunkIds = Array.isArray(taskSpec.verifiedChunkIds)
      ? taskSpec.verifiedChunkIds.filter((value): value is string => typeof value === "string")
      : [];
    const verifiedWorkIds = Array.isArray(taskSpec.verifiedWorkIds)
      ? taskSpec.verifiedWorkIds.filter((value): value is string => typeof value === "string")
      : [];
    runMetrics.verifiedChunksAtVmHandoff = Math.max(runMetrics.verifiedChunksAtVmHandoff, verifiedChunkIds.length);
    runMetrics.verifiedWorksAtVmHandoff = Math.max(runMetrics.verifiedWorksAtVmHandoff, verifiedWorkIds.length);
    const followUpReuseMetrics =
      taskSpec.followUpReuseMetrics && typeof taskSpec.followUpReuseMetrics === "object"
        ? taskSpec.followUpReuseMetrics as Record<string, unknown>
        : null;
    if (followUpReuseMetrics) {
      if (typeof followUpReuseMetrics.frontierWorkCount === "number") {
        runMetrics.reusedPriorFrontierWorks = Math.max(
          runMetrics.reusedPriorFrontierWorks,
          followUpReuseMetrics.frontierWorkCount,
        );
      }
      if (typeof followUpReuseMetrics.verifiedWorkCount === "number") {
        runMetrics.reusedPriorVerifiedWorks = Math.max(
          runMetrics.reusedPriorVerifiedWorks,
          followUpReuseMetrics.verifiedWorkCount,
        );
      }
      if (typeof followUpReuseMetrics.chunkCount === "number") {
        runMetrics.reusedPriorChunks = Math.max(runMetrics.reusedPriorChunks, followUpReuseMetrics.chunkCount);
      }
    }
    const plannedFrontierWorks =
      Array.isArray(taskSpec.frontierWorkIds)
        ? taskSpec.frontierWorkIds.length
        : typeof taskSpec.searchPlan === "object" && taskSpec.searchPlan && typeof (taskSpec.searchPlan as Record<string, unknown>).recommendedFrontierWorks === "number"
          ? (taskSpec.searchPlan as Record<string, unknown>).recommendedFrontierWorks as number
          : Array.isArray(taskSpec.candidateWorkIds)
            ? taskSpec.candidateWorkIds.length
            : workIds.length;
    runMetrics.plannedFrontierWorks = Math.max(runMetrics.plannedFrontierWorks, plannedFrontierWorks);
    for (const workId of workIds) {
      if (typeof workId === "string" && workId.length > 0) {
        runMetrics.selectedWorkspaceBookIds.add(workId);
      }
    }
  };
  const captureToolResultRunMetrics = (toolName: string, result: Record<string, unknown>) => {
    if (toolName === "estimate_research_scope") {
      const probeWorks = Array.isArray(result.probeWorks) ? result.probeWorks : [];
      const metadataWorkEstimate = typeof result.metadataWorkEstimate === "number" ? result.metadataWorkEstimate : 0;
      const chunkWorkEstimate = typeof result.chunkWorkEstimate === "number" ? result.chunkWorkEstimate : 0;
      runMetrics.estimatedTrueBreadthBooks = Math.max(
        runMetrics.estimatedTrueBreadthBooks,
        metadataWorkEstimate,
        chunkWorkEstimate,
        probeWorks.length,
      );
      runMetrics.probeBooksShown = Math.max(runMetrics.probeBooksShown, probeWorks.length);
      if (typeof result.recommendedParallelism === "number" && result.recommendedParallelism > 0) {
        runMetrics.plannedParallelShards = Math.max(runMetrics.plannedParallelShards, result.recommendedParallelism);
      }
      if (typeof result.recommendedFrontierWorks === "number" && result.recommendedFrontierWorks > 0) {
        runMetrics.plannedFrontierWorks = Math.max(runMetrics.plannedFrontierWorks, result.recommendedFrontierWorks);
      }
      return;
    }
    if (toolName === "search_works") {
      const frontier =
        result.frontier && typeof result.frontier === "object"
          ? result.frontier as Record<string, unknown>
          : null;
      const frontierCount = typeof frontier?.workCount === "number"
        ? frontier.workCount
        : Array.isArray(frontier?.works)
          ? frontier.works.length
          : Array.isArray(result.works)
            ? result.works.length
            : 0;
      if (frontierCount > 0) {
        runMetrics.estimatedTrueBreadthBooks = Math.max(runMetrics.estimatedTrueBreadthBooks, frontierCount);
      }
      return;
    }
    if (toolName === "run_workspace_task" && Array.isArray(result.shardResults)) {
      runMetrics.actualShardRuns = Math.max(runMetrics.actualShardRuns, result.shardResults.length);
      runMetrics.successfulShardRuns = Math.max(
        runMetrics.successfulShardRuns,
        result.shardResults.filter((value) => value && typeof value === "object" && (value as Record<string, unknown>).ok === true).length,
      );
    }
  };
  send = async (event: string, data: Record<string, unknown>) => {
    let nextData = data;
    const persistableRunEventNames = new Set([
      "run.started",
      "assistant.plan",
      "tool.started",
      "tool.progress",
      "tool.completed",
      "assistant.completed",
      "run.completed",
    ]);
    if (event === "tool.started") {
      currentActiveToolCallId = typeof data.toolCallId === "string" ? data.toolCallId : currentActiveToolCallId;
    } else if (event === "tool.completed") {
      const completedToolCallId = typeof data.toolCallId === "string" ? data.toolCallId : null;
      if (completedToolCallId && currentActiveToolCallId === completedToolCallId) {
        currentActiveToolCallId = null;
      }
    } else if (event === "run.completed") {
      currentActiveToolCallId = null;
    }
    const nowMs = deps.now?.() ?? Date.now();
    if (event === "tool.started") {
      const toolName = typeof data.toolName === "string" ? data.toolName : "";
      const args = data.args && typeof data.args === "object" ? data.args as Record<string, unknown> : null;
      if (toolName === "run_workspace_task" && args?.taskSpec && typeof args.taskSpec === "object") {
        captureTaskSpecRunMetrics(args.taskSpec as Record<string, unknown>);
      }
    }
    if (event === "tool.progress") {
      const detail = data.detail && typeof data.detail === "object" ? data.detail as Record<string, unknown> : null;
      const detailType = typeof detail?.type === "string" ? detail.type : "";
      if (detailType === "research.work") {
        const workId = typeof detail?.workId === "string" ? detail.workId : null;
        if (workId) {
          runMetrics.documentBookIds.add(workId);
          runMetrics.vmTouchedBookIds.add(workId);
          if (runMetrics.firstBookMentionAtMs === null) {
            runMetrics.firstBookMentionAtMs = nowMs;
          }
        }
      }
      if (detailType === "research.chunk") {
        const workId = typeof detail?.workId === "string" ? detail.workId : null;
        const chunkId = typeof detail?.chunkId === "string"
          ? detail.chunkId
          : `${workId ?? "work"}:${typeof detail?.chunkIndex === "number" ? detail.chunkIndex : runMetrics.mentionedChunkIds.size}`;
        if (workId) {
          runMetrics.documentBookIds.add(workId);
          runMetrics.vmTouchedBookIds.add(workId);
          if (runMetrics.firstBookMentionAtMs === null) {
            runMetrics.firstBookMentionAtMs = nowMs;
          }
        }
        runMetrics.mentionedChunkIds.add(chunkId);
        if (runMetrics.firstPrimarySourceAtMs === null) {
          runMetrics.firstPrimarySourceAtMs = nowMs;
        }
      }
      if (
        detailType === "codex.step.attempt"
        || detailType === "codex.stdout"
        || detailType === "codex.stderr"
      ) {
        if (runMetrics.firstCodexCliStartAtMs === null) {
          runMetrics.firstCodexCliStartAtMs = nowMs;
        }
      }
    }
    if (event === "tool.completed") {
      const toolName = typeof data.toolName === "string" ? data.toolName : "";
      const result = data.result && typeof data.result === "object" ? data.result as Record<string, unknown> : {};
      captureToolResultRunMetrics(toolName, result);
      const candidateWorkIds = uniqueWorkIds([
        ...collectWorkIdsFromWorks(result.works),
        ...collectWorkIdsFromFrontier(result.frontier),
      ]);
      for (const workId of candidateWorkIds) {
        runMetrics.candidateBookIds.add(workId);
        runMetrics.documentBookIds.add(workId);
      }
      if (candidateWorkIds.length > 0 && runMetrics.firstBookMentionAtMs === null) {
        runMetrics.firstBookMentionAtMs = nowMs;
      }
      const chunkWorkIds = collectWorkIdsFromChunks(result.chunks);
      const chunkIds = collectChunkIds(result.chunks);
      for (const workId of chunkWorkIds) {
        runMetrics.documentBookIds.add(workId);
      }
      for (const chunkId of chunkIds) {
        runMetrics.mentionedChunkIds.add(chunkId);
      }
      if (chunkIds.length > 0 && runMetrics.firstPrimarySourceAtMs === null) {
        runMetrics.firstPrimarySourceAtMs = nowMs;
      }
      if (toolName === "create_workspace") {
        for (const workId of collectWorkIdsFromManifest(result.manifest)) {
          runMetrics.documentBookIds.add(workId);
          runMetrics.selectedWorkspaceBookIds.add(workId);
        }
        if (data.status === "completed" && runMetrics.workspaceReadyAtMs === null) {
          runMetrics.workspaceReadyAtMs = nowMs;
        }
      }
    }
    if (event === "assistant.completed" && Array.isArray(data.citations)) {
      for (const citation of data.citations as Array<Record<string, unknown>>) {
        const workId = typeof citation.workId === "string" ? citation.workId : null;
        const chunkId = typeof citation.chunkId === "string" ? citation.chunkId : null;
        if (workId) {
          runMetrics.activeBookIds.add(workId);
          runMetrics.documentBookIds.add(workId);
          if (runMetrics.firstBookMentionAtMs === null) {
            runMetrics.firstBookMentionAtMs = nowMs;
          }
        }
        if (chunkId) {
          runMetrics.mentionedChunkIds.add(chunkId);
          if (runMetrics.firstPrimarySourceAtMs === null) {
            runMetrics.firstPrimarySourceAtMs = nowMs;
          }
        }
      }
    }
    if (event === "run.completed") {
      runMetrics.completionMode =
        typeof data.completionMode === "string"
          ? data.completionMode
          : typeof data.status === "string" && data.status !== "completed"
            ? data.status
            : runMetrics.completionMode;
      const metrics = buildRunMetricsSnapshot(
        runMetrics,
        typeof data.status === "string" ? data.status : "completed",
        nowMs,
      );
      nextData = { ...nextData, metrics };
      if (!runMetrics.recorded) {
        runMetrics.recorded = true;
        recordRawLog("run.metrics", metrics as unknown as Record<string, unknown>);
        const analyticsSummary = buildRunMetricsAnalyticsSummary(
          activeSession.id,
          typeof data.runId === "string" ? data.runId : (run?.id ?? crypto.randomUUID()),
          activeSession.userId,
          metrics,
        );
        void recordAnalyticsEvent(deps, request, "run_metrics_summary", analyticsSummary).catch(() => {});
      }
    }
    const persistedRunId = typeof nextData.runId === "string" ? nextData.runId : null;
    const persistedSessionId = typeof nextData.sessionId === "string" ? nextData.sessionId : session?.id ?? null;
    if (persistedRunId && persistedSessionId && persistableRunEventNames.has(event)) {
      await deps.store.appendRunEvent(persistedRunId, persistedSessionId, event, nextData);
    }
    try {
      await originalSend(event, nextData);
    } catch (error) {
      recordRawLog("stream.send_failed", {
        event,
        runId: persistedRunId,
        sessionId: persistedSessionId,
        error: error instanceof Error ? error.message : "Unknown stream send error",
      });
    }
    await fanOutNotifications(event, nextData);
    const runId = typeof nextData.runId === "string" ? nextData.runId : null;
    if (!runId) {
      return;
    }
    const activeRun = activeRuns.get(runId);
    if (!activeRun || activeRun.subscribers.size === 0) {
      return;
    }
    const subscribers = [...activeRun.subscribers.values()];
    await Promise.all(subscribers.map(async (subscriber) => {
      try {
        await subscriber(event, nextData);
      } catch {
        // Ignore subscriber disconnect races.
      }
    }));
  };
  if (!input.userId) {
    throw new Error("A userId is required to start an orchestrator run.");
  }
  await deps.store.ensureUser(input.userId);
  let liveResearchDocumentHtml = "";
  const appendedResearchDocumentKeys = new Set<string>();
  let latestPlanTraceVersion = 0;
  let persistedPlanTraceVersion = 0;
  let planTracePersistChain = Promise.resolve();
  let rawLogPersistChain = Promise.resolve();
  let rawLogPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let rawLogPersistScheduled = false;
  let rawLogPersistedLength = 0;
  let researchDocumentPersistChain = Promise.resolve();
  let researchDocumentPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let researchDocumentPersistScheduled = false;
  let persistedResearchDocumentHtml = "";
  let pendingSessionTitleUpdate: Promise<void> | null = null;

  const persistRawLogSnapshot = async () => {
    if (!session || !run || rawRunLog.length === rawLogPersistedLength) {
      return;
    }
    await persistRunStreamArtifact(deps, session.id, run.id, rawRunLog);
    rawLogPersistedLength = rawRunLog.length;
  };

  const scheduleRawLogPersist = (force = false) => {
    if (!session || !run) {
      return;
    }
    if (force) {
      if (rawLogPersistTimer) {
        clearTimeout(rawLogPersistTimer);
        rawLogPersistTimer = null;
      }
      rawLogPersistScheduled = false;
      rawLogPersistChain = rawLogPersistChain.then(persistRawLogSnapshot).catch(() => {});
      return;
    }
    if (rawLogPersistScheduled || rawLogPersistTimer) {
      return;
    }
    rawLogPersistScheduled = true;
    rawLogPersistTimer = setTimeout(() => {
      rawLogPersistTimer = null;
      rawLogPersistScheduled = false;
      rawLogPersistChain = rawLogPersistChain.then(persistRawLogSnapshot).catch(() => {});
    }, 300);
  };

  const persistResearchDocumentSnapshot = async () => {
    if (!session || !run) {
      return;
    }
    const html = liveResearchDocumentHtml.trim();
    if (!html || html === persistedResearchDocumentHtml) {
      return;
    }
    await persistResearchDocumentArtifact(deps, session.id, run.id, liveResearchDocumentHtml);
    persistedResearchDocumentHtml = html;
  };

  const scheduleResearchDocumentPersist = (force = false) => {
    if (!session || !run) {
      return;
    }
    if (force) {
      if (researchDocumentPersistTimer) {
        clearTimeout(researchDocumentPersistTimer);
        researchDocumentPersistTimer = null;
      }
      researchDocumentPersistScheduled = false;
      researchDocumentPersistChain = researchDocumentPersistChain.then(persistResearchDocumentSnapshot).catch(() => {});
      return;
    }
    if (researchDocumentPersistScheduled || researchDocumentPersistTimer) {
      return;
    }
    researchDocumentPersistScheduled = true;
    researchDocumentPersistTimer = setTimeout(() => {
      researchDocumentPersistTimer = null;
      researchDocumentPersistScheduled = false;
      researchDocumentPersistChain = researchDocumentPersistChain.then(persistResearchDocumentSnapshot).catch(() => {});
    }, 300);
  };

  const emitToolProgress = async (
    payload: {
      runId: string;
      toolCallId: string;
      toolName: ToolName;
      text: string;
      detail?: Record<string, unknown>;
    },
    onEmit: (text: string, detail?: Record<string, unknown>) => Promise<void>,
  ) => {
    recordRawLog("tool.progress.raw", payload);
    const normalizedText = normalizeToolProgressText(payload.toolName, payload.text);
    if (!normalizedText) {
      return;
    }
    await onEmit(normalizedText, payload.detail);
  };

  const persistLatestPlanToolTrace = async (
    messageId: string | null,
    toolCalls: LiveToolTraceEntry[],
  ) => {
    if (!messageId) {
      return;
    }
    const version = ++latestPlanTraceVersion;
    const snapshot = compactPlanToolTraceEntriesForPersistence(cloneLiveToolTraceEntries(toolCalls));
    const queuedWrite = planTracePersistChain.then(async () => {
      if (version <= persistedPlanTraceVersion || version !== latestPlanTraceVersion) {
        return;
      }
      await deps.store.updateMessageMetadata(messageId, {
        phase: "plan",
        runId: run!.id,
        toolCalls: snapshot,
      });
      persistedPlanTraceVersion = version;
    });
    planTracePersistChain = queuedWrite.catch(() => {});
    await queuedWrite;
  };

  const persistAndSendToolProgress = async (
    toolCallId: string,
    toolName: ToolName,
    text: string,
    detail?: Record<string, unknown>,
    options: {
      noteResearchDocumentActivity?: () => void;
      runtimeId?: string | null;
    } = {},
  ) => {
    liveToolTrace = liveToolTrace.map((entry) =>
      entry.id === toolCallId
        ? appendToolProgress(entry, text, detail)
        : entry,
    );
    options.noteResearchDocumentActivity?.();
    await appendResearchDocumentProgress(toolCallId, text, detail);
    await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
    await send("tool.progress", {
      runId: run.id,
      toolCallId,
      toolName,
      ...(options.runtimeId ? { runtimeId: options.runtimeId } : {}),
      text,
      ...(detail ? { detail } : {}),
    });
  };

  const appendResearchDocumentOnce = (key: string, fragment: string) => {
    if (!fragment.trim() || appendedResearchDocumentKeys.has(key)) {
      return;
    }
    appendedResearchDocumentKeys.add(key);
    liveResearchDocumentHtml = appendResearchDocumentFragment(liveResearchDocumentHtml, fragment);
    scheduleResearchDocumentPersist(false);
  };

  const appendResearchDocumentSectionOnce = (entry: LiveToolTraceEntry) => {
    appendResearchDocumentOnce(`section:${entry.id}`, buildResearchDocumentSectionHeader(entry.label, entry.rationale ?? ""));
  };

  const ensureResearchDocumentShell = (question: string) => {
    if (liveResearchDocumentHtml.trim().length > 0) {
      return;
    }
    liveResearchDocumentHtml = appendResearchDocumentFragment(
      liveResearchDocumentHtml,
      buildResearchDocumentRunShell(question),
    );
    appendedResearchDocumentKeys.add("shell:intro");
    scheduleResearchDocumentPersist(false);
  };

  const appendResearchDocumentLogOnce = (toolCallId: string, text: string, suffix = "") => {
    const normalized = normalizeDocumentText(text);
    const sanitized = sanitizeUserFacingToolText(normalized)?.replace(/\s+/gu, " ").trim() ?? "";
    if (
      !sanitized
      || isLowValueDocumentSummary(sanitized)
      || /^ALPHABOOK[ _]PROGRESS\b/iu.test(normalized)
      || /^[a-f0-9]{8}(?:[- ][a-f0-9]{4}){3}[- ][a-f0-9]{12}\s+\d+:/iu.test(normalized)
      || /[{}]/u.test(normalized)
    ) {
      return;
    }
    appendResearchDocumentOnce(`log:${toolCallId}:${suffix || sanitized}`, buildResearchDocumentLogEntry(sanitized));
  };

  const appendResearchDocumentProgress = async (
    toolCallId: string,
    text: string,
    detail?: Record<string, unknown>,
  ) => {
    ensureResearchDocumentShell(routedQueryRef.current);
    if (!detail) {
      return;
    }
    const detailType = typeof detail.type === "string" ? detail.type : "";
    if (detailType.startsWith("semantic.")) {
      appendResearchDocumentLogOnce(toolCallId, text);
      return;
    }
    if (
      detailType !== "research.work"
      && detailType !== "research.chunk"
      && detailType !== "research.briefing_line"
    ) {
      return;
    }
    await appendResearchDocumentDetailOnce(toolCallId, detail);
  };

  const appendResearchDocumentDetailOnce = async (
    toolCallId: string,
    detail: Record<string, unknown>,
  ) => {
    const detailType = typeof detail.type === "string" ? detail.type : "";
    if (detailType === "research.work") {
      const titleText = normalizeDocumentText(detail.workTitle ?? detail.title);
      if (!titleText) {
        return;
      }
      const authors = Array.isArray(detail.authors)
        ? detail.authors.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      const workId =
        typeof detail.workId === "string"
          ? detail.workId
          : typeof detail.id === "string"
            ? detail.id
            : null;
      const line = formatResearchDocumentBookLine(titleText, authors);
      appendResearchDocumentOnce(
        `detail:${toolCallId}:work:${workId ?? titleText}`,
        `<p class="assistant-document-entry is-book">${
          workId
            ? buildResearchDocumentLink(line, buildResearchDocumentWorkUrl(siteOrigin(deps), session!.id, workId))
            : escapeResearchHtml(line)
        }</p>`,
      );
      return;
    }
    if (detailType === "research.chunk") {
      const excerpt = normalizeDocumentText(detail.excerpt).slice(0, 440);
      if (!isUsefulPersistedExcerpt(excerpt)) {
        return;
      }
      const chunkIndex = typeof detail.chunkIndex === "number" ? detail.chunkIndex : null;
      const workId = typeof detail.workId === "string" ? detail.workId : null;
      const chunkId =
        typeof detail.chunkId === "string"
          ? detail.chunkId
          : typeof detail.id === "string"
            ? detail.id
            : null;
      const workTitle = normalizeDocumentText(detail.workTitle ?? detail.title) || "Source";
      const href = workId && chunkId
        ? await buildChunkPassageUrlFromChunk(
            deps,
            session!.id,
            {
              workId,
              readerPath: typeof detail.readerPath === "string" ? detail.readerPath : null,
            },
          )
        : workId
          ? await buildCitationPassageUrl(deps, session!.id, {
              workId,
              chunkId: undefined,
              label: workTitle,
              excerpt,
              readerPath: typeof detail.readerPath === "string" ? detail.readerPath : undefined,
            })
          : null;
      const sourceLabel = `Source: ${workTitle}, ${persistedPassageLocation(chunkIndex)}`;
      appendResearchDocumentOnce(
        `detail:${toolCallId}:chunk:${workId ?? "unknown"}:${String(chunkIndex ?? "mid")}:${excerpt.slice(0, 60)}`,
        `<blockquote class="assistant-document-entry is-chunk"><p class="assistant-document-quote">${escapeResearchHtml(excerpt)}</p><footer class="assistant-document-citation">${href ? buildResearchDocumentLink(sourceLabel, href) : escapeResearchHtml(sourceLabel)}</footer></blockquote>`,
      );
      return;
    }
    if (detailType === "research.briefing_line") {
      const line = typeof detail.line === "string" ? detail.line.trim() : "";
      if (!line) {
        return;
      }
      const shardScope =
        typeof detail.shardId === "string" && detail.shardId.trim().length > 0
          ? detail.shardId.trim()
          : typeof detail.shardLabel === "string" && detail.shardLabel.trim().length > 0
            ? detail.shardLabel.trim()
            : "global";
      const key = `detail:${toolCallId}:briefing:${shardScope}:${typeof detail.lineIndex === "number" ? detail.lineIndex : line}`;
      appendResearchDocumentOnce(key, await renderStreamingBriefingLineHtml(deps, session!.id, line));
    }
  };

  const appendResearchDocumentCompletedResultDetails = async (
    toolCallId: string,
    result: Record<string, unknown>,
  ) => {
    const frontier = result.frontier && typeof result.frontier === "object"
      ? result.frontier as Record<string, unknown>
      : null;
    const works = Array.isArray(frontier?.works)
      ? frontier.works
      : Array.isArray(result.works)
        ? result.works
        : [];
    for (const work of works) {
      if (!work || typeof work !== "object") {
        continue;
      }
      await appendResearchDocumentDetailOnce(toolCallId, {
        type: "research.work",
        ...(work as Record<string, unknown>),
        workTitle:
          typeof (work as Record<string, unknown>).workTitle === "string"
            ? (work as Record<string, unknown>).workTitle
            : (work as Record<string, unknown>).title,
      });
    }
    const chunks =
      Array.isArray(result.rankedChunks)
        ? result.rankedChunks
        : Array.isArray(result.chunks)
          ? result.chunks
          : [];
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== "object") {
        continue;
      }
      await appendResearchDocumentDetailOnce(toolCallId, {
        type: "research.chunk",
        ...(chunk as Record<string, unknown>),
        workTitle:
          typeof (chunk as Record<string, unknown>).workTitle === "string"
            ? (chunk as Record<string, unknown>).workTitle
            : (chunk as Record<string, unknown>).title,
      });
    }
  };

  if (session && session.userId !== input.userId) {
    throw new Error("Not authorized for this session.");
  }
  if (!session) {
    session = await deps.store.createSession(input.userId, fallbackSessionTitleFromMessage(input.message));
    await send("session.created", {
      sessionId: session.id,
      title: session.title,
    });
    recordRawLog("session.created", {
      sessionId: session.id,
      title: session.title,
    });
    const createdSessionId = session.id;
    pendingSessionTitleUpdate = (async () => {
      const generatedTitle = await createSessionTitle(deps, input.message, recordRawLog);
      await deps.store.updateSessionTitle(createdSessionId, generatedTitle);
      if (session?.id === createdSessionId) {
        session = {
          ...session,
          title: generatedTitle,
        };
      }
      await send("session.updated", {
        sessionId: createdSessionId,
        title: generatedTitle,
      });
      recordRawLog("session.updated", {
        sessionId: createdSessionId,
        title: generatedTitle,
      });
    })().catch((error) => {
      recordRawLog("session.title_failed", {
        sessionId: createdSessionId,
        error: error instanceof Error ? error.message : "Unknown session title error",
      });
    });
  }
  if (!session) {
    throw new Error("Session was not created.");
  }
  const activeSession = session;

  if (!options.recovery?.skipUserMessageAppend) {
    await deps.store.appendMessage(activeSession.id, "user", input.message);
    recordRawLog("message.user", {
      sessionId: activeSession.id,
      content: input.message,
    });
  } else {
    recordRawLog("message.user.reused", {
      sessionId: activeSession.id,
      content: input.message,
    });
  }
  const sessionMessages = await deps.store.listMessages(activeSession.id);
  const conversationHistory = formatConversationHistory(sessionMessages);
  run = await deps.store.createRun(activeSession.id);
  runCreated = true;
  activeRuns.set(run.id, {
    sessionId: activeSession.id,
    userId: input.userId,
    runtimeIds: new Set<string>(),
    cancelRequested: false,
    rawLog: rawRunLog,
    subscribers: new Map(),
  });
  let currentActiveToolCallId: string | null = null;
  const finalizeRunState = async (status: "completed" | "failed" | "timed_out") => {
    if (!run) {
      return;
    }
    const completedAt = new Date().toISOString();
    await deps.store.updateRun(run.id, terminalRunStateUpdate(status, completedAt));
    run = {
      ...run,
      status,
      completedAt,
      activeToolCallId: null,
    };
  };
  scheduleRawLogPersist(true);
  await send("run.started", {
    runId: run.id,
    sessionId: activeSession.id,
  });
  recordRawLog("run.started", {
    runId: run.id,
    sessionId: activeSession.id,
  });

  const toolHistory: Array<{
    toolName: ToolName;
    rationale?: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }> = [];
  const runtimeIdsToCleanup = new Set<string>();
  const toolResults: Record<string, unknown>[] = [];
  const priorRunEvidence = extractPriorRunEvidence(sessionMessages, run.id);
  let liveToolTrace: LiveToolTraceEntry[] = [];
  let runtimeTasks = 0;
  let workspaceStartAttempts = 0;
  let workspaceLastFailureAt = 0;
  let initialPlanSent = false;
  let planMessageId: string | null = null;
  type HighLevelWorkflow = "search" | "design_experiment";
  type InitialWorkflowIntent = {
    workflow: HighLevelWorkflow;
    routedQuery: string;
    rationale: string;
    executionMode?: "semantic" | "comprehensive" | "agentic";
    designSummary?: string;
  };
  let initialWorkflowIntent: InitialWorkflowIntent | null = null;
  type PendingWorkspaceExecution = {
    toolName: ToolName;
    toolRecordId: string;
    normalizedArgs: Record<string, unknown>;
    rationale?: string;
    progressEmitter: { stop: () => void | Promise<void> };
    promise: Promise<void>;
    settled: boolean;
    finalized: boolean;
    status: "completed" | "failed";
    result?: Record<string, unknown>;
  };
  let pendingWorkspaceExecution: PendingWorkspaceExecution | null = null;

  const hasWorkspaceTaskStarted = async (toolName: "run_workspace_task") => {
    if (pendingWorkspaceExecution?.toolName === toolName) {
      return true;
    }
    if (liveToolTrace.some((entry) => entry.toolName === toolName)) {
      return true;
    }
    if (toolHistory.some((entry) => entry.toolName === toolName)) {
      return true;
    }
    const persistedToolCalls = await deps.store.listToolCalls(run.id);
    return persistedToolCalls.some((toolCall) => toolCall.toolName === toolName);
  };
  let runFinalized = false;
  let runCompletionPromise: Promise<void> | null = null;
  const forwardPersistedToolEvents = async (
    afterSequence: number,
    toolCallId: string,
  ) => {
    const runEvents = await deps.store.listRunEvents(run.id);
    let latestSequence = afterSequence;
    for (const runEvent of runEvents) {
      if (runEvent.sequence <= afterSequence || runEvent.event !== "tool.progress") {
        continue;
      }
      const eventToolCallId = typeof runEvent.dataJson.toolCallId === "string" ? runEvent.dataJson.toolCallId : null;
      if (eventToolCallId !== toolCallId) {
        continue;
      }
      latestSequence = runEvent.sequence;
      await originalSend(runEvent.event, runEvent.dataJson);
    }
    return latestSequence;
  };

  const waitForDurableResearchTask = async (
    taskId: string,
    toolCallId: string,
  ) => {
    let lastSequence = (await deps.store.listRunEvents(run.id)).at(-1)?.sequence ?? 0;
    while (true) {
      lastSequence = await forwardPersistedToolEvents(lastSequence, toolCallId);
      const task = await deps.store.getResearchTask(taskId);
      if (!task) {
        throw new Error("Research task was not found after it was queued.");
      }
      const toolCall = (await deps.store.listToolCalls(run.id)).find((candidate) => candidate.id === toolCallId) ?? null;
      if (toolCall?.resultJson && (toolCall.status === "completed" || toolCall.status === "failed")) {
        const completedAt = new Date().toISOString();
        if (task.status === "queued" || task.status === "starting" || task.status === "running") {
          await deps.store.updateResearchTask(task.id, {
            status: toolCall.status === "completed" ? "succeeded" : "failed",
            errorJson: toolCall.status === "failed" ? toolCall.resultJson : null,
            completedAt,
          });
        }
        return {
          status: toolCall.status,
          result: toolCall.resultJson,
        };
      }
      const terminalError = terminalResearchTaskError(task);
      if (terminalError && (task.status === "queued" || task.status === "starting" || task.status === "running")) {
        await deps.store.updateResearchTask(task.id, {
          status: "failed",
          errorJson: { error: terminalError },
          completedAt: new Date().toISOString(),
        });
        return {
          status: "failed",
          result: { ok: false, error: terminalError },
        } as const;
      }
      if (task.status === "queued" || task.status === "starting" || task.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 750));
        continue;
      }
      if (toolCall?.resultJson && (toolCall.status === "completed" || toolCall.status === "failed")) {
        return {
          status: toolCall.status,
          result: toolCall.resultJson,
        };
      }
      return {
        status: task.status === "succeeded" ? "completed" : "failed",
        result: task.errorJson ?? { ok: false, error: "Durable research task finished without a tool result." },
      } as const;
    }
  };

  const completedForegroundRetrievalCount = () =>
    toolHistory.filter((entry) => entry.toolName !== "create_workspace" && entry.toolName !== "run_workspace_task").length;

  const waitForPendingWorkspace = async (timeoutMs: number) => {
    if (!pendingWorkspaceExecution || pendingWorkspaceExecution.settled) {
      return;
    }
    await Promise.race([
      pendingWorkspaceExecution.promise,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  };

  const finalizeToolExecution = async (
    toolCallId: string,
    toolName: ToolName,
    normalizedArgs: Record<string, unknown>,
    rationale: string | undefined,
    status: "completed" | "failed",
    result: Record<string, unknown>,
  ) => {
    await deps.store.finishToolCall(toolCallId, status, result);
    captureToolResultRunMetrics(toolName, result);
    if (status === "completed") {
      void recordBookAnalyticsEvents(
        deps,
        request,
        "book_candidate_in_run",
        {
          userId: activeSession.userId,
          sessionId: activeSession.id,
          runId: run.id,
          source: "orchestrator",
          toolName,
          query: routedQueryRef.current,
          status,
        },
        extractCandidateWorkIds(toolName, normalizedArgs, result),
      );
    }
    const streamedResult = clientSafeToolResult(toolName, result);
    recordRawLog("tool.completed.raw", {
      runId: run.id,
      toolCallId,
      toolName,
      status,
      result,
    });
    const completedToolLines = await normalizeToolLinesForUser(deps, {
      toolName,
      lines: flattenValueForCleanup(streamedResult).map((line) => ({
        ...line,
        toolName,
      })),
      allowModelCleanup: false,
    });
    liveToolTrace = liveToolTrace.map((entry) =>
      entry.id === toolCallId
        ? {
            ...entry,
            label: labelForToolCall(toolName, normalizedArgs),
            rationale:
              entry.progress.length > 0
                ? entry.progress[entry.progress.length - 1]
                : sanitizeUserFacingToolText(rationale) ?? entry.rationale,
            progress: entry.progress,
            result: canonicalToolResult(toolName, streamedResult, {
              ok: status !== "failed",
              logLines: completedToolLines.normalizedLines,
            }),
            isError: status === "failed",
            state: status === "failed" ? "error" : "completed",
          }
        : entry,
    );
    const completedEntry = liveToolTrace.find((entry) => entry.id === toolCallId) ?? null;
    if (completedEntry) {
      appendResearchDocumentSectionOnce(completedEntry);
    }
    if (toolName === "search_works" || toolName === "get_work_metadata") {
      const visibleWorks = Array.isArray(streamedResult.works) ? streamedResult.works : [];
      for (const work of visibleWorks) {
        if (!work || typeof work !== "object") {
          continue;
        }
        await appendResearchDocumentDetailOnce(toolCallId, {
          type: "research.work",
          ...(work as Record<string, unknown>),
          workId:
            typeof (work as Record<string, unknown>).workId === "string"
              ? (work as Record<string, unknown>).workId
              : typeof (work as Record<string, unknown>).id === "string"
                ? (work as Record<string, unknown>).id
                : undefined,
        });
      }
    }
    recordRawLog("tool.finalization.completed_result_details.started", {
      runId: run.id,
      toolCallId,
      toolName,
      rankedChunkCount: Array.isArray(result.rankedChunks) ? result.rankedChunks.length : 0,
      chunkCount: Array.isArray(result.chunks) ? result.chunks.length : 0,
    });
    await appendResearchDocumentCompletedResultDetails(toolCallId, result);
    recordRawLog("tool.finalization.completed_result_details.completed", {
      runId: run.id,
      toolCallId,
      toolName,
    });
    if (toolName === "run_workspace_task") {
      const briefing = typeof result.briefing === "string" ? result.briefing.trim() : "";
      if (briefing) {
        appendResearchDocumentOnce(`briefing:${toolCallId}`, await renderBriefingHtml(deps, session!.id, briefing));
      }
    }
    recordRawLog("tool.finalization.plan_trace.started", {
      runId: run.id,
      toolCallId,
      toolName,
    });
    await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
    recordRawLog("tool.finalization.plan_trace.completed", {
      runId: run.id,
      toolCallId,
      toolName,
    });
    const completedRuntimeId = runtimeIdFromToolResult(streamedResult, normalizedArgs);
    recordRawLog("tool.finalization.send_completed.started", {
      runId: run.id,
      toolCallId,
      toolName,
    });
    await send("tool.completed", {
      runId: run.id,
      toolCallId,
      toolName,
      ...(completedRuntimeId ? { runtimeId: completedRuntimeId } : {}),
      label: labelForToolCall(toolName, normalizedArgs),
      rationale: sanitizeUserFacingToolText(rationale) ?? null,
      status,
      result: canonicalToolResult(toolName, streamedResult, {
        ok: status !== "failed",
        logLines: completedToolLines.normalizedLines,
      }),
    });
    recordRawLog("tool.finalization.send_completed.completed", {
      runId: run.id,
      toolCallId,
      toolName,
    });
    toolHistory.push({
      toolName,
      rationale: sanitizeUserFacingToolText(rationale) ?? undefined,
      args: normalizedArgs,
      result,
    });
    toolResults.push(result);
  };

  const completeRunFromBriefing = async (
    completedBriefing: { answer: string; citations: Citation[] },
    completionMode: "standard" = "standard",
  ) => {
    if (runFinalized) {
      return;
    }
    if (runCompletionPromise) {
      await runCompletionPromise;
      return;
    }
    runCompletionPromise = (async () => {
      await synthesizeAnswer(
        deps,
        {
          request,
          userId: activeSession.userId,
          sessionId: activeSession.id,
          runId: run.id,
          userMessage: input.message,
          conversationHistory,
          plannerDraft: completedBriefing.answer,
          plannerCitations: completedBriefing.citations,
          toolHistory,
          auditLog: recordRawLog,
        },
        send,
      );
      runFinalized = true;
      await finalizeRunState("completed");
      await send("run.completed", {
        runId: run.id,
        sessionId: activeSession.id,
        status: "completed",
        completionMode,
      });
      recordRawLog("run.completed", {
        runId: run.id,
        sessionId: activeSession.id,
        status: "completed",
        completionMode,
      });
    })();
    try {
      await runCompletionPromise;
    } catch (error) {
      if (!runFinalized) {
        runCompletionPromise = null;
      }
      throw error;
    }
  };

  const harvestPendingWorkspace = async (force = false) => {
    if (!pendingWorkspaceExecution) {
      return false;
    }
    if (!pendingWorkspaceExecution.settled && !force) {
      return false;
    }
    await pendingWorkspaceExecution.promise;
    if (pendingWorkspaceExecution.finalized) {
      return pendingWorkspaceExecution.status === "completed";
    }
    pendingWorkspaceExecution.finalized = true;
    await finalizeToolExecution(
      pendingWorkspaceExecution.toolRecordId,
      pendingWorkspaceExecution.toolName,
      pendingWorkspaceExecution.normalizedArgs,
      pendingWorkspaceExecution.rationale,
      pendingWorkspaceExecution.status,
      pendingWorkspaceExecution.result ?? { ok: false, error: "The background research step did not return a result." },
    );
    if (pendingWorkspaceExecution.toolName === "create_workspace" && pendingWorkspaceExecution.status === "failed") {
      workspaceLastFailureAt = deps.now?.() ?? Date.now();
    }
    const completedWorkspaceRuntimeId =
      pendingWorkspaceExecution.toolName === "create_workspace"
      && pendingWorkspaceExecution.status === "completed"
      && typeof pendingWorkspaceExecution.result?.runtimeId === "string"
        ? pendingWorkspaceExecution.result.runtimeId
        : null;
    const completedWorkspaceBriefing =
      pendingWorkspaceExecution.toolName === "run_workspace_task"
      && pendingWorkspaceExecution.status === "completed"
      && pendingWorkspaceExecution.result
        ? extractCompletedBriefing(
            pendingWorkspaceExecution.toolName,
            pendingWorkspaceExecution.normalizedArgs,
            pendingWorkspaceExecution.result,
          )
        : null;
    const wasCompleted = pendingWorkspaceExecution.status === "completed";
    pendingWorkspaceExecution = null;
    if (completedWorkspaceBriefing) {
      await completeRunFromBriefing(completedWorkspaceBriefing, "standard");
      return true;
    }
    if (
      completedWorkspaceRuntimeId
      && !(await hasWorkspaceTaskStarted("run_workspace_task"))
    ) {
      await startBackgroundTool(
        "run_workspace_task",
        buildBackgroundWorkspaceTaskSpec(completedWorkspaceRuntimeId),
        Array.isArray(input.workIds) && input.workIds.length > 0
          ? "I’m starting the deeper research run now while metadata and passage search keep collecting evidence."
          : "I’m starting the deeper research run now while metadata and passage search keep collecting evidence.",
      );
    }
    return wasCompleted;
  };

  const ensureInitialPlanSent = async (routedQuery: string) => {
    if (initialPlanSent) {
      return;
    }
    ensureResearchDocumentShell(routedQuery);
    const planText = initialWorkflowIntent
      ? initialWorkflowPlan(initialWorkflowIntent)
      : requestedAssistantMode(input) === "semantic"
        ? initialSemanticAssistantPlan(routedQuery)
        : initialAssistantPlan(routedQuery);
    const planMessage = await deps.store.appendMessage(activeSession.id, "assistant", planText, {
      phase: "plan",
      runId: run.id,
    });
    planMessageId = planMessage.id;
    if (initialWorkflowIntent) {
      liveToolTrace = [{
        id: `intent:${initialWorkflowIntent.workflow}:${run.id}`,
        toolName: initialWorkflowIntent.workflow,
        label: getToolLabel(initialWorkflowIntent.workflow),
        rationale: initialWorkflowIntent.rationale,
        progress: [initialWorkflowIntent.rationale],
        sourceArgs: {
          query: initialWorkflowIntent.routedQuery,
          ...(initialWorkflowIntent.executionMode ? { executionMode: initialWorkflowIntent.executionMode } : {}),
          ...(initialWorkflowIntent.designSummary ? { designSummary: initialWorkflowIntent.designSummary } : {}),
        },
        args: canonicalToolArgs(
          initialWorkflowIntent.workflow,
          {
            query: initialWorkflowIntent.routedQuery,
            ...(initialWorkflowIntent.executionMode ? { executionMode: initialWorkflowIntent.executionMode } : {}),
            ...(initialWorkflowIntent.designSummary ? { designSummary: initialWorkflowIntent.designSummary } : {}),
          },
          initialWorkflowIntent.rationale,
          [initialWorkflowIntent.rationale],
        ),
        result: canonicalToolResult(initialWorkflowIntent.workflow, {
          ok: true,
          status: "selected",
          ...(initialWorkflowIntent.designSummary ? { briefing: initialWorkflowIntent.designSummary } : {}),
        }, {
          ok: true,
        }),
        state: "completed",
      }];
    }
    await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
    await send("assistant.plan", {
      runId: run.id,
      sessionId: activeSession.id,
      messageId: planMessage.id,
      text: planText,
    });
    recordRawLog("assistant.plan", {
      runId: run.id,
      sessionId: activeSession.id,
      messageId: planMessage.id,
      text: planText,
    });
    initialPlanSent = true;
  };

  const toPendingTools = (pending: PendingWorkspaceExecution | null): PlannerContext["pendingTools"] =>
    pending
      ? [{
          toolName: pending.toolName,
          args: pending.normalizedArgs,
        }]
      : [];

  const searchWorksFromHistory = () => {
    return searchFrontierWorksFromHistory(toolHistory);
  };

  const metadataWorksFromHistory = () => {
    const latest = [...toolHistory].reverse().find((entry) => entry.toolName === "get_work_metadata");
    return Array.isArray(latest?.result.works) ? latest.result.works as Array<Record<string, unknown>> : [];
  };

  const chunksFromHistory = () => {
    const latest = [...toolHistory].reverse().find((entry) => entry.toolName === "get_relevant_chunks");
    return Array.isArray(latest?.result.chunks) ? latest.result.chunks as Array<Record<string, unknown>> : [];
  };

  const latestCompletedRuntimeId = () => {
    for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
      const entry = toolHistory[index];
      if (entry.toolName !== "create_workspace") {
        continue;
      }
      return typeof entry.result.runtimeId === "string" ? entry.result.runtimeId : null;
    }
    return null;
  };

  const buildBackgroundWorkspaceTaskSpec = (runtimeId: string) => {
    const broadCorpusQuery = isBroadCorpusResearchQuery(routedQueryRef.current, Array.isArray(input.workIds) ? input.workIds.length : 0);
    const estimate = latestScopeEstimateFromHistory(toolHistory);
    const searchPlan = searchPlanFromEstimate(estimate, broadCorpusQuery, requestedIntensityOverride(input));
    const workLimit = Math.max(broadCorpusQuery ? (searchPlan.intensity === "normal" ? 48 : 40) : 12, Math.min(72, searchPlan.frontierWorks));
    const candidateLimit = broadCorpusQuery
      ? searchPlan.intensity === "normal"
        ? Math.max(20, Math.min(28, Math.ceil(searchPlan.frontierWorks * 0.75)))
        : Math.max(16, Math.min(24, Math.ceil(searchPlan.frontierWorks / 4)))
      : Math.max(8, Math.min(16, searchPlan.frontierWorks));
    const chunkLimit = Math.max(broadCorpusQuery ? 64 : 24, Math.min(128, searchPlan.frontierWorks * 2));
    const seedChunkLimit = Math.max(
      broadCorpusQuery ? (searchPlan.intensity === "normal" ? 48 : 40) : 16,
      Math.min(96, searchPlan.frontierWorks),
    );
    const scopedWorkIds = Array.isArray(input.workIds) ? input.workIds.slice(0, workLimit) : [];
    const searchWorks = searchWorksFromHistory();
    const metadataWorks = metadataWorksFromHistory();
    const seedChunks = chunksFromHistory();
    const seededWorkIds = new Set(
      seedChunks
        .map((chunk) => (typeof chunk.workId === "string" ? chunk.workId : null))
        .filter((value): value is string => typeof value === "string"),
    );
    const rankedSearchWorks = rankWorkspaceCandidateWorks(searchWorks, routedQueryRef.current, seededWorkIds)
      .filter(({ work, totalScore }, index) => shouldSeedWorkspaceWork(work, routedQueryRef.current, seededWorkIds, totalScore, index))
      .slice(0, candidateLimit)
      .map(({ work }) => work);
    const rankedMetadataWorks = rankWorkspaceCandidateWorks(metadataWorks, routedQueryRef.current, seededWorkIds)
      .filter(({ work, totalScore }, index) => shouldSeedWorkspaceWork(work, routedQueryRef.current, seededWorkIds, totalScore, index))
      .slice(0, candidateLimit)
      .map(({ work }) => work);
    const frontierWorkIds = uniqueWorkIds([
      ...scopedWorkIds,
      ...rankedSearchWorks.map((work) => (typeof work.id === "string" ? work.id : null)),
      ...rankedMetadataWorks.map((work) => (typeof work.id === "string" ? work.id : null)),
      ...seedChunks.map((chunk) => (typeof chunk.workId === "string" ? chunk.workId : null)),
    ]).slice(0, workLimit);
    const verifiedWorkIds = uniqueWorkIds(
      seedChunks.map((chunk) => (typeof chunk.workId === "string" ? chunk.workId : null)),
    ).slice(0, candidateLimit);
    const strictVerifiedFrontier = verifiedWorkIds.length >= 2;
    const candidateWorkIds = uniqueWorkIds(
      strictVerifiedFrontier
        ? [
            ...verifiedWorkIds,
            ...scopedWorkIds,
          ]
        : [
            ...verifiedWorkIds,
            ...scopedWorkIds,
            ...rankedMetadataWorks.map((work) => (typeof work.id === "string" ? work.id : null)),
            ...rankedSearchWorks.map((work) => (typeof work.id === "string" ? work.id : null)),
            ...frontierWorkIds,
          ],
    ).slice(0, candidateLimit);
    const boundedFrontierWorkIds = uniqueWorkIds(
      strictVerifiedFrontier
        ? [
            ...verifiedWorkIds,
            ...scopedWorkIds,
          ]
        : frontierWorkIds,
    ).slice(0, workLimit);
    const boundedRetrievalWorks = strictVerifiedFrontier
      ? uniqueWorkIds(candidateWorkIds)
      : uniqueWorkIds([
          ...rankedSearchWorks.map((work) => (typeof work.id === "string" ? work.id : null)),
          ...rankedMetadataWorks.map((work) => (typeof work.id === "string" ? work.id : null)),
        ]);
    const effectiveParallelism = (() => {
      const verifiedBound = strictVerifiedFrontier
        ? Math.max(1, Math.floor(verifiedWorkIds.length / 3))
        : 0;
      const candidateBound = Math.max(1, Math.floor(candidateWorkIds.length / 4));
      const maxUsefulParallelism = Math.max(verifiedBound, candidateBound);
      return Math.max(1, Math.min(searchPlan.parallelism, maxUsefulParallelism));
    })();
    const effectiveShardAxis = effectiveParallelism > 1 ? searchPlan.shardAxis : "none";
    const effectiveShardPlan = effectiveParallelism > 1
      ? searchPlan.shards.slice(0, effectiveParallelism)
      : [];
    const mergedTaskSpec = mergeTaskSpecWithPriorEvidence({
      kind: "briefing_search",
      phase: "collect_and_brief",
      question: routedQueryRef.current,
      researchObjective: routedQueryRef.current,
      mode: scopedWorkIds.length > 0 ? "open_book_analysis" : "exhaustive_corpus_search",
      intensity: searchPlan.intensity,
      timeBudgetMinutes: searchPlan.wallClockMinutes,
      parallelism: effectiveParallelism,
      shardAxis: effectiveShardAxis,
      workIds: candidateWorkIds,
      chunkIds: seedChunks
        .map((chunk) => (typeof chunk.id === "string" ? chunk.id : null))
        .filter((value): value is string => typeof value === "string")
        .slice(0, chunkLimit),
      candidateWorkIds,
      frontierWorkIds: boundedFrontierWorkIds,
      verifiedWorkIds,
      verifiedChunkIds: seedChunks
        .map((chunk) => (typeof chunk.id === "string" ? chunk.id : null))
        .filter((value): value is string => typeof value === "string")
        .slice(0, chunkLimit),
      shardPlan: effectiveShardPlan,
      searchHints: {
        searchWorksQuery: routedQueryRef.current,
        passageSearchFocus: strictVerifiedFrontier
          ? "Stay grounded in the verified books and passages already surfaced. Only widen if you find directly relevant new evidence."
          : "Find the strongest directly quotable passages that best answer the research objective.",
      },
      searchPlan: searchPlan.estimate ?? {
        recommendedIntensity: searchPlan.intensity,
        recommendedWallClockMinutes: searchPlan.wallClockMinutes,
        recommendedParallelism: effectiveParallelism,
        recommendedShardAxis: effectiveShardAxis,
        recommendedFrontierWorks: searchPlan.frontierWorks,
        recommendedShards: effectiveShardPlan,
      },
      retrieval: {
        frontierWorks: boundedRetrievalWorks
          .map((workId) => rankedSearchWorks.find((work) => work.id === workId) ?? rankedMetadataWorks.find((work) => work.id === workId))
          .filter((work): work is Record<string, unknown> => Boolean(work && typeof work === "object"))
          .slice(0, workLimit)
          .map((work) => ({
            id: typeof work.id === "string" ? work.id : null,
            title: typeof work.title === "string" ? work.title : "",
            authors: Array.isArray(work.authors) ? work.authors : [],
            summary: typeof work.summary === "string" ? work.summary : null,
            subjects: Array.isArray(work.subjects) ? work.subjects : [],
            gutenbergId: typeof work.gutenbergId === "number" ? work.gutenbergId : null,
          })),
        searchWorks: rankedSearchWorks.slice(0, workLimit).map((work) => ({
          id: typeof work.id === "string" ? work.id : null,
          title: typeof work.title === "string" ? work.title : "",
          authors: Array.isArray(work.authors) ? work.authors : [],
          summary: typeof work.summary === "string" ? work.summary : null,
          subjects: Array.isArray(work.subjects) ? work.subjects : [],
          gutenbergId: typeof work.gutenbergId === "number" ? work.gutenbergId : null,
        })),
        metadataWorks: rankedMetadataWorks.slice(0, workLimit).map((work) => ({
          id: typeof work.id === "string" ? work.id : null,
          title: typeof work.title === "string" ? work.title : "",
          authors: Array.isArray(work.authors) ? work.authors : [],
          summary: typeof work.summary === "string" ? work.summary : null,
          subjects: Array.isArray(work.subjects) ? work.subjects : [],
          gutenbergId: typeof work.gutenbergId === "number" ? work.gutenbergId : null,
        })),
        seedChunks: seedChunks.slice(0, seedChunkLimit).map((chunk) => ({
          id: typeof chunk.id === "string" ? chunk.id : null,
          workId: typeof chunk.workId === "string" ? chunk.workId : null,
          chunkIndex: typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : null,
          excerpt: typeof chunk.excerpt === "string" ? chunk.excerpt : "",
          r2Key: typeof chunk.r2Key === "string" ? chunk.r2Key : null,
        })),
        verifiedChunks: seedChunks.slice(0, chunkLimit).map((chunk) => ({
          id: typeof chunk.id === "string" ? chunk.id : null,
          workId: typeof chunk.workId === "string" ? chunk.workId : null,
          chunkIndex: typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : null,
          excerpt: typeof chunk.excerpt === "string" ? chunk.excerpt : "",
          r2Key: typeof chunk.r2Key === "string" ? chunk.r2Key : null,
        })),
      },
      evidenceFile: "output/evidence.json",
      evidenceNotesFile: "output/evidence-notes.md",
      briefingFile: "output/briefing.md",
      briefingJsonFile: "output/briefing.json",
      prewarmed: true,
    }, priorRunEvidence, input.message);
    return normalizeToolArgs("run_workspace_task", {
      runtimeId,
      taskSpec: mergedTaskSpec,
    });
  };

  const buildExperimentWorkspaceArgs = () => normalizeToolArgs("create_workspace", {
    workIds: Array.isArray(input.workIds) ? input.workIds.slice(0, 24) : [],
    chunkIds: [],
    taskContext: {
      question: routedQueryRef.current,
      researchObjective: routedQueryRef.current,
      workflow: "design_experiment",
      approved: true,
      ...(initialWorkflowIntent?.designSummary ? { designSummary: initialWorkflowIntent.designSummary } : {}),
      prewarmed: true,
    },
  });

  const buildExperimentWorkspaceTaskSpec = (runtimeId: string) => normalizeToolArgs("run_workspace_task", {
    runtimeId,
    taskSpec: {
      kind: "experiment_design",
      phase: "collect_and_brief",
      workflow: "design_experiment",
      taskIntent: "experiment_design",
      question: routedQueryRef.current,
      researchObjective: routedQueryRef.current,
      mode: Array.isArray(input.workIds) && input.workIds.length > 0 ? "open_book_analysis" : "exhaustive_corpus_search",
      intensity: "maximum",
      timeBudgetMinutes: 45,
      parallelism: Array.isArray(input.workIds) && input.workIds.length > 0 ? 1 : 4,
      workIds: Array.isArray(input.workIds) ? input.workIds.slice(0, 80) : [],
      chunkIds: [],
      searchHints: {
        searchWorksQuery: routedQueryRef.current,
        passageSearchFocus: "Find the passages and records needed to execute the approved experiment design. Build labels first, then run the aggregation and write up the paper.",
      },
      deliverables: [
        "output/briefing.md",
        "output/briefing.json",
        "output/evidence.json",
        "output/evidence-notes.md",
        "output/scripts/",
        "output/charts/",
        "output/labels/",
      ],
      outputExpectations: {
        paperFile: "output/briefing.md",
        paperJsonFile: "output/briefing.json",
        scriptDir: "output/scripts",
        chartDir: "output/charts",
        labelsDir: "output/labels",
      },
      ...(initialWorkflowIntent?.designSummary ? { designSummary: initialWorkflowIntent.designSummary } : {}),
    },
  });

  const startBackgroundTool = async (
    toolName: "create_workspace" | "run_workspace_task",
    normalizedToolArgs: Record<string, unknown>,
    rationale: string,
  ) => {
    if (pendingWorkspaceExecution) {
      if (toolName === "create_workspace") {
        return;
      }
      if (toolName === "run_workspace_task" && pendingWorkspaceExecution.toolName === "run_workspace_task") {
        return;
      }
    }
    if (toolName === "create_workspace") {
      if (latestCompletedRuntimeId()) {
        return;
      }
      workspaceStartAttempts += 1;
    }
    if (toolName === "run_workspace_task" && await hasWorkspaceTaskStarted("run_workspace_task")) {
      return;
    }
    runtimeTasks += 1;
    const toolRecord = await deps.store.startToolCall(run.id, toolName, normalizedToolArgs);
    const researchTask = toolUsesDurableResearchQueue(toolName)
      ? await deps.store.createResearchTask({
          runId: run.id,
          sessionId: activeSession.id,
          toolCallId: toolRecord.id,
          runtimeId: typeof normalizedToolArgs.runtimeId === "string" ? normalizedToolArgs.runtimeId : null,
          kind: "workspace_research",
          taskSpecJson: toolName === "run_workspace_task"
            ? {
                runtimeId: normalizedToolArgs.runtimeId,
                taskSpec: normalizedToolArgs.taskSpec && typeof normalizedToolArgs.taskSpec === "object"
                  ? normalizedToolArgs.taskSpec as Record<string, unknown>
                  : {},
              }
            : { query: normalizedToolArgs.query, workIds: normalizedToolArgs.workIds, maxResults: normalizedToolArgs.maxResults },
        })
      : null;
    await ensureInitialPlanSent(routedQueryRef.current);
    ensureResearchDocumentShell(routedQueryRef.current);
    recordRawLog("tool.started.raw", {
      runId: run.id,
      toolCallId: toolRecord.id,
      toolName,
      rationale,
      args: normalizedToolArgs,
    });
    if (toolName === "run_workspace_task" && normalizedToolArgs.taskSpec && typeof normalizedToolArgs.taskSpec === "object") {
      captureTaskSpecRunMetrics(normalizedToolArgs.taskSpec as Record<string, unknown>);
    }
    liveToolTrace = [
      ...liveToolTrace,
      {
        id: toolRecord.id,
        toolName,
        label: labelForToolCall(toolName, normalizedToolArgs),
        rationale: sanitizeUserFacingToolText(rationale) ?? undefined,
        progress: sanitizeUserFacingToolText(rationale) ? [sanitizeUserFacingToolText(rationale)!] : [],
        sourceArgs: structuredClone(normalizedToolArgs),
        args: canonicalToolArgs(
          toolName,
          normalizedToolArgs,
          sanitizeUserFacingToolText(rationale) ?? undefined,
          sanitizeUserFacingToolText(rationale) ? [sanitizeUserFacingToolText(rationale)!] : [],
        ),
        state: "running",
      },
    ];
    const startedEntry = liveToolTrace[liveToolTrace.length - 1]!;
    appendResearchDocumentSectionOnce(startedEntry);
    let lastResearchDocumentActivityAt = Date.now();
    const noteResearchDocumentActivity = () => {
      lastResearchDocumentActivityAt = Date.now();
    };
    noteResearchDocumentActivity();
    const heartbeatTimer = toolNeedsForegroundHeartbeat(toolName)
      ? setInterval(() => {
          if (Date.now() - lastResearchDocumentActivityAt < 15_000) {
            return;
          }
          lastResearchDocumentActivityAt = Date.now();
          const heartbeatText = foregroundHeartbeatText(toolName, run.startedAt);
          void emitToolProgress(
            {
              runId: run.id,
              toolCallId: toolRecord.id,
              toolName,
              text: heartbeatText,
              detail: {
                type: "research.note",
                note: heartbeatText,
                phase: "heartbeat",
              },
            },
            (progressText, detail) => persistAndSendToolProgress(
              toolRecord.id,
              toolName,
              progressText,
              detail,
            ),
          );
        }, 10_000)
      : null;
    await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
    const startedRuntimeId = runtimeIdFromToolArgs(normalizedToolArgs);
    await send("tool.started", {
      runId: run.id,
      toolCallId: toolRecord.id,
      toolName,
      ...(startedRuntimeId ? { runtimeId: startedRuntimeId } : {}),
      label: labelForToolCall(toolName, normalizedToolArgs),
      rationale: sanitizeUserFacingToolText(rationale) ?? null,
      args: startedEntry.args,
    });
    const progressEmitter = startToolProgressEmitter(
      deps.runtimeGateway,
      async (eventName, data) => {
        if (eventName !== "tool.progress" || typeof data.toolCallId !== "string" || typeof data.text !== "string") {
          await send(eventName, data);
          return;
        }
            void emitToolProgress(
          {
            runId: typeof data.runId === "string" ? data.runId : run.id,
            toolCallId: data.toolCallId,
            toolName,
            text: data.text,
            detail: data.detail && typeof data.detail === "object" ? data.detail as Record<string, unknown> : undefined,
          },
          (progressText, detail) => persistAndSendToolProgress(
            typeof data.toolCallId === "string" ? data.toolCallId : toolRecord.id,
            toolName,
            progressText,
            detail,
            {
              noteResearchDocumentActivity,
              runtimeId:
                typeof data.runtimeId === "string" && data.runtimeId.trim().length > 0
                  ? data.runtimeId
                  : startedRuntimeId,
            },
          ),
        );
      },
      {
        sessionId: activeSession.id,
        runId: run.id,
      },
      run.id,
      toolRecord.id,
      toolName,
      normalizedToolArgs,
    );
    pendingWorkspaceExecution = {
      toolName,
      toolRecordId: toolRecord.id,
      normalizedArgs: normalizedToolArgs,
      rationale,
      progressEmitter,
      settled: false,
      finalized: false,
      status: "failed",
      promise: (async () => {
        let backgroundResult: Record<string, unknown>;
        let backgroundStatus: "completed" | "failed" = "completed";
        try {
          if (researchTask && deps.enqueueJob) {
            await deps.enqueueJob({
              type: "research_task_requested",
              taskId: researchTask.id,
              queuedAt: new Date().toISOString(),
            });
            const durableResult = await waitForDurableResearchTask(researchTask.id, toolRecord.id);
            backgroundStatus = durableResult.status;
            backgroundResult = durableResult.result;
          } else {
            const executionPromise = executeTool(deps, toolName, normalizedToolArgs, {
              userId: activeSession.userId,
              sessionId: activeSession.id,
              runId: run.id,
              auditLog: recordRawLog,
              progressReporter: async (text, detail) => {
                await emitToolProgress(
                  {
                    runId: run.id,
                    toolCallId: toolRecord.id,
                    toolName,
                    text,
                    detail,
                  },
                  (progressText, emittedDetail) => persistAndSendToolProgress(
                    toolRecord.id,
                    toolName,
                    progressText,
                    emittedDetail,
                    {
                      noteResearchDocumentActivity,
                      runtimeId: startedRuntimeId,
                    },
                  ),
                );
              },
            });
            const deadline = backgroundToolDeadlineMs(toolName, normalizedToolArgs);
            backgroundResult = await withToolExecutionDeadline(
              executionPromise,
              deadline.timeoutMs,
              deadline.message,
            );
            addRuntimeIds(runtimeIdsToCleanup, normalizedToolArgs, backgroundResult);
            if (toolName === "run_workspace_task") {
              await trackRuntimeBillingEvents(deps, activeSession, run, backgroundResult.billingEvents);
            }
            const resultRuntimeId = typeof backgroundResult.runtimeId === "string" ? backgroundResult.runtimeId : null;
            if (resultRuntimeId) {
              activeRuns.get(run.id)?.runtimeIds.add(resultRuntimeId);
            }
          }
        } catch (error) {
          addRuntimeIds(runtimeIdsToCleanup, normalizedToolArgs);
          if (
            toolName === "run_workspace_task"
            && error
            && typeof error === "object"
            && "runtimePayload" in error
          ) {
            const runtimePayload = (error as { runtimePayload?: Record<string, unknown> }).runtimePayload;
            await trackRuntimeBillingEvents(deps, activeSession, run, runtimePayload?.billingEvents);
          }
          backgroundStatus = "failed";
          backgroundResult = {
            ok: false,
            error: formatToolExecutionError(toolName, error),
          };
          try {
            await recordUnexpectedError(deps, error, {
              request,
              route: "/chat",
              method: "POST",
              source: "tool_execution",
              toolName,
              runId: run.id,
              sessionId: activeSession.id,
              userId: activeSession.userId,
              extra: {
                toolArgs: normalizedToolArgs,
              },
            });
          } catch {
            // Error reporting should not block the user-facing run result.
          }
        } finally {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
          }
          await progressEmitter.stop();
        }
        if (pendingWorkspaceExecution) {
          pendingWorkspaceExecution.status = backgroundStatus;
          pendingWorkspaceExecution.result = backgroundResult;
          pendingWorkspaceExecution.settled = true;
        }
      })(),
    };
  };

  const maybeStartWorkspacePrewarm = async () => {
    if (pendingWorkspaceExecution || workspaceStartAttempts > 0 || latestCompletedRuntimeId()) {
      return;
    }
    const broadCorpusQuery = isBroadCorpusResearchQuery(
      routedQueryRef.current,
      Array.isArray(input.workIds) ? input.workIds.length : 0,
    );
    const estimate = latestScopeEstimateFromHistory(toolHistory);
    const candidateWorkIds = latestCandidateWorkIdsFromHistory(toolHistory);
    if (!estimate) {
      return;
    }
    const searchPlan = searchPlanFromEstimate(estimate, broadCorpusQuery, requestedIntensityOverride(input));
    const prewarmWorkLimit = broadCorpusQuery ? 24 : 12;
    const prewarmCandidateWorkIds = (
      candidateWorkIds.length > 0
        ? candidateWorkIds
        : Array.isArray(input.workIds)
          ? input.workIds
          : []
    ).slice(0, prewarmWorkLimit);
    const prewarmToolArgs = normalizeToolArgs("create_workspace", {
      workIds: Array.isArray(input.workIds) ? input.workIds.slice(0, prewarmWorkLimit) : [],
      chunkIds: [],
      taskContext: {
        question: routedQueryRef.current,
        researchObjective: routedQueryRef.current,
        mode: Array.isArray(input.workIds) && input.workIds.length > 0 ? "open_book_analysis" : "exhaustive_corpus_search",
        candidateWorkIds: prewarmCandidateWorkIds,
        topChunks: [],
        searchPlan: estimate ?? {
          recommendedIntensity: searchPlan.intensity,
          recommendedWallClockMinutes: searchPlan.wallClockMinutes,
          recommendedParallelism: searchPlan.parallelism,
          recommendedShardAxis: searchPlan.shardAxis,
          recommendedFrontierWorks: searchPlan.frontierWorks,
        },
        prewarmed: true,
      },
    });
    await startBackgroundTool(
      "create_workspace",
      prewarmToolArgs,
      Array.isArray(input.workIds) && input.workIds.length > 0
        ? "I’m spinning up the deeper research workspace for this book now so retrieval can feed into it immediately."
        : "I’m spinning up the deeper research workspace now so retrieval can feed into it immediately.",
    );
  };

  const routedQueryRef = { current: input.message };
  let prefetchedScopeEstimate:
    | {
      keys: Set<string>;
      promise: Promise<Record<string, unknown>>;
    }
    | null = null;
  const runSpriteFanoutMode = async () => {
    const normalizedToolArgs = normalizeToolArgs("run_workspace_task", {
      runtimeId: `sprite-fanout:${run.id}`,
      taskSpec: {
        kind: "sprite_fanout_research",
        mode: "sprite_fanout",
        phase: "collect_and_brief",
        question: input.message,
        researchObjective: input.message,
        intensity: requestedAssistantMode(input) === "comprehensive" ? "maximum" : "normal",
        workIds: Array.isArray(input.workIds) ? input.workIds : [],
      },
    });
    const rationale = "I’m running a broad search across many parts of the library and combining the strongest passages into one answer.";
    await startBackgroundTool("run_workspace_task", normalizedToolArgs, rationale);
    const completed = await harvestPendingWorkspace(true);
    if (completed || runFinalized) {
      return;
    }
    const latestToolCalls = await deps.store.listToolCalls(run.id);
    const latestRunWorkspaceTask = [...latestToolCalls]
      .reverse()
      .find((toolCall) => toolCall.toolName === "run_workspace_task");
    const latestError =
      typeof latestRunWorkspaceTask?.resultJson?.error === "string" && latestRunWorkspaceTask.resultJson.error.trim().length > 0
        ? latestRunWorkspaceTask.resultJson.error.trim()
        : null;
    throw new Error(latestError ?? "Sprite fanout research did not return a usable briefing.");
  };

  const runDesignExperimentMode = async () => {
    await ensureInitialPlanSent(routedQueryRef.current);
    if (!latestCompletedRuntimeId() && !pendingWorkspaceExecution) {
      await startBackgroundTool(
        "create_workspace",
        buildExperimentWorkspaceArgs(),
        "I’m setting up the experiment workspace and pulling in the corpus context needed for the approved design.",
      );
    }

    const startedAtMs = deps.now?.() ?? Date.now();
    const maxDurationMs = Math.min(HARD_LIMITS.MAX_RUN_WALL_CLOCK_SECONDS * 1000, 45 * 60_000);
    while ((deps.now?.() ?? Date.now()) - startedAtMs < maxDurationMs) {
      await harvestPendingWorkspace(false);
      if (runFinalized) {
        return;
      }
      const runtimeId = latestCompletedRuntimeId();
      if (runtimeId && !pendingWorkspaceExecution && !(await hasWorkspaceTaskStarted("run_workspace_task"))) {
        await startBackgroundTool(
          "run_workspace_task",
          buildExperimentWorkspaceTaskSpec(runtimeId),
          "I’m writing the experiment scripts now, then I’ll run the labels and aggregations and turn the results into a paper draft.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    await harvestPendingWorkspace(true);
    if (runFinalized) {
      return;
    }
    throw new Error("The experiment run hit its wall-clock limit before it produced a paper draft.");
  };
  try {
    if (requestedAssistantMode(input) === "comprehensive") {
      recordRawLog("research_mode.selected", {
        runId: run.id,
        sessionId: session.id,
        researchMode: "sprite_fanout",
      });
      await runSpriteFanoutMode();
      return;
    }
    recordRawLog("router.started", {
      sessionId: session.id,
      message: input.message,
    });
    let routeDecision: RouterDecision;
    try {
      routeDecision = options.precomputedRouteDecision ?? (input.workflow === "search"
        ? {
            type: "search" as const,
            fullQuery: input.message.trim(),
            executionMode: input.mode ?? "agentic",
            rationale: "The user explicitly asked to run a search.",
          }
        : deps.router
          ? await deps.router.decide({
              userMessage: input.message,
              requestedWorkflow: input.workflow,
              conversationHistory,
              auditLog: recordRawLog,
              billingContext: {
                userId: session.userId,
                sessionId: session.id,
                runId: run.id,
                source: "router",
              },
            })
          : shouldUseHermesBackend(deps, input)
            ? {
                type: "search" as const,
                fullQuery: input.message,
                executionMode: "agentic" as const,
              }
            : {
                type: "search" as const,
                fullQuery: input.message,
                executionMode: input.mode ?? "agentic",
              });
    } catch (error) {
      recordRawLog("router.failed", {
        runId: run.id,
        sessionId: session.id,
        error: error instanceof Error ? error.message : "Unknown router error",
      });
      throw error;
    }
    if (options.precomputedRouteDecision) {
      recordRawLog("router.reused", {
        runId: run.id,
        sessionId: session.id,
        type: routeDecision.type,
        fullQuery: routeDecision.type === "search" ? routeDecision.fullQuery : null,
      });
    }
    await send("router.completed", {
      runId: run.id,
      sessionId: session.id,
      type: routeDecision.type,
      fullQuery: routeDecision.type === "search" ? routeDecision.fullQuery : null,
    });
    recordRawLog("router.completed", {
      runId: run.id,
      sessionId: session.id,
      type: routeDecision.type,
      fullQuery: routeDecision.type === "search" ? routeDecision.fullQuery : null,
    });

    if (routeDecision.type === "direct_response") {
      const experimentProposal = routeDecision.workflowHint === "design_experiment"
        ? routeDecision.experimentProposal ?? fallbackExperimentProposalFromAnswer(routeDecision.answer, input.message)
        : undefined;
      const artifactKey = await persistFinalArtifact(deps, session.id, run.id, routeDecision.answer, []);
      const directResearchDocumentHtml = await appendFinalAnswerResearchDocumentHtml(
        deps,
        session.id,
        "",
        [],
        routeDecision.answer,
      );
      await persistResearchDocumentArtifact(
        deps,
        session.id,
        run.id,
        directResearchDocumentHtml,
      );
      await deps.store.appendMessage(session.id, "assistant", routeDecision.answer, {
        artifactKey,
        route: "direct_response",
        ...(routeDecision.workflowHint ? { workflowHint: routeDecision.workflowHint } : {}),
        ...(experimentProposal ? { experimentProposal } : {}),
      });
      await finalizeRunState("completed");
      await streamAssistantText(routeDecision.answer, send);
      await send("assistant.completed", {
        answer: routeDecision.answer,
        citations: [],
        artifactKey,
      });
      recordRawLog("assistant.completed", {
        answer: routeDecision.answer,
        citations: [],
        artifactKey,
      });
      await send("run.completed", {
        runId: run.id,
        sessionId: session.id,
        status: "completed",
        completionMode: "direct_response",
      });
      recordRawLog("run.completed", {
        runId: run.id,
        sessionId: session.id,
        status: "completed",
        completionMode: "direct_response",
      });
      return;
    }

    if (routeDecision.type === "design_experiment") {
      const routedQuery = routeDecision.executionPrompt.trim() || input.message;
      routedQueryRef.current = routedQuery;
      initialWorkflowIntent = {
        workflow: "design_experiment",
        routedQuery,
        rationale: routeDecision.rationale
          ?? "The experiment design is concrete and approved, so I’m setting up the runner now.",
        designSummary: routeDecision.designSummary,
      };
      await runDesignExperimentMode();
      return;
    }

    const routedQuery = routeDecision.fullQuery.trim() || input.message;
    routedQueryRef.current = routedQuery;
    input.mode = routeDecision.executionMode ?? input.mode ?? "agentic";
    if (input.mode === "agentic") {
      recordRawLog("router.dispatch_mismatch", {
        runId: run.id,
        sessionId: session.id,
        routedQuery,
        executionMode: input.mode,
      });
      throw new Error("Agentic search was routed into the semantic orchestrator path.");
    }
    initialWorkflowIntent = {
      workflow: "search",
      routedQuery,
      rationale: routeDecision.rationale
        ?? (input.mode === "comprehensive"
          ? "I’ve selected Search and this query needs the broader corpus pass."
          : "I’ve selected Search and I’m starting with the fast evidence pass."),
      executionMode: input.mode,
    };
    await ensureInitialPlanSent(routedQuery);
    await maybeStartWorkspacePrewarm();
    const currentTimeBudgetMs = () => {
      const estimate = latestScopeEstimateFromHistory(toolHistory);
      const broadCorpusQuery = isBroadCorpusResearchQuery(routedQueryRef.current, Array.isArray(input.workIds) ? input.workIds.length : 0);
      const searchPlan = searchPlanFromEstimate(estimate, broadCorpusQuery, requestedIntensityOverride(input));
      return Math.min(
        HARD_LIMITS.MAX_RUN_WALL_CLOCK_SECONDS * 1000,
        Math.max(60_000, searchPlan.wallClockMinutes * 60_000),
      );
    };
    for (let turn = 1; turn <= HARD_LIMITS.MAX_TURNS; turn += 1) {
      await harvestPendingWorkspace(false);
      if (runFinalized) {
        return;
      }
      await maybeStartWorkspacePrewarm();
      if (activeRuns.get(run.id)?.cancelRequested) {
        break;
      }
      if (
        !pendingWorkspaceExecution
        && !(await hasWorkspaceTaskStarted("run_workspace_task"))
      ) {
        const runtimeId = latestCompletedRuntimeId();
        if (runtimeId) {
          await startBackgroundTool(
            "run_workspace_task",
            buildBackgroundWorkspaceTaskSpec(runtimeId),
            Array.isArray(input.workIds) && input.workIds.length > 0
              ? "I’m starting the deeper research run now while metadata and passage search keep collecting evidence."
            : "I’m starting the deeper research run now while metadata and passage search keep collecting evidence.",
          );
        }
      }
      const elapsedMs = (deps.now?.() ?? Date.now()) - started;
      if (elapsedMs > currentTimeBudgetMs()) {
        recordRawLog("run.time_budget_reached", {
          runId: run.id,
          sessionId: session.id,
          elapsedMs,
          timeBudgetMs: currentTimeBudgetMs(),
        });
        break;
      }
      if (elapsedMs > HARD_LIMITS.MAX_RUN_WALL_CLOCK_SECONDS * 1000) {
        break;
      }
      await deps.store.updateRun(run.id, {
        plannerTurns: turn,
      });

      await send("planner.turn", {
        runId: run.id,
        turn,
      });

      const assistantMode = requestedAssistantMode(input);
      if (assistantMode === "agentic") {
        throw new Error("Agentic search reached the semantic planner loop.");
      }
      const plannerContext: PlannerContext = {
        userMessage: routedQuery,
        mode: assistantMode,
        conversationHistory,
        turns: turn,
        toolHistory,
        pendingTools: toPendingTools(pendingWorkspaceExecution),
        workScope: input.workIds,
        billingContext: {
          userId: session.userId,
          sessionId: session.id,
          runId: run.id,
          source: "planner",
        },
      };
      recordRawLog("planner.started", {
        runId: run.id,
        sessionId: session.id,
        turn,
        toolHistoryCount: toolHistory.length,
        pendingToolCount: plannerContext.pendingTools?.length ?? 0,
      });
      let decision: PlannerDecision;
      try {
        decision = await withToolExecutionDeadline(
          deps.planner.decide(plannerContext),
          HARD_LIMITS.MAX_TOOL_TIMEOUT_SECONDS * 1000,
          "Planner timed out before choosing the next step.",
        );
      } catch (error) {
        recordRawLog("planner.failed", {
          runId: run.id,
          sessionId: session.id,
          turn,
          error: error instanceof Error ? error.message : "Unknown planner error",
        });
        throw error;
      }
      recordRawLog("planner.completed", {
        runId: run.id,
        sessionId: session.id,
        turn,
        decisionType: decision.type,
        toolName: decision.type === "tool_call" ? decision.tool_name : null,
      });

      if (decision.type === "final_answer") {
        await deps.store.updateRun(run.id, {
          plannerTurns: turn,
        });
        await finalizeRunState("completed");
        await synthesizeAnswer(
          deps,
          {
            request,
            userId: session.userId,
            sessionId: session.id,
            runId: run.id,
            userMessage: input.message,
            conversationHistory,
            plannerDraft: decision.answer,
            plannerCitations: decision.citations,
            toolHistory,
            auditLog: recordRawLog,
          },
          send,
        );
        await send("run.completed", {
          runId: run.id,
          sessionId: session.id,
          status: "completed",
          completionMode: "standard",
        });
        recordRawLog("run.completed", {
          runId: run.id,
          sessionId: session.id,
          status: "completed",
          completionMode: "standard",
        });
        return;
      }

      const toolCall = parseToolCall(decision);
      if (!toolCall) {
        continue;
      }

      if (
        (toolCall.tool_name === "create_workspace" || toolCall.tool_name === "run_workspace_task") &&
        runtimeTasks >= HARD_LIMITS.MAX_RUNTIME_TASKS_PER_RUN
      ) {
        toolResults.push({
          toolName: toolCall.tool_name,
          ok: false,
          error: "MAX_RUNTIME_TASKS_PER_RUN exceeded",
        });
        continue;
      }

      const normalizedToolArgs = augmentToolArgsFromHistory(
        toolCall.tool_name,
        augmentSearchWorksArgsFromContext(
          toolCall.tool_name,
          normalizeToolArgs(toolCall.tool_name, toolCall.args),
          toolCall.rationale,
          routedQueryRef.current,
        ),
        toolHistory,
      );
      if (toolCall.tool_name === "semantic_deep_search" && input.semanticBackend && normalizedToolArgs.backend === undefined) {
        normalizedToolArgs.backend = input.semanticBackend;
      }
      if (toolCall.tool_name === "run_workspace_task" && normalizedToolArgs.taskSpec && typeof normalizedToolArgs.taskSpec === "object") {
        normalizedToolArgs.taskSpec = mergeTaskSpecWithPriorEvidence(
          normalizedToolArgs.taskSpec as Record<string, unknown>,
          priorRunEvidence,
          input.message,
        );
      }
      if (toolCall.tool_name === "search_works" && hasCompletedSearchWorks(toolHistory)) {
        continue;
      }
      if (toolCall.tool_name === "get_relevant_chunks" && hasCompletedChunkSearch(toolHistory)) {
        continue;
      }
      if (toolCall.tool_name === "create_workspace" && pendingWorkspaceExecution) {
        continue;
      }
      if (toolCall.tool_name === "create_workspace") {
        if (latestCompletedRuntimeId()) {
          continue;
        }
        const now = deps.now?.() ?? Date.now();
        if (workspaceStartAttempts >= 2) {
          continue;
        }
        if (workspaceLastFailureAt > 0 && now - workspaceLastFailureAt < 30_000) {
          continue;
        }
        await startBackgroundTool("create_workspace", normalizedToolArgs, toolCall.rationale ?? "Preparing the deeper research workspace.");
        continue;
      }
      const pendingExecution = pendingWorkspaceExecution as PendingWorkspaceExecution | null;
      if (toolCall.tool_name === "run_workspace_task" && pendingExecution) {
        const waitingOnBackgroundRuntimeTask = pendingExecution.toolName === "run_workspace_task";
        await harvestPendingWorkspace(true);
        if (runFinalized) {
          return;
        }
        if (waitingOnBackgroundRuntimeTask) {
          continue;
        }
        let readyRuntimeId: unknown = null;
        for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
          const entry = toolHistory[index];
          if (entry.toolName === "create_workspace") {
            readyRuntimeId = entry.result.runtimeId;
            break;
          }
        }
        if (typeof normalizedToolArgs.runtimeId !== "string" && typeof readyRuntimeId === "string") {
          normalizedToolArgs.runtimeId = readyRuntimeId;
        }
      }
      const activeRun = activeRuns.get(run.id);
      const runtimeId =
        typeof normalizedToolArgs.runtimeId === "string"
          ? normalizedToolArgs.runtimeId
          : null;
      if (runtimeId) {
        activeRun?.runtimeIds.add(runtimeId);
      }
      const toolRecord = await deps.store.startToolCall(run.id, toolCall.tool_name, normalizedToolArgs);
      const researchTask = toolCall.tool_name === "semantic_deep_search" || toolCall.tool_name === "run_workspace_task"
        ? await deps.store.createResearchTask({
            runId: run.id,
            sessionId: session.id,
            toolCallId: toolRecord.id,
            runtimeId: typeof normalizedToolArgs.runtimeId === "string" ? normalizedToolArgs.runtimeId : null,
            kind: toolCall.tool_name === "semantic_deep_search" ? "semantic_research" : "workspace_research",
            taskSpecJson: toolCall.tool_name === "run_workspace_task"
              ? {
                  runtimeId: normalizedToolArgs.runtimeId,
                  taskSpec: normalizedToolArgs.taskSpec && typeof normalizedToolArgs.taskSpec === "object"
                    ? normalizedToolArgs.taskSpec as Record<string, unknown>
                    : {},
                }
              : {
                  query: normalizedToolArgs.query,
                  workIds: normalizedToolArgs.workIds,
                  maxResults: normalizedToolArgs.maxResults,
                  ...(typeof normalizedToolArgs.backend === "string" ? { backend: normalizedToolArgs.backend } : {}),
                },
          })
        : null;
      await ensureInitialPlanSent(routedQuery);
      ensureResearchDocumentShell(routedQueryRef.current);
      recordRawLog("tool.started.raw", {
        runId: run.id,
        toolCallId: toolRecord.id,
        toolName: toolCall.tool_name,
        rationale: toolCall.rationale ?? null,
        args: normalizedToolArgs,
      });
      if (
        toolCall.tool_name === "run_workspace_task"
        && normalizedToolArgs.taskSpec
        && typeof normalizedToolArgs.taskSpec === "object"
      ) {
        captureTaskSpecRunMetrics(normalizedToolArgs.taskSpec as Record<string, unknown>);
      }
      liveToolTrace = [
        ...liveToolTrace,
        {
          id: toolRecord.id,
          toolName: toolCall.tool_name,
          label: labelForToolCall(toolCall.tool_name, normalizedToolArgs),
          rationale: sanitizeUserFacingToolText(toolCall.rationale) ?? undefined,
          progress: sanitizeUserFacingToolText(toolCall.rationale) ? [sanitizeUserFacingToolText(toolCall.rationale)!] : [],
          sourceArgs: structuredClone(normalizedToolArgs),
          args: canonicalToolArgs(
            toolCall.tool_name,
            normalizedToolArgs,
            sanitizeUserFacingToolText(toolCall.rationale) ?? undefined,
            sanitizeUserFacingToolText(toolCall.rationale) ? [sanitizeUserFacingToolText(toolCall.rationale)!] : [],
          ),
          state: "running",
        },
      ];
      const startedEntry = liveToolTrace[liveToolTrace.length - 1]!;
      let lastResearchDocumentActivityAt = Date.now();
      const noteResearchDocumentActivity = () => {
        lastResearchDocumentActivityAt = Date.now();
      };
      noteResearchDocumentActivity();
      const startedRuntimeId = runtimeIdFromToolArgs(normalizedToolArgs);
      const reportForegroundToolProgress = (
        text: string,
        detail?: Record<string, unknown>,
        options: {
          toolCallId?: string;
          runtimeId?: string | null;
        } = {},
      ) => emitToolProgress(
        {
          runId: run.id,
          toolCallId: options.toolCallId ?? toolRecord.id,
          toolName: toolCall.tool_name,
          text,
          detail,
        },
        (progressText, emittedDetail) => persistAndSendToolProgress(
          options.toolCallId ?? toolRecord.id,
          toolCall.tool_name,
          progressText,
          emittedDetail,
          {
            noteResearchDocumentActivity,
            runtimeId: options.runtimeId ?? startedRuntimeId,
          },
        ).then(async () => {
          if (!researchTask || (deps.enqueueJob && toolUsesDurableResearchQueue(toolCall.tool_name))) {
            return;
          }
          const existing = await deps.store.getResearchTask(researchTask.id);
          const nextSeq = (existing?.progressSeq ?? 0) + 1;
          await deps.store.updateResearchTask(researchTask.id, {
            status: existing?.status === "queued" ? "running" : existing?.status ?? "running",
            runtimeId: typeof (options.runtimeId ?? startedRuntimeId) === "string" ? options.runtimeId ?? startedRuntimeId : existing?.runtimeId ?? null,
            progressSeq: nextSeq,
            checkpointJson: checkpointFromToolProgressDetail(detail),
            ...(existing?.startedAt ? {} : { startedAt: new Date().toISOString() }),
          });
        }),
      );
      const heartbeatTimer = toolNeedsForegroundHeartbeat(toolCall.tool_name)
        ? setInterval(() => {
            if (Date.now() - lastResearchDocumentActivityAt < 15_000) {
              return;
            }
            lastResearchDocumentActivityAt = Date.now();
            const heartbeatText = foregroundHeartbeatText(toolCall.tool_name, run.startedAt);
            void reportForegroundToolProgress(heartbeatText, {
              type: "research.note",
              note: heartbeatText,
              phase: "heartbeat",
            });
          }, 10_000)
        : null;
      await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
    await send("tool.started", {
      runId: run.id,
      toolCallId: toolRecord.id,
      toolName: toolCall.tool_name,
      ...(startedRuntimeId ? { runtimeId: startedRuntimeId } : {}),
      label: labelForToolCall(toolCall.tool_name, normalizedToolArgs),
      rationale: sanitizeUserFacingToolText(toolCall.rationale) ?? null,
      args: startedEntry.args,
    });
      const progressEmitter = startToolProgressEmitter(
        deps.runtimeGateway,
        async (eventName, data) => {
          if (eventName !== "tool.progress" || typeof data.toolCallId !== "string" || typeof data.text !== "string") {
            await send(eventName, data);
            return;
          }
          await reportForegroundToolProgress(
            data.text,
            data.detail && typeof data.detail === "object" ? data.detail as Record<string, unknown> : undefined,
            {
              toolCallId: data.toolCallId,
              runtimeId:
                typeof data.runtimeId === "string" && data.runtimeId.trim().length > 0
                  ? data.runtimeId
                  : startedRuntimeId,
            },
          );
        },
        {
          sessionId: session.id,
          runId: run.id,
        },
        run.id,
        toolRecord.id,
        toolCall.tool_name,
        normalizedToolArgs,
      );

      let result: Record<string, unknown>;
      let status: "completed" | "failed" = "completed";
      try {
        if (researchTask && deps.enqueueJob && toolUsesDurableResearchQueue(toolCall.tool_name)) {
          await deps.enqueueJob({
            type: "research_task_requested",
            taskId: researchTask.id,
            queuedAt: new Date().toISOString(),
          });
          const durableResult = await waitForDurableResearchTask(researchTask.id, toolRecord.id);
          status = durableResult.status;
          result = durableResult.result;
        } else if (
          toolCall.tool_name === "estimate_research_scope"
          && typeof normalizedToolArgs.query === "string"
          && !(
            (Array.isArray(normalizedToolArgs.workIds) && normalizedToolArgs.workIds.length > 0)
            || (Array.isArray(normalizedToolArgs.chunkIds) && normalizedToolArgs.chunkIds.length > 0)
          )
        ) {
          const estimateFilters = normalizedScopeEstimateFilters(normalizedToolArgs.filters);
          const estimateKey = scopeEstimateCacheKey(normalizedToolArgs.query, estimateFilters);
          if (prefetchedScopeEstimate && (prefetchedScopeEstimate.keys.has(estimateKey) || toolHistory.some((entry) => entry.toolName === "search_works"))) {
            result = await prefetchedScopeEstimate.promise;
          } else if (toolHistory.some((entry) => entry.toolName === "search_works")) {
            const latestSearchResult = latestSearchWorksResultFromHistory(toolHistory);
            result = latestSearchResult
              ? await deriveScopeEstimateFromSearchResult(deps, normalizedToolArgs.query, latestSearchResult, estimateFilters)
              : await executeTool(deps, toolCall.tool_name, normalizedToolArgs, {
                  userId: session.userId,
                  sessionId: session.id,
                  runId: run.id,
                  auditLog: recordRawLog,
                  progressReporter: async (text, detail) => {
                    await reportForegroundToolProgress(text, detail);
                  },
                });
          } else {
            result = await executeTool(deps, toolCall.tool_name, normalizedToolArgs, {
              userId: session.userId,
              sessionId: session.id,
              runId: run.id,
              auditLog: recordRawLog,
              progressReporter: async (text, detail) => {
                await reportForegroundToolProgress(text, detail);
              },
            });
          }
        } else {
          result = await executeTool(deps, toolCall.tool_name, normalizedToolArgs, {
            userId: session.userId,
            sessionId: session.id,
            runId: run.id,
            auditLog: recordRawLog,
            progressReporter: async (text, detail) => {
              await reportForegroundToolProgress(text, detail);
            },
          });
        }
        addRuntimeIds(runtimeIdsToCleanup, normalizedToolArgs, result);
        if (toolCall.tool_name === "search_works" && typeof normalizedToolArgs.query === "string") {
          const estimateFilters = normalizedScopeEstimateFilters(normalizedToolArgs.filters);
          const estimateKeys = new Set<string>([
            scopeEstimateCacheKey(normalizedToolArgs.query, estimateFilters),
          ]);
          if (typeof routedQueryRef.current === "string" && routedQueryRef.current.trim().length > 0) {
            estimateKeys.add(scopeEstimateCacheKey(routedQueryRef.current, estimateFilters));
          }
          if (typeof input.message === "string" && input.message.trim().length > 0) {
            estimateKeys.add(scopeEstimateCacheKey(input.message, estimateFilters));
          }
          prefetchedScopeEstimate = {
            keys: estimateKeys,
            promise: deriveScopeEstimateFromSearchResult(deps, normalizedToolArgs.query, result, estimateFilters),
          };
        }
        if (toolCall.tool_name === "run_workspace_task") {
          await trackRuntimeBillingEvents(deps, session, run, result.billingEvents);
        }
        if (toolCall.tool_name === "run_workspace_task") {
          runtimeTasks += 1;
        }
        const resultRuntimeId = typeof result.runtimeId === "string" ? result.runtimeId : null;
        if (resultRuntimeId) {
          activeRun?.runtimeIds.add(resultRuntimeId);
        }
      } catch (error) {
        addRuntimeIds(runtimeIdsToCleanup, normalizedToolArgs);
        if (
          toolCall.tool_name === "run_workspace_task"
          && error
          && typeof error === "object"
          && "runtimePayload" in error
        ) {
          const runtimePayload = (error as { runtimePayload?: Record<string, unknown> }).runtimePayload;
          await trackRuntimeBillingEvents(deps, session, run, runtimePayload?.billingEvents);
        }
        status = "failed";
        result = {
          ok: false,
          error: formatToolExecutionError(toolCall.tool_name, error),
        };
        try {
          await recordUnexpectedError(deps, error, {
            request,
            route: "/chat",
            method: "POST",
            source: "tool_execution",
            toolName: toolCall.tool_name,
            runId: run.id,
            sessionId: session.id,
            userId: session.userId,
            extra: {
              toolArgs: normalizedToolArgs,
            },
          });
        } catch {
          // Error reporting should not block the user-facing run result.
        }
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        await progressEmitter.stop();
      }

      if (researchTask) {
        const runtimeArtifactKey = Array.isArray(result.artifacts)
          ? (result.artifacts as Array<Record<string, unknown>>).find((artifact) =>
            artifact && typeof artifact === "object" && typeof artifact.r2Key === "string"
          )?.r2Key
          : null;
        await deps.store.updateResearchTask(researchTask.id, {
          runtimeId:
            typeof result.runtimeId === "string"
              ? result.runtimeId
              : typeof normalizedToolArgs.runtimeId === "string"
                ? normalizedToolArgs.runtimeId
                : null,
          status: status === "completed" ? "succeeded" : "failed",
          resultArtifactKey: typeof runtimeArtifactKey === "string" ? runtimeArtifactKey : null,
          errorJson: status === "completed"
            ? null
            : {
                error: typeof result.error === "string" ? result.error : "Long-running research failed.",
              },
          completedAt: new Date().toISOString(),
        });
      }

      if (activeRuns.get(run.id)?.cancelRequested) {
        await finalizeRunState("failed");
        await send("run.completed", {
          runId: run.id,
          sessionId: session.id,
          status: "failed",
          completionMode: "failed",
        });
        recordRawLog("run.completed", {
          runId: run.id,
          sessionId: session.id,
          status: "failed",
          completionMode: "failed",
        });
        return;
      }

      await finalizeToolExecution(
        toolRecord.id,
        toolCall.tool_name,
        normalizedToolArgs,
        toolCall.rationale,
        status,
        result,
      );

      const completedBriefing = status === "completed"
        ? extractCompletedBriefing(toolCall.tool_name, normalizedToolArgs, result)
        : null;
      if (completedBriefing) {
        await completeRunFromBriefing(completedBriefing, "standard");
        return;
      }
    }

    await harvestPendingWorkspace(true);
    if (runFinalized) {
      return;
    }
    const completedBriefing = latestCompletedBriefing(toolHistory);
    if (completedBriefing) {
      await completeRunFromBriefing(completedBriefing, "standard");
    } else {
      await finalizeRunState("timed_out");
      const timeoutMessage = "The run hit its hard limits before it produced a valid answer.";
      const timeoutResearchDocumentHtml = await appendFinalAnswerResearchDocumentHtml(
        deps,
        session.id,
        liveResearchDocumentHtml,
        [],
        timeoutMessage,
      );
      await appendRunErrorMessageOnce(deps, session.id, run.id, timeoutMessage, {
        runId: run.id,
        phase: "error",
      });
      await streamAssistantText(timeoutMessage, send);
      await send("assistant.completed", {
        answer: timeoutMessage,
        citations: [],
        artifactKey: null,
        phase: "error",
      });
      recordRawLog("assistant.completed", {
        answer: timeoutMessage,
        citations: [],
        artifactKey: null,
      });
      await send("run.completed", {
        runId: run.id,
        sessionId: session.id,
        status: "timed_out",
        completionMode: "timed_out",
      });
      recordRawLog("run.completed", {
        runId: run.id,
        sessionId: session.id,
        status: "timed_out",
        completionMode: "timed_out",
      });
    }
  } catch (error) {
    await harvestPendingWorkspace(true);
    if (runFinalized) {
      return;
    }
    try {
      await recordUnexpectedError(deps, error, {
        request,
        route: "/chat",
        method: "POST",
        source: "run_orchestrator",
        runId: run.id,
        sessionId: session.id,
        userId: session.userId,
      });
    } catch {
      // Error reporting should not block failure cleanup.
    }

    const openToolCalls = await deps.store.listToolCalls(run.id);
    await Promise.all(
      openToolCalls
        .filter((toolCall) => toolCall.status === "running" || toolCall.status === "queued")
        .map((toolCall) => deps.store.finishToolCall(toolCall.id, "failed", {
          ok: false,
          error: error instanceof Error ? error.message : "Unknown orchestrator error",
        })),
    );
    await finalizeRunState("failed");

    const failureMessage = userFacingRunFailureMessage(error);
    const failureResearchDocumentHtml = await appendFinalAnswerResearchDocumentHtml(
      deps,
      session.id,
      liveResearchDocumentHtml,
      [],
      failureMessage,
    );
    await appendRunErrorMessageOnce(deps, session.id, run.id, failureMessage, {
      runId: run.id,
      phase: "error",
    });
    await streamAssistantText(failureMessage, send);
    await send("assistant.completed", {
      answer: failureMessage,
      citations: [],
      artifactKey: null,
      phase: "error",
    });
    recordRawLog("assistant.completed", {
      answer: failureMessage,
      citations: [],
      artifactKey: null,
    });
    await send("run.completed", {
      runId: run.id,
      sessionId: session.id,
      status: "failed",
      completionMode: "failed",
    });
    recordRawLog("run.completed", {
      runId: run.id,
      sessionId: session.id,
      status: "failed",
      completionMode: "failed",
      error: error instanceof Error ? error.message : "Unknown orchestrator error",
    });
    return;
  } finally {
    await harvestPendingWorkspace(true);
    if (runFinalized) {
      return;
    }
    if (pendingSessionTitleUpdate) {
      await pendingSessionTitleUpdate;
    }
    if (rawLogPersistTimer) {
      clearTimeout(rawLogPersistTimer);
      rawLogPersistTimer = null;
    }
    if (researchDocumentPersistTimer) {
      clearTimeout(researchDocumentPersistTimer);
      researchDocumentPersistTimer = null;
    }
    await rawLogPersistChain;
    scheduleResearchDocumentPersist(true);
    await researchDocumentPersistChain;
    await persistRunStreamArtifact(deps, session.id, run.id, rawRunLog);
    await destroyTrackedRuntimes(deps, { sessionId: session.id, runId: run.id }, runtimeIdsToCleanup);
    await reapExpiredRuntimeInstances(deps, { runId: run.id });
    activeRuns.delete(run.id);
  }
}

const DEFAULT_RUNTIME_GATEWAY: RuntimeToolGateway = {
  async createWorkspace() {
    return { ok: false, error: "disabled" };
  },
  async runWorkspaceTask() {
    return { ok: false, error: "disabled" };
  },
  async runSpriteFanoutResearch() {
    return { ok: false, error: "disabled" };
  },
  async readWorkspaceFile() {
    return { ok: false, error: "disabled" };
  },
  async destroyWorkspace() {
    return { ok: false, error: "disabled" };
  },
};

const DEFAULT_SYNTHESIZER: Synthesizer = {
  async synthesize(input) {
    return {
      answer: input.plannerDraft ?? "No synthesized answer was available.",
      citations: input.plannerCitations,
    };
  },
};

export function createApp(inputDeps: CreateAppInput) {
  const deps: AppDeps = {
    ...inputDeps,
    planner: inputDeps.planner ?? new FallbackPlanner(),
    embedder: inputDeps.embedder ?? new HashEmbedder(),
    synthesizer: inputDeps.synthesizer ?? DEFAULT_SYNTHESIZER,
    blobStore: inputDeps.blobStore ?? new MemoryBlobStore(),
    runtimeGateway: inputDeps.runtimeGateway ?? DEFAULT_RUNTIME_GATEWAY,
    queues: inputDeps.queues ?? {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  };
  const app = new Hono();
  const activeRuns = new Map<string, ActiveRunState>();
  app.onError(async (error, c) => {
    try {
      await recordUnexpectedError(deps, error, {
        request: c.req.raw,
        route: c.req.path,
        method: c.req.method,
      });
    } catch {
      // Fall through to the response even if incident capture fails.
    }
    return applyCorsHeaders(
      deps,
      c,
      c.json({ error: error instanceof Error ? error.message : "Internal server error." }, 500),
    );
  });
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) {
          return origin;
        }
        if (isAllowedWebOrigin(deps, origin)) {
          return origin;
        }
        return "";
      },
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type", "authorization", "payment-signature", "x-payment"],
      exposeHeaders: ["content-type", "payment-required", "x-payment-required", "PAYMENT-REQUIRED", "payment-response", "x-payment-response", "PAYMENT-RESPONSE"],
      credentials: true,
      maxAge: 86400,
    }),
  );

  async function resolvePrincipal(c: Context): Promise<AuthPrincipal | null> {
    const bearerToken = bearerTokenFromRequest(c.req.raw);
    if (bearerToken) {
      const agent = await deps.store.authenticateAgentApiKey(await sha256Hex(bearerToken));
      if (agent) {
        const user = await deps.store.getUserProfile(agent.userId);
        if (user) {
          return {
            kind: "agent",
            user,
            agent,
          };
        }
      }
    }
    if (deps.auth?.isConfigured()) {
      const user = await deps.auth.getCurrentUser(c);
      return user ? { kind: "user", user } : null;
    }
    const userId = c.req.query("userId");
    if (!userId) {
      return null;
    }
    await deps.store.ensureUser(userId);
    const user = await deps.store.getUserProfile(userId);
    return user ? { kind: "user", user } : null;
  }

  async function resolveUser(c: Context) {
    const principal = await resolvePrincipal(c);
    return principal?.user ?? null;
  }

  async function requireAdmin(c: Context) {
    const principal = await resolvePrincipal(c);
    if (!principal || principal.kind !== "user" || !isAdminUser(principal.user, deps.adminAllowedEmail)) {
      return null;
    }
    return principal.user;
  }

  async function canAccessSession(c: Context, session: SessionRecord) {
    const principal = await resolvePrincipal(c);
    if (!principal) {
      return !(deps.auth?.isConfigured() ?? false);
    }
    if (principal.kind === "agent") {
      return principal.user.id === session.userId;
    }
    if (!(deps.auth?.isConfigured() ?? false)) {
      return true;
    }
    if (!principal.user) {
      return false;
    }
    if (principal.user.id === session.userId || isAdminUser(principal.user, deps.adminAllowedEmail)) {
      return true;
    }
    const owningAgent = await deps.store.getAgentIdentityByUserId(session.userId);
    return owningAgent?.ownerUserId === principal.user.id;
  }

  async function canAccessComprehensiveJob(c: Context, ownerUserId: string | null | undefined) {
    if (!(deps.auth?.isConfigured() ?? false)) {
      return true;
    }
    const principal = await resolvePrincipal(c);
    if (!principal) {
      return false;
    }
    if (principal.kind === "agent") {
      return principal.user.id === ownerUserId;
    }
    return principal.user.id === ownerUserId || isAdminUser(principal.user, deps.adminAllowedEmail);
  }

  function requireTrustedBrowserRequest(c: Context) {
    if (bearerTokenFromRequest(c.req.raw)) {
      return null;
    }
    if (!(deps.auth?.isConfigured() ?? false)) {
      return null;
    }
    const origin = c.req.header("origin");
    if (origin && isAllowedWebOrigin(deps, origin)) {
      return null;
    }
    const secFetchSite = c.req.header("sec-fetch-site");
    if (secFetchSite === "same-origin" || secFetchSite === "same-site") {
      return null;
    }
      return applyCorsHeaders(deps, c, c.json({ error: "Cross-site requests are not allowed." }, 403));
  }

  async function fetchComprehensiveJobResponse(
    jobId: string,
    pathname: string,
    init?: RequestInit,
  ) {
    if (!deps.comprehensiveJobs) {
      throw new Error("Comprehensive job coordinator is not configured.");
    }
    const stub = deps.comprehensiveJobs.get(deps.comprehensiveJobs.idFromName(jobId));
    return stub.fetch(`https://comprehensive-job.internal${pathname}`, init);
  }

  async function fetchComprehensiveJobJson<T>(
    jobId: string,
    pathname: string,
    init?: RequestInit,
  ): Promise<T> {
    const response = await fetchComprehensiveJobResponse(jobId, pathname, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `Comprehensive job request failed with ${response.status}.`);
    }
    return text ? JSON.parse(text) as T : {} as T;
  }

  async function respondWithLoggedError(
    c: Context,
    error: unknown,
    fallbackMessage: string,
    options: {
      statusCode?: number;
      source?: string;
      toolName?: string;
      runId?: string | null;
      sessionId?: string | null;
      userId?: string | null;
      extra?: Record<string, unknown>;
    } = {},
  ) {
    try {
      await recordUnexpectedError(deps, error, {
        request: c.req.raw,
        route: c.req.path,
        method: c.req.method,
        statusCode: 500,
        source: options.source,
        toolName: options.toolName,
        runId: options.runId ?? null,
        sessionId: options.sessionId ?? null,
        userId: options.userId ?? null,
        extra: options.extra,
      });
    } catch {
      // Preserve the original response if incident capture fails.
    }
    return applyCorsHeaders(
      deps,
      c,
      c.json({ error: error instanceof Error ? error.message : fallbackMessage }, 500),
    );
  }

  function toPublicProfile(profile: Awaited<ReturnType<AppStore["getUserProfile"]>>) {
    if (!profile) {
      return null;
    }
    return {
      ...profile,
      email: null,
    };
  }

  app.get("/health", async (c) => {
    const database = await deps.store.healthCheck();
    return c.json({
      status: "ok",
      service: `${deps.implementation?.id ?? "alphabook"}-orchestrator-worker`,
      database,
      r2: "bound",
      authConfigured: deps.auth?.isConfigured() ?? false,
      queues: {
        ingest: deps.queues.ingestName,
        jobs: deps.queues.jobsName,
      },
      limits: {
        maxTurns: HARD_LIMITS.MAX_TURNS,
        maxRuntimeTasksPerRun: HARD_LIMITS.MAX_RUNTIME_TASKS_PER_RUN,
        maxRunWallClockSeconds: HARD_LIMITS.MAX_RUN_WALL_CLOCK_SECONDS,
      },
    });
  });

  app.get("/skill.md", (c) => {
    const apiBase = `${new URL(c.req.url).origin}/api/v1`;
    const implementationId = deps.implementation?.id ?? "alphabook";
    const skill = [
      "---",
      `name: ${implementationId}`,
      "version: 1.0.0",
      `description: Agent-facing research access for ${productName(deps)}'s corpus and retrieval runtime.`,
      `homepage: ${new URL(c.req.url).origin}`,
      `metadata: ${JSON.stringify({ [implementationId]: { api_base: apiBase, category: "research" } })}`,
      "---",
      "",
      `# ${productName(deps)}`,
      "",
      `If a human sends you this file, you are the AI agent that should connect to ${productName(deps)} over the CLI.`,
      "",
      "## What to do",
      "",
      "1. Register yourself.",
      "2. Save the returned `api_key`.",
      "3. Send the returned `claim_url` back to your human.",
      `4. Tell them to open the claim URL while signed into ${productName(deps)}.`,
      "5. Use the same API key for future research requests.",
      "",
      "## Register first",
      "",
      "```bash",
      `curl -X POST ${apiBase}/agents/register \\`,
      "  -H \"Content-Type: application/json\" \\",
      "  -d '{\"name\":\"YourAgentName\",\"description\":\"What you research\"}'",
      "```",
      "",
      "## Check your identity",
      "",
      "```bash",
      `curl ${apiBase}/agents/me \\`,
      "  -H \"Authorization: Bearer YOUR_API_KEY\"",
      "```",
      "",
      "## Run research from the CLI",
      "",
      "```bash",
      `curl -N -X POST ${apiBase}/documents/chat \\`,
      "  -H \"Authorization: Bearer YOUR_API_KEY\" \\",
      "  -H \"Content-Type: application/json\" \\",
      "  -d '{\"message\":\"Find cases about equal protection and segregation\"}'",
      "```",
      "",
      "## Session endpoints",
      "",
      `- \`POST ${apiBase}/chat\` streams the compatibility API`,
      `- \`POST ${apiBase}/documents/chat\` streams the neutral document API`,
      `- \`GET ${apiBase}/sessions\` lists your sessions`,
      `- \`GET ${apiBase}/sessions/:sessionId/runs\` lists runs for a session`,
      `- \`GET ${apiBase}/sessions/:sessionId/runs/:runId\` returns run status, tool trace, and artifacts`,
      `- \`GET ${apiBase}/sessions/:sessionId/runs/:runId/logs\` returns the full transcript and artifacts`,
      `- \`GET ${apiBase}/sessions/:sessionId/messages\` returns the transcript`,
      `- \`GET ${apiBase}/agents/me\` returns your agent identity`,
      "",
      "## Auth",
      "",
      "Use `Authorization: Bearer YOUR_API_KEY` on every CLI request.",
      "",
      "## Billing",
      "",
      `If ${productName(deps)} replies with HTTP 402, inspect the JSON body plus the \`PAYMENT-REQUIRED\` or \`payment-required\` headers for x402 requirements.`,
      "When you pay, retry the same request with `PAYMENT-SIGNATURE` and read `PAYMENT-RESPONSE` on success.",
    ].join("\n");
    return c.text(skill, 200, {
      "content-type": "text/markdown; charset=utf-8",
    });
  });

  app.get("/me", async (c) => {
    const principal = await resolvePrincipal(c);
    const user = principal?.user ?? null;
    return c.json({
      authenticated: Boolean(user),
      authConfigured: deps.auth?.isConfigured() ?? false,
      user: user ?? null,
      auth: principal
        ? {
            type: principal.kind,
            agent: principal.kind === "agent" ? publicAgentIdentity(principal.agent) : null,
          }
        : null,
    }, 200, {
      "cache-control": "private, no-store, max-age=0",
      pragma: "no-cache",
    });
  });

  app.get("/notifications", async (c) => {
    const principal = await resolvePrincipal(c);
    if (!principal || principal.kind !== "user") {
      return c.json({ error: "Authentication required." }, deps.auth?.isConfigured() ? 401 : 400);
    }
    try {
      const [notifications, unreadCount] = await Promise.all([
        deps.store.listNotifications(principal.user.id, { limit: 100 }),
        deps.store.countUnreadNotifications(principal.user.id),
      ]);
      return c.json({ notifications, unreadCount });
    } catch (error) {
      return respondWithLoggedError(c, error, "Failed to load notifications.", {
        source: "notifications_list",
      });
    }
  });

  app.post("/notifications/read-all", async (c) => {
    const principal = await resolvePrincipal(c);
    if (!principal || principal.kind !== "user") {
      return c.json({ error: "Authentication required." }, deps.auth?.isConfigured() ? 401 : 400);
    }
    try {
      const updatedCount = await deps.store.markAllNotificationsRead(principal.user.id);
      return c.json({ ok: true, updatedCount });
    } catch (error) {
      return respondWithLoggedError(c, error, "Failed to update notifications.", {
        source: "notifications_read_all",
      });
    }
  });

  app.post("/notifications/:notificationId/read", async (c) => {
    const principal = await resolvePrincipal(c);
    if (!principal || principal.kind !== "user") {
      return c.json({ error: "Authentication required." }, deps.auth?.isConfigured() ? 401 : 400);
    }
    try {
      const updated = await deps.store.markNotificationRead(c.req.param("notificationId"), principal.user.id);
      if (!updated) {
        return c.json({ error: "Notification not found." }, 404);
      }
      return c.json({ ok: true });
    } catch (error) {
      return respondWithLoggedError(c, error, "Failed to update the notification.", {
        source: "notification_read",
      });
    }
  });

  app.post("/api/v1/agents/register", async (c) => {
    const payload = AgentRegistrationRequestSchema.parse(await c.req.json());
    const registration = await registerAgentIdentity(deps, c.req.raw, payload);
    return c.json({
      api_key: registration.apiKey,
      claim_url: registration.claimUrl,
      verification_code: registration.agent.verificationCode,
      status: registration.agent.status,
      agent: {
        ...publicAgentIdentity(registration.agent),
        claimUrl: registration.claimUrl,
        verificationCode: registration.agent.verificationCode,
      },
    }, 201);
  });

  app.get("/api/v1/agents/me", async (c) => {
    const principal = await resolvePrincipal(c);
    if (!principal || principal.kind !== "agent") {
      return c.json({ error: "Agent API key required." }, 401);
    }
    return c.json({
      authenticated: true,
      authType: "agent",
      user: principal.user,
      agent: publicAgentIdentity(principal.agent),
    });
  });

  app.get("/claim/:claimToken", async (c) => {
    const claimToken = c.req.param("claimToken");
    const agent = await deps.store.getAgentIdentityByClaimToken(claimToken);
    if (!agent) {
      return c.text("Claim not found.", 404);
    }
    if (!deps.auth?.isConfigured()) {
      return c.text("Browser claim flow requires account auth to be configured.", 501);
    }
    const principal = await resolvePrincipal(c);
    if (!principal || principal.kind !== "user") {
      const currentUrl = new URL(c.req.url).toString();
      return c.redirect(`/auth/sign-in?returnTo=${encodeURIComponent(currentUrl)}`, 302);
    }
    const claimed = await deps.store.claimAgentIdentity(claimToken, principal.user.id);
    if (!claimed) {
      return c.text("Unable to claim this agent identity.", 400);
    }
    return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${productName(deps)} agent claimed</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: Manrope, system-ui, sans-serif; background: #f6f0e7; color: #1f1c17; padding: 48px 24px; }
      main { max-width: 640px; margin: 0 auto; background: #fffaf4; border: 1px solid #dfd2c2; border-radius: 20px; padding: 32px; }
      h1 { margin-top: 0; }
      code { background: #f1e4d3; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Agent claimed</h1>
      <p><strong>${claimed.name}</strong> is now attached to your ${productName(deps)} account.</p>
      <p>The agent can keep using its existing API key over the CLI. Its verification code is <code>${claimed.verificationCode}</code>.</p>
      <p>You can close this tab and return to your agent.</p>
    </main>
  </body>
</html>`);
  });

  app.get("/api/v1/agent-keys", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const principal = await resolvePrincipal(c);
    if (!principal || principal.kind !== "user") {
      return c.json({ error: "Authentication required." }, deps.auth?.isConfigured() ? 401 : 400);
    }
    const keys = await deps.store.listAgentIdentitiesByOwner(principal.user.id);
    return c.json({ keys: keys.map((key) => publicAgentIdentity(key)) });
  });

  app.post("/api/v1/agent-keys", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const principal = await resolvePrincipal(c);
    if (!principal || principal.kind !== "user") {
      return c.json({ error: "Authentication required." }, deps.auth?.isConfigured() ? 401 : 400);
    }
    const payload = AgentRegistrationRequestSchema.parse(await c.req.json());
    const registration = await registerAgentIdentity(deps, c.req.raw, payload, principal.user.id);
    return c.json({
      api_key: registration.apiKey,
      key: {
        ...publicAgentIdentity(registration.agent),
        claimUrl: registration.claimUrl,
      },
    }, 201);
  });

  app.post("/a", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    let payload: Record<string, unknown> | null = null;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Invalid analytics payload." }, 400);
    }
    const eventName = typeof payload?.event === "string" ? payload.event.trim() : "";
    if (!eventName) {
      return c.json({ error: "event is required." }, 400);
    }
    const user = await resolveUser(c);
    const details = payload && typeof payload.properties === "object" && payload.properties
      ? payload.properties as Record<string, unknown>
      : {};
    try {
      await recordAnalyticsEvent(deps, c.req.raw, eventName, {
        userId: user?.id ?? (typeof payload?.userId === "string" ? payload.userId : null),
        authenticated: Boolean(user),
        details,
      });
      return c.json({ ok: true });
    } catch (error) {
      return respondWithLoggedError(c, error, "Failed to store analytics event.", {
        source: "analytics_ingest",
      });
    }
  });

  app.get("/admin/access", async (c) => {
    const user = await resolveUser(c);
    return c.json({
      allowed: isAdminUser(user, deps.adminAllowedEmail),
      authenticated: Boolean(user),
      authConfigured: deps.auth?.isConfigured() ?? false,
      user: user ?? null,
    });
  });

  app.get("/admin/users", async (c) => {
    const admin = await requireAdmin(c);
    if (!admin) {
      return c.json({ error: "Not authorized." }, 403);
    }
    try {
      const users = await deps.store.listUsers();
      return c.json({ users });
    } catch (error) {
      return respondWithLoggedError(c, error, "Failed to load users.", {
        source: "admin_users",
      });
    }
  });

  app.get("/admin/runs", async (c) => {
    const admin = await requireAdmin(c);
    if (!admin) {
      return c.json({ error: "Not authorized." }, 403);
    }
    try {
      const runs = await deps.store.listAllRuns();
      return c.json({ runs });
    } catch (error) {
      return respondWithLoggedError(c, error, "Failed to load runs.", {
        source: "admin_runs",
      });
    }
  });

  app.get("/admin/sessions", async (c) => {
    const admin = await requireAdmin(c);
    if (!admin) {
      return c.json({ error: "Not authorized." }, 403);
    }
    try {
      const sessions = await deps.store.listAdminSessions();
      return c.json({ sessions });
    } catch (error) {
      return respondWithLoggedError(c, error, "Failed to load sessions.", {
        source: "admin_sessions",
      });
    }
  });

  app.get("/admin/incidents", async (c) => {
    const admin = await requireAdmin(c);
    if (!admin) {
      return c.json({ error: "Not authorized." }, 403);
    }
    const days = Number(c.req.query("days") ?? "7");
    const query = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit") ?? "50");
    const eventLimit = Number(c.req.query("eventLimit") ?? "400");
    try {
      return c.json(await listAdminIncidentsWithFilters(deps, {
        days: Number.isFinite(days) ? days : 7,
        query,
        limit: Number.isFinite(limit) ? limit : 50,
        eventLimit: Number.isFinite(eventLimit) ? eventLimit : 400,
      }));
    } catch (error) {
      return respondWithLoggedError(c, error, "Failed to load incidents.", {
        source: "admin_incidents",
      });
    }
  });

  app.post("/admin/analytics/query", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const admin = await requireAdmin(c);
    if (!admin) {
      return c.json({ error: "Not authorized." }, 403);
    }
    const payload = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const query = typeof payload?.query === "string" ? payload.query.trim() : "";
    const days = typeof payload?.days === "number" ? payload.days : 7;
    if (!query) {
      return c.json({ error: "query is required." }, 400);
    }
    try {
      const result = await runAnalyticsQuery(deps, { query, days });
      return c.json(result);
    } catch (error) {
      return respondWithLoggedError(c, error, "Analytics query failed.", {
        source: "admin_analytics_query",
      });
    }
  });

  app.get("/profiles/:userId", async (c) => {
    const targetUserId = c.req.param("userId");
    const profile = await deps.store.getUserProfile(targetUserId);
    if (!profile) {
      return c.json({ error: "Profile not found." }, 404);
    }
    const viewer = await resolveUser(c);
    const isSelf = Boolean(viewer && viewer.id === targetUserId);
    const isFollowing = viewer && !isSelf ? await deps.store.isFollowing(viewer.id, targetUserId) : false;
    return c.json({
      profile: isSelf ? profile : toPublicProfile(profile),
      isFollowing,
      isSelf,
    });
  });

  app.get("/profiles/:userId/stats", async (c) => {
    const targetUserId = c.req.param("userId");
    const viewer = await resolveUser(c);
    const profile = await deps.store.getUserProfile(targetUserId);
    if (!profile) {
      return c.json({ error: "Profile not found." }, 404);
    }
    const stats = await deps.store.getUserProfileStats(targetUserId);
    const isSelf = Boolean(viewer && viewer.id === targetUserId);
    return c.json({ stats });
  });

  app.post("/profiles/:userId/follow", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const viewer = await resolveUser(c);
    if (!viewer) {
      return c.json({ error: "Authentication required." }, deps.auth?.isConfigured() ? 401 : 400);
    }
    const targetUserId = c.req.param("userId");
    const profile = await deps.store.getUserProfile(targetUserId);
    if (!profile) {
      return c.json({ error: "Profile not found." }, 404);
    }
    if (viewer.id !== targetUserId) {
      await deps.store.followUser(viewer.id, targetUserId);
    }
    const refreshed = await deps.store.getUserProfile(targetUserId);
    return c.json({
      ok: true,
      profile: viewer.id === targetUserId ? (refreshed ?? profile) : toPublicProfile(refreshed ?? profile),
      isFollowing: viewer.id !== targetUserId,
    });
  });

  app.post("/profiles/:userId/claim-guest", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const viewer = await resolveUser(c);
    if (!viewer) {
      return c.json({ error: "Authentication required." }, deps.auth?.isConfigured() ? 401 : 400);
    }
    const targetUserId = c.req.param("userId");
    if (viewer.id !== targetUserId) {
      return c.json({ error: "Not authorized." }, 403);
    }
    const payload = await c.req.json().catch(() => null) as { guestUserId?: unknown } | null;
    const guestUserId = typeof payload?.guestUserId === "string" ? payload.guestUserId.trim() : "";
    if (!guestUserId) {
      return c.json({ error: "guestUserId is required." }, 400);
    }
    await deps.store.claimGuestUserData(guestUserId, targetUserId);
    return c.json({ ok: true });
  });

  app.delete("/profiles/:userId/follow", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const viewer = await resolveUser(c);
    if (!viewer) {
      return c.json({ error: "Authentication required." }, deps.auth?.isConfigured() ? 401 : 400);
    }
    const targetUserId = c.req.param("userId");
    const profile = await deps.store.getUserProfile(targetUserId);
    if (!profile) {
      return c.json({ error: "Profile not found." }, 404);
    }
    if (viewer.id !== targetUserId) {
      await deps.store.unfollowUser(viewer.id, targetUserId);
    }
    const refreshed = await deps.store.getUserProfile(targetUserId);
    return c.json({
      ok: true,
      profile: viewer.id === targetUserId ? (refreshed ?? profile) : toPublicProfile(refreshed ?? profile),
      isFollowing: false,
    });
  });

  app.get("/auth/sign-in", async (c) => {
    if (!deps.auth?.isConfigured()) {
      return c.json({ error: "Authentication is not configured." }, 501);
    }
    void recordAnalyticsEvent(deps, c.req.raw, "sign_in", {
      returnTo: c.req.query("returnTo") ?? null,
    }).catch(() => {});
    return deps.auth.signIn(c);
  });

  app.get("/auth/sign-up", async (c) => {
    if (!deps.auth?.isConfigured()) {
      return c.json({ error: "Authentication is not configured." }, 501);
    }
    void recordAnalyticsEvent(deps, c.req.raw, "sign_up", {
      returnTo: c.req.query("returnTo") ?? null,
    }).catch(() => {});
    return deps.auth.signUp(c);
  });

  app.get("/auth/callback", async (c) => {
    if (!deps.auth?.isConfigured()) {
      return c.json({ error: "Authentication is not configured." }, 501);
    }
    return deps.auth.callback(c);
  });

  app.get("/auth/sign-out", async (c) => {
    if (!deps.auth?.isConfigured()) {
      return c.redirect(siteOrigin(deps), 302);
    }
    const redirectTo = await deps.auth.signOut(c);
    return c.redirect(redirectTo, 302);
  });

  app.post("/auth/sign-out", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    if (!deps.auth?.isConfigured()) {
      return c.json({ redirectTo: siteOrigin(deps) });
    }
    const redirectTo = await deps.auth.signOut(c);
    return c.json({ redirectTo });
  });

  app.get("/internal/runtime-file", async (c) => {
    const expectedToken = deps.runtimeSharedToken?.trim() ?? "";
    const bearerToken = bearerTokenFromRequest(c.req.raw);
    const queryToken = c.req.query("token")?.trim() ?? "";
    if (!expectedToken || (bearerToken !== expectedToken && queryToken !== expectedToken)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const key = c.req.query("key")?.trim() ?? "";
    if (!key) {
      return c.json({ error: "key is required." }, 400);
    }
    const object = await deps.blobStore.getObject(key);
    if (!object) {
      return c.json({ error: "File not found." }, 404);
    }
    return new Response(await object.arrayBuffer(), {
      status: 200,
      headers: {
        "content-type": object.contentType ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  });

  const handleChatRequest = async (c: Context) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const requestBody = await c.req.json();
    const usePlatformChatContract = c.req.path === "/api/v1/documents/chat";
    const payload = usePlatformChatContract
      ? toLegacyChatRequest(PlatformChatRequestSchema.parse(requestBody))
      : ChatRequestSchema.parse(requestBody);
    const principal = await resolvePrincipal(c);
    const user = principal?.user ?? null;
    if ((deps.auth?.isConfigured() ?? false) && !user && !bearerTokenFromRequest(c.req.raw)) {
      return c.json({ error: "Authentication required." }, 401);
    }
    if (!user && !payload.userId) {
      return c.json({ error: "userId is required when authentication is disabled." }, 400);
    }
    const requestPayload: ChatRequest = {
      ...payload,
      userId: user?.id ?? payload.userId,
    };
    if (!requestPayload.mode) {
      const inferredMode = inferExplicitAssistantMode(requestPayload.message);
      if (inferredMode) {
        requestPayload.mode = inferredMode;
      }
    }
    let existingSession: SessionRecord | null = null;
    if (requestPayload.sessionId) {
      existingSession = await deps.store.getSession(requestPayload.sessionId);
      if (existingSession && existingSession.userId !== requestPayload.userId) {
        return c.json({ error: "Not authorized for this session." }, 403);
      }
    }
    const billingUserId = requestPayload.userId;
    if (!billingUserId) {
      return c.json({ error: "userId is required when authentication is disabled." }, 400);
    }
    const billingCheck = await deps.billing.check(billingUserId);
    let settledPayment: SettleResponse | null = null;
    if (!billingCheck.allowed) {
      const x402Result = await verifyAndSettleX402Payment(deps, c.req.raw, billingCheck);
      if (x402Result.ok) {
        settledPayment = x402Result.settlement;
      } else if (x402Result.response) {
        return x402Result.response;
      }
      const paymentRequirements = await createX402PaymentRequirements(deps, c.req.raw, billingCheck);
      const x402 = await createX402PaymentRequired(deps, c.req.raw);
      if (paymentRequirements) {
        if (x402) {
          c.header("payment-required", encodePaymentRequiredHeader(x402.paymentRequired));
        }
        c.header("x-payment-required", encodeBase64Json(paymentRequirements));
      }
      if (!settledPayment) {
      return c.json({
        error: "Monthly AI usage limit reached.",
        code: "billing_limit_exceeded",
        limitUsd: billingCheck.limitUsd,
        spendUsd: billingCheck.spendUsd,
        windowStartedAt: billingCheck.windowStartedAt,
        paymentRequirements,
      }, 402);
      }
    }
    const response = streamQueuedEventsResponse(
      async (send) => {
        let executionCtx: ExecutionContext | null = null;
        let precomputedRouteDecision: RouterDecision | undefined;
        try {
          executionCtx = c.executionCtx;
        } catch {
          executionCtx = null;
        }
        if (!requestPayload.mode && requestPayload.workflow !== "search" && requestPayload.workflow !== "design_experiment" && deps.router) {
          const conversationHistory = existingSession
            ? formatConversationHistory(await deps.store.listMessages(existingSession.id))
            : [];
          precomputedRouteDecision = await deps.router.decide({
            userMessage: requestPayload.message,
            requestedWorkflow: requestPayload.workflow,
            conversationHistory,
          });
          if (precomputedRouteDecision.type === "search") {
            requestPayload.mode = precomputedRouteDecision.executionMode ?? "agentic";
          }
        }
        if (requestedAssistantMode(requestPayload) === "agentic" && !deps.hermesJobApiUrl) {
          throw new Error("Agentic search mode is not configured for this environment.");
        }
        const sendEvent = usePlatformChatContract
          ? async (event: string, data: Record<string, unknown>) => send(event, toPlatformEventPayload(data) as Record<string, unknown>)
          : send;
        const runPromise = shouldUseHermesBackend(deps, requestPayload)
          ? runHermesConversation(
              deps,
              c.req.raw,
              requestPayload,
              sendEvent,
              activeRuns,
            )
          : runOrchestrator(
              deps,
              c.req.raw,
              requestPayload,
              sendEvent,
              activeRuns,
              { precomputedRouteDecision },
            );
        if (executionCtx && typeof executionCtx.waitUntil === "function") {
          executionCtx.waitUntil(runPromise);
        }
        await runPromise;
      },
      (error) =>
        recordUnexpectedError(deps, error, {
          request: c.req.raw,
          route: c.req.path,
          method: c.req.method,
          source: "chat_stream",
          userId: requestPayload.userId ?? null,
          sessionId: requestPayload.sessionId ?? null,
        }),
    );
    if (settledPayment) {
      response.headers.set("payment-response", encodePaymentResponseHeader(settledPayment));
      response.headers.set("x-payment-response", encodeBase64Json(settledPayment));
    }
    return response;
  };

  app.post("/chat", handleChatRequest);
  app.post("/api/v1/chat", handleChatRequest);
  app.post("/api/v1/documents/chat", handleChatRequest);

  const ComprehensiveJobRequestSchema = z.object({
    prompt: z.string().trim().min(1),
    sessionId: z.string().trim().min(1).optional(),
    userId: z.string().trim().min(1).optional(),
    workIds: z.array(z.string().trim().min(1)).max(256).optional(),
    mode: z.enum(["comprehensive", "semantic"]).optional(),
    intensityOverride: z.enum(["normal", "high", "maximum"]).optional(),
    semanticBackend: z.enum(["alphaloop", "context1"]).optional(),
  });

  type ComprehensiveJobPayload = {
    job: {
      id: string;
      ownerUserId?: string | null;
    } & Record<string, unknown>;
  };

  const handleCreateComprehensiveJob = async (c: Context) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    if (!deps.comprehensiveJobs) {
      return c.json({ error: "Comprehensive jobs are not configured." }, 501);
    }
    const payload = ComprehensiveJobRequestSchema.parse(await c.req.json());
    const principal = await resolvePrincipal(c);
    const user = principal?.user ?? null;
    if ((deps.auth?.isConfigured() ?? false) && !user && !bearerTokenFromRequest(c.req.raw)) {
      return c.json({ error: "Authentication required." }, 401);
    }
    const ownerUserId = user?.id ?? payload.userId;
    if (!ownerUserId) {
      return c.json({ error: "userId is required when authentication is disabled." }, 400);
    }
    if (payload.sessionId) {
      const existingSession = await deps.store.getSession(payload.sessionId);
      if (existingSession && existingSession.userId !== ownerUserId) {
        return c.json({ error: "Not authorized for this session." }, 403);
      }
    }
    const jobId = crypto.randomUUID();
    const response = await fetchComprehensiveJobResponse(jobId, "/internal/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jobId,
        ownerUserId,
        chatRequest: {
          message: payload.prompt,
          mode: payload.mode ?? "comprehensive",
          sessionId: payload.sessionId,
          userId: ownerUserId,
          workIds: payload.workIds ?? [],
          intensityOverride: payload.intensityOverride,
          semanticBackend: payload.semanticBackend,
        } satisfies ChatRequest,
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      return c.json({ error: text || "Failed to create comprehensive job." }, response.status as never);
    }
    return c.body(text, 201, {
      "content-type": "application/json; charset=utf-8",
    });
  };

  const handleGetComprehensiveJob = async (c: Context) => {
    if (!deps.comprehensiveJobs) {
      return c.json({ error: "Comprehensive jobs are not configured." }, 501);
    }
    const jobId = c.req.param("jobId") ?? "";
    const payload = await fetchComprehensiveJobJson<ComprehensiveJobPayload>(jobId, "/job");
    if (!(await canAccessComprehensiveJob(c, payload.job.ownerUserId))) {
      return c.json({ error: "Not authorized for this job." }, 403);
    }
    return c.json(payload);
  };

  const handleGetComprehensiveJobLogs = async (c: Context) => {
    if (!deps.comprehensiveJobs) {
      return c.json({ error: "Comprehensive jobs are not configured." }, 501);
    }
    const jobId = c.req.param("jobId") ?? "";
    const summary = await fetchComprehensiveJobJson<ComprehensiveJobPayload>(jobId, "/job");
    if (!(await canAccessComprehensiveJob(c, summary.job.ownerUserId))) {
      return c.json({ error: "Not authorized for this job." }, 403);
    }
    const query = new URLSearchParams();
    const cursor = c.req.query("cursor");
    const limit = c.req.query("limit");
    const stream = c.req.query("stream");
    const includeEvents = c.req.query("include_events");
    if (cursor) {
      query.set("cursor", cursor);
    }
    if (limit) {
      query.set("limit", limit);
    }
    if (stream) {
      query.set("stream", stream);
    }
    if (includeEvents) {
      query.set("include_events", includeEvents);
    }
    const response = await fetchComprehensiveJobResponse(
      jobId,
      `/logs${query.toString() ? `?${query.toString()}` : ""}`,
    );
    const text = await response.text();
    return c.body(text, response.status as never, {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    });
  };

  const handleGetComprehensiveJobArtifacts = async (c: Context) => {
    if (!deps.comprehensiveJobs) {
      return c.json({ error: "Comprehensive jobs are not configured." }, 501);
    }
    const jobId = c.req.param("jobId") ?? "";
    const summary = await fetchComprehensiveJobJson<ComprehensiveJobPayload>(jobId, "/job");
    if (!(await canAccessComprehensiveJob(c, summary.job.ownerUserId))) {
      return c.json({ error: "Not authorized for this job." }, 403);
    }
    const response = await fetchComprehensiveJobResponse(jobId, "/artifacts");
    const text = await response.text();
    return c.body(text, response.status as never, {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    });
  };

  const handleGetComprehensiveJobArtifact = async (c: Context) => {
    if (!deps.comprehensiveJobs) {
      return c.json({ error: "Comprehensive jobs are not configured." }, 501);
    }
    const jobId = c.req.param("jobId") ?? "";
    const artifactName = c.req.param("artifactName") ?? "";
    const summary = await fetchComprehensiveJobJson<ComprehensiveJobPayload>(jobId, "/job");
    if (!(await canAccessComprehensiveJob(c, summary.job.ownerUserId))) {
      return c.json({ error: "Not authorized for this job." }, 403);
    }
    const response = await fetchComprehensiveJobResponse(jobId, `/artifacts/${encodeURIComponent(artifactName)}`);
    const text = await response.text();
    return c.body(text, response.status as never, {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    });
  };

  const handleCancelComprehensiveJob = async (c: Context) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    if (!deps.comprehensiveJobs) {
      return c.json({ error: "Comprehensive jobs are not configured." }, 501);
    }
    const jobId = c.req.param("jobId") ?? "";
    const summary = await fetchComprehensiveJobJson<ComprehensiveJobPayload>(jobId, "/job");
    if (!(await canAccessComprehensiveJob(c, summary.job.ownerUserId))) {
      return c.json({ error: "Not authorized for this job." }, 403);
    }
    const response = await fetchComprehensiveJobResponse(jobId, "/cancel", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const text = await response.text();
    return c.body(text, response.status as never, {
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    });
  };

  app.post("/v1/comprehensive-jobs", handleCreateComprehensiveJob);
  app.post("/api/v1/comprehensive-jobs", handleCreateComprehensiveJob);
  app.get("/v1/comprehensive-jobs/:jobId", handleGetComprehensiveJob);
  app.get("/api/v1/comprehensive-jobs/:jobId", handleGetComprehensiveJob);
  app.get("/v1/comprehensive-jobs/:jobId/logs", handleGetComprehensiveJobLogs);
  app.get("/api/v1/comprehensive-jobs/:jobId/logs", handleGetComprehensiveJobLogs);
  app.get("/v1/comprehensive-jobs/:jobId/artifacts", handleGetComprehensiveJobArtifacts);
  app.get("/api/v1/comprehensive-jobs/:jobId/artifacts", handleGetComprehensiveJobArtifacts);
  app.get("/v1/comprehensive-jobs/:jobId/artifacts/:artifactName", handleGetComprehensiveJobArtifact);
  app.get("/api/v1/comprehensive-jobs/:jobId/artifacts/:artifactName", handleGetComprehensiveJobArtifact);
  app.post("/v1/comprehensive-jobs/:jobId/cancel", handleCancelComprehensiveJob);
  app.post("/api/v1/comprehensive-jobs/:jobId/cancel", handleCancelComprehensiveJob);

  app.get("/sessions/:sessionId/runs/:runId/stream", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }
    const run = await deps.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      return c.json({ error: "Run not found." }, 404);
    }

    let stopped = false;

    return streamResponse(
      async (send) => {
        let lastSequence = 0;
        const existingEvents = await deps.store.listRunEvents(runId);
        if (existingEvents.length > 0) {
          lastSequence = existingEvents[existingEvents.length - 1]!.sequence;
        }

        while (!stopped) {
          let nextRun = await deps.store.getRun(runId);
          if (!nextRun || nextRun.sessionId !== sessionId) {
            await send("error", {
              message: "Run not found.",
            });
            return;
          }
          if (nextRun.status === "running" || nextRun.status === "queued") {
            try {
              await syncHermesBackgroundJob(deps, activeRuns, { session, run: nextRun, send });
              nextRun = await deps.store.getRun(runId) ?? nextRun;
            } catch {
              // Best-effort background job sync while streaming.
            }
          }
          const runEvents = await deps.store.listRunEvents(runId);

          for (const runEvent of runEvents) {
            if (runEvent.sequence <= lastSequence) {
              continue;
            }
            lastSequence = runEvent.sequence;
            await send(runEvent.event, runEvent.dataJson);
          }

          if (nextRun.status !== "running" && nextRun.status !== "queued") {
            return;
          }

          await new Promise((resolve) => {
            setTimeout(resolve, 1000);
          });
        }
      },
      undefined,
      () => {
        stopped = true;
      },
    );
  });

  app.get("/api/v1/sessions/:sessionId/runs/:runId/stream", async (c) => {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }
    const run = await deps.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      return c.json({ error: "Run not found." }, 404);
    }

    let stopped = false;

    return streamResponse(
      async (send) => {
        let lastSequence = 0;
        const existingEvents = await deps.store.listRunEvents(runId);
        if (existingEvents.length > 0) {
          lastSequence = existingEvents[existingEvents.length - 1]!.sequence;
        }

        while (!stopped) {
          let nextRun = await deps.store.getRun(runId);
          if (!nextRun || nextRun.sessionId !== sessionId) {
            await send("error", {
              message: "Run not found.",
            });
            return;
          }
          if (nextRun.status === "running" || nextRun.status === "queued") {
            try {
              await syncHermesBackgroundJob(deps, activeRuns, { session, run: nextRun, send });
              nextRun = await deps.store.getRun(runId) ?? nextRun;
            } catch {
              // Best-effort background job sync while streaming.
            }
          }
          const runEvents = await deps.store.listRunEvents(runId);

          for (const runEvent of runEvents) {
            if (runEvent.sequence <= lastSequence) {
              continue;
            }
            lastSequence = runEvent.sequence;
            await send(runEvent.event, runEvent.dataJson);
          }

          if (nextRun.status !== "running" && nextRun.status !== "queued") {
            return;
          }

          await new Promise((resolve) => {
            setTimeout(resolve, 1000);
          });
        }
      },
      undefined,
      () => {
        stopped = true;
      },
    );
  });

  app.post("/runs/:runId/cancel", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const runId = c.req.param("runId");
    const run = await deps.store.getRun(runId);
    if (!run) {
      return c.json({ error: "Run not found." }, 404);
    }
    const session = await deps.store.getSession(run.sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this run." }, 403);
    }

    const activeRun = activeRuns.get(runId);
    const runAlreadyTerminal = isTerminalRunStatus(run.status);
    if (runAlreadyTerminal) {
      return c.json({
        ok: true,
        runId,
        cancelled: false,
        alreadyTerminal: true,
        status: run.status,
        active: false,
        runtimeIds: [],
      });
    }
    if (activeRun) {
      activeRun.cancelRequested = true;
    }
    const backgroundJob = await deps.store.getLatestBackgroundJobForRun(runId);
    if (backgroundJob && backgroundJob.provider === "hermes" && deps.hermesJobApiUrl && backgroundJobIsActive(backgroundJob.status)) {
      await cancelHermesJob(deps.hermesJobApiUrl, deps.hermesJobApiToken, backgroundJob.externalJobId).catch(() => {});
      await deps.store.updateBackgroundJob(backgroundJob.id, {
        status: "cancelled",
        completedAt: new Date().toISOString(),
        error: "Run cancelled by user.",
      });
    }
    const [toolCalls, persistedRuntimeIds] = await Promise.all([
      deps.store.listToolCalls(runId),
      listPersistedRunRuntimeIds(deps, session.id, runId),
    ]);
    const runtimeIds = new Set<string>([
      ...Array.from(activeRun?.runtimeIds ?? []),
      ...persistedRuntimeIds,
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
          error: "Run cancelled by user.",
        })),
    );
    await writeTerminalRunState(deps, runId, "failed");

    return c.json({
      ok: true,
      runId,
      cancelled: true,
      active: Boolean(activeRun) || run.status === "running" || run.status === "queued",
      runtimeIds: Array.from(runtimeIds),
    });
  });

  app.post("/api/v1/runs/:runId/cancel", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const runId = c.req.param("runId");
    const run = await deps.store.getRun(runId);
    if (!run) {
      return c.json({ error: "Run not found." }, 404);
    }
    const session = await deps.store.getSession(run.sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this run." }, 403);
    }

    const activeRun = activeRuns.get(runId);
    const runAlreadyTerminal = isTerminalRunStatus(run.status);
    if (runAlreadyTerminal) {
      return c.json({
        ok: true,
        runId,
        cancelled: false,
        alreadyTerminal: true,
        status: run.status,
        active: false,
        runtimeIds: [],
      });
    }
    if (activeRun) {
      activeRun.cancelRequested = true;
    }
    const backgroundJob = await deps.store.getLatestBackgroundJobForRun(runId);
    if (backgroundJob && backgroundJob.provider === "hermes" && deps.hermesJobApiUrl && backgroundJobIsActive(backgroundJob.status)) {
      await cancelHermesJob(deps.hermesJobApiUrl, deps.hermesJobApiToken, backgroundJob.externalJobId).catch(() => {});
      await deps.store.updateBackgroundJob(backgroundJob.id, {
        status: "cancelled",
        completedAt: new Date().toISOString(),
        error: "Run cancelled by user.",
      });
    }
    const [toolCalls, persistedRuntimeIds] = await Promise.all([
      deps.store.listToolCalls(runId),
      listPersistedRunRuntimeIds(deps, session.id, runId),
    ]);
    const runtimeIds = new Set<string>([
      ...Array.from(activeRun?.runtimeIds ?? []),
      ...persistedRuntimeIds,
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
          error: "Run cancelled by user.",
        })),
    );
    await writeTerminalRunState(deps, runId, "failed");

    return c.json({
      ok: true,
      runId,
      cancelled: true,
      active: Boolean(activeRun) || run.status === "running" || run.status === "queued",
      runtimeIds: Array.from(runtimeIds),
    });
  });

  const handleListSessions = async (c: Context) => {
    const user = await resolveUser(c);
    if (!user) {
      return c.json({ error: "Authentication required." }, deps.auth?.isConfigured() ? 401 : 400);
    }
    const sessions = await deps.store.listSessions(user.id);
    return c.json({ sessions });
  };

  app.get("/sessions", handleListSessions);
  app.get("/api/v1/sessions", handleListSessions);

  const handleListMessages = async (c: Context) => {
    const sessionId = c.req.param("sessionId") ?? "";
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }
    const messages = await deps.store.listMessages(sessionId);
    return c.json({ messages });
  };

  app.get("/sessions/:sessionId/messages", handleListMessages);
  app.get("/api/v1/sessions/:sessionId/messages", handleListMessages);

  const buildRunStatePayload = async (
    sessionId: string,
    runId: string,
    options: {
      includeArtifacts?: boolean;
      includeRuntimeInstances?: boolean;
      includeBackgroundJob?: boolean;
      runEventLimit?: number | null;
    } = {},
  ) => {
    const includeArtifacts = options.includeArtifacts ?? true;
    const includeRuntimeInstances = options.includeRuntimeInstances ?? true;
    const includeBackgroundJob = options.includeBackgroundJob ?? true;
    const runEventLimit = typeof options.runEventLimit === "number" && options.runEventLimit >= 0
      ? Math.floor(options.runEventLimit)
      : null;
    const initialRun = await deps.store.getRun(runId);
    if (!initialRun || initialRun.sessionId !== sessionId) {
      return null;
    }
    let run = initialRun;
    if (!run || run.sessionId !== sessionId) {
      return null;
    }
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return null;
    }
    if (run.status === "running" || run.status === "queued") {
      try {
        await syncHermesBackgroundJob(deps, activeRuns, { session, run });
        run = await deps.store.getRun(runId) ?? run;
      } catch {
        // Best-effort state sync for active external jobs.
      }
    }
    const toolCalls = await deps.store.listToolCalls(run.id);
    const backgroundJobPromise = includeBackgroundJob
      ? deps.store.getLatestBackgroundJobForRun(run.id)
      : Promise.resolve(null);
    const [{ runtimeInstances, runEvents: fullRunEvents, runtimeIds }, planMessage, backgroundJob] = await Promise.all([
      resolveRunRuntimeContext(deps, sessionId, run, toolCalls, { runEventLimit }),
      deps.store.getLatestPlanMessageForRun(sessionId, run.id),
      backgroundJobPromise,
    ]);
    const runEvents = fullRunEvents;
    const artifacts = includeArtifacts
      ? await loadRunDocumentArtifacts(deps, sessionId, run.id, runtimeIds)
      : [];
    const toolTrace = planMessage?.metadata && typeof planMessage.metadata === "object"
      ? readPersistedPlanToolTrace(planMessage.metadata as Record<string, unknown>)
      : [];

    return {
      run,
      ...(includeBackgroundJob && backgroundJob ? { backgroundJob } : {}),
      toolCalls,
      runEvents,
      toolTrace,
      ...(includeRuntimeInstances ? { runtimeInstances } : {}),
      artifacts,
    };
  };

  const stripBootstrapMessageToolTrace = (message: MessageRecord): MessageRecord => {
    const metadata = message.metadata && typeof message.metadata === "object"
      ? { ...(message.metadata as Record<string, unknown>) }
      : {};
    if ("toolCalls" in metadata) {
      delete metadata.toolCalls;
    }
    const custom = metadata.custom && typeof metadata.custom === "object"
      ? { ...(metadata.custom as Record<string, unknown>) }
      : null;
    if (custom && "toolCalls" in custom) {
      delete custom.toolCalls;
      metadata.custom = custom;
    }
    return {
      ...message,
      metadata,
    };
  };

  const handleAssistantSessionBootstrap = async (c: Context) => {
    const sessionId = c.req.param("sessionId") ?? "";
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }

    const user = await resolveUser(c);
    if (!user) {
      return c.json({ error: "Authentication required." }, deps.auth?.isConfigured() ? 401 : 400);
    }

    const [sessions, rawMessages, runs] = await Promise.all([
      deps.store.listSessions(user.id),
      deps.store.listMessages(sessionId),
      deps.store.listRuns(sessionId),
    ]);
    const messages = rawMessages.map(stripBootstrapMessageToolTrace);
    const preferredRun =
      runs.find((run) => run.status === "running" || run.status === "queued")
      ?? [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
      ?? null;
    const runState = preferredRun
      ? await buildRunStatePayload(sessionId, preferredRun.id, {
          includeArtifacts: false,
          includeRuntimeInstances: false,
          includeBackgroundJob: false,
          runEventLimit: preferredRun.status === "running" || preferredRun.status === "queued" ? 160 : 0,
        })
      : null;

    return c.json({
      sessionId,
      sessions,
      messages,
      runs,
      runState: runState ?? undefined,
    });
  };

  app.get("/sessions/:sessionId/bootstrap", handleAssistantSessionBootstrap);
  app.get("/api/v1/sessions/:sessionId/bootstrap", handleAssistantSessionBootstrap);

  app.get("/sessions/:sessionId/runs", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }
    const runs = await deps.store.listRuns(sessionId);
    return c.json({ runs });
  });

  app.get("/api/v1/sessions/:sessionId/runs", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }
    const runs = await deps.store.listRuns(sessionId);
    return c.json({ runs });
  });

  app.get("/sessions/:sessionId/runs/:runId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }

    const payload = await buildRunStatePayload(sessionId, runId);
    if (!payload) {
      return c.json({ error: "Run not found." }, 404);
    }
    return c.json(payload);
  });

  app.get("/sessions/:sessionId/runs/:runId/document", async (c) => {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }

    const run = await deps.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      return c.json({ error: "Run not found." }, 404);
    }
    const toolCalls = await deps.store.listToolCalls(runId);
    const [{ runEvents, runtimeIds }, planMessage] = await Promise.all([
      resolveRunRuntimeContext(deps, sessionId, run, toolCalls),
      deps.store.getLatestPlanMessageForRun(sessionId, runId),
    ]);
    const artifacts = await loadRunDocumentArtifacts(deps, sessionId, runId, runtimeIds);
    const toolTrace = planMessage?.metadata && typeof planMessage.metadata === "object"
      ? readPersistedPlanToolTrace(planMessage.metadata as Record<string, unknown>)
      : [];

    return c.json({
      run,
      runEvents,
      toolTrace,
      artifacts,
    });
  });

  app.get("/api/v1/sessions/:sessionId/runs/:runId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }

    const payload = await buildRunStatePayload(sessionId, runId);
    if (!payload) {
      return c.json({ error: "Run not found." }, 404);
    }
    return c.json(payload);
  });

  app.get("/api/v1/sessions/:sessionId/runs/:runId/document", async (c) => {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }

    const run = await deps.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      return c.json({ error: "Run not found." }, 404);
    }
    const toolCalls = await deps.store.listToolCalls(runId);
    const [{ runEvents, runtimeIds }, planMessage] = await Promise.all([
      resolveRunRuntimeContext(deps, sessionId, run, toolCalls),
      deps.store.getLatestPlanMessageForRun(sessionId, runId),
    ]);
    const artifacts = await loadRunDocumentArtifacts(deps, sessionId, runId, runtimeIds);
    const toolTrace = planMessage?.metadata && typeof planMessage.metadata === "object"
      ? readPersistedPlanToolTrace(planMessage.metadata as Record<string, unknown>)
      : [];

    return c.json({
      run,
      runEvents,
      toolTrace,
      artifacts,
    });
  });

  app.get("/sessions/:sessionId/debug", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }
    const [messages, runs, runtimeInstances, artifacts] = await Promise.all([
      deps.store.listMessages(sessionId),
      deps.store.listRuns(sessionId),
      deps.store.listRuntimeInstances(sessionId),
      deps.store.listArtifacts(sessionId),
    ]);
    const toolCallsByRun = Object.fromEntries(
      await Promise.all(
        runs.map(async (run) => [run.id, await deps.store.listToolCalls(run.id)]),
      ),
    );
    const rawLogByRun = Object.fromEntries(
      await Promise.all(
        runs.map(async (run) => {
          const { runtimeIds } = await resolveRunRuntimeContext(deps, sessionId, run, toolCallsByRun[run.id] ?? []);
          const persistedRawLog = await loadPersistedRawRunLog(deps, sessionId, run.id);
          return [run.id, persistedRawLog];
        }),
      ),
    );

    return c.json({
      session,
      messages,
      runs,
      toolCallsByRun,
      rawLogByRun,
      runtimeInstances,
      artifacts,
    });
  });

  app.get("/sessions/:sessionId/bridge", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }
    return c.json(await buildSessionBridgePayload(deps, session));
  });

  app.get("/api/v1/sessions/:sessionId/bridge", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }
    return c.json(await buildSessionBridgePayload(deps, session));
  });

  app.get("/sessions/:sessionId/runs/:runId/debug", async (c) => {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }

    const run = await deps.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      return c.json({ error: "Run not found." }, 404);
    }
    const toolCalls = await deps.store.listToolCalls(runId);
    return c.json(await buildRunLogsPayload(c, deps, session, run, toolCalls));
  });

  app.get("/sessions/:sessionId/runs/:runId/logs", async (c) => {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }

    const run = await deps.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      return c.json({ error: "Run not found." }, 404);
    }
    const toolCalls = await deps.store.listToolCalls(runId);
    return c.json(await buildRunLogsPayload(c, deps, session, run, toolCalls));
  });

  app.get("/sessions/:sessionId/runs/:runId/output", async (c) => {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }
    const run = await deps.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      return c.json({ error: "Run not found." }, 404);
    }
    const toolCalls = await deps.store.listToolCalls(runId);
    const runContext = await resolveRunRuntimeContext(deps, sessionId, run, toolCalls, { runEventLimit: 400 });
    const backgroundJob = await deps.store.getLatestBackgroundJobForRun(run.id);
    const bridge = await resolveHermesBridgeRecord(deps, backgroundJob);
    const rawLog = await loadPersistedRawRunLog(deps, sessionId, run.id);
    return c.json({
      runId: run.id,
      text: summarizeDetailedRunOutputLines(run, backgroundJob, bridge, runContext.runEvents, rawLog),
    });
  });

  app.get("/api/v1/sessions/:sessionId/runs/:runId/logs", async (c) => {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }

    const run = await deps.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      return c.json({ error: "Run not found." }, 404);
    }
    const toolCalls = await deps.store.listToolCalls(runId);
    return c.json(await buildRunLogsPayload(c, deps, session, run, toolCalls));
  });

  app.get("/api/v1/sessions/:sessionId/runs/:runId/output", async (c) => {
    const sessionId = c.req.param("sessionId");
    const runId = c.req.param("runId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }
    const run = await deps.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      return c.json({ error: "Run not found." }, 404);
    }
    const toolCalls = await deps.store.listToolCalls(runId);
    const runContext = await resolveRunRuntimeContext(deps, sessionId, run, toolCalls, { runEventLimit: 400 });
    const backgroundJob = await deps.store.getLatestBackgroundJobForRun(run.id);
    const bridge = await resolveHermesBridgeRecord(deps, backgroundJob);
    const rawLog = await loadPersistedRawRunLog(deps, sessionId, run.id);
    return c.json({
      runId: run.id,
      text: summarizeDetailedRunOutputLines(run, backgroundJob, bridge, runContext.runEvents, rawLog),
    });
  });

  app.get("/admin/runs/:runId/logs", async (c) => {
    const admin = await requireAdmin(c);
    if (!admin) {
      return c.json({ error: "Not authorized." }, 403);
    }

    const runId = c.req.param("runId");
    const run = await deps.store.getRun(runId);
    if (!run) {
      return c.json({ error: "Run not found." }, 404);
    }
    const session = await deps.store.getSession(run.sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }

    const [toolCalls, owner] = await Promise.all([
      deps.store.listToolCalls(runId),
      deps.store.getUserProfile(session.userId),
    ]);
    return c.json(await buildRunLogsPayload(c, deps, session, run, toolCalls, {
      owner,
      requestedBy: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
      },
    }));
  });

  app.get("/works", async (c) => {
    const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
    const limit = Math.min(24, Math.max(1, Number.parseInt(c.req.query("limit") ?? "12", 10) || 12));
    const filters = {
      ...(typeof c.req.query("language") === "string" && c.req.query("language")!.trim().length > 0 ? { language: c.req.query("language")!.trim() } : {}),
      ...(typeof c.req.query("subject") === "string" && c.req.query("subject")!.trim().length > 0 ? { subject: c.req.query("subject")!.trim() } : {}),
      ...(typeof c.req.query("bookshelf") === "string" && c.req.query("bookshelf")!.trim().length > 0 ? { bookshelf: c.req.query("bookshelf")!.trim() } : {}),
      ...(typeof c.req.query("randomSeed") === "string" && c.req.query("randomSeed")!.trim().length > 0
        ? { randomSeed: Number.parseInt(c.req.query("randomSeed")!, 10) || 0 }
        : {}),
    };
    const [works, totalCount, facets] = await Promise.all([
      deps.store.listWorks({ offset, limit, filters }),
      deps.store.countWorks(filters),
      deps.store.listWorkFacets(filters),
    ]);
    return c.json({
      works: works.map((work) => decorateWork(c, work)),
      nextOffset: works.length === limit ? offset + works.length : null,
      totalCount,
      facets,
    });
  });

  app.get("/api/v1/documents", async (c) => {
    const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
    const limit = Math.min(24, Math.max(1, Number.parseInt(c.req.query("limit") ?? "12", 10) || 12));
    const [documents, totalCount] = await Promise.all([
      deps.store.listDocuments(offset, limit),
      deps.store.countDocuments(),
    ]);
    return c.json({
      documents: documents.map((document) => decorateCorpusDocument(c, document)),
      nextOffset: documents.length === limit ? offset + documents.length : null,
      totalCount,
    });
  });

  app.get("/works/:workId", async (c) => {
    const workId = c.req.param("workId");
    const work = await deps.store.getWorkById(workId);
    if (!work) {
      return c.json({ error: "Work not found." }, 404);
    }

    return c.json({
      work: decorateWork(c, work),
      source: null,
    });
  });

  app.get("/api/v1/documents/:documentId", async (c) => {
    const documentId = c.req.param("documentId");
    const [document, work] = await Promise.all([
      deps.store.getDocumentById(documentId),
      deps.store.getWorkById(documentId),
    ]);
    if (!document || !work) {
      return c.json({ error: "Document not found." }, 404);
    }

    return c.json({
      document: {
        ...decorateCorpusDocument(c, document),
        ...decorateDocumentDetail(c, work),
      },
      source: null,
    });
  });

  app.get("/works/:workId/content", async (c) => {
    const workId = c.req.param("workId");
    const work = await deps.store.getWorkById(workId);
    if (!work) {
      return c.json({ error: "Work not found." }, 404);
    }

    const files = await deps.store.getWorkFiles([workId], ["book_html"]);
    const htmlFile = files.find((file) => file.kind === "book_html") ?? null;
    if (htmlFile?.r2Key) {
      const object = await deps.blobStore.getObject(htmlFile.r2Key);
      if (object) {
        return new Response(await object.arrayBuffer(), {
          headers: {
            "content-type": object.contentType ?? "text/html; charset=utf-8",
            "cache-control": "public, max-age=14400",
          },
        });
      }
    }

    const sourceFiles = await deps.store.getWorkFiles([workId], ["raw", "clean"]);
    const rawFile = sourceFiles.find((file) => file.kind === "raw") ?? null;
    const cleanFile = sourceFiles.find((file) => file.kind === "clean") ?? null;
    const preferredFile = rawFile ?? cleanFile;
    const content = preferredFile?.r2Key ? await deps.blobStore.getText(preferredFile.r2Key) : null;
    if (!content) {
      return c.json({ error: "Book content not found." }, 404);
    }
    const metadata = work.metadata && typeof work.metadata === "object" ? work.metadata as Record<string, unknown> : {};
    const sourceFormat = metadata.sourceFormat === "html" ? "html" : "text";
    const html = buildFallbackBookHtml(work, content, sourceFormat);
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-alphabook-content-source": "fallback-generated",
      },
    });
  });

  app.get("/api/v1/documents/:documentId/content", async (c) => {
    const documentId = c.req.param("documentId");
    const work = await deps.store.getWorkById(documentId);
    if (!work) {
      return c.json({ error: "Document not found." }, 404);
    }

    const files = await deps.store.getWorkFiles([documentId], ["book_html"]);
    const htmlFile = files.find((file) => file.kind === "book_html") ?? null;
    if (htmlFile?.r2Key) {
      const object = await deps.blobStore.getObject(htmlFile.r2Key);
      if (object) {
        return new Response(await object.arrayBuffer(), {
          headers: {
            "content-type": object.contentType ?? "text/html; charset=utf-8",
            "cache-control": "public, max-age=14400",
          },
        });
      }
    }

    const sourceFiles = await deps.store.getWorkFiles([documentId], ["raw", "clean"]);
    const rawFile = sourceFiles.find((file) => file.kind === "raw") ?? null;
    const cleanFile = sourceFiles.find((file) => file.kind === "clean") ?? null;
    const preferredFile = rawFile ?? cleanFile;
    const content = preferredFile?.r2Key ? await deps.blobStore.getText(preferredFile.r2Key) : null;
    if (!content) {
      return c.json({ error: "Document content not found." }, 404);
    }
    const metadata = work.metadata && typeof work.metadata === "object" ? work.metadata as Record<string, unknown> : {};
    const sourceFormat = metadata.sourceFormat === "html" ? "html" : "text";
    const html = buildFallbackBookHtml(work, content, sourceFormat);
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-alphabook-content-source": "fallback-generated",
      },
    });
  });

  app.get("/works/:workId/source", async (c) => {
    const workId = c.req.param("workId");
    const work = await deps.store.getWorkById(workId);
    if (!work) {
      return c.json({ error: "Work not found." }, 404);
    }

    const files = await deps.store.getWorkFiles([workId], ["raw", "clean"]);
    const rawFile = files.find((file) => file.kind === "raw") ?? null;
    const cleanFile = files.find((file) => file.kind === "clean") ?? null;
    const preferredFile = rawFile ?? cleanFile;
    const content = preferredFile?.r2Key ? await deps.blobStore.getText(preferredFile.r2Key) : null;
    const metadata = work.metadata ?? {};
    const sourceFormat =
      typeof metadata.sourceFormat === "string" && (metadata.sourceFormat === "html" || metadata.sourceFormat === "text")
        ? metadata.sourceFormat
        : rawFile?.r2Key?.endsWith(".html")
          ? "html"
          : "text";

    return c.json({
      source: content
        ? {
            format: sourceFormat,
            content,
            r2Key: preferredFile?.r2Key ?? null,
            sourcePath: typeof metadata.sourcePath === "string" ? metadata.sourcePath : null,
            metadataPath: typeof metadata.metadataPath === "string" ? metadata.metadataPath : null,
          }
        : null,
    });
  });

  app.get("/api/v1/documents/:documentId/source", async (c) => {
    const documentId = c.req.param("documentId");
    const work = await deps.store.getWorkById(documentId);
    if (!work) {
      return c.json({ error: "Document not found." }, 404);
    }

    const files = await deps.store.getWorkFiles([documentId], ["raw", "clean"]);
    const rawFile = files.find((file) => file.kind === "raw") ?? null;
    const cleanFile = files.find((file) => file.kind === "clean") ?? null;
    const preferredFile = rawFile ?? cleanFile;
    const content = preferredFile?.r2Key ? await deps.blobStore.getText(preferredFile.r2Key) : null;
    const metadata = work.metadata ?? {};
    const sourceFormat =
      typeof metadata.sourceFormat === "string" && (metadata.sourceFormat === "html" || metadata.sourceFormat === "text")
        ? metadata.sourceFormat
        : rawFile?.r2Key?.endsWith(".html")
          ? "html"
          : "text";

    return c.json({
      source: content
        ? workSourceToDocumentSource({
            format: sourceFormat,
            content,
            r2Key: preferredFile?.r2Key ?? null,
            sourcePath: typeof metadata.sourcePath === "string" ? metadata.sourcePath : null,
            metadataPath: typeof metadata.metadataPath === "string" ? metadata.metadataPath : null,
          })
        : null,
    });
  });

  app.get("/works/:workId/cover", async (c) => {
    const workId = c.req.param("workId");
    const work = await deps.store.getWorkById(workId);
    if (!work) {
      return c.json({ error: "Work not found." }, 404);
    }
    const metadata = work.metadata ?? {};
    const coverImageKey = typeof metadata.coverImageKey === "string" ? metadata.coverImageKey : null;
    if (!coverImageKey) {
      return c.json({ error: "Cover not found." }, 404);
    }
    const object = await deps.blobStore.getObject(coverImageKey);
    if (!object) {
      return c.json({ error: "Cover not found." }, 404);
    }
    return new Response(await object.arrayBuffer(), {
      headers: {
        "content-type": object.contentType ?? "image/jpeg",
        "cache-control": "public, max-age=86400",
      },
    });
  });

  app.get("/api/v1/documents/:documentId/cover", async (c) => {
    const documentId = c.req.param("documentId");
    const work = await deps.store.getWorkById(documentId);
    if (!work) {
      return c.json({ error: "Document not found." }, 404);
    }
    const metadata = work.metadata ?? {};
    const coverImageKey = typeof metadata.coverImageKey === "string" ? metadata.coverImageKey : null;
    if (!coverImageKey) {
      return c.json({ error: "Cover not found." }, 404);
    }
    const object = await deps.blobStore.getObject(coverImageKey);
    if (!object) {
      return c.json({ error: "Cover not found." }, 404);
    }
    return new Response(await object.arrayBuffer(), {
      headers: {
        "content-type": object.contentType ?? "image/jpeg",
        "cache-control": "public, max-age=86400",
      },
    });
  });

  return app;
}
