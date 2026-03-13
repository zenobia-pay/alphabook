import { type ComponentType, type FormEvent, type UIEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  makeAssistantToolUI,
  useExternalStoreRuntime,
  useMessage,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { Thread } from "@assistant-ui/react-ui";
import type { ReadonlyJSONObject, ReadonlyJSONValue } from "assistant-stream/utils";
import type { AgentationProps } from "agentation";

import { getToolLabel, type ChatSessionSummary, type Citation, type MessageRecord, type UserProfile, type WorkSummary } from "@alphabook/shared";

import { buildSignInUrl, buildSignOutUrl, buildSignUpUrl, fetchCurrentUser, fetchMessages, fetchSessions, fetchWorks, streamChat } from "./api";

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

type AuthState = {
  loading: boolean;
  authConfigured: boolean;
  user: UserProfile | null;
  error: string | null;
};

type ViewMode = "explore" | "assistant" | "library" | "profile";
type UrlState = {
  view: ViewMode;
  sessionId: string | null | undefined;
  debugEnabled: boolean;
};

const USER_STORAGE_KEY = "alphabook.localUserId";

function isViewMode(value: string | null): value is ViewMode {
  return value === "explore" || value === "assistant" || value === "library" || value === "profile";
}

function readUrlState(): UrlState {
  if (typeof window === "undefined") {
    return {
      view: "assistant",
      sessionId: undefined,
      debugEnabled: false,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const rawView = params.get("view");
  return {
    view: isViewMode(rawView) ? rawView : "assistant",
    sessionId: params.has("session") ? params.get("session") || null : undefined,
    debugEnabled: params.get("debug") === "true",
  };
}

function writeUrlState(next: UrlState) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("view", next.view);
  if (next.view === "assistant" && next.sessionId) {
    url.searchParams.set("session", next.sessionId);
  } else {
    url.searchParams.delete("session");
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

  switch (toolName) {
    case "search_works":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return query ? `Searching the corpus for ${query}.` : "Searching the corpus.";
      }
      if (state === "error") {
        return query
          ? `The corpus search for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
          : `The corpus search failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      if (resultWorkCount === 0) {
        return query
          ? `Searched the corpus for ${query} and found no matching books.`
          : "Searched the corpus and found no matching books.";
      }
      return query
        ? `Searched the corpus for ${query} and found ${pluralize(resultWorkCount, "matching work")}.`
        : `Searched the corpus and found ${pluralize(resultWorkCount, "matching work")}.`;

    case "get_relevant_chunks":
      if (state === "running") {
        if (planned) {
          return planned;
        }
        return query ? `Gathering the strongest passages for ${query}.` : "Gathering the strongest passages.";
      }
      if (state === "error") {
        return query
          ? `Passage retrieval for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
          : `Passage retrieval failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      if (resultChunkCount === 0) {
        return query
          ? `Looked for grounded passages for ${query} and found none.`
          : "Looked for grounded passages and found none.";
      }
      return query
        ? `Pulled ${pluralize(resultChunkCount, "grounded passage")} for ${query}.`
        : `Pulled ${pluralize(resultChunkCount, "grounded passage")}.`;

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
        return query ? `Running a deeper VM search for ${query}.` : "Running a deeper VM search.";
      }
      if (state === "error") {
        return query
          ? `The deep VM search for ${query} failed${errorMessage ? `: ${errorMessage}` : "."}`
          : `The deep VM search failed${errorMessage ? `: ${errorMessage}` : "."}`;
      }
      return query ? `Finished the deeper VM search for ${query}.` : "Finished the deeper VM search.";

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

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2 2-6.5Z" />
      <path d="M18 3.5 18.8 6l2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8.8-2.5Z" />
    </svg>
  );
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

  if (citations.length === 0) {
    return null;
  }

  return (
    <div className="assistant-footnotes">
      <div className="citation-list">
        {citations.map((citation) => (
          <span key={`${citation.workId}-${citation.chunkId ?? citation.label}`} className="citation-chip">
            {citation.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function AssistantWelcome({
  isSending,
  onPrompt,
}: {
  isSending: boolean;
  onPrompt: (prompt: string) => Promise<void>;
}) {
  const prompts = [
    "Trace how grief moves across Don Quixote and Moby-Dick.",
    "Find books where exile and melancholy overlap.",
    "Compare how obsession sounds in the strongest passages of the corpus.",
  ];

  return (
    <section className="assistant-blank" data-testid="empty-state">
      <div className="assistant-blank-mark">
        <SparkIcon />
      </div>
      <h2>Ask Alphabook.</h2>
      <div className="assistant-suggestions">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="assistant-suggestion"
            disabled={isSending}
            onClick={() => {
              void onPrompt(prompt);
            }}
          >
            {prompt}
          </button>
        ))}
      </div>
    </section>
  );
}

function LockedState({
  title,
  copy,
  icon: Icon,
  compact = false,
}: {
  title: string;
  copy: string;
  icon: ComponentType;
  compact?: boolean;
}) {
  return (
    <section className={`locked-panel ${compact ? "is-compact" : ""}`}>
      <div className="locked-mark">
        <Icon />
      </div>
      <div className="locked-copy">
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
      <div className="locked-actions">
        <a className="hero-button hero-button-primary" href={buildSignInUrl(window.location.href)}>
          Sign in
        </a>
        <a className="hero-button" href={buildSignUpUrl(window.location.href)}>
          Create account
        </a>
      </div>
    </section>
  );
}

function AssistantSurface({
  messages,
  isSending,
  streamingAssistantId,
  onPrompt,
  showWelcome,
}: {
  messages: UiMessage[];
  isSending: boolean;
  streamingAssistantId: string | null;
  onPrompt: (prompt: string) => Promise<void>;
  showWelcome: boolean;
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

  function Welcome() {
    return <AssistantWelcome isSending={isSending} onPrompt={onPrompt} />;
  }

  function AssistantComposer() {
    return (
      <ComposerPrimitive.Root className="aui-composer-root">
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          className="aui-composer-input"
          placeholder="Write a message..."
        />
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send asChild>
            <button
              type="button"
              className="aui-button aui-button-primary aui-button-icon aui-composer-send"
              aria-label="Send"
            >
              <ArrowUpIcon />
            </button>
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
      </ComposerPrimitive.Root>
    );
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        assistantAvatar={{ fallback: "A" }}
        tools={TOOL_UIS}
        components={{
          ...(showWelcome ? { ThreadWelcome: Welcome } : {}),
          Composer: AssistantComposer,
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
          message: null,
        }}
      />
    </AssistantRuntimeProvider>
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
  const [isSending, setIsSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(initialUrlState.debugEnabled);
  const [AgentationComponent, setAgentationComponent] = useState<ComponentType<AgentationProps> | null>(null);
  const [exploreDraft, setExploreDraft] = useState("");
  const [feedWorks, setFeedWorks] = useState<WorkSummary[]>([]);
  const [feedNextOffset, setFeedNextOffset] = useState<number | null>(0);
  const [feedLoading, setFeedLoading] = useState(false);
  const [selectedWorkIds, setSelectedWorkIds] = useState<string[]>([]);
  const activeRunTokenRef = useRef(0);

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
  const activeViewLabel = activeView === "assistant" ? activeSession?.title ?? "Assistant" : NAV_ITEMS.find((item) => item.id === activeView)?.label ?? "AlphaBook";
  const authLocked = authState.authConfigured && !authState.user;
  const hasAuthenticatedUser = Boolean(authState.user);

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
      debugEnabled,
    });
  }, [activeView, selectedSessionId, debugEnabled]);

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
    if (authState.loading) {
      return;
    }
    if (!currentUserId) {
      setSessions([]);
      setSelectedSessionId(null);
      setMessages([]);
      return;
    }

    void (async () => {
      try {
        const nextSessions = await fetchSessions(authState.authConfigured ? undefined : currentUserId);
        setSessions(nextSessions);
        if (selectedSessionId === undefined && nextSessions[0]) {
          setSelectedSessionId(nextSessions[0].id);
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Failed to load sessions.");
      }
    })();
  }, [authState.authConfigured, currentUserId, selectedSessionId]);

  useEffect(() => {
    if (authState.loading) {
      return;
    }
    if (!selectedSessionId) {
      setMessages([]);
      return;
    }

    void (async () => {
      try {
        const nextMessages = await fetchMessages(selectedSessionId);
        setMessages(nextMessages.map(hydrateStoredMessage));
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Failed to load messages.");
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

  async function sendPrompt(question: string, options: { sessionIdOverride?: string | null } = {}) {
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
    setActiveView("assistant");
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
    if (view === "assistant" && activeView === "assistant") {
      startNewChat();
      return;
    }
    setActiveView(view);
  }

  function openSession(sessionId: string) {
    setMobileNavOpen(false);
    setSelectedSessionId(sessionId);
    setActiveView("assistant");
  }

  function queuePrompt(prompt: string) {
    startNewChat();
    void sendPrompt(prompt, { sessionIdOverride: null });
  }

  function renderAssistantView() {
    const showWelcome = !authState.loading && !authLocked && selectedSessionId == null && messages.length === 0 && !isSending;

    return (
      <section className="assistant-page">
        {loadError ? <div className="thread-error-banner">{loadError}</div> : null}

        <div className="assistant-thread-shell" data-testid="thread">
          {authState.loading ? <div className="session-loading">Checking your session…</div> : null}
          {!authState.loading && authLocked ? (
            <LockedState
              compact
              icon={ChatIcon}
              title="Sign in to use the assistant."
              copy="Chats and citations stay with your account."
            />
          ) : (
            <AssistantSurface
              key={selectedSessionId ?? "new-thread"}
              messages={messages}
              isSending={isSending}
              streamingAssistantId={streamingAssistantId}
              onPrompt={sendPrompt}
              showWelcome={showWelcome}
            />
          )}
        </div>
      </section>
    );
  }

  function renderExploreView() {
    return (
      <div className="view-shell explore-view" onScroll={handleExploreScroll}>
        <section className="explore-hero">
          <h1>Ask or search anything</h1>

          <form className="explore-composer-shell" onSubmit={submitExplorePrompt}>
            <div className="aui-composer-root explore-composer-root">
              {selectedWorks.length > 0 ? (
                <div className="explore-selection-row">
                  {selectedWorks.map((work) => (
                    <button
                      key={work.id}
                      type="button"
                      className="explore-selection-chip"
                      onClick={() => toggleSelectedWork(work.id)}
                    >
                      {work.title}
                    </button>
                  ))}
                </div>
              ) : null}

              <textarea
                className="aui-composer-input explore-composer-input"
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
                <button
                  type="submit"
                  className="send-button explore-send"
                  disabled={!exploreDraft.trim() && selectedWorks.length === 0}
                  aria-label="Send prompt"
                >
                  <ArrowUpIcon />
                </button>
              </div>
            </div>
          </form>
        </section>

        <section className="work-feed" aria-label="Corpus feed">
          {feedWorks.map((work) => {
            const selected = selectedWorkIds.includes(work.id);
            const previewMeta = [formatReleaseYear(work.releaseDate), work.language?.toUpperCase()].filter(Boolean).join(" · ");
            return (
              <button
                key={work.id}
                type="button"
                aria-pressed={selected}
                className={`work-feed-card ${selected ? "is-selected" : ""}`}
                onClick={() => toggleSelectedWork(work.id)}
              >
                <div className="work-feed-heading">
                  <div>
                    {previewMeta ? <p className="work-feed-meta">{previewMeta}</p> : null}
                    <h2>{work.title}</h2>
                    {work.authors.length > 0 ? <p className="work-feed-authors">{work.authors.join(" · ")}</p> : null}
                  </div>
                  <span className="work-feed-marker" aria-hidden="true" />
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
            );
          })}

          {feedLoading ? <p className="feed-status">Loading more works…</p> : null}
          {!feedLoading && feedWorks.length === 0 ? <p className="feed-status">No works yet.</p> : null}
        </section>
      </div>
    );
  }

  function renderLibraryView() {
    if (authState.loading) {
      return (
        <div className="view-shell locked-view">
          <header className="view-header">
            <h1>Library</h1>
          </header>
          <div className="session-loading">Checking your session…</div>
        </div>
      );
    }

    if (authLocked) {
      return (
        <div className="view-shell locked-view">
          <header className="view-header">
            <h1>Library</h1>
          </header>
          <LockedState
            icon={LibraryIcon}
            title="Sign in to open your library."
            copy="Saved chats live here."
          />
        </div>
      );
    }

    return (
      <div className="view-shell">
        <header className="view-header">
          <h1>Library</h1>
        </header>

        <div className="library-list">
          {sessions.length === 0 ? (
            <article className="feature-card">
              <p className="empty-copy">Saved chats appear here.</p>
            </article>
          ) : (
            sessions.map((session) => (
              <button key={session.id} type="button" className="library-card" onClick={() => openSession(session.id)}>
                <div className="library-card-top">
                  <strong>{session.title ?? "Untitled chat"}</strong>
                  <span>{formatRelativeTime(session.lastMessageAt)}</span>
                </div>
                <p>{session.lastMessagePreview ?? "No messages yet."}</p>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  function renderProfileView() {
    if (authState.loading) {
      return (
        <div className="view-shell locked-view">
          <header className="view-header">
            <h1>Profile</h1>
          </header>
          <div className="session-loading">Checking your session…</div>
        </div>
      );
    }

    if (authLocked) {
      return (
        <div className="view-shell locked-view">
          <header className="view-header">
            <h1>Profile</h1>
          </header>
          <LockedState
            icon={ProfileIcon}
            title="Create an account to open your profile."
            copy="History and saved sessions live here."
          />
        </div>
      );
    }

    return (
      <div className="profile-view">
        <section className="profile-hero">
          {currentUser?.avatarUrl ? (
            <img className="profile-hero-image" src={currentUser.avatarUrl} alt={displayProfileName} />
          ) : (
            <div className="profile-hero-badge" style={{ ["--profile-hue" as string]: profileHue }}>
              {initialsFromSeed(displayProfileName)}
            </div>
          )}
          <h1>{displayProfileName}</h1>
          <p>{profileTag}</p>
          <div className="profile-actions">
            {authState.authConfigured && authState.user ? (
              <a className="hero-button" href={buildSignOutUrl(window.location.href)}>
                Sign out
              </a>
            ) : null}
          </div>
        </section>

        <section className="profile-stats">
          <article>
            <strong>{sessions.length}</strong>
            <span>Threads</span>
          </article>
          <article>
            <strong>{assistantMessages.length}</strong>
            <span>Answers</span>
          </article>
          <article>
            <strong>{citationCount}</strong>
            <span>Citations</span>
          </article>
        </section>

        <section className="profile-layout">
          <div className="profile-history">
            <header className="view-header">
              <h2>History</h2>
            </header>
            <div className="library-list">
              {sessions.length === 0 ? (
                <article className="feature-card">
                  <p className="empty-copy">No history yet.</p>
                </article>
              ) : (
                sessions.map((session) => (
                  <button key={session.id} type="button" className="library-card" onClick={() => openSession(session.id)}>
                    <div className="library-card-top">
                      <strong>{session.title ?? "Untitled chat"}</strong>
                      <span>{formatRelativeTime(session.lastMessageAt)}</span>
                    </div>
                    <p>{session.lastMessagePreview ?? "No messages yet."}</p>
                  </button>
                ))
              )}
            </div>
          </div>

          <aside className="profile-sidecard">
            <h2 className="section-title">Areas</h2>
            <div className="tag-cloud">
              {["Public Domain", "Comparative Reading", "Theme Tracking", "Long Search", "Corpus Notes"].map((tag) => (
                <span key={tag} className="tag-chip">
                  {tag}
                </span>
              ))}
            </div>
          </aside>
        </section>
      </div>
    );
  }

  function renderMainView() {
    switch (activeView) {
      case "explore":
        return renderExploreView();
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
    <div className={`app-shell ${mobileNavOpen ? "is-nav-open" : ""}`}>
      <button
        type="button"
        className={`shell-backdrop ${mobileNavOpen ? "is-open" : ""}`}
        aria-label="Close navigation"
        onClick={() => setMobileNavOpen(false)}
      />

      <aside className={`sidebar ${mobileNavOpen ? "is-open" : ""}`} data-testid="sidebar">
        <div className="sidebar-header">
          <div className="brand-lockup">
            <span className="wordmark">alphabook</span>
            <button
              type="button"
              className="mobile-nav-close"
              aria-label="Close menu"
              onClick={() => setMobileNavOpen(false)}
            >
              <CloseIcon />
            </button>
          </div>
          {authState.authConfigured && !authState.user && !authState.loading ? (
            <div className="sidebar-auth-actions">
              <a className="sidebar-signin" href={buildSignInUrl(window.location.href)}>
                Sign in
              </a>
              <a className="sidebar-signin" href={buildSignUpUrl(window.location.href)}>
                Create account
              </a>
            </div>
          ) : null}
        </div>

        <nav className="sidebar-nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`sidebar-nav-button ${activeView === item.id ? "is-active" : ""}`}
                onClick={() => handleNavSelection(item.id)}
              >
                <Icon />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <button
          type="button"
          className="sidebar-profile sidebar-profile-icon"
          onClick={() => {
            setActiveView("profile");
            setMobileNavOpen(false);
          }}
          aria-label="Open profile"
          title={displayProfileName}
        >
          {currentUser?.avatarUrl ? (
            <img className="sidebar-avatar-image" src={currentUser.avatarUrl} alt={displayProfileName} />
          ) : hasAuthenticatedUser ? (
            <div className="profile-badge" style={{ ["--profile-hue" as string]: profileHue }}>
              {initialsFromSeed(displayProfileName)}
            </div>
          ) : (
            <div className="profile-badge profile-badge-neutral">
              <ProfileIcon />
            </div>
          )}
        </button>
      </aside>

      <main className={`main-panel is-${activeView}`}>
        <div className="mobile-shell-bar">
          <button
            type="button"
            className="mobile-shell-button"
            aria-label="Open navigation"
            onClick={() => setMobileNavOpen(true)}
          >
            <MenuIcon />
          </button>
          <div className="mobile-shell-meta">
            <span className="mobile-shell-wordmark">alphabook</span>
            <strong>{activeViewLabel}</strong>
          </div>
          <button
            type="button"
            className="mobile-shell-button mobile-profile-button"
            aria-label="Open profile"
            onClick={() => {
              setMobileNavOpen(false);
              setActiveView("profile");
            }}
          >
            {currentUser?.avatarUrl ? (
              <img className="sidebar-avatar-image" src={currentUser.avatarUrl} alt={displayProfileName} />
            ) : hasAuthenticatedUser ? (
              <div className="profile-badge" style={{ ["--profile-hue" as string]: profileHue }}>
                {initialsFromSeed(displayProfileName)}
              </div>
            ) : (
              <div className="profile-badge profile-badge-neutral">
                <ProfileIcon />
              </div>
            )}
          </button>
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
