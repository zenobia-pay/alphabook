import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { HARD_LIMITS, normalizeWorkspaceChunks, normalizeWorkspaceDocuments } from "@alphabook/corpus-core";
import { RUNTIME_AGENT_PROMPT, type RuntimeTaskResult, type WorkspaceManifest } from "@alphabook/shared";

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
  byteSize?: number | null;
  kind?: "clean" | "chunks";
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

type RuntimeTaskStatusRecord =
  | {
      status: "idle";
      runtimeId?: string;
    }
  | {
      status: "running";
      runtimeId: string;
      startedAt: string;
    }
  | {
      status: "completed";
      runtimeId: string;
      startedAt: string;
      completedAt: string;
      result: RuntimeTaskResult;
    }
  | {
      status: "failed";
      runtimeId: string;
      startedAt: string;
      completedAt: string;
      error: string;
      billingEvents?: Array<Record<string, unknown>>;
    };

function requireAuthToken(authToken?: string): string {
  const normalized = authToken?.trim();
  if (!normalized) {
    throw new Error("RUNTIME_SHARED_TOKEN is required.");
  }
  return normalized;
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

function runtimeTaskStatusPath(paths: ReturnType<typeof createPaths>) {
  return join(paths.output, "run-status.json");
}

function nowIso() {
  return new Date().toISOString();
}

function usageLogPath(paths: ReturnType<typeof createPaths>) {
  return join(paths.output, "openai-usage.jsonl");
}

async function readUsageLogLines(paths: ReturnType<typeof createPaths>) {
  const usageLogFile = usageLogPath(paths);
  return (await fileExists(usageLogFile))
    ? (await readFile(usageLogFile, "utf8")).split("\n").filter((line) => line.trim().length > 0)
    : [];
}

async function readRuntimeBillingEvents(paths: ReturnType<typeof createPaths>) {
  const usageLines = await readUsageLogLines(paths);
  return usageLines.flatMap((line) => {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof record.provider !== "string"
        || typeof record.model !== "string"
        || typeof record.operation !== "string"
      ) {
        return [];
      }
      return [{
        provider: record.provider,
        model: record.model,
        operation: record.operation,
        inputTokens: Number(record.inputTokens ?? 0),
        outputTokens: Number(record.outputTokens ?? 0),
        totalTokens: Number(record.totalTokens ?? 0),
        cachedInputTokens: Number(record.cachedInputTokens ?? 0),
        requestId: typeof record.requestId === "string" ? record.requestId : null,
        createdAt: typeof record.timestamp === "string" ? record.timestamp : nowIso(),
        metadata: record.metadata && typeof record.metadata === "object" ? record.metadata as Record<string, unknown> : {},
      }];
    } catch {
      return [];
    }
  });
}

async function writeRuntimeTaskStatus(
  paths: ReturnType<typeof createPaths>,
  status: RuntimeTaskStatusRecord,
) {
  await writeFile(runtimeTaskStatusPath(paths), JSON.stringify(status, null, 2), "utf8");
}

async function readRuntimeTaskStatus(paths: ReturnType<typeof createPaths>): Promise<RuntimeTaskStatusRecord> {
  return readJsonIfPresent<RuntimeTaskStatusRecord>(runtimeTaskStatusPath(paths), { status: "idle" });
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

async function ensureCodexAuthConfigured() {
  const authJson = process.env.CODEX_AUTH_JSON;
  if (!authJson || !authJson.trim()) {
    return;
  }
  const homeDir = process.env.HOME ?? "/root";
  const codexDir = join(homeDir, ".codex");
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, "auth.json"), authJson, { encoding: "utf8", mode: 0o600 });
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

