export type GutenbergArtifactKind = "raw" | "metadata" | "clean" | "chunks" | "book_html" | "book_manifest" | "book_page" | "cover" | "unknown";

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
  chunk_index?: number;
  text?: string;
  r2_key?: string | null;
  embedding_dimensions?: number | null;
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

export function getMissingRequiredArtifacts(artifacts: GutenbergR2Artifacts): GutenbergArtifactKind[] {
  return REQUIRED_CANONICAL_ARTIFACTS.filter((kind) => !artifacts.keys[kind]?.length);
}
