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
import { artifactKeys } from "@alphabook/corpus-core";
import { MemoryBlobStore, type BlobStore } from "./r2";

const PASSAGE_SEARCH_TIMEOUT_MS = 45_000;
const INLINE_PAYLOAD_MAX_BYTES = 4_096;
const INLINE_STRING_MAX_LENGTH = 1_200;
const INLINE_ARRAY_MAX_ITEMS = 12;
const INLINE_OBJECT_MAX_KEYS = 24;

type RetentionClass = "product-critical" | "debug-index" | "debug-blob";

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
  argsRef?: string | null;
  resultRef?: string | null;
  argsSummary?: string | null;
  resultSummary?: string | null;
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
  summaryText?: string | null;
  payloadRef?: string | null;
  phase?: string | null;
  status?: string | null;
  toolCallId?: string | null;
  runtimeId?: string | null;
  retentionClass?: RetentionClass | null;
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
  manifestRef?: string | null;
  taskSpecJson?: Record<string, unknown> | null;
  selectedWorkIds?: string[];
  selectedChunkIds?: string[];
  fileCatalogRef?: string | null;
  researchMode?: string | null;
  shardId?: string | null;
  isAggregator?: boolean;
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
  blobRef?: string | null;
  filename: string;
  mimeType: string;
  byteSize?: number | null;
  summaryText?: string | null;
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

export type SeedWork = WorkSummary & {
  cleanTextKey?: string;
  chunksKey?: string;
  text?: string;
  metadata?: Record<string, unknown>;
};

