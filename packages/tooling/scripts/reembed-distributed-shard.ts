import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { buildCorpusChunkId } from "@alphabook/corpus-core";
import { loadLocalDevVars } from "@alphabook/db";
import {
  buildOpenAIEmbeddingBatchRequest,
  estimateEmbeddingCostUsd,
  estimateEmbeddingInputTokensForText,
  getOpenAIEmbeddingBatchStatus,
  resolveOpenAIMaxRequestsPerFile,
  submitOpenAIEmbeddingBatch,
  downloadOpenAIEmbeddingBatchOutputs,
} from "../../../apps/ingest/src/openai-batch";
import { parseChunkPayload } from "../../../apps/ingest/src/rebuild";

import type { DistributedShardManifest } from "./lib/distributed-run";
import {
  hasFlag,
  pathExists,
  printJson,
  readArg,
  readJsonFile,
  requireFile,
  writeJson,
} from "./lib/distributed-run";

const DEFAULT_REQUEST_BATCH_SIZE = 1;
const DEFAULT_MAX_FILE_BYTES = 190_000_000;
const DEFAULT_MAX_REQUESTS_PER_FILE = 50_000;
const DEFAULT_MAX_INPUTS_PER_FILE = 50_000;
const DEFAULT_PRICE_PER_MILLION_TOKENS_USD = 0.01;
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const DEFAULT_MAX_WAIT_MINUTES = 24 * 60;

type ShardEmbeddingSidecarRow = {
  customId: string;
  sourceId: string;
  gutenbergId: string;
  chunkIndex: number;
  title: string;
  workTitle: string;
  authors: string[];
  language: string | null;
  rightsStatus: string | null;
  excerpt: string | null;
  readerPath: string | null;
  r2Key: string | null;
  estimatedTokens: number;
};

type PreparedBatchFile = {
  index: number;
  requestPath: string;
  sidecarPath: string;
  requestCount: number;
  totalBytes: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  firstGutenbergId: string | null;
  lastGutenbergId: string | null;
};

type ShardEmbeddingBatchManifest = {
  runId: string;
  createdAt: string;
  shardId: string;
  shardNumber: number;
  model: string;
  dimensions: number | null;
  requestBatchSize: number;
  pricePerMillionTokensUsd: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  requestCount: number;
  bookCount: number;
  outputDir: string;
  corpusRoot: string;
  r2Root: string;
  files: PreparedBatchFile[];
};

type ShardEmbeddingSubmission = {
  manifestPath: string;
  submittedAt: string;
  model: string;
  jobs: Array<{
    index: number;
    requestPath: string;
    sidecarPath: string;
    requestCount: number;
    estimatedTokens: number;
    estimatedCostUsd: number;
    uploadedFileId: string | null;
    batchId: string | null;
    status: string | null;
    outputFileId: string | null;
    errorFileId: string | null;
    errorMessage: string | null;
  }>;
};

type BatchOutputLine = {
  custom_id?: string;
  response?: {
    status_code?: number;
    body?: {
      data?: Array<{
        embedding?: number[];
      }>;
      model?: string;
    };
  };
  error?: unknown;
};

class BatchFileWriter {
  readonly requestPath: string;
  readonly sidecarPath: string;
  readonly index: number;
  requestCount = 0;
  inputCount = 0;
  totalBytes = 0;
  estimatedTokens = 0;
  firstGutenbergId: string | null = null;
  lastGutenbergId: string | null = null;

  private readonly requestStream;
  private readonly sidecarStream;

  constructor(runDir: string, index: number) {
    this.index = index;
    const baseName = `embedding-batch-${String(index).padStart(4, "0")}`;
    this.requestPath = join(runDir, `${baseName}.jsonl`);
    this.sidecarPath = join(runDir, `${baseName}.sidecar.jsonl`);
    this.requestStream = createWriteStream(this.requestPath, { encoding: "utf8" });
    this.sidecarStream = createWriteStream(this.sidecarPath, { encoding: "utf8" });
  }

