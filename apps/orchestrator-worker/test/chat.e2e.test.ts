import test from "node:test";
import assert from "node:assert/strict";

import { R2_PREFIXES } from "@alphabook/shared";

import { createApp } from "../src/app";
import { WorkOSAuth } from "../src/auth";
import { HashEmbedder, OpenAIEmbedder } from "../src/embeddings";
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
      message: "Find me books about sadness",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /event: session\.created/);
  assert.match(body, /event: assistant\.plan/);
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

test("auth sign-out route clears local cookies and redirects through WorkOS logout when session exists", async () => {
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
  assert.equal(
    response.headers.get("location"),
    "https://api.workos.com/user_management/sessions/logout?session_id=session_123",
  );
  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.length, 2);
  assert.ok(setCookies.some((value) => value.startsWith("alphabook_session=")));
  assert.ok(setCookies.some((value) => value.startsWith("alphabook_auth_state=")));
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
    ["user", "assistant"],
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

  assert.deepEqual(capturedTaskContext, { prompt: "find angry passages" });

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
  assert.equal(runDetailsPayload.toolCalls.length, 1);
  assert.equal(runDetailsPayload.toolCalls[0]?.toolName, "create_workspace");
  assert.deepEqual(runDetailsPayload.toolCalls[0]?.argsJson.taskContext, "find angry passages");

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
    profile: { followersCount: number };
    isFollowing: boolean;
  };
  assert.equal(initialProfile.isFollowing, false);
  assert.equal(initialProfile.profile.followersCount, 0);

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
