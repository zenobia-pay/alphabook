import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { artifactKeys, HARD_LIMITS } from "@alphabook/corpus-core";
import { ChatRequestSchema, ToolArgsSchemas, getToolLabel, type ChatRequest, type ChunkSearchResult, type Citation, type PlannerDecision, type ToolName, type WorkSummary } from "@alphabook/shared";
import { createFacilitatorConfig } from "@coinbase/x402";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { type Network, type PaymentPayload, type PaymentRequired, type PaymentRequirements, type SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ZodError, z } from "zod";

import type { WorkOSAuth } from "./auth";
import type { BillingService } from "./billing";
import type { Embedder } from "./embeddings";
import type { BlobStore } from "./r2";
import type { Planner, PlannerContext } from "./planner";
import { FallbackPlanner, parseToolCall } from "./planner";
import type { Router } from "./router";
import { cleanupToolStreamWithWorkersAi, type ToolStreamCleanupLine } from "./tool-stream-cleanup";
import type { Synthesizer, ToolHistoryEntry } from "./synthesizer";
import type { AgentIdentityRecord, AnalyticsEventRecord, AppStore, MessageRecord, SessionRecord, UserRecord } from "./store";
import type { WorkersAiBinding } from "./index";

export interface WorkerQueues {
  ingestName: string;
  jobsName: string;
}

export interface RuntimeToolGateway {
  createWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  runWorkspaceTask(args: Record<string, unknown>): Promise<Record<string, unknown>>;
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
  embedder: Embedder;
  synthesizer: Synthesizer;
  blobStore: BlobStore;
  runtimeGateway: RuntimeToolGateway;
  queues: WorkerQueues;
  auth?: WorkOSAuth;
  now?: () => number;
  adminAllowedEmail?: string;
  openAIApiKey?: string;
  openAIModel?: string;
  ai?: WorkersAiBinding;
  toolStreamCleanupModel?: string;
  errorAlertWebhookUrl?: string;
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
}

