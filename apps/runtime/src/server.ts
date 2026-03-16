import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { RUNTIME_AGENT_PROMPT, type RuntimeTaskResult, type WorkspaceManifest } from "@alphabook/shared";

const execFileAsync = promisify(execFile);

export interface RuntimeServerOptions {
  port?: number;
  workspaceRoot?: string;
  authToken?: string;
  r2Client?: S3Client;
  r2BucketName?: string;
}

interface WorkspaceDownload {
  r2Key?: string;
  sourceUrl?: string;
  destinationPath: string;
}

interface PrepareRequest {
  runtimeId: string;
  sessionId: string;
  works: WorkspaceManifest["works"];
  dataSchema?: WorkspaceManifest["dataSchema"];
  fileCatalog?: WorkspaceManifest["fileCatalog"];
  selectedChunkIds: string[];
  selectedChunks?: WorkspaceManifest["selectedChunks"];
  taskContext: Record<string, unknown>;
  downloads?: WorkspaceDownload[];
}

interface RunTaskRequest {
  runtimeId: string;
  taskSpec: Record<string, unknown>;
}

function createR2ClientFromEnv(): S3Client | null {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return null;
  }
  return new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

function createPaths(workspaceRoot: string) {
  return {
    books: join(workspaceRoot, "books"),
    chunks: join(workspaceRoot, "chunks"),
    context: join(workspaceRoot, "context"),
    output: join(workspaceRoot, "output"),
    scratch: join(workspaceRoot, "scratch"),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function json(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as T;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonIfPresent<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function safeJoin(root: string, targetPath: string): string {
  const fullPath = normalize(join(root, targetPath.replace(/^\/+/, "")));
  if (!fullPath.startsWith(root)) {
    throw new Error("Path escapes workspace.");
  }
  return fullPath;
}

async function ensureWorkspace(paths: ReturnType<typeof createPaths>) {
  await Promise.all(
    Object.values(paths).map(async (path) => {
      await mkdir(path, { recursive: true });
    }),
  );
}

async function resetWorkspace(paths: ReturnType<typeof createPaths>) {
  await Promise.all(
    Object.values(paths).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
  await ensureWorkspace(paths);
}

async function streamToString(stream: unknown): Promise<string> {
  if (stream && typeof stream === "object" && "transformToString" in stream && typeof stream.transformToString === "function") {
    return stream.transformToString();
  }
  if (stream && typeof stream === "object" && Symbol.asyncIterator in stream) {
    const parts: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array | Buffer | string>) {
      parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(parts).toString("utf8");
  }
  throw new Error("Unsupported object body.");
}

async function downloadFromR2(
  r2Client: S3Client,
  bucketName: string,
  r2Key: string,
): Promise<string> {
  let response;
  try {
    response = await r2Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: r2Key,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown R2 error";
    throw new Error(`Failed to download ${r2Key} from R2 bucket ${bucketName}: ${message}`);
  }
  if (!response.Body) {
    throw new Error(`R2 object ${r2Key} had no body.`);
  }
  return streamToString(response.Body);
}

async function downloadFiles(
  downloads: WorkspaceDownload[],
  workspaceRoot: string,
  r2Client: S3Client | null,
  r2BucketName: string | null,
) {
  for (const item of downloads) {
    const destination = safeJoin(workspaceRoot, item.destinationPath);
    await mkdir(dirname(destination), { recursive: true });

    if (item.r2Key) {
      if (!r2Client || !r2BucketName) {
        throw new Error("R2 hydration requested but runtime R2 credentials are not configured.");
      }
      const body = await downloadFromR2(r2Client, r2BucketName, item.r2Key);
      await writeFile(destination, body, "utf8");
      continue;
    }

    if (item.sourceUrl) {
      const response = await fetch(item.sourceUrl);
      if (!response.ok) {
        throw new Error(`Failed to download ${item.sourceUrl}: ${response.status}`);
      }
      await writeFile(destination, await response.text(), "utf8");
      continue;
    }

    throw new Error("Workspace download requires either r2Key or sourceUrl.");
  }
}

async function writeManifest(paths: ReturnType<typeof createPaths>, payload: PrepareRequest) {
  const manifest: WorkspaceManifest = {
    runtimeId: payload.runtimeId,
    sessionId: payload.sessionId,
    works: payload.works,
    dataSchema: payload.dataSchema,
    fileCatalog: payload.fileCatalog,
    selectedChunkIds: payload.selectedChunkIds,
    selectedChunks: payload.selectedChunks,
    taskContext: payload.taskContext,
  };
  await writeFile(join(paths.context, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

async function writeSelectedChunks(paths: ReturnType<typeof createPaths>, payload: PrepareRequest) {
  await writeFile(
    join(paths.context, "selected-chunks.json"),
    JSON.stringify(payload.selectedChunks ?? [], null, 2),
    "utf8",
  );
}

async function writeWorkspaceHelpers(paths: ReturnType<typeof createPaths>) {
  const helperScripts = [
    {
      filename: "hydrate-files.mjs",
      targetUrl: new URL("../bin/hydrate-files.mjs", import.meta.url).href,
    },
    {
      filename: "search-db.mjs",
      targetUrl: new URL("../bin/search-db.mjs", import.meta.url).href,
    },
  ];

  await Promise.all(
    helperScripts.map(async ({ filename, targetUrl }) => {
      await writeFile(
        join(paths.context, filename),
        `#!/usr/bin/env node\nimport ${JSON.stringify(targetUrl)};\n`,
        "utf8",
      );
    }),
  );
}

async function appendProgressEvent(paths: ReturnType<typeof createPaths>, event: Record<string, unknown>) {
  await mkdir(paths.output, { recursive: true });
  await appendFile(
    join(paths.output, "codex-progress.jsonl"),
    `${JSON.stringify({
      timestamp: nowIso(),
      ...event,
    })}\n`,
    "utf8",
  );
}

function isLoopbackRequest(request: IncomingMessage) {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function extractPromptPreview(payload: unknown): string | null {
  const candidates: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.instructions === "string") {
      candidates.push(record.instructions);
    }
    if ("input" in record) {
      walk(record.input);
    }
    if ("content" in record) {
      walk(record.content);
    }
    if (typeof record.text === "string") {
      candidates.push(record.text);
    }
  };
  walk(payload);
  const combined = candidates.join("\n").replace(/\s+/g, " ").trim();
  if (!combined) {
    return null;
  }
  return combined.length > 700 ? `${combined.slice(0, 699)}…` : combined;
}

async function proxyOpenAIRequest(
  request: IncomingMessage,
  response: ServerResponse,
  paths: ReturnType<typeof createPaths>,
) {
  if (!isLoopbackRequest(request)) {
    return json(response, 403, { error: "Codex proxy only accepts loopback requests." });
  }

  const upstreamBaseUrl = process.env.RUNTIME_OPENAI_PROXY_UPSTREAM_BASE_URL ?? "https://api.openai.com/v1";
  const proxyPrefix = "/openai-proxy/v1";
  const requestUrl = request.url ?? "";
  const upstreamPath = requestUrl.startsWith(proxyPrefix) ? requestUrl.slice(proxyPrefix.length) || "/" : requestUrl;
  const upstreamUrl = `${upstreamBaseUrl.replace(/\/+$/u, "")}/${upstreamPath.replace(/^\/+/u, "")}`;
  const bodyBuffer = await readRequestBody(request);
  const bodyText = bodyBuffer.toString("utf8");

  let promptPreview: string | null = null;
  try {
    promptPreview = extractPromptPreview(JSON.parse(bodyText) as unknown);
  } catch {
    promptPreview = null;
  }

  await appendProgressEvent(paths, {
    type: "codex.proxy.request",
    method: request.method ?? "GET",
    path: upstreamPath,
    upstreamUrl,
    promptPreview,
    message: request.method === "POST" && /\/responses(?:\?|$)/u.test(upstreamPath)
      ? "Codex sent a model request through the runtime proxy."
      : `Codex requested ${upstreamPath} through the runtime proxy.`,
  });

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || key.toLowerCase() === "host" || key.toLowerCase() === "content-length") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: bodyBuffer.length > 0 ? bodyBuffer : undefined,
    });

    response.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "content-length" || lower === "transfer-encoding" || lower === "connection") {
        return;
      }
      response.setHeader(key, value);
    });

    if (upstream.body) {
      for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
        response.write(chunk);
      }
    }
    response.end();

    await appendProgressEvent(paths, {
      type: "codex.proxy.response",
      method: request.method ?? "GET",
      path: upstreamPath,
      status: upstream.status,
      message: upstream.ok
        ? `The runtime proxy received a ${upstream.status} response from OpenAI.`
        : `The runtime proxy received a ${upstream.status} error from OpenAI.`,
    });
    return undefined;
  } catch (error) {
    await appendProgressEvent(paths, {
      type: "codex.proxy.error",
      method: request.method ?? "GET",
      path: upstreamPath,
      error: error instanceof Error ? error.message : String(error),
      message: "The runtime proxy failed while talking to OpenAI.",
    });
    throw error;
  }
}

