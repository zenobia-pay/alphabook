import {
  CurrentUserResponseSchema,
  ExploreSemanticSearchResponseSchema,
  FollowProfileResponseSchema,
  MarkAllNotificationsReadResponseSchema,
  MarkNotificationReadResponseSchema,
  MessageListResponseSchema,
  NotificationListResponseSchema,
  PublicProfileResponseSchema,
  SessionListResponseSchema,
  UserProfileStatsResponseSchema,
  WorkDetailResponseSchema,
  WorkListResponseSchema,
  WorkSourceResponseSchema,
  type Citation,
  type ChatSessionSummary,
  type CurrentUserResponse,
  type ExploreSemanticSearchResponse,
  type FollowProfileResponse,
  type MessageRecord,
  type NotificationListResponse,
  type PublicProfileResponse,
  type StreamEvent,
  type UserProfileStats,
  type WorkFacetCounts,
  type WorkDetailResponse,
  type WorkSource,
  type WorkSummary,
} from "@alphabook/shared";

function resolveApiBase() {
  const configured = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "");
  if (configured) {
    return configured;
  }

  return "/api";
}

const API_BASE = resolveApiBase();

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(message: string, status = 0, data: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export type BillingLimitErrorPayload = {
  error?: string;
  code?: string;
  limitUsd?: number;
  spendUsd?: number;
  windowStartedAt?: string;
  paymentRequirements?: unknown;
};

function extractApiErrorText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const looksLikeHtmlDocument = /<!doctype html|<html\b|<head\b|<body\b|<title\b/i.test(trimmed);
  if (looksLikeHtmlDocument) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Fall back to the original text when the response is not JSON.
  }

  const normalized = trimmed.replace(/\s+/g, " ").trim();
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;
}

function humanizeApiErrorText(message: string, fallback: string): string {
  const normalized = message.toLowerCase();

  if (normalized.includes("duplicate key value violates unique constraint") && normalized.includes("users_email_key")) {
    return "We hit an account sync problem while loading this page. Please refresh and try signing in again.";
  }
  if (normalized === "authentication required.") {
    return "Please sign in to continue.";
  }
  if (normalized === "not authorized." || normalized.includes("not authorized")) {
    return "You do not have access to that view.";
  }
  if (
    normalized.includes("worker threw exception")
    || normalized.includes("error 1101")
    || normalized.includes("cloudflare")
    || normalized.includes("please enable cookies")
  ) {
    return "Something went wrong on our side. Please refresh and try again.";
  }

  return message || fallback;
}

export function getErrorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const extracted = extractApiErrorText(error.message);
  if (!extracted) {
    return fallback;
  }
  return humanizeApiErrorText(extracted, fallback);
}

export interface ChatStreamHandlers {
  onEvent: (event: StreamEvent) => void;
}

export type SessionRunRecord = {
  id: string;
  sessionId: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out";
  plannerTurns: number;
  startedAt: string;
  completedAt: string | null;
};

