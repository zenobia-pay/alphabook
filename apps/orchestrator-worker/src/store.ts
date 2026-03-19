import type { DbClient } from "@alphabook/db";
import type { ChunkSearchResult, ToolName, WorkDetail, WorkSummary } from "@alphabook/shared";

const PASSAGE_SEARCH_TIMEOUT_MS = 45_000;

export interface PassageSearchFilters {
  language?: string;
  rightsStatus?: string;
  yearRange?: [number, number];
  genre?: string[];
}

export interface ResearchShardDescriptor {
  shardId: string;
  index: number;
  totalShards: number;
  axis: "work_id_hash" | "author_initial" | "publication_year" | "retrieval_strategy";
  label: string;
  targetWorkCount: number;
  estimatedCoveragePercent: number;
  hashBucketStart?: number;
  hashBucketEnd?: number;
  authorInitialStart?: string;
  authorInitialEnd?: string;
  yearStart?: number;
  yearEnd?: number;
  strategy?: string;
}

export interface ResearchScopeEstimate {
  query: string;
  metadataWorkEstimate: number;
  chunkMatchEstimate: number;
  chunkWorkEstimate: number;
  breadthBand: "tiny" | "small" | "medium" | "large" | "huge";
  recommendedIntensity: "normal" | "high" | "maximum";
  recommendedWallClockMinutes: 5 | 15 | 60;
  recommendedParallelism: number;
  recommendedShardAxis: "none" | "work_id_hash" | "author_initial" | "publication_year" | "retrieval_strategy";
  recommendedVmWorkBudget: number;
  recommendedFrontierWorks: number;
  estimatedCoveragePercent: {
    normal: number;
    high: number;
    maximum: number;
  };
  probeWorks: Array<{
    id: string;
    title: string;
    authors: string[];
  }>;
  recommendedShards: ResearchShardDescriptor[];
  rationale: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  title: string | null;
  createdAt: string;
}

export interface UserRecord {
  id: string;
  email: string | null;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  followersCount: number;
  followingCount: number;
}

export interface AdminUserRecord extends UserRecord {
  sessionCount: number;
  runCount: number;
  lastSeenAt: string | null;
  monthlySpendUsd: number;
  totalSpendUsd: number;
  billingEventCount: number;
}

