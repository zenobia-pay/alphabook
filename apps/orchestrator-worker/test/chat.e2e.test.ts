import test from "node:test";
import assert from "node:assert/strict";

import { artifactKeys } from "@alphabook/corpus-core";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";

import { createApp, reapExpiredRuntimeInstances } from "../src/app";
import { WorkOSAuth } from "../src/auth";
import { createBillingService } from "../src/billing";
import { HashEmbedder, OpenAIEmbedder } from "../src/embeddings";
import { MemoryBlobStore } from "../src/r2";
import { FallbackPlanner, ScriptedPlanner } from "../src/planner";
import { ScriptedRouter } from "../src/router";
import { FlyMachinesRuntimeGateway } from "../src/runtime";
import { InMemoryAppStore, NeonAppStore } from "../src/store";
import type { SynthesisInput, SynthesisResult, Synthesizer } from "../src/synthesizer";
import type { PlannerContext } from "../src/planner";
import type { RouterContext } from "../src/router";

class EchoSynthesizer implements Synthesizer {
  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    return {
      answer: input.plannerDraft ?? "No synthesized answer was available.",
      citations: input.plannerCitations,
    };
  }
}

class RuntimeAwareSynthesizer implements Synthesizer {
  lastInput: SynthesisInput | null = null;

  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    this.lastInput = input;
    return {
      answer: `Summary: ${(input.runtimeBriefing ?? "").slice(0, 40)} | ${(input.researchDocument ?? "").slice(0, 80)}`.trim(),
      citations: input.plannerCitations,
    };
  }
}

class NarrowCitationSynthesizer implements Synthesizer {
  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    return {
      answer: input.plannerDraft ?? "Narrow answer",
      citations: input.plannerCitations.slice(0, 1),
    };
  }
}

class CapturingBlobStore extends MemoryBlobStore {
  readonly writes: Array<{ key: string; value: string }> = [];

  override async putText(key: string, value: string): Promise<void> {
    this.writes.push({ key, value });
    await super.putText(key, value);
  }
}

const AUTH_STATE_COOKIE_NAME = "alphabook_auth_state=";

test("orchestrator can answer direct chat without starting the tool chain", async () => {
  const store = new InMemoryAppStore([], []);
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "direct_response",
        answer: "You could ask about themes, moods, exact passages, or comparisons between books.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "planner should not run",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });
  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "11111111-1111-1111-1111-111111111111",
      message: "What kind of things do you think I should look up?",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /event: router\.completed/);
  assert.match(body, /"type":"direct_response"/);
  assert.doesNotMatch(body, /event: planner\.turn/);
  assert.doesNotMatch(body, /event: tool\.started/);
  assert.match(body, /You could ask about themes, moods, exact passages, or comparisons between books\./);
});

test("orchestrator streams retrieval tool calls and final answer", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 996,
        title: "Don Quixote",
        language: "en",
        releaseDate: "2000-01-01",
        rightsStatus: "public_domain",
        summary: "A novel about delusion, grief, and errantry.",
        authors: ["Miguel de Cervantes"],
        subjects: ["fiction", "melancholy"],
        cleanTextKey: "gutenberg/clean/996/clean.txt",
      },
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 12,
        text: "Don Quixote speaks of grief and sadness in terms of knightly suffering.",
        r2Key: "gutenberg/clean/996/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
      {
        id: "chunk-2",
        workId: "work-1",
        chunkIndex: 13,
        text: "Sancho answers with practical remarks about sorrow and endurance.",
        r2Key: "gutenberg/clean/996/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );
  const blobStore = new MemoryBlobStore();
  blobStore.seed("gutenberg/clean/996/clean.txt", "Full clean text for Don Quixote");

  const planner = new ScriptedPlanner([
    {
      type: "tool_call",
      tool_name: "search_works",
      args: {
        query: "books about sadness in fiction",
      },
    },
    {
      type: "tool_call",
      tool_name: "get_relevant_chunks",
      args: {
        query: "sadness and grief",
        workIds: ["work-1"],
      },
    },
    {
      type: "final_answer",
      answer: "Don Quixote is the strongest match, and the retrieved passages directly discuss grief and sadness.",
      citations: [
        {
          workId: "work-1",
          chunkId: "chunk-1",
          label: "Don Quixote#12",
          excerpt: "Don Quixote speaks of grief and sadness in terms of knightly suffering.",
          r2Key: "gutenberg/clean/996/chunks.jsonl",
        },
      ],
    },
  ]);

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "books about sadness in fiction",
      },
    ]),
    planner,
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore,
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    ai: {
      async run<ModelInput extends Record<string, unknown>, ModelOutput = unknown>(): Promise<ModelOutput> {
        return { response: "Grief in Fiction" } as ModelOutput;
      },
    },
    x402: {
      enabled: true,
      payTo: "0x1234",
      network: "eip155:8453",
      asset: "USDC",
      maxAmountUsd: "5.00",
      description: "AlphaBook research access",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "11111111-1111-1111-1111-111111111111",
      message: "Find me books about sadness",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /event: session\.created/);
  assert.match(body, /event: router\.completed/);
  assert.match(body, /books about sadness in fiction/);
  assert.match(body, /event: assistant\.plan/);
  assert.match(body, /event: tool\.started/);
  assert.match(body, /event: tool\.completed/);
  assert.match(body, /event: assistant\.completed/);
  assert.match(body, /Don Quixote is the strongest match/);

  const analyticsEvents = await store.listAnalyticsEvents({ limit: 50 });
  const passageCited = analyticsEvents.find((event) => event.event === "passage_cited");
  assert.ok(passageCited);
  assert.equal(passageCited.properties.workId, "work-1");
  assert.equal(passageCited.properties.chunkId, "chunk-1");
  assert.equal(passageCited.properties.label, "Don Quixote#12");

  const sessions = await store.listSessions("11111111-1111-1111-1111-111111111111");
  const sessionId = sessions[0]?.id;
  assert.ok(sessionId);
  const runs = await store.listRuns(sessionId!);
  const runId = runs[0]?.id;
  assert.ok(runId);
  const logsResponse = await app.request(`/sessions/${sessionId}/runs/${runId}/logs`);
  assert.equal(logsResponse.status, 200);
  const logsPayload = (await logsResponse.json()) as {
    rawLog: Array<{ event?: string }>;
  };
  const rawEvents = logsPayload.rawLog.map((entry) => entry.event);
  assert.ok(rawEvents.includes("internal.session_title.started"));
  assert.ok(rawEvents.includes("internal.session_title.completed"));
  assert.ok(rawEvents.includes("router.started"));
  assert.ok(rawEvents.includes("router.completed"));
  assert.ok(rawEvents.includes("planner.started"));
  assert.ok(rawEvents.includes("planner.completed"));
  assert.ok(rawEvents.includes("internal.embedding.started"));
  assert.ok(rawEvents.includes("internal.embedding.completed"));
  assert.ok(rawEvents.includes("internal.synthesis.started"));
  assert.ok(rawEvents.includes("internal.synthesis.completed"));
  assert.ok(rawEvents.includes("run.metrics"));

  const runDetailsResponse = await app.request(`/sessions/${sessionId}/runs/${runId}`);
  assert.equal(runDetailsResponse.status, 200);
  const runDetailsPayload = (await runDetailsResponse.json()) as {
    metrics?: Record<string, unknown>;
  };
  assert.equal(runDetailsPayload.metrics?.totalBooksMentioned, 1);
  assert.equal(runDetailsPayload.metrics?.totalCandidateBooks, 1);
  assert.equal(runDetailsPayload.metrics?.totalPassagesMentioned, 2);
  assert.equal(runDetailsPayload.metrics?.totalActiveBooksInFinalAnswer, 1);
  assert.equal(typeof runDetailsPayload.metrics?.timeToCompletionMs, "number");
});

test("session titles are generated by Workers AI instead of truncating the first message", async () => {
  const store = new InMemoryAppStore();
  let prompt = "";
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "direct_response",
        answer: "ok",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "unused",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    ai: {
      async run<ModelInput extends Record<string, unknown>, ModelOutput = unknown>(_model: string, input: ModelInput): Promise<ModelOutput> {
        const record = input as unknown as { messages?: Array<{ content?: string }> };
        prompt = Array.isArray(record.messages) ? record.messages.map((message) => message.content ?? "").join("\n") : "";
        return {
          response: "Grief and Mourning in Fiction",
        } as ModelOutput;
      },
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "title-user",
      message: "Find me all the ways that characters deal with grief in 19th century fiction.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();
  const sessions = await store.listSessions("title-user");
  assert.equal(sessions[0]?.title, "Grief and Mourning in Fiction");
  assert.match(prompt, /Do not simply repeat the opening words of the message/);
});

test("session is created and streamed before title generation finishes", async () => {
  const store = new InMemoryAppStore();
  let releaseTitle: (() => void) | undefined;
  const titleGate = new Promise<void>((resolve) => {
    releaseTitle = resolve;
  });
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "direct_response",
        answer: "ok",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "unused",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    ai: {
      async run<ModelInput extends Record<string, unknown>, ModelOutput = unknown>(): Promise<ModelOutput> {
        await titleGate;
        return {
          response: "Mourning in Fiction",
        } as ModelOutput;
      },
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "early-session-user",
      message: "Find grief in fiction.",
    }),
  });

  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  const firstChunkPromise = reader.read().then(({ value }) => new TextDecoder().decode(value ?? new Uint8Array()));
  const firstChunk = await Promise.race([
    firstChunkPromise,
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for first chunk")), 100)),
  ]);
  assert.match(firstChunk, /event: session\.created/);

  releaseTitle?.();
  await reader.cancel();
});

test("session titles accept chat-completions style Workers AI payloads", async () => {
  const store = new InMemoryAppStore();
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "direct_response",
        answer: "ok",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "unused",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    ai: {
      async run<ModelInput extends Record<string, unknown>, ModelOutput = unknown>(): Promise<ModelOutput> {
        return {
          choices: [
            {
              message: {
                content: "Victorian Grief Patterns",
              },
            },
          ],
        } as ModelOutput;
      },
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "title-user-choices",
      message: "Find me all the ways that characters deal with grief in 19th century fiction.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();
  const sessions = await store.listSessions("title-user-choices");
  assert.equal(sessions[0]?.title, "Victorian Grief Patterns");
});

test("session titles accept nested Workers AI result payloads", async () => {
  const store = new InMemoryAppStore();
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "direct_response",
        answer: "ok",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "unused",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    ai: {
      async run<ModelInput extends Record<string, unknown>, ModelOutput = unknown>(): Promise<ModelOutput> {
        return {
          result: {
            choices: [
              {
                message: {
                  content: "Mourning in Victorian Fiction",
                },
              },
            ],
          },
        } as ModelOutput;
      },
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "title-user-nested",
      message: "Find me all the ways that characters deal with grief in 19th century fiction.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();
  const sessions = await store.listSessions("title-user-nested");
  assert.equal(sessions[0]?.title, "Mourning in Victorian Fiction");
});

test("background deep research starts before retrieval has finished", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 996,
        title: "Don Quixote",
        language: "en",
        releaseDate: "2000-01-01",
        rightsStatus: "public_domain",
        summary: "A novel about grief.",
        authors: ["Miguel de Cervantes"],
        subjects: ["fiction", "grief"],
      },
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 12,
        text: "Don Quixote speaks about grief and sorrow.",
        r2Key: "gutenberg/clean/996/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );
  const calls: string[] = [];
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "Find grief passages in fiction",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "search_works",
        args: {
          query: "Find grief passages in fiction",
        },
      },
      {
        type: "tool_call",
        tool_name: "get_relevant_chunks",
        args: {
          query: "Find grief passages in fiction",
          workIds: ["work-1"],
        },
      },
      {
        type: "final_answer",
        answer: "Done.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        calls.push("create_workspace");
        return { ok: true, runtimeId: "runtime-1" };
      },
      async runWorkspaceTask(args) {
        calls.push(`run_workspace_task:${typeof args.runtimeId === "string" ? args.runtimeId : "missing"}`);
        return { ok: true, runtimeId: "runtime-1", briefing: "Background briefing.", citations: [] };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    ai: {
      async run<ModelInput extends Record<string, unknown>, ModelOutput = unknown>(): Promise<ModelOutput> {
        return { response: "Grief in Fiction" } as ModelOutput;
      },
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "parallel-user",
      message: "Find grief passages in fiction",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();
  const backgroundIndex = calls.findIndex((entry) => entry.startsWith("run_workspace_task:runtime-1"));
  assert.notEqual(backgroundIndex, -1);
  const createIndex = calls.indexOf("create_workspace");
  assert.notEqual(createIndex, -1);
  assert.ok(backgroundIndex > createIndex);

  const runs = await store.listRuns((await store.listSessions("parallel-user"))[0]!.id);
  const toolCalls = await store.listToolCalls(runs[0]!.id);
  const runTaskIndex = toolCalls.findIndex((entry) => entry.toolName === "run_workspace_task");
  const chunkIndex = toolCalls.findIndex((entry) => entry.toolName === "get_relevant_chunks");
  assert.notEqual(runTaskIndex, -1);
  assert.notEqual(chunkIndex, -1);
  assert.ok(runTaskIndex < chunkIndex);
});

test("follow-up requests pass full chat history into router and planner", async () => {
  const store = new InMemoryAppStore([
    {
      id: "work-1",
      gutenbergId: 996,
      title: "Don Quixote",
      language: "en",
      releaseDate: "2000-01-01",
      rightsStatus: "public_domain",
      summary: "A novel about delusion, grief, and errantry.",
      authors: ["Miguel de Cervantes"],
      subjects: ["fiction", "melancholy"],
      cleanTextKey: "gutenberg/clean/996/clean.txt",
    },
  ], []);
  const session = await store.createSession("11111111-1111-1111-1111-111111111111", "Follow-up thread");
  await store.appendMessage(session.id, "user", "Show me books about grief.");
  await store.appendMessage(session.id, "assistant", "Don Quixote and Moby-Dick are strong matches.");

  const router = {
    async decide(context: RouterContext) {
      assert.equal(context.userMessage, "What about the second one?");
      assert.deepEqual(
        context.conversationHistory.map((message) => [message.role, message.content]),
        [
          ["user", "Show me books about grief."],
          ["assistant", "Don Quixote and Moby-Dick are strong matches."],
          ["user", "What about the second one?"],
        ],
      );
      return {
        type: "tool_chain" as const,
        fullQuery: "Tell me more about Moby-Dick as a grief novel.",
      };
    },
  };

  const planner = {
    async decide(context: PlannerContext) {
      assert.equal(context.userMessage, "Tell me more about Moby-Dick as a grief novel.");
      assert.deepEqual(
        context.conversationHistory.map((message) => [message.role, message.content]),
        [
          ["user", "Show me books about grief."],
          ["assistant", "Don Quixote and Moby-Dick are strong matches."],
          ["user", "What about the second one?"],
        ],
      );
      return {
        type: "final_answer" as const,
        answer: "The follow-up saw the full thread.",
        citations: [],
      };
    },
  };

  const app = createApp({
    store,
    billing: createBillingService(store),
    router,
    planner,
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    x402: {
      enabled: true,
      payTo: "0x1234",
      network: "base",
      asset: "USDC",
      maxAmountUsd: "5.00",
      description: "AlphaBook research access",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId: session.id,
      userId: "11111111-1111-1111-1111-111111111111",
      message: "What about the second one?",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /The follow-up saw the full thread\./);
});

test("disconnecting the chat stream does not fail the underlying run", async () => {
  const store = new InMemoryAppStore([], []);
  const planner = new ScriptedPlanner([
    {
      type: "tool_call",
      tool_name: "search_works",
      args: {
        query: "builders introspection",
      },
    },
    {
      type: "final_answer",
      answer: "The run finished after the client disconnected.",
      citations: [],
    },
  ]);

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "builders introspection",
      },
    ]),
    planner,
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "disconnect-user",
      message: "Find me builders being introspective",
    }),
  });

  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  await reader.read();
  await reader.cancel();

  await new Promise((resolve) => setTimeout(resolve, 25));

  const sessions = await store.listSessions("disconnect-user");
  assert.equal(sessions.length, 1);
  const runs = await store.listRuns(sessions[0]!.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, "completed");

  const messages = await store.listMessages(sessions[0]!.id);
  const errorMessage = messages.find((message) => (
    message.role === "assistant"
    && message.metadata?.phase === "error"
    && message.metadata?.runId === runs[0]!.id
  ));
  assert.equal(errorMessage, undefined);
});


