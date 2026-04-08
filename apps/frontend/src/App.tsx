import { Component, createContext, type ComponentType, type CSSProperties, type ErrorInfo, type FormEvent, type ReactNode, type UIEvent, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReadonlyJSONObject, ReadonlyJSONValue } from "assistant-stream/utils";
import type { AgentationProps } from "agentation";
import { ChevronsLeft, ChevronsRight, Dices, Funnel, Link2, LoaderCircle, MessageSquarePlus, X } from "lucide-react";

import { ChatSessionSummarySchema, getToolLabel, type ChatSessionSummary, type Citation, type MessageRecord, type NotificationRecord, type ProfileBookStat, type ProfileFacetStat, type ProfileQueryStat, type PublicProfileResponse, type UserProfile, type UserProfileStats, type WorkDetail, type WorkFacetCounts, type WorkSource, type WorkSummary } from "@alphabook/shared";

import { ApiError, buildSignInUrl, buildSignOutUrl, cancelRun, claimGuestProfile, fetchAdminAccess, fetchAdminIncidents, fetchAdminRunLogs, fetchAdminRuns, fetchAdminSessions, fetchAdminUsers, fetchAssistantDocumentState, fetchAssistantSessionBootstrap, fetchCurrentUser, fetchExploreSemanticSearch, fetchMessages, fetchNotifications, fetchProfile, fetchProfileStats, fetchRunState, fetchRuns, fetchSessions, fetchWorkDetail, fetchWorks, fetchWorkSource, followProfile, getErrorMessage, markNotificationRead, queryAdminAnalytics, sendAnalyticsEvent, streamChat, streamRun, unfollowProfile, type BillingLimitErrorPayload, type PersistedRunEventRecord, type RunArtifactRecord, type RunStateRecord, type SessionRunRecord } from "./api";
import type { AssistantSurfaceProps } from "./components/assistant-surface";
import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";
import { Skeleton } from "./components/ui/skeleton";
import { resolveFrontendImplementation } from "./implementation";
import { cn } from "./lib/utils";

type UiMessage = MessageRecord & {
  citations: Citation[];
  toolCalls: ToolTraceEntry[];
};

type RawUiMessage = MessageRecord & {
  citations: Citation[];
  toolCalls?: Array<Record<string, unknown>>;
};

type ToolTraceEntry = {
  id: string;
  toolName: string;
  label: string;
  rationale?: string;
  progress: string[];
  progressDetails?: Array<Record<string, unknown>>;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  isError?: boolean;
  state: "running" | "completed" | "error";
};

type AssistantDocumentBootstrapPayload = {
  sessionId: string;
  runId: string;
  sessionTitle?: string;
  messages?: RawUiMessage[];
  runState?: {
    run?: SessionRunRecord;
    runEvents?: PersistedRunEventRecord[];
    toolTrace?: Array<Record<string, unknown>>;
    artifacts?: RunArtifactRecord[];
  };
  error?: string;
  errorStatus?: number;
};

type AssistantSessionBootstrapPayload = {
  sessionId: string;
  sessions?: ChatSessionSummary[];
  messages?: RawUiMessage[];
  runs?: SessionRunRecord[];
  runState?: {
    run?: SessionRunRecord;
    runEvents?: PersistedRunEventRecord[];
    toolTrace?: Array<Record<string, unknown>>;
    artifacts?: RunArtifactRecord[];
  };
  error?: string;
  errorStatus?: number;
};

type WorkPageBootstrapPayload = {
  workId: string;
  work?: WorkDetail;
  source?: WorkSource | null;
  error?: string;
  errorStatus?: number;
};

type ResearchDocumentEntryKind = "title" | "log" | "book" | "chunk";

type CitationNavigationContextValue = {
  openCitation: (citation: Citation) => void;
  activeWorkId: string | null | undefined;
};

type AuthState = {
  loading: boolean;
  authConfigured: boolean;
  user: UserProfile | null;
  error: string | null;
};

type ViewMode = "explore" | "assistant" | "assistant_document" | "profile" | "book" | "admin";
type UrlWriteMode = "replace" | "push";
type UrlState = {
  view: ViewMode;
  sessionId: string | null | undefined;
  workId: string | null | undefined;
  readerPath: string | null | undefined;
  chunkId: string | null | undefined;
  passageId: string | null | undefined;
  profileUserId: string | null | undefined;
  runId: string | null | undefined;
  adminSection: "runs" | "users" | "analytics" | "incidents" | "logs";
  debugEnabled: boolean;
  exploreFilters: ExploreFilterState;
  exploreRandomSeed: number | null;
  exploreQuery: string;
};

type AdminAccessState = {
  loading: boolean;
  allowed: boolean;
  authenticated: boolean;
  authConfigured: boolean;
  user: UserProfile | null;
};

type AdminRunLogState = {
  loading: boolean;
  error: string | null;
  runId: string;
  payload: Record<string, unknown> | null;
};

type AdminTableState = {
  loading: boolean;
  error: string | null;
  rows: Record<string, unknown>[];
};

type AdminAnalyticsState = {
  loading: boolean;
  error: string | null;
  draft: string;
  query: string;
  payload: Record<string, unknown> | null;
};

type AdminIncidentsState = {
  loading: boolean;
  error: string | null;
  query: string;
  days: number;
  selectedFingerprint: string | null;
  payload: Record<string, unknown> | null;
};

type NotificationsState = {
  loading: boolean;
  error: string | null;
  notifications: NotificationRecord[];
  unreadCount: number;
};

type ThreadSuggestion = {
  icon?: "search" | "heart";
  title: string;
  description?: string;
  prompt: string;
};

type ExploreFilterState = {
  language: string;
  subject: string;
  bookshelf: string;
};

type ReaderPassageKind = "heading" | "paragraph" | "quote" | "list-item" | "preformatted";

type ReaderPassage = {
  id: string;
  kind: ReaderPassageKind;
  text: string;
  searchText: string;
};

type OverlayContentsEntry = {
  id: string;
  label: string;
};

type BillingLimitState = {
  limitUsd: number | null;
  spendUsd: number | null;
  windowStartedAt: string | null;
};

declare global {
  interface Window {
    __ALPHABOOK_ASSISTANT_DOCUMENT_BOOTSTRAP__?: AssistantDocumentBootstrapPayload;
    __ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__?: AssistantSessionBootstrapPayload;
    __ALPHABOOK_WORK_PAGE_BOOTSTRAP__?: WorkPageBootstrapPayload;
  }
}

const USER_STORAGE_KEY = "alphabook.localUserId";
const RECENT_SESSIONS_STORAGE_KEY = "alphabook.recentSessions";
const IMPLEMENTATION = resolveFrontendImplementation();
const IMPLEMENTATION_ID = IMPLEMENTATION.id;
const PRODUCT_NAME = IMPLEMENTATION.productName;
const DEFAULT_READER_NAME = IMPLEMENTATION.defaultReaderName;
const SEO_SITE_NAME = IMPLEMENTATION.siteName;
const SEO_SITE_ORIGIN = IMPLEMENTATION.siteOrigin;
const BOOK_CONTENT_ORIGIN = IMPLEMENTATION.contentOrigin;
const BOOK_CONTENT_VERSION = "20260326g";
const DEFAULT_SEO_DESCRIPTION = IMPLEMENTATION.siteDescription;
const DEFAULT_OG_IMAGE_PATH = "/social-card.svg";
const CORPUS_LABEL_PLURAL = IMPLEMENTATION.corpusLabelPlural;
const EXPLORE_PLACEHOLDER = IMPLEMENTATION.explorePlaceholder;
const WORDMARK = SEO_SITE_NAME;
const WORDMARK_MONOGRAM = `${WORDMARK
  .split(/\s+/u)
  .map((part) => part[0]?.toLowerCase() ?? "")
  .join("")
  .slice(0, 2)}.`;
const EMPTY_WORK_FACETS: WorkFacetCounts = {
  languages: [],
  subjects: [],
  bookshelves: [],
};
const DEFAULT_EXPLORE_FILTERS: ExploreFilterState = {
  language: "all",
  subject: "all",
  bookshelf: "all",
};
const EXPLORE_PAGE_SIZE = 24;
const GUEST_CLAIM_STORAGE_PREFIX = `${IMPLEMENTATION_ID}:guest-claimed:`;
const LANGUAGE_DISPLAY_NAMES = typeof Intl !== "undefined"
  ? new Intl.DisplayNames(["en"], { type: "language" })
  : null;

type SeoDocumentState = {
  title: string;
  description: string;
  canonicalPath: string;
  robots: string;
  ogType: "website" | "book" | "profile";
  jsonLd: Record<string, unknown>;
};

function upsertMetaTag(attribute: "name" | "property", key: string, content: string) {
  if (typeof document === "undefined") {
    return;
  }
  let element = document.head.querySelector(`meta[${attribute}="${key}"]`);
  if (!(element instanceof HTMLMetaElement)) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.setAttribute("content", content);
}

function upsertLinkTag(rel: string, href: string) {
  if (typeof document === "undefined") {
    return;
  }
  let element = document.head.querySelector(`link[rel="${rel}"]`);
  if (!(element instanceof HTMLLinkElement)) {
    element = document.createElement("link");
    element.setAttribute("rel", rel);
    document.head.appendChild(element);
  }
  element.setAttribute("href", href);
}

function upsertJsonLdScript(id: string, payload: Record<string, unknown>) {
  if (typeof document === "undefined") {
    return;
  }
  let element = document.head.querySelector(`#${id}`) as HTMLScriptElement | null;
  if (!(element instanceof HTMLScriptElement)) {
    element = document.createElement("script");
    element.id = id;
    element.type = "application/ld+json";
    document.head.appendChild(element);
  }
  element.textContent = JSON.stringify(payload);
}

function buildSeoState(options: {
  activeView: ViewMode;
  activeWork: WorkDetail | null;
  activeWorkId: string | null | undefined;
  activeProfileUserId: string | null | undefined;
  publicProfile: PublicProfileResponse | null;
}) {
  const { activeView, activeWork, activeWorkId, activeProfileUserId, publicProfile } = options;

  if (activeView === "book" && activeWork && activeWorkId) {
    const authors = activeWork.authors.filter((author) => author.trim().length > 0);
    const summary = activeWork.summary?.trim();
    const descriptionParts = [
      authors.length > 0 ? `Read ${activeWork.title} by ${authors.join(", ")}.` : `Read ${activeWork.title}.`,
      summary || "Open the text, jump to passages, and ask grounded questions with citations.",
    ];
    return {
      title: `${activeWork.title} | ${SEO_SITE_NAME}`,
      description: descriptionParts.join(" "),
      canonicalPath: `/works/${encodeURIComponent(activeWorkId)}`,
      robots: "index, follow",
      ogType: "book" as const,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "Book",
        name: activeWork.title,
        author: authors.map((author) => ({
          "@type": "Person",
          name: author,
        })),
        inLanguage: activeWork.language ?? undefined,
        description: summary ?? DEFAULT_SEO_DESCRIPTION,
        url: `${SEO_SITE_ORIGIN}/works/${encodeURIComponent(activeWorkId)}`,
      },
    };
  }

  if (activeView === "profile" && activeProfileUserId) {
    const profileName = publicProfile?.profile.name?.trim() || "Reader profile";
    const handle = publicProfile?.profile.handle?.trim();
    return {
      title: `${profileName} | ${SEO_SITE_NAME}`,
      description: handle
        ? `See ${profileName}'s reading trail, saved research, and public bookshelf activity on alpha book.`
        : `See ${profileName}'s reading trail, saved research, and public bookshelf activity.`,
      canonicalPath: `/u/${encodeURIComponent(activeProfileUserId)}`,
      robots: "index, follow",
      ogType: "profile" as const,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        name: profileName,
        url: `${SEO_SITE_ORIGIN}/u/${encodeURIComponent(activeProfileUserId)}`,
        mainEntity: {
          "@type": "Person",
          name: profileName,
          alternateName: handle || undefined,
        },
      },
    };
  }

  if (activeView === "admin") {
    return {
      title: SEO_SITE_NAME,
      description: DEFAULT_SEO_DESCRIPTION,
      canonicalPath: "/",
      robots: "noindex, nofollow",
      ogType: "website" as const,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: SEO_SITE_NAME,
        description: DEFAULT_SEO_DESCRIPTION,
        url: SEO_SITE_ORIGIN,
      },
    };
  }

  const exploreDescription =
    activeView === "explore"
      ? "Browse the catalog, open full texts, and launch cited questions across the library."
      : DEFAULT_SEO_DESCRIPTION;
  return {
    title: SEO_SITE_NAME,
    description: exploreDescription,
    canonicalPath: "/",
    robots: "index, follow",
    ogType: "website" as const,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SEO_SITE_NAME,
      description: exploreDescription,
      url: SEO_SITE_ORIGIN,
      potentialAction: {
        "@type": "SearchAction",
        target: `${SEO_SITE_ORIGIN}/?view=explore`,
        "query-input": "required name=search_term_string",
      },
    },
  };
}

function isViewMode(value: string | null): value is ViewMode {
  return value === "explore" || value === "assistant" || value === "assistant_document" || value === "profile" || value === "book" || value === "admin";
}

function isRetryableReconnectError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 0 || error.status >= 500;
  }
  return !(error instanceof Error) || error.name !== "AbortError";
}

function readUrlState(): UrlState {
  if (typeof window === "undefined") {
    return {
      view: "assistant",
      sessionId: undefined,
      workId: undefined,
      readerPath: undefined,
      chunkId: undefined,
      passageId: undefined,
      profileUserId: undefined,
      runId: undefined,
      adminSection: "runs",
      debugEnabled: false,
      exploreFilters: DEFAULT_EXPLORE_FILTERS,
      exploreRandomSeed: null,
      exploreQuery: "",
    };
  }

  const pathnameMatch = window.location.pathname.match(/^\/works\/([^/]+)$/);
  const profilePathMatch = window.location.pathname.match(/^\/u\/([^/]+)$/);
  const pathnameView = window.location.pathname === "/explore"
    ? "explore"
    : window.location.pathname === "/profile"
      ? "profile"
      : null;
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get("view");
  const resolvedView = rawView === "library" ? "explore" : rawView;
  const rawExploreSeed = params.get("exploreSeed");
  const parsedExploreSeed = rawExploreSeed ? Number.parseInt(rawExploreSeed, 10) : Number.NaN;
  return {
    view: pathnameMatch ? "book" : profilePathMatch ? "profile" : pathnameView ?? (isViewMode(resolvedView) ? resolvedView : "assistant"),
    sessionId: params.has("session") ? params.get("session") || null : undefined,
    workId: pathnameMatch ? decodeURIComponent(pathnameMatch[1]) : params.has("work") ? params.get("work") || null : undefined,
    readerPath: params.has("reader") ? params.get("reader") || null : undefined,
    chunkId: params.has("chunk") ? params.get("chunk") || null : undefined,
    passageId: window.location.hash ? decodeURIComponent(window.location.hash.replace(/^#/, "").trim()) || null : undefined,
    profileUserId: profilePathMatch ? decodeURIComponent(profilePathMatch[1]) : params.has("profile") ? params.get("profile") || null : undefined,
    runId: params.has("run") ? params.get("run") || null : undefined,
    adminSection:
      params.get("adminSection") === "users" || params.get("adminSection") === "analytics" || params.get("adminSection") === "incidents" || params.get("adminSection") === "logs"
        ? params.get("adminSection") as "users" | "analytics" | "incidents" | "logs"
        : params.has("run")
          ? "logs"
          : "runs",
    debugEnabled: params.get("debug") === "true",
    exploreFilters: {
      language: params.get("exploreLanguage") || DEFAULT_EXPLORE_FILTERS.language,
      subject: params.get("exploreSubject") || DEFAULT_EXPLORE_FILTERS.subject,
      bookshelf: params.get("exploreBookshelf") || DEFAULT_EXPLORE_FILTERS.bookshelf,
    },
    exploreRandomSeed: Number.isInteger(parsedExploreSeed) && parsedExploreSeed > 0 ? parsedExploreSeed : null,
    exploreQuery: params.get("exploreQuery")?.trim() ?? "",
  };
}

function writeUrlState(next: UrlState, mode: UrlWriteMode = "replace") {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  if (next.view === "assistant_document" && next.sessionId && next.runId) {
    url.pathname = "/";
    url.searchParams.set("view", "assistant_document");
    url.searchParams.delete("work");
    url.searchParams.delete("profile");
    url.searchParams.delete("reader");
  } else if (next.view === "book" && next.workId) {
    url.pathname = `/works/${encodeURIComponent(next.workId)}`;
    url.searchParams.delete("view");
    url.searchParams.delete("work");
    url.searchParams.delete("profile");
  } else if (next.view === "profile" && next.profileUserId) {
    url.pathname = `/u/${encodeURIComponent(next.profileUserId)}`;
    url.searchParams.delete("view");
    url.searchParams.delete("work");
    url.searchParams.delete("profile");
  } else {
    url.pathname = "/";
    url.searchParams.set("view", next.view);
    url.searchParams.delete("work");
    if (next.profileUserId) {
      url.searchParams.set("profile", next.profileUserId);
    } else {
      url.searchParams.delete("profile");
    }
  }
  if ((next.view === "admin" || next.view === "assistant_document") && next.runId) {
    url.searchParams.set("run", next.runId);
  } else {
    url.searchParams.delete("run");
  }
  if (next.view === "admin") {
    url.searchParams.set("adminSection", next.adminSection);
  } else {
    url.searchParams.delete("adminSection");
  }

  if ((next.view === "assistant" || next.view === "assistant_document" || next.view === "book") && next.sessionId) {
    url.searchParams.set("session", next.sessionId);
  } else {
    url.searchParams.delete("session");
  }
  if (next.workId && next.readerPath) {
    url.searchParams.set("reader", next.readerPath);
  } else {
    url.searchParams.delete("reader");
  }
  if (next.workId && next.chunkId) {
    url.searchParams.set("chunk", next.chunkId);
  } else {
    url.searchParams.delete("chunk");
  }
  if (next.view !== "book" && next.workId) {
    url.searchParams.set("work", next.workId);
  }
  if (next.workId && next.passageId) {
    url.hash = next.passageId;
  } else {
    url.hash = "";
  }
  if (next.debugEnabled) {
    url.searchParams.set("debug", "true");
  } else {
    url.searchParams.delete("debug");
  }
  if (next.view === "explore") {
    if (next.exploreFilters.language !== "all") {
      url.searchParams.set("exploreLanguage", next.exploreFilters.language);
    } else {
      url.searchParams.delete("exploreLanguage");
    }
    if (next.exploreFilters.subject !== "all") {
      url.searchParams.set("exploreSubject", next.exploreFilters.subject);
    } else {
      url.searchParams.delete("exploreSubject");
    }
    if (next.exploreFilters.bookshelf !== "all") {
      url.searchParams.set("exploreBookshelf", next.exploreFilters.bookshelf);
    } else {
      url.searchParams.delete("exploreBookshelf");
    }
    if (next.exploreRandomSeed) {
      url.searchParams.set("exploreSeed", String(next.exploreRandomSeed));
    } else {
      url.searchParams.delete("exploreSeed");
    }
    if (next.exploreQuery.trim().length > 0) {
      url.searchParams.set("exploreQuery", next.exploreQuery.trim());
    } else {
      url.searchParams.delete("exploreQuery");
    }
  } else {
    url.searchParams.delete("exploreLanguage");
    url.searchParams.delete("exploreSubject");
    url.searchParams.delete("exploreBookshelf");
    url.searchParams.delete("exploreSeed");
    url.searchParams.delete("exploreQuery");
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) {
    window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", nextUrl);
  }
}

function ensureLocalUserId(): string {
  const existing = window.localStorage.getItem(USER_STORAGE_KEY);
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  window.localStorage.setItem(USER_STORAGE_KEY, created);
  return created;
}

function formatExploreLanguageLabel(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return value;
  }
  if (/^[a-z]{2,3}(?:-[a-z]{2,4})?$/iu.test(normalized)) {
    const display = LANGUAGE_DISPLAY_NAMES?.of(normalized.toLowerCase());
    if (display && display.toLowerCase() !== normalized.toLowerCase()) {
      return display;
    }
  }
  return normalized
    .split(/\s+/u)
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function readCachedSessions(): ChatSessionSummary[] {
  if (typeof window === "undefined") {
    return [];
  }
  const raw = window.localStorage.getItem(RECENT_SESSIONS_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { sessions?: unknown };
    return ChatSessionSummarySchema.array().parse(parsed.sessions ?? []);
  } catch {
    window.localStorage.removeItem(RECENT_SESSIONS_STORAGE_KEY);
    return [];
  }
}

function writeCachedSessions(userId: string | null, sessions: ChatSessionSummary[]) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(RECENT_SESSIONS_STORAGE_KEY, JSON.stringify({
    userId,
    sessions,
  }));
}

function clearCachedSessions() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(RECENT_SESSIONS_STORAGE_KEY);
}

function createGuestProfile(id: string): UserProfile {
  return {
    id,
    email: null,
    handle: null,
    name: DEFAULT_READER_NAME,
    avatarUrl: null,
    createdAt: new Date().toISOString(),
    followersCount: 0,
    followingCount: 0,
  };
}

function normalizeToolTraceEntry(entry: Record<string, unknown>, index: number): ToolTraceEntry {
  const toolName = typeof entry.toolName === "string" ? entry.toolName : "search_works";
  const progress = Array.isArray(entry.progress)
    ? entry.progress.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const progressDetails = Array.isArray(entry.progressDetails)
    ? entry.progressDetails.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
    : [];
  const result = entry.result && typeof entry.result === "object" ? (entry.result as Record<string, unknown>) : undefined;
  const resultIndicatesError =
    result?.ok === false
    || (typeof result?.error === "string" && result.error.trim().length > 0);
  const explicitState = entry.state;
  const status = entry.status;
  const state =
    explicitState === "running" || explicitState === "completed" || explicitState === "error"
      ? explicitState
      : status === "running"
        ? "running"
        : status === "failed" || entry.isError === true || resultIndicatesError
          ? "error"
          : result
            ? "completed"
            : progress.length > 0
              ? "running"
              : "completed";

  return {
    id:
      typeof entry.toolCallId === "string"
        ? entry.toolCallId
        : typeof entry.id === "string"
          ? entry.id
          : `${toolName}-${index}`,
    toolName,
    label: typeof entry.label === "string" ? entry.label : getToolLabel(toolName),
    rationale: typeof entry.rationale === "string" ? entry.rationale : undefined,
    progress,
    ...(progressDetails.length > 0 ? { progressDetails } : {}),
    args: entry.args && typeof entry.args === "object" ? (entry.args as Record<string, unknown>) : {},
    result,
    isError: entry.isError === true || resultIndicatesError || state === "error",
    state,
  };
}

function toReadonlyJsonValue(value: unknown): ReadonlyJSONValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toReadonlyJsonValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toReadonlyJsonValue(entry)]),
    ) as ReadonlyJSONObject;
  }
  return String(value);
}

function toReadonlyJsonObject(args: Record<string, unknown>): ReadonlyJSONObject {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, toReadonlyJsonValue(value)])) as ReadonlyJSONObject;
}

function rawMessageToolCalls(message: RawUiMessage): Array<Record<string, unknown>> {
  if (Array.isArray(message.toolCalls)) {
    return message.toolCalls;
  }
  const metadataToolCalls = message.metadata?.toolCalls;
  return Array.isArray(metadataToolCalls)
    ? metadataToolCalls.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

function hydrateStoredMessage(message: RawUiMessage): UiMessage {
  const phase = typeof message.metadata?.phase === "string" ? message.metadata.phase : null;
  const hydratedToolCalls = rawMessageToolCalls(message);
  return {
    ...message,
    citations: message.citations ?? [],
    toolCalls: phase === "plan" && hydratedToolCalls.length > 0
      ? hydratedToolCalls.map((entry, index) =>
          entry && typeof entry === "object"
            ? normalizeToolTraceEntry(entry as Record<string, unknown>, index)
            : {
                id: `search_works-${index}`,
                toolName: "search_works",
                label: getToolLabel("search_works"),
                progress: [],
                args: {},
                state: "completed",
              },
        )
      : [],
  };
}

function readRunEventText(event: PersistedRunEventRecord): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const data = event.dataJson && typeof event.dataJson === "object"
    ? event.dataJson as Record<string, unknown>
    : null;
  if (!data) {
    return null;
  }

  if ((event.event === "tool.progress" || event.event === "tool.progress.raw") && typeof data.text === "string") {
    const text = data.text.trim();
    return text.length > 0 ? text : null;
  }

  if (event.event === "job.log" && typeof data.text === "string") {
    const text = data.text.trim();
    return text.length > 0 ? text : null;
  }

  if (event.event === "job.started") {
    const detail = typeof data.detail === "string" ? data.detail.trim() : "";
    return detail || "Background job started.";
  }

  if (event.event === "job.progress") {
    const detail = typeof data.detail === "string" ? data.detail.trim() : "";
    const phase = typeof data.phase === "string" ? data.phase.trim() : "";
    const progressPct = typeof data.progressPct === "number" ? `${Math.round(data.progressPct)}%` : "";
    return [detail, phase, progressPct].filter(Boolean).join(" ").trim() || null;
  }

  if (event.event === "job.updated") {
    const status = typeof data.status === "string" ? data.status.trim() : "";
    const detail = typeof data.detail === "string" ? data.detail.trim() : "";
    return [status, detail].filter(Boolean).join(": ").trim() || null;
  }

  if (event.event === "tool.started") {
    const label = typeof data.label === "string"
      ? data.label.trim()
      : typeof data.toolName === "string"
        ? getToolLabel(data.toolName)
        : "Tool";
    return label.length > 0 ? `${label} started.` : null;
  }

  if (event.event === "tool.completed") {
    const label = typeof data.label === "string"
      ? data.label.trim()
      : typeof data.toolName === "string"
        ? getToolLabel(data.toolName)
        : "Tool";
    const result = data.result && typeof data.result === "object"
      ? data.result as Record<string, unknown>
      : null;
    const error = typeof result?.error === "string" ? result.error.trim() : "";
    if (error) {
      return `${label} failed: ${error}`;
    }
    return label.length > 0 ? `${label} completed.` : null;
  }

  if (event.event === "run.completed") {
    const error = typeof data.error === "string" ? data.error.trim() : "";
    return error || null;
  }

  return null;
}

function buildPersistedRunLogMessage(
  sessionId: string,
  runState: AssistantSessionBootstrapPayload["runState"] | RunStateRecord | null | undefined,
): UiMessage | null {
  const run = runState?.run;
  if (!run || (run.status !== "running" && run.status !== "queued")) {
    return null;
  }
  const runEvents = Array.isArray(runState?.runEvents) ? runState.runEvents : [];
  if (runEvents.length === 0) {
    return null;
  }

  const lines: string[] = [];
  const seen = new Set<string>();
  for (const event of runEvents) {
    const text = readRunEventText(event);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    lines.push(text);
  }
  if (lines.length === 0) {
    return null;
  }

  return {
    id: `run-progress:${run.id}`,
    sessionId,
    role: "assistant",
    content: lines.join("\n\n"),
    metadata: {
      phase: "progress",
      runId: run.id,
      synthetic: true,
    },
    createdAt: runEvents[runEvents.length - 1]?.createdAt ?? run.startedAt,
    citations: [],
    toolCalls: [],
  };
}

function hydrateConversationMessages(
  sessionId: string,
  rawMessages: RawUiMessage[] | undefined,
  runState: AssistantSessionBootstrapPayload["runState"] | RunStateRecord | null | undefined,
): UiMessage[] {
  const hydrated = Array.isArray(rawMessages) ? rawMessages.map(hydrateStoredMessage) : [];
  const run = runState?.run;
  const toolTrace = Array.isArray(runState?.toolTrace) ? runState.toolTrace : [];
  if (run && toolTrace.length > 0) {
    for (let index = hydrated.length - 1; index >= 0; index -= 1) {
      const message = hydrated[index];
      if (message.role !== "assistant") {
        continue;
      }
      if (message.metadata?.phase !== "plan") {
        continue;
      }
      if (message.metadata?.runId !== run.id) {
        continue;
      }
      hydrated[index] = {
        ...message,
        metadata: {
          ...(message.metadata ?? {}),
          runStatus: run.status,
        },
        toolCalls: toolTrace.map((entry, traceIndex) =>
          normalizeToolTraceEntry(entry as Record<string, unknown>, traceIndex),
        ),
      };
      break;
    }
  }
  const progressMessage = buildPersistedRunLogMessage(sessionId, runState);
  if (!progressMessage) {
    return hydrated;
  }
  return [...hydrated.filter((message) => message.id !== progressMessage.id), progressMessage];
}

function dedupeAdjacentErrorMessages(messages: UiMessage[]) {
  const deduped: UiMessage[] = [];
  for (const message of messages) {
    const previous = deduped[deduped.length - 1];
    const sameErrorMessage = previous
      && previous.role === "assistant"
      && message.role === "assistant"
      && previous.content === message.content
      && previous.metadata?.phase === "error"
      && message.metadata?.phase === "error"
      && previous.metadata?.runId === message.metadata?.runId;
    if (sameErrorMessage) {
      continue;
    }
    deduped.push(message);
  }
  return deduped;
}

function isOptimisticMessage(message: UiMessage) {
  return message.metadata?.optimistic === true;
}

function shouldPreserveOptimisticMessages(
  currentMessages: UiMessage[],
  nextMessages: UiMessage[],
  sessionId: string,
  runActive: boolean,
) {
  if (nextMessages.length > 0 || !runActive) {
    return false;
  }
  return currentMessages.some((message) => message.sessionId === sessionId && isOptimisticMessage(message));
}

