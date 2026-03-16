import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { ChatRequestSchema, HARD_LIMITS, R2_PREFIXES, ToolArgsSchemas, getToolLabel, type ChatRequest, type ChunkSearchResult, type Citation, type PlannerDecision, type ToolName, type WorkSummary } from "@alphabook/shared";
import { ZodError } from "zod";

import type { WorkOSAuth } from "./auth";
import type { BillingService } from "./billing";
import type { Embedder } from "./embeddings";
import type { BlobStore } from "./r2";
import type { Planner, PlannerContext } from "./planner";
import { FallbackPlanner, parseToolCall } from "./planner";
import type { Router } from "./router";
import { cleanupToolStreamWithWorkersAi, type ToolStreamCleanupLine } from "./tool-stream-cleanup";
import type { Synthesizer, ToolHistoryEntry } from "./synthesizer";
import type { AnalyticsEventRecord, AppStore, MessageRecord, SessionRecord } from "./store";
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
}

const ALLOWED_WEB_ORIGINS = new Set([
  "https://alpha-book.org",
  "https://www.alpha-book.org",
  "http://127.0.0.1:4193",
  "http://localhost:4193",
]);

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isAllowedWebOrigin(origin: string | null | undefined): boolean {
  if (!origin) {
    return false;
  }
  return ALLOWED_WEB_ORIGINS.has(origin);
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

function normalizeToolArgs(toolName: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...args };
  switch (toolName) {
    case "get_work_metadata":
      if (normalized.workIds === undefined && normalized.work_ids !== undefined) {
        normalized.workIds = normalized.work_ids;
      }
      break;
    case "get_relevant_chunks":
      if (normalized.workIds === undefined && normalized.work_ids !== undefined) {
        normalized.workIds = normalized.work_ids;
      }
      if (normalized.filters && typeof normalized.filters === "object") {
        const filters = { ...(normalized.filters as Record<string, unknown>) };
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

function formatToolExecutionError(toolName: ToolName, error: unknown) {
  if (error instanceof ZodError) {
    if (toolName === "get_relevant_chunks") {
      return "Passage search requested too many passages at once, so I reduced the request to the allowed limit.";
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
      const send = async (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      try {
        await executor(send);
      } catch (error) {
        if (onError) {
          await onError(error);
        }
        await send("error", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        controller.close();
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
  subscribers: Map<string, (event: string, data: Record<string, unknown>) => Promise<void>>;
};

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
  context: { userId: string; sessionId: string; runId: string },
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
        embedding = await deps.embedder.embedQuery(parsed.query, {
          userId: context.userId,
          sessionId: context.sessionId,
          runId: context.runId,
          source: "embedder",
        });
      } catch {
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
  if (/context_length_exceeded|maximum context length|too many tokens|too long for messages/i.test(rawMessage)) {
    return "This run tried to carry too much prior search state into the next planning step, so I stopped it instead of continuing with a broken context window.";
  }
  if (/cancelled by user/i.test(rawMessage)) {
    return "This run was cancelled.";
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
) {
  const fallback = fallbackNormalizeToolLines(input.lines);
  if (!deps.ai || input.lines.length === 0) {
    return fallback;
  }
  try {
    const cleaned = await cleanupToolStreamWithWorkersAi(deps.ai, {
      model: deps.toolStreamCleanupModel,
      toolName: input.toolName,
      lines: input.lines,
    });
    const normalized = fallbackNormalizeToolLines(
      cleaned.normalizedLines.map((line) => ({
        toolName: input.toolName,
        key: "normalized",
        value: line,
      })),
    );
    return normalized.length > 0 ? normalized : fallback;
  } catch {
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
  const r2Key = R2_PREFIXES.sessionArtifact(sessionId, filename);
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

  const userMessage =
    [...conversationHistory].reverse().find((message) => message.role === "user")?.content ?? "";

  try {
    await synthesizeAnswer(
      deps,
      {
        request,
        userId: session.userId,
        sessionId: session.id,
        runId,
        userMessage,
        conversationHistory,
        plannerDraft: completedBriefing.answer,
        plannerCitations: completedBriefing.citations,
        toolHistory,
      },
      async () => {},
    );
    return;
  } catch (error) {
    const fallbackAnswer = await rewriteAnswerWithCitationLinks(
      deps,
      session.id,
      completedBriefing.answer,
      completedBriefing.citations,
    );
    const artifactKey = await persistFinalArtifact(
      deps,
      session.id,
      runId,
      fallbackAnswer,
      completedBriefing.citations,
    );
    await deps.store.appendMessage(session.id, "assistant", fallbackAnswer, {
      runId,
      phase: "answer",
      citations: completedBriefing.citations,
      artifactKey,
      researchLog: summarizeToolHistory(toolHistory),
      synthesisFallback: true,
      synthesisError: error instanceof Error ? error.message : "Unknown synthesis error",
    });
  }
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
    if (run.status === "running" || run.status === "queued") {
      await reconcilePersistentRun(deps, request, run);
    }
  }
}

function titleFromMessage(message: string): string {
  return message
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");
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
  const key = R2_PREFIXES.sessionArtifact(sessionId, `${runId}-final-answer.json`);
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
  },
  send: (event: string, data: Record<string, unknown>) => Promise<void>,
) {
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

  const artifactKey = await persistFinalArtifact(deps, params.sessionId, params.runId, synthesis.answer, synthesis.citations);
  const summarizedToolHistory = summarizeToolHistory(params.toolHistory);
  await deps.store.appendMessage(params.sessionId, "assistant", synthesis.answer, {
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

  const recordRawLog = (event: string, payload: Record<string, unknown>) => {
    rawRunLog.push({
      seq: rawLogSequence,
      timestamp: new Date().toISOString(),
      event,
      payload,
    });
    rawLogSequence += 1;
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
      });
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

  let session: SessionRecord | null = input.sessionId ? await deps.store.getSession(input.sessionId) : null;
  if (session && session.userId !== input.userId) {
    throw new Error("Not authorized for this session.");
  }
  if (!session) {
    session = await deps.store.createSession(input.userId, titleFromMessage(input.message));
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
  const run = await deps.store.createRun(session.id);
  activeRuns.set(run.id, {
    sessionId: session.id,
    userId: input.userId,
    runtimeIds: new Set<string>(),
    cancelRequested: false,
    subscribers: new Map(),
  });
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
  let pendingWorkspaceExecution: {
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
  } | null = null;

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
              __logLines: completedLogLines,
              error: typeof streamedResult.error === "string" ? streamedResult.error : undefined,
            },
            isError: status === "failed",
            state: status === "failed" ? "error" : "completed",
          }
        : entry,
    );
    await persistPlanToolTrace(deps, planMessageId, run.id, liveToolTrace);
    await send("tool.completed", {
      runId: run.id,
      toolCallId,
      toolName,
      label: labelForToolCall(toolName, normalizedArgs),
      rationale: sanitizeUserFacingToolText(rationale) ?? null,
      status,
      result: {
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
      pendingWorkspaceExecution.result ?? { ok: false, error: "Workspace startup did not return a result." },
    );
    const wasCompleted = pendingWorkspaceExecution.status === "completed";
    pendingWorkspaceExecution = null;
    return wasCompleted;
  };

  const routedQueryRef = { current: input.message };
  try {
    const routeDecision = deps.router
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
    for (let turn = 1; turn <= HARD_LIMITS.MAX_TURNS; turn += 1) {
      await harvestPendingWorkspace(false);
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
        pendingTools: pendingWorkspaceExecution
          ? [{
              toolName: pendingWorkspaceExecution.toolName,
              args: pendingWorkspaceExecution.normalizedArgs,
            }]
          : [],
        workScope: input.workIds,
        billingContext: {
          userId: session.userId,
          sessionId: session.id,
          runId: run.id,
          source: "planner",
        },
      };
      const decision: PlannerDecision = await deps.planner.decide(plannerContext);

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
      if (toolCall.tool_name === "run_workspace_task" && pendingWorkspaceExecution) {
        await harvestPendingWorkspace(true);
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
      if (!initialPlanSent) {
        const planText = initialAssistantPlan(routedQuery);
        const planMessage = await deps.store.appendMessage(session.id, "assistant", planText, {
          phase: "plan",
          runId: run.id,
        });
        planMessageId = planMessage.id;
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
        await persistPlanToolTrace(deps, planMessageId, run.id, liveToolTrace);
        initialPlanSent = true;
      }
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
      await persistPlanToolTrace(deps, planMessageId, run.id, liveToolTrace);
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
              await send("tool.progress", {
                runId: run.id,
                toolCallId: data.toolCallId,
                toolName: toolCall.tool_name,
                text: progressText,
              });
              liveToolTrace = liveToolTrace.map((entry) =>
                entry.id === data.toolCallId
                  ? appendToolProgress(entry, progressText)
                  : entry,
              );
              await persistPlanToolTrace(deps, planMessageId, run.id, liveToolTrace);
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
        runtimeTasks += 1;
        pendingWorkspaceExecution = {
          toolName: toolCall.tool_name,
          toolRecordId: toolRecord.id,
          normalizedArgs: normalizedToolArgs,
          rationale: toolCall.rationale,
          progressEmitter,
          settled: false,
          finalized: false,
          status: "failed",
          promise: (async () => {
            let backgroundResult: Record<string, unknown>;
            let backgroundStatus: "completed" | "failed" = "completed";
            try {
              backgroundResult = await executeTool(deps, toolCall.tool_name, normalizedToolArgs, {
                userId: session.userId,
                sessionId: session.id,
                runId: run.id,
              });
              addRuntimeIds(runtimeIdsToCleanup, normalizedToolArgs, backgroundResult);
              const resultRuntimeId = typeof backgroundResult.runtimeId === "string" ? backgroundResult.runtimeId : null;
              if (resultRuntimeId) {
                activeRun?.runtimeIds.add(resultRuntimeId);
              }
            } catch (error) {
              addRuntimeIds(runtimeIdsToCleanup, normalizedToolArgs);
              backgroundStatus = "failed";
              backgroundResult = {
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
                  await send("tool.progress", {
                    runId: run.id,
                    toolCallId: toolRecord.id,
                    toolName: toolCall.tool_name,
                    text: progressText,
                  });
                  liveToolTrace = liveToolTrace.map((entry) =>
                    entry.id === toolRecord.id
                      ? appendToolProgress(entry, progressText)
                      : entry,
                  );
                  await persistPlanToolTrace(deps, planMessageId, run.id, liveToolTrace);
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
        continue;
      }
      try {
        result = await executeTool(deps, toolCall.tool_name, normalizedToolArgs, {
          userId: session.userId,
          sessionId: session.id,
          runId: run.id,
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
            await send("tool.progress", {
              runId: run.id,
              toolCallId: toolRecord.id,
              toolName: toolCall.tool_name,
              text: progressText,
            });
            liveToolTrace = liveToolTrace.map((entry) =>
              entry.id === toolRecord.id
                ? appendToolProgress(entry, progressText)
                : entry,
            );
            await persistPlanToolTrace(deps, planMessageId, run.id, liveToolTrace);
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
      await send("tool.progress", {
        runId: run.id,
        toolCallId,
        toolName,
        text,
      });
    });
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
    return c.json({ error: error instanceof Error ? error.message : "Internal server error." }, 500);
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
      allowHeaders: ["content-type"],
      exposeHeaders: ["content-type"],
      credentials: true,
      maxAge: 86400,
    }),
  );

  async function resolveUser(c: Context) {
    if (deps.auth?.isConfigured()) {
      return deps.auth.getCurrentUser(c);
    }
    const userId = c.req.query("userId");
    if (!userId) {
      return null;
    }
    await deps.store.ensureUser(userId);
    return deps.store.getUserProfile(userId);
  }

  async function requireAdmin(c: Context) {
    const user = await resolveUser(c);
    if (!isAdminUser(user, deps.adminAllowedEmail)) {
      return null;
    }
    return user;
  }

  async function canAccessSession(c: Context, session: SessionRecord) {
    if (!(deps.auth?.isConfigured() ?? false)) {
      return true;
    }
    const user = await resolveUser(c);
    if (!user) {
      return false;
    }
    return user.id === session.userId || isAdminUser(user, deps.adminAllowedEmail);
  }

  function requireTrustedBrowserRequest(c: Context) {
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
    return c.json({ error: "Cross-site requests are not allowed." }, 403);
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
    return c.json({ error: error instanceof Error ? error.message : fallbackMessage }, 500);
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

  app.get("/me", async (c) => {
    const user = await resolveUser(c);
    return c.json({
      authenticated: Boolean(user),
      authConfigured: deps.auth?.isConfigured() ?? false,
      user: user ?? null,
    });
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

  app.post("/chat", async (c) => {
    const trustedRequest = requireTrustedBrowserRequest(c);
    if (trustedRequest) {
      return trustedRequest;
    }
    const payload = ChatRequestSchema.parse(await c.req.json());
    const user = await resolveUser(c);
    if ((deps.auth?.isConfigured() ?? false) && !user) {
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
    if (!billingCheck.allowed) {
      return c.json({
        error: "Monthly AI usage limit reached.",
        code: "billing_limit_exceeded",
        limitUsd: billingCheck.limitUsd,
        spendUsd: billingCheck.spendUsd,
        windowStartedAt: billingCheck.windowStartedAt,
      }, 402);
    }
    return streamResponse(
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
  });

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

  app.get("/sessions", async (c) => {
    const user = await resolveUser(c);
    if (!user) {
      return c.json({ error: "Authentication required." }, deps.auth?.isConfigured() ? 401 : 400);
    }
    const sessions = await deps.store.listSessions(user.id);
    return c.json({ sessions });
  });

  app.get("/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }
    await reconcileSessionRuns(deps, c.req.raw, sessionId);
    const messages = await deps.store.listMessages(sessionId);
    return c.json({ messages });
  });

  app.get("/sessions/:sessionId/runs", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }
    if (!(await canAccessSession(c, session))) {
      return c.json({ error: "Not authorized for this session." }, 403);
    }

    await reconcileSessionRuns(deps, c.req.raw, sessionId);
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

    return c.json({
      run: reconciledRun ?? run,
      toolCalls,
      toolTrace: buildRecoveredToolTrace(toolCalls),
      runtimeInstances,
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

    await reconcileSessionRuns(deps, c.req.raw, sessionId);
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

    return c.json({
      session,
      messages,
      runs,
      toolCallsByRun,
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

    return c.json({
      session,
      run: reconciledRun ?? run,
      messages,
      toolCalls,
      runtimeInstances,
      artifacts,
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

    return c.json({
      session,
      run: reconciledRun ?? run,
      messages,
      toolCalls,
      runtimeInstances,
      artifacts,
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