test("orchestrator can delegate to a runtime gateway and finish the run", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 996,
        title: "Don Quixote",
        language: "en",
        releaseDate: "2000-01-01",
        rightsStatus: "public_domain",
        summary: "A novel about delusion, grief, and errantry.",
        authors: ["Miguel de Cervantes"],
        subjects: ["fiction", "melancholy"],
        cleanTextKey: "gutenberg/clean/996/clean.txt",
      },
      {
        id: "work-2",
        gutenbergId: 1400,
        title: "Great Expectations",
        language: "en",
        releaseDate: "2001-01-01",
        rightsStatus: "public_domain",
        summary: "A novel about ambition and disappointment.",
        authors: ["Charles Dickens"],
        subjects: ["fiction", "class"],
        cleanTextKey: "gutenberg/clean/1400/clean.txt",
      },
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 7,
        text: "Don Quixote frames grief as a kind of honorable endurance.",
        r2Key: "gutenberg/clean/996/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
      {
        id: "chunk-2",
        workId: "work-2",
        chunkIndex: 11,
        text: "Great Expectations turns ambition into a quieter sorrow and inward strain.",
        r2Key: "gutenberg/clean/1400/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );
  const planner = new ScriptedPlanner([
    {
      type: "tool_call",
      tool_name: "search_works",
      args: {
        query: "compare grief and ambition",
      },
    },
    {
      type: "tool_call",
      tool_name: "create_workspace",
      args: {
        workIds: ["work-1", "work-2"],
        chunkIds: [],
        taskContext: {
          question: "Compare how the two novels talk about inner struggle.",
        },
      },
    },
    {
      type: "tool_call",
      tool_name: "run_workspace_task",
      args: {
        runtimeId: "runtime-1",
        taskSpec: {
          kind: "compare",
          output: "summary.md",
        },
      },
    },
    {
      type: "final_answer",
      answer: "The workspace comparison completed and produced a summary artifact.",
      citations: [
        {
          workId: "work-1",
          label: "summary.md",
          excerpt: "Comparison stored in runtime output.",
        },
      ],
    },
  ]);

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner,
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace(args) {
        return {
          ok: true,
          runtimeId: "runtime-1",
          manifest: args,
        };
      },
      async runWorkspaceTask() {
        return {
          ok: true,
          runtimeId: "runtime-1",
          stdout: "completed",
          stderr: "",
          exitCode: 0,
          artifacts: [
            {
              filename: "summary.md",
              path: "/workspace/output/summary.md",
              mimeType: "text/markdown",
            },
          ],
        };
      },
      async readWorkspaceFile() {
        return {
          ok: true,
          path: "/workspace/output/summary.md",
          content: "# Summary",
        };
      },
      async listWorkspaceFiles() {
        return {
          ok: true,
          files: ["output/summary.md"],
        };
      },
      async destroyWorkspace() {
        return {
          ok: true,
        };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    x402: {
      enabled: true,
      payTo: "0x1234",
      network: "base",
      asset: "USDC",
      maxAmountUsd: "5.00",
      description: "AlphaBook research access",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "11111111-1111-1111-1111-111111111111",
      message: "Compare how these novels handle inner struggle.",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /event: tool\.started/);
  assert.match(body, /create_workspace/);
  assert.match(body, /run_workspace_task/);
  assert.match(body, /workspace comparison completed/);
});

test("orchestrator prewarms the deep research workspace before the first planner turn", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 996,
        title: "Don Quixote",
        language: "en",
        releaseDate: "2000-01-01",
        rightsStatus: "public_domain",
        summary: "A novel about grief and errantry.",
        authors: ["Miguel de Cervantes"],
        subjects: ["fiction"],
        cleanTextKey: "gutenberg/clean/996/clean.txt",
      },
    ],
    [],
  );

  let createWorkspaceCalls = 0;
  let plannerSawPendingWorkspace = false;

  const planner = {
    async decide(context: PlannerContext) {
      assert.equal(createWorkspaceCalls, 1);
      if (context.turns === 1) {
        assert.ok((context.pendingTools ?? []).some((entry) => entry.toolName === "create_workspace"));
        plannerSawPendingWorkspace = true;
        return {
          type: "tool_call" as const,
          tool_name: "search_works" as const,
          args: {
            query: context.userMessage,
            filters: {
              limit: 5,
            },
          },
          rationale: "Searching while the workspace boots.",
        };
      }
      return {
        type: "final_answer" as const,
        answer: "The workspace was already spinning up while I searched.",
        citations: [],
      };
    },
  };

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner,
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace(args) {
        createWorkspaceCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          ok: true,
          runtimeId: "runtime-prewarm",
          manifest: args,
        };
      },
      async runWorkspaceTask() {
        return {
          ok: true,
          runtimeId: "runtime-prewarm",
        };
      },
      async readWorkspaceFile() {
        return {
          ok: false,
          error: "not used",
        };
      },
      async listWorkspaceFiles() {
        return {
          ok: true,
          files: [],
        };
      },
      async destroyWorkspace() {
        return {
          ok: true,
        };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "11111111-1111-1111-1111-111111111111",
      message: "Find grief across the corpus.",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(createWorkspaceCalls, 1);
  assert.equal(plannerSawPendingWorkspace, true);
  assert.match(body, /spinning up the deeper research/i);
  assert.match(body, /Searching while the .* boots\./);
});

test("orchestrator keeps planning retrieval while background workspace startup is still pending", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 996,
        title: "Don Quixote",
        language: "en",
        releaseDate: "2000-01-01",
        rightsStatus: "public_domain",
        summary: "A novel about grief and errantry.",
        authors: ["Miguel de Cervantes"],
        subjects: ["fiction"],
        cleanTextKey: "gutenberg/clean/996/clean.txt",
      },
    ],
    [],
  );

  let createWorkspaceCalls = 0;
  let plannerTurnCount = 0;
  let releaseWorkspace!: () => void;
  const workspaceReady = new Promise<void>((resolve) => {
    releaseWorkspace = resolve;
  });

  const planner = {
    async decide(context: PlannerContext) {
      plannerTurnCount += 1;
      if (context.turns === 1) {
        return {
          type: "tool_call" as const,
          tool_name: "search_works" as const,
          args: {
            query: context.userMessage,
            filters: {
              limit: 5,
            },
          },
          rationale: "Searching while the workspace boots.",
        };
      }
      return {
        type: "final_answer" as const,
        answer: "Done.",
        citations: [],
      };
    },
  };

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner,
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        createWorkspaceCalls += 1;
        await workspaceReady;
        return {
          ok: true,
          runtimeId: "runtime-prewarm",
        };
      },
      async runWorkspaceTask() {
        return {
          ok: true,
          runtimeId: "runtime-prewarm",
          answer: "workspace complete",
          artifacts: [],
        };
      },
      async readWorkspaceFile() {
        return {
          ok: false,
          error: "not used",
        };
      },
      async listWorkspaceFiles() {
        return {
          ok: true,
          files: [],
        };
      },
      async destroyWorkspace() {
        return {
          ok: true,
        };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const responsePromise = app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "11111111-1111-1111-1111-111111111111",
      message: "Find grief across the corpus.",
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseWorkspace();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(createWorkspaceCalls, 1);
  assert.equal(plannerTurnCount, 2);

  const sessions = await store.listSessions("11111111-1111-1111-1111-111111111111");
  const sessionId = sessions[0]?.id;
  assert.ok(sessionId);
  const runs = await store.listRuns(sessionId!);
  const runId = runs[0]?.id;
  assert.ok(runId);
  const logsResponse = await app.request(`/sessions/${sessionId}/runs/${runId}/logs`);
  assert.equal(logsResponse.status, 200);
  const logsPayload = (await logsResponse.json()) as {
    rawLog: Array<{ event?: string }>;
  };
  const rawEvents = logsPayload.rawLog.map((entry) => entry.event);
  assert.ok(!rawEvents.includes("planner.deferred_for_pending_workspace"));
});

test("orchestrator starts the deep research run as soon as the workspace becomes ready", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 996,
        title: "Don Quixote",
        language: "en",
        releaseDate: "2000-01-01",
        rightsStatus: "public_domain",
        summary: "A novel about grief and errantry.",
        authors: ["Miguel de Cervantes"],
        subjects: ["fiction"],
        cleanTextKey: "gutenberg/clean/996/clean.txt",
      },
    ],
    [],
  );

  let plannerSawPendingRuntimeTask = false;

  const planner = {
    async decide(context: PlannerContext) {
      if (context.turns === 1) {
        return {
          type: "tool_call" as const,
          tool_name: "search_works" as const,
          args: {
            query: context.userMessage,
            filters: {
              limit: 5,
            },
          },
          rationale: "Searching while the workspace boots.",
        };
      }
      plannerSawPendingRuntimeTask = (context.pendingTools ?? []).some((entry) => entry.toolName === "run_workspace_task");
      if (!plannerSawPendingRuntimeTask && context.turns < 3) {
        return {
          type: "tool_call" as const,
          tool_name: "search_works" as const,
          args: {
            query: context.userMessage,
            filters: {
              limit: 5,
            },
          },
          rationale: "Keep retrieval moving while the workspace becomes ready.",
        };
      }
      return {
        type: "final_answer" as const,
        answer: "Done.",
        citations: [],
      };
    },
  };

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner,
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          ok: true,
          runtimeId: "runtime-prewarm",
        };
      },
      async runWorkspaceTask() {
        return {
          ok: true,
          runtimeId: "runtime-prewarm",
          answer: "workspace complete",
          artifacts: [],
        };
      },
      async readWorkspaceFile() {
        return {
          ok: false,
          error: "not used",
        };
      },
      async listWorkspaceFiles() {
        return {
          ok: true,
          files: [],
        };
      },
      async destroyWorkspace() {
        return {
          ok: true,
        };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "11111111-1111-1111-1111-111111111111",
      message: "Find grief across the corpus.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();

  const sessions = await store.listSessions("11111111-1111-1111-1111-111111111111");
  const sessionId = sessions[0]?.id;
  assert.ok(sessionId);
  const runs = await store.listRuns(sessionId!);
  const runId = runs[0]?.id;
  assert.ok(runId);
  const logsResponse = await app.request(`/sessions/${sessionId}/runs/${runId}/logs`);
  assert.equal(logsResponse.status, 200);
  const logsPayload = (await logsResponse.json()) as {
    rawLog: Array<{ event?: string; payload?: Record<string, unknown> }>;
  };
  const startedRuntimeTask = logsPayload.rawLog.some((entry) =>
    entry.event === "tool.started.raw" && entry.payload?.toolName === "run_workspace_task"
  );
  assert.equal(startedRuntimeTask || plannerSawPendingRuntimeTask, true);
});

test("auth sign-up route redirects into WorkOS authkit with sign-up hint", async () => {
  const store = new InMemoryAppStore();
  const auth = new WorkOSAuth(
    {
      workosApiKey: "test_api_key",
      workosClientId: "client_123",
      cookiePassword: "test_cookie_password_32_chars_minimum",
    },
    store,
  );

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new FallbackPlanner(),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    auth,
  });

  const response = await app.request("/auth/sign-up?returnTo=https%3A%2F%2Falpha-book.org", {
    headers: {
      host: "api.alpha-book.org",
      "x-forwarded-proto": "https",
    },
  });

  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  assert.match(location, /^https:\/\/api\.workos\.com\/user_management\/authorize\?/);
  assert.match(location, /screen_hint=sign-up/);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie, new RegExp(AUTH_STATE_COOKIE_NAME));
});

test("analytics endpoint stores posted events", async () => {
  const blobStore = new CapturingBlobStore();
  const store = new InMemoryAppStore();
  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "ok",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore,
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false };
      },
      async runWorkspaceTask() {
        return { ok: false };
      },
      async readWorkspaceFile() {
        return { ok: false };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    x402: {
      enabled: true,
      payTo: "0x1234",
      network: "base",
      asset: "USDC",
      maxAmountUsd: "5.00",
      description: "AlphaBook research access",
    },
  });

  const response = await app.request("/a?userId=guest-user", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      event: "book_open",
      userId: "guest-user",
      properties: {
        workId: "work-1",
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(blobStore.writes.length, 1);
  assert.match(blobStore.writes[0]?.key ?? "", /^analytics\//);
  assert.match(blobStore.writes[0]?.value ?? "", /"event": "book_open"/);
});

test("auth sign-in route forces interactive WorkOS auth", async () => {
  const store = new InMemoryAppStore();
  const auth = new WorkOSAuth(
    {
      workosApiKey: "test_api_key",
      workosClientId: "client_123",
      cookiePassword: "test_cookie_password_32_chars_minimum",
    },
    store,
  );

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new FallbackPlanner(),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    auth,
  });

  const response = await app.request(
    "/auth/sign-in?returnTo=https%3A%2F%2Falpha-book.org",
    {
      headers: {
        host: "api.alpha-book.org",
        "x-forwarded-proto": "https",
      },
    },
  );

  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  assert.match(location, /^https:\/\/api\.workos\.com\/user_management\/authorize\?/);
  assert.match(location, /prompt=login/);
});

test("auth callback preserves the new session cookie while clearing the pending auth state", async () => {
  const store = new InMemoryAppStore();
  const auth = new WorkOSAuth(
    {
      workosApiKey: "test_api_key",
      workosClientId: "client_123",
      cookiePassword: "test_cookie_password_32_chars_minimum",
    },
    store,
  );

  const authInternals = auth as unknown as {
    workos: {
      userManagement: {
        authenticateWithCode(args: {
          clientId: string;
          code: string;
          codeVerifier: string;
          session: {
            sealSession: boolean;
            cookiePassword: string;
          };
        }): Promise<{
          sealedSession?: string;
          user: {
            id: string;
            email?: string | null;
            firstName?: string | null;
            lastName?: string | null;
            profilePictureUrl?: string | null;
          };
        }>;
      };
    };
  };

  authInternals.workos.userManagement.authenticateWithCode = async ({ clientId, code, codeVerifier, session }) => {
    assert.equal(clientId, "client_123");
    assert.equal(code, "auth-code");
    assert.equal(codeVerifier, "code-verifier");
    assert.equal(session.sealSession, true);
    assert.equal(session.cookiePassword, "test_cookie_password_32_chars_minimum");
    return {
      sealedSession: "sealed-session",
      user: {
        id: "user_123",
        email: "reader@example.com",
        firstName: "Reader",
        lastName: "Example",
      },
    };
  };

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new FallbackPlanner(),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    auth,
  });

  const pendingState = Buffer.from(JSON.stringify({
    state: "expected-state",
    codeVerifier: "code-verifier",
    returnTo: "https://alpha-book.org",
  })).toString("base64");

  const response = await app.request(
    "/auth/callback?code=auth-code&state=expected-state",
    {
      headers: {
        cookie: `alphabook_auth_state=${pendingState}`,
        host: "api.alpha-book.org",
        "x-forwarded-proto": "https",
      },
    },
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://alpha-book.org/");

  const setCookies = response.headers.getSetCookie();
  assert.ok(setCookies.some((value) => value.startsWith("alphabook_session=sealed-session")));
  assert.ok(setCookies.some((value) => value.startsWith("alphabook_auth_state=")));
  assert.ok(!setCookies.some((value) => value.startsWith("alphabook_session=;")));

  const profile = await store.getUserProfile("user_123");
  assert.ok(profile);
  assert.equal(profile.email, "reader@example.com");
});