export type BackgroundJobRecord = {
  id: string;
  runId: string;
  sessionId: string;
  provider: "hermes";
  externalJobId: string;
  status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
  phase: string | null;
  detail: string | null;
  progressPct: number | null;
  lastHeartbeatAt: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RunArtifactRecord = {
  id?: string;
  runtimeId?: string | null;
  r2Key?: string;
  filename: string;
  mimeType: string;
  byteSize?: number | null;
  summaryText?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string | null;
  content?: string | null;
};

export type PersistedRunEventRecord = {
  id: string;
  runId: string;
  sessionId: string;
  event: string;
  sequence: number;
  dataJson: Record<string, unknown>;
  createdAt: string;
};

export type RunStateRecord = {
  run?: SessionRunRecord;
  backgroundJob?: BackgroundJobRecord;
  runEvents?: PersistedRunEventRecord[];
  toolTrace?: Array<Record<string, unknown>>;
  artifacts?: RunArtifactRecord[];
};

export type HydratedMessageRecord = MessageRecord & {
  citations: Citation[];
  toolCalls?: Array<Record<string, unknown>>;
};

export type AssistantSessionBootstrapRecord = {
  sessionId: string;
  sessions?: ChatSessionSummary[];
  messages?: HydratedMessageRecord[];
  runs?: SessionRunRecord[];
  runState?: RunStateRecord;
};

async function ensureOk(response: Response): Promise<Response> {
  if (!response.ok) {
    const fallback = response.status >= 500
      ? "Something went wrong on our side. Please try again."
      : "We couldn't complete that request. Please try again.";
    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    throw new ApiError(
      humanizeApiErrorText(extractApiErrorText(raw) ?? "", fallback),
      response.status,
      parsed,
    );
  }
  return response;
}

export async function fetchSessions(userId?: string) {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions${userId ? `?userId=${encodeURIComponent(userId)}` : ""}`, {
      credentials: "include",
    }),
  );
  return SessionListResponseSchema.parse(await response.json()).sessions;
}

export async function fetchMessages(sessionId: string) {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/messages`, {
      credentials: "include",
    }),
  );
  return MessageListResponseSchema.parse(await response.json()).messages.map(hydrateMessage);
}

export async function fetchAssistantSessionBootstrap(sessionId: string): Promise<AssistantSessionBootstrapRecord> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/bootstrap`, {
      credentials: "include",
    }),
  );
  const payload = await response.json() as AssistantSessionBootstrapRecord;
  return {
    ...payload,
    messages: Array.isArray(payload.messages) ? payload.messages.map(hydrateMessage) : [],
    sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
    runs: Array.isArray(payload.runs) ? payload.runs : [],
  };
}

export async function fetchRuns(sessionId: string): Promise<SessionRunRecord[]> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/runs`, {
      credentials: "include",
    }),
  );
  const payload = await response.json() as { runs?: SessionRunRecord[] };
  return Array.isArray(payload.runs) ? payload.runs : [];
}

export async function fetchRunArtifacts(sessionId: string, runId: string): Promise<RunArtifactRecord[]> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/runs/${runId}/logs`, {
      credentials: "include",
    }),
  );
  const payload = await response.json() as { artifacts?: RunArtifactRecord[] };
  return Array.isArray(payload.artifacts) ? payload.artifacts : [];
}

export async function fetchRunState(sessionId: string, runId: string): Promise<RunStateRecord> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/runs/${runId}`, {
      credentials: "include",
    }),
  );
  return await response.json() as RunStateRecord;
}

export async function fetchRunLogs(sessionId: string, runId: string): Promise<Record<string, unknown>> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/runs/${runId}/logs`, {
      credentials: "include",
    }),
  );
  return await response.json() as Record<string, unknown>;
}

export async function fetchRunOutput(sessionId: string, runId: string): Promise<{ runId: string; text: string }> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/runs/${runId}/output`, {
      credentials: "include",
    }),
  );
  return await response.json() as { runId: string; text: string };
}

export async function fetchAssistantDocumentState(sessionId: string, runId: string): Promise<RunStateRecord> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/runs/${runId}/document`, {
      credentials: "include",
    }),
  );
  return await response.json() as RunStateRecord;
}

export async function fetchCurrentUser(): Promise<CurrentUserResponse> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/me`, {
      credentials: "include",
      cache: "no-store",
    }),
  );
  return CurrentUserResponseSchema.parse(await response.json());
}

export async function fetchNotifications(): Promise<NotificationListResponse> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/notifications`, {
      credentials: "include",
    }),
  );
  return NotificationListResponseSchema.parse(await response.json());
}

export async function markNotificationRead(notificationId: string) {
  const response = await ensureOk(
    await fetch(`${API_BASE}/notifications/${encodeURIComponent(notificationId)}/read`, {
      method: "POST",
      credentials: "include",
    }),
  );
  return MarkNotificationReadResponseSchema.parse(await response.json());
}

export async function markAllNotificationsRead() {
  const response = await ensureOk(
    await fetch(`${API_BASE}/notifications/read-all`, {
      method: "POST",
      credentials: "include",
    }),
  );
  return MarkAllNotificationsReadResponseSchema.parse(await response.json());
}

export async function fetchAdminAccess(): Promise<{
  allowed: boolean;
  authenticated: boolean;
  authConfigured: boolean;
  user: CurrentUserResponse["user"];
}> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/admin/access`, {
      credentials: "include",
    }),
  );
  return await response.json();
}

