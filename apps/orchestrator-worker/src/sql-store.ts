import crypto from "node:crypto";

import type { DbClient } from "@alphabook/db";
import { artifactKeys, buildCorpusChunkId, parseCorpusChunkId } from "@alphabook/corpus-core";
import { workDetailToDocumentDetail } from "@alphabook/platform";
import type { ChunkSearchResult, NotificationType, ToolName, WorkSummary } from "@alphabook/shared";

import { InMemoryAppStore, type AdminRunRecord, type AdminSessionRecord, type AdminUserRecord, type AgentIdentityRecord, type AnalyticsEventRecord, type AppStore, type ArtifactRecord, type BackgroundJobRecord, type BillingEventRecord, type BillingSpendSummary, type DocumentTextRecord, type ExploreWorkFacets, type ExploreWorksFilters, type MessageRecord, type NotificationRecord, type PassageSearchFilters, type ResearchScopeEstimate, type ResearchTaskRecord, type RunEventRecord, type RunRecord, type RuntimeInstanceRecord, type SeedChunk, type SeedWork, type SessionRecord, type SessionSummaryRecord, type ToolCallRecord, type UserProfileStatsRecord, type UserRecord, type WorkDetailRecord, type WorkFileKind, type WorkFileRecord, type WorkSetSizeEstimate } from "./store";
import { MemoryBlobStore, type BlobStore } from "./r2";

const INLINE_PAYLOAD_MAX_BYTES = 4_096;
const INLINE_STRING_MAX_LENGTH = 1_200;
const INLINE_ARRAY_MAX_ITEMS = 12;
const INLINE_OBJECT_MAX_KEYS = 24;
const EXPLORE_LANGUAGE_CODE_RE = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/iu;
const EXPLORE_CLASSIFICATION_CODE_RE = /^(?:[A-Z]{1,3}\d{0,4}(?:\.\d+)?|[A-Z]{1,3})$/u;

type RetentionClass = "product-critical" | "debug-index" | "debug-blob";

function nowIso() {
  return new Date().toISOString();
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJsonArray(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function parseJsonStringList(value: unknown): string[] {
  return parseJsonArray(value)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "null" && entry !== "undefined");
}

function splitSubtitleFromTitle(title: string): { title: string; subtitle: string | null } {
  const match = title.match(/^(.+?)(?:\s+[:;]\s+|\s+[—-]\s+)(.+)$/u);
  if (!match) {
    return { title, subtitle: null };
  }
  return {
    title: match[1]?.trim() || title,
    subtitle: match[2]?.trim() || null,
  };
}

function readMetadataText(metadata: Record<string, unknown> | undefined, keys: string[]) {
  if (!metadata) {
    return null;
  }
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function readMetadataTextList(metadata: Record<string, unknown> | undefined, keys: string[]) {
  if (!metadata) {
    return [];
  }
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      const list = value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean);
      if (list.length > 0) {
        return list;
      }
    }
    if (typeof value === "string" && value.trim()) {
      return value
        .split(/[,;|]/gu)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function normalizeSqlExploreSeed(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const seed = Math.abs(Math.trunc(value)) || 1;
  return {
    primaryFactor: (seed % 46336) + 1,
    primaryOffset: (Math.floor(seed / 46337) % 46337),
    secondaryFactor: (Math.floor(seed / 97) % 46326) + 1,
    secondaryOffset: (Math.floor(seed / 193) % 46327),
  };
}

function isPlausibleExploreLanguageLabel(label: string) {
  const normalized = label.trim();
  if (!normalized) {
    return false;
  }
  return EXPLORE_LANGUAGE_CODE_RE.test(normalized);
}

function isClassificationLikeSubject(label: string) {
  const normalized = label.trim();
  if (!normalized) {
    return false;
  }
  return EXPLORE_CLASSIFICATION_CODE_RE.test(normalized);
}

function parseSiteStatJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function buildSqlExploreOrderBy(idExpression: string, randomSeed: ReturnType<typeof normalizeSqlExploreSeed>, fallbackOrder: string) {
  if (randomSeed == null) {
    return {
      clause: fallbackOrder,
      params: [] as number[],
    };
  }
  return {
    clause: `ORDER BY ((((${idExpression}) % 46337) * ?) + ?) % 46337 ASC, ((((${idExpression}) % 46327) * ?) + ?) % 46327 ASC, ${fallbackOrder.replace(/^ORDER BY\s+/u, "")}`,
    params: [
      randomSeed.primaryFactor,
      randomSeed.primaryOffset,
      randomSeed.secondaryFactor,
      randomSeed.secondaryOffset,
    ],
  };
}

function mapFeedWorkRowToSummary(row: {
  id: string;
  gutenberg_id: number | string | null;
  title: string;
  language: string | null;
  release_date: string | null;
  rights_status: string | null;
  summary: string | null;
  metadata_json: string | Record<string, unknown> | null;
  authors_json?: string | null;
  subjects_json?: string | null;
  score?: number | null;
  feed_label?: string | null;
}): WorkSummary {
  const metadata = parseJsonObject(row.metadata_json);
  const explicitSubtitle = readMetadataText(metadata, ["subtitle", "subTitle", "secondaryTitle"]);
  const explicitCoverImageUrl = readMetadataText(metadata, ["coverImageUrl", "coverUrl", "imageUrl", "thumbnailUrl"]);
  const coverImageKey = readMetadataText(metadata, ["coverImageKey"]);
  const titleParts = explicitSubtitle ? { title: row.title, subtitle: explicitSubtitle } : splitSubtitleFromTitle(row.title);
  return {
    id: row.id,
    gutenbergId: row.gutenberg_id == null ? null : Number(row.gutenberg_id),
    title: titleParts.title,
    subtitle: titleParts.subtitle,
    coverImageUrl: explicitCoverImageUrl,
    hasCoverImage: Boolean(explicitCoverImageUrl || coverImageKey),
    language: row.language ?? null,
    releaseDate: row.release_date ?? null,
    rightsStatus: row.rights_status ?? null,
    summary: row.summary ?? null,
    publisher: readMetadataText(metadata, ["publisher"]),
    authors: parseJsonStringList(row.authors_json),
    subjects: parseJsonStringList(row.subjects_json),
    bookshelves: readMetadataTextList(metadata, ["bookshelves"]),
    translators: readMetadataTextList(metadata, ["translators"]),
    illustrators: readMetadataTextList(metadata, ["illustrators"]),
    editors: readMetadataTextList(metadata, ["editors"]),
    score: typeof row.score === "number" ? row.score : undefined,
    feedLabel: row.feed_label ?? null,
  };
}

function mapWorkRowToDetail(row: {
  id: string;
  gutenberg_id: number | string | null;
  title: string;
  language: string | null;
  release_date: string | null;
  rights_status: string | null;
  summary: string | null;
  metadata_json: string | Record<string, unknown> | null;
  authors_json?: string | null;
  subjects_json?: string | null;
}): WorkDetailRecord {
  const metadata = parseJsonObject(row.metadata_json);
  return {
    ...mapFeedWorkRowToSummary(row),
    metadata,
    authors: parseJsonStringList(row.authors_json),
    subjects: parseJsonStringList(row.subjects_json),
  };
}

type ChunkManifestEntry = {
  id?: string;
  work_title?: string | null;
  authors?: string[];
  chunk_index?: number;
  text?: string;
  excerpt?: string;
  r2_key?: string | null;
  reader_path?: string | null;
  metadata?: Record<string, unknown>;
};

function parseChunkManifest(text: string): ChunkManifestEntry[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChunkManifestEntry);
}

function deriveHandle(email: string | null, name: string | null, id: string) {
  if (email) {
    return email.split("@")[0] ?? id.slice(0, 8);
  }
  if (name) {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32) || id.slice(0, 8);
  }
  return id.slice(0, 8);
}

function jsonByteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateInlineValue(value: unknown, depth = 0): unknown {
  if (depth > 3) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.length > INLINE_STRING_MAX_LENGTH ? `${value.slice(0, INLINE_STRING_MAX_LENGTH)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, INLINE_ARRAY_MAX_ITEMS).map((entry) => truncateInlineValue(entry, depth + 1));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, INLINE_OBJECT_MAX_KEYS)
        .map(([key, entry]) => [key, truncateInlineValue(entry, depth + 1)])
        .filter(([, entry]) => entry !== undefined),
    );
  }
  return value;
}

function containsHeavyPayload(value: unknown, depth = 0): boolean {
  if (depth > 3 || value == null) {
    return false;
  }
  if (typeof value === "string") {
    return value.length > INLINE_STRING_MAX_LENGTH || value.includes("<html") || value.includes("<div") || value.includes("<p");
  }
  if (Array.isArray(value)) {
    return value.length > INLINE_ARRAY_MAX_ITEMS || value.some((entry) => containsHeavyPayload(entry, depth + 1));
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > INLINE_OBJECT_MAX_KEYS) {
      return true;
    }
    return keys.some((key) =>
      key === "researchDocumentHtml"
      || key === "works"
      || key === "documents"
      || key === "selectedChunks"
      || key === "result"
      || key === "content"
      || key === "html"
      || containsHeavyPayload(value[key], depth + 1));
  }
  return false;
}

function shouldSpillPayload(value: unknown): boolean {
  return jsonByteSize(value) > INLINE_PAYLOAD_MAX_BYTES || containsHeavyPayload(value);
}

function buildInlinePayload(value: Record<string, unknown>) {
  const truncated = truncateInlineValue(value);
  return isPlainRecord(truncated) ? truncated : {};
}

function summarizePayload(value: Record<string, unknown>, fallback: string): string {
  for (const key of ["summary", "text", "message", "title", "status"]) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim()) {
      return entry.trim().slice(0, 240);
    }
  }
  return fallback;
}

async function loadJsonBlob(blobStore: BlobStore, ref: string | null | undefined) {
  if (!ref) {
    return null;
  }
  const text = await blobStore.getText(ref);
  return text ? parseJsonObject(text) : null;
}

function compactManifest(manifest: Record<string, unknown>) {
  const taskSpecJson = parseJsonObject(manifest.taskSpec);
  const works = Array.isArray(manifest.works) ? manifest.works : [];
  const selectedWorkIds = works
    .map((item) => (item && typeof item === "object" && "workId" in item ? String((item as { workId: unknown }).workId) : null))
    .filter((value): value is string => Boolean(value));
  const selectedChunks = Array.isArray(manifest.selectedChunks) ? manifest.selectedChunks : [];
  const selectedChunkIds = selectedChunks
    .map((item) => (item && typeof item === "object" && "chunkId" in item ? String((item as { chunkId: unknown }).chunkId) : null))
    .filter((value): value is string => Boolean(value));
  const fileCatalog = Array.isArray(manifest.fileCatalog) ? manifest.fileCatalog : [];
  return {
    compactManifest: {
      taskSpec: taskSpecJson,
      works: selectedWorkIds.map((workId) => ({ workId })),
      selectedChunks: selectedChunkIds.map((chunkId) => ({ chunkId })),
      taskContext: parseJsonObject(manifest.taskContext),
    } satisfies Record<string, unknown>,
    taskSpecJson,
    selectedWorkIds,
    selectedChunkIds,
    fileCatalog,
    researchMode: typeof taskSpecJson.mode === "string" ? taskSpecJson.mode : null,
    shardId: typeof taskSpecJson.shardId === "string" ? taskSpecJson.shardId : null,
    isAggregator: taskSpecJson.kind === "sprite_aggregate",
  };
}

function mapResearchTaskRow(row: {
  id: string;
  run_id: string;
  session_id: string;
  tool_call_id: string | null;
  runtime_id: string | null;
  kind: string;
  status: string;
  task_spec_json: string | Record<string, unknown>;
  checkpoint_json: string | Record<string, unknown> | null;
  progress_seq: number;
  result_artifact_key: string | null;
  error_json: string | Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}): ResearchTaskRecord {
  return {
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id ?? null,
    runtimeId: row.runtime_id ?? null,
    kind: row.kind as ResearchTaskRecord["kind"],
    status: row.status as ResearchTaskRecord["status"],
    taskSpecJson: parseJsonObject(row.task_spec_json),
    checkpointJson: row.checkpoint_json ? parseJsonObject(row.checkpoint_json) : null,
    progressSeq: Number(row.progress_seq ?? 0),
    resultArtifactKey: row.result_artifact_key ?? null,
    errorJson: row.error_json ? parseJsonObject(row.error_json) : null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
}

export class SqlAppStore implements AppStore {
  private readonly blobStore: BlobStore;
  private readonly adapterId: string | null;
  private readonly feedLabels: { summary: string; taxonomy: string; fallback: string };
  private corpusStorePromise: Promise<InMemoryAppStore> | null = null;
  private readonly workChunksKeyById = new Map<string, string>();
  private readonly workReferenceById = new Map<string, { adapterId: string; externalId: string; title: string; authors: string[] }>();
  private readonly workIdByExternalRef = new Map<string, string>();
  private readonly chunkManifestCache = new Map<string, ChunkManifestEntry[]>();
  private runLifecycleColumnsReady: Promise<void> | null = null;
  private backgroundJobsTableReady: Promise<void> | null = null;
  private researchTasksTableReady: Promise<void> | null = null;
  private runEventSequencesTableReady: Promise<void> | null = null;

  constructor(
    private readonly db: DbClient,
    options: {
      adapterId?: string | null;
      blobStore?: BlobStore;
      feedLabels?: { summary: string; taxonomy: string; fallback: string };
    } = {},
  ) {
    this.adapterId = options.adapterId ?? null;
    this.blobStore = options.blobStore ?? new MemoryBlobStore();
    this.feedLabels = options.feedLabels ?? {
      summary: "Worth opening",
      taxonomy: "Browse by shelf",
      fallback: "From the stack",
    };
  }

  private async corpusStore() {
    if (!this.corpusStorePromise) {
      this.corpusStorePromise = this.loadCorpusStore();
    }
    return this.corpusStorePromise;
  }

  private async ensureWorkReferenceById(workId: string) {
    if (this.workReferenceById.has(workId) && this.workChunksKeyById.has(workId)) {
      return this.workReferenceById.get(workId) ?? null;
    }
    const workResult = await this.db.query<{
      id: string;
      gutenberg_id: number | string | null;
      title: string;
      metadata_json: string | Record<string, unknown> | null;
    }>(
      "SELECT id, gutenberg_id, title, metadata_json FROM works WHERE id = ? LIMIT 1",
      [workId],
    );
    const row = workResult.rows[0];
    if (!row) {
      return null;
    }
    const metadata = parseJsonObject(row.metadata_json);
    const adapterId = typeof metadata.corpusAdapterId === "string" ? metadata.corpusAdapterId : "gutenberg";
    const externalId = typeof metadata.externalId === "string"
      ? metadata.externalId
      : row.gutenberg_id == null
        ? row.id
        : String(row.gutenberg_id);
    const authorsResult = await this.db.query<{ name: string }>(
      "SELECT a.name FROM work_authors wa JOIN authors a ON a.id = wa.author_id WHERE wa.work_id = ? ORDER BY a.name ASC",
      [workId],
    );
    const fileRows = await this.db.query<{ kind: WorkFileKind; r2_key: string }>(
      "SELECT kind, r2_key FROM work_files WHERE work_id = ? AND kind IN ('clean', 'chunks', 'raw')",
      [workId],
    );
    for (const fileRow of fileRows.rows) {
      if (fileRow.kind === "chunks") {
        this.workChunksKeyById.set(workId, fileRow.r2_key);
      }
    }
    const reference = {
      adapterId,
      externalId,
      title: row.title,
      authors: authorsResult.rows
        .map((author) => author.name)
        .filter((name): name is string => typeof name === "string" && name.trim().length > 0),
    };
    this.workReferenceById.set(workId, reference);
    this.workIdByExternalRef.set(`${adapterId}:${externalId}`, workId);
    return reference;
  }

  private async resolveWorkIdByExternalRef(adapterId: string, externalId: string) {
    const cacheKey = `${adapterId}:${externalId}`;
    const cached = this.workIdByExternalRef.get(cacheKey);
    if (cached) {
      return cached;
    }
    const rows = adapterId === "gutenberg"
      ? await this.db.query<{ id: string }>(
        "SELECT id FROM works WHERE gutenberg_id = ? LIMIT 1",
        [Number.parseInt(externalId, 10)],
      )
      : await this.db.query<{ id: string }>(
        "SELECT id FROM works WHERE json_extract(metadata_json, '$.corpusAdapterId') = ? AND json_extract(metadata_json, '$.externalId') = ? LIMIT 1",
        [adapterId, externalId],
      );
    const workId = rows.rows[0]?.id ?? null;
    if (!workId) {
      return null;
    }
    await this.ensureWorkReferenceById(workId);
    return workId;
  }

  private hasScopedCorpus() {
    return Boolean(this.adapterId && this.adapterId !== "gutenberg");
  }

  private adapterWorkClause(alias = "w") {
    if (!this.hasScopedCorpus()) {
      return "";
    }
    return ` AND COALESCE(json_extract(${alias}.metadata_json, '$.corpusAdapterId'), '') = '${this.adapterId}'`;
  }

  private buildExploreFilterClause(filters: ExploreWorksFilters = {}, alias = "w") {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (typeof filters.language === "string" && filters.language.trim().length > 0) {
      clauses.push(`AND ${alias}.language = ?`);
      params.push(filters.language.trim());
    }
    if (typeof filters.subject === "string" && filters.subject.trim().length > 0) {
      clauses.push(`AND EXISTS (
        SELECT 1
        FROM work_subjects ws_filter
        JOIN subjects s_filter ON s_filter.id = ws_filter.subject_id
        WHERE ws_filter.work_id = ${alias}.id AND s_filter.label = ?
      )`);
      params.push(filters.subject.trim());
    }
    if (typeof filters.bookshelf === "string" && filters.bookshelf.trim().length > 0) {
      clauses.push(`AND EXISTS (
        SELECT 1
        FROM json_each(COALESCE(json_extract(${alias}.metadata_json, '$.bookshelves'), '[]')) shelf_filter
        WHERE shelf_filter.value = ?
      )`);
      params.push(filters.bookshelf.trim());
    }
    return {
      clause: clauses.join("\n"),
      params,
    };
  }

  private hasDatasetExploreFilters(filters: ExploreWorksFilters = {}) {
    return Boolean(filters.language || filters.subject || filters.bookshelf);
  }

  private async getSiteStat<T>(key: string): Promise<T | null> {
    const result = await this.db.query<{ value_json: string | null }>(
      "SELECT value_json FROM site_stats WHERE key = ? LIMIT 1",
      [key],
    );
    return parseSiteStatJson<T>(result.rows[0]?.value_json ?? null);
  }

  private async setSiteStat(key: string, value: unknown) {
    await this.db.query(
      `
        INSERT INTO site_stats (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `,
      [key, JSON.stringify(value), nowIso()],
    );
  }

  private async queryLiveWorkCount(filters: ExploreWorksFilters = {}) {
    const filterClause = this.buildExploreFilterClause(filters, "w");
    const result = await this.db.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM works w WHERE 1 = 1 ${this.adapterWorkClause("w")} ${filterClause.clause}`,
      filterClause.params,
    );
    return Number.parseInt(String(result.rows[0]?.count ?? "0"), 10) || 0;
  }

  private async queryLiveWorkFacets(filters: ExploreWorksFilters = {}): Promise<ExploreWorkFacets> {
    const filterClause = this.buildExploreFilterClause(filters, "w");
    const [languages, subjects, bookshelves] = await Promise.all([
      this.db.query<{ label: string | null; count: string | number }>(
        `
          SELECT w.language AS label, COUNT(*) AS count
          FROM works w
          WHERE w.language IS NOT NULL AND TRIM(w.language) <> '' ${this.adapterWorkClause("w")} ${filterClause.clause}
          GROUP BY w.language
          ORDER BY COUNT(*) DESC, w.language ASC
          LIMIT 256
        `,
        filterClause.params,
      ),
      this.db.query<{ label: string | null; count: string | number }>(
        `
          SELECT s.label AS label, COUNT(DISTINCT w.id) AS count
          FROM works w
          JOIN work_subjects ws ON ws.work_id = w.id
          JOIN subjects s ON s.id = ws.subject_id
          WHERE 1 = 1 ${this.adapterWorkClause("w")} ${filterClause.clause}
          GROUP BY s.label
          ORDER BY COUNT(DISTINCT w.id) DESC, s.label ASC
          LIMIT 40
        `,
        filterClause.params,
      ),
      this.db.query<{ label: string | null; count: string | number }>(
        `
          SELECT shelf.value AS label, COUNT(DISTINCT w.id) AS count
          FROM works w
          JOIN json_each(COALESCE(json_extract(w.metadata_json, '$.bookshelves'), '[]')) shelf
          WHERE 1 = 1 ${this.adapterWorkClause("w")} ${filterClause.clause}
          GROUP BY shelf.value
          ORDER BY COUNT(DISTINCT w.id) DESC, shelf.value ASC
          LIMIT 40
        `,
        filterClause.params,
      ),
    ]);
    return {
      languages: languages.rows
        .filter((row): row is { label: string; count: string | number } => typeof row.label === "string" && row.label.trim().length > 0)
        .filter((row) => isPlausibleExploreLanguageLabel(row.label))
        .slice(0, 12)
        .map((row) => ({ label: row.label, count: Number(row.count) || 0 })),
      subjects: subjects.rows
        .filter((row): row is { label: string; count: string | number } => typeof row.label === "string" && row.label.trim().length > 0)
        .filter((row) => !isClassificationLikeSubject(row.label))
        .map((row) => ({ label: row.label, count: Number(row.count) || 0 })),
      bookshelves: bookshelves.rows
        .filter((row): row is { label: string; count: string | number } => typeof row.label === "string" && row.label.trim().length > 0)
        .map((row) => ({ label: row.label, count: Number(row.count) || 0 })),
    };
  }

  private async queryRankedWorkRows(offset = 0, limit = 12, filters: ExploreWorksFilters = {}) {
    const filterClause = this.buildExploreFilterClause(filters, "w");
    const randomSeed = normalizeSqlExploreSeed(filters.randomSeed);
    const orderBy = buildSqlExploreOrderBy(
      "COALESCE(w.gutenberg_id, length(w.id) * 7919)",
      randomSeed,
      "ORDER BY score DESC, CASE WHEN w.release_date IS NULL THEN 1 ELSE 0 END, w.release_date DESC, w.title ASC",
    );
    return this.db.query<{
      id: string;
      gutenberg_id: number | string | null;
      title: string;
      language: string | null;
      release_date: string | null;
      rights_status: string | null;
      summary: string | null;
      metadata_json: string | Record<string, unknown> | null;
      authors_json: string | null;
      subjects_json: string | null;
      score: number;
      feed_label: string | null;
    }>(
      `
        SELECT
          w.id,
          w.gutenberg_id,
          w.title,
          w.language,
          w.release_date,
          w.rights_status,
          w.summary,
          w.metadata_json,
          json_group_array(DISTINCT a.name) AS authors_json,
          json_group_array(DISTINCT s.label) AS subjects_json,
          (
            CASE WHEN COALESCE(
              json_extract(w.metadata_json, '$.coverImageKey'),
              json_extract(w.metadata_json, '$.coverImageUrl'),
              json_extract(w.metadata_json, '$.coverUrl'),
              json_extract(w.metadata_json, '$.imageUrl'),
              json_extract(w.metadata_json, '$.thumbnailUrl')
            ) IS NOT NULL THEN 0.9 ELSE 0 END
            + CASE WHEN w.summary IS NOT NULL AND TRIM(w.summary) <> '' THEN 0.8 ELSE 0 END
            + CASE WHEN EXISTS(SELECT 1 FROM work_authors wa2 WHERE wa2.work_id = w.id) THEN 0.35 ELSE 0 END
            + MIN(3, COALESCE(json_array_length(json_extract(w.metadata_json, '$.bookshelves')), 0)) * 0.18
          ) AS score,
          CASE
            WHEN COALESCE(
              json_extract(w.metadata_json, '$.coverImageKey'),
              json_extract(w.metadata_json, '$.coverImageUrl'),
              json_extract(w.metadata_json, '$.coverUrl'),
              json_extract(w.metadata_json, '$.imageUrl'),
              json_extract(w.metadata_json, '$.thumbnailUrl')
            ) IS NOT NULL AND w.summary IS NOT NULL AND TRIM(w.summary) <> '' THEN ?
            WHEN COALESCE(json_array_length(json_extract(w.metadata_json, '$.bookshelves')), 0) > 0 THEN ?
            ELSE ?
          END AS feed_label
        FROM works w
        LEFT JOIN work_authors wa ON wa.work_id = w.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = w.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        WHERE 1 = 1 ${this.adapterWorkClause("w")}
        ${filterClause.clause}
        GROUP BY w.id, w.gutenberg_id, w.title, w.language, w.release_date, w.rights_status, w.summary, w.metadata_json
        ${orderBy.clause}
        LIMIT ? OFFSET ?
      `,
      [
        this.feedLabels.summary,
        this.feedLabels.taxonomy,
        this.feedLabels.fallback,
        ...filterClause.params,
        ...orderBy.params,
        limit,
        offset,
      ],
    );
  }

  private async queryRankedWorks(offset = 0, limit = 12, filters: ExploreWorksFilters = {}): Promise<WorkSummary[]> {
    const result = await this.queryRankedWorkRows(offset, limit, filters);
    return result.rows.map(mapFeedWorkRowToSummary);
  }

  private async queryWorkDetailRow(workId: string) {
    const result = await this.db.query<{
      id: string;
      gutenberg_id: number | string | null;
      title: string;
      language: string | null;
      release_date: string | null;
      rights_status: string | null;
      summary: string | null;
      metadata_json: string | Record<string, unknown> | null;
      authors_json: string | null;
      subjects_json: string | null;
    }>(
      `
        SELECT
          w.id,
          w.gutenberg_id,
          w.title,
          w.language,
          w.release_date,
          w.rights_status,
          w.summary,
          w.metadata_json,
          json_group_array(DISTINCT a.name) AS authors_json,
          json_group_array(DISTINCT s.label) AS subjects_json
        FROM works w
        LEFT JOIN work_authors wa ON wa.work_id = w.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = w.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        WHERE w.id = ? ${this.adapterWorkClause("w")}
        GROUP BY w.id, w.gutenberg_id, w.title, w.language, w.release_date, w.rights_status, w.summary, w.metadata_json
        LIMIT 1
      `,
      [workId],
    );
    return result.rows[0] ?? null;
  }

  private async queryWorkFilesRows(workIds: string[], kinds?: WorkFileKind[]) {
    const normalizedWorkIds = [...new Set(workIds.map((workId) => workId.trim()).filter(Boolean))];
    if (normalizedWorkIds.length === 0) {
      return [];
    }
    const workPlaceholders = normalizedWorkIds.map(() => "?").join(", ");
    const normalizedKinds = kinds?.length ? [...new Set(kinds)] : null;
    const kindClause = normalizedKinds?.length ? ` AND wf.kind IN (${normalizedKinds.map(() => "?").join(", ")})` : "";
    const result = await this.db.query<{
      id: string;
      work_id: string;
      kind: WorkFileKind;
      r2_key: string;
      byte_size: number | null;
      metadata_json: string | Record<string, unknown> | null;
      created_at?: string | null;
    }>(
      `
        SELECT wf.id, wf.work_id, wf.kind, wf.r2_key, wf.byte_size, wf.metadata_json, wf.created_at
        FROM work_files wf
        JOIN works w ON w.id = wf.work_id
        WHERE wf.work_id IN (${workPlaceholders}) ${kindClause} ${this.adapterWorkClause("w")}
        ORDER BY wf.work_id ASC, wf.kind ASC
      `,
      normalizedKinds?.length ? [...normalizedWorkIds, ...normalizedKinds] : normalizedWorkIds,
    );
    return result.rows;
  }

  private async ensureRunLifecycleColumns() {
    if (!this.runLifecycleColumnsReady) {
      this.runLifecycleColumnsReady = (async () => {
        const statements = [
          "ALTER TABLE runs ADD COLUMN owner_instance_id TEXT",
          "ALTER TABLE runs ADD COLUMN heartbeat_at TEXT",
          "ALTER TABLE runs ADD COLUMN lease_expires_at TEXT",
          "ALTER TABLE runs ADD COLUMN active_tool_call_id TEXT",
        ];
        for (const statement of statements) {
          try {
            await this.db.query(statement);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/duplicate column name|already exists/i.test(message)) {
              throw error;
            }
          }
        }
      })();
    }
    await this.runLifecycleColumnsReady;
  }

  private async ensureResearchTasksTable() {
    if (!this.researchTasksTableReady) {
      this.researchTasksTableReady = this.db.query(`
        CREATE TABLE IF NOT EXISTS research_tasks (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          tool_call_id TEXT,
          runtime_id TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          task_spec_json TEXT NOT NULL,
          checkpoint_json TEXT,
          progress_seq INTEGER NOT NULL DEFAULT 0,
          last_heartbeat_at TEXT,
          lease_owner TEXT,
          lease_expires_at TEXT,
          result_artifact_key TEXT,
          error_json TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        )
      `).then(() => undefined);
    }
    await this.researchTasksTableReady;
  }

  private async ensureBackgroundJobsTable() {
    if (!this.backgroundJobsTableReady) {
      this.backgroundJobsTableReady = this.db.query(`
        CREATE TABLE IF NOT EXISTS background_jobs (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          external_job_id TEXT NOT NULL,
          status TEXT NOT NULL,
          phase TEXT,
          detail TEXT,
          progress_pct REAL,
          log_cursor TEXT,
          last_heartbeat_at TEXT,
          error_text TEXT,
          metadata_json TEXT,
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `).then(() => undefined);
    }
    await this.backgroundJobsTableReady;
  }

  private async ensureRunEventSequencesTable() {
    if (!this.runEventSequencesTableReady) {
      this.runEventSequencesTableReady = this.db.query(`
        CREATE TABLE IF NOT EXISTS run_event_sequences (
          run_id TEXT PRIMARY KEY,
          next_sequence INTEGER NOT NULL
        )
      `).then(() => undefined);
    }
    await this.runEventSequencesTableReady;
  }

  private async allocateRunEventSequence(runId: string) {
    await this.ensureRunEventSequencesTable();
    const result = await this.db.query<{ next_sequence: number | string }>(
      `
        INSERT INTO run_event_sequences (run_id, next_sequence)
        VALUES (?, 1)
        ON CONFLICT(run_id) DO UPDATE
        SET next_sequence = run_event_sequences.next_sequence + 1
        RETURNING next_sequence
      `,
      [runId],
    );
    return Number(result.rows[0]?.next_sequence ?? 1);
  }

  private async loadCorpusStore() {
    const worksResult = await this.db.query<{
      id: string;
      gutenberg_id: number | string | null;
      title: string;
      language: string | null;
      release_date: string | null;
      rights_status: string | null;
      summary: string | null;
      metadata_json: string | Record<string, unknown> | null;
    }>(
      "SELECT id, gutenberg_id, title, language, release_date, rights_status, summary, metadata_json FROM works ORDER BY title ASC",
    );
    const authorsResult = await this.db.query<{ work_id: string; name: string }>(
      "SELECT wa.work_id, a.name FROM work_authors wa JOIN authors a ON a.id = wa.author_id ORDER BY wa.work_id ASC, a.name ASC",
    );
    const subjectsResult = await this.db.query<{ work_id: string; label: string }>(
      "SELECT ws.work_id, s.label FROM work_subjects ws JOIN subjects s ON s.id = ws.subject_id ORDER BY ws.work_id ASC, s.label ASC",
    );
    const filesResult = await this.db.query<{ work_id: string; kind: WorkFileKind; r2_key: string }>(
      "SELECT work_id, kind, r2_key FROM work_files ORDER BY work_id ASC",
    );
    const authorsByWork = new Map<string, string[]>();
    for (const row of authorsResult.rows) {
      const list = authorsByWork.get(row.work_id) ?? [];
      list.push(row.name);
      authorsByWork.set(row.work_id, list);
    }
    const subjectsByWork = new Map<string, string[]>();
    for (const row of subjectsResult.rows) {
      const list = subjectsByWork.get(row.work_id) ?? [];
      list.push(row.label);
      subjectsByWork.set(row.work_id, list);
    }
    const fileKeysByWork = new Map<string, { cleanTextKey?: string; chunksKey?: string; rawKey?: string }>();
    for (const row of filesResult.rows) {
      const entry = fileKeysByWork.get(row.work_id) ?? {};
      if (row.kind === "clean") {
        entry.cleanTextKey = row.r2_key;
      } else if (row.kind === "chunks") {
        entry.chunksKey = row.r2_key;
      } else if (row.kind === "raw") {
        entry.rawKey = row.r2_key;
      }
      fileKeysByWork.set(row.work_id, entry);
    }

    const works: SeedWork[] = worksResult.rows
      .filter((row) => !this.adapterId || this.adapterId === "gutenberg" || parseJsonObject(row.metadata_json).corpusAdapterId === this.adapterId)
      .map((row) => {
        const keys = fileKeysByWork.get(row.id) ?? {};
        const metadata = parseJsonObject(row.metadata_json);
        const adapterId = typeof metadata.corpusAdapterId === "string" ? metadata.corpusAdapterId : "gutenberg";
        const externalId = typeof metadata.externalId === "string"
          ? metadata.externalId
          : row.gutenberg_id == null
            ? row.id
            : String(row.gutenberg_id);
        if (keys.rawKey) {
          metadata.rawKey = keys.rawKey;
        }
        if (keys.chunksKey) {
          this.workChunksKeyById.set(row.id, keys.chunksKey);
        }
        this.workReferenceById.set(row.id, {
          adapterId,
          externalId,
          title: row.title,
          authors: authorsByWork.get(row.id) ?? [],
        });
        this.workIdByExternalRef.set(`${adapterId}:${externalId}`, row.id);
        return {
          id: row.id,
          gutenbergId: row.gutenberg_id == null ? null : Number(row.gutenberg_id),
          title: row.title,
          language: row.language,
          releaseDate: row.release_date,
          rightsStatus: row.rights_status,
          summary: row.summary,
          authors: authorsByWork.get(row.id) ?? [],
          subjects: subjectsByWork.get(row.id) ?? [],
          metadata,
          cleanTextKey: keys.cleanTextKey,
          chunksKey: keys.chunksKey,
        };
      });
    return new InMemoryAppStore(works, [], this.blobStore);
  }

  private async loadWorkChunkManifest(workId: string) {
    const cached = this.chunkManifestCache.get(workId);
    if (cached) {
      return cached;
    }
    await this.ensureWorkReferenceById(workId);
    const chunksKey = this.workChunksKeyById.get(workId);
    if (!chunksKey) {
      this.chunkManifestCache.set(workId, []);
      return [];
    }
    const manifestText = await this.blobStore.getText(chunksKey);
    const manifest = manifestText ? parseChunkManifest(manifestText) : [];
    this.chunkManifestCache.set(workId, manifest);
    return manifest;
  }

  private makeChunkResult(workId: string, entry: ChunkManifestEntry, fallbackIndex: number): ChunkSearchResult | null {
    const workRef = this.workReferenceById.get(workId);
    if (!workRef) {
      return null;
    }
    const chunkIndex = typeof entry.chunk_index === "number" ? entry.chunk_index : fallbackIndex;
    const text = typeof entry.text === "string" ? entry.text : "";
    const excerpt = typeof entry.excerpt === "string" ? entry.excerpt : text.slice(0, 240);
    const r2Key = typeof entry.r2_key === "string" && entry.r2_key.length > 0
      ? entry.r2_key
      : this.workChunksKeyById.get(workId) ?? null;
    return {
      id: typeof entry.id === "string" && entry.id.length > 0
        ? entry.id
        : buildCorpusChunkId(workRef.adapterId, workRef.externalId, chunkIndex),
      workId,
      workTitle:
        typeof entry.work_title === "string" && entry.work_title.trim().length > 0
          ? entry.work_title
          : workRef.title,
      authors: Array.isArray(entry.authors)
        ? entry.authors.filter((author): author is string => typeof author === "string" && author.trim().length > 0)
        : workRef.authors,
      chunkIndex,
      text,
      excerpt,
      r2Key,
      readerPath: typeof entry.reader_path === "string" && entry.reader_path.length > 0 ? entry.reader_path : null,
      score: 0,
    };
  }

  private lexicalChunkScore(query: string, text: string) {
    const haystack = text.toLowerCase();
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 3);
    return tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
  }

  private async queryUsers() {
    const users = await this.db.query<{ id: string; email: string | null; name: string | null; avatar_url: string | null; created_at: string }>(
      "SELECT id, email, name, avatar_url, created_at FROM users ORDER BY created_at DESC",
    );
    const follows = await this.db.query<{ follower_id: string; followed_id: string }>(
      "SELECT follower_id, followed_id FROM user_follows",
    );
    const followerCounts = new Map<string, number>();
    const followingCounts = new Map<string, number>();
    for (const row of follows.rows) {
      followerCounts.set(row.followed_id, (followerCounts.get(row.followed_id) ?? 0) + 1);
      followingCounts.set(row.follower_id, (followingCounts.get(row.follower_id) ?? 0) + 1);
    }
    return users.rows.map((row) => ({
      id: row.id,
      email: row.email,
      handle: deriveHandle(row.email, row.name, row.id),
      name: row.name,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at,
      followersCount: followerCounts.get(row.id) ?? 0,
      followingCount: followingCounts.get(row.id) ?? 0,
    }));
  }

  async ensureUser(userId: string): Promise<void> {
    await this.db.query(
      "INSERT OR IGNORE INTO users (id, email, name, avatar_url, created_at) VALUES (?, NULL, ?, NULL, ?)",
      [userId, "AlphaBook User", nowIso()],
    );
  }

  async upsertUserProfile(input: { id: string; email?: string | null; name?: string | null; avatarUrl?: string | null }): Promise<UserRecord> {
    const canonicalResult = input.email
      ? await this.db.query<{ id: string }>("SELECT id FROM users WHERE email = ? LIMIT 1", [input.email])
      : { rows: [] };
    const id = canonicalResult.rows[0]?.id ?? input.id;
    const existing = await this.db.query<{ created_at: string }>("SELECT created_at FROM users WHERE id = ? LIMIT 1", [id]);
    await this.db.query(
      `
        INSERT INTO users (id, email, name, avatar_url, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = COALESCE(excluded.email, users.email),
          name = COALESCE(excluded.name, users.name),
          avatar_url = COALESCE(excluded.avatar_url, users.avatar_url)
      `,
      [id, input.email ?? null, input.name ?? null, input.avatarUrl ?? null, existing.rows[0]?.created_at ?? nowIso()],
    );
    return (await this.getUserProfile(id))!;
  }

  async getUserProfile(userId: string): Promise<UserRecord | null> {
    const users = await this.queryUsers();
    return users.find((user) => user.id === userId) ?? null;
  }

  async claimGuestUserData(guestUserId: string, userId: string): Promise<void> {
    if (!guestUserId || !userId || guestUserId === userId) {
      return;
    }
    await this.ensureUser(userId);
    await this.db.query("UPDATE chat_sessions SET user_id = ? WHERE user_id = ?", [userId, guestUserId]);
    await this.db.query("UPDATE billing_events SET user_id = ? WHERE user_id = ?", [userId, guestUserId]);
    await this.db.query("UPDATE analytics_events SET user_id = ? WHERE user_id = ?", [userId, guestUserId]);
    await this.db.query("DELETE FROM users WHERE id = ? AND id <> ?", [guestUserId, userId]);
  }

  async createAgentIdentity(input: {
    name: string;
    description?: string | null;
    ownerUserId?: string | null;
    apiKeyPrefix: string;
    apiKeyHash: string;
    verificationCode: string;
    claimToken: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentIdentityRecord> {
    const userId = `agent_${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    await this.ensureUser(userId);
    if (input.ownerUserId) {
      await this.ensureUser(input.ownerUserId);
    }
    await this.db.query(
      `
        INSERT INTO agent_identities (
          id, user_id, owner_user_id, name, description, api_key_prefix, api_key_hash, status,
          verification_code, claim_token, metadata_json, last_used_at, claimed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `,
      [
        id,
        userId,
        input.ownerUserId ?? null,
        input.name,
        input.description ?? null,
        input.apiKeyPrefix,
        input.apiKeyHash,
        input.ownerUserId ? "active" : "pending_claim",
        input.verificationCode,
        input.claimToken,
        JSON.stringify(input.metadata ?? {}),
        input.ownerUserId ? createdAt : null,
        createdAt,
      ],
    );
    return (await this.getAgentIdentityByUserId(userId))!;
  }

  async authenticateAgentApiKey(apiKeyHash: string): Promise<AgentIdentityRecord | null> {
    await this.db.query("UPDATE agent_identities SET last_used_at = ? WHERE api_key_hash = ? AND status <> 'revoked'", [nowIso(), apiKeyHash]);
    const result = await this.db.query<any>(
      "SELECT id, user_id, owner_user_id, name, description, api_key_prefix, status, verification_code, claim_token, last_used_at, created_at, claimed_at, metadata_json FROM agent_identities WHERE api_key_hash = ? AND status <> 'revoked' LIMIT 1",
      [apiKeyHash],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      userId: row.user_id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      description: row.description,
      apiKeyPrefix: row.api_key_prefix,
      status: row.status,
      verificationCode: row.verification_code,
      claimToken: row.claim_token,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      claimedAt: row.claimed_at,
      metadata: parseJsonObject(row.metadata_json),
    } : null;
  }

  async getAgentIdentityByUserId(userId: string): Promise<AgentIdentityRecord | null> {
    const rows = await this.db.query<any>(
      "SELECT id, user_id, owner_user_id, name, description, api_key_prefix, status, verification_code, claim_token, last_used_at, created_at, claimed_at, metadata_json FROM agent_identities WHERE user_id = ? LIMIT 1",
      [userId],
    );
    const row = rows.rows[0];
    return row ? {
      id: row.id,
      userId: row.user_id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      description: row.description,
      apiKeyPrefix: row.api_key_prefix,
      status: row.status,
      verificationCode: row.verification_code,
      claimToken: row.claim_token,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      claimedAt: row.claimed_at,
      metadata: parseJsonObject(row.metadata_json),
    } : null;
  }

  async getAgentIdentityByClaimToken(claimToken: string): Promise<AgentIdentityRecord | null> {
    const rows = await this.db.query<any>(
      "SELECT id, user_id, owner_user_id, name, description, api_key_prefix, status, verification_code, claim_token, last_used_at, created_at, claimed_at, metadata_json FROM agent_identities WHERE claim_token = ? LIMIT 1",
      [claimToken],
    );
    const row = rows.rows[0];
    return row ? {
      id: row.id,
      userId: row.user_id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      description: row.description,
      apiKeyPrefix: row.api_key_prefix,
      status: row.status,
      verificationCode: row.verification_code,
      claimToken: row.claim_token,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      claimedAt: row.claimed_at,
      metadata: parseJsonObject(row.metadata_json),
    } : null;
  }

  async claimAgentIdentity(claimToken: string, ownerUserId: string): Promise<AgentIdentityRecord | null> {
    await this.ensureUser(ownerUserId);
    await this.db.query(
      "UPDATE agent_identities SET owner_user_id = ?, status = 'active', claimed_at = COALESCE(claimed_at, ?) WHERE claim_token = ? AND status <> 'revoked'",
      [ownerUserId, nowIso(), claimToken],
    );
    return this.getAgentIdentityByClaimToken(claimToken);
  }

  async listAgentIdentitiesByOwner(ownerUserId: string): Promise<AgentIdentityRecord[]> {
    const rows = await this.db.query<any>(
      "SELECT id, user_id, owner_user_id, name, description, api_key_prefix, status, verification_code, claim_token, last_used_at, created_at, claimed_at, metadata_json FROM agent_identities WHERE owner_user_id = ? ORDER BY created_at DESC",
      [ownerUserId],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      description: row.description,
      apiKeyPrefix: row.api_key_prefix,
      status: row.status,
      verificationCode: row.verification_code,
      claimToken: row.claim_token,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      claimedAt: row.claimed_at,
      metadata: parseJsonObject(row.metadata_json),
    }));
  }

  async listUsers(): Promise<AdminUserRecord[]> {
    const users = await this.queryUsers();
    const sessions = await this.db.query<{ user_id: string }>("SELECT user_id FROM chat_sessions");
    const runs = await this.db.query<{ session_id: string }>("SELECT session_id FROM runs");
    const billing = await this.db.query<{ user_id: string; cost_usd: number | string; created_at: string }>("SELECT user_id, cost_usd, created_at FROM billing_events");
    const sessionsByUser = new Map<string, number>();
    for (const row of sessions.rows) {
      sessionsByUser.set(row.user_id, (sessionsByUser.get(row.user_id) ?? 0) + 1);
    }
    const sessionOwners = await this.db.query<{ id: string; user_id: string }>("SELECT id, user_id FROM chat_sessions");
    const ownerBySession = new Map(sessionOwners.rows.map((row) => [row.id, row.user_id]));
    const runsByUser = new Map<string, number>();
    for (const row of runs.rows) {
      const owner = ownerBySession.get(row.session_id);
      if (owner) {
        runsByUser.set(owner, (runsByUser.get(owner) ?? 0) + 1);
      }
    }
    return users.map((user) => {
      const userBilling = billing.rows.filter((row) => row.user_id === user.id);
      return {
        ...user,
        sessionCount: sessionsByUser.get(user.id) ?? 0,
        runCount: runsByUser.get(user.id) ?? 0,
        lastSeenAt: null,
        monthlySpendUsd: userBilling.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0),
        totalSpendUsd: userBilling.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0),
        billingEventCount: userBilling.length,
      };
    });
  }

  async followUser(followerId: string, followedId: string): Promise<void> {
    if (followerId === followedId) {
      return;
    }
    await this.ensureUser(followerId);
    await this.ensureUser(followedId);
    await this.db.query("INSERT OR IGNORE INTO user_follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)", [followerId, followedId, nowIso()]);
  }

  async unfollowUser(followerId: string, followedId: string): Promise<void> {
    await this.db.query("DELETE FROM user_follows WHERE follower_id = ? AND followed_id = ?", [followerId, followedId]);
  }

  async isFollowing(followerId: string, followedId: string): Promise<boolean> {
    const rows = await this.db.query<{ c: number }>("SELECT 1 as c FROM user_follows WHERE follower_id = ? AND followed_id = ? LIMIT 1", [followerId, followedId]);
    return Boolean(rows.rows[0]);
  }

  async createSession(userId: string, title?: string): Promise<SessionRecord> {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    await this.db.query("INSERT INTO chat_sessions (id, user_id, title, created_at) VALUES (?, ?, ?, ?)", [id, userId, title ?? null, createdAt]);
    return { id, userId, title: title ?? null, createdAt };
  }

  async updateSessionTitle(sessionId: string, title: string | null): Promise<void> {
    await this.db.query("UPDATE chat_sessions SET title = ? WHERE id = ?", [title, sessionId]);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const rows = await this.db.query<{ id: string; user_id: string; title: string | null; created_at: string }>("SELECT id, user_id, title, created_at FROM chat_sessions WHERE id = ? LIMIT 1", [sessionId]);
    const row = rows.rows[0];
    return row ? { id: row.id, userId: row.user_id, title: row.title, createdAt: row.created_at } : null;
  }

  async listSessions(userId: string): Promise<SessionSummaryRecord[]> {
    const sessions = await this.db.query<{ id: string; user_id: string; title: string | null; created_at: string }>("SELECT id, user_id, title, created_at FROM chat_sessions WHERE user_id = ? ORDER BY created_at DESC", [userId]);
    const messages = await this.db.query<{ session_id: string; content: string; created_at: string }>("SELECT session_id, content, created_at FROM messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id = ?)", [userId]);
    const runs = await this.db.query<{ session_id: string; status: RunRecord["status"]; started_at: string }>("SELECT session_id, status, started_at FROM runs WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id = ?)", [userId]);
    return sessions.rows.map((session) => {
      const sessionMessages = messages.rows.filter((row) => row.session_id === session.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
      const lastMessage = sessionMessages[sessionMessages.length - 1];
      const activeRun = runs.rows
        .filter((row) => row.session_id === session.id && (row.status === "queued" || row.status === "running"))
        .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
      return {
        id: session.id,
        userId: session.user_id,
        title: session.title,
        createdAt: session.created_at,
        lastMessageAt: lastMessage?.created_at ?? null,
        lastMessagePreview: lastMessage?.content?.slice(0, 120) ?? null,
        activeRunStatus: activeRun?.status === "queued" || activeRun?.status === "running" ? activeRun.status : null,
      };
    }).sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
  }

  async getUserProfileStats(userId: string): Promise<UserProfileStatsRecord> {
    const sessions = await this.listSessions(userId);
    return {
      userId,
      generatedAt: nowIso(),
      counts: {
        sessionCount: sessions.length,
        queryCount: 0,
        runCount: 0,
        activeDayCount: 0,
        booksOpenedCount: 0,
        uniqueBooksOpenedCount: 0,
        uniqueBooksCitedCount: 0,
        booksTouchedCount: 0,
        citationCount: 0,
      },
      averages: {
        queriesPerSession: 0,
        citationsPerQuery: 0,
        booksOpenedPerSession: 0,
        booksTouchedPerQuery: 0,
      },
      books: { recent: [], topOpened: [], topCited: [] },
      fingerprint: { authors: [], subjects: [], languages: [] },
      recentQueries: [],
    };
  }

  async listAdminSessions(): Promise<AdminSessionRecord[]> {
    const sessions = await this.db.query<{ id: string; user_id: string; title: string | null; created_at: string }>("SELECT id, user_id, title, created_at FROM chat_sessions ORDER BY created_at DESC");
    const users = await this.queryUsers();
    const userById = new Map(users.map((user) => [user.id, user]));
    return sessions.rows.map((session) => ({
      id: session.id,
      userId: session.user_id,
      title: session.title,
      createdAt: session.created_at,
      userEmail: userById.get(session.user_id)?.email ?? null,
      userName: userById.get(session.user_id)?.name ?? null,
      runCount: 0,
      messageCount: 0,
      lastMessageAt: null,
      lastMessagePreview: null,
      spendUsd: 0,
    }));
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const rows = await this.db.query<{ id: string; session_id: string; role: MessageRecord["role"]; content: string; metadata_json: string | Record<string, unknown> | null; created_at: string }>(
      "SELECT id, session_id, role, content, metadata_json, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC",
      [sessionId],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at,
    }));
  }

  async getLatestPlanMessageForRun(sessionId: string, runId: string): Promise<MessageRecord | null> {
    const messages = await this.listMessages(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "assistant" && message.metadata.phase === "plan" && message.metadata.runId === runId) {
        return message;
      }
    }
    return null;
  }

  async appendMessage(sessionId: string, role: MessageRecord["role"], content: string, metadata: Record<string, unknown> = {}): Promise<MessageRecord> {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    await this.db.query("INSERT INTO messages (id, session_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, sessionId, role, content, JSON.stringify(metadata), createdAt]);
    return { id, sessionId, role, content, metadata, createdAt };
  }

  async updateMessageMetadata(messageId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.db.query("UPDATE messages SET metadata_json = ? WHERE id = ?", [JSON.stringify(metadata), messageId]);
  }

  async createRun(sessionId: string, options: {
    ownerInstanceId?: string | null;
    heartbeatAt?: string | null;
    leaseExpiresAt?: string | null;
  } = {}): Promise<RunRecord> {
    await this.ensureRunLifecycleColumns();
    const id = crypto.randomUUID();
    const startedAt = nowIso();
    await this.db.query(
      "INSERT INTO runs (id, session_id, status, started_at, completed_at, planner_turns, owner_instance_id, heartbeat_at, lease_expires_at, active_tool_call_id) VALUES (?, ?, 'running', ?, NULL, 0, ?, ?, ?, NULL)",
      [id, sessionId, startedAt, options.ownerInstanceId ?? null, options.heartbeatAt ?? null, options.leaseExpiresAt ?? null],
    );
    return {
      id,
      sessionId,
      status: "running",
      plannerTurns: 0,
      startedAt,
      completedAt: null,
      ownerInstanceId: options.ownerInstanceId ?? null,
      heartbeatAt: options.heartbeatAt ?? null,
      leaseExpiresAt: options.leaseExpiresAt ?? null,
      activeToolCallId: null,
    };
  }

  async createBackgroundJob(input: {
    runId: string;
    sessionId: string;
    provider: BackgroundJobRecord["provider"];
    externalJobId: string;
    status: BackgroundJobRecord["status"];
    phase?: string | null;
    detail?: string | null;
    progressPct?: number | null;
    logCursor?: string | null;
    lastHeartbeatAt?: string | null;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<BackgroundJobRecord> {
    await this.ensureBackgroundJobsTable();
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const updatedAt = createdAt;
    await this.db.query(
      `INSERT INTO background_jobs (
        id, run_id, session_id, provider, external_job_id, status, phase, detail, progress_pct, log_cursor,
        last_heartbeat_at, error_text, metadata_json, started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.runId,
        input.sessionId,
        input.provider,
        input.externalJobId,
        input.status,
        input.phase ?? null,
        input.detail ?? null,
        input.progressPct ?? null,
        input.logCursor ?? null,
        input.lastHeartbeatAt ?? null,
        input.error ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.startedAt ?? null,
        input.completedAt ?? null,
        createdAt,
        updatedAt,
      ],
    );
    return {
      id,
      runId: input.runId,
      sessionId: input.sessionId,
      provider: input.provider,
      externalJobId: input.externalJobId,
      status: input.status,
      phase: input.phase ?? null,
      detail: input.detail ?? null,
      progressPct: input.progressPct ?? null,
      logCursor: input.logCursor ?? null,
      lastHeartbeatAt: input.lastHeartbeatAt ?? null,
      error: input.error ?? null,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      metadata: input.metadata ?? {},
      createdAt,
      updatedAt,
    };
  }

  async getBackgroundJob(jobId: string): Promise<BackgroundJobRecord | null> {
    await this.ensureBackgroundJobsTable();
    const rows = await this.db.query<{
      id: string;
      run_id: string;
      session_id: string;
      provider: BackgroundJobRecord["provider"];
      external_job_id: string;
      status: BackgroundJobRecord["status"];
      phase: string | null;
      detail: string | null;
      progress_pct: number | null;
      log_cursor: string | null;
      last_heartbeat_at: string | null;
      error_text: string | null;
      metadata_json: string | Record<string, unknown> | null;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
      updated_at: string;
    }>("SELECT * FROM background_jobs WHERE id = ? LIMIT 1", [jobId]);
    const row = rows.rows[0];
    return row ? {
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      provider: row.provider,
      externalJobId: row.external_job_id,
      status: row.status,
      phase: row.phase ?? null,
      detail: row.detail ?? null,
      progressPct: row.progress_pct ?? null,
      logCursor: row.log_cursor ?? null,
      lastHeartbeatAt: row.last_heartbeat_at ?? null,
      error: row.error_text ?? null,
      metadata: parseJsonObject(row.metadata_json),
      startedAt: row.started_at ?? null,
      completedAt: row.completed_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  async getLatestBackgroundJobForRun(runId: string): Promise<BackgroundJobRecord | null> {
    await this.ensureBackgroundJobsTable();
    const rows = await this.db.query<{
      id: string;
      run_id: string;
      session_id: string;
      provider: BackgroundJobRecord["provider"];
      external_job_id: string;
      status: BackgroundJobRecord["status"];
      phase: string | null;
      detail: string | null;
      progress_pct: number | null;
      log_cursor: string | null;
      last_heartbeat_at: string | null;
      error_text: string | null;
      metadata_json: string | Record<string, unknown> | null;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
      updated_at: string;
    }>("SELECT * FROM background_jobs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", [runId]);
    const row = rows.rows[0];
    return row ? {
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      provider: row.provider,
      externalJobId: row.external_job_id,
      status: row.status,
      phase: row.phase ?? null,
      detail: row.detail ?? null,
      progressPct: row.progress_pct ?? null,
      logCursor: row.log_cursor ?? null,
      lastHeartbeatAt: row.last_heartbeat_at ?? null,
      error: row.error_text ?? null,
      metadata: parseJsonObject(row.metadata_json),
      startedAt: row.started_at ?? null,
      completedAt: row.completed_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    await this.ensureRunLifecycleColumns();
    const rows = await this.db.query<{ id: string; session_id: string; status: RunRecord["status"]; started_at: string; completed_at: string | null; planner_turns: number; owner_instance_id: string | null; heartbeat_at: string | null; lease_expires_at: string | null; active_tool_call_id: string | null }>(
      "SELECT id, session_id, status, started_at, completed_at, planner_turns, owner_instance_id, heartbeat_at, lease_expires_at, active_tool_call_id FROM runs WHERE id = ? LIMIT 1",
      [runId],
    );
    const row = rows.rows[0];
    return row ? {
      id: row.id,
      sessionId: row.session_id,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      plannerTurns: Number(row.planner_turns ?? 0),
      ownerInstanceId: row.owner_instance_id ?? null,
      heartbeatAt: row.heartbeat_at ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
      activeToolCallId: row.active_tool_call_id ?? null,
    } : null;
  }

  async listRuns(sessionId: string): Promise<RunRecord[]> {
    await this.ensureRunLifecycleColumns();
    const rows = await this.db.query<{ id: string; session_id: string; status: RunRecord["status"]; started_at: string; completed_at: string | null; planner_turns: number; owner_instance_id: string | null; heartbeat_at: string | null; lease_expires_at: string | null; active_tool_call_id: string | null }>(
      "SELECT id, session_id, status, started_at, completed_at, planner_turns, owner_instance_id, heartbeat_at, lease_expires_at, active_tool_call_id FROM runs WHERE session_id = ? ORDER BY started_at DESC",
      [sessionId],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      plannerTurns: Number(row.planner_turns ?? 0),
      ownerInstanceId: row.owner_instance_id ?? null,
      heartbeatAt: row.heartbeat_at ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
      activeToolCallId: row.active_tool_call_id ?? null,
    }));
  }

  async listAllRuns(): Promise<AdminRunRecord[]> {
    await this.ensureRunLifecycleColumns();
    const runs = await this.db.query<{ id: string; session_id: string; status: RunRecord["status"]; started_at: string; completed_at: string | null; planner_turns: number; owner_instance_id: string | null; heartbeat_at: string | null; lease_expires_at: string | null; active_tool_call_id: string | null }>(
      "SELECT id, session_id, status, started_at, completed_at, planner_turns, owner_instance_id, heartbeat_at, lease_expires_at, active_tool_call_id FROM runs ORDER BY started_at DESC",
    );
    const sessions = await this.db.query<{ id: string; user_id: string; title: string | null }>("SELECT id, user_id, title FROM chat_sessions");
    const users = await this.queryUsers();
    const sessionById = new Map(sessions.rows.map((row) => [row.id, row]));
    const userById = new Map(users.map((row) => [row.id, row]));
    return runs.rows.map((row) => {
      const session = sessionById.get(row.session_id);
      const user = session ? userById.get(session.user_id) : null;
      return {
        id: row.id,
        sessionId: row.session_id,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        plannerTurns: Number(row.planner_turns ?? 0),
        ownerInstanceId: row.owner_instance_id ?? null,
        heartbeatAt: row.heartbeat_at ?? null,
        leaseExpiresAt: row.lease_expires_at ?? null,
        activeToolCallId: row.active_tool_call_id ?? null,
        userId: session?.user_id ?? "unknown",
        userEmail: user?.email ?? null,
        userName: user?.name ?? null,
        sessionTitle: session?.title ?? null,
        toolCallCount: 0,
        messageCount: 0,
        lastMessagePreview: null,
        spendUsd: 0,
      };
    });
  }

  async saveAnalyticsEvent(input: { event: string; userId?: string | null; sessionId?: string | null; properties?: Record<string, unknown>; createdAt?: string }): Promise<AnalyticsEventRecord> {
    const id = crypto.randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    await this.db.query("INSERT INTO analytics_events (id, event, user_id, session_id, properties_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, input.event, input.userId ?? null, input.sessionId ?? null, JSON.stringify(input.properties ?? {}), createdAt]);
    return { id, event: input.event, userId: input.userId ?? null, sessionId: input.sessionId ?? null, properties: input.properties ?? {}, createdAt };
  }

  async listAnalyticsEvents(options: { since?: string; limit?: number } = {}): Promise<AnalyticsEventRecord[]> {
    const rows = await this.db.query<{ id: string; event: string; user_id: string | null; session_id: string | null; properties_json: string | Record<string, unknown> | null; created_at: string }>(
      "SELECT id, event, user_id, session_id, properties_json, created_at FROM analytics_events ORDER BY created_at DESC LIMIT ?",
      [options.limit ?? 500],
    );
    return rows.rows
      .filter((row) => !options.since || row.created_at >= options.since)
      .map((row) => ({ id: row.id, event: row.event, userId: row.user_id, sessionId: row.session_id, properties: parseJsonObject(row.properties_json), createdAt: row.created_at }));
  }

  async listUserMessages(options: { since?: string; limit?: number } = {}) {
    const rows = await this.db.query<{ id: string; session_id: string; content: string; created_at: string }>(
      "SELECT id, session_id, content, created_at FROM messages WHERE role = 'user' ORDER BY created_at DESC LIMIT ?",
      [options.limit ?? 500],
    );
    const sessions = await this.db.query<{ id: string; user_id: string }>("SELECT id, user_id FROM chat_sessions");
    const ownerBySession = new Map(sessions.rows.map((row) => [row.id, row.user_id]));
    return rows.rows
      .filter((row) => !options.since || row.created_at >= options.since)
      .map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        userId: ownerBySession.get(row.session_id) ?? "unknown",
        content: row.content,
        createdAt: row.created_at,
      }));
  }

  async updateRun(runId: string, updates: Partial<Pick<RunRecord, "status" | "plannerTurns" | "completedAt" | "ownerInstanceId" | "heartbeatAt" | "leaseExpiresAt" | "activeToolCallId">>): Promise<void> {
    await this.ensureRunLifecycleColumns();
    await this.db.query(
      `
        UPDATE runs
        SET
          status = CASE WHEN ? THEN ? ELSE status END,
          planner_turns = CASE WHEN ? THEN ? ELSE planner_turns END,
          completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
          owner_instance_id = CASE WHEN ? THEN ? ELSE owner_instance_id END,
          heartbeat_at = CASE WHEN ? THEN ? ELSE heartbeat_at END,
          lease_expires_at = CASE WHEN ? THEN ? ELSE lease_expires_at END,
          active_tool_call_id = CASE WHEN ? THEN ? ELSE active_tool_call_id END
        WHERE id = ?
      `,
      [
        updates.status !== undefined ? 1 : 0,
        updates.status ?? null,
        updates.plannerTurns !== undefined ? 1 : 0,
        updates.plannerTurns ?? null,
        updates.completedAt !== undefined ? 1 : 0,
        updates.completedAt ?? null,
        updates.ownerInstanceId !== undefined ? 1 : 0,
        updates.ownerInstanceId ?? null,
        updates.heartbeatAt !== undefined ? 1 : 0,
        updates.heartbeatAt ?? null,
        updates.leaseExpiresAt !== undefined ? 1 : 0,
        updates.leaseExpiresAt ?? null,
        updates.activeToolCallId !== undefined ? 1 : 0,
        updates.activeToolCallId ?? null,
        runId,
      ],
    );
  }

  async updateBackgroundJob(
    jobId: string,
    updates: Partial<
      Pick<
        BackgroundJobRecord,
        "status" | "phase" | "detail" | "progressPct" | "logCursor" | "lastHeartbeatAt" | "error" | "startedAt" | "completedAt" | "metadata" | "updatedAt"
      >
    >,
  ): Promise<void> {
    await this.ensureBackgroundJobsTable();
    await this.db.query(
      `
        UPDATE background_jobs
        SET
          status = CASE WHEN ? THEN ? ELSE status END,
          phase = CASE WHEN ? THEN ? ELSE phase END,
          detail = CASE WHEN ? THEN ? ELSE detail END,
          progress_pct = CASE WHEN ? THEN ? ELSE progress_pct END,
          log_cursor = CASE WHEN ? THEN ? ELSE log_cursor END,
          last_heartbeat_at = CASE WHEN ? THEN ? ELSE last_heartbeat_at END,
          error_text = CASE WHEN ? THEN ? ELSE error_text END,
          started_at = CASE WHEN ? THEN ? ELSE started_at END,
          completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
          metadata_json = CASE WHEN ? THEN ? ELSE metadata_json END,
          updated_at = ?
        WHERE id = ?
      `,
      [
        updates.status !== undefined ? 1 : 0,
        updates.status ?? null,
        updates.phase !== undefined ? 1 : 0,
        updates.phase ?? null,
        updates.detail !== undefined ? 1 : 0,
        updates.detail ?? null,
        updates.progressPct !== undefined ? 1 : 0,
        updates.progressPct ?? null,
        updates.logCursor !== undefined ? 1 : 0,
        updates.logCursor ?? null,
        updates.lastHeartbeatAt !== undefined ? 1 : 0,
        updates.lastHeartbeatAt ?? null,
        updates.error !== undefined ? 1 : 0,
        updates.error ?? null,
        updates.startedAt !== undefined ? 1 : 0,
        updates.startedAt ?? null,
        updates.completedAt !== undefined ? 1 : 0,
        updates.completedAt ?? null,
        updates.metadata !== undefined ? 1 : 0,
        JSON.stringify(updates.metadata ?? {}),
        updates.updatedAt ?? nowIso(),
        jobId,
      ],
    );
  }

  async startToolCall(runId: string, toolName: ToolName, argsJson: Record<string, unknown>): Promise<ToolCallRecord> {
    const id = crypto.randomUUID();
    const startedAt = nowIso();
    const argsRef = shouldSpillPayload(argsJson) ? `runs/${runId}/tools/${id}/args.json` : null;
    if (argsRef) {
      await this.blobStore.putJson(argsRef, argsJson);
    }
    await this.db.query(
      "INSERT INTO tool_calls (id, run_id, tool_name, args_json, result_json, args_ref, result_ref, args_summary, result_summary, started_at, completed_at, status) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, NULL, 'running')",
      [id, runId, toolName, JSON.stringify(argsRef ? buildInlinePayload(argsJson) : argsJson), argsRef, summarizePayload(argsJson, `${toolName} arguments`), startedAt],
    );
    return {
      id,
      runId,
      toolName,
      argsJson: argsRef ? buildInlinePayload(argsJson) : argsJson,
      resultJson: null,
      argsRef,
      resultRef: null,
      argsSummary: summarizePayload(argsJson, `${toolName} arguments`),
      resultSummary: null,
      status: "running",
      startedAt,
      completedAt: null,
    };
  }

  async listToolCalls(runId: string): Promise<ToolCallRecord[]> {
    const rows = await this.db.query<any>("SELECT id, run_id, tool_name, args_json, result_json, args_ref, result_ref, args_summary, result_summary, started_at, completed_at, status FROM tool_calls WHERE run_id = ? ORDER BY started_at ASC", [runId]);
    return Promise.all(rows.rows.map(async (row) => ({
      id: row.id,
      runId: row.run_id,
      toolName: row.tool_name,
      argsJson: row.args_ref ? (await loadJsonBlob(this.blobStore, row.args_ref) ?? parseJsonObject(row.args_json)) : parseJsonObject(row.args_json),
      resultJson: row.result_ref ? (await loadJsonBlob(this.blobStore, row.result_ref) ?? (row.result_json ? parseJsonObject(row.result_json) : null)) : (row.result_json ? parseJsonObject(row.result_json) : null),
      argsRef: row.args_ref,
      resultRef: row.result_ref,
      argsSummary: row.args_summary,
      resultSummary: row.result_summary,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    })));
  }

  async finishToolCall(toolCallId: string, status: ToolCallRecord["status"], resultJson: Record<string, unknown>): Promise<void> {
    const existing = await this.db.query<{ run_id: string; tool_name: string }>("SELECT run_id, tool_name FROM tool_calls WHERE id = ? LIMIT 1", [toolCallId]);
    const row = existing.rows[0];
    const resultRef = shouldSpillPayload(resultJson) ? `runs/${row?.run_id ?? "run"}/tools/${toolCallId}/result.json` : null;
    if (resultRef) {
      await this.blobStore.putJson(resultRef, resultJson);
    }
    await this.db.query("UPDATE tool_calls SET status = ?, result_json = ?, result_ref = ?, result_summary = ?, completed_at = ? WHERE id = ?", [
      status,
      JSON.stringify(resultRef ? buildInlinePayload(resultJson) : resultJson),
      resultRef,
      summarizePayload(resultJson, `${row?.tool_name ?? "tool"} ${status}`),
      nowIso(),
      toolCallId,
    ]);
  }

  async appendRunEvent(runId: string, sessionId: string, event: string, dataJson: Record<string, unknown>): Promise<RunEventRecord> {
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const sequence = await this.allocateRunEventSequence(runId);
    const payloadRef = shouldSpillPayload(dataJson) ? `runs/${runId}/events/${id}.json` : null;
    const summaryText = summarizePayload(dataJson, event);
    const phase = typeof dataJson.phase === "string" ? dataJson.phase : null;
    const status = typeof dataJson.status === "string" ? dataJson.status : null;
    const toolCallId = typeof dataJson.toolCallId === "string" ? dataJson.toolCallId : null;
    const runtimeId = typeof dataJson.runtimeId === "string" ? dataJson.runtimeId : null;
    const retentionClass = (payloadRef ? "debug-blob" : "debug-index") as RetentionClass;
    if (payloadRef) {
      await this.blobStore.putJson(payloadRef, dataJson);
    }
    await this.db.query(
      `
        INSERT INTO run_events (id, run_id, session_id, sequence, event, data_json, payload_ref, summary_text, phase, status, tool_call_id, runtime_id, retention_class, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        runId,
        sessionId,
        sequence,
        event,
        JSON.stringify(payloadRef ? buildInlinePayload(dataJson) : dataJson),
        payloadRef,
        summaryText,
        phase,
        status,
        toolCallId,
        runtimeId,
        retentionClass,
        createdAt,
      ],
    );
    return {
      id,
      runId,
      sessionId,
      sequence,
      event,
      dataJson,
      payloadRef,
      summaryText,
      phase,
      status,
      toolCallId,
      runtimeId,
      retentionClass,
      createdAt,
    };
  }

  async listRunEvents(runId: string): Promise<RunEventRecord[]> {
    const rows = await this.db.query<any>("SELECT id, run_id, session_id, sequence, event, data_json, payload_ref, summary_text, phase, status, tool_call_id, runtime_id, retention_class, created_at FROM run_events WHERE run_id = ? ORDER BY sequence ASC", [runId]);
    return Promise.all(rows.rows.map(async (row) => ({
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      sequence: Number(row.sequence),
      event: row.event,
      dataJson: row.payload_ref ? (await loadJsonBlob(this.blobStore, row.payload_ref) ?? parseJsonObject(row.data_json)) : parseJsonObject(row.data_json),
      payloadRef: row.payload_ref,
      summaryText: row.summary_text,
      phase: row.phase,
      status: row.status,
      toolCallId: row.tool_call_id,
      runtimeId: row.runtime_id,
      retentionClass: row.retention_class,
      createdAt: row.created_at,
    })));
  }

  async listRecentRunEvents(runId: string, limit: number): Promise<RunEventRecord[]> {
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const rows = await this.db.query<any>(
      `SELECT id, run_id, session_id, sequence, event, data_json, payload_ref, summary_text, phase, status, tool_call_id, runtime_id, retention_class, created_at
       FROM (
         SELECT id, run_id, session_id, sequence, event, data_json, payload_ref, summary_text, phase, status, tool_call_id, runtime_id, retention_class, created_at
         FROM run_events
         WHERE run_id = ?
         ORDER BY sequence DESC
         LIMIT ?
       ) recent
       ORDER BY sequence ASC`,
      [runId, normalizedLimit],
    );
    return Promise.all(rows.rows.map(async (row) => ({
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      sequence: Number(row.sequence),
      event: row.event,
      dataJson: row.payload_ref ? (await loadJsonBlob(this.blobStore, row.payload_ref) ?? parseJsonObject(row.data_json)) : parseJsonObject(row.data_json),
      payloadRef: row.payload_ref,
      summaryText: row.summary_text,
      phase: row.phase,
      status: row.status,
      toolCallId: row.tool_call_id,
      runtimeId: row.runtime_id,
      retentionClass: row.retention_class,
      createdAt: row.created_at,
    })));
  }

  async listWorks(
    optionsOrOffset: { offset?: number; limit?: number; filters?: ExploreWorksFilters } | number = {},
    limitArg?: number,
  ) {
    const options = typeof optionsOrOffset === "number"
      ? { offset: optionsOrOffset, limit: limitArg }
      : optionsOrOffset;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 12;
    const filters = options.filters ?? {};
    const hasDatasetFilters = this.hasDatasetExploreFilters(filters) || Boolean(filters.randomSeed);
    if (hasDatasetFilters) {
      return this.queryRankedWorks(offset, limit, filters);
    }
    const orderBy = buildSqlExploreOrderBy(
      "COALESCE(gutenberg_id, length(work_id) * 7919)",
      normalizeSqlExploreSeed(filters.randomSeed),
      "ORDER BY rank ASC",
    );
    const snapshot = await this.db.query<{
      work_id: string;
      gutenberg_id: number | string | null;
      title: string;
      language: string | null;
      release_date: string | null;
      rights_status: string | null;
      summary: string | null;
      metadata_json: string | Record<string, unknown> | null;
      authors_json: string | null;
      subjects_json: string | null;
      score: number;
      feed_label: string | null;
    }>(
      `
        SELECT
          work_id,
          gutenberg_id,
          title,
          language,
          release_date,
          rights_status,
          summary,
          metadata_json,
          authors_json,
          subjects_json,
          score,
          feed_label
        FROM feed_works
        WHERE 1 = 1
          ${typeof filters.language === "string" && filters.language.trim().length > 0 ? "AND language = ?" : ""}
          ${typeof filters.subject === "string" && filters.subject.trim().length > 0 ? "AND EXISTS (SELECT 1 FROM json_each(COALESCE(subjects_json, '[]')) subject_filter WHERE subject_filter.value = ?)" : ""}
          ${typeof filters.bookshelf === "string" && filters.bookshelf.trim().length > 0 ? "AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(metadata_json, '$.bookshelves'), '[]')) shelf_filter WHERE shelf_filter.value = ?)" : ""}
        ${orderBy.clause}
        LIMIT ? OFFSET ?
      `,
      [
        ...(typeof filters.language === "string" && filters.language.trim().length > 0 ? [filters.language.trim()] : []),
        ...(typeof filters.subject === "string" && filters.subject.trim().length > 0 ? [filters.subject.trim()] : []),
        ...(typeof filters.bookshelf === "string" && filters.bookshelf.trim().length > 0 ? [filters.bookshelf.trim()] : []),
        ...orderBy.params,
        limit,
        offset,
      ],
    );
    if (snapshot.rows.length > 0) {
      return snapshot.rows.map((row) => mapFeedWorkRowToSummary({
        id: row.work_id,
        gutenberg_id: row.gutenberg_id,
        title: row.title,
        language: row.language,
        release_date: row.release_date,
        rights_status: row.rights_status,
        summary: row.summary,
        metadata_json: row.metadata_json,
        authors_json: row.authors_json,
        subjects_json: row.subjects_json,
        score: row.score,
        feed_label: row.feed_label,
      }));
    }
    return this.queryRankedWorks(offset, limit, filters);
  }

  async countWorks(filters: ExploreWorksFilters = {}) {
    if (!this.hasDatasetExploreFilters(filters)) {
      const cached = await this.getSiteStat<{ count?: number }>("corpus_work_count");
      if (typeof cached?.count === "number" && Number.isFinite(cached.count)) {
        return cached.count;
      }
    }
    return this.queryLiveWorkCount(filters);
  }

  async listExploreWorkIds(filters: ExploreWorksFilters = {}) {
    const filterClause = this.buildExploreFilterClause(filters, "w");
    const result = await this.db.query<{ id: string }>(
      `SELECT w.id FROM works w WHERE 1 = 1 ${this.adapterWorkClause("w")} ${filterClause.clause} ORDER BY w.id ASC`,
      filterClause.params,
    );
    return result.rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  async listWorkFacets(filters: ExploreWorksFilters = {}): Promise<ExploreWorkFacets> {
    if (!this.hasDatasetExploreFilters(filters)) {
      const cached = await this.getSiteStat<ExploreWorkFacets>("explore_work_facets");
      if (cached && Array.isArray(cached.languages) && Array.isArray(cached.subjects) && Array.isArray(cached.bookshelves)) {
        return cached;
      }
    }
    return this.queryLiveWorkFacets(filters);
  }
  async listDocuments(offset?: number, limit?: number) { return (await this.corpusStore()).listDocuments(offset, limit); }
  async countDocuments() { return (await this.corpusStore()).countDocuments(); }
  async refreshExploreFeedSnapshot(limit = 512) {
    const [rankedRows, totalCount, facets] = await Promise.all([
      this.queryRankedWorkRows(0, limit),
      this.queryLiveWorkCount(),
      this.queryLiveWorkFacets(),
    ]);

    await this.db.query("DELETE FROM feed_works");
    for (const [index, row] of rankedRows.rows.entries()) {
      await this.db.query(
        `
          INSERT INTO feed_works (
            work_id, rank, score, feed_label, title, gutenberg_id, language, release_date,
            rights_status, summary, metadata_json, authors_json, subjects_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          row.id,
          index,
          row.score ?? 0,
          row.feed_label,
          row.title,
          row.gutenberg_id == null ? null : Number(row.gutenberg_id),
          row.language,
          row.release_date,
          row.rights_status,
          row.summary,
          JSON.stringify(parseJsonObject(row.metadata_json)),
          JSON.stringify(parseJsonStringList(row.authors_json)),
          JSON.stringify(parseJsonStringList(row.subjects_json)),
          nowIso(),
        ],
      );
    }
    await this.setSiteStat("corpus_work_count", { count: totalCount });
    await this.setSiteStat("explore_work_facets", facets);
  }
  async getWorkById(workId: string): Promise<WorkDetailRecord | null> {
    const row = await this.queryWorkDetailRow(workId);
    return row ? mapWorkRowToDetail(row) : null;
  }

  async getDocumentById(documentId: string) {
    const work = await this.getWorkById(documentId);
    return work ? workDetailToDocumentDetail(work) : null;
  }
  async getWorksByIdPrefixes(prefixes: string[]) { return (await this.corpusStore()).getWorksByIdPrefixes(prefixes); }
  async estimateWorkSetSize(workIds?: string[], filters?: PassageSearchFilters): Promise<WorkSetSizeEstimate> { return (await this.corpusStore()).estimateWorkSetSize(workIds, filters); }
  async estimateDocumentSetSize(documentIds?: string[], filters?: PassageSearchFilters): Promise<WorkSetSizeEstimate> { return (await this.corpusStore()).estimateDocumentSetSize(documentIds, filters); }
  async estimateResearchScope(query: string, filters?: PassageSearchFilters): Promise<ResearchScopeEstimate> { return (await this.corpusStore()).estimateResearchScope(query, filters); }
  async searchWorks(query: string, filters?: Record<string, unknown>) { return (await this.corpusStore()).searchWorks(query, filters); }
  async searchDocuments(query: string, filters?: Record<string, unknown>) { return (await this.corpusStore()).searchDocuments(query, filters); }
  async getWorkMetadata(workIds: string[]) { return (await this.corpusStore()).getWorkMetadata(workIds); }
  async getDocumentMetadata(documentIds: string[]) { return (await this.corpusStore()).getDocumentMetadata(documentIds); }
  async getRelevantChunks(query: string, workIds?: string[], limit = 8, _embedding?: number[], filters?: PassageSearchFilters): Promise<ChunkSearchResult[]> {
    const store = await this.corpusStore();
    const scopedWorks = workIds?.length
      ? await store.getWorkMetadata(workIds)
      : (await store.searchWorks(query, filters as Record<string, unknown> | undefined)).slice(0, 24);
    const filteredWorks = scopedWorks.filter((work) => {
      if (filters?.language && work.language !== filters.language) {
        return false;
      }
      if (filters?.rightsStatus && work.rightsStatus !== filters.rightsStatus) {
        return false;
      }
      return true;
    });
    const chunks = (
      await Promise.all(
        filteredWorks.slice(0, 120).map(async (work) => {
          const manifest = await this.loadWorkChunkManifest(work.id);
          return manifest
            .map((entry, index) => this.makeChunkResult(work.id, entry, index))
            .filter((entry): entry is ChunkSearchResult => Boolean(entry));
        }),
      )
    ).flat();
    return chunks
      .map((chunk) => ({
        ...chunk,
        score: this.lexicalChunkScore(query, chunk.text),
      }))
      .filter((chunk) => chunk.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
  async getRelevantDocumentChunks(query: string, documentIds?: string[], limit?: number, embedding?: number[], filters?: PassageSearchFilters) {
    return (await this.getRelevantChunks(query, documentIds, limit, embedding, filters)).map((chunk) => ({
      id: chunk.id,
      documentId: chunk.workId,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      excerpt: chunk.excerpt,
      r2Key: chunk.r2Key ?? null,
      score: chunk.score,
    }));
  }
  async getWorkTextFile(workId: string) { return (await this.corpusStore()).getWorkTextFile(workId); }
  async getDocumentTextFile(documentId: string): Promise<DocumentTextRecord | null> { return (await this.corpusStore()).getDocumentTextFile(documentId); }
  async getWorkFiles(workIds: string[], kinds?: WorkFileKind[]): Promise<WorkFileRecord[]> {
    const rows = await this.queryWorkFilesRows(workIds, kinds);
    return rows.map((row) => ({
      id: row.id,
      workId: row.work_id,
      kind: row.kind,
      r2Key: row.r2_key,
      byteSize: row.byte_size ?? null,
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at ?? undefined,
    }));
  }
  async getDocumentFiles(documentIds: string[], kinds?: WorkFileKind[]) { return (await this.corpusStore()).getDocumentFiles(documentIds, kinds); }
  async getChunksByIds(chunkIds: string[]) {
    const chunks = await Promise.all(chunkIds.map(async (chunkId) => {
      const parsed = parseCorpusChunkId(chunkId);
      if (!parsed) {
        return null;
      }
      const workId = await this.resolveWorkIdByExternalRef(parsed.adapterId, parsed.externalId);
      if (!workId) {
        return null;
      }
      const manifest = await this.loadWorkChunkManifest(workId);
      const entry = manifest.find((candidate, index) =>
        (typeof candidate.id === "string" && candidate.id === chunkId)
        || (typeof candidate.chunk_index === "number" ? candidate.chunk_index : index) === parsed.chunkIndex,
      );
      return entry ? this.makeChunkResult(workId, entry, parsed.chunkIndex) : null;
    }));
    return chunks.filter((chunk): chunk is ChunkSearchResult => Boolean(chunk));
  }
  async getChunkByWorkAndIndex(workId: string, chunkIndex: number) {
    const manifest = await this.loadWorkChunkManifest(workId);
    const entry = manifest.find((candidate, index) => (typeof candidate.chunk_index === "number" ? candidate.chunk_index : index) === chunkIndex);
    return entry ? this.makeChunkResult(workId, entry, chunkIndex) : null;
  }
  async findChunkByWorkAndExcerpt(workId: string, excerpt: string) {
    const normalizedExcerpt = excerpt.trim().toLowerCase();
    if (!normalizedExcerpt) {
      return null;
    }
    const manifest = await this.loadWorkChunkManifest(workId);
    for (const [index, entry] of manifest.entries()) {
      const chunk = this.makeChunkResult(workId, entry, index);
      if (chunk && chunk.text.toLowerCase().includes(normalizedExcerpt)) {
        return chunk;
      }
    }
    return null;
  }

  async createResearchTask(input: {
    runId: string;
    sessionId: string;
    toolCallId?: string | null;
    runtimeId?: string | null;
    kind: ResearchTaskRecord["kind"];
    taskSpecJson: Record<string, unknown>;
    checkpointJson?: Record<string, unknown> | null;
  }): Promise<ResearchTaskRecord> {
    await this.ensureResearchTasksTable();
    const record: ResearchTaskRecord = {
      id: crypto.randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId ?? null,
      runtimeId: input.runtimeId ?? null,
      kind: input.kind,
      status: "queued",
      taskSpecJson: input.taskSpecJson,
      checkpointJson: input.checkpointJson ?? null,
      progressSeq: 0,
      resultArtifactKey: null,
      errorJson: null,
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
    };
    await this.db.query(
      `INSERT INTO research_tasks (
        id, run_id, session_id, tool_call_id, runtime_id, kind, status, task_spec_json, checkpoint_json,
        progress_seq, last_heartbeat_at, lease_owner, lease_expires_at, result_artifact_key, error_json, created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.runId,
        record.sessionId,
        record.toolCallId,
        record.runtimeId,
        record.kind,
        record.status,
        JSON.stringify(record.taskSpecJson),
        record.checkpointJson ? JSON.stringify(record.checkpointJson) : null,
        record.progressSeq,
        null,
        null,
        null,
        record.resultArtifactKey,
        record.errorJson ? JSON.stringify(record.errorJson) : null,
        record.createdAt,
        record.startedAt,
        record.completedAt,
      ],
    );
    return record;
  }

  async getResearchTask(taskId: string): Promise<ResearchTaskRecord | null> {
    await this.ensureResearchTasksTable();
    const rows = await this.db.query<any>("SELECT * FROM research_tasks WHERE id = ? LIMIT 1", [taskId]);
    return rows.rows[0] ? mapResearchTaskRow(rows.rows[0]) : null;
  }

  async getLatestResearchTaskForToolCall(toolCallId: string): Promise<ResearchTaskRecord | null> {
    await this.ensureResearchTasksTable();
    const rows = await this.db.query<any>(
      "SELECT * FROM research_tasks WHERE tool_call_id = ? ORDER BY created_at DESC LIMIT 1",
      [toolCallId],
    );
    return rows.rows[0] ? mapResearchTaskRow(rows.rows[0]) : null;
  }

  async listResearchTasksForRun(runId: string): Promise<ResearchTaskRecord[]> {
    await this.ensureResearchTasksTable();
    const rows = await this.db.query<any>("SELECT * FROM research_tasks WHERE run_id = ? ORDER BY created_at ASC", [runId]);
    return rows.rows.map(mapResearchTaskRow);
  }

  async updateResearchTask(
    taskId: string,
    updates: Partial<Pick<
      ResearchTaskRecord,
      "runtimeId" | "status" | "checkpointJson" | "progressSeq" | "resultArtifactKey" | "errorJson" | "startedAt" | "completedAt"
    >>,
  ): Promise<void> {
    await this.ensureResearchTasksTable();
    await this.db.query(
      `
        UPDATE research_tasks
        SET
          runtime_id = CASE WHEN ? THEN ? ELSE runtime_id END,
          status = CASE WHEN ? THEN ? ELSE status END,
          checkpoint_json = CASE WHEN ? THEN ? ELSE checkpoint_json END,
          progress_seq = CASE WHEN ? THEN ? ELSE progress_seq END,
          result_artifact_key = CASE WHEN ? THEN ? ELSE result_artifact_key END,
          error_json = CASE WHEN ? THEN ? ELSE error_json END,
          started_at = CASE WHEN ? THEN ? ELSE started_at END,
          completed_at = CASE WHEN ? THEN ? ELSE completed_at END
        WHERE id = ?
      `,
      [
        updates.runtimeId !== undefined ? 1 : 0,
        updates.runtimeId ?? null,
        updates.status !== undefined ? 1 : 0,
        updates.status ?? null,
        updates.checkpointJson !== undefined ? 1 : 0,
        updates.checkpointJson ? JSON.stringify(updates.checkpointJson) : null,
        updates.progressSeq !== undefined ? 1 : 0,
        updates.progressSeq ?? null,
        updates.resultArtifactKey !== undefined ? 1 : 0,
        updates.resultArtifactKey ?? null,
        updates.errorJson !== undefined ? 1 : 0,
        updates.errorJson ? JSON.stringify(updates.errorJson) : null,
        updates.startedAt !== undefined ? 1 : 0,
        updates.startedAt ?? null,
        updates.completedAt !== undefined ? 1 : 0,
        updates.completedAt ?? null,
        taskId,
      ],
    );
  }

  async listRuntimeInstances(sessionId: string): Promise<RuntimeInstanceRecord[]> {
    const rows = await this.db.query<any>("SELECT * FROM runtime_instances WHERE session_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC", [sessionId]);
    return Promise.all(rows.rows.map(async (row) => ({
      id: row.id,
      sessionId: row.session_id,
      runtimeId: row.runtime_id,
      provider: row.provider,
      providerMachineId: row.provider_machine_id,
      status: row.status,
      manifestJson: row.manifest_ref ? (await loadJsonBlob(this.blobStore, row.manifest_ref) ?? parseJsonObject(row.manifest_json)) : parseJsonObject(row.manifest_json),
      manifestRef: row.manifest_ref,
      taskSpecJson: parseJsonObject(row.task_spec_json),
      selectedWorkIds: parseJsonArray(row.selected_work_ids_json),
      selectedChunkIds: parseJsonArray(row.selected_chunk_ids_json),
      fileCatalogRef: row.file_catalog_ref,
      researchMode: row.research_mode,
      shardId: row.shard_id,
      isAggregator: Boolean(row.aggregator),
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })));
  }

  async listExpiredRuntimeInstances(limit = 50): Promise<RuntimeInstanceRecord[]> {
    const rows = await this.db.query<any>("SELECT * FROM runtime_instances WHERE expires_at IS NOT NULL AND status NOT IN ('destroyed', 'expired') ORDER BY expires_at ASC LIMIT ?", [limit]);
    return (await Promise.all(rows.rows.map(async (row) => ({
      id: row.id,
      sessionId: row.session_id,
      runtimeId: row.runtime_id,
      provider: row.provider,
      providerMachineId: row.provider_machine_id,
      status: row.status,
      manifestJson: row.manifest_ref ? (await loadJsonBlob(this.blobStore, row.manifest_ref) ?? parseJsonObject(row.manifest_json)) : parseJsonObject(row.manifest_json),
      manifestRef: row.manifest_ref,
      taskSpecJson: parseJsonObject(row.task_spec_json),
      selectedWorkIds: parseJsonArray(row.selected_work_ids_json),
      selectedChunkIds: parseJsonArray(row.selected_chunk_ids_json),
      fileCatalogRef: row.file_catalog_ref,
      researchMode: row.research_mode,
      shardId: row.shard_id,
      isAggregator: Boolean(row.aggregator),
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })))).filter((row) => row.expiresAt && Date.parse(row.expiresAt) <= Date.now());
  }

  async getRuntimeInstance(runtimeId: string): Promise<RuntimeInstanceRecord | null> {
    const rows = await this.listRuntimeInstances((await this.db.query<{ session_id: string }>("SELECT session_id FROM runtime_instances WHERE runtime_id = ? LIMIT 1", [runtimeId])).rows[0]?.session_id ?? "");
    return rows.find((row) => row.runtimeId === runtimeId) ?? null;
  }

  async saveRuntimeInstance(input: Omit<RuntimeInstanceRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<RuntimeInstanceRecord> {
    const manifestRef = artifactKeys.runtimeArtifact(input.runtimeId, "manifest.json");
    await this.blobStore.putJson(manifestRef, input.manifestJson);
    const compact = compactManifest(input.manifestJson);
    const fileCatalogRef = compact.fileCatalog.length > 0 ? artifactKeys.runtimeArtifact(input.runtimeId, "workspace/file-catalog.json") : null;
    if (fileCatalogRef) {
      await this.blobStore.putJson(fileCatalogRef, { items: compact.fileCatalog });
    }
    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    await this.db.query(
      `
        INSERT INTO runtime_instances (
          id, session_id, runtime_id, provider, provider_machine_id, status, manifest_json, manifest_ref,
          task_spec_json, selected_work_ids_json, selected_chunk_ids_json, file_catalog_ref, research_mode,
          shard_id, aggregator, last_used_at, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(runtime_id) DO UPDATE SET
          session_id=excluded.session_id,
          provider=excluded.provider,
          provider_machine_id=excluded.provider_machine_id,
          status=excluded.status,
          manifest_json=excluded.manifest_json,
          manifest_ref=excluded.manifest_ref,
          task_spec_json=excluded.task_spec_json,
          selected_work_ids_json=excluded.selected_work_ids_json,
          selected_chunk_ids_json=excluded.selected_chunk_ids_json,
          file_catalog_ref=excluded.file_catalog_ref,
          research_mode=excluded.research_mode,
          shard_id=excluded.shard_id,
          aggregator=excluded.aggregator,
          last_used_at=excluded.last_used_at,
          expires_at=excluded.expires_at
      `,
      [
        id,
        input.sessionId,
        input.runtimeId,
        input.provider,
        input.providerMachineId ?? null,
        input.status,
        JSON.stringify(compact.compactManifest),
        manifestRef,
        JSON.stringify(compact.taskSpecJson),
        JSON.stringify(compact.selectedWorkIds),
        JSON.stringify(compact.selectedChunkIds),
        fileCatalogRef,
        compact.researchMode,
        compact.shardId,
        input.isAggregator ? 1 : 0,
        input.lastUsedAt,
        input.expiresAt,
        createdAt,
      ],
    );
    return (await this.getRuntimeInstance(input.runtimeId))!;
  }

  async updateRuntimeInstance(runtimeId: string, updates: Partial<Pick<RuntimeInstanceRecord, "status" | "manifestJson" | "lastUsedAt" | "expiresAt" | "providerMachineId">>): Promise<void> {
    const nextManifest = updates.manifestJson;
    let manifestJsonValue: string | null = null;
    let manifestRefValue: string | null = null;
    let selectedWorkIdsValue: string | null = null;
    let selectedChunkIdsValue: string | null = null;
    let fileCatalogRefValue: string | null = null;

    if (nextManifest !== undefined) {
      manifestRefValue = artifactKeys.runtimeArtifact(runtimeId, "manifest.json");
      await this.blobStore.putJson(manifestRefValue, nextManifest);
      const compact = compactManifest(nextManifest);
      manifestJsonValue = JSON.stringify(compact.compactManifest);
      selectedWorkIdsValue = JSON.stringify(compact.selectedWorkIds);
      selectedChunkIdsValue = JSON.stringify(compact.selectedChunkIds);
      fileCatalogRefValue = compact.fileCatalog.length > 0
        ? artifactKeys.runtimeArtifact(runtimeId, "workspace/file-catalog.json")
        : null;
      if (fileCatalogRefValue) {
        await this.blobStore.putJson(fileCatalogRefValue, { items: compact.fileCatalog });
      }
    }

    await this.db.query(
      `
        UPDATE runtime_instances
        SET
          status = CASE WHEN ? THEN ? ELSE status END,
          provider_machine_id = CASE WHEN ? THEN ? ELSE provider_machine_id END,
          manifest_json = CASE WHEN ? THEN ? ELSE manifest_json END,
          manifest_ref = CASE WHEN ? THEN ? ELSE manifest_ref END,
          selected_work_ids_json = CASE WHEN ? THEN ? ELSE selected_work_ids_json END,
          selected_chunk_ids_json = CASE WHEN ? THEN ? ELSE selected_chunk_ids_json END,
          file_catalog_ref = CASE WHEN ? THEN ? ELSE file_catalog_ref END,
          last_used_at = CASE WHEN ? THEN ? ELSE last_used_at END,
          expires_at = CASE WHEN ? THEN ? ELSE expires_at END
        WHERE runtime_id = ?
      `,
      [
        updates.status !== undefined ? 1 : 0,
        updates.status ?? null,
        updates.providerMachineId !== undefined ? 1 : 0,
        updates.providerMachineId ?? null,
        nextManifest !== undefined ? 1 : 0,
        manifestJsonValue,
        nextManifest !== undefined ? 1 : 0,
        manifestRefValue,
        nextManifest !== undefined ? 1 : 0,
        selectedWorkIdsValue,
        nextManifest !== undefined ? 1 : 0,
        selectedChunkIdsValue,
        nextManifest !== undefined ? 1 : 0,
        fileCatalogRefValue,
        updates.lastUsedAt !== undefined ? 1 : 0,
        updates.lastUsedAt ?? null,
        updates.expiresAt !== undefined ? 1 : 0,
        updates.expiresAt ?? null,
        runtimeId,
      ],
    );
  }

  async saveArtifact(input: Omit<ArtifactRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<ArtifactRecord> {
    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    const blobRef = input.blobRef ?? input.r2Key;
    await this.db.query(
      `
        INSERT INTO artifacts (id, session_id, runtime_id, r2_key, blob_ref, filename, mime_type, byte_size, summary_text, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(r2_key) DO UPDATE SET
          runtime_id=excluded.runtime_id,
          blob_ref=excluded.blob_ref,
          filename=excluded.filename,
          mime_type=excluded.mime_type,
          byte_size=excluded.byte_size,
          summary_text=excluded.summary_text,
          metadata_json=excluded.metadata_json
      `,
      [id, input.sessionId, input.runtimeId, input.r2Key, blobRef, input.filename, input.mimeType, input.byteSize ?? null, input.summaryText ?? summarizePayload(input.metadata, input.filename), JSON.stringify(input.metadata), createdAt],
    );
    return { id, sessionId: input.sessionId, runtimeId: input.runtimeId, r2Key: input.r2Key, blobRef, filename: input.filename, mimeType: input.mimeType, byteSize: input.byteSize ?? null, summaryText: input.summaryText ?? summarizePayload(input.metadata, input.filename), metadata: input.metadata, createdAt };
  }

  async listArtifacts(sessionId: string, runtimeId?: string | null): Promise<ArtifactRecord[]> {
    const rows = await this.db.query<any>(
      runtimeId === undefined
        ? "SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC"
        : "SELECT * FROM artifacts WHERE session_id = ? AND runtime_id IS ? ORDER BY created_at ASC",
      runtimeId === undefined ? [sessionId] : [sessionId, runtimeId],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      runtimeId: row.runtime_id,
      r2Key: row.r2_key,
      blobRef: row.blob_ref,
      filename: row.filename,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      summaryText: row.summary_text,
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at,
    }));
  }

  async createNotification(input: {
    userId: string;
    sessionId?: string | null;
    runId?: string | null;
    toolCallId?: string | null;
    type: NotificationType;
    title: string;
    body: string;
    dedupeKey: string;
    metadata?: Record<string, unknown>;
    readAt?: string | null;
    emailedAt?: string | null;
    createdAt?: string;
  }): Promise<NotificationRecord> {
    const existing = await this.db.query<any>("SELECT * FROM notifications WHERE dedupe_key = ? LIMIT 1", [input.dedupeKey]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      return {
        id: row.id,
        userId: row.user_id,
        sessionId: row.session_id,
        runId: row.run_id,
        toolCallId: row.tool_call_id,
        type: row.type,
        title: row.title,
        body: row.body,
        dedupeKey: row.dedupe_key,
        metadata: parseJsonObject(row.metadata_json),
        readAt: row.read_at,
        emailedAt: row.emailed_at,
        createdAt: row.created_at,
      };
    }
    const id = crypto.randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    await this.db.query(
      "INSERT INTO notifications (id, user_id, session_id, run_id, tool_call_id, type, title, body, dedupe_key, metadata_json, read_at, emailed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, input.userId, input.sessionId ?? null, input.runId ?? null, input.toolCallId ?? null, input.type, input.title, input.body, input.dedupeKey, JSON.stringify(input.metadata ?? {}), input.readAt ?? null, input.emailedAt ?? null, createdAt],
    );
    return { id, userId: input.userId, sessionId: input.sessionId ?? null, runId: input.runId ?? null, toolCallId: input.toolCallId ?? null, type: input.type, title: input.title, body: input.body, dedupeKey: input.dedupeKey, metadata: input.metadata ?? {}, readAt: input.readAt ?? null, emailedAt: input.emailedAt ?? null, createdAt };
  }

  async listNotifications(userId: string, options: { limit?: number } = {}): Promise<NotificationRecord[]> {
    const rows = await this.db.query<any>("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", [userId, options.limit ?? 100]);
    return rows.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      runId: row.run_id,
      toolCallId: row.tool_call_id,
      type: row.type,
      title: row.title,
      body: row.body,
      dedupeKey: row.dedupe_key,
      metadata: parseJsonObject(row.metadata_json),
      readAt: row.read_at,
      emailedAt: row.emailed_at,
      createdAt: row.created_at,
    }));
  }

  async countUnreadNotifications(userId: string): Promise<number> {
    const rows = await this.db.query<{ c: number }>("SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read_at IS NULL", [userId]);
    return Number(rows.rows[0]?.c ?? 0);
  }

  async markNotificationRead(notificationId: string, userId: string, readAt = nowIso()): Promise<boolean> {
    await this.db.query("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?", [readAt, notificationId, userId]);
    return true;
  }

  async markAllNotificationsRead(userId: string, readAt = nowIso()): Promise<number> {
    const unread = await this.countUnreadNotifications(userId);
    await this.db.query("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", [readAt, userId]);
    return unread;
  }

  async updateNotification(notificationId: string, userId: string, updates: Partial<Pick<NotificationRecord, "metadata" | "emailedAt" | "readAt">>): Promise<void> {
    const existing = (await this.listNotifications(userId, { limit: 1000 })).find((row) => row.id === notificationId);
    if (!existing) {
      return;
    }
    await this.db.query("UPDATE notifications SET metadata_json = ?, emailed_at = ?, read_at = ? WHERE id = ? AND user_id = ?", [
      JSON.stringify(updates.metadata ?? existing.metadata),
      updates.emailedAt ?? existing.emailedAt,
      updates.readAt ?? existing.readAt,
      notificationId,
      userId,
    ]);
  }

  async createBillingEvent(input: Omit<BillingEventRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<BillingEventRecord> {
    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    await this.db.query(
      `
        INSERT INTO billing_events (
          id, user_id, session_id, run_id, source, provider, model, operation, input_tokens, output_tokens,
          total_tokens, cached_input_tokens, cost_usd, request_id, request_json, response_json, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO NOTHING
      `,
      [id, input.userId, input.sessionId, input.runId, input.source, input.provider, input.model, input.operation, input.inputTokens, input.outputTokens, input.totalTokens, input.cachedInputTokens, input.costUsd, input.requestId ?? null, JSON.stringify(input.requestJson ?? null), JSON.stringify(input.responseJson ?? null), JSON.stringify(input.metadata), createdAt],
    );
    return { ...input, id, createdAt };
  }

  async getBillingSpend(userId: string, since: string): Promise<BillingSpendSummary> {
    const rows = await this.db.query<{ cost_usd: number | string; created_at: string }>("SELECT cost_usd, created_at FROM billing_events WHERE user_id = ?", [userId]);
    const relevant = rows.rows.filter((row) => row.created_at >= since);
    return {
      totalCostUsd: relevant.reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0),
      eventCount: relevant.length,
    };
  }

  async healthCheck(): Promise<"ok" | "error"> {
    try {
      await this.db.query("SELECT 1");
      return "ok";
    } catch {
      return "error";
    }
  }
}