test("agent API keys can register and use CLI chat even when browser auth is enabled", async () => {
  const store = new InMemoryAppStore([], []);
  const auth = new WorkOSAuth(
    {
      workosApiKey: "test-key",
      workosClientId: "client_123",
      cookiePassword: "super-secret-password",
    },
    store,
  );
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "direct_response",
        answer: "CLI access is ready.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "planner should not run",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    auth,
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    x402: {
      enabled: true,
      payTo: "0x1234",
      network: "base",
      asset: "USDC",
      maxAmountUsd: "5.00",
      description: "AlphaBook research access",
    },
  });

  const registrationResponse = await app.request("/api/v1/agents/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Codex",
      description: "AlphaBook CLI researcher",
    }),
  });
  assert.equal(registrationResponse.status, 201);
  const registrationPayload = await registrationResponse.json() as {
    api_key: string;
    claim_url: string;
    status: string;
  };
  assert.match(registrationPayload.api_key, /^abk_/);
  assert.match(registrationPayload.claim_url, /\/claim\/abclaim_/);
  assert.equal(registrationPayload.status, "pending_claim");

  const meResponse = await app.request("/api/v1/agents/me", {
    headers: {
      authorization: `Bearer ${registrationPayload.api_key}`,
    },
  });
  assert.equal(meResponse.status, 200);

  const chatResponse = await app.request("/api/v1/chat", {
    method: "POST",
    headers: {
      authorization: `Bearer ${registrationPayload.api_key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: "Can I use AlphaBook entirely from the CLI?",
    }),
  });
  assert.equal(chatResponse.status, 200);
  const chatBody = await chatResponse.text();
  assert.match(chatBody, /CLI access is ready\./);
  const sessionMatch = chatBody.match(/"sessionId":"([^"]+)"/);
  const runMatch = chatBody.match(/"runId":"([^"]+)"/);
  assert.ok(sessionMatch?.[1]);
  assert.ok(runMatch?.[1]);

  const sessionsResponse = await app.request("/api/v1/sessions", {
    headers: {
      authorization: `Bearer ${registrationPayload.api_key}`,
    },
  });
  assert.equal(sessionsResponse.status, 200);

  const runsResponse = await app.request(`/api/v1/sessions/${sessionMatch?.[1]}/runs`, {
    headers: {
      authorization: `Bearer ${registrationPayload.api_key}`,
    },
  });
  assert.equal(runsResponse.status, 200);

  const runStateResponse = await app.request(`/api/v1/sessions/${sessionMatch?.[1]}/runs/${runMatch?.[1]}`, {
    headers: {
      authorization: `Bearer ${registrationPayload.api_key}`,
    },
  });
  assert.equal(runStateResponse.status, 200);
  const runState = await runStateResponse.json() as { run?: { status?: string } };
  assert.equal(runState.run?.status, "completed");

  const logsResponse = await app.request(`/api/v1/sessions/${sessionMatch?.[1]}/runs/${runMatch?.[1]}/logs`, {
    headers: {
      authorization: `Bearer ${registrationPayload.api_key}`,
    },
  });
  assert.equal(logsResponse.status, 200);
});

test("auth sign-out route clears local cookies and returns the WorkOS logout redirect when session exists", async () => {
  const store = new InMemoryAppStore();
  const auth = new WorkOSAuth(
    {
      workosApiKey: "test_api_key",
      workosClientId: "client_123",
      cookiePassword: "test_cookie_password_32_chars_minimum",
    },
    store,
  );

  const authInternals = auth as unknown as {
    workos: {
      userManagement: {
        getSessionFromCookie(args: { sessionData: string; cookiePassword: string }): Promise<{
          sessionId?: string;
          session?: { id?: string };
        }>;
        getLogoutUrl(args: { sessionId: string; returnTo?: string }): string;
      };
    };
  };

  authInternals.workos.userManagement.getSessionFromCookie = async ({ sessionData, cookiePassword }) => {
    assert.equal(sessionData, "sealed-session");
    assert.equal(cookiePassword, "test_cookie_password_32_chars_minimum");
    return {
      session: {
        id: "session_123",
      },
    };
  };
  authInternals.workos.userManagement.getLogoutUrl = ({ sessionId, returnTo }) => {
    assert.equal(sessionId, "session_123");
    assert.equal(returnTo, "https://alpha-book.org/signed-out");
    return "https://api.workos.com/user_management/sessions/logout?session_id=session_123";
  };

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new FallbackPlanner(),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    auth,
  });

  const response = await app.request(
    "/auth/sign-out?returnTo=https%3A%2F%2Falpha-book.org%2Fsigned-out",
    {
      method: "POST",
      headers: {
        cookie: "alphabook_session=sealed-session",
        host: "api.alpha-book.org",
        "x-forwarded-proto": "https",
        origin: "https://alpha-book.org",
      },
    },
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { redirectTo: string };
  assert.equal(payload.redirectTo, "https://api.workos.com/user_management/sessions/logout?session_id=session_123");
  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.length, 2);
  assert.ok(setCookies.some((value) => value.startsWith("alphabook_session=")));
  assert.ok(setCookies.some((value) => value.startsWith("alphabook_auth_state=")));
});

test("auth sign-out GET route redirects the browser through WorkOS logout", async () => {
  const store = new InMemoryAppStore();
  const auth = new WorkOSAuth(
    {
      workosApiKey: "test_api_key",
      workosClientId: "client_123",
      cookiePassword: "test_cookie_password_32_chars_minimum",
    },
    store,
  );

  const authInternals = auth as unknown as {
    workos: {
      userManagement: {
        getSessionFromCookie(args: { sessionData: string; cookiePassword: string }): Promise<{
          sessionId?: string;
          session?: { id?: string };
        }>;
        getLogoutUrl(args: { sessionId: string; returnTo?: string }): string;
      };
    };
  };

  authInternals.workos.userManagement.getSessionFromCookie = async () => ({
    session: {
      id: "session_123",
    },
  });
  authInternals.workos.userManagement.getLogoutUrl = ({ sessionId, returnTo }) => {
    assert.equal(sessionId, "session_123");
    assert.equal(returnTo, "https://alpha-book.org/signed-out");
    return "https://api.workos.com/user_management/sessions/logout?session_id=session_123";
  };

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new FallbackPlanner(),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    auth,
  });

  const response = await app.request(
    "/auth/sign-out?returnTo=https%3A%2F%2Falpha-book.org%2Fsigned-out",
    {
      headers: {
        cookie: "alphabook_session=sealed-session",
        host: "api.alpha-book.org",
        "x-forwarded-proto": "https",
      },
    },
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://api.workos.com/user_management/sessions/logout?session_id=session_123");
  const setCookies = response.headers.getSetCookie();
  assert.ok(setCookies.some((value) => value.startsWith("alphabook_session=")));
  assert.ok(setCookies.some((value) => value.startsWith("alphabook_auth_state=")));
});

test("chat route rejects writing to another user's existing session", async () => {
  const store = new InMemoryAppStore();
  const session = await store.createSession("owner-user", "Private session");

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "ok",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false };
      },
      async runWorkspaceTask() {
        return { ok: false };
      },
      async readWorkspaceFile() {
        return { ok: false };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    x402: {
      enabled: true,
      payTo: "0x1234",
      network: "base",
      asset: "USDC",
      maxAmountUsd: "5.00",
      description: "AlphaBook research access",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "attacker-user",
      sessionId: session.id,
      message: "append to someone else's chat",
    }),
  });

  assert.equal(response.status, 403);
  const payload = (await response.json()) as { error: string };
  assert.equal(payload.error, "Not authorized for this session.");
});

test("quota failures surface a clear user-facing assistant message", async () => {
  const store = new InMemoryAppStore();
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: {
      async decide() {
        throw new Error('Router request failed: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}');
      },
    },
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "unreachable",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false };
      },
      async runWorkspaceTask() {
        return { ok: false };
      },
      async readWorkspaceFile() {
        return { ok: false };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "11111111-1111-1111-1111-111111111111",
      message: "Find me books about grief",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /The assistant is temporarily unavailable because our AI provider quota was exceeded\./);
});

test("claimed agent owners can read sessions created by their agent identity", async () => {
  const store = new InMemoryAppStore();
  const owner = await store.upsertUserProfile({
    id: "owner-user",
    email: "owner@example.com",
    name: "Owner User",
  });
  const agent = await store.createAgentIdentity({
    name: "Owner Agent",
    description: "Claimed assistant",
    ownerUserId: owner.id,
    apiKeyPrefix: "abk_owneragent",
    apiKeyHash: "hash-owneragent",
    verificationCode: "folio-ABCD",
    claimToken: "abclaim_owneragent",
    metadata: {},
  });
  const session = await store.createSession(agent.userId, "Agent-owned session");
  await store.appendMessage(session.id, "assistant", "Saved by the agent.");

  const auth = new WorkOSAuth(
    {
      workosApiKey: "test_api_key",
      workosClientId: "client_123",
      cookiePassword: "test_cookie_password_32_chars_minimum",
    },
    store,
  );

  const authInternals = auth as unknown as {
    workos: {
      userManagement: {
        getSessionFromCookie(args: { sessionData: string; cookiePassword: string }): Promise<{
          user?: {
            id?: string;
            email?: string | null;
            firstName?: string | null;
            lastName?: string | null;
            profilePictureUrl?: string | null;
          };
        }>;
      };
    };
  };

  authInternals.workos.userManagement.getSessionFromCookie = async ({ sessionData, cookiePassword }) => {
    assert.equal(sessionData, "sealed-session");
    assert.equal(cookiePassword, "test_cookie_password_32_chars_minimum");
    return {
      user: {
        id: owner.id,
        email: owner.email,
        firstName: "Owner",
        lastName: "User",
        profilePictureUrl: null,
      },
    };
  };

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "ok",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false };
      },
      async runWorkspaceTask() {
        return { ok: false };
      },
      async readWorkspaceFile() {
        return { ok: false };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    auth,
  });

  const response = await app.request(`/sessions/${session.id}/messages`, {
    headers: {
      cookie: "alphabook_session=sealed-session",
    },
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { messages: Array<{ content: string }> };
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0]?.content, "Saved by the agent.");
});

test("fallback planner can create a Fly workspace, run a task, read the briefing, and answer", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 996,
        title: "Don Quixote",
        language: "en",
        releaseDate: "2000-01-01",
        rightsStatus: "public_domain",
        summary: "A novel about grief, melancholy, and errantry.",
        authors: ["Miguel de Cervantes"],
        subjects: ["fiction", "melancholy"],
        cleanTextKey: "gutenberg/clean/996/clean.txt",
        chunksKey: "gutenberg/clean/996/chunks.jsonl",
      },
      {
        id: "work-2",
        gutenbergId: 1400,
        title: "Great Expectations",
        language: "en",
        releaseDate: "2001-01-01",
        rightsStatus: "public_domain",
        summary: "A novel about ambition, disappointment, and inner struggle.",
        authors: ["Charles Dickens"],
        subjects: ["fiction", "class"],
        cleanTextKey: "gutenberg/clean/1400/clean.txt",
        chunksKey: "gutenberg/clean/1400/chunks.jsonl",
      },
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 7,
        text: "Don Quixote frames grief as a kind of honorable endurance.",
        r2Key: "gutenberg/clean/996/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
      {
        id: "chunk-2",
        workId: "work-2",
        chunkIndex: 11,
        text: "Great Expectations turns ambition into a quieter sorrow and inward strain.",
        r2Key: "gutenberg/clean/1400/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );
  const blobStore = new MemoryBlobStore();
  const calls: string[] = [];

  const runtimeGateway = new FlyMachinesRuntimeGateway(
    store,
    blobStore,
    {
      apiToken: "fly-token",
      appName: "alphabook-runtime",
      image: "registry.fly.io/alphabook-runtime:phase2",
      region: "iad",
      runtimeSharedToken: "runtime-secret",
      r2BucketName: "alphabook-corpus",
      r2Endpoint: "https://example.r2.cloudflarestorage.com",
      r2AccessKeyId: "r2-access",
      r2SecretAccessKey: "r2-secret",
    },
    async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);

      if (url === "https://api.machines.dev/v1/apps/alphabook-runtime/machines" && method === "POST") {
        return Response.json({ id: "machine-1", state: "started" });
      }
      if (url.includes("/machines/machine-1/wait") && method === "GET") {
        return Response.json({ ok: true });
      }
      if (url.endsWith("/machines/machine-1") && method === "GET") {
        return Response.json({ id: "machine-1", state: "started" });
      }
      if (url === "https://alphabook-runtime.fly.dev/prepare" && method === "POST") {
        assert.equal(init?.headers instanceof Headers ? init.headers.get("fly-force-instance-id") : null, "machine-1");
        assert.equal(init?.headers instanceof Headers ? init.headers.get("authorization") : null, "Bearer runtime-secret");
        return Response.json({ ok: true, runtimeId: "machine-1" });
      }
      if (url === "https://alphabook-runtime.fly.dev/run-task" && method === "POST") {
        return Response.json({ ok: true });
      }
      if (url === "https://alphabook-runtime.fly.dev/task-status" && method === "GET") {
        return Response.json({
          status: "completed",
          result: {
            runtimeId: "machine-1",
            stdout: "completed",
            stderr: "",
            exitCode: 0,
            artifacts: [
              {
                filename: "briefing.md",
                path: "output/briefing.md",
                mimeType: "text/markdown",
              },
            ],
          },
        });
      }
      if (url === "https://alphabook-runtime.fly.dev/file?path=output%2Fbriefing.md" && method === "GET") {
        return Response.json({
          path: "output/briefing.md",
          size: 56,
          encoding: "utf8",
          content: "# Summary\n\nComparative answer across the two novels.",
        });
      }
      if (url === "https://alphabook-runtime.fly.dev/destroy" && method === "POST") {
        return Response.json({ ok: true });
      }
      if (url === "https://api.machines.dev/v1/apps/alphabook-runtime/machines/machine-1?force=true" && method === "DELETE") {
        return Response.json({ ok: true });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    },
  );

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new FallbackPlanner(),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore,
    runtimeGateway,
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    x402: {
      enabled: true,
      payTo: "0x1234",
      network: "base",
      asset: "USDC",
      maxAmountUsd: "5.00",
      description: "AlphaBook research access",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "user-123",
      message: "Compare grief and ambition across Don Quixote and Great Expectations.",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /event: tool\.started/);
  assert.match(body, /create_workspace/);
  assert.match(body, /run_workspace_task/);
  assert.match(body, /read_workspace_file/);
  assert.match(body, /Comparative answer across the two novels/);
  assert.match(body, /event: run\.completed/);
  assert.ok(calls.includes("POST https://alphabook-runtime.fly.dev/destroy"));
  assert.ok(calls.includes("DELETE https://api.machines.dev/v1/apps/alphabook-runtime/machines/machine-1?force=true"));

  const artifact = await blobStore.getText(artifactKeys.runtimeArtifact("machine-1", "briefing.md"));
  assert.match(artifact ?? "", /Comparative answer across the two novels/);
  assert.ok(calls.some((call) => call.includes("api.machines.dev")));
  assert.ok(calls.some((call) => call.includes("/run-task")));
});

test("orchestrator reaps expired runtimes from older sessions", async () => {
  const store = new InMemoryAppStore();
  const expiredSession = await store.createSession("expired-user", "Expired runtime");
  await store.saveRuntimeInstance({
    sessionId: expiredSession.id,
    runtimeId: "runtime-expired-1",
    provider: "fly-machines",
    providerMachineId: "machine-expired-1",
    status: "ready",
    manifestJson: {},
    lastUsedAt: "2026-03-16T00:00:00.000Z",
    expiresAt: "2026-03-16T00:05:00.000Z",
  });

  const destroyed: string[] = [];
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "direct_response",
        answer: "No search needed.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "planner should not run",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace(args) {
        destroyed.push(String(args.runtimeId ?? ""));
        await store.updateRuntimeInstance(String(args.runtimeId ?? ""), {
          status: "destroyed",
          lastUsedAt: new Date().toISOString(),
          expiresAt: new Date().toISOString(),
        });
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "fresh-user",
      message: "hello",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(destroyed, ["runtime-expired-1"]);
  const expiredRuntime = await store.getRuntimeInstance("runtime-expired-1");
  assert.equal(expiredRuntime?.status, "destroyed");
});

test("scheduled janitor reaps expired runtimes without a chat run", async () => {
  const store = new InMemoryAppStore();
  const expiredSession = await store.createSession("expired-user", "Expired runtime");
  await store.saveRuntimeInstance({
    sessionId: expiredSession.id,
    runtimeId: "runtime-expired-2",
    provider: "fly-machines",
    providerMachineId: "machine-expired-2",
    status: "ready",
    manifestJson: {},
    lastUsedAt: "2026-03-16T00:00:00.000Z",
    expiresAt: "2026-03-16T00:05:00.000Z",
  });

  const destroyed: string[] = [];
  await reapExpiredRuntimeInstances(
    {
      store,
      billing: createBillingService(store),
      planner: new FallbackPlanner(),
      embedder: new HashEmbedder(),
      synthesizer: new EchoSynthesizer(),
      blobStore: new MemoryBlobStore(),
      runtimeGateway: {
        async createWorkspace() {
          return { ok: false, error: "disabled" };
        },
        async runWorkspaceTask() {
          return { ok: false, error: "disabled" };
        },
        async readWorkspaceFile() {
          return { ok: false, error: "disabled" };
        },
        async listWorkspaceFiles() {
          return { ok: false, error: "disabled" };
        },
        async destroyWorkspace(args) {
          destroyed.push(String(args.runtimeId ?? ""));
          await store.updateRuntimeInstance(String(args.runtimeId ?? ""), {
            status: "destroyed",
            lastUsedAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
          });
          return { ok: true };
        },
      },
      queues: {
        ingestName: "alphabook-ingest",
        jobsName: "alphabook-jobs",
      },
    },
    { runId: "scheduled-janitor-test" },
  );

  assert.deepEqual(destroyed, ["runtime-expired-2"]);
  const expiredRuntime = await store.getRuntimeInstance("runtime-expired-2");
  assert.equal(expiredRuntime?.status, "destroyed");
});

test("session endpoints expose chat history for the assistant UI", async () => {
  const store = new InMemoryAppStore();
  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "The assistant created a new session.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false };
      },
      async runWorkspaceTask() {
        return { ok: false };
      },
      async readWorkspaceFile() {
        return { ok: false };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const chatResponse = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "demo-user",
      message: "Start a session",
    }),
  });
  await chatResponse.text();

  const sessionsResponse = await app.request("/sessions?userId=demo-user");
  assert.equal(sessionsResponse.status, 200);
  const sessionsPayload = (await sessionsResponse.json()) as {
    sessions: Array<{ id: string }>;
  };
  assert.equal(sessionsPayload.sessions.length, 1);

  const messagesResponse = await app.request(`/sessions/${sessionsPayload.sessions[0].id}/messages`);
  assert.equal(messagesResponse.status, 200);
  const messagesPayload = (await messagesResponse.json()) as {
    messages: Array<{ role: string }>;
  };
  assert.deepEqual(
    messagesPayload.messages.map((message) => message.role),
    ["user", "assistant", "assistant"],
  );
});

test("admin can inspect all users, all runs, and another user's session", async () => {
  const store = new InMemoryAppStore();
  await store.upsertUserProfile({
    id: "admin-user",
    email: "rprendergast1121@gmail.com",
    name: "Admin",
  });
  await store.upsertUserProfile({
    id: "reader-user",
    email: "reader@example.com",
    name: "Reader",
  });
  const session = await store.createSession("reader-user", "Reader session");
  await store.appendMessage(session.id, "user", "Find angry passages.");
  const run = await store.createRun(session.id);
  await store.updateRun(run.id, {
    status: "completed",
    plannerTurns: 2,
    completedAt: new Date().toISOString(),
  });

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "ok",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false };
      },
      async runWorkspaceTask() {
        return { ok: false };
      },
      async readWorkspaceFile() {
        return { ok: false };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    adminAllowedEmail: "rprendergast1121@gmail.com",
  });

  const adminUsersResponse = await app.request("/admin/users?userId=admin-user");
  assert.equal(adminUsersResponse.status, 200);
  const adminUsers = await adminUsersResponse.json() as {
    users: Array<{ email: string | null }>;
  };
  assert.ok(adminUsers.users.some((user) => user.email === "reader@example.com"));

  const adminRunsResponse = await app.request("/admin/runs?userId=admin-user");
  assert.equal(adminRunsResponse.status, 200);
  const adminRuns = await adminRunsResponse.json() as {
    runs: Array<{ id: string }>;
  };
  assert.ok(adminRuns.runs.some((candidate) => candidate.id === run.id));

  const sessionMessagesResponse = await app.request(`/sessions/${session.id}/messages?userId=admin-user`);
  assert.equal(sessionMessagesResponse.status, 200);
  const sessionMessages = await sessionMessagesResponse.json() as {
    messages: Array<{ content: string }>;
  };
  assert.equal(sessionMessages.messages[0]?.content, "Find angry passages.");
});

test("workspace args are normalized and run logs are exposed", async () => {
  const store = new InMemoryAppStore([
    {
      id: "work-1",
      gutenbergId: 42,
      title: "Divine Comedy",
      language: "en",
      releaseDate: "2000-01-01",
      rightsStatus: "public_domain",
      summary: "An epic poem through Hell, Purgatory, and Heaven.",
      authors: ["Dante Alighieri"],
      subjects: ["poetry"],
      cleanTextKey: "gutenberg/clean/42/clean.txt",
    },
  ]);

  let capturedTaskContext: Record<string, unknown> | null = null;
  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "create_workspace",
        args: {
          workIds: ["work-1"],
          chunkIds: [],
          taskContext: "find angry passages",
        },
      },
      {
        type: "final_answer",
        answer: "Done.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace(args) {
        capturedTaskContext = (args.taskContext ?? null) as Record<string, unknown> | null;
        return { ok: true, runtimeId: "runtime-1" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const chatResponse = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "demo-user",
      message: "Find angry passages in Divine Comedy",
    }),
  });
  await chatResponse.text();

  assert.deepEqual(capturedTaskContext, {
    question: "Find angry passages in Divine Comedy",
    researchObjective: "Find angry passages in Divine Comedy",
    mode: "exhaustive_corpus_search",
    candidateWorkIds: [],
    topChunks: [],
    prewarmed: true,
  });

  const sessionsResponse = await app.request("/sessions?userId=demo-user");
  const sessionsPayload = (await sessionsResponse.json()) as {
    sessions: Array<{ id: string }>;
  };
  const sessionId = sessionsPayload.sessions[0]?.id;
  assert.ok(sessionId);

  const runsResponse = await app.request(`/sessions/${sessionId}/runs`);
  assert.equal(runsResponse.status, 200);
  const runsPayload = (await runsResponse.json()) as {
    runs: Array<{ id: string }>;
  };
  assert.equal(runsPayload.runs.length, 1);

  const runDetailsResponse = await app.request(`/sessions/${sessionId}/runs/${runsPayload.runs[0]?.id}`);
  assert.equal(runDetailsResponse.status, 200);
  const runDetailsPayload = (await runDetailsResponse.json()) as {
    toolCalls: Array<{ toolName: string; argsJson: Record<string, unknown> }>;
  };
  assert.ok(runDetailsPayload.toolCalls.length >= 2);
  const createWorkspaceCall = runDetailsPayload.toolCalls.find((toolCall) => toolCall.toolName === "create_workspace");
  assert.ok(createWorkspaceCall);
  assert.deepEqual(createWorkspaceCall?.argsJson.taskContext, {
    question: "Find angry passages in Divine Comedy",
    researchObjective: "Find angry passages in Divine Comedy",
    mode: "exhaustive_corpus_search",
    candidateWorkIds: [],
    topChunks: [],
    prewarmed: true,
  });

  const debugResponse = await app.request(`/sessions/${sessionId}/debug`);
  assert.equal(debugResponse.status, 200);
  const debugPayload = (await debugResponse.json()) as {
    messages: Array<{ role: string }>;
    runs: Array<{ id: string }>;
    toolCallsByRun: Record<string, Array<{ toolName: string }>>;
    artifacts: Array<unknown>;
  };
  assert.deepEqual(debugPayload.messages.map((message) => message.role), ["user", "assistant", "assistant"]);
  assert.equal(debugPayload.runs.length, 1);
  assert.equal(debugPayload.toolCallsByRun[runsPayload.runs[0]?.id ?? ""]?.[0]?.toolName, "create_workspace");
  assert.ok(Array.isArray(debugPayload.artifacts));

  const runDebugResponse = await app.request(`/sessions/${sessionId}/runs/${runsPayload.runs[0]?.id}/debug`);
  assert.equal(runDebugResponse.status, 200);
  const runDebugPayload = (await runDebugResponse.json()) as {
    run: { id: string };
    toolCalls: Array<{ toolName: string }>;
  };
  assert.equal(runDebugPayload.run.id, runsPayload.runs[0]?.id);
  assert.equal(runDebugPayload.toolCalls[0]?.toolName, "create_workspace");
});

test("run details endpoint recovers a completed run answer from a persisted briefing", async () => {
  const store = new InMemoryAppStore();
  const session = await store.createSession("reader-user", "Recover briefing");
  await store.appendMessage(session.id, "user", "Find grief passages.");
  const run = await store.createRun(session.id);
  const toolCall = await store.startToolCall(run.id, "run_workspace_task", {
    runtimeId: "runtime-1",
    taskSpec: {
      phase: "collect_and_brief",
    },
  });
  await store.finishToolCall(toolCall.id, "completed", {
    ok: true,
    runtimeId: "runtime-1",
    briefing: "Recovered briefing content.",
    citations: [],
  });
  await store.updateRun(run.id, {
    status: "completed",
    completedAt: new Date().toISOString(),
  });

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "unused",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const repairResponse = await app.request(`/sessions/${session.id}/runs/${run.id}?userId=reader-user`);
  assert.equal(repairResponse.status, 200);

  const messagesResponse = await app.request(`/sessions/${session.id}/messages?userId=reader-user`);
  assert.equal(messagesResponse.status, 200);
  const payload = await messagesResponse.json() as {
    messages: Array<{ role: string; content: string; metadata: Record<string, unknown> }>;
  };
  assert.equal(payload.messages.length, 2);
  assert.equal(payload.messages[1]?.role, "assistant");
  assert.equal(payload.messages[1]?.content, "Recovered briefing content.");
  assert.equal(payload.messages[1]?.metadata.runId, run.id);
});

test("run recovery synthesizes a user-facing answer from the saved briefing and research document", async () => {
  const store = new InMemoryAppStore();
  const session = await store.createSession("reader-user", "Recover synthesized briefing");
  await store.appendMessage(session.id, "user", "Find grief passages.");
  const run = await store.createRun(session.id);
  const workTool = await store.startToolCall(run.id, "search_works", {
    query: "grief mourning fiction",
  });
  await store.finishToolCall(workTool.id, "completed", {
    ok: true,
    works: [
      {
        id: "work-1",
        title: "Little Women",
        authors: ["Louisa May Alcott"],
      },
    ],
  });
  const chunkTool = await store.startToolCall(run.id, "get_relevant_chunks", {
    query: "grief mourning",
    workIds: ["work-1"],
  });
  await store.finishToolCall(chunkTool.id, "completed", {
    ok: true,
    chunks: [
      {
        id: "chunk-1",
        workId: "work-1",
        title: "Little Women",
        author: "Louisa May Alcott",
        chunkIndex: 12,
        excerpt: "Beth bears suffering quietly while the family mourns around her.",
        text: "Beth bears suffering quietly while the family mourns around her.",
        r2Key: "gutenberg/clean/514/chunks.jsonl",
      },
    ],
  });
  const toolCall = await store.startToolCall(run.id, "run_workspace_task", {
    runtimeId: "runtime-1",
    taskSpec: {
      phase: "collect_and_brief",
    },
  });
  await store.finishToolCall(toolCall.id, "completed", {
    ok: true,
    runtimeId: "runtime-1",
    briefing: "Recovered briefing content about grief rituals and family comfort.",
    citations: [
      {
        workId: "work-1",
        chunkId: "chunk-1",
        label: "Little Women#12",
        excerpt: "Beth bears suffering quietly while the family mourns around her.",
        r2Key: "gutenberg/clean/514/chunks.jsonl",
      },
    ],
  });
  await store.updateRun(run.id, {
    status: "completed",
    completedAt: new Date().toISOString(),
  });

  const synthesizer = new RuntimeAwareSynthesizer();
  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "unused",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer,
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const repairResponse = await app.request(`/sessions/${session.id}/runs/${run.id}?userId=reader-user`);
  assert.equal(repairResponse.status, 200);

  const messagesResponse = await app.request(`/sessions/${session.id}/messages?userId=reader-user`);
  assert.equal(messagesResponse.status, 200);
  const payload = await messagesResponse.json() as {
    messages: Array<{ role: string; content: string; metadata: Record<string, unknown> }>;
  };
  assert.equal(payload.messages[1]?.role, "assistant");
  assert.match(payload.messages[1]?.content ?? "", /^Summary:/);
  assert.notEqual(payload.messages[1]?.content, "Recovered briefing content about grief rituals and family comfort.");
  assert.equal(synthesizer.lastInput?.runtimeBriefing, "Recovered briefing content about grief rituals and family comfort.");
  assert.match(synthesizer.lastInput?.researchDocument ?? "", /Little Women by Louisa May Alcott/);
});

test("run details endpoint fails orphaned running runs with no active tool call", async () => {
  const store = new InMemoryAppStore();
  const session = await store.createSession("reader-user", "Stuck run");
  await store.appendMessage(session.id, "user", "Find grief passages.");
  const run = await store.createRun(session.id);
  const toolCall = await store.startToolCall(run.id, "search_works", {
    query: "grief",
  });
  await store.finishToolCall(toolCall.id, "completed", {
    works: [],
  });

  const staleStartedAt = new Date(Date.now() - 45_000).toISOString();
  await store.updateRun(run.id, {
    status: "running",
    completedAt: null,
  });
  const runs = (store as unknown as { runs: Map<string, { startedAt: string }> }).runs;
  const storedRun = runs.get(run.id);
  assert.ok(storedRun);
  storedRun.startedAt = staleStartedAt;

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "unused",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const runResponse = await app.request(`/sessions/${session.id}/runs/${run.id}?userId=reader-user`);
  assert.equal(runResponse.status, 200);
  const runPayload = await runResponse.json() as {
    run: { status: string };
  };
  assert.equal(runPayload.run.status, "failed");

  const messagesResponse = await app.request(`/sessions/${session.id}/messages?userId=reader-user`);
  assert.equal(messagesResponse.status, 200);
  const payload = await messagesResponse.json() as {
    messages: Array<{ role: string; content: string; metadata: Record<string, unknown> }>;
  };
  const errorMessage = payload.messages.find((message) => message.metadata?.phase === "error");
  assert.equal(errorMessage?.content, "This run stopped unexpectedly before it produced an answer.");
});

test("persisted tool traces keep chunk results compact enough for refresh", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 154,
        title: "The Rise of Silas Lapham",
        language: "en",
        releaseDate: "2000-01-01",
        rightsStatus: "public_domain",
        summary: "A novel with passages about adversity and mourning.",
        authors: ["William Dean Howells"],
        subjects: ["fiction", "grief"],
        cleanTextKey: "gutenberg/clean/154/clean.txt",
      },
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 472,
        text: "The house of mourning is decorously darkened to the world, but within itself it is also the house of laughing. Bursts of gaiety, as heartfelt as its grief, relieve the gloom, and the stricken survivors have their jests together.",
        r2Key: "gutenberg/clean/154/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "get_relevant_chunks",
        args: {
          query: "grief and mourning",
          filters: {
            language: "en",
          },
        },
      },
      {
        type: "final_answer",
        answer: "Found one passage.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "trace-user",
      message: "Find grief and mourning.",
    }),
  });
  await response.text();

  const sessionsResponse = await app.request("/sessions?userId=trace-user");
  const sessionsPayload = await sessionsResponse.json() as {
    sessions: Array<{ id: string }>;
  };
  const sessionId = sessionsPayload.sessions[0]?.id;
  assert.ok(sessionId);

  const messagesResponse = await app.request(`/sessions/${sessionId}/messages?userId=trace-user`);
  const messagesPayload = await messagesResponse.json() as {
    messages: Array<{ metadata: Record<string, unknown> }>;
  };
  const planMessage = messagesPayload.messages.find((message) => message.metadata?.phase === "plan");
  const toolCalls = Array.isArray(planMessage?.metadata?.toolCalls)
    ? planMessage?.metadata?.toolCalls as Array<Record<string, unknown>>
    : [];
  const chunkResult = toolCalls.find((entry) => entry.toolName === "get_relevant_chunks");
  const result = chunkResult?.result && typeof chunkResult.result === "object"
    ? chunkResult.result as Record<string, unknown>
    : null;
  const logLines = Array.isArray(result?.__logLines) ? result.__logLines as unknown[] : [];
  const compactLines = logLines.filter((line): line is string => typeof line === "string");
  const compactChunks = Array.isArray(result?.chunks) ? result.chunks as Array<Record<string, unknown>> : [];

  assert.ok(compactLines.some((line) => line.startsWith("1 chunk 1 work 1 472")));
  assert.ok(compactLines.some((line) => line.includes("house of laughing")));
  assert.ok(compactLines.every((line) => !line.includes("The house of mourning is decorously darkened to the world")));
  assert.equal(compactChunks.length, 1);
  assert.equal(compactChunks[0]?.workId, "work-1");
  assert.equal(compactChunks[0]?.chunkIndex, 472);
});

test("get_relevant_chunks tolerates null workIds from planner output", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 1342,
        title: "Pride and Prejudice",
        language: "en",
        releaseDate: "2001-01-01",
        rightsStatus: "public_domain",
        summary: "A novel of courtship, separation, and eventual marriage.",
        authors: ["Jane Austen"],
        subjects: ["courtship", "grief"],
      },
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 21,
        text: "After a painful separation, the lovers were reconciled and finally married.",
        r2Key: "gutenberg/clean/1342/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "grief in fiction",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "get_relevant_chunks",
        args: {
          query: "painful separation reconciled married",
          workIds: null,
          work_ids: null,
          filters: {
            language: "en",
          },
        },
      },
      {
        type: "final_answer",
        answer: "Found one relevant passage.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "null-workids-user",
      message: "Find grief in fiction.",
    }),
  });
  await response.text();

  const sessionsResponse = await app.request("/sessions?userId=null-workids-user");
  const sessionsPayload = await sessionsResponse.json() as {
    sessions: Array<{ id: string }>;
  };
  const sessionId = sessionsPayload.sessions[0]?.id;
  assert.ok(sessionId);

  const messagesResponse = await app.request(`/sessions/${sessionId}/messages?userId=null-workids-user`);
  const messagesPayload = await messagesResponse.json() as {
    messages: Array<{ metadata: Record<string, unknown> }>;
  };
  const planMessage = messagesPayload.messages.find((message) => message.metadata?.phase === "plan");
  const toolCalls = Array.isArray(planMessage?.metadata?.toolCalls)
    ? planMessage?.metadata?.toolCalls as Array<Record<string, unknown>>
    : [];
  const chunkResult = toolCalls.find((entry) => entry.toolName === "get_relevant_chunks");
  assert.equal(chunkResult?.state, "completed");
  const result = chunkResult?.result && typeof chunkResult.result === "object"
    ? chunkResult.result as Record<string, unknown>
    : null;
  const compactChunks = Array.isArray(result?.chunks) ? result.chunks as Array<Record<string, unknown>> : [];
  assert.equal(compactChunks.length, 1);
});

test("get_relevant_chunks simplifies scoped metadata-style queries into thematic passage search", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 71152,
        title: "A lady and her husband",
        language: "en",
        releaseDate: "1914-01-01",
        rightsStatus: "public_domain",
        summary: "A novel of marriage and inward conflict.",
        authors: ["Amber Reeves Blanco White"],
        subjects: ["Fiction", "Marriage -- Fiction"],
      },
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 12,
        text: "Within myself I reproached my own conscience and asked myself whether I had mistaken the whole course of my life.",
        r2Key: "gutenberg/clean/71152/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "Find introspective passages in notable lives.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "get_relevant_chunks",
        args: {
          query: "\"examine myself\" OR \"my conscience\" OR \"I asked myself\" OR \"within myself\" AND (Napoleon OR Lincoln OR \"John Stuart Mill\")",
          workIds: ["work-1"],
          filters: {
            language: "en",
          },
        },
      },
      {
        type: "final_answer",
        answer: "Found one introspective passage.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "scoped-chunk-user",
      message: "Find introspective passages in notable lives.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();

  const sessionsResponse = await app.request("/sessions?userId=scoped-chunk-user");
  const sessionsPayload = await sessionsResponse.json() as {
    sessions: Array<{ id: string }>;
  };
  const sessionId = sessionsPayload.sessions[0]?.id;
  assert.ok(sessionId);

  const messagesResponse = await app.request(`/sessions/${sessionId}/messages?userId=scoped-chunk-user`);
  const messagesPayload = await messagesResponse.json() as {
    messages: Array<{ metadata: Record<string, unknown> }>;
  };
  const planMessage = messagesPayload.messages.find((message) => message.metadata?.phase === "plan");
  const toolCalls = Array.isArray(planMessage?.metadata?.toolCalls)
    ? planMessage?.metadata?.toolCalls as Array<Record<string, unknown>>
    : [];
  const chunkResult = toolCalls.find((entry) => entry.toolName === "get_relevant_chunks");
  assert.equal(chunkResult?.state, "completed");
  const result = chunkResult?.result && typeof chunkResult.result === "object"
    ? chunkResult.result as Record<string, unknown>
    : null;
  const compactChunks = Array.isArray(result?.chunks) ? result.chunks as Array<Record<string, unknown>> : [];
  assert.equal(compactChunks.length, 1);
  assert.match(String(compactChunks[0]?.excerpt ?? ""), /within myself|conscience|asked myself/i);
});

test("get_relevant_chunks widens scoped workIds with metadata candidates from history", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 1702,
        title: "Little Masterpieces of Autobiography",
        language: "en",
        releaseDate: "1900-01-01",
        rightsStatus: "public_domain",
        summary: "Autobiographical selections.",
        authors: ["George Iles"],
        subjects: ["Autobiographies"],
      },
      {
        id: "work-2",
        gutenbergId: 2523,
        title: "The Memoirs of Victor Hugo",
        language: "en",
        releaseDate: "1900-01-01",
        rightsStatus: "public_domain",
        summary: "A memoir with self-reflective passages.",
        authors: ["Victor Hugo"],
        subjects: ["Autobiographies", "Memoirs"],
      },
    ],
    [
      {
        id: "chunk-2",
        workId: "work-2",
        chunkIndex: 7,
        text: "Within myself I found the same doubts, the same conscience, and the same need to judge my own life.",
        r2Key: "gutenberg/clean/2523/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "Find introspective passages in notable lives.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "search_works",
        args: {
          query: "memoir autobiography reflection",
          filters: {
            language: "en",
          },
        },
      },
      {
        type: "tool_call",
        tool_name: "get_relevant_chunks",
        args: {
          query: "\"within myself\" OR conscience OR reflection",
          workIds: ["work-1"],
          filters: {
            language: "en",
          },
        },
      },
      {
        type: "final_answer",
        answer: "Found one introspective passage.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "history-expanded-chunks-user",
      message: "Find introspective passages in notable lives.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();

  const sessionsResponse = await app.request("/sessions?userId=history-expanded-chunks-user");
  const sessionsPayload = await sessionsResponse.json() as {
    sessions: Array<{ id: string }>;
  };
  const sessionId = sessionsPayload.sessions[0]?.id;
  assert.ok(sessionId);

  const messagesResponse = await app.request(`/sessions/${sessionId}/messages?userId=history-expanded-chunks-user`);
  const messagesPayload = await messagesResponse.json() as {
    messages: Array<{ metadata: Record<string, unknown> }>;
  };
  const planMessage = messagesPayload.messages.find((message) => message.metadata?.phase === "plan");
  const toolCalls = Array.isArray(planMessage?.metadata?.toolCalls)
    ? planMessage?.metadata?.toolCalls as Array<Record<string, unknown>>
    : [];
  const chunkResult = toolCalls.find((entry) => entry.toolName === "get_relevant_chunks");
  assert.equal(chunkResult?.state, "completed");
  const result = chunkResult?.result && typeof chunkResult.result === "object"
    ? chunkResult.result as Record<string, unknown>
    : null;
  const compactChunks = Array.isArray(result?.chunks) ? result.chunks as Array<Record<string, unknown>> : [];
  assert.equal(compactChunks.length, 1);
  assert.equal(compactChunks[0]?.workId, "work-2");
});

test("run_workspace_task auto-seeds scoped chunks when the planner provides books but no passages", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 71152,
        title: "A lady and her husband",
        language: "en",
        releaseDate: "1914-01-01",
        rightsStatus: "public_domain",
        summary: "A novel of marriage and inward conflict.",
        authors: ["Amber Reeves Blanco White"],
        subjects: ["Fiction", "Marriage -- Fiction"],
      },
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 12,
        text: "Within myself I reproached my own conscience and asked myself whether I had mistaken the whole course of my life.",
        r2Key: "gutenberg/clean/71152/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );

  let receivedTaskSpec: Record<string, unknown> | null = null;
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "Find introspective passages in notable lives.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "run_workspace_task",
        args: {
          runtimeId: "runtime-1",
          taskSpec: {
            mode: "open_book_analysis",
            question: "Find introspective passages in notable lives.",
            researchObjective: "Find introspective passages in notable lives.",
            searchHints: {
              passageSearchFocus: "\"within myself\" OR \"my conscience\" OR \"I asked myself\"",
            },
            workIds: ["work-1"],
            chunkIds: [],
            retrieval: {
              seedChunks: [],
            },
          },
        },
      },
      {
        type: "final_answer",
        answer: "Done.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask(input) {
        receivedTaskSpec = input.taskSpec as Record<string, unknown>;
        return { ok: true, briefing: "Briefing written." };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "seeded-runtime-user",
      message: "Find introspective passages in notable lives.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();
  assert.ok(receivedTaskSpec);
  const taskSpecRecord = receivedTaskSpec as Record<string, unknown>;
  const chunkIds = Array.isArray(taskSpecRecord.chunkIds) ? taskSpecRecord.chunkIds : [];
  assert.equal(chunkIds.length, 1);
  assert.equal(chunkIds[0], "chunk-1");
  const retrieval = taskSpecRecord.retrieval && typeof taskSpecRecord.retrieval === "object"
    ? taskSpecRecord.retrieval as Record<string, unknown>
    : null;
  const seedChunks = Array.isArray(retrieval?.seedChunks) ? retrieval.seedChunks as Array<Record<string, unknown>> : [];
  assert.equal(seedChunks.length, 1);
  assert.equal(seedChunks[0]?.id, "chunk-1");
});

test("run_workspace_task at maximum intensity widens passage seeding when scoped books produce no chunks", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 111,
        title: "Irrelevant Seed Work",
        language: "en",
        releaseDate: "1880-01-01",
        rightsStatus: "public_domain",
        summary: "A work that does not contain the target passage.",
        authors: ["Author One"],
        subjects: ["Fiction"],
      },
      {
        id: "work-2",
        gutenbergId: 222,
        title: "Broader Corpus Match",
        language: "en",
        releaseDate: "1885-01-01",
        rightsStatus: "public_domain",
        summary: "A broader match with grief consolation passages.",
        authors: ["Author Two"],
        subjects: ["Fiction", "Grief -- Fiction"],
      },
    ],
    [
      {
        id: "chunk-2",
        workId: "work-2",
        chunkIndex: 9,
        text: "Her grief found consolation in work and prayer after the funeral.",
        r2Key: "gutenberg/clean/222/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );

  let receivedTaskSpec: Record<string, unknown> | null = null;
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "Find grief consolation passages.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "run_workspace_task",
        args: {
          runtimeId: "runtime-1",
          taskSpec: {
            mode: "exhaustive_corpus_search",
            intensity: "maximum",
            question: "Find grief consolation passages.",
            researchObjective: "Find grief consolation passages.",
            searchHints: {
              passageSearchFocus: "grief consolation funeral prayer work",
            },
            workIds: ["work-1"],
            frontierWorkIds: ["work-1"],
            chunkIds: [],
            retrieval: {
              seedChunks: [],
            },
          },
        },
      },
      {
        type: "final_answer",
        answer: "Done.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask(input) {
        receivedTaskSpec = input.taskSpec as Record<string, unknown>;
        return { ok: true, briefing: "Briefing written." };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "maximum-seed-runtime-user",
      message: "Find grief consolation passages.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();
  assert.ok(receivedTaskSpec);
  const taskSpecRecord = receivedTaskSpec as Record<string, unknown>;
  const chunkIds = Array.isArray(taskSpecRecord.chunkIds) ? taskSpecRecord.chunkIds : [];
  assert.ok(chunkIds.includes("chunk-2"));
  const frontierWorkIds = Array.isArray(taskSpecRecord.frontierWorkIds) ? taskSpecRecord.frontierWorkIds : [];
  assert.ok(frontierWorkIds.includes("work-2"));
  const verifiedWorkIds = Array.isArray(taskSpecRecord.verifiedWorkIds) ? taskSpecRecord.verifiedWorkIds : [];
  assert.ok(verifiedWorkIds.includes("work-2"));
});

test("run_workspace_task at normal intensity backfills verified passage seeds before VM launch", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 111,
        title: "Irrelevant Seed Work",
        language: "en",
        releaseDate: "1880-01-01",
        rightsStatus: "public_domain",
        summary: "A work that does not contain the target passage.",
        authors: ["Author One"],
        subjects: ["Fiction"],
      },
      {
        id: "work-2",
        gutenbergId: 222,
        title: "Broader Corpus Match",
        language: "en",
        releaseDate: "1885-01-01",
        rightsStatus: "public_domain",
        summary: "A broader match with grief consolation passages.",
        authors: ["Author Two"],
        subjects: ["Fiction", "Grief -- Fiction"],
      },
    ],
    [
      {
        id: "chunk-2",
        workId: "work-2",
        chunkIndex: 9,
        text: "Her grief found consolation in work and prayer after the funeral.",
        r2Key: "gutenberg/clean/222/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );

  let receivedTaskSpec: Record<string, unknown> | null = null;
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "Find grief consolation passages.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "run_workspace_task",
        args: {
          runtimeId: "runtime-1",
          taskSpec: {
            mode: "exhaustive_corpus_search",
            intensity: "normal",
            question: "Find grief consolation passages.",
            researchObjective: "Find grief consolation passages.",
            searchHints: {
              passageSearchFocus: "grief consolation funeral prayer work",
            },
            workIds: ["work-1"],
            frontierWorkIds: ["work-1"],
            chunkIds: [],
            verifiedChunkIds: [],
            retrieval: {
              seedChunks: [],
            },
          },
        },
      },
      {
        type: "final_answer",
        answer: "Done.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask(input) {
        receivedTaskSpec = input.taskSpec as Record<string, unknown>;
        return { ok: true, briefing: "Briefing written." };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "normal-seed-runtime-user",
      message: "Find grief consolation passages.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();
  assert.ok(receivedTaskSpec);
  const taskSpecRecord = receivedTaskSpec as Record<string, unknown>;
  const chunkIds = Array.isArray(taskSpecRecord.chunkIds) ? taskSpecRecord.chunkIds : [];
  assert.ok(chunkIds.includes("chunk-2"));
  const verifiedChunkIds = Array.isArray(taskSpecRecord.verifiedChunkIds) ? taskSpecRecord.verifiedChunkIds : [];
  assert.ok(verifiedChunkIds.includes("chunk-2"));
});

test("search_works ignores unsupported human-readable language filters from planner output", async () => {
  const store = new InMemoryAppStore([
    {
      id: "work-1",
      gutenbergId: 996,
      title: "Don Quixote",
      language: "en",
      releaseDate: "2000-01-01",
      rightsStatus: "public_domain",
      summary: "A novel about grief and errantry.",
      authors: ["Miguel de Cervantes"],
      subjects: ["fiction", "melancholy"],
    },
  ], []);

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "books about grief in fiction",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "search_works",
        args: {
          query: "grief mourning bereavement novel",
          filters: {
            language: "English",
            year_gte: 1801,
            year_lte: 1900,
          },
        },
      },
      {
        type: "final_answer",
        answer: "Found one relevant work.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "language-filter-user",
      message: "Find grief in fiction.",
    }),
  });
  await response.text();

  const sessionsResponse = await app.request("/sessions?userId=language-filter-user");
  const sessionsPayload = await sessionsResponse.json() as {
    sessions: Array<{ id: string }>;
  };
  const sessionId = sessionsPayload.sessions[0]?.id;
  assert.ok(sessionId);

  const messagesResponse = await app.request(`/sessions/${sessionId}/messages?userId=language-filter-user`);
  const messagesPayload = await messagesResponse.json() as {
    messages: Array<{ metadata: Record<string, unknown> }>;
  };
  const planMessage = messagesPayload.messages.find((message) => message.metadata?.phase === "plan");
  const toolCalls = Array.isArray(planMessage?.metadata?.toolCalls)
    ? planMessage?.metadata?.toolCalls as Array<Record<string, unknown>>
    : [];
  const searchResult = toolCalls.find((entry) => entry.toolName === "search_works");
  assert.equal(searchResult?.state, "completed");
  const result = searchResult?.result && typeof searchResult.result === "object"
    ? searchResult.result as Record<string, unknown>
    : null;
  const works = Array.isArray(result?.works) ? result.works as Array<Record<string, unknown>> : [];
  assert.equal(works.length, 1);
  assert.equal(works[0]?.id, "work-1");
});

test("search_works normalizes planner date ranges and fiction intent before ranking works", async () => {
  const store = new InMemoryAppStore([
    {
      id: "work-fiction",
      gutenbergId: 1342,
      title: "Pride and Prejudice",
      language: "en",
      releaseDate: "1813-01-28",
      rightsStatus: "public_domain",
      summary: "A fiction novel of mourning, grief, and recovery.",
      authors: ["Jane Austen"],
      subjects: ["Fiction", "Courtship"],
    },
    {
      id: "work-lincoln",
      gutenbergId: 9,
      title: "Lincoln’s First Inaugural Address",
      language: "en",
      releaseDate: "1861-01-01",
      rightsStatus: "public_domain",
      summary: "An address about the crisis of the Union.",
      authors: ["Abraham Lincoln"],
      subjects: ["Politics", "United States"],
    },
  ], []);

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "Find grief in 19th century fiction.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "search_works",
        args: {
          query: "(grief OR mourning OR bereavement OR widow* OR funeral) AND (novel OR story) AND (18* OR 19*)",
          filters: {
            dateRange: { from: 1800, to: 1899 },
            language: "en",
          },
        },
      },
      {
        type: "final_answer",
        answer: "done",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "search-filter-user",
      message: "Find grief in fiction.",
    }),
  });
  await response.text();

  const sessions = await store.listSessions("search-filter-user");
  const runs = await store.listRuns(sessions[0]!.id);
  const toolCalls = await store.listToolCalls(runs[0]!.id);
  const searchCall = toolCalls.find((entry) => entry.toolName === "search_works");
  assert.ok(searchCall);
  assert.deepEqual(searchCall.argsJson.filters, {
    language: "en",
    yearRange: [1800, 1899],
    genre: ["fiction"],
  });
  assert.equal(searchCall.status, "completed");
  const resultWorks = Array.isArray(searchCall.resultJson?.works)
    ? searchCall.resultJson?.works as Array<Record<string, unknown>>
    : [];
  assert.deepEqual(resultWorks.map((work) => work.id), ["work-fiction"]);
});

test("search_works strips dead and death from fiction grief metadata queries before execution", async () => {
  const store = new InMemoryAppStore([
    {
      id: "work-fiction",
      gutenbergId: 1885,
      title: "Mourning Novel",
      language: "en",
      releaseDate: "1885-01-01",
      rightsStatus: "public_domain",
      summary: "A fiction novel of mourning, grief, and consolation.",
      authors: ["A. Writer"],
      subjects: ["Fiction"],
    },
  ], []);

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "Find grief in 19th century fiction.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "search_works",
        args: {
          query: '(grief OR mourning OR bereavement OR "death" OR "dead" OR widow OR widower OR funeral OR revenge OR acceptance) AND (novel OR fiction)',
          filters: {
            publicationYear: { from: 1800, to: 1899 },
            language: "en",
          },
        },
      },
      {
        type: "final_answer",
        answer: "done",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "search-sanitization-user",
      message: "Find grief in 19th century fiction.",
    }),
  });
  await response.text();

  const sessions = await store.listSessions("search-sanitization-user");
  const runs = await store.listRuns(sessions[0]!.id);
  const toolCalls = await store.listToolCalls(runs[0]!.id);
  const searchCall = toolCalls.find((entry) => entry.toolName === "search_works");
  assert.ok(searchCall);
  const normalizedQuery = String(searchCall.argsJson.query ?? "");
  assert.match(normalizedQuery, /mourning/i);
  assert.match(normalizedQuery, /bereavement/i);
  assert.doesNotMatch(normalizedQuery, /\bdead\b/i);
  assert.doesNotMatch(normalizedQuery, /\bdeath\b/i);
  assert.doesNotMatch(normalizedQuery, /\brevenge\b/i);
  assert.doesNotMatch(normalizedQuery, /\bacceptance\b/i);
});

test("sql metadata search fails loudly instead of silently falling back", async () => {
  const store = new NeonAppStore({
    async query() {
      throw new Error("db blew up");
    },
    async end() {},
  });

  await assert.rejects(
    () => store.searchWorks("grief fiction", {
      language: "en",
      yearRange: [1800, 1899],
      genre: ["fiction"],
    }),
    /Metadata search failed: db blew up/,
  );
});

test("sql metadata search can broaden into chunk-backed work discovery when metadata rows are empty", async () => {
  const queries: string[] = [];
  const store = new NeonAppStore({
    async query<T = Record<string, unknown>>(sql: string) {
      queries.push(sql);
      if (queries.length === 1) {
        return { rows: [] as T[] };
      }
      return {
        rows: [
          {
            id: "work-fiction",
            gutenberg_id: 1342,
            title: "Pride and Prejudice",
            metadata_json: {},
            language: "en",
            release_date: "1813-01-28",
            rights_status: "public_domain",
            summary: "A fiction novel of mourning and grief.",
            authors: ["Jane Austen"],
            subjects: ["Fiction", "Courtship"],
            score: 3,
          },
        ] as T[],
      };
    },
    async end() {},
  });

  const results = await store.searchWorks("grief mourning bereavement widow funeral 1800 1899 fiction", {
    language: "en",
    yearRange: [1800, 1899],
    genre: ["fiction"],
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.id, "work-fiction");
  assert.ok(queries.length >= 2);
  assert.ok(queries.some((query) => /chunk_matches AS \(/.test(query)));
});

test("sql metadata search keeps broadening when grief metadata hits are plentiful but low-signal", async () => {
  const queries: string[] = [];
  const store = new NeonAppStore({
    async query<T = Record<string, unknown>>(sql: string) {
      queries.push(sql);
      if (queries.length === 1) {
        return {
          rows: [
            {
              id: "juvenile-work",
              gutenberg_id: 19514,
              title: "A Little Princess",
              metadata_json: {},
              language: "en",
              release_date: "1905-01-01",
              rights_status: "public_domain",
              summary: "An orphan girl at a boarding school.",
              authors: ["Frances Hodgson Burnett"],
              subjects: ["Orphans -- Juvenile fiction", "Girls -- Juvenile fiction", "PZ"],
              score: 1.4,
            },
            {
              id: "juvenile-work-2",
              gutenberg_id: 45,
              title: "Anne of Green Gables",
              metadata_json: {},
              language: "en",
              release_date: "1908-01-01",
              rights_status: "public_domain",
              summary: "Another orphan story.",
              authors: ["L. M. Montgomery"],
              subjects: ["Orphans -- Fiction", "Girls -- Fiction"],
              score: 1.3,
            },
          ] as T[],
        };
      }
      return {
        rows: [
          {
            id: "adult-work",
            gutenberg_id: 1342,
            title: "Pride and Prejudice",
            metadata_json: {},
            language: "en",
            release_date: "1813-01-28",
            rights_status: "public_domain",
            summary: "A fiction novel of mourning and grief.",
            authors: ["Jane Austen"],
            subjects: ["Fiction", "Courtship"],
            score: 3,
          },
        ] as T[],
      };
    },
    async end() {},
  });

  const results = await store.searchWorks("grief mourning bereavement funeral orphan fiction", {
    language: "en",
    yearRange: [1800, 1899],
    genre: ["fiction"],
  });

  assert.equal(results[0]?.id, "adult-work");
  assert.ok(queries.length >= 2);
  assert.ok(queries.some((query) => /chunk_matches AS \(/.test(query)));
});

test("sql metadata search relaxes again when grief matches remain low-signal after chunk expansion", async () => {
  const seenParams: unknown[][] = [];
  let queryCount = 0;
  const store = new NeonAppStore({
    async query<T = Record<string, unknown>>(_sql: string, params?: unknown[]) {
      queryCount += 1;
      seenParams.push(params ?? []);
      if (queryCount === 1) {
        return {
          rows: [
            {
              id: "juvenile-work",
              gutenberg_id: 19514,
              title: "A Little Princess",
              metadata_json: {},
              language: "en",
              release_date: "1905-01-01",
              rights_status: "public_domain",
              summary: "An orphan girl at a boarding school.",
              authors: ["Frances Hodgson Burnett"],
              subjects: ["Orphans -- Juvenile fiction", "Girls -- Juvenile fiction", "PZ"],
              score: 1.4,
            },
          ] as T[],
        };
      }
      if (queryCount === 2) {
        return { rows: [] as T[] };
      }
      return {
        rows: [
          {
            id: "adult-work",
            gutenberg_id: 1342,
            title: "Pride and Prejudice",
            metadata_json: {},
            language: null,
            release_date: null,
            rights_status: "public_domain",
            summary: "A fiction novel of mourning and grief.",
            authors: ["Jane Austen"],
            subjects: ["Fiction", "Courtship"],
            score: 2,
          },
        ] as T[],
      };
    },
    async end() {},
  });

  const results = await store.searchWorks("grief mourning bereavement funeral orphan", {
    language: "en",
    yearRange: [1800, 1899],
    genre: ["fiction"],
  });

  assert.equal(results[0]?.id, "adult-work");
  assert.ok(
    seenParams.some((params) => params[2] === null && params[3] === null),
    "expected a relaxed query without yearRange after low-signal grief hits",
  );
});

test("sql metadata search relaxes sparse year and language filters after empty discovery", async () => {
  const seenParams: unknown[][] = [];
  let queryCount = 0;
  const store = new NeonAppStore({
    async query<T = Record<string, unknown>>(_sql: string, params?: unknown[]) {
      queryCount += 1;
      seenParams.push(params ?? []);
      if (queryCount < 5) {
        return { rows: [] as T[] };
      }
      return {
        rows: [
          {
            id: "work-fiction",
            gutenberg_id: 1342,
            title: "Pride and Prejudice",
            metadata_json: {},
            language: null,
            release_date: null,
            rights_status: "public_domain",
            summary: "A fiction novel of mourning and grief.",
            authors: ["Jane Austen"],
            subjects: ["Fiction", "Courtship"],
            score: 2,
          },
        ] as T[],
      };
    },
    async end() {},
  });

  const results = await store.searchWorks("grief mourning bereavement funeral widow", {
    language: "en",
    yearRange: [1800, 1899],
    genre: ["fiction"],
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.id, "work-fiction");
  assert.ok(
    seenParams.some((params) => params[2] === null && params[3] === null),
    "expected a relaxed query without yearRange",
  );
  assert.ok(
    seenParams.some((params) => params[1] === null),
    "expected a relaxed query without language",
  );
});

test("sql metadata search downranks juvenile orphan results for grief queries when adult grief matches exist", async () => {
  const store = new NeonAppStore({
    async query<T = Record<string, unknown>>() {
      return {
        rows: [
          {
            id: "juvenile-work",
            gutenberg_id: 19514,
            title: "A Little Princess",
            metadata_json: {},
            language: "en",
            release_date: "1905-01-01",
            rights_status: "public_domain",
            summary: "An orphan girl at a boarding school.",
            authors: ["Frances Hodgson Burnett"],
            subjects: ["Orphans -- Juvenile fiction", "Girls -- Juvenile fiction", "PZ"],
            score: 1.4,
          },
          {
            id: "adult-work",
            gutenberg_id: 1342,
            title: "Pride and Prejudice",
            metadata_json: {},
            language: "en",
            release_date: "1813-01-28",
            rights_status: "public_domain",
            summary: "A fiction novel with mourning, grief, and family sorrow.",
            authors: ["Jane Austen"],
            subjects: ["Fiction", "Courtship"],
            score: 1.0,
          },
        ] as T[],
      };
    },
    async end() {},
  });

  const results = await store.searchWorks("grief mourning bereavement funeral 1800 1899 fiction", {
    language: "en",
    yearRange: [1800, 1899],
    genre: ["fiction"],
  });

  assert.equal(results[0]?.id, "adult-work");
  assert.equal(results[1]?.id, "juvenile-work");
});

test("sql metadata search broadens grief queries with additional mourning terms", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const store = new NeonAppStore({
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [] as T[] };
    },
    async end() {},
  });

  await store.searchWorks("grief fiction", {
    language: "en",
    genre: ["fiction"],
  });

  const firstQueryParams = queries[0]?.params ?? [];
  assert.match(String(firstQueryParams[0] ?? ""), /mourning/);
  assert.match(String(firstQueryParams[0] ?? ""), /sorrow/);
  assert.match(String(firstQueryParams[0] ?? ""), /funeral/);
  assert.doesNotMatch(String(firstQueryParams[0] ?? ""), /dead/);
  assert.doesNotMatch(String(firstQueryParams[0] ?? ""), /death/);
});

test("sql metadata search overfetches and forces chunk expansion for broad survey queries", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const store = new NeonAppStore({
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (queries.length === 1) {
        return {
          rows: Array.from({ length: 12 }, (_, index) => ({
            id: `work-${index + 1}`,
            gutenberg_id: 1000 + index,
            title: `Survey Work ${index + 1}`,
            metadata_json: {},
            language: "en",
            release_date: "1850-01-01",
            rights_status: "public_domain",
            summary: "A fiction work about grief, mourning, and sorrow.",
            authors: ["Author"],
            subjects: ["Fiction", "Grief"],
            score: 5 - index * 0.05,
          })) as T[],
        };
      }
      return { rows: [] as T[] };
    },
    async end() {},
  });

  const results = await store.searchWorks(
    "Identify the different ways characters deal with grief across 19th century fiction",
    {
      language: "en",
      yearRange: [1800, 1899],
      genre: ["fiction"],
      limit: 12,
    },
  );

  assert.equal(results.length, 12);
  assert.ok((queries[0]?.params?.[6] as number) > 12, "expected metadata overfetch for broad survey query");
  assert.ok(queries.some((query) => /chunk_matches AS \(/.test(query.sql)), "expected broad survey query to force chunk expansion");
});

test("sql metadata search downranks death-title matches without stronger grief evidence", async () => {
  const store = new NeonAppStore({
    async query<T = Record<string, unknown>>() {
      return {
        rows: [
          {
            id: "dead-title",
            gutenberg_id: 23053,
            title: "Night of the Living Dead",
            metadata_json: {},
            language: "en",
            release_date: "1968-01-01",
            rights_status: "public_domain",
            summary: "A horror drama about the living dead.",
            authors: ["George A. Romero"],
            subjects: ["Dead -- Drama", "Horror films", "Science fiction"],
            score: 2.3,
          },
          {
            id: "mourning-title",
            gutenberg_id: 1342,
            title: "The Mourning Bride",
            metadata_json: {},
            language: "en",
            release_date: "1813-01-28",
            rights_status: "public_domain",
            summary: "A fiction work of grief, mourning, and sorrow.",
            authors: ["Jane Austen"],
            subjects: ["Fiction", "Mourning", "Grief"],
            score: 1.1,
          },
        ] as T[],
      };
    },
    async end() {},
  });

  const results = await store.searchWorks("grief mourning bereavement funeral 1800 1899 fiction", {
    language: "en",
    yearRange: [1800, 1899],
    genre: ["fiction"],
  });

  assert.equal(results[0]?.id, "mourning-title");
  assert.equal(results[1]?.id, "dead-title");
});

test("sql metadata search downranks nonfiction grief-adjacent books when the query asks for fiction", async () => {
  const store = new NeonAppStore({
    async query<T = Record<string, unknown>>() {
      return {
        rows: [
          {
            id: "nonfiction-work",
            gutenberg_id: 71993,
            title: "The danger of premature interment",
            metadata_json: {},
            language: "en",
            release_date: "1885-01-01",
            rights_status: "public_domain",
            summary: "A medical and historical discussion of burial, funeral rites, and premature interment.",
            authors: ["Joseph Taylor"],
            subjects: ["Burial, Premature", "Funeral rites and ceremonies", "Biography"],
            score: 2.7,
          },
          {
            id: "fiction-work",
            gutenberg_id: 76886,
            title: "Dead-sea fruit, Vol. 2 (of 3)",
            metadata_json: {},
            language: "en",
            release_date: "1860-01-01",
            rights_status: "public_domain",
            summary: "A 19th-century fiction novel with mourning, grief, and despair.",
            authors: ["M. E. Braddon"],
            subjects: ["English fiction -- 19th century", "PR"],
            score: 1.9,
          },
        ] as T[],
      };
    },
    async end() {},
  });

  const results = await store.searchWorks("grief mourning funeral 19th century fiction novel short fiction", {
    language: "en",
    yearRange: [1800, 1899],
    genre: ["fiction"],
  });

  assert.equal(results[0]?.id, "fiction-work");
  assert.equal(results[1]?.id, "nonfiction-work");
});

test("OpenAIEmbedder requests 1536 dimensions for text-embedding-3 models", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const embedder = new OpenAIEmbedder("test-key", "text-embedding-3-small", async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return Response.json({
      data: [
        {
          embedding: [0.1, 0.2, 0.3],
        },
      ],
    });
  });

  const embedding = await embedder.embedQuery("anger");
  assert.deepEqual(embedding, [0.1, 0.2, 0.3]);
  assert.equal(requestBody ? requestBody["dimensions"] : undefined, 1536);
});

test("billing gate rejects chat requests once monthly spend exceeds limit", async () => {
  const store = new InMemoryAppStore();
  await store.ensureUser("billing-user");
  await store.createBillingEvent({
    userId: "billing-user",
    sessionId: null,
    runId: null,
    source: "planner",
    provider: "openai",
    model: "gpt-5.2",
    operation: "chat.completions.create",
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cachedInputTokens: 0,
    costUsd: 50.01,
    requestId: null,
    requestJson: null,
    responseJson: null,
    metadata: {},
  });

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new FallbackPlanner(),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    x402: {
      enabled: true,
      payTo: "0x1234",
      network: "base",
      asset: "USDC",
      maxAmountUsd: "5.00",
      description: "AlphaBook research access",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "billing-user",
      message: "Blocked",
    }),
  });

  assert.equal(response.status, 402);
  assert.ok(response.headers.get("payment-required"));
  const body = await response.json() as { code?: string; paymentRequirements?: { accepts?: unknown[] } | null };
  assert.equal(body.code, "billing_limit_exceeded");
  assert.equal(Array.isArray(body.paymentRequirements?.accepts), true);
});

test("billing blocked chat requests accept a valid x402 payment and return settlement headers", async () => {
  const store = new InMemoryAppStore();
  await store.ensureUser("billing-user");
  await store.createBillingEvent({
    userId: "billing-user",
    sessionId: null,
    runId: null,
    source: "planner",
    provider: "openai",
    model: "gpt-5.2",
    operation: "responses.create",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    costUsd: 50.01,
    requestId: null,
    requestJson: null,
    responseJson: null,
    metadata: {},
  });

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "direct_response",
        answer: "Paid access granted.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "planner should not run",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    x402: {
      enabled: true,
      payTo: "0x1234",
      network: "eip155:8453",
      asset: "USDC",
      maxAmountUsd: "5.00",
      description: "AlphaBook research access",
      facilitatorConfig: {
        url: "https://api.cdp.coinbase.com/platform/v2/x402",
        async createAuthHeaders() {
          return {
            verify: { authorization: "Bearer test" },
            settle: { authorization: "Bearer test" },
            supported: {},
          };
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/supported")) {
      return Response.json({
        kinds: [{ x402Version: 1, scheme: "exact", network: "eip155:8453" }],
        extensions: [],
        signers: {},
      });
    }
    if (url.endsWith("/verify")) {
      return Response.json({ isValid: true, payer: "0xpayer" });
    }
    if (url.endsWith("/settle")) {
      return Response.json({
        success: true,
        payer: "0xpayer",
        transaction: "0xtxn",
        network: "eip155:8453",
      });
    }
    throw new Error(`Unexpected fetch call: ${url} ${init?.method ?? "GET"}`);
  };

  try {
    const preflight = await app.request("/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: "billing-user",
        message: "Blocked",
      }),
    });
    const paymentRequiredHeader = preflight.headers.get("payment-required");
    assert.ok(paymentRequiredHeader);
    const accepted = decodePaymentRequiredHeader(paymentRequiredHeader).accepts[0];
    assert.ok(accepted);

    const response = await app.request("/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": encodePaymentSignatureHeader({
          x402Version: 1,
          accepted,
          payload: {
            signature: "0xabc",
          },
        }),
      },
      body: JSON.stringify({
        userId: "billing-user",
        message: "Blocked",
      }),
    });

    assert.equal(response.status, 200);
    assert.ok(response.headers.get("payment-response"));
    const body = await response.text();
    assert.match(body, /Paid access granted\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("billing tracker records OpenAI usage costs", async () => {
  const store = new InMemoryAppStore();
  const billing = createBillingService(store);

  await billing.track(
    {
      userId: "tracked-user",
      sessionId: "session-1",
      runId: "run-1",
      source: "planner",
    },
    {
      provider: "openai",
      model: "gpt-5.2",
      operation: "chat.completions.create",
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      cachedInputTokens: 200,
      metadata: {},
    },
  );

  const spend = await store.getBillingSpend("tracked-user", new Date(Date.now() - 60_000).toISOString());
  assert.equal(spend.eventCount, 1);
  assert.equal(spend.totalCostUsd, 0.006025);
});

test("error responses preserve CORS headers for allowed web origins", async () => {
  const store = new InMemoryAppStore([], []);
  store.getSession = async () => {
    throw new Error("boom");
  };

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([]),
    planner: new FallbackPlanner(),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/sessions/session-123/messages", {
    headers: {
      origin: "https://alpha-book.org",
    },
  });

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://alpha-book.org");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), "true");
});

test("runtime billing events are persisted even when the runtime call fails", async () => {
  const store = new InMemoryAppStore();
  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "run_workspace_task",
        args: {
          runtimeId: "runtime-1",
          taskSpec: {
            phase: "collect_and_brief",
          },
        },
      },
      {
        type: "final_answer",
        answer: "Stopped after the failed runtime.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: true, runtimeId: "runtime-1" };
      },
      async runWorkspaceTask() {
        const error = new Error("runtime failed") as Error & { runtimePayload?: Record<string, unknown> };
        error.runtimePayload = {
          billingEvents: [
            {
              provider: "openai",
              model: "gpt-5.2",
              operation: "responses.create",
              inputTokens: 2000,
              outputTokens: 300,
              totalTokens: 2300,
              cachedInputTokens: 500,
              requestId: "req_runtime_1",
            },
          ],
        };
        throw error;
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "runtime-billing-user",
      message: "Run the VM task.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();
  const spend = await store.getBillingSpend("runtime-billing-user", new Date(Date.now() - 60_000).toISOString());
  assert.equal(spend.eventCount, 1);
  assert.equal(spend.totalCostUsd, 0.004937);
});

test("public profile endpoints expose follow state", async () => {
  const store = new InMemoryAppStore();
  await store.upsertUserProfile({
    id: "viewer",
    email: "viewer@example.com",
    name: "Viewer",
  });
  await store.upsertUserProfile({
    id: "author",
    email: "author@example.com",
    name: "Author",
  });

  const app = createApp({
    store,
    billing: createBillingService(store),
    planner: new ScriptedPlanner([
      {
        type: "final_answer",
        answer: "ok",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false };
      },
      async runWorkspaceTask() {
        return { ok: false };
      },
      async readWorkspaceFile() {
        return { ok: false };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const initialProfileResponse = await app.request("/profiles/author?userId=viewer");
  assert.equal(initialProfileResponse.status, 200);
  const initialProfile = (await initialProfileResponse.json()) as {
    profile: { followersCount: number; email: string | null };
    isFollowing: boolean;
  };
  assert.equal(initialProfile.isFollowing, false);
  assert.equal(initialProfile.profile.followersCount, 0);
  assert.equal(initialProfile.profile.email, null);

  const followResponse = await app.request("/profiles/author/follow?userId=viewer", {
    method: "POST",
  });
  assert.equal(followResponse.status, 200);
  const followPayload = (await followResponse.json()) as {
    profile: { followersCount: number };
    isFollowing: boolean;
  };
  assert.equal(followPayload.isFollowing, true);
  assert.equal(followPayload.profile.followersCount, 1);

  const unfollowResponse = await app.request("/profiles/author/follow?userId=viewer", {
    method: "DELETE",
  });
  assert.equal(unfollowResponse.status, 200);
  const unfollowPayload = (await unfollowResponse.json()) as {
    profile: { followersCount: number };
    isFollowing: boolean;
  };
  assert.equal(unfollowPayload.isFollowing, false);
  assert.equal(unfollowPayload.profile.followersCount, 0);
});

test("in-memory retrieval expands conversational relationship queries into seed passages", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 1342,
        title: "Pride and Prejudice",
        language: "en",
        releaseDate: "2001-01-01",
        rightsStatus: "public_domain",
        summary: "A novel of courtship, separation, and eventual marriage.",
        authors: ["Jane Austen"],
        subjects: ["courtship"],
      },
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 21,
        text: "After a painful separation, the lovers were reconciled and finally married.",
        r2Key: "gutenberg/clean/1342/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );

  const works = await store.searchWorks("hey there find me passages where people who broke up got back together");
  const chunks = await store.getRelevantChunks("hey there find me passages where people who broke up got back together");

  assert.equal(works.length, 1);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.text ?? "", /reconciled/i);
});

test("in-memory passage retrieval honors year and genre filters", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-fiction",
        gutenbergId: 1342,
        title: "Pride and Prejudice",
        language: "en",
        releaseDate: "1813-01-28",
        rightsStatus: "public_domain",
        summary: "A fiction novel of courtship, loss, and recovery.",
        authors: ["Jane Austen"],
        subjects: ["Fiction", "Courtship"],
      },
      {
        id: "work-nonfiction",
        gutenbergId: 9999,
        title: "A Treatise on Mourning",
        language: "en",
        releaseDate: "1850-01-01",
        rightsStatus: "public_domain",
        summary: "A nonfiction essay about grief customs.",
        authors: ["Essayist"],
        subjects: ["Essays", "Religion"],
      },
      {
        id: "work-fiction-outside-range",
        gutenbergId: 7777,
        title: "Modern Grief Novel",
        language: "en",
        releaseDate: "1920-01-01",
        rightsStatus: "public_domain",
        summary: "A fiction novel about grief.",
        authors: ["Later Author"],
        subjects: ["Fiction"],
      },
    ],
    [
      {
        id: "chunk-fiction",
        workId: "work-fiction",
        chunkIndex: 1,
        text: "She wept in mourning and slowly returned to society.",
        r2Key: "fiction/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
      {
        id: "chunk-nonfiction",
        workId: "work-nonfiction",
        chunkIndex: 1,
        text: "This essay describes mourning customs in abstract terms.",
        r2Key: "essay/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
      {
        id: "chunk-outside-range",
        workId: "work-fiction-outside-range",
        chunkIndex: 1,
        text: "A modern fiction account of grief and mourning.",
        r2Key: "modern/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );

  const chunks = await store.getRelevantChunks(
    "mourning grief fiction",
    undefined,
    8,
    undefined,
    {
      yearRange: [1800, 1899],
      genre: ["fiction"],
    },
  );

  assert.deepEqual(chunks.map((chunk) => chunk.workId), ["work-fiction"]);
});

test("sql retrieval bounds semantic candidates instead of scanning every embedded chunk", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const store = new NeonAppStore({
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [] as T[] };
    },
    async end() {},
  });

  await store.getRelevantChunks(
    "grief and mourning in fiction",
    ["11111111-1111-1111-1111-111111111111"],
    8,
    new Array(1536).fill(0.25),
  );

  const issued = queries.at(-1);
  assert.ok(issued, "expected a chunks query to run");
  assert.match(issued.sql, /semantic_candidates AS \(/);
  assert.match(issued.sql, /ORDER BY c\.embedding <=> query_input\.embedding/);
  assert.match(issued.sql, /LIMIT \$6/);
  assert.doesNotMatch(issued.sql, /OR \(query_input\.embedding IS NOT NULL AND c\.embedding IS NOT NULL\)/);
  assert.equal(issued.params?.[5], 96);
});

test("passage search inherits candidate work ids from the latest metadata search", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 111,
        title: "Grief Novel",
        language: "en",
        releaseDate: "1850-01-01",
        rightsStatus: "public_domain",
        summary: "A fiction novel about grief.",
        authors: ["Author One"],
        subjects: ["Fiction"],
      },
      {
        id: "work-2",
        gutenbergId: 222,
        title: "Mourning Tale",
        language: "en",
        releaseDate: "1860-01-01",
        rightsStatus: "public_domain",
        summary: "A fiction tale about mourning.",
        authors: ["Author Two"],
        subjects: ["Fiction"],
      },
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 1,
        text: "The heroine endured grief with stoic composure.",
        r2Key: "work-1/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
      {
        id: "chunk-2",
        workId: "work-2",
        chunkIndex: 1,
        text: "The mourner turned to prayer and work.",
        r2Key: "work-2/chunks.jsonl",
        score: 0,
        excerpt: "",
      },
    ],
  );

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "grief in fiction",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "search_works",
        args: {
          query: "grief in fiction",
          filters: {
            yearRange: [1800, 1899],
            genre: ["fiction"],
          },
        },
      },
      {
        type: "tool_call",
        tool_name: "get_relevant_chunks",
        args: {
          query: "grief mourning prayer work",
          filters: {
            yearRange: [1800, 1899],
            genre: ["fiction"],
          },
        },
      },
      {
        type: "final_answer",
        answer: "done",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: true, reused: false, runtimeId: "runtime-1", manifest: { works: [] } };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, error: "disabled" };
      },
      async destroyWorkspace() {
        return { ok: false, error: "disabled" };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
    ai: {
      async run<ModelInput extends Record<string, unknown>, ModelOutput = unknown>(): Promise<ModelOutput> {
        return { response: "Grief Taxonomy" } as ModelOutput;
      },
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "11111111-1111-1111-1111-111111111111",
      message: "Find grief passages in fiction",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();
  const sessions = await store.listSessions("11111111-1111-1111-1111-111111111111");
  const runs = await store.listRuns(sessions[0]!.id);
  const toolCalls = await store.listToolCalls(runs[0]!.id);
  const passageSearch = toolCalls.find((toolCall) => toolCall.toolName === "get_relevant_chunks");
  assert.ok(passageSearch);
  assert.deepEqual(passageSearch.argsJson.workIds, ["work-1", "work-2"]);
  assert.deepEqual(passageSearch.argsJson.filters, {
    yearRange: [1800, 1899],
    genre: ["fiction"],
  });
});

test("search_works inherits fiction genre from the routed query when planner omits it", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 111,
        title: "Grief Novel",
        language: "en",
        releaseDate: null,
        rightsStatus: "public_domain",
        summary: "A fiction novel about grief.",
        authors: ["Author One"],
        subjects: ["Fiction"],
      },
    ],
    [],
  );

  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "Find grief in 19th century fiction.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "search_works",
        args: {
          query: "grief mourning bereavement widow funeral",
          filters: {
            yearRange: [1800, 1899],
            language: "en",
          },
        },
        rationale: "Locate fiction works about grief and mourning.",
      },
      {
        type: "final_answer",
        answer: "done",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: true, files: [] };
      },
      async destroyWorkspace() {
        return { ok: true };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "query-genre-user",
      message: "Find grief in 19th century fiction.",
    }),
  });
  await response.text();

  const sessions = await store.listSessions("query-genre-user");
  const runs = await store.listRuns(sessions[0]!.id);
  const toolCalls = await store.listToolCalls(runs[0]!.id);
  const searchCall = toolCalls.find((entry) => entry.toolName === "search_works");
  assert.ok(searchCall);
  assert.deepEqual(searchCall.argsJson.filters, {
    language: "en",
    yearRange: [1800, 1899],
    genre: ["fiction"],
  });
});

test("fallback planner estimates scope before starting retrieval or workspace setup", async () => {
  const planner = new FallbackPlanner();
  const decision = await planner.decide({
    userMessage: "Find broad grief patterns across 19th century fiction.",
    conversationHistory: [],
    turns: 1,
    toolHistory: [],
  });

  assert.equal(decision.type, "tool_call");
  assert.equal(decision.tool_name, "estimate_research_scope");
  assert.equal(decision.args.query, "Find broad grief patterns across 19th century fiction.");
});

test("estimateResearchScope returns budget and shard recommendations for broad queries", async () => {
  const store = new InMemoryAppStore(
    Array.from({ length: 90 }, (_, index) => ({
      id: `work-${index + 1}`,
      gutenbergId: index + 1,
      title: `Grief Story ${index + 1}`,
      language: "en",
      releaseDate: "1880-01-01",
      rightsStatus: "public_domain",
      summary: "A fiction work about grief, mourning, sorrow, loss, and consolation.",
      authors: [`Author ${index + 1}`],
      subjects: ["fiction", "grief", "mourning"],
      cleanTextKey: `gutenberg/clean/${index + 1}/clean.txt`,
    })),
    Array.from({ length: 240 }, (_, index) => ({
      id: `chunk-${index + 1}`,
      workId: `work-${(index % 90) + 1}`,
      chunkIndex: index,
      text: "The characters speak of grief, mourning, sorrow, and consolation after a death.",
      r2Key: `gutenberg/clean/${(index % 90) + 1}/chunks.jsonl`,
      score: 0,
      excerpt: "",
    })),
  );

  const estimate = await store.estimateResearchScope("Find broad grief patterns across 19th century fiction.");

  assert.equal(estimate.recommendedIntensity, "maximum");
  assert.equal(estimate.recommendedWallClockMinutes, 60);
  assert.ok(estimate.recommendedParallelism >= 4);
  assert.ok(estimate.recommendedFrontierWorks >= 72);
  assert.ok(estimate.chunkMatchEstimate > 0);
  assert.ok(estimate.metadataWorkEstimate > 0);
  assert.equal(estimate.recommendedShards.length, estimate.recommendedParallelism);
  assert.equal(estimate.recommendedShards[0]?.axis, estimate.recommendedShardAxis);
  assert.ok((estimate.recommendedShards[0]?.targetWorkCount ?? 0) > 0);
});

test("estimateResearchScope prefers retrieval-strategy sharding for hypothesis queries", async () => {
  const store = new InMemoryAppStore(
    Array.from({ length: 60 }, (_, index) => ({
      id: `work-${index + 1}`,
      gutenbergId: index + 1,
      title: `Moral Grief Novel ${index + 1}`,
      language: "en",
      releaseDate: "1880-01-01",
      rightsStatus: "public_domain",
      summary: "A fiction work about grief, conscience, virtue, and moral transformation.",
      authors: [`Author ${index + 1}`],
      subjects: ["fiction", "grief", "mourning"],
      cleanTextKey: `gutenberg/clean/${index + 1}/clean.txt`,
    })),
    Array.from({ length: 180 }, (_, index) => ({
      id: `chunk-${index + 1}`,
      workId: `work-${(index % 60) + 1}`,
      chunkIndex: index,
      text: "The characters speak of grief, virtue, remorse, and moral purification.",
      r2Key: `gutenberg/clean/${(index % 60) + 1}/chunks.jsonl`,
      score: 0,
      excerpt: "",
    })),
  );

  const estimate = await store.estimateResearchScope("Test the hypothesis that grief in 19th century fiction is morally purifying.");

  assert.equal(estimate.recommendedShardAxis, "retrieval_strategy");
  assert.ok(estimate.recommendedShards.some((shard) => shard.strategy === "supporting_evidence"));
  assert.ok(estimate.recommendedShards.some((shard) => shard.strategy === "opposing_evidence"));
});

test("fallback planner carries shard planning into workspace task specs for broad queries", async () => {
  const planner = new FallbackPlanner();
  const decision = await planner.decide({
    userMessage: "Find broad grief patterns across 19th century fiction.",
    conversationHistory: [],
    turns: 4,
    toolHistory: [
      {
        toolName: "estimate_research_scope",
        args: {
          query: "Find broad grief patterns across 19th century fiction.",
        },
        result: {
          recommendedIntensity: "maximum",
          recommendedWallClockMinutes: 60,
          recommendedParallelism: 8,
          recommendedShardAxis: "work_id_hash",
          recommendedFrontierWorks: 128,
          recommendedShards: Array.from({ length: 8 }, (_, index) => ({
            shardId: `work-hash-${index + 1}`,
            index,
            totalShards: 8,
            axis: "work_id_hash",
            label: `Work hash shard ${index + 1}`,
            targetWorkCount: 16,
            estimatedCoveragePercent: 100,
          })),
        },
      },
      {
        toolName: "create_workspace",
        args: {
          workIds: [],
          chunkIds: [],
          taskContext: {},
        },
        result: {
          ok: true,
          runtimeId: "runtime-1",
        },
      },
      {
        toolName: "search_works",
        args: {
          query: "Find broad grief patterns across 19th century fiction.",
        },
        result: {
          works: Array.from({ length: 20 }, (_, index) => ({
            id: `work-${index + 1}`,
            title: `Work ${index + 1}`,
            authors: [`Author ${index + 1}`],
            summary: "A work about grief and mourning.",
            subjects: ["grief", "mourning"],
            gutenbergId: index + 1,
          })),
          frontier: {
            workCount: 40,
            works: Array.from({ length: 40 }, (_, index) => ({
              id: `work-${index + 1}`,
              title: `Work ${index + 1}`,
              authors: [`Author ${index + 1}`],
              summary: "A work about grief and mourning.",
              subjects: ["grief", "mourning"],
              gutenbergId: index + 1,
            })),
          },
        },
      },
      {
        toolName: "get_work_metadata",
        args: {
          workIds: Array.from({ length: 12 }, (_, index) => `work-${index + 1}`),
        },
        result: {
          works: Array.from({ length: 12 }, (_, index) => ({
            id: `work-${index + 1}`,
            title: `Work ${index + 1}`,
            authors: [`Author ${index + 1}`],
            summary: "A work about grief and mourning.",
            subjects: ["grief", "mourning"],
            gutenbergId: index + 1,
          })),
        },
      },
      {
        toolName: "get_relevant_chunks",
        args: {
          query: "Find broad grief patterns across 19th century fiction.",
        },
        result: {
          chunks: Array.from({ length: 16 }, (_, index) => ({
            id: `chunk-${index + 1}`,
            workId: `work-${(index % 16) + 1}`,
            chunkIndex: index,
            excerpt: "A grief passage.",
            r2Key: `gutenberg/clean/${index + 1}/chunks.jsonl`,
          })),
        },
      },
    ],
  });

  assert.equal(decision.type, "tool_call");
  assert.equal(decision.tool_name, "run_workspace_task");
  const taskSpec = decision.args.taskSpec as Record<string, unknown>;
  assert.equal(taskSpec.parallelism, 8);
  assert.equal(taskSpec.shardAxis, "work_id_hash");
  assert.ok(Array.isArray(taskSpec.shardPlan));
  assert.equal((taskSpec.shardPlan as unknown[]).length, 8);
  assert.ok(Array.isArray(taskSpec.frontierWorkIds));
  assert.equal((taskSpec.frontierWorkIds as unknown[]).length, 40);
  assert.ok(Array.isArray(taskSpec.candidateWorkIds));
  assert.ok((taskSpec.candidateWorkIds as unknown[]).length >= 16);
  assert.ok((taskSpec.candidateWorkIds as unknown[]).length < (taskSpec.frontierWorkIds as unknown[]).length);
  assert.ok(Array.isArray(taskSpec.verifiedWorkIds));
  assert.ok((taskSpec.verifiedWorkIds as unknown[]).length > 0);
});

test("fallback planner marks hypothesis-test runs with supporting and opposing evidence hints", async () => {
  const planner = new FallbackPlanner();
  const decision = await planner.decide({
    userMessage: "Test the hypothesis that 19th century fiction treats grief as morally purifying.",
    conversationHistory: [],
    turns: 4,
    toolHistory: [
      {
        toolName: "estimate_research_scope",
        args: {
          query: "Test the hypothesis that 19th century fiction treats grief as morally purifying.",
        },
        result: {
          recommendedIntensity: "maximum",
          recommendedWallClockMinutes: 60,
          recommendedParallelism: 8,
          recommendedShardAxis: "retrieval_strategy",
          recommendedFrontierWorks: 96,
          recommendedShards: Array.from({ length: 8 }, (_, index) => ({
            shardId: `retrieval-strategy-${index + 1}`,
            index,
            totalShards: 8,
            axis: "retrieval_strategy",
            label: `Strategy shard ${index + 1}`,
            targetWorkCount: 12,
            estimatedCoveragePercent: 100,
            strategy: index === 0 ? "supporting_evidence" : "opposing_evidence",
          })),
        },
      },
      {
        toolName: "create_workspace",
        args: {
          workIds: [],
          chunkIds: [],
          taskContext: {},
        },
        result: {
          ok: true,
          runtimeId: "runtime-1",
        },
      },
      {
        toolName: "search_works",
        args: {
          query: "Test the hypothesis that 19th century fiction treats grief as morally purifying.",
        },
        result: {
          works: Array.from({ length: 20 }, (_, index) => ({
            id: `work-${index + 1}`,
            title: `Work ${index + 1}`,
            authors: [`Author ${index + 1}`],
          })),
          frontier: {
            workCount: 40,
            works: Array.from({ length: 40 }, (_, index) => ({
              id: `work-${index + 1}`,
              title: `Work ${index + 1}`,
              authors: [`Author ${index + 1}`],
            })),
          },
        },
      },
      {
        toolName: "get_relevant_chunks",
        args: {
          query: "Test the hypothesis that 19th century fiction treats grief as morally purifying.",
        },
        result: {
          chunks: Array.from({ length: 12 }, (_, index) => ({
            id: `chunk-${index + 1}`,
            workId: `work-${index + 1}`,
            chunkIndex: index,
            excerpt: "A relevant passage.",
            r2Key: `gutenberg/clean/${index + 1}/chunks.jsonl`,
          })),
        },
      },
    ],
  });

  assert.equal(decision.type, "tool_call");
  assert.equal(decision.tool_name, "get_work_metadata");

  const nextDecision = await planner.decide({
    userMessage: "Test the hypothesis that 19th century fiction treats grief as morally purifying.",
    conversationHistory: [],
    turns: 5,
    toolHistory: [
      {
        toolName: "estimate_research_scope",
        args: { query: "Test the hypothesis that 19th century fiction treats grief as morally purifying." },
        result: {
          recommendedIntensity: "maximum",
          recommendedWallClockMinutes: 60,
          recommendedParallelism: 8,
          recommendedShardAxis: "retrieval_strategy",
          recommendedFrontierWorks: 96,
          recommendedShards: [],
        },
      },
      { toolName: "create_workspace", args: { workIds: [], chunkIds: [], taskContext: {} }, result: { ok: true, runtimeId: "runtime-1" } },
      { toolName: "search_works", args: { query: "Test the hypothesis that 19th century fiction treats grief as morally purifying." }, result: { works: [], frontier: { workCount: 0, works: [] } } },
      { toolName: "get_relevant_chunks", args: { query: "Test the hypothesis that 19th century fiction treats grief as morally purifying." }, result: { chunks: Array.from({ length: 12 }, (_, index) => ({ id: `chunk-${index + 1}`, workId: `work-${index + 1}`, chunkIndex: index, excerpt: "A relevant passage." })) } },
      { toolName: "get_work_metadata", args: { workIds: Array.from({ length: 12 }, (_, index) => `work-${index + 1}`) }, result: { works: [] } },
    ],
  });

  assert.equal(nextDecision.type, "tool_call");
  assert.equal(nextDecision.tool_name, "run_workspace_task");
  const taskSpec = nextDecision.args.taskSpec as Record<string, unknown>;
  assert.equal(taskSpec.taskIntent, "hypothesis_test");
  const searchHints = taskSpec.searchHints as Record<string, unknown>;
  assert.match(String(searchHints.supportingEvidenceFocus ?? ""), /support/i);
  assert.match(String(searchHints.opposingEvidenceFocus ?? ""), /challenge|oppose/i);
  assert.equal(searchHints.synthesisMode, "verdict");
});

test("fallback planner marks short context-dependent turns as follow-up refinements", async () => {
  const planner = new FallbackPlanner();
  const decision = await planner.decide({
    userMessage: "Now just focus on religious consolation.",
    conversationHistory: [
      { role: "user", content: "Find grief passages across 19th century fiction." },
      { role: "assistant", content: "I found examples across several works and categories." },
    ],
    turns: 4,
    toolHistory: [
      {
        toolName: "estimate_research_scope",
        args: { query: "Now just focus on religious consolation." },
        result: {
          recommendedIntensity: "high",
          recommendedWallClockMinutes: 15,
          recommendedParallelism: 2,
          recommendedShardAxis: "retrieval_strategy",
          recommendedFrontierWorks: 40,
          recommendedShards: [],
        },
      },
      { toolName: "create_workspace", args: { workIds: [], chunkIds: [], taskContext: {} }, result: { ok: true, runtimeId: "runtime-1" } },
      { toolName: "search_works", args: { query: "Now just focus on religious consolation." }, result: { works: [], frontier: { workCount: 0, works: [] } } },
      { toolName: "get_relevant_chunks", args: { query: "Now just focus on religious consolation." }, result: { chunks: Array.from({ length: 8 }, (_, index) => ({ id: `chunk-${index + 1}`, workId: `work-${index + 1}`, chunkIndex: index, excerpt: "A relevant passage." })) } },
      { toolName: "get_work_metadata", args: { workIds: Array.from({ length: 8 }, (_, index) => `work-${index + 1}`) }, result: { works: [] } },
    ],
  });

  assert.equal(decision.type, "tool_call");
  assert.equal(decision.tool_name, "run_workspace_task");
  const taskSpec = decision.args.taskSpec as Record<string, unknown>;
  assert.equal(taskSpec.taskIntent, "follow_up_refinement");
  const followUpContext = taskSpec.followUpContext as Record<string, unknown>;
  assert.ok(Array.isArray(followUpContext.priorUserMessages));
  assert.match(String(followUpContext.priorAssistantSummary ?? ""), /found examples/i);
  const searchHints = taskSpec.searchHints as Record<string, unknown>;
  assert.equal(searchHints.synthesisMode, "follow_up");
});

test("fallback planner verifies passages over the wide frontier before VM narrowing", async () => {
  const planner = new FallbackPlanner();
  const decision = await planner.decide({
    userMessage: "Find broad grief patterns across 19th century fiction.",
    conversationHistory: [],
    turns: 4,
    toolHistory: [
      {
        toolName: "estimate_research_scope",
        args: {
          query: "Find broad grief patterns across 19th century fiction.",
        },
        result: {
          recommendedIntensity: "maximum",
          recommendedWallClockMinutes: 60,
          recommendedParallelism: 8,
          recommendedShardAxis: "work_id_hash",
          recommendedFrontierWorks: 64,
          recommendedShards: [],
        },
      },
      {
        toolName: "create_workspace",
        args: {
          workIds: [],
          chunkIds: [],
          taskContext: {},
        },
        result: {
          ok: true,
          runtimeId: "runtime-1",
        },
      },
      {
        toolName: "search_works",
        args: {
          query: "Find broad grief patterns across 19th century fiction.",
        },
        result: {
          works: Array.from({ length: 20 }, (_, index) => ({
            id: `visible-work-${index + 1}`,
            title: `Visible Work ${index + 1}`,
            authors: [`Author ${index + 1}`],
          })),
          frontier: {
            workCount: 64,
            works: Array.from({ length: 64 }, (_, index) => ({
              id: `frontier-work-${index + 1}`,
              title: `Frontier Work ${index + 1}`,
              authors: [`Author ${index + 1}`],
            })),
          },
        },
      },
      {
        toolName: "get_work_metadata",
        args: {
          workIds: Array.from({ length: 20 }, (_, index) => `frontier-work-${index + 1}`),
        },
        result: {
          works: Array.from({ length: 20 }, (_, index) => ({
            id: `frontier-work-${index + 1}`,
            title: `Frontier Work ${index + 1}`,
            authors: [`Author ${index + 1}`],
            summary: "A work about grief and mourning.",
            subjects: ["grief", "mourning"],
          })),
        },
      },
    ],
  });

  assert.equal(decision.type, "tool_call");
  assert.equal(decision.tool_name, "get_relevant_chunks");
  assert.match(decision.rationale ?? "", /wider ranked frontier/i);
  assert.ok(Array.isArray(decision.args.workIds));
  assert.ok((decision.args.workIds as unknown[]).length >= 60);
});

test("fallback planner asks for passage verification before metadata after search works on broad queries", async () => {
  const planner = new FallbackPlanner();
  const decision = await planner.decide({
    userMessage: "Find broad grief patterns across 19th century fiction.",
    conversationHistory: [],
    turns: 3,
    toolHistory: [
      {
        toolName: "estimate_research_scope",
        args: {
          query: "Find broad grief patterns across 19th century fiction.",
        },
        result: {
          recommendedIntensity: "maximum",
          recommendedWallClockMinutes: 60,
          recommendedParallelism: 8,
          recommendedShardAxis: "work_id_hash",
          recommendedFrontierWorks: 64,
          recommendedShards: [],
        },
      },
      {
        toolName: "create_workspace",
        args: {
          workIds: [],
          chunkIds: [],
          taskContext: {},
        },
        result: {
          ok: true,
          runtimeId: "runtime-1",
        },
      },
      {
        toolName: "search_works",
        args: {
          query: "Find broad grief patterns across 19th century fiction.",
        },
        result: {
          works: Array.from({ length: 24 }, (_, index) => ({
            id: `work-${index + 1}`,
            title: `Work ${index + 1}`,
            authors: [`Author ${index + 1}`],
          })),
          frontier: {
            workCount: 64,
            works: Array.from({ length: 64 }, (_, index) => ({
              id: `work-${index + 1}`,
              title: `Work ${index + 1}`,
              authors: [`Author ${index + 1}`],
            })),
          },
        },
      },
    ],
  });

  assert.equal(decision.type, "tool_call");
  assert.equal(decision.tool_name, "get_relevant_chunks");
});

test("broad passage search diversifies hits across works", async () => {
  const store = new InMemoryAppStore(
    Array.from({ length: 12 }, (_, index) => ({
      id: `work-${index + 1}`,
      gutenbergId: index + 1,
      title: `Grief Work ${index + 1}`,
      language: "en",
      releaseDate: "1880-01-01",
      rightsStatus: "public_domain",
      summary: "A broad fiction work about grief and mourning.",
      authors: [`Author ${index + 1}`],
      subjects: ["fiction", "grief"],
      cleanTextKey: `gutenberg/clean/${index + 1}/clean.txt`,
    })),
    Array.from({ length: 72 }, (_, index) => ({
      id: `chunk-${index + 1}`,
      workId: `work-${(index % 12) + 1}`,
      chunkIndex: index,
      text: `Grief and mourning passage ${index + 1} about sorrow, consolation, and loss in fiction.`,
      r2Key: `gutenberg/clean/${(index % 12) + 1}/chunks.jsonl`,
      score: 0,
      excerpt: "",
    })),
  );

  const chunks = await store.getRelevantChunks(
    "Find broad grief patterns across 19th century fiction.",
    Array.from({ length: 12 }, (_, index) => `work-${index + 1}`),
    24,
  );

  assert.equal(chunks.length, 24);
  assert.ok(new Set(chunks.map((chunk) => chunk.workId)).size >= 8);
});

test("run metrics record candidate books from broad search_works passes", async () => {
  class FrontierMetricsStore extends InMemoryAppStore {
    override async searchWorks(): Promise<Awaited<ReturnType<InMemoryAppStore["searchWorks"]>>> {
      return Array.from({ length: 30 }, (_, index) => ({
        id: `work-${index + 1}`,
        gutenbergId: index + 1,
        title: `Grief Work ${index + 1}`,
        language: "en",
        releaseDate: "1880-01-01",
        rightsStatus: "public_domain",
        summary: "A broad fiction work about grief and mourning.",
        authors: [`Author ${index + 1}`],
        subjects: ["fiction", "grief", "mourning"],
        metadata: {},
      }));
    }
  }

  const store = new FrontierMetricsStore(
    Array.from({ length: 30 }, (_, index) => ({
      id: `work-${index + 1}`,
      gutenbergId: index + 1,
      title: `Grief Work ${index + 1}`,
      language: "en",
      releaseDate: "1880-01-01",
      rightsStatus: "public_domain",
      summary: "A broad fiction work about grief and mourning.",
      authors: [`Author ${index + 1}`],
      subjects: ["fiction", "grief", "mourning"],
      cleanTextKey: `gutenberg/clean/${index + 1}/clean.txt`,
    })),
    [],
  );
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "Survey grief mourning fiction across the corpus.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "search_works",
        args: {
          query: "Survey grief mourning fiction across the corpus.",
          filters: {
            limit: 24,
          },
        },
      },
      {
        type: "final_answer",
        answer: "Finished the broad metadata pass.",
        citations: [],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, files: [] };
      },
      async destroyWorkspace() {
        return { ok: false };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "frontier-metrics-user",
      message: "Survey grief mourning fiction across the corpus.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();

  const sessions = await store.listSessions("frontier-metrics-user");
  const runs = await store.listRuns(sessions[0]!.id);
  const runDetailsResponse = await app.request(`/sessions/${sessions[0]!.id}/runs/${runs[0]!.id}`);
  assert.equal(runDetailsResponse.status, 200);
  const runDetailsPayload = (await runDetailsResponse.json()) as {
    metrics?: Record<string, unknown>;
  };
  assert.ok(typeof runDetailsPayload.metrics?.totalCandidateBooks === "number");
  assert.ok((runDetailsPayload.metrics?.totalCandidateBooks as number) >= 12);
});

test("synthesis preserves citation breadth across multiple verified works on broad runs", async () => {
  const store = new InMemoryAppStore(
    [
      {
        id: "work-1",
        gutenbergId: 1,
        title: "First Grief Novel",
        language: "en",
        releaseDate: "1880-01-01",
        rightsStatus: "public_domain",
        summary: "A novel about grief.",
        authors: ["Author One"],
        subjects: ["fiction", "grief"],
        cleanTextKey: "gutenberg/clean/1/clean.txt",
      },
      {
        id: "work-2",
        gutenbergId: 2,
        title: "Second Grief Novel",
        language: "en",
        releaseDate: "1881-01-01",
        rightsStatus: "public_domain",
        summary: "Another novel about grief.",
        authors: ["Author Two"],
        subjects: ["fiction", "grief"],
        cleanTextKey: "gutenberg/clean/2/clean.txt",
      },
      {
        id: "work-3",
        gutenbergId: 3,
        title: "Third Grief Novel",
        language: "en",
        releaseDate: "1882-01-01",
        rightsStatus: "public_domain",
        summary: "A third novel about grief.",
        authors: ["Author Three"],
        subjects: ["fiction", "grief"],
        cleanTextKey: "gutenberg/clean/3/clean.txt",
      },
    ],
    [
      {
        id: "chunk-1",
        workId: "work-1",
        chunkIndex: 1,
        text: "A first passage about grief and mourning.",
        r2Key: "gutenberg/clean/1/chunks.jsonl",
        score: 0,
        excerpt: "A first passage about grief and mourning.",
      },
      {
        id: "chunk-2",
        workId: "work-2",
        chunkIndex: 2,
        text: "A second passage about grief and mourning.",
        r2Key: "gutenberg/clean/2/chunks.jsonl",
        score: 0,
        excerpt: "A second passage about grief and mourning.",
      },
      {
        id: "chunk-3",
        workId: "work-3",
        chunkIndex: 3,
        text: "A third passage about grief and mourning.",
        r2Key: "gutenberg/clean/3/chunks.jsonl",
        score: 0,
        excerpt: "A third passage about grief and mourning.",
      },
    ],
  );
  const app = createApp({
    store,
    billing: createBillingService(store),
    router: new ScriptedRouter([
      {
        type: "tool_chain",
        fullQuery: "Survey grief mourning fiction across the corpus.",
      },
    ]),
    planner: new ScriptedPlanner([
      {
        type: "tool_call",
        tool_name: "get_relevant_chunks",
        args: {
          query: "Survey grief mourning fiction across the corpus.",
          workIds: ["work-1", "work-2", "work-3"],
          filters: {
            limit: 3,
          },
        },
      },
      {
        type: "final_answer",
        answer: "Here is the synthesis.",
        citations: [
          {
            workId: "work-1",
            chunkId: "chunk-1",
            label: "work-1#1",
            excerpt: "A first passage about grief and mourning.",
          },
        ],
      },
    ]),
    embedder: new HashEmbedder(),
    synthesizer: new NarrowCitationSynthesizer(),
    blobStore: new MemoryBlobStore(),
    runtimeGateway: {
      async createWorkspace() {
        return { ok: false, error: "disabled" };
      },
      async runWorkspaceTask() {
        return { ok: false, error: "disabled" };
      },
      async readWorkspaceFile() {
        return { ok: false, error: "disabled" };
      },
      async listWorkspaceFiles() {
        return { ok: false, files: [] };
      },
      async destroyWorkspace() {
        return { ok: false };
      },
    },
    queues: {
      ingestName: "alphabook-ingest",
      jobsName: "alphabook-jobs",
    },
  });

  const response = await app.request("/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      userId: "citation-breadth-user",
      message: "Survey grief mourning fiction across the corpus.",
    }),
  });

  assert.equal(response.status, 200);
  await response.text();

  const sessions = await store.listSessions("citation-breadth-user");
  const messages = await store.listMessages(sessions[0]!.id);
  const finalAssistant = [...messages].reverse().find((message) => message.role === "assistant" && message.metadata?.phase === "answer");
  assert.ok(finalAssistant);
  const citations = Array.isArray(finalAssistant?.metadata?.citations) ? finalAssistant?.metadata?.citations as Array<Record<string, unknown>> : [];
  assert.ok(new Set(citations.map((citation) => citation.workId)).size >= 3);
});