export async function fetchAdminRunLogs(runId: string): Promise<Record<string, unknown>> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/admin/runs/${encodeURIComponent(runId)}/logs`, {
      credentials: "include",
    }),
  );
  return await response.json();
}

export async function fetchAdminUsers(): Promise<Record<string, unknown>[]> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/admin/users`, {
      credentials: "include",
    }),
  );
  const payload = await response.json() as { users?: Record<string, unknown>[] };
  return Array.isArray(payload.users) ? payload.users : [];
}

export async function fetchAdminRuns(): Promise<Record<string, unknown>[]> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/admin/runs`, {
      credentials: "include",
    }),
  );
  const payload = await response.json() as { runs?: Record<string, unknown>[] };
  return Array.isArray(payload.runs) ? payload.runs : [];
}

export async function fetchAdminSessions(): Promise<Record<string, unknown>[]> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/admin/sessions`, {
      credentials: "include",
    }),
  );
  const payload = await response.json() as { sessions?: Record<string, unknown>[] };
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

export async function fetchAdminIncidents(options: {
  days?: number;
  query?: string;
  limit?: number;
  eventLimit?: number;
} = {}): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  params.set("days", String(options.days ?? 7));
  if (options.query?.trim()) {
    params.set("q", options.query.trim());
  }
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.eventLimit !== undefined) {
    params.set("eventLimit", String(options.eventLimit));
  }
  const response = await ensureOk(
    await fetch(`${API_BASE}/admin/incidents?${params.toString()}`, {
      credentials: "include",
    }),
  );
  return await response.json();
}

export async function queryAdminAnalytics(query: string, days = 7): Promise<Record<string, unknown>> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/admin/analytics/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ query, days }),
    }),
  );
  return await response.json();
}

export function sendAnalyticsEvent(
  event: string,
  properties: Record<string, unknown> = {},
  userId?: string | null,
) {
  const payload = JSON.stringify({
    event,
    properties,
    userId: userId ?? null,
  });

  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const blob = new Blob([payload], { type: "application/json" });
    const sent = navigator.sendBeacon(`${API_BASE}/a`, blob);
    if (sent) {
      return;
    }
  }

  void fetch(`${API_BASE}/a`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    credentials: "include",
    keepalive: true,
    body: payload,
  }).catch(() => {});
}

export async function fetchProfile(userId: string): Promise<PublicProfileResponse> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/profiles/${userId}`, {
      credentials: "include",
    }),
  );
  return PublicProfileResponseSchema.parse(await response.json());
}

export async function fetchProfileStats(userId: string, options: { fallbackUserId?: string | null } = {}): Promise<UserProfileStats> {
  const params = new URLSearchParams();
  if (options.fallbackUserId) {
    params.set("userId", options.fallbackUserId);
  }
  const response = await ensureOk(
    await fetch(`${API_BASE}/profiles/${userId}/stats${params.size ? `?${params.toString()}` : ""}`, {
      credentials: "include",
    }),
  );
  return UserProfileStatsResponseSchema.parse(await response.json()).stats;
}

export async function claimGuestProfile(userId: string, guestUserId: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/profiles/${userId}/claim-guest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ guestUserId }),
    }),
  );
}

export async function followProfile(userId: string): Promise<FollowProfileResponse> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/profiles/${userId}/follow`, {
      method: "POST",
      credentials: "include",
    }),
  );
  return FollowProfileResponseSchema.parse(await response.json());
}