async function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | null = null;

    const finish = (result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      finish({ stdout, stderr, exitCode: code, timedOut });
    });

    if (options.signal) {
      const abort = () => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 5_000).unref();
      };
      if (options.signal.aborted) {
        abort();
      } else {
        options.signal.addEventListener("abort", abort, { once: true });
      }
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 5_000).unref();
      }, options.timeoutMs);
      timeout.unref();
    }
  });
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
  const orderedDownloads = [...downloads].sort((left, right) => {
    const leftKindRank = left.kind === "clean" ? 0 : 1;
    const rightKindRank = right.kind === "clean" ? 0 : 1;
    if (leftKindRank !== rightKindRank) {
      return leftKindRank - rightKindRank;
    }
    return (right.byteSize ?? 0) - (left.byteSize ?? 0);
  });
  const cleanDownloadCount = orderedDownloads.filter((item) => item.kind === "clean").length;
  const chunkDownloadCount = orderedDownloads.filter((item) => item.kind === "chunks").length;
  const concurrency = Math.max(
    1,
    Math.min(
      chunkDownloadCount === 0 ? 24 : 12,
      cleanDownloadCount > 0 && chunkDownloadCount === 0 ? orderedDownloads.length : Math.max(12, orderedDownloads.length),
    ),
  );
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < orderedDownloads.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const item = orderedDownloads[currentIndex]!;
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
  };

  await Promise.all(new Array(concurrency).fill(null).map(() => worker()));
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
      targetPath: "/app/apps/runtime/bin/hydrate-files.mjs",
    },
    {
      filename: "search-db.mjs",
      targetPath: "/app/apps/runtime/bin/search-db.mjs",
    },
  ];

  await Promise.all(
    helperScripts.map(async ({ filename, targetPath }) => {
      await writeFile(
        join(paths.context, filename),
        `#!/usr/bin/env node
import { spawn } from "node:child_process";

const child = spawn(process.execPath, [${JSON.stringify(targetPath)}, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
`,
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

async function appendUsageEvent(paths: ReturnType<typeof createPaths>, event: Record<string, unknown>) {
  await mkdir(paths.output, { recursive: true });
  await appendFile(
    usageLogPath(paths),
    `${JSON.stringify({
      timestamp: nowIso(),
      ...event,
    })}\n`,
    "utf8",
  );
}

function extractOpenAIUsage(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const usage = record.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : null;
  if (!usage) {
    return null;
  }
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);
  const details = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details as Record<string, unknown>
    : usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? usage.prompt_tokens_details as Record<string, unknown>
      : null;
  const cachedInputTokens = Number(details?.cached_tokens ?? 0);
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    cachedInputTokens: Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0,
    requestId: typeof record.id === "string" ? record.id : null,
    model: typeof record.model === "string" ? record.model : null,
  };
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
  let requestedModel: string | null = null;
  try {
    const parsedRequest = JSON.parse(bodyText) as Record<string, unknown>;
    promptPreview = extractPromptPreview(parsedRequest);
    requestedModel = typeof parsedRequest.model === "string" ? parsedRequest.model : null;
  } catch {
    promptPreview = null;
    requestedModel = null;
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
    const contentType = upstream.headers.get("content-type") ?? "";
    const usagePromise = contentType.includes("application/json")
      ? upstream.clone().text().then(async (body) => {
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          const usage = extractOpenAIUsage(parsed);
          if (!usage) {
            return;
          }
          await appendUsageEvent(paths, {
            provider: "openai",
            model: usage.model ?? requestedModel ?? "unknown",
            operation: upstreamPath.replace(/^\/+/u, ""),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            cachedInputTokens: usage.cachedInputTokens,
            requestId: usage.requestId,
            metadata: {
              method: request.method ?? "GET",
              path: upstreamPath,
              promptPreview,
            },
          });
        } catch {
          // Best-effort usage capture for runtime-side requests.
        }
      }).catch(() => {})
      : Promise.resolve();

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
    await usagePromise;

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
  const documents = normalizeWorkspaceDocuments(manifest);
  const selectedChunks = normalizeWorkspaceChunks(manifest);
  const workFiles = await listFiles(paths.books, workspaceRoot);
  const chunkFiles = await listFiles(paths.chunks, workspaceRoot);
  const comparisonLines = documents.map((document) => `- ${document.documentId}: ${document.cleanTextKey ?? "no-clean-text"} | ${document.chunksKey ?? "no-chunks"}`);
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
      evidence: selectedChunks.slice(0, 6).map((chunk) => ({
        workId: chunk.documentId,
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        sourcePath: `chunks/${chunk.documentId}/chunks.jsonl`,
        label: `${chunk.documentId}#${chunk.chunkIndex}`,
        excerpt: chunk.excerpt,
        rationale: "Stub runtime evidence item.",
        r2Key: chunk.r2Key ?? undefined,
      })),
    }, null, 2),
    "utf8",
  );
  await writeFile(
    join(paths.output, "viewed-chunks.json"),
    JSON.stringify({
      generatedAt: nowIso(),
      summary: {
        uniqueChunkCount: manifest.selectedChunks?.length ?? 0,
        selectedChunkCount: selectedChunks.length,
        topRuntimeHitCount: 0,
        iterationCount: 0,
      },
      chunks: selectedChunks.map((chunk) => ({
        chunkId: chunk.id,
        workId: chunk.documentId,
        workTitle: documents.find((document) => document.documentId === chunk.documentId)?.title ?? null,
        authors: documents.find((document) => document.documentId === chunk.documentId)?.contributors ?? [],
        chunkIndex: chunk.chunkIndex,
        excerpt: chunk.excerpt ?? chunk.text ?? "",
        r2Key: chunk.r2Key ?? null,
        viewedIn: ["workspace_selected_chunks"],
        matchedIterations: [],
        maxScore: null,
      })),
    }, null, 2),
    "utf8",
  );
  await writeFile(
    join(paths.output, "every-single-reference.md"),
    [
      "# Every Single Reference",
      "",
      `Generated: ${nowIso()}`,
      "",
      ...selectedChunks.map((chunk) => {
        const work = documents.find((item) => item.documentId === chunk.documentId);
        return [
          `## ${work?.title ?? chunk.documentId}`,
          "",
          `- Work ID: ${chunk.documentId}`,
          `- Chunk: ${chunk.id}#${chunk.chunkIndex}`,
          ...(Array.isArray(work?.contributors) && work.contributors.length > 0 ? [`- Authors: ${work.contributors.join(", ")}`] : []),
          "- Seen in: workspace_selected_chunks",
          "",
          `> ${chunk.excerpt ?? chunk.text ?? ""}`,
          "",
        ].join("\n");
      }),
    ].join("\n"),
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
    {
      path: "output/viewed-chunks.json",
      filename: "viewed-chunks.json",
      mimeType: "application/json",
      metadata: {
        kind: "reference_index",
        title: "Every Single Reference (Raw)",
      },
    },
    {
      path: "output/every-single-reference.md",
      filename: "every-single-reference.md",
      mimeType: "text/markdown",
      metadata: {
        kind: "reference_file",
        title: "Every Single Reference",
      },
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
        citations: selectedChunks.slice(0, 6).map((chunk) => ({
          workId: chunk.documentId,
          chunkId: chunk.id,
          label: `${chunk.documentId}#${chunk.chunkIndex}`,
          excerpt: chunk.excerpt,
          r2Key: chunk.r2Key ?? undefined,
        })),
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
      ? selectedChunks.slice(0, 6).map((chunk) => ({
        workId: chunk.documentId,
        chunkId: chunk.id,
        label: `${chunk.documentId}#${chunk.chunkIndex}`,
        excerpt: chunk.excerpt,
        r2Key: chunk.r2Key ?? undefined,
      }))
      : [],
    codexRuns: [],
    artifacts,
  };
}