async function listFiles(root: string, workspaceRoot: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        return listFiles(fullPath, workspaceRoot);
      }
      return [fullPath.replace(`${workspaceRoot}/`, "")];
    }),
  );
  return files.flat();
}

async function runStubAgent(paths: ReturnType<typeof createPaths>, workspaceRoot: string, taskSpec: Record<string, unknown>): Promise<RuntimeTaskResult> {
  const manifestText = await readFile(join(paths.context, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as WorkspaceManifest;
  const workFiles = await listFiles(paths.books, workspaceRoot);
  const chunkFiles = await listFiles(paths.chunks, workspaceRoot);
  const comparisonLines = manifest.works.map((work) => `- ${work.workId}: ${work.cleanTextKey ?? "no-clean-text"} | ${work.chunksKey ?? "no-chunks"}`);
  const phase = typeof taskSpec.phase === "string" ? taskSpec.phase : "collect_and_brief";

  const summary = [
    "# Summary",
    "",
    "This is a bounded AlphaBook runtime output.",
    "",
    "## Runtime Prompt",
    RUNTIME_AGENT_PROMPT,
    "",
    "## Task",
    JSON.stringify(taskSpec, null, 2),
    "",
    "## Data Schema",
    JSON.stringify(manifest.dataSchema ?? {}, null, 2),
    "",
    "## Works",
    ...comparisonLines,
    "",
    "## Workspace Files",
    ...workFiles.map((file) => `- ${file}`),
    ...chunkFiles.map((file) => `- ${file}`),
  ].join("\n");

  const evidenceNotesRelativePath = "output/evidence-notes.md";
  const evidenceNotesPath = join(paths.output, "evidence-notes.md");
  await writeFile(evidenceNotesPath, summary, "utf8");
  await writeFile(
    join(paths.output, "evidence.json"),
    JSON.stringify({
      question: taskSpec.question ?? null,
      evidence: manifest.selectedChunks?.slice(0, 6).map((chunk) => ({
        workId: chunk.workId,
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        sourcePath: `chunks/${chunk.workId}/chunks.jsonl`,
        label: `${chunk.workId}#${chunk.chunkIndex}`,
        excerpt: chunk.excerpt,
        rationale: "Stub runtime evidence item.",
        r2Key: chunk.r2Key ?? undefined,
      })) ?? [],
    }, null, 2),
    "utf8",
  );

  const artifacts: RuntimeTaskResult["artifacts"] = [
    {
      path: evidenceNotesRelativePath,
      filename: "evidence-notes.md",
      mimeType: "text/markdown",
    },
    {
      path: "output/evidence.json",
      filename: "evidence.json",
      mimeType: "application/json",
    },
  ];

  if (phase === "write_briefing" || phase === "collect_and_brief") {
    const summaryRelativePath = "output/briefing.md";
    const summaryPath = join(paths.output, "briefing.md");
    await writeFile(summaryPath, summary, "utf8");
    await writeFile(
      join(paths.output, "briefing.json"),
      JSON.stringify({
        question: taskSpec.question ?? null,
        briefing: summary,
        citations: manifest.selectedChunks?.slice(0, 6).map((chunk) => ({
          workId: chunk.workId,
          chunkId: chunk.id,
          label: `${chunk.workId}#${chunk.chunkIndex}`,
          excerpt: chunk.excerpt,
          r2Key: chunk.r2Key ?? undefined,
        })) ?? [],
      }, null, 2),
      "utf8",
    );
    artifacts.push({
      path: summaryRelativePath,
      filename: "briefing.md",
      mimeType: "text/markdown",
    });
    artifacts.push({
      path: "output/briefing.json",
      filename: "briefing.json",
      mimeType: "application/json",
    });
  }

  return {
    runtimeId: manifest.runtimeId,
    stdout: "Stub agent completed.",
    stderr: "",
    exitCode: 0,
    evidenceNotes: summary,
    briefing: phase === "write_briefing" || phase === "collect_and_brief" ? summary : undefined,
    citations: phase === "write_briefing" || phase === "collect_and_brief"
      ? manifest.selectedChunks?.slice(0, 6).map((chunk) => ({
        workId: chunk.workId,
        chunkId: chunk.id,
        label: `${chunk.workId}#${chunk.chunkIndex}`,
        excerpt: chunk.excerpt,
        r2Key: chunk.r2Key ?? undefined,
      })) ?? []
      : [],
    codexRuns: [],
    artifacts,
  };
}

async function runExternalAgent(
  paths: ReturnType<typeof createPaths>,
  workspaceRoot: string,
  taskSpec: Record<string, unknown>,
): Promise<RuntimeTaskResult> {
  const command = process.env.RUNTIME_AGENT_COMMAND;
  if (!command) {
    return runStubAgent(paths, workspaceRoot, taskSpec);
  }

  const taskPath = join(paths.context, "task.json");
  await writeFile(taskPath, JSON.stringify(taskSpec, null, 2), "utf8");
  const shouldUseNode = /\.(?:[cm]?js|[cm]?ts)$/i.test(command);
  const executable = shouldUseNode ? process.execPath : command;
  const args = shouldUseNode ? [command] : [];
  const { stdout, stderr } = await execFileAsync(executable, args, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      ALPHABOOK_RUNTIME_PROMPT: RUNTIME_AGENT_PROMPT,
      ALPHABOOK_TASK_PATH: taskPath,
      ALPHABOOK_OUTPUT_DIR: paths.output,
    },
    timeout: 180_000,
  });

  const outputFiles = await listFiles(paths.output, workspaceRoot);
  const briefingJsonPath = join(paths.output, "briefing.json");
  const codexRunsPath = join(paths.output, "codex-runs.json");
  const evidenceNotesPath = join(paths.output, "evidence-notes.md");
  const briefingJson = await readJsonIfPresent<Record<string, unknown> | null>(briefingJsonPath, null);
  const codexRuns = await readJsonIfPresent<unknown[]>(codexRunsPath, []);
  const evidenceNotes = (await fileExists(evidenceNotesPath))
    ? await readFile(evidenceNotesPath, "utf8")
    : undefined;
  const normalizedCodexRuns = Array.isArray(codexRuns)
    ? codexRuns.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const record = entry as Record<string, unknown>;
      if (
        typeof record.step !== "string"
        || typeof record.promptPath !== "string"
        || typeof record.outputPath !== "string"
        || typeof record.logPath !== "string"
        || typeof record.exitCode !== "number"
      ) {
        return [];
      }
      return [{
        step: record.step,
        promptPath: record.promptPath,
        outputPath: record.outputPath,
        logPath: record.logPath,
        exitCode: record.exitCode,
      }];
    })
    : [];
  return {
    runtimeId: String(taskSpec.runtimeId ?? "runtime"),
    stdout,
    stderr,
    exitCode: 0,
    evidenceNotes,
    briefing:
      briefingJson && typeof briefingJson === "object" && typeof briefingJson.briefing === "string"
        ? briefingJson.briefing
        : undefined,
    citations:
      briefingJson && typeof briefingJson === "object" && Array.isArray(briefingJson.citations)
        ? briefingJson.citations
        : [],
    codexRuns: normalizedCodexRuns,
    artifacts: outputFiles.map((file) => ({
      path: file,
      filename: file.split("/").at(-1) ?? file,
      mimeType: file.endsWith(".md") ? "text/markdown" : "application/octet-stream",
    })),
  };
}