export async function unfollowProfile(userId: string): Promise<FollowProfileResponse> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/profiles/${userId}/follow`, {
      method: "DELETE",
      credentials: "include",
    }),
  );
  return FollowProfileResponseSchema.parse(await response.json());
}

export async function fetchWorks(options: {
  offset?: number;
  limit?: number;
  language?: string | null;
  subject?: string | null;
  bookshelf?: string | null;
  randomSeed?: number | null;
} = {}): Promise<{ works: WorkSummary[]; nextOffset: number | null; totalCount: number; facets: WorkFacetCounts }> {
  const params = new URLSearchParams();
  if (options.offset !== undefined) {
    params.set("offset", String(options.offset));
  }
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.language) {
    params.set("language", options.language);
  }
  if (options.subject) {
    params.set("subject", options.subject);
  }
  if (options.bookshelf) {
    params.set("bookshelf", options.bookshelf);
  }
  if (typeof options.randomSeed === "number" && Number.isFinite(options.randomSeed)) {
    params.set("randomSeed", String(options.randomSeed));
  }
  const response = await ensureOk(
    await fetch(`${API_BASE}/works${params.size ? `?${params.toString()}` : ""}`, {
      credentials: "include",
    }),
  );
  const parsed = WorkListResponseSchema.parse(await response.json());
  return {
    ...parsed,
    works: parsed.works.map((work) => ({
      ...work,
      coverImageUrl: work.coverImageUrl ?? (work.hasCoverImage ? `${API_BASE}/works/${work.id}/cover` : null),
    })),
  };
}

export async function fetchExploreSemanticSearch(options: {
  query: string;
  limit?: number;
  language?: string | null;
  subject?: string | null;
  bookshelf?: string | null;
  thinking?: boolean;
  signal?: AbortSignal;
}): Promise<ExploreSemanticSearchResponse> {
  const params = new URLSearchParams();
  params.set("q", options.query);
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.language) {
    params.set("language", options.language);
  }
  if (options.subject) {
    params.set("subject", options.subject);
  }
  if (options.bookshelf) {
    params.set("bookshelf", options.bookshelf);
  }
  if (options.thinking) {
    params.set("thinking", "true");
  }
  const response = await ensureOk(
    await fetch(`${API_BASE}/works/semantic-search?${params.toString()}`, {
      credentials: "include",
      signal: options.signal,
    }),
  );
  const parsed = ExploreSemanticSearchResponseSchema.parse(await response.json());
  return parsed;
}

export async function streamExploreSemanticSearch(
  options: {
    query: string;
    limit?: number;
    language?: string | null;
    subject?: string | null;
    bookshelf?: string | null;
    signal?: AbortSignal;
    onProgress?: (entry: { text: string; detail?: Record<string, unknown> | null }) => void;
  },
): Promise<ExploreSemanticSearchResponse> {
  const params = new URLSearchParams();
  params.set("q", options.query);
  params.set("thinking", "true");
  params.set("stream", "true");
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.language) {
    params.set("language", options.language);
  }
  if (options.subject) {
    params.set("subject", options.subject);
  }
  if (options.bookshelf) {
    params.set("bookshelf", options.bookshelf);
  }
  const response = await ensureOk(
    await fetch(`${API_BASE}/works/semantic-search?${params.toString()}`, {
      credentials: "include",
      signal: options.signal,
      headers: {
        Accept: "text/event-stream",
      },
    }),
  );
  if (!response.body) {
    throw new ApiError("Semantic search stream was empty.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: ExploreSemanticSearchResponse | null = null;
  const nextEventBoundary = () => buffer.search(/\r?\n\r?\n/);

  const processEvent = (chunk: string) => {
    const lines = chunk.split(/\r?\n/);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) {
      return;
    }
    const raw = dataLines.join("\n");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (event === "progress") {
      options.onProgress?.({
        text: typeof parsed.text === "string" ? parsed.text : "Working",
        detail: parsed.detail && typeof parsed.detail === "object" ? parsed.detail as Record<string, unknown> : null,
      });
      return;
    }
    if (event === "result") {
      finalResult = ExploreSemanticSearchResponseSchema.parse(parsed);
      return;
    }
    if (event === "error") {
      throw new ApiError(typeof parsed.message === "string" ? parsed.message : "Semantic search stream failed.");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary = nextEventBoundary();
    while (boundary >= 0) {
      const eventChunk = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/);
      buffer = buffer.slice(boundary + (separator?.[0].length ?? 2));
      if (eventChunk.trim().length > 0) {
        processEvent(eventChunk);
      }
      boundary = nextEventBoundary();
    }
    if (done) {
      break;
    }
  }
  if (buffer.trim().length > 0) {
    processEvent(buffer);
  }
  if (!finalResult) {
    throw new ApiError("Semantic search stream finished without a result.");
  }
  return finalResult;
}

export async function fetchWorkDetail(workId: string): Promise<WorkDetailResponse> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/works/${workId}`, {
      credentials: "include",
    }),
  );
  const parsed = WorkDetailResponseSchema.parse(await response.json());
  return {
    ...parsed,
    work: {
      ...parsed.work,
      coverImageUrl: parsed.work.coverImageUrl ?? (parsed.work.hasCoverImage ? `${API_BASE}/works/${parsed.work.id}/cover` : null),
    },
  };
}

