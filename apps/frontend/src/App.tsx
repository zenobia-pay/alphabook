import { createContext, type ComponentType, type CSSProperties, type FormEvent, type UIEvent, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  makeAssistantToolUI,
  useExternalStoreRuntime,
  useMessage,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { Composer, Thread } from "@assistant-ui/react-ui";
import type { ReadonlyJSONObject, ReadonlyJSONValue } from "assistant-stream/utils";
import type { AgentationProps } from "agentation";
import { ChevronsLeft, ChevronsRight } from "lucide-react";

import { getToolLabel, type ChatSessionSummary, type Citation, type MessageRecord, type UserProfile, type WorkDetail, type WorkSource, type WorkSummary } from "@alphabook/shared";

import { buildSignInUrl, buildSignOutUrl, fetchCurrentUser, fetchMessages, fetchSessions, fetchWorkDetail, fetchWorks, streamChat } from "./api";
import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar";
import { Badge } from "./components/ui/badge";
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

type ViewMode = "explore" | "assistant" | "library" | "profile" | "book";
type UrlState = {
  view: ViewMode;
  sessionId: string | null | undefined;
  workId: string | null | undefined;
  debugEnabled: boolean;
};

const USER_STORAGE_KEY = "alphabook.localUserId";
const CitationNavigationContext = createContext<CitationNavigationContextValue | null>(null);

function isViewMode(value: string | null): value is ViewMode {
  return value === "explore" || value === "assistant" || value === "library" || value === "profile" || value === "book";
}

function readUrlState(): UrlState {
  if (typeof window === "undefined") {
    return {
      view: "assistant",
      sessionId: undefined,
      workId: undefined,
      debugEnabled: false,
    };
  }

  const pathnameMatch = window.location.pathname.match(/^\/works\/([^/]+)$/);
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get("view");
  return {
    view: pathnameMatch ? "book" : isViewMode(rawView) ? rawView : "assistant",
    sessionId: params.has("session") ? params.get("session") || null : undefined,
    workId: pathnameMatch ? decodeURIComponent(pathnameMatch[1]) : params.has("work") ? params.get("work") || null : undefined,
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
  } else {
    url.pathname = "/";
    url.searchParams.set("view", next.view);
    url.searchParams.delete("work");
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

  switch (toolName) {
    case "search_works":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return query ? `Scanning corpus metadata for ${query}.` : "Scanning corpus metadata.";
      }
      if (state === "error") {
        return query
          ? `The corpus metadata scan for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
          : `The corpus metadata scan failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      if (resultWorkCount === 0) {
        return query
          ? `Scanned corpus metadata for ${query} and found no strong candidate books.`
          : "Scanned corpus metadata and found no strong candidate books.";
      }
      return query
        ? `Scanned corpus metadata for ${query} and found ${pluralize(resultWorkCount, "candidate work")}.`
        : `Scanned corpus metadata and found ${pluralize(resultWorkCount, "candidate work")}.`;

    case "get_relevant_chunks":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return query ? `Running an initial index scan for ${query}.` : "Running an initial index scan.";
      }
      if (state === "error") {
        return query
          ? `The initial index scan for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
          : `The initial index scan failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      if (resultChunkCount === 0) {
        return query
          ? `Ran an initial index scan for ${query} and found no seed matches.`
          : "Ran an initial index scan and found no seed matches.";
      }
      return query
        ? `Found ${pluralize(resultChunkCount, "seed match")} for ${query}.`
        : `Found ${pluralize(resultChunkCount, "seed match")}.`;

    case "get_work_metadata":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return `Loading metadata for ${pluralize(workCount, "book")}.`;
      }
      if (state === "error") {
        return `Metadata lookup failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return `Loaded metadata for ${pluralize(resultWorkCount || workCount, "book")}.`;

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
        return `Preparing a VM workspace for ${pluralize(workCount, "book")}${chunkCount ? ` and ${pluralize(chunkCount, "passage")}` : ""}.`;
      }
      if (state === "error") {
        return `Preparing the VM workspace failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return `Prepared a VM workspace for ${pluralize(workCount, "book")}${chunkCount ? ` and ${pluralize(chunkCount, "passage")}` : ""}.`;

    case "run_workspace_task":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        if (runtimePhase === "collect_evidence") {
          return query ? `Running VM pass 1 to collect evidence for ${query}.` : "Running VM pass 1 to collect evidence.";
        }
        if (runtimePhase === "write_briefing") {
          return query ? `Running VM pass 2 to write the briefing for ${query}.` : "Running VM pass 2 to write the briefing.";
        }
        return query ? `Running the VM search for ${query}.` : "Running the VM search.";
      }
      if (state === "error") {
        if (runtimePhase === "collect_evidence") {
          return query
            ? `VM pass 1 for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
            : `VM pass 1 failed${errorMessage ? `: ${errorMessage}` : "."}`;
        }
        if (runtimePhase === "write_briefing") {
          return query
            ? `VM pass 2 for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
            : `VM pass 2 failed${errorMessage ? `: ${errorMessage}` : "."}`;
        }
        return query
          ? `The VM search for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
          : `The VM search failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      if (runtimePhase === "collect_evidence") {
        return query ? `Finished VM pass 1 evidence collection for ${query}.` : "Finished VM pass 1 evidence collection.";
      }
      if (runtimePhase === "write_briefing") {
        return query ? `Finished VM pass 2 briefing for ${query}.` : "Finished VM pass 2 briefing.";
      }
      return query ? `Finished the VM search for ${query}.` : "Finished the VM search.";

    case "read_workspace_file":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return path ? `Reading ${path} from the VM workspace.` : "Reading the VM workspace output.";
      }
      if (state === "error") {
        return `Reading the VM workspace output failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return path ? `Read ${path} from the VM workspace.` : "Read the VM workspace output.";

    case "destroy_workspace":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return "Closing the VM workspace.";
      }
      if (state === "error") {
        return `Closing the VM workspace failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return "Closed the VM workspace.";

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
          toolName: entry.toolName,
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
    const isPlanMessage = message.metadata.phase === "plan";
    const content = isPlanMessage
      ? [...textParts, ...toolParts]
      : [...toolParts, ...textParts];

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

function AssistantToolCall({
  toolName,
  args,
  result,
  isError,
  status,
}: ToolCallMessagePartProps<Record<string, unknown>, Record<string, unknown>>) {
  const label = getToolLabel(toolName);
  const { __rationale, ...visibleArgs } = args;
  const state =
    status.type === "running" || result === undefined ? "running" : isError || status.type === "incomplete" ? "error" : "completed";
  const detail = summarizeToolSentence({
    toolName,
    args: visibleArgs,
    result,
    state,
    rationale: typeof __rationale === "string" ? __rationale : undefined,
  });

  return (
    <div className={`tool-call-card is-${state}`}>
      <span className="tool-call-label">{label}</span>
      <p className="tool-call-detail">{detail}</p>
    </div>
  );
}

const TOOL_UIS = [
  "search_works",
  "get_work_metadata",
  "get_relevant_chunks",
  "get_work_text",
  "create_workspace",
  "run_workspace_task",
  "read_workspace_file",
  "destroy_workspace",
].map((toolName) =>
  makeAssistantToolUI<Record<string, unknown>, Record<string, unknown>>({
    toolName,
    render: AssistantToolCall,
  }),
);

function AssistantFooter() {
  const metadata = useMessage((message) => message.metadata.custom as Record<string, unknown> | undefined);
  const citations = (Array.isArray(metadata?.citations) ? metadata?.citations : []) as Citation[];
  const citationNavigation = useContext(CitationNavigationContext);

  if (citations.length === 0) {
    return null;
  }

  return (
    <div className="assistant-footnotes">
      <div className="citation-list">
        {citations.map((citation) => (
          <button
            key={`${citation.workId}-${citation.chunkId ?? citation.label}`}
            type="button"
            className={`citation-chip ${citationNavigation?.activeWorkId === citation.workId ? "is-active" : ""}`}
            title={decodeHtmlText(citation.excerpt)}
            data-testid="citation-chip"
            onClick={() => citationNavigation?.openCitation(citation)}
          >
            {citation.label}
          </button>
        ))}
      </div>
    </div>
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
        <Button asChild variant="accent" size="lg">
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
  showWelcome,
  onOpenCitation,
  activeWorkId,
}: {
  messages: UiMessage[];
  isSending: boolean;
  streamingAssistantId: string | null;
  onPrompt: (prompt: string) => Promise<void>;
  showWelcome: boolean;
  onOpenCitation: (citation: Citation) => void;
  activeWorkId: string | null | undefined;
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
    <CitationNavigationContext.Provider value={{ openCitation: onOpenCitation, activeWorkId }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread
          assistantAvatar={{ fallback: "A" }}
          tools={TOOL_UIS}
          components={{
            Composer,
          }}
          assistantMessage={{
            allowCopy: true,
            components: {
              Footer: AssistantFooter,
            },
          }}
          composer={{
            allowAttachments: false,
          }}
          welcome={{
            message: showWelcome ? "Ask Alphabook." : null,
            suggestions: showWelcome
              ? [
                  {
                    prompt: "Trace how grief moves across Don Quixote and Moby-Dick.",
                  },
                  {
                    prompt: "Find books where exile and melancholy overlap.",
                  },
                  {
                    prompt: "Compare how obsession sounds in the strongest passages of the corpus.",
                  },
                ]
              : [],
          }}
        />
      </AssistantRuntimeProvider>
    </CitationNavigationContext.Provider>
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
  const [activeWork, setActiveWork] = useState<WorkDetail | null>(null);
  const [activeWorkSource, setActiveWorkSource] = useState<WorkSource | null>(null);
  const [activeWorkLoading, setActiveWorkLoading] = useState(false);
  const [pendingCitation, setPendingCitation] = useState<Citation | null>(null);
  const [bookReaderLoadVersion, setBookReaderLoadVersion] = useState(0);
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
        : NAV_ITEMS.find((item) => item.id === activeView)?.label ?? "AlphaBook";
  const authLocked = authState.authConfigured && !authState.user;
  const hasAuthenticatedUser = Boolean(authState.user);
  const authPending = authState.loading;

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
    const handlePopState = () => {
      const next = readUrlState();
      setActiveView(next.view);
      setSelectedSessionId(next.sessionId);
      setActiveWorkId(next.workId);
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
      debugEnabled,
    });
  }, [activeView, selectedSessionId, activeWorkId, debugEnabled]);

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
              setMessages((current) =>
                current.map((message) =>
                  message.id === planMessageId
                    ? {
                        ...message,
                        toolCalls: activityLog,
                      }
                    : message,
                ),
              );
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
              setMessages((current) =>
                current.map((message) =>
                  message.id === planMessageId
                    ? {
                        ...message,
                        toolCalls: activityLog,
                      }
                    : message,
                ),
              );
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
    if (view === "assistant" && activeView === "assistant") {
      startNewChat();
      return;
    }
    setActiveView(view);
  }

  function openSession(sessionId: string) {
    setMobileNavOpen(false);
    setSelectedSessionId(sessionId);
    setActiveWorkId(null);
    setPendingCitation(null);
    setActiveView("assistant");
  }

  function queuePrompt(prompt: string) {
    startNewChat();
    void sendPrompt(prompt, { sessionIdOverride: null });
  }

  function openWork(workId: string) {
    setMobileNavOpen(false);
    setPendingCitation(null);
    setActiveWorkId(workId);
    startNewBookChat();
  }

  function openCitation(citation: Citation) {
    setMobileNavOpen(false);
    setPendingCitation(citation);
    setActiveWorkId(citation.workId);
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
                showWelcome={showWelcome}
                onOpenCitation={openCitation}
                activeWorkId={activeWorkId}
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
                showWelcome={showWelcome}
                onOpenCitation={openCitation}
                activeWorkId={activeWorkId}
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
            <Card className="explore-composer-root rounded-[28px] border-[var(--shell-strong)] bg-[rgba(255,251,247,0.84)] shadow-[0_18px_40px_rgba(58,34,27,0.08)]">
              <CardContent className="p-3">
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

              <Textarea
                className="explore-composer-input min-h-[96px] border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
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

              <div className="explore-composer-footer flex justify-end">
                <Button
                  type="submit"
                  variant="default"
                  size="icon"
                  className="send-button explore-send size-10"
                  disabled={!exploreDraft.trim() && selectedWorks.length === 0}
                  aria-label="Send prompt"
                >
                  <ArrowUpIcon />
                </Button>
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
              title="Create an account to open your profile."
            />
          </div>
        </section>
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
            <Badge variant="subtle" className="gap-2 px-4 py-2 text-sm">
              <strong className="text-[var(--ink)]">{currentUser?.followersCount ?? 0}</strong>
              <span>Followers</span>
            </Badge>
            <Badge variant="subtle" className="gap-2 px-4 py-2 text-sm">
              <strong className="text-[var(--ink)]">{currentUser?.followingCount ?? 0}</strong>
              <span>Following</span>
            </Badge>
          </div>
          <div className="profile-actions">
            {authState.authConfigured && authState.user ? (
              <Button asChild variant="outline" className="profile-chip">
                <a href={buildSignOutUrl(window.location.href)}>Log out</a>
              </Button>
            ) : null}
          </div>
        </section>

        <section className="profile-nav" aria-label="Profile sections">
          <div className="mx-auto flex w-fit items-center gap-2 rounded-full border border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.72)] p-1">
            <Button type="button" variant="ghost" size="sm" className="profile-nav-item" aria-disabled="true">
              Papers
            </Button>
            <Button type="button" variant="ghost" size="sm" className="profile-nav-item" aria-disabled="true">
              Activity
            </Button>
            <Button type="button" variant="default" size="sm" className="profile-nav-item is-active">
              History
            </Button>
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
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id || (activeView === "book" && item.id === "explore");
            return (
              <Button
                key={item.id}
                type="button"
                variant={isActive ? "default" : "ghost"}
                className={cn(
                  "sidebar-nav-button w-full justify-start rounded-[18px] px-4 py-3 text-[1.05rem]",
                  isActive && "bg-white shadow-[0_8px_20px_rgba(58,34,27,0.05)]",
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
            variant="outline"
            className={cn(
              "sidebar-profile h-auto justify-start gap-3 rounded-[18px] border-[rgba(72,43,37,0.06)] bg-[rgba(255,255,255,0.74)] p-2 shadow-none",
              sidebarCollapsed && "size-12 justify-center p-0",
            )}
            onClick={() => {
              setActiveWorkId(null);
              setActiveView("profile");
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
          <Button asChild variant="accent" className={cn("sidebar-signin sidebar-signin-bottom", sidebarCollapsed && "size-11 px-0")}>
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
              setMobileNavOpen(false);
              setActiveWorkId(null);
              setActiveView("profile");
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
