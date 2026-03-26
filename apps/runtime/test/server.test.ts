import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import { createAlphaBookRuntimeServer } from "../src/server";

test("runtime server requires a shared auth token", () => {
  assert.throws(
    () => createAlphaBookRuntimeServer({ authToken: "" }),
    /RUNTIME_SHARED_TOKEN is required/,
  );
});

test("runtime server deduplicates concurrent prepare requests for the same runtime", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "alphabook-runtime-test-"));
  let downloadHits = 0;
  const sourceServer = createServer((request, response) => {
    if (request.url === "/book.txt") {
      downloadHits += 1;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("chapter one");
      }, 75);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", () => resolve()));
  const sourceAddress = sourceServer.address();
  assert.ok(sourceAddress && typeof sourceAddress === "object");
  const sourceUrl = `http://127.0.0.1:${sourceAddress.port}/book.txt`;

  const runtimeServer = createAlphaBookRuntimeServer({
    authToken: "test-token",
    workspaceRoot,
  });
  await new Promise<void>((resolve) => runtimeServer.listen(0, "127.0.0.1", () => resolve()));
  const runtimeAddress = runtimeServer.address();
  assert.ok(runtimeAddress && typeof runtimeAddress === "object");
  const runtimeUrl = `http://127.0.0.1:${runtimeAddress.port}`;
  const payload = {
    runtimeId: "runtime-1",
    sessionId: "session-1",
    works: [],
    dataSchema: {},
    fileCatalog: [],
    selectedChunkIds: [],
    selectedChunks: [],
    taskContext: {},
    downloads: [
      {
        sourceUrl,
        destinationPath: "books/work-1/clean.txt",
      },
    ],
  };

  try {
    const [first, second] = await Promise.all([
      fetch(`${runtimeUrl}/prepare`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
      fetch(`${runtimeUrl}/prepare`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(downloadHits, 1);
    assert.equal(
      await readFile(join(workspaceRoot, "books", "work-1", "clean.txt"), "utf8"),
      "chapter one",
    );
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => runtimeServer.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => sourceServer.close((error) => error ? reject(error) : resolve())),
    ]);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runtime task status reports the latest output activity while a task is still running", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "alphabook-runtime-status-"));
  const scriptPath = join(workspaceRoot, "fake-agent.mjs");
  const previousCommand = process.env.RUNTIME_AGENT_COMMAND;
  await writeFile(
    scriptPath,
    [
      "import { appendFile, writeFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      "",
      "const outputDir = process.env.ALPHABOOK_OUTPUT_DIR;",
      "if (!outputDir) throw new Error('missing output dir');",
      "await appendFile(join(outputDir, 'codex-progress.jsonl'), JSON.stringify({ type: 'research.note', message: 'started' }) + '\\n', 'utf8');",
      "await new Promise((resolve) => setTimeout(resolve, 250));",
      "await writeFile(join(outputDir, 'briefing.md'), '# Done\\n', 'utf8');",
      "await new Promise((resolve) => setTimeout(resolve, 400));",
    ].join("\n"),
    "utf8",
  );
  process.env.RUNTIME_AGENT_COMMAND = scriptPath;

  const runtimeServer = createAlphaBookRuntimeServer({
    authToken: "test-token",
    workspaceRoot,
  });
  await new Promise<void>((resolve) => runtimeServer.listen(0, "127.0.0.1", () => resolve()));
  const runtimeAddress = runtimeServer.address();
  assert.ok(runtimeAddress && typeof runtimeAddress === "object");
  const runtimeUrl = `http://127.0.0.1:${runtimeAddress.port}`;

  try {
    const runResponse = await fetch(`${runtimeUrl}/run-task`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runtimeId: "runtime-2",
        taskSpec: { runtimeId: "runtime-2", kind: "sprite_fanout_research" },
      }),
    });
    assert.equal(runResponse.status, 202);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const statusResponse = await fetch(`${runtimeUrl}/task-status`, {
      headers: {
        authorization: "Bearer test-token",
      },
    });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json() as Record<string, unknown>;
    assert.equal(status.status, "running");
    assert.equal(typeof status.lastOutputAt, "string");

    await new Promise((resolve) => setTimeout(resolve, 700));
  } finally {
    if (previousCommand === undefined) {
      delete process.env.RUNTIME_AGENT_COMMAND;
    } else {
      process.env.RUNTIME_AGENT_COMMAND = previousCommand;
    }
    await new Promise<void>((resolve, reject) => runtimeServer.close((error) => error ? reject(error) : resolve()));
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runtime prefers API key auth over shared Codex auth json", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "alphabook-runtime-auth-"));
  const scriptPath = join(workspaceRoot, "fake-agent-auth.mjs");
  const fakeHome = join(workspaceRoot, "home");
  const previousCommand = process.env.RUNTIME_AGENT_COMMAND;
  const previousHome = process.env.HOME;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousAuthJson = process.env.CODEX_AUTH_JSON;

  await writeFile(
    scriptPath,
    [
      "import { writeFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      "const outputDir = process.env.ALPHABOOK_OUTPUT_DIR;",
      "await writeFile(join(outputDir, 'briefing.md'), '# Done\\n', 'utf8');",
    ].join("\n"),
    "utf8",
  );

  process.env.RUNTIME_AGENT_COMMAND = scriptPath;
  process.env.HOME = fakeHome;
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:8080/openai-proxy/v1";
  process.env.CODEX_AUTH_JSON = JSON.stringify({ refresh_token: "shared-refresh-token" });

  const runtimeServer = createAlphaBookRuntimeServer({
    authToken: "test-token",
    workspaceRoot,
  });
  await new Promise<void>((resolve) => runtimeServer.listen(0, "127.0.0.1", () => resolve()));
  const runtimeAddress = runtimeServer.address();
  assert.ok(runtimeAddress && typeof runtimeAddress === "object");
  const runtimeUrl = `http://127.0.0.1:${runtimeAddress.port}`;

  try {
    const runResponse = await fetch(`${runtimeUrl}/run-task`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runtimeId: "runtime-auth",
        taskSpec: { runtimeId: "runtime-auth", kind: "sprite_fanout_research" },
      }),
    });
    assert.equal(runResponse.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await readFile(join(workspaceRoot, "output", "briefing.md"), "utf8"), "# Done\n");
    await assert.rejects(
      readFile(join(fakeHome, ".codex", "auth.json"), "utf8"),
      /ENOENT/,
    );
  } finally {
    if (previousCommand === undefined) {
      delete process.env.RUNTIME_AGENT_COMMAND;
    } else {
      process.env.RUNTIME_AGENT_COMMAND = previousCommand;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
    if (previousBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
    if (previousAuthJson === undefined) {
      delete process.env.CODEX_AUTH_JSON;
    } else {
      process.env.CODEX_AUTH_JSON = previousAuthJson;
    }
    await new Promise<void>((resolve, reject) => runtimeServer.close((error) => error ? reject(error) : resolve()));
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runtime OpenAI proxy injects bearer auth from OPENAI_API_KEY when Codex omits it", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "alphabook-runtime-proxy-"));
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousProxyBaseUrl = process.env.RUNTIME_OPENAI_PROXY_UPSTREAM_BASE_URL;

  let seenAuthorization = "";
  let seenPath = "";
  let seenBody = "";
  const upstreamServer = createServer(async (request, response) => {
    seenAuthorization = String(request.headers.authorization ?? "");
    seenPath = String(request.url ?? "");
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    seenBody = Buffer.concat(chunks).toString("utf8");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_123", output: [] }));
  });
  await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", () => resolve()));
  const upstreamAddress = upstreamServer.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}/v1`;

  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.RUNTIME_OPENAI_PROXY_UPSTREAM_BASE_URL = upstreamBaseUrl;

  const runtimeServer = createAlphaBookRuntimeServer({
    authToken: "test-token",
    workspaceRoot,
  });
  await new Promise<void>((resolve) => runtimeServer.listen(0, "127.0.0.1", () => resolve()));
  const runtimeAddress = runtimeServer.address();
  assert.ok(runtimeAddress && typeof runtimeAddress === "object");
  const runtimeUrl = `http://127.0.0.1:${runtimeAddress.port}`;

  try {
    const proxyResponse = await fetch(`${runtimeUrl}/openai-proxy/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2-codex",
        input: "hello",
      }),
    });
    assert.equal(proxyResponse.status, 200);
    assert.equal(seenAuthorization, "Bearer test-openai-key");
    assert.equal(seenPath, "/v1/responses");
    assert.match(seenBody, /"model":"gpt-5\.2-codex"/);
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousApiKey;
    }
    if (previousProxyBaseUrl === undefined) {
      delete process.env.RUNTIME_OPENAI_PROXY_UPSTREAM_BASE_URL;
    } else {
      process.env.RUNTIME_OPENAI_PROXY_UPSTREAM_BASE_URL = previousProxyBaseUrl;
    }
    await Promise.all([
      new Promise<void>((resolve, reject) => runtimeServer.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => upstreamServer.close((error) => error ? reject(error) : resolve())),
    ]);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
