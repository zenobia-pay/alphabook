import { createContext, type ComponentType, type CSSProperties, type FormEvent, type ReactNode, type UIEvent, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { ReadonlyJSONObject, ReadonlyJSONValue } from "assistant-stream/utils";
import type { AgentationProps } from "agentation";
import { ChevronsLeft, ChevronsRight } from "lucide-react";

import { getToolLabel, type ChatSessionSummary, type Citation, type MessageRecord, type PublicProfileResponse, type UserProfile, type WorkDetail, type WorkSource, type WorkSummary } from "@alphabook/shared";

import { buildSignInUrl, buildSignOutUrl, fetchAdminAccess, fetchAdminRunLogs, fetchAdminRuns, fetchAdminSessions, fetchAdminUsers, fetchCurrentUser, fetchMessages, fetchProfile, fetchSessions, fetchWorkDetail, fetchWorks, followProfile, queryAdminAnalytics, sendAnalyticsEvent, streamChat, unfollowProfile } from "./api";
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

type ViewMode = "explore" | "assistant" | "library" | "profile" | "book" | "admin";
type UrlState = {
  view: ViewMode;
  sessionId: string | null | undefined;
  workId: string | null | undefined;
  profileUserId: string | null | undefined;
  runId: string | null | undefined;
  adminSection: "runs" | "users" | "analytics" | "logs";
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
  query: string;
  payload: Record<string, unknown> | null;
};

const USER_STORAGE_KEY = "alphabook.localUserId";
function isViewMode(value: string | null): value is ViewMode {
  return value === "explore" || value === "assistant" || value === "library" || value === "profile" || value === "book" || value === "admin";
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
  return {
    view: pathnameMatch ? "book" : profilePathMatch ? "profile" : isViewMode(rawView) ? rawView : "assistant",
    sessionId: params.has("session") ? params.get("session") || null : undefined,
    workId: pathnameMatch ? decodeURIComponent(pathnameMatch[1]) : params.has("work") ? params.get("work") || null : undefined,
    profileUserId: profilePathMatch ? decodeURIComponent(profilePathMatch[1]) : params.has("profile") ? params.get("profile") || null : undefined,
    runId: params.has("run") ? params.get("run") || null : undefined,
    adminSection:
      params.get("adminSection") === "users" || params.get("adminSection") === "analytics" || params.get("adminSection") === "logs"
        ? params.get("adminSection") as "users" | "analytics" | "logs"
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
    name: "AlphaBook Reader",
    avatarUrl: null,
    createdAt: new Date().toISOString(),
    followersCount: 0,
    followingCount: 0,
  };
}

function normalizeToolTraceEntry(entry: Record<string, unknown>, index: number): ToolTraceEntry {
  const toolName = typeof entry.toolName === "string" ? entry.toolName : "search_works";
  const state =
    entry.state === "running" || entry.state === "completed" || entry.state === "error"
      ? entry.state
      : entry.isError === true
        ? "error"
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
    args: entry.args && typeof entry.args === "object" ? (entry.args as Record<string, unknown>) : {},
    result: entry.result && typeof entry.result === "object" ? (entry.result as Record<string, unknown>) : undefined,
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
                args: {},
                state: "completed",
              },
        )
      : [],
  };
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

