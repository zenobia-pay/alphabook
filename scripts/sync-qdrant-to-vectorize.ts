import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type QdrantOffset = string | number | null;

type VectorizeRecord = {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
};

type QdrantScrollPoint = {
  id?: string | number;
  vector?: number[] | Record<string, number[]>;
  payload?: Record<string, unknown>;
};

type QdrantScrollResponse = {
  result?: {
    points?: QdrantScrollPoint[];
    next_page_offset?: QdrantOffset;
  };
};

type QdrantInfoResponse = {
  result?: {
    config?: {
      params?: {
        vectors?: {
          size?: number;
        };
      };
    };
    points_count?: number;
  };
};

type VectorizeInfo = {
  dimensions?: number;
  vectorCount?: number;
};

type CheckpointState = {
  offset: QdrantOffset;
  processedPoints: number;
  uploadedVectors: number;
  batches: number;
  updatedAt: string;
};

type GutenbergIdRange = {
  min?: number;
  max?: number;
};

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function normalizePointId(point: QdrantScrollPoint) {
  const sourceId = point.payload?.source_id;
  if (typeof sourceId === "string" && sourceId.length > 0) {
    return sourceId;
  }
  if (typeof point.id === "string" || typeof point.id === "number") {
    return String(point.id);
  }
  throw new Error("Qdrant point did not contain a usable id.");
}

function normalizeVector(point: QdrantScrollPoint) {
  if (Array.isArray(point.vector)) {
    return point.vector;
  }
  if (point.vector && typeof point.vector === "object") {
    const named = Object.values(point.vector).find((value) => Array.isArray(value));
    if (named) {
      return named;
    }
  }
  throw new Error(`Qdrant point ${normalizePointId(point)} did not include a vector.`);
}