  canFit(bytes: number, inputCount: number, maxFileBytes: number, maxRequestsPerFile: number, maxInputsPerFile: number) {
    return (
      this.requestCount === 0
      || (
        this.totalBytes + bytes <= maxFileBytes
        && this.requestCount < maxRequestsPerFile
        && this.inputCount + inputCount <= maxInputsPerFile
      )
    );
  }

  async write(requestLine: string, sidecarLine: string, estimatedTokens: number, gutenbergId: string, inputCount: number) {
    const bytes = Buffer.byteLength(`${requestLine}\n`, "utf8");
    await Promise.all([
      new Promise<void>((resolvePromise, rejectPromise) => {
        this.requestStream.write(`${requestLine}\n`, "utf8", (error) => error ? rejectPromise(error) : resolvePromise());
      }),
      new Promise<void>((resolvePromise, rejectPromise) => {
        this.sidecarStream.write(`${sidecarLine}\n`, "utf8", (error) => error ? rejectPromise(error) : resolvePromise());
      }),
    ]);
    this.requestCount += 1;
    this.inputCount += inputCount;
    this.totalBytes += bytes;
    this.estimatedTokens += estimatedTokens;
    this.firstGutenbergId ??= gutenbergId;
    this.lastGutenbergId = gutenbergId;
  }

  async close() {
    await Promise.all([
      new Promise<void>((resolvePromise, rejectPromise) => {
        this.requestStream.end((error?: Error | null) => error ? rejectPromise(error) : resolvePromise());
      }),
      new Promise<void>((resolvePromise, rejectPromise) => {
        this.sidecarStream.end((error?: Error | null) => error ? rejectPromise(error) : resolvePromise());
      }),
    ]);
  }
}

