import test from "node:test";
import assert from "node:assert/strict";

import { R2_PREFIXES } from "@alphabook/shared";

import { createApp } from "../src/app";
import { WorkOSAuth } from "../src/auth";
import { HashEmbedder } from "../src/embeddings";
import { MemoryBlobStore } from "../src/r2";
import { FallbackPlanner, ScriptedPlanner } from "../src/planner";
import { FlyMachinesRuntimeGateway } from "../src/runtime";
import { InMemoryAppStore } from "../src/store";
import type { SynthesisInput, SynthesisResult, Synthesizer } from "../src/synthesizer";

class EchoSynthesizer implements Synthesizer {
  async synthesize(input: SynthesisInput): Promise<SynthesisResult> {
    return {
      answer: input.plannerDraft ?? "No synthesized answer was available.",
      citations: input.plannerCitations,
    };
  }
}

const AUTH_STATE_COOKIE_NAME = "alphabook_auth_state=";

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
        query: "books about sadness",
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
      message: "Find me books about sadness",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /event: session\.created/);
  assert.match(body, /event: tool\.started/);
  assert.match(body, /event: tool\.completed/);
  assert.match(body, /event: assistant\.completed/);
  assert.match(body, /Don Quixote is the strongest match/);
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

test("fallback planner can create a Fly workspace, run a task, read summary.md, and answer", async () => {
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
        return Response.json({
          runtimeId: "machine-1",
          stdout: "completed",
          stderr: "",
          exitCode: 0,
          artifacts: [
            {
              filename: "summary.md",
              path: "output/summary.md",
              mimeType: "text/markdown",
            },
          ],
        });
      }
      if (url === "https://alphabook-runtime.fly.dev/file?path=output%2Fsummary.md" && method === "GET") {
        return Response.json({
          path: "output/summary.md",
          size: 56,
          encoding: "utf8",
          content: "# Summary\n\nComparative answer across the two novels.",
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    },
  );

  const app = createApp({
    store,
    planner: new FallbackPlanner(),
    embedder: new HashEmbedder(),
    synthesizer: new EchoSynthesizer(),
    blobStore,
    runtimeGateway,
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

  const artifact = await blobStore.getText(R2_PREFIXES.runtimeArtifact("machine-1", "summary.md"));
  assert.match(artifact ?? "", /Comparative answer across the two novels/);
  assert.ok(calls.some((call) => call.includes("api.machines.dev")));
  assert.ok(calls.some((call) => call.includes("/run-task")));
});

test("session endpoints expose chat history for the assistant UI", async () => {
  const app = createApp({
    store: new InMemoryAppStore(),
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
    ["user", "assistant"],
  );
});