export type SeedChunk = ChunkSearchResult & {
  embedding?: number[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function jsonByteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function summarizeScalar(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 240) : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
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
    return value.length > INLINE_STRING_MAX_LENGTH
      || value.includes("<html")
      || value.includes("<div")
      || value.includes("<p");
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

function buildInlinePayload(value: Record<string, unknown>): Record<string, unknown> {
  const truncated = truncateInlineValue(value);
  return isPlainRecord(truncated) ? truncated : {};
}

function summarizePayload(value: Record<string, unknown>, fallback: string): string {
  const preferredKeys = [
    "summary",
    "text",
    "message",
    "error",
    "status",
    "label",
    "title",
    "phase",
    "toolName",
  ];
  for (const key of preferredKeys) {
    const summary = summarizeScalar(value[key]);
    if (summary) {
      return summary;
    }
  }
  return fallback;
}

function compactManifest(manifest: Record<string, unknown>): {
  compactManifest: Record<string, unknown>;
  taskSpecJson: Record<string, unknown>;
  selectedWorkIds: string[];
  selectedChunkIds: string[];
  fileCatalog: unknown[];
  researchMode: string | null;
  shardId: string | null;
  isAggregator: boolean;
} {
  const taskContext = isPlainRecord(manifest.taskContext) ? manifest.taskContext : {};
  const documents = Array.isArray(manifest.documents) ? manifest.documents : [];
  const selectedWorkIds = documents
    .map((entry) => {
      if (!isPlainRecord(entry)) {
        return null;
      }
      return typeof entry.documentId === "string"
        ? entry.documentId
        : typeof entry.workId === "string"
          ? entry.workId
          : null;
    })
    .filter((entry): entry is string => typeof entry === "string");
  const selectedChunkIds = Array.isArray(manifest.selectedChunkIds)
    ? manifest.selectedChunkIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  const fileCatalog = Array.isArray(manifest.fileCatalog) ? manifest.fileCatalog : [];
  const taskSpecJson = isPlainRecord(taskContext.taskSpec)
    ? structuredClone(taskContext.taskSpec)
    : taskContext;
  return {
    compactManifest: {
      runtimeId: typeof manifest.runtimeId === "string" ? manifest.runtimeId : null,
      sessionId: typeof manifest.sessionId === "string" ? manifest.sessionId : null,
      selectedWorkIds,
      selectedChunkIds,
      fileCount: fileCatalog.length,
      researchMode: typeof taskContext.researchMode === "string" ? taskContext.researchMode : null,
      shardId: typeof taskContext.shardId === "string" ? taskContext.shardId : null,
      aggregator: taskContext.aggregator === true,
      taskContext: buildInlinePayload(taskContext),
    },
    taskSpecJson,
    selectedWorkIds,
    selectedChunkIds,
    fileCatalog,
    researchMode: typeof taskContext.researchMode === "string" ? taskContext.researchMode : null,
    shardId: typeof taskContext.shardId === "string" ? taskContext.shardId : null,
    isAggregator: taskContext.aggregator === true,
  };
}

async function loadJsonBlob(blobStore: BlobStore, key: string | null | undefined): Promise<Record<string, unknown> | null> {
  if (!key) {
    return null;
  }
  const text = await blobStore.getText(key);
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
    private readonly blobStore: BlobStore = new MemoryBlobStore(),
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
    const toolCallId = crypto.randomUUID();
    const argsRef = shouldSpillPayload(argsJson)
      ? artifactKeys.sessionArtifact(runId, `tool-call-${toolCallId}-args.json`)
      : null;
    if (argsRef) {
      await this.blobStore.putJson(argsRef, argsJson);
    }
    const toolCall: ToolCallRecord = {
      id: toolCallId,
      runId,
      toolName,
      argsJson: argsRef ? buildInlinePayload(argsJson) : structuredClone(argsJson),
      resultJson: null,
      argsRef,
      argsSummary: summarizePayload(argsJson, `${toolName} arguments`),
      status: "running",
      startedAt: nowIso(),
      completedAt: null,
    };
    this.toolCalls.set(toolCall.id, toolCall);
    return toolCall;
  }

  async listToolCalls(runId: string): Promise<ToolCallRecord[]> {
    const toolCalls = [...this.toolCalls.values()]
      .filter((toolCall) => toolCall.runId === runId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    return Promise.all(toolCalls.map(async (toolCall) => ({
      ...toolCall,
      argsJson: toolCall.argsRef ? (await loadJsonBlob(this.blobStore, toolCall.argsRef) ?? toolCall.argsJson) : toolCall.argsJson,
      resultJson: toolCall.resultRef ? (await loadJsonBlob(this.blobStore, toolCall.resultRef) ?? toolCall.resultJson) : toolCall.resultJson,
    })));
  }

  async finishToolCall(toolCallId: string, status: ToolCallRecord["status"], resultJson: Record<string, unknown>): Promise<void> {
    const toolCall = this.toolCalls.get(toolCallId);
    if (!toolCall) {
      return;
    }
    const resultRef = shouldSpillPayload(resultJson)
      ? artifactKeys.sessionArtifact(toolCall.runId, `tool-call-${toolCallId}-result.json`)
      : null;
    if (resultRef) {
      await this.blobStore.putJson(resultRef, resultJson);
    }
    toolCall.status = status;
    toolCall.resultJson = resultRef ? buildInlinePayload(resultJson) : structuredClone(resultJson);
    toolCall.resultRef = resultRef;
    toolCall.resultSummary = summarizePayload(resultJson, `${toolCall.toolName} ${status}`);
    toolCall.completedAt = nowIso();
  }

  async appendRunEvent(runId: string, sessionId: string, event: string, dataJson: Record<string, unknown>): Promise<RunEventRecord> {
    const existing = this.runEvents.get(runId) ?? [];
    const sequence = existing.length + 1;
    const payloadRef = shouldSpillPayload(dataJson)
      ? artifactKeys.sessionArtifact(sessionId, `runs/${runId}/events/${String(sequence).padStart(6, "0")}.json`)
      : null;
    if (payloadRef) {
      await this.blobStore.putJson(payloadRef, dataJson);
    }
    const record: RunEventRecord = {
      id: crypto.randomUUID(),
      runId,
      sessionId,
      event,
      sequence,
      dataJson: payloadRef ? buildInlinePayload(dataJson) : structuredClone(dataJson),
      summaryText: summarizePayload(dataJson, event),
      payloadRef,
      phase: typeof dataJson.phase === "string" ? dataJson.phase : null,
      status: typeof dataJson.status === "string" ? dataJson.status : null,
      toolCallId: typeof dataJson.toolCallId === "string" ? dataJson.toolCallId : null,
      runtimeId: typeof dataJson.runtimeId === "string" ? dataJson.runtimeId : null,
      retentionClass: payloadRef ? "debug-blob" : "debug-index",
      createdAt: nowIso(),
    };
    existing.push(record);
    this.runEvents.set(runId, existing);
    return record;
  }

  async listRunEvents(runId: string): Promise<RunEventRecord[]> {
    return Promise.all((this.runEvents.get(runId) ?? []).map(async (record) => ({
      ...record,
      dataJson: record.payloadRef ? (await loadJsonBlob(this.blobStore, record.payloadRef) ?? record.dataJson) : record.dataJson,
    })));
  }

  async listRecentRunEvents(runId: string, limit: number): Promise<RunEventRecord[]> {
    const events = this.runEvents.get(runId) ?? [];
    return Promise.all(events.slice(Math.max(0, events.length - Math.max(1, limit))).map(async (record) => ({
      ...record,
      dataJson: record.payloadRef ? (await loadJsonBlob(this.blobStore, record.payloadRef) ?? record.dataJson) : record.dataJson,
    })));
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
    const rows = [...this.runtimeInstances.values()]
      .filter((instance) => instance.sessionId === sessionId)
      .sort((left, right) => {
        const leftValue = left.lastUsedAt ?? left.createdAt;
        const rightValue = right.lastUsedAt ?? right.createdAt;
        return rightValue.localeCompare(leftValue);
      });
    return Promise.all(rows.map(async (instance) => ({
      ...instance,
      manifestJson: instance.manifestRef ? (await loadJsonBlob(this.blobStore, instance.manifestRef) ?? instance.manifestJson) : instance.manifestJson,
    })));
  }

  async listExpiredRuntimeInstances(limit = 50): Promise<RuntimeInstanceRecord[]> {
    const rows = [...this.runtimeInstances.values()]
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
    return Promise.all(rows.map(async (instance) => ({
      ...instance,
      manifestJson: instance.manifestRef ? (await loadJsonBlob(this.blobStore, instance.manifestRef) ?? instance.manifestJson) : instance.manifestJson,
    })));
  }

  async getRuntimeInstance(runtimeId: string): Promise<RuntimeInstanceRecord | null> {
    const instance = this.runtimeInstances.get(runtimeId) ?? null;
    if (!instance) {
      return null;
    }
    return {
      ...instance,
      manifestJson: instance.manifestRef ? (await loadJsonBlob(this.blobStore, instance.manifestRef) ?? instance.manifestJson) : instance.manifestJson,
    };
  }

  async saveRuntimeInstance(
    input: Omit<RuntimeInstanceRecord, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): Promise<RuntimeInstanceRecord> {
    const existing = this.runtimeInstances.get(input.runtimeId);
    const manifestRef = artifactKeys.runtimeArtifact(input.runtimeId, "manifest.json");
    await this.blobStore.putJson(manifestRef, input.manifestJson);
    const compact = compactManifest(input.manifestJson);
    const fileCatalogRef = compact.fileCatalog.length > 0
      ? artifactKeys.runtimeArtifact(input.runtimeId, "workspace/file-catalog.json")
      : null;
    if (fileCatalogRef) {
      await this.blobStore.putJson(fileCatalogRef, compact.fileCatalog);
    }
    const record: RuntimeInstanceRecord = {
      id: input.id ?? existing?.id ?? crypto.randomUUID(),
      sessionId: input.sessionId,
      runtimeId: input.runtimeId,
      provider: input.provider,
      providerMachineId: input.providerMachineId,
      status: input.status,
      manifestJson: compact.compactManifest,
      manifestRef,
      taskSpecJson: compact.taskSpecJson,
      selectedWorkIds: compact.selectedWorkIds,
      selectedChunkIds: compact.selectedChunkIds,
      fileCatalogRef,
      researchMode: compact.researchMode,
      shardId: compact.shardId,
      isAggregator: compact.isAggregator,
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
    let next: RuntimeInstanceRecord = {
      ...existing,
      ...updates,
    };
    if (updates.manifestJson) {
      const manifestRef = artifactKeys.runtimeArtifact(runtimeId, "manifest.json");
      await this.blobStore.putJson(manifestRef, updates.manifestJson);
      const compact = compactManifest(updates.manifestJson);
      const fileCatalogRef = compact.fileCatalog.length > 0
        ? artifactKeys.runtimeArtifact(runtimeId, "workspace/file-catalog.json")
        : null;
      if (fileCatalogRef) {
        await this.blobStore.putJson(fileCatalogRef, compact.fileCatalog);
      }
      next = {
        ...next,
        manifestJson: compact.compactManifest,
        manifestRef,
        taskSpecJson: compact.taskSpecJson,
        selectedWorkIds: compact.selectedWorkIds,
        selectedChunkIds: compact.selectedChunkIds,
        fileCatalogRef,
        researchMode: compact.researchMode,
        shardId: compact.shardId,
        isAggregator: compact.isAggregator,
      };
    }
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
      blobRef: input.blobRef ?? input.r2Key,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.byteSize ?? null,
      summaryText: input.summaryText ?? summarizePayload(input.metadata, input.filename),
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
