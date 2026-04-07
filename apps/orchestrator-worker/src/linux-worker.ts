import process from "node:process";

import PgBoss from "pg-boss";

import { type ResearchTaskQueueMessage } from "./app";
import { createBillingService } from "./billing";
import { buildLinuxAppDeps, loadLinuxEnv } from "./linux-env";
import { runQueuedWorkspaceResearchTask } from "./queued-research";

async function processResearchTaskMessage(
  deps: ReturnType<typeof buildLinuxAppDeps>,
  message: ResearchTaskQueueMessage,
) {
  if (message.type !== "research_task_requested") {
    return;
  }
  const task = await deps.store.getResearchTask(message.taskId);
  if (!task || task.status !== "queued") {
    return;
  }

  const run = await deps.store.getRun(task.runId);
  const session = await deps.store.getSession(task.sessionId);
  if (!run || !session) {
    await deps.store.updateResearchTask(task.id, {
      status: "failed",
      errorJson: { error: "Research task lost its run or session context." },
      completedAt: new Date().toISOString(),
    });
    return;
  }
  const toolCall = (await deps.store.listToolCalls(run.id)).find((candidate) => candidate.id === task.toolCallId) ?? null;
  if (!toolCall) {
    await deps.store.updateResearchTask(task.id, {
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
    await deps.store.appendRunEvent(run.id, session.id, "tool.progress", {
      runId: run.id,
      toolCallId: toolCall.id,
      toolName,
      ...(runtimeId ? { runtimeId } : {}),
      text,
      ...(detail ? { detail } : {}),
    });
    await deps.store.updateResearchTask(task.id, {
      status: "running",
      progressSeq,
      runtimeId: runtimeId ?? task.runtimeId ?? null,
      checkpointJson: detail ?? task.checkpointJson,
      startedAt: task.startedAt ?? new Date().toISOString(),
    });
  };

  try {
    await deps.store.updateResearchTask(task.id, {
      status: "starting",
      startedAt: task.startedAt ?? new Date().toISOString(),
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
      result = await runQueuedWorkspaceResearchTask(deps.runtimeGateway, {
        runtimeId,
        taskSpec,
        sessionId: session.id,
        runId: run.id,
        implementationId: deps.implementation?.id ?? "alphabook",
        progressReporter: async (text: string, detail?: Record<string, unknown>) => {
          await reportProgress("run_workspace_task", text, detail, runtimeId);
        },
      });
    } else {
      if (!deps.semanticSearch) {
        throw new Error("Semantic search is not configured.");
      }
      result = await deps.semanticSearch.search({
        query: typeof task.taskSpecJson.query === "string" ? task.taskSpecJson.query : "",
        workIds: Array.isArray(task.taskSpecJson.workIds)
          ? task.taskSpecJson.workIds.filter((value): value is string => typeof value === "string")
          : undefined,
        maxResults: typeof task.taskSpecJson.maxResults === "number" ? task.taskSpecJson.maxResults : 8,
        backend:
          task.taskSpecJson.backend === "context1" || task.taskSpecJson.backend === "alphaloop"
            ? task.taskSpecJson.backend
            : undefined,
        billingContext: {
          userId: session.userId,
          sessionId: session.id,
          runId: run.id,
          source: "semantic_search",
        },
        onProgress: async (text, detail) => {
          await reportProgress("semantic_deep_search", text, detail);
        },
        auditLog: (event, payload) => {
          void deps.store.appendRunEvent(run.id, session.id, "tool.audit", {
            runId: run.id,
            toolCallId: toolCall.id,
            toolName: "semantic_deep_search",
            text: event,
            detail: {
              type: "semantic.audit",
              event,
              ...payload,
            },
          });
        },
      });
    }

    await deps.store.finishToolCall(toolCall.id, "completed", result);
    await deps.store.updateResearchTask(task.id, {
      status: "succeeded",
      runtimeId: typeof result.runtimeId === "string" ? result.runtimeId : task.runtimeId ?? null,
      resultArtifactKey:
        Array.isArray(result.artifacts)
          ? ((result.artifacts as Array<Record<string, unknown>>).find((artifact) => typeof artifact.r2Key === "string")?.r2Key as string | undefined) ?? null
          : null,
      errorJson: null,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Durable research task failed.";
    await deps.store.finishToolCall(toolCall.id, "failed", {
      ok: false,
      error: messageText,
    });
    await deps.store.updateResearchTask(task.id, {
      status: "failed",
      errorJson: { error: messageText },
      completedAt: new Date().toISOString(),
    });
  }
}

async function runMaintenanceTick(deps: ReturnType<typeof buildLinuxAppDeps>, _boss: PgBoss) {
  await deps.store.refreshExploreFeedSnapshot();
}

const env = await loadLinuxEnv(process.cwd());
if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the Linux worker path.");
}

const boss = new PgBoss(env.DATABASE_URL);
await boss.start();

const deps = buildLinuxAppDeps(env, { boss });
await boss.createQueue(deps.queues.jobsName);

await boss.work<ResearchTaskQueueMessage>(deps.queues.jobsName, async (jobs) => {
  for (const job of jobs) {
    await processResearchTaskMessage(deps, job.data as ResearchTaskQueueMessage);
  }
});

const intervalMs = Math.max(10_000, Number(env.JANITOR_INTERVAL_MS ?? "60000"));
await runMaintenanceTick(deps, boss);
setInterval(() => {
  void runMaintenanceTick(deps, boss).catch((error) => {
    console.error("linux worker maintenance tick failed", error);
  });
}, intervalMs);

console.log(`alphabook linux worker started for queue ${deps.queues.jobsName}`);
