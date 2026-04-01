import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { GoogleGenAI, type BatchJob, type File as GoogleFile } from "@google/genai";
import { buildCorpusChunkId } from "@alphabook/corpus-core";
import { prepareCorpusIngest } from "./corpus-ingest";
import { gutenbergCorpusAdapter } from "@alphabook/source-gutenberg/adapter";
import { listMirrorIds, resolveMirrorSource } from "@alphabook/source-gutenberg/mirror";

const DEFAULT_GOOGLE_BATCH_PRICE_PER_MILLION_TOKENS_USD = 0.075;
const DEFAULT_GOOGLE_BATCH_MAX_FILE_BYTES = 1_500_000_000;
const GOOGLE_BATCH_REQUEST_MIME_TYPE = "application/json";

export interface GoogleEmbeddingBatchRequest {
  request: {
    content: {
      parts: Array<{ text: string }>;
    };
    taskType: "RETRIEVAL_DOCUMENT";
    title?: string;
    outputDimensionality: number;
  };
}

export interface GoogleEmbeddingBatchSidecarRow {
  sourceId: string;
  gutenbergId: string;
  chunkIndex: number;
  title: string;
  authors: string[];
  language: string | null;
  rightsStatus: string | null;
  estimatedTokens: number;
}

export interface GoogleEmbeddingBatchPreparedFile {
  index: number;
  requestPath: string;
  sidecarPath: string;
  requestCount: number;
  totalBytes: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  firstGutenbergId: string | null;
  lastGutenbergId: string | null;
}

export interface GoogleEmbeddingBatchManifest {
  runId: string;
  createdAt: string;
  mirrorRoot: string;
  model: string;
  dimensions: number;
  chunkTargetSize: number;
  pricePerMillionTokensUsd: number;
  targetCostUsd: number;
  targetTokens: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  requestCount: number;
  bookCount: number;
  startAfterId: string | null;
  lastIncludedId: string | null;
  outputDir: string;
  files: GoogleEmbeddingBatchPreparedFile[];
}

export interface GoogleEmbeddingBatchSubmission {
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
    uploadedFileName: string | null;
    batchJobName: string | null;
    state: string | null;
    destFileName: string | null;
    errorMessage: string | null;
  }>;
}

export interface PrepareGoogleEmbeddingBatchOptions {
  mirrorRoot: string;
  startAfterId?: string | null;
  targetCostUsd: number;
  outputDir: string;
  maxFileBytes?: number;
  chunkTargetSize: number;
  dimensions: number;
  model: string;
  pricePerMillionTokensUsd?: number;
  limitBooks?: number | null;
}

export function estimateEmbeddingInputTokensForText(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }
  return Math.ceil(normalized.length / 4);
}

export function estimateEmbeddingCostUsd(
  estimatedTokens: number,
  pricePerMillionTokensUsd = DEFAULT_GOOGLE_BATCH_PRICE_PER_MILLION_TOKENS_USD,
) {
  return Number(((estimatedTokens / 1_000_000) * pricePerMillionTokensUsd).toFixed(8));
}

export function buildGoogleEmbeddingBatchRequest(
  text: string,
  dimensions: number,
  title?: string | null,
): GoogleEmbeddingBatchRequest {
  return {
    request: {
      content: {
        parts: [{ text }],
      },
      taskType: "RETRIEVAL_DOCUMENT",
      ...(title?.trim() ? { title: title.trim() } : {}),
      outputDimensionality: dimensions,
    },
  };
}

function resolveGoogleApiKey() {
  const apiKey = process.env.GOOGLE_AI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GOOGLE_AI_API_KEY or GOOGLE_API_KEY is required for Google Batch embeddings.");
  }
  return apiKey;
}

function createGoogleGenAI() {
  return new GoogleGenAI({
    apiKey: resolveGoogleApiKey(),
  });
}

class BatchFileWriter {
  readonly requestPath: string;
  readonly sidecarPath: string;
  readonly index: number;
  requestCount = 0;
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

  canFit(bytes: number, maxFileBytes: number) {
    return this.requestCount === 0 || this.totalBytes + bytes <= maxFileBytes;
  }