function authorized(request: IncomingMessage, authToken?: string): boolean {
  if (!authToken) {
    return true;
  }
  const header = request.headers.authorization;
  return header === `Bearer ${authToken}`;
}

export function createAlphaBookRuntimeServer(options: RuntimeServerOptions = {}): Server {
  const workspaceRoot = options.workspaceRoot ?? process.env.RUNTIME_WORKSPACE_ROOT ?? "/workspace";
  const authToken = options.authToken ?? process.env.RUNTIME_SHARED_TOKEN;
  const r2Client = options.r2Client ?? createR2ClientFromEnv();
  const r2BucketName = options.r2BucketName ?? process.env.R2_BUCKET_NAME ?? null;
  const paths = createPaths(workspaceRoot);

  return createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/openai-proxy/v1/")) {
        return await proxyOpenAIRequest(request, response, paths);
      }

      if (!authorized(request, authToken)) {
        return json(response, 401, { error: "Unauthorized" });
      }

      await ensureWorkspace(paths);

      if (request.method === "GET" && request.url === "/health") {
        return json(response, 200, {
          status: "ok",
          workspaceRoot,
        });
      }

      if (request.method === "POST" && request.url === "/prepare") {
        const payload = await readJson<PrepareRequest>(request);
        await resetWorkspace(paths);
        await writeManifest(paths, payload);
        await writeSelectedChunks(paths, payload);
        await writeWorkspaceHelpers(paths);
        if (payload.downloads?.length) {
          await downloadFiles(payload.downloads, workspaceRoot, r2Client, r2BucketName);
        }
        return json(response, 200, {
          ok: true,
          runtimeId: payload.runtimeId,
          workspaceRoot,
          manifestPath: "context/manifest.json",
        });
      }

      if (request.method === "POST" && request.url === "/run-task") {
        const payload = await readJson<RunTaskRequest>(request);
        const taskPath = join(paths.context, "task.json");
        await writeFile(taskPath, JSON.stringify(payload.taskSpec, null, 2), "utf8");
        await writeFile(join(paths.output, "codex-progress.jsonl"), "", "utf8");
        const result = await runExternalAgent(paths, workspaceRoot, {
          runtimeId: payload.runtimeId,
          ...payload.taskSpec,
        });
        return json(response, 200, result);
      }

      if (request.method === "GET" && request.url?.startsWith("/file?")) {
        const url = new URL(request.url, "http://runtime.internal");
        const targetPath = url.searchParams.get("path");
        if (!targetPath) {
          return json(response, 400, { error: "path is required" });
        }
        const filePath = safeJoin(workspaceRoot, targetPath);
        const content = await readFile(filePath, "utf8");
        const fileInfo = await stat(filePath);
        return json(response, 200, {
          path: targetPath,
          size: fileInfo.size,
          content,
          encoding: "utf8",
        });
      }

      if (request.method === "GET" && request.url === "/files") {
        return json(response, 200, {
          files: await listFiles(workspaceRoot, workspaceRoot),
        });
      }

      if (request.method === "POST" && request.url === "/destroy") {
        await resetWorkspace(paths);
        return json(response, 200, {
          ok: true,
        });
      }

      return json(response, 404, { error: "Not found" });
    } catch (error) {
      console.error("runtime request failed", error);
      return json(response, 500, {
        error: error instanceof Error ? error.message : "Unknown runtime error",
      });
    }
  });
}

export function startAlphaBookRuntimeServer(options: RuntimeServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 8080);
  const server = createAlphaBookRuntimeServer(options);
  server.listen(port, () => {
    console.log(`AlphaBook runtime listening on :${port}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startAlphaBookRuntimeServer();
}