function usage() {
  process.stdout.write(
    [
      "Usage: node --import tsx packages/tooling/scripts/reembed-distributed-shard.ts --manifest <path> [options]",
      "",
      "Options:",
      "  --output-dir <path>",
      "  --corpus-root </mnt/alphabook_consolidation/final/latest>",
      "  --r2-root </mnt/alphabook_consolidation/final/latest/r2>",
      "  --model <text-embedding-3-small>",
      "  --dimensions <768>",
      "  --request-batch-size <1>",
      "  --poll-interval-seconds <60>",
      "  --max-wait-minutes <1440>",
      "  --skip-submit",
      "  --skip-wait",
      "  --skip-download",
      "  --skip-materialize",
    ].join("\n") + "\n",
  );
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function requestBatchSize() {
  return Math.max(1, Number(readArg("--request-batch-size") ?? process.env.OPENAI_EMBEDDING_BATCH_SIZE ?? DEFAULT_REQUEST_BATCH_SIZE));
}

async function prepareShardEmbeddingBatch(options: {
  manifest: DistributedShardManifest;
  outputDir: string;
  corpusRoot: string;
  r2Root: string;
  model: string;
  dimensions: number | null;
}): Promise<{ manifestPath: string; manifest: ShardEmbeddingBatchManifest }> {
  const runId = `distributed-openai-embedding-batch-${options.manifest.shardId}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = resolve(options.outputDir);
  const maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  const batchSize = requestBatchSize();
  const maxInputsPerFile = Math.max(batchSize, DEFAULT_MAX_INPUTS_PER_FILE);
  const maxRequestsPerFile = resolveOpenAIMaxRequestsPerFile(
    batchSize,
    DEFAULT_MAX_REQUESTS_PER_FILE,
    maxInputsPerFile,
  );
  await mkdir(runDir, { recursive: true });

  const files: PreparedBatchFile[] = [];
  let currentFile: BatchFileWriter | null = null;
  let estimatedTokens = 0;
  let requestCount = 0;

  const flushCurrent = async () => {
    if (!currentFile) {
      return;
    }
    await currentFile.close();
    files.push({
      index: currentFile.index,
      requestPath: currentFile.requestPath,
      sidecarPath: currentFile.sidecarPath,
      requestCount: currentFile.requestCount,
      totalBytes: currentFile.totalBytes,
      estimatedTokens: currentFile.estimatedTokens,
      estimatedCostUsd: estimateEmbeddingCostUsd(currentFile.estimatedTokens, DEFAULT_PRICE_PER_MILLION_TOKENS_USD),
      firstGutenbergId: currentFile.firstGutenbergId,
      lastGutenbergId: currentFile.lastGutenbergId,
    });
    currentFile = null;
  };

  for (const book of options.manifest.books) {
    const chunksKey = book.chunksR2Key ?? join("gutenberg", "clean", book.gutenbergId, "chunks.jsonl");
    const chunksPath = join(options.r2Root, chunksKey);
    const raw = await readFile(chunksPath, "utf8");
    const chunkPayload = parseChunkPayload(raw);
    for (const [fallbackIndex, chunk] of chunkPayload.entries()) {
      const chunkIndex = typeof chunk.chunk_index === "number" ? chunk.chunk_index : fallbackIndex;
      const chunkId = typeof chunk.id === "string" && chunk.id.length > 0
        ? chunk.id
        : buildCorpusChunkId("gutenberg", book.gutenbergId, chunkIndex);
      const text = typeof chunk.text === "string" ? chunk.text.trim() : "";
      if (!text) {
        throw new Error(`Chunk ${chunkIndex} for Gutenberg ${book.gutenbergId} was empty.`);
      }
      const sidecar: ShardEmbeddingSidecarRow = {
        customId: `embedding-request-${String(requestCount + 1).padStart(8, "0")}`,
        sourceId: chunkId,
        gutenbergId: book.gutenbergId,
        chunkIndex,
        title: book.title,
        workTitle: typeof chunk.work_title === "string" && chunk.work_title.length > 0 ? chunk.work_title : book.title,
        authors: Array.isArray(chunk.authors) ? chunk.authors.filter((value): value is string => typeof value === "string") : [],
        language: null,
        rightsStatus: null,
        excerpt: typeof chunk.excerpt === "string" ? chunk.excerpt : null,
        readerPath: typeof chunk.reader_path === "string" ? chunk.reader_path : null,
        r2Key: typeof chunk.r2_key === "string" ? chunk.r2_key : null,
        estimatedTokens: estimateEmbeddingInputTokensForText(text),
      };
      const request = buildOpenAIEmbeddingBatchRequest(
        sidecar.customId,
        text,
        options.model,
        options.dimensions,
      );
      const requestLine = JSON.stringify(request);
      const sidecarLine = JSON.stringify(sidecar);
      const requestBytes = Buffer.byteLength(`${requestLine}\n`, "utf8");
      if (!currentFile || !currentFile.canFit(requestBytes, 1, maxFileBytes, maxRequestsPerFile, maxInputsPerFile)) {
        await flushCurrent();
        currentFile = new BatchFileWriter(runDir, files.length + 1);
      }
      await currentFile.write(requestLine, sidecarLine, sidecar.estimatedTokens, book.gutenbergId, 1);
      estimatedTokens += sidecar.estimatedTokens;
      requestCount += 1;
    }
  }

  await flushCurrent();

  const manifest: ShardEmbeddingBatchManifest = {
    runId,
    createdAt: new Date().toISOString(),
    shardId: options.manifest.shardId,
    shardNumber: options.manifest.shardNumber,
    model: options.model,
    dimensions: options.dimensions,
    requestBatchSize: batchSize,
    pricePerMillionTokensUsd: DEFAULT_PRICE_PER_MILLION_TOKENS_USD,
    estimatedTokens,
    estimatedCostUsd: estimateEmbeddingCostUsd(estimatedTokens, DEFAULT_PRICE_PER_MILLION_TOKENS_USD),
    requestCount,
    bookCount: options.manifest.books.length,
    outputDir: runDir,
    corpusRoot: options.corpusRoot,
    r2Root: options.r2Root,
    files,
  };
  const manifestPath = join(runDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { manifestPath, manifest };
}

function resolveSubmissionPath(manifestPath: string) {
  return join(dirname(manifestPath), "submission.json");
}

async function waitForOpenAIBatchCompletion(submissionPath: string, options: {
  pollIntervalSeconds: number;
  maxWaitMinutes: number;
}) {
  const deadline = Date.now() + options.maxWaitMinutes * 60_000;
  while (true) {
    const status = await getOpenAIEmbeddingBatchStatus(submissionPath) as ShardEmbeddingSubmission;
    const jobStatuses = status.jobs.map((job) => job.status ?? "unknown");
    const failed = status.jobs.filter((job) => ["failed", "expired", "cancelled"].includes(job.status ?? ""));
    if (failed.length > 0) {
      throw new Error(`One or more OpenAI Batch jobs failed: ${failed.map((job) => `${job.index}:${job.status}:${job.errorMessage ?? ""}`).join(" | ")}`);
    }
    if (status.jobs.length > 0 && status.jobs.every((job) => job.status === "completed")) {
      return status;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for OpenAI Batch completion. Latest statuses: ${jobStatuses.join(", ")}`);
    }
    await sleep(options.pollIntervalSeconds * 1000);
  }
}

