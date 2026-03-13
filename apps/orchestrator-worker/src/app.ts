import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { ChatRequestSchema, HARD_LIMITS, R2_PREFIXES, ToolArgsSchemas, getToolLabel, type ChatRequest, type ChunkSearchResult, type Citation, type PlannerDecision, type ToolName, type WorkSummary } from "@alphabook/shared";

import type { WorkOSAuth } from "./auth";
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
  destroyWorkspace(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface AppDeps {
  store: AppStore;
  planner: Planner;
  embedder: Embedder;
  synthesizer: Synthesizer;
  blobStore: BlobStore;
  runtimeGateway: RuntimeToolGateway;
  queues: WorkerQueues;
  auth?: WorkOSAuth;
  now?: () => number;
}

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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

async function executeTool(
  deps: AppDeps,
  toolName: ToolName,
  args: Record<string, unknown>,
  context: { sessionId: string; runId: string },
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
        embedding = await deps.embedder.embedQuery(parsed.query);
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

function startToolProgressEmitter(
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
  const timer = setInterval(() => {
    const text = steps[stepIndex % steps.length];
    stepIndex += 1;
    void send("tool.progress", {
      runId,
      toolCallId,
      toolName,
      text,
    });
  }, 4000);

  return {
    stop() {
      clearInterval(timer);
    },
  };
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

function summarizeToolHistory(toolHistory: ToolHistoryEntry[]) {
  return toolHistory.map((entry, index) => ({
    id: `${entry.toolName}-${index}`,
    toolName: entry.toolName,
    label: getToolLabel(entry.toolName),
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

function fallbackFinalAnswer(toolResults: Record<string, unknown>[]): { answer: string; citations: Array<Record<string, unknown>> } {
  let lastChunkPayload: { chunks: ChunkSearchResult[] } | undefined;
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const candidate = toolResults[index];
    if (Array.isArray(candidate.chunks)) {
      lastChunkPayload = candidate as { chunks: ChunkSearchResult[] };
      break;
    }
  }
  if (!lastChunkPayload?.chunks.length) {
    return {
      answer: "The orchestrator stopped without enough evidence to answer confidently.",
      citations: [],
    };
  }
  const citations = lastChunkPayload.chunks.slice(0, 4).map((chunk) => ({
    workId: chunk.workId,
    chunkId: chunk.id,
    label: `${chunk.workId}#${chunk.chunkIndex}`,
    excerpt: chunk.excerpt,
    r2Key: chunk.r2Key,
  }));
  return {
    answer: "I gathered relevant passages, but the run hit its hard limit before producing a cleaner synthesis.",
    citations,
  };
}

function isTextArtifact(filename: string, mimeType: string) {
  return mimeType.startsWith("text/") || mimeType.includes("json") || /\.(md|txt|json|log)$/iu.test(filename);
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
  try {
    synthesis = await deps.synthesizer.synthesize({
      userMessage: params.userMessage,
      plannerDraft: params.plannerDraft,
      plannerCitations: params.plannerCitations,
      toolHistory: params.toolHistory,
    });
  } catch (error) {
    synthesis = {
      answer: params.plannerDraft ?? "The run completed, but the final synthesis step failed.",
      citations: params.plannerCitations,
    };
    await send("synthesis.failed", {
      runId: params.runId,
      message: error instanceof Error ? error.message : "Unknown synthesis error",
    });
  }

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
      label: getToolLabel(toolCall.tool_name),
      rationale: toolCall.rationale ?? null,
      args: toolCall.args,
    });
    const progressEmitter = startToolProgressEmitter(send, run.id, toolRecord.id, toolCall.tool_name, toolCall.args);

    let result: Record<string, unknown>;
    let status: "completed" | "failed" = "completed";
    try {
      result = await executeTool(deps, toolCall.tool_name, toolCall.args, {
        sessionId: session.id,
        runId: run.id,
      });
      if (toolCall.tool_name === "create_workspace" || toolCall.tool_name === "run_workspace_task") {
        runtimeTasks += 1;
      }
    } catch (error) {
      status = "failed";
      result = {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown tool error",
      };
    } finally {
      progressEmitter.stop();
    }

    await deps.store.finishToolCall(toolRecord.id, status, result);
    await send("tool.completed", {
      runId: run.id,
      toolCallId: toolRecord.id,
      toolName: toolCall.tool_name,
      label: getToolLabel(toolCall.tool_name),
      rationale: toolCall.rationale ?? null,
      status,
      result,
    });
    toolHistory.push({
      toolName: toolCall.tool_name,
      rationale: toolCall.rationale,
      args: toolCall.args,
      result,
    });
    toolResults.push(result);
  }

  const fallback = fallbackFinalAnswer(toolResults);
  await deps.store.updateRun(run.id, {
    status: "timed_out",
    completedAt: new Date().toISOString(),
  });
  await synthesizeAnswer(
    deps,
    {
      sessionId: session.id,
      runId: run.id,
      userMessage: input.message,
      plannerDraft: fallback.answer,
      plannerCitations: fallback.citations as Citation[],
      toolHistory,
    },
    send,
  );
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
    return deps.auth.signIn(c);
  });

  app.get("/auth/sign-up", async (c) => {
    if (!deps.auth?.isConfigured()) {
      return c.json({ error: "Authentication is not configured." }, 501);
    }
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
    const user = await resolveUser(c);
    if ((deps.auth?.isConfigured() ?? false) && (!user || user.id !== session.userId)) {
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
    const user = await resolveUser(c);
    if ((deps.auth?.isConfigured() ?? false) && (!user || user.id !== session.userId)) {
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
    const user = await resolveUser(c);
    if ((deps.auth?.isConfigured() ?? false) && (!user || user.id !== session.userId)) {
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
    const user = await resolveUser(c);
    if ((deps.auth?.isConfigured() ?? false) && (!user || user.id !== session.userId)) {
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
    const user = await resolveUser(c);
    if ((deps.auth?.isConfigured() ?? false) && (!user || user.id !== session.userId)) {
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
    const user = await resolveUser(c);
    if ((deps.auth?.isConfigured() ?? false) && (!user || user.id !== session.userId)) {
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

  app.get("/works", async (c) => {
    const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
    const limit = Math.min(24, Math.max(1, Number.parseInt(c.req.query("limit") ?? "12", 10) || 12));
    const works = await deps.store.listWorks(offset, limit);
    return c.json({
      works,
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
      work,
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

  return app;
}