  async write(
    requestLine: string,
    sidecarLine: string,
    estimatedTokens: number,
    gutenbergId: string,
  ) {
    const bytes = Buffer.byteLength(`${requestLine}\n`, "utf8");
    await Promise.all([
      new Promise<void>((resolvePromise, rejectPromise) => {
        this.requestStream.write(`${requestLine}\n`, "utf8", (error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      }),
      new Promise<void>((resolvePromise, rejectPromise) => {
        this.sidecarStream.write(`${sidecarLine}\n`, "utf8", (error) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      }),
    ]);
    this.requestCount += 1;
    this.totalBytes += bytes;
    this.estimatedTokens += estimatedTokens;
    this.firstGutenbergId ??= gutenbergId;
    this.lastGutenbergId = gutenbergId;
  }

  async close() {
    await Promise.all([
      new Promise<void>((resolvePromise, rejectPromise) => {
        this.requestStream.end((error?: Error | null) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      }),
      new Promise<void>((resolvePromise, rejectPromise) => {
        this.sidecarStream.end((error?: Error | null) => {
          if (error) {
            rejectPromise(error);
            return;
          }
          resolvePromise();
        });
      }),
    ]);
  }
}

function numericIdOrInfinity(value: string | null | undefined) {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export async function prepareGoogleEmbeddingBatch(
  options: PrepareGoogleEmbeddingBatchOptions,
): Promise<{ manifestPath: string; manifest: GoogleEmbeddingBatchManifest }> {
  const mirrorIds = await listMirrorIds(options.mirrorRoot);
  const runId = `google-embedding-batch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = resolve(options.outputDir);
  const maxFileBytes = Math.max(1_000_000, options.maxFileBytes ?? DEFAULT_GOOGLE_BATCH_MAX_FILE_BYTES);
  const pricePerMillionTokensUsd = options.pricePerMillionTokensUsd ?? DEFAULT_GOOGLE_BATCH_PRICE_PER_MILLION_TOKENS_USD;
  const targetTokens = Math.max(1, Math.floor((options.targetCostUsd / pricePerMillionTokensUsd) * 1_000_000));
  const startAfter = numericIdOrInfinity(options.startAfterId ?? null);
  const limitBooks = options.limitBooks ?? null;

  await mkdir(runDir, { recursive: true });

  const files: GoogleEmbeddingBatchPreparedFile[] = [];
  let currentFile: BatchFileWriter | null = null;
  let estimatedTokens = 0;
  let requestCount = 0;
  let bookCount = 0;
  let lastIncludedId: string | null = null;

  for (const gutenbergId of mirrorIds) {
    const numericId = Number.parseInt(gutenbergId, 10);
    if (!Number.isFinite(numericId) || numericId <= startAfter) {
      continue;
    }
    if (limitBooks !== null && bookCount >= limitBooks) {
      break;
    }
    if (estimatedTokens >= targetTokens && requestCount > 0) {
      break;
    }

    const source = await resolveMirrorSource(options.mirrorRoot, gutenbergId).catch(() => null);
    if (!source) {
      continue;
    }
    const prepared = prepareCorpusIngest(
      gutenbergCorpusAdapter,
      {
        adapterId: gutenbergCorpusAdapter.id,
        externalId: gutenbergId,
        legacyNumericId: gutenbergId,
        title: source.title ?? `Project Gutenberg ${gutenbergId}`,
        rawSource: source.rawSource,
        rawText: source.rawText,
        sourceFormat: source.format,
        authors: source.authors,
        subjects: source.subjects,
        language: source.language,
        releaseDate: source.releaseDate,
        rightsStatus: source.rightsStatus,
        summary: source.summary,
        sourcePath: source.sourcePath,
        metadata: {
          source: "local-mirror",
          mirrorRoot: options.mirrorRoot,
          metadataPath: source.metadataPath,
          format: source.format,
        },
      },
      {
        chunkTargetSize: options.chunkTargetSize,
      },
    );

    if (prepared.chunks.length === 0) {
      continue;
    }

    for (const [chunkIndex, chunkText] of prepared.chunks.entries()) {
      const request = buildGoogleEmbeddingBatchRequest(chunkText, options.dimensions, prepared.metadataPayload.title as string);
      const requestLine = JSON.stringify(request);
      const chunkTokens = estimateEmbeddingInputTokensForText(chunkText);
      const sidecar: GoogleEmbeddingBatchSidecarRow = {
        sourceId: buildCorpusChunkId(gutenbergCorpusAdapter.id, gutenbergId, chunkIndex),
        gutenbergId,
        chunkIndex,
        title: String(prepared.metadataPayload.title ?? `Project Gutenberg ${gutenbergId}`),
        authors: prepared.authors,
        language: typeof prepared.metadataPayload.language === "string" ? prepared.metadataPayload.language : null,
        rightsStatus: typeof prepared.metadataPayload.rightsStatus === "string" ? prepared.metadataPayload.rightsStatus : null,
        estimatedTokens: chunkTokens,
      };
      const sidecarLine = JSON.stringify(sidecar);
      const requestBytes = Buffer.byteLength(`${requestLine}\n`, "utf8");

      if (!currentFile || !currentFile.canFit(requestBytes, maxFileBytes)) {
        if (currentFile) {
          await currentFile.close();
          files.push({
            index: currentFile.index,
            requestPath: currentFile.requestPath,
            sidecarPath: currentFile.sidecarPath,
            requestCount: currentFile.requestCount,
            totalBytes: currentFile.totalBytes,
            estimatedTokens: currentFile.estimatedTokens,
            estimatedCostUsd: estimateEmbeddingCostUsd(currentFile.estimatedTokens, pricePerMillionTokensUsd),
            firstGutenbergId: currentFile.firstGutenbergId,
            lastGutenbergId: currentFile.lastGutenbergId,
          });
        }
        currentFile = new BatchFileWriter(runDir, files.length + 1);
      }

      await currentFile.write(requestLine, sidecarLine, chunkTokens, gutenbergId);
      estimatedTokens += chunkTokens;
      requestCount += 1;
      lastIncludedId = gutenbergId;

      if (estimatedTokens >= targetTokens) {
        break;
      }
    }

    bookCount += 1;
  }

  if (currentFile) {
    await currentFile.close();
    files.push({
      index: currentFile.index,
      requestPath: currentFile.requestPath,
      sidecarPath: currentFile.sidecarPath,
      requestCount: currentFile.requestCount,
      totalBytes: currentFile.totalBytes,
      estimatedTokens: currentFile.estimatedTokens,
      estimatedCostUsd: estimateEmbeddingCostUsd(currentFile.estimatedTokens, pricePerMillionTokensUsd),
      firstGutenbergId: currentFile.firstGutenbergId,
      lastGutenbergId: currentFile.lastGutenbergId,
    });
  }

  const manifest: GoogleEmbeddingBatchManifest = {
    runId,
    createdAt: new Date().toISOString(),
    mirrorRoot: options.mirrorRoot,
    model: options.model,
    dimensions: options.dimensions,
    chunkTargetSize: options.chunkTargetSize,
    pricePerMillionTokensUsd,
    targetCostUsd: Number(options.targetCostUsd.toFixed(2)),
    targetTokens,
    estimatedTokens,
    estimatedCostUsd: estimateEmbeddingCostUsd(estimatedTokens, pricePerMillionTokensUsd),
    requestCount,
    bookCount,
    startAfterId: options.startAfterId ?? null,
    lastIncludedId,
    outputDir: runDir,
    files,
  };
  const manifestPath = join(runDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { manifestPath, manifest };
}

export async function submitGoogleEmbeddingBatch(manifestPathInput: string) {
  const manifestPath = resolve(manifestPathInput);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GoogleEmbeddingBatchManifest;
  const ai = createGoogleGenAI();
  const submission: GoogleEmbeddingBatchSubmission = {
    manifestPath,
    submittedAt: new Date().toISOString(),
    model: manifest.model,
    jobs: [],
  };

  for (const file of manifest.files) {
    const uploaded = await ai.files.upload({
      file: file.requestPath,
      config: {
        mimeType: GOOGLE_BATCH_REQUEST_MIME_TYPE,
      },
    });
    const batchJob = await ai.batches.createEmbeddings({
      model: manifest.model,
      src: {
        fileName: uploaded.name!,
      },
      config: {
        displayName: `${manifest.runId}-part-${String(file.index).padStart(4, "0")}`,
      },
    });
    submission.jobs.push({
      index: file.index,
      requestPath: file.requestPath,
      sidecarPath: file.sidecarPath,
      requestCount: file.requestCount,
      estimatedTokens: file.estimatedTokens,
      estimatedCostUsd: file.estimatedCostUsd,
      uploadedFileName: uploaded.name ?? null,
      batchJobName: batchJob.name ?? null,
      state: batchJob.state ?? null,
      destFileName: batchJob.dest?.fileName ?? null,
      errorMessage: batchJob.error?.message ?? null,
    });
  }

  const submissionPath = join(dirname(manifestPath), "submission.json");
  await writeFile(submissionPath, JSON.stringify(submission, null, 2), "utf8");
  return { submissionPath, submission };
}

export async function getGoogleEmbeddingBatchStatus(nameOrSubmissionPath: string) {
  const ai = createGoogleGenAI();
  const resolvedPath = resolve(nameOrSubmissionPath);
  const maybeJson = await readFile(resolvedPath, "utf8").catch(() => null);
  if (maybeJson) {
    const submission = JSON.parse(maybeJson) as GoogleEmbeddingBatchSubmission;
    const jobs = await Promise.all(submission.jobs.map(async (job) => {
      if (!job.batchJobName) {
        return job;
      }
      const batchJob = await ai.batches.get({ name: job.batchJobName });
      return {
        ...job,
        state: batchJob.state ?? null,
        destFileName: batchJob.dest?.fileName ?? null,
        errorMessage: batchJob.error?.message ?? null,
      };
    }));
    const updated: GoogleEmbeddingBatchSubmission = {
      ...submission,
      jobs,
    };
    await writeFile(resolvedPath, JSON.stringify(updated, null, 2), "utf8");
    return updated;
  }

  const batchJob = await ai.batches.get({ name: nameOrSubmissionPath });
  return batchJob;
}

export async function downloadGoogleEmbeddingBatchOutputs(
  submissionPathInput: string,
  outputDirInput?: string | null,
) {
  const submissionPath = resolve(submissionPathInput);
  const submission = JSON.parse(await readFile(submissionPath, "utf8")) as GoogleEmbeddingBatchSubmission;
  const ai = createGoogleGenAI();
  const outputDir = resolve(outputDirInput ?? join(dirname(submissionPath), "outputs"));
  await mkdir(outputDir, { recursive: true });

  const downloads: Array<{
    index: number;
    batchJobName: string;
    destFileName: string;
    downloadPath: string;
  }> = [];

  for (const job of submission.jobs) {
    if (!job.batchJobName || !job.destFileName) {
      continue;
    }
    const downloadPath = join(outputDir, `embedding-batch-${String(job.index).padStart(4, "0")}-output.jsonl`);
    await ai.files.download({
      file: job.destFileName,
      downloadPath,
    });
    downloads.push({
      index: job.index,
      batchJobName: job.batchJobName,
      destFileName: job.destFileName,
      downloadPath,
    });
  }

  const downloadManifestPath = join(outputDir, "downloads.json");
  await writeFile(downloadManifestPath, JSON.stringify({
    submissionPath,
    createdAt: new Date().toISOString(),
    downloads,
  }, null, 2), "utf8");

  return {
    outputDir,
    downloadManifestPath,
    downloads,
  };
}

export async function createGoogleEmbeddingBatchFromEnv(args: {
  startAfterId?: string | null;
  targetCostUsd?: number;
  outputDir?: string | null;
  maxFileBytes?: number | null;
  limitBooks?: number | null;
  chunkTargetSize: number;
  model: string;
  dimensions: number;
}) {
  const mirrorRoot = process.env.GUTENBERG_MIRROR_ROOT?.trim();
  if (!mirrorRoot) {
    throw new Error("GUTENBERG_MIRROR_ROOT is required for prepare-google-embedding-batch.");
  }
  const outputDir = args.outputDir?.trim()
    ? resolve(args.outputDir)
    : resolve(process.cwd(), ".alphabook", "google-embedding-batch");
  return prepareGoogleEmbeddingBatch({
    mirrorRoot,
    startAfterId: args.startAfterId ?? null,
    targetCostUsd: args.targetCostUsd ?? 300,
    outputDir,
    maxFileBytes: args.maxFileBytes ?? DEFAULT_GOOGLE_BATCH_MAX_FILE_BYTES,
    chunkTargetSize: args.chunkTargetSize,
    dimensions: args.dimensions,
    model: args.model,
    pricePerMillionTokensUsd: DEFAULT_GOOGLE_BATCH_PRICE_PER_MILLION_TOKENS_USD,
    limitBooks: args.limitBooks ?? null,
  });
}