export async function fetchWorkSource(workId: string): Promise<WorkSource | null> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/works/${workId}/source`, {
      credentials: "include",
    }),
  );
  const parsed = WorkSourceResponseSchema.parse(await response.json());
  return parsed.source;
}

export function buildSignInUrl(returnTo: string) {
  return `${API_BASE}/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
}

export function buildSignUpUrl(returnTo: string) {
  return `${API_BASE}/auth/sign-up?returnTo=${encodeURIComponent(returnTo)}`;
}

export function buildSignOutUrl(returnTo: string) {
  return `${API_BASE}/auth/sign-out?returnTo=${encodeURIComponent(returnTo)}`;
}

function hydrateMessage(message: MessageRecord) {
  return {
    ...message,
    citations: Array.isArray(message.metadata.citations) ? (message.metadata.citations as Citation[]) : [],
    toolCalls: Array.isArray(message.metadata.toolCalls)
      ? (message.metadata.toolCalls as Array<Record<string, unknown>>)
      : [],
  };
}

export async function streamChat(
  payload: {
    userId?: string;
    sessionId?: string;
    message: string;
    workIds?: string[];
    mode?: "semantic" | "comprehensive" | "agentic";
    workflow?: "auto" | "search" | "design_experiment";
    intensityOverride?: "normal" | "high" | "maximum";
    researchMode?: "default" | "sprite_fanout";
    semanticBackend?: "alphaloop" | "context1";
  },
  handlers: ChatStreamHandlers,
  options: {
    signal?: AbortSignal;
  } = {},
) {
  const response = await ensureOk(
    await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(payload),
      signal: options.signal,
    }),
  );

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response stream was not available.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const eventName = rawEvent
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.replace("event:", "")
        .trim();
      const dataLine = rawEvent
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.replace("data:", "")
        .trim();

      if (!eventName || !dataLine) {
        continue;
      }

      handlers.onEvent({
        event: eventName,
        data: JSON.parse(dataLine) as Record<string, unknown>,
      });
    }
  }
}

export async function streamRun(
  sessionId: string,
  runId: string,
  handlers: ChatStreamHandlers,
  options: {
    signal?: AbortSignal;
  } = {},
) {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/stream`, {
      method: "GET",
      credentials: "include",
      signal: options.signal,
    }),
  );

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Run stream was not available.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const eventName = rawEvent
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.replace("event:", "")
        .trim();
      const dataLine = rawEvent
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.replace("data:", "")
        .trim();

      if (!eventName || !dataLine) {
        continue;
      }

      handlers.onEvent({
        event: eventName,
        data: JSON.parse(dataLine) as Record<string, unknown>,
      });
    }
  }
}

export async function cancelRun(runId: string) {
  const response = await ensureOk(
    await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      credentials: "include",
    }),
  );
  return await response.json();
}
