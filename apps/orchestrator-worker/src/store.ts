import type { DbClient } from "@alphabook/db";
import {
  workDetailToDocumentDetail,
  workSummaryToDocumentSummary,
} from "@alphabook/platform";
import { defaultCorpusAdapter, type ChunkSearchResult, type NotificationType, type ToolName, type WorkDetail, type WorkSummary } from "@alphabook/shared";
import type {
  CorpusChunkRecord,
  CorpusDocumentRecord,
  CorpusFileRecord,
} from "@alphabook/platform";
import { NeonCorpusDbRepository } from "./db-repository";

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
  scopeMode: "focused" | "subset_wide" | "corpus_wide";
  metadataWorkEstimate: number;
  chunkMatchEstimate: number;
  chunkWorkEstimate: number;
  totalWorkEstimate: number;
  totalChunkEstimate: number;
  totalTextBytesEstimate: number;
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

export interface WorkSetSizeEstimate {
  workCount: number;
  totalChunkCount: number;
  totalTextBytes: number;
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

export interface ProfileFacetStatRecord {
  label: string;
  count: number;
}

export interface ProfileBookStatRecord {
  work: WorkSummary;
  openCount: number;
  citationCount: number;
  sessionCount: number;
  lastTouchedAt: string | null;
}

export interface ProfileQueryStatRecord {
  sessionId: string;
  sessionTitle: string | null;
  firstUserQuery: string | null;
  latestUserQuery: string | null;
  lastActivityAt: string | null;
  userMessageCount: number;
  citationCount: number;
  distinctCitedWorks: number;
}

export interface UserProfileStatsRecord {
  userId: string;
  generatedAt: string;
  counts: {
    sessionCount: number;
    queryCount: number;
    runCount: number;
    activeDayCount: number;
    booksOpenedCount: number;
    uniqueBooksOpenedCount: number;
    uniqueBooksCitedCount: number;
    booksTouchedCount: number;
    citationCount: number;
  };
  averages: {
    queriesPerSession: number;
    citationsPerQuery: number;
    booksOpenedPerSession: number;
    booksTouchedPerQuery: number;
  };
  books: {
    recent: ProfileBookStatRecord[];
    topOpened: ProfileBookStatRecord[];
    topCited: ProfileBookStatRecord[];
  };
  fingerprint: {
    authors: ProfileFacetStatRecord[];
    subjects: ProfileFacetStatRecord[];
    languages: ProfileFacetStatRecord[];
  };
  recentQueries: ProfileQueryStatRecord[];
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
  activeRunStatus: "queued" | "running" | null;
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

export interface RunEventRecord {
  id: string;
  runId: string;
  sessionId: string;
  event: string;
  sequence: number;
  dataJson: Record<string, unknown>;
  createdAt: string;
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

export interface DocumentTextRecord {
  documentId: string;
  r2Key: string | null;
}

export type DocumentFileKind = WorkFileKind;

export interface DocumentFileRecord extends CorpusFileRecord {
  id: string;
  kind: DocumentFileKind;
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

export interface NotificationRecord {
  id: string;
  userId: string;
  sessionId: string | null;
  runId: string | null;
  toolCallId: string | null;
  type: NotificationType;
  title: string;
  body: string;
  dedupeKey: string;
  metadata: Record<string, unknown>;
  readAt: string | null;
  emailedAt: string | null;
  createdAt: string;
}

export interface AppStore {
  ensureUser(userId: string): Promise<void>;
  upsertUserProfile(input: { id: string; email?: string | null; name?: string | null; avatarUrl?: string | null }): Promise<UserRecord>;
  getUserProfile(userId: string): Promise<UserRecord | null>;
  claimGuestUserData(guestUserId: string, userId: string): Promise<void>;
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
  getUserProfileStats(userId: string): Promise<UserProfileStatsRecord>;
  listAdminSessions(): Promise<AdminSessionRecord[]>;
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  getLatestPlanMessageForRun(sessionId: string, runId: string): Promise<MessageRecord | null>;
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
  appendRunEvent(runId: string, sessionId: string, event: string, dataJson: Record<string, unknown>): Promise<RunEventRecord>;
  listRunEvents(runId: string): Promise<RunEventRecord[]>;
  listRecentRunEvents(runId: string, limit: number): Promise<RunEventRecord[]>;
  listWorks(offset?: number, limit?: number): Promise<WorkSummary[]>;
  countWorks(): Promise<number>;
  listDocuments(offset?: number, limit?: number): Promise<CorpusDocumentRecord[]>;
  countDocuments(): Promise<number>;
  refreshExploreFeedSnapshot(limit?: number): Promise<void>;
  getWorkById(workId: string): Promise<WorkDetailRecord | null>;
  getDocumentById(documentId: string): Promise<CorpusDocumentRecord | null>;
  getWorksByIdPrefixes(prefixes: string[]): Promise<Array<{
    prefix: string;
    work: WorkDetailRecord;
  }>>;
  estimateWorkSetSize(workIds?: string[], filters?: PassageSearchFilters): Promise<WorkSetSizeEstimate>;
  estimateDocumentSetSize(documentIds?: string[], filters?: PassageSearchFilters): Promise<WorkSetSizeEstimate>;
  estimateResearchScope(query: string, filters?: PassageSearchFilters): Promise<ResearchScopeEstimate>;
  searchWorks(query: string, filters?: Record<string, unknown>): Promise<WorkSummary[]>;
  searchDocuments(query: string, filters?: Record<string, unknown>): Promise<CorpusDocumentRecord[]>;
  getWorkMetadata(workIds: string[]): Promise<WorkSummary[]>;
  getDocumentMetadata(documentIds: string[]): Promise<CorpusDocumentRecord[]>;
  getRelevantChunks(
    query: string,
    workIds?: string[],
    limit?: number,
    embedding?: number[],
    filters?: PassageSearchFilters,
  ): Promise<ChunkSearchResult[]>;
  getRelevantDocumentChunks(
    query: string,
    documentIds?: string[],
    limit?: number,
    embedding?: number[],
    filters?: PassageSearchFilters,
  ): Promise<CorpusChunkRecord[]>;
  getWorkTextFile(workId: string): Promise<WorkTextRecord | null>;
  getDocumentTextFile(documentId: string): Promise<DocumentTextRecord | null>;
  getWorkFiles(workIds: string[], kinds?: WorkFileKind[]): Promise<WorkFileRecord[]>;
  getDocumentFiles(documentIds: string[], kinds?: DocumentFileKind[]): Promise<DocumentFileRecord[]>;
  getChunksByIds(chunkIds: string[]): Promise<ChunkSearchResult[]>;
  getChunkByWorkAndIndex(workId: string, chunkIndex: number): Promise<ChunkSearchResult | null>;
  findChunkByWorkAndExcerpt(workId: string, excerpt: string): Promise<ChunkSearchResult | null>;
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
  createNotification(input: {
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
  }): Promise<NotificationRecord>;
  listNotifications(userId: string, options?: { limit?: number }): Promise<NotificationRecord[]>;
  countUnreadNotifications(userId: string): Promise<number>;
  markNotificationRead(notificationId: string, userId: string, readAt?: string): Promise<boolean>;
  markAllNotificationsRead(userId: string, readAt?: string): Promise<number>;
  updateNotification(
    notificationId: string,
    userId: string,
    updates: Partial<Pick<NotificationRecord, "metadata" | "emailedAt" | "readAt">>,
  ): Promise<void>;
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

function mapWorkSummaryToDocument(work: WorkSummary): CorpusDocumentRecord {
  return workSummaryToDocumentSummary(work);
}

function mapWorkDetailToDocument(work: WorkDetailRecord): CorpusDocumentRecord {
  return workDetailToDocumentDetail(work);
}

function mapChunkToDocument(chunk: ChunkSearchResult): CorpusChunkRecord {
  return {
    id: chunk.id,
    documentId: chunk.workId,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    excerpt: chunk.excerpt,
    r2Key: chunk.r2Key ?? null,
    score: chunk.score,
  };
}

function mapWorkFileToDocument(file: WorkFileRecord): DocumentFileRecord {
  return {
    id: file.id,
    documentId: file.workId,
    kind: file.kind,
    r2Key: file.r2Key,
    byteSize: file.byteSize,
    metadata: file.metadata,
    createdAt: file.createdAt,
  };
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

type NotificationRow = {
  id: string;
  user_id: string;
  session_id: string | null;
  run_id: string | null;
  tool_call_id: string | null;
  type: NotificationType;
  title: string;
  body: string;
  dedupe_key: string;
  metadata_json: Record<string, unknown>;
  read_at: string | null;
  emailed_at: string | null;
  created_at: string;
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

function mapNotificationRow(row: NotificationRow): NotificationRecord {
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
    metadata: row.metadata_json ?? {},
    readAt: row.read_at,
    emailedAt: row.emailed_at,
    createdAt: row.created_at,
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

function roundProfileAverage(value: number) {
  return Math.round(value * 10) / 10;
}

function isoDay(value: string | null | undefined) {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : null;
}

function extractMessageCitations(metadata: Record<string, unknown> | undefined): Array<{ workId: string }> {
  const raw = metadata?.citations;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({ workId: typeof entry.workId === "string" ? entry.workId : "" }))
    .filter((entry) => entry.workId.length > 0);
}

function topFacetStats(values: Map<string, number>, limit = 5): ProfileFacetStatRecord[] {
  return [...values.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, limit);
}

function buildProfileBookStats(
  worksById: Map<string, WorkSummary>,
  openCounts: Map<string, number>,
  citationCounts: Map<string, number>,
  sessionSetsByWork: Map<string, Set<string>>,
  lastTouchedAt: Map<string, string>,
): ProfileBookStatRecord[] {
  return [...new Set([
    ...openCounts.keys(),
    ...citationCounts.keys(),
    ...sessionSetsByWork.keys(),
  ])]
    .map((workId) => {
      const work = worksById.get(workId);
      if (!work) {
        return null;
      }
      return {
        work,
        openCount: openCounts.get(workId) ?? 0,
        citationCount: citationCounts.get(workId) ?? 0,
        sessionCount: sessionSetsByWork.get(workId)?.size ?? 0,
        lastTouchedAt: lastTouchedAt.get(workId) ?? null,
      };
    })
    .filter((entry): entry is ProfileBookStatRecord => Boolean(entry));
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

function normalizeExcerptMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/[^a-z0-9\s']/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function excerptMatchScore(chunkText: string, excerptText: string): number {
  const chunk = normalizeExcerptMatchText(chunkText);
  const excerpt = normalizeExcerptMatchText(excerptText);
  if (!chunk || !excerpt) {
    return -1;
  }
  if (chunk.includes(excerpt)) {
    return excerpt.length + 10_000;
  }
  const excerptTokens = excerpt.split(" ").filter((token) => token.length >= 4);
  if (excerptTokens.length === 0) {
    return -1;
  }
  let overlap = 0;
  for (const token of excerptTokens) {
    if (chunk.includes(token)) {
      overlap += token.length;
    }
  }
  return overlap;
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
  "categorized",
  "characters",
  "cite",
  "corpus",
  "deal",
  "different",
  "direct",
  "directly",
  "extract",
  "extracts",
  "find",
  "for",
  "from",
  "give",
  "got",
  "hello",
  "help",
  "hey",
  "how",
  "identify",
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
  "provide",
  "quotable",
  "return",
  "seed",
  "show",
  "some",
  "strongest",
  "supporting",
  "taxonomy",
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
  "way",
  "ways",
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
  "categorized",
  "characters",
  "deal",
  "death",
  "died",
  "deep",
  "dress",
  "identify",
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
  "way",
  "ways",
  "different",
  "extract",
  "extracts",
  "return",
  "provide",
  "provided",
  "supporting",
  "citation",
  "citations",
  "taxonomy",
  "category",
  "categories",
  "direct",
  "directly",
  "strongest",
  "quotable",
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

const PASSAGE_SEARCH_QUERY_STOP_WORDS = new Set([
  "1800",
  "1899",
  "19th",
  "authors",
  "book",
  "books",
  "century",
  "characters",
  "cite",
  "citing",
  "compile",
  "coping",
  "categories",
  "category",
  "deal",
  "different",
  "direct",
  "directly",
  "emotional",
  "extract",
  "extracts",
  "fiction",
  "identify",
  "locations",
  "location",
  "multiple",
  "novel",
  "novels",
  "objective",
  "patterns",
  "passage",
  "passages",
  "portrayals",
  "published",
  "provide",
  "quotable",
  "relevant",
  "responses",
  "retrieve",
  "short",
  "stories",
  "story",
  "strongest",
  "supporting",
  "summarize",
  "taxonomy",
  "titles",
  "types",
  "ways",
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

const GRIEF_EXPLICIT_MATCH_PATTERN = /\b(grief|mourning|bereavement|funeral|sorrow|lament|weep|wept|weeping|tears?|loss|consolation|despair)\b/u;
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
  for (const token of defaultCorpusAdapter.hooks?.expandQueryTerms?.({
    query,
    mode: "search",
  }) ?? []) {
    if (token.length >= 3 && !WORK_SEARCH_STOP_WORDS.has(token)) {
      expanded.add(token);
    }
  }
  for (const token of baseTokens) {
    for (const synonym of QUERY_SYNONYMS[token] ?? []) {
      if (synonym.length >= 3 && !WORK_SEARCH_STOP_WORDS.has(synonym)) {
        expanded.add(synonym);
      }
    }
  }
  return [...expanded].slice(0, 16);
}

function passageSearchTokens(query: string): string[] {
  const adapterTerms = defaultCorpusAdapter.hooks?.expandQueryTerms?.({
    query,
    mode: "passage",
  }) ?? [];
  const expanded = expandedSearchTokens(query)
    .concat(adapterTerms)
    .filter((token) => !PASSAGE_SEARCH_QUERY_STOP_WORDS.has(token))
    .filter((token) => !/^\d{4}$/u.test(token));
  const hasStrongGriefSignal = expanded.some((token) => GRIEF_THEME_TOKENS.has(token) || token === "grief");
  const focused = hasStrongGriefSignal
    ? Array.from(new Set([...expanded, ...GRIEF_BROADENING_TERMS]))
    : expanded;
  return focused.slice(0, isBroadMetadataSurveyQuery(query) ? 14 : 10);
}

function isBroadMetadataSurveyQuery(query: string) {
  return /\b(all|every|compare|comparison|trace|theme|pattern|survey|synthesize|search|find|why|how|where|when|across|identify|different|examples|kinds|types)\b/iu.test(
    query,
  );
}

function metadataSearchTerms(query: string): string[] {
  const expanded = Array.from(new Set([
    ...expandedSearchTokens(query),
    ...(defaultCorpusAdapter.hooks?.expandQueryTerms?.({
      query,
      mode: "metadata",
    }) ?? []),
  ]));
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

function isBroadSurveyShardQuery(query: string) {
  return /\b(all|every|trace|theme|pattern|survey|synthesize|search|find|identify|examples|different ways|ways that|kinds of|types of)\b/iu.test(
    query,
  );
}

function isTemporalAnalysisQuery(query: string) {
  return /\b(by decade|over time|through time|throughout the century|changed over time|change over time|evolution of|evolve|earlier vs later|early vs late|before and after|first half|second half)\b/iu.test(
    query,
  );
}

function recommendedShardAxis(query: string, estimatedWorkBreadth: number): ResearchScopeEstimate["recommendedShardAxis"] {
  const adapterShardAxis = defaultCorpusAdapter.hooks?.recommendedShardAxis?.({
    query,
    estimatedDocumentBreadth: estimatedWorkBreadth,
  });
  if (adapterShardAxis) {
    return adapterShardAxis;
  }
  if (estimatedWorkBreadth <= 24) {
    return "none";
  }
  if (/\b(hypothesis|test whether|for and against|support and oppose|support or refute|prove or disprove|verdict|counterexample|exception|exceptions|disconfirm)\b/iu.test(query)) {
    return "retrieval_strategy";
  }
  if (/\b(what about|go deeper|follow up|follow-up|focus on|expand on|narrow|zoom in)\b/iu.test(query)) {
    return "retrieval_strategy";
  }
  if (isBroadSurveyShardQuery(query) && !isTemporalAnalysisQuery(query)) {
    return "work_id_hash";
  }
  if (
    isTemporalAnalysisQuery(query)
    || /\b(180\d|181\d|182\d|183\d|184\d|185\d|186\d|187\d|188\d|189\d|decade|era|period)\b/iu.test(query)
  ) {
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
    "supporting_evidence",
    "opposing_evidence",
    "metadata_expansion",
    "semantic_chunk_search",
    "lexical_regex_search",
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
  workload: {
    scopeMode?: ResearchScopeEstimate["scopeMode"];
    workCount?: number;
    totalChunkCount?: number;
    totalTextBytes?: number;
  } = {},
): ResearchScopeEstimate {
  const totalWorkEstimate = Math.max(workload.workCount ?? 0, metadataWorkEstimate, chunkWorkEstimate, probeWorks.length);
  const totalChunkEstimate = Math.max(workload.totalChunkCount ?? 0, chunkMatchEstimate);
  const totalTextBytesEstimate = Math.max(0, workload.totalTextBytes ?? 0);
  const scopeMode = workload.scopeMode
    ?? (isBroadMetadataSurveyQuery(query) ? "corpus_wide" : totalWorkEstimate <= 12 ? "focused" : "subset_wide");
  const effectiveWorkBreadth = totalWorkEstimate;
  const effectiveChunkBreadth = totalChunkEstimate;
  const effectiveTextMegabytes = totalTextBytesEstimate / 1_000_000;
  let breadthBand: ResearchScopeEstimate["breadthBand"] = "tiny";
  let recommendedIntensity: ResearchScopeEstimate["recommendedIntensity"] = "normal";
  let recommendedWallClockMinutes: ResearchScopeEstimate["recommendedWallClockMinutes"] = 5;
  let recommendedParallelism = 1;
  let recommendedVmWorkBudget = 40;
  let recommendedFrontierWorks = scopeMode === "focused" ? Math.max(12, effectiveWorkBreadth) : 24;

  if (
    effectiveWorkBreadth > 320
    || effectiveChunkBreadth > 48_000
    || effectiveTextMegabytes > 180
  ) {
    breadthBand = "huge";
    recommendedIntensity = "maximum";
    recommendedWallClockMinutes = 60;
    recommendedParallelism = 12;
    recommendedVmWorkBudget = 36;
    recommendedFrontierWorks = scopeMode === "corpus_wide" ? 224 : 192;
  } else if (
    effectiveWorkBreadth > 128
    || effectiveChunkBreadth > 18_000
    || effectiveTextMegabytes > 64
  ) {
    breadthBand = "large";
    recommendedIntensity = "maximum";
    recommendedWallClockMinutes = 60;
    recommendedParallelism = 8;
    recommendedVmWorkBudget = 40;
    recommendedFrontierWorks = scopeMode === "corpus_wide" ? 160 : 128;
  } else if (
    effectiveWorkBreadth > 48
    || effectiveChunkBreadth > 6_000
    || effectiveTextMegabytes > 24
  ) {
    breadthBand = "medium";
    recommendedIntensity = "high";
    recommendedWallClockMinutes = 15;
    recommendedParallelism = 4;
    recommendedVmWorkBudget = 32;
    recommendedFrontierWorks = scopeMode === "focused" ? Math.max(24, effectiveWorkBreadth) : 72;
  } else if (
    effectiveWorkBreadth > 12
    || effectiveChunkBreadth > 1_500
    || effectiveTextMegabytes > 8
  ) {
    breadthBand = "small";
    recommendedIntensity = "high";
    recommendedWallClockMinutes = 15;
    recommendedParallelism = 2;
    recommendedVmWorkBudget = 24;
    recommendedFrontierWorks = scopeMode === "focused" ? Math.max(16, effectiveWorkBreadth) : 40;
  }

  if (scopeMode === "focused" && effectiveWorkBreadth <= 8 && effectiveChunkBreadth <= 2_500) {
    recommendedIntensity = "normal";
    recommendedWallClockMinutes = 5;
    recommendedParallelism = 1;
    recommendedVmWorkBudget = 20;
    recommendedFrontierWorks = Math.max(8, effectiveWorkBreadth);
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
    `The run is sized as ${scopeMode.replaceAll("_", " ")} over roughly ${effectiveWorkBreadth} books`,
    effectiveChunkBreadth > 0 ? `covering about ${effectiveChunkBreadth} indexed passages` : "with sparse indexed passage coverage so far",
    totalTextBytesEstimate > 0 ? `and about ${(totalTextBytesEstimate / 1_000_000).toFixed(1)} MB of source text` : "and limited source-text size information",
    `so the recommended intensity is ${recommendedIntensity} (${recommendedWallClockMinutes} minutes)`,
    recommendedParallelism > 1 ? `using ${recommendedParallelism} parallel shards on ${shardAxis.replaceAll("_", " ")}` : "without parallel sharding yet",
    `and a frontier of about ${recommendedFrontierWorks} active books before verification narrows it.`,
  ].join(", ");

  return {
    query,
    scopeMode,
    metadataWorkEstimate,
    chunkMatchEstimate,
    chunkWorkEstimate,
    totalWorkEstimate,
    totalChunkEstimate,
    totalTextBytesEstimate,
    breadthBand,
    recommendedIntensity,
    recommendedWallClockMinutes,
    recommendedParallelism,
    recommendedShardAxis: shardAxis,
    recommendedVmWorkBudget,
    recommendedFrontierWorks,
    estimatedCoveragePercent,
    probeWorks: probeWorks.slice(0, breadthBand === "tiny" || breadthBand === "small" ? 6 : 12).map((work) => ({
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
  const adapterDecision = defaultCorpusAdapter.hooks?.acceptMetadataResults?.({
    query,
    limit,
    documents: rows.map((row) => ({
      id: "",
      title: row.title,
      summary: row.summary ?? null,
      contributors: row.authors ?? [],
      subjects: row.subjects ?? [],
      metadata: row.metadata_json ?? {},
    })),
  });
  if (typeof adapterDecision === "boolean") {
    return adapterDecision;
  }
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
  id: string;
  title: string;
  summary: string | null;
  authors: string[];
  subjects: string[];
  metadata_json: Record<string, unknown>;
  score: number;
}>(rows: T[], query: string): T[] {
  return rows
    .map((row) => {
      const bonus = defaultCorpusAdapter.hooks?.scoreDocumentMetadata?.({
        query,
        document: {
          id: row.id,
          title: row.title,
          summary: row.summary ?? null,
          contributors: row.authors ?? [],
          subjects: row.subjects ?? [],
          metadata: row.metadata_json ?? {},
        },
        metadata: row.metadata_json ?? {},
      }) ?? 0;
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

function scopeEstimateTerms(query: string) {
  const adapterTerms = defaultCorpusAdapter.hooks?.expandQueryTerms?.({
    query,
    mode: "scope",
  }) ?? [];
  return Array.from(new Set([
    ...metadataSearchTerms(query),
    ...adapterTerms,
  ]))
    .filter((term) => /^[a-z0-9]+$/iu.test(term))
    .slice(0, 24);
}

function scopeEstimateTsQuery(query: string) {
  return scopeEstimateTerms(query)
    .map((term) => `${term}:*`)
    .join(" | ");
}

function scopeEstimateChunkQueries(query: string) {
  const terms = scopeEstimateTerms(query);
  if (terms.length === 0) {
    return [query.trim()].filter((value) => value.length > 0);
  }
  const variants = new Set<string>();
  variants.add(terms.join(" "));
  if (terms.length > 6) {
    variants.add(terms.slice(0, 6).join(" "));
    variants.add(terms.slice(-6).join(" "));
  }
  variants.add(query.trim());
  return [...variants].filter((value) => value.length > 0).slice(0, isBroadMetadataSurveyQuery(query) ? 4 : 2);
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

function chunkStringArray(values: string[], size: number): string[][] {
  const chunkSize = Math.max(1, size);
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
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
  private readonly runEvents = new Map<string, RunEventRecord[]>();
  private readonly runtimeInstances = new Map<string, RuntimeInstanceRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly notifications = new Map<string, NotificationRecord>();
  private readonly notificationsByDedupeKey = new Map<string, string>();
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

  async claimGuestUserData(guestUserId: string, userId: string): Promise<void> {
    if (!guestUserId || !userId || guestUserId === userId) {
      return;
    }
    await this.ensureUser(userId);
    const guestProfile = this.userProfiles.get(guestUserId);
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.userId === guestUserId) {
        this.sessions.set(sessionId, { ...session, userId });
      }
    }
    for (const event of this.billingEvents.values()) {
      if (event.userId === guestUserId) {
        event.userId = userId;
      }
    }
    for (const event of this.analyticsEvents.values()) {
      if (event.userId === guestUserId) {
        event.userId = userId;
      }
    }
    if (guestProfile) {
      this.userProfiles.delete(guestUserId);
    }
    this.users.delete(guestUserId);
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
        const activeRun: RunRecord | null =
          [...this.runs.values()]
            .filter((run) => run.sessionId === session.id && (run.status === "queued" || run.status === "running"))
            .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
          ?? null;
        return {
          ...session,
          lastMessageAt: lastMessage?.createdAt ?? null,
          lastMessagePreview: lastMessage?.content.slice(0, 120) ?? null,
          activeRunStatus:
            activeRun?.status === "queued" || activeRun?.status === "running"
              ? activeRun.status
              : null,
        };
      })
      .sort((left, right) => (right.lastMessageAt ?? right.createdAt).localeCompare(left.lastMessageAt ?? left.createdAt));
  }

  async getUserProfileStats(userId: string): Promise<UserProfileStatsRecord> {
    const sessions = [...this.sessions.values()].filter((session) => session.userId === userId);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const messages = [...this.messages.values()].flat().filter((message) => sessionIds.has(message.sessionId));
    const runs = [...this.runs.values()].filter((run) => sessionIds.has(run.sessionId));
    const bookOpens = [...this.analyticsEvents.values()].filter((event) =>
      event.userId === userId
      && event.event === "book_open"
      && typeof event.properties.workId === "string"
      && event.properties.workId.trim().length > 0
    );

    const queryStats = sessions.map((session) => {
      const sessionMessages = messages
        .filter((message) => message.sessionId === session.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const userMessages = sessionMessages.filter((message) => message.role === "user");
      const assistantMessages = sessionMessages.filter((message) => message.role === "assistant");
      const citedWorkIds = new Set<string>();
      let citationCount = 0;
      for (const message of assistantMessages) {
        for (const citation of extractMessageCitations(message.metadata)) {
          citationCount += 1;
          citedWorkIds.add(citation.workId);
        }
      }
      const lastActivityAt = [...sessionMessages].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.createdAt ?? session.createdAt;
      return {
        sessionId: session.id,
        sessionTitle: session.title,
        firstUserQuery: userMessages[0]?.content ?? null,
        latestUserQuery: userMessages[userMessages.length - 1]?.content ?? null,
        lastActivityAt,
        userMessageCount: userMessages.length,
        citationCount,
        distinctCitedWorks: citedWorkIds.size,
      };
    }).sort((left, right) => (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""));

    const openCounts = new Map<string, number>();
    const citationCounts = new Map<string, number>();
    const sessionSetsByWork = new Map<string, Set<string>>();
    const lastTouchedAt = new Map<string, string>();
    const activeDays = new Set<string>();

    for (const event of bookOpens) {
      const workId = String(event.properties.workId);
      openCounts.set(workId, (openCounts.get(workId) ?? 0) + 1);
      const sessionId = typeof event.sessionId === "string" ? event.sessionId : `analytics:${event.id}`;
      if (!sessionSetsByWork.has(workId)) {
        sessionSetsByWork.set(workId, new Set());
      }
      sessionSetsByWork.get(workId)!.add(sessionId);
      const currentLastTouched = lastTouchedAt.get(workId);
      if (!currentLastTouched || event.createdAt > currentLastTouched) {
        lastTouchedAt.set(workId, event.createdAt);
      }
      const day = isoDay(event.createdAt);
      if (day) {
        activeDays.add(day);
      }
    }

    for (const message of messages) {
      const day = isoDay(message.createdAt);
      if (day) {
        activeDays.add(day);
      }
      if (message.role !== "assistant") {
        continue;
      }
      for (const citation of extractMessageCitations(message.metadata)) {
        citationCounts.set(citation.workId, (citationCounts.get(citation.workId) ?? 0) + 1);
        if (!sessionSetsByWork.has(citation.workId)) {
          sessionSetsByWork.set(citation.workId, new Set());
        }
        sessionSetsByWork.get(citation.workId)!.add(message.sessionId);
        const currentLastTouched = lastTouchedAt.get(citation.workId);
        if (!currentLastTouched || message.createdAt > currentLastTouched) {
          lastTouchedAt.set(citation.workId, message.createdAt);
        }
      }
    }

    const workIds = [...new Set([
      ...openCounts.keys(),
      ...citationCounts.keys(),
    ])];
    const works = workIds.length > 0 ? await this.getWorkMetadata(workIds) : [];
    const worksById = new Map(works.map((work) => [work.id, work]));
    const allBookStats = buildProfileBookStats(worksById, openCounts, citationCounts, sessionSetsByWork, lastTouchedAt);

    const authorWeights = new Map<string, number>();
    const subjectWeights = new Map<string, number>();
    const languageWeights = new Map<string, number>();
    for (const book of allBookStats) {
      const weight = Math.max(1, book.openCount + book.citationCount + book.sessionCount);
      for (const author of book.work.authors) {
        authorWeights.set(author, (authorWeights.get(author) ?? 0) + weight);
      }
      for (const subject of book.work.subjects) {
        subjectWeights.set(subject, (subjectWeights.get(subject) ?? 0) + weight);
      }
      if (book.work.language) {
        languageWeights.set(book.work.language, (languageWeights.get(book.work.language) ?? 0) + weight);
      }
    }

    const queryCount = queryStats.reduce((total, entry) => total + entry.userMessageCount, 0);
    const citationCount = [...citationCounts.values()].reduce((total, count) => total + count, 0);

    return {
      userId,
      generatedAt: nowIso(),
      counts: {
        sessionCount: sessions.length,
        queryCount,
        runCount: runs.length,
        activeDayCount: activeDays.size,
        booksOpenedCount: bookOpens.length,
        uniqueBooksOpenedCount: openCounts.size,
        uniqueBooksCitedCount: citationCounts.size,
        booksTouchedCount: allBookStats.length,
        citationCount,
      },
      averages: {
        queriesPerSession: sessions.length > 0 ? roundProfileAverage(queryCount / sessions.length) : 0,
        citationsPerQuery: queryCount > 0 ? roundProfileAverage(citationCount / queryCount) : 0,
        booksOpenedPerSession: sessions.length > 0 ? roundProfileAverage(bookOpens.length / sessions.length) : 0,
        booksTouchedPerQuery: queryCount > 0 ? roundProfileAverage(allBookStats.length / queryCount) : 0,
      },
      books: {
        recent: [...allBookStats]
          .sort((left, right) => (right.lastTouchedAt ?? "").localeCompare(left.lastTouchedAt ?? ""))
          .slice(0, 6),
        topOpened: [...allBookStats]
          .sort((left, right) => right.openCount - left.openCount || (right.lastTouchedAt ?? "").localeCompare(left.lastTouchedAt ?? ""))
          .slice(0, 6),
        topCited: [...allBookStats]
          .sort((left, right) => right.citationCount - left.citationCount || (right.lastTouchedAt ?? "").localeCompare(left.lastTouchedAt ?? ""))
          .slice(0, 6),
      },
      fingerprint: {
        authors: topFacetStats(authorWeights),
        subjects: topFacetStats(subjectWeights),
        languages: topFacetStats(languageWeights, 3),
      },
      recentQueries: queryStats.slice(0, 12),
    };
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

  async getLatestPlanMessageForRun(sessionId: string, runId: string): Promise<MessageRecord | null> {
    const messages = this.messages.get(sessionId) ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message.role === "assistant"
        && message.metadata?.phase === "plan"
        && message.metadata?.runId === runId
      ) {
        return message;
      }
    }
    return null;
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

  async appendRunEvent(runId: string, sessionId: string, event: string, dataJson: Record<string, unknown>): Promise<RunEventRecord> {
    const existing = this.runEvents.get(runId) ?? [];
    const record: RunEventRecord = {
      id: crypto.randomUUID(),
      runId,
      sessionId,
      event,
      sequence: existing.length + 1,
      dataJson: structuredClone(dataJson),
      createdAt: nowIso(),
    };
    existing.push(record);
    this.runEvents.set(runId, existing);
    return record;
  }

  async listRunEvents(runId: string): Promise<RunEventRecord[]> {
    return [...(this.runEvents.get(runId) ?? [])];
  }

  async listRecentRunEvents(runId: string, limit: number): Promise<RunEventRecord[]> {
    const events = this.runEvents.get(runId) ?? [];
    return events.slice(Math.max(0, events.length - Math.max(1, limit)));
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

  async listDocuments(offset = 0, limit = 50): Promise<CorpusDocumentRecord[]> {
    const works = await this.listWorks(offset, limit);
    return works.map(mapWorkSummaryToDocument);
  }

  async countDocuments(): Promise<number> {
    return this.countWorks();
  }

  async refreshExploreFeedSnapshot(_limit = 512): Promise<void> {}

  async estimateWorkSetSize(workIds?: string[], filters: PassageSearchFilters = {}): Promise<WorkSetSizeEstimate> {
    const restrictedIds = Array.isArray(workIds)
      ? new Set(workIds)
      : null;
    const eligibleWorks = this.works.filter((work) =>
      (!restrictedIds || restrictedIds.has(work.id))
      && workMatchesSearchFilters(work, filters as Record<string, unknown>),
    );
    const eligibleWorkIds = new Set(eligibleWorks.map((work) => work.id));
    return {
      workCount: eligibleWorks.length,
      totalChunkCount: this.chunks.filter((chunk) => eligibleWorkIds.has(chunk.workId)).length,
      totalTextBytes: eligibleWorks.reduce((sum, work) => sum + (work.text?.length ?? 0), 0),
    };
  }

  async estimateDocumentSetSize(documentIds?: string[], filters: PassageSearchFilters = {}): Promise<WorkSetSizeEstimate> {
    return this.estimateWorkSetSize(documentIds, filters);
  }

  async estimateResearchScope(query: string, filters: PassageSearchFilters = {}): Promise<ResearchScopeEstimate> {
    const probeLimit = isBroadMetadataSurveyQuery(query) ? 12 : 6;
    const probeWorks = await this.searchWorks(query, {
      ...filters,
      limit: probeLimit,
    } as Record<string, unknown>);
    const lexicalProbeQuery = scopeEstimateTerms(query).join(" ");
    const metadataWorkEstimate = [...this.works]
      .filter((work) => workMatchesSearchFilters(work, filters as Record<string, unknown>))
      .filter((work) => {
        const haystack = `${work.title} ${work.summary ?? ""} ${work.authors.join(" ")} ${work.subjects.join(" ")} ${JSON.stringify(work.metadata ?? {})}`;
        return lexicalScore(lexicalProbeQuery, haystack) > 0;
      })
      .length;
    const chunkQueries = scopeEstimateChunkQueries(query);
    const chunkResults = await Promise.all(
      (chunkQueries.length > 0 ? chunkQueries : [query]).map((variant: string) =>
        this.getRelevantChunks(variant, undefined, Math.min(isBroadMetadataSurveyQuery(query) ? 500 : 250, this.chunks.length), undefined, filters),
      ),
    );
    const chunkById = new Map<string, ChunkSearchResult>();
    for (const batch of chunkResults) {
      for (const chunk of batch) {
        if (!chunkById.has(chunk.id)) {
          chunkById.set(chunk.id, chunk);
        }
      }
    }
    const chunks = [...chunkById.values()];
    const chunkMatchEstimate = chunks.length;
    const chunkWorkEstimate = new Set(chunks.map((chunk) => chunk.workId)).size;
    const probeWorkIds = probeWorks.map((work) => work.id);
    const workload = isBroadMetadataSurveyQuery(query)
      ? await this.estimateWorkSetSize(undefined, filters)
      : await this.estimateWorkSetSize(probeWorkIds, filters);
    return buildResearchScopeEstimate(query, metadataWorkEstimate, chunkMatchEstimate, chunkWorkEstimate, probeWorks, {
      scopeMode: isBroadMetadataSurveyQuery(query) ? "corpus_wide" : probeWorkIds.length <= 12 ? "focused" : "subset_wide",
      workCount: workload.workCount,
      totalChunkCount: workload.totalChunkCount,
      totalTextBytes: workload.totalTextBytes,
    });
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

  async getDocumentById(documentId: string): Promise<CorpusDocumentRecord | null> {
    const work = await this.getWorkById(documentId);
    return work ? mapWorkDetailToDocument(work) : null;
  }

  async getWorksByIdPrefixes(prefixes: string[]): Promise<Array<{
    prefix: string;
    work: WorkDetailRecord;
  }>> {
    const normalizedPrefixes = [...new Set(prefixes.map((prefix) => prefix.trim().toLowerCase()).filter(Boolean))];
    const resolved: Array<{ prefix: string; work: WorkDetailRecord }> = [];
    for (const prefix of normalizedPrefixes) {
      const work = this.works.find((candidate) => candidate.id.toLowerCase().startsWith(prefix));
      if (!work) {
        continue;
      }
      resolved.push({
        prefix,
        work: {
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
        },
      });
    }
    return resolved;
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

  async searchDocuments(query: string, filters: Record<string, unknown> = {}): Promise<CorpusDocumentRecord[]> {
    const works = await this.searchWorks(query, filters);
    return works.map(mapWorkSummaryToDocument);
  }

  async getWorkMetadata(workIds: string[]): Promise<WorkSummary[]> {
    const set = new Set(workIds);
    return this.works.filter((work) => set.has(work.id)).map((work) => toWorkSummary(work));
  }

  async getDocumentMetadata(documentIds: string[]): Promise<CorpusDocumentRecord[]> {
    const works = await this.getWorkMetadata(documentIds);
    return works.map(mapWorkSummaryToDocument);
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

  async getRelevantDocumentChunks(
    query: string,
    documentIds?: string[],
    limit = 8,
    embedding?: number[],
    filters: PassageSearchFilters = {},
  ): Promise<CorpusChunkRecord[]> {
    const chunks = await this.getRelevantChunks(query, documentIds, limit, embedding, filters);
    return chunks.map(mapChunkToDocument);
  }

  async getWorkTextFile(workId: string): Promise<WorkTextRecord | null> {
    const work = this.works.find((candidate) => candidate.id === workId);
    return work ? { workId, r2Key: work.cleanTextKey ?? null } : null;
  }

  async getDocumentTextFile(documentId: string): Promise<DocumentTextRecord | null> {
    const record = await this.getWorkTextFile(documentId);
    return record ? { documentId: record.workId, r2Key: record.r2Key } : null;
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

  async getDocumentFiles(documentIds: string[], kinds?: DocumentFileKind[]): Promise<DocumentFileRecord[]> {
    const files = await this.getWorkFiles(documentIds, kinds);
    return files.map(mapWorkFileToDocument);
  }

  async getChunksByIds(chunkIds: string[]): Promise<ChunkSearchResult[]> {
    const set = new Set(chunkIds);
    return this.chunks.filter((chunk) => set.has(chunk.id));
  }

  async getChunkByWorkAndIndex(workId: string, chunkIndex: number): Promise<ChunkSearchResult | null> {
    return this.chunks.find((chunk) => chunk.workId === workId && chunk.chunkIndex === chunkIndex) ?? null;
  }

  async findChunkByWorkAndExcerpt(workId: string, excerpt: string): Promise<ChunkSearchResult | null> {
    const normalizedExcerpt = normalizeExcerptMatchText(excerpt);
    if (!normalizedExcerpt) {
      return null;
    }
    let best: ChunkSearchResult | null = null;
    let bestScore = -1;
    for (const chunk of this.chunks) {
      if (chunk.workId !== workId) {
        continue;
      }
      const score = excerptMatchScore(chunk.text, normalizedExcerpt);
      if (score > bestScore) {
        best = chunk;
        bestScore = score;
      }
    }
    return bestScore > 24 ? best : null;
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
    const existingId = this.notificationsByDedupeKey.get(input.dedupeKey);
    if (existingId) {
      return this.notifications.get(existingId)!;
    }
    const record: NotificationRecord = {
      id: crypto.randomUUID(),
      userId: input.userId,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      toolCallId: input.toolCallId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      dedupeKey: input.dedupeKey,
      metadata: input.metadata ?? {},
      readAt: input.readAt ?? null,
      emailedAt: input.emailedAt ?? null,
      createdAt: input.createdAt ?? nowIso(),
    };
    this.notifications.set(record.id, record);
    this.notificationsByDedupeKey.set(record.dedupeKey, record.id);
    return record;
  }

  async listNotifications(userId: string, options: { limit?: number } = {}): Promise<NotificationRecord[]> {
    const limit = options.limit ?? 100;
    return [...this.notifications.values()]
      .filter((notification) => notification.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async countUnreadNotifications(userId: string): Promise<number> {
    return [...this.notifications.values()].filter((notification) => notification.userId === userId && !notification.readAt).length;
  }

  async markNotificationRead(notificationId: string, userId: string, readAt = nowIso()): Promise<boolean> {
    const record = this.notifications.get(notificationId);
    if (!record || record.userId !== userId) {
      return false;
    }
    this.notifications.set(notificationId, {
      ...record,
      readAt: record.readAt ?? readAt,
    });
    return true;
  }

  async markAllNotificationsRead(userId: string, readAt = nowIso()): Promise<number> {
    let updatedCount = 0;
    for (const [id, record] of this.notifications.entries()) {
      if (record.userId !== userId || record.readAt) {
        continue;
      }
      this.notifications.set(id, {
        ...record,
        readAt,
      });
      updatedCount += 1;
    }
    return updatedCount;
  }

  async updateNotification(
    notificationId: string,
    userId: string,
    updates: Partial<Pick<NotificationRecord, "metadata" | "emailedAt" | "readAt">>,
  ): Promise<void> {
    const record = this.notifications.get(notificationId);
    if (!record || record.userId !== userId) {
      return;
    }
    this.notifications.set(notificationId, {
      ...record,
      metadata: updates.metadata ?? record.metadata,
      emailedAt: updates.emailedAt ?? record.emailedAt,
      readAt: updates.readAt ?? record.readAt,
    });
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
  private exploreFeedSchemaReady: Promise<void> | null = null;
  private runEventsSchemaReady: Promise<void> | null = null;
  private workCountCache: { value: number; expiresAt: number } | null = null;
  private readonly corpusRepository: NeonCorpusDbRepository;
  private readonly adapterId: string | null;
  private readonly feedLabels: {
    summary: string;
    taxonomy: string;
    fallback: string;
  };

  constructor(
    private readonly db: DbClient,
    options: {
      adapterId?: string | null;
      feedLabels?: {
        summary: string;
        taxonomy: string;
        fallback: string;
      };
    } = {},
  ) {
    this.adapterId = options.adapterId ?? null;
    this.feedLabels = options.feedLabels ?? {
      summary: "Worth opening",
      taxonomy: "Browse by shelf",
      fallback: "From the stack",
    };
    this.corpusRepository = new NeonCorpusDbRepository(db, {
      adapterId: this.adapterId,
    });
  }

  private static readonly WORK_COUNT_CACHE_TTL_MS = 1000 * 60 * 5;
  private static readonly WORK_COUNT_STAT_STALE_AFTER_MS = 1000 * 60 * 15;
  private static readonly EXPLORE_FEED_DEFAULT_LIMIT = 512;
  private static readonly RUN_EVENT_INSERT_MAX_ATTEMPTS = 6;

  private hasScopedCorpus() {
    return Boolean(this.adapterId && this.adapterId !== "gutenberg");
  }

  private adapterWorkClause(alias = "w") {
    if (!this.hasScopedCorpus()) {
      return "";
    }
    return ` AND COALESCE(${alias}.metadata_json->>'corpusAdapterId', '') = '${this.adapterId}'`;
  }

  private ensureAnalyticsSchema() {
    if (!this.analyticsSchemaReady) {
      this.analyticsSchemaReady = (async () => {
        await this.db.query(
          `
            CREATE TABLE IF NOT EXISTS analytics_events (
              id uuid PRIMARY KEY,
              event text NOT NULL,
              user_id text REFERENCES users(id) ON DELETE SET NULL,
              session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
              properties_json jsonb NOT NULL DEFAULT '{}'::jsonb,
              created_at timestamptz NOT NULL DEFAULT now()
            )
          `,
        );
        await this.db.query(
          "CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at DESC)",
        );
        await this.db.query(
          "CREATE INDEX IF NOT EXISTS idx_analytics_events_event_created_at ON analytics_events(event, created_at DESC)",
        );
        await this.db.query(
          "CREATE INDEX IF NOT EXISTS idx_analytics_events_session_id ON analytics_events(session_id)",
        );
        await this.db.query(
          "CREATE INDEX IF NOT EXISTS idx_analytics_events_book_open_work_id_created_at ON analytics_events(event, (properties_json->>'workId'), created_at DESC) WHERE properties_json ? 'workId'",
        );
      })();
    }
    return this.analyticsSchemaReady;
  }

  private ensureExploreFeedSchema() {
    if (!this.exploreFeedSchemaReady) {
      this.exploreFeedSchemaReady = (async () => {
        await this.db.query(
          `
            CREATE TABLE IF NOT EXISTS feed_works (
              work_id uuid PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
              rank integer NOT NULL,
              score double precision NOT NULL,
              feed_label text,
              title text NOT NULL,
              gutenberg_id bigint,
              language text,
              release_date date,
              rights_status text,
              summary text,
              metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
              authors text[] NOT NULL DEFAULT ARRAY[]::text[],
              subjects text[] NOT NULL DEFAULT ARRAY[]::text[],
              updated_at timestamptz NOT NULL DEFAULT now()
            )
          `,
        );
        await this.db.query(
          `
            CREATE TABLE IF NOT EXISTS site_stats (
              key text PRIMARY KEY,
              value_json jsonb NOT NULL,
              updated_at timestamptz NOT NULL DEFAULT now()
            )
          `,
        );
        await this.db.query(
          "CREATE INDEX IF NOT EXISTS idx_feed_works_rank ON feed_works(rank)",
        );
      })();
    }
    return this.exploreFeedSchemaReady;
  }

  private ensureRunEventsSchema() {
    if (!this.runEventsSchemaReady) {
      this.runEventsSchemaReady = (async () => {
        await this.db.query(
          `
            CREATE TABLE IF NOT EXISTS run_events (
              id uuid PRIMARY KEY,
              run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
              session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
              sequence integer NOT NULL,
              event text NOT NULL,
              data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
              created_at timestamptz NOT NULL DEFAULT now()
            )
          `,
        );
        await this.db.query(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_id_sequence ON run_events(run_id, sequence)",
        );
        await this.db.query(
          "CREATE INDEX IF NOT EXISTS idx_run_events_run_id_created_at ON run_events(run_id, created_at ASC)",
        );
      })();
    }
    return this.runEventsSchemaReady;
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

  async claimGuestUserData(guestUserId: string, userId: string): Promise<void> {
    if (!guestUserId || !userId || guestUserId === userId) {
      return;
    }
    await this.ensureUser(userId);
    await this.db.query(
      `
        UPDATE chat_sessions
        SET user_id = $2
        WHERE user_id = $1
      `,
      [guestUserId, userId],
    );
    await this.db.query(
      `
        UPDATE billing_events
        SET user_id = $2
        WHERE user_id = $1
      `,
      [guestUserId, userId],
    );
    await this.db.query(
      `
        UPDATE analytics_events
        SET user_id = $2
        WHERE user_id = $1
      `,
      [guestUserId, userId],
    );
    await this.db.query(
      `
        DELETE FROM users
        WHERE id = $1
          AND id <> $2
      `,
      [guestUserId, userId],
    );
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
      active_run_status: "queued" | "running" | null;
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
          )[1] AS last_message_preview,
          (
            ARRAY_AGG(r.status ORDER BY CASE WHEN r.status = 'running' THEN 0 ELSE 1 END, r.started_at DESC)
            FILTER (WHERE r.status IN ('queued', 'running'))
          )[1]::text AS active_run_status
        FROM chat_sessions cs
        LEFT JOIN messages m ON m.session_id = cs.id
        LEFT JOIN runs r ON r.session_id = cs.id
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
      activeRunStatus: row.active_run_status ?? null,
    }));
  }

  async getUserProfileStats(userId: string): Promise<UserProfileStatsRecord> {
    await this.ensureAnalyticsSchema();

    const [summaryResult, queryResult, openResult, citationResult] = await Promise.all([
      this.db.query<{
        session_count: number;
        query_count: number;
        run_count: number;
        active_day_count: number;
      }>(
        `
          WITH active_days AS (
            SELECT DISTINCT m.created_at::date AS day
            FROM messages m
            JOIN chat_sessions cs ON cs.id = m.session_id
            WHERE cs.user_id = $1
            UNION
            SELECT DISTINCT ae.created_at::date AS day
            FROM analytics_events ae
            WHERE ae.user_id = $1 AND ae.event = 'book_open'
          )
          SELECT
            COALESCE((SELECT COUNT(*)::int FROM chat_sessions WHERE user_id = $1), 0) AS session_count,
            COALESCE((
              SELECT COUNT(*)::int
              FROM messages m
              JOIN chat_sessions cs ON cs.id = m.session_id
              WHERE cs.user_id = $1 AND m.role = 'user'
            ), 0) AS query_count,
            COALESCE((
              SELECT COUNT(r.id)::int
              FROM runs r
              JOIN chat_sessions cs ON cs.id = r.session_id
              WHERE cs.user_id = $1
            ), 0) AS run_count,
            COALESCE((SELECT COUNT(*)::int FROM active_days), 0) AS active_day_count
        `,
        [userId],
      ),
      this.db.query<{
        session_id: string;
        session_title: string | null;
        first_user_query: string | null;
        latest_user_query: string | null;
        last_activity_at: string | null;
        user_message_count: number;
        citation_count: number;
        distinct_cited_works: number;
      }>(
        `
          WITH user_sessions AS (
            SELECT id, title, created_at
            FROM chat_sessions
            WHERE user_id = $1
          ),
          message_rollup AS (
            SELECT
              us.id AS session_id,
              us.title AS session_title,
              COALESCE(
                (ARRAY_AGG(m.content ORDER BY m.created_at ASC) FILTER (WHERE m.role = 'user' AND m.id IS NOT NULL))[1],
                NULL
              ) AS first_user_query,
              COALESCE(
                (ARRAY_AGG(m.content ORDER BY m.created_at DESC) FILTER (WHERE m.role = 'user' AND m.id IS NOT NULL))[1],
                NULL
              ) AS latest_user_query,
              COALESCE(MAX(m.created_at)::text, us.created_at::text) AS last_activity_at,
              COUNT(*) FILTER (WHERE m.role = 'user')::int AS user_message_count
            FROM user_sessions us
            LEFT JOIN messages m ON m.session_id = us.id
            GROUP BY us.id, us.title, us.created_at
          ),
          citation_rollup AS (
            SELECT
              m.session_id,
              COUNT(*)::int AS citation_count,
              COUNT(DISTINCT citation.value->>'workId')::int AS distinct_cited_works
            FROM messages m
            JOIN user_sessions us ON us.id = m.session_id
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(m.metadata_json->'citations') = 'array' THEN m.metadata_json->'citations'
                ELSE '[]'::jsonb
              END
            ) AS citation(value)
            WHERE m.role = 'assistant'
              AND COALESCE(citation.value->>'workId', '') <> ''
            GROUP BY m.session_id
          )
          SELECT
            mr.session_id,
            mr.session_title,
            mr.first_user_query,
            mr.latest_user_query,
            mr.last_activity_at,
            mr.user_message_count,
            COALESCE(cr.citation_count, 0) AS citation_count,
            COALESCE(cr.distinct_cited_works, 0) AS distinct_cited_works
          FROM message_rollup mr
          LEFT JOIN citation_rollup cr ON cr.session_id = mr.session_id
          ORDER BY mr.last_activity_at DESC NULLS LAST
          LIMIT 12
        `,
        [userId],
      ),
      this.db.query<{
        work_id: string;
        open_count: number;
        last_touched_at: string;
        session_ids: string[];
      }>(
        `
          SELECT
            properties_json->>'workId' AS work_id,
            COUNT(*)::int AS open_count,
            MAX(created_at)::text AS last_touched_at,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT COALESCE(session_id::text, 'analytics:' || id::text)), NULL) AS session_ids
          FROM analytics_events
          WHERE user_id = $1
            AND event = 'book_open'
            AND properties_json ? 'workId'
            AND COALESCE(properties_json->>'workId', '') <> ''
          GROUP BY properties_json->>'workId'
        `,
        [userId],
      ),
      this.db.query<{
        work_id: string;
        citation_count: number;
        last_touched_at: string;
        session_ids: string[];
      }>(
        `
          WITH user_sessions AS (
            SELECT id
            FROM chat_sessions
            WHERE user_id = $1
          )
          SELECT
            citation.value->>'workId' AS work_id,
            COUNT(*)::int AS citation_count,
            MAX(m.created_at)::text AS last_touched_at,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.session_id::text), NULL) AS session_ids
          FROM messages m
          JOIN user_sessions us ON us.id = m.session_id
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(m.metadata_json->'citations') = 'array' THEN m.metadata_json->'citations'
              ELSE '[]'::jsonb
            END
          ) AS citation(value)
          WHERE m.role = 'assistant'
            AND COALESCE(citation.value->>'workId', '') <> ''
          GROUP BY citation.value->>'workId'
        `,
        [userId],
      ),
    ]);

    const summary = summaryResult.rows[0] ?? {
      session_count: 0,
      query_count: 0,
      run_count: 0,
      active_day_count: 0,
    };

    const openCounts = new Map<string, number>();
    const citationCounts = new Map<string, number>();
    const sessionSetsByWork = new Map<string, Set<string>>();
    const lastTouchedAt = new Map<string, string>();

    for (const row of openResult.rows) {
      openCounts.set(row.work_id, Number(row.open_count ?? 0));
      sessionSetsByWork.set(row.work_id, new Set((row.session_ids ?? []).filter((value): value is string => typeof value === "string" && value.length > 0)));
      lastTouchedAt.set(row.work_id, row.last_touched_at);
    }

    for (const row of citationResult.rows) {
      citationCounts.set(row.work_id, Number(row.citation_count ?? 0));
      const existing = sessionSetsByWork.get(row.work_id) ?? new Set<string>();
      for (const sessionId of row.session_ids ?? []) {
        if (typeof sessionId === "string" && sessionId.length > 0) {
          existing.add(sessionId);
        }
      }
      sessionSetsByWork.set(row.work_id, existing);
      const currentLastTouched = lastTouchedAt.get(row.work_id);
      if (!currentLastTouched || row.last_touched_at > currentLastTouched) {
        lastTouchedAt.set(row.work_id, row.last_touched_at);
      }
    }

    const workIds = [...new Set([...openCounts.keys(), ...citationCounts.keys()])];
    const works = workIds.length > 0 ? await this.getWorkMetadata(workIds) : [];
    const worksById = new Map(works.map((work) => [work.id, work]));
    const allBookStats = buildProfileBookStats(worksById, openCounts, citationCounts, sessionSetsByWork, lastTouchedAt);

    const authorWeights = new Map<string, number>();
    const subjectWeights = new Map<string, number>();
    const languageWeights = new Map<string, number>();
    for (const book of allBookStats) {
      const weight = Math.max(1, book.openCount + book.citationCount + book.sessionCount);
      for (const author of book.work.authors) {
        authorWeights.set(author, (authorWeights.get(author) ?? 0) + weight);
      }
      for (const subject of book.work.subjects) {
        subjectWeights.set(subject, (subjectWeights.get(subject) ?? 0) + weight);
      }
      if (book.work.language) {
        languageWeights.set(book.work.language, (languageWeights.get(book.work.language) ?? 0) + weight);
      }
    }

    const queryCount = Number(summary.query_count ?? 0);
    const sessionCount = Number(summary.session_count ?? 0);
    const totalOpenCount = [...openCounts.values()].reduce((total, count) => total + count, 0);
    const totalCitationCount = [...citationCounts.values()].reduce((total, count) => total + count, 0);

    return {
      userId,
      generatedAt: nowIso(),
      counts: {
        sessionCount,
        queryCount,
        runCount: Number(summary.run_count ?? 0),
        activeDayCount: Number(summary.active_day_count ?? 0),
        booksOpenedCount: totalOpenCount,
        uniqueBooksOpenedCount: openCounts.size,
        uniqueBooksCitedCount: citationCounts.size,
        booksTouchedCount: allBookStats.length,
        citationCount: totalCitationCount,
      },
      averages: {
        queriesPerSession: sessionCount > 0 ? roundProfileAverage(queryCount / sessionCount) : 0,
        citationsPerQuery: queryCount > 0 ? roundProfileAverage(totalCitationCount / queryCount) : 0,
        booksOpenedPerSession: sessionCount > 0 ? roundProfileAverage(totalOpenCount / sessionCount) : 0,
        booksTouchedPerQuery: queryCount > 0 ? roundProfileAverage(allBookStats.length / queryCount) : 0,
      },
      books: {
        recent: [...allBookStats]
          .sort((left, right) => (right.lastTouchedAt ?? "").localeCompare(left.lastTouchedAt ?? ""))
          .slice(0, 6),
        topOpened: [...allBookStats]
          .sort((left, right) => right.openCount - left.openCount || (right.lastTouchedAt ?? "").localeCompare(left.lastTouchedAt ?? ""))
          .slice(0, 6),
        topCited: [...allBookStats]
          .sort((left, right) => right.citationCount - left.citationCount || (right.lastTouchedAt ?? "").localeCompare(left.lastTouchedAt ?? ""))
          .slice(0, 6),
      },
      fingerprint: {
        authors: topFacetStats(authorWeights),
        subjects: topFacetStats(subjectWeights),
        languages: topFacetStats(languageWeights, 3),
      },
      recentQueries: queryResult.rows.map((row) => ({
        sessionId: row.session_id,
        sessionTitle: row.session_title,
        firstUserQuery: row.first_user_query,
        latestUserQuery: row.latest_user_query,
        lastActivityAt: row.last_activity_at,
        userMessageCount: Number(row.user_message_count ?? 0),
        citationCount: Number(row.citation_count ?? 0),
        distinctCitedWorks: Number(row.distinct_cited_works ?? 0),
      })),
    };
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

  async getLatestPlanMessageForRun(sessionId: string, runId: string): Promise<MessageRecord | null> {
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
          AND role = 'assistant'
          AND metadata_json->>'phase' = 'plan'
          AND metadata_json->>'runId' = $2
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [sessionId, runId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      metadata: row.metadata_json,
      createdAt: row.created_at,
    };
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

  async appendRunEvent(runId: string, sessionId: string, event: string, dataJson: Record<string, unknown>): Promise<RunEventRecord> {
    await this.ensureRunEventsSchema();
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    let insertResult: { rows: Array<{ sequence: number }> } | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= NeonAppStore.RUN_EVENT_INSERT_MAX_ATTEMPTS; attempt += 1) {
      try {
        insertResult = await this.db.query<{ sequence: number }>(
          `
            WITH run_lock AS (
              SELECT pg_advisory_xact_lock(
                ('x' || substr(md5($1::text), 1, 16))::bit(64)::bigint
              )
            ),
            next_sequence AS (
              SELECT COALESCE(MAX(sequence), 0)::int + 1 AS sequence
              FROM run_events
              WHERE run_id = $1::uuid
            ),
            inserted AS (
              INSERT INTO run_events (id, run_id, session_id, sequence, event, data_json, created_at)
              SELECT $2::uuid, $1::uuid, $3::uuid, next_sequence.sequence, $4, $5::jsonb, $6::timestamptz
              FROM run_lock, next_sequence
              RETURNING sequence
            )
            SELECT sequence
            FROM inserted
          `,
          [runId, id, sessionId, event, JSON.stringify(dataJson), createdAt],
        );
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error ?? "");
        const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
        const isSequenceConflict =
          code === "23505"
          && /idx_run_events_run_id_sequence/i.test(message);
        if (!isSequenceConflict || attempt === NeonAppStore.RUN_EVENT_INSERT_MAX_ATTEMPTS) {
          throw error;
        }
      }
    }
    if (!insertResult) {
      throw lastError instanceof Error ? lastError : new Error("Run event insert failed.");
    }
    const sequence = Number(insertResult.rows[0]?.sequence ?? 1);
    return {
      id,
      runId,
      sessionId,
      sequence,
      event,
      dataJson,
      createdAt,
    };
  }

  async listRunEvents(runId: string): Promise<RunEventRecord[]> {
    await this.ensureRunEventsSchema();
    const result = await this.db.query<{
      id: string;
      run_id: string;
      session_id: string;
      sequence: number;
      event: string;
      data_json: Record<string, unknown>;
      created_at: string;
    }>(
      `
        SELECT id, run_id, session_id, sequence, event, data_json, created_at
        FROM run_events
        WHERE run_id = $1::uuid
        ORDER BY sequence ASC, created_at ASC
      `,
      [runId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      sequence: Number(row.sequence ?? 0),
      event: row.event,
      dataJson: row.data_json ?? {},
      createdAt: row.created_at,
    }));
  }

  async listRecentRunEvents(runId: string, limit: number): Promise<RunEventRecord[]> {
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit) || 200));
    const result = await this.db.query<{
      id: string;
      run_id: string;
      session_id: string;
      sequence: number;
      event: string;
      data_json: Record<string, unknown>;
      created_at: string;
    }>(
      `
        SELECT id, run_id, session_id, sequence, event, data_json, created_at
        FROM (
          SELECT id, run_id, session_id, sequence, event, data_json, created_at
          FROM run_events
          WHERE run_id = $1::uuid
          ORDER BY sequence DESC
          LIMIT $2
        ) recent
        ORDER BY sequence ASC
      `,
      [runId, safeLimit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      sequence: Number(row.sequence ?? 0),
      event: row.event,
      dataJson: row.data_json ?? {},
      createdAt: row.created_at,
    }));
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
    if (this.hasScopedCorpus()) {
      const fallback = await this.db.query<{
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
            0::float AS score,
            CASE
              WHEN COALESCE(w.summary, '') <> '' THEN $3::text
              WHEN EXISTS (SELECT 1 FROM work_subjects ws_check WHERE ws_check.work_id = w.id) THEN $4::text
              ELSE $5::text
            END AS feed_label
          FROM works w
          LEFT JOIN work_authors wa ON wa.work_id = w.id
          LEFT JOIN authors a ON a.id = wa.author_id
          LEFT JOIN work_subjects ws ON ws.work_id = w.id
          LEFT JOIN subjects s ON s.id = ws.subject_id
          WHERE 1 = 1 ${this.adapterWorkClause("w")}
          GROUP BY
            w.id,
            w.gutenberg_id,
            w.title,
            w.metadata_json,
            w.language,
            w.release_date,
            w.rights_status,
            w.summary
          ORDER BY
            w.release_date DESC NULLS LAST,
            w.title ASC
          OFFSET $1
          LIMIT $2
        `,
        [offset, limit, this.feedLabels.summary, this.feedLabels.taxonomy, this.feedLabels.fallback],
      );

      return fallback.rows.map((row) =>
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

    await this.ensureAnalyticsSchema();
    await this.ensureExploreFeedSchema();
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
        SELECT
          fw.work_id AS id,
          fw.gutenberg_id,
          fw.title,
          fw.metadata_json,
          fw.language,
          fw.release_date::text,
          fw.rights_status,
          fw.summary,
          fw.authors,
          fw.subjects,
          fw.score,
          fw.feed_label
        FROM feed_works fw
        ORDER BY fw.rank ASC
        OFFSET $1
        LIMIT $2
      `,
      [offset, limit],
    );

    if (result.rows.length === 0) {
      const fallback = await this.db.query<{
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
            0::float AS score,
            NULL::text AS feed_label
          FROM works w
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
            w.summary
          ORDER BY
            w.release_date DESC NULLS LAST,
            w.title ASC
          OFFSET $1
          LIMIT $2
        `,
        [offset, limit],
      );

      return fallback.rows.map((row) =>
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
    if (this.hasScopedCorpus()) {
      const fallback = await this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM works w WHERE 1 = 1 ${this.adapterWorkClause("w")}`,
      );
      return Number.parseInt(fallback.rows[0]?.count ?? "0", 10) || 0;
    }
    await this.ensureExploreFeedSchema();
    if (this.workCountCache && this.workCountCache.expiresAt > Date.now()) {
      return this.workCountCache.value;
    }
    const result = await this.db.query<{ value: number | string | null; updated_at: string | Date | null }>(
      `
        SELECT value_json->>'value' AS value, updated_at
        FROM site_stats
        WHERE key = 'work_count'
      `,
    );
    const row = result.rows[0];
    let parsed = Number.parseInt(String(row?.value ?? ""), 10);
    const updatedAtMs = row?.updated_at ? new Date(row.updated_at).getTime() : Number.NaN;
    const statIsFresh = Number.isFinite(updatedAtMs)
      && (Date.now() - updatedAtMs) <= NeonAppStore.WORK_COUNT_STAT_STALE_AFTER_MS;
    if (!Number.isFinite(parsed) || !statIsFresh) {
      const fallback = await this.db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM works");
      parsed = Number.parseInt(fallback.rows[0]?.count ?? "0", 10) || 0;
    }
    this.workCountCache = {
      value: parsed,
      expiresAt: Date.now() + NeonAppStore.WORK_COUNT_CACHE_TTL_MS,
    };
    return parsed;
  }

  async listDocuments(offset = 0, limit = 50): Promise<CorpusDocumentRecord[]> {
    return this.corpusRepository.listDocuments(offset, limit);
  }

  async countDocuments(): Promise<number> {
    return this.corpusRepository.countDocuments();
  }

  async refreshExploreFeedSnapshot(limit = NeonAppStore.EXPLORE_FEED_DEFAULT_LIMIT): Promise<void> {
    await this.ensureAnalyticsSchema();
    await this.ensureExploreFeedSchema();
    const safeLimit = Math.max(24, Math.min(5000, Math.trunc(limit) || NeonAppStore.EXPLORE_FEED_DEFAULT_LIMIT));
    await this.db.query(
      `
        WITH engagement AS (
          SELECT
            properties_json->>'workId' AS work_id,
            COUNT(*) FILTER (WHERE created_at >= now() - interval '3 days')::int AS opens_3d,
            COUNT(*)::int AS opens_14d,
            MAX(created_at) AS last_opened_at
          FROM analytics_events
          WHERE event = 'book_open'
            AND properties_json ? 'workId'
            AND created_at >= now() - interval '14 days'
          GROUP BY properties_json->>'workId'
        ),
        ranked AS (
          SELECT
            w.id AS work_id,
            ROW_NUMBER() OVER (
              ORDER BY
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
                ) DESC,
                COALESCE(e.opens_3d, 0) DESC,
                w.release_date DESC NULLS LAST,
                w.title ASC
            ) AS rank,
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
            END AS feed_label,
            w.title,
            w.gutenberg_id,
            w.language,
            w.release_date,
            w.rights_status,
            w.summary,
            w.metadata_json
          FROM works w
          LEFT JOIN engagement e ON e.work_id = w.id::text
        ),
        limited AS (
          SELECT *
          FROM ranked
          WHERE rank <= $1
        ),
        aggregated AS (
          SELECT
            l.work_id,
            l.rank,
            l.score,
            l.feed_label,
            l.title,
            l.gutenberg_id,
            l.language,
            l.release_date,
            l.rights_status,
            l.summary,
            l.metadata_json,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.name), NULL) AS authors,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.label), NULL) AS subjects
          FROM limited l
          LEFT JOIN work_authors wa ON wa.work_id = l.work_id
          LEFT JOIN authors a ON a.id = wa.author_id
          LEFT JOIN work_subjects ws ON ws.work_id = l.work_id
          LEFT JOIN subjects s ON s.id = ws.subject_id
          GROUP BY
            l.work_id,
            l.rank,
            l.score,
            l.feed_label,
            l.title,
            l.gutenberg_id,
            l.language,
            l.release_date,
            l.rights_status,
            l.summary,
            l.metadata_json
        ),
        replaced AS (
          DELETE FROM feed_works
          WHERE TRUE
        )
        INSERT INTO feed_works (
          work_id,
          rank,
          score,
          feed_label,
          title,
          gutenberg_id,
          language,
          release_date,
          rights_status,
          summary,
          metadata_json,
          authors,
          subjects,
          updated_at
        )
        SELECT
          aggregated.work_id,
          aggregated.rank,
          aggregated.score,
          aggregated.feed_label,
          aggregated.title,
          aggregated.gutenberg_id,
          aggregated.language,
          aggregated.release_date,
          aggregated.rights_status,
          aggregated.summary,
          aggregated.metadata_json,
          aggregated.authors,
          aggregated.subjects,
          now()
        FROM aggregated
        ORDER BY aggregated.rank ASC
      `,
      [safeLimit],
    );
    await this.db.query(
      `
        INSERT INTO site_stats (key, value_json, updated_at)
        VALUES ('work_count', jsonb_build_object('value', (SELECT COUNT(*)::int FROM works)), now())
        ON CONFLICT (key) DO UPDATE
          SET value_json = EXCLUDED.value_json,
              updated_at = EXCLUDED.updated_at
      `,
    );
    this.workCountCache = null;
  }

  async estimateResearchScope(query: string, filters: PassageSearchFilters = {}): Promise<ResearchScopeEstimate> {
    const tsQuery = scopeEstimateTsQuery(query);
    const estimateTerms = scopeEstimateTerms(query);
    const probeLimit = isBroadMetadataSurveyQuery(query) ? 12 : 6;
    const probeWorks = await this.searchWorks(query, {
      ...filters,
      limit: probeLimit,
    } as Record<string, unknown>);
    const startYear = Array.isArray(filters.yearRange) ? Math.min(filters.yearRange[0], filters.yearRange[1]) : null;
    const endYear = Array.isArray(filters.yearRange) ? Math.max(filters.yearRange[0], filters.yearRange[1]) : null;
    const genres = Array.isArray(filters.genre)
      ? filters.genre.map((genre) => genre.trim()).filter((genre) => genre.length > 0).slice(0, 8)
      : [];

    if (!tsQuery && estimateTerms.length === 0) {
      return buildResearchScopeEstimate(query, 0, 0, 0, probeWorks);
    }

    const estimateResult = await withTimeout(this.db.query<{
      metadata_work_estimate: number;
    }>(
      `
        WITH query_input AS (
          SELECT CASE
            WHEN NULLIF($1::text, '') IS NULL THEN NULL
            ELSE to_tsquery('english', $1::text)
          END AS tsq
        ),
        eligible_works AS (
          SELECT w.id, w.title, w.summary, w.metadata_json
          FROM works w
          WHERE ($2::text IS NULL OR w.language = $2::text)
            ${this.adapterWorkClause("w")}
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
            (
              query_input.tsq IS NOT NULL AND
              (
                setweight(to_tsvector('english', COALESCE(ew.title, '')), 'A')
                || setweight(to_tsvector('english', COALESCE(ew.summary, '')), 'B')
                || setweight(to_tsvector('english', COALESCE(ew.metadata_json::text, '')), 'D')
              ) @@ query_input.tsq
            )
            OR EXISTS (
              SELECT 1
              FROM unnest($7::text[]) AS token
              WHERE
                COALESCE(ew.title, '') ILIKE '%' || token || '%'
                OR COALESCE(ew.summary, '') ILIKE '%' || token || '%'
                OR COALESCE(ew.metadata_json::text, '') ILIKE '%' || token || '%'
            )
          )
        )
        SELECT
          metadata_hits.metadata_work_estimate
        FROM metadata_hits
      `,
      [
        tsQuery,
        typeof filters.language === "string" ? filters.language : null,
        typeof filters.rightsStatus === "string" ? filters.rightsStatus : null,
        Number.isInteger(startYear) ? startYear : null,
        Number.isInteger(endYear) ? endYear : null,
        genres,
        estimateTerms,
      ],
    ), 5_000, "Scope estimate timed out before the database returned counts.");

    const row = estimateResult.rows[0] ?? {
      metadata_work_estimate: 0,
    };
    const metadataEstimate = Math.max(Number(row.metadata_work_estimate ?? 0), 0);
    const broadSurvey = isBroadMetadataSurveyQuery(query);
    const chunkWorkEstimate = Math.max(
      0,
      Math.min(metadataEstimate, broadSurvey ? Math.round(metadataEstimate * 0.7) : Math.round(metadataEstimate * 0.5)),
    );
    const chunkMatchEstimate = Math.max(
      0,
      chunkWorkEstimate * (broadSurvey ? 4 : 3),
    );
    const probeWorkIds = probeWorks.map((work) => work.id);
    const workload = broadSurvey
      ? await this.estimateWorkSetSize(undefined, filters)
      : await this.estimateWorkSetSize(probeWorkIds, filters);
    return buildResearchScopeEstimate(
      query,
      metadataEstimate,
      chunkMatchEstimate,
      chunkWorkEstimate,
      probeWorks,
      {
        scopeMode: broadSurvey ? "corpus_wide" : probeWorkIds.length <= 12 ? "focused" : "subset_wide",
        workCount: workload.workCount,
        totalChunkCount: workload.totalChunkCount,
        totalTextBytes: workload.totalTextBytes,
      },
    );
  }

  async estimateWorkSetSize(workIds?: string[], filters: PassageSearchFilters = {}): Promise<WorkSetSizeEstimate> {
    const startYear = Array.isArray(filters.yearRange) ? Math.min(filters.yearRange[0], filters.yearRange[1]) : null;
    const endYear = Array.isArray(filters.yearRange) ? Math.max(filters.yearRange[0], filters.yearRange[1]) : null;
    const genres = Array.isArray(filters.genre)
      ? filters.genre.map((genre) => genre.trim()).filter((genre) => genre.length > 0).slice(0, 8)
      : [];
    const workIdFilter = Array.isArray(workIds) ? workIds : null;
    const result = await withTimeout(this.db.query<{
      work_count: number;
      total_chunk_count: number;
      total_text_bytes: number | string;
    }>(
      `
        WITH eligible_works AS (
          SELECT w.id
          FROM works w
          WHERE ($1::uuid[] IS NULL OR w.id = ANY($1::uuid[]))
            ${this.adapterWorkClause("w")}
            AND ($2::text IS NULL OR w.language = $2::text)
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
        chunk_counts AS (
          SELECT c.work_id, COUNT(*)::int AS chunk_count
          FROM chunks c
          INNER JOIN eligible_works ew ON ew.id = c.work_id
          GROUP BY c.work_id
        ),
        clean_files AS (
          SELECT DISTINCT ON (wf.work_id) wf.work_id, COALESCE(wf.byte_size, 0)::bigint AS byte_size
          FROM work_files wf
          INNER JOIN eligible_works ew ON ew.id = wf.work_id
          WHERE wf.kind = 'clean'
          ORDER BY wf.work_id ASC, wf.created_at DESC
        )
        SELECT
          COUNT(*)::int AS work_count,
          COALESCE(SUM(chunk_counts.chunk_count), 0)::int AS total_chunk_count,
          COALESCE(SUM(clean_files.byte_size), 0)::bigint AS total_text_bytes
        FROM eligible_works ew
        LEFT JOIN chunk_counts ON chunk_counts.work_id = ew.id
        LEFT JOIN clean_files ON clean_files.work_id = ew.id
      `,
      [
        workIdFilter,
        typeof filters.language === "string" ? filters.language : null,
        typeof filters.rightsStatus === "string" ? filters.rightsStatus : null,
        Number.isInteger(startYear) ? startYear : null,
        Number.isInteger(endYear) ? endYear : null,
        genres,
      ],
    ), 5_000, "Scope estimate timed out before the database returned workload stats.");
    const row = result.rows[0];
    return {
      workCount: Math.max(0, Number(row?.work_count ?? 0)),
      totalChunkCount: Math.max(0, Number(row?.total_chunk_count ?? 0)),
      totalTextBytes: Math.max(0, Number(row?.total_text_bytes ?? 0)),
    };
  }

  async estimateDocumentSetSize(documentIds?: string[], filters: PassageSearchFilters = {}): Promise<WorkSetSizeEstimate> {
    return this.estimateWorkSetSize(documentIds, filters);
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
        WHERE w.id = $1::uuid ${this.adapterWorkClause("w")}
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

  async getDocumentById(documentId: string): Promise<CorpusDocumentRecord | null> {
    return this.corpusRepository.getDocumentById(documentId);
  }

  async getWorksByIdPrefixes(prefixes: string[]): Promise<Array<{
    prefix: string;
    work: WorkDetailRecord;
  }>> {
    const normalizedPrefixes = [...new Set(prefixes.map((prefix) => prefix.trim().toLowerCase()).filter(Boolean))];
    const resolved: Array<{ prefix: string; work: WorkDetailRecord }> = [];
    for (const prefix of normalizedPrefixes) {
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
          WHERE LOWER(w.id::text) LIKE $1 ${this.adapterWorkClause("w")}
          GROUP BY w.id, w.gutenberg_id, w.title, w.language, w.release_date, w.rights_status, w.summary, w.metadata_json
          ORDER BY w.id
          LIMIT 1
        `,
        [`${prefix}%`],
      );
      const row = result.rows[0];
      if (!row) {
        continue;
      }
      resolved.push({
        prefix,
        work: {
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
        },
      });
    }
    return resolved;
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
            WHERE 1 = 1 ${this.adapterWorkClause("w")}
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
              ${this.adapterWorkClause("w")}
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

  async searchDocuments(query: string, filters: Record<string, unknown> = {}): Promise<CorpusDocumentRecord[]> {
    const works = await this.searchWorks(query, filters);
    return works.map(mapWorkSummaryToDocument);
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
        WHERE w.id = ANY($1::uuid[]) ${this.adapterWorkClause("w")}
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

  async getDocumentMetadata(documentIds: string[]): Promise<CorpusDocumentRecord[]> {
    return this.corpusRepository.getDocumentMetadata(documentIds);
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
    const tokens = passageSearchTokens(query);
    const tsQuery = tokens.join(" ").trim() || normalizeSearchQuery(query) || query.trim();
    const semanticCandidateLimit = Math.max(limit * 8, 64);
    const lexicalCandidateLimit = Math.min(Math.max(limit * 4, 64), 192);
    const rankedResultLimit = shouldDiversifyChunkResults(query, workIds, limit)
      ? Math.min(Math.max(limit * 3, 96), 256)
      : limit;
    const startYear = Array.isArray(filters.yearRange) ? Math.min(filters.yearRange[0], filters.yearRange[1]) : null;
    const endYear = Array.isArray(filters.yearRange) ? Math.max(filters.yearRange[0], filters.yearRange[1]) : null;
    const genres = Array.isArray(filters.genre)
      ? filters.genre.map((genre) => genre.trim()).filter((genre) => genre.length > 0).slice(0, 8)
      : [];
    const runScopedQuery = async (scopedWorkIds?: string[]) => {
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
            ${this.adapterWorkClause("w")}
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
        ts_candidates AS (
          SELECT c.id
          FROM chunks c
          JOIN eligible_works ew ON ew.id = c.work_id,
          query_input
          WHERE
            query_input.tsq IS NOT NULL
            AND c.tsv @@ query_input.tsq
          ORDER BY ts_rank_cd(c.tsv, query_input.tsq) DESC, c.work_id ASC, c.chunk_index ASC
          LIMIT $12
        ),
        token_candidates AS (
          SELECT c.id
          FROM chunks c
          JOIN eligible_works ew ON ew.id = c.work_id,
          query_input
          WHERE
            query_input.tsq IS NULL
            AND EXISTS (
              SELECT 1
              FROM UNNEST($5::text[]) AS token
              WHERE COALESCE(c.text, '') ILIKE '%' || token || '%'
            )
          ORDER BY c.work_id ASC, c.chunk_index ASC
          LIMIT $12
        ),
        candidate_ids AS (
          SELECT id FROM semantic_candidates
          UNION
          SELECT id FROM ts_candidates
          UNION
          SELECT id FROM token_candidates
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
        scopedWorkIds?.length ? scopedWorkIds : null,
        rankedResultLimit,
        vectorLiteral,
        tokens,
        semanticCandidateLimit,
        typeof filters.language === "string" ? filters.language : null,
        typeof filters.rightsStatus === "string" ? filters.rightsStatus : null,
        Number.isInteger(startYear) ? startYear : null,
        Number.isInteger(endYear) ? endYear : null,
        genres,
        lexicalCandidateLimit,
      ],
    ), PASSAGE_SEARCH_TIMEOUT_MS, "Passage search timed out before the database returned chunks.");
      return result.rows.map((row) => ({
      id: row.id,
      workId: row.work_id,
      chunkIndex: row.chunk_index,
      text: row.text,
      r2Key: row.r2_key,
      score: Number(row.semantic_score ?? 0) + Number(row.token_score ?? 0),
      excerpt: excerpt(row.text, query),
      }));
    };
    const scopedWorkIds = Array.isArray(workIds)
      ? workIds.filter((value): value is string => typeof value === "string")
      : [];
    const batchSize = shouldDiversifyChunkResults(query, scopedWorkIds, limit) ? 12 : 24;
    const batches = scopedWorkIds.length > batchSize
      ? chunkStringArray(scopedWorkIds, batchSize)
      : [scopedWorkIds];
    const batchResults: ChunkSearchResult[][] = [];
    const batchConcurrency = scopedWorkIds.length > batchSize ? 2 : 1;
    for (let index = 0; index < batches.length; index += batchConcurrency) {
      const window = batches.slice(index, index + batchConcurrency);
      const windowResults = await Promise.all(
        window.map((batch: string[]) => runScopedQuery(batch.length > 0 ? batch : undefined)),
      );
      batchResults.push(...windowResults);
    }
    const dedupedRows = new Map<string, ChunkSearchResult>();
    for (const batch of batchResults) {
      for (const row of batch) {
        if (!dedupedRows.has(row.id)) {
          dedupedRows.set(row.id, row);
        }
      }
    }
    const rankedRows = [...dedupedRows.values()].sort((left, right) => right.score - left.score);
    return diversifyChunkResults(query, workIds, rankedRows, limit);
  }

  async getRelevantDocumentChunks(
    query: string,
    documentIds?: string[],
    limit = 8,
    embedding?: number[],
    filters: PassageSearchFilters = {},
  ): Promise<CorpusChunkRecord[]> {
    const chunks = await this.getRelevantChunks(query, documentIds, limit, embedding, filters);
    return chunks.map(mapChunkToDocument);
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

  async getDocumentTextFile(documentId: string): Promise<DocumentTextRecord | null> {
    return this.corpusRepository.getDocumentTextFile(documentId);
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

  async getDocumentFiles(documentIds: string[], kinds?: DocumentFileKind[]): Promise<DocumentFileRecord[]> {
    const files = await this.corpusRepository.getDocumentFiles(documentIds, kinds);
    return files.map((file) => ({
      id: `${file.documentId}:${file.kind}:${file.r2Key}`,
      documentId: file.documentId,
      kind: file.kind as DocumentFileKind,
      r2Key: file.r2Key,
      byteSize: file.byteSize,
      metadata: file.metadata ?? {},
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

  async findChunkByWorkAndExcerpt(workId: string, excerpt: string): Promise<ChunkSearchResult | null> {
    const normalizedExcerpt = normalizeExcerptMatchText(excerpt);
    if (!normalizedExcerpt) {
      return null;
    }
    const tokenNeedles = [...new Set(
      normalizedExcerpt
        .split(" ")
        .filter((token) => token.length >= 5)
        .slice(0, 8),
    )];
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
        WHERE work_id = $1::uuid
        ORDER BY chunk_index ASC
      `,
      [workId],
    );
    let best: ChunkSearchResult | null = null;
    let bestScore = -1;
    for (const row of result.rows) {
      if (
        tokenNeedles.length > 0
        && !tokenNeedles.some((token) => normalizeExcerptMatchText(row.text).includes(token))
      ) {
        continue;
      }
      const score = excerptMatchScore(row.text, normalizedExcerpt);
      if (score > bestScore) {
        bestScore = score;
        best = {
          id: row.id,
          workId: row.work_id,
          chunkIndex: row.chunk_index,
          text: row.text,
          r2Key: row.r2_key,
          score: 0,
          excerpt: row.text.slice(0, 220),
        };
      }
    }
    return bestScore > 24 ? best : null;
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
    const notificationId = crypto.randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    const result = await this.db.query<NotificationRow>(
      `
        INSERT INTO notifications (
          id,
          user_id,
          session_id,
          run_id,
          tool_call_id,
          type,
          title,
          body,
          dedupe_key,
          metadata_json,
          read_at,
          emailed_at,
          created_at
        )
        VALUES (
          $1::uuid,
          $2,
          $3::uuid,
          $4::uuid,
          $5::uuid,
          $6,
          $7,
          $8,
          $9,
          $10::jsonb,
          $11::timestamptz,
          $12::timestamptz,
          $13::timestamptz
        )
        ON CONFLICT (dedupe_key) DO UPDATE
        SET dedupe_key = EXCLUDED.dedupe_key
        RETURNING
          id,
          user_id,
          session_id,
          run_id,
          tool_call_id,
          type,
          title,
          body,
          dedupe_key,
          metadata_json,
          read_at,
          emailed_at,
          created_at
      `,
      [
        notificationId,
        input.userId,
        input.sessionId ?? null,
        input.runId ?? null,
        input.toolCallId ?? null,
        input.type,
        input.title,
        input.body,
        input.dedupeKey,
        JSON.stringify(input.metadata ?? {}),
        input.readAt ?? null,
        input.emailedAt ?? null,
        createdAt,
      ],
    );
    return mapNotificationRow(result.rows[0]);
  }

  async listNotifications(userId: string, options: { limit?: number } = {}): Promise<NotificationRecord[]> {
    const result = await this.db.query<NotificationRow>(
      `
        SELECT
          id,
          user_id,
          session_id,
          run_id,
          tool_call_id,
          type,
          title,
          body,
          dedupe_key,
          metadata_json,
          read_at,
          emailed_at,
          created_at
        FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [userId, options.limit ?? 100],
    );
    return result.rows.map((row) => mapNotificationRow(row));
  }

  async countUnreadNotifications(userId: string): Promise<number> {
    const result = await this.db.query<{ unread_count: number }>(
      `
        SELECT COUNT(*)::int AS unread_count
        FROM notifications
        WHERE user_id = $1
          AND read_at IS NULL
      `,
      [userId],
    );
    return Number(result.rows[0]?.unread_count ?? 0);
  }

  async markNotificationRead(notificationId: string, userId: string, readAt = nowIso()): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `
        UPDATE notifications
        SET read_at = COALESCE(read_at, $3::timestamptz)
        WHERE id = $1::uuid
          AND user_id = $2
        RETURNING id
      `,
      [notificationId, userId, readAt],
    );
    return result.rows.length > 0;
  }

  async markAllNotificationsRead(userId: string, readAt = nowIso()): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      `
        UPDATE notifications
        SET read_at = COALESCE(read_at, $2::timestamptz)
        WHERE user_id = $1
          AND read_at IS NULL
        RETURNING id
      `,
      [userId, readAt],
    );
    return result.rows.length;
  }

  async updateNotification(
    notificationId: string,
    userId: string,
    updates: Partial<Pick<NotificationRecord, "metadata" | "emailedAt" | "readAt">>,
  ): Promise<void> {
    await this.db.query(
      `
        UPDATE notifications
        SET
          metadata_json = COALESCE($3::jsonb, metadata_json),
          emailed_at = COALESCE($4::timestamptz, emailed_at),
          read_at = COALESCE($5::timestamptz, read_at)
        WHERE id = $1::uuid
          AND user_id = $2
      `,
      [
        notificationId,
        userId,
        updates.metadata ? JSON.stringify(updates.metadata) : null,
        updates.emailedAt ?? null,
        updates.readAt ?? null,
      ],
    );
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
