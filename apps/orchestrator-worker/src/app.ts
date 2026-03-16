import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { ChatRequestSchema, HARD_LIMITS, R2_PREFIXES, ToolArgsSchemas, getToolLabel, type ChatRequest, type ChunkSearchResult, type Citation, type PlannerDecision, type ToolName, type WorkSummary } from "@alphabook/shared";

import type { WorkOSAuth } from "./auth";
import type { BillingService } from "./billing";
import type { Embedder } from "./embeddings";
import type { BlobStore } from "./r2";
import type { Planner } from "./planner";
import { parseToolCall } from "./planner";
import type { Synthesizer, ToolHistoryEntry } from "./synthesizer";
import type { AppStore, SessionRecord } from "./store";

export interface WorkerQueues {
  ingestName: string;
  jobsName: string;
}

export interface RuntimeToolGateway {
  createWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  runWorkspaceTask(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  readWorkspaceFile(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  listWorkspaceFiles?(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  destroyWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AppDeps {
  store: AppStore;
  billing: BillingService;
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
}

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function analyticsKey(eventName: string) {
  const date = new Date().toISOString().slice(0, 10);
  const safeEvent = eventName.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  return `analytics/${date}/${Date.now()}-${crypto.randomUUID()}-${safeEvent}.json`;
}

async function recordAnalyticsEvent(
  deps: AppDeps,
  request: Request,
  eventName: string,
  payload: Record<string, unknown> = {},
) {
  const forwardedFor = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for");
  const userAgent = request.headers.get("user-agent");
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

function streamResponse(
  executor: (send: (event: string, data: Record<string, unknown>) => Promise<void>) => Promise<void>,
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
        await send("error", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        controller.close();
      }
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
      "Allocating a fresh workspace.",
      "Loading corpus files into the workspace.",
      "Finishing the workspace setup.",
    ];
  }
  const taskSpec = args.taskSpec && typeof args.taskSpec === "object" ? args.taskSpec as Record<string, unknown> : null;
  const phase = typeof taskSpec?.phase === "string" ? taskSpec.phase : null;
  const workCount = Array.isArray(taskSpec?.workIds) ? taskSpec.workIds.length : 0;
  const scope = workCount > 0 ? `${workCount} books` : "the current corpus snapshot";
  if (phase === "collect_evidence") {
    return [
      `Scanning ${scope} for likely matches.`,
      "Pulling candidate passages into the evidence set.",
      "Keeping the strongest quotations and source references.",
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
    stop() {
      clearInterval(timer);
    },
  };
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
    if (stopped || inFlight) {
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
          if (typeof event.message === "string" && event.message.trim().length > 0) {
            await emit(event.message, event);
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

  void emit("Starting the background Codex search.");
  void poll();
  const timer = setInterval(() => {
    void poll();
  }, 1500);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
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
  }
  return genericProgressEmitter(send, runId, toolCallId, toolName, args);
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
  let cursor = 0;
  while (cursor < cleaned.length) {
    const nextCursor = Math.min(cleaned.length, cursor + 180);
    chunks.push(cleaned.slice(cursor, nextCursor));
    cursor = nextCursor;
  }
  return chunks;
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
    const hydratedWorkCount = manifest && Array.isArray(manifest.works) ? manifest.works.length : 0;
    return {
      ok: result.ok === true,
      reused: result.reused === true,
      runtimeId: typeof result.runtimeId === "string" ? result.runtimeId : undefined,
      hydratedWorkCount,
      manifest: hydratedWorkCount > 0 ? { works: new Array(hydratedWorkCount).fill(null) } : undefined,
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

function describePlannerAction(toolName: ToolName, rationale?: string) {
  if (typeof rationale === "string" && rationale.trim()) {
    return rationale.trim();
  }

  switch (toolName) {
    case "search_works":
      return "Scanning the library for likely books and themes.";
    case "get_relevant_chunks":
      return "Pulling a few seed passages to guide the deeper search.";
    case "get_work_metadata":
      return "Loading context for the books most likely to matter.";
    case "get_work_text":
      return "Opening the source text directly.";
    case "create_workspace":
      return "Preparing the workspace for the full corpus search.";
    case "run_workspace_task":
      return "Searching the corpus now.";
    case "read_workspace_file":
      return "Bringing the latest search notes back into the thread.";
    case "destroy_workspace":
      return "Cleaning up the workspace.";
    default:
      return "Planning the next research step.";
  }
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

  return Promise.all(
    filtered.map(async (artifact) => ({
      ...artifact,
      content: isTextArtifact(artifact.filename, artifact.mimeType)
        ? await deps.blobStore.getText(artifact.r2Key)
        : null,
    })),
  );
}

function isAdminUser(user: Awaited<ReturnType<AppStore["getUserProfile"]>>, allowedEmail?: string) {
  if (!allowedEmail || !user?.email) {
    return false;
  }
  return user.email.trim().toLowerCase() === allowedEmail.trim().toLowerCase();
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

  if (!deps.openAIApiKey || !deps.openAIModel) {
    return {
      title: "Analytics unavailable",
      summary: "OpenAI is not configured for analytics queries in this environment.",
      metrics: [],
      series: [],
      hashtags: [],
      inspectedDays: days,
      events,
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

async function synthesizeAnswer(
  deps: AppDeps,
  params: {
    userId: string;
    sessionId: string;
    runId: string;
    userMessage: string;
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

  let synthesis;
  synthesis = await deps.synthesizer.synthesize({
    userMessage: params.userMessage,
    plannerDraft: params.plannerDraft,
    plannerCitations: params.plannerCitations,
    toolHistory: params.toolHistory,
    billingContext: {
      userId: params.userId,
      sessionId: params.sessionId,
      runId: params.runId,
      source: "synthesizer",
    },
  });

  const artifactKey = await persistFinalArtifact(deps, params.sessionId, params.runId, synthesis.answer, synthesis.citations);
  const summarizedToolHistory = summarizeToolHistory(params.toolHistory);
  await deps.store.appendMessage(params.sessionId, "assistant", synthesis.answer, {
    citations: synthesis.citations,
    artifactKey,
    researchLog: summarizedToolHistory,
    toolCalls: summarizedToolHistory,
  });

  for (const text of chunkTextForStream(synthesis.answer)) {
    await send("assistant.delta", {
      text,
    });
  }
  await send("assistant.completed", {
    answer: synthesis.answer,
    citations: synthesis.citations,
    artifactKey,
  });
}

async function runOrchestrator(
  deps: AppDeps,
  input: ChatRequest,
  send: (event: string, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const started = deps.now?.() ?? Date.now();
  if (!input.userId) {
    throw new Error("A userId is required to start an orchestrator run.");
  }
  await deps.store.ensureUser(input.userId);

  let session: SessionRecord | null = input.sessionId ? await deps.store.getSession(input.sessionId) : null;
  if (!session) {
    session = await deps.store.createSession(input.userId, titleFromMessage(input.message));
    await send("session.created", {
      sessionId: session.id,
      title: session.title,
    });
  }

  await deps.store.appendMessage(session.id, "user", input.message);
  const run = await deps.store.createRun(session.id);
  await send("run.started", {
    runId: run.id,
    sessionId: session.id,
  });

  const toolHistory: Array<{
    toolName: ToolName;
    rationale?: string;
    args: Record<string, unknown>;
    result: Record<string, unknown>;
  }> = [];
  const toolResults: Record<string, unknown>[] = [];
  let runtimeTasks = 0;
  let initialPlanSent = false;

  for (let turn = 1; turn <= HARD_LIMITS.MAX_TURNS; turn += 1) {
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

    const decision: PlannerDecision = await deps.planner.decide({
      userMessage: input.message,
      turns: turn,
      toolHistory,
      workScope: input.workIds,
      billingContext: {
        userId: session.userId,
        sessionId: session.id,
        runId: run.id,
        source: "planner",
      },
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
          userId: session.userId,
          sessionId: session.id,
          runId: run.id,
          userMessage: input.message,
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

    const toolRecord = await deps.store.startToolCall(run.id, toolCall.tool_name, toolCall.args);
    if (!initialPlanSent) {
      const planText = describePlannerAction(toolCall.tool_name, toolCall.rationale);
      const planMessage = await deps.store.appendMessage(session.id, "assistant", planText, {
        phase: "plan",
        runId: run.id,
      });
      await send("assistant.plan", {
        runId: run.id,
        sessionId: session.id,
        messageId: planMessage.id,
        text: planText,
      });
      initialPlanSent = true;
    }
    await send("tool.started", {
      runId: run.id,
      toolCallId: toolRecord.id,
      toolName: toolCall.tool_name,
      label: labelForToolCall(toolCall.tool_name, toolCall.args),
      rationale: toolCall.rationale ?? null,
      args: toolCall.args,
    });
    const progressEmitter = startToolProgressEmitter(
      deps.runtimeGateway,
      send,
      {
        sessionId: session.id,
        runId: run.id,
      },
      run.id,
      toolRecord.id,
      toolCall.tool_name,
      toolCall.args,
    );

    let result: Record<string, unknown>;
    let status: "completed" | "failed" = "completed";
    try {
      result = await executeTool(deps, toolCall.tool_name, toolCall.args, {
        userId: session.userId,
        sessionId: session.id,
        runId: run.id,
      });
      if (toolCall.tool_name === "run_workspace_task") {
        await trackRuntimeBillingEvents(deps, session, run, result.billingEvents);
      }
      if (toolCall.tool_name === "create_workspace" || toolCall.tool_name === "run_workspace_task") {
        runtimeTasks += 1;
      }
    } catch (error) {
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
        error: error instanceof Error ? error.message : "Unknown tool error",
      };
    } finally {
      progressEmitter.stop();
    }

    await deps.store.finishToolCall(toolRecord.id, status, result);
    const streamedResult = clientSafeToolResult(toolCall.tool_name, result);
    await send("tool.completed", {
      runId: run.id,
      toolCallId: toolRecord.id,
      toolName: toolCall.tool_name,
      label: labelForToolCall(toolCall.tool_name, toolCall.args),
      rationale: toolCall.rationale ?? null,
      status,
      result: streamedResult,
    });
    toolHistory.push({
      toolName: toolCall.tool_name,
      rationale: toolCall.rationale,
      args: toolCall.args,
      result,
    });
    toolResults.push(result);
  }

  await deps.store.updateRun(run.id, {
    status: "timed_out",
    completedAt: new Date().toISOString(),
  });
  const timeoutMessage = "The run hit its hard limits before it produced a valid answer.";
  await deps.store.appendMessage(session.id, "assistant", timeoutMessage, {
    runId: run.id,
    phase: "error",
    toolCalls: summarizeToolHistory(toolHistory),
  });
  await send("assistant.delta", { text: timeoutMessage });
  await send("assistant.completed", {
    answer: timeoutMessage,
    citations: [],
    artifactKey: null,
  });
  await send("run.completed", {
    runId: run.id,
    sessionId: session.id,
    status: "timed_out",
  });
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) {
          return origin;
        }
        if (
          origin === "https://alpha-book.org" ||
          origin === "https://www.alpha-book.org" ||
          origin === "http://127.0.0.1:4193" ||
          origin === "http://localhost:4193"
        ) {
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
      return c.json({ error: error instanceof Error ? error.message : "Failed to store analytics event." }, 500);
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
      return c.json({ error: error instanceof Error ? error.message : "Failed to load users." }, 500);
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
      return c.json({ error: error instanceof Error ? error.message : "Failed to load runs." }, 500);
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
      return c.json({ error: error instanceof Error ? error.message : "Failed to load sessions." }, 500);
    }
  });

  app.post("/admin/analytics/query", async (c) => {
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
      return c.json({ error: error instanceof Error ? error.message : "Analytics query failed." }, 500);
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
      profile,
      isFollowing,
      isSelf,
    });
  });

  app.post("/profiles/:userId/follow", async (c) => {
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
      profile: refreshed ?? profile,
      isFollowing: viewer.id !== targetUserId,
    });
  });

  app.delete("/profiles/:userId/follow", async (c) => {
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
      profile: refreshed ?? profile,
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
    return deps.auth.signOut(c);
  });

  app.post("/chat", async (c) => {
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
    return streamResponse((send) => runOrchestrator(deps, requestPayload, send));
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

    const [toolCalls, runtimeInstances] = await Promise.all([
      deps.store.listToolCalls(runId),
      deps.store.listRuntimeInstances(sessionId),
    ]);

    return c.json({
      run,
      toolCalls,
      runtimeInstances,
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

    const [messages, toolCalls, runtimeInstances, artifacts] = await Promise.all([
      deps.store.listMessages(sessionId),
      deps.store.listToolCalls(runId),
      deps.store.listRuntimeInstances(sessionId),
      deps.store.listArtifacts(sessionId),
    ]);

    return c.json({
      session,
      run,
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

    const [messages, toolCalls, runtimeInstances] = await Promise.all([
      deps.store.listMessages(sessionId),
      deps.store.listToolCalls(runId),
      deps.store.listRuntimeInstances(sessionId),
    ]);
    const artifacts = await loadRunArtifacts(deps, sessionId, runId, toolCalls);

    return c.json({
      session,
      run,
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

    const session = await deps.store.getSession(run.sessionId);
    if (!session) {
      return c.json({ error: "Session not found." }, 404);
    }

    const [messages, toolCalls, runtimeInstances, owner] = await Promise.all([
      deps.store.listMessages(run.sessionId),
      deps.store.listToolCalls(runId),
      deps.store.listRuntimeInstances(run.sessionId),
      deps.store.getUserProfile(session.userId),
    ]);
    const artifacts = await loadRunArtifacts(deps, run.sessionId, runId, toolCalls);
    const liveRuntime = await loadLiveRuntimeLogs(deps, run.sessionId, runId, collectRuntimeIds(toolCalls));

    return c.json({
      requestedBy: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
      },
      owner,
      session,
      run,
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
    const works = await deps.store.listWorks(offset, limit);
    return c.json({
      works: works.map((work) => decorateWork(c, work)),
      nextOffset: works.length === limit ? offset + works.length : null,
    });
  });

  app.get("/works/:workId", async (c) => {
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
      work: decorateWork(c, work),
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