function normalizeMetadata(point: QdrantScrollPoint) {
  if (!point.payload) {
    return undefined;
  }
  const metadata = { ...point.payload };
  delete metadata.source_id;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

async function qdrantRequest<T>(path: string, init: RequestInit): Promise<T> {
  const baseUrl = requireEnv("QDRANT_URL").replace(/\/$/, "");
  const apiKey = process.env.QDRANT_API_KEY?.trim();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (apiKey) {
    headers.set("api-key", apiKey);
  }
  const response = await fetch(`${baseUrl}/${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`Qdrant request failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

async function fetchQdrantInfo() {
  const collection = requireEnv("QDRANT_COLLECTION");
  const payload = await qdrantRequest<QdrantInfoResponse>(`collections/${encodeURIComponent(collection)}`, {
    method: "GET",
  });
  return {
    dimensions: payload.result?.config?.params?.vectors?.size,
    pointCount: payload.result?.points_count,
  };
}

async function fetchQdrantBatch(limit: number, offset: QdrantOffset) {
  const collection = requireEnv("QDRANT_COLLECTION");
  const filter = buildGutenbergIdFilter();
  const payload = await qdrantRequest<QdrantScrollResponse>(
    `collections/${encodeURIComponent(collection)}/points/scroll`,
    {
      method: "POST",
      body: JSON.stringify({
        limit,
        with_payload: true,
        with_vector: true,
        ...(filter ? { filter } : {}),
        ...(offset === null ? {} : { offset }),
      }),
    },
  );
  return {
    points: payload.result?.points ?? [],
    nextOffset: payload.result?.next_page_offset ?? null,
  };
}

function parseOptionalInt(value: string | undefined) {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}

function getGutenbergIdRange(): GutenbergIdRange {
  const min = parseOptionalInt(process.env.QDRANT_GUTENBERG_ID_MIN);
  const max = parseOptionalInt(process.env.QDRANT_GUTENBERG_ID_MAX);
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`Invalid Gutenberg ID range: min ${min} exceeds max ${max}`);
  }
  return { min, max };
}

function buildGutenbergIdFilter() {
  const { min, max } = getGutenbergIdRange();
  if (min === undefined && max === undefined) {
    return undefined;
  }
  const range: Record<string, number> = {};
  if (min !== undefined) {
    range.gte = min;
  }
  if (max !== undefined) {
    range.lte = max;
  }
  return {
    must: [
      {
        key: "gutenberg_id",
        range,
      },
    ],
  };
}

async function getVectorizeInfo() {
  const indexName = requireEnv("VECTOR_INDEX_NAME");
  const wranglerConfig = process.env.D1_WRANGLER_CONFIG?.trim() || "apps/orchestrator-worker/wrangler.toml";
  const { stdout } = await execFileAsync("npx", [
    "wrangler",
    "vectorize",
    "info",
    indexName,
    "--json",
    "--config",
    wranglerConfig,
  ], {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error(`Unexpected wrangler vectorize info output: ${stdout}`);
  }
  return JSON.parse(stdout.slice(start)) as VectorizeInfo;
}

async function upsertVectorizeBatch(vectors: VectorizeRecord[]) {
  const indexName = requireEnv("VECTOR_INDEX_NAME");
  const wranglerConfig = process.env.D1_WRANGLER_CONFIG?.trim() || "apps/orchestrator-worker/wrangler.toml";
  const tempDir = await mkdtemp(join(tmpdir(), "alphabook-qdrant-vectorize-"));
  const payloadPath = join(tempDir, "vectors.ndjson");
  try {
    await writeFile(payloadPath, `${vectors.map((vector) => JSON.stringify(vector)).join("\n")}\n`, "utf8");
    await execFileAsync("npx", [
      "wrangler",
      "vectorize",
      "upsert",
      indexName,
      "--file",
      payloadPath,
      "--config",
      wranglerConfig,
    ], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function shouldRetryWithSmallerBatch(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /413|payload too large/i.test(message);
}

async function uploadAdaptive(vectors: VectorizeRecord[], initialBatchSize: number) {
  let batchSize = Math.max(1, initialBatchSize);
  let uploaded = 0;
  let largestSuccessfulBatch = 0;

  for (let index = 0; index < vectors.length;) {
    const batch = vectors.slice(index, index + batchSize);
    try {
      await upsertVectorizeBatch(batch);
      uploaded += batch.length;
      largestSuccessfulBatch = Math.max(largestSuccessfulBatch, batch.length);
      index += batch.length;
    } catch (error) {
      if (!shouldRetryWithSmallerBatch(error) || batch.length === 1) {
        throw error;
      }
      batchSize = Math.max(1, Math.floor(batch.length / 2));
      continue;
    }
  }

  return {
    uploaded,
    nextSuggestedBatchSize: Math.max(1, largestSuccessfulBatch || initialBatchSize),
  };
}

async function readCheckpoint(path: string): Promise<CheckpointState | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CheckpointState;
  } catch {
    return null;
  }
}

async function writeCheckpoint(path: string, state: CheckpointState) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function main() {
  const scrollLimit = Math.max(1, Number(process.env.QDRANT_SCROLL_LIMIT ?? "1000"));
  let uploadBatchSize = Math.max(1, Number(process.env.VECTORIZE_UPSERT_BATCH_SIZE ?? "1000"));
  const checkpointPath = process.env.QDRANT_VECTORIZE_CHECKPOINT_PATH?.trim()
    || ".alphabook/qdrant-to-vectorize-checkpoint.json";
  const range = getGutenbergIdRange();
  const workerLabel = process.env.QDRANT_VECTORIZE_WORKER_LABEL?.trim() || "default";
  const checkpoint = await readCheckpoint(checkpointPath);
  let offset = checkpoint?.offset ?? null;
  let processedPoints = checkpoint?.processedPoints ?? 0;
  let uploadedVectors = checkpoint?.uploadedVectors ?? 0;
  let batches = checkpoint?.batches ?? 0;

  const qdrantInfo = await fetchQdrantInfo();
  const vectorizeInfo = await getVectorizeInfo();
  if (qdrantInfo.dimensions && vectorizeInfo.dimensions && qdrantInfo.dimensions !== vectorizeInfo.dimensions) {
    throw new Error(
      `Qdrant/Vectorize dimension mismatch: qdrant=${qdrantInfo.dimensions}, vectorize=${vectorizeInfo.dimensions}`,
    );
  }

  console.log(JSON.stringify({
    event: "start",
    qdrantCollection: requireEnv("QDRANT_COLLECTION"),
    vectorIndexName: requireEnv("VECTOR_INDEX_NAME"),
    qdrantDimensions: qdrantInfo.dimensions ?? null,
    vectorizeDimensions: vectorizeInfo.dimensions ?? null,
    qdrantPointCount: qdrantInfo.pointCount ?? null,
    vectorizeVectorCount: vectorizeInfo.vectorCount ?? null,
    workerLabel,
    gutenbergIdMin: range.min ?? null,
    gutenbergIdMax: range.max ?? null,
    offset,
    processedPoints,
    uploadedVectors,
    batches,
    scrollLimit,
    uploadBatchSize,
  }));

  while (true) {
    const { points, nextOffset } = await fetchQdrantBatch(scrollLimit, offset);
    if (points.length === 0) {
      break;
    }
    const vectors = points.map((point) => ({
      id: normalizePointId(point),
      values: normalizeVector(point),
      ...(normalizeMetadata(point) ? { metadata: normalizeMetadata(point) } : {}),
    }));
    const upload = await uploadAdaptive(vectors, uploadBatchSize);
    uploadBatchSize = upload.nextSuggestedBatchSize;
    processedPoints += points.length;
    uploadedVectors += upload.uploaded;
    batches += 1;
    offset = nextOffset;
    await writeCheckpoint(checkpointPath, {
      offset,
      processedPoints,
      uploadedVectors,
      batches,
      updatedAt: new Date().toISOString(),
    });
    console.log(JSON.stringify({
      event: "batch",
      batches,
      processedPoints,
      uploadedVectors,
      batchPoints: points.length,
      workerLabel,
      gutenbergIdMin: range.min ?? null,
      gutenbergIdMax: range.max ?? null,
      nextOffset: offset,
      uploadBatchSize,
    }));
    if (nextOffset === null) {
      break;
    }
  }

  const finalInfo = await getVectorizeInfo();
  console.log(JSON.stringify({
    event: "complete",
    processedPoints,
    uploadedVectors,
    batches,
    workerLabel,
    gutenbergIdMin: range.min ?? null,
    gutenbergIdMax: range.max ?? null,
    vectorizeVectorCount: finalInfo.vectorCount ?? null,
    updatedAt: new Date().toISOString(),
  }));
}

await main();