export interface AgentIdentityRecord {
  id: string;
  userId: string;
  ownerUserId: string | null;
  name: string;
  description: string | null;
  apiKeyPrefix: string;
  status: "pending_claim" | "active" | "revoked";
  verificationCode: string;
  claimToken: string;
  lastUsedAt: string | null;
  createdAt: string;
  claimedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface SessionSummaryRecord extends SessionRecord {
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out";
  plannerTurns: number;
  startedAt: string;
  completedAt: string | null;
}

export interface AdminRunRecord extends RunRecord {
  userId: string;
  userEmail: string | null;
  userName: string | null;
  sessionTitle: string | null;
  toolCallCount: number;
  messageCount: number;
  lastMessagePreview: string | null;
  spendUsd: number;
}

export interface AdminSessionRecord extends SessionRecord {
  userEmail: string | null;
  userName: string | null;
  runCount: number;
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  spendUsd: number;
}

export interface AnalyticsEventRecord {
  id: string;
  event: string;
  userId: string | null;
  sessionId: string | null;
  properties: Record<string, unknown>;
  createdAt: string;
}

export interface ToolCallRecord {
  id: string;
  runId: string;
  toolName: ToolName;
  argsJson: Record<string, unknown>;
  resultJson: Record<string, unknown> | null;
  status: "queued" | "running" | "completed" | "failed" | "timed_out";
  startedAt: string;
  completedAt: string | null;
}

export interface WorkTextRecord {
  workId: string;
  r2Key: string | null;
}

export interface WorkDetailRecord extends WorkDetail {}

export type WorkFileKind = "raw" | "metadata" | "clean" | "chunks" | "book_html";

export interface WorkFileRecord {
  id: string;
  workId: string;
  kind: WorkFileKind;
  r2Key: string;
  byteSize: number | null;
  metadata: Record<string, unknown>;
  createdAt?: string;
}

export interface RuntimeInstanceRecord {
  id: string;
  sessionId: string;
  runtimeId: string;
  provider: string;
  providerMachineId: string | null;
  status: "creating" | "ready" | "busy" | "destroyed" | "failed" | "expired";
  manifestJson: Record<string, unknown>;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface BillingEventRecord {
  id: string;
  userId: string;
  sessionId: string | null;
  runId: string | null;
  source: string;
  provider: string;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  requestId: string | null;
  requestJson: Record<string, unknown> | null;
  responseJson: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface BillingSpendSummary {
  totalCostUsd: number;
  eventCount: number;
}

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  runtimeId: string | null;
  r2Key: string;
  filename: string;
  mimeType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AppStore {
  ensureUser(userId: string): Promise<void>;
  upsertUserProfile(input: { id: string; email?: string | null; name?: string | null; avatarUrl?: string | null }): Promise<UserRecord>;
  getUserProfile(userId: string): Promise<UserRecord | null>;
  createAgentIdentity(input: {
    name: string;
    description?: string | null;
    ownerUserId?: string | null;
    apiKeyPrefix: string;
    apiKeyHash: string;
    verificationCode: string;
    claimToken: string;
    metadata?: Record<string, unknown>;
  }): Promise<AgentIdentityRecord>;
  authenticateAgentApiKey(apiKeyHash: string): Promise<AgentIdentityRecord | null>;
  getAgentIdentityByUserId(userId: string): Promise<AgentIdentityRecord | null>;
  getAgentIdentityByClaimToken(claimToken: string): Promise<AgentIdentityRecord | null>;
  claimAgentIdentity(claimToken: string, ownerUserId: string): Promise<AgentIdentityRecord | null>;
  listAgentIdentitiesByOwner(ownerUserId: string): Promise<AgentIdentityRecord[]>;
  listUsers(): Promise<AdminUserRecord[]>;
  followUser(followerId: string, followedId: string): Promise<void>;
  unfollowUser(followerId: string, followedId: string): Promise<void>;
  isFollowing(followerId: string, followedId: string): Promise<boolean>;
  createSession(userId: string, title?: string): Promise<SessionRecord>;
  updateSessionTitle(sessionId: string, title: string | null): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listSessions(userId: string): Promise<SessionSummaryRecord[]>;
  listAdminSessions(): Promise<AdminSessionRecord[]>;
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  appendMessage(sessionId: string, role: MessageRecord["role"], content: string, metadata?: Record<string, unknown>): Promise<MessageRecord>;
  updateMessageMetadata(messageId: string, metadata: Record<string, unknown>): Promise<void>;
  createRun(sessionId: string): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRuns(sessionId: string): Promise<RunRecord[]>;
  listAllRuns(): Promise<AdminRunRecord[]>;
  saveAnalyticsEvent(input: {
    event: string;
    userId?: string | null;
    sessionId?: string | null;
    properties?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<AnalyticsEventRecord>;
  listAnalyticsEvents(options?: { since?: string; limit?: number }): Promise<AnalyticsEventRecord[]>;
  listUserMessages(options?: { since?: string; limit?: number }): Promise<Array<{
    id: string;
    sessionId: string;
    userId: string;
    content: string;
    createdAt: string;
  }>>;
  updateRun(runId: string, updates: Partial<Pick<RunRecord, "status" | "plannerTurns" | "completedAt">>): Promise<void>;
  startToolCall(runId: string, toolName: ToolName, argsJson: Record<string, unknown>): Promise<ToolCallRecord>;
  listToolCalls(runId: string): Promise<ToolCallRecord[]>;
  finishToolCall(toolCallId: string, status: ToolCallRecord["status"], resultJson: Record<string, unknown>): Promise<void>;
  listWorks(offset?: number, limit?: number): Promise<WorkSummary[]>;
  countWorks(): Promise<number>;
  getWorkById(workId: string): Promise<WorkDetailRecord | null>;
  estimateResearchScope(query: string, filters?: PassageSearchFilters): Promise<ResearchScopeEstimate>;
  searchWorks(query: string, filters?: Record<string, unknown>): Promise<WorkSummary[]>;
  getWorkMetadata(workIds: string[]): Promise<WorkSummary[]>;
  getRelevantChunks(
    query: string,
    workIds?: string[],
    limit?: number,
    embedding?: number[],
    filters?: PassageSearchFilters,
  ): Promise<ChunkSearchResult[]>;
  getWorkTextFile(workId: string): Promise<WorkTextRecord | null>;
  getWorkFiles(workIds: string[], kinds?: WorkFileKind[]): Promise<WorkFileRecord[]>;
  getChunksByIds(chunkIds: string[]): Promise<ChunkSearchResult[]>;
  getChunkByWorkAndIndex(workId: string, chunkIndex: number): Promise<ChunkSearchResult | null>;
  listRuntimeInstances(sessionId: string): Promise<RuntimeInstanceRecord[]>;
  listExpiredRuntimeInstances(limit?: number): Promise<RuntimeInstanceRecord[]>;
  getRuntimeInstance(runtimeId: string): Promise<RuntimeInstanceRecord | null>;
  saveRuntimeInstance(
    input: Omit<RuntimeInstanceRecord, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<RuntimeInstanceRecord>;
  updateRuntimeInstance(
    runtimeId: string,
    updates: Partial<Pick<RuntimeInstanceRecord, "status" | "manifestJson" | "lastUsedAt" | "expiresAt" | "providerMachineId">>,
  ): Promise<void>;
  saveArtifact(
    input: Omit<ArtifactRecord, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<ArtifactRecord>;
  listArtifacts(sessionId: string, runtimeId?: string | null): Promise<ArtifactRecord[]>;
  createBillingEvent(
    input: Omit<BillingEventRecord, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<BillingEventRecord>;
  getBillingSpend(userId: string, since: string): Promise<BillingSpendSummary>;
  healthCheck(): Promise<"ok" | "error">;
}

type SeedWork = WorkSummary & {
  cleanTextKey?: string;
  chunksKey?: string;
  text?: string;
  metadata?: Record<string, unknown>;
};

type SeedChunk = ChunkSearchResult & {
  embedding?: number[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeGutenbergId(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

type AgentIdentityRow = {
  id: string;
  user_id: string;
  owner_user_id: string | null;
  name: string;
  description: string | null;
  api_key_prefix: string;
  status: AgentIdentityRecord["status"];
  verification_code: string;
  claim_token: string;
  last_used_at: string | null;
  created_at: string;
  claimed_at: string | null;
  metadata_json: Record<string, unknown>;
};

function mapAgentIdentityRow(row: AgentIdentityRow): AgentIdentityRecord {
  return {
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
    metadata: row.metadata_json ?? {},
  };
}

function slugifyProfileHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function deriveUserHandle(user: { email?: string | null; name?: string | null; id?: string | null }): string | null {
  const emailLocalPart = typeof user.email === "string" ? user.email.split("@")[0]?.trim() : "";
  if (emailLocalPart) {
    return slugifyProfileHandle(emailLocalPart);
  }
  const nameSlug = typeof user.name === "string" ? slugifyProfileHandle(user.name) : "";
  if (nameSlug) {
    return nameSlug;
  }
  return null;
}

function readMetadataText(metadata: Record<string, unknown> | undefined, keys: string[]): string | null {
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

function readMetadataTextList(metadata: Record<string, unknown> | undefined, keys: string[]): string[] {
  if (!metadata) {
    return [];
  }
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
    }
  }
  return [];
}

function splitSubtitleFromTitle(title: string): { title: string; subtitle: string | null } {
  const match = title.match(/^(.+?):\s+(.+)$/);
  if (!match) {
    return { title, subtitle: null };
  }
  return {
    title: match[1]?.trim() || title,
    subtitle: match[2]?.trim() || null,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMatchesGenre(haystack: string, genre: string) {
  const normalizedGenre = genre.trim().toLowerCase();
  if (!normalizedGenre) {
    return false;
  }
  return new RegExp(`\\b${escapeRegExp(normalizedGenre)}\\b`, "iu").test(haystack);
}

function toWorkSummary(
  work: Pick<SeedWork, "id" | "gutenbergId" | "title" | "language" | "releaseDate" | "rightsStatus" | "summary" | "authors" | "subjects" | "score" | "metadata"> & {
    feedLabel?: string | null;
  },
): WorkSummary {
  const explicitSubtitle = readMetadataText(work.metadata, ["subtitle", "subTitle", "secondaryTitle"]);
  const explicitCoverImageUrl = readMetadataText(work.metadata, ["coverImageUrl", "coverUrl", "imageUrl", "thumbnailUrl"]);
  const coverImageKey = readMetadataText(work.metadata, ["coverImageKey"]);
  const publisher = readMetadataText(work.metadata, ["publisher"]);
  const bookshelves = readMetadataTextList(work.metadata, ["bookshelves"]);
  const translators = readMetadataTextList(work.metadata, ["translators"]);
  const illustrators = readMetadataTextList(work.metadata, ["illustrators"]);
  const editors = readMetadataTextList(work.metadata, ["editors"]);
  const titleParts = explicitSubtitle ? { title: work.title, subtitle: explicitSubtitle } : splitSubtitleFromTitle(work.title);
  return {
    id: work.id,
    gutenbergId: work.gutenbergId ?? null,
    title: titleParts.title,
    subtitle: titleParts.subtitle,
    coverImageUrl: explicitCoverImageUrl,
    hasCoverImage: Boolean(explicitCoverImageUrl || coverImageKey),
    language: work.language ?? null,
    releaseDate: work.releaseDate ?? null,
    rightsStatus: work.rightsStatus ?? null,
    summary: work.summary ?? null,
    publisher,
    authors: work.authors ?? [],
    subjects: work.subjects ?? [],
    bookshelves,
    translators,
    illustrators,
    editors,
    score: work.score,
    feedLabel: work.feedLabel ?? null,
  };
}

function parseReleaseYear(releaseDate: string | null | undefined) {
  if (typeof releaseDate !== "string" || releaseDate.length < 4) {
    return Number.NaN;
  }
  return Number.parseInt(releaseDate.slice(0, 4), 10);
}

function workGenreHaystack(
  work: Pick<SeedWork, "title" | "summary" | "language" | "subjects" | "metadata">,
) {
  return [
    work.title,
    work.summary ?? "",
    work.language ?? "",
    ...(work.subjects ?? []),
    JSON.stringify(work.metadata ?? {}),
  ].join(" ").toLowerCase();
}

function workMatchesSearchFilters(
  work: Pick<SeedWork, "title" | "summary" | "language" | "releaseDate" | "rightsStatus" | "subjects" | "metadata">,
  filters: Record<string, unknown> = {},
) {
  if (typeof filters.language === "string" && work.language !== filters.language) {
    return false;
  }
  if (typeof filters.rightsStatus === "string" && work.rightsStatus !== filters.rightsStatus) {
    return false;
  }
  if (Array.isArray(filters.yearRange) && filters.yearRange.length === 2) {
    const year = parseReleaseYear(work.releaseDate);
    const [startYear, endYear] = filters.yearRange as [number, number];
    if (!Number.isFinite(year) || year < startYear || year > endYear) {
      return false;
    }
  }
  if (Array.isArray(filters.genre) && filters.genre.length > 0) {
    const haystack = workGenreHaystack(work);
    if (!(filters.genre as unknown[]).some((genre) => typeof genre === "string" && textMatchesGenre(haystack, genre))) {
      return false;
    }
  }
  return true;
}

function lexicalScore(query: string, text: string): number {
  const tokens = query
    .toLowerCase()
    .split(/\W+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const haystack = text.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function excerpt(text: string, query: string): string {
  const lower = text.toLowerCase();
  const match = query
    .toLowerCase()
    .split(/\W+/)
    .find((token) => token && lower.includes(token));
  const index = match ? lower.indexOf(match) : 0;
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, start + 220);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

const EXPECTED_EMBEDDING_DIMENSIONS = 1536;

const WORK_SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "book",
  "books",
  "can",
  "at",
  "be",
  "by",
  "cite",
  "corpus",
  "find",
  "for",
  "from",
  "give",
  "got",
  "hello",
  "help",
  "hey",
  "how",
  "in",
  "is",
  "it",
  "library",
  "like",
  "likely",
  "look",
  "looking",
  "me",
  "of",
  "on",
  "or",
  "passages",
  "people",
  "please",
  "pull",
  "seed",
  "show",
  "some",
  "strongest",
  "the",
  "them",
  "then",
  "there",
  "these",
  "this",
  "those",
  "times",
  "to",
  "up",
  "want",
  "what",
  "where",
  "which",
  "with",
]);

const QUERY_SYNONYMS: Record<string, string[]> = {
  anger: ["angry", "rage", "furious", "wrath", "ira", "sdegno"],
  angry: ["anger", "rage", "furious", "wrath", "ira", "sdegno"],
  back: ["again", "return", "returned", "reconcile", "reconciled", "reunion", "reunited"],
  broke: ["breakup", "parted", "separation", "divorce", "divorced"],
  breakup: ["break", "broke", "broken", "separation", "parted", "divorce", "divorced", "left"],
  broken: ["breakup", "parted", "separation", "divorce", "divorced"],
  together: ["reconcile", "reconciled", "reunion", "reunited", "return", "returned", "married", "lover"],
  grief: ["sadness", "sorrow", "mourning", "lament", "melancholy"],
  sadness: ["grief", "sorrow", "mourning", "lament", "melancholy"],
  obsession: ["fixation", "mania", "compulsion"],
  rage: ["anger", "angry", "furious", "wrath"],
};

const METADATA_SEARCH_QUERY_STOP_WORDS = new Set([
  "1800",
  "1899",
  "1900",
  "black",
  "bitter",
  "death",
  "died",
  "deep",
  "dress",
  "19th",
  "century",
  "english",
  "fiction",
  "novel",
  "novels",
  "romance",
  "romances",
  "story",
  "stories",
  "tale",
  "tales",
  "year",
  "literature",
  "book",
  "books",
  "text",
  "texts",
  "work",
  "works",
  "public",
  "domain",
  "gutenberg",
  "author",
  "authors",
  "en",
  "her",
  "his",
  "lost",
  "after",
  "widow",
  "widows",
  "widower",
  "widowers",
]);

const GRIEF_THEME_TOKENS = new Set([
  "bereavement",
  "comfort",
  "funeral",
  "grief",
  "lament",
  "melancholy",
  "mourn",
  "mourning",
  "sorrow",
  "weep",
  "weeping",
  "wept",
]);

const GRIEF_BROADENING_TERMS = [
  "grief",
  "mourning",
  "bereavement",
  "sorrow",
  "lament",
  "melancholy",
  "weep",
  "wept",
  "tears",
  "funeral",
  "buried",
  "loss",
  "consolation",
  "despair",
];

const GRIEF_EXPLICIT_MATCH_PATTERN = /\b(grief|mourning|bereavement|funeral|sorrow|lament|weep|wept|weeping|tears?|loss|dead|death|consolation|despair)\b/u;
const GRIEF_METADATA_STRONG_MATCH_PATTERN = /\b(grief|mourning|bereavement|funeral|sorrow|lament|weep|wept|weeping|tears?|loss|consolation|despair)\b/u;
const JUVENILE_MATCH_PATTERN = /\b(juvenile|children|child|girls|boys|school|schools|orphans?|pz)\b/u;
const ORPHAN_MATCH_PATTERN = /\borphans?\b/u;
const DEATH_TITLE_ONLY_PATTERN = /\b(dead|death)\b/u;
const LOW_SIGNAL_GENRE_PATTERN = /\b(science fiction|horror|drama|satire)\b/u;
const FICTION_SIGNAL_PATTERN = /\b(fiction|novel|novels|story|stories|tale|tales|romance|romances|short stories)\b/u;
const NONFICTION_SIGNAL_PATTERN = /\b(biography|biographies|diary|diaries|history|registers of dead|funeral rites|ceremonies|folklore|personal narratives|memoir|memoirs)\b/u;
const SHORT_FORM_PATTERN = /\b(short stories|short story)\b/u;

function normalizeSearchQuery(query: string): string {
  const tokens = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !WORK_SEARCH_STOP_WORDS.has(token)),
    ),
  );
  return tokens.join(" ");
}

function searchTokens(query: string): string[] {
  const normalized = normalizeSearchQuery(query);
  return Array.from(
    new Set(
      normalized
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !WORK_SEARCH_STOP_WORDS.has(token)),
    ),
  ).slice(0, 8);
}

function expandedSearchTokens(query: string): string[] {
  const baseTokens = searchTokens(query);
  const expanded = new Set(baseTokens);
  for (const token of baseTokens) {
    for (const synonym of QUERY_SYNONYMS[token] ?? []) {
      if (synonym.length >= 3 && !WORK_SEARCH_STOP_WORDS.has(synonym)) {
        expanded.add(synonym);
      }
    }
  }
  return [...expanded].slice(0, 16);
}

function isBroadMetadataSurveyQuery(query: string) {
  return /\b(all|every|compare|comparison|trace|theme|pattern|survey|synthesize|search|find|why|how|where|when|across|identify|different|examples|kinds|types)\b/iu.test(
    query,
  );
}

function metadataSearchTerms(query: string): string[] {
  const expanded = expandedSearchTokens(query);
  const hasStrongGriefSignal = expanded.some((token) => GRIEF_THEME_TOKENS.has(token));
  const broadSurveyQuery = isBroadMetadataSurveyQuery(query);
  const terms = hasStrongGriefSignal
    ? Array.from(new Set([...expanded, ...GRIEF_BROADENING_TERMS]))
    : expanded;
  return terms
    .filter((token) => !METADATA_SEARCH_QUERY_STOP_WORDS.has(token))
    .filter((token) => !(hasStrongGriefSignal && (token === "widow" || token === "widows")))
    .filter((token) => !(hasStrongGriefSignal && (token === "orphan" || token === "orphans")))
    .filter((token) => !(hasStrongGriefSignal && (token === "child" || token === "children" || token === "juvenile")))
    .filter((token) => !/^\d{4}$/u.test(token))
    .slice(0, broadSurveyQuery ? 24 : 16);
}

function clampPercentage(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function recommendedShardAxis(query: string, estimatedWorkBreadth: number): ResearchScopeEstimate["recommendedShardAxis"] {
  if (estimatedWorkBreadth <= 24) {
    return "none";
  }
  if (/\b(180\d|181\d|182\d|183\d|184\d|185\d|186\d|187\d|188\d|189\d|century|decade|era|period|before|after)\b/iu.test(query)) {
    return "publication_year";
  }
  if (/\b(compare|comparison|across|survey|pattern|types|different ways|kinds of)\b/iu.test(query)) {
    return "work_id_hash";
  }
  if (/\b(author|authors|writer|writers|novelist|novelists)\b/iu.test(query)) {
    return "author_initial";
  }
  return "retrieval_strategy";
}

function buildWorkIdHashShards(totalShards: number, targetWorkCount: number, estimatedCoveragePercent: number): ResearchShardDescriptor[] {
  const totalBuckets = 256;
  return Array.from({ length: totalShards }, (_, index) => {
    const hashBucketStart = Math.floor((index * totalBuckets) / totalShards);
    const hashBucketEnd = Math.floor(((index + 1) * totalBuckets) / totalShards) - 1;
    return {
      shardId: `work-hash-${index + 1}`,
      index,
      totalShards,
      axis: "work_id_hash",
      label: `Work hash ${hashBucketStart}-${hashBucketEnd}`,
      targetWorkCount,
      estimatedCoveragePercent,
      hashBucketStart,
      hashBucketEnd,
    };
  });
}

function buildAuthorInitialShards(totalShards: number, targetWorkCount: number, estimatedCoveragePercent: number): ResearchShardDescriptor[] {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  return Array.from({ length: totalShards }, (_, index) => {
    const startIndex = Math.floor((index * letters.length) / totalShards);
    const endIndex = Math.min(letters.length - 1, Math.floor(((index + 1) * letters.length) / totalShards) - 1);
    return {
      shardId: `author-initial-${index + 1}`,
      index,
      totalShards,
      axis: "author_initial",
      label: `Authors ${letters[startIndex]}-${letters[endIndex]}`,
      targetWorkCount,
      estimatedCoveragePercent,
      authorInitialStart: letters[startIndex],
      authorInitialEnd: letters[endIndex],
    };
  });
}

function buildPublicationYearShards(totalShards: number, targetWorkCount: number, estimatedCoveragePercent: number): ResearchShardDescriptor[] {
  const yearStart = 1800;
  const yearEnd = 1899;
  const span = yearEnd - yearStart + 1;
  return Array.from({ length: totalShards }, (_, index) => {
    const sliceStart = yearStart + Math.floor((index * span) / totalShards);
    const sliceEnd = yearStart + Math.floor((((index + 1) * span) / totalShards)) - 1;
    return {
      shardId: `publication-year-${index + 1}`,
      index,
      totalShards,
      axis: "publication_year",
      label: `Years ${sliceStart}-${Math.max(sliceStart, sliceEnd)}`,
      targetWorkCount,
      estimatedCoveragePercent,
      yearStart: sliceStart,
      yearEnd: Math.max(sliceStart, sliceEnd),
    };
  });
}

function buildRetrievalStrategyShards(totalShards: number, targetWorkCount: number, estimatedCoveragePercent: number): ResearchShardDescriptor[] {
  const strategies = [
    "metadata_expansion",
    "semantic_chunk_search",
    "lexical_regex_search",
    "neighbor_expansion",
    "verification_rerank",
    "gap_fill",
  ];
  return Array.from({ length: totalShards }, (_, index) => {
    const strategy = strategies[index] ?? `strategy_${index + 1}`;
    return {
      shardId: `retrieval-strategy-${index + 1}`,
      index,
      totalShards,
      axis: "retrieval_strategy",
      label: strategy.replaceAll("_", " "),
      targetWorkCount,
      estimatedCoveragePercent,
      strategy,
    };
  });
}

function buildRecommendedShards(
  shardAxis: ResearchScopeEstimate["recommendedShardAxis"],
  recommendedParallelism: number,
  recommendedFrontierWorks: number,
  effectiveWorkBreadth: number,
) {
  const totalShards = Math.max(1, recommendedParallelism);
  const targetWorkCount = Math.max(8, Math.ceil(recommendedFrontierWorks / totalShards));
  const estimatedCoveragePercent = clampPercentage((recommendedFrontierWorks / Math.max(effectiveWorkBreadth, 1)) * 100);
  switch (shardAxis) {
    case "author_initial":
      return buildAuthorInitialShards(totalShards, targetWorkCount, estimatedCoveragePercent);
    case "publication_year":
      return buildPublicationYearShards(totalShards, targetWorkCount, estimatedCoveragePercent);
    case "retrieval_strategy":
      return buildRetrievalStrategyShards(totalShards, targetWorkCount, estimatedCoveragePercent);
    case "none":
      return [];
    case "work_id_hash":
    default:
      return buildWorkIdHashShards(totalShards, targetWorkCount, estimatedCoveragePercent);
  }
}

function buildResearchScopeEstimate(
  query: string,
  metadataWorkEstimate: number,
  chunkMatchEstimate: number,
  chunkWorkEstimate: number,
  probeWorks: WorkSummary[],
): ResearchScopeEstimate {
  const effectiveWorkBreadth = Math.max(metadataWorkEstimate, chunkWorkEstimate, probeWorks.length);
  let breadthBand: ResearchScopeEstimate["breadthBand"] = "tiny";
  let recommendedIntensity: ResearchScopeEstimate["recommendedIntensity"] = "normal";
  let recommendedWallClockMinutes: ResearchScopeEstimate["recommendedWallClockMinutes"] = 5;
  let recommendedParallelism = 1;
  let recommendedVmWorkBudget = 40;
  let recommendedFrontierWorks = 24;

  if (effectiveWorkBreadth > 160 || chunkMatchEstimate > 12_000) {
    breadthBand = "huge";
    recommendedIntensity = "maximum";
    recommendedWallClockMinutes = 60;
    recommendedParallelism = 12;
    recommendedVmWorkBudget = 36;
    recommendedFrontierWorks = 192;
  } else if (effectiveWorkBreadth > 80 || chunkMatchEstimate > 4_000) {
    breadthBand = "large";
    recommendedIntensity = "maximum";
    recommendedWallClockMinutes = 60;
    recommendedParallelism = 8;
    recommendedVmWorkBudget = 40;
    recommendedFrontierWorks = 128;
  } else if (effectiveWorkBreadth > 30 || chunkMatchEstimate > 1_000) {
    breadthBand = "medium";
    recommendedIntensity = "high";
    recommendedWallClockMinutes = 15;
    recommendedParallelism = 4;
    recommendedVmWorkBudget = 32;
    recommendedFrontierWorks = 72;
  } else if (effectiveWorkBreadth > 12 || chunkMatchEstimate > 200) {
    breadthBand = "small";
    recommendedIntensity = "high";
    recommendedWallClockMinutes = 15;
    recommendedParallelism = 2;
    recommendedVmWorkBudget = 24;
    recommendedFrontierWorks = 40;
  }

  const breadthDenominator = Math.max(effectiveWorkBreadth, 1);
  const estimatedCoveragePercent = {
    normal: clampPercentage((40 / breadthDenominator) * 100),
    high: clampPercentage((120 / breadthDenominator) * 100),
    maximum: clampPercentage((320 / breadthDenominator) * 100),
  };

  const shardAxis = recommendedShardAxis(query, effectiveWorkBreadth);
  const recommendedShards = buildRecommendedShards(
    shardAxis,
    recommendedParallelism,
    recommendedFrontierWorks,
    effectiveWorkBreadth,
  );
  const rationale = [
    `The cheap probes suggest roughly ${effectiveWorkBreadth} books are in play`,
    chunkMatchEstimate > 0 ? `with about ${chunkMatchEstimate} matching passages` : "with sparse direct passage matches so far",
    `so the recommended intensity is ${recommendedIntensity} (${recommendedWallClockMinutes} minutes)`,
    recommendedParallelism > 1 ? `using ${recommendedParallelism} parallel shards on ${shardAxis.replaceAll("_", " ")}` : "without parallel sharding yet",
    `and a frontier of about ${recommendedFrontierWorks} active books before verification narrows it.`,
  ].join(", ");

  return {
    query,
    metadataWorkEstimate,
    chunkMatchEstimate,
    chunkWorkEstimate,
    breadthBand,
    recommendedIntensity,
    recommendedWallClockMinutes,
    recommendedParallelism,
    recommendedShardAxis: shardAxis,
    recommendedVmWorkBudget,
    recommendedFrontierWorks,
    estimatedCoveragePercent,
    probeWorks: probeWorks.slice(0, 6).map((work) => ({
      id: work.id,
      title: work.title,
      authors: work.authors ?? [],
    })),
    recommendedShards,
    rationale,
  };
}

function metadataTextHaystack(row: {
  title: string;
  summary: string | null;
  authors: string[];
  subjects: string[];
  metadata_json: Record<string, unknown>;
}) {
  return [
    row.title,
    row.summary ?? "",
    ...(row.authors ?? []),
    ...(row.subjects ?? []),
    JSON.stringify(row.metadata_json ?? {}),
  ].join(" ").toLowerCase();
}

function hasExplicitGriefMetadataMatch(haystack: string) {
  return GRIEF_METADATA_STRONG_MATCH_PATTERN.test(haystack);
}

function shouldAcceptMetadataRows<T extends {
  title: string;
  summary: string | null;
  authors: string[];
  subjects: string[];
  metadata_json: Record<string, unknown>;
}>(rows: T[], query: string, limit: number) {
  const terms = metadataSearchTerms(query);
  const hasStrongGriefSignal = terms.some((token) => GRIEF_THEME_TOKENS.has(token));
  const broadSurveyQuery = isBroadMetadataSurveyQuery(query);
  if (!hasStrongGriefSignal) {
    const target = broadSurveyQuery ? Math.min(limit, 12) : Math.min(limit, 6);
    return rows.length >= target;
  }
  const strongMatches = rows
    .slice(0, Math.min(rows.length, broadSurveyQuery ? 14 : 8))
    .filter((row) => hasExplicitGriefMetadataMatch(metadataTextHaystack(row)));
  return strongMatches.length >= Math.min(limit, broadSurveyQuery ? 6 : 4);
}

function rerankMetadataRows<T extends {
  title: string;
  summary: string | null;
  authors: string[];
  subjects: string[];
  metadata_json: Record<string, unknown>;
  score: number;
}>(rows: T[], query: string): T[] {
  const terms = metadataSearchTerms(query);
  const hasStrongGriefSignal = terms.some((token) => GRIEF_THEME_TOKENS.has(token));
  const asksForJuvenile = /\b(children|child|juvenile|girl|girls|boy|boys|school|orphan|orphans)\b/iu.test(query);
  const asksForFiction = /\bfiction|novel|novels|short fiction|story|stories|tale|tales|romance\b/iu.test(query);
  return rows
    .map((row) => {
      const haystack = metadataTextHaystack(row);
      let bonus = 0;
      for (const term of terms) {
        if (!haystack.includes(term)) {
          continue;
        }
        bonus += GRIEF_THEME_TOKENS.has(term) ? 0.35 : 0.12;
      }
      const hasExplicitGriefMatch = GRIEF_EXPLICIT_MATCH_PATTERN.test(haystack);
      const titleHasDeathWord = DEATH_TITLE_ONLY_PATTERN.test(row.title.toLowerCase());
      if (hasStrongGriefSignal && !hasExplicitGriefMatch) {
        bonus -= 0.4;
      }
      if (hasStrongGriefSignal && /\bwidows?\b/u.test(haystack) && !hasExplicitGriefMatch) {
        bonus -= 0.45;
      }
      if (hasStrongGriefSignal && titleHasDeathWord && !hasExplicitGriefMatch) {
        bonus -= 1.2;
      }
      if (hasStrongGriefSignal && LOW_SIGNAL_GENRE_PATTERN.test(haystack) && !hasExplicitGriefMatch) {
        bonus -= 0.9;
      }
      if (asksForFiction && !FICTION_SIGNAL_PATTERN.test(haystack)) {
        bonus -= 1.1;
      }
      if (asksForFiction && NONFICTION_SIGNAL_PATTERN.test(haystack)) {
        bonus -= 1.25;
      }
      if (hasStrongGriefSignal && !asksForJuvenile) {
        if (JUVENILE_MATCH_PATTERN.test(haystack) && !hasExplicitGriefMatch) {
          bonus -= 1.15;
        } else if (JUVENILE_MATCH_PATTERN.test(haystack)) {
          bonus -= 0.55;
        }
        if (ORPHAN_MATCH_PATTERN.test(haystack) && !hasExplicitGriefMatch) {
          bonus -= 0.35;
        }
        if (SHORT_FORM_PATTERN.test(haystack) && !hasExplicitGriefMatch) {
          bonus -= 0.45;
        }
      }
      if (hasStrongGriefSignal && hasExplicitGriefMatch) {
        bonus += 0.45;
      }
      return {
        row,
        totalScore: row.score + bonus,
      };
    })
    .sort((left, right) => right.totalScore - left.totalScore || left.row.title.localeCompare(right.row.title))
    .map((entry) => ({
      ...entry.row,
      score: entry.totalScore,
    }));
}

function dedupeMetadataRows<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    deduped.push(row);
  }
  return deduped;
}

function buildMetadataTsQuery(query: string): string {
  const terms = metadataSearchTerms(query)
    .filter((term) => /^[a-z0-9]+$/iu.test(term))
    .map((term) => `${term}:*`);
  return terms.join(" | ");
}

function relaxMetadataSearchFilters(filters: Record<string, unknown>) {
  const variants: Record<string, unknown>[] = [];
  const push = (candidate: Record<string, unknown>) => {
    const key = JSON.stringify(candidate, Object.keys(candidate).sort());
    if (!variants.some((existing) => JSON.stringify(existing, Object.keys(existing).sort()) === key)) {
      variants.push(candidate);
    }
  };

  if ("yearRange" in filters) {
    const { yearRange: _yearRange, ...withoutYearRange } = filters;
    push(withoutYearRange);
  }
  if ("language" in filters) {
    const { language: _language, ...withoutLanguage } = filters;
    push(withoutLanguage);
  }
  if ("yearRange" in filters && "language" in filters) {
    const { yearRange: _yearRange, language: _language, ...withoutBoth } = filters;
    push(withoutBoth);
  }
  return variants;
}

function shouldDiversifyChunkResults(query: string, workIds: string[] | undefined, limit: number) {
  if (limit < 12) {
    return false;
  }
  if (Array.isArray(workIds) && workIds.length >= 16) {
    return true;
  }
  return isBroadMetadataSurveyQuery(query);
}

function diversifyChunkResults<T extends { workId: string; score: number }>(
  query: string,
  workIds: string[] | undefined,
  rows: T[],
  limit: number,
) {
  if (!shouldDiversifyChunkResults(query, workIds, limit) || rows.length <= limit) {
    return rows.slice(0, limit);
  }
  const perWorkCap = Array.isArray(workIds) && workIds.length > 48 ? 2 : 3;
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.workId) ?? [];
    bucket.push(row);
    grouped.set(row.workId, bucket);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((left, right) => right.score - left.score);
  }
  const selected: T[] = [];
  for (let pass = 0; selected.length < limit && pass < perWorkCap; pass += 1) {
    for (const bucket of grouped.values()) {
      const candidate = bucket[pass];
      if (!candidate) {
        continue;
      }
      selected.push(candidate);
      if (selected.length >= limit) {
        break;
      }
    }
  }
  if (selected.length < limit) {
    const seen = new Set(selected.map((row) => `${row.workId}:${JSON.stringify(row)}`));
    for (const row of rows) {
      const key = `${row.workId}:${JSON.stringify(row)}`;
      if (seen.has(key)) {
        continue;
      }
      selected.push(row);
      seen.add(key);
      if (selected.length >= limit) {
        break;
      }
    }
  }
  return selected.slice(0, limit);
}

export class InMemoryAppStore implements AppStore {
  private readonly users = new Set<string>();
  private readonly userProfiles = new Map<string, UserRecord>();
  private readonly agentIdentities = new Map<string, AgentIdentityRecord & { apiKeyHash: string }>();
  private readonly follows = new Set<string>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  private readonly runtimeInstances = new Map<string, RuntimeInstanceRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly billingEvents = new Map<string, BillingEventRecord>();
  private readonly analyticsEvents = new Map<string, AnalyticsEventRecord>();

  constructor(
    private readonly works: SeedWork[] = [],
    private readonly chunks: SeedChunk[] = [],
  ) {}

  async ensureUser(userId: string): Promise<void> {
    this.users.add(userId);
    if (!this.userProfiles.has(userId)) {
      this.userProfiles.set(userId, {
        id: userId,
        email: null,
        handle: null,
        name: "AlphaBook User",
        avatarUrl: null,
        createdAt: nowIso(),
        followersCount: 0,
        followingCount: 0,
      });
    }
  }

  async upsertUserProfile(input: { id: string; email?: string | null; name?: string | null; avatarUrl?: string | null }): Promise<UserRecord> {
    const existingByEmail = input.email
      ? [...this.userProfiles.values()].find((profile) => profile.email === input.email)
      : null;
    const canonicalId = existingByEmail?.id ?? input.id;
    const existing = this.userProfiles.get(canonicalId);
    const record: UserRecord = {
      id: canonicalId,
      email: input.email ?? existing?.email ?? null,
      handle: deriveUserHandle({
        email: input.email ?? existing?.email ?? null,
        name: input.name ?? existing?.name ?? "AlphaBook User",
        id: canonicalId,
      }),
      name: input.name ?? existing?.name ?? "AlphaBook User",
      avatarUrl: input.avatarUrl ?? existing?.avatarUrl ?? null,
      createdAt: existing?.createdAt ?? nowIso(),
      followersCount: existing?.followersCount ?? 0,
      followingCount: existing?.followingCount ?? 0,
    };
    this.users.add(canonicalId);
    this.userProfiles.set(canonicalId, record);
    return record;
  }

  async getUserProfile(userId: string): Promise<UserRecord | null> {
    const profile = this.userProfiles.get(userId);
    if (!profile) {
      return null;
    }
    return {
      ...profile,
      followersCount: this.countFollowers(userId),
      followingCount: this.countFollowing(userId),
    };
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
    const ownerUserId = input.ownerUserId ?? null;
    if (ownerUserId) {
      await this.ensureUser(ownerUserId);
    }
    const createdAt = nowIso();
    const record: AgentIdentityRecord & { apiKeyHash: string } = {
      id: crypto.randomUUID(),
      userId,
      ownerUserId,
      name: input.name,
      description: input.description ?? null,
      apiKeyPrefix: input.apiKeyPrefix,
      apiKeyHash: input.apiKeyHash,
      status: ownerUserId ? "active" : "pending_claim",
      verificationCode: input.verificationCode,
      claimToken: input.claimToken,
      lastUsedAt: null,
      createdAt,
      claimedAt: ownerUserId ? createdAt : null,
      metadata: input.metadata ?? {},
    };
    this.agentIdentities.set(record.id, record);
    await this.upsertUserProfile({
      id: userId,
      name: input.name,
    });
    return this.toAgentIdentityRecord(record);
  }

  async authenticateAgentApiKey(apiKeyHash: string): Promise<AgentIdentityRecord | null> {
    const record = [...this.agentIdentities.values()].find((candidate) => candidate.apiKeyHash === apiKeyHash) ?? null;
    if (!record || record.status === "revoked") {
      return null;
    }
    record.lastUsedAt = nowIso();
    return this.toAgentIdentityRecord(record);
  }

  async getAgentIdentityByUserId(userId: string): Promise<AgentIdentityRecord | null> {
    const record = [...this.agentIdentities.values()].find((candidate) => candidate.userId === userId) ?? null;
    return record ? this.toAgentIdentityRecord(record) : null;
  }

  async getAgentIdentityByClaimToken(claimToken: string): Promise<AgentIdentityRecord | null> {
    const record = [...this.agentIdentities.values()].find((candidate) => candidate.claimToken === claimToken) ?? null;
    return record ? this.toAgentIdentityRecord(record) : null;
  }

  async claimAgentIdentity(claimToken: string, ownerUserId: string): Promise<AgentIdentityRecord | null> {
    await this.ensureUser(ownerUserId);
    const record = [...this.agentIdentities.values()].find((candidate) => candidate.claimToken === claimToken) ?? null;
    if (!record || record.status === "revoked") {
      return null;
    }
    const claimedAt = nowIso();
    record.ownerUserId = ownerUserId;
    record.status = "active";
    record.claimedAt = claimedAt;
    return this.toAgentIdentityRecord(record);
  }

  async listAgentIdentitiesByOwner(ownerUserId: string): Promise<AgentIdentityRecord[]> {
    return [...this.agentIdentities.values()]
      .filter((record) => record.ownerUserId === ownerUserId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => this.toAgentIdentityRecord(record));
  }

  async listUsers(): Promise<AdminUserRecord[]> {
    const runsBySession = [...this.runs.values()].reduce((map, run) => {
      map.set(run.sessionId, (map.get(run.sessionId) ?? 0) + 1);
      return map;
    }, new Map<string, number>());
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    return [...this.userProfiles.values()]
      .map((profile) => {
        const sessions = [...this.sessions.values()].filter((session) => session.userId === profile.id);
        const sessionIds = new Set(sessions.map((session) => session.id));
        const messages = [...this.messages.values()].flat().filter((message) => sessionIds.has(message.sessionId));
        const billingEvents = [...this.billingEvents.values()].filter((event) => event.userId === profile.id);
        const lastSeenAt = messages
          .map((message) => message.createdAt)
          .sort((left, right) => right.localeCompare(left))[0] ?? null;

        return {
          ...profile,
          followersCount: this.countFollowers(profile.id),
          followingCount: this.countFollowing(profile.id),
          sessionCount: sessions.length,
          runCount: sessions.reduce((total, session) => total + (runsBySession.get(session.id) ?? 0), 0),
          lastSeenAt,
          monthlySpendUsd: Math.round(
            billingEvents
              .filter((event) => Date.parse(event.createdAt) >= thirtyDaysAgo)
              .reduce((total, event) => total + event.costUsd, 0) * 1_000_000,
          ) / 1_000_000,
          totalSpendUsd: Math.round(billingEvents.reduce((total, event) => total + event.costUsd, 0) * 1_000_000) / 1_000_000,
          billingEventCount: billingEvents.length,
        };
      })
      .sort((left, right) => {
        const rightValue = right.lastSeenAt ?? right.createdAt;
        const leftValue = left.lastSeenAt ?? left.createdAt;
        return rightValue.localeCompare(leftValue);
      });
  }

  async followUser(followerId: string, followedId: string): Promise<void> {
    if (followerId === followedId) {
      return;
    }
    await this.ensureUser(followerId);
    await this.ensureUser(followedId);
    this.follows.add(`${followerId}:${followedId}`);
  }

  async unfollowUser(followerId: string, followedId: string): Promise<void> {
    this.follows.delete(`${followerId}:${followedId}`);
  }

  async isFollowing(followerId: string, followedId: string): Promise<boolean> {
    return this.follows.has(`${followerId}:${followedId}`);
  }

  async createSession(userId: string, title?: string): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: crypto.randomUUID(),
      userId,
      title: title ?? null,
      createdAt: nowIso(),
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  async updateSessionTitle(sessionId: string, title: string | null): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.set(sessionId, {
      ...session,
      title,
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listSessions(userId: string): Promise<SessionSummaryRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .map((session) => {
        const messages = this.messages.get(session.id) ?? [];
        const lastMessage = messages[messages.length - 1] ?? null;
        return {
          ...session,
          lastMessageAt: lastMessage?.createdAt ?? null,
          lastMessagePreview: lastMessage?.content.slice(0, 120) ?? null,
        };
      })
      .sort((left, right) => (right.lastMessageAt ?? right.createdAt).localeCompare(left.lastMessageAt ?? left.createdAt));
  }

  async listAdminSessions(): Promise<AdminSessionRecord[]> {
    return [...this.sessions.values()]
      .map((session) => {
        const user = this.userProfiles.get(session.userId) ?? null;
        const messages = this.messages.get(session.id) ?? [];
        const sessionRuns = [...this.runs.values()].filter((run) => run.sessionId === session.id);
        const lastMessage = messages[messages.length - 1] ?? null;
        const spendUsd = [...this.billingEvents.values()]
          .filter((event) => event.sessionId === session.id)
          .reduce((total, event) => total + event.costUsd, 0);
        return {
          ...session,
          userEmail: user?.email ?? null,
          userName: user?.name ?? null,
          runCount: sessionRuns.length,
          messageCount: messages.length,
          lastMessageAt: lastMessage?.createdAt ?? null,
          lastMessagePreview: lastMessage?.content.slice(0, 160) ?? null,
          spendUsd: Math.round(spendUsd * 1_000_000) / 1_000_000,
        };
      })
      .sort((left, right) => (right.lastMessageAt ?? right.createdAt).localeCompare(left.lastMessageAt ?? left.createdAt));
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    return [...(this.messages.get(sessionId) ?? [])];
  }

  async appendMessage(
    sessionId: string,
    role: MessageRecord["role"],
    content: string,
    metadata: Record<string, unknown> = {},
  ): Promise<MessageRecord> {
    const message: MessageRecord = {
      id: crypto.randomUUID(),
      sessionId,
      role,
      content,
      metadata,
      createdAt: nowIso(),
    };
    const existing = this.messages.get(sessionId) ?? [];
    existing.push(message);
    this.messages.set(sessionId, existing);
    return message;
  }

  async updateMessageMetadata(messageId: string, metadata: Record<string, unknown>): Promise<void> {
    for (const [sessionId, messages] of this.messages.entries()) {
      const index = messages.findIndex((message) => message.id === messageId);
      if (index === -1) {
        continue;
      }
      const next = [...messages];
      next[index] = {
        ...next[index],
        metadata,
      };
      this.messages.set(sessionId, next);
      return;
    }
  }

  async createRun(sessionId: string): Promise<RunRecord> {
    const run: RunRecord = {
      id: crypto.randomUUID(),
      sessionId,
      status: "running",
      plannerTurns: 0,
      startedAt: nowIso(),
      completedAt: null,
    };
    this.runs.set(run.id, run);
    return run;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRuns(sessionId: string): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async listAllRuns(): Promise<AdminRunRecord[]> {
    return [...this.runs.values()]
      .map((run) => {
        const session = this.sessions.get(run.sessionId) ?? null;
        const user = session ? this.userProfiles.get(session.userId) ?? null : null;
        const messages = this.messages.get(run.sessionId) ?? [];
        const toolCallCount = [...this.toolCalls.values()].filter((toolCall) => toolCall.runId === run.id).length;
        return {
          ...run,
          userId: session?.userId ?? "unknown",
          userEmail: user?.email ?? null,
          userName: user?.name ?? null,
          sessionTitle: session?.title ?? null,
          toolCallCount,
          messageCount: messages.length,
          lastMessagePreview: messages[messages.length - 1]?.content.slice(0, 160) ?? null,
          spendUsd: Math.round(
            [...this.billingEvents.values()]
              .filter((event) => event.runId === run.id)
              .reduce((total, event) => total + event.costUsd, 0) * 1_000_000,
          ) / 1_000_000,
        };
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async saveAnalyticsEvent(input: {
    event: string;
    userId?: string | null;
    sessionId?: string | null;
    properties?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<AnalyticsEventRecord> {
    const record: AnalyticsEventRecord = {
      id: crypto.randomUUID(),
      event: input.event,
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      properties: input.properties ?? {},
      createdAt: input.createdAt ?? nowIso(),
    };
    this.analyticsEvents.set(record.id, record);
    return record;
  }

  async listAnalyticsEvents(options: { since?: string; limit?: number } = {}): Promise<AnalyticsEventRecord[]> {
    const sinceTs = options.since ? Date.parse(options.since) : Number.NEGATIVE_INFINITY;
    const limit = options.limit ?? 500;
    return [...this.analyticsEvents.values()]
      .filter((event) => Date.parse(event.createdAt) >= sinceTs)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async listUserMessages(options: { since?: string; limit?: number } = {}) {
    const sinceTs = options.since ? Date.parse(options.since) : Number.NEGATIVE_INFINITY;
    const limit = options.limit ?? 500;
    return [...this.messages.values()]
      .flat()
      .filter((message) => message.role === "user" && Date.parse(message.createdAt) >= sinceTs)
      .map((message) => ({
        id: message.id,
        sessionId: message.sessionId,
        userId: this.sessions.get(message.sessionId)?.userId ?? "unknown",
        content: message.content,
        createdAt: message.createdAt,
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async updateRun(runId: string, updates: Partial<Pick<RunRecord, "status" | "plannerTurns" | "completedAt">>): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    Object.assign(run, updates);
    this.runs.set(runId, run);
  }

  async startToolCall(runId: string, toolName: ToolName, argsJson: Record<string, unknown>): Promise<ToolCallRecord> {
    const toolCall: ToolCallRecord = {
      id: crypto.randomUUID(),
      runId,
      toolName,
      argsJson,
      resultJson: null,
      status: "running",
      startedAt: nowIso(),
      completedAt: null,
    };
    this.toolCalls.set(toolCall.id, toolCall);
    return toolCall;
  }

  async listToolCalls(runId: string): Promise<ToolCallRecord[]> {
    return [...this.toolCalls.values()]
      .filter((toolCall) => toolCall.runId === runId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async finishToolCall(toolCallId: string, status: ToolCallRecord["status"], resultJson: Record<string, unknown>): Promise<void> {
    const toolCall = this.toolCalls.get(toolCallId);
    if (!toolCall) {
      return;
    }
    toolCall.status = status;
    toolCall.resultJson = resultJson;
    toolCall.completedAt = nowIso();
  }

  async listWorks(offset = 0, limit = 12): Promise<WorkSummary[]> {
    return [...this.works]
      .map((work) => {
        const metadata = work.metadata ?? {};
        const hasCover = Boolean(
          readMetadataText(metadata, ["coverImageKey", "coverImageUrl", "coverUrl", "imageUrl", "thumbnailUrl"]),
        );
        const bookshelves = readMetadataTextList(metadata, ["bookshelves"]);
        const score =
          (hasCover ? 0.9 : 0)
          + (work.summary ? 0.8 : 0)
          + (work.authors.length > 0 ? 0.35 : 0)
          + Math.min(bookshelves.length, 3) * 0.18;
        const feedLabel = hasCover && work.summary
          ? "Worth opening"
          : bookshelves.length > 0
            ? "Shelved to discover"
            : "From the stack";
        return { ...work, score, feedLabel };
      })
      .sort((left, right) => {
        const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        const leftRelease = left.releaseDate ?? "";
        const rightRelease = right.releaseDate ?? "";
        if (leftRelease !== rightRelease) {
          return rightRelease.localeCompare(leftRelease);
        }
        return left.title.localeCompare(right.title);
      })
      .slice(offset, offset + limit)
      .map((work) => toWorkSummary(work));
  }

  async countWorks(): Promise<number> {
    return this.works.length;
  }

  async estimateResearchScope(query: string, filters: PassageSearchFilters = {}): Promise<ResearchScopeEstimate> {
    const probeWorks = await this.searchWorks(query, {
      ...filters,
      limit: 6,
    } as Record<string, unknown>);
    const metadataWorkEstimate = [...this.works]
      .filter((work) => workMatchesSearchFilters(work, filters as Record<string, unknown>))
      .filter((work) => {
        const haystack = `${work.title} ${work.summary ?? ""} ${work.authors.join(" ")} ${work.subjects.join(" ")}`;
        return lexicalScore(expandedSearchTokens(query).join(" "), haystack) > 0;
      })
      .length;
    const chunks = await this.getRelevantChunks(query, undefined, Math.min(250, this.chunks.length), undefined, filters);
    const chunkMatchEstimate = chunks.length;
    const chunkWorkEstimate = new Set(chunks.map((chunk) => chunk.workId)).size;
    return buildResearchScopeEstimate(query, metadataWorkEstimate, chunkMatchEstimate, chunkWorkEstimate, probeWorks);
  }

  async getWorkById(workId: string): Promise<WorkDetailRecord | null> {
    const work = this.works.find((candidate) => candidate.id === workId);
    if (!work) {
      return null;
    }
    return {
      id: work.id,
      gutenbergId: work.gutenbergId ?? null,
      title: work.title,
      language: work.language ?? null,
      releaseDate: work.releaseDate ?? null,
      rightsStatus: work.rightsStatus ?? null,
      summary: work.summary ?? null,
      authors: work.authors ?? [],
      subjects: work.subjects ?? [],
      metadata: work.metadata ?? {},
    };
  }

  async searchWorks(query: string, filters: Record<string, unknown> = {}): Promise<WorkSummary[]> {
    const limit = typeof filters.limit === "number"
      ? Math.max(1, Math.min(20, Math.trunc(filters.limit)))
      : 20;
    const lexicalQuery = expandedSearchTokens(query).join(" ");
    return [...this.works]
      .filter((work) => workMatchesSearchFilters(work, filters))
      .map((work) => ({
        ...work,
        score: lexicalScore(
          lexicalQuery,
          `${work.title} ${work.summary ?? ""} ${work.authors.join(" ")} ${work.subjects.join(" ")} ${JSON.stringify(work.metadata ?? {})}`,
        ),
      }))
      .filter((work) => (work.score ?? 0) > 0)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, limit)
      .map((work) => toWorkSummary(work));
  }

  async getWorkMetadata(workIds: string[]): Promise<WorkSummary[]> {
    const set = new Set(workIds);
    return this.works.filter((work) => set.has(work.id)).map((work) => toWorkSummary(work));
  }

  async getRelevantChunks(
    query: string,
    workIds?: string[],
    limit = 8,
    embedding?: number[],
    filters: PassageSearchFilters = {},
  ): Promise<ChunkSearchResult[]> {
    const hasWorkScope = Boolean(workIds?.length)
      || Boolean(filters.language)
      || Boolean(filters.rightsStatus)
      || Boolean(filters.yearRange)
      || Boolean(filters.genre?.length);
    const allowedWorkIds = hasWorkScope
      ? new Set(
        this.works
          .filter((work) => {
          if (workIds?.length && !workIds.includes(work.id)) {
            return false;
          }
          if (filters.language && work.language !== filters.language) {
            return false;
          }
          if (filters.rightsStatus && work.rightsStatus !== filters.rightsStatus) {
            return false;
          }
          if (filters.yearRange) {
            const [startYear, endYear] = filters.yearRange;
            const year = typeof work.releaseDate === "string"
              ? Number.parseInt(work.releaseDate.slice(0, 4), 10)
              : Number.NaN;
            if (!Number.isFinite(year) || year < startYear || year > endYear) {
              return false;
            }
          }
          if (filters.genre?.length) {
            const haystack = [
              work.title,
              work.summary ?? "",
              work.language ?? "",
              ...work.subjects,
              JSON.stringify(work.metadata ?? {}),
            ].join(" ").toLowerCase();
            if (!filters.genre.some((genre) => textMatchesGenre(haystack, genre))) {
              return false;
            }
          }
          return true;
          })
          .map((work) => work.id),
      )
      : null;
    const lexicalQuery = expandedSearchTokens(query).join(" ");
    const rankedRows = this.chunks
      .filter((chunk) => !allowedWorkIds || allowedWorkIds.has(chunk.workId))
      .map((chunk) => ({
        ...chunk,
        score:
          lexicalScore(lexicalQuery, chunk.text) +
          (embedding && chunk.embedding ? cosineSimilarity(embedding, chunk.embedding) : 0),
        excerpt: excerpt(chunk.text, lexicalQuery || query),
      }))
      .filter((chunk) => chunk.score > 0)
      .sort((left, right) => right.score - left.score);
    return diversifyChunkResults(query, workIds, rankedRows, limit);
  }

  async getWorkTextFile(workId: string): Promise<WorkTextRecord | null> {
    const work = this.works.find((candidate) => candidate.id === workId);
    return work ? { workId, r2Key: work.cleanTextKey ?? null } : null;
  }

  async getWorkFiles(workIds: string[], kinds?: WorkFileKind[]): Promise<WorkFileRecord[]> {
    const wantedKinds = kinds?.length ? new Set(kinds) : null;
    return this.works
      .filter((work) => workIds.includes(work.id))
      .flatMap((work) => {
        const records: WorkFileRecord[] = [];
        if ((!wantedKinds || wantedKinds.has("clean")) && work.cleanTextKey) {
          records.push({
            id: `${work.id}-clean`,
            workId: work.id,
            kind: "clean",
            r2Key: work.cleanTextKey,
            byteSize: work.text?.length ?? null,
            metadata: {},
          });
        }
        const rawKey = (work.metadata as Record<string, unknown> | undefined)?.rawKey;
        if ((!wantedKinds || wantedKinds.has("raw")) && typeof rawKey === "string") {
          records.push({
            id: `${work.id}-raw`,
            workId: work.id,
            kind: "raw",
            r2Key: rawKey,
            byteSize: null,
            metadata: {},
          });
        }
        const chunksKey =
          work.chunksKey ??
          this.chunks.find((chunk) => chunk.workId === work.id && chunk.r2Key)?.r2Key ??
          null;
        if ((!wantedKinds || wantedKinds.has("chunks")) && chunksKey) {
          records.push({
            id: `${work.id}-chunks`,
            workId: work.id,
            kind: "chunks",
            r2Key: chunksKey,
            byteSize: null,
            metadata: {},
          });
        }
        return records;
      });
  }

  async getChunksByIds(chunkIds: string[]): Promise<ChunkSearchResult[]> {
    const set = new Set(chunkIds);
    return this.chunks.filter((chunk) => set.has(chunk.id));
  }

  async getChunkByWorkAndIndex(workId: string, chunkIndex: number): Promise<ChunkSearchResult | null> {
    return this.chunks.find((chunk) => chunk.workId === workId && chunk.chunkIndex === chunkIndex) ?? null;
  }

  async listRuntimeInstances(sessionId: string): Promise<RuntimeInstanceRecord[]> {
    return [...this.runtimeInstances.values()]
      .filter((instance) => instance.sessionId === sessionId)
      .sort((left, right) => {
        const leftValue = left.lastUsedAt ?? left.createdAt;
        const rightValue = right.lastUsedAt ?? right.createdAt;
        return rightValue.localeCompare(leftValue);
      });
  }

  async listExpiredRuntimeInstances(limit = 50): Promise<RuntimeInstanceRecord[]> {
    return [...this.runtimeInstances.values()]
      .filter((instance) =>
        instance.status !== "destroyed" &&
        instance.status !== "expired" &&
        instance.expiresAt !== null &&
        Date.parse(instance.expiresAt) <= Date.now(),
      )
      .sort((left, right) => {
        const leftValue = left.expiresAt ?? left.lastUsedAt ?? left.createdAt;
        const rightValue = right.expiresAt ?? right.lastUsedAt ?? right.createdAt;
        return leftValue.localeCompare(rightValue);
      })
      .slice(0, Math.max(0, limit));
  }

  async getRuntimeInstance(runtimeId: string): Promise<RuntimeInstanceRecord | null> {
    return this.runtimeInstances.get(runtimeId) ?? null;
  }

  async saveRuntimeInstance(
    input: Omit<RuntimeInstanceRecord, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<RuntimeInstanceRecord> {
    const existing = this.runtimeInstances.get(input.runtimeId);
    const record: RuntimeInstanceRecord = {
      id: input.id ?? existing?.id ?? crypto.randomUUID(),
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      provider: input.provider,
      providerMachineId: input.providerMachineId,
      status: input.status,
      manifestJson: input.manifestJson,
      lastUsedAt: input.lastUsedAt,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt ?? existing?.createdAt ?? nowIso(),
    };
    this.runtimeInstances.set(record.runtimeId, record);
    return record;
  }

  async updateRuntimeInstance(
    runtimeId: string,
    updates: Partial<Pick<RuntimeInstanceRecord, "status" | "manifestJson" | "lastUsedAt" | "expiresAt" | "providerMachineId">>,
  ): Promise<void> {
    const existing = this.runtimeInstances.get(runtimeId);
    if (!existing) {
      return;
    }
    const next: RuntimeInstanceRecord = {
      ...existing,
      ...updates,
    };
    this.runtimeInstances.set(runtimeId, next);
  }

  async saveArtifact(
    input: Omit<ArtifactRecord, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<ArtifactRecord> {
    const existing = [...this.artifacts.values()].find((artifact) => artifact.r2Key === input.r2Key);
    const record: ArtifactRecord = {
      id: input.id ?? existing?.id ?? crypto.randomUUID(),
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      r2Key: input.r2Key,
      filename: input.filename,
      mimeType: input.mimeType,
      metadata: input.metadata,
      createdAt: input.createdAt ?? existing?.createdAt ?? nowIso(),
    };
    this.artifacts.set(record.r2Key, record);
    return record;
  }

  async listArtifacts(sessionId: string, runtimeId?: string | null): Promise<ArtifactRecord[]> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.sessionId === sessionId && (runtimeId === undefined || artifact.runtimeId === runtimeId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createBillingEvent(
    input: Omit<BillingEventRecord, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<BillingEventRecord> {
    const record: BillingEventRecord = {
      id: input.id ?? crypto.randomUUID(),
      userId: input.userId,
      sessionId: input.sessionId,
      runId: input.runId,
      source: input.source,
      provider: input.provider,
      model: input.model,
      operation: input.operation,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      cachedInputTokens: input.cachedInputTokens,
      costUsd: input.costUsd,
      requestId: input.requestId,
      requestJson: input.requestJson,
      responseJson: input.responseJson,
      metadata: input.metadata,
      createdAt: input.createdAt ?? nowIso(),
    };
    this.billingEvents.set(record.id, record);
    return record;
  }

  async getBillingSpend(userId: string, since: string): Promise<BillingSpendSummary> {
    const sinceMs = Date.parse(since);
    const events = [...this.billingEvents.values()].filter((event) =>
      event.userId === userId && Date.parse(event.createdAt) >= sinceMs,
    );
    return {
      totalCostUsd: Math.round(events.reduce((total, event) => total + event.costUsd, 0) * 1_000_000) / 1_000_000,
      eventCount: events.length,
    };
  }

  async healthCheck(): Promise<"ok" | "error"> {
    return "ok";
  }

  private toAgentIdentityRecord(record: AgentIdentityRecord & { apiKeyHash: string }): AgentIdentityRecord {
    return {
      id: record.id,
      userId: record.userId,
      ownerUserId: record.ownerUserId,
      name: record.name,
      description: record.description,
      apiKeyPrefix: record.apiKeyPrefix,
      status: record.status,
      verificationCode: record.verificationCode,
      claimToken: record.claimToken,
      lastUsedAt: record.lastUsedAt,
      createdAt: record.createdAt,
      claimedAt: record.claimedAt,
      metadata: record.metadata,
    };
  }

  private countFollowers(userId: string): number {
    let count = 0;
    for (const key of this.follows) {
      if (key.endsWith(`:${userId}`)) {
        count += 1;
      }
    }
    return count;
  }

  private countFollowing(userId: string): number {
    let count = 0;
    for (const key of this.follows) {
      if (key.startsWith(`${userId}:`)) {
        count += 1;
      }
    }
    return count;
  }
}

export class NeonAppStore implements AppStore {
  private analyticsSchemaReady: Promise<void> | null = null;

  constructor(private readonly db: DbClient) {}

  private ensureAnalyticsSchema() {
    if (!this.analyticsSchemaReady) {
      this.analyticsSchemaReady = this.db.query(
        `
          CREATE TABLE IF NOT EXISTS analytics_events (
            id uuid PRIMARY KEY,
            event text NOT NULL,
            user_id text REFERENCES users(id) ON DELETE SET NULL,
            session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
            properties_json jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_analytics_events_event_created_at ON analytics_events(event, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_analytics_events_session_id ON analytics_events(session_id);
        `,
      ).then(() => {});
    }
    return this.analyticsSchemaReady;
  }

  async ensureUser(userId: string): Promise<void> {
    await this.db.query(
      `
        INSERT INTO users (id, name)
        VALUES ($1, $2)
        ON CONFLICT (id) DO NOTHING
      `,
      [userId, "AlphaBook User"],
    );
  }

  async upsertUserProfile(input: {
    id: string;
    email?: string | null;
    name?: string | null;
    avatarUrl?: string | null;
  }): Promise<UserRecord> {
    const existingByEmail = input.email
      ? await this.db.query<{
        id: string;
      }>(
        `
          SELECT id
          FROM users
          WHERE email = $1
          LIMIT 1
        `,
        [input.email],
      )
      : null;
    const canonicalId = existingByEmail?.rows[0]?.id ?? input.id;
    const params = [canonicalId, input.email ?? null, input.name ?? null, input.avatarUrl ?? null];
    const existingById = await this.db.query<{
      id: string;
      email: string | null;
      name: string | null;
      avatar_url: string | null;
      created_at: string;
    }>(
      `
        UPDATE users
        SET
          email = COALESCE($2, email),
          name = COALESCE($3, name),
          avatar_url = COALESCE($4, avatar_url)
        WHERE id = $1
        RETURNING id, email, name, avatar_url, created_at
      `,
      params,
    );
    const matchedIdRow = existingById.rows[0];
    if (matchedIdRow) {
      return {
        id: matchedIdRow.id,
        email: matchedIdRow.email,
        handle: deriveUserHandle({ email: matchedIdRow.email, name: matchedIdRow.name, id: matchedIdRow.id }),
        name: matchedIdRow.name,
        avatarUrl: matchedIdRow.avatar_url,
        createdAt: matchedIdRow.created_at,
        followersCount: 0,
        followingCount: 0,
      };
    }

    const result = await this.db.query<{
      id: string;
      email: string | null;
      name: string | null;
      avatar_url: string | null;
      created_at: string;
    }>(
      `
        INSERT INTO users (id, email, name, avatar_url)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE
        SET
          email = EXCLUDED.email,
          name = EXCLUDED.name,
          avatar_url = EXCLUDED.avatar_url
        RETURNING id, email, name, avatar_url, created_at
      `,
      params,
    );
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      handle: deriveUserHandle({ email: row.email, name: row.name, id: row.id }),
      name: row.name,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at,
      followersCount: 0,
      followingCount: 0,
    };
  }

  async getUserProfile(userId: string): Promise<UserRecord | null> {
    const result = await this.db.query<{
      id: string;
      email: string | null;
      name: string | null;
      avatar_url: string | null;
      created_at: string;
      followers_count: number;
      following_count: number;
    }>(
      `
        SELECT
          u.id,
          u.email,
          u.name,
          u.avatar_url,
          u.created_at,
          COALESCE(followers.count, 0) AS followers_count,
          COALESCE(following.count, 0) AS following_count
        FROM users u
        LEFT JOIN (
          SELECT followed_id, COUNT(*)::int AS count
          FROM user_follows
          GROUP BY followed_id
        ) AS followers ON followers.followed_id = u.id
        LEFT JOIN (
          SELECT follower_id, COUNT(*)::int AS count
          FROM user_follows
          GROUP BY follower_id
        ) AS following ON following.follower_id = u.id
        WHERE u.id = $1
        LIMIT 1
      `,
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      email: row.email,
      handle: deriveUserHandle({ email: row.email, name: row.name, id: row.id }),
      name: row.name,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at,
      followersCount: Number(row.followers_count ?? 0),
      followingCount: Number(row.following_count ?? 0),
    };
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
    await this.db.query(
      `
        INSERT INTO users (id, name)
        VALUES ($1, $2)
        ON CONFLICT (id) DO NOTHING
      `,
      [userId, input.name],
    );
    if (input.ownerUserId) {
      await this.ensureUser(input.ownerUserId);
    }
    const result = await this.db.query<AgentIdentityRow>(
      `
        INSERT INTO agent_identities (
          id,
          user_id,
          owner_user_id,
          name,
          description,
          api_key_prefix,
          api_key_hash,
          status,
          verification_code,
          claim_token,
          metadata_json,
          created_at,
          claimed_at
        )
        VALUES (
          $1::uuid,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11::jsonb,
          $12::timestamptz,
          $13::timestamptz
        )
        RETURNING
          id,
          user_id,
          owner_user_id,
          name,
          description,
          api_key_prefix,
          status,
          verification_code,
          claim_token,
          last_used_at,
          created_at,
          claimed_at,
          metadata_json
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
        createdAt,
        input.ownerUserId ? createdAt : null,
      ],
    );
    return mapAgentIdentityRow(result.rows[0]);
  }

  async authenticateAgentApiKey(apiKeyHash: string): Promise<AgentIdentityRecord | null> {
    const result = await this.db.query<AgentIdentityRow>(
      `
        UPDATE agent_identities
        SET last_used_at = now()
        WHERE api_key_hash = $1
          AND status <> 'revoked'
        RETURNING
          id,
          user_id,
          owner_user_id,
          name,
          description,
          api_key_prefix,
          status,
          verification_code,
          claim_token,
          last_used_at,
          created_at,
          claimed_at,
          metadata_json
      `,
      [apiKeyHash],
    );
    const row = result.rows[0];
    return row ? mapAgentIdentityRow(row) : null;
  }

  async getAgentIdentityByUserId(userId: string): Promise<AgentIdentityRecord | null> {
    const result = await this.db.query<AgentIdentityRow>(
      `
        SELECT
          id,
          user_id,
          owner_user_id,
          name,
          description,
          api_key_prefix,
          status,
          verification_code,
          claim_token,
          last_used_at,
          created_at,
          claimed_at,
          metadata_json
        FROM agent_identities
        WHERE user_id = $1
        LIMIT 1
      `,
      [userId],
    );
    const row = result.rows[0];
    return row ? mapAgentIdentityRow(row) : null;
  }

  async getAgentIdentityByClaimToken(claimToken: string): Promise<AgentIdentityRecord | null> {
    const result = await this.db.query<AgentIdentityRow>(
      `
        SELECT
          id,
          user_id,
          owner_user_id,
          name,
          description,
          api_key_prefix,
          status,
          verification_code,
          claim_token,
          last_used_at,
          created_at,
          claimed_at,
          metadata_json
        FROM agent_identities
        WHERE claim_token = $1
        LIMIT 1
      `,
      [claimToken],
    );
    const row = result.rows[0];
    return row ? mapAgentIdentityRow(row) : null;
  }

  async claimAgentIdentity(claimToken: string, ownerUserId: string): Promise<AgentIdentityRecord | null> {
    await this.ensureUser(ownerUserId);
    const result = await this.db.query<AgentIdentityRow>(
      `
        UPDATE agent_identities
        SET
          owner_user_id = $2,
          status = 'active',
          claimed_at = COALESCE(claimed_at, now())
        WHERE claim_token = $1
          AND status <> 'revoked'
        RETURNING
          id,
          user_id,
          owner_user_id,
          name,
          description,
          api_key_prefix,
          status,
          verification_code,
          claim_token,
          last_used_at,
          created_at,
          claimed_at,
          metadata_json
      `,
      [claimToken, ownerUserId],
    );
    const row = result.rows[0];
    return row ? mapAgentIdentityRow(row) : null;
  }

  async listAgentIdentitiesByOwner(ownerUserId: string): Promise<AgentIdentityRecord[]> {
    const result = await this.db.query<AgentIdentityRow>(
      `
        SELECT
          id,
          user_id,
          owner_user_id,
          name,
          description,
          api_key_prefix,
          status,
          verification_code,
          claim_token,
          last_used_at,
          created_at,
          claimed_at,
          metadata_json
        FROM agent_identities
        WHERE owner_user_id = $1
        ORDER BY created_at DESC
      `,
      [ownerUserId],
    );
    return result.rows.map((row) => mapAgentIdentityRow(row));
  }

  async listUsers(): Promise<AdminUserRecord[]> {
    await this.ensureAnalyticsSchema();
    const result = await this.db.query<{
      id: string;
      email: string | null;
      name: string | null;
      avatar_url: string | null;
      created_at: string;
      session_count: number;
      run_count: number;
      last_seen_at: string | null;
      monthly_spend_usd: string | number | null;
      total_spend_usd: string | number | null;
      billing_event_count: number;
    }>(
      `
        SELECT
          u.id,
          u.email,
          u.name,
          u.avatar_url,
          u.created_at,
          COALESCE(session_counts.session_count, 0) AS session_count,
          COALESCE(run_counts.run_count, 0) AS run_count,
          last_seen.last_seen_at,
          COALESCE(billing_monthly.monthly_spend_usd, 0) AS monthly_spend_usd,
          COALESCE(billing_total.total_spend_usd, 0) AS total_spend_usd,
          COALESCE(billing_total.billing_event_count, 0) AS billing_event_count
        FROM users u
        LEFT JOIN (
          SELECT user_id, COUNT(*)::int AS session_count
          FROM chat_sessions
          GROUP BY user_id
        ) AS session_counts ON session_counts.user_id = u.id
        LEFT JOIN (
          SELECT cs.user_id, COUNT(r.id)::int AS run_count
          FROM chat_sessions cs
          LEFT JOIN runs r ON r.session_id = cs.id
          GROUP BY cs.user_id
        ) AS run_counts ON run_counts.user_id = u.id
        LEFT JOIN (
          SELECT cs.user_id, MAX(m.created_at)::timestamptz AS last_seen_at
          FROM chat_sessions cs
          LEFT JOIN messages m ON m.session_id = cs.id
          GROUP BY cs.user_id
        ) AS last_seen ON last_seen.user_id = u.id
        LEFT JOIN (
          SELECT
            user_id,
            SUM(cost_usd) AS monthly_spend_usd
          FROM billing_events
          WHERE created_at >= now() - interval '30 days'
          GROUP BY user_id
        ) AS billing_monthly ON billing_monthly.user_id = u.id
        LEFT JOIN (
          SELECT
            user_id,
            SUM(cost_usd) AS total_spend_usd,
            COUNT(*)::int AS billing_event_count
          FROM billing_events
          GROUP BY user_id
        ) AS billing_total ON billing_total.user_id = u.id
        ORDER BY COALESCE(last_seen.last_seen_at, u.created_at::timestamptz) DESC, u.created_at DESC
      `,
    );
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      handle: deriveUserHandle({ email: row.email, name: row.name, id: row.id }),
      name: row.name,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at,
      followersCount: 0,
      followingCount: 0,
      sessionCount: Number(row.session_count ?? 0),
      runCount: Number(row.run_count ?? 0),
      lastSeenAt: row.last_seen_at,
      monthlySpendUsd: Number(row.monthly_spend_usd ?? 0),
      totalSpendUsd: Number(row.total_spend_usd ?? 0),
      billingEventCount: Number(row.billing_event_count ?? 0),
    }));
  }

  async followUser(followerId: string, followedId: string): Promise<void> {
    if (followerId === followedId) {
      return;
    }
    await this.ensureUser(followerId);
    await this.ensureUser(followedId);
    await this.db.query(
      `
        INSERT INTO user_follows (follower_id, followed_id)
        VALUES ($1, $2)
        ON CONFLICT (follower_id, followed_id) DO NOTHING
      `,
      [followerId, followedId],
    );
  }

  async unfollowUser(followerId: string, followedId: string): Promise<void> {
    await this.db.query(
      `
        DELETE FROM user_follows
        WHERE follower_id = $1 AND followed_id = $2
      `,
      [followerId, followedId],
    );
  }

  async isFollowing(followerId: string, followedId: string): Promise<boolean> {
    const result = await this.db.query<{ following: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM user_follows
          WHERE follower_id = $1 AND followed_id = $2
        ) AS following
      `,
      [followerId, followedId],
    );
    return Boolean(result.rows[0]?.following);
  }

  async createSession(userId: string, title?: string): Promise<SessionRecord> {
    const sessionId = crypto.randomUUID();
    const createdAt = nowIso();
    await this.db.query(
      `
        INSERT INTO chat_sessions (id, user_id, title, created_at)
        VALUES ($1::uuid, $2, $3, $4::timestamptz)
      `,
      [sessionId, userId, title ?? null, createdAt],
    );
    return {
      id: sessionId,
      userId,
      title: title ?? null,
      createdAt,
    };
  }

  async updateSessionTitle(sessionId: string, title: string | null): Promise<void> {
    await this.db.query(
      `
        UPDATE chat_sessions
        SET title = $2
        WHERE id = $1::uuid
      `,
      [sessionId, title],
    );
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.db.query<{
      id: string;
      user_id: string;
      title: string | null;
      created_at: string;
    }>(
      `SELECT id, user_id, title, created_at FROM chat_sessions WHERE id = $1::uuid LIMIT 1`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      createdAt: row.created_at,
    };
  }

  async listSessions(userId: string): Promise<SessionSummaryRecord[]> {
    const result = await this.db.query<{
      id: string;
      user_id: string;
      title: string | null;
      created_at: string;
      last_message_at: string | null;
      last_message_preview: string | null;
    }>(
      `
        SELECT
          cs.id,
          cs.user_id,
          cs.title,
          cs.created_at,
          MAX(m.created_at)::text AS last_message_at,
          (
            ARRAY_AGG(m.content ORDER BY m.created_at DESC)
            FILTER (WHERE m.id IS NOT NULL)
          )[1] AS last_message_preview
        FROM chat_sessions cs
        LEFT JOIN messages m ON m.session_id = cs.id
        WHERE cs.user_id = $1
        GROUP BY cs.id
        ORDER BY COALESCE(MAX(m.created_at), cs.created_at) DESC
      `,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      title: row.title,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      lastMessagePreview: row.last_message_preview?.slice(0, 120) ?? null,
    }));
  }

  async listAdminSessions(): Promise<AdminSessionRecord[]> {
    const result = await this.db.query<{
      id: string;
      user_id: string;
      title: string | null;
      created_at: string;
      user_email: string | null;
      user_name: string | null;
      run_count: number;
      message_count: number;
      last_message_at: string | null;
      last_message_preview: string | null;
      spend_usd: string | number | null;
    }>(
      `
        SELECT
          cs.id,
          cs.user_id,
          cs.title,
          cs.created_at,
          u.email AS user_email,
          u.name AS user_name,
          COALESCE(run_counts.run_count, 0) AS run_count,
          COALESCE(message_counts.message_count, 0) AS message_count,
          message_counts.last_message_at,
          message_counts.last_message_preview,
          COALESCE(billing.spend_usd, 0) AS spend_usd
        FROM chat_sessions cs
        LEFT JOIN users u ON u.id = cs.user_id
        LEFT JOIN (
          SELECT session_id, COUNT(*)::int AS run_count
          FROM runs
          GROUP BY session_id
        ) AS run_counts ON run_counts.session_id = cs.id
        LEFT JOIN (
          SELECT
            session_id,
            COUNT(*)::int AS message_count,
            MAX(created_at)::text AS last_message_at,
            (ARRAY_AGG(content ORDER BY created_at DESC))[1] AS last_message_preview
          FROM messages
          GROUP BY session_id
        ) AS message_counts ON message_counts.session_id = cs.id
        LEFT JOIN (
          SELECT session_id, SUM(cost_usd) AS spend_usd
          FROM billing_events
          WHERE session_id IS NOT NULL
          GROUP BY session_id
        ) AS billing ON billing.session_id = cs.id
        ORDER BY COALESCE(message_counts.last_message_at, cs.created_at::text) DESC, cs.created_at DESC
      `,
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      title: row.title,
      createdAt: row.created_at,
      userEmail: row.user_email,
      userName: row.user_name,
      runCount: Number(row.run_count ?? 0),
      messageCount: Number(row.message_count ?? 0),
      lastMessageAt: row.last_message_at,
      lastMessagePreview: row.last_message_preview?.slice(0, 160) ?? null,
      spendUsd: Number(row.spend_usd ?? 0),
    }));
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      role: MessageRecord["role"];
      content: string;
      metadata_json: Record<string, unknown>;
      created_at: string;
    }>(
      `
        SELECT id, session_id, role, content, metadata_json, created_at
        FROM messages
        WHERE session_id = $1::uuid
        ORDER BY created_at ASC
      `,
      [sessionId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      metadata: row.metadata_json,
      createdAt: row.created_at,
    }));
  }

  async appendMessage(
    sessionId: string,
    role: MessageRecord["role"],
    content: string,
    metadata: Record<string, unknown> = {},
  ): Promise<MessageRecord> {
    const messageId = crypto.randomUUID();
    const createdAt = nowIso();
    await this.db.query(
      `
        INSERT INTO messages (id, session_id, role, content, metadata_json, created_at)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::timestamptz)
      `,
      [messageId, sessionId, role, content, JSON.stringify(metadata), createdAt],
    );
    return {
      id: messageId,
      sessionId,
      role,
      content,
      metadata,
      createdAt,
    };
  }

  async updateMessageMetadata(messageId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `
        UPDATE messages
        SET metadata_json = $2::jsonb
        WHERE id = $1::uuid
      `,
      [messageId, JSON.stringify(metadata)],
    );
  }

  async createRun(sessionId: string): Promise<RunRecord> {
    const runId = crypto.randomUUID();
    const startedAt = nowIso();
    await this.db.query(
      `
        INSERT INTO runs (id, session_id, status, started_at, planner_turns)
        VALUES ($1::uuid, $2::uuid, 'running', $3::timestamptz, 0)
      `,
      [runId, sessionId, startedAt],
    );
    return {
      id: runId,
      sessionId,
      status: "running",
      plannerTurns: 0,
      startedAt,
      completedAt: null,
    };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      status: RunRecord["status"];
      planner_turns: number;
      started_at: string;
      completed_at: string | null;
    }>(
      `
        SELECT id, session_id, status, planner_turns, started_at, completed_at
        FROM runs
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [runId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          sessionId: row.session_id,
          status: row.status,
          plannerTurns: row.planner_turns,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        }
      : null;
  }

  async listRuns(sessionId: string): Promise<RunRecord[]> {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      status: RunRecord["status"];
      planner_turns: number;
      started_at: string;
      completed_at: string | null;
    }>(
      `
        SELECT id, session_id, status, planner_turns, started_at, completed_at
        FROM runs
        WHERE session_id = $1::uuid
        ORDER BY started_at DESC
      `,
      [sessionId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      status: row.status,
      plannerTurns: row.planner_turns,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }));
  }

  async listAllRuns(): Promise<AdminRunRecord[]> {
    await this.ensureAnalyticsSchema();
    const result = await this.db.query<{
      id: string;
      session_id: string;
      status: RunRecord["status"];
      planner_turns: number;
      started_at: string;
      completed_at: string | null;
      user_id: string;
      user_email: string | null;
      user_name: string | null;
      session_title: string | null;
      tool_call_count: number;
      message_count: number;
      last_message_preview: string | null;
      spend_usd: string | number | null;
    }>(
      `
        SELECT
          r.id,
          r.session_id,
          r.status,
          r.planner_turns,
          r.started_at,
          r.completed_at,
          cs.user_id,
          u.email AS user_email,
          u.name AS user_name,
          cs.title AS session_title,
          COALESCE(tool_counts.tool_call_count, 0) AS tool_call_count,
          COALESCE(message_counts.message_count, 0) AS message_count,
          message_counts.last_message_preview,
          COALESCE(billing.spend_usd, 0) AS spend_usd
        FROM runs r
        JOIN chat_sessions cs ON cs.id = r.session_id
        LEFT JOIN users u ON u.id = cs.user_id
        LEFT JOIN (
          SELECT run_id, COUNT(*)::int AS tool_call_count
          FROM tool_calls
          GROUP BY run_id
        ) AS tool_counts ON tool_counts.run_id = r.id
        LEFT JOIN (
          SELECT
            session_id,
            COUNT(*)::int AS message_count,
            (ARRAY_AGG(content ORDER BY created_at DESC))[1] AS last_message_preview
          FROM messages
          GROUP BY session_id
        ) AS message_counts ON message_counts.session_id = r.session_id
        LEFT JOIN (
          SELECT run_id, SUM(cost_usd) AS spend_usd
          FROM billing_events
          WHERE run_id IS NOT NULL
          GROUP BY run_id
        ) AS billing ON billing.run_id = r.id
        ORDER BY r.started_at DESC
      `,
    );
    return result.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      status: row.status,
      plannerTurns: Number(row.planner_turns ?? 0),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      userId: row.user_id,
      userEmail: row.user_email,
      userName: row.user_name,
      sessionTitle: row.session_title,
      toolCallCount: Number(row.tool_call_count ?? 0),
      messageCount: Number(row.message_count ?? 0),
      lastMessagePreview: row.last_message_preview?.slice(0, 160) ?? null,
      spendUsd: Number(row.spend_usd ?? 0),
    }));
  }

  async saveAnalyticsEvent(input: {
    event: string;
    userId?: string | null;
    sessionId?: string | null;
    properties?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<AnalyticsEventRecord> {
    await this.ensureAnalyticsSchema();
    const id = crypto.randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    await this.db.query(
      `
        INSERT INTO analytics_events (id, event, user_id, session_id, properties_json, created_at)
        VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, $6::timestamptz)
      `,
      [
        id,
        input.event,
        input.userId ?? null,
        input.sessionId ?? null,
        JSON.stringify(input.properties ?? {}),
        createdAt,
      ],
    );
    return {
      id,
      event: input.event,
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      properties: input.properties ?? {},
      createdAt,
    };
  }

  async listAnalyticsEvents(options: { since?: string; limit?: number } = {}): Promise<AnalyticsEventRecord[]> {
    await this.ensureAnalyticsSchema();
    const result = await this.db.query<{
      id: string;
      event: string;
      user_id: string | null;
      session_id: string | null;
      properties_json: Record<string, unknown>;
      created_at: string;
    }>(
      `
        SELECT id, event, user_id, session_id, properties_json, created_at
        FROM analytics_events
        WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [options.since ?? null, options.limit ?? 500],
    );
    return result.rows.map((row) => ({
      id: row.id,
      event: row.event,
      userId: row.user_id,
      sessionId: row.session_id,
      properties: row.properties_json ?? {},
      createdAt: row.created_at,
    }));
  }

  async listUserMessages(options: { since?: string; limit?: number } = {}) {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      user_id: string;
      content: string;
      created_at: string;
    }>(
      `
        SELECT m.id, m.session_id, cs.user_id, m.content, m.created_at
        FROM messages m
        JOIN chat_sessions cs ON cs.id = m.session_id
        WHERE m.role = 'user'
          AND ($1::timestamptz IS NULL OR m.created_at >= $1::timestamptz)
        ORDER BY m.created_at DESC
        LIMIT $2
      `,
      [options.since ?? null, options.limit ?? 500],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      userId: row.user_id,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  async updateRun(runId: string, updates: Partial<Pick<RunRecord, "status" | "plannerTurns" | "completedAt">>): Promise<void> {
    await this.db.query(
      `
        UPDATE runs
        SET
          status = COALESCE($2, status),
          planner_turns = COALESCE($3, planner_turns),
          completed_at = COALESCE($4::timestamptz, completed_at)
        WHERE id = $1::uuid
      `,
      [runId, updates.status ?? null, updates.plannerTurns ?? null, updates.completedAt ?? null],
    );
  }

  async startToolCall(runId: string, toolName: ToolName, argsJson: Record<string, unknown>): Promise<ToolCallRecord> {
    const toolCallId = crypto.randomUUID();
    const startedAt = nowIso();
    await this.db.query(
      `
        INSERT INTO tool_calls (id, run_id, tool_name, args_json, status, started_at)
        VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, 'running', $5::timestamptz)
      `,
      [toolCallId, runId, toolName, JSON.stringify(argsJson), startedAt],
    );
    return {
      id: toolCallId,
      runId,
      toolName,
      argsJson,
      resultJson: null,
      status: "running",
      startedAt,
      completedAt: null,
    };
  }

  async finishToolCall(toolCallId: string, status: ToolCallRecord["status"], resultJson: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `
        UPDATE tool_calls
        SET
          status = $2,
          result_json = $3::jsonb,
          completed_at = now()
        WHERE id = $1::uuid
      `,
      [toolCallId, status, JSON.stringify(resultJson)],
    );
  }

  async listToolCalls(runId: string): Promise<ToolCallRecord[]> {
    const result = await this.db.query<{
      id: string;
      run_id: string;
      tool_name: ToolName;
      args_json: Record<string, unknown>;
      result_json: Record<string, unknown> | null;
      status: ToolCallRecord["status"];
      started_at: string;
      completed_at: string | null;
    }>(
      `
        SELECT id, run_id, tool_name, args_json, result_json, status, started_at, completed_at
        FROM tool_calls
        WHERE run_id = $1::uuid
        ORDER BY started_at ASC
      `,
      [runId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      toolName: row.tool_name,
      argsJson: row.args_json,
      resultJson: row.result_json,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }));
  }

  async listWorks(offset = 0, limit = 12): Promise<WorkSummary[]> {
    await this.ensureAnalyticsSchema();
    const result = await this.db.query<{
      id: string;
      gutenberg_id: number | string | null;
      title: string;
      metadata_json: Record<string, unknown>;
      language: string | null;
      release_date: string | null;
      rights_status: string | null;
      summary: string | null;
      authors: string[];
      subjects: string[];
      score: number;
      feed_label: string | null;
    }>(
      `
        WITH engagement AS (
          SELECT
            properties_json->>'workId' AS work_id,
            COUNT(*) FILTER (WHERE created_at >= now() - interval '3 days')::int AS opens_3d,
            COUNT(*) FILTER (WHERE created_at >= now() - interval '14 days')::int AS opens_14d,
            MAX(created_at) AS last_opened_at
          FROM analytics_events
          WHERE event = 'book_open' AND properties_json ? 'workId'
          GROUP BY properties_json->>'workId'
        )
        SELECT
          w.id,
          w.gutenberg_id,
          w.title,
          w.metadata_json,
          w.language,
          w.release_date::text,
          w.rights_status,
          w.summary,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.name), NULL) AS authors,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.label), NULL) AS subjects,
          (
            COALESCE(e.opens_3d, 0) * 5.0
            + COALESCE(e.opens_14d, 0) * 1.8
            + CASE
                WHEN e.last_opened_at >= now() - interval '1 day' THEN 2.4
                WHEN e.last_opened_at >= now() - interval '7 days' THEN 1.2
                ELSE 0
              END
            + CASE
                WHEN COALESCE(w.summary, '') <> '' THEN 0.9
                ELSE 0
              END
            + CASE
                WHEN COALESCE(w.metadata_json->>'coverImageKey', w.metadata_json->>'coverImageUrl', w.metadata_json->>'coverUrl', w.metadata_json->>'imageUrl', w.metadata_json->>'thumbnailUrl') IS NOT NULL THEN 0.85
                ELSE 0
              END
            + CASE
                WHEN COALESCE(jsonb_typeof(w.metadata_json->'bookshelves'), '') = 'array' THEN LEAST(jsonb_array_length(w.metadata_json->'bookshelves'), 3) * 0.2
                ELSE 0
              END
            + CASE
                WHEN EXISTS (SELECT 1 FROM work_authors wa_check WHERE wa_check.work_id = w.id) THEN 0.3
                ELSE 0
              END
          ) AS score,
          CASE
            WHEN COALESCE(e.opens_3d, 0) >= 4 THEN 'Trending now'
            WHEN COALESCE(e.opens_14d, 0) >= 2 THEN 'Readers are revisiting this'
            WHEN e.last_opened_at >= now() - interval '14 days' THEN 'Circulating this week'
            WHEN COALESCE(w.metadata_json->>'coverImageKey', w.metadata_json->>'coverImageUrl', w.metadata_json->>'coverUrl', w.metadata_json->>'imageUrl', w.metadata_json->>'thumbnailUrl') IS NOT NULL
              AND COALESCE(w.summary, '') <> '' THEN 'Worth opening'
            ELSE 'From the stack'
          END AS feed_label
        FROM works w
        LEFT JOIN engagement e ON e.work_id = w.id::text
        LEFT JOIN work_authors wa ON wa.work_id = w.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = w.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        GROUP BY
          w.id,
          w.gutenberg_id,
          w.title,
          w.metadata_json,
          w.language,
          w.release_date,
          w.rights_status,
          w.summary,
          e.opens_3d,
          e.opens_14d,
          e.last_opened_at
        ORDER BY score DESC, COALESCE(e.opens_3d, 0) DESC, w.release_date DESC NULLS LAST, w.title ASC
        OFFSET $1
        LIMIT $2
      `,
      [offset, limit],
    );

    return result.rows.map((row) =>
      toWorkSummary({
        id: row.id,
        gutenbergId: normalizeGutenbergId(row.gutenberg_id),
        title: row.title,
        language: row.language,
        releaseDate: row.release_date,
        rightsStatus: row.rights_status,
        summary: row.summary,
        authors: row.authors ?? [],
        subjects: row.subjects ?? [],
        score: Number(row.score ?? 0),
        feedLabel: row.feed_label ?? null,
        metadata: row.metadata_json ?? {},
      }),
    );
  }

  async countWorks(): Promise<number> {
    const result = await this.db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM works");
    const value = result.rows[0]?.count ?? "0";
    return Number.parseInt(value, 10) || 0;
  }

  async estimateResearchScope(query: string, filters: PassageSearchFilters = {}): Promise<ResearchScopeEstimate> {
    const normalizedQuery = normalizeSearchQuery(query);
    const tsQuery = normalizedQuery || query.trim();
    const probeWorks = await this.searchWorks(query, {
      ...filters,
      limit: 6,
    } as Record<string, unknown>);
    const startYear = Array.isArray(filters.yearRange) ? Math.min(filters.yearRange[0], filters.yearRange[1]) : null;
    const endYear = Array.isArray(filters.yearRange) ? Math.max(filters.yearRange[0], filters.yearRange[1]) : null;
    const genres = Array.isArray(filters.genre)
      ? filters.genre.map((genre) => genre.trim()).filter((genre) => genre.length > 0).slice(0, 8)
      : [];

    if (!tsQuery) {
      return buildResearchScopeEstimate(query, 0, 0, 0, probeWorks);
    }

    const estimateResult = await withTimeout(this.db.query<{
      metadata_work_estimate: number;
      chunk_match_estimate: number;
      chunk_work_estimate: number;
    }>(
      `
        WITH query_input AS (
          SELECT websearch_to_tsquery('english', $1::text) AS tsq
        ),
        eligible_works AS (
          SELECT w.id, w.title, w.summary, w.metadata_json
          FROM works w
          WHERE ($2::text IS NULL OR w.language = $2::text)
            AND ($3::text IS NULL OR w.rights_status = $3::text)
            AND (
              $4::int IS NULL
              OR (
                NULLIF(SUBSTRING(COALESCE(w.release_date::text, '') FROM '([0-9]{4})'), '') IS NOT NULL
                AND NULLIF(SUBSTRING(COALESCE(w.release_date::text, '') FROM '([0-9]{4})'), '')::int >= $4::int
              )
            )
            AND (
              $5::int IS NULL
              OR (
                NULLIF(SUBSTRING(COALESCE(w.release_date::text, '') FROM '([0-9]{4})'), '') IS NOT NULL
                AND NULLIF(SUBSTRING(COALESCE(w.release_date::text, '') FROM '([0-9]{4})'), '')::int <= $5::int
              )
            )
            AND (
              COALESCE(array_length($6::text[], 1), 0) = 0
              OR EXISTS (
                SELECT 1
                FROM UNNEST($6::text[]) AS genre
                WHERE
                  COALESCE(w.title, '') ILIKE '%' || genre || '%'
                  OR COALESCE(w.summary, '') ILIKE '%' || genre || '%'
                  OR COALESCE(w.metadata_json::text, '') ILIKE '%' || genre || '%'
              )
            )
        ),
        metadata_hits AS (
          SELECT COUNT(*)::int AS metadata_work_estimate
          FROM eligible_works ew, query_input
          WHERE (
            setweight(to_tsvector('english', COALESCE(ew.title, '')), 'A')
            || setweight(to_tsvector('english', COALESCE(ew.summary, '')), 'B')
            || setweight(to_tsvector('english', COALESCE(ew.metadata_json::text, '')), 'D')
          ) @@ query_input.tsq
        ),
        chunk_hits AS (
          SELECT
            COUNT(*)::int AS chunk_match_estimate,
            COUNT(DISTINCT c.work_id)::int AS chunk_work_estimate
          FROM chunks c
          JOIN eligible_works ew ON ew.id = c.work_id,
          query_input
          WHERE c.tsv @@ query_input.tsq
        )
        SELECT
          metadata_hits.metadata_work_estimate,
          chunk_hits.chunk_match_estimate,
          chunk_hits.chunk_work_estimate
        FROM metadata_hits, chunk_hits
      `,
      [
        tsQuery,
        typeof filters.language === "string" ? filters.language : null,
        typeof filters.rightsStatus === "string" ? filters.rightsStatus : null,
        Number.isInteger(startYear) ? startYear : null,
        Number.isInteger(endYear) ? endYear : null,
        genres,
      ],
    ), 5_000, "Scope estimate timed out before the database returned counts.");

    const row = estimateResult.rows[0] ?? {
      metadata_work_estimate: 0,
      chunk_match_estimate: 0,
      chunk_work_estimate: 0,
    };
    return buildResearchScopeEstimate(
      query,
      Number(row.metadata_work_estimate ?? 0),
      Number(row.chunk_match_estimate ?? 0),
      Number(row.chunk_work_estimate ?? 0),
      probeWorks,
    );
  }

  async getWorkById(workId: string): Promise<WorkDetailRecord | null> {
    const result = await this.db.query<{
      id: string;
      gutenberg_id: number | string | null;
      title: string;
      language: string | null;
      release_date: string | null;
      rights_status: string | null;
      summary: string | null;
      metadata_json: Record<string, unknown>;
      authors: string[];
      subjects: string[];
    }>(
      `
        SELECT
          w.id,
          w.gutenberg_id,
          w.title,
          w.language,
          w.release_date::text,
          w.rights_status,
          w.summary,
          w.metadata_json,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.name), NULL) AS authors,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.label), NULL) AS subjects
        FROM works w
        LEFT JOIN work_authors wa ON wa.work_id = w.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = w.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        WHERE w.id = $1::uuid
        GROUP BY w.id, w.gutenberg_id, w.title, w.language, w.release_date, w.rights_status, w.summary, w.metadata_json
        LIMIT 1
      `,
      [workId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      ...toWorkSummary({
        id: row.id,
        gutenbergId: normalizeGutenbergId(row.gutenberg_id),
        title: row.title,
        language: row.language,
        releaseDate: row.release_date,
        rightsStatus: row.rights_status,
        summary: row.summary,
        authors: row.authors ?? [],
        subjects: row.subjects ?? [],
        metadata: row.metadata_json ?? {},
      }),
      metadata: row.metadata_json ?? {},
    };
  }

  async searchWorks(query: string, filters: Record<string, unknown> = {}): Promise<WorkSummary[]> {
    const limit = Number(filters.limit ?? 20);
    const broadSurveyQuery = isBroadMetadataSurveyQuery(query);
    const metadataCandidateLimit = broadSurveyQuery ? Math.max(limit * 6, 72) : limit;
    const chunkCandidateLimit = broadSurveyQuery ? Math.max(limit * 240, 1200) : Math.max(limit * 80, 240);
    const chunkWorkLimit = broadSurveyQuery ? Math.max(limit * 4, 48) : limit;
    const tsQuery = buildMetadataTsQuery(query);
    const tokens = metadataSearchTerms(query);
    const lexicalMetadataQuery = tokens.join(" ");
    const mapRows = (
      rows: Array<{
        id: string;
        gutenberg_id: number | string | null;
        title: string;
        metadata_json: Record<string, unknown>;
        language: string | null;
        release_date: string | null;
        rights_status: string | null;
        summary: string | null;
        authors: string[];
        subjects: string[];
        score: number;
      }>,
    ) =>
      rows.map((row) =>
        toWorkSummary({
          id: row.id,
          gutenbergId: normalizeGutenbergId(row.gutenberg_id),
          title: row.title,
          language: row.language,
          releaseDate: row.release_date,
          rightsStatus: row.rights_status,
          summary: row.summary,
          authors: row.authors ?? [],
          subjects: row.subjects ?? [],
          score: row.score,
          metadata: row.metadata_json ?? {},
        }),
      );
    if (!tsQuery && tokens.length === 0) {
      return [];
    }
    try {
      const result = await this.db.query<{
        id: string;
        gutenberg_id: number | string | null;
        title: string;
        metadata_json: Record<string, unknown>;
        language: string | null;
        release_date: string | null;
        rights_status: string | null;
        summary: string | null;
        authors: string[];
        subjects: string[];
        score: number;
      }>(
        `
          WITH query_input AS (
            SELECT to_tsquery('english', CAST($1 AS text)) AS tsq
          ),
          work_index AS (
            SELECT
              w.id,
              w.gutenberg_id,
              w.title,
              w.metadata_json,
              w.language,
              w.release_date::text,
              w.rights_status,
              w.summary,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.name), NULL) AS authors,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.label), NULL) AS subjects,
              setweight(to_tsvector('english', COALESCE(w.title, '')), 'A') ||
              setweight(to_tsvector('english', COALESCE(w.summary, '')), 'B') ||
              setweight(to_tsvector('english', COALESCE(string_agg(DISTINCT a.name, ' '), '')), 'C') ||
              setweight(to_tsvector('english', COALESCE(string_agg(DISTINCT s.label, ' '), '')), 'B') ||
              setweight(to_tsvector('english', COALESCE(w.metadata_json::text, '')), 'D') AS document
            FROM works w
            LEFT JOIN work_authors wa ON wa.work_id = w.id
            LEFT JOIN authors a ON a.id = wa.author_id
            LEFT JOIN work_subjects ws ON ws.work_id = w.id
            LEFT JOIN subjects s ON s.id = ws.subject_id
            GROUP BY w.id, w.gutenberg_id, w.title, w.metadata_json, w.language, w.release_date, w.rights_status, w.summary
          )
          SELECT
            work_index.id,
            work_index.gutenberg_id,
            work_index.title,
            work_index.metadata_json,
            work_index.language,
            work_index.release_date,
            work_index.rights_status,
            work_index.summary,
            work_index.authors,
            work_index.subjects,
            ts_rank_cd(work_index.document, query_input.tsq) AS score
          FROM work_index, query_input
          WHERE work_index.document @@ query_input.tsq
            AND ($2::text IS NULL OR work_index.language = $2::text)
            AND ($3::text IS NULL OR work_index.rights_status = $3::text)
            AND (
              $4::int IS NULL
              OR (
                work_index.release_date IS NOT NULL
                AND work_index.release_date ~ '^[0-9]{4}'
                AND substring(work_index.release_date FROM 1 FOR 4)::int BETWEEN $4::int AND $5::int
              )
            )
            AND (
              COALESCE(array_length($6::text[], 1), 0) = 0
              OR EXISTS (
                SELECT 1
                FROM unnest($6::text[]) AS genre
                WHERE lower(
                  concat_ws(
                    ' ',
                    work_index.title,
                    COALESCE(work_index.summary, ''),
                    array_to_string(work_index.subjects, ' '),
                    COALESCE(work_index.metadata_json::text, '')
                  )
                ) LIKE '%' || lower(genre) || '%'
              )
            )
          ORDER BY score DESC, work_index.title ASC
          LIMIT $7
        `,
        [
          tsQuery,
          typeof filters.language === "string" ? filters.language : null,
          typeof filters.rightsStatus === "string" ? filters.rightsStatus : null,
          Array.isArray(filters.yearRange) ? Number(filters.yearRange[0]) : null,
          Array.isArray(filters.yearRange) ? Number(filters.yearRange[1]) : null,
          Array.isArray(filters.genre) ? filters.genre : [],
          metadataCandidateLimit,
        ],
      );
      const rerankedMetadataRows = rerankMetadataRows(result.rows, query);
      if (!broadSurveyQuery && (tokens.length === 0 || shouldAcceptMetadataRows(rerankedMetadataRows, query, limit))) {
        return mapRows(rerankedMetadataRows.slice(0, limit));
      }

      let chunkBackedRows: Array<{
        id: string;
        gutenberg_id: number | string | null;
        title: string;
        metadata_json: Record<string, unknown>;
        language: string | null;
        release_date: string | null;
        rights_status: string | null;
        summary: string | null;
        authors: string[];
        subjects: string[];
        score: number;
      }> = [];
      try {
        const chunkBackedResult = await withTimeout(this.db.query<{
          id: string;
          gutenberg_id: number | string | null;
          title: string;
          metadata_json: Record<string, unknown>;
          language: string | null;
          release_date: string | null;
          rights_status: string | null;
          summary: string | null;
          authors: string[];
          subjects: string[];
          score: number;
        }>(
          `
          WITH query_input AS (
            SELECT CASE
              WHEN NULLIF($6::text, '') IS NULL THEN NULL
              ELSE websearch_to_tsquery('english', $6::text)
            END AS tsq
          ),
          eligible_works AS (
            SELECT
              w.id,
              w.gutenberg_id,
              w.title,
              w.metadata_json,
              w.language,
              w.release_date::text,
              w.rights_status,
              w.summary
            FROM works w
            WHERE ($1::text IS NULL OR w.language = $1::text)
              AND ($2::text IS NULL OR w.rights_status = $2::text)
              AND (
                $3::int IS NULL
                OR (
                  w.release_date IS NOT NULL
                  AND w.release_date::text ~ '^[0-9]{4}'
                  AND substring(w.release_date::text FROM 1 FOR 4)::int BETWEEN $3::int AND $4::int
                )
              )
          ),
          filtered_works AS (
            SELECT *
            FROM eligible_works ew
            WHERE (
              COALESCE(array_length($5::text[], 1), 0) = 0
              OR EXISTS (
                SELECT 1
                FROM work_subjects ws
                JOIN subjects s ON s.id = ws.subject_id
                WHERE ws.work_id = ew.id
                  AND EXISTS (
                    SELECT 1
                    FROM unnest($5::text[]) AS genre
                    WHERE lower(
                      concat_ws(
                        ' ',
                        ew.title,
                        COALESCE(ew.summary, ''),
                        COALESCE(ew.metadata_json::text, ''),
                        s.label
                      )
                    ) LIKE '%' || lower(genre) || '%'
                  )
              )
            )
          ),
          chunk_matches AS (
            SELECT
              candidate_chunks.work_id,
              COUNT(*)::float AS score
            FROM (
              SELECT c.work_id
              FROM chunks c
              JOIN filtered_works fw ON fw.id = c.work_id,
              query_input
              WHERE
                (query_input.tsq IS NOT NULL AND c.tsv @@ query_input.tsq)
                OR EXISTS (
                  SELECT 1
                  FROM unnest($7::text[]) AS token
                  WHERE COALESCE(c.text, '') ILIKE '%' || token || '%'
                )
              LIMIT $8
            ) AS candidate_chunks
            GROUP BY candidate_chunks.work_id
          )
          SELECT
            fw.id,
            fw.gutenberg_id,
            fw.title,
            fw.metadata_json,
            fw.language,
            fw.release_date,
            fw.rights_status,
            fw.summary,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.name), NULL) AS authors,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.label), NULL) AS subjects,
            chunk_matches.score
          FROM chunk_matches
          JOIN filtered_works fw ON fw.id = chunk_matches.work_id
          LEFT JOIN work_authors wa ON wa.work_id = fw.id
          LEFT JOIN authors a ON a.id = wa.author_id
          LEFT JOIN work_subjects ws ON ws.work_id = fw.id
          LEFT JOIN subjects s ON s.id = ws.subject_id
          GROUP BY fw.id, fw.gutenberg_id, fw.title, fw.metadata_json, fw.language, fw.release_date, fw.rights_status, fw.summary, chunk_matches.score
          ORDER BY chunk_matches.score DESC, fw.title ASC
          LIMIT $9
        `,
        [
          typeof filters.language === "string" ? filters.language : null,
          typeof filters.rightsStatus === "string" ? filters.rightsStatus : null,
          Array.isArray(filters.yearRange) ? Number(filters.yearRange[0]) : null,
          Array.isArray(filters.yearRange) ? Number(filters.yearRange[1]) : null,
          Array.isArray(filters.genre) ? filters.genre : [],
          lexicalMetadataQuery,
          tokens,
          chunkCandidateLimit,
          chunkWorkLimit,
        ],
        ), 8_000, "Metadata search chunk expansion timed out.");
        chunkBackedRows = chunkBackedResult.rows;
      } catch (error) {
        if (result.rows.length === 0) {
          throw error;
        }
      }

      const mergedRows = dedupeMetadataRows(
        rerankMetadataRows(
          [
            ...rerankedMetadataRows,
            ...chunkBackedRows,
          ],
          query,
        ),
      );
      if (tokens.length === 0) {
        return mapRows(mergedRows.slice(0, limit));
      }

      if (shouldAcceptMetadataRows(mergedRows, query, limit)) {
        return mapRows(mergedRows.slice(0, limit));
      }

      for (const relaxedFilters of relaxMetadataSearchFilters(filters)) {
        const relaxedResults = await this.searchWorks(query, relaxedFilters);
        if (relaxedResults.length > 0) {
          return relaxedResults;
        }
      }
      if (mergedRows.length > 0) {
        return mapRows(mergedRows.slice(0, limit));
      }
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Metadata search failed: ${message}`);
    }
  }

  async getWorkMetadata(workIds: string[]): Promise<WorkSummary[]> {
    const result = await this.db.query<{
      id: string;
      gutenberg_id: number | string | null;
      title: string;
      metadata_json: Record<string, unknown>;
      language: string | null;
      release_date: string | null;
      rights_status: string | null;
      summary: string | null;
      authors: string[];
      subjects: string[];
    }>(
      `
        SELECT
          w.id,
          w.gutenberg_id,
          w.title,
          w.metadata_json,
          w.language,
          w.release_date::text,
          w.rights_status,
          w.summary,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.name), NULL) AS authors,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.label), NULL) AS subjects
        FROM works w
        LEFT JOIN work_authors wa ON wa.work_id = w.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = w.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        WHERE w.id = ANY($1::uuid[])
        GROUP BY w.id, w.gutenberg_id, w.title, w.metadata_json, w.language, w.release_date, w.rights_status, w.summary
        ORDER BY w.title ASC
      `,
      [workIds],
    );
    return result.rows.map((row) =>
      toWorkSummary({
        id: row.id,
        gutenbergId: normalizeGutenbergId(row.gutenberg_id),
        title: row.title,
        language: row.language,
        releaseDate: row.release_date,
        rightsStatus: row.rights_status,
        summary: row.summary,
        authors: row.authors ?? [],
        subjects: row.subjects ?? [],
        metadata: row.metadata_json ?? {},
      }),
    );
  }

  async getRelevantChunks(
    query: string,
    workIds?: string[],
    limit = 8,
    embedding?: number[],
    filters: PassageSearchFilters = {},
  ): Promise<ChunkSearchResult[]> {
    const usableEmbedding = embedding?.length === EXPECTED_EMBEDDING_DIMENSIONS ? embedding : undefined;
    const vectorLiteral = usableEmbedding ? `[${usableEmbedding.join(",")}]` : null;
    const normalizedQuery = normalizeSearchQuery(query);
    const tsQuery = normalizedQuery || query.trim();
    const tokens = expandedSearchTokens(query);
    const semanticCandidateLimit = Math.max(limit * 20, 192);
    const rankedResultLimit = shouldDiversifyChunkResults(query, workIds, limit)
      ? Math.min(Math.max(limit * 3, 96), 256)
      : limit;
    const startYear = Array.isArray(filters.yearRange) ? Math.min(filters.yearRange[0], filters.yearRange[1]) : null;
    const endYear = Array.isArray(filters.yearRange) ? Math.max(filters.yearRange[0], filters.yearRange[1]) : null;
    const genres = Array.isArray(filters.genre)
      ? filters.genre.map((genre) => genre.trim()).filter((genre) => genre.length > 0).slice(0, 8)
      : [];
    const result = await withTimeout(this.db.query<{
      id: string;
      work_id: string;
      chunk_index: number;
      text: string;
      r2_key: string | null;
      semantic_score: number;
      token_score: number;
      }>(
      `
        WITH query_input AS (
          SELECT
            CASE
              WHEN NULLIF($1::text, '') IS NULL THEN NULL
              ELSE websearch_to_tsquery('english', $1::text)
            END AS tsq,
            CASE WHEN $4::text IS NULL THEN NULL ELSE $4::vector END AS embedding
        ),
        eligible_works AS (
          SELECT w.id
          FROM works w
          WHERE
            ($2::uuid[] IS NULL OR w.id = ANY($2::uuid[]))
            AND ($7::text IS NULL OR w.language = $7::text)
            AND ($8::text IS NULL OR w.rights_status = $8::text)
            AND (
              $9::int IS NULL
              OR (
                NULLIF(SUBSTRING(COALESCE(w.release_date::text, '') FROM '([0-9]{4})'), '') IS NOT NULL
                AND NULLIF(SUBSTRING(COALESCE(w.release_date::text, '') FROM '([0-9]{4})'), '')::int >= $9::int
              )
            )
            AND (
              $10::int IS NULL
              OR (
                NULLIF(SUBSTRING(COALESCE(w.release_date::text, '') FROM '([0-9]{4})'), '') IS NOT NULL
                AND NULLIF(SUBSTRING(COALESCE(w.release_date::text, '') FROM '([0-9]{4})'), '')::int <= $10::int
              )
            )
            AND (
              COALESCE(array_length($11::text[], 1), 0) = 0
              OR EXISTS (
                SELECT 1
                FROM UNNEST($11::text[]) AS genre
                WHERE
                  COALESCE(w.title, '') ILIKE '%' || genre || '%'
                  OR COALESCE(w.summary, '') ILIKE '%' || genre || '%'
                  OR COALESCE(w.metadata_json::text, '') ILIKE '%' || genre || '%'
                  OR EXISTS (
                    SELECT 1
                    FROM work_subjects ws
                    JOIN subjects s ON s.id = ws.subject_id
                    WHERE ws.work_id = w.id
                      AND COALESCE(s.label, '') ILIKE '%' || genre || '%'
                  )
              )
            )
        ),
        semantic_candidates AS (
          SELECT c.id
          FROM chunks c
          JOIN eligible_works ew ON ew.id = c.work_id,
          query_input
          WHERE
            query_input.embedding IS NOT NULL
            AND c.embedding IS NOT NULL
          ORDER BY c.embedding <=> query_input.embedding
          LIMIT $6
        ),
        lexical_candidates AS (
          SELECT c.id
          FROM chunks c
          JOIN eligible_works ew ON ew.id = c.work_id,
          query_input
          WHERE
            (
              (query_input.tsq IS NOT NULL AND c.tsv @@ query_input.tsq)
              OR EXISTS (
                SELECT 1
                FROM UNNEST($5::text[]) AS token
                WHERE COALESCE(c.text, '') ILIKE '%' || token || '%'
              )
            )
        ),
        candidate_ids AS (
          SELECT id FROM semantic_candidates
          UNION
          SELECT id FROM lexical_candidates
        ),
        ranked AS (
          SELECT
            c.id,
            c.work_id,
            c.chunk_index,
            c.text,
            c.r2_key,
            (
              SELECT COUNT(*)::float
              FROM UNNEST($5::text[]) AS token
              WHERE COALESCE(c.text, '') ILIKE '%' || token || '%'
            ) AS token_score,
            CASE
              WHEN query_input.embedding IS NULL OR c.embedding IS NULL THEN
                COALESCE(CASE WHEN query_input.tsq IS NULL THEN NULL ELSE ts_rank_cd(c.tsv, query_input.tsq) END, 0)
              ELSE
                COALESCE(CASE WHEN query_input.tsq IS NULL THEN NULL ELSE ts_rank_cd(c.tsv, query_input.tsq) END, 0)
                + (1 - (c.embedding <=> query_input.embedding))
            END AS semantic_score
          FROM candidate_ids
          JOIN chunks c ON c.id = candidate_ids.id, query_input
        )
        SELECT
          ranked.id,
          ranked.work_id,
          ranked.chunk_index,
          ranked.text,
          ranked.r2_key,
          ranked.token_score,
          ranked.semantic_score
        FROM ranked
        ORDER BY (ranked.semantic_score + ranked.token_score) DESC, ranked.work_id ASC, ranked.chunk_index ASC
        LIMIT $3
      `,
      [
        tsQuery,
        workIds?.length ? workIds : null,
        rankedResultLimit,
        vectorLiteral,
        tokens,
        semanticCandidateLimit,
        typeof filters.language === "string" ? filters.language : null,
        typeof filters.rightsStatus === "string" ? filters.rightsStatus : null,
        Number.isInteger(startYear) ? startYear : null,
        Number.isInteger(endYear) ? endYear : null,
        genres,
      ],
    ), PASSAGE_SEARCH_TIMEOUT_MS, "Passage search timed out before the database returned chunks.");
    const rankedRows = result.rows.map((row) => ({
      id: row.id,
      workId: row.work_id,
      chunkIndex: row.chunk_index,
      text: row.text,
      r2Key: row.r2_key,
      score: Number(row.semantic_score ?? 0) + Number(row.token_score ?? 0),
      excerpt: excerpt(row.text, query),
    }));
    return diversifyChunkResults(query, workIds, rankedRows, limit);
  }

  async getWorkTextFile(workId: string): Promise<WorkTextRecord | null> {
    const result = await this.db.query<{ work_id: string; r2_key: string | null }>(
      `
        SELECT work_id, r2_key
        FROM work_files
        WHERE work_id = $1::uuid AND kind = 'clean'
        LIMIT 1
      `,
      [workId],
    );
    const row = result.rows[0];
    return row ? { workId: row.work_id, r2Key: row.r2_key } : null;
  }

  async getWorkFiles(workIds: string[], kinds?: WorkFileKind[]): Promise<WorkFileRecord[]> {
    const result = await this.db.query<{
      id: string;
      work_id: string;
      kind: WorkFileKind;
      r2_key: string;
      byte_size: number | null;
      metadata_json: Record<string, unknown>;
      created_at: string;
    }>(
      `
        SELECT id, work_id, kind, r2_key, byte_size, metadata_json, created_at
        FROM work_files
        WHERE
          work_id = ANY($1::uuid[])
          AND ($2::text[] IS NULL OR kind = ANY($2::text[]))
        ORDER BY work_id ASC, kind ASC
      `,
      [workIds, kinds?.length ? kinds : null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      workId: row.work_id,
      kind: row.kind,
      r2Key: row.r2_key,
      byteSize: row.byte_size,
      metadata: row.metadata_json,
      createdAt: row.created_at,
    }));
  }

  async getChunksByIds(chunkIds: string[]): Promise<ChunkSearchResult[]> {
    const result = await this.db.query<{
      id: string;
      work_id: string;
      chunk_index: number;
      text: string;
      r2_key: string | null;
    }>(
      `
        SELECT id, work_id, chunk_index, text, r2_key
        FROM chunks
        WHERE id = ANY($1::uuid[])
        ORDER BY work_id ASC, chunk_index ASC
      `,
      [chunkIds],
    );
    return result.rows.map((row) => ({
      id: row.id,
      workId: row.work_id,
      chunkIndex: row.chunk_index,
      text: row.text,
      r2Key: row.r2_key,
      score: 0,
      excerpt: row.text.slice(0, 220),
    }));
  }

  async getChunkByWorkAndIndex(workId: string, chunkIndex: number): Promise<ChunkSearchResult | null> {
    const result = await this.db.query<{
      id: string;
      work_id: string;
      chunk_index: number;
      text: string;
      r2_key: string | null;
    }>(
      `
        SELECT id, work_id, chunk_index, text, r2_key
        FROM chunks
        WHERE work_id = $1::uuid AND chunk_index = $2
        LIMIT 1
      `,
      [workId, chunkIndex],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      workId: row.work_id,
      chunkIndex: row.chunk_index,
      text: row.text,
      r2Key: row.r2_key,
      score: 0,
      excerpt: row.text.slice(0, 220),
    };
  }

  async listRuntimeInstances(sessionId: string): Promise<RuntimeInstanceRecord[]> {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      runtime_id: string;
      provider: string;
      provider_machine_id: string | null;
      status: RuntimeInstanceRecord["status"];
      manifest_json: Record<string, unknown>;
      last_used_at: string | null;
      expires_at: string | null;
      created_at: string;
    }>(
      `
        SELECT
          id,
          session_id,
          runtime_id,
          provider,
          provider_machine_id,
          status,
          manifest_json,
          last_used_at,
          expires_at,
          created_at
        FROM runtime_instances
        WHERE session_id = $1::uuid
        ORDER BY COALESCE(last_used_at, created_at) DESC
      `,
      [sessionId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      runtimeId: row.runtime_id,
      provider: row.provider,
      providerMachineId: row.provider_machine_id,
      status: row.status,
      manifestJson: row.manifest_json,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  async listExpiredRuntimeInstances(limit = 50): Promise<RuntimeInstanceRecord[]> {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      runtime_id: string;
      provider: string;
      provider_machine_id: string | null;
      status: RuntimeInstanceRecord["status"];
      manifest_json: Record<string, unknown>;
      last_used_at: string | null;
      expires_at: string | null;
      created_at: string;
    }>(
      `
        SELECT
          id,
          session_id,
          runtime_id,
          provider,
          provider_machine_id,
          status,
          manifest_json,
          last_used_at,
          expires_at,
          created_at
        FROM runtime_instances
        WHERE status NOT IN ('destroyed', 'expired')
          AND expires_at IS NOT NULL
          AND expires_at <= now()
        ORDER BY expires_at ASC
        LIMIT $1
      `,
      [Math.max(0, limit)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      runtimeId: row.runtime_id,
      provider: row.provider,
      providerMachineId: row.provider_machine_id,
      status: row.status,
      manifestJson: row.manifest_json,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  async getRuntimeInstance(runtimeId: string): Promise<RuntimeInstanceRecord | null> {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      runtime_id: string;
      provider: string;
      provider_machine_id: string | null;
      status: RuntimeInstanceRecord["status"];
      manifest_json: Record<string, unknown>;
      last_used_at: string | null;
      expires_at: string | null;
      created_at: string;
    }>(
      `
        SELECT
          id,
          session_id,
          runtime_id,
          provider,
          provider_machine_id,
          status,
          manifest_json,
          last_used_at,
          expires_at,
          created_at
        FROM runtime_instances
        WHERE runtime_id = $1
        LIMIT 1
      `,
      [runtimeId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      runtimeId: row.runtime_id,
      provider: row.provider,
      providerMachineId: row.provider_machine_id,
      status: row.status,
      manifestJson: row.manifest_json,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  async saveRuntimeInstance(
    input: Omit<RuntimeInstanceRecord, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<RuntimeInstanceRecord> {
    const recordId = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    const result = await this.db.query<{
      id: string;
      session_id: string;
      runtime_id: string;
      provider: string;
      provider_machine_id: string | null;
      status: RuntimeInstanceRecord["status"];
      manifest_json: Record<string, unknown>;
      last_used_at: string | null;
      expires_at: string | null;
      created_at: string;
    }>(
      `
        INSERT INTO runtime_instances (
          id,
          session_id,
          runtime_id,
          provider,
          provider_machine_id,
          status,
          manifest_json,
          last_used_at,
          expires_at,
          created_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          $4,
          $5,
          $6,
          $7::jsonb,
          $8::timestamptz,
          $9::timestamptz,
          $10::timestamptz
        )
        ON CONFLICT (runtime_id) DO UPDATE
        SET
          provider = EXCLUDED.provider,
          provider_machine_id = EXCLUDED.provider_machine_id,
          status = EXCLUDED.status,
          manifest_json = EXCLUDED.manifest_json,
          last_used_at = EXCLUDED.last_used_at,
          expires_at = EXCLUDED.expires_at
        RETURNING
          id,
          session_id,
          runtime_id,
          provider,
          provider_machine_id,
          status,
          manifest_json,
          last_used_at,
          expires_at,
          created_at
      `,
      [
        recordId,
        input.sessionId,
        input.runtimeId,
        input.provider,
        input.providerMachineId,
        input.status,
        JSON.stringify(input.manifestJson),
        input.lastUsedAt,
        input.expiresAt,
        createdAt,
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      sessionId: row.session_id,
      runtimeId: row.runtime_id,
      provider: row.provider,
      providerMachineId: row.provider_machine_id,
      status: row.status,
      manifestJson: row.manifest_json,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  async updateRuntimeInstance(
    runtimeId: string,
    updates: Partial<Pick<RuntimeInstanceRecord, "status" | "manifestJson" | "lastUsedAt" | "expiresAt" | "providerMachineId">>,
  ): Promise<void> {
    await this.db.query(
      `
        UPDATE runtime_instances
        SET
          status = COALESCE($2, status),
          manifest_json = COALESCE($3::jsonb, manifest_json),
          last_used_at = COALESCE($4::timestamptz, last_used_at),
          expires_at = COALESCE($5::timestamptz, expires_at),
          provider_machine_id = COALESCE($6, provider_machine_id)
        WHERE runtime_id = $1
      `,
      [
        runtimeId,
        updates.status ?? null,
        updates.manifestJson ? JSON.stringify(updates.manifestJson) : null,
        updates.lastUsedAt ?? null,
        updates.expiresAt ?? null,
        updates.providerMachineId ?? null,
      ],
    );
  }

  async saveArtifact(
    input: Omit<ArtifactRecord, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<ArtifactRecord> {
    const artifactId = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    const result = await this.db.query<{
      id: string;
      session_id: string;
      runtime_id: string | null;
      r2_key: string;
      filename: string;
      mime_type: string;
      metadata_json: Record<string, unknown>;
      created_at: string;
    }>(
      `
        INSERT INTO artifacts (id, session_id, runtime_id, r2_key, filename, mime_type, metadata_json, created_at)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
        ON CONFLICT (r2_key) DO UPDATE
        SET
          runtime_id = EXCLUDED.runtime_id,
          filename = EXCLUDED.filename,
          mime_type = EXCLUDED.mime_type,
          metadata_json = EXCLUDED.metadata_json
        RETURNING id, session_id, runtime_id, r2_key, filename, mime_type, metadata_json, created_at
      `,
      [
        artifactId,
        input.sessionId,
        input.runtimeId,
        input.r2Key,
        input.filename,
        input.mimeType,
        JSON.stringify(input.metadata),
        createdAt,
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      sessionId: row.session_id,
      runtimeId: row.runtime_id,
      r2Key: row.r2_key,
      filename: row.filename,
      mimeType: row.mime_type,
      metadata: row.metadata_json,
      createdAt: row.created_at,
    };
  }

  async listArtifacts(sessionId: string, runtimeId?: string | null): Promise<ArtifactRecord[]> {
    const result = await this.db.query<{
      id: string;
      session_id: string;
      runtime_id: string | null;
      r2_key: string;
      filename: string;
      mime_type: string;
      metadata_json: Record<string, unknown>;
      created_at: string;
    }>(
      `
        SELECT id, session_id, runtime_id, r2_key, filename, mime_type, metadata_json, created_at
        FROM artifacts
        WHERE
          session_id = $1::uuid
          AND ($2::text IS NULL OR runtime_id = $2::text)
        ORDER BY created_at ASC
      `,
      [sessionId, runtimeId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      runtimeId: row.runtime_id,
      r2Key: row.r2_key,
      filename: row.filename,
      mimeType: row.mime_type,
      metadata: row.metadata_json,
      createdAt: row.created_at,
    }));
  }

  async createBillingEvent(
    input: Omit<BillingEventRecord, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<BillingEventRecord> {
    const billingEventId = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    const result = await this.db.query<{
      id: string;
      user_id: string;
      session_id: string | null;
      run_id: string | null;
      source: string;
      provider: string;
      model: string;
      operation: string;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cached_input_tokens: number;
      cost_usd: string | number;
      request_id: string | null;
      request_json: Record<string, unknown> | null;
      response_json: Record<string, unknown> | null;
      metadata_json: Record<string, unknown>;
      created_at: string;
    }>(
      `
        INSERT INTO billing_events (
          id,
          user_id,
          session_id,
          run_id,
          source,
          provider,
          model,
          operation,
          input_tokens,
          output_tokens,
          total_tokens,
          cached_input_tokens,
          cost_usd,
          request_id,
          request_json,
          response_json,
          metadata_json,
          created_at
        )
        VALUES (
          $1::uuid,
          $2,
          $3::uuid,
          $4::uuid,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15::jsonb,
          $16::jsonb,
          $17::jsonb,
          $18::timestamptz
        )
        RETURNING
          id,
          user_id,
          session_id,
          run_id,
          source,
          provider,
          model,
          operation,
          input_tokens,
          output_tokens,
          total_tokens,
          cached_input_tokens,
          cost_usd,
          request_id,
          request_json,
          response_json,
          metadata_json,
          created_at
      `,
      [
        billingEventId,
        input.userId,
        input.sessionId,
        input.runId,
        input.source,
        input.provider,
        input.model,
        input.operation,
        input.inputTokens,
        input.outputTokens,
        input.totalTokens,
        input.cachedInputTokens,
        input.costUsd,
        input.requestId,
        input.requestJson ? JSON.stringify(input.requestJson) : null,
        input.responseJson ? JSON.stringify(input.responseJson) : null,
        JSON.stringify(input.metadata),
        createdAt,
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      runId: row.run_id,
      source: row.source,
      provider: row.provider,
      model: row.model,
      operation: row.operation,
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      cachedInputTokens: Number(row.cached_input_tokens ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
      requestId: row.request_id,
      requestJson: row.request_json,
      responseJson: row.response_json,
      metadata: row.metadata_json ?? {},
      createdAt: row.created_at,
    };
  }

  async getBillingSpend(userId: string, since: string): Promise<BillingSpendSummary> {
    const result = await this.db.query<{
      total_cost_usd: string | number | null;
      event_count: number;
    }>(
      `
        SELECT
          COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
          COUNT(*)::int AS event_count
        FROM billing_events
        WHERE user_id = $1
          AND created_at >= $2::timestamptz
      `,
      [userId, since],
    );
    const row = result.rows[0];
    return {
      totalCostUsd: Number(row?.total_cost_usd ?? 0),
      eventCount: Number(row?.event_count ?? 0),
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
