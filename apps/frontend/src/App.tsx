import { createContext, type ComponentType, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type UIEvent, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { ReadonlyJSONObject, ReadonlyJSONValue } from "assistant-stream/utils";
import type { AgentationProps } from "agentation";
import { ChevronsLeft, ChevronsRight, Link2, MessageSquarePlus } from "lucide-react";

import { getToolLabel, type ChatSessionSummary, type Citation, type MessageRecord, type PublicProfileResponse, type UserProfile, type WorkDetail, type WorkSource, type WorkSummary } from "@alphabook/shared";

import { buildSignInUrl, cancelRun, fetchAdminAccess, fetchAdminIncidents, fetchAdminRunLogs, fetchAdminRuns, fetchAdminSessions, fetchAdminUsers, fetchCurrentUser, fetchMessages, fetchProfile, fetchRuns, fetchSessions, fetchWorkDetail, fetchWorks, fetchWorkSource, followProfile, queryAdminAnalytics, sendAnalyticsEvent, signOut, streamChat, streamRun, unfollowProfile, type SessionRunRecord } from "./api";
import { Thread } from "./components/assistant-ui/thread";
import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";
import { Separator } from "./components/ui/separator";
import { Skeleton } from "./components/ui/skeleton";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";

type UiMessage = MessageRecord & {
  citations: Citation[];
  toolCalls: ToolTraceEntry[];
};

type RawUiMessage = MessageRecord & {
  citations: Citation[];
  toolCalls: Array<Record<string, unknown>>;
};

type ToolTraceEntry = {
  id: string;
  toolName: string;
  label: string;
  rationale?: string;
  progress: string[];
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  isError?: boolean;
  state: "running" | "completed" | "error";
};

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

type ViewMode = "explore" | "assistant" | "profile" | "book" | "admin";
type UrlState = {
  view: ViewMode;
  sessionId: string | null | undefined;
  workId: string | null | undefined;
  profileUserId: string | null | undefined;
  runId: string | null | undefined;
  adminSection: "runs" | "users" | "analytics" | "incidents" | "logs";
  debugEnabled: boolean;
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

type ThreadSuggestion = {
  title: string;
  description?: string;
  prompt: string;
};

type ReaderPassageKind = "heading" | "paragraph" | "quote" | "list-item" | "preformatted";

type ReaderPassage = {
  id: string;
  kind: ReaderPassageKind;
  text: string;
  searchText: string;
};

const USER_STORAGE_KEY = "alphabook.localUserId";
const BOOK_ASSISTANT_WIDTH_STORAGE_KEY = "alphabook.bookAssistantWidth";
const BOOK_ASSISTANT_MIN_WIDTH = 320;
const BOOK_ASSISTANT_MAX_WIDTH = 720;
const ASSISTANT_WELCOME_SUGGESTIONS: ThreadSuggestion[] = [
  {
    title: "Find a Passage",
    description: "Pull a tight set of passages on grief and mourning.",
    prompt: "Find the most revealing passages about grief and mourning.",
  },
  {
    title: "Theme Search",
    description: "Contrast eras and authorial treatment of grief.",
    prompt: "summarize grief in 19th century romantic versus 20th century authors.",
  },
];

function isViewMode(value: string | null): value is ViewMode {
  return value === "explore" || value === "assistant" || value === "profile" || value === "book" || value === "admin";
}

function readUrlState(): UrlState {
  if (typeof window === "undefined") {
    return {
      view: "assistant",
      sessionId: undefined,
      workId: undefined,
      profileUserId: undefined,
      runId: undefined,
      adminSection: "runs",
      debugEnabled: false,
    };
  }

  const pathnameMatch = window.location.pathname.match(/^\/works\/([^/]+)$/);
  const profilePathMatch = window.location.pathname.match(/^\/u\/([^/]+)$/);
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get("view");
  const resolvedView = rawView === "library" ? "explore" : rawView;
  return {
    view: pathnameMatch ? "book" : profilePathMatch ? "profile" : isViewMode(resolvedView) ? resolvedView : "assistant",
    sessionId: params.has("session") ? params.get("session") || null : undefined,
    workId: pathnameMatch ? decodeURIComponent(pathnameMatch[1]) : params.has("work") ? params.get("work") || null : undefined,
    profileUserId: profilePathMatch ? decodeURIComponent(profilePathMatch[1]) : params.has("profile") ? params.get("profile") || null : undefined,
    runId: params.has("run") ? params.get("run") || null : undefined,
    adminSection:
      params.get("adminSection") === "users" || params.get("adminSection") === "analytics" || params.get("adminSection") === "incidents" || params.get("adminSection") === "logs"
        ? params.get("adminSection") as "users" | "analytics" | "incidents" | "logs"
        : params.has("run")
          ? "logs"
          : "runs",
    debugEnabled: params.get("debug") === "true",
  };
}

function writeUrlState(next: UrlState) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  if (next.view === "book" && next.workId) {
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
  if (next.view === "admin" && next.runId) {
    url.searchParams.set("run", next.runId);
  } else {
    url.searchParams.delete("run");
  }
  if (next.view === "admin") {
    url.searchParams.set("adminSection", next.adminSection);
  } else {
    url.searchParams.delete("adminSection");
  }

  if ((next.view === "assistant" || next.view === "book") && next.sessionId) {
    url.searchParams.set("session", next.sessionId);
  } else {
    url.searchParams.delete("session");
  }
  if (next.view !== "book" && next.workId) {
    url.searchParams.set("work", next.workId);
  }
  if (next.debugEnabled) {
    url.searchParams.set("debug", "true");
  } else {
    url.searchParams.delete("debug");
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState({}, "", nextUrl);
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

function createGuestProfile(id: string): UserProfile {
  return {
    id,
    email: null,
    handle: null,
    name: "AlphaBook Reader",
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
  const result = entry.result && typeof entry.result === "object" ? (entry.result as Record<string, unknown>) : undefined;
  const explicitState = entry.state;
  const status = entry.status;
  const state =
    explicitState === "running" || explicitState === "completed" || explicitState === "error"
      ? explicitState
      : status === "running"
        ? "running"
        : status === "failed" || entry.isError === true
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
    args: entry.args && typeof entry.args === "object" ? (entry.args as Record<string, unknown>) : {},
    result,
    isError: entry.isError === true || state === "error",
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

function hydrateStoredMessage(message: RawUiMessage): UiMessage {
  return {
    ...message,
    citations: message.citations ?? [],
    toolCalls: Array.isArray(message.toolCalls)
      ? message.toolCalls.map((entry, index) =>
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

function reconcileMessagesWithRunState(messages: UiMessage[], runs: SessionRunRecord[]) {
  if (messages.length === 0 || runs.length === 0) {
    return messages;
  }

  const runStatusById = new Map(runs.map((run) => [run.id, run.status]));

  return messages.map((message) => {
    const runId = typeof message.metadata?.runId === "string" ? message.metadata.runId : null;
    if (!runId) {
      return message;
    }

    const runStatus = runStatusById.get(runId);
    if (!runStatus || (runStatus !== "failed" && runStatus !== "timed_out" && runStatus !== "completed")) {
      return message;
    }

    let changed = false;
    const runFailureReason =
      runStatus === "failed"
        ? "This research run failed before it could finish."
        : runStatus === "timed_out"
          ? "This research run timed out before it could finish."
          : null;
    const nextToolCalls = message.toolCalls.map((toolCall) => {
      if (toolCall.state !== "running") {
        return toolCall;
      }

      changed = true;
      const nextState: ToolTraceEntry["state"] = runStatus === "completed" ? "completed" : "error";
      return {
        ...toolCall,
        state: nextState,
        isError: runStatus === "failed" || runStatus === "timed_out" ? true : toolCall.isError,
        result:
          nextState === "error"
            ? {
                ...(toolCall.result ?? {}),
                ok: false,
                error:
                  typeof toolCall.result?.error === "string" && toolCall.result.error.trim()
                    ? toolCall.result.error
                    : runFailureReason ?? "This step failed.",
              }
            : toolCall.result,
      };
    });

    return changed
      ? {
          ...message,
          toolCalls: nextToolCalls,
        }
      : message;
  });
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

  return passages[0]
    ? {
        passageId: passages[0].id,
        highlight: null,
      }
    : null;
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
  return [
    `${pluralize(toolCalls, "tool call")}`,
    `${pluralize(artifacts, "artifact")}`,
    `${pluralize(runtimeInstances, "runtime")}`,
    `${pluralize(liveRuntime, "live runtime snapshot")}`,
  ];
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

function summarizeToolSentence({
  toolName,
  args,
  result,
  state,
  rationale,
}: Pick<ToolTraceEntry, "toolName" | "args" | "result" | "state" | "rationale">) {
  const planned = typeof rationale === "string" && rationale.trim() ? rationale.trim() : null;
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
    case "search_works":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return query ? `Scanning the library for leads on ${query}.` : "Scanning the library for leads.";
      }
      if (state === "error") {
        return query
          ? `The first search pass for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
          : `The first search pass failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      if (resultWorkCount === 0) {
        return query
          ? `Scanned the library for ${query} and found no strong leads yet.`
          : "Scanned the library and found no strong leads yet.";
      }
      return query
        ? `Scanned the library for ${query} and found ${pluralize(resultWorkCount, "candidate book")}.`
        : `Scanned the library and found ${pluralize(resultWorkCount, "candidate book")}.`;

    case "get_relevant_chunks":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return query ? `Looking for early leads on ${query}.` : "Looking for early leads.";
      }
      if (state === "error") {
        return query
          ? `The quick scan for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
          : `The quick scan failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      if (resultChunkCount === 0) {
        return query
          ? `Ran a quick scan for ${query} and found no strong leads yet.`
          : "Ran a quick scan and found no strong leads yet.";
      }
      return query
        ? `Found ${pluralize(resultChunkCount, "early lead")} for ${query}.`
        : `Found ${pluralize(resultChunkCount, "early lead")}.`;

    case "get_work_metadata":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return `Loading details for ${pluralize(workCount, "book")}.`;
      }
      if (state === "error") {
        return `Loading book details failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return `Loaded details for ${pluralize(resultWorkCount || workCount, "book")}.`;

    case "get_work_text":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return "Opening the full text for a book.";
      }
      if (state === "error") {
        return `Opening the full text failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return "Opened the full text for a book.";

    case "create_workspace":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return "Preparing the deeper research workspace.";
      }
      if (state === "error") {
        return `Preparing the deeper research workspace failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return "Prepared the deeper research workspace.";

    case "run_workspace_task":
      if (state === "running") {
        if (planned) {
          return planned;
        }
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
        if (planned) {
          return planned;
        }
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
        if (planned) {
          return planned;
        }
        return "Cleaning up the background search.";
      }
      if (state === "error") {
        return `Cleaning up the background search failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return "Cleaned up the background search.";

    default:
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return "Running the next research step.";
      }
      if (state === "error") {
        return `A research step failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return "Finished the next research step.";
  }
}

function displayName(user: UserProfile | null) {
  return user?.name?.trim() || user?.email?.split("@")[0] || "AlphaBook Reader";
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

function buildExplorePrompt(question: string, works: WorkSummary[]) {
  const normalized = question.trim();
  if (works.length === 0) {
    return normalized;
  }
  const titles = works.map((work) => work.title).join(", ");
  if (!normalized) {
    return `Give me a concise overview of ${titles}.`;
  }
  return `${normalized}\n\nFocus on these books: ${titles}.`;
}

function buildBookAssistantPrompt(
  question: string,
  work: WorkDetail | null,
  activePassage: ReaderPassage | null,
) {
  const normalized = question.trim();
  if (!normalized || !work) {
    return normalized;
  }

  const header = [
    "You are answering about the book currently open in the reading view.",
    `Title: ${work.title}`,
    work.subtitle ? `Subtitle: ${work.subtitle}` : null,
    work.authors.length > 0 ? `Authors: ${work.authors.join(", ")}` : null,
    work.language ? `Language: ${work.language}` : null,
    activePassage
      ? [
          "Current open passage:",
          `Passage id: ${activePassage.id}`,
          `Passage kind: ${activePassage.kind}`,
          `Passage text: ${activePassage.text.slice(0, 1400)}`,
        ].join("\n")
      : "No specific passage is currently selected.",
    "",
    `User question: ${normalized}`,
    "",
    "Answer using this current book context unless the user explicitly asks to switch books.",
  ].filter(Boolean).join("\n");

  return header;
}

function messageToThreadMessage(message: UiMessage, streamingAssistantId: string | null, isSending: boolean) {
  const metadata = {
    custom: {
      citations: message.citations,
    },
  };

  if (message.role === "assistant") {
    const toolParts = message.toolCalls.map((entry) => {
        const progress = entry.progress.filter((value) => value.trim().length > 0);
        const args = toReadonlyJsonObject(
          {
            ...entry.args,
            ...(entry.rationale
              ? {
                  __rationale: entry.rationale,
                }
              : {}),
            ...(progress.length > 0
              ? {
                  __progress: progress,
                }
              : {}),
          },
        );
        return {
          type: "tool-call" as const,
          toolCallId: entry.id,
          toolName: entry.label,
          args,
          argsText: JSON.stringify(args),
          status:
            entry.state === "running"
              ? ({ type: "running" } as const)
              : entry.isError
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
                result: entry.result ?? { ok: !entry.isError },
                isError: entry.isError,
              }),
        };
      });
    const hasRunningTool = message.toolCalls.some((entry) => entry.state === "running");
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
        (isSending && message.id === streamingAssistantId) || hasRunningTool
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

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H9l-5 4v-4.5A2.5 2.5 0 0 1 4 13.5Z" />
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
  { id: "explore", label: "Explore", icon: CompassIcon },
  { id: "assistant", label: "Assistant", icon: ChatIcon },
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

function AssistantLoadingState() {
  return (
    <div className="assistant-loading-state" aria-hidden="true">
      <div className="assistant-loading-center">
        <div className="assistant-loading-copy">
          <Skeleton className="assistant-loading-title" />
          <Skeleton className="assistant-loading-subtitle" />
        </div>
      </div>

      <div className="assistant-loading-footer">
        <div className="assistant-loading-suggestions">
          {[0, 1].map((item) => (
            <div key={item} className="assistant-loading-suggestion">
              <Skeleton className="assistant-loading-suggestion-title" />
              <Skeleton className="assistant-loading-suggestion-copy" />
            </div>
          ))}
        </div>

        <div className="assistant-loading-composer">
          <Skeleton className="assistant-loading-composer-line is-long" />
          <Skeleton className="assistant-loading-composer-line" />
          <div className="assistant-loading-composer-footer">
            <Skeleton className="assistant-loading-status" />
            <Skeleton className="assistant-loading-send" />
          </div>
        </div>
      </div>
    </div>
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
  return (
    <div className="book-reader-surface book-reader-surface-loading" aria-hidden="true">
      <div className="book-reader-passages book-reader-passages-loading">
        {[0, 1, 2, 3, 4].map((item) => (
          <div key={item} className="book-loading-passage">
            <Skeleton className="book-loading-anchor" />
            <div className="book-loading-lines">
              <Skeleton className="book-loading-line is-wide" />
              <Skeleton className="book-loading-line" />
              <Skeleton className="book-loading-line is-short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BookMetaLoadingState() {
  return (
    <div className="book-reader-pane book-reader-pane-loading" aria-hidden="true">
      <header className="book-reader-header book-reader-header-loading">
        <div className="book-loading-copy">
          <Skeleton className="book-loading-meta" />
          <Skeleton className="book-loading-title" />
          <Skeleton className="book-loading-authors" />
        </div>
      </header>

      <BookLoadingState />
    </div>
  );
}

function BookAssistantPaneSkeleton() {
  return (
    <div className="book-loading-thread" aria-hidden="true">
      <div className="book-loading-thread-messages">
        {[0, 1].map((item) => (
          <div key={item} className="book-loading-bubble">
            <Skeleton className="book-loading-bubble-title" />
            <Skeleton className="book-loading-bubble-line is-wide" />
            <Skeleton className="book-loading-bubble-line" />
          </div>
        ))}
      </div>
      <div className="book-loading-composer">
        <Skeleton className="book-loading-composer-line is-wide" />
        <div className="book-loading-composer-footer">
          <Skeleton className="book-loading-composer-plus" />
          <Skeleton className="book-loading-composer-send" />
        </div>
      </div>
    </div>
  );
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

function AssistantSurface({
  messages,
  isSending,
  streamingAssistantId,
  onPrompt,
  onCancel,
  suggestions = ASSISTANT_WELCOME_SUGGESTIONS,
}: {
  messages: UiMessage[];
  isSending: boolean;
  streamingAssistantId: string | null;
  onPrompt: (prompt: string) => Promise<void>;
  onCancel: () => Promise<void>;
  suggestions?: ThreadSuggestion[];
}) {
  const runtime = useExternalStoreRuntime({
    isRunning: isSending,
    messages: messages.filter((message) => message.role === "user" || message.role === "assistant"),
    convertMessage: (message: UiMessage) => messageToThreadMessage(message, streamingAssistantId, isSending),
    onNew: async (message: { content?: unknown }) => {
      const prompt = extractPromptText(message);
      if (!prompt) {
        return;
      }
      await onPrompt(prompt);
    },
    onCancel,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        isRunning={isSending}
        suggestions={suggestions}
        onSuggestionSelect={(prompt) => {
          void onPrompt(prompt);
        }}
        onCancel={() => {
          void onCancel();
        }}
      />
    </AssistantRuntimeProvider>
  );
}

function BookAssistantToolbar({
  sessions,
  selectedSessionId,
  onSelectSession,
  onStartNewChat,
}: {
  sessions: ChatSessionSummary[];
  selectedSessionId: string | null | undefined;
  onSelectSession: (sessionId: string | null) => void;
  onStartNewChat: () => void;
}) {
  return (
    <div className="book-assistant-toolbar">
      <label className="book-assistant-session-picker">
        <span className="sr-only">Assistant session</span>
        <select
          value={selectedSessionId ?? ""}
          onChange={(event) => onSelectSession(event.currentTarget.value || null)}
          aria-label="Assistant session"
        >
          <option value="">New chat</option>
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {(session.title ?? "Untitled chat").slice(0, 72)}
            </option>
          ))}
        </select>
      </label>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="book-assistant-new-chat"
        onClick={onStartNewChat}
        aria-label="Start a new chat"
      >
        <MessageSquarePlus />
      </Button>
    </div>
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
        <strong className="profile-history-row-title">{session.title ?? "Untitled chat"}</strong>
        <span className="profile-history-row-time">{formatRelativeTime(session.lastMessageAt)}</span>
      </div>
      <p className="profile-history-row-preview">{session.lastMessagePreview ?? "No messages yet."}</p>
    </button>
  );
}

export default function App() {
  const initialUrlState = readUrlState();
  const [guestUserId] = useState(() => ensureLocalUserId());
  const [authState, setAuthState] = useState<AuthState>({
    loading: true,
    authConfigured: false,
    user: null,
    error: null,
  });
  const [activeView, setActiveView] = useState<ViewMode>(initialUrlState.view);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null | undefined>(initialUrlState.sessionId);
  const [selectedAdminRunId, setSelectedAdminRunId] = useState<string | null | undefined>(initialUrlState.runId);
  const [adminSection, setAdminSection] = useState<"runs" | "users" | "analytics" | "incidents" | "logs">(initialUrlState.adminSection);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsResolved, setSessionsResolved] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [recoveredActiveRunId, setRecoveredActiveRunId] = useState<string | null>(null);
  const [sessionRuns, setSessionRuns] = useState<SessionRunRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(initialUrlState.debugEnabled);
  const [AgentationComponent, setAgentationComponent] = useState<ComponentType<AgentationProps> | null>(null);
  const [exploreDraft, setExploreDraft] = useState("");
  const [feedWorks, setFeedWorks] = useState<WorkSummary[]>([]);
  const [feedNextOffset, setFeedNextOffset] = useState<number | null>(0);
  const [feedTotalCount, setFeedTotalCount] = useState<number | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [selectedWorkIds, setSelectedWorkIds] = useState<string[]>([]);
  const [activeWorkId, setActiveWorkId] = useState<string | null | undefined>(initialUrlState.workId);
  const [activeProfileUserId, setActiveProfileUserId] = useState<string | null | undefined>(initialUrlState.profileUserId);
  const [activeWork, setActiveWork] = useState<WorkDetail | null>(null);
  const [activeWorkSource, setActiveWorkSource] = useState<WorkSource | null>(null);
  const [activeWorkLoading, setActiveWorkLoading] = useState(false);
  const [activeWorkSourceLoading, setActiveWorkSourceLoading] = useState(false);
  const [pendingCitation, setPendingCitation] = useState<Citation | null>(null);
  const [activePassageId, setActivePassageId] = useState<string | null>(null);
  const [highlightedPassageExcerpt, setHighlightedPassageExcerpt] = useState<string | null>(null);
  const [bookAssistantWidth, setBookAssistantWidth] = useState(() => {
    if (typeof window === "undefined") {
      return 420;
    }
    const saved = Number.parseInt(window.localStorage.getItem(BOOK_ASSISTANT_WIDTH_STORAGE_KEY) ?? "", 10);
    return Number.isFinite(saved) ? Math.min(BOOK_ASSISTANT_MAX_WIDTH, Math.max(BOOK_ASSISTANT_MIN_WIDTH, saved)) : 420;
  });
  const [isDraggingBookAssistant, setIsDraggingBookAssistant] = useState(false);
  const [publicProfile, setPublicProfile] = useState<PublicProfileResponse | null>(null);
  const [publicProfileLoading, setPublicProfileLoading] = useState(false);
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
  const bookPageRef = useRef<HTMLElement | null>(null);
  const bookAssistantResizeStartRef = useRef<{ pointerX: number; width: number } | null>(null);
  const bookAssistantRafRef = useRef<number | null>(null);

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
  const selectedWorks = useMemo(
    () => feedWorks.filter((work) => selectedWorkIds.includes(work.id)),
    [feedWorks, selectedWorkIds],
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
      ? activeSession?.title ?? "Assistant"
      : activeView === "book"
        ? activeWork?.title ?? "Book"
        : activeView === "admin"
          ? "Admin"
        : NAV_ITEMS.find((item) => item.id === activeView)?.label ?? "AlphaBook";
  const authLocked = authState.authConfigured && !authState.user;
  const hasAuthenticatedUser = Boolean(authState.user);
  const authPending = authState.loading;
  const navigationItems = adminAccess.allowed
    ? [...NAV_ITEMS, { id: "admin" as const, label: "Admin", icon: ProfileIcon }]
    : NAV_ITEMS;

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
          error: error instanceof Error ? error.message : "Failed to resolve the current user.",
        });
      }
    })();
  }, []);

  useEffect(() => {
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
    const handlePopState = () => {
      const next = readUrlState();
      setActiveView(next.view);
      setSelectedSessionId(next.sessionId);
      setActiveWorkId(next.workId);
      setActiveProfileUserId(next.profileUserId);
      setSelectedAdminRunId(next.runId);
      setAdminSection(next.adminSection);
      setAdminRunInput(next.runId ?? "");
      setDebugEnabled(next.debugEnabled);
      setMobileNavOpen(false);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    writeUrlState({
      view: activeView,
      sessionId: selectedSessionId,
      workId: activeWorkId,
      profileUserId: activeProfileUserId,
      runId: selectedAdminRunId,
      adminSection,
      debugEnabled,
    });
  }, [activeView, selectedSessionId, activeWorkId, activeProfileUserId, selectedAdminRunId, adminSection, debugEnabled]);

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
    if (feedLoading || feedNextOffset === null || feedWorks.length > 0) {
      return;
    }

    void (async () => {
      try {
        setFeedLoading(true);
        const next = await fetchWorks({ offset: 0, limit: 12 });
        setFeedWorks(next.works);
        setFeedNextOffset(next.nextOffset);
        setFeedTotalCount(next.totalCount);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Failed to load the corpus feed.");
      } finally {
        setFeedLoading(false);
      }
    })();
  }, [feedLoading, feedNextOffset, feedWorks.length]);

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
        setActivePassageId(null);
        setHighlightedPassageExcerpt(null);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Failed to load the selected book.");
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
  }, [activeWorkId]);

  useEffect(() => {
    if (!activeWorkId) {
      setActiveWorkSourceLoading(false);
      setActiveWorkSource(null);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      setActiveWorkSourceLoading(false);
      setLoadError("Loading this book's text is taking too long. Try refreshing or opening it again.");
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
          setLoadError(error instanceof Error ? error.message : "Failed to load the selected book text.");
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
  }, [activeWorkId]);

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
          setLoadError(error instanceof Error ? error.message : "Failed to load profile.");
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
    if (!pendingCitation || !activeWork || activeWork.id !== pendingCitation.workId || readerPassages.length === 0) {
      return;
    }

    const match = findPassageForCitation(readerPassages, pendingCitation);
    if (match) {
      setActivePassageId(match.passageId);
      setHighlightedPassageExcerpt(match.highlight);
      const url = new URL(window.location.href);
      url.hash = match.passageId;
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setPendingCitation(null);
  }, [activeWork, pendingCitation, readerPassages]);

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
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(BOOK_ASSISTANT_WIDTH_STORAGE_KEY, String(bookAssistantWidth));
  }, [bookAssistantWidth]);

  useEffect(() => {
    if (!isDraggingBookAssistant) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const start = bookAssistantResizeStartRef.current;
      const rect = bookPageRef.current?.getBoundingClientRect();
      if (!start || !rect) {
        return;
      }
      const delta = start.pointerX - event.clientX;
      const maxWidth = Math.min(BOOK_ASSISTANT_MAX_WIDTH, Math.max(BOOK_ASSISTANT_MIN_WIDTH, rect.width - 360));
      const nextWidth = Math.min(maxWidth, Math.max(BOOK_ASSISTANT_MIN_WIDTH, start.width + delta));
      if (bookAssistantRafRef.current !== null) {
        cancelAnimationFrame(bookAssistantRafRef.current);
      }
      bookAssistantRafRef.current = window.requestAnimationFrame(() => {
        setBookAssistantWidth(nextWidth);
      });
    };
    const stopDragging = () => {
      setIsDraggingBookAssistant(false);
      bookAssistantResizeStartRef.current = null;
      if (bookAssistantRafRef.current !== null) {
        cancelAnimationFrame(bookAssistantRafRef.current);
        bookAssistantRafRef.current = null;
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
    };
  }, [isDraggingBookAssistant]);

  useEffect(() => {
    if (authState.loading) {
      return;
    }
    if (!currentUserId) {
      setSessionsResolved(true);
      setSessionsLoading(false);
      setSessions([]);
      setSelectedSessionId(null);
      setMessages([]);
      return;
    }

    void (async () => {
      try {
        setSessionsLoading(true);
        const nextSessions = await fetchSessions(authState.authConfigured ? undefined : currentUserId);
        setSessions(nextSessions);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Failed to load sessions.");
      } finally {
        setSessionsLoading(false);
        setSessionsResolved(true);
      }
    })();
  }, [authState.authConfigured, currentUserId, selectedSessionId]);

  useEffect(() => {
    if (authState.loading) {
      return;
    }
    if (!selectedSessionId) {
      setMessagesLoading(false);
      setMessages([]);
      return;
    }

    void (async () => {
      try {
        setMessagesLoading(true);
        const nextMessages = await fetchMessages(selectedSessionId);
        setMessages(nextMessages.map(hydrateStoredMessage));
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Failed to load messages.");
      } finally {
        setMessagesLoading(false);
      }
    })();
  }, [authState.loading, selectedSessionId]);

  useEffect(() => {
    if (authState.loading || isSending || !selectedSessionId || !recoveredActiveRunId) {
      return;
    }

    let cancelled = false;
    let pollTimer: number | null = null;
    let streamFailed = false;
    const abortController = new AbortController();
    reconnectRunStreamAbortControllerRef.current?.abort();
    reconnectRunStreamAbortControllerRef.current = abortController;

    const pollMessages = async () => {
      try {
        const nextMessages = await fetchMessages(selectedSessionId);
        if (cancelled) {
          return;
        }
        setMessages(nextMessages.map(hydrateStoredMessage));
        pollTimer = window.setTimeout(() => {
          void pollMessages();
        }, 2000);
      } catch {
        if (!cancelled) {
          pollTimer = window.setTimeout(() => {
            void pollMessages();
          }, 4000);
        }
      }
    };

    const refreshMessages = async () => {
      const nextMessages = await fetchMessages(selectedSessionId);
      if (cancelled) {
        return;
      }
      setMessages(nextMessages.map(hydrateStoredMessage));
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
            event.event === "assistant.plan"
            || event.event === "tool.started"
            || event.event === "tool.progress"
            || event.event === "tool.completed"
            || event.event === "assistant.completed"
            || event.event === "run.completed"
          ) {
            void refreshMessages();
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
      void pollMessages();
    });

    window.setTimeout(() => {
      if (!cancelled && !streamFailed) {
        void pollMessages();
      }
    }, 2500);

    return () => {
      cancelled = true;
      abortController.abort();
      if (reconnectRunStreamAbortControllerRef.current === abortController) {
        reconnectRunStreamAbortControllerRef.current = null;
      }
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
      }
    };
  }, [authState.loading, isSending, recoveredActiveRunId, selectedSessionId]);

  useEffect(() => {
    if (authState.loading) {
      return;
    }
    if (!selectedSessionId) {
      setRecoveredActiveRunId(null);
      setSessionRuns([]);
      return;
    }

    let cancelled = false;
    let pollTimer: number | null = null;

    const loadRuns = async () => {
      try {
        const runs = await fetchRuns(selectedSessionId);
        if (cancelled) {
          return;
        }
        setSessionRuns(runs);
        const activeRun = runs.find((run) => run.status === "running" || run.status === "queued") ?? null;
        const nextRunId = activeRun?.id ?? null;
        setRecoveredActiveRunId(nextRunId);
        if (!isSending) {
          activeRunIdRef.current = nextRunId;
        }
        if (nextRunId) {
          pollTimer = window.setTimeout(() => {
            void loadRuns();
          }, 4000);
        }
      } catch {
        if (!cancelled) {
          setSessionRuns([]);
          setRecoveredActiveRunId(null);
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
  }, [authState.loading, isSending, selectedSessionId]);

  const visibleMessages = useMemo(
    () => reconcileMessagesWithRunState(messages, sessionRuns),
    [messages, sessionRuns],
  );

  async function refreshSessions(preferredSessionId?: string | null) {
    if (!currentUserId) {
      return;
    }
    const nextSessions = await fetchSessions(authState.authConfigured ? undefined : currentUserId);
    setSessions(nextSessions);
    if (preferredSessionId !== undefined) {
      setSelectedSessionId(preferredSessionId);
    }
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
        error: error instanceof Error ? error.message : "Failed to load run logs.",
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
        error: error instanceof Error ? error.message : "Failed to load users.",
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
        error: error instanceof Error ? error.message : "Failed to load runs.",
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
        error: error instanceof Error ? error.message : "Failed to load sessions.",
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
        error: error instanceof Error ? error.message : "Failed to load analytics.",
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
        error: error instanceof Error ? error.message : "Failed to load incidents.",
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
    options: { sessionIdOverride?: string | null; workIdsOverride?: string[]; viewOverride?: ViewMode; transportMessageOverride?: string } = {},
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
      metadata: {},
      createdAt: new Date().toISOString(),
      citations: [],
      toolCalls: [],
    };
    setActiveView(options.viewOverride ?? "assistant");
    setIsSending(true);
    setLoadError(null);
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
    let activityLog: ToolTraceEntry[] = [];
    let planMessageId: string | null = null;
    let finalAssistantMessageId: string | null = null;
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
    const settleRunUi = () => {
      if (runSettled || activeRunTokenRef.current !== runToken) {
        return;
      }
      clearStreamIdleTimer();
      runSettled = true;
      setIsSending(false);
      setStreamingAssistantId(null);
    };
    const updatePlanMessage = (updater: (message: UiMessage) => UiMessage) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === planMessageId
            ? updater(message)
            : message,
        ),
      );
    };

    try {
      await streamChat(
        {
          sessionId: initialSessionId ?? undefined,
          userId: authState.authConfigured ? undefined : currentUserId,
          message: transportQuestion,
          workIds: options.workIdsOverride,
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
              setSelectedSessionId(createdSessionId);
              setSessions((current) => [
                {
                  id: createdSessionId,
                  userId: currentUserId,
                  title: typeof event.data.title === "string" ? event.data.title : normalizedQuestion.slice(0, 64),
                  createdAt: new Date().toISOString(),
                  lastMessageAt: new Date().toISOString(),
                  lastMessagePreview: normalizedQuestion,
                },
                ...current.filter((session) => session.id !== createdSessionId),
              ]);
              setMessages((current) =>
                current.map((message) =>
                  message.id === userMessage.id || message.id === planMessageId || message.id === finalAssistantMessageId
                    ? { ...message, sessionId: createdSessionId }
                    : message,
                ),
              );
              return;
            }

            if (event.event === "run.started" && typeof event.data.runId === "string") {
              activeRunIdRef.current = event.data.runId;
              return;
            }

            if (event.event === "assistant.plan" && typeof event.data.text === "string") {
              const messageId = typeof event.data.messageId === "string" ? event.data.messageId : crypto.randomUUID();
              planMessageId = messageId;
              setMessages((current) => {
                const existingIndex = current.findIndex((message) => message.id === messageId);
                const nextMessage: UiMessage = {
                  id: messageId,
                  sessionId: workingSessionId ?? "pending",
                  role: "assistant",
                  content: event.data.text as string,
                  metadata: {
                    phase: "plan",
                  },
                  createdAt: new Date().toISOString(),
                  citations: [],
                  toolCalls: activityLog,
                };
                if (existingIndex >= 0) {
                  const copy = [...current];
                  copy[existingIndex] = {
                    ...copy[existingIndex],
                    content: nextMessage.content,
                    metadata: {
                      ...copy[existingIndex].metadata,
                      phase: "plan",
                    },
                    toolCalls: activityLog,
                  };
                  return copy;
                }
                return [...current, nextMessage];
              });
              return;
            }

            if (event.event === "tool.started" && typeof event.data.toolName === "string") {
              const toolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : crypto.randomUUID();
              const toolName = event.data.toolName;
              const label = typeof event.data.label === "string" ? event.data.label : getToolLabel(toolName);
              activityLog = [
                ...activityLog,
                {
                  id: toolCallId,
                  toolName,
                  label,
                  rationale: typeof event.data.rationale === "string" ? event.data.rationale : undefined,
                  progress: [],
                  args: event.data.args && typeof event.data.args === "object" ? (event.data.args as Record<string, unknown>) : {},
                  state: "running",
                },
              ];
              updatePlanMessage((message) => ({
                ...message,
                toolCalls: activityLog,
              }));
              return;
            }

            if (event.event === "tool.completed" && typeof event.data.toolName === "string") {
              const toolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : null;
              const toolName = event.data.toolName;
              const label = typeof event.data.label === "string" ? event.data.label : getToolLabel(toolName);
              activityLog = activityLog.map((entry) =>
                (toolCallId ? entry.id === toolCallId : entry.toolName === toolName && entry.state === "running")
                  ? {
                      ...entry,
                      label,
                      rationale:
                        entry.progress.length > 0
                          ? entry.progress[entry.progress.length - 1]
                          : typeof event.data.rationale === "string"
                            ? event.data.rationale
                            : entry.rationale,
                      progress:
                        typeof event.data.rationale === "string"
                        && event.data.rationale.trim().length > 0
                        && entry.progress.length === 0
                        && !entry.progress.includes(event.data.rationale)
                          ? [...entry.progress, event.data.rationale]
                          : entry.progress,
                      result: event.data.result && typeof event.data.result === "object" ? (event.data.result as Record<string, unknown>) : undefined,
                      isError: event.data.status === "failed",
                      state: event.data.status === "failed" ? "error" : "completed",
                    }
                  : entry,
              );
              const completedEntry = activityLog.find((entry) => entry.id === toolCallId)
                ?? activityLog.find((entry) => entry.toolName === toolName);
              updatePlanMessage((message) => ({
                ...message,
                toolCalls: activityLog,
              }));
              return;
            }

            if (event.event === "tool.progress" && typeof event.data.toolName === "string" && typeof event.data.text === "string") {
              const toolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : null;
              const toolName = event.data.toolName;
              const rationale = event.data.text;
              activityLog = activityLog.map((entry): ToolTraceEntry =>
                (toolCallId ? entry.id === toolCallId : entry.toolName === toolName && entry.state === "running")
                  ? {
                      ...entry,
                      rationale,
                      progress: entry.progress.includes(rationale) ? entry.progress : [...entry.progress, rationale],
                    }
                  : entry,
              );
              updatePlanMessage((message) => ({
                ...message,
                toolCalls: activityLog,
              }));
              return;
            }

            if (event.event === "assistant.delta" && typeof event.data.text === "string") {
              if (!finalAssistantMessageId) {
                finalAssistantMessageId = crypto.randomUUID();
                setStreamingAssistantId(finalAssistantMessageId);
                setMessages((current) => [
                  ...current,
                  {
                    id: finalAssistantMessageId!,
                    sessionId: workingSessionId ?? "pending",
                    role: "assistant",
                    content: "",
                    metadata: {},
                    createdAt: new Date().toISOString(),
                    citations: [],
                    toolCalls: [],
                  },
                ]);
              }
              setMessages((current) =>
                current.map((message) =>
                  message.id === finalAssistantMessageId
                    ? {
                        ...message,
                        content: `${message.content}${event.data.text as string}`,
                      }
                    : message,
                ),
              );
              scheduleStreamIdleSettle();
              return;
            }

            if (event.event === "assistant.completed") {
              if (!finalAssistantMessageId) {
                finalAssistantMessageId = crypto.randomUUID();
                setMessages((current) => [
                  ...current,
                  {
                    id: finalAssistantMessageId!,
                    sessionId: workingSessionId ?? "pending",
                    role: "assistant",
                    content: typeof event.data.answer === "string" ? event.data.answer : "",
                    metadata: {},
                    createdAt: new Date().toISOString(),
                    citations: Array.isArray(event.data.citations) ? (event.data.citations as Citation[]) : [],
                    toolCalls: [],
                  },
                ]);
              }
              setMessages((current) =>
                current.map((message) =>
                  message.id === finalAssistantMessageId
                    ? {
                        ...message,
                        citations: Array.isArray(event.data.citations) ? (event.data.citations as Citation[]) : [],
                        toolCalls: [],
                      }
                    : message,
                ),
              );
              settleRunUi();
              return;
            }

            if (event.event === "run.completed") {
              settleRunUi();
              return;
            }

            if (event.event === "error") {
              setLoadError(typeof event.data.message === "string" ? event.data.message : "The assistant run failed.");
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
        setLoadError(error instanceof Error ? error.message : "Failed to stream the assistant run.");
      }
    } finally {
      clearStreamIdleTimer();
      if (activeChatAbortControllerRef.current === abortController) {
        activeChatAbortControllerRef.current = null;
      }
      if (activeRunTokenRef.current === runToken) {
        activeRunIdRef.current = null;
        settleRunUi();
        await refreshSessions(workingSessionId ?? null);
      }
    }
  }

  async function handleSignOut() {
    const redirectTo = await signOut(window.location.href);
    window.location.assign(redirectTo);
  }

  async function loadMoreWorks() {
    if (feedLoading || feedNextOffset === null) {
      return;
    }

    try {
      setFeedLoading(true);
      const next = await fetchWorks({ offset: feedNextOffset, limit: 12 });
      setFeedWorks((current) => {
        const seen = new Set(current.map((work) => work.id));
        return [...current, ...next.works.filter((work) => !seen.has(work.id))];
      });
      setFeedNextOffset(next.nextOffset);
      setFeedTotalCount(next.totalCount);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load more works.");
    } finally {
      setFeedLoading(false);
    }
  }

  function startNewChat() {
    activeRunTokenRef.current += 1;
    setMobileNavOpen(false);
    setSelectedSessionId(null);
    setMessages([]);
    setLoadError(null);
    setIsSending(false);
    setStreamingAssistantId(null);
    setActiveView("assistant");
  }

  function startNewBookChat() {
    activeRunTokenRef.current += 1;
    setSelectedSessionId(null);
    setMessages([]);
    setLoadError(null);
    setIsSending(false);
    setStreamingAssistantId(null);
    setHighlightedPassageExcerpt(null);
    setActiveView("book");
  }

  function toggleSelectedWork(workId: string) {
    setSelectedWorkIds((current) => {
      if (current.includes(workId)) {
        return current.filter((id) => id !== workId);
      }
      track("book_selected_for_ask", {
        workId,
        source: "explore",
      });
      return [...current, workId];
    });
  }

  function submitExplorePrompt(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const finalPrompt = buildExplorePrompt(exploreDraft, selectedWorks);
    if (!finalPrompt) {
      return;
    }
    setExploreDraft("");
    setSelectedWorkIds([]);
    queuePrompt(finalPrompt);
  }

  function handleExploreScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 360) {
      void loadMoreWorks();
    }
  }

  function handleNavSelection(view: ViewMode) {
    setMobileNavOpen(false);
    if (view !== "book") {
      setActiveWorkId(null);
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

  function openSession(sessionId: string) {
    setMobileNavOpen(false);
    setSelectedSessionId(sessionId);
    setActiveWorkId(null);
    setActiveProfileUserId(null);
    setPendingCitation(null);
    setActiveView("assistant");
  }

  function queuePrompt(prompt: string) {
    startNewChat();
    void sendPrompt(prompt, { sessionIdOverride: null });
  }

  function openWork(workId: string) {
    track("book_open", {
      workId,
      source: activeView,
    });
    setMobileNavOpen(false);
    setPendingCitation(null);
    setActiveProfileUserId(null);
    setActiveWorkId(workId);
    startNewBookChat();
  }

  function openCitation(citation: Citation) {
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
    setActiveProfileUserId(null);
    setActiveWorkId(citation.workId);
    setActiveView("book");
  }

  function openProfile(userId?: string | null) {
    setMobileNavOpen(false);
    setActiveWorkId(null);
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
      setLoadError(error instanceof Error ? error.message : "Failed to update follow state.");
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
    setActivePassageId(passageId);
    setHighlightedPassageExcerpt(highlight);
    const url = new URL(window.location.href);
    url.hash = passageId;
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    if (replaceHistory) {
      window.history.replaceState({}, "", nextUrl);
    } else {
      window.history.pushState({}, "", nextUrl);
    }
  }

  function startBookAssistantResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 980) {
      return;
    }
    event.preventDefault();
    bookAssistantResizeStartRef.current = {
      pointerX: event.clientX,
      width: bookAssistantWidth,
    };
    setIsDraggingBookAssistant(true);
  }

  function openBookSession(sessionId: string | null) {
    setSelectedSessionId(sessionId);
    setLoadError(null);
    setIsSending(false);
    setStreamingAssistantId(null);
    setActiveView("book");
  }

  function renderAssistantView() {
    const assistantHistoryLoading =
      !authPending
      && !authLocked
      && (
        (hasAuthenticatedUser && !sessionsResolved)
        || sessionsLoading
        || (selectedSessionId != null && messagesLoading)
      );
    const showWelcome =
      !assistantHistoryLoading
      && !authState.loading
      && !authLocked
      && selectedSessionId == null
      && messages.length === 0
      && !isSending;

    return (
      <section className="assistant-page">
        {loadError ? <div className="thread-error-banner">{loadError}</div> : null}

        <div className="assistant-thread-shell" data-testid="thread">
          {authPending ? (
            <AssistantLoadingState />
          ) : assistantHistoryLoading ? (
            <AssistantLoadingState />
          ) : authLocked ? (
            <LockedState
              compact
              title="Sign in to use the assistant."
            />
          ) : (
              <AssistantSurface
                key={selectedSessionId ?? "new-thread"}
                messages={visibleMessages}
                isSending={isSending || recoveredActiveRunId !== null}
                streamingAssistantId={streamingAssistantId}
                onPrompt={sendPrompt}
                onCancel={cancelActiveRun}
              />
            )}
          </div>
        </section>
    );
  }

  function renderBookView() {
    const bookPromptHandler = async (prompt: string) => {
      if (!activeWorkId) {
        return;
      }
      const activePassage = activePassageId
        ? readerPassages.find((passage) => passage.id === activePassageId) ?? null
        : null;
      await sendPrompt(prompt, {
        sessionIdOverride: selectedSessionId ?? null,
        workIdsOverride: [activeWorkId],
        viewOverride: "book",
        transportMessageOverride: buildBookAssistantPrompt(prompt, activeWork, activePassage),
      });
    };

    return (
      <section
        ref={bookPageRef}
        className={cn("book-page", isDraggingBookAssistant && "is-resizing")}
        style={{ ["--book-assistant-width" as string]: `${bookAssistantWidth}px` }}
      >
        {activeWorkLoading ? (
          <BookMetaLoadingState />
        ) : (
          <div className="book-reader-pane">
            {activeWork ? (
              <>
                <header className="book-reader-header">
                  <div>
                    <p className="book-reader-meta">
                      {[activeWork.gutenbergId ? `Gutenberg ${activeWork.gutenbergId}` : null, activeWork.language?.toUpperCase()].filter(Boolean).join(" · ")}
                    </p>
                    <h1>{activeWork.title}</h1>
                    {activeWork.authors.length > 0 ? <p className="book-reader-authors">{activeWork.authors.join(" · ")}</p> : null}
                  </div>
                </header>

                <div className="book-reader-surface">
                    {readerPassages.length > 0 ? (
                      <div className="book-reader-passages">
                        {readerPassages.map((passage) => (
                          <ReaderPassageBlock
                            key={passage.id}
                          passage={passage}
                          isActive={passage.id === activePassageId}
                          highlight={passage.id === activePassageId ? highlightedPassageExcerpt : null}
                          onActivate={(passageId) => activatePassage(passageId, null)}
                        />
                        ))}
                      </div>
                    ) : activeWorkSourceLoading ? (
                      <BookLoadingState />
                    ) : (
                      <div className="book-loading">This book does not have stored source content yet.</div>
                    )}
                  </div>
              </>
            ) : (
              <div className="book-loading">Book not found.</div>
            )}
          </div>
        )}

        <div
          className="book-assistant-divider"
          onPointerDown={startBookAssistantResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize assistant panel"
        />

        <aside className="book-assistant-pane">
          {loadError ? <div className="thread-error-banner">{loadError}</div> : null}
          <div className="book-assistant-shell" data-testid="book-thread">
            <BookAssistantToolbar
              sessions={sessions}
              selectedSessionId={selectedSessionId}
              onSelectSession={openBookSession}
              onStartNewChat={startNewBookChat}
            />
            {authPending ? (
              <BookAssistantPaneSkeleton />
            ) : authLocked ? (
              <LockedState
                compact
                title="Sign in to ask about this book."
              />
            ) : (
              <AssistantSurface
                key={`book-${activeWorkId ?? "unknown"}-${selectedSessionId ?? "new-thread"}`}
                messages={visibleMessages}
                isSending={isSending || recoveredActiveRunId !== null}
                streamingAssistantId={streamingAssistantId}
                onPrompt={bookPromptHandler}
                onCancel={cancelActiveRun}
                suggestions={ASSISTANT_WELCOME_SUGGESTIONS}
              />
            )}
          </div>
        </aside>
      </section>
    );
  }

  function renderExploreView() {
    const formattedCorpusCount = formatCompactCount(feedTotalCount);
    return (
      <div className="view-shell explore-view" onScroll={handleExploreScroll}>
        <section className="explore-hero">
          <h1>
            {formattedCorpusCount
              ? `Ask or search anything over ${formattedCorpusCount} books.`
              : "Ask or search anything over the corpus."}
          </h1>

          <form className="explore-composer-shell" onSubmit={submitExplorePrompt}>
            <Card className="explore-composer-root">
              <CardContent className="p-0">
              {selectedWorks.length > 0 ? (
                <div className="explore-selection-row mb-3 flex flex-wrap gap-2">
                  {selectedWorks.map((work) => (
                    <Button
                      key={work.id}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="explore-selection-chip"
                      onClick={() => toggleSelectedWork(work.id)}
                    >
                      {work.title}
                    </Button>
                  ))}
                </div>
              ) : null}

              <div className="explore-composer-surface">
                <Textarea
                  className="explore-composer-input"
                  placeholder="Ask about a book, a theme, or the whole corpus..."
                  value={exploreDraft}
                  onChange={(event) => setExploreDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submitExplorePrompt();
                    }
                  }}
                />

                <div className="explore-composer-footer">
                  <span className="explore-composer-spacer" aria-hidden="true">+</span>
                  <Button
                    type="submit"
                    variant="default"
                    size="icon"
                    className="explore-send"
                    disabled={!exploreDraft.trim() && selectedWorks.length === 0}
                    aria-label="Send prompt"
                  >
                    <ArrowUpIcon />
                  </Button>
                </div>
              </div>
              </CardContent>
            </Card>
          </form>
        </section>

        <section className="work-feed" aria-label="Corpus feed">
          {feedWorks.map((work) => {
            const selected = selectedWorkIds.includes(work.id);
            const previewMeta = [formatReleaseYear(work.releaseDate), work.publisher].filter(Boolean).join(" · ");
            const secondaryTags = work.bookshelves?.length
              ? work.bookshelves.slice(0, 2)
              : work.subjects.slice(0, 3);
            return (
              <article key={work.id} className={`work-feed-card ${selected ? "is-selected" : ""}`}>
                <button
                  type="button"
                  className="work-feed-open"
                  onClick={() => openWork(work.id)}
                >
                  <div className="work-feed-heading">
                    {work.coverImageUrl ? (
                      <div className="work-feed-cover">
                        <img src={work.coverImageUrl} alt="" loading="lazy" />
                      </div>
                    ) : null}
                    <div className="work-feed-copy">
                      {previewMeta ? <p className="work-feed-meta">{previewMeta}</p> : null}
                      <h2>{work.title}</h2>
                      {work.subtitle ? <p className="work-feed-subtitle">{work.subtitle}</p> : null}
                      {work.authors.length > 0 ? <p className="work-feed-authors">{work.authors.join(" · ")}</p> : null}
                    </div>
                  </div>

                  {work.summary ? <p className="work-feed-summary">{work.summary}</p> : null}

                  {secondaryTags.length > 0 ? (
                    <div className="work-feed-tags">
                      {secondaryTags.map((subject) => (
                        <span key={subject} className="tag-chip">
                          {subject}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </button>
              </article>
            );
          })}

          {feedLoading ? <p className="feed-status">Loading more works…</p> : null}
          {!feedLoading && feedWorks.length === 0 ? <p className="feed-status">No works yet.</p> : null}
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
                  <Button asChild className="signin-pill-button" size="lg">
                    <a href={buildSignInUrl(window.location.href)}>Sign in</a>
                  </Button>
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

          <section className="profile-history">
            <div className="profile-history-list">
              <ProfileEmptyState
                title="No public reading history yet"
                copy="This reader has not shared any visible activity here."
              />
            </div>
          </section>
        </div>
      );
    }

    const joinedLabel = formatMonthYear(currentUser?.createdAt);
    const currentMeta = [profileTag, joinedLabel ? `joined ${joinedLabel}` : null].filter(Boolean).join(" • ");

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
              <Button type="button" variant="ghost" className="profile-chip" onClick={() => void handleSignOut()}>
                Log out
              </Button>
            ) : null}
          </div>
        </section>

        <section className="profile-history">
          <div className="profile-history-list">
            {sessions.length === 0 ? (
              <ProfileEmptyState
                title="No searches yet"
                copy="Start a conversation with the assistant and your recent research will show up here."
                action={(
                  <Button type="button" className="signin-pill-button" onClick={() => handleNavSelection("assistant")}>
                    Start searching
                  </Button>
                )}
              />
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
                onClick={() => setAdminSection(item.key)}
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

                {adminIncidents.error ? (
                  <div className="rounded-[16px] border border-[rgba(187,73,44,0.2)] bg-[rgba(187,73,44,0.08)] px-4 py-3 text-sm leading-6 text-[var(--ink)]">
                    {adminIncidents.error}
                  </div>
                ) : null}

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
                onClick={() => setAdminSection("runs")}
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

                {adminRunLog.error ? (
                  <div className="rounded-[16px] border border-[rgba(187,73,44,0.2)] bg-[rgba(187,73,44,0.08)] px-4 py-3 text-sm leading-6 text-[var(--ink)]">
                    {adminRunLog.error}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </section>

          {adminRunLog.payload ? (
            <section className="space-y-4">
              <AdminJsonBlock title="Run" value={adminRunLog.payload.run ?? {}} />
              <AdminJsonBlock title="Session" value={adminRunLog.payload.session ?? {}} />
              <AdminJsonBlock title="Owner" value={adminRunLog.payload.owner ?? {}} />
              <AdminJsonBlock title="Messages" value={adminRunLog.payload.messages ?? []} />
              <AdminJsonBlock title="Tool Calls" value={adminRunLog.payload.toolCalls ?? []} />
              <AdminJsonBlock title="Runtime Instances" value={adminRunLog.payload.runtimeInstances ?? []} />
              <AdminJsonBlock title="Artifacts" value={adminRunLog.payload.artifacts ?? []} />
              <AdminJsonBlock title="Live Runtime" value={adminRunLog.payload.liveRuntime ?? []} />
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
                <p className="text-sm text-[var(--ink-soft)]">{adminRuns.error}</p>
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
                <p className="text-sm text-[var(--ink-soft)]">{adminUsers.error}</p>
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
                <p className="text-sm text-[var(--ink-soft)]">{adminSessions.error}</p>
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

                {adminAnalytics.error ? (
                  <div className="rounded-[16px] border border-[rgba(187,73,44,0.2)] bg-[rgba(187,73,44,0.08)] px-4 py-3 text-sm leading-6 text-[var(--ink)]">
                    {adminAnalytics.error}
                  </div>
                ) : null}
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

  return (
    <div className={cn("app-shell", mobileNavOpen && "is-nav-open", sidebarCollapsed && "is-sidebar-collapsed")}>
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
              <span className={cn("wordmark", sidebarCollapsed && "sr-only")}>alphabook</span>
              {sidebarCollapsed ? <span className="wordmark">a.</span> : null}
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
          <Separator />
        </div>

        <nav className={cn("sidebar-nav", sidebarCollapsed && "items-center")} aria-label="Primary">
          {navigationItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id || (activeView === "book" && item.id === "explore");
            return (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                className={cn(
                  "sidebar-nav-button w-full justify-start rounded-none px-0 py-3 text-[1.05rem]",
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

        {authPending ? (
          <SidebarProfileSkeleton collapsed={sidebarCollapsed} />
        ) : hasAuthenticatedUser || !authState.authConfigured ? (
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
            <span className="mobile-shell-wordmark">alphabook</span>
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
        {renderMainView()}
      </main>

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
