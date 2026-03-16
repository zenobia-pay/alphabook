import type { DbClient } from "@alphabook/db";
import type { ChunkSearchResult, ToolName, WorkDetail, WorkSummary } from "@alphabook/shared";

export interface SessionRecord {
  id: string;
  userId: string;
  title: string | null;
  createdAt: string;
}

export interface UserRecord {
  id: string;
  email: string | null;
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

export type WorkFileKind = "raw" | "metadata" | "clean" | "chunks";

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
  listUsers(): Promise<AdminUserRecord[]>;
  followUser(followerId: string, followedId: string): Promise<void>;
  unfollowUser(followerId: string, followedId: string): Promise<void>;
  isFollowing(followerId: string, followedId: string): Promise<boolean>;
  createSession(userId: string, title?: string): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listSessions(userId: string): Promise<SessionSummaryRecord[]>;
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  appendMessage(sessionId: string, role: MessageRecord["role"], content: string, metadata?: Record<string, unknown>): Promise<MessageRecord>;
  createRun(sessionId: string): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRuns(sessionId: string): Promise<RunRecord[]>;
  listAllRuns(): Promise<AdminRunRecord[]>;
  updateRun(runId: string, updates: Partial<Pick<RunRecord, "status" | "plannerTurns" | "completedAt">>): Promise<void>;
  startToolCall(runId: string, toolName: ToolName, argsJson: Record<string, unknown>): Promise<ToolCallRecord>;
  listToolCalls(runId: string): Promise<ToolCallRecord[]>;
  finishToolCall(toolCallId: string, status: ToolCallRecord["status"], resultJson: Record<string, unknown>): Promise<void>;
  listWorks(offset?: number, limit?: number): Promise<WorkSummary[]>;
  getWorkById(workId: string): Promise<WorkDetailRecord | null>;
  searchWorks(query: string, filters?: Record<string, unknown>): Promise<WorkSummary[]>;
  getWorkMetadata(workIds: string[]): Promise<WorkSummary[]>;
  getRelevantChunks(query: string, workIds?: string[], limit?: number, embedding?: number[]): Promise<ChunkSearchResult[]>;
  getWorkTextFile(workId: string): Promise<WorkTextRecord | null>;
  getWorkFiles(workIds: string[], kinds?: WorkFileKind[]): Promise<WorkFileRecord[]>;
  getChunksByIds(chunkIds: string[]): Promise<ChunkSearchResult[]>;
  listRuntimeInstances(sessionId: string): Promise<RuntimeInstanceRecord[]>;
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

function toWorkSummary(
  work: Pick<SeedWork, "id" | "gutenbergId" | "title" | "language" | "releaseDate" | "rightsStatus" | "summary" | "authors" | "subjects" | "score" | "metadata">,
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
  };
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

export class InMemoryAppStore implements AppStore {
  private readonly users = new Set<string>();
  private readonly userProfiles = new Map<string, UserRecord>();
  private readonly follows = new Set<string>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  private readonly runtimeInstances = new Map<string, RuntimeInstanceRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();

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
        name: "AlphaBook User",
        avatarUrl: null,
        createdAt: nowIso(),
        followersCount: 0,
        followingCount: 0,
      });
    }
  }

  async upsertUserProfile(input: { id: string; email?: string | null; name?: string | null; avatarUrl?: string | null }): Promise<UserRecord> {
    const existing = this.userProfiles.get(input.id);
    const record: UserRecord = {
      id: input.id,
      email: input.email ?? existing?.email ?? null,
      name: input.name ?? existing?.name ?? "AlphaBook User",
      avatarUrl: input.avatarUrl ?? existing?.avatarUrl ?? null,
      createdAt: existing?.createdAt ?? nowIso(),
      followersCount: existing?.followersCount ?? 0,
      followingCount: existing?.followingCount ?? 0,
    };
    this.users.add(input.id);
    this.userProfiles.set(input.id, record);
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

  async listUsers(): Promise<AdminUserRecord[]> {
    const runsBySession = [...this.runs.values()].reduce((map, run) => {
      map.set(run.sessionId, (map.get(run.sessionId) ?? 0) + 1);
      return map;
    }, new Map<string, number>());

    return [...this.userProfiles.values()]
      .map((profile) => {
        const sessions = [...this.sessions.values()].filter((session) => session.userId === profile.id);
        const sessionIds = new Set(sessions.map((session) => session.id));
        const messages = [...this.messages.values()].flat().filter((message) => sessionIds.has(message.sessionId));
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
        };
      })
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
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
      .sort((left, right) => {
        const leftRelease = left.releaseDate ?? "";
        const rightRelease = right.releaseDate ?? "";
        if (leftRelease !== rightRelease) {
          return rightRelease.localeCompare(leftRelease);
        }
        return left.title.localeCompare(right.title);
      })
      .slice(offset, offset + limit)
      .map((work) => toWorkSummary({ ...work, score: undefined }));
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

  async searchWorks(query: string): Promise<WorkSummary[]> {
    const lexicalQuery = expandedSearchTokens(query).join(" ");
    return [...this.works]
      .map((work) => ({
        ...work,
        score: lexicalScore(
          lexicalQuery,
          `${work.title} ${work.summary ?? ""} ${work.subjects.join(" ")}`,
        ),
      }))
      .filter((work) => (work.score ?? 0) > 0)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, 8)
      .map((work) => toWorkSummary(work));
  }

  async getWorkMetadata(workIds: string[]): Promise<WorkSummary[]> {
    const set = new Set(workIds);
    return this.works.filter((work) => set.has(work.id)).map((work) => toWorkSummary(work));
  }

  async getRelevantChunks(query: string, workIds?: string[], limit = 8, embedding?: number[]): Promise<ChunkSearchResult[]> {
    const set = workIds?.length ? new Set(workIds) : null;
    const lexicalQuery = expandedSearchTokens(query).join(" ");
    return this.chunks
      .filter((chunk) => !set || set.has(chunk.workId))
      .map((chunk) => ({
        ...chunk,
        score:
          lexicalScore(lexicalQuery, chunk.text) +
          (embedding && chunk.embedding ? cosineSimilarity(embedding, chunk.embedding) : 0),
        excerpt: excerpt(chunk.text, lexicalQuery || query),
      }))
      .filter((chunk) => chunk.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
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

  async listRuntimeInstances(sessionId: string): Promise<RuntimeInstanceRecord[]> {
    return [...this.runtimeInstances.values()]
      .filter((instance) => instance.sessionId === sessionId)
      .sort((left, right) => {
        const leftValue = left.lastUsedAt ?? left.createdAt;
        const rightValue = right.lastUsedAt ?? right.createdAt;
        return rightValue.localeCompare(leftValue);
      });
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

  async healthCheck(): Promise<"ok" | "error"> {
    return "ok";
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
  constructor(private readonly db: DbClient) {}

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
      [input.id, input.email ?? null, input.name ?? null, input.avatarUrl ?? null],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
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
      name: row.name,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at,
      followersCount: Number(row.followers_count ?? 0),
      followingCount: Number(row.following_count ?? 0),
    };
  }

  async listUsers(): Promise<AdminUserRecord[]> {
    const result = await this.db.query<{
      id: string;
      email: string | null;
      name: string | null;
      avatar_url: string | null;
      created_at: string;
      session_count: number;
      run_count: number;
      last_seen_at: string | null;
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
          last_seen.last_seen_at
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
          SELECT cs.user_id, MAX(m.created_at)::text AS last_seen_at
          FROM chat_sessions cs
          LEFT JOIN messages m ON m.session_id = cs.id
          GROUP BY cs.user_id
        ) AS last_seen ON last_seen.user_id = u.id
        ORDER BY COALESCE(last_seen.last_seen_at, u.created_at) DESC, u.created_at DESC
      `,
    );
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at,
      followersCount: 0,
      followingCount: 0,
      sessionCount: Number(row.session_count ?? 0),
      runCount: Number(row.run_count ?? 0),
      lastSeenAt: row.last_seen_at,
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
          message_counts.last_message_preview
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
        GROUP BY w.id, w.gutenberg_id, w.title, w.metadata_json, w.language, w.release_date, w.rights_status, w.summary
        ORDER BY w.release_date DESC NULLS LAST, w.title ASC
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
        metadata: row.metadata_json ?? {},
      }),
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
    const limit = Number(filters.limit ?? 8);
    const normalizedQuery = normalizeSearchQuery(query);
    const tsQuery = normalizedQuery || query.trim();
    const tokens = expandedSearchTokens(query);
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
            SELECT websearch_to_tsquery('english', CAST($1 AS text)) AS tsq
          ),
          ranked AS (
            SELECT
              w.id,
              w.gutenberg_id,
              w.title,
              w.metadata_json,
              w.language,
              w.release_date::text,
              w.rights_status,
              w.summary,
              ts_rank_cd(
                setweight(to_tsvector('english', COALESCE(w.title, '')), 'A') ||
                setweight(to_tsvector('english', COALESCE(w.summary, '')), 'B'),
                query_input.tsq
              ) AS score
            FROM works w, query_input
            WHERE
              (
                setweight(to_tsvector('english', COALESCE(w.title, '')), 'A') ||
                setweight(to_tsvector('english', COALESCE(w.summary, '')), 'B')
              ) @@ query_input.tsq
              AND ($2::text IS NULL OR w.language = $2::text)
              AND ($3::text IS NULL OR w.rights_status = $3::text)
          )
          SELECT
            ranked.id,
            ranked.gutenberg_id,
            ranked.title,
            ranked.metadata_json,
            ranked.language,
            ranked.release_date,
            ranked.rights_status,
            ranked.summary,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.name), NULL) AS authors,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.label), NULL) AS subjects,
            ranked.score
          FROM ranked
          LEFT JOIN work_authors wa ON wa.work_id = ranked.id
          LEFT JOIN authors a ON a.id = wa.author_id
          LEFT JOIN work_subjects ws ON ws.work_id = ranked.id
          LEFT JOIN subjects s ON s.id = ws.subject_id
          GROUP BY ranked.id, ranked.gutenberg_id, ranked.title, ranked.metadata_json, ranked.language, ranked.release_date, ranked.rights_status, ranked.summary, ranked.score
          ORDER BY ranked.score DESC, ranked.title ASC
          LIMIT $4
        `,
        [
          tsQuery,
          typeof filters.language === "string" ? filters.language : null,
          typeof filters.rightsStatus === "string" ? filters.rightsStatus : null,
          limit,
        ],
      );
      if (result.rows.length > 0) {
        return mapRows(result.rows);
      }
    } catch {
      // Fall back to simpler token matching if the tsquery path rejects a query shape.
    }

    if (tokens.length === 0) {
      return [];
    }

    const fallbackResult = await this.db.query<{
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
        WITH matches AS (
          SELECT
            w.id,
            w.gutenberg_id,
            w.title,
            w.metadata_json,
            w.language,
            w.release_date::text,
            w.rights_status,
            w.summary,
            COUNT(*)::float AS score
          FROM works w
          LEFT JOIN work_authors wa_seed ON wa_seed.work_id = w.id
          LEFT JOIN authors a_seed ON a_seed.id = wa_seed.author_id
          LEFT JOIN work_subjects ws_seed ON ws_seed.work_id = w.id
          LEFT JOIN subjects s_seed ON s_seed.id = ws_seed.subject_id
          CROSS JOIN UNNEST($3::text[]) AS token
          WHERE
            ($1::text IS NULL OR w.language = $1::text)
            AND ($2::text IS NULL OR w.rights_status = $2::text)
            AND (
              COALESCE(w.title, '') ILIKE '%' || token || '%'
              OR COALESCE(w.summary, '') ILIKE '%' || token || '%'
              OR COALESCE(a_seed.name, '') ILIKE '%' || token || '%'
              OR COALESCE(s_seed.label, '') ILIKE '%' || token || '%'
              OR COALESCE(w.metadata_json::text, '') ILIKE '%' || token || '%'
            )
          GROUP BY w.id, w.gutenberg_id, w.title, w.metadata_json, w.language, w.release_date, w.rights_status, w.summary
        )
        SELECT
          matches.id,
          matches.gutenberg_id,
          matches.title,
          matches.metadata_json,
          matches.language,
          matches.release_date,
          matches.rights_status,
          matches.summary,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.name), NULL) AS authors,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.label), NULL) AS subjects,
          matches.score
        FROM matches
        LEFT JOIN work_authors wa ON wa.work_id = matches.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = matches.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        GROUP BY matches.id, matches.gutenberg_id, matches.title, matches.metadata_json, matches.language, matches.release_date, matches.rights_status, matches.summary, matches.score
        ORDER BY matches.score DESC, matches.title ASC
        LIMIT $4
      `,
      [
        typeof filters.language === "string" ? filters.language : null,
        typeof filters.rightsStatus === "string" ? filters.rightsStatus : null,
        tokens,
        limit,
      ],
    );
    if (fallbackResult.rows.length > 0) {
      return mapRows(fallbackResult.rows);
    }

    const chunkBackedResult = await this.db.query<{
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
        WITH chunk_matches AS (
          SELECT
            c.work_id,
            COUNT(*)::float AS score
          FROM chunks c
          WHERE EXISTS (
            SELECT 1
            FROM UNNEST($3::text[]) AS token
            WHERE COALESCE(c.text, '') ILIKE '%' || token || '%'
          )
          GROUP BY c.work_id
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
          chunk_matches.score
        FROM chunk_matches
        JOIN works w ON w.id = chunk_matches.work_id
        LEFT JOIN work_authors wa ON wa.work_id = w.id
        LEFT JOIN authors a ON a.id = wa.author_id
        LEFT JOIN work_subjects ws ON ws.work_id = w.id
        LEFT JOIN subjects s ON s.id = ws.subject_id
        WHERE
          ($1::text IS NULL OR w.language = $1::text)
          AND ($2::text IS NULL OR w.rights_status = $2::text)
        GROUP BY w.id, w.gutenberg_id, w.title, w.metadata_json, w.language, w.release_date, w.rights_status, w.summary, chunk_matches.score
        ORDER BY chunk_matches.score DESC, w.title ASC
        LIMIT $4
      `,
      [
        typeof filters.language === "string" ? filters.language : null,
        typeof filters.rightsStatus === "string" ? filters.rightsStatus : null,
        tokens,
        limit,
      ],
    );
    return mapRows(chunkBackedResult.rows);
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

  async getRelevantChunks(query: string, workIds?: string[], limit = 8, embedding?: number[]): Promise<ChunkSearchResult[]> {
    const usableEmbedding = embedding?.length === EXPECTED_EMBEDDING_DIMENSIONS ? embedding : undefined;
    const vectorLiteral = usableEmbedding ? `[${usableEmbedding.join(",")}]` : null;
    const normalizedQuery = normalizeSearchQuery(query);
    const tsQuery = normalizedQuery || query.trim();
    const tokens = expandedSearchTokens(query);
    const result = await this.db.query<{
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
          FROM chunks c, query_input
          WHERE
            ($2::uuid[] IS NULL OR c.work_id = ANY($2::uuid[]))
            AND (
              (query_input.tsq IS NOT NULL AND c.tsv @@ query_input.tsq)
              OR (query_input.embedding IS NOT NULL AND c.embedding IS NOT NULL)
              OR EXISTS (
                SELECT 1
                FROM UNNEST($5::text[]) AS token
                WHERE COALESCE(c.text, '') ILIKE '%' || token || '%'
              )
            )
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
      [tsQuery, workIds?.length ? workIds : null, limit, vectorLiteral, tokens],
    );
    return result.rows.map((row) => ({
      id: row.id,
      workId: row.work_id,
      chunkIndex: row.chunk_index,
      text: row.text,
      r2Key: row.r2_key,
      score: Number(row.semantic_score ?? 0) + Number(row.token_score ?? 0),
      excerpt: excerpt(row.text, query),
    }));
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

  async healthCheck(): Promise<"ok" | "error"> {
    try {
      await this.db.query("SELECT 1");
      return "ok";
    } catch {
      return "error";
    }
  }
}
