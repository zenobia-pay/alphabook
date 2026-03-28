import test from "node:test";
import assert from "node:assert/strict";

import { runQueuedWorkspaceResearchTask } from "../src/index";

test("queued workspace research dispatches sprite fanout tasks to the sprite runtime lane", async () => {
  const calls: string[] = [];
  const runtimeGateway = {
    async runWorkspaceTask() {
      calls.push("workspace");
      return { ok: true, runtimeId: "workspace-1" };
    },
    async runSpriteFanoutResearch(args: Record<string, unknown>) {
      calls.push("sprite");
      return {
        ok: true,
        runtimeId: typeof args.runtimeId === "string" ? args.runtimeId : "missing",
        briefing: "Sprite aggregate briefing.",
      };
    },
  } as const;

  const result = await runQueuedWorkspaceResearchTask(runtimeGateway as never, {
    runtimeId: "sprite-fanout:run-1",
    taskSpec: {
      mode: "sprite_fanout",
      question: "Compare grief across the corpus.",
      intensity: "maximum",
      workIds: ["work-1", "work-2"],
    },
    sessionId: "session-1",
    runId: "run-1",
    implementationId: "alphabook",
    progressReporter: async () => {},
  });

  assert.deepEqual(calls, ["sprite"]);
  assert.equal((result as Record<string, unknown>).ok, true);
  assert.equal((result as Record<string, unknown>).runtimeId, "sprite-fanout:run-1");
});

test("queued workspace research dispatches non-sprite tasks to the normal runtime lane", async () => {
  const calls: string[] = [];
  const runtimeGateway = {
    async runWorkspaceTask(args: Record<string, unknown>) {
      calls.push("workspace");
      return {
        ok: true,
        runtimeId: typeof args.runtimeId === "string" ? args.runtimeId : "missing",
        briefing: "Workspace briefing.",
      };
    },
  } as const;

  const result = await runQueuedWorkspaceResearchTask(runtimeGateway as never, {
    runtimeId: "runtime-1",
    taskSpec: {
      mode: "collect_and_brief",
      question: "Find passages about revenge.",
    },
    sessionId: "session-1",
    runId: "run-1",
    implementationId: "alphabook",
    progressReporter: async () => {},
  });

  assert.deepEqual(calls, ["workspace"]);
  assert.equal((result as Record<string, unknown>).ok, true);
  assert.equal((result as Record<string, unknown>).runtimeId, "runtime-1");
});
