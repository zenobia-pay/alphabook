import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { buildCorpusChunkId } from "@alphabook/corpus-core";
import { prepareCorpusIngest } from "./corpus-ingest";
import { gutenbergCorpusAdapter } from "@alphabook/source-gutenberg/adapter";
import { listMirrorIds, resolveMirrorSource } from "@alphabook/source-gutenberg/mirror";

const DEFAULT_OPENAI_BATCH_PRICE_PER_MILLION_TOKENS_USD = 0.01;
const DEFAULT_OPENAI_BATCH_MAX_FILE_BYTES = 190_000_000;
const DEFAULT_OPENAI_BATCH_MAX_REQUESTS_PER_FILE = 50_000;
const DEFAULT_OPENAI_BATCH_MAX_INPUTS_PER_FILE = 50_000;
const OPENAI_BATCH_COMPLETION_WINDOW = "24h";
const OPENAI_BATCH_ENDPOINT = "/v1/embeddings";
const OPENAI_RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export interface OpenAIEmbeddingBatchRequestLine {
  custom_id: string;
  method: "POST";
  url: "/v1/embeddings";
  body: {
    model: string;
    input: string | string[];
    dimensions?: number;
    encoding_format?: "float";
  };
}

export interface OpenAIEmbeddingBatchSidecarRow {
  sourceId: string;
  gutenbergId: string;
  chunkIndex: number;
  title: string;
  authors: string[];
  language: string | null;
  rightsStatus: string | null;
  estimatedTokens: number;
}

export interface OpenAIEmbeddingBatchPreparedFile {
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

export interface OpenAIEmbeddingBatchManifest {
  runId: string;
  createdAt: string;
  mirrorRoot: string;
  model: string;
  dimensions: number | null;
  chunkTargetSize: number;
  requestBatchSize: number;
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
  files: OpenAIEmbeddingBatchPreparedFile[];
}

export interface OpenAIEmbeddingBatchSubmission {
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
}

function resolveSubmissionPath(manifestPath: string) {
  return join(dirname(manifestPath), "submission.json");
}

export interface PrepareOpenAIEmbeddingBatchOptions {
  mirrorRoot: string;
  startAfterId?: string | null;
  targetCostUsd: number;
  outputDir: string;
  maxFileBytes?: number;
  maxRequestsPerFile?: number;
  maxInputsPerFile?: number;
  chunkTargetSize: number;
  requestBatchSize: number;
  dimensions?: number | null;
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
  pricePerMillionTokensUsd = DEFAULT_OPENAI_BATCH_PRICE_PER_MILLION_TOKENS_USD,
) {
  return Number(((estimatedTokens / 1_000_000) * pricePerMillionTokensUsd).toFixed(8));
}

export function resolveOpenAIMaxRequestsPerFile(requestBatchSize: number, configuredMaxRequestsPerFile?: number | null, maxInputsPerFile = DEFAULT_OPENAI_BATCH_MAX_INPUTS_PER_FILE) {
  return Math.max(
    1,
    Math.min(
      configuredMaxRequestsPerFile ?? DEFAULT_OPENAI_BATCH_MAX_REQUESTS_PER_FILE,
      Math.floor(Math.max(requestBatchSize, maxInputsPerFile) / Math.max(1, requestBatchSize)),
    ),
  );
}

export function buildOpenAIEmbeddingBatchRequest(
  customId: string,
  input: string | string[],
  model: string,
  dimensions?: number | null,
): OpenAIEmbeddingBatchRequestLine {
  return {
    custom_id: customId,
    method: "POST",
    url: OPENAI_BATCH_ENDPOINT,
    body: {
      model,
      input,
      ...(dimensions ? { dimensions } : {}),
      encoding_format: "float",
    },
  };
}

function resolveOpenAIApiKey() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for OpenAI Batch embeddings.");
  }
  return apiKey;
}

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
    this.inputCount += inputCount;
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
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

