export type GutenbergArtifactKind = "raw" | "metadata" | "clean" | "chunks" | "chunk_object" | "book_html" | "book_manifest" | "book_page" | "cover" | "unknown";

export interface GutenbergR2Artifacts {
  id: string;
  keys: Partial<Record<GutenbergArtifactKind, string[]>>;
  unknownKeys: string[];
}

export interface GutenbergR2ScanResult {
  byId: Map<string, GutenbergR2Artifacts>;
  canonicalIds: string[];
  idsMissingRequiredArtifacts: string[];
  orphanedKeys: string[];
}

export interface RebuildChunkRecord {
  id?: string;
  work_id?: string;
  work_title?: string | null;
  authors?: string[];
  chunk_index?: number;
  text?: string;
  excerpt?: string | null;
  r2_key?: string | null;
  reader_path?: string | null;
  metadata?: Record<string, unknown> | null;
  embedding_dimensions?: number | null;
}

export interface ChunkPayloadIssue {
  code: "missing_text" | "empty_text" | "duplicate_chunk_id" | "duplicate_chunk_index";
  chunkId: string | null;
  chunkIndex: number | null;
  message: string;
}

const REQUIRED_CANONICAL_ARTIFACTS: GutenbergArtifactKind[] = ["raw", "metadata", "clean", "chunks", "book_html"];

function ensureArtifacts(result: Map<string, GutenbergR2Artifacts>, id: string) {
  const existing = result.get(id);
  if (existing) {
    return existing;
  }
  const created: GutenbergR2Artifacts = {
    id,
    keys: {},
    unknownKeys: [],
  };
  result.set(id, created);
  return created;
}

function pushArtifact(artifacts: GutenbergR2Artifacts, kind: GutenbergArtifactKind, key: string) {
  const existing = artifacts.keys[kind] ?? [];
  existing.push(key);
  artifacts.keys[kind] = existing;
}

function classifyGutenbergKey(key: string): { id: string | null; kind: GutenbergArtifactKind } {
  let match = key.match(/^gutenberg\/raw\/(\d+)\/raw\.txt$/u);
  if (match) return { id: match[1] ?? null, kind: "raw" };
  match = key.match(/^gutenberg\/raw\/(\d+)\/metadata\.json$/u);
  if (match) return { id: match[1] ?? null, kind: "metadata" };
  match = key.match(/^gutenberg\/raw\/(\d+)\/cover\.[^.]+$/u);
  if (match) return { id: match[1] ?? null, kind: "cover" };
  match = key.match(/^gutenberg\/clean\/(\d+)\/clean\.txt$/u);
  if (match) return { id: match[1] ?? null, kind: "clean" };
  match = key.match(/^gutenberg\/clean\/(\d+)\/chunks\.jsonl$/u);
  if (match) return { id: match[1] ?? null, kind: "chunks" };
  match = key.match(/^gutenberg\/clean\/(\d+)\/chunks\/\d+\.json$/u);
  if (match) return { id: match[1] ?? null, kind: "chunk_object" };
  match = key.match(/^gutenberg\/clean\/(\d+)\/book\.html$/u);
  if (match) return { id: match[1] ?? null, kind: "book_html" };
  match = key.match(/^gutenberg\/clean\/(\d+)\/book\/manifest\.json$/u);
  if (match) return { id: match[1] ?? null, kind: "book_manifest" };
  match = key.match(/^gutenberg\/clean\/(\d+)\/book\/pages\/page-\d+\.html$/u);
  if (match) return { id: match[1] ?? null, kind: "book_page" };
  return { id: null, kind: "unknown" };
}

export function scanGutenbergR2Keys(keys: string[]): GutenbergR2ScanResult {
  const byId = new Map<string, GutenbergR2Artifacts>();
  const orphanedKeys: string[] = [];

  for (const key of keys) {
    const { id, kind } = classifyGutenbergKey(key);
    if (!id || kind === "unknown") {
      orphanedKeys.push(key);
      continue;
    }
    const artifacts = ensureArtifacts(byId, id);
    pushArtifact(artifacts, kind, key);
  }

  const canonicalIds: string[] = [];
  const idsMissingRequiredArtifacts: string[] = [];
  for (const [id, artifacts] of byId.entries()) {
    const missingRequired = REQUIRED_CANONICAL_ARTIFACTS.filter((kind) => !artifacts.keys[kind]?.length);
    if (missingRequired.length === 0) {
      canonicalIds.push(id);
    } else {
      idsMissingRequiredArtifacts.push(id);
    }
  }

  canonicalIds.sort((left, right) => Number(left) - Number(right));
  idsMissingRequiredArtifacts.sort((left, right) => Number(left) - Number(right));

  return {
    byId,
    canonicalIds,
    idsMissingRequiredArtifacts,
    orphanedKeys: orphanedKeys.sort(),
  };
}

export function parseChunkPayload(raw: string): RebuildChunkRecord[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RebuildChunkRecord);
}

export function validateChunkPayload(records: RebuildChunkRecord[]): ChunkPayloadIssue[] {
  const issues: ChunkPayloadIssue[] = [];
  const seenIds = new Set<string>();
  const seenIndexes = new Set<number>();

  for (const [fallbackIndex, record] of records.entries()) {
    const chunkIndex = typeof record.chunk_index === "number" ? record.chunk_index : fallbackIndex;
    const chunkId = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : null;
    const text = typeof record.text === "string" ? record.text : null;
    if (text === null) {
      issues.push({
        code: "missing_text",
        chunkId,
        chunkIndex,
        message: `Chunk ${chunkIndex} is missing text.`,
      });
    } else if (text.trim().length === 0) {
      issues.push({
        code: "empty_text",
        chunkId,
        chunkIndex,
        message: `Chunk ${chunkIndex} text was empty.`,
      });
    }

    if (chunkId) {
      if (seenIds.has(chunkId)) {
        issues.push({
          code: "duplicate_chunk_id",
          chunkId,
          chunkIndex,
          message: `Duplicate chunk id ${chunkId}.`,
        });
      } else {
        seenIds.add(chunkId);
      }
    }

    if (seenIndexes.has(chunkIndex)) {
      issues.push({
        code: "duplicate_chunk_index",
        chunkId,
        chunkIndex,
        message: `Duplicate chunk index ${chunkIndex}.`,
      });
    } else {
      seenIndexes.add(chunkIndex);
    }
  }

  return issues;
}

export function getMissingRequiredArtifacts(artifacts: GutenbergR2Artifacts): GutenbergArtifactKind[] {
  return REQUIRED_CANONICAL_ARTIFACTS.filter((kind) => !artifacts.keys[kind]?.length);
}