function buildCitationCandidates(citation: Citation) {
  const decodedExcerpt = decodeHtmlText(citation.excerpt).replace(/\s+/g, " ").trim();
  const cleanedExcerpt = decodedExcerpt.replace(/^[`"'“”‘’]+|[`"'“”‘’.,;:!?]+$/g, "").trim();
  const excerptSegments = cleanedExcerpt
    .split(/[.;!?]\s+|\s+[—–-]\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 24);
  const labelCandidate = decodeHtmlText(citation.label).replace(/\s+/g, " ").trim();
  const candidates = [decodedExcerpt, cleanedExcerpt, ...excerptSegments, labelCandidate]
    .filter((candidate, index, values) => candidate.length >= 12 && values.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);

  if (candidates.length === 0 && decodedExcerpt.length > 0) {
    return [decodedExcerpt];
  }
  return candidates;
}

function clearReaderHighlights(root: ParentNode) {
  for (const mark of root.querySelectorAll("mark.alphabook-inline-highlight")) {
    const parent = mark.parentNode;
    if (!parent) {
      continue;
    }
    parent.replaceChild(mark.ownerDocument.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  }

  for (const block of root.querySelectorAll(".alphabook-highlight-block")) {
    block.classList.remove("alphabook-highlight-block");
  }
}

function highlightTextNodeRange(node: Text, startOffset: number, endOffset: number, className: string) {
  if (startOffset >= endOffset) {
    return null;
  }

  let target = node;
  if (startOffset > 0) {
    target = target.splitText(startOffset);
  }
  if (endOffset - startOffset < target.length) {
    target.splitText(endOffset - startOffset);
  }

  const mark = target.ownerDocument.createElement("mark");
  mark.className = className;
  target.parentNode?.replaceChild(mark, target);
  mark.appendChild(target);
  return mark;
}

function highlightExcerptInTextContainer(container: HTMLElement, citation: Citation) {
  clearReaderHighlights(container);

  const textNode = container.firstChild instanceof Text ? container.firstChild : null;
  if (!textNode?.textContent) {
    return false;
  }

  const rawText = textNode.textContent;
  const { normalized, map } = buildNormalizedSearchIndex(rawText);
  for (const candidate of buildCitationCandidates(citation)) {
    const normalizedCandidate = buildNormalizedSearchIndex(candidate).normalized.trim();
    if (!normalizedCandidate) {
      continue;
    }
    const matchIndex = normalized.indexOf(normalizedCandidate);
    if (matchIndex < 0) {
      continue;
    }

    const rawStart = map[matchIndex];
    const rawEnd = map[matchIndex + normalizedCandidate.length - 1] + 1;
    const mark = highlightTextNodeRange(textNode, rawStart, rawEnd, "alphabook-inline-highlight");
    mark?.parentElement?.classList.add("alphabook-highlight-block");
    mark?.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  return false;
}

function highlightExcerptInIframe(iframe: HTMLIFrameElement, citation: Citation) {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win || !doc.body) {
    return false;
  }

  clearReaderHighlights(doc);
  const searchableWindow = win as Window & {
    find?: (
      string: string,
      caseSensitive?: boolean,
      backwards?: boolean,
      wrapAround?: boolean,
      wholeWord?: boolean,
      searchInFrames?: boolean,
      showDialog?: boolean,
    ) => boolean;
  };
  const finder = typeof searchableWindow.find === "function" ? searchableWindow.find.bind(searchableWindow) : null;
  if (!finder) {
    return false;
  }

  for (const candidate of buildCitationCandidates(citation)) {
    const found = finder(candidate, false, false, true, false, false, false);
    if (!found) {
      continue;
    }

    const selection = win.getSelection();
    const anchorNode = selection?.anchorNode ?? selection?.focusNode ?? null;
    const anchorElement =
      anchorNode instanceof Element
        ? anchorNode
        : anchorNode?.parentElement ?? null;
    const block = anchorElement?.closest("p, li, blockquote, h1, h2, h3, h4, h5, h6, div");

    if (block instanceof HTMLElement) {
      block.classList.add("alphabook-highlight-block");
      block.scrollIntoView({ behavior: "smooth", block: "center" });
      selection?.removeAllRanges();
      return true;
    }

    selection?.removeAllRanges();
  }

  return false;
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
        if (workCount === 0) {
          return "Preparing the background search across the current corpus.";
        }
        return `Preparing the background search for ${pluralize(workCount, "book")}${chunkCount ? ` and ${pluralize(chunkCount, "lead")}` : ""}.`;
      }
      if (state === "error") {
        return `Starting the background search failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      if (hydratedWorkCount > 0) {
        return `Prepared the background search for ${pluralize(hydratedWorkCount, "book")}${chunkCount ? ` and ${pluralize(chunkCount, "lead")}` : ""}.`;
      }
      return `Prepared the background search for ${pluralize(workCount, "book")}${chunkCount ? ` and ${pluralize(chunkCount, "lead")}` : ""}.`;

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
        return query ? `Running the background search for ${query}.` : "Running the background search.";
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
          ? `The background search for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
          : `The background search failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      if (runtimePhase === "collect_evidence") {
        return query ? `Finished gathering evidence for ${query}.` : "Finished gathering evidence.";
      }
      if (runtimePhase === "write_briefing") {
        return query ? `Finished the quoted briefing for ${query}.` : "Finished the quoted briefing.";
      }
      return query ? `Finished the background search for ${query}.` : "Finished the background search.";

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
  if (user?.email) {
    return `@${user.email.split("@")[0]}`;
  }
  return `@reader-${(user?.id ?? "alphabook").slice(0, 8)}`;
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

function messageToThreadMessage(message: UiMessage, streamingAssistantId: string | null, isSending: boolean) {
  const metadata = {
    custom: {
      citations: message.citations,
    },
  };

  if (message.role === "assistant") {
    const toolParts = message.toolCalls.map((entry) => {
        const args = toReadonlyJsonObject(
          entry.rationale
            ? {
                ...entry.args,
                __rationale: entry.rationale,
              }
            : entry.args,
        );
        return {
          type: "tool-call" as const,
          toolCallId: entry.id,
          toolName: entry.label,
          args,
          argsText: JSON.stringify(args),
          ...(entry.state === "running"
            ? {}
            : {
                result: entry.result ?? { ok: !entry.isError },
                isError: entry.isError,
              }),
        };
      });
    const textParts = message.content
      ? [
          {
            type: "text" as const,
            text: message.content,
          },
        ]
      : [];
    const content = [...textParts, ...toolParts];

    return {
      id: message.id,
      role: "assistant" as const,
      createdAt: new Date(message.createdAt),
      content,
      metadata,
      status:
        isSending && message.id === streamingAssistantId
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

function LibraryIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 4h4A1.5 1.5 0 0 1 11 5.5v13A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4Zm8 0h4A1.5 1.5 0 0 1 19 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 12 18.5v-13A1.5 1.5 0 0 1 13.5 4Z" />
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
  { id: "library", label: "Library", icon: LibraryIcon },
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
        <Button asChild variant="default" size="lg">
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

function AssistantSurface({
  messages,
  isSending,
  streamingAssistantId,
  onPrompt,
}: {
  messages: UiMessage[];
  isSending: boolean;
  streamingAssistantId: string | null;
  onPrompt: (prompt: string) => Promise<void>;
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
    onCancel: async () => {},
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread isRunning={isSending} />
    </AssistantRuntimeProvider>
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
    <button type="button" onClick={onOpen} className="w-full text-left">
      <Card className="rounded-[20px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.72)] shadow-none transition-colors hover:border-[rgba(72,43,37,0.1)] hover:bg-[rgba(255,255,255,0.92)]">
        <CardContent className="space-y-3 p-5">
          <div className="flex items-start justify-between gap-4">
            <strong className="text-base font-semibold text-[var(--ink)]">{session.title ?? "Untitled chat"}</strong>
            <span className="shrink-0 text-sm text-[var(--ink-soft)]">{formatRelativeTime(session.lastMessageAt)}</span>
          </div>
          <p className="line-clamp-2 text-sm leading-6 text-[var(--ink-soft)]">{session.lastMessagePreview ?? "No messages yet."}</p>
        </CardContent>
      </Card>
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
  const [adminSection, setAdminSection] = useState<"runs" | "users" | "analytics" | "logs">(initialUrlState.adminSection);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsResolved, setSessionsResolved] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(initialUrlState.debugEnabled);
  const [AgentationComponent, setAgentationComponent] = useState<ComponentType<AgentationProps> | null>(null);
  const [exploreDraft, setExploreDraft] = useState("");
  const [feedWorks, setFeedWorks] = useState<WorkSummary[]>([]);
  const [feedNextOffset, setFeedNextOffset] = useState<number | null>(0);
  const [feedLoading, setFeedLoading] = useState(false);
  const [selectedWorkIds, setSelectedWorkIds] = useState<string[]>([]);
  const [activeWorkId, setActiveWorkId] = useState<string | null | undefined>(initialUrlState.workId);
  const [activeProfileUserId, setActiveProfileUserId] = useState<string | null | undefined>(initialUrlState.profileUserId);
  const [activeWork, setActiveWork] = useState<WorkDetail | null>(null);
  const [activeWorkSource, setActiveWorkSource] = useState<WorkSource | null>(null);
  const [activeWorkLoading, setActiveWorkLoading] = useState(false);
  const [pendingCitation, setPendingCitation] = useState<Citation | null>(null);
  const [bookReaderLoadVersion, setBookReaderLoadVersion] = useState(0);
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
    query: "Give me signups per day over the past seven days.",
    payload: null,
  });
  const activeRunTokenRef = useRef(0);
  const bookReaderFrameRef = useRef<HTMLIFrameElement | null>(null);
  const bookReaderTextRef = useRef<HTMLPreElement | null>(null);

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
      } catch {
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
        console.error("Failed to load Agentation.", error);
      });

    return () => {
      cancelled = true;
    };
  }, [debugEnabled]);

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
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Failed to load the corpus feed.");
      } finally {
        setFeedLoading(false);
      }
    })();
  }, [feedLoading, feedNextOffset, feedWorks.length]);

  useEffect(() => {
    if (!activeWorkId) {
      setActiveWork(null);
      setActiveWorkSource(null);
      setBookReaderLoadVersion((current) => current + 1);
      return;
    }

    void (async () => {
      try {
        setActiveWorkLoading(true);
        const detail = await fetchWorkDetail(activeWorkId);
        setActiveWork(detail.work);
        setActiveWorkSource(detail.source);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Failed to load the selected book.");
      } finally {
        setActiveWorkLoading(false);
      }
    })();
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
    if (!pendingCitation || !activeWorkSource || !activeWork || activeWork.id !== pendingCitation.workId) {
      return;
    }

    let cancelled = false;
    const applyHighlight = () => {
      if (cancelled) {
        return;
      }

      const highlighted =
        activeWorkSource.format === "html"
          ? (bookReaderFrameRef.current ? highlightExcerptInIframe(bookReaderFrameRef.current, pendingCitation) : false)
          : (bookReaderTextRef.current ? highlightExcerptInTextContainer(bookReaderTextRef.current, pendingCitation) : false);

      if (highlighted || activeWorkSource.format === "text") {
        setPendingCitation(null);
      }
    };

    const timeout = window.setTimeout(applyHighlight, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [activeWork, activeWorkSource, bookReaderLoadVersion, pendingCitation]);

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
        if (selectedSessionId === undefined && nextSessions[0]) {
          setSelectedSessionId(nextSessions[0].id);
        }
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

  async function refreshSessions(preferredSessionId?: string | null) {
    if (!currentUserId) {
      return;
    }
    const nextSessions = await fetchSessions(authState.authConfigured ? undefined : currentUserId);
    setSessions(nextSessions);
    if (preferredSessionId !== undefined) {
      setSelectedSessionId(preferredSessionId);
      return;
    }
    if (selectedSessionId === undefined && nextSessions[0]) {
      setSelectedSessionId(nextSessions[0].id);
    }
  }

  function track(event: string, properties: Record<string, unknown> = {}) {
    sendAnalyticsEvent(event, properties, currentUserId);
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

  async function loadAdminAnalytics(query = adminAnalytics.query) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setAdminAnalytics({
        loading: false,
        error: "Enter an analytics question.",
        query,
        payload: null,
      });
      return;
    }
    try {
      setAdminAnalytics({
        loading: true,
        error: null,
        query: normalizedQuery,
        payload: null,
      });
      const payload = await queryAdminAnalytics(normalizedQuery, 7);
      setAdminAnalytics({
        loading: false,
        error: null,
        query: normalizedQuery,
        payload,
      });
    } catch (error) {
      setAdminAnalytics({
        loading: false,
        error: error instanceof Error ? error.message : "Failed to load analytics.",
        query: normalizedQuery,
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
    if (adminUsers.rows.length === 0 && !adminUsers.loading && !adminUsers.error) {
      void loadAdminUsers();
    }
    if (adminSessions.rows.length === 0 && !adminSessions.loading && !adminSessions.error) {
      void loadAdminSessions();
    }
    if (adminRuns.rows.length === 0 && !adminRuns.loading && !adminRuns.error) {
      void loadAdminRuns();
    }
  }, [adminAccess.allowed, adminRuns.error, adminRuns.loading, adminRuns.rows.length, adminSessions.error, adminSessions.loading, adminSessions.rows.length, adminUsers.error, adminUsers.loading, adminUsers.rows.length]);

  useEffect(() => {
    if (!adminAccess.allowed || adminSection !== "analytics" || adminAnalytics.loading || adminAnalytics.payload || adminAnalytics.error) {
      return;
    }
    void loadAdminAnalytics(adminAnalytics.query);
  }, [adminAccess.allowed, adminSection]);

  async function sendPrompt(
    question: string,
    options: { sessionIdOverride?: string | null; workIdsOverride?: string[]; viewOverride?: ViewMode } = {},
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

    const runToken = activeRunTokenRef.current + 1;
    activeRunTokenRef.current = runToken;
    let workingSessionId = initialSessionId;
    let activityLog: ToolTraceEntry[] = [];
    let planMessageId: string | null = null;
    let finalAssistantMessageId: string | null = null;
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
          message: normalizedQuestion,
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
                      rationale: typeof event.data.rationale === "string" ? event.data.rationale : entry.rationale,
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
              return;
            }

            if (event.event === "error") {
              setLoadError(typeof event.data.message === "string" ? event.data.message : "The assistant run failed.");
            }
          },
        },
      );
    } catch (error) {
      if (activeRunTokenRef.current === runToken) {
        setLoadError(error instanceof Error ? error.message : "Failed to stream the assistant run.");
      }
    } finally {
      if (activeRunTokenRef.current === runToken) {
        setIsSending(false);
        setStreamingAssistantId(null);
        await refreshSessions(workingSessionId ?? null);
      }
    }
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
    setActiveView("book");
  }

  function toggleSelectedWork(workId: string) {
    setSelectedWorkIds((current) => (current.includes(workId) ? current.filter((id) => id !== workId) : [...current, workId]));
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
    if (view === "assistant" && activeView === "assistant") {
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
            <AuthLoadingState compact />
          ) : assistantHistoryLoading ? (
            <AuthLoadingState compact />
          ) : authLocked ? (
            <LockedState
              compact
              title="Sign in to use the assistant."
            />
          ) : (
              <AssistantSurface
                key={selectedSessionId ?? "new-thread"}
                messages={messages}
                isSending={isSending}
                streamingAssistantId={streamingAssistantId}
                onPrompt={sendPrompt}
              />
            )}
          </div>
        </section>
    );
  }

  function renderBookView() {
    const showWelcome = !authState.loading && !authLocked && selectedSessionId == null && messages.length === 0 && !isSending;
    const bookPromptHandler = async (prompt: string) => {
      if (!activeWorkId) {
        return;
      }
      await sendPrompt(prompt, {
        sessionIdOverride: selectedSessionId ?? null,
        workIdsOverride: [activeWorkId],
        viewOverride: "book",
      });
    };

    return (
      <section className="book-page">
        <div className="book-reader-pane">
          {activeWorkLoading ? (
            <div className="book-loading">Loading the book…</div>
          ) : activeWork ? (
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
                {activeWorkSource ? (
                  activeWorkSource.format === "html" ? (
                    <iframe
                      title={activeWork.title}
                      className="book-reader-frame"
                      ref={bookReaderFrameRef}
                      sandbox="allow-same-origin"
                      srcDoc={buildReaderDocument(activeWorkSource, activeWork)}
                      onLoad={() => setBookReaderLoadVersion((current) => current + 1)}
                    />
                  ) : (
                    <pre ref={bookReaderTextRef} className="book-reader-text">{activeWorkSource.content}</pre>
                  )
                ) : (
                  <div className="book-loading">This book does not have stored source content yet.</div>
                )}
              </div>
            </>
          ) : (
            <div className="book-loading">Book not found.</div>
          )}
        </div>

        <aside className="book-assistant-pane">
          {loadError ? <div className="thread-error-banner">{loadError}</div> : null}
          <div className="book-assistant-shell" data-testid="book-thread">
            {authPending ? (
              <AuthLoadingState compact />
            ) : authLocked ? (
              <LockedState
                compact
                title="Sign in to ask about this book."
              />
            ) : (
              <AssistantSurface
                key={`book-${activeWorkId ?? "unknown"}-${selectedSessionId ?? "new-thread"}`}
                messages={messages}
                isSending={isSending}
                streamingAssistantId={streamingAssistantId}
                onPrompt={bookPromptHandler}
              />
            )}
          </div>
        </aside>
      </section>
    );
  }

  function renderExploreView() {
    return (
      <div className="view-shell explore-view" onScroll={handleExploreScroll}>
        <section className="explore-hero">
          <h1>Ask or search anything</h1>

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
            const previewMeta = [formatReleaseYear(work.releaseDate)].filter(Boolean).join(" · ");
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

                  {work.subjects.length > 0 ? (
                    <div className="work-feed-tags">
                      {work.subjects.slice(0, 4).map((subject) => (
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

  function renderLibraryView() {
    if (authPending) {
      return (
        <section className="assistant-page">
          <div className="assistant-thread-shell">
            <AuthLoadingState compact />
          </div>
        </section>
      );
    }

    if (authLocked) {
      return (
        <section className="assistant-page">
          <div className="assistant-thread-shell">
            <LockedState
              compact
              title="Sign in to open your library."
            />
          </div>
        </section>
      );
    }

    return (
      <div className="view-shell">
        <header className="view-header">
          <h1>Library</h1>
        </header>

        <div className="library-list space-y-3">
          {sessions.length === 0 ? (
            <Card className="feature-card rounded-[20px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.62)] shadow-none">
              <CardContent className="p-8">
                <p className="empty-copy text-sm text-[var(--ink-soft)]">Saved chats appear here.</p>
              </CardContent>
            </Card>
          ) : (
            sessions.map((session) => <SessionListCard key={session.id} session={session} onOpen={() => openSession(session.id)} />)
          )}
        </div>
      </div>
    );
  }

  function renderProfileView() {
    const isPublicProfile = Boolean(activeProfileUserId && (!currentUserId || activeProfileUserId !== currentUserId));
    if (authPending) {
      return (
        <section className="assistant-page">
          <div className="assistant-thread-shell">
            <AuthLoadingState compact />
          </div>
        </section>
      );
    }

    if (authLocked && !isPublicProfile) {
      return (
        <section className="assistant-page">
          <div className="assistant-thread-shell">
            <LockedState
              compact
              title="Create an account to open your profile."
            />
          </div>
        </section>
      );
    }

    if (isPublicProfile) {
      if (publicProfileLoading) {
        return (
          <section className="assistant-page">
            <div className="assistant-thread-shell">
              <AuthLoadingState compact />
            </div>
          </section>
        );
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

      return (
        <div className="profile-view space-y-6">
          <section className="profile-hero space-y-3">
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
            <p>{publicJoined ? `${publicTag} • joined ${publicJoined}` : publicTag}</p>
          </section>

          <section className="profile-toolbar flex flex-wrap items-center justify-center gap-4">
            <div className="profile-stats flex items-center gap-3">
              <div className="px-4 py-1 text-center">
                <strong className="block text-[var(--ink)]">{profile.followersCount}</strong>
                <span className="text-xs text-[var(--ink-soft)]">Followers</span>
              </div>
              <div className="px-4 py-1 text-center">
                <strong className="block text-[var(--ink)]">{profile.followingCount}</strong>
                <span className="text-xs text-[var(--ink-soft)]">Following</span>
              </div>
            </div>
            <div className="profile-actions">
              {publicProfile.isSelf ? null : authLocked ? (
                <Button asChild variant="ghost" className="profile-chip">
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
            <div className="library-list space-y-3">
              <Card className="feature-card rounded-[20px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.62)] shadow-none">
                <CardContent className="p-8">
                  <p className="empty-copy text-sm text-[var(--ink-soft)]">Public reading history is not shared yet.</p>
                </CardContent>
              </Card>
            </div>
          </section>
        </div>
      );
    }

    const joinedLabel = formatMonthYear(currentUser?.createdAt);

    return (
      <div className="profile-view space-y-6">
        <section className="profile-hero space-y-3">
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
          <p>{joinedLabel ? `${profileTag} • joined ${joinedLabel}` : profileTag}</p>
        </section>

        <section className="profile-toolbar flex flex-wrap items-center justify-center gap-4">
          <div className="profile-stats flex items-center gap-3">
            <div className="px-4 py-1 text-center">
              <strong className="block text-[var(--ink)]">{currentUser?.followersCount ?? 0}</strong>
              <span className="text-xs text-[var(--ink-soft)]">Followers</span>
            </div>
            <div className="px-4 py-1 text-center">
              <strong className="block text-[var(--ink)]">{currentUser?.followingCount ?? 0}</strong>
              <span className="text-xs text-[var(--ink-soft)]">Following</span>
            </div>
          </div>
          <div className="profile-actions">
            {authState.authConfigured && authState.user ? (
              <Button asChild variant="ghost" className="profile-chip">
                <a href={buildSignOutUrl(window.location.href)}>Log out</a>
              </Button>
            ) : null}
          </div>
        </section>

        <section className="profile-history">
          <div className="library-list space-y-3">
            {sessions.length === 0 ? (
              <Card className="feature-card rounded-[20px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.62)] shadow-none">
                <CardContent className="p-8">
                  <p className="empty-copy text-sm text-[var(--ink-soft)]">No history yet.</p>
                </CardContent>
              </Card>
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
    const analyticsPayload = adminAnalytics.payload ?? {};
    const analyticsMetrics = Array.isArray(analyticsPayload.metrics) ? analyticsPayload.metrics as Array<Record<string, unknown>> : [];
    const analyticsSeries = Array.isArray(analyticsPayload.series) ? analyticsPayload.series as Array<Record<string, unknown>> : [];
    const analyticsHashtags = Array.isArray(analyticsPayload.hashtags) ? analyticsPayload.hashtags as Array<Record<string, unknown>> : [];
    const analyticsNotes = Array.isArray(analyticsPayload.notes) ? analyticsPayload.notes as Array<unknown> : [];
    const adminNavItems = [
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

        <div className="grid gap-3 md:grid-cols-3">
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

                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void loadAdminAnalytics(adminAnalytics.query);
                  }}
                >
                  <div className="relative">
                    <Textarea
                      className="min-h-[150px] rounded-[18px] border-[rgba(72,43,37,0.12)] bg-white px-4 py-4 pr-18 text-sm leading-6 focus-visible:border-[rgba(72,43,37,0.28)] focus-visible:ring-[rgba(72,43,37,0.14)]"
                      value={adminAnalytics.query}
                      onChange={(event) => setAdminAnalytics((current) => ({ ...current, query: event.currentTarget.value }))}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                          event.preventDefault();
                          void loadAdminAnalytics(adminAnalytics.query);
                        }
                      }}
                      placeholder="Give me signups per day over the past seven days."
                    />
                    <Button
                      type="submit"
                      size="icon"
                      className="absolute bottom-4 right-4 h-10 w-10 rounded-full"
                      disabled={adminAnalytics.loading || !adminAnalytics.query.trim()}
                      aria-label="Run analytics query"
                    >
                      <ArrowUpIcon />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      "Give me signups per day over the past seven days.",
                      "Give me the number of new research queries over the past seven days.",
                      "Give me the topics people are searching on over the past seven days.",
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        className="rounded-full border border-[rgba(72,43,37,0.12)] bg-white px-3 py-2 text-xs font-medium text-[var(--ink-soft)] transition hover:border-[rgba(72,43,37,0.2)] hover:text-[var(--ink)]"
                        onClick={() => {
                          setAdminAnalytics((current) => ({ ...current, query: suggestion }));
                          void loadAdminAnalytics(suggestion);
                        }}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="submit" disabled={adminAnalytics.loading || !adminAnalytics.query.trim()}>
                      {adminAnalytics.loading ? "Running analytics…" : "Run analytics query"}
                    </Button>
                    <span className="text-sm text-[var(--ink-soft)]">
                      Press `Cmd`/`Ctrl` + `Enter` to run from the field.
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
      case "library":
        return renderLibraryView();
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
          <div className="sidebar-auth-skeleton" aria-hidden="true">
            <Skeleton className={cn("h-11 rounded-full", sidebarCollapsed ? "w-11" : "w-full")} />
          </div>
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
          <Button asChild variant="default" className={cn("sidebar-signin sidebar-signin-bottom", sidebarCollapsed && "size-11 px-0")}>
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