async function openAIRequest(path: string, init: RequestInit) {
  const apiKey = resolveOpenAIApiKey();
  let lastError: Error | null = null;
  const maxAttempts = path === "/v1/files" ? 8 : 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`https://api.openai.com${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(init.headers ?? {}),
        },
      });
      if (response.ok) {
        return response;
      }
      const detail = await response.text();
      const error = new Error(`OpenAI request failed: ${response.status} ${detail}`);
      if (!OPENAI_RETRYABLE_STATUS_CODES.has(response.status) || attempt >= maxAttempts) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= maxAttempts) {
        throw lastError;
      }
    }
    const backoffMs = Math.min(60_000, 1_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, backoffMs));
  }
  throw lastError ?? new Error("OpenAI request failed.");
}

async function uploadBatchInputFile(requestPath: string) {
  const form = new FormData();
  form.set("purpose", "batch");
  form.set(
    "file",
    new Blob([await readFile(requestPath)], { type: "application/jsonl" }),
    basename(requestPath),
  );
  const response = await openAIRequest("/v1/files", {
    method: "POST",
    body: form,
  });
  return response.json() as Promise<{ id: string }>;
}

async function createBatch(inputFileId: string, metadata?: Record<string, string>) {
  const response = await openAIRequest("/v1/batches", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint: OPENAI_BATCH_ENDPOINT,
      completion_window: OPENAI_BATCH_COMPLETION_WINDOW,
      ...(metadata ? { metadata } : {}),
    }),
  });
  return response.json() as Promise<{
    id: string;
    status?: string;
    output_file_id?: string | null;
    error_file_id?: string | null;
    errors?: { data?: Array<{ message?: string }> } | null;
  }>;
}

async function getBatch(batchId: string) {
  const response = await openAIRequest(`/v1/batches/${batchId}`, {
    method: "GET",
  });
  return response.json() as Promise<{
    id: string;
    status?: string;
    output_file_id?: string | null;
    error_file_id?: string | null;
    errors?: { data?: Array<{ message?: string }> } | null;
  }>;
}

async function downloadFileContent(fileId: string) {
  const response = await openAIRequest(`/v1/files/${fileId}/content`, {
    method: "GET",
  });
  return response.text();
}

export async function prepareOpenAIEmbeddingBatch(
  options: PrepareOpenAIEmbeddingBatchOptions,
): Promise<{ manifestPath: string; manifest: OpenAIEmbeddingBatchManifest }> {
  const mirrorIds = await listMirrorIds(options.mirrorRoot);
  const runId = `openai-embedding-batch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = resolve(options.outputDir);
  const maxFileBytes = Math.max(1_000_000, options.maxFileBytes ?? DEFAULT_OPENAI_BATCH_MAX_FILE_BYTES);
  const pricePerMillionTokensUsd = options.pricePerMillionTokensUsd ?? DEFAULT_OPENAI_BATCH_PRICE_PER_MILLION_TOKENS_USD;
  const targetTokens = Math.max(1, Math.floor((options.targetCostUsd / pricePerMillionTokensUsd) * 1_000_000));
  const startAfter = numericIdOrInfinity(options.startAfterId ?? null);
  const limitBooks = options.limitBooks ?? null;
  const requestBatchSize = Math.max(1, options.requestBatchSize);
  const maxInputsPerFile = Math.max(requestBatchSize, options.maxInputsPerFile ?? DEFAULT_OPENAI_BATCH_MAX_INPUTS_PER_FILE);
  const maxRequestsPerFile = resolveOpenAIMaxRequestsPerFile(
    requestBatchSize,
    options.maxRequestsPerFile ?? DEFAULT_OPENAI_BATCH_MAX_REQUESTS_PER_FILE,
    maxInputsPerFile,
  );

  await mkdir(runDir, { recursive: true });

  const files: OpenAIEmbeddingBatchPreparedFile[] = [];
  let currentFile: BatchFileWriter | null = null;
  let estimatedTokens = 0;
  let requestCount = 0;
  let bookCount = 0;
  let lastIncludedId: string | null = null;
  let pendingTexts: string[] = [];
  let pendingSidecars: OpenAIEmbeddingBatchSidecarRow[] = [];
  let pendingTokens = 0;

  const flushPending = async () => {
    if (pendingTexts.length === 0) {
      return;
    }
    const customId = `embedding-request-${String(requestCount + 1).padStart(8, "0")}`;
    const request = buildOpenAIEmbeddingBatchRequest(
      customId,
      pendingTexts,
      options.model,
      options.dimensions ?? null,
    );
    const requestLine = JSON.stringify(request);
    const sidecarLine = JSON.stringify(pendingSidecars);
    const requestBytes = Buffer.byteLength(`${requestLine}\n`, "utf8");

    const requestInputCount = pendingTexts.length;
    if (!currentFile || !currentFile.canFit(requestBytes, requestInputCount, maxFileBytes, maxRequestsPerFile, maxInputsPerFile)) {
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

    await currentFile.write(requestLine, sidecarLine, pendingTokens, pendingSidecars[0]!.gutenbergId, requestInputCount);
    requestCount += 1;
    pendingTexts = [];
    pendingSidecars = [];
    pendingTokens = 0;
  };

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
      const sourceId = buildCorpusChunkId(gutenbergCorpusAdapter.id, gutenbergId, chunkIndex);
      const chunkTokens = estimateEmbeddingInputTokensForText(chunkText);
      const sidecar: OpenAIEmbeddingBatchSidecarRow = {
        sourceId,
        gutenbergId,
        chunkIndex,
        title: String(prepared.metadataPayload.title ?? `Project Gutenberg ${gutenbergId}`),
        authors: prepared.authors,
        language: typeof prepared.metadataPayload.language === "string" ? prepared.metadataPayload.language : null,
        rightsStatus: typeof prepared.metadataPayload.rightsStatus === "string" ? prepared.metadataPayload.rightsStatus : null,
        estimatedTokens: chunkTokens,
      };
      estimatedTokens += chunkTokens;
      lastIncludedId = gutenbergId;
      pendingTexts.push(chunkText);
      pendingSidecars.push(sidecar);
      pendingTokens += chunkTokens;

      if (pendingTexts.length >= requestBatchSize) {
        await flushPending();
      }

      if (estimatedTokens >= targetTokens) {
        break;
      }
    }

    bookCount += 1;
  }

  await flushPending();

  if (currentFile !== null) {
    const finalizedFile = currentFile as BatchFileWriter;
    await finalizedFile.close();
    files.push({
      index: finalizedFile.index,
      requestPath: finalizedFile.requestPath,
      sidecarPath: finalizedFile.sidecarPath,
      requestCount: finalizedFile.requestCount,
      totalBytes: finalizedFile.totalBytes,
      estimatedTokens: finalizedFile.estimatedTokens,
      estimatedCostUsd: estimateEmbeddingCostUsd(finalizedFile.estimatedTokens, pricePerMillionTokensUsd),
      firstGutenbergId: finalizedFile.firstGutenbergId,
      lastGutenbergId: finalizedFile.lastGutenbergId,
    });
  }

  const manifest: OpenAIEmbeddingBatchManifest = {
    runId,
    createdAt: new Date().toISOString(),
    mirrorRoot: options.mirrorRoot,
    model: options.model,
    dimensions: options.dimensions ?? null,
    chunkTargetSize: options.chunkTargetSize,
    requestBatchSize,
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

export async function submitOpenAIEmbeddingBatch(manifestPathInput: string) {
  const manifestPath = resolve(manifestPathInput);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OpenAIEmbeddingBatchManifest;
  const submissionPath = resolveSubmissionPath(manifestPath);
  const existingSubmission = await readFile(submissionPath, "utf8")
    .then((text) => JSON.parse(text) as OpenAIEmbeddingBatchSubmission)
    .catch(() => null);
  const submission: OpenAIEmbeddingBatchSubmission = existingSubmission ?? {
    manifestPath,
    submittedAt: new Date().toISOString(),
    model: manifest.model,
    jobs: [],
  };
  const jobsByIndex = new Map(submission.jobs.map((job) => [job.index, job]));

  for (const file of manifest.files) {
    const existingJob = jobsByIndex.get(file.index);
    if (existingJob?.batchId) {
      continue;
    }
    const uploaded = await uploadBatchInputFile(file.requestPath);
    const batch = await createBatch(uploaded.id, {
      run_id: manifest.runId,
      part: String(file.index),
    });
    const job = {
      index: file.index,
      requestPath: file.requestPath,
      sidecarPath: file.sidecarPath,
      requestCount: file.requestCount,
      estimatedTokens: file.estimatedTokens,
      estimatedCostUsd: file.estimatedCostUsd,
      uploadedFileId: uploaded.id ?? null,
      batchId: batch.id ?? null,
      status: batch.status ?? null,
      outputFileId: batch.output_file_id ?? null,
      errorFileId: batch.error_file_id ?? null,
      errorMessage: batch.errors?.data?.map((item) => item.message).filter(Boolean).join("; ") || null,
    };
    jobsByIndex.set(file.index, job);
    submission.jobs = [...jobsByIndex.values()].sort((left, right) => left.index - right.index);
    await writeFile(submissionPath, JSON.stringify(submission, null, 2), "utf8");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return { submissionPath, submission };
}

export async function getOpenAIEmbeddingBatchStatus(idOrSubmissionPath: string) {
  const resolvedPath = resolve(idOrSubmissionPath);
  const maybeJson = await readFile(resolvedPath, "utf8").catch(() => null);
  if (maybeJson) {
    const submission = JSON.parse(maybeJson) as OpenAIEmbeddingBatchSubmission;
    const jobs = await Promise.all(submission.jobs.map(async (job) => {
      if (!job.batchId) {
        return job;
      }
      const batch = await getBatch(job.batchId);
      return {
        ...job,
        status: batch.status ?? null,
        outputFileId: batch.output_file_id ?? null,
        errorFileId: batch.error_file_id ?? null,
        errorMessage: batch.errors?.data?.map((item) => item.message).filter(Boolean).join("; ") || null,
      };
    }));
    const updated: OpenAIEmbeddingBatchSubmission = {
      ...submission,
      jobs,
    };
    await writeFile(resolvedPath, JSON.stringify(updated, null, 2), "utf8");
    return updated;
  }

  return getBatch(idOrSubmissionPath);
}

export async function downloadOpenAIEmbeddingBatchOutputs(
  submissionPathInput: string,
  outputDirInput?: string | null,
) {
  const submissionPath = resolve(submissionPathInput);
  const submission = JSON.parse(await readFile(submissionPath, "utf8")) as OpenAIEmbeddingBatchSubmission;
  const outputDir = resolve(outputDirInput ?? join(dirname(submissionPath), "outputs"));
  await mkdir(outputDir, { recursive: true });

  const downloads: Array<{
    index: number;
    batchId: string;
    outputFileId: string;
    downloadPath: string;
  }> = [];

  for (const job of submission.jobs) {
    if (!job.batchId || !job.outputFileId) {
      continue;
    }
    const downloadPath = join(outputDir, `embedding-batch-${String(job.index).padStart(4, "0")}-output.jsonl`);
    const content = await downloadFileContent(job.outputFileId);
    await writeFile(downloadPath, content, "utf8");
    downloads.push({
      index: job.index,
      batchId: job.batchId,
      outputFileId: job.outputFileId,
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

export async function createOpenAIEmbeddingBatchFromEnv(args: {
  startAfterId?: string | null;
  targetCostUsd?: number;
  outputDir?: string | null;
  maxFileBytes?: number | null;
  maxRequestsPerFile?: number | null;
  limitBooks?: number | null;
  chunkTargetSize: number;
  model: string;
  dimensions?: number | null;
}) {
  const mirrorRoot = process.env.GUTENBERG_MIRROR_ROOT?.trim();
  if (!mirrorRoot) {
    throw new Error("GUTENBERG_MIRROR_ROOT is required for prepare-openai-embedding-batch.");
  }
  const outputDir = args.outputDir?.trim()
    ? resolve(args.outputDir)
    : resolve(process.cwd(), ".alphabook", "openai-embedding-batch");
  return prepareOpenAIEmbeddingBatch({
    mirrorRoot,
    startAfterId: args.startAfterId ?? null,
    targetCostUsd: args.targetCostUsd ?? 300,
    outputDir,
    maxFileBytes: args.maxFileBytes ?? DEFAULT_OPENAI_BATCH_MAX_FILE_BYTES,
    maxRequestsPerFile: args.maxRequestsPerFile ?? DEFAULT_OPENAI_BATCH_MAX_REQUESTS_PER_FILE,
    maxInputsPerFile: DEFAULT_OPENAI_BATCH_MAX_INPUTS_PER_FILE,
    chunkTargetSize: args.chunkTargetSize,
    requestBatchSize: Number(process.env.OPENAI_EMBEDDING_BATCH_SIZE ?? "32"),
    dimensions: args.dimensions ?? null,
    model: args.model,
    pricePerMillionTokensUsd: Number(
      process.env.OPENAI_BATCH_EMBEDDING_PRICE_PER_MILLION_TOKENS_USD ?? DEFAULT_OPENAI_BATCH_PRICE_PER_MILLION_TOKENS_USD,
    ),
    limitBooks: args.limitBooks ?? null,
  });
}