async function runExternalAgent(
  paths: ReturnType<typeof createPaths>,
  workspaceRoot: string,
  taskSpec: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RuntimeTaskResult> {
  const command = process.env.RUNTIME_AGENT_COMMAND;
  if (!command) {
    throw new Error("RUNTIME_AGENT_COMMAND is not configured; runtime cannot invoke Codex.");
  }

  await ensureCodexAuthConfigured();

  const taskPath = join(paths.context, "task.json");
  await writeFile(taskPath, JSON.stringify(taskSpec, null, 2), "utf8");
  const shouldUseNode = /\.(?:[cm]?js|[cm]?ts)$/i.test(command);
  const executable = shouldUseNode ? process.execPath : command;
  const args = shouldUseNode ? [command] : [];
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ALPHABOOK_RUNTIME_PROMPT: RUNTIME_AGENT_PROMPT,
    ALPHABOOK_TASK_PATH: taskPath,
    ALPHABOOK_OUTPUT_DIR: paths.output,
  };
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.OPENAI_BASE_URL;
  delete childEnv.RUNTIME_OPENAI_PROXY_UPSTREAM_BASE_URL;
  const processResult = await runProcess(executable, args, {
    cwd: workspaceRoot,
    env: childEnv,
    timeoutMs: HARD_LIMITS.MAX_RUNTIME_TOOL_TIMEOUT_SECONDS * 1000,
    signal,
  });
  if (signal?.aborted) {
    throw new Error("Task cancelled.");
  }
  if (processResult.exitCode !== 0) {
    const timeoutSuffix = processResult.timedOut ? " (timed out)" : "";
    throw new Error(
      `Runtime agent failed with exit code ${processResult.exitCode ?? "unknown"}${timeoutSuffix}\nstdout:\n${processResult.stdout}\nstderr:\n${processResult.stderr}`,
    );
  }
  const { stdout, stderr } = processResult;

  const outputFiles = await listFiles(paths.output, workspaceRoot);
  const briefingMarkdownPath = join(paths.output, "briefing.md");
  const briefingJsonPath = join(paths.output, "briefing.json");
  const codexRunsPath = join(paths.output, "codex-runs.json");
  const evidenceNotesPath = join(paths.output, "evidence-notes.md");
  const briefingMarkdown = (await fileExists(briefingMarkdownPath))
    ? await readFile(briefingMarkdownPath, "utf8")
    : undefined;
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
  const billingEvents = await readRuntimeBillingEvents(paths);
  const artifactMetadataByFilename = new Map<string, Record<string, unknown>>([
    ["every-single-reference.md", { kind: "reference_file", title: "Every Single Reference" }],
    ["viewed-chunks.json", { kind: "reference_index", title: "Every Single Reference (Raw)" }],
  ]);
  return {
    runtimeId: String(taskSpec.runtimeId ?? "runtime"),
    stdout,
    stderr,
    exitCode: 0,
    evidenceNotes,
    briefing:
      typeof briefingMarkdown === "string" && briefingMarkdown.trim().length > 0
        ? briefingMarkdown
        : briefingJson && typeof briefingJson === "object" && typeof briefingJson.briefing === "string"
          ? briefingJson.briefing
          : undefined,
    citations:
      briefingJson && typeof briefingJson === "object" && Array.isArray(briefingJson.citations)
        ? briefingJson.citations
        : [],
    codexRuns: normalizedCodexRuns,
    billingEvents,
    artifacts: outputFiles.map((file) => {
      const filename = file.split("/").at(-1) ?? file;
      return {
        path: file,
        filename,
        mimeType: file.endsWith(".md") ? "text/markdown" : "application/octet-stream",
        metadata: artifactMetadataByFilename.get(filename),
      };
    }),
  };
}