function formatRelativeTime(value: string | null | undefined) {
  if (!value) {
    return "Just now";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "Recently";
  }
  const deltaMinutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function decodeHtmlText(input: string) {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, "\"")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function canonicalizeSearchCharacter(character: string) {
  if (/\s/.test(character)) {
    return " ";
  }

  switch (character) {
    case "’":
    case "‘":
      return "'";
    case "“":
    case "”":
      return "\"";
    case "—":
    case "–":
      return "-";
    default:
      return character.toLowerCase();
  }
}

function buildNormalizedSearchIndex(raw: string) {
  let normalized = "";
  const map: number[] = [];
  let previousWasSpace = false;

  for (let index = 0; index < raw.length; index += 1) {
    const next = canonicalizeSearchCharacter(raw[index]);
    if (next === " ") {
      if (previousWasSpace) {
        continue;
      }
      previousWasSpace = true;
    } else {
      previousWasSpace = false;
    }
    normalized += next;
    map.push(index);
  }

  return { normalized, map };
}

function stripGutenbergBoilerplate(text: string) {
  let normalized = text.replace(/\r\n/g, "\n");
  const startMatch = normalized.match(/^[^\n]*\*\*\*\s*START OF[\s\S]*?\*\*\*[^\n]*\n?/im);
  if (startMatch && typeof startMatch.index === "number") {
    normalized = normalized.slice(startMatch.index + startMatch[0].length);
  }

  const endMatch = normalized.match(/\n?[^\n]*\*\*\*\s*END OF[\s\S]*?\*\*\*[^\n]*$/im);
  if (endMatch && typeof endMatch.index === "number") {
    normalized = normalized.slice(0, endMatch.index);
  }

  return normalized
    .replace(/^\s*(?:start of )?the project gutenberg e(?:book|text).*$\n?/gim, "")
    .replace(/^\s*project gutenberg(?:'s)? e(?:book|text).*$\n?/gim, "")
    .trim();
}

function normalizeReaderText(input: string, preserveLineBreaks = false) {
  const normalized = decodeHtmlText(input)
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  if (preserveLineBreaks) {
    return normalized.replace(/\n{3,}/g, "\n\n").trim();
  }

  return normalized.replace(/\s+/g, " ").trim();
}

function hashText(value: string) {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function createReaderPassageId(index: number, text: string) {
  return `passage-${index + 1}-${hashText(text).slice(0, 6)}`;
}

function buildExcerptCandidates(excerpt: string) {
  const decodedExcerpt = decodeHtmlText(excerpt).replace(/\s+/g, " ").trim();
  const cleanedExcerpt = decodedExcerpt.replace(/^[`"'“”‘’]+|[`"'“”‘’.,;:!?]+$/g, "").trim();
  const excerptSegments = cleanedExcerpt
    .split(/[.;!?]\s+|\s+[—–-]\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 24);
  const candidates = [decodedExcerpt, cleanedExcerpt, ...excerptSegments]
    .filter((candidate, index, values) => candidate.length >= 12 && values.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);

  if (candidates.length === 0 && decodedExcerpt.length > 0) {
    return [decodedExcerpt];
  }
  return candidates;
}

function buildCitationCandidates(citation: Citation) {
  const excerptCandidates = buildExcerptCandidates(citation.excerpt);
  const labelCandidate = decodeHtmlText(citation.label).replace(/\s+/g, " ").trim();
  const candidates = [...excerptCandidates, labelCandidate]
    .filter((candidate, index, values) => candidate.length >= 12 && values.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);

  return candidates;
}

function toSearchText(value: string) {
  return buildNormalizedSearchIndex(value).normalized.trim();
}

function finalizeReaderPassages(passages: Array<{ kind: ReaderPassageKind; text: string }>): ReaderPassage[] {
  let started = false;
  let ended = false;
  const cleaned: Array<{ kind: ReaderPassageKind; text: string }> = [];

  for (const passage of passages) {
    if (ended) {
      break;
    }

    let text = passage.text;
    const startMatch = text.match(/\*\*\*\s*START OF[\s\S]*?\*\*\*/i);
    if (startMatch) {
      started = true;
      text = text.slice(startMatch.index! + startMatch[0].length).trim();
    }

    const endMatch = text.match(/\*\*\*\s*END OF[\s\S]*?\*\*\*/i);
    if (endMatch) {
      text = text.slice(0, endMatch.index).trim();
      ended = true;
    }

    const shouldKeep = started || !/project gutenberg/i.test(text);
    const normalized = normalizeReaderText(text, passage.kind === "preformatted");
    if (!shouldKeep || !normalized) {
      continue;
    }

    cleaned.push({
      kind: passage.kind,
      text: normalized,
    });
  }

  const fallback = stripGutenbergBoilerplate(cleaned.map((passage) => passage.text).join("\n\n"));
  const output = cleaned.length > 0
    ? cleaned
    : fallback
      ? fallback.split(/\n{2,}/).map((text) => ({
          kind: "paragraph" as const,
          text: normalizeReaderText(text, true),
        })).filter((passage) => passage.text.length > 0)
      : [];

  return output.map((passage, index) => ({
    ...passage,
    id: createReaderPassageId(index, passage.text),
    searchText: toSearchText(passage.text),
  }));
}

function buildTextReaderPassages(content: string): ReaderPassage[] {
  const cleaned = stripGutenbergBoilerplate(content);
  return finalizeReaderPassages(
    cleaned
      .split(/\n{2,}/)
      .map((chunk) => normalizeReaderText(chunk, true))
      .filter(Boolean)
      .map((text) => ({
        kind: "paragraph" as const,
        text,
      })),
  );
}

function buildHtmlReaderPassages(content: string): ReaderPassage[] {
  if (typeof DOMParser === "undefined") {
    return buildTextReaderPassages(content);
  }

  const doc = new DOMParser().parseFromString(content, "text/html");
  for (const node of doc.querySelectorAll("script, style, link, meta, base, noscript, iframe")) {
    node.remove();
  }
  for (const anchor of doc.querySelectorAll("a")) {
    anchor.replaceWith(...Array.from(anchor.childNodes));
  }

  const selector = "h1, h2, h3, h4, h5, h6, p, li, blockquote, pre";
  const blocks = Array.from(doc.body.querySelectorAll(selector)).filter((element) => !element.parentElement?.closest(selector));
  const passages = blocks
    .map((element) => {
      const tagName = element.tagName.toLowerCase();
      const rawText = tagName === "pre"
        ? element.textContent ?? ""
        : element.textContent?.replace(/\s+/g, " ") ?? "";
      const text = normalizeReaderText(rawText, tagName === "pre");
      if (!text) {
        return null;
      }

      const kind: ReaderPassageKind =
        /^h[1-6]$/.test(tagName)
          ? "heading"
          : tagName === "blockquote"
            ? "quote"
            : tagName === "li"
              ? "list-item"
              : tagName === "pre"
                ? "preformatted"
                : "paragraph";

      return {
        kind,
        text: kind === "list-item" ? `• ${text}` : text,
      };
    })
    .filter((passage): passage is { kind: ReaderPassageKind; text: string } => Boolean(passage));

  if (passages.length === 0) {
    return buildTextReaderPassages(doc.body.textContent ?? "");
  }

  return finalizeReaderPassages(passages);
}

function buildReaderPassages(source: WorkSource | null): ReaderPassage[] {
  if (!source?.content) {
    return [];
  }
  return source.format === "html"
    ? buildHtmlReaderPassages(source.content)
    : buildTextReaderPassages(source.content);
}

function buildOverlayContentsEntries(source: WorkSource | null, passages: ReaderPassage[]): OverlayContentsEntry[] {
  const headingPassages = passages.filter((passage) => passage.kind === "heading");
  const headingLookup = new Map(headingPassages.map((passage) => [passage.searchText, passage]));

  if (source?.format === "html" && typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(source.content, "text/html");
    const tocRoots = Array.from(
      doc.querySelectorAll(
        [
          "nav[epub\\:type='toc']",
          "nav[role='doc-toc']",
          "nav[aria-label*='contents' i]",
          "[id*='contents' i]",
          "[id*='toc' i]",
          "[class*='contents' i]",
          "[class*='toc' i]",
        ].join(", "),
      ),
    );
    const tocEntries = tocRoots.flatMap((root) =>
      Array.from(root.querySelectorAll("a, li"))
        .map((node) => normalizeReaderText(node.textContent?.replace(/\s+/g, " ") ?? ""))
        .filter((text): text is string => Boolean(text) && text.length >= 3)
        .filter((text, index, values) => values.indexOf(text) === index),
    );
    const matchedEntries = tocEntries
      .map((label) => {
        const search = toSearchText(label.replace(/^•\s*/, ""));
        if (!search) {
          return null;
        }
        const direct = headingLookup.get(search);
        if (direct) {
          return { id: direct.id, label };
        }
        const fuzzy = headingPassages.find(
          (passage) => passage.searchText.includes(search) || search.includes(passage.searchText),
        );
        return fuzzy ? { id: fuzzy.id, label } : null;
      })
      .filter((entry): entry is OverlayContentsEntry => Boolean(entry))
      .filter((entry, index, values) => values.findIndex((candidate) => candidate.id === entry.id) === index)
      .slice(0, 24);

    if (matchedEntries.length > 0) {
      return matchedEntries;
    }
  }

  return headingPassages.slice(0, 18).map((passage) => ({
    id: passage.id,
    label: passage.text,
  }));
}

function findHighlightRange(rawText: string, candidates: string[]) {
  const { normalized, map } = buildNormalizedSearchIndex(rawText);
  for (const candidate of candidates) {
    const normalizedCandidate = buildNormalizedSearchIndex(candidate).normalized.trim();
    if (!normalizedCandidate) {
      continue;
    }
    const matchIndex = normalized.indexOf(normalizedCandidate);
    if (matchIndex < 0) {
      continue;
    }

    return {
      start: map[matchIndex],
      end: map[matchIndex + normalizedCandidate.length - 1] + 1,
    };
  }
  return null;
}

function findPassageForCitation(passages: ReaderPassage[], citation: Citation) {
  const candidates = buildCitationCandidates(citation);
  for (const candidate of candidates) {
    const normalizedCandidate = toSearchText(candidate);
    if (!normalizedCandidate) {
      continue;
    }

    const matchingPassage = passages.find((passage) => passage.searchText.includes(normalizedCandidate));
    if (matchingPassage) {
      return {
        passageId: matchingPassage.id,
        highlight: candidate,
      };
    }
  }

  return null;
}

function initialsFromSeed(seed: string) {
  const letters = seed.replace(/[^a-z0-9]/gi, "");
  return letters.slice(0, 2).toUpperCase() || "AB";
}

function hueFromSeed(seed: string) {
  let total = 0;
  for (const character of seed) {
    total = (total * 31 + character.charCodeAt(0)) % 360;
  }
  return (total + 24) % 360;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function adminText(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "—";
}

function normalizeClientError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }
  return {
    name: "Error",
    message: typeof error === "string" ? error : "Unknown client error",
    stack: null,
  };
}

function formatCurrency(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "—";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function summarizeRunLogPayload(payload: Record<string, unknown> | null) {
  if (!payload) {
    return [];
  }
  const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls.length : 0;
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts.length : 0;
  const runtimeInstances = Array.isArray(payload.runtimeInstances) ? payload.runtimeInstances.length : 0;
  const liveRuntime = Array.isArray(payload.liveRuntime) ? payload.liveRuntime.length : 0;
  const metrics = payload.metrics && typeof payload.metrics === "object" ? payload.metrics as Record<string, unknown> : null;
  const summary = [
    `${pluralize(toolCalls, "tool call")}`,
    `${pluralize(artifacts, "artifact")}`,
    `${pluralize(runtimeInstances, "runtime")}`,
    `${pluralize(liveRuntime, "live runtime snapshot")}`,
  ];
  if (typeof metrics?.timeToFirstPrimarySourceMs === "number") {
    summary.push(`first source ${Math.round(metrics.timeToFirstPrimarySourceMs / 1000)}s`);
  }
  if (typeof metrics?.timeToFirstCodexCliStartMs === "number") {
    summary.push(`first Codex ${Math.round(metrics.timeToFirstCodexCliStartMs / 1000)}s`);
  }
  if (typeof metrics?.totalBooksMentioned === "number") {
    summary.push(`${pluralize(metrics.totalBooksMentioned, "book")} mentioned`);
  }
  if (typeof metrics?.totalActiveBooksInFinalAnswer === "number") {
    summary.push(`${pluralize(metrics.totalActiveBooksInFinalAnswer, "active book")} in final answer`);
  }
  return summary;
}

type AdminCombinedLogEntry = {
  sortValue: number;
  index: number;
  timestamp: string | null;
  source: string;
  lines: string[];
};

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function splitLogLines(value: unknown) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function pushCombinedLogEntry(
  entries: AdminCombinedLogEntry[],
  source: string,
  lines: string[],
  timestamp?: string | null,
  sortOffset = 0,
) {
  const normalizedLines = lines.filter((line) => line.trim().length > 0);
  if (normalizedLines.length === 0) {
    return;
  }
  const sortValue = timestamp ? Date.parse(timestamp) || 0 : Number.MAX_SAFE_INTEGER - 1;
  entries.push({
    sortValue: sortValue + sortOffset,
    index: entries.length,
    timestamp: timestamp ?? null,
    source,
    lines: normalizedLines,
  });
}

function buildAdminRunLogEntries(payload: Record<string, unknown> | null) {
  if (!payload) {
    return [];
  }

  const entries: AdminCombinedLogEntry[] = [];
  const run = payload.run && typeof payload.run === "object" ? payload.run as Record<string, unknown> : null;
  const session = payload.session && typeof payload.session === "object" ? payload.session as Record<string, unknown> : null;
  const owner = payload.owner && typeof payload.owner === "object" ? payload.owner as Record<string, unknown> : null;

  pushCombinedLogEntry(
    entries,
    "run",
    [
      `run_id=${adminText(run?.id)} status=${adminText(run?.status)} planner_turns=${adminText(run?.plannerTurns)}`,
      `session_id=${adminText(session?.id)} title=${adminText(session?.title)}`,
      `owner=${adminText(owner?.email)} user_id=${adminText(owner?.id)}`,
    ],
    typeof run?.startedAt === "string" ? run.startedAt : null,
    -5_000,
  );

  const messages = Array.isArray(payload.messages) ? payload.messages as Array<Record<string, unknown>> : [];
  messages.forEach((message) => {
    const role = adminText(message.role).toLowerCase();
    pushCombinedLogEntry(
      entries,
      `message.${role}`,
      [
        ...splitLogLines(message.content),
        ...(message.metadata && typeof message.metadata === "object"
          ? [`metadata ${compactJson(message.metadata)}`]
          : []),
      ],
      typeof message.createdAt === "string" ? message.createdAt : null,
    );
  });

  const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls as Array<Record<string, unknown>> : [];
  toolCalls.forEach((toolCall) => {
    const toolName = adminText(toolCall.toolName);
    const startedAt = typeof toolCall.startedAt === "string" ? toolCall.startedAt : null;
    const completedAt = typeof toolCall.completedAt === "string" ? toolCall.completedAt : null;
    pushCombinedLogEntry(
      entries,
      `tool.${toolName}`,
      [
        `start status=${adminText(toolCall.status)}`,
        `args ${compactJson(toolCall.argsJson ?? {})}`,
      ],
      startedAt,
    );
    pushCombinedLogEntry(
      entries,
      `tool.${toolName}`,
      [
        `finish status=${adminText(toolCall.status)}`,
        `result ${compactJson(toolCall.resultJson ?? null)}`,
      ],
      completedAt ?? startedAt,
      1,
    );
  });

  const runtimeInstances = Array.isArray(payload.runtimeInstances)
    ? payload.runtimeInstances as Array<Record<string, unknown>>
    : [];
  runtimeInstances.forEach((runtime) => {
    pushCombinedLogEntry(
      entries,
      `runtime.${adminText(runtime.runtimeId)}`,
      [
        `status=${adminText(runtime.status)} provider=${adminText(runtime.provider)} machine=${adminText(runtime.providerMachineId)}`,
        `manifest ${compactJson(runtime.manifestJson ?? {})}`,
      ],
      typeof runtime.createdAt === "string" ? runtime.createdAt : null,
    );
  });

  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts as Array<Record<string, unknown>> : [];
  artifacts.forEach((artifact) => {
    const artifactSource = `artifact.${adminText(artifact.filename)}`;
    pushCombinedLogEntry(
      entries,
      artifactSource,
      [
        `r2_key=${adminText(artifact.r2Key)} runtime_id=${adminText(artifact.runtimeId)} mime=${adminText(artifact.mimeType)}`,
      ],
      typeof artifact.createdAt === "string" ? artifact.createdAt : null,
      -1,
    );
    pushCombinedLogEntry(
      entries,
      artifactSource,
      splitLogLines(artifact.content),
      typeof artifact.createdAt === "string" ? artifact.createdAt : null,
    );
  });

  const liveRuntime = Array.isArray(payload.liveRuntime) ? payload.liveRuntime as Array<Record<string, unknown>> : [];
  liveRuntime.forEach((runtime, runtimeIndex) => {
    const runtimeId = adminText(runtime.runtimeId);
    if (typeof runtime.error === "string" && runtime.error.trim().length > 0) {
      pushCombinedLogEntry(
        entries,
        `live.${runtimeId}`,
        [runtime.error],
        null,
        runtimeIndex,
      );
    }
    const files = Array.isArray(runtime.files) ? runtime.files as Array<Record<string, unknown>> : [];
    files.forEach((file, fileIndex) => {
      const source = `live.${runtimeId}.${adminText(file.path)}`;
      pushCombinedLogEntry(
        entries,
        source,
        [
          ...(typeof file.error === "string" && file.error.trim().length > 0 ? [file.error] : []),
          ...splitLogLines(file.content),
        ],
        null,
        runtimeIndex * 100 + fileIndex,
      );
    });
  });

  return entries.sort((left, right) =>
    left.sortValue === right.sortValue
      ? left.index - right.index
      : left.sortValue - right.sortValue,
  );
}

function renderAdminCombinedLog(payload: Record<string, unknown> | null) {
  const entries = buildAdminRunLogEntries(payload);
  if (entries.length === 0) {
    return "No logs available.";
  }

  const sourceWidth = Math.min(
    48,
    Math.max(12, ...entries.map((entry) => entry.source.length)),
  );

  return entries
    .flatMap((entry) =>
      entry.lines.map((line) => {
        const timestamp = entry.timestamp ?? "—";
        return `${timestamp.padEnd(24)} ${entry.source.padEnd(sourceWidth)} ${line}`;
      }),
    )
    .join("\n");
}

function stripHtmlForFrame(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .trim();
}

function buildReaderDocument(source: WorkSource, work: WorkDetail | null) {
  const gutenbergId = work?.gutenbergId ?? null;
  const baseHref = gutenbergId ? `https://www.gutenberg.org/cache/epub/${gutenbergId}/` : null;
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    baseHref ? `<base href="${baseHref}">` : "",
    "<style>",
    "html,body{margin:0;padding:0;background:#f6f1e8;color:#241d17;font-family:Georgia,serif;line-height:1.58;}",
    "body{padding:32px 36px;}",
    "img{max-width:100%;height:auto;}",
    "table{max-width:100%;}",
    "a{color:inherit;}",
    ".alphabook-highlight-block{background:rgba(187,73,44,0.14)!important;box-shadow:0 0 0 3px rgba(187,73,44,0.16);border-radius:10px;padding:0.2rem 0.45rem;scroll-margin:24vh;}",
    "mark.alphabook-inline-highlight{background:rgba(187,73,44,0.18);color:inherit;border-radius:0.22rem;padding:0 0.12rem;}",
    "</style>",
    "</head>",
    "<body>",
    stripHtmlForFrame(source.content),
    "</body>",
    "</html>",
  ].join("");
}

function quoted(value: unknown) {
  return typeof value === "string" && value.trim() ? `“${value.trim()}”` : null;
}

function getCount(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function describeMetadataSearchIntent(args: Record<string, unknown>) {
  const query = typeof args.query === "string" && args.query.trim().length > 0
    ? `for ${quoted(args.query)}`
    : "";
  return `Scanning book titles, summaries, subjects, and catalog metadata ${query}`.trim();
}

function describePassageSearchIntent(args: Record<string, unknown>) {
  const query = typeof args.query === "string" && args.query.trim().length > 0
    ? `for ${quoted(args.query)}`
    : "";
  const scopedWorkCount = Array.isArray(args.workIds) ? args.workIds.length : 0;
  const scope = scopedWorkCount > 0 ? ` across ${pluralize(scopedWorkCount, "candidate book")}` : " across the corpus";
  return `Pulling quoted passages from passage text and semantic matches${scope} ${query}`.replace(/\s+/g, " ").trim();
}

function summarizeToolSentence({
  toolName,
  args,
  result,
  state,
  rationale,
}: Pick<ToolTraceEntry, "toolName" | "args" | "result" | "state" | "rationale">) {
  const query = quoted(args.query)
    ?? (args.taskSpec && typeof args.taskSpec === "object" ? quoted((args.taskSpec as Record<string, unknown>).query) : null)
    ?? (args.taskSpec && typeof args.taskSpec === "object" ? quoted((args.taskSpec as Record<string, unknown>).goal) : null);
  const workCount = getCount(args.workIds);
  const chunkCount = getCount(args.chunkIds);
  const resultWorkCount = result ? getCount(result.works) : 0;
  const resultChunkCount = result ? getCount(result.chunks) : 0;
  const path = typeof args.path === "string" ? args.path : null;
  const errorMessage = typeof result?.error === "string" ? result.error : null;
  const taskSpec = args.taskSpec && typeof args.taskSpec === "object" ? args.taskSpec as Record<string, unknown> : null;
  const runtimePhase = typeof taskSpec?.phase === "string" ? taskSpec.phase : null;
  const hydratedWorkCount =
    result?.manifest && typeof result.manifest === "object" && Array.isArray((result.manifest as Record<string, unknown>).works)
      ? ((result.manifest as Record<string, unknown>).works as unknown[]).length
      : 0;

  switch (toolName) {
    case "semantic_deep_search":
    case "semantic search":
      if (state === "running") {
        return query
          ? `Running the semantic loop for ${query}.`
          : "Running the semantic loop.";
      }
      if (state === "error") {
        return `Semantic search failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      if (resultChunkCount === 0) {
        return "Semantic search did not find strong passages yet.";
      }
      return `Semantic search found ${pluralize(resultChunkCount, "ranked passage")}.`;
    case "search_works":
      {
        const searchIntent = describeMetadataSearchIntent(args);
        if (state === "running") {
          return `${searchIntent}.`;
        }
        if (state === "error") {
          return `${searchIntent} failed${errorMessage ? `: ${errorMessage}` : "."}`;
        }
        if (resultWorkCount === 0) {
          return `${searchIntent} found no strong book matches yet.`;
        }
        return `${searchIntent} found ${pluralize(resultWorkCount, "candidate book")}.`;
      }

    case "get_relevant_chunks":
      {
        const searchIntent = describePassageSearchIntent(args);
        if (state === "running") {
          return `${searchIntent}.`;
        }
        if (state === "error") {
          return `${searchIntent} failed${errorMessage ? `: ${errorMessage}` : "."}`;
        }
        if (resultChunkCount === 0) {
          return `${searchIntent} found no strong passages yet.`;
        }
        return `${searchIntent} found ${pluralize(resultChunkCount, "relevant passage")}.`;
      }

    case "get_work_metadata":
      if (state === "running") {
        return `Loading details for ${pluralize(workCount, "book")}.`;
      }
      if (state === "error") {
        return `Loading book details failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return `Loaded details for ${pluralize(resultWorkCount || workCount, "book")}.`;

    case "get_work_text":
      if (state === "running") {
        return "Opening the full text for a book.";
      }
      if (state === "error") {
        return `Opening the full text failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return "Opened the full text for a book.";

    case "create_workspace":
      if (state === "running") {
        return "Booting the deeper research workspace and wiring in the corpus tools.";
      }
      if (state === "error") {
        return `Booting the deeper research workspace failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return "The deeper research workspace is ready.";

    case "run_workspace_task":
      if (state === "running") {
        if (runtimePhase === "collect_evidence") {
          return query ? `Searching the corpus for evidence about ${query}.` : "Searching the corpus for evidence.";
        }
        if (runtimePhase === "write_briefing") {
          return query ? `Writing the quoted briefing for ${query}.` : "Writing the quoted briefing.";
        }
        return query ? `Searching the corpus for ${query}.` : "Searching the corpus.";
      }
      if (state === "error") {
        if (runtimePhase === "collect_evidence") {
          return query
            ? `The evidence search for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
            : `The evidence search failed${errorMessage ? `: ${errorMessage}` : "."}`;
        }
        if (runtimePhase === "write_briefing") {
          return query
            ? `Writing the briefing for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
            : `Writing the briefing failed${errorMessage ? `: ${errorMessage}` : "."}`;
        }
        return query
          ? `The deeper research run for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
          : `The deeper research run failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      if (runtimePhase === "collect_evidence") {
        return query ? `Finished gathering evidence for ${query}.` : "Finished gathering evidence.";
      }
      if (runtimePhase === "write_briefing") {
        return query ? `Finished the quoted briefing for ${query}.` : "Finished the quoted briefing.";
      }
      return query ? `Finished the deeper research run for ${query}.` : "Finished the deeper research run.";

    case "read_workspace_file":
      if (state === "running") {
        return path?.includes("evidence")
          ? "Bringing back the current search notes."
          : "Bringing back the finished briefing.";
      }
      if (state === "error") {
        return `Reading the search output failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return path?.includes("evidence")
        ? "Brought back the current search notes."
        : "Brought back the finished briefing.";

    case "destroy_workspace":
      if (state === "running") {
        return "Cleaning up the background search.";
      }
      if (state === "error") {
        return `Cleaning up the background search failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return "Cleaned up the background search.";

    default:
      if (state === "running") {
        return "Running the next research step.";
      }
      if (state === "error") {
        return `A research step failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return "Finished the next research step.";
  }
}

function displayName(user: UserProfile | null) {
  return user?.name?.trim() || user?.email?.split("@")[0] || DEFAULT_READER_NAME;
}

function profileHandle(user: UserProfile | null) {
  return user?.handle?.trim() ? `@${user.handle.trim()}` : null;
}

function formatReleaseYear(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return new Date(timestamp).getUTCFullYear().toString();
  }
  const match = value.match(/\d{4}/);
  return match ? match[0] : null;
}

function formatMonthYear(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

function formatCompactCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value.toLocaleString("en-US");
}

function describeError(message: string): { title: string; body: string } {
  const normalized = message.trim();
  const lower = normalized.toLowerCase();

  if (lower.includes("account sync problem")) {
    return {
      title: "Account Sync Issue",
      body: normalized,
    };
  }
  if (lower.includes("sign in")) {
    return {
      title: "Sign-In Required",
      body: normalized,
    };
  }
  if (lower.includes("do not have access")) {
    return {
      title: "Access Restricted",
      body: normalized,
    };
  }

  return {
    title: "Something Went Wrong",
    body: normalized,
  };
}

function ErrorNotice({
  message,
  className,
  onDismiss,
}: {
  message: string;
  className?: string;
  onDismiss?: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [message]);

  const { title, body } = describeError(message);
  if (dismissed) {
    return null;
  }
  return (
    <div className={cn("app-error-notice", className)} role="alert" aria-live="polite">
      <div className="app-error-notice-mark" aria-hidden="true">!</div>
      <div className="app-error-notice-copy">
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
      <button
        type="button"
        className="app-error-notice-dismiss"
        aria-label="Dismiss error"
        onClick={() => {
          setDismissed(true);
          if (onDismiss) {
            onDismiss();
            return;
          }
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function parseBillingLimitState(error: unknown): BillingLimitState | null {
  if (!(error instanceof ApiError) || error.status !== 402 || !error.data || typeof error.data !== "object") {
    return null;
  }
  const payload = error.data as BillingLimitErrorPayload;
  if (payload.code !== "billing_limit_exceeded") {
    return null;
  }
  return {
    limitUsd: typeof payload.limitUsd === "number" ? payload.limitUsd : null,
    spendUsd: typeof payload.spendUsd === "number" ? payload.spendUsd : null,
    windowStartedAt: typeof payload.windowStartedAt === "string" ? payload.windowStartedAt : null,
  };
}

function formatUsdAmount(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function formatBillingWindowDate(value: string | null) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(timestamp);
}

function BillingLimitDialog({
  state,
  onClose,
}: {
  state: BillingLimitState;
  onClose: () => void;
}) {
  const limit = formatUsdAmount(state.limitUsd);
  const spend = formatUsdAmount(state.spendUsd);
  const windowDate = formatBillingWindowDate(state.windowStartedAt);

  return (
    <div className="billing-limit-shell" role="dialog" aria-modal="true" aria-label="Usage limit reached">
      <button type="button" className="billing-limit-backdrop" aria-label="Close usage limit dialog" onClick={onClose} />
      <section className="billing-limit-panel">
        <div className="billing-limit-header">
          <h2>Monthly Usage Limit Reached</h2>
          <button type="button" className="billing-limit-close" aria-label="Close usage limit dialog" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="billing-limit-copy">
          <p>You’ve used this month’s AI credit budget for this account, so new runs are paused for now.</p>
          {limit || spend ? (
            <dl className="billing-limit-stats">
              {spend ? (
                <>
                  <dt>Current spend</dt>
                  <dd>{spend}</dd>
                </>
              ) : null}
              {limit ? (
                <>
                  <dt>Monthly limit</dt>
                  <dd>{limit}</dd>
                </>
              ) : null}
              {windowDate ? (
                <>
                  <dt>Current window started</dt>
                  <dd>{windowDate}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          <p>When the limit is raised, the billing window resets, or payment is accepted, you can start runs again.</p>
        </div>
        <div className="billing-limit-actions">
          <button type="button" className="billing-limit-button" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}

function isConversationAccessIssue(message: string | null) {
  if (!message) {
    return false;
  }
  return /not authorized|do not have access|sign in/i.test(message);
}

function generateExploreRandomSeed() {
  const maxSeed = 2147483646;
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return (values[0] % maxSeed) + 1;
  }
  return Math.floor(Math.random() * maxSeed) + 1;
}

function messageToThreadMessage(
  message: UiMessage,
  activeAssistantId: string | null,
  isSending: boolean,
  runActive: boolean,
) {
  const metadata = {
    custom: {
      citations: message.citations,
      phase: typeof message.metadata?.phase === "string" ? message.metadata.phase : null,
      toolCalls: message.toolCalls,
      runId: typeof message.metadata?.runId === "string" ? message.metadata.runId : null,
      sessionId: message.sessionId,
      runStatus: typeof message.metadata?.runStatus === "string" ? message.metadata.runStatus : null,
      experimentProposal:
        message.metadata?.experimentProposal && typeof message.metadata.experimentProposal === "object"
          ? message.metadata.experimentProposal
          : null,
    },
  };

  if (message.role === "assistant") {
    const phase = typeof message.metadata?.phase === "string" ? message.metadata.phase : null;
    const toolParts = phase === "plan"
      ? []
      : message.toolCalls.map((entry) => {
          const entryHasError =
            entry.isError
            || entry.state === "error"
            || entry.result?.ok === false
            || (typeof entry.result?.error === "string" && entry.result.error.trim().length > 0);
          const args = toReadonlyJsonObject(entry.args);
          return {
            type: "tool-call" as const,
            toolCallId: entry.id,
            toolName: entry.label,
            args,
            argsText: JSON.stringify(args),
            status:
              entry.state === "running"
                ? ({ type: "running" } as const)
                : entryHasError
                  ? ({
                      type: "incomplete",
                      reason: "error",
                      error:
                        typeof entry.result?.error === "string"
                          ? entry.result.error
                          : "This step failed.",
                    } as const)
                  : ({ type: "complete" } as const),
            ...(entry.state === "running"
              ? {}
              : {
                  result: entry.result ?? { ok: !entryHasError },
                  isError: entryHasError,
                }),
          };
        });
    const hasRunningTool = phase !== "plan" && message.toolCalls.some((entry) => entry.state === "running");
    const textParts = message.content
      ? [
          {
            type: "text" as const,
            text: message.content,
          },
        ]
      : [];
    const content = toolParts.length > 0 ? [...textParts, ...toolParts] : textParts;

    return {
      id: message.id,
      role: "assistant" as const,
      createdAt: new Date(message.createdAt),
      content,
      metadata,
      status:
        ((isSending || (runActive && phase !== "plan")) && message.id === activeAssistantId) || hasRunningTool
          ? ({ type: "running" } as const)
          : ({ type: "complete", reason: "stop" } as const),
    };
  }

  return {
    id: message.id,
    role: "user" as const,
    createdAt: new Date(message.createdAt),
    content: message.content,
    metadata,
  };
}

function resolveActiveAssistantMessageId(
  messages: UiMessage[],
  streamingAssistantId: string | null,
  runActive: boolean,
) {
  if (streamingAssistantId) {
    return streamingAssistantId;
  }
  if (!runActive) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    const phase = typeof message.metadata?.phase === "string" ? message.metadata.phase : null;
    if (phase === "answer" || phase === "error") {
      continue;
    }
    return message.id;
  }
  return null;
}

function extractPromptText(message: {
  content?: unknown;
}) {
  const content = message.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      const candidate = part as { type?: string; text?: string };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        return [candidate.text];
      }
      return [];
    })
    .join("\n")
    .trim();
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6.75h16v1.5H4Zm0 4.5h16v1.5H4Zm0 4.5h16v1.5H4Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6.53 5.47 12 12-1.06 1.06-12-12Z" />
      <path d="m18.53 6.53-12 12-1.06-1.06 12-12Z" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.75 5.56v12.69h-1.5V5.56l-4.22 4.22-1.06-1.06L12 2.69l6.03 6.03-1.06 1.06-4.22-4.22Z" />
    </svg>
  );
}

function CompassIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5A9.5 9.5 0 1 0 21.5 12 9.5 9.5 0 0 0 12 2.5Zm4.2 5.3-2.1 6.1L7.9 16.2l2.1-6.1 6.2-2.3Z" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5a4.25 4.25 0 1 1 0 8.5 4.25 4.25 0 0 1 0-8.5Zm0 10c4.56 0 8.25 2.29 8.25 5.12 0 1-.81 1.88-1.87 1.88H5.62c-1.06 0-1.87-.88-1.87-1.88 0-2.83 3.69-5.12 8.25-5.12Z" />
    </svg>
  );
}

const NAV_ITEMS: Array<{ id: ViewMode; label: string; icon: ComponentType }> = [
  { id: "assistant", label: "New chat", icon: MessageSquarePlus },
  { id: "explore", label: "Explore", icon: CompassIcon },
  { id: "profile", label: "Profile", icon: ProfileIcon },
];

function AdminJsonBlock({
  title,
  value,
}: {
  title: string;
  value: unknown;
}) {
  return (
    <Card className="rounded-[20px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.72)] shadow-none">
      <CardContent className="space-y-3 p-5">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">{title}</h2>
        </div>
        <pre className="max-h-[28rem] overflow-auto rounded-[16px] bg-[rgba(32,24,18,0.05)] p-4 text-xs leading-6 text-[var(--ink)]">
          {formatJson(value)}
        </pre>
      </CardContent>
    </Card>
  );
}

function AdminLogConsole({
  payload,
}: {
  payload: Record<string, unknown> | null;
}) {
  return (
    <Card className="rounded-[20px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.72)] shadow-none">
      <CardContent className="space-y-3 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">Combined Logs</h2>
        <pre className="max-h-[68vh] overflow-auto rounded-[16px] bg-[rgba(32,24,18,0.05)] p-4 font-mono text-[11px] leading-5 text-[var(--ink)]">
          {renderAdminCombinedLog(payload)}
        </pre>
      </CardContent>
    </Card>
  );
}

function AdminTableCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="rounded-[20px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.72)] shadow-none">
      <CardContent className="space-y-3 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">{title}</h2>
        {children}
      </CardContent>
    </Card>
  );
}

function IncidentSeverityBadge({ severity }: { severity: string }) {
  const normalized = severity.toLowerCase();
  const className =
    normalized === "critical"
      ? "border-[rgba(187,73,44,0.22)] bg-[rgba(187,73,44,0.12)] text-[rgb(131,43,24)]"
      : "border-[rgba(72,43,37,0.12)] bg-[rgba(72,43,37,0.06)] text-[var(--ink)]";
  return (
    <span className={cn("inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]", className)}>
      {severity}
    </span>
  );
}

function AnalyticsSeriesCard({
  series,
}: {
  series: Record<string, unknown>;
}) {
  const label = adminText(series.label);
  const points = Array.isArray(series.points) ? series.points as Array<Record<string, unknown>> : [];
  const maxValue = Math.max(1, ...points.map((point) => (typeof point.value === "number" ? point.value : 0)));

  return (
    <Card className="rounded-[20px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.72)] shadow-none">
      <CardContent className="space-y-3 p-5">
        <h3 className="text-base font-semibold text-[var(--ink)]">{label}</h3>
        <div className="space-y-2">
          {points.map((point, index) => {
            const value = typeof point.value === "number" ? point.value : 0;
            const width = `${Math.max(6, Math.round((value / maxValue) * 100))}%`;
            return (
              <div key={`${adminText(point.date)}-${index}`} className="space-y-1">
                <div className="flex items-center justify-between gap-3 text-xs text-[var(--ink-soft)]">
                  <span>{adminText(point.tag) !== "—" ? `${adminText(point.date)} · ${adminText(point.tag)}` : adminText(point.date)}</span>
                  <span>{value}</span>
                </div>
                <div className="h-2 rounded-full bg-[rgba(72,43,37,0.08)]">
                  <div className="h-2 rounded-full bg-[var(--accent)]" style={{ width }} />
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function LockedState({
  title,
  compact = false,
}: {
  title: string;
  compact?: boolean;
}) {
  return (
    <Card className={cn("mx-auto w-full max-w-3xl border-none bg-transparent shadow-none", compact && "min-h-[52vh]")}>
      <CardContent className="flex min-h-[44vh] flex-col items-center justify-center gap-6 px-6 py-10 text-center">
        <h2 className="max-w-3xl font-[Newsreader] text-[clamp(2.2rem,5vw,4.6rem)] font-semibold leading-[0.92] tracking-[-0.06em] text-[var(--ink)]">
          {title}
        </h2>
        <Button asChild variant="default" size="lg" className="signin-pill-button">
          <a href={buildSignInUrl(window.location.href)}>Sign in</a>
        </Button>
      </CardContent>
    </Card>
  );
}

function AuthLoadingState({ compact = false }: { compact?: boolean }) {
  return (
    <Card className={cn("mx-auto w-full max-w-3xl border-none bg-transparent shadow-none", compact && "min-h-[52vh]")} aria-hidden="true">
      <CardContent className="flex min-h-[44vh] flex-col items-center justify-center gap-6 px-6 py-10">
        <Skeleton className="h-16 w-[min(44rem,82vw)] rounded-[28px]" />
        <Skeleton className="h-11 w-32 rounded-full" />
      </CardContent>
    </Card>
  );
}

function ProfileLoadingState({ publicView = false }: { publicView?: boolean }) {
  return (
    <div className={cn("profile-view", publicView && "profile-view-public")} aria-hidden="true">
      <section className={cn("profile-hero", publicView && "profile-hero-public")}>
        <Skeleton className="profile-loading-avatar" />
        <Skeleton className="profile-loading-name" />
        <Skeleton className="profile-loading-meta" />
      </section>

      <section className={cn("profile-toolbar", publicView && "profile-toolbar-public")}>
        <div className="profile-stats" aria-hidden="true">
          {[0, 1].map((item) => (
            <article key={item} className="profile-stat-skeleton">
              <Skeleton className="profile-loading-stat-value" />
              <Skeleton className="profile-loading-stat-label" />
            </article>
          ))}
        </div>
        <div className="profile-actions">
          <Skeleton className="profile-loading-action" />
        </div>
      </section>

      <section className="profile-history">
        <div className="profile-history-list">
          {[0, 1, 2].map((item) => (
            <div key={item} className="profile-history-row profile-history-row-skeleton" aria-hidden="true">
              <div className="profile-history-row-head">
                <Skeleton className="profile-loading-row-title" />
                <Skeleton className="profile-loading-row-time" />
              </div>
              <Skeleton className="profile-loading-row-copy is-wide" />
              <Skeleton className="profile-loading-row-copy" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function BookLoadingState() {
  return <div className="book-reader-frame book-reader-frame-empty" aria-hidden="true" />;
}

function ProfileEmptyState({
  title,
  copy,
  action,
}: {
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <div className="profile-history-empty profile-history-empty-card">
      <div className="profile-history-empty-mark">
        <MessageSquarePlus />
      </div>
      <div className="profile-history-empty-copy">
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
      {action ? <div className="profile-history-empty-actions">{action}</div> : null}
    </div>
  );
}

function SidebarProfileSkeleton({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className={cn("sidebar-auth-skeleton", collapsed && "is-collapsed")} aria-hidden="true">
      <Skeleton className="sidebar-auth-skeleton-avatar" />
      {!collapsed ? (
        <div className="sidebar-auth-skeleton-copy">
          <Skeleton className="sidebar-auth-skeleton-name" />
          <Skeleton className="sidebar-auth-skeleton-meta" />
        </div>
      ) : null}
    </div>
  );
}

function isGenericSessionTitle(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "new chat" || normalized === "untitled chat";
}

function sessionDisplayTitle(session: ChatSessionSummary) {
  const explicitTitle = session.title?.trim();
  if (explicitTitle && !isGenericSessionTitle(explicitTitle)) {
    return explicitTitle;
  }
  if (explicitTitle) {
    const previewTitle = session.lastMessagePreview?.trim();
    if (previewTitle) {
      return previewTitle.split(/\s+/).slice(0, 8).join(" ");
    }
  }
  const previewTitle = session.lastMessagePreview?.trim();
  if (previewTitle) {
    return previewTitle.split(/\s+/).slice(0, 8).join(" ");
  }
  return "Untitled chat";
}

function sessionDisplayPreview(session: ChatSessionSummary) {
  const preview = session.lastMessagePreview?.trim();
  if (preview) {
    return preview;
  }
  return "No messages yet.";
}

function assistantSessionName(session: ChatSessionSummary | null) {
  if (!session) {
    return "New chat";
  }
  return sessionDisplayTitle(session);
}

type SessionNotificationState = {
  type: "completed" | "error";
  notificationIds: string[];
};

function buildSessionNotificationMap(notifications: NotificationRecord[]) {
  const next = new Map<string, SessionNotificationState>();
  for (const notification of notifications) {
    if (notification.readAt || !notification.sessionId) {
      continue;
    }
    if (
      notification.type !== "run_completed"
      && notification.type !== "run_failed"
      && notification.type !== "run_timed_out"
    ) {
      continue;
    }
    const type = notification.type === "run_completed" ? "completed" : "error";
    const current = next.get(notification.sessionId);
    if (!current) {
      next.set(notification.sessionId, { type, notificationIds: [notification.id] });
      continue;
    }
    current.notificationIds.push(notification.id);
    if (type === "error") {
      current.type = "error";
    }
  }
  return next;
}

function SidebarRecents({
  collapsed,
  activeView,
  sessions,
  runningSessionIds,
  sessionNotifications,
  selectedSessionId,
  onSelectSession,
}: {
  collapsed: boolean;
  activeView: ViewMode;
  sessions: ChatSessionSummary[];
  runningSessionIds: ReadonlySet<string>;
  sessionNotifications: ReadonlyMap<string, SessionNotificationState>;
  selectedSessionId: string | null | undefined;
  onSelectSession: (sessionId: string) => void;
}) {
  if (collapsed || sessions.length === 0) {
    return null;
  }

  return (
    <section className="sidebar-recents" aria-labelledby="sidebar-recents-heading">
      <div className="sidebar-recents-header">
        <p id="sidebar-recents-heading">Recents</p>
        <span>{pluralize(sessions.length, "chat")}</span>
      </div>

      <div className="sidebar-recents-list">
        {sessions.map((session) => {
          const isActive = activeView === "assistant" && selectedSessionId === session.id;
          const isRunning = runningSessionIds.has(session.id);
          const notificationState = sessionNotifications.get(session.id);
          return (
            <button
              key={session.id}
              type="button"
              className={cn("sidebar-recent-row", isActive && "is-active")}
              onClick={() => onSelectSession(session.id)}
            >
              <span className="sidebar-recent-row-label">{sessionDisplayTitle(session)}</span>
              {isRunning ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="sidebar-recent-row-spinner animate-spin"
                  data-testid={`recent-session-spinner-${session.id}`}
                />
              ) : notificationState?.type === "error" ? (
                <span
                  className="sidebar-recent-row-indicator is-error"
                  aria-label="Run failed"
                  title="Run failed"
                  data-testid={`recent-session-notification-error-${session.id}`}
                >
                  <X aria-hidden="true" />
                </span>
              ) : notificationState?.type === "completed" ? (
                <span
                  className="sidebar-recent-row-indicator is-completed"
                  aria-label="Run completed"
                  title="Run completed"
                  data-testid={`recent-session-notification-completed-${session.id}`}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AssistantSurfaceFallback() {
  return <div className="assistant-thread-shell" data-testid="thread-loading" />;
}

function currentResearchDocumentEnding(messages: UiMessage[], runActive = false) {
  if (runActive || messages.some((message) => message.toolCalls.some((toolCall) => toolCall.state === "running"))) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    if (message.toolCalls.length > 0) {
      continue;
    }
    if (message.content.trim().length === 0) {
      continue;
    }
    if (
      /^this run (?:failed|timed out|was cancelled)\b/i.test(message.content.trim())
      || /^the run hit its hard limits\b/i.test(message.content.trim())
    ) {
      continue;
    }
    return message.content;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || message.toolCalls.length === 0) {
      continue;
    }
    for (let toolIndex = message.toolCalls.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const toolCall = message.toolCalls[toolIndex];
      const briefing =
        typeof toolCall.result?.briefing === "string"
          ? toolCall.result.briefing.trim()
          : typeof toolCall.result?.answer === "string"
            ? toolCall.result.answer.trim()
            : "";
      if (briefing.length > 0) {
        return briefing;
      }
    }
  }
  return null;
}

function isTransientResearchDocumentHtml(html: string) {
  if (!html) {
    return false;
  }
  if (!/<h2[^>]*>\s*Search Underway\s*<\/h2>/iu.test(html)) {
    return false;
  }
  const hasMeaningfulContent =
    /assistant-document-entry is-log/iu.test(html)
    || /assistant-document-entry is-chunk/iu.test(html)
    || /assistant-document-section-title[^>]*>\s*Answer\s*</iu.test(html)
    || /assistant-document-section-title[^>]*>\s*Semantic Search\s*</iu.test(html);
  return !hasMeaningfulContent;
}

function artifactText(artifact: RunArtifactRecord) {
  return typeof artifact.content === "string" ? artifact.content.trim() : "";
}

function artifactCreatedAtTimestamp(artifact: RunArtifactRecord) {
  if (!artifact.createdAt) {
    return 0;
  }
  const timestamp = Date.parse(artifact.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function persistedResearchDocumentHtml(artifacts: RunArtifactRecord[]) {
  const candidate = [...artifacts]
    .filter((artifact) => artifact.metadata?.kind === "research_document")
    .sort((left, right) => artifactCreatedAtTimestamp(right) - artifactCreatedAtTimestamp(left))[0];
  return candidate ? artifactText(candidate) : "";
}

function currentResearchDocumentHtml(
  _messages: UiMessage[],
  artifacts: RunArtifactRecord[],
  _runId: string | null,
) {
  const persistedHtml = persistedResearchDocumentHtml(artifacts);
  if (persistedHtml && !isTransientResearchDocumentHtml(persistedHtml)) {
    return persistedHtml;
  }
  return "";
}

function appendProgressDetail(
  details: Array<Record<string, unknown>> | undefined,
  detail: Record<string, unknown>,
) {
  const existing = Array.isArray(details) ? details : [];
  const fingerprint = JSON.stringify(detail);
  if (existing.some((candidate) => JSON.stringify(candidate) === fingerprint)) {
    return existing;
  }
  return [...existing, detail];
}

function syncToolDisplayArgs(
  args: Record<string, unknown>,
  entry: {
    toolName: string;
    rationale?: string;
    progress: string[];
    progressDetails?: Array<Record<string, unknown>>;
  },
) {
  const nextArgs: Record<string, unknown> = {
    ...args,
    __toolName: entry.toolName,
  };
  if (entry.rationale && entry.rationale.trim().length > 0) {
    nextArgs.__rationale = entry.rationale;
  } else {
    delete nextArgs.__rationale;
  }
  if (entry.progress.length > 0) {
    nextArgs.__progress = [...entry.progress];
  } else {
    delete nextArgs.__progress;
  }
  const alphaloopEvents = (entry.progressDetails ?? [])
    .map((detail) => detail.type === "semantic.alphaloop" && detail.event && typeof detail.event === "object" ? detail.event : null)
    .filter((detail): detail is Record<string, unknown> => Boolean(detail));
  if (alphaloopEvents.length > 0) {
    nextArgs.__alphaloopEvents = alphaloopEvents;
  } else {
    delete nextArgs.__alphaloopEvents;
  }
  return nextArgs;
}

type SpriteTraceState = "queued" | "starting" | "hydrating" | "ready" | "searching" | "completed" | "failed";

function progressDetailState(value: unknown): SpriteTraceState | null {
  return value === "queued"
    || value === "starting"
    || value === "hydrating"
    || value === "ready"
    || value === "searching"
    || value === "completed"
    || value === "failed"
    ? value
    : null;
}

function spriteShardEntryId(detail: Record<string, unknown>) {
  const shardId = progressDetailString(detail.shardId) || "unknown";
  return `sprite-shard:${shardId}`;
}

function spriteAggregateEntryId() {
  return "sprite-aggregate";
}

function spriteLabel(detail: Record<string, unknown>) {
  const explicit = progressDetailString(detail.shardLabel) || progressDetailString(detail.label);
  if (explicit) {
    return explicit;
  }
  const shardIndex = progressDetailNumber(detail.shardIndex);
  const totalShards = progressDetailNumber(detail.totalShards);
  if (shardIndex !== null && totalShards !== null) {
    return `Part ${shardIndex + 1} of ${totalShards}`;
  }
  return "Library Part";
}

function spriteStateSummary(state: SpriteTraceState | null, detail: Record<string, unknown>) {
  const citationCount = progressDetailNumber(detail.citationCount);
  if (state === "queued") {
    return "Queued";
  }
  if (state === "starting") {
    return "Starting";
  }
  if (state === "hydrating") {
    return "Loading books";
  }
  if (state === "ready") {
    return "Loaded and waiting";
  }
  if (state === "searching") {
    return "Searching";
  }
  if (state === "completed") {
    return citationCount !== null ? `Completed with ${pluralize(citationCount, "passage")}` : "Completed";
  }
  if (state === "failed") {
    return "Failed";
  }
  return "";
}

function spriteEntryMeta(detail: Record<string, unknown>) {
  const bookCount = progressDetailNumber(detail.bookCount);
  return bookCount !== null ? pluralize(bookCount, "book") : "";
}

function applySpriteLifecycleDetail(
  trace: ToolTraceEntry[],
  detail: Record<string, unknown>,
  progressText?: string,
) {
  const detailType = progressDetailString(detail.type);
  if (detailType !== "sprite.shard_state" && detailType !== "sprite.aggregate_state") {
    return trace;
  }

  const nextTrace = [...trace];
  if (detailType === "sprite.shard_state") {
    const entryId = spriteShardEntryId(detail);
    const state = progressDetailState(detail.state);
    const existingIndex = nextTrace.findIndex((entry) => entry.id === entryId);
    const existing = existingIndex >= 0 ? nextTrace[existingIndex]! : null;
    const label = spriteLabel(detail);
    const progressLine = progressText || spriteStateSummary(state, detail);
    const nextEntry: ToolTraceEntry = {
      id: entryId,
      toolName: "run_workspace_task",
      label,
      rationale: progressLine || existing?.rationale,
      progress: progressLine
        ? existing?.progress?.includes(progressLine)
          ? (existing.progress ?? [])
          : [...(existing?.progress ?? []), progressLine]
        : (existing?.progress ?? []),
      progressDetails: appendProgressDetail(existing?.progressDetails, detail),
      args: {
        __summary: spriteEntryMeta(detail) || undefined,
      },
      ...(state === "completed"
        ? { result: { ok: true, citationCount: progressDetailNumber(detail.citationCount) ?? undefined } }
        : state === "failed"
          ? {
              result: {
                ok: false,
                error: progressDetailString(detail.error) || "This part failed.",
              },
              isError: true,
            }
          : existing?.result
            ? { result: existing.result }
            : {}),
      state:
        state === "completed"
          ? "completed"
          : state === "failed"
            ? "error"
            : "running",
      isError: state === "failed",
    };
    if (existingIndex >= 0) {
      nextTrace[existingIndex] = nextEntry;
    } else {
      nextTrace.push(nextEntry);
    }
    return nextTrace;
  }

  const state = progressDetailState(detail.state);
  const entryId = spriteAggregateEntryId();
  const existingIndex = nextTrace.findIndex((entry) => entry.id === entryId);
  const existing = existingIndex >= 0 ? nextTrace[existingIndex]! : null;
  const progressLine = progressText
    || (state === "starting"
      ? "Combining the strongest passages."
      : state === "completed"
        ? "Finished combining the strongest passages."
        : "The final merge failed.");
  const nextEntry: ToolTraceEntry = {
    id: entryId,
    toolName: "run_workspace_task",
    label: "Compiled Answer",
    rationale: progressLine,
    progress: progressLine
      ? existing?.progress?.includes(progressLine)
        ? (existing.progress ?? [])
        : [...(existing?.progress ?? []), progressLine]
      : (existing?.progress ?? []),
    progressDetails: appendProgressDetail(existing?.progressDetails, detail),
    args: {},
    ...(state === "completed"
      ? { result: { ok: true, citationCount: progressDetailNumber(detail.citationCount) ?? undefined } }
      : state === "failed"
        ? {
            result: {
              ok: false,
              error: progressDetailString(detail.error) || "The final merge failed.",
            },
            isError: true,
          }
        : existing?.result
          ? { result: existing.result }
          : {}),
    state:
      state === "completed"
        ? "completed"
        : state === "failed"
          ? "error"
          : "running",
    isError: state === "failed",
  };
  if (existingIndex >= 0) {
    nextTrace[existingIndex] = nextEntry;
  } else {
    nextTrace.push(nextEntry);
  }
  return nextTrace;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
}

function progressDetailString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function progressDetailNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildWorkHref(workId: string) {
  return `/works/${encodeURIComponent(workId)}`;
}

function buildAssistantDocumentHref(sessionId: string, runId: string) {
  return `/?view=assistant_document&session=${encodeURIComponent(sessionId)}&run=${encodeURIComponent(runId)}`;
}

function deriveAssistantDocumentTitle(
  sessionTitle: string | null | undefined,
  messages: UiMessage[],
) {
  const explicitTitle = sessionTitle?.trim();
  if (explicitTitle && !isGenericResearchDocumentTitle(explicitTitle)) {
    return explicitTitle;
  }
  const firstUserText = messages.find((message) => message.role === "user" && typeof message.content === "string" && message.content.trim().length > 0);
  if (firstUserText?.content) {
    return firstUserText.content.trim().replace(/\s+/g, " ").split(" ").slice(0, 8).join(" ");
  }
  return explicitTitle || "Research log";
}

function readAssistantDocumentBootstrap(sessionId: string, runId: string) {
  if (typeof window === "undefined") {
    return null;
  }
  const payload = window.__ALPHABOOK_ASSISTANT_DOCUMENT_BOOTSTRAP__;
  if (!payload || payload.sessionId !== sessionId || payload.runId !== runId) {
    return null;
  }
  return payload;
}

function readAssistantSessionBootstrap(sessionId: string | null | undefined) {
  if (typeof window === "undefined" || !sessionId) {
    return null;
  }
  const payload = window.__ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__;
  if (!payload || payload.sessionId !== sessionId) {
    return null;
  }
  return payload;
}

function readWorkPageBootstrap(workId: string | null | undefined) {
  if (typeof window === "undefined" || !workId) {
    return null;
  }
  const payload = window.__ALPHABOOK_WORK_PAGE_BOOTSTRAP__;
  if (!payload || payload.workId !== workId) {
    const meta = document.querySelector('meta[name="alphabook-work-page-bootstrap"]');
    const metaContent = meta?.getAttribute("content");
    if (metaContent) {
      try {
        const parsed = JSON.parse(decodeURIComponent(metaContent)) as WorkPageBootstrapPayload;
        return parsed.workId === workId ? parsed : null;
      } catch {
        return null;
      }
    }
    const serverRendered = document.getElementById("work-page-ssr");
    const encoded = serverRendered?.getAttribute("data-bootstrap");
    if (!encoded) {
      return null;
    }
    try {
      const parsed = JSON.parse(decodeURIComponent(encoded)) as WorkPageBootstrapPayload;
      return parsed.workId === workId ? parsed : null;
    } catch {
      return null;
    }
  }
  return payload;
}

function buildWorkContentHref(workId: string, gutenbergId?: string | number | null) {
  if (gutenbergId != null && String(gutenbergId).trim().length > 0) {
    return `${BOOK_CONTENT_ORIGIN}/${encodeURIComponent(String(gutenbergId))}/pages/page-0001.html?v=${BOOK_CONTENT_VERSION}`;
  }
  return `/api/works/${encodeURIComponent(workId)}/content?v=${BOOK_CONTENT_VERSION}`;
}

function appendBookVersionToReaderPath(readerPath: string) {
  const url = new URL(readerPath, BOOK_CONTENT_ORIGIN);
  url.searchParams.set("v", BOOK_CONTENT_VERSION);
  return `${url.pathname}${url.search}${url.hash}`;
}

function normalizeReaderPath(readerPath: string | null | undefined) {
  if (!readerPath) {
    return null;
  }
  try {
    const url = new URL(readerPath, BOOK_CONTENT_ORIGIN);
    if (url.origin !== BOOK_CONTENT_ORIGIN) {
      return null;
    }
    if (!/^\/\d+(?:\/|$)/u.test(url.pathname)) {
      return null;
    }
    url.searchParams.delete("v");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function buildWorkContentFrameHref(workId: string, gutenbergId?: string | number | null, passageId?: string | null, readerPath?: string | null) {
  const normalizedReaderPath = normalizeReaderPath(readerPath);
  if (normalizedReaderPath) {
    return `${BOOK_CONTENT_ORIGIN}${appendBookVersionToReaderPath(normalizedReaderPath)}`;
  }
  if (gutenbergId != null && String(gutenbergId).trim().length > 0 && passageId) {
    return `${BOOK_CONTENT_ORIGIN}/${encodeURIComponent(String(gutenbergId))}/passages/${encodeURIComponent(passageId)}?v=${BOOK_CONTENT_VERSION}`;
  }
  const baseHref = buildWorkContentHref(workId, gutenbergId);
  if (!passageId) {
    return baseHref;
  }
  return `${baseHref}#${encodeURIComponent(passageId)}`;
}

function buildResearchDocumentLinkHref(
  mode: "app" | "iframe",
  workId?: string | null,
  citation?: Citation | null,
) {
  if (!workId && !citation?.workId) {
    return undefined;
  }
  const resolvedWorkId = citation?.workId ?? workId ?? null;
  if (!resolvedWorkId) {
    return undefined;
  }
  if (mode === "iframe") {
    return buildWorkContentFrameHref(resolvedWorkId, undefined, citation?.chunkId ?? null);
  }
  return buildWorkHref(resolvedWorkId);
}

function formatPassageLocation(chunkIndex: number | null) {
  if (chunkIndex === null || !Number.isFinite(chunkIndex)) {
    return "roughly mid-book";
  }
  return `around passage ${chunkIndex}`;
}

function normalizeResearchEnding(text: string | null | undefined) {
  if (typeof text !== "string") {
    return "";
  }
  const cleaned = text
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*]\s+/gmu, "")
    .trim();
  if (!cleaned) {
    return "";
  }
  const paragraphs = cleaned
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs.slice(0, 2).join("\n\n");
}

function isGenericResearchDocumentTitle(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "" || normalized === "research log";
}

class ResearchDocumentErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("research_document_render", error, info.componentStack || "");
  }

  render() {
    if (this.state.hasError) {
      return (
        <section className="assistant-document-pane">
          <div className="assistant-document-scroll">
            <div className="session-loading">
              We couldn&apos;t render this research document. Try refreshing the run.
            </div>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}

function ResearchArtifactDocument({
  sessionTitle,
  documentHtml,
  emptyState = "No research has been written yet.",
}: {
  sessionTitle: string;
  documentHtml: string;
  emptyState?: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const previousHtmlRef = useRef<string>("");

  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) {
      previousHtmlRef.current = "";
      return;
    }
    const nextHtml = documentHtml.trim();
    const previousHtml = previousHtmlRef.current;
    if (!nextHtml) {
      element.innerHTML = "";
      previousHtmlRef.current = "";
      return;
    }
    if (!previousHtml) {
      element.innerHTML = nextHtml;
      previousHtmlRef.current = nextHtml;
      return;
    }
    if (nextHtml === previousHtml) {
      return;
    }
    if (nextHtml.startsWith(previousHtml)) {
      const delta = nextHtml.slice(previousHtml.length);
      if (delta.trim().length > 0) {
        element.insertAdjacentHTML("beforeend", delta);
      }
      previousHtmlRef.current = nextHtml;
      return;
    }
    element.innerHTML = nextHtml;
    previousHtmlRef.current = nextHtml;
  }, [documentHtml]);

  return (
    <ResearchDocumentErrorBoundary>
      <section className="assistant-document-pane">
        <div className="assistant-document-scroll">
          <div className="assistant-document-text">
            <h1 className="assistant-document-entry is-title">
              {sessionTitle.trim() || "Research log"}
            </h1>
            {documentHtml.trim().length > 0 ? (
              <div ref={bodyRef} className="assistant-document-body" />
            ) : emptyState ? (
              <div className="assistant-document-body">{emptyState}</div>
            ) : null}
          </div>
        </div>
      </section>
    </ResearchDocumentErrorBoundary>
  );
}

function AssistantDocumentFramePage({
  sessionId,
  runId,
}: {
  sessionId: string;
  runId: string;
}) {
  const hasServerRenderedDocument = typeof document !== "undefined" && Boolean(document.getElementById("assistant-document-ssr"));
  const bootstrap = useMemo(() => readAssistantDocumentBootstrap(sessionId, runId), [runId, sessionId]);
  const bootstrapHydratedMessages = useMemo(() => {
    return hydrateConversationMessages(
      sessionId,
      Array.isArray(bootstrap?.messages) ? bootstrap.messages : [],
      bootstrap?.runState,
    );
  }, [bootstrap]);
  const [messages, setMessages] = useState<UiMessage[]>(bootstrapHydratedMessages);
  const [artifacts, setArtifacts] = useState<RunArtifactRecord[]>(() => (
    Array.isArray(bootstrap?.runState?.artifacts) ? bootstrap.runState.artifacts : []
  ));
  const [runStatus, setRunStatus] = useState<SessionRunRecord["status"] | null>(() => bootstrap?.runState?.run?.status ?? null);
  const [sessionTitle, setSessionTitle] = useState<string>(() => deriveAssistantDocumentTitle(bootstrap?.sessionTitle, bootstrapHydratedMessages));
  const [loading, setLoading] = useState(bootstrap ? false : !hasServerRenderedDocument);
  const [error, setError] = useState<string | null>(bootstrap?.error ?? null);
  const [errorStatus, setErrorStatus] = useState<number | null>(bootstrap?.errorStatus ?? null);

  useEffect(() => {
    if (loading) {
      return;
    }
    const serverRendered = document.getElementById("assistant-document-ssr");
    if (serverRendered) {
      serverRendered.remove();
    }
  }, [loading]);

  useEffect(() => {
    setMessages(bootstrapHydratedMessages);
    setArtifacts(Array.isArray(bootstrap?.runState?.artifacts) ? bootstrap.runState.artifacts : []);
    setRunStatus(bootstrap?.runState?.run?.status ?? null);
    setSessionTitle(deriveAssistantDocumentTitle(bootstrap?.sessionTitle, bootstrapHydratedMessages));
    setLoading(bootstrap ? false : !hasServerRenderedDocument);
    setError(bootstrap?.error ?? null);
    setErrorStatus(bootstrap?.errorStatus ?? null);
  }, [bootstrap, bootstrapHydratedMessages, hasServerRenderedDocument, runId]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | null = null;
    let loadingTimer: number | null = null;

    if (!bootstrap && !hasServerRenderedDocument) {
      loadingTimer = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        setLoading(false);
        setError("We couldn't load this research document.");
        setErrorStatus(503);
      }, 6000);
    }

    const refresh = async () => {
      try {
        const [nextMessages, nextState] = await Promise.all([
          fetchMessages(sessionId),
          fetchAssistantDocumentState(sessionId, runId),
        ]);
        if (cancelled) {
          return;
        }
        if (loadingTimer !== null) {
          window.clearTimeout(loadingTimer);
          loadingTimer = null;
        }
        const merged = hydrateConversationMessages(sessionId, nextMessages, nextState);
        setMessages(merged);
        setArtifacts(Array.isArray(nextState.artifacts) ? nextState.artifacts : []);
        setRunStatus(nextState.run?.status ?? null);
        setSessionTitle((current) => deriveAssistantDocumentTitle(current, merged));
        setLoading(false);
        setError(null);
        setErrorStatus(null);
        if (nextState.run?.status === "running" || nextState.run?.status === "queued") {
          pollTimer = window.setTimeout(() => {
            void refresh();
          }, 1500);
        }
      } catch (nextError) {
        if (cancelled) {
          return;
        }
        if (loadingTimer !== null) {
          window.clearTimeout(loadingTimer);
          loadingTimer = null;
        }
        setLoading(false);
        setErrorStatus(nextError instanceof ApiError ? nextError.status : null);
        setError(getErrorMessage(nextError, "We couldn't load this research document."));
      }
    };

    if (bootstrap) {
      if (bootstrap.error) {
        setLoading(false);
        setError(bootstrap.error);
        setErrorStatus(bootstrap.errorStatus ?? null);
      } else if (bootstrap.runState?.run?.status === "running" || bootstrap.runState?.run?.status === "queued") {
        pollTimer = window.setTimeout(() => {
          void refresh();
        }, 1500);
      }
    } else {
      setLoading(hasServerRenderedDocument ? false : true);
      void refresh();
    }
    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
      }
      if (loadingTimer !== null) {
        window.clearTimeout(loadingTimer);
      }
    };
  }, [bootstrap, hasServerRenderedDocument, runId, sessionId]);

  const ending = useMemo(
    () => currentResearchDocumentEnding(messages, runStatus === "running" || runStatus === "queued"),
    [messages, runStatus],
  );
  const documentHtml = useMemo(
    () => currentResearchDocumentHtml(messages, artifacts, runId),
    [artifacts, messages, runId],
  );

  if (loading && !hasServerRenderedDocument) {
    return (
      <section className="assistant-document-pane assistant-document-standalone">
        <div className="assistant-document-scroll" />
      </section>
    );
  }

  if (error) {
    const needsSignIn = errorStatus === 401;
    const accessDenied = errorStatus === 403;
    return (
      <section className="assistant-document-pane assistant-document-standalone">
        <div className="assistant-document-scroll">
          <div className="session-loading">
            <div>{needsSignIn ? "Please sign in to view this research document." : error}</div>
            {needsSignIn ? (
              <div className="mt-3">
                <a className="font-medium underline underline-offset-4" href={buildSignInUrl(window.location.href)}>
                  Sign in to view this research document
                </a>
              </div>
            ) : accessDenied ? (
              <div className="mt-3 text-sm text-muted-foreground">
                This session or run is not available to the current account.
              </div>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="assistant-document-pane assistant-document-standalone" data-run-status={runStatus ?? "unknown"}>
      <ResearchArtifactDocument
        sessionTitle={sessionTitle}
        documentHtml={documentHtml}
      />
    </section>
  );
}

function ReaderPassageBlock({
  passage,
  isActive,
  highlight,
  onActivate,
}: {
  passage: ReaderPassage;
  isActive: boolean;
  highlight: string | null;
  onActivate: (passageId: string) => void;
}) {
  const range = useMemo(
    () => (highlight ? findHighlightRange(passage.text, buildExcerptCandidates(highlight)) : null),
    [highlight, passage.text],
  );
  const before = range ? passage.text.slice(0, range.start) : passage.text;
  const marked = range ? passage.text.slice(range.start, range.end) : "";
  const after = range ? passage.text.slice(range.end) : "";
  const Tag = passage.kind === "heading" ? "h2" : passage.kind === "quote" ? "blockquote" : "p";

  return (
    <article
      id={passage.id}
      className={cn("book-passage", isActive && "is-active", `is-${passage.kind}`)}
      data-passage-id={passage.id}
    >
      <button
        type="button"
        className="book-passage-anchor"
        onClick={() => onActivate(passage.id)}
        aria-label="Link to this passage"
      >
        <Link2 />
      </button>
      <Tag className="book-passage-text">
        {range ? (
          <>
            {before}
            <mark className="alphabook-inline-highlight">{marked}</mark>
            {after}
          </>
        ) : (
          passage.text
        )}
      </Tag>
    </article>
  );
}

function SessionListCard({
  session,
  onOpen,
}: {
  session: ChatSessionSummary;
  onOpen: () => void;
}) {
  return (
    <button type="button" onClick={onOpen} className="profile-history-row w-full text-left">
      <div className="profile-history-row-head">
        <strong className="profile-history-row-title">{sessionDisplayTitle(session)}</strong>
        <span className="profile-history-row-time">{formatRelativeTime(session.lastMessageAt)}</span>
      </div>
      <p className="profile-history-row-preview">{session.lastMessagePreview ?? "No messages yet."}</p>
    </button>
  );
}

function trimSentence(value: string | null | undefined, maxLength = 180) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function formatStatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: value % 1 === 0 ? 0 : 1 }).format(value);
}

function ProfileMetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="profile-metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function ProfileFacetRail({
  label,
  items,
}: {
  label: string;
  items: ProfileFacetStat[];
}) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="profile-facet-rail">
      <span className="profile-facet-label">{label}</span>
      <div className="profile-facet-pills">
        {items.map((item) => (
          <span key={`${label}-${item.label}`} className="profile-facet-pill">
            {item.label}
            <small>{item.count}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

function ProfileBookCard({
  item,
  onOpen,
}: {
  item: ProfileBookStat;
  onOpen: (workId: string) => void;
}) {
  const subtitle = [
    item.work.authors[0] ?? item.work.language?.toUpperCase() ?? null,
    item.lastTouchedAt ? formatRelativeTime(item.lastTouchedAt) : null,
  ].filter(Boolean).join(" | ");
  return (
    <button type="button" className="profile-book-card" onClick={() => onOpen(item.work.id)}>
      <div className="profile-book-card-head">
        <strong>{item.work.title}</strong>
        {subtitle ? <span>{subtitle}</span> : null}
      </div>
      {item.work.summary ? <p>{trimSentence(item.work.summary, 130)}</p> : null}
      <div className="profile-book-card-stats">
        <span>{pluralize(item.openCount, "open")}</span>
        <span>{pluralize(item.citationCount, "citation")}</span>
        <span>{pluralize(item.sessionCount, "session")}</span>
      </div>
    </button>
  );
}

function ProfileBookShelf({
  title,
  items,
  emptyCopy,
  onOpenWork,
}: {
  title: string;
  items: ProfileBookStat[];
  emptyCopy: string;
  onOpenWork: (workId: string) => void;
}) {
  return (
    <section className="profile-section-card">
      <div className="profile-section-header">
        <div>
          <h2>{title}</h2>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="profile-section-empty">{emptyCopy}</p>
      ) : (
        <div className="profile-book-grid">
          {items.map((item) => <ProfileBookCard key={`${title}-${item.work.id}`} item={item} onOpen={onOpenWork} />)}
        </div>
      )}
    </section>
  );
}

function ProfileQueryCard({
  item,
  onOpen,
}: {
  item: ProfileQueryStat;
  onOpen: (sessionId: string) => void;
}) {
  const summary = trimSentence(item.latestUserQuery ?? item.firstUserQuery ?? item.sessionTitle, 220);
  const startedWith = trimSentence(item.firstUserQuery, 110);
  return (
    <button type="button" onClick={() => onOpen(item.sessionId)} className="profile-history-row profile-history-row-rich w-full text-left">
      <div className="profile-history-row-head">
        <div className="profile-history-row-copy-block">
          <strong className="profile-history-row-title">{summary ?? "Untitled query"}</strong>
          <span className="profile-history-row-session">{item.sessionTitle ?? "Untitled session"}</span>
        </div>
        <span className="profile-history-row-time">{formatRelativeTime(item.lastActivityAt)}</span>
      </div>
      <div className="profile-history-chip-row">
        <span>{pluralize(item.userMessageCount, "query")}</span>
        <span>{pluralize(item.distinctCitedWorks, "book")} cited</span>
        <span>{pluralize(item.citationCount, "citation")}</span>
      </div>
      {startedWith && item.latestUserQuery && item.firstUserQuery !== item.latestUserQuery ? (
        <p className="profile-history-row-preview">Started with "{startedWith}"</p>
      ) : null}
    </button>
  );
}

export default function App() {
  const initialUrlState = readUrlState();
  const initialAssistantSessionBootstrap = readAssistantSessionBootstrap(initialUrlState.sessionId);
  const initialWorkPageBootstrap = readWorkPageBootstrap(initialUrlState.workId);
  const initialBootstrapHydratedMessages = hydrateConversationMessages(
    initialUrlState.sessionId ?? "pending",
    Array.isArray(initialAssistantSessionBootstrap?.messages)
      ? initialAssistantSessionBootstrap.messages
      : [],
    initialAssistantSessionBootstrap?.runState,
  );
  const initialBootstrapRuns = Array.isArray(initialAssistantSessionBootstrap?.runs)
    ? initialAssistantSessionBootstrap.runs
    : [];
  const initialBootstrapPreferredRun =
    initialBootstrapRuns.find((run) => run.status === "running" || run.status === "queued")
    ?? null;
  const [guestUserId] = useState(() => ensureLocalUserId());
  const [authState, setAuthState] = useState<AuthState>({
    loading: true,
    authConfigured: false,
    user: null,
    error: null,
  });
  const [activeView, setActiveView] = useState<ViewMode>(initialUrlState.view);
  const [cachedSessions] = useState<ChatSessionSummary[]>(() => readCachedSessions());
  const [sessions, setSessions] = useState<ChatSessionSummary[]>(() => (
    Array.isArray(initialAssistantSessionBootstrap?.sessions)
      ? initialAssistantSessionBootstrap.sessions
      : cachedSessions
  ));
  const [selectedSessionId, setSelectedSessionId] = useState<string | null | undefined>(initialUrlState.sessionId);
  const [selectedAdminRunId, setSelectedAdminRunId] = useState<string | null | undefined>(initialUrlState.runId);
  const [adminSection, setAdminSection] = useState<"runs" | "users" | "analytics" | "incidents" | "logs">(initialUrlState.adminSection);
  const [messages, setMessages] = useState<UiMessage[]>(initialBootstrapHydratedMessages);
  const messagesRef = useRef<UiMessage[]>([]);
  const [conversationHydrated, setConversationHydrated] = useState(() => (
    initialUrlState.sessionId == null || Array.isArray(initialAssistantSessionBootstrap?.messages)
  ));
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsResolved, setSessionsResolved] = useState(Boolean(initialAssistantSessionBootstrap?.sessions));
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [recoveredActiveRunId, setRecoveredActiveRunId] = useState<string | null>(initialBootstrapPreferredRun?.id ?? null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [sessionRuns, setSessionRuns] = useState<SessionRunRecord[]>(initialBootstrapRuns);
  const [runArtifacts, setRunArtifacts] = useState<RunArtifactRecord[]>(() => (
    Array.isArray(initialAssistantSessionBootstrap?.runState?.artifacts)
      ? initialAssistantSessionBootstrap.runState.artifacts
      : []
  ));
  const [loadError, setLoadError] = useState<string | null>(initialAssistantSessionBootstrap?.error ?? null);
  const [billingLimitState, setBillingLimitState] = useState<BillingLimitState | null>(null);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const streamingAssistantIdRef = useRef<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(initialUrlState.debugEnabled);
  const [AgentationComponent, setAgentationComponent] = useState<ComponentType<AgentationProps> | null>(null);
  const [AssistantSurfaceComponent, setAssistantSurfaceComponent] = useState<ComponentType<AssistantSurfaceProps> | null>(null);
  const [exploreDraft, setExploreDraft] = useState(initialUrlState.exploreQuery);
  const [exploreQuery, setExploreQuery] = useState(initialUrlState.exploreQuery);
  const [feedWorks, setFeedWorks] = useState<WorkSummary[]>([]);
  const [feedNextOffset, setFeedNextOffset] = useState<number | null>(0);
  const [feedTotalCount, setFeedTotalCount] = useState<number | null>(null);
  const [feedFacets, setFeedFacets] = useState<WorkFacetCounts>(EMPTY_WORK_FACETS);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedInitialLoadState, setFeedInitialLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [exploreFilterOpen, setExploreFilterOpen] = useState(false);
  const [exploreAppliedFilters, setExploreAppliedFilters] = useState<ExploreFilterState>(initialUrlState.exploreFilters);
  const [exploreDraftFilters, setExploreDraftFilters] = useState<ExploreFilterState>(initialUrlState.exploreFilters);
  const [exploreRandomSeed, setExploreRandomSeed] = useState<number | null>(initialUrlState.exploreRandomSeed);
  const [activeWorkId, setActiveWorkId] = useState<string | null | undefined>(initialUrlState.workId);
  const [activeProfileUserId, setActiveProfileUserId] = useState<string | null | undefined>(initialUrlState.profileUserId);
  const [activeWork, setActiveWork] = useState<WorkDetail | null>(() => initialWorkPageBootstrap?.work ?? null);
  const [activeWorkSource, setActiveWorkSource] = useState<WorkSource | null>(() => initialWorkPageBootstrap?.source ?? null);
  const [activeWorkLoading, setActiveWorkLoading] = useState(false);
  const [activeWorkSourceLoading, setActiveWorkSourceLoading] = useState(false);
  const [activeReaderPath, setActiveReaderPath] = useState<string | null | undefined>(initialUrlState.readerPath);
  const [activeChunkId, setActiveChunkId] = useState<string | null | undefined>(initialUrlState.chunkId);
  const [pendingCitation, setPendingCitation] = useState<Citation | null>(null);
  const [activePassageId, setActivePassageId] = useState<string | null>(initialUrlState.passageId ?? null);
  const [highlightedPassageExcerpt, setHighlightedPassageExcerpt] = useState<string | null>(null);
  const bookReaderFrameRef = useRef<HTMLIFrameElement | null>(null);
  const lastReaderFrameHrefRef = useRef<string | null>(null);
  const latestReaderPathRef = useRef<string | null | undefined>(initialUrlState.readerPath);
  const latestReaderContextRef = useRef({
    view: initialUrlState.view,
    sessionId: initialUrlState.sessionId,
    workId: initialUrlState.workId,
    chunkId: initialUrlState.chunkId,
    profileUserId: initialUrlState.profileUserId,
    runId: initialUrlState.runId,
    adminSection: initialUrlState.adminSection,
    debugEnabled: initialUrlState.debugEnabled,
    gutenbergId: initialWorkPageBootstrap?.work?.gutenbergId ?? null,
  });
  const [publicProfile, setPublicProfile] = useState<PublicProfileResponse | null>(null);
  const [publicProfileLoading, setPublicProfileLoading] = useState(false);
  const [profileStats, setProfileStats] = useState<UserProfileStats | null>(null);
  const [profileStatsLoading, setProfileStatsLoading] = useState(false);
  const [notificationsState, setNotificationsState] = useState<NotificationsState>({
    loading: false,
    error: null,
    notifications: [],
    unreadCount: 0,
  });
  const [adminAccess, setAdminAccess] = useState<AdminAccessState>({
    loading: true,
    allowed: false,
    authenticated: false,
    authConfigured: false,
    user: null,
  });
  const [adminRunInput, setAdminRunInput] = useState(initialUrlState.runId ?? "");
  const [adminRunLog, setAdminRunLog] = useState<AdminRunLogState>({
    loading: false,
    error: null,
    runId: initialUrlState.runId ?? "",
    payload: null,
  });
  const [adminUsers, setAdminUsers] = useState<AdminTableState>({
    loading: false,
    error: null,
    rows: [],
  });
  const [adminRuns, setAdminRuns] = useState<AdminTableState>({
    loading: false,
    error: null,
    rows: [],
  });
  const [adminSessions, setAdminSessions] = useState<AdminTableState>({
    loading: false,
    error: null,
    rows: [],
  });
  const [adminAnalytics, setAdminAnalytics] = useState<AdminAnalyticsState>({
    loading: false,
    error: null,
    draft: "",
    query: "",
    payload: null,
  });
  const [adminIncidents, setAdminIncidents] = useState<AdminIncidentsState>({
    loading: false,
    error: null,
    query: "",
    days: 7,
    selectedFingerprint: null,
    payload: null,
  });
  const activeRunTokenRef = useRef(0);
  const activeChatAbortControllerRef = useRef<AbortController | null>(null);
  const reconnectRunStreamAbortControllerRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const selectedSessionIdRef = useRef<string | null | undefined>(selectedSessionId);
  const pendingUrlWriteModeRef = useRef<UrlWriteMode>("replace");
  const suppressNextUrlWriteRef = useRef(false);

  const currentUser = useMemo(
    () => {
      if (authState.loading) {
        return null;
      }
      if (authState.user) {
        return authState.user;
      }
      return authState.authConfigured ? null : createGuestProfile(guestUserId);
    },
    [authState.authConfigured, authState.loading, authState.user, guestUserId],
  );
  const currentUserId = currentUser?.id ?? null;
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );
  const hasActiveExploreFilters = (
    exploreAppliedFilters.language !== "all"
    || exploreAppliedFilters.subject !== "all"
    || exploreAppliedFilters.bookshelf !== "all"
  );
  const activeExploreFilterCount = (
    (exploreAppliedFilters.language !== "all" ? 1 : 0)
    + (exploreAppliedFilters.subject !== "all" ? 1 : 0)
    + (exploreAppliedFilters.bookshelf !== "all" ? 1 : 0)
  );
  const assistantMessages = useMemo(() => messages.filter((message) => message.role === "assistant"), [messages]);
  const citationCount = useMemo(() => messages.reduce((count, message) => count + message.citations.length, 0), [messages]);
  const readerPassages = useMemo(() => buildReaderPassages(activeWorkSource), [activeWorkSource]);
  const profileSeed = currentUser?.email ?? currentUser?.id ?? guestUserId;
  const profileHue = useMemo(() => hueFromSeed(profileSeed), [profileSeed]);
  const displayProfileName = displayName(currentUser);
  const profileTag = profileHandle(currentUser);
  const activeViewLabel =
    activeView === "assistant"
      ? assistantSessionName(activeSession)
      : activeView === "book"
        ? activeWork?.title ?? "Book"
        : activeView === "admin"
          ? "Admin"
          : NAV_ITEMS.find((item) => item.id === activeView)?.label ?? PRODUCT_NAME;
  const authLocked = authState.authConfigured && !authState.user;
  const hasAuthenticatedUser = Boolean(authState.user);
  const authPending = authState.loading;
  const hasAssistantSessionBootstrap =
    activeView === "assistant"
    && Boolean(selectedSessionId)
    && initialAssistantSessionBootstrap?.sessionId === selectedSessionId;
  const hasWorkPageBootstrap =
    activeView === "book"
    && Boolean(activeWorkId)
    && initialWorkPageBootstrap?.workId === activeWorkId
    && Boolean(initialWorkPageBootstrap?.work);
  const navigationItems = adminAccess.allowed
    ? [...NAV_ITEMS, { id: "admin" as const, label: "Admin", icon: ProfileIcon }]
    : NAV_ITEMS;
  const runningSessionIds = useMemo(() => {
    const next = new Set(
      sessions
        .filter((session) => session.activeRunStatus === "queued" || session.activeRunStatus === "running")
        .map((session) => session.id),
    );
    if (selectedSessionId && (isSending || sessionRuns.some((run) => run.status === "running" || run.status === "queued"))) {
      next.add(selectedSessionId);
    }
    return next;
  }, [isSending, selectedSessionId, sessionRuns, sessions]);
  const sessionNotifications = useMemo(
    () => buildSessionNotificationMap(notificationsState.notifications),
    [notificationsState.notifications],
  );
  const activeReaderFrameHref = useMemo(
    () => (
      activeWorkId && activeWork
        ? buildWorkContentFrameHref(activeWorkId, activeWork.gutenbergId, activePassageId, activeReaderPath)
        : null
    ),
    [activePassageId, activeReaderPath, activeWork, activeWorkId],
  );

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    if (activeView !== "assistant" || !selectedSessionId || authState.loading) {
      return;
    }
    const bootstrapRun = initialAssistantSessionBootstrap?.runState?.run;
    if (!bootstrapRun || bootstrapRun.sessionId !== selectedSessionId) {
      return;
    }
    if (Array.isArray(initialAssistantSessionBootstrap?.runState?.artifacts) && initialAssistantSessionBootstrap.runState.artifacts.length > 0) {
      return;
    }
    if (recoveredActiveRunId && recoveredActiveRunId !== bootstrapRun.id) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const nextState = await fetchRunState(selectedSessionId, bootstrapRun.id);
        if (cancelled || selectedSessionIdRef.current !== selectedSessionId) {
          return;
        }
        setRunArtifacts(Array.isArray(nextState.artifacts) ? nextState.artifacts : []);
        setMessages((current) => hydrateConversationMessages(selectedSessionId, current, nextState));
      } catch {
        // Best-effort backfill for lightweight bootstrap payloads.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeView,
    authState.loading,
    recoveredActiveRunId,
    selectedSessionId,
  ]);

  useEffect(() => {
    if (activeView !== "assistant" || !selectedSessionId || !sessionNotifications.has(selectedSessionId)) {
      return;
    }
    void handleMarkSessionNotificationsRead(selectedSessionId);
  }, [activeView, selectedSessionId, sessionNotifications]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    const authError = url.searchParams.get("auth_error");
    if (!authError) {
      return;
    }
    setLoadError(
      authError === "state_mismatch"
        ? "We couldn't complete sign-in because the session expired. Please try signing in again."
        : "We couldn't complete sign-in. Please try again.",
    );
    url.searchParams.delete("auth_error");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const next = await fetchCurrentUser();
        setAuthState({
          loading: false,
          authConfigured: next.authConfigured,
          user: next.user,
          error: null,
        });
      } catch (error) {
        setAuthState({
          loading: false,
          authConfigured: false,
          user: null,
          error: getErrorMessage(error, "We couldn't load your account right now."),
        });
      }
    })();
  }, []);

  useEffect(() => {
    if (activeView === "assistant_document") {
      return;
    }
    if (authState.loading) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchAdminAccess();
        if (!cancelled) {
          setAdminAccess({
            loading: false,
            allowed: next.allowed,
            authenticated: next.authenticated,
            authConfigured: next.authConfigured,
            user: next.user,
          });
        }
      } catch (error) {
        reportClientIncident(error, {
          source: "admin_access_load",
        });
        if (!cancelled) {
          setAdminAccess({
            loading: false,
            allowed: false,
            authenticated: false,
            authConfigured: authState.authConfigured,
            user: null,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authState.authConfigured, authState.loading, authState.user?.email, authState.user?.id]);

  useEffect(() => {
    if (authState.loading) {
      return;
    }
    if (!authState.user) {
      setNotificationsState({
        loading: false,
        error: null,
        notifications: [],
        unreadCount: 0,
      });
      return;
    }
    void loadNotifications({ silent: true });
  }, [authState.loading, authState.user?.id]);

  useEffect(() => {
    if (typeof window === "undefined" || !authState.user || authState.loading || authState.authConfigured === false) {
      return;
    }
    if (!guestUserId || guestUserId === authState.user.id) {
      return;
    }
    const storageKey = `${GUEST_CLAIM_STORAGE_PREFIX}${authState.user.id}:${guestUserId}`;
    if (window.localStorage.getItem(storageKey) === "done") {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        await claimGuestProfile(authState.user!.id, guestUserId);
        if (cancelled) {
          return;
        }
        window.localStorage.setItem(storageKey, "done");
        if (activeView === "profile") {
          const nextStats = await fetchProfileStats(activeProfileUserId ?? authState.user!.id);
          if (!cancelled) {
            setProfileStats(nextStats);
          }
        }
        if (!cancelled) {
          await refreshSessions(selectedSessionId);
        }
      } catch {
        // The claim path is best-effort and should not block the UI.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeProfileUserId,
    activeView,
    authState.authConfigured,
    authState.loading,
    authState.user,
    guestUserId,
    selectedSessionId,
  ]);

  useEffect(() => {
    latestReaderPathRef.current = activeReaderPath;
  }, [activeReaderPath]);

  useEffect(() => {
    latestReaderContextRef.current = {
      view: activeView,
      sessionId: selectedSessionId,
      workId: activeWorkId,
      chunkId: activeChunkId,
      profileUserId: activeProfileUserId,
      runId: selectedAdminRunId,
      adminSection,
      debugEnabled,
      gutenbergId: activeWork?.gutenbergId ?? null,
    };
  }, [
    activeChunkId,
    activeProfileUserId,
    activeView,
    activeWork?.gutenbergId,
    activeWorkId,
    adminSection,
    debugEnabled,
    selectedAdminRunId,
    selectedSessionId,
  ]);

  useEffect(() => {
    const handlePopState = () => {
      pendingUrlWriteModeRef.current = "replace";
      const next = readUrlState();
      latestReaderPathRef.current = next.readerPath;
      setActiveView(next.view);
      setSelectedSessionId(next.sessionId);
      setActiveWorkId(next.workId);
      setActiveReaderPath(next.readerPath);
      setActiveChunkId(next.chunkId);
      setActivePassageId(next.passageId ?? null);
      setHighlightedPassageExcerpt(null);
      setActiveProfileUserId(next.profileUserId);
      setSelectedAdminRunId(next.runId);
      setAdminSection(next.adminSection);
      setAdminRunInput(next.runId ?? "");
      setDebugEnabled(next.debugEnabled);
      setExploreAppliedFilters(next.exploreFilters);
      setExploreDraftFilters(next.exploreFilters);
      setExploreRandomSeed(next.exploreRandomSeed);
      setExploreQuery(next.exploreQuery);
      setExploreDraft(next.exploreQuery);
      setMobileNavOpen(false);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (suppressNextUrlWriteRef.current) {
      suppressNextUrlWriteRef.current = false;
      pendingUrlWriteModeRef.current = "replace";
      return;
    }
    writeUrlState({
      view: activeView,
      sessionId: selectedSessionId,
      workId: activeWorkId,
      readerPath: activeReaderPath,
      chunkId: activeChunkId,
      passageId: activePassageId,
      profileUserId: activeProfileUserId,
      runId: selectedAdminRunId,
      adminSection,
      debugEnabled,
      exploreFilters: exploreAppliedFilters,
      exploreRandomSeed,
      exploreQuery,
    }, pendingUrlWriteModeRef.current);
    pendingUrlWriteModeRef.current = "replace";
  }, [activeView, selectedSessionId, activeWorkId, activeReaderPath, activeChunkId, activePassageId, activeProfileUserId, selectedAdminRunId, adminSection, debugEnabled, exploreAppliedFilters, exploreRandomSeed, exploreQuery]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const seo = buildSeoState({
      activeView,
      activeWork,
      activeWorkId,
      activeProfileUserId,
      publicProfile,
    });
    const canonicalUrl = new URL(seo.canonicalPath, SEO_SITE_ORIGIN).toString();
    const imageUrl = new URL(DEFAULT_OG_IMAGE_PATH, SEO_SITE_ORIGIN).toString();

    document.title = seo.title;
    upsertMetaTag("name", "description", seo.description);
    upsertMetaTag("name", "robots", seo.robots);
    upsertMetaTag("name", "application-name", SEO_SITE_NAME);
    upsertMetaTag("name", "apple-mobile-web-app-title", SEO_SITE_NAME);
    upsertMetaTag("property", "og:title", seo.title);
    upsertMetaTag("property", "og:description", seo.description);
    upsertMetaTag("property", "og:site_name", SEO_SITE_NAME);
    upsertMetaTag("property", "og:type", seo.ogType);
    upsertMetaTag("property", "og:url", canonicalUrl);
    upsertMetaTag("property", "og:image", imageUrl);
    upsertMetaTag("property", "og:image:alt", "alpha book preview card");
    upsertMetaTag("name", "twitter:card", "summary_large_image");
    upsertMetaTag("name", "twitter:title", seo.title);
    upsertMetaTag("name", "twitter:description", seo.description);
    upsertMetaTag("name", "twitter:image", imageUrl);
    upsertLinkTag("canonical", canonicalUrl);
    upsertJsonLdScript("seo-structured-data", seo.jsonLd);
  }, [
    activeProfileUserId,
    activeView,
    activeWork,
    activeWorkId,
    publicProfile,
  ]);

  useEffect(() => {
    if (activeView === "profile" && currentUserId && !activeProfileUserId) {
      setActiveProfileUserId(currentUserId);
    }
  }, [activeView, activeProfileUserId, currentUserId]);

  useEffect(() => {
    if (!debugEnabled) {
      setAgentationComponent(null);
      return;
    }

    let cancelled = false;
    void import("agentation")
      .then((module) => {
        if (!cancelled) {
          setAgentationComponent(() => module.Agentation);
        }
      })
      .catch((error) => {
        reportClientIncident(error, {
          source: "agentation_import",
        });
        console.error("Failed to load Agentation.", error);
      });

    return () => {
      cancelled = true;
    };
  }, [debugEnabled]);

  useEffect(() => {
    if (AssistantSurfaceComponent || (activeView !== "assistant" && activeView !== "book")) {
      return;
    }

    let cancelled = false;
    const loadAssistantSurface = () => {
      void import("./components/assistant-surface")
        .then((module) => {
          if (!cancelled) {
            setAssistantSurfaceComponent(() => module.default);
          }
        })
        .catch((error) => {
          reportClientIncident(error, {
            source: "assistant_surface_import",
          });
          console.error("Failed to load assistant surface.", error);
        });
    };

    if (activeView === "assistant") {
      loadAssistantSurface();
      return () => {
        cancelled = true;
      };
    }

    const idleCallback = typeof window !== "undefined" && "requestIdleCallback" in window
      ? window.requestIdleCallback(loadAssistantSurface, { timeout: 1500 })
      : null;
    const timeoutId = idleCallback == null ? window.setTimeout(loadAssistantSurface, 500) : null;

    return () => {
      cancelled = true;
      if (idleCallback != null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleCallback);
      }
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [AssistantSurfaceComponent, activeView]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleError = (event: ErrorEvent) => {
      reportClientIncident(event.error ?? event.message, {
        source: "window_error",
        filename: event.filename || null,
        lineno: event.lineno || null,
        colno: event.colno || null,
      });
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      reportClientIncident(event.reason, {
        source: "unhandledrejection",
      });
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, [currentUserId]);

  useEffect(() => {
    if (activeView !== "explore" || !activeWorkId) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeExploreWorkOverlay();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeView, activeWorkId]);

  async function loadExploreWorks(reset = false) {
    const offset = reset ? 0 : feedNextOffset;
    if (offset === null || (feedLoading && !reset)) {
      return;
    }
    try {
      if (reset) {
        setFeedInitialLoadState("loading");
        setFeedWorks([]);
        setFeedNextOffset(0);
      }
      setFeedLoading(true);
      if (exploreQuery.trim().length > 0) {
        const next = await fetchExploreSemanticSearch({
          query: exploreQuery.trim(),
          limit: EXPLORE_PAGE_SIZE,
          language: exploreAppliedFilters.language === "all" ? null : exploreAppliedFilters.language,
          subject: exploreAppliedFilters.subject === "all" ? null : exploreAppliedFilters.subject,
          bookshelf: exploreAppliedFilters.bookshelf === "all" ? null : exploreAppliedFilters.bookshelf,
        });
        setFeedWorks(next.works);
        setFeedNextOffset(null);
        setFeedTotalCount(next.works.length);
      } else {
        const next = await fetchWorks({
          offset,
          limit: EXPLORE_PAGE_SIZE,
          language: exploreAppliedFilters.language === "all" ? null : exploreAppliedFilters.language,
          subject: exploreAppliedFilters.subject === "all" ? null : exploreAppliedFilters.subject,
          bookshelf: exploreAppliedFilters.bookshelf === "all" ? null : exploreAppliedFilters.bookshelf,
          randomSeed: exploreRandomSeed,
        });
        setFeedWorks((current) => {
          if (reset) {
            return next.works;
          }
          const seen = new Set(current.map((work) => work.id));
          return [...current, ...next.works.filter((work) => !seen.has(work.id))];
        });
        setFeedNextOffset(next.nextOffset);
        setFeedTotalCount(next.totalCount);
        setFeedFacets(next.facets);
      }
      if (reset) {
        setFeedInitialLoadState("ready");
      }
    } catch (error) {
      if (reset) {
        setFeedInitialLoadState("error");
      }
      setLoadError(getErrorMessage(error, "We couldn't load the corpus feed."));
    } finally {
      setFeedLoading(false);
    }
  }

  useEffect(() => {
    if (activeView !== "explore") {
      return;
    }
    void loadExploreWorks(true);
  }, [activeView, exploreAppliedFilters, exploreRandomSeed, exploreQuery]);

  useEffect(() => {
    setExploreDraftFilters(exploreAppliedFilters);
  }, [exploreAppliedFilters]);

  useEffect(() => {
    if (!activeWorkId) {
      setActiveWorkLoading(false);
      setActiveWorkSourceLoading(false);
      setActiveWork(null);
      setActiveWorkSource(null);
      setActivePassageId(null);
      setHighlightedPassageExcerpt(null);
      return;
    }
    if (hasWorkPageBootstrap) {
      setActiveWorkLoading(false);
      setActivePassageId(null);
      setHighlightedPassageExcerpt(null);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      setActiveWorkLoading(false);
      setLoadError("Loading this book is taking too long. Try refreshing or opening it again.");
    }, 12000);

    void (async () => {
      try {
        setActiveWorkLoading(true);
        const detail = await fetchWorkDetail(activeWorkId);
        if (cancelled) {
          return;
        }
        setActiveWork(detail.work);
        setActiveWorkSource(detail.source ?? null);
        setActivePassageId(null);
        setHighlightedPassageExcerpt(null);
      } catch (error) {
        if (!cancelled) {
          setLoadError(getErrorMessage(error, "We couldn't load that book."));
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (!cancelled) {
          setActiveWorkLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeWorkId, hasWorkPageBootstrap]);

  useEffect(() => {
    if (!activeWorkId) {
      setActiveWorkSourceLoading(false);
      setActiveWorkSource(null);
      return;
    }
    if (hasWorkPageBootstrap) {
      setActiveWorkSourceLoading(false);
      return;
    }
    if (!activeWork) {
      setActiveWorkSourceLoading(false);
      return;
    }

    let cancelled = false;
    const usesStaticBookSurface = activeWork?.gutenbergId != null && String(activeWork.gutenbergId).trim().length > 0;
    const hasPassageHash = typeof window !== "undefined" && window.location.hash.replace(/^#/, "").trim().length > 0;
    const needsFullWorkSource = !usesStaticBookSurface || activeChunkId != null || pendingCitation != null || hasPassageHash;
    if (!needsFullWorkSource) {
      setActiveWorkSourceLoading(false);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      setActiveWorkSourceLoading(false);
      if (!usesStaticBookSurface) {
        setLoadError("Loading this book's text is taking too long. Try refreshing or opening it again.");
      }
    }, 12000);

    void (async () => {
      try {
        setActiveWorkSourceLoading(true);
        const source = await fetchWorkSource(activeWorkId);
        if (cancelled) {
          return;
        }
        setActiveWorkSource(source);
      } catch (error) {
        if (!cancelled) {
          if (!usesStaticBookSurface) {
            setLoadError(getErrorMessage(error, "We couldn't load that book's text."));
          }
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (!cancelled) {
          setActiveWorkSourceLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeChunkId, activeWork, activeWorkId, hasWorkPageBootstrap, pendingCitation]);

  useEffect(() => {
    if (!activeProfileUserId || (currentUserId && activeProfileUserId === currentUserId)) {
      setPublicProfile(null);
      setPublicProfileLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        setPublicProfileLoading(true);
        const next = await fetchProfile(activeProfileUserId);
        if (!cancelled) {
          setPublicProfile(next);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(getErrorMessage(error, "We couldn't load that profile."));
          setPublicProfile(null);
        }
      } finally {
        if (!cancelled) {
          setPublicProfileLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProfileUserId, currentUserId]);

  useEffect(() => {
    const targetProfileId = activeView === "profile"
      ? (activeProfileUserId ?? currentUserId)
      : null;
    if (!targetProfileId) {
      setProfileStats(null);
      setProfileStatsLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        setProfileStatsLoading(true);
        const next = await fetchProfileStats(targetProfileId, {
          fallbackUserId: !authState.authConfigured && currentUserId === targetProfileId ? currentUserId : null,
        });
        if (!cancelled) {
          setProfileStats(next);
        }
      } catch (error) {
        if (!cancelled) {
          reportClientIncident(error, {
            source: "profile_stats_load",
            userId: targetProfileId,
          });
          setProfileStats(null);
        }
      } finally {
        if (!cancelled) {
          setProfileStatsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProfileUserId, activeView, authState.authConfigured, currentUserId]);

  useEffect(() => {
    if (!activeChunkId || !activeWorkId || activeView !== "book") {
      return;
    }
    setPendingCitation((current) => {
      if (current?.workId === activeWorkId && current.chunkId === activeChunkId) {
        return current;
      }
      return {
        workId: activeWorkId,
        chunkId: activeChunkId,
        label: `${activeWorkId}#${activeChunkId}`,
        excerpt: "",
      };
    });
  }, [activeChunkId, activeWorkId, activeView]);

  useEffect(() => {
    if (!pendingCitation || !activeWork || activeWork.id !== pendingCitation.workId || readerPassages.length === 0) {
      return;
    }

    const match = findPassageForCitation(readerPassages, pendingCitation);
    if (match) {
      pendingUrlWriteModeRef.current = "replace";
      setActivePassageId(match.passageId);
      setHighlightedPassageExcerpt(match.highlight);
      if (activeChunkId) {
        setActiveChunkId(null);
      }
    }
    setPendingCitation(null);
  }, [activeWork, pendingCitation, readerPassages, activeChunkId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleReaderLocation = (event: MessageEvent) => {
      if (event.origin !== BOOK_CONTENT_ORIGIN) {
        return;
      }
      const data = event.data;
      if (!data || typeof data !== "object" || data === null || (data as { type?: string }).type !== "alphabook-reader-location") {
        return;
      }
      const path = typeof (data as { path?: unknown }).path === "string" ? (data as { path: string }).path : null;
      const historyMode = (data as { history?: unknown }).history === "push" ? "push" : "replace";
      const context = latestReaderContextRef.current;
      const normalized = normalizeReaderPath(path);
      if (!normalized || normalized === latestReaderPathRef.current) {
        return;
      }
      latestReaderPathRef.current = normalized;
      lastReaderFrameHrefRef.current = `${BOOK_CONTENT_ORIGIN}${appendBookVersionToReaderPath(normalized)}`;
      suppressNextUrlWriteRef.current = true;
      writeUrlState({
        view: context.view,
        sessionId: context.sessionId,
        workId: context.workId,
        readerPath: normalized,
        chunkId: context.chunkId,
        passageId: activePassageId,
        profileUserId: context.profileUserId,
        runId: context.runId,
        adminSection: context.adminSection,
        debugEnabled: context.debugEnabled,
        exploreFilters: exploreAppliedFilters,
        exploreRandomSeed,
      }, historyMode);
      setActiveReaderPath(normalized);
    };

    window.addEventListener("message", handleReaderLocation);
    return () => window.removeEventListener("message", handleReaderLocation);
  }, [activePassageId, exploreAppliedFilters, exploreRandomSeed]);

  useEffect(() => {
    if (!activeWorkId) {
      lastReaderFrameHrefRef.current = null;
      setActiveReaderPath(null);
    }
  }, [activeWorkId]);

  useEffect(() => {
    if (!pendingCitation) {
      return;
    }
    setActiveReaderPath(null);
  }, [pendingCitation]);

  useEffect(() => {
    const normalized = normalizeReaderPath(activeReaderPath);
    if (activeReaderPath && !normalized) {
      setActiveReaderPath(null);
    }
  }, [activeReaderPath]);

  useEffect(() => {
    if (!activeReaderFrameHref) {
      return;
    }
    const frame = bookReaderFrameRef.current;
    if (!frame) {
      return;
    }
    if (lastReaderFrameHrefRef.current === activeReaderFrameHref) {
      return;
    }
    if (frame.getAttribute("src") !== activeReaderFrameHref) {
      frame.setAttribute("src", activeReaderFrameHref);
    }
    lastReaderFrameHrefRef.current = activeReaderFrameHref;
  }, [activeReaderFrameHref]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const syncPassageFromHash = () => {
      const hash = decodeURIComponent(window.location.hash.replace(/^#/, "").trim());
      if (!hash) {
        setActivePassageId(null);
        setHighlightedPassageExcerpt(null);
        return;
      }
      if (readerPassages.some((passage) => passage.id === hash)) {
        setActivePassageId(hash);
      }
    };

    syncPassageFromHash();
    window.addEventListener("hashchange", syncPassageFromHash);
    return () => window.removeEventListener("hashchange", syncPassageFromHash);
  }, [readerPassages]);

  useEffect(() => {
    if (!activePassageId) {
      return;
    }
    const target = document.getElementById(activePassageId);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activePassageId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    streamingAssistantIdRef.current = streamingAssistantId;
  }, [streamingAssistantId]);

  useEffect(() => {
    if (activeView !== "assistant" || !selectedSessionId) {
      return;
    }
    const serverRendered = document.getElementById("assistant-session-ssr");
    if (serverRendered) {
      serverRendered.remove();
    }
  }, [activeView, selectedSessionId]);

  useEffect(() => {
    if (activeView !== "book" || !activeWorkId) {
      return;
    }
    const serverRendered = document.getElementById("work-page-ssr");
    if (serverRendered) {
      serverRendered.remove();
    }
  }, [activeView, activeWorkId]);

  useEffect(() => {
    if (authState.loading) {
      return;
    }
    if (!currentUserId) {
      clearCachedSessions();
      return;
    }
    writeCachedSessions(currentUserId, sessions);
  }, [authState.loading, currentUserId, sessions]);

  useEffect(() => {
    if (authState.loading) {
      return;
    }
    if (!currentUserId) {
      setSessionsResolved(true);
      setSessionsLoading(false);
      setSessions([]);
      setMessages([]);
      return;
    }

    void (async () => {
      try {
        setSessionsResolved(false);
        setSessionsLoading(true);
        const nextSessions = await fetchSessions(authState.authConfigured ? undefined : currentUserId);
        setSessions(nextSessions);
      } catch (error) {
        setLoadError(getErrorMessage(error, "We couldn't load your sessions."));
      } finally {
        setSessionsLoading(false);
        setSessionsResolved(true);
      }
    })();
  }, [activeView, authState.authConfigured, currentUserId]);

  useEffect(() => {
    if (activeView === "assistant_document") {
      return;
    }
    if (authState.loading) {
      return;
    }
    if (!selectedSessionId) {
      setMessagesLoading(false);
      setConversationHydrated(true);
      setMessages([]);
      return;
    }

    void (async () => {
      try {
        setMessagesLoading(true);
        await refreshAssistantConversation(selectedSessionId);
      } catch (error) {
        if (selectedSessionIdRef.current === selectedSessionId) {
          setConversationHydrated(true);
        }
        setLoadError(getErrorMessage(error, "We couldn't load this conversation."));
      } finally {
        setMessagesLoading(false);
      }
    })();
  }, [activeView, authState.loading, selectedSessionId]);

  useEffect(() => {
    if (activeView === "assistant_document") {
      return;
    }
    if (authState.loading || isSending || !selectedSessionId || !recoveredActiveRunId) {
      return;
    }

    let cancelled = false;
    let pollTimer: number | null = null;
    let refreshTimer: number | null = null;
    let streamHandshakeTimer: number | null = null;
    let streamFailed = false;
    let sawStreamEvent = false;
    let consecutivePollFailures = 0;
    const abortController = new AbortController();
    reconnectRunStreamAbortControllerRef.current?.abort();
    reconnectRunStreamAbortControllerRef.current = abortController;
    setStreamConnected(false);

    const pollMessages = async () => {
      try {
        const [nextMessages, nextRunState] = await Promise.all([
          fetchMessages(selectedSessionId),
          recoveredActiveRunId ? fetchRunState(selectedSessionId, recoveredActiveRunId).catch(() => null) : Promise.resolve(null),
        ]);
        if (cancelled || selectedSessionIdRef.current !== selectedSessionId) {
          return;
        }
        consecutivePollFailures = 0;
        const hydrated = hydrateConversationMessages(selectedSessionId, nextMessages, nextRunState);
        setMessages(hydrated);
        setRunArtifacts(Array.isArray(nextRunState?.artifacts) ? nextRunState.artifacts : []);
        pollTimer = window.setTimeout(() => {
          void pollMessages();
        }, 2000);
      } catch (error) {
        if (cancelled) {
          return;
        }
        consecutivePollFailures += 1;
        if (!isRetryableReconnectError(error) || consecutivePollFailures >= 5) {
          setStreamConnected(false);
          setRecoveredActiveRunId(null);
          setLoadError(getErrorMessage(error, "We lost the assistant connection. Please refresh or reopen the conversation."));
          return;
        }
        pollTimer = window.setTimeout(() => {
          void pollMessages();
        }, 4000);
      }
    };

    const refreshMessages = async () => {
      const [nextMessages, nextRunState] = await Promise.all([
        fetchMessages(selectedSessionId),
        recoveredActiveRunId ? fetchRunState(selectedSessionId, recoveredActiveRunId).catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled || selectedSessionIdRef.current !== selectedSessionId) {
        return;
      }
      const hydrated = hydrateConversationMessages(selectedSessionId, nextMessages, nextRunState);
      setMessages(hydrated);
      setRunArtifacts(Array.isArray(nextRunState?.artifacts) ? nextRunState.artifacts : []);
    };

    const scheduleRefreshMessages = (delayMs = 750) => {
      if (cancelled || refreshTimer !== null) {
        return;
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshMessages();
      }, delayMs);
    };

    void streamRun(
      selectedSessionId,
      recoveredActiveRunId,
      {
        onEvent: (event) => {
          if (cancelled) {
            return;
          }
          if (
            event.event === "run.started"
            || event.event === "assistant.plan"
            || event.event === "job.started"
            || event.event === "job.progress"
            || event.event === "job.log"
            || event.event === "job.updated"
            || event.event === "tool.started"
            || event.event === "tool.progress"
            || event.event === "tool.completed"
            || event.event === "assistant.delta"
            || event.event === "assistant.completed"
          ) {
            sawStreamEvent = true;
            setStreamConnected(true);
          }
          if (event.event === "assistant.delta" && typeof event.data.text === "string") {
            appendStreamingAssistantDelta(selectedSessionId, event.data.text);
            return;
          }
          if (event.event === "assistant.plan" && typeof event.data.text === "string") {
            appendAssistantPlan(selectedSessionId, event.data.text);
          }
          if (event.event === "assistant.completed" && typeof event.data.answer === "string") {
            completeStreamingAssistantAnswer(
              selectedSessionId,
              event.data.answer,
              Array.isArray(event.data.citations) ? event.data.citations as Citation[] : [],
              typeof event.data.phase === "string" ? event.data.phase : "answer",
            );
          }
          if (
            event.event === "assistant.plan"
            || event.event === "job.started"
            || event.event === "job.updated"
            || event.event === "tool.started"
            || event.event === "tool.completed"
            || event.event === "artifact.created"
            || event.event === "artifacts.updated"
            || event.event === "assistant.completed"
            || event.event === "run.completed"
          ) {
            scheduleRefreshMessages();
          }
        },
      },
      {
        signal: abortController.signal,
      },
    ).catch((error) => {
      if (cancelled || (error instanceof DOMException && error.name === "AbortError")) {
        return;
      }
      streamFailed = true;
      setStreamConnected(false);
      void pollMessages();
    });

    streamHandshakeTimer = window.setTimeout(() => {
      if (!cancelled && !streamFailed && !sawStreamEvent) {
        void pollMessages();
      }
    }, 2500);

    return () => {
      cancelled = true;
      abortController.abort();
      if (reconnectRunStreamAbortControllerRef.current === abortController) {
        reconnectRunStreamAbortControllerRef.current = null;
      }
      setStreamConnected(false);
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
      }
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      if (streamHandshakeTimer !== null) {
        window.clearTimeout(streamHandshakeTimer);
      }
    };
  }, [activeView, authState.loading, isSending, recoveredActiveRunId, selectedSessionId]);

  useEffect(() => {
    if (activeView === "assistant_document") {
      return;
    }
    if (!selectedSessionId) {
      setRunArtifacts([]);
      return;
    }
    if (authState.loading) {
      if (!hasAssistantSessionBootstrap) {
        setRunArtifacts([]);
      }
      return;
    }

    const preferredRun =
      sessionRuns.find((run) => run.id === recoveredActiveRunId)
      ?? sessionRuns.find((run) => run.status === "running" || run.status === "queued")
      ?? [...sessionRuns].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
      ?? null;
    if (!preferredRun) {
      setRunArtifacts([]);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const nextState = await fetchRunState(selectedSessionId, preferredRun.id);
        if (!cancelled && selectedSessionIdRef.current === selectedSessionId) {
          setRunArtifacts(Array.isArray(nextState.artifacts) ? nextState.artifacts : []);
        }
      } catch {
        if (!cancelled && selectedSessionIdRef.current === selectedSessionId) {
          setRunArtifacts([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeView, authState.loading, hasAssistantSessionBootstrap, recoveredActiveRunId, selectedSessionId, sessionRuns]);

  useEffect(() => {
    if (activeView === "assistant_document") {
      return;
    }
    if (authState.loading) {
      return;
    }
    if (!selectedSessionId) {
      setRecoveredActiveRunId(null);
      setStreamConnected(false);
      setSessionRuns([]);
      return;
    }

    let cancelled = false;
    let pollTimer: number | null = null;

    const loadRuns = async () => {
      try {
        const runs = await fetchRuns(selectedSessionId);
        if (cancelled || selectedSessionIdRef.current !== selectedSessionId) {
          return;
        }
        setSessionRuns(runs);
        const activeRun = runs.find((run) => run.status === "running" || run.status === "queued") ?? null;
        const nextRunId = activeRun?.id ?? null;
        setRecoveredActiveRunId(nextRunId);
        if (!nextRunId) {
          setStreamConnected(false);
        }
        if (!isSending) {
          activeRunIdRef.current = nextRunId;
        }
        if (nextRunId) {
          pollTimer = window.setTimeout(() => {
            void loadRuns();
          }, 15000);
        }
      } catch {
        if (!cancelled && selectedSessionIdRef.current === selectedSessionId) {
          setSessionRuns([]);
          setRecoveredActiveRunId(null);
          setStreamConnected(false);
        }
      }
    };

    void loadRuns();

    return () => {
      cancelled = true;
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
      }
    };
  }, [activeView, authState.loading, isSending, selectedSessionId]);

  const visibleMessages = useMemo(() => dedupeAdjacentErrorMessages(messages), [messages]);

  async function loadNotifications(options: { silent?: boolean } = {}) {
    if (!authState.user) {
      setNotificationsState({
        loading: false,
        error: null,
        notifications: [],
        unreadCount: 0,
      });
      return;
    }
    if (!options.silent) {
      setNotificationsState((current) => ({ ...current, loading: true, error: null }));
    }
    try {
      const next = await fetchNotifications();
      setNotificationsState({
        loading: false,
        error: null,
        notifications: next.notifications,
        unreadCount: next.unreadCount,
      });
    } catch (error) {
      if (options.silent) {
        return;
      }
      setNotificationsState((current) => ({
        ...current,
        loading: false,
        error: getErrorMessage(error, "We couldn't load notifications."),
      }));
    }
  }

  async function handleMarkSessionNotificationsRead(sessionId: string) {
    const unreadNotificationIds = notificationsState.notifications
      .filter((notification) => notification.sessionId === sessionId && !notification.readAt)
      .map((notification) => notification.id);
    if (unreadNotificationIds.length === 0) {
      return;
    }

    const readAt = new Date().toISOString();
    setNotificationsState((current) => ({
      ...current,
      notifications: current.notifications.map((notification) =>
        notification.sessionId === sessionId && !notification.readAt
          ? { ...notification, readAt }
          : notification,
      ),
      unreadCount: Math.max(0, current.unreadCount - unreadNotificationIds.length),
    }));

    const results = await Promise.allSettled(unreadNotificationIds.map((notificationId) => markNotificationRead(notificationId)));
    if (results.some((result) => result.status === "rejected")) {
      setNotificationsState((current) => ({
        ...current,
        error: "We couldn't clear that session notification.",
      }));
      void loadNotifications({ silent: true });
    }
  }

  async function refreshSessions(preferredSessionId?: string | null) {
    if (!currentUserId) {
      return;
    }
    const nextSessions = await fetchSessions(authState.authConfigured ? undefined : currentUserId);
    setSessions(nextSessions);
    if (preferredSessionId !== undefined) {
      selectedSessionIdRef.current = preferredSessionId;
      setSelectedSessionId(preferredSessionId);
    }
  }

  async function refreshAssistantConversation(sessionId: string) {
    const bootstrap = await fetchAssistantSessionBootstrap(sessionId);
    const nextRuns = Array.isArray(bootstrap.runs) ? bootstrap.runs : [];
    const activeRun =
      nextRuns.find((run) => run.status === "running" || run.status === "queued")
      ?? null;
    const hydratedMessages = hydrateConversationMessages(sessionId, bootstrap.messages, bootstrap.runState);
    setSessions((current) => (
      Array.isArray(bootstrap.sessions) && bootstrap.sessions.length > 0
        ? bootstrap.sessions
        : current
    ));
    if (selectedSessionIdRef.current !== sessionId) {
      return;
    }
    setConversationHydrated(true);
    setSessionRuns(nextRuns);
    setRecoveredActiveRunId(activeRun?.id ?? null);
    setRunArtifacts(Array.isArray(bootstrap.runState?.artifacts) ? bootstrap.runState.artifacts : []);
    setMessages((current) => (
      shouldPreserveOptimisticMessages(current, hydratedMessages, sessionId, activeRun != null)
        ? current
        : hydratedMessages
    ));
  }

  function appendStreamingAssistantDelta(sessionId: string | null | undefined, text: string) {
    if (!text) {
      return;
    }
    const resolvedSessionId = sessionId ?? selectedSessionIdRef.current ?? "pending";
    const activeStreamingMessage = [...messagesRef.current].reverse().find((message) =>
      message.role === "assistant" && (
        message.id === streamingAssistantIdRef.current
        || message.metadata?.streaming === true
      )
    );
    const targetMessageId = activeStreamingMessage?.id ?? streamingAssistantIdRef.current ?? crypto.randomUUID();
    if (streamingAssistantIdRef.current !== targetMessageId) {
      streamingAssistantIdRef.current = targetMessageId;
      setStreamingAssistantId(targetMessageId);
    }
    setMessages((current) => {
      const targetIndex = current.findIndex((message) => message.id === targetMessageId);

      if (targetIndex === -1) {
        return [
          ...current,
          {
            id: targetMessageId,
            sessionId: resolvedSessionId,
            role: "assistant",
            content: text,
            metadata: {
              phase: "answer",
              streaming: true,
              optimistic: true,
            },
            createdAt: new Date().toISOString(),
            citations: [],
            toolCalls: [],
          },
        ];
      }

      return current.map((message, index) =>
        index === targetIndex
          ? {
              ...message,
              content: `${message.content ?? ""}${text}`,
              metadata: {
                ...(message.metadata ?? {}),
                phase: "answer",
                streaming: true,
                optimistic: true,
              },
            }
          : message,
      );
    });
  }

  function appendAssistantPlan(sessionId: string | null | undefined, text: string) {
    if (!text) {
      return;
    }
    const resolvedSessionId = sessionId ?? selectedSessionIdRef.current ?? "pending";
    setMessages((current) => {
      const lastAssistant = [...current].reverse().find((message) => message.role === "assistant");
      if (lastAssistant?.metadata?.phase === "plan") {
        return current.map((message) =>
          message.id === lastAssistant.id
            ? {
                ...message,
                content: text,
                metadata: {
                  ...(message.metadata ?? {}),
                  phase: "plan",
                  optimistic: true,
                },
              }
            : message,
        );
      }
      return [
        ...current,
        {
          id: crypto.randomUUID(),
          sessionId: resolvedSessionId,
          role: "assistant",
          content: text,
          metadata: {
            phase: "plan",
            optimistic: true,
          },
          createdAt: new Date().toISOString(),
          citations: [],
          toolCalls: [],
        },
      ];
    });
  }

  function completeStreamingAssistantAnswer(
    sessionId: string | null | undefined,
    answer: string,
    citations: Citation[] = [],
    phase: string | null = "answer",
  ) {
    const resolvedSessionId = sessionId ?? selectedSessionIdRef.current ?? "pending";
    const targetMessageId = streamingAssistantIdRef.current;
    streamingAssistantIdRef.current = null;
    setStreamingAssistantId(null);
    setMessages((current) => {
      const targetIndex = targetMessageId
        ? current.findIndex((message) => message.id === targetMessageId)
        : -1;
      if (targetIndex === -1) {
        return [
          ...current,
          {
            id: crypto.randomUUID(),
            sessionId: resolvedSessionId,
            role: "assistant",
            content: answer,
            metadata: phase ? { phase } : {},
            createdAt: new Date().toISOString(),
            citations,
            toolCalls: [],
          },
        ];
      }
      return current.map((message, index) =>
        index === targetIndex
          ? {
              ...message,
              content: answer,
              metadata: {
                ...(message.metadata ?? {}),
                ...(phase ? { phase } : {}),
                streaming: false,
                optimistic: true,
              },
              citations,
            }
          : message,
      );
    });
  }

  function detachActiveAssistantStreams() {
    activeRunTokenRef.current += 1;
    activeChatAbortControllerRef.current?.abort();
    activeChatAbortControllerRef.current = null;
    reconnectRunStreamAbortControllerRef.current?.abort();
    reconnectRunStreamAbortControllerRef.current = null;
    activeRunIdRef.current = null;
    setIsSending(false);
    streamingAssistantIdRef.current = null;
    setStreamingAssistantId(null);
    setStreamConnected(false);
  }

  function track(event: string, properties: Record<string, unknown> = {}) {
    sendAnalyticsEvent(event, properties, currentUserId);
  }

  function reportClientIncident(error: unknown, context: Record<string, unknown> = {}) {
    const normalized = normalizeClientError(error);
    sendAnalyticsEvent("unexpected_error", {
      service: "frontend",
      severity: "error",
      source: "client",
      message: normalized.message,
      errorName: normalized.name,
      stack: normalized.stack,
      href: typeof window !== "undefined" ? window.location.href : null,
      ...context,
    }, currentUserId);
  }

  async function loadAdminRunLogs(runId: string) {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      setAdminRunLog({
        loading: false,
        error: "Enter a run ID.",
        runId: "",
        payload: null,
      });
      setSelectedAdminRunId(null);
      return;
    }

    try {
      pendingUrlWriteModeRef.current = "push";
      setAdminRunLog((current) => ({
        ...current,
        loading: true,
        error: null,
        runId: normalizedRunId,
      }));
      const payload = await fetchAdminRunLogs(normalizedRunId);
      setSelectedAdminRunId(normalizedRunId);
      setAdminSection("logs");
      setAdminRunInput(normalizedRunId);
      setAdminRunLog({
        loading: false,
        error: null,
        runId: normalizedRunId,
        payload,
      });
    } catch (error) {
      setSelectedAdminRunId(normalizedRunId);
      setAdminSection("logs");
      setAdminRunInput(normalizedRunId);
      setAdminRunLog({
        loading: false,
        error: getErrorMessage(error, "We couldn't load those run logs."),
        runId: normalizedRunId,
        payload: null,
      });
    }
  }

  async function loadAdminUsers() {
    try {
      setAdminUsers((current) => ({ ...current, loading: true, error: null }));
      const rows = await fetchAdminUsers();
      setAdminUsers({
        loading: false,
        error: null,
        rows,
      });
    } catch (error) {
      setAdminUsers({
        loading: false,
        error: getErrorMessage(error, "We couldn't load users."),
        rows: [],
      });
    }
  }

  async function loadAdminRuns() {
    try {
      setAdminRuns((current) => ({ ...current, loading: true, error: null }));
      const rows = await fetchAdminRuns();
      setAdminRuns({
        loading: false,
        error: null,
        rows,
      });
    } catch (error) {
      setAdminRuns({
        loading: false,
        error: getErrorMessage(error, "We couldn't load runs."),
        rows: [],
      });
    }
  }

  async function loadAdminSessions() {
    try {
      setAdminSessions((current) => ({ ...current, loading: true, error: null }));
      const rows = await fetchAdminSessions();
      setAdminSessions({
        loading: false,
        error: null,
        rows,
      });
    } catch (error) {
      setAdminSessions({
        loading: false,
        error: getErrorMessage(error, "We couldn't load sessions."),
        rows: [],
      });
    }
  }

  async function loadAdminAnalytics(query = adminAnalytics.draft) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setAdminAnalytics((current) => ({
        ...current,
        loading: false,
        error: "Enter an analytics question.",
      }));
      return;
    }
    try {
      setAdminAnalytics((current) => ({
        ...current,
        loading: true,
        error: null,
        query: normalizedQuery,
        draft: query,
      }));
      const payload = await queryAdminAnalytics(normalizedQuery, 7);
      setAdminAnalytics((current) => ({
        ...current,
        loading: false,
        error: null,
        query: normalizedQuery,
        payload,
      }));
    } catch (error) {
      setAdminAnalytics((current) => ({
        ...current,
        loading: false,
        error: getErrorMessage(error, "We couldn't load analytics."),
        query: normalizedQuery,
      }));
    }
  }

  async function loadAdminIncidents(options: {
    days?: number;
    query?: string;
    selectedFingerprint?: string | null;
  } = {}) {
    try {
      const nextDays = options.days ?? adminIncidents.days;
      const nextQuery = options.query ?? adminIncidents.query;
      const nextSelectedFingerprint = options.selectedFingerprint ?? adminIncidents.selectedFingerprint;
      setAdminIncidents((current) => ({
        ...current,
        loading: true,
        error: null,
        days: nextDays,
        query: nextQuery,
        selectedFingerprint: nextSelectedFingerprint,
      }));
      const payload = await fetchAdminIncidents({
        days: nextDays,
        query: nextQuery,
        limit: 120,
        eventLimit: 600,
      });
      const grouped = Array.isArray(payload.incidents) ? payload.incidents as Array<Record<string, unknown>> : [];
      const firstFingerprint = grouped[0] && typeof grouped[0].fingerprint === "string" ? grouped[0].fingerprint : null;
      setAdminIncidents({
        loading: false,
        error: null,
        days: nextDays,
        query: nextQuery,
        selectedFingerprint: nextSelectedFingerprint ?? firstFingerprint,
        payload,
      });
    } catch (error) {
      setAdminIncidents({
        loading: false,
        error: getErrorMessage(error, "We couldn't load incidents."),
        days: options.days ?? adminIncidents.days,
        query: options.query ?? adminIncidents.query,
        selectedFingerprint: options.selectedFingerprint ?? adminIncidents.selectedFingerprint,
        payload: null,
      });
    }
  }

  useEffect(() => {
    if (!adminAccess.allowed || !selectedAdminRunId || adminRunLog.loading || adminRunLog.payload || adminRunLog.error) {
      return;
    }
    void loadAdminRunLogs(selectedAdminRunId);
  }, [adminAccess.allowed, adminRunLog.error, adminRunLog.loading, adminRunLog.payload, selectedAdminRunId]);

  useEffect(() => {
    if (!adminAccess.allowed) {
      return;
    }
    if (adminSection === "users" && adminUsers.rows.length === 0 && !adminUsers.loading && !adminUsers.error) {
      void loadAdminUsers();
    }
    if (adminSection === "users" && adminSessions.rows.length === 0 && !adminSessions.loading && !adminSessions.error) {
      void loadAdminSessions();
    }
    if (adminSection === "runs" && adminRuns.rows.length === 0 && !adminRuns.loading && !adminRuns.error) {
      void loadAdminRuns();
    }
    if (adminSection === "incidents" && !adminIncidents.payload && !adminIncidents.loading && !adminIncidents.error) {
      void loadAdminIncidents();
    }
  }, [adminAccess.allowed, adminIncidents.error, adminIncidents.loading, adminIncidents.payload, adminRuns.error, adminRuns.loading, adminRuns.rows.length, adminSection, adminSessions.error, adminSessions.loading, adminSessions.rows.length, adminUsers.error, adminUsers.loading, adminUsers.rows.length]);

  async function cancelActiveRun() {
    const abortController = activeChatAbortControllerRef.current;
    activeChatAbortControllerRef.current = null;
    abortController?.abort();
    reconnectRunStreamAbortControllerRef.current?.abort();
    reconnectRunStreamAbortControllerRef.current = null;
    setStreamConnected(false);

    const runId = activeRunIdRef.current ?? recoveredActiveRunId;
    activeRunIdRef.current = null;
    setRecoveredActiveRunId(null);
    if (runId) {
      try {
        await cancelRun(runId);
      } catch (error) {
        console.error("failed to cancel active run", error);
      }
    }

    activeRunTokenRef.current += 1;
    setIsSending(false);
    setStreamingAssistantId(null);
  }

  async function sendPrompt(
    question: string,
    options: {
      sessionIdOverride?: string | null;
      workIdsOverride?: string[];
      viewOverride?: ViewMode;
      transportMessageOverride?: string;
      workflowOverride?: "auto" | "search" | "design_experiment";
    } = {},
  ) {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion || isSending || authState.loading) {
      return;
    }
    if (!currentUserId) {
      window.location.href = buildSignInUrl(window.location.href);
      return;
    }

    const initialSessionId = options.sessionIdOverride !== undefined ? options.sessionIdOverride : selectedSessionId;
    const transportQuestion = options.transportMessageOverride?.trim() || normalizedQuestion;
    if (initialSessionId) {
      track("assistant_followup_message", {
        sessionId: initialSessionId,
        view: options.viewOverride ?? activeView,
        workIds: options.workIdsOverride ?? [],
      });
    }
    const userMessage: UiMessage = {
      id: crypto.randomUUID(),
      sessionId: initialSessionId ?? "pending",
      role: "user",
      content: normalizedQuestion,
      metadata: { optimistic: true },
      createdAt: new Date().toISOString(),
      citations: [],
      toolCalls: [],
    };
    setActiveView(options.viewOverride ?? "assistant");
    setIsSending(true);
    setStreamConnected(true);
    setLoadError(null);
    setBillingLimitState(null);
    setStreamingAssistantId(null);
    setMessages((current) => [...current, userMessage]);
    activeChatAbortControllerRef.current?.abort();
    reconnectRunStreamAbortControllerRef.current?.abort();
    reconnectRunStreamAbortControllerRef.current = null;
    const abortController = new AbortController();
    activeChatAbortControllerRef.current = abortController;

    const runToken = activeRunTokenRef.current + 1;
    activeRunTokenRef.current = runToken;
    let workingSessionId = initialSessionId;
    let runSettled = false;
    let streamIdleTimer: number | null = null;
    const clearStreamIdleTimer = () => {
      if (streamIdleTimer !== null) {
        window.clearTimeout(streamIdleTimer);
        streamIdleTimer = null;
      }
    };
    const scheduleStreamIdleSettle = () => {
      clearStreamIdleTimer();
      streamIdleTimer = window.setTimeout(() => {
        settleRunUi();
      }, 1200);
    };
    let conversationRefreshTimer: number | null = null;
    const queueConversationRefresh = (delayMs = 900) => {
      if (!workingSessionId || conversationRefreshTimer !== null) {
        return;
      }
      conversationRefreshTimer = window.setTimeout(() => {
        conversationRefreshTimer = null;
        void refreshAssistantConversation(workingSessionId as string);
      }, delayMs);
    };
    const settleRunUi = () => {
      if (runSettled || activeRunTokenRef.current !== runToken) {
        return;
      }
      clearStreamIdleTimer();
      runSettled = true;
      setIsSending(false);
      setStreamingAssistantId(null);
    };

    try {
      await streamChat(
        {
          sessionId: initialSessionId ?? undefined,
          userId: authState.authConfigured ? undefined : currentUserId,
          message: transportQuestion,
          workIds: options.workIdsOverride,
          workflow: options.workflowOverride ?? "auto",
        },
        {
          onEvent: (event) => {
            if (activeRunTokenRef.current !== runToken) {
              return;
            }
            if (event.event === "session.created" && typeof event.data.sessionId === "string") {
              const createdSessionId = event.data.sessionId;
              track("assistant_session_created", {
                sessionId: createdSessionId,
                promptLength: normalizedQuestion.length,
                view: options.viewOverride ?? activeView,
                workIds: options.workIdsOverride ?? [],
              });
              workingSessionId = createdSessionId;
              selectedSessionIdRef.current = createdSessionId;
              setSelectedSessionId(createdSessionId);
              setSessions((current) => [
                {
                  id: createdSessionId,
                  userId: currentUserId,
                  title: typeof event.data.title === "string" ? event.data.title : normalizedQuestion.slice(0, 64),
                  createdAt: new Date().toISOString(),
                  lastMessageAt: new Date().toISOString(),
                  lastMessagePreview: normalizedQuestion,
                  activeRunStatus: null,
                },
                ...current.filter((session) => session.id !== createdSessionId),
              ]);
              setMessages((current) =>
                current.map((message) =>
                  message.id === userMessage.id
                    ? { ...message, sessionId: createdSessionId }
                    : message,
                ),
              );
              return;
            }

            if (event.event === "session.updated" && typeof event.data.sessionId === "string") {
              const updatedSessionId = event.data.sessionId;
              const updatedTitle = typeof event.data.title === "string" ? event.data.title : null;
              setSessions((current) => current.map((session) =>
                session.id === updatedSessionId
                  ? {
                      ...session,
                      title: updatedTitle,
                    }
                  : session,
              ));
              return;
            }

            if (event.event === "run.started" && typeof event.data.runId === "string") {
              activeRunIdRef.current = event.data.runId;
              setStreamConnected(true);
              if (workingSessionId) {
                setSessions((current) => current.map((session) =>
                  session.id === workingSessionId
                    ? { ...session, activeRunStatus: "running" }
                    : session,
                ));
              }
              if (workingSessionId) {
                queueConversationRefresh(0);
              }
              return;
            }

            if (event.event === "assistant.plan" && typeof event.data.text === "string") {
              appendAssistantPlan(workingSessionId, event.data.text);
              if (workingSessionId) {
                queueConversationRefresh();
              }
              return;
            }

            if (
              event.event === "job.started"
              || event.event === "job.progress"
              || event.event === "job.log"
              || event.event === "job.updated"
            ) {
              if (workingSessionId) {
                queueConversationRefresh();
              }
              return;
            }

            if (event.event === "tool.started" && typeof event.data.toolName === "string") {
              if (workingSessionId) {
                queueConversationRefresh();
              }
              return;
            }

            if (event.event === "tool.completed" && typeof event.data.toolName === "string") {
              if (workingSessionId) {
                queueConversationRefresh();
              }
              return;
            }

            if (event.event === "tool.progress" && typeof event.data.toolName === "string" && typeof event.data.text === "string") {
              if (workingSessionId) {
                queueConversationRefresh();
              }
              return;
            }

            if (event.event === "artifact.created" || event.event === "artifacts.updated") {
              if (workingSessionId) {
                queueConversationRefresh();
              }
              return;
            }

            if (event.event === "assistant.delta" && typeof event.data.text === "string") {
              appendStreamingAssistantDelta(workingSessionId, event.data.text);
              scheduleStreamIdleSettle();
              return;
            }

            if (event.event === "assistant.completed") {
              if (typeof event.data.answer === "string") {
                completeStreamingAssistantAnswer(
                  workingSessionId,
                  event.data.answer,
                  Array.isArray(event.data.citations) ? event.data.citations as Citation[] : [],
                  typeof event.data.phase === "string" ? event.data.phase : "answer",
                );
              }
              if (workingSessionId) {
                queueConversationRefresh(0);
              }
              settleRunUi();
              setStreamConnected(false);
              return;
            }

            if (event.event === "run.completed") {
              settleRunUi();
              activeRunIdRef.current = null;
              setRecoveredActiveRunId(null);
              setStreamConnected(false);
              if (workingSessionId) {
                setSessions((current) => current.map((session) =>
                  session.id === workingSessionId
                    ? { ...session, activeRunStatus: null }
                    : session,
                ));
              }
              if (workingSessionId) {
                queueConversationRefresh(0);
              } else {
                void refreshSessions(workingSessionId ?? null);
              }
              return;
            }

            if (event.event === "error") {
              setLoadError(getErrorMessage(new Error(typeof event.data.message === "string" ? event.data.message : ""), "The assistant run failed."));
              setStreamConnected(false);
              settleRunUi();
            }
          },
        },
        {
          signal: abortController.signal,
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (activeRunTokenRef.current === runToken) {
          settleRunUi();
        }
        return;
      }
      if (activeRunTokenRef.current === runToken) {
        const billingLimit = parseBillingLimitState(error);
        if (billingLimit) {
          setBillingLimitState(billingLimit);
          setLoadError(null);
        } else {
          setLoadError(getErrorMessage(error, "We couldn't finish that assistant run."));
        }
        setStreamConnected(false);
      }
    } finally {
      clearStreamIdleTimer();
      if (conversationRefreshTimer !== null) {
        window.clearTimeout(conversationRefreshTimer);
      }
      if (activeChatAbortControllerRef.current === abortController) {
        activeChatAbortControllerRef.current = null;
      }
      if (activeRunTokenRef.current === runToken) {
        activeRunIdRef.current = null;
        setStreamConnected(false);
        settleRunUi();
        if (workingSessionId) {
          await refreshAssistantConversation(workingSessionId);
        } else {
          await refreshSessions(workingSessionId ?? null);
        }
        if (authState.user) {
          await loadNotifications({ silent: true });
        }
      }
    }
  }

  useEffect(() => {
    const handleApproveExperiment = (event: Event) => {
      const detail = event instanceof CustomEvent && event.detail && typeof event.detail === "object"
        ? event.detail as Record<string, unknown>
        : null;
      const displayText = typeof detail?.displayText === "string" ? detail.displayText : "Approve experiment";
      const transportMessage = typeof detail?.transportMessage === "string" ? detail.transportMessage : "";
      void sendPrompt(displayText, {
        transportMessageOverride: transportMessage || displayText,
        workflowOverride: "design_experiment",
      });
    };

    window.addEventListener("alphabook:approve-experiment", handleApproveExperiment as EventListener);
    return () => {
      window.removeEventListener("alphabook:approve-experiment", handleApproveExperiment as EventListener);
    };
  }, [currentUserId, authState.loading, selectedSessionId, activeView, isSending]);

  function handleSignOut() {
    const signedOutUrl = new URL("/", window.location.origin);
    signedOutUrl.searchParams.set("signed_out", "1");
    window.location.assign(buildSignOutUrl(signedOutUrl.toString()));
  }

  async function loadMoreWorks() {
    if (feedLoading || feedNextOffset === null || exploreQuery.trim().length > 0) {
      return;
    }
    await loadExploreWorks(false);
  }

  function retryInitialWorksLoad() {
    if (feedLoading) {
      return;
    }
    void loadExploreWorks(true);
  }

  function resetExploreFilters() {
    pendingUrlWriteModeRef.current = "push";
    setExploreDraftFilters(DEFAULT_EXPLORE_FILTERS);
    setExploreAppliedFilters(DEFAULT_EXPLORE_FILTERS);
    setExploreFilterOpen(false);
  }

  function startNewChat() {
    pendingUrlWriteModeRef.current = "push";
    detachActiveAssistantStreams();
    setMobileNavOpen(false);
    selectedSessionIdRef.current = null;
    setSelectedSessionId(null);
    setConversationHydrated(true);
    setMessages([]);
    setSessionRuns([]);
    setRunArtifacts([]);
    setRecoveredActiveRunId(null);
    setLoadError(null);
    setActiveWorkId(null);
    setActiveReaderPath(null);
    setActiveChunkId(null);
    setActivePassageId(null);
    setHighlightedPassageExcerpt(null);
    setPendingCitation(null);
    setActiveView("assistant");
  }

  function startNewBookChat() {
    pendingUrlWriteModeRef.current = "push";
    detachActiveAssistantStreams();
    selectedSessionIdRef.current = null;
    setSelectedSessionId(null);
    setConversationHydrated(true);
    setMessages([]);
    setSessionRuns([]);
    setRunArtifacts([]);
    setRecoveredActiveRunId(null);
    setLoadError(null);
    setActiveReaderPath(null);
    setActiveChunkId(null);
    setHighlightedPassageExcerpt(null);
    setActiveView("book");
  }

  function rerollExploreFeed() {
    pendingUrlWriteModeRef.current = "push";
    setExploreQuery("");
    setExploreDraft("");
    setExploreRandomSeed(generateExploreRandomSeed());
  }

  function applyExploreFilters() {
    pendingUrlWriteModeRef.current = "push";
    setExploreAppliedFilters(exploreDraftFilters);
    setExploreFilterOpen(false);
  }

  function submitExplorePrompt(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const nextQuery = exploreDraft.trim();
    if (!nextQuery) {
      return;
    }
    pendingUrlWriteModeRef.current = "push";
    setExploreRandomSeed(null);
    setExploreQuery(nextQuery);
  }

  function handleExploreScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 360) {
      void loadMoreWorks();
    }
  }

  function handleNavSelection(view: ViewMode) {
    pendingUrlWriteModeRef.current = "push";
    setMobileNavOpen(false);
    if (view !== "book") {
      setActiveWorkId(null);
      setActiveReaderPath(null);
      setActiveChunkId(null);
      setActivePassageId(null);
      setHighlightedPassageExcerpt(null);
      setPendingCitation(null);
    }
    if (view !== "profile") {
      setActiveProfileUserId(null);
      setPublicProfile(null);
    }
    if (view !== "admin") {
      setSelectedAdminRunId(null);
      setAdminSection("runs");
    }
    if (view === "assistant") {
      startNewChat();
      return;
    }
    if (view === "profile" && currentUserId) {
      setActiveProfileUserId(currentUserId);
    }
    setActiveView(view);
  }

  function openSession(sessionId: string | null) {
    if (!sessionId) {
      startNewChat();
      return;
    }
    pendingUrlWriteModeRef.current = "push";
    detachActiveAssistantStreams();
    setMobileNavOpen(false);
    void handleMarkSessionNotificationsRead(sessionId);
    setConversationHydrated(false);
    setMessages([]);
    setSessionRuns([]);
    setRunArtifacts([]);
    setRecoveredActiveRunId(null);
    setStreamingAssistantId(null);
    setLoadError(null);
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    setActiveWorkId(null);
    setActiveProfileUserId(null);
    setPendingCitation(null);
    setActiveView("assistant");
  }

  function openWork(workId: string) {
    pendingUrlWriteModeRef.current = "push";
    track("book_open", {
      workId,
      source: activeView,
    });
    setMobileNavOpen(false);
    setPendingCitation(null);
    setActiveReaderPath(null);
    setActiveChunkId(null);
    setActivePassageId(null);
    setHighlightedPassageExcerpt(null);
    setActiveProfileUserId(null);
    setActiveWorkId(workId);
    if (activeView === "explore") {
      return;
    }
    startNewBookChat();
  }

  function closeExploreWorkOverlay() {
    if (activeView !== "explore") {
      return;
    }
    pendingUrlWriteModeRef.current = "push";
    setPendingCitation(null);
    setActiveReaderPath(null);
    setActiveChunkId(null);
    setActivePassageId(null);
    setHighlightedPassageExcerpt(null);
    setActiveWorkId(null);
  }

  function openCitation(citation: Citation) {
    pendingUrlWriteModeRef.current = "push";
    track("book_citation_open", {
      workId: citation.workId,
      chunkId: citation.chunkId ?? null,
      source: "citation",
    });
    track("book_open", {
      workId: citation.workId,
      source: "citation",
    });
    setMobileNavOpen(false);
    setPendingCitation(citation);
    setActiveReaderPath(null);
    setActivePassageId(null);
    setHighlightedPassageExcerpt(null);
    setActiveProfileUserId(null);
    setActiveWorkId(citation.workId);
    setActiveView("book");
  }

  function openProfile(userId?: string | null) {
    pendingUrlWriteModeRef.current = "push";
    setMobileNavOpen(false);
    setActiveWorkId(null);
    setActiveReaderPath(null);
    setActiveChunkId(null);
    setActivePassageId(null);
    setHighlightedPassageExcerpt(null);
    setPendingCitation(null);
    setActiveProfileUserId(userId ?? currentUserId ?? null);
    setActiveView("profile");
  }

  async function toggleFollowProfile() {
    if (!activeProfileUserId || !publicProfile || publicProfile.isSelf) {
      return;
    }
    try {
      const next = publicProfile.isFollowing ? await unfollowProfile(activeProfileUserId) : await followProfile(activeProfileUserId);
      setPublicProfile({
        profile: next.profile,
        isFollowing: next.isFollowing,
        isSelf: false,
      });
      if (currentUser && currentUser.id === activeProfileUserId) {
        setAuthState((state) => ({
          ...state,
          user: next.profile,
        }));
      }
    } catch (error) {
      setLoadError(getErrorMessage(error, "We couldn't update that follow state."));
    }
  }

  function activatePassage(passageId: string, highlight: string | null = null, replaceHistory = false) {
    if (activeWorkId && (passageId !== activePassageId || highlight !== highlightedPassageExcerpt)) {
      track("passage_open", {
        workId: activeWorkId,
        passageId,
        source: pendingCitation ? "citation" : "reader",
        highlighted: Boolean(highlight),
      });
    }
    pendingUrlWriteModeRef.current = replaceHistory ? "replace" : "push";
    setActivePassageId(passageId);
    setHighlightedPassageExcerpt(highlight);
  }

  function renderAssistantSurface(props: {
    messages: UiMessage[];
    isSending: boolean;
    streamingAssistantId: string | null;
    artifacts: RunArtifactRecord[];
    showArtifacts?: boolean;
    showWelcome?: boolean;
    onPrompt: (prompt: string) => Promise<void>;
    onCancel: () => Promise<void>;
    suggestions?: ThreadSuggestion[];
    composerDisabled?: boolean;
    composerDisabledNotice?: ReactNode;
    componentKey?: string;
  }) {
    if (!AssistantSurfaceComponent) {
      return <AssistantSurfaceFallback />;
    }
    const Component = AssistantSurfaceComponent;
    const activeAssistantId = resolveActiveAssistantMessageId(
      props.messages,
      props.streamingAssistantId,
      props.isSending,
    );
    return (
      <Component
        key={props.componentKey}
        messages={props.messages}
        isSending={props.isSending}
        showRunningDot={isSending}
        streamingAssistantId={props.streamingAssistantId}
        artifacts={props.artifacts}
        showArtifacts={props.showArtifacts}
        showWelcome={props.showWelcome}
        onPrompt={props.onPrompt}
        onCancel={props.onCancel}
        suggestions={props.suggestions}
        composerDisabled={props.composerDisabled}
        composerDisabledNotice={props.composerDisabledNotice}
        convertMessage={(message, _streamingAssistantId, isSending) =>
          messageToThreadMessage(message, activeAssistantId, isSending, props.isSending)
        }
        extractPromptText={extractPromptText}
      />
    );
  }

  function renderAssistantView() {
    const assistantSessionLoading = selectedSessionId != null && !conversationHydrated;
    const showBlankSession =
      !assistantSessionLoading
      && selectedSessionId == null
      && messages.length === 0
      && !isSending
      && recoveredActiveRunId == null;
    const showRestrictedConversation =
      selectedSessionId != null
      && !assistantSessionLoading
      && messages.length === 0
      && !isSending
      && recoveredActiveRunId == null
      && isConversationAccessIssue(loadError);
    const assistantComposerNotice = authLocked ? (
      <>
        Sign in to start a research thread.{" "}
        <a className="font-medium underline underline-offset-4" href={buildSignInUrl(window.location.href)}>Sign in</a>
      </>
    ) : undefined;

    return (
      <section className="assistant-page">
        {assistantSessionLoading ? (
          <div className="assistant-thread-shell" data-testid="thread">
            {renderAssistantSurface({
              messages: [],
              isSending: false,
              streamingAssistantId: null,
              artifacts: [],
              showWelcome: false,
              onPrompt: sendPrompt,
              onCancel: cancelActiveRun,
              composerDisabled: authLocked,
              composerDisabledNotice: assistantComposerNotice,
              componentKey: `loading-${selectedSessionId ?? "new-thread"}`,
            })}
          </div>
        ) : showRestrictedConversation ? (
          <div className="assistant-thread-shell" data-testid="thread">
            <LockedState compact title={authLocked ? "Sign in to view this conversation." : "This conversation is private."} />
          </div>
        ) : showBlankSession ? (
          <div className="assistant-thread-shell" data-testid="thread">
            {renderAssistantSurface({
              messages: [],
              isSending: false,
              streamingAssistantId: null,
              artifacts: [],
              onPrompt: sendPrompt,
              onCancel: cancelActiveRun,
              composerDisabled: authLocked,
              composerDisabledNotice: assistantComposerNotice,
              componentKey: "assistant-landing",
            })}
          </div>
        ) : (
          <div className="assistant-thread-shell" data-testid="thread">
            {renderAssistantSurface({
              messages: visibleMessages,
              isSending: isSending || recoveredActiveRunId !== null,
              streamingAssistantId,
              artifacts: runArtifacts,
              onPrompt: sendPrompt,
              onCancel: cancelActiveRun,
              composerDisabled: authLocked,
              composerDisabledNotice: assistantComposerNotice,
              componentKey: selectedSessionId ?? "new-thread",
            })}
          </div>
        )}
      </section>
    );
  }

  function renderBookView() {
    return (
      <section className="book-page">
        <div className="book-reader-pane">
          {activeWorkId ? (
            <div className="book-reader-surface">
              {activeWorkLoading ? (
                <BookLoadingState />
              ) : activeWork ? (
                <iframe
                  key={activeWorkId}
                  ref={bookReaderFrameRef}
                  className="book-reader-frame"
                  src={activeReaderFrameHref ?? undefined}
                  title={activeWork.title ? `${activeWork.title} text` : "Book text"}
                  loading="eager"
                />
              ) : (
                <div className="book-loading">Book not found.</div>
              )}
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  function renderExploreBookOverlay() {
    if (activeView !== "explore" || !activeWorkId) {
      return null;
    }

    const contentsEntries = buildOverlayContentsEntries(activeWorkSource, readerPassages);
    const authorLine = activeWork?.authors.join(", ") ?? "";

    return (
      <div className="book-overlay-shell" role="dialog" aria-modal="true" aria-label={activeWork?.title ?? "Book"}>
        <button type="button" className="book-overlay-backdrop" aria-label="Close book" onClick={closeExploreWorkOverlay} />
        <section className="book-overlay-panel">
          <div className="book-overlay-stage">
            <div className="book-overlay-reader">
              {activeWorkLoading ? (
                <BookLoadingState />
              ) : activeWork ? (
                <iframe
                  key={activeWorkId}
                  ref={bookReaderFrameRef}
                  className="book-reader-frame book-overlay-frame"
                  src={activeReaderFrameHref ?? undefined}
                  title={activeWork.title ? `${activeWork.title} text` : "Book text"}
                  loading="eager"
                />
              ) : (
                <div className="book-loading">Book not found.</div>
              )}
            </div>
          </div>

          <aside className="book-overlay-sidebar">
            <div className="book-overlay-sidebar-scroll">
              <div className="book-overlay-toolbar">
                <button
                  type="button"
                  className="book-overlay-close"
                  aria-label="Close book"
                  onClick={closeExploreWorkOverlay}
                >
                  <CloseIcon />
                </button>
              </div>

              {activeWork ? (
                <>
                  <div className="book-overlay-header">
                    <h2>{activeWork.title}</h2>
                    {authorLine ? <p className="book-overlay-authors">{authorLine}</p> : null}
                  </div>

                  {contentsEntries.length > 0 ? (
                    <section className="book-overlay-section">
                      <div className="book-overlay-section-header">
                        <h3>Contents</h3>
                      </div>
                      <div className="book-overlay-contents">
                        {contentsEntries.map((entry) => (
                          <button
                            key={entry.id}
                            type="button"
                            className="book-overlay-content-link"
                            onClick={() => activatePassage(entry.id, null, false)}
                          >
                            {entry.label}
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </>
              ) : (
                <div className="book-loading">Loading book…</div>
              )}
            </div>
          </aside>
        </section>
      </div>
    );
  }

  function renderAssistantDocumentView() {
    if (!selectedSessionId || !selectedAdminRunId) {
      return (
        <section className="assistant-document-pane assistant-document-standalone">
          <div className="assistant-document-scroll">
            <div className="session-loading">Missing session or run for this research document.</div>
          </div>
        </section>
      );
    }

    return <AssistantDocumentFramePage sessionId={selectedSessionId} runId={selectedAdminRunId} />;
  }

  function renderExploreView() {
    const formattedCorpusCount = formatCompactCount(feedTotalCount);
    const isFeedRefreshing = feedInitialLoadState === "loading";
    const isFeedAppending = feedLoading && !isFeedRefreshing && feedWorks.length > 0;
    return (
      <div className="view-shell explore-view" onScroll={handleExploreScroll}>
        <section className="explore-hero">
          <h1>
            {formattedCorpusCount
              ? `Ask or search anything over ${formattedCorpusCount} ${CORPUS_LABEL_PLURAL}.`
              : "Ask or search anything over the corpus."}
          </h1>

          <form className="explore-composer-shell" onSubmit={submitExplorePrompt}>
            <div className="explore-composer-toolbar" aria-label="Explore controls">
              <Button
                type="button"
                variant="ghost"
                className="explore-tool-button"
                onClick={rerollExploreFeed}
                aria-label="Randomize feed"
              >
                <Dices size={16} />
              </Button>

              <div className="explore-filter-menu">
                <Button
                  type="button"
                  variant="ghost"
                  className="explore-tool-button"
                  onClick={() => setExploreFilterOpen((current) => !current)}
                  aria-label="Open filters"
                  aria-expanded={exploreFilterOpen}
                >
                  <Funnel size={16} />
                  {activeExploreFilterCount > 0 ? (
                    <span className="explore-tool-badge">{activeExploreFilterCount}</span>
                  ) : null}
                </Button>

                {exploreFilterOpen ? (
                  <div className="explore-filter-popover" aria-label="Book filters">
                    {feedFacets.languages.length > 1 ? (
                      <label className="explore-filter-field">
                        <span>Language</span>
                        <select
                          value={exploreDraftFilters.language}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setExploreDraftFilters((current) => ({ ...current, language: value }));
                          }}
                        >
                          <option value="all">All languages</option>
                          {feedFacets.languages.map((option) => (
                            <option key={option.label} value={option.label}>{formatExploreLanguageLabel(option.label)} ({option.count})</option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    {feedFacets.subjects.length > 0 ? (
                      <label className="explore-filter-field">
                        <span>Topic</span>
                        <select
                          value={exploreDraftFilters.subject}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setExploreDraftFilters((current) => ({ ...current, subject: value }));
                          }}
                        >
                          <option value="all">All topics</option>
                          {feedFacets.subjects.map((option) => (
                            <option key={option.label} value={option.label}>{option.label} ({option.count})</option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    {feedFacets.bookshelves.length > 0 ? (
                      <label className="explore-filter-field">
                        <span>Bookshelf</span>
                        <select
                          value={exploreDraftFilters.bookshelf}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setExploreDraftFilters((current) => ({ ...current, bookshelf: value }));
                          }}
                        >
                          <option value="all">All bookshelves</option>
                          {feedFacets.bookshelves.map((option) => (
                            <option key={option.label} value={option.label}>{option.label} ({option.count})</option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    <div className="explore-filter-actions">
                      {hasActiveExploreFilters ? (
                        <Button type="button" variant="ghost" onClick={resetExploreFilters}>Reset</Button>
                      ) : <span />}
                      <Button type="button" variant="default" onClick={applyExploreFilters}>Apply filters</Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="explore-composer-layout">
              <label className="explore-search-label" htmlFor="explore-semantic-search">Semantic search</label>
              <div className="explore-search-row">
                <input
                  id="explore-semantic-search"
                  className="explore-search-input"
                  type="text"
                  placeholder={EXPLORE_PLACEHOLDER}
                  value={exploreDraft}
                  onChange={(event) => setExploreDraft(event.currentTarget.value)}
                />
                <Button
                  type="submit"
                  variant="default"
                  className="explore-search-submit"
                  disabled={!exploreDraft.trim()}
                >
                  Search
                </Button>
              </div>
              {exploreQuery.trim().length > 0 ? (
                <div className="explore-search-meta">
                  <span>Showing semantic matches for “{exploreQuery.trim()}”</span>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      pendingUrlWriteModeRef.current = "push";
                      setExploreQuery("");
                      setExploreDraft("");
                    }}
                  >
                    Clear search
                  </Button>
                </div>
              ) : null}
            </div>

            {isFeedRefreshing ? (
              <div className="explore-feed-indicator" role="status" aria-live="polite">
                <LoaderCircle aria-hidden="true" className="explore-feed-indicator-spinner animate-spin" />
                <span>Loading books</span>
              </div>
            ) : null}
          </form>
        </section>

        <section className="work-feed" aria-label="Corpus feed" aria-busy={feedLoading}>
          {feedWorks.map((work) => {
            const primaryAuthor = work.authors[0] ?? null;
            return (
              <article key={work.id} className="work-feed-card">
                <button
                  type="button"
                  className="work-feed-open"
                  onClick={() => openWork(work.id)}
                >
                  <div className="work-feed-artwork">
                    {work.coverImageUrl ? (
                      <div className="work-feed-cover">
                        <img src={work.coverImageUrl} alt="" loading="lazy" />
                      </div>
                    ) : (
                      <div className="work-feed-cover work-feed-cover-placeholder" aria-hidden="true">
                        <div className="work-feed-cover-spine" />
                        <div className="work-feed-cover-fallback-copy">
                          <p className="work-feed-cover-kicker">alpha book</p>
                          <p className="work-feed-cover-title">{work.title}</p>
                          {primaryAuthor ? (
                            <p className="work-feed-cover-author">{primaryAuthor}</p>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="work-feed-copy">
                    <h2>{work.title}</h2>
                    {primaryAuthor ? <p className="work-feed-authors">{primaryAuthor}</p> : null}
                  </div>
                </button>
              </article>
            );
          })}

          {!feedLoading && feedWorks.length === 0 && feedInitialLoadState === "ready" ? (
            <div className="feed-status">
              <p>No books match the current metadata filters.</p>
              {hasActiveExploreFilters ? (
                <Button type="button" variant="ghost" onClick={resetExploreFilters}>Clear filters</Button>
              ) : null}
            </div>
          ) : null}

          {!feedLoading && feedWorks.length === 0 && feedInitialLoadState === "error" ? (
            <div className="feed-status">
              <p>We couldn't load the corpus feed.</p>
              <Button type="button" variant="ghost" onClick={retryInitialWorksLoad}>Retry</Button>
            </div>
          ) : null}

          {!feedLoading && feedWorks.length === 0 && feedInitialLoadState !== "error" ? (
            <div className="feed-status">
              <p>
                {IMPLEMENTATION.emptyCorpusMessage}
              </p>
            </div>
          ) : null}

          {isFeedAppending ? (
            <div className="feed-status feed-status-loading" role="status" aria-live="polite">
              <LoaderCircle aria-hidden="true" className="explore-feed-indicator-spinner animate-spin" />
              <p>Loading more books</p>
            </div>
          ) : null}
        </section>
      </div>
    );
  }

  function renderProfileView() {
    const isPublicProfile = Boolean(activeProfileUserId && (!currentUserId || activeProfileUserId !== currentUserId));
    if (authPending) {
      return <ProfileLoadingState publicView={isPublicProfile} />;
    }

    if (authLocked && !isPublicProfile) {
      return (
        <div className="profile-view">
          <section className="profile-hero">
            <div className="profile-hero-badge profile-badge-neutral">
              <ProfileIcon />
            </div>
            <h1>Your profile</h1>
            <p>Save searches, return to past threads, and keep your reading trail in one place.</p>
          </section>

          <section className="profile-history">
            <div className="profile-history-list">
              <ProfileEmptyState
                title="Sign in to unlock your profile"
                copy="Your saved chats and recent research will appear here once you have an account."
                action={(
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <Button asChild className="signin-pill-button" size="lg">
                      <a href={buildSignInUrl(window.location.href)}>Sign in</a>
                    </Button>
                  </div>
                )}
              />
            </div>
          </section>
        </div>
      );
    }

    if (isPublicProfile) {
      if (publicProfileLoading) {
        return <ProfileLoadingState publicView />;
      }

      if (!publicProfile) {
        return (
          <section className="assistant-page">
            <div className="assistant-thread-shell">
              <LockedState compact title="That profile could not be loaded." />
            </div>
          </section>
        );
      }

      const profile = publicProfile.profile;
      const publicName = displayName(profile);
      const publicTag = profileHandle(profile);
      const publicHue = hueFromSeed(profile.email ?? profile.id);
      const publicJoined = formatMonthYear(profile.createdAt);
      const publicMeta = [publicTag, publicJoined ? `joined ${publicJoined}` : null].filter(Boolean).join(" • ");
      const stats = profileStats;
      const metrics = stats
        ? [
          {
            label: "Questions asked",
            value: formatStatNumber(stats.counts.queryCount),
            detail: `${formatStatNumber(stats.averages.queriesPerSession)} per session`,
          },
          {
            label: "Books touched",
            value: formatStatNumber(stats.counts.booksTouchedCount),
            detail: `${formatStatNumber(stats.counts.uniqueBooksCitedCount)} cited`,
          },
          {
            label: "Citations surfaced",
            value: formatStatNumber(stats.counts.citationCount),
            detail: `${formatStatNumber(stats.counts.booksOpenedCount)} opens tracked`,
          },
          {
            label: "Active days",
            value: formatStatNumber(stats.counts.activeDayCount),
            detail: `${formatStatNumber(stats.counts.runCount)} runs`,
          },
        ]
        : [];

      return (
        <div className="profile-view profile-view-public">
          <section className="profile-hero profile-hero-public">
            {profile.avatarUrl ? (
              <Avatar className="profile-hero-image size-28 bg-white p-1">
                <AvatarImage src={profile.avatarUrl} alt={publicName} />
                <AvatarFallback>{initialsFromSeed(publicName)}</AvatarFallback>
              </Avatar>
            ) : (
              <Avatar className="profile-hero-badge size-28 bg-white p-1" style={{ ["--profile-hue" as string]: publicHue }}>
                <AvatarFallback
                  className="text-3xl text-white"
                  style={{ background: `linear-gradient(160deg, hsl(${publicHue} 72% 56%), hsl(${publicHue - 12} 62% 46%))` }}
                >
                  {initialsFromSeed(publicName)}
                </AvatarFallback>
              </Avatar>
            )}
            <h1>{publicName}</h1>
            {publicMeta ? <p>{publicMeta}</p> : null}
          </section>

          <section className="profile-toolbar profile-toolbar-public">
            <div className="profile-stats">
              <article>
                <strong className="block text-[var(--ink)]">{profile.followersCount}</strong>
                <span className="text-xs text-[var(--ink-soft)]">Followers</span>
              </article>
              <article>
                <strong className="block text-[var(--ink)]">{profile.followingCount}</strong>
                <span className="text-xs text-[var(--ink-soft)]">Following</span>
              </article>
            </div>
            <div className="profile-actions">
              {publicProfile.isSelf ? null : authLocked ? (
                <Button asChild className="signin-pill-button">
                  <a href={buildSignInUrl(window.location.href)}>Sign in to follow</a>
                </Button>
              ) : (
                <Button type="button" variant="ghost" className="profile-chip" onClick={() => void toggleFollowProfile()}>
                  {publicProfile.isFollowing ? "Following" : "Follow"}
                </Button>
              )}
            </div>
          </section>

          <section className="profile-section-card profile-section-card-hero">
            <div className="profile-section-header">
              <div>
                <h2>Reading fingerprint</h2>
                <p>
                  {stats
                    ? `${pluralize(stats.counts.booksTouchedCount, "book")} touched across ${pluralize(stats.counts.sessionCount, "session")}.`
                    : "Loading reading activity."}
                </p>
              </div>
            </div>
            {profileStatsLoading && !stats ? (
              <p className="profile-section-empty">Loading reading activity...</p>
            ) : stats ? (
              <>
                <div className="profile-metric-grid">
                  {metrics.map((item) => (
                    <ProfileMetricCard key={item.label} label={item.label} value={item.value} detail={item.detail} />
                  ))}
                </div>
                <div className="profile-fingerprint-grid">
                  <ProfileFacetRail label="Authors" items={stats.fingerprint.authors} />
                  <ProfileFacetRail label="Subjects" items={stats.fingerprint.subjects} />
                  <ProfileFacetRail label="Languages" items={stats.fingerprint.languages} />
                </div>
              </>
            ) : (
              <p className="profile-section-empty">No public reading activity yet.</p>
            )}
          </section>

          <div className="profile-book-shelves">
            <ProfileBookShelf
              title="Recently touched"
              items={stats?.books.recent ?? []}
              emptyCopy="No recent book activity yet."
              onOpenWork={openWork}
            />
            <ProfileBookShelf
              title="Most opened"
              items={stats?.books.topOpened ?? []}
              emptyCopy="No tracked book opens yet."
              onOpenWork={openWork}
            />
            <ProfileBookShelf
              title="Most cited"
              items={stats?.books.topCited ?? []}
              emptyCopy="No cited books yet."
              onOpenWork={openWork}
            />
          </div>
        </div>
      );
    }

    const joinedLabel = formatMonthYear(currentUser?.createdAt);
    const currentMeta = [profileTag, joinedLabel ? `joined ${joinedLabel}` : null].filter(Boolean).join(" • ");
    const stats = profileStats;
    const metrics = stats
      ? [
        {
          label: "Questions asked",
          value: formatStatNumber(stats.counts.queryCount),
          detail: `${formatStatNumber(stats.averages.queriesPerSession)} per session on average`,
        },
        {
          label: "Books touched",
          value: formatStatNumber(stats.counts.booksTouchedCount),
          detail: `${formatStatNumber(stats.counts.uniqueBooksCitedCount)} cited and ${formatStatNumber(stats.counts.uniqueBooksOpenedCount)} opened`,
        },
        {
          label: "Citations surfaced",
          value: formatStatNumber(stats.counts.citationCount),
          detail: `${formatStatNumber(stats.averages.citationsPerQuery)} per query`,
        },
        {
          label: "Active days",
          value: formatStatNumber(stats.counts.activeDayCount),
          detail: `${formatStatNumber(stats.counts.runCount)} research runs completed`,
        },
      ]
      : [];

    return (
      <div className="profile-view">
        <section className="profile-hero">
          {currentUser?.avatarUrl ? (
            <Avatar className="profile-hero-image size-28 bg-white p-1">
              <AvatarImage src={currentUser.avatarUrl} alt={displayProfileName} />
              <AvatarFallback>{initialsFromSeed(displayProfileName)}</AvatarFallback>
            </Avatar>
          ) : (
            <Avatar className="profile-hero-badge size-28 bg-white p-1" style={{ ["--profile-hue" as string]: profileHue }}>
              <AvatarFallback
                className="text-3xl text-white"
                style={{ background: `linear-gradient(160deg, hsl(${profileHue} 72% 56%), hsl(${profileHue - 12} 62% 46%))` }}
              >
                {initialsFromSeed(displayProfileName)}
              </AvatarFallback>
            </Avatar>
          )}
          <h1>{displayProfileName}</h1>
          {currentMeta ? <p>{currentMeta}</p> : null}
        </section>

        <section className="profile-toolbar">
          <div className="profile-stats">
            <article>
              <strong className="block text-[var(--ink)]">{currentUser?.followersCount ?? 0}</strong>
              <span className="text-xs text-[var(--ink-soft)]">Followers</span>
            </article>
            <article>
              <strong className="block text-[var(--ink)]">{currentUser?.followingCount ?? 0}</strong>
              <span className="text-xs text-[var(--ink-soft)]">Following</span>
            </article>
          </div>
          <div className="profile-actions">
            {authState.authConfigured && authState.user ? (
              <Button type="button" variant="ghost" className="profile-chip" onClick={handleSignOut}>
                Log out
              </Button>
            ) : null}
          </div>
        </section>

        <section className="profile-section-card profile-section-card-hero">
          <div className="profile-section-header">
            <div>
              <h2>Your reading fingerprint</h2>
              <p>
                {stats
                  ? `${pluralize(stats.counts.sessionCount, "session")}, ${pluralize(stats.counts.queryCount, "question")}, and ${pluralize(stats.counts.booksTouchedCount, "book")} shaped this profile.`
                  : "We are assembling your corpus trail from sessions, citations, and books you have opened."}
              </p>
            </div>
          </div>

          {profileStatsLoading && !stats ? (
            <p className="profile-section-empty">Loading your reader stats…</p>
          ) : stats ? (
            <>
              <div className="profile-metric-grid">
                {metrics.map((item) => (
                  <ProfileMetricCard key={item.label} label={item.label} value={item.value} detail={item.detail} />
                ))}
              </div>
              <div className="profile-fingerprint-grid">
                <ProfileFacetRail label="Authors" items={stats.fingerprint.authors} />
                <ProfileFacetRail label="Subjects" items={stats.fingerprint.subjects} />
                <ProfileFacetRail label="Languages" items={stats.fingerprint.languages} />
              </div>
            </>
          ) : (
            <p className="profile-section-empty">Start opening books and asking grounded questions to build your stats.</p>
          )}
        </section>

        <div className="profile-book-shelves">
          <ProfileBookShelf
            title="Recently touched"
            items={stats?.books.recent ?? []}
            emptyCopy="Recent books you open or cite will appear here."
            onOpenWork={openWork}
          />
          <ProfileBookShelf
            title="Most opened"
            items={stats?.books.topOpened ?? []}
            emptyCopy="Your most revisited books will show up here."
            onOpenWork={openWork}
          />
          <ProfileBookShelf
            title="Most cited"
            items={stats?.books.topCited ?? []}
            emptyCopy="Once answers start citing books, your anchor texts will show up here."
            onOpenWork={openWork}
          />
        </div>

        <section className="profile-history">
          <div className="profile-section-header profile-section-header-inline">
            <div>
              <h2>Query history</h2>
              <p>Recent prompts, follow-up depth, and citation breadth by session.</p>
            </div>
          </div>
          <div className="profile-history-list">
            {stats && stats.recentQueries.length > 0 ? (
              stats.recentQueries.map((item) => (
                <ProfileQueryCard key={item.sessionId} item={item} onOpen={openSession} />
              ))
            ) : sessions.length === 0 ? (
              <div className="profile-inline-empty">
                <p>No searches yet. Start a conversation with the assistant and your recent research will show up here.</p>
                <Button type="button" className="signin-pill-button" onClick={() => handleNavSelection("assistant")}>
                  Start searching
                </Button>
              </div>
            ) : (
              sessions.map((session) => <SessionListCard key={session.id} session={session} onOpen={() => openSession(session.id)} />)
            )}
          </div>
        </section>
      </div>
    );
  }

  function renderAdminView() {
    if (adminAccess.loading || authPending) {
      return (
        <section className="assistant-page">
          <div className="assistant-thread-shell">
            <AuthLoadingState compact />
          </div>
        </section>
      );
    }

    if (!adminAccess.allowed) {
      return (
        <section className="assistant-page">
          <div className="assistant-thread-shell">
            <LockedState compact title="This admin page is restricted." />
          </div>
        </section>
      );
    }

    const summary = summarizeRunLogPayload(adminRunLog.payload);
    const showingLogs = adminSection === "logs";
    const showingIncidents = adminSection === "incidents";
    const analyticsPayload = adminAnalytics.payload ?? {};
    const analyticsMetrics = Array.isArray(analyticsPayload.metrics) ? analyticsPayload.metrics as Array<Record<string, unknown>> : [];
    const analyticsSeries = Array.isArray(analyticsPayload.series) ? analyticsPayload.series as Array<Record<string, unknown>> : [];
    const analyticsHashtags = Array.isArray(analyticsPayload.hashtags) ? analyticsPayload.hashtags as Array<Record<string, unknown>> : [];
    const analyticsNotes = Array.isArray(analyticsPayload.notes) ? analyticsPayload.notes as Array<unknown> : [];
    const incidentsPayload = adminIncidents.payload ?? {};
    const incidentRows = Array.isArray(incidentsPayload.incidents) ? incidentsPayload.incidents as Array<Record<string, unknown>> : [];
    const incidentEvents = Array.isArray(incidentsPayload.events) ? incidentsPayload.events as Array<Record<string, unknown>> : [];
    const selectedIncident =
      incidentRows.find((row) => typeof row.fingerprint === "string" && row.fingerprint === adminIncidents.selectedFingerprint)
      ?? incidentRows[0]
      ?? null;
    const selectedFingerprint = selectedIncident && typeof selectedIncident.fingerprint === "string"
      ? selectedIncident.fingerprint
      : null;
    const selectedIncidentEvents = selectedFingerprint
      ? incidentEvents.filter((row) => row.fingerprint === selectedFingerprint)
      : incidentEvents;
    const adminNavItems = [
      {
        key: "incidents",
        label: "Incidents",
        description: "Search unexpected errors and inspect full occurrence logs.",
      },
      {
        key: "runs",
        label: "Runs",
        description: "Browse every assistant run and open full log detail.",
      },
      {
        key: "users",
        label: "Users",
        description: "Inspect signed-up accounts and usage at a glance.",
      },
      {
        key: "analytics",
        label: "Analytics",
        description: "Ask free-form questions over product events and research queries.",
      },
    ] as const;

    const renderAdminNav = () => (
      <section className="space-y-4">
        <header className="space-y-2">
          <h1 className="font-[Newsreader] text-[clamp(2.2rem,4vw,3.5rem)] font-semibold leading-[0.92] tracking-[-0.05em] text-[var(--ink)]">
            Admin
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-[var(--ink-soft)]">
            Signed in as {adminAccess.user?.email ?? "unknown user"}. Move between runs, users, analytics, and full run logs from here.
          </p>
        </header>

        <div className="grid gap-3 md:grid-cols-4">
          {adminNavItems.map((item) => {
            const active = adminSection === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  pendingUrlWriteModeRef.current = "push";
                  setAdminSection(item.key);
                }}
                className={cn(
                  "rounded-[22px] border px-5 py-4 text-left transition",
                  active
                    ? "border-[rgba(72,43,37,0.24)] bg-[rgba(255,255,255,0.92)] shadow-[0_20px_60px_rgba(72,43,37,0.08)]"
                    : "border-[rgba(72,43,37,0.08)] bg-[rgba(255,255,255,0.68)] hover:border-[rgba(72,43,37,0.16)] hover:bg-[rgba(255,255,255,0.84)]",
                )}
              >
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">{item.label}</div>
                <div className="mt-2 text-sm leading-6 text-[var(--ink)]">{item.description}</div>
              </button>
            );
          })}
        </div>
      </section>
    );

    if (showingIncidents) {
      return (
        <div className="view-shell space-y-6">
          {renderAdminNav()}

          <section className="space-y-4">
            <Card className="overflow-hidden rounded-[28px] border-[rgba(72,43,37,0.06)] bg-[linear-gradient(180deg,rgba(255,251,248,0.98),rgba(255,255,255,0.92))] shadow-none">
              <CardContent className="space-y-5 p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-2">
                    <h2 className="font-[Newsreader] text-[clamp(1.9rem,3vw,3rem)] font-semibold tracking-[-0.04em] text-[var(--ink)]">
                      Incident Log Explorer
                    </h2>
                    <p className="max-w-3xl text-sm leading-6 text-[var(--ink-soft)]">
                      Search every unexpected error fingerprint, inspect repeated occurrences, and read raw captured payloads without leaving admin.
                    </p>
                  </div>
                  <Button type="button" variant="outline" onClick={() => void loadAdminIncidents()}>
                    Refresh logs
                  </Button>
                </div>

                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_12rem_10rem]">
                  <input
                    className="min-h-12 rounded-[16px] border border-[rgba(72,43,37,0.12)] bg-white px-4 text-sm text-[var(--ink)] outline-none transition focus:border-[rgba(72,43,37,0.28)]"
                    placeholder="Search by message, route, run ID, session ID, fingerprint, stack, or service"
                    value={adminIncidents.query}
                    onChange={(event) => setAdminIncidents((current) => ({ ...current, query: event.currentTarget.value }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void loadAdminIncidents({ query: adminIncidents.query });
                      }
                    }}
                  />
                  <select
                    className="min-h-12 rounded-[16px] border border-[rgba(72,43,37,0.12)] bg-white px-4 text-sm text-[var(--ink)] outline-none transition focus:border-[rgba(72,43,37,0.28)]"
                    value={String(adminIncidents.days)}
                    onChange={(event) => {
                      const days = Number(event.currentTarget.value);
                      setAdminIncidents((current) => ({ ...current, days }));
                      void loadAdminIncidents({ days });
                    }}
                  >
                    <option value="1">Last day</option>
                    <option value="3">Last 3 days</option>
                    <option value="7">Last 7 days</option>
                    <option value="14">Last 14 days</option>
                    <option value="30">Last 30 days</option>
                  </select>
                  <Button
                    type="button"
                    className="bg-black text-white transition hover:bg-black/90"
                    onClick={() => void loadAdminIncidents({ query: adminIncidents.query, days: adminIncidents.days })}
                    disabled={adminIncidents.loading}
                  >
                    {adminIncidents.loading ? "Searching…" : "Search"}
                  </Button>
                </div>

                {adminIncidents.error ? <ErrorNotice message={adminIncidents.error} /> : null}

                <div className="grid gap-4 xl:grid-cols-[minmax(20rem,0.95fr)_minmax(0,1.45fr)]">
                  <div className="rounded-[22px] border border-[rgba(72,43,37,0.08)] bg-[rgba(255,255,255,0.74)]">
                    <div className="flex items-center justify-between border-b border-[rgba(72,43,37,0.08)] px-4 py-3">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Fingerprints</div>
                        <div className="text-sm text-[var(--ink-soft)]">{incidentRows.length} matching groups</div>
                      </div>
                    </div>
                    <div className="max-h-[72vh] overflow-auto p-2">
                      {incidentRows.length > 0 ? incidentRows.map((row, index) => {
                        const fingerprint = typeof row.fingerprint === "string" ? row.fingerprint : `incident-${index}`;
                        const active = fingerprint === selectedFingerprint;
                        return (
                          <button
                            key={fingerprint}
                            type="button"
                            onClick={() => setAdminIncidents((current) => ({ ...current, selectedFingerprint: fingerprint }))}
                            className={cn(
                              "mb-2 w-full rounded-[18px] border px-4 py-4 text-left transition",
                              active
                                ? "border-[rgba(72,43,37,0.22)] bg-[rgba(255,248,243,0.96)] shadow-[0_16px_42px_rgba(72,43,37,0.08)]"
                                : "border-[rgba(72,43,37,0.08)] bg-white hover:border-[rgba(72,43,37,0.16)]",
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <IncidentSeverityBadge severity={adminText(row.severity)} />
                              <div className="text-xs text-[var(--ink-soft)]">{adminText(row.count)} hits</div>
                            </div>
                            <div className="mt-3 font-medium text-[var(--ink)]">{adminText(row.message)}</div>
                            <div className="mt-2 text-xs leading-5 text-[var(--ink-soft)]">
                              {adminText(row.service)} · {adminText(row.source)} · {adminText(row.route)}
                            </div>
                            <div className="mt-2 text-xs leading-5 text-[var(--ink-soft)]">
                              {adminText(row.runId) !== "—" ? `run ${adminText(row.runId)} · ` : ""}
                              {adminText(row.sessionId) !== "—" ? `session ${adminText(row.sessionId)} · ` : ""}
                              last seen {formatRelativeTime(typeof row.lastSeenAt === "string" ? row.lastSeenAt : null)}
                            </div>
                          </button>
                        );
                      }) : (
                        <div className="px-3 py-8 text-sm text-[var(--ink-soft)]">
                          {adminIncidents.loading ? "Loading incidents…" : "No incidents matched this search window."}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-4">
                    {selectedIncident ? (
                      <>
                        <Card className="rounded-[22px] border-[rgba(72,43,37,0.08)] bg-[rgba(255,255,255,0.82)] shadow-none">
                          <CardContent className="space-y-4 p-5">
                            <div className="flex flex-wrap items-start justify-between gap-4">
                              <div className="space-y-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  <IncidentSeverityBadge severity={adminText(selectedIncident.severity)} />
                                  <span className="text-xs uppercase tracking-[0.16em] text-[var(--ink-soft)]">{adminText(selectedIncident.service)}</span>
                                </div>
                                <h3 className="font-[Newsreader] text-[clamp(1.5rem,2.4vw,2.2rem)] font-semibold leading-[0.98] tracking-[-0.04em] text-[var(--ink)]">
                                  {adminText(selectedIncident.message)}
                                </h3>
                              </div>
                              <div className="text-right text-xs leading-5 text-[var(--ink-soft)]">
                                <div>{adminText(selectedIncident.count)} total occurrences</div>
                                <div>First seen {formatRelativeTime(typeof selectedIncident.firstSeenAt === "string" ? selectedIncident.firstSeenAt : null)}</div>
                                <div>Last seen {formatRelativeTime(typeof selectedIncident.lastSeenAt === "string" ? selectedIncident.lastSeenAt : null)}</div>
                              </div>
                            </div>

                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                              <div className="rounded-[18px] bg-[rgba(72,43,37,0.05)] px-4 py-3">
                                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Route</div>
                                <div className="mt-1 text-sm text-[var(--ink)]">{adminText(selectedIncident.route)}</div>
                              </div>
                              <div className="rounded-[18px] bg-[rgba(72,43,37,0.05)] px-4 py-3">
                                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Method / Tool</div>
                                <div className="mt-1 text-sm text-[var(--ink)]">{adminText(selectedIncident.method)} {adminText(selectedIncident.toolName) !== "—" ? `· ${adminText(selectedIncident.toolName)}` : ""}</div>
                              </div>
                              <div className="rounded-[18px] bg-[rgba(72,43,37,0.05)] px-4 py-3">
                                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Run / Session</div>
                                <div className="mt-1 text-sm text-[var(--ink)]">{adminText(selectedIncident.runId)} {adminText(selectedIncident.sessionId) !== "—" ? `· ${adminText(selectedIncident.sessionId)}` : ""}</div>
                              </div>
                            </div>

                            <div className="space-y-2">
                              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Fingerprint</div>
                              <code className="block overflow-auto rounded-[16px] bg-[rgba(32,24,18,0.05)] px-4 py-3 text-xs leading-6 text-[var(--ink)]">
                                {adminText(selectedIncident.fingerprint)}
                              </code>
                            </div>

                            {adminText(selectedIncident.runId) !== "—" ? (
                              <div className="flex flex-wrap gap-3">
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => {
                                    pendingUrlWriteModeRef.current = "push";
                                    setAdminSection("logs");
                                    void loadAdminRunLogs(adminText(selectedIncident.runId));
                                  }}
                                >
                                  Open run logs
                                </Button>
                              </div>
                            ) : null}
                          </CardContent>
                        </Card>

                        <AdminTableCard title="Occurrence Log">
                          {selectedIncidentEvents.length > 0 ? (
                            <div className="space-y-3">
                              {selectedIncidentEvents.map((event, index) => (
                                <div key={`${adminText(event.id)}-${index}`} className="rounded-[18px] border border-[rgba(72,43,37,0.08)] bg-white p-4">
                                  <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div className="text-sm font-medium text-[var(--ink)]">
                                      {formatRelativeTime(typeof event.createdAt === "string" ? event.createdAt : null)}
                                    </div>
                                    <div className="text-xs text-[var(--ink-soft)]">
                                      {adminText(event.source)} {adminText(event.route) !== "—" ? `· ${adminText(event.route)}` : ""}
                                    </div>
                                  </div>
                                  <pre className="mt-3 max-h-[18rem] overflow-auto rounded-[14px] bg-[rgba(32,24,18,0.05)] p-3 text-xs leading-6 text-[var(--ink)]">
                                    {formatJson(event)}
                                  </pre>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-sm text-[var(--ink-soft)]">No raw events matched this fingerprint.</p>
                          )}
                        </AdminTableCard>
                      </>
                    ) : (
                      <AdminTableCard title="Incident Detail">
                        <p className="text-sm text-[var(--ink-soft)]">
                          Select a fingerprint from the left to inspect its full occurrence log.
                        </p>
                      </AdminTableCard>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>
        </div>
      );
    }

    if (showingLogs) {
      return (
        <div className="view-shell space-y-6">
          {renderAdminNav()}

          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-2">
                <h1 className="font-[Newsreader] text-[clamp(2.2rem,4vw,3.5rem)] font-semibold leading-[0.92] tracking-[-0.05em] text-[var(--ink)]">
                  Run Log Detail
                </h1>
                <p className="max-w-3xl text-sm leading-6 text-[var(--ink-soft)]">
                  Inspect one run in full, including tool calls, session context, artifacts, prompts, and live runtime output.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  pendingUrlWriteModeRef.current = "push";
                  setAdminSection("runs");
                }}
              >
                Back to runs
              </Button>
            </div>

            <Card className="rounded-[24px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.78)] shadow-none">
              <CardContent className="space-y-4 p-5">
                <form
                  className="flex flex-col gap-3 md:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void loadAdminRunLogs(adminRunInput);
                  }}
                >
                  <input
                    className="min-h-12 flex-1 rounded-[16px] border border-[rgba(72,43,37,0.12)] bg-white px-4 text-sm text-[var(--ink)] outline-none transition focus:border-[rgba(72,43,37,0.28)]"
                    placeholder="Enter a run ID"
                    value={adminRunInput}
                    onChange={(event) => setAdminRunInput(event.currentTarget.value)}
                  />
                  <Button type="submit" disabled={adminRunLog.loading || !adminRunInput.trim()}>
                    {adminRunLog.loading ? "Loading…" : "Load run"}
                  </Button>
                </form>

                <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--ink-soft)]">
                  <span>Signed in as {adminAccess.user?.email ?? "unknown user"}.</span>
                  {adminRunLog.runId ? <span>Viewing run {adminRunLog.runId}.</span> : null}
                  {summary.length > 0 ? <span>{summary.join(" · ")}</span> : null}
                </div>

                {adminRunLog.error ? <ErrorNotice message={adminRunLog.error} /> : null}
              </CardContent>
            </Card>
          </section>

          {adminRunLog.payload ? (
            <section className="space-y-4">
              <AdminLogConsole payload={adminRunLog.payload} />
            </section>
          ) : null}
        </div>
      );
    }

    return (
      <div className="view-shell space-y-6">
        {renderAdminNav()}

        {adminSection === "runs" ? (
          <section className="space-y-4">
            <Card className="rounded-[24px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.78)] shadow-none">
              <CardContent className="space-y-4 p-5">
                <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <div className="space-y-2">
                    <h2 className="font-[Newsreader] text-[clamp(1.8rem,3vw,2.8rem)] font-semibold tracking-[-0.04em] text-[var(--ink)]">
                      Assistant Runs
                    </h2>
                    <p className="max-w-3xl text-sm leading-6 text-[var(--ink-soft)]">
                      Every assistant run across the app. Open a session or drill straight into full runtime logs.
                    </p>
                  </div>
                  <form
                    className="flex flex-col gap-3 md:w-[32rem] md:flex-row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void loadAdminRunLogs(adminRunInput);
                    }}
                  >
                    <input
                      className="min-h-12 flex-1 rounded-[16px] border border-[rgba(72,43,37,0.12)] bg-white px-4 text-sm text-[var(--ink)] outline-none transition focus:border-[rgba(72,43,37,0.28)]"
                      placeholder="Jump to a run ID"
                      value={adminRunInput}
                      onChange={(event) => setAdminRunInput(event.currentTarget.value)}
                    />
                    <Button type="submit" disabled={adminRunLog.loading || !adminRunInput.trim()}>
                      {adminRunLog.loading ? "Loading…" : "Open logs"}
                    </Button>
                  </form>
                </div>
              </CardContent>
            </Card>

            <AdminTableCard title="Runs">
              {adminRuns.error ? (
                <ErrorNotice message={adminRuns.error} />
              ) : adminRuns.loading ? (
                <p className="text-sm text-[var(--ink-soft)]">Loading runs…</p>
              ) : (
                <div className="overflow-auto">
                  <table className="min-w-full text-sm text-[var(--ink)]">
                    <thead className="text-left text-xs uppercase tracking-[0.16em] text-[var(--ink-soft)]">
                      <tr>
                        <th className="pb-3 pr-4">Run</th>
                        <th className="pb-3 pr-4">Status</th>
                        <th className="pb-3 pr-4">Owner</th>
                        <th className="pb-3 pr-4">Session</th>
                        <th className="pb-3 pr-4">Started</th>
                        <th className="pb-3 pr-4">Spend</th>
                        <th className="pb-3 pr-4">Tools</th>
                        <th className="pb-3 pr-4">Messages</th>
                        <th className="pb-3 pr-4">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adminRuns.rows.map((row, index) => {
                        const runId = adminText(row.id);
                        const sessionId = adminText(row.sessionId);
                        return (
                          <tr key={`${runId}-${index}`} className="border-t border-[rgba(72,43,37,0.08)] align-top">
                            <td className="py-3 pr-4">
                              <div className="font-medium">{runId}</div>
                              <div className="max-w-[20rem] text-xs text-[var(--ink-soft)]">{adminText(row.lastMessagePreview)}</div>
                            </td>
                            <td className="py-3 pr-4">{adminText(row.status)}</td>
                            <td className="py-3 pr-4">
                              <div>{adminText(row.userName) !== "—" ? adminText(row.userName) : adminText(row.userEmail)}</div>
                              <div className="text-xs text-[var(--ink-soft)]">{adminText(row.userEmail)}</div>
                            </td>
                            <td className="py-3 pr-4">
                              <div>{adminText(row.sessionTitle)}</div>
                              <div className="text-xs text-[var(--ink-soft)]">{sessionId}</div>
                            </td>
                            <td className="py-3 pr-4">{formatRelativeTime(typeof row.startedAt === "string" ? row.startedAt : null)}</td>
                            <td className="py-3 pr-4">{formatCurrency(typeof row.spendUsd === "number" ? row.spendUsd : NaN)}</td>
                            <td className="py-3 pr-4">{adminText(row.toolCallCount)}</td>
                            <td className="py-3 pr-4">{adminText(row.messageCount)}</td>
                            <td className="py-3 pr-4">
                              <div className="flex flex-col gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    pendingUrlWriteModeRef.current = "push";
                                    setAdminSection("logs");
                                    void loadAdminRunLogs(runId);
                                  }}
                                >
                                  Logs
                                </Button>
                                <Button asChild type="button" variant="ghost" size="sm">
                                  <a href={`/?view=assistant&session=${encodeURIComponent(sessionId)}`}>Open session</a>
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </AdminTableCard>
          </section>
        ) : null}

        {adminSection === "users" ? (
          <section className="space-y-4">
            <Card className="rounded-[24px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.78)] shadow-none">
              <CardContent className="space-y-3 p-5">
                <h2 className="font-[Newsreader] text-[clamp(1.8rem,3vw,2.8rem)] font-semibold tracking-[-0.04em] text-[var(--ink)]">
                  Signed-Up Users
                </h2>
                <p className="max-w-3xl text-sm leading-6 text-[var(--ink-soft)]">
                  Account-level usage snapshot with session and run counts, plus rolling 30-day, lifetime, and per-session billing totals.
                </p>
              </CardContent>
            </Card>

            <AdminTableCard title="Users">
              {adminUsers.error ? (
                <ErrorNotice message={adminUsers.error} />
              ) : adminUsers.loading ? (
                <p className="text-sm text-[var(--ink-soft)]">Loading users…</p>
              ) : (
                <div className="overflow-auto">
                  <table className="min-w-full text-sm text-[var(--ink)]">
                    <thead className="text-left text-xs uppercase tracking-[0.16em] text-[var(--ink-soft)]">
                      <tr>
                        <th className="pb-3 pr-4">User</th>
                        <th className="pb-3 pr-4">Created</th>
                        <th className="pb-3 pr-4">Sessions</th>
                        <th className="pb-3 pr-4">Runs</th>
                        <th className="pb-3 pr-4">30d spend</th>
                        <th className="pb-3 pr-4">Lifetime spend</th>
                        <th className="pb-3 pr-4">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adminUsers.rows.map((row, index) => (
                        <tr key={`${adminText(row.id)}-${index}`} className="border-t border-[rgba(72,43,37,0.08)] align-top">
                          <td className="py-3 pr-4">
                            <div className="font-medium">{adminText(row.name) !== "—" ? adminText(row.name) : adminText(row.email)}</div>
                            <div className="text-xs text-[var(--ink-soft)]">{adminText(row.email)}</div>
                            <div className="text-xs text-[var(--ink-soft)]">{adminText(row.id)}</div>
                          </td>
                          <td className="py-3 pr-4">{formatRelativeTime(typeof row.createdAt === "string" ? row.createdAt : null)}</td>
                          <td className="py-3 pr-4">{adminText(row.sessionCount)}</td>
                          <td className="py-3 pr-4">{adminText(row.runCount)}</td>
                          <td className="py-3 pr-4">{formatCurrency(typeof row.monthlySpendUsd === "number" ? row.monthlySpendUsd : NaN)}</td>
                          <td className="py-3 pr-4">{formatCurrency(typeof row.totalSpendUsd === "number" ? row.totalSpendUsd : NaN)}</td>
                          <td className="py-3 pr-4">{formatRelativeTime(typeof row.lastSeenAt === "string" ? row.lastSeenAt : null)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </AdminTableCard>

            <AdminTableCard title="Sessions">
              {adminSessions.error ? (
                <ErrorNotice message={adminSessions.error} />
              ) : adminSessions.loading ? (
                <p className="text-sm text-[var(--ink-soft)]">Loading sessions…</p>
              ) : (
                <div className="overflow-auto">
                  <table className="min-w-full text-sm text-[var(--ink)]">
                    <thead className="text-left text-xs uppercase tracking-[0.16em] text-[var(--ink-soft)]">
                      <tr>
                        <th className="pb-3 pr-4">Session</th>
                        <th className="pb-3 pr-4">Owner</th>
                        <th className="pb-3 pr-4">Runs</th>
                        <th className="pb-3 pr-4">Messages</th>
                        <th className="pb-3 pr-4">Spend</th>
                        <th className="pb-3 pr-4">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adminSessions.rows.map((row, index) => (
                        <tr key={`${adminText(row.id)}-${index}`} className="border-t border-[rgba(72,43,37,0.08)] align-top">
                          <td className="py-3 pr-4">
                            <div className="font-medium">{adminText(row.title)}</div>
                            <div className="max-w-[24rem] text-xs text-[var(--ink-soft)]">{adminText(row.lastMessagePreview)}</div>
                            <div className="text-xs text-[var(--ink-soft)]">{adminText(row.id)}</div>
                          </td>
                          <td className="py-3 pr-4">
                            <div>{adminText(row.userName) !== "—" ? adminText(row.userName) : adminText(row.userEmail)}</div>
                            <div className="text-xs text-[var(--ink-soft)]">{adminText(row.userEmail)}</div>
                          </td>
                          <td className="py-3 pr-4">{adminText(row.runCount)}</td>
                          <td className="py-3 pr-4">{adminText(row.messageCount)}</td>
                          <td className="py-3 pr-4">{formatCurrency(typeof row.spendUsd === "number" ? row.spendUsd : NaN)}</td>
                          <td className="py-3 pr-4">{formatRelativeTime(typeof row.lastMessageAt === "string" ? row.lastMessageAt : null)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </AdminTableCard>
          </section>
        ) : null}

        {adminSection === "analytics" ? (
          <section className="space-y-4">
            <Card className="rounded-[24px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.78)] shadow-none">
              <CardContent className="space-y-4 p-5">
                <div className="space-y-2">
                  <h2 className="font-[Newsreader] text-[clamp(1.8rem,3vw,2.8rem)] font-semibold tracking-[-0.04em] text-[var(--ink)]">
                    Vibe Analytics
                  </h2>
                  <p className="max-w-3xl text-sm leading-6 text-[var(--ink-soft)]">
                    Ask for metrics, time series, or topic patterns. The worker pulls recent analytics events and user research messages, then uses the model to answer in a structured format.
                  </p>
                </div>

                <div className="grid gap-4 rounded-[20px] bg-[rgba(26,33,52,0.03)] p-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">Tracked Events</h3>
                    <div className="space-y-1 text-sm leading-6 text-[var(--ink)]">
                      <p><code>sign_in</code>: a user started a sign-in flow.</p>
                      <p><code>sign_up</code>: a user started a sign-up flow.</p>
                      <p><code>assistant_session_created</code>: a new assistant session was created.</p>
                      <p><code>assistant_followup_message</code>: a user sent another message in an existing session.</p>
                      <p><code>book_impression</code>: a book became visible in the explore feed.</p>
                      <p><code>book_open</code>: a book page was opened.</p>
                      <p><code>book_selected_for_ask</code>: a book was added into an ask.</p>
                      <p><code>book_citation_open</code>: a citation opened a book.</p>
                      <p><code>book_candidate_in_run</code>: the orchestrator elevated a book into a serious candidate set.</p>
                      <p><code>book_cited</code>: the final answer cited the book.</p>
                      <p><code>book_used_in_successful_answer</code>: the book contributed to a completed answer.</p>
                      <p>User research messages from assistant sessions are also available as text corpus input for topic and phrasing questions.</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">Good Questions</h3>
                    <div className="space-y-1 text-sm leading-6 text-[var(--ink)]">
                      <p>Which books are trending this week by opens, asks, and citations?</p>
                      <p>What books are rising quickly even if total volume is still low?</p>
                      <p>Which books get many impressions but few opens?</p>
                      <p>Which books are most used in successful answers?</p>
                      <p>Which subjects or shelves are overperforming in explore?</p>
                      <p>Which books are selected for asks most often after being seen in the feed?</p>
                    </div>
                  </div>
                </div>

                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void loadAdminAnalytics(adminAnalytics.draft);
                  }}
                >
                  <div className="flex flex-col gap-3 md:flex-row">
                    <input
                      type="text"
                      className="min-h-12 flex-1 rounded-[16px] border border-[rgba(72,43,37,0.12)] bg-white px-4 text-sm text-[var(--ink)] outline-none transition focus:border-[rgba(72,43,37,0.28)]"
                      value={adminAnalytics.draft}
                      onChange={(event) => {
                        const nextDraft = event.currentTarget.value;
                        setAdminAnalytics((current) => ({ ...current, draft: nextDraft }));
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                      onKeyUp={(event) => event.stopPropagation()}
                      placeholder="Ask an analytics question"
                      spellCheck={false}
                    />
                    <Button
                      type="submit"
                      className="bg-black text-white transition hover:bg-black/90 disabled:bg-black/20 disabled:text-black/45"
                      disabled={adminAnalytics.loading || !adminAnalytics.draft.trim()}
                    >
                      {adminAnalytics.loading ? "Running analytics…" : "Run analytics query"}
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm text-[var(--ink-soft)]">
                      Type a question, then run it with the button.
                    </span>
                    <span className="text-sm text-[var(--ink-soft)]">
                      Backed by `/a` events plus recent user messages from assistant sessions.
                    </span>
                  </div>
                </form>

                {adminAnalytics.error ? <ErrorNotice message={adminAnalytics.error} /> : null}
              </CardContent>
            </Card>

            {adminAnalytics.payload ? (
              <div className="grid gap-4 xl:grid-cols-[1.3fr_1.7fr]">
                <AdminTableCard title={adminText(analyticsPayload.title) !== "—" ? adminText(analyticsPayload.title) : "Result"}>
                  <div className="space-y-4">
                    <p className="text-sm leading-6 text-[var(--ink)]">{adminText(analyticsPayload.summary)}</p>
                    {analyticsMetrics.length > 0 ? (
                      <div className="flex flex-wrap gap-3">
                        {analyticsMetrics.map((metric, index) => (
                          <div key={`${adminText(metric.label)}-${index}`} className="rounded-[18px] border border-[rgba(72,43,37,0.08)] bg-[rgba(255,255,255,0.78)] px-4 py-3">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">
                              {adminText(metric.label)}
                            </div>
                            <div className="mt-1 text-lg font-semibold text-[var(--ink)]">{adminText(metric.value)}</div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {analyticsHashtags.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {analyticsHashtags.map((hashtag, index) => (
                          <span key={`${adminText(hashtag.tag)}-${index}`} className="rounded-full bg-[rgba(72,43,37,0.08)] px-3 py-1 text-xs font-medium text-[var(--ink)]">
                            {adminText(hashtag.tag)} {adminText(hashtag.count) !== "—" ? `· ${adminText(hashtag.count)}` : ""}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {analyticsNotes.length > 0 ? (
                      <div className="space-y-2">
                        {analyticsNotes.map((note, index) => (
                          <p key={`analytics-note-${index}`} className="text-sm leading-6 text-[var(--ink-soft)]">
                            {typeof note === "string" ? note : adminText(note)}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </AdminTableCard>

                <div className="space-y-4">
                  {analyticsSeries.length > 0 ? analyticsSeries.map((series, index) => (
                    <AnalyticsSeriesCard key={`${adminText(series.label)}-${index}`} series={series} />
                  )) : (
                    <AdminTableCard title="Series">
                      <p className="text-sm leading-6 text-[var(--ink-soft)]">
                        No structured series was returned for this question.
                      </p>
                    </AdminTableCard>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    );
  }

  function renderMainView() {
    switch (activeView) {
      case "explore":
        return renderExploreView();
      case "assistant_document":
        return renderAssistantDocumentView();
      case "book":
        return renderBookView();
      case "profile":
        return renderProfileView();
      case "admin":
        return renderAdminView();
      case "assistant":
      default:
        return renderAssistantView();
    }
  }

  if (activeView === "assistant_document") {
    return renderAssistantDocumentView();
  }

  return (
    <div className={cn("app-shell", mobileNavOpen && "is-nav-open", sidebarCollapsed && "is-sidebar-collapsed")}>
      {sidebarCollapsed ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="sidebar-expand-fab hidden md:inline-flex"
          aria-label="Expand sidebar"
          onClick={() => setSidebarCollapsed(false)}
        >
          <ChevronsRight className="size-4" />
        </Button>
      ) : null}

      <button
        type="button"
        className={`shell-backdrop ${mobileNavOpen ? "is-open" : ""}`}
        aria-label="Close navigation"
        onClick={() => setMobileNavOpen(false)}
      />

      <aside className={cn("sidebar", mobileNavOpen && "is-open", sidebarCollapsed && "is-collapsed")} data-testid="sidebar">
        <div className="sidebar-header gap-4">
          <div className="brand-lockup">
            <div className="flex min-w-0 items-center gap-3">
              <span className="wordmark">{WORDMARK}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="hidden md:inline-flex"
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                onClick={() => setSidebarCollapsed((current) => !current)}
              >
                {sidebarCollapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
              </Button>
              <button
                type="button"
                className="mobile-nav-close"
                aria-label="Close menu"
                onClick={() => setMobileNavOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>
          </div>

        </div>

        <div className="sidebar-scroll-region">
          <nav className={cn("sidebar-nav", sidebarCollapsed && "items-center")} aria-label="Primary">
            {navigationItems.map((item) => {
              const Icon = item.icon;
              const isAssistantNewChatActive =
                item.id === "assistant"
                && activeView === "assistant"
                && !selectedSessionId;
              const isActive =
                isAssistantNewChatActive
                || (activeView === item.id && item.id !== "assistant")
                || (activeView === "book" && item.id === "explore");
              return (
                <Button
                  key={item.id}
                  type="button"
                  variant="ghost"
                  className={cn(
                    "sidebar-nav-button w-full justify-start rounded-none px-0 py-3 text-[1.05rem]",
                    isActive && "is-active",
                    isActive && "font-medium",
                    sidebarCollapsed && "w-11 justify-center px-0",
                  )}
                  onClick={() => handleNavSelection(item.id)}
                >
                  <Icon />
                  {!sidebarCollapsed ? <span>{item.label}</span> : null}
                </Button>
              );
            })}
          </nav>

          <SidebarRecents
            collapsed={sidebarCollapsed}
            activeView={activeView}
            sessions={sessions}
            runningSessionIds={runningSessionIds}
            sessionNotifications={sessionNotifications}
            selectedSessionId={selectedSessionId}
            onSelectSession={openSession}
          />
        </div>

        {authPending ? (
          <SidebarProfileSkeleton collapsed={sidebarCollapsed} />
        ) : hasAuthenticatedUser || !authState.authConfigured ? (
          <div className={cn("sidebar-profile-wrap", sidebarCollapsed && "is-collapsed")}>
            {!sidebarCollapsed ? (
              <a
                className="sidebar-powered-by"
                href="https://alpharesearch.nyc"
                target="_blank"
                rel="noreferrer"
              >
                powered by Alpha Research Co.
              </a>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className={cn(
                "sidebar-profile h-auto justify-start gap-3 rounded-none p-0",
                sidebarCollapsed && "size-12 justify-center p-0",
              )}
              onClick={() => {
                openProfile(currentUser?.id ?? null);
                setMobileNavOpen(false);
              }}
              aria-label="Open profile"
              title={displayProfileName}
            >
              <Avatar className="size-11 bg-white p-0.5">
                {currentUser?.avatarUrl ? <AvatarImage className="sidebar-avatar-image" src={currentUser.avatarUrl} alt={displayProfileName} /> : null}
                <AvatarFallback
                  className={cn(hasAuthenticatedUser ? "text-white" : "bg-[rgba(72,43,37,0.05)] text-[var(--ink-soft)]")}
                  style={
                    hasAuthenticatedUser
                      ? ({
                          background: `linear-gradient(160deg, hsl(${profileHue} 72% 56%), hsl(${profileHue - 12} 62% 46%))`,
                        } as CSSProperties)
                      : undefined
                  }
                >
                  {hasAuthenticatedUser ? initialsFromSeed(displayProfileName) : <ProfileIcon />}
                </AvatarFallback>
              </Avatar>
              {!sidebarCollapsed ? (
                <div className="min-w-0 text-left">
                  <div className="truncate text-[1rem] font-medium text-[var(--ink)]">{displayProfileName}</div>
                  <div className="truncate text-xs text-[var(--ink-soft)]">{hasAuthenticatedUser ? "Account" : "Guest reader"}</div>
                </div>
              ) : null}
            </Button>
          </div>
        ) : (
          <Button asChild variant="default" className={cn("sidebar-signin sidebar-signin-bottom signin-pill-button", sidebarCollapsed && "size-11 px-0")}>
            <a href={buildSignInUrl(window.location.href)}>{sidebarCollapsed ? "→" : "Sign in"}</a>
          </Button>
        )}
      </aside>

      <main className={`main-panel is-${activeView}`}>
        <div className="mobile-shell-bar items-center">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="mobile-shell-button"
            aria-label="Open navigation"
            onClick={() => setMobileNavOpen(true)}
          >
            <MenuIcon />
          </Button>
          <div className="mobile-shell-meta">
            <span className="mobile-shell-wordmark">{WORDMARK}</span>
            <strong>{activeViewLabel}</strong>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="mobile-shell-button mobile-profile-button overflow-hidden"
            aria-label="Open profile"
            onClick={() => {
              openProfile(currentUser?.id ?? null);
            }}
          >
            <Avatar className="size-8">
              {currentUser?.avatarUrl ? <AvatarImage className="sidebar-avatar-image" src={currentUser.avatarUrl} alt={displayProfileName} /> : null}
              <AvatarFallback>{hasAuthenticatedUser ? initialsFromSeed(displayProfileName) : <ProfileIcon />}</AvatarFallback>
            </Avatar>
          </Button>
        </div>
        {loadError ? <ErrorNotice className="thread-error-banner" message={loadError} onDismiss={() => setLoadError(null)} /> : null}
        {renderMainView()}
      </main>

      {renderExploreBookOverlay()}

      {billingLimitState ? (
        <BillingLimitDialog
          state={billingLimitState}
          onClose={() => setBillingLimitState(null)}
        />
      ) : null}

      {debugEnabled && AgentationComponent ? (
        <AgentationComponent
          className="agentation-shell"
          onCopy={(markdown) => {
            console.info("[Agentation] copied feedback", markdown);
          }}
        />
      ) : null}
    </div>
  );
}