const ALLOWED_WEB_ORIGINS = new Set([
  "https://alpha-book.org",
  "https://www.alpha-book.org",
  "http://127.0.0.1:4193",
  "http://localhost:4193",
]);

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
      description: deps.x402.description ?? "AlphaBook CLI research access",
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
      "Payment does not match AlphaBook's current x402 requirements.",
    );
    return {
      ok: false as const,
      response: new Response(JSON.stringify({
        error: "Payment does not match AlphaBook's current x402 requirements.",
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

function isAllowedWebOrigin(origin: string | null | undefined): boolean {
  if (!origin) {
    return false;
  }
  return ALLOWED_WEB_ORIGINS.has(origin);
}

function applyCorsHeaders(c: Context, response: Response): Response {
  const origin = c.req.header("origin");
  if (!origin || !isAllowedWebOrigin(origin)) {
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

async function persistAnalyticsEvent(
  deps: AppDeps,
  eventName: string,
  payload: Record<string, unknown> = {},
  request?: Request,
) {
  const forwardedFor = request?.headers.get("cf-connecting-ip") ?? request?.headers.get("x-forwarded-for");
  const userAgent = request?.headers.get("user-agent");
  const properties: Record<string, unknown> = {
    source: "alphabook-web",
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

async function sendIncidentAlert(webhookUrl: string, incident: Record<string, unknown>) {
  const text = [
    "AlphaBook unexpected error",
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
        await sendIncidentAlert(deps.errorAlertWebhookUrl, incident);
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
    case "search_works": {
      const works = Array.isArray(result.works) ? result.works as Array<Record<string, unknown>> : [];
      return uniqueWorkIds(works.map((work) => (typeof work.id === "string" ? work.id : null)));
    }
    case "get_work_metadata": {
      return Array.isArray(args.workIds) ? uniqueWorkIds(args.workIds.filter((value): value is string => typeof value === "string")) : [];
    }
    case "get_relevant_chunks": {
      const chunks = Array.isArray(result.chunks) ? result.chunks as Array<Record<string, unknown>> : [];
      return uniqueWorkIds(chunks.map((chunk) => (typeof chunk.workId === "string" ? chunk.workId : null)));
    }
    case "create_workspace": {
      return Array.isArray(args.workIds) ? uniqueWorkIds(args.workIds.filter((value): value is string => typeof value === "string")) : [];
    }
    case "run_workspace_task": {
      const taskSpec = args.taskSpec && typeof args.taskSpec === "object" ? args.taskSpec as Record<string, unknown> : null;
      return Array.isArray(taskSpec?.workIds)
        ? uniqueWorkIds((taskSpec.workIds as unknown[]).filter((value): value is string => typeof value === "string"))
        : [];
    }
    default:
      return [];
  }
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

function normalizeToolArgs(toolName: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...args };
  switch (toolName) {
    case "search_works":
      if (normalized.filters && typeof normalized.filters === "object") {
        const filters = { ...(normalized.filters as Record<string, unknown>) };
        const language = normalizeSearchLanguageFilter(filters.language);
        if (language) {
          filters.language = language;
        } else {
          delete filters.language;
        }
        if (typeof filters.limit === "number") {
          filters.limit = Math.max(1, Math.min(20, Math.trunc(filters.limit)));
        }
        normalized.filters = filters;
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
          filters.limit = Math.max(1, Math.min(20, Math.trunc(filters.limit)));
        }
        normalized.filters = filters;
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

type ActiveRunState = {
  sessionId: string;
  userId: string;
  runtimeIds: Set<string>;
  cancelRequested: boolean;
  rawLog: ToolRunRawLogEntry[];
  subscribers: Map<string, (event: string, data: Record<string, unknown>) => Promise<void>>;
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

async function executeTool(
  deps: AppDeps,
  toolName: ToolName,
  args: Record<string, unknown>,
  context: { userId: string; sessionId: string; runId: string; auditLog?: AuditLogger },
): Promise<Record<string, unknown>> {
  const normalizedArgs = normalizeToolArgs(toolName, args);
  switch (toolName) {
    case "search_works": {
      const parsed = ToolArgsSchemas.search_works.parse(normalizedArgs);
      const works = await deps.store.searchWorks(parsed.query, parsed.filters);
      return { works };
    }
    case "get_work_metadata": {
      const parsed = ToolArgsSchemas.get_work_metadata.parse(normalizedArgs);
      const works = await deps.store.getWorkMetadata(parsed.workIds);
      return { works };
    }
    case "get_relevant_chunks": {
      const parsed = ToolArgsSchemas.get_relevant_chunks.parse(normalizedArgs);
      let embedding: number[] | undefined;
      try {
        context.auditLog?.("internal.embedding.started", {
          toolName,
          query: parsed.query,
          scopedWorkCount: Array.isArray(parsed.workIds) ? parsed.workIds.length : 0,
        });
        embedding = await deps.embedder.embedQuery(parsed.query, {
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
      const chunks = await deps.store.getRelevantChunks(
        parsed.query,
        parsed.workIds,
        parsed.filters?.limit ?? 8,
        embedding,
      );
      return { chunks };
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
      return deps.runtimeGateway.runWorkspaceTask({
        ...ToolArgsSchemas.run_workspace_task.parse(normalizedArgs),
        sessionId: context.sessionId,
        runId: context.runId,
      });
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
  const emitStep = () => {
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
  const timer = setInterval(() => {
    emitStep();
  }, 3000);

  return {
    async stop() {
      clearInterval(timer);
    },
  };
}

function normalizeRuntimeProgressLine(event: Record<string, unknown>): string | null {
  const rawMessage = typeof event.message === "string" ? event.message.trim() : "";
  if (!rawMessage) {
    return null;
  }

  const type = typeof event.type === "string" ? event.type : "";
  const line = typeof event.line === "string" ? event.line.trim() : "";

  if (type === "codex.stdout" || type === "codex.stderr") {
    return line || null;
  }

  if (type === "codex.step.prepared") {
    return "The deeper research pass is ready to run.";
  }
  if (type === "codex.step.attempt") {
    return "Starting the deeper research pass.";
  }
  if (type === "codex.step.completed") {
    return "The deeper research pass finished writing the briefing.";
  }
  if (type === "codex.step.attempt_failed") {
    return "The deeper research pass hit an error and is retrying.";
  }
  if (type === "codex.step.failed") {
    return "The deeper research pass failed.";
  }
  if (type === "workspace.local_chunks.missing") {
    return "Starting from the best current evidence and searching the full corpus directly.";
  }

  return rawMessage
    .replace(/^codex-briefing:\s*/i, "")
    .replace(/\bCodex corpus briefing\b/gi, "Deep research")
    .replace(/\bCodex step\b/gi, "Research step")
    .replace(/\bCodex\b/gi, "the research engine");
}

function sanitizeUserFacingToolText(text: string | null | undefined): string | null {
  if (!text || !text.trim()) {
    return null;
  }
  return text
    .replace(/\bCodex\b/gi, "deep research")
    .replace(/\bcodex\b/gi, "deep research")
    .replace(/\bhydrat(?:e|ed|ing)\b/gi, "load")
    .replace(/\bworkspace\b/gi, "research run")
    .trim();
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

type ToolProgressBuffer = {
  toolName: ToolName;
  lines: ToolStreamCleanupLine[];
  timer: ReturnType<typeof setTimeout> | null;
  flushPromise: Promise<void> | null;
};

function looksSensitiveKey(key: string) {
  return /(secret|token|password|cookie|authorization|api[-_]?key|session[-_]?id)/iu.test(key);
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\b(sk|rk|pk)_[a-z0-9_-]{12,}\b/giu, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/giu, "Bearer [redacted]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/gu, "[redacted]")
    .replace(/([A-Za-z0-9+/]{32,}={0,2})/gu, "[redacted]");
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
    value = sanitizeUserFacingToolText(value) ?? value;
    if (looksSensitiveKey(line.key)) {
      value = "[redacted]";
    }
    if (normalized[normalized.length - 1] === value) {
      continue;
    }
    const previous = normalized[normalized.length - 1];
    const isShortOrVague = value.length < 28 || /^(starting|working|running|loading|checking|reviewing|searching)\b/iu.test(value);
    if (previous && isShortOrVague && previous.length < 160) {
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
  },
  auditLog?: AuditLogger,
) {
  const fallback = fallbackNormalizeToolLines(input.lines);
  if (!deps.ai || input.lines.length === 0) {
    return fallback;
  }
  auditLog?.("internal.glm_cleanup.started", {
    toolName: input.toolName,
    model: deps.toolStreamCleanupModel ?? DEFAULT_SESSION_TITLE_MODEL,
    lineCount: input.lines.length,
  });
  try {
    const cleaned = await cleanupToolStreamWithWorkersAi(deps.ai, {
      model: deps.toolStreamCleanupModel,
      toolName: input.toolName,
      lines: input.lines,
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
    return normalized.length > 0 ? normalized : fallback;
  } catch (error) {
    auditLog?.("internal.glm_cleanup.failed", {
      toolName: input.toolName,
      model: deps.toolStreamCleanupModel ?? DEFAULT_SESSION_TITLE_MODEL,
      error: error instanceof Error ? error.message : "Unknown cleanup error",
    });
    return fallback;
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
) {
  let stopped = false;
  let inFlight = false;
  let seenLines = 0;

  const emit = async (text: string, detail?: Record<string, unknown>) => {
    await send("tool.progress", {
      runId,
      toolCallId,
      toolName,
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
          const text = normalizeRuntimeProgressLine(event);
          if (text) {
            await emit(text, event);
          }
        } catch {
          continue;
        }
      }
      seenLines = lines.length;
    } catch {
      // Runtime progress is best-effort while the task is still starting up.
    } finally {
      inFlight = false;
    }
  };

  void emit("Starting the deeper research run.");
  void poll();
  const timer = setInterval(() => {
    void poll();
  }, 1500);

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
        });
      }
    }
  }
  return [...deduped.values()];
}

function runtimeIdFromToolCall(toolCall: Awaited<ReturnType<AppStore["listToolCalls"]>>[number]) {
  const argsRuntimeId = typeof toolCall.argsJson?.runtimeId === "string" ? toolCall.argsJson.runtimeId : null;
  const resultRuntimeId = typeof toolCall.resultJson?.runtimeId === "string" ? toolCall.resultJson.runtimeId : null;
  return resultRuntimeId ?? argsRuntimeId;
}

async function recoverRunCompletion(
  deps: AppDeps,
  request: Request,
  session: SessionRecord,
  run: { id: string; status: string },
  toolCalls: Awaited<ReturnType<AppStore["listToolCalls"]>>,
) {
  const toolHistory = toolCalls
    .filter((toolCall) => toolCall.resultJson && toolCall.status === "completed")
    .map((toolCall) => ({
      toolName: toolCall.toolName,
      rationale: undefined,
      args: toolCall.argsJson,
      result: toolCall.resultJson as Record<string, unknown>,
    }));

  const completedBriefing = latestCompletedBriefing(toolHistory);
  if (!completedBriefing) {
    return false;
  }

  const messages = await deps.store.listMessages(session.id);
  const conversationHistory = formatConversationHistory(messages);
  await deps.store.updateRun(run.id, {
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  await persistRecoveredPlanToolTrace(deps, session.id, run.id, toolCalls);
  await ensureRunAnswerPersisted(
    deps,
    request,
    session,
    run.id,
    messages,
    conversationHistory,
    completedBriefing,
    toolHistory,
  );
  return true;
}

async function ensureRunAnswerPersisted(
  deps: AppDeps,
  request: Request,
  session: SessionRecord,
  runId: string,
  messages: Awaited<ReturnType<AppStore["listMessages"]>>,
  conversationHistory: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string }>,
  completedBriefing: { answer: string; citations: Citation[] },
  toolHistory: ToolHistoryEntry[],
) {
  const hasAnswer = messages.some((message) => {
    if (message.role !== "assistant") {
      return false;
    }
    const metadata = message.metadata as Record<string, unknown> | undefined;
    return metadata?.runId === runId && metadata?.phase !== "plan" && metadata?.phase !== "error";
  });
  if (hasAnswer) {
    return;
  }

  const recoveredAnswer = await rewriteAnswerWithCitationLinks(
    deps,
    session.id,
    completedBriefing.answer,
    completedBriefing.citations,
  );
  const artifactKey = await persistFinalArtifact(
    deps,
    session.id,
    runId,
    recoveredAnswer,
    completedBriefing.citations,
  );
  await deps.store.appendMessage(session.id, "assistant", recoveredAnswer, {
    runId,
    phase: "answer",
    citations: completedBriefing.citations,
    artifactKey,
    researchLog: summarizeToolHistory(toolHistory),
    recoveredFromBriefing: true,
  });
}

async function reconcilePersistentRun(
  deps: AppDeps,
  request: Request,
  run: Awaited<ReturnType<AppStore["getRun"]>>,
) {
  if (!run) {
    return run;
  }

  const session = await deps.store.getSession(run.sessionId);
  if (!session) {
    return run;
  }

  const toolCalls = await deps.store.listToolCalls(run.id);
  if (run.status === "completed") {
    const completedBriefing = latestCompletedBriefing(
      toolCalls
        .filter((toolCall) => toolCall.resultJson && toolCall.status === "completed")
        .map((toolCall) => ({
          toolName: toolCall.toolName,
          rationale: undefined,
          args: toolCall.argsJson,
          result: toolCall.resultJson as Record<string, unknown>,
        })),
    );
    if (completedBriefing) {
      await persistRecoveredPlanToolTrace(deps, session.id, run.id, toolCalls);
      const messages = await deps.store.listMessages(session.id);
      const conversationHistory = formatConversationHistory(messages);
      await ensureRunAnswerPersisted(
        deps,
        request,
        session,
        run.id,
        messages,
        conversationHistory,
        completedBriefing,
        toolCalls
          .filter((toolCall) => toolCall.resultJson && toolCall.status === "completed")
          .map((toolCall) => ({
            toolName: toolCall.toolName,
            rationale: undefined,
            args: toolCall.argsJson,
            result: toolCall.resultJson as Record<string, unknown>,
          })),
      );
    }
    return deps.store.getRun(run.id);
  }
  if (run.status !== "running" && run.status !== "queued") {
    return run;
  }

  if (await recoverRunCompletion(deps, request, session, run, toolCalls)) {
    return deps.store.getRun(run.id);
  }

  const runAgeMs = Date.now() - Date.parse(run.startedAt);
  const runningToolCall = [...toolCalls].reverse().find((toolCall) => toolCall.status === "running");
  if (!runningToolCall) {
    if (toolCalls.length > 0 && runAgeMs > ORPHANED_RUN_GRACE_MS) {
      const failureMessage = "This run stopped unexpectedly before it produced an answer.";
      await deps.store.updateRun(run.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      await persistRecoveredPlanToolTrace(deps, session.id, run.id, toolCalls);
      await appendRunErrorMessageOnce(deps, session.id, run.id, failureMessage, {
        runId: run.id,
        phase: "error",
        toolCalls: buildRecoveredToolTrace(toolCalls),
        researchLog: buildRecoveredToolTrace(toolCalls),
        recoveredFromStalledRun: true,
      });
      return deps.store.getRun(run.id);
    }
    if (runAgeMs > HARD_LIMITS.MAX_RUN_WALL_CLOCK_SECONDS * 1000) {
      const failureMessage = "This run timed out before it produced an answer.";
      await deps.store.updateRun(run.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      await persistRecoveredPlanToolTrace(deps, session.id, run.id, toolCalls);
      await appendRunErrorMessageOnce(deps, session.id, run.id, failureMessage, {
        runId: run.id,
        phase: "error",
        toolCalls: buildRecoveredToolTrace(toolCalls),
        researchLog: buildRecoveredToolTrace(toolCalls),
      });
      return deps.store.getRun(run.id);
    }
    return run;
  }

  const runtimeId = runtimeIdFromToolCall(runningToolCall);
  if (!runtimeId || !deps.runtimeGateway.getWorkspaceTaskStatus) {
    return run;
  }

  let taskStatus: Record<string, unknown>;
  try {
    taskStatus = await deps.runtimeGateway.getWorkspaceTaskStatus({
      runtimeId,
      sessionId: session.id,
      runId: run.id,
    });
  } catch {
    return run;
  }

  if (taskStatus.status === "running" || taskStatus.status === "idle") {
    return run;
  }

  if (taskStatus.status === "failed") {
    const failedResult = {
      ok: false,
      error:
        typeof taskStatus.error === "string"
          ? taskStatus.error
          : "Deep research failed in the runtime.",
      billingEvents: Array.isArray(taskStatus.billingEvents) ? taskStatus.billingEvents : undefined,
      runtimeId,
    };
    await deps.store.finishToolCall(runningToolCall.id, "failed", failedResult);
    const refreshedToolCalls = await deps.store.listToolCalls(run.id);
    await persistRecoveredPlanToolTrace(deps, session.id, run.id, refreshedToolCalls);
    await deps.store.updateRun(run.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
    });
    return deps.store.getRun(run.id);
  }

  if (taskStatus.status === "completed" && taskStatus.result && typeof taskStatus.result === "object") {
    const result: Record<string, unknown> = {
      ...(taskStatus.result as Record<string, unknown>),
      runtimeId,
    };
    await deps.store.finishToolCall(runningToolCall.id, "completed", result);
    if (runningToolCall.toolName === "run_workspace_task") {
      await trackRuntimeBillingEvents(deps, session, run, result.billingEvents);
    }
    const refreshedToolCalls = await deps.store.listToolCalls(run.id);
    await persistRecoveredPlanToolTrace(deps, session.id, run.id, refreshedToolCalls);
    await recoverRunCompletion(deps, request, session, run, refreshedToolCalls);
    return deps.store.getRun(run.id);
  }

  return run;
}

async function reconcileSessionRuns(
  deps: AppDeps,
  request: Request,
  sessionId: string,
) {
  const runs = await deps.store.listRuns(sessionId);
  for (const run of runs) {
    await reconcilePersistentRun(deps, request, run);
  }
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
    return "New chat";
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

function labelForToolCall(toolName: ToolName, args: Record<string, unknown>) {
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

function clientSafeToolResult(toolName: ToolName, result: Record<string, unknown>): Record<string, unknown> {
  if (toolName === "search_works" || toolName === "get_work_metadata") {
    const works = Array.isArray(result.works) ? result.works : [];
    return {
      workCount: works.length,
      works: works.slice(0, 8).map((candidate) => {
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
    return {
      chunkCount: chunks.length,
      chunks: chunks.slice(0, 8).map((candidate) => {
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
      evidenceCount: typeof evidenceCount === "number" ? evidenceCount : undefined,
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

type LiveToolTraceEntry = {
  id: string;
  toolName: ToolName;
  label: string;
  rationale?: string;
  progress: string[];
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  state: "running" | "completed" | "error";
  isError?: boolean;
};

function appendToolProgress(entry: LiveToolTraceEntry, nextText: string): LiveToolTraceEntry {
  const progress = entry.progress.includes(nextText) ? entry.progress : [...entry.progress, nextText];
  return {
    ...entry,
    rationale: progress[progress.length - 1] ?? entry.rationale,
    progress,
  };
}

async function persistPlanToolTrace(
  deps: AppDeps,
  messageId: string | null,
  runId: string,
  toolCalls: LiveToolTraceEntry[],
) {
  if (!messageId) {
    return;
  }
  await deps.store.updateMessageMetadata(messageId, {
    phase: "plan",
    runId,
    toolCalls,
    researchLog: toolCalls,
  });
}

function cloneLiveToolTraceEntries(toolCalls: LiveToolTraceEntry[]): LiveToolTraceEntry[] {
  return toolCalls.map((entry) => ({
    ...entry,
    progress: [...entry.progress],
    args: structuredClone(entry.args),
    result: entry.result ? structuredClone(entry.result) : undefined,
  }));
}

function buildRecoveredToolTrace(
  toolCalls: Awaited<ReturnType<AppStore["listToolCalls"]>>,
): LiveToolTraceEntry[] {
  return toolCalls.map((toolCall) => {
    const normalizedArgs = normalizeToolArgs(toolCall.toolName, toolCall.argsJson);
    const safeResult = toolCall.resultJson
      ? clientSafeToolResult(toolCall.toolName, toolCall.resultJson)
      : undefined;
    const startedLogLines = flattenValueForCleanup(normalizedArgs).map((line) => ({
      ...line,
      toolName: toolCall.toolName,
    }));
    const completedLogLines = safeResult
      ? flattenValueForCleanup(safeResult).map((line) => ({
          ...line,
          toolName: toolCall.toolName,
        }))
      : [];

    return {
      id: toolCall.id,
      toolName: toolCall.toolName,
      label: labelForToolCall(toolCall.toolName, normalizedArgs),
      progress: [],
      args: {
        __logLines: startedLogLines,
      },
      result: safeResult
        ? {
            ...safeResult,
            __logLines: completedLogLines,
            error: typeof safeResult.error === "string" ? safeResult.error : undefined,
          }
        : undefined,
      state:
        toolCall.status === "failed" || toolCall.status === "timed_out"
          ? "error"
          : toolCall.status === "completed"
            ? "completed"
            : "running",
      isError: toolCall.status === "failed" || toolCall.status === "timed_out",
    };
  });
}

async function persistRecoveredPlanToolTrace(
  deps: AppDeps,
  sessionId: string,
  runId: string,
  toolCalls: Awaited<ReturnType<AppStore["listToolCalls"]>>,
) {
  const messages = await deps.store.listMessages(sessionId);
  const planMessage = [...messages].reverse().find((message) => (
    message.role === "assistant"
    && message.metadata?.phase === "plan"
    && message.metadata?.runId === runId
  ));
  if (!planMessage) {
    return;
  }

  const recoveredTrace = buildRecoveredToolTrace(toolCalls);
  await deps.store.updateMessageMetadata(planMessage.id, {
    ...planMessage.metadata,
    phase: "plan",
    runId,
    toolCalls: recoveredTrace,
    researchLog: recoveredTrace,
  });
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
    case "search_works":
      return normalizedMessage
        ? `I’m going to search the corpus for “${normalizedMessage},” pull the strongest passages, and then run a deeper research pass if the quick evidence is thin.`
        : "I’m going to search the corpus, pull the strongest passages, and then run a deeper research pass if the quick evidence is thin.";
    case "get_relevant_chunks":
      return normalizedMessage
        ? `I found some likely matches for “${normalizedMessage}.” Now I’m pulling the strongest passages before I write the answer.`
        : "I found some likely matches. Now I’m pulling the strongest passages before I write the answer.";
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

async function loadRunArtifacts(
  deps: AppDeps,
  sessionId: string,
  runId: string,
  toolCalls: Awaited<ReturnType<AppStore["listToolCalls"]>>,
) {
  const runtimeIds = new Set<string>();
  for (const toolCall of toolCalls) {
    const result = toolCall.resultJson;
    const args = toolCall.argsJson;
    if (typeof result?.runtimeId === "string") {
      runtimeIds.add(result.runtimeId);
    }
    if (typeof args?.runtimeId === "string") {
      runtimeIds.add(args.runtimeId);
    }
  }

  const artifacts = await deps.store.listArtifacts(sessionId);
  const filtered = artifacts.filter((artifact) =>
    artifact.runtimeId === null
      ? artifact.filename.includes(runId)
      : runtimeIds.has(artifact.runtimeId),
  );
  const hydrated = await Promise.all(
    filtered.map(async (artifact) => ({
      ...artifact,
      content: isTextArtifact(artifact.filename, artifact.mimeType)
        ? await deps.blobStore.getText(artifact.r2Key)
        : null,
    })),
  );
  return synthesizeReferenceArtifacts(hydrated);
}

function isAdminUser(user: Awaited<ReturnType<AppStore["getUserProfile"]>>, allowedEmail?: string) {
  if (!allowedEmail || !user?.email) {
    return false;
  }
  return user.email.trim().toLowerCase() === allowedEmail.trim().toLowerCase();
}

type RunArtifactLike = {
  filename: string;
  mimeType: string;
  metadata?: Record<string, unknown> | null;
  content?: string | null;
  createdAt?: string | null;
  id?: string;
  runtimeId?: string | null;
  r2Key?: string;
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

function resolveRunRawLog(
  activeRuns: Map<string, ActiveRunState>,
  runId: string,
  artifacts: RunArtifactLike[],
) {
  const persisted = parseRawRunLogEntries(artifacts);
  if (persisted.length > 0) {
    return persisted;
  }
  return (activeRuns.get(runId)?.rawLog ?? []).map((entry) => ({
    seq: entry.seq,
    timestamp: entry.timestamp,
    event: entry.event,
    payload: entry.payload,
  }));
}

function collectRuntimeIds(toolCalls: Awaited<ReturnType<AppStore["listToolCalls"]>>) {
  const runtimeIds = new Set<string>();
  for (const toolCall of toolCalls) {
    const args = toolCall.argsJson;
    const result = toolCall.resultJson;
    if (typeof args?.runtimeId === "string" && args.runtimeId.length > 0) {
      runtimeIds.add(args.runtimeId);
    }
    if (typeof result?.runtimeId === "string" && result.runtimeId.length > 0) {
      runtimeIds.add(result.runtimeId);
    }
  }
  return Array.from(runtimeIds);
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

async function reapExpiredRuntimeInstances(
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
            "You are the AlphaBook analytics model.",
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

function buildSourceWorkPassages(format: "html" | "text", content: string) {
  return format === "html" ? buildHtmlWorkPassages(content) : buildTextWorkPassages(content);
}

async function buildCitationPassageUrl(
  deps: AppDeps,
  sessionId: string,
  citation: Citation,
): Promise<string> {
  const baseUrl = `https://alpha-book.org/works/${encodeURIComponent(citation.workId)}?session=${encodeURIComponent(sessionId)}`;
  const work = await deps.store.getWorkById(citation.workId);
  const files = await deps.store.getWorkFiles([citation.workId], ["raw", "clean"]);
  const rawFile = files.find((file) => file.kind === "raw") ?? null;
  const cleanFile = files.find((file) => file.kind === "clean") ?? null;
  const preferredFile = rawFile ?? cleanFile;
  if (!preferredFile?.r2Key) {
    return baseUrl;
  }
  const content = await deps.blobStore.getText(preferredFile.r2Key);
  if (!content) {
    return baseUrl;
  }
  const metadata = work?.metadata ?? {};
  const sourceFormat =
    typeof metadata.sourceFormat === "string" && (metadata.sourceFormat === "html" || metadata.sourceFormat === "text")
      ? metadata.sourceFormat
      : rawFile?.r2Key?.endsWith(".html") || content.trimStart().startsWith("<!DOCTYPE html") || content.trimStart().startsWith("<html")
        ? "html"
        : "text";
  const passages = buildSourceWorkPassages(sourceFormat, content);
  const candidates = buildExcerptCandidates(citation.excerpt).map((candidate) => buildNormalizedSearchIndex(candidate));
  const match = passages.find((passage) => candidates.some((candidate) => candidate && passage.searchText.includes(candidate)));
  return match ? `${baseUrl}#${match.id}` : baseUrl;
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
  return buildCitationPassageUrl(deps, sessionId, {
    workId,
    chunkId: chunk.id,
    label: `chunk #${chunkIndex}`,
    excerpt: chunk.text,
    r2Key: chunk.r2Key ?? undefined,
  });
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
  return buildCitationPassageUrl(deps, sessionId, {
    workId: chunk.workId,
    chunkId: chunk.id,
    label: `chunk ${chunk.id}`,
    excerpt: chunk.text,
    r2Key: chunk.r2Key ?? undefined,
  });
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

    const exactCitationLinks = await Promise.all(
      collectSynthesisCitations(params.plannerCitations, params.toolHistory)
        .slice(0, 16)
        .map(async (citation) => ({
          workId: citation.workId,
          ...(citation.chunkId ? { chunkId: citation.chunkId } : {}),
          label: citation.label,
          excerpt: citation.excerpt,
          url: await buildCitationPassageUrl(deps, params.sessionId, citation),
        })),
    );

    let synthesis;
    synthesis = await deps.synthesizer.synthesize({
      userMessage: params.userMessage,
      conversationHistory: params.conversationHistory,
      plannerDraft: params.plannerDraft,
      plannerCitations: params.plannerCitations,
      toolHistory: params.toolHistory,
      exactCitationLinks,
      billingContext: {
        userId: params.userId,
        sessionId: params.sessionId,
        runId: params.runId,
        source: "synthesizer",
      },
    });
    synthesis.answer = await rewriteAnswerWithCitationLinks(
      deps,
      params.sessionId,
      synthesis.answer,
      synthesis.citations,
    );
    params.auditLog?.("internal.synthesis.completed", {
      citationCount: synthesis.citations.length,
      answerLength: synthesis.answer.length,
    });

    const artifactKey = await persistFinalArtifact(deps, params.sessionId, params.runId, synthesis.answer, synthesis.citations);
    const summarizedToolHistory = summarizeToolHistory(params.toolHistory);
    await deps.store.appendMessage(params.sessionId, "assistant", synthesis.answer, {
      runId: params.runId,
      phase: "answer",
      citations: synthesis.citations,
      artifactKey,
      researchLog: summarizedToolHistory,
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

    await streamAssistantText(synthesis.answer, send);
    await send("assistant.completed", {
      answer: synthesis.answer,
      citations: synthesis.citations,
      artifactKey,
    });
  } catch (error) {
    params.auditLog?.("internal.synthesis.failed", {
      error: error instanceof Error ? error.message : "Unknown synthesis error",
    });
    throw error;
  }
}

async function runOrchestrator(
  deps: AppDeps,
  request: Request,
  input: ChatRequest,
  send: (event: string, data: Record<string, unknown>) => Promise<void>,
  activeRuns: Map<string, ActiveRunState>,
): Promise<void> {
  const originalSend = send;
  send = async (event: string, data: Record<string, unknown>) => {
    await originalSend(event, data);
    const runId = typeof data.runId === "string" ? data.runId : null;
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
        await subscriber(event, data);
      } catch {
        // Ignore subscriber disconnect races.
      }
    }));
  };

  const started = deps.now?.() ?? Date.now();
  if (!input.userId) {
    throw new Error("A userId is required to start an orchestrator run.");
  }
  await deps.store.ensureUser(input.userId);
  let rawLogSequence = 0;
  const rawRunLog: ToolRunRawLogEntry[] = [];
  const progressBuffers = new Map<string, ToolProgressBuffer>();
  let latestPlanTraceVersion = 0;
  let persistedPlanTraceVersion = 0;
  let planTracePersistChain = Promise.resolve();
  let rawLogPersistChain = Promise.resolve();
  let rawLogPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let rawLogPersistScheduled = false;
  let rawLogPersistedLength = 0;

  let session: SessionRecord | null = input.sessionId ? await deps.store.getSession(input.sessionId) : null;
  let run: Awaited<ReturnType<AppStore["createRun"]>> | null = null;

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

  const flushToolProgress = async (
    toolCallId: string,
    context: { runId: string; toolName: ToolName },
    onEmit: (text: string) => Promise<void>,
  ) => {
    const buffer = progressBuffers.get(toolCallId);
    if (!buffer) {
      return;
    }
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    if (buffer.flushPromise) {
      await buffer.flushPromise;
      return;
    }
    const batch = buffer.lines.splice(0, buffer.lines.length);
    if (batch.length === 0) {
      return;
    }
    buffer.flushPromise = (async () => {
      const normalizedLines = await normalizeToolLinesForUser(deps, {
        toolName: context.toolName,
        lines: batch,
      }, recordRawLog);
      for (const text of normalizedLines) {
        await onEmit(text);
      }
    })().finally(() => {
      buffer.flushPromise = null;
      if (buffer.lines.length === 0 && !buffer.timer) {
        progressBuffers.delete(toolCallId);
      }
    });
    await buffer.flushPromise;
  };

  const queueToolProgress = (
    payload: {
      runId: string;
      toolCallId: string;
      toolName: ToolName;
      text: string;
      detail?: Record<string, unknown>;
    },
    onEmit: (text: string) => Promise<void>,
  ) => {
    recordRawLog("tool.progress.raw", payload);
    const buffer = progressBuffers.get(payload.toolCallId) ?? {
      toolName: payload.toolName,
      lines: [],
      timer: null,
      flushPromise: null,
    };
    buffer.toolName = payload.toolName;
    buffer.lines.push({
      toolName: payload.toolName,
      key: typeof payload.detail?.type === "string" ? payload.detail.type : "progress",
      value: payload.text,
    });
    progressBuffers.set(payload.toolCallId, buffer);
    if (buffer.lines.length >= 4) {
      void flushToolProgress(payload.toolCallId, payload, onEmit);
      return;
    }
    if (!buffer.timer) {
      buffer.timer = setTimeout(() => {
        buffer.timer = null;
        void flushToolProgress(payload.toolCallId, payload, onEmit);
      }, 650);
    }
  };

  const flushAllToolProgress = async (
    onEmit: (toolCallId: string, toolName: ToolName, text: string) => Promise<void>,
  ) => {
    await Promise.all(
      Array.from(progressBuffers.entries()).map(([toolCallId, buffer]) =>
        flushToolProgress(toolCallId, { runId: "", toolName: buffer.toolName }, (text) =>
          onEmit(toolCallId, buffer.toolName, text)
        ),
      ),
    );
  };

  const persistLatestPlanToolTrace = async (
    messageId: string | null,
    toolCalls: LiveToolTraceEntry[],
  ) => {
    if (!messageId) {
      return;
    }
    const version = ++latestPlanTraceVersion;
    const snapshot = cloneLiveToolTraceEntries(toolCalls);
    const queuedWrite = planTracePersistChain.then(async () => {
      if (version <= persistedPlanTraceVersion || version !== latestPlanTraceVersion) {
        return;
      }
      await persistPlanToolTrace(deps, messageId, run!.id, snapshot);
      persistedPlanTraceVersion = version;
    });
    planTracePersistChain = queuedWrite.catch(() => {});
    await queuedWrite;
  };

  if (session && session.userId !== input.userId) {
    throw new Error("Not authorized for this session.");
  }
  if (!session) {
    session = await deps.store.createSession(input.userId, await createSessionTitle(deps, input.message, recordRawLog));
    await send("session.created", {
      sessionId: session.id,
      title: session.title,
    });
    recordRawLog("session.created", {
      sessionId: session.id,
      title: session.title,
    });
  }

  await deps.store.appendMessage(session.id, "user", input.message);
  recordRawLog("message.user", {
    sessionId: session.id,
    content: input.message,
  });
  const conversationHistory = formatConversationHistory(await deps.store.listMessages(session.id));
  run = await deps.store.createRun(session.id);
  activeRuns.set(run.id, {
    sessionId: session.id,
    userId: input.userId,
    runtimeIds: new Set<string>(),
    cancelRequested: false,
    rawLog: rawRunLog,
    subscribers: new Map(),
  });
  scheduleRawLogPersist(true);
  await send("run.started", {
    runId: run.id,
    sessionId: session.id,
  });
  recordRawLog("run.started", {
    runId: run.id,
    sessionId: session.id,
  });

  const toolHistory: Array<{
    toolName: ToolName;
    rationale?: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }> = [];
  const runtimeIdsToCleanup = new Set<string>();
  const toolResults: Record<string, unknown>[] = [];
  let liveToolTrace: LiveToolTraceEntry[] = [];
  let runtimeTasks = 0;
  let initialPlanSent = false;
  let planMessageId: string | null = null;
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

  const finalizeToolExecution = async (
    toolCallId: string,
    toolName: ToolName,
    normalizedArgs: Record<string, unknown>,
    rationale: string | undefined,
    status: "completed" | "failed",
    result: Record<string, unknown>,
  ) => {
    await deps.store.finishToolCall(toolCallId, status, result);
    if (status === "completed") {
      void recordBookAnalyticsEvents(
        deps,
        request,
        "book_candidate_in_run",
        {
          userId: session.userId,
          sessionId: session.id,
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
    const completedLogLines = await normalizeToolLinesForUser(deps, {
      toolName,
      lines: flattenValueForCleanup(streamedResult).map((line) => ({
        ...line,
        toolName,
      })),
    });
    recordRawLog("tool.completed.raw", {
      runId: run.id,
      toolCallId,
      toolName,
      status,
      result,
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
            result: {
              ...streamedResult,
              __logLines: completedLogLines,
              error: typeof streamedResult.error === "string" ? streamedResult.error : undefined,
            },
            isError: status === "failed",
            state: status === "failed" ? "error" : "completed",
          }
        : entry,
    );
    await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
    await send("tool.completed", {
      runId: run.id,
      toolCallId,
      toolName,
      label: labelForToolCall(toolName, normalizedArgs),
      rationale: sanitizeUserFacingToolText(rationale) ?? null,
      status,
      result: {
        ...streamedResult,
        __logLines: completedLogLines,
        error: typeof streamedResult.error === "string" ? streamedResult.error : undefined,
      },
    });
    toolHistory.push({
      toolName,
      rationale: sanitizeUserFacingToolText(rationale) ?? undefined,
      args: normalizedArgs,
      result,
    });
    toolResults.push(result);
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
    const wasCompleted = pendingWorkspaceExecution.status === "completed";
    pendingWorkspaceExecution = null;
    return wasCompleted;
  };

  const ensureInitialPlanSent = async (routedQuery: string) => {
    if (initialPlanSent) {
      return;
    }
    const planText = initialAssistantPlan(routedQuery);
    const planMessage = await deps.store.appendMessage(session.id, "assistant", planText, {
      phase: "plan",
      runId: run.id,
    });
    planMessageId = planMessage.id;
    await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
    await send("assistant.plan", {
      runId: run.id,
      sessionId: session.id,
      messageId: planMessage.id,
      text: planText,
    });
    recordRawLog("assistant.plan", {
      runId: run.id,
      sessionId: session.id,
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
    const latest = [...toolHistory].reverse().find((entry) => entry.toolName === "search_works");
    return Array.isArray(latest?.result.works) ? latest.result.works as Array<Record<string, unknown>> : [];
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
    const scopedWorkIds = Array.isArray(input.workIds) ? input.workIds.slice(0, 12) : [];
    const searchWorks = searchWorksFromHistory();
    const metadataWorks = metadataWorksFromHistory();
    const seedChunks = chunksFromHistory();
    const candidateWorkIds = uniqueWorkIds([
      ...scopedWorkIds,
      ...searchWorks.map((work) => (typeof work.id === "string" ? work.id : null)),
      ...metadataWorks.map((work) => (typeof work.id === "string" ? work.id : null)),
      ...seedChunks.map((chunk) => (typeof chunk.workId === "string" ? chunk.workId : null)),
    ]).slice(0, 12);
    return normalizeToolArgs("run_workspace_task", {
      runtimeId,
      taskSpec: {
        kind: "briefing_search",
        phase: "collect_and_brief",
        question: routedQueryRef.current,
        researchObjective: routedQueryRef.current,
        mode: scopedWorkIds.length > 0 ? "open_book_analysis" : "exhaustive_corpus_search",
        workIds: candidateWorkIds,
        chunkIds: seedChunks
          .map((chunk) => (typeof chunk.id === "string" ? chunk.id : null))
          .filter((value): value is string => typeof value === "string")
          .slice(0, 24),
        candidateWorkIds,
        searchHints: {
          searchWorksQuery: routedQueryRef.current,
          passageSearchFocus: "Find the strongest directly quotable passages that best answer the research objective.",
        },
        retrieval: {
          searchWorks: searchWorks.slice(0, 12).map((work) => ({
            id: typeof work.id === "string" ? work.id : null,
            title: typeof work.title === "string" ? work.title : "",
            authors: Array.isArray(work.authors) ? work.authors : [],
            summary: typeof work.summary === "string" ? work.summary : null,
            subjects: Array.isArray(work.subjects) ? work.subjects : [],
            gutenbergId: typeof work.gutenbergId === "number" ? work.gutenbergId : null,
          })),
          metadataWorks: metadataWorks.slice(0, 12).map((work) => ({
            id: typeof work.id === "string" ? work.id : null,
            title: typeof work.title === "string" ? work.title : "",
            authors: Array.isArray(work.authors) ? work.authors : [],
            summary: typeof work.summary === "string" ? work.summary : null,
            subjects: Array.isArray(work.subjects) ? work.subjects : [],
            gutenbergId: typeof work.gutenbergId === "number" ? work.gutenbergId : null,
          })),
          seedChunks: seedChunks.slice(0, 16).map((chunk) => ({
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
      },
    });
  };

  const startBackgroundTool = async (
    toolName: "create_workspace" | "run_workspace_task",
    normalizedToolArgs: Record<string, unknown>,
    rationale: string,
  ) => {
    runtimeTasks += 1;
    const toolRecord = await deps.store.startToolCall(run.id, toolName, normalizedToolArgs);
    await ensureInitialPlanSent(routedQueryRef.current);
    const startedLogLines = await normalizeToolLinesForUser(deps, {
      toolName,
      lines: [
        {
          toolName,
          key: "rationale",
          value: rationale,
        },
        ...flattenValueForCleanup(normalizedToolArgs).map((line) => ({
          ...line,
          toolName,
        })),
      ],
    });
    recordRawLog("tool.started.raw", {
      runId: run.id,
      toolCallId: toolRecord.id,
      toolName,
      rationale,
      args: normalizedToolArgs,
    });
    liveToolTrace = [
      ...liveToolTrace,
      {
        id: toolRecord.id,
        toolName,
        label: labelForToolCall(toolName, normalizedToolArgs),
        rationale: sanitizeUserFacingToolText(rationale) ?? undefined,
        progress: sanitizeUserFacingToolText(rationale) ? [sanitizeUserFacingToolText(rationale)!] : [],
        args: {
          __logLines: startedLogLines,
        },
        state: "running",
      },
    ];
    await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
    await send("tool.started", {
      runId: run.id,
      toolCallId: toolRecord.id,
      toolName,
      label: labelForToolCall(toolName, normalizedToolArgs),
      rationale: sanitizeUserFacingToolText(rationale) ?? null,
      args: {
        __logLines: startedLogLines,
      },
    });
    const progressEmitter = startToolProgressEmitter(
      deps.runtimeGateway,
      async (eventName, data) => {
        if (eventName !== "tool.progress" || typeof data.toolCallId !== "string" || typeof data.text !== "string") {
          await send(eventName, data);
          return;
        }
        queueToolProgress(
          {
            runId: typeof data.runId === "string" ? data.runId : run.id,
            toolCallId: data.toolCallId,
            toolName,
            text: data.text,
            detail: data.detail && typeof data.detail === "object" ? data.detail as Record<string, unknown> : undefined,
          },
          async (progressText) => {
            liveToolTrace = liveToolTrace.map((entry) =>
              entry.id === data.toolCallId
                ? appendToolProgress(entry, progressText)
                : entry,
            );
            await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
            await send("tool.progress", {
              runId: run.id,
              toolCallId: data.toolCallId,
              toolName,
              text: progressText,
            });
          },
        );
      },
      {
        sessionId: session.id,
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
          backgroundResult = await executeTool(deps, toolName, normalizedToolArgs, {
            userId: session.userId,
            sessionId: session.id,
            runId: run.id,
            auditLog: recordRawLog,
          });
          addRuntimeIds(runtimeIdsToCleanup, normalizedToolArgs, backgroundResult);
          if (toolName === "run_workspace_task") {
            await trackRuntimeBillingEvents(deps, session, run, backgroundResult.billingEvents);
          }
          const resultRuntimeId = typeof backgroundResult.runtimeId === "string" ? backgroundResult.runtimeId : null;
          if (resultRuntimeId) {
            activeRuns.get(run.id)?.runtimeIds.add(resultRuntimeId);
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
            await trackRuntimeBillingEvents(deps, session, run, runtimePayload?.billingEvents);
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
          await progressEmitter.stop();
          await flushToolProgress(
            toolRecord.id,
            {
              runId: run.id,
              toolName,
            },
            async (progressText) => {
              liveToolTrace = liveToolTrace.map((entry) =>
                entry.id === toolRecord.id
                  ? appendToolProgress(entry, progressText)
                  : entry,
              );
              await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
                  await send("tool.progress", {
                    runId: run.id,
                    toolCallId: toolRecord.id,
                    toolName,
                    text: progressText,
                  });
                },
          );
        }
        if (pendingWorkspaceExecution) {
          pendingWorkspaceExecution.status = backgroundStatus;
          pendingWorkspaceExecution.result = backgroundResult;
          pendingWorkspaceExecution.settled = true;
        }
      })(),
    };
  };

  const routedQueryRef = { current: input.message };
  try {
    recordRawLog("router.started", {
      sessionId: session.id,
      message: input.message,
    });
    let routeDecision;
    try {
      routeDecision = deps.router
        ? await deps.router.decide({
            userMessage: input.message,
            conversationHistory,
            billingContext: {
              userId: session.userId,
              sessionId: session.id,
              runId: run.id,
              source: "router",
            },
          })
        : {
            type: "tool_chain" as const,
            fullQuery: input.message,
          };
    } catch (error) {
      recordRawLog("router.failed", {
        runId: run.id,
        sessionId: session.id,
        error: error instanceof Error ? error.message : "Unknown router error",
      });
      throw error;
    }
    await send("router.completed", {
      runId: run.id,
      sessionId: session.id,
      type: routeDecision.type,
      fullQuery: routeDecision.type === "tool_chain" ? routeDecision.fullQuery : null,
    });
    recordRawLog("router.completed", {
      runId: run.id,
      sessionId: session.id,
      type: routeDecision.type,
      fullQuery: routeDecision.type === "tool_chain" ? routeDecision.fullQuery : null,
    });

    if (routeDecision.type === "direct_response") {
      const artifactKey = await persistFinalArtifact(deps, session.id, run.id, routeDecision.answer, []);
      await deps.store.appendMessage(session.id, "assistant", routeDecision.answer, {
        artifactKey,
        route: "direct_response",
      });
      await deps.store.updateRun(run.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
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
      });
      recordRawLog("run.completed", {
        runId: run.id,
        sessionId: session.id,
        status: "completed",
      });
      return;
    }

    const routedQuery = routeDecision.fullQuery.trim() || input.message;
    routedQueryRef.current = routedQuery;
    await ensureInitialPlanSent(routedQuery);
    if (!pendingWorkspaceExecution) {
      const prewarmToolArgs = normalizeToolArgs("create_workspace", {
        workIds: Array.isArray(input.workIds) ? input.workIds.slice(0, 12) : [],
        chunkIds: [],
        taskContext: {
          question: routedQuery,
          researchObjective: routedQuery,
          mode: Array.isArray(input.workIds) && input.workIds.length > 0 ? "open_book_analysis" : "exhaustive_corpus_search",
          candidateWorkIds: Array.isArray(input.workIds) ? input.workIds.slice(0, 12) : [],
          topChunks: [],
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
    }
    for (let turn = 1; turn <= HARD_LIMITS.MAX_TURNS; turn += 1) {
      await harvestPendingWorkspace(false);
      if (
        !pendingWorkspaceExecution
        && !toolHistory.some((entry) => entry.toolName === "run_workspace_task")
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
      if (activeRuns.get(run.id)?.cancelRequested) {
        break;
      }
      if ((deps.now?.() ?? Date.now()) - started > HARD_LIMITS.MAX_RUN_WALL_CLOCK_SECONDS * 1000) {
        break;
      }

      await deps.store.updateRun(run.id, {
        plannerTurns: turn,
      });

      await send("planner.turn", {
        runId: run.id,
        turn,
      });

      const plannerContext: PlannerContext = {
        userMessage: routedQuery,
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
        decision = await deps.planner.decide(plannerContext);
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
          status: "completed",
          plannerTurns: turn,
          completedAt: new Date().toISOString(),
        });
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
        });
        recordRawLog("run.completed", {
          runId: run.id,
          sessionId: session.id,
          status: "completed",
        });
        return;
      }

      let toolCall = parseToolCall(decision);
      if (toolCall?.tool_name === "create_workspace" && pendingWorkspaceExecution) {
        const fallbackDecision = await new FallbackPlanner().decide(plannerContext);
        toolCall = parseToolCall(fallbackDecision);
      }
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

      const normalizedToolArgs = normalizeToolArgs(toolCall.tool_name, toolCall.args);
      if (toolCall.tool_name === "create_workspace" && pendingWorkspaceExecution) {
        continue;
      }
      const pendingExecution = pendingWorkspaceExecution as PendingWorkspaceExecution | null;
      if (toolCall.tool_name === "run_workspace_task" && pendingExecution) {
        const waitingOnBackgroundRuntimeTask = pendingExecution.toolName === "run_workspace_task";
        await harvestPendingWorkspace(true);
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
          : toolCall.tool_name === "create_workspace" && typeof normalizedToolArgs.runtime_id === "string"
            ? normalizedToolArgs.runtime_id
            : null;
      if (runtimeId) {
        activeRun?.runtimeIds.add(runtimeId);
      }
      const toolRecord = await deps.store.startToolCall(run.id, toolCall.tool_name, normalizedToolArgs);
      await ensureInitialPlanSent(routedQuery);
      const startedLogLines = await normalizeToolLinesForUser(deps, {
        toolName: toolCall.tool_name,
        lines: [
          ...(toolCall.rationale
            ? [{
                toolName: toolCall.tool_name,
                key: "rationale",
                value: toolCall.rationale,
              }]
            : []),
          ...flattenValueForCleanup(normalizedToolArgs).map((line) => ({
            ...line,
            toolName: toolCall.tool_name,
          })),
        ],
      });
      recordRawLog("tool.started.raw", {
        runId: run.id,
        toolCallId: toolRecord.id,
        toolName: toolCall.tool_name,
        rationale: toolCall.rationale ?? null,
        args: normalizedToolArgs,
      });
      liveToolTrace = [
        ...liveToolTrace,
        {
          id: toolRecord.id,
          toolName: toolCall.tool_name,
          label: labelForToolCall(toolCall.tool_name, normalizedToolArgs),
          rationale: sanitizeUserFacingToolText(toolCall.rationale) ?? undefined,
          progress: sanitizeUserFacingToolText(toolCall.rationale) ? [sanitizeUserFacingToolText(toolCall.rationale)!] : [],
          args: {
            __logLines: startedLogLines,
          },
          state: "running",
        },
      ];
      await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
      await send("tool.started", {
        runId: run.id,
        toolCallId: toolRecord.id,
        toolName: toolCall.tool_name,
        label: labelForToolCall(toolCall.tool_name, normalizedToolArgs),
        rationale: sanitizeUserFacingToolText(toolCall.rationale) ?? null,
        args: {
          __logLines: startedLogLines,
        },
      });
      const progressEmitter = startToolProgressEmitter(
        deps.runtimeGateway,
        async (eventName, data) => {
          if (eventName !== "tool.progress" || typeof data.toolCallId !== "string" || typeof data.text !== "string") {
            await send(eventName, data);
            return;
          }
          queueToolProgress(
            {
              runId: typeof data.runId === "string" ? data.runId : run.id,
              toolCallId: data.toolCallId,
              toolName: toolCall.tool_name,
              text: data.text,
              detail: data.detail && typeof data.detail === "object" ? data.detail as Record<string, unknown> : undefined,
            },
            async (progressText) => {
              liveToolTrace = liveToolTrace.map((entry) =>
                entry.id === data.toolCallId
                  ? appendToolProgress(entry, progressText)
                  : entry,
              );
              await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
              await send("tool.progress", {
                runId: run.id,
                toolCallId: data.toolCallId,
                toolName: toolCall.tool_name,
                text: progressText,
              });
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
      if (toolCall.tool_name === "create_workspace") {
        await progressEmitter.stop();
        liveToolTrace = liveToolTrace.filter((entry) => entry.id !== toolRecord.id);
        await deps.store.finishToolCall(toolRecord.id, "failed", {
          ok: false,
          error: "Replaced by background workspace startup.",
        });
        await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
        await startBackgroundTool("create_workspace", normalizedToolArgs, toolCall.rationale ?? "Preparing the deeper research workspace.");
        continue;
      }
      try {
        result = await executeTool(deps, toolCall.tool_name, normalizedToolArgs, {
          userId: session.userId,
          sessionId: session.id,
          runId: run.id,
          auditLog: recordRawLog,
        });
        addRuntimeIds(runtimeIdsToCleanup, normalizedToolArgs, result);
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
        await progressEmitter.stop();
        await flushToolProgress(
          toolRecord.id,
          {
            runId: run.id,
            toolName: toolCall.tool_name,
          },
          async (progressText) => {
            liveToolTrace = liveToolTrace.map((entry) =>
              entry.id === toolRecord.id
                ? appendToolProgress(entry, progressText)
                : entry,
            );
            await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
            await send("tool.progress", {
              runId: run.id,
              toolCallId: toolRecord.id,
              toolName: toolCall.tool_name,
              text: progressText,
            });
          },
        );
      }

      if (activeRuns.get(run.id)?.cancelRequested) {
        await deps.store.updateRun(run.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
        });
        await send("run.completed", {
          runId: run.id,
          sessionId: session.id,
          status: "failed",
        });
        recordRawLog("run.completed", {
          runId: run.id,
          sessionId: session.id,
          status: "failed",
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
        await deps.store.updateRun(run.id, {
          status: "completed",
          plannerTurns: turn,
          completedAt: new Date().toISOString(),
        });
        await synthesizeAnswer(
          deps,
          {
            request,
            userId: session.userId,
            sessionId: session.id,
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
        await send("run.completed", {
          runId: run.id,
          sessionId: session.id,
          status: "completed",
        });
        recordRawLog("run.completed", {
          runId: run.id,
          sessionId: session.id,
          status: "completed",
        });
        return;
      }
    }

    const completedBriefing = latestCompletedBriefing(toolHistory);
    if (completedBriefing) {
      await deps.store.updateRun(run.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await synthesizeAnswer(
        deps,
        {
          request,
          userId: session.userId,
          sessionId: session.id,
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
      await send("run.completed", {
        runId: run.id,
        sessionId: session.id,
        status: "completed",
      });
      recordRawLog("run.completed", {
        runId: run.id,
        sessionId: session.id,
        status: "completed",
      });
    } else {
      await deps.store.updateRun(run.id, {
        status: "timed_out",
        completedAt: new Date().toISOString(),
      });
      const timeoutMessage = "The run hit its hard limits before it produced a valid answer.";
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
      });
      recordRawLog("run.completed", {
        runId: run.id,
        sessionId: session.id,
        status: "timed_out",
      });
    }
  } catch (error) {
    await harvestPendingWorkspace(true);
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
          runtimeId: runtimeIdFromToolCall(toolCall) ?? undefined,
        })),
    );
    const refreshedToolCalls = await deps.store.listToolCalls(run.id);
    await persistRecoveredPlanToolTrace(deps, session.id, run.id, refreshedToolCalls);
    await deps.store.updateRun(run.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
    });

    const failureMessage = userFacingRunFailureMessage(error);
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
    });
    recordRawLog("run.completed", {
      runId: run.id,
      sessionId: session.id,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown orchestrator error",
    });
    return;
  } finally {
    await harvestPendingWorkspace(true);
    await flushAllToolProgress(async (toolCallId, toolName, text) => {
      liveToolTrace = liveToolTrace.map((entry) =>
        entry.id === toolCallId
          ? appendToolProgress(entry, text)
          : entry,
      );
      await persistLatestPlanToolTrace(planMessageId, liveToolTrace);
      await send("tool.progress", {
        runId: run.id,
        toolCallId,
        toolName,
        text,
      });
    });
    if (rawLogPersistTimer) {
      clearTimeout(rawLogPersistTimer);
      rawLogPersistTimer = null;
    }
    await rawLogPersistChain;
    await persistRunStreamArtifact(deps, session.id, run.id, rawRunLog);
    await destroyTrackedRuntimes(deps, { sessionId: session.id, runId: run.id }, runtimeIdsToCleanup);
    await reapExpiredRuntimeInstances(deps, { runId: run.id });
    activeRuns.delete(run.id);
  }
}

export function createApp(deps: AppDeps) {
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
        if (isAllowedWebOrigin(origin)) {
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

  function requireTrustedBrowserRequest(c: Context) {
    if (bearerTokenFromRequest(c.req.raw)) {
      return null;
    }
    if (!(deps.auth?.isConfigured() ?? false)) {
      return null;
    }
    const origin = c.req.header("origin");
    if (origin && isAllowedWebOrigin(origin)) {
      return null;
    }
    const secFetchSite = c.req.header("sec-fetch-site");
    if (secFetchSite === "same-origin" || secFetchSite === "same-site") {
      return null;
    }
    return applyCorsHeaders(c, c.json({ error: "Cross-site requests are not allowed." }, 403));
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
      service: "alphabook-orchestrator-worker",
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
    const skill = [
      "---",
      "name: alphabook",
      "version: 1.0.0",
      "description: Agent-facing research access for AlphaBook's corpus and retrieval runtime.",
      `homepage: ${new URL(c.req.url).origin}`,
      `metadata: ${JSON.stringify({ alphabook: { api_base: apiBase, category: "research" } })}`,
      "---",
      "",
      "# AlphaBook",
      "",
      "If a human sends you this file, you are the AI agent that should connect to AlphaBook over the CLI.",
      "",
      "## What to do",
      "",
      "1. Register yourself.",
      "2. Save the returned `api_key`.",
      "3. Send the returned `claim_url` back to your human.",
      "4. Tell them to open the claim URL while signed into AlphaBook.",
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
      `curl -N -X POST ${apiBase}/chat \\`,
      "  -H \"Authorization: Bearer YOUR_API_KEY\" \\",
      "  -H \"Content-Type: application/json\" \\",
      "  -d '{\"message\":\"Find public domain works about grief and exile\"}'",
      "```",
      "",
      "## Session endpoints",
      "",
      `- \`POST ${apiBase}/chat\` streams a research run`,
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
      "If AlphaBook replies with HTTP 402, inspect the JSON body plus the `PAYMENT-REQUIRED` or `payment-required` headers for x402 requirements.",
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
    });
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
    <title>AlphaBook agent claimed</title>
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
      <p><strong>${claimed.name}</strong> is now attached to your AlphaBook account.</p>
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
      return c.redirect("https://alpha-book.org", 302);
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
      return c.json({ redirectTo: "https://alpha-book.org" });
    }
    const redirectTo = await deps.auth.signOut(c);
    return c.json({ redirectTo });
  });

  const handleChatRequest = async (c: Context) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const payload = ChatRequestSchema.parse(await c.req.json());
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
    if (requestPayload.sessionId) {
      const existingSession = await deps.store.getSession(requestPayload.sessionId);
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
    const response = streamResponse(
      (send) => runOrchestrator(deps, c.req.raw, requestPayload, send, activeRuns),
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
        await send("run.started", {
          runId,
          sessionId,
        });

        let lastPlanSignature = "";
        let lastAssistantSignature = "";

        while (!stopped) {
          const [nextRun, messages] = await Promise.all([
            deps.store.getRun(runId),
            deps.store.listMessages(sessionId),
          ]);
          if (!nextRun || nextRun.sessionId !== sessionId) {
            await send("error", {
              message: "Run not found.",
            });
            return;
          }

          const planMessage = [...messages].reverse().find((message) => (
            message.role === "assistant"
            && message.metadata?.phase === "plan"
            && message.metadata?.runId === runId
          ));
          const planSignature = JSON.stringify(planMessage?.metadata?.toolCalls ?? []);
          if (planSignature !== lastPlanSignature) {
            lastPlanSignature = planSignature;
            if (planMessage) {
              await send("tool.progress", {
                runId,
                sessionId,
                toolName: "run_workspace_task",
                text: "stream_update",
              });
            }
          }

          const assistantMessage = [...messages].reverse().find((message) => (
            message.role === "assistant"
            && message.metadata?.phase !== "plan"
            && message.metadata?.runId === runId
          ));
          const assistantSignature = assistantMessage
            ? JSON.stringify({
                id: assistantMessage.id,
                content: assistantMessage.content,
                metadata: assistantMessage.metadata,
              })
            : "";
          if (assistantSignature && assistantSignature !== lastAssistantSignature) {
            lastAssistantSignature = assistantSignature;
            await send("assistant.completed", {
              runId,
              sessionId,
              answer: assistantMessage?.content ?? "",
              citations: Array.isArray(assistantMessage?.metadata?.citations)
                ? assistantMessage?.metadata?.citations as Citation[]
                : [],
              phase: typeof assistantMessage?.metadata?.phase === "string"
                ? assistantMessage.metadata.phase
                : null,
            });
          }

          if (nextRun.status !== "running" && nextRun.status !== "queued") {
            await send("run.completed", {
              runId,
              sessionId,
              status: nextRun.status,
            });
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
        await send("run.started", {
          runId,
          sessionId,
        });

        let lastPlanSignature = "";
        let lastAssistantSignature = "";

        while (!stopped) {
          const [nextRun, messages] = await Promise.all([
            deps.store.getRun(runId),
            deps.store.listMessages(sessionId),
          ]);
          if (!nextRun || nextRun.sessionId !== sessionId) {
            await send("error", {
              message: "Run not found.",
            });
            return;
          }

          const planMessage = [...messages].reverse().find((message) => (
            message.role === "assistant"
            && message.metadata?.phase === "plan"
            && message.metadata?.runId === runId
          ));
          const planSignature = JSON.stringify(planMessage?.metadata?.toolCalls ?? []);
          if (planSignature !== lastPlanSignature) {
            lastPlanSignature = planSignature;
            if (planMessage) {
              await send("tool.progress", {
                runId,
                sessionId,
                toolName: "run_workspace_task",
                text: "stream_update",
              });
            }
          }

          const assistantMessage = [...messages].reverse().find((message) => (
            message.role === "assistant"
            && message.metadata?.phase !== "plan"
            && message.metadata?.runId === runId
          ));
          const assistantSignature = assistantMessage
            ? JSON.stringify({
                id: assistantMessage.id,
                content: assistantMessage.content,
                metadata: assistantMessage.metadata,
              })
            : "";
          if (assistantSignature && assistantSignature !== lastAssistantSignature) {
            lastAssistantSignature = assistantSignature;
            await send("assistant.completed", {
              runId,
              sessionId,
              answer: assistantMessage?.content ?? "",
              citations: Array.isArray(assistantMessage?.metadata?.citations)
                ? assistantMessage?.metadata?.citations as Citation[]
                : [],
              phase: typeof assistantMessage?.metadata?.phase === "string"
                ? assistantMessage.metadata.phase
                : null,
            });
          }

          if (nextRun.status !== "running" && nextRun.status !== "queued") {
            await send("run.completed", {
              runId,
              sessionId,
              status: nextRun.status,
            });
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
    if (activeRun) {
      activeRun.cancelRequested = true;
    }
    const toolCalls = await deps.store.listToolCalls(runId);
    const runtimeIds = new Set<string>([
      ...Array.from(activeRun?.runtimeIds ?? []),
      ...collectRuntimeIds(toolCalls),
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
          runtimeId: runtimeIdFromToolCall(toolCall) ?? undefined,
        })),
    );
    await deps.store.updateRun(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
    });
    await persistRecoveredPlanToolTrace(deps, session.id, runId, await deps.store.listToolCalls(runId));

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
    if (activeRun) {
      activeRun.cancelRequested = true;
    }
    const toolCalls = await deps.store.listToolCalls(runId);
    const runtimeIds = new Set<string>([
      ...Array.from(activeRun?.runtimeIds ?? []),
      ...collectRuntimeIds(toolCalls),
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
          runtimeId: runtimeIdFromToolCall(toolCall) ?? undefined,
        })),
    );
    await deps.store.updateRun(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
    });
    await persistRecoveredPlanToolTrace(deps, session.id, runId, await deps.store.listToolCalls(runId));

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

    const run = await deps.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      return c.json({ error: "Run not found." }, 404);
    }
    const reconciledRun = await reconcilePersistentRun(deps, c.req.raw, run);

    const [toolCalls, runtimeInstances] = await Promise.all([
      deps.store.listToolCalls(runId),
      deps.store.listRuntimeInstances(sessionId),
    ]);
    const artifacts = await loadRunArtifacts(deps, sessionId, runId, toolCalls);
    const rawLog = resolveRunRawLog(activeRuns, runId, artifacts);

    return c.json({
      run: reconciledRun ?? run,
      toolCalls,
      toolTrace: buildRecoveredToolTrace(toolCalls),
      runtimeInstances,
      artifacts,
      rawLog,
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

    const run = await deps.store.getRun(runId);
    if (!run || run.sessionId !== sessionId) {
      return c.json({ error: "Run not found." }, 404);
    }
    const reconciledRun = await reconcilePersistentRun(deps, c.req.raw, run);

    const [toolCalls, runtimeInstances] = await Promise.all([
      deps.store.listToolCalls(runId),
      deps.store.listRuntimeInstances(sessionId),
    ]);
    const artifacts = await loadRunArtifacts(deps, sessionId, runId, toolCalls);
    const rawLog = resolveRunRawLog(activeRuns, runId, artifacts);

    return c.json({
      run: reconciledRun ?? run,
      toolCalls,
      toolTrace: buildRecoveredToolTrace(toolCalls),
      runtimeInstances,
      artifacts,
      rawLog,
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
          const runArtifacts = await loadRunArtifacts(deps, sessionId, run.id, toolCallsByRun[run.id] ?? []);
          return [run.id, resolveRunRawLog(activeRuns, run.id, runArtifacts)];
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
    const reconciledRun = await reconcilePersistentRun(deps, c.req.raw, run);

    const [messages, toolCalls, runtimeInstances, artifacts] = await Promise.all([
      deps.store.listMessages(sessionId),
      deps.store.listToolCalls(runId),
      deps.store.listRuntimeInstances(sessionId),
      deps.store.listArtifacts(sessionId),
    ]);
    const rawLog = resolveRunRawLog(activeRuns, runId,
      artifacts.filter((artifact) =>
        artifact.metadata?.kind === "tool_stream_raw" && artifact.filename.includes(runId),
      ),
    );

    return c.json({
      session,
      run: reconciledRun ?? run,
      messages,
      toolCalls,
      runtimeInstances,
      artifacts,
      rawLog,
    });
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
    const reconciledRun = await reconcilePersistentRun(deps, c.req.raw, run);

    const [messages, toolCalls, runtimeInstances] = await Promise.all([
      deps.store.listMessages(sessionId),
      deps.store.listToolCalls(runId),
      deps.store.listRuntimeInstances(sessionId),
    ]);
    const artifacts = await loadRunArtifacts(deps, sessionId, runId, toolCalls);
    const rawLog = resolveRunRawLog(activeRuns, runId, artifacts);

    return c.json({
      session,
      run: reconciledRun ?? run,
      messages,
      toolCalls,
      runtimeInstances,
      artifacts,
      rawLog,
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
    const reconciledRun = await reconcilePersistentRun(deps, c.req.raw, run);

    const [messages, toolCalls, runtimeInstances] = await Promise.all([
      deps.store.listMessages(sessionId),
      deps.store.listToolCalls(runId),
      deps.store.listRuntimeInstances(sessionId),
    ]);
    const artifacts = await loadRunArtifacts(deps, sessionId, runId, toolCalls);
    const rawLog = resolveRunRawLog(activeRuns, runId, artifacts);

    return c.json({
      session,
      run: reconciledRun ?? run,
      messages,
      toolCalls,
      runtimeInstances,
      artifacts,
      rawLog,
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
    const reconciledRun = await reconcilePersistentRun(deps, c.req.raw, run);

    const session = await deps.store.getSession((reconciledRun ?? run).sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }

    const [messages, toolCalls, runtimeInstances, owner] = await Promise.all([
      deps.store.listMessages(session.id),
      deps.store.listToolCalls(runId),
      deps.store.listRuntimeInstances(session.id),
      deps.store.getUserProfile(session.userId),
    ]);
    const artifacts = await loadRunArtifacts(deps, session.id, runId, toolCalls);
    const rawLog = parseRawRunLogEntries(artifacts);
    const liveRuntime = await loadLiveRuntimeLogs(deps, session.id, runId, collectRuntimeIds(toolCalls));

    return c.json({
      requestedBy: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
      },
      owner,
      session,
      run: reconciledRun ?? run,
      messages,
      toolCalls,
      runtimeInstances,
      artifacts,
      rawLog,
      liveRuntime,
    });
  });

  app.get("/works", async (c) => {
    const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
    const limit = Math.min(24, Math.max(1, Number.parseInt(c.req.query("limit") ?? "12", 10) || 12));
    const [works, totalCount] = await Promise.all([
      deps.store.listWorks(offset, limit),
      deps.store.countWorks(),
    ]);
    return c.json({
      works: works.map((work) => decorateWork(c, work)),
      nextOffset: works.length === limit ? offset + works.length : null,
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

  return app;
}