async function startExternalAgentTask(
  paths: ReturnType<typeof createPaths>,
  workspaceRoot: string,
  payload: RunTaskRequest,
  activeTasks: Map<string, AbortController>,
) {
  const startedAt = nowIso();
  const abortController = new AbortController();
  activeTasks.set(payload.runtimeId, abortController);
  await writeRuntimeTaskStatus(paths, {
    status: "running",
    runtimeId: payload.runtimeId,
    startedAt,
  });

  void (async () => {
    try {
      const result = await runExternalAgent(paths, workspaceRoot, {
        runtimeId: payload.runtimeId,
        ...payload.taskSpec,
      }, abortController.signal);
      await writeRuntimeTaskStatus(paths, {
        status: "completed",
        runtimeId: payload.runtimeId,
        startedAt,
        completedAt: nowIso(),
        result,
      });
    } catch (error) {
      await writeRuntimeTaskStatus(paths, {
        status: "failed",
        runtimeId: payload.runtimeId,
        startedAt,
        completedAt: nowIso(),
        error: error instanceof Error ? error.message : "Unknown runtime error",
        billingEvents: await readRuntimeBillingEvents(paths),
      });
    } finally {
      activeTasks.delete(payload.runtimeId);
    }
  })();
}

function authorized(request: IncomingMessage, authToken?: string): boolean {
  const header = request.headers.authorization;
  return header === `Bearer ${authToken}`;
}

