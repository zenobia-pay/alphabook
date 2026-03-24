import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