async function materializeVectors(options: {
  batchManifestPath: string;
  downloadDir: string;
  outputDir: string;
  model: string;
  dimensions: number | null;
}) {
  const manifest = await readJsonFile<ShardEmbeddingBatchManifest>(options.batchManifestPath);
  const sidecarsByCustomId = new Map<string, ShardEmbeddingSidecarRow>();
  for (const file of manifest.files) {
    const sidecarLines = (await readFile(file.sidecarPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of sidecarLines) {
      const row = JSON.parse(line) as ShardEmbeddingSidecarRow;
      sidecarsByCustomId.set(row.customId, row);
    }
  }

  await mkdir(options.outputDir, { recursive: true });
  const vectorsPath = join(options.outputDir, "vectors.ndjson");
  const summaryPath = join(options.outputDir, "vector-manifest.json");
  const records: string[] = [];
  const countsByBook = new Map<string, number>();

  const downloadFiles = (await readJsonFile<{ downloads: Array<{ downloadPath: string }> }>(join(options.downloadDir, "downloads.json"))).downloads;
  for (const download of downloadFiles) {
    const lines = (await readFile(download.downloadPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const payload = JSON.parse(line) as BatchOutputLine;
      const customId = typeof payload.custom_id === "string" ? payload.custom_id : null;
      if (!customId) {
        continue;
      }
      const sidecar = sidecarsByCustomId.get(customId);
      if (!sidecar) {
        continue;
      }
      const vector = payload.response?.body?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error(`Missing embedding vector for ${customId}.`);
      }
      records.push(JSON.stringify({
        id: sidecar.sourceId,
        vector,
        payload: {
          source_id: sidecar.sourceId,
          gutenberg_id: sidecar.gutenbergId,
          chunk_index: sidecar.chunkIndex,
          title: sidecar.title,
          work_title: sidecar.workTitle,
          authors: sidecar.authors,
          language: sidecar.language,
          rights_status: sidecar.rightsStatus,
          excerpt: sidecar.excerpt,
          reader_path: sidecar.readerPath,
          r2_key: sidecar.r2Key,
          embedding_model: options.model,
          embedding_dimensions: options.dimensions,
        },
      }));
      countsByBook.set(sidecar.gutenbergId, (countsByBook.get(sidecar.gutenbergId) ?? 0) + 1);
    }
  }

  await writeFile(vectorsPath, `${records.join("\n")}\n`, "utf8");
  const summary = {
    generatedAt: new Date().toISOString(),
    shardId: manifest.shardId,
    batchManifestPath: options.batchManifestPath,
    outputDir: options.outputDir,
    model: options.model,
    dimensions: options.dimensions,
    vectorCount: records.length,
    countsByBook: Object.fromEntries([...countsByBook.entries()].sort((left, right) => Number(left[0]) - Number(right[0]))),
  };
  await writeJson(summaryPath, summary);
  return summary;
}

async function main() {
  if (hasFlag("--help")) {
    usage();
    return;
  }

  await loadLocalDevVars(process.cwd());
  const manifestPath = readArg("--manifest");
  if (!manifestPath) {
    throw new Error("--manifest is required.");
  }
  await requireFile(manifestPath);
  const manifest = await readJsonFile<DistributedShardManifest>(manifestPath);
  const corpusRoot = resolve(readArg("--corpus-root") ?? manifest.sourceRoot);
  const r2Root = resolve(readArg("--r2-root") ?? join(corpusRoot, "r2"));
  const outputDir = resolve(readArg("--output-dir") ?? `output/distributed-run/${manifest.shardId}/embeddings`);
  const model = readArg("--model") ?? process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const dimensions = Number(readArg("--dimensions") ?? process.env.OPENAI_EMBEDDING_DIMENSIONS ?? "768");
  const skipSubmit = hasFlag("--skip-submit");
  const skipWait = hasFlag("--skip-wait");
  const skipDownload = hasFlag("--skip-download");
  const skipMaterialize = hasFlag("--skip-materialize");
  const batchManifestPath = join(outputDir, "manifest.json");

  let batchManifest: { manifestPath: string; manifest: ShardEmbeddingBatchManifest };
  if (!await pathExists(batchManifestPath)) {
    batchManifest = await prepareShardEmbeddingBatch({
      manifest,
      outputDir,
      corpusRoot,
      r2Root,
      model,
      dimensions: Number.isFinite(dimensions) ? dimensions : null,
    });
  } else {
    batchManifest = {
      manifestPath: batchManifestPath,
      manifest: await readJsonFile<ShardEmbeddingBatchManifest>(batchManifestPath),
    };
  }

  const submissionPath = resolveSubmissionPath(batchManifest.manifestPath);
  let submission: unknown = await readFile(submissionPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
  if (!skipSubmit && !submission) {
    const result = await submitOpenAIEmbeddingBatch(batchManifest.manifestPath);
    submission = result.submission;
  }

  if (!skipWait && submission) {
    await waitForOpenAIBatchCompletion(submissionPath, {
      pollIntervalSeconds: Math.max(5, Number(readArg("--poll-interval-seconds") ?? DEFAULT_POLL_INTERVAL_SECONDS)),
      maxWaitMinutes: Math.max(1, Number(readArg("--max-wait-minutes") ?? DEFAULT_MAX_WAIT_MINUTES)),
    });
  }

  let downloads: { outputDir: string } | null = null;
  if (!skipDownload && submission) {
    downloads = await downloadOpenAIEmbeddingBatchOutputs(
      submissionPath,
      join(outputDir, "downloads"),
    ) as { outputDir: string };
  }

  let vectorSummary: Record<string, unknown> | null = null;
  if (!skipMaterialize) {
    const downloadDir = downloads?.outputDir ?? join(outputDir, "downloads");
    if (!await pathExists(join(downloadDir, "downloads.json"))) {
      throw new Error("Cannot materialize vectors before batch outputs are downloaded. Re-run without --skip-download, or add --skip-materialize for a prepare-only run.");
    }
    vectorSummary = await materializeVectors({
      batchManifestPath,
      downloadDir,
      outputDir,
      model,
      dimensions: Number.isFinite(dimensions) ? dimensions : null,
    });
  }

  printJson({
    ok: true,
    shardId: manifest.shardId,
    batchManifestPath,
    submissionPath: await pathExists(submissionPath) ? submissionPath : null,
    downloadsDir: await pathExists(join(outputDir, "downloads")) ? join(outputDir, "downloads") : null,
    vectorSummary,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