export function createAlphaBookRuntimeServer(options: RuntimeServerOptions = {}): Server {
  const workspaceRoot = options.workspaceRoot ?? process.env.RUNTIME_WORKSPACE_ROOT ?? "/workspace";
  const authToken = requireAuthToken(options.authToken ?? process.env.RUNTIME_SHARED_TOKEN);
  const r2Client = options.r2Client ?? createR2ClientFromEnv();
  const r2BucketName = options.r2BucketName ?? process.env.R2_BUCKET_NAME ?? null;
  const paths = createPaths(workspaceRoot);
  const activeTasks = new Map<string, AbortController>();
  const activePrepares = new Map<string, Promise<{
    ok: true;
    runtimeId: string;
    workspaceRoot: string;
    manifestPath: string;
  }>>();

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
        const existingPrepare = activePrepares.get(payload.runtimeId);
        const preparePromise = existingPrepare ?? (async () => {
          await resetWorkspace(paths);
          await writeManifest(paths, payload);
          await writeSelectedChunks(paths, payload);
          await writeWorkspaceHelpers(paths);
          if (payload.downloads?.length) {
            await downloadFiles(payload.downloads, workspaceRoot, r2Client, r2BucketName);
          }
          return {
            ok: true as const,
            runtimeId: payload.runtimeId,
            workspaceRoot,
            manifestPath: "context/manifest.json",
          };
        })();
        if (!existingPrepare) {
          activePrepares.set(payload.runtimeId, preparePromise);
        }
        try {
          return json(response, 200, await preparePromise);
        } finally {
          if (!existingPrepare) {
            activePrepares.delete(payload.runtimeId);
          }
        }
      }

      if (request.method === "POST" && request.url === "/run-task") {
        const payload = await readJson<RunTaskRequest>(request);
        const taskPath = join(paths.context, "task.json");
        await writeFile(taskPath, JSON.stringify(payload.taskSpec, null, 2), "utf8");
        await writeFile(join(paths.output, "codex-progress.jsonl"), "", "utf8");
        await writeFile(usageLogPath(paths), "", "utf8");
        const existing = await readRuntimeTaskStatus(paths);
        if (existing.status === "running" && existing.runtimeId === payload.runtimeId) {
          return json(response, 202, existing);
        }
        if (!activeTasks.has(payload.runtimeId)) {
          await startExternalAgentTask(paths, workspaceRoot, payload, activeTasks);
          const taskPoller = async () => {
            const current = await readRuntimeTaskStatus(paths);
            if (current.status !== "running") {
              activeTasks.delete(payload.runtimeId);
            } else {
              setTimeout(() => {
                void taskPoller();
              }, 1000).unref();
            }
          };
          void taskPoller();
        }
        return json(response, 202, {
          ok: true,
          runtimeId: payload.runtimeId,
          status: "running",
        });
      }

      if (request.method === "POST" && request.url === "/cancel-task") {
        const payload = await readJson<{ runtimeId?: string }>(request);
        const runtimeId = typeof payload.runtimeId === "string" ? payload.runtimeId : "";
        const activeTask = activeTasks.get(runtimeId);
        activeTask?.abort();
        return json(response, 200, {
          ok: true,
          runtimeId,
          cancelled: Boolean(activeTask),
        });
      }

      if (request.method === "GET" && request.url === "/task-status") {
        return json(response, 200, await readRuntimeTaskStatus(paths));
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
        const current = await readRuntimeTaskStatus(paths);
        if (current.status === "running") {
          activeTasks.get(current.runtimeId)?.abort();
        }
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
