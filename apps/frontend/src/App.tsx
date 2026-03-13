import { type ComponentType, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  makeAssistantToolUI,
  useExternalStoreRuntime,
  useMessage,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { Thread } from "@assistant-ui/react-ui";
import type { ReadonlyJSONObject, ReadonlyJSONValue } from "assistant-stream/utils";

import { getToolLabel, type ChatSessionSummary, type Citation, type MessageRecord, type UserProfile } from "@alphabook/shared";

import { buildSignInUrl, buildSignOutUrl, buildSignUpUrl, fetchCurrentUser, fetchMessages, fetchSessions, streamChat } from "./api";

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

const USER_STORAGE_KEY = "alphabook.localUserId";

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

function toolStatusLabel(entry: Pick<ToolTraceEntry, "state">) {
  switch (entry.state) {
    case "running":
      return "Working";
    case "error":
      return "Failed";
    default:
      return "Done";
  }
}

function summarizeToolCall(entry: Pick<ToolTraceEntry, "toolName" | "args">) {
  if (typeof entry.args.query === "string" && entry.args.query.trim()) {
    return entry.args.query;
  }
  if (typeof entry.args.path === "string" && entry.args.path.trim()) {
    return entry.args.path;
  }
  if (Array.isArray(entry.args.workIds) && entry.args.workIds.length > 0) {
    return `${entry.args.workIds.length} work${entry.args.workIds.length === 1 ? "" : "s"}`;
  }
  if (Array.isArray(entry.args.chunkIds) && entry.args.chunkIds.length > 0) {
    return `${entry.args.chunkIds.length} chunk${entry.args.chunkIds.length === 1 ? "" : "s"}`;
  }
  if (entry.toolName === "run_workspace_task" && entry.args.taskSpec && typeof entry.args.taskSpec === "object") {
    const taskSpec = entry.args.taskSpec as Record<string, unknown>;
    if (typeof taskSpec.goal === "string") {
      return taskSpec.goal;
    }
    if (typeof taskSpec.query === "string") {
      return taskSpec.query;
    }
  }
  return "";
}

function toolFallbackLabel(toolName: string) {
  return getToolLabel(toolName);
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

function messageToThreadMessage(message: UiMessage, streamingAssistantId: string | null, isSending: boolean) {
  const metadata = {
    custom: {
      citations: message.citations,
    },
  };

  if (message.role === "assistant") {
    const content = [
      ...message.toolCalls.map((entry) => {
        const args = toReadonlyJsonObject(entry.args);
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
      }),
      ...(message.content
        ? [
            {
              type: "text" as const,
              text: message.content,
            },
          ]
        : []),
    ];

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

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 17.5V20h2.5L18.7 7.8l-2.5-2.5L4 17.5Z" />
      <path d="M14.8 4.7 17.3 2.2a1.6 1.6 0 0 1 2.2 0l2.3 2.3a1.6 1.6 0 0 1 0 2.2l-2.5 2.5-4.5-4.5Z" />
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
  const label = toolFallbackLabel(toolName);
  const state =
    status.type === "running" || result === undefined ? "running" : isError || status.type === "incomplete" ? "error" : "completed";
  const detail = summarizeToolCall({ toolName, args });

  return (
    <div className={`tool-call-card is-${state}`}>
      <div className="tool-call-card-header">
        <span className="tool-call-state">{toolStatusLabel({ state })}</span>
        <strong>{label}</strong>
      </div>
      {detail ? <p className="tool-call-detail">{detail}</p> : null}
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

  function Welcome() {
    return <AssistantWelcome isSending={isSending} onPrompt={onPrompt} />;
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        assistantAvatar={{ fallback: "A" }}
        tools={TOOL_UIS}
        components={{ ThreadWelcome: Welcome }}
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
  const [guestUserId] = useState(() => ensureLocalUserId());
  const [authState, setAuthState] = useState<AuthState>({
    loading: true,
    authConfigured: false,
    user: null,
    error: null,
  });
  const [activeView, setActiveView] = useState<ViewMode>("assistant");
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null | undefined>(undefined);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
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
  const recentSessions = useMemo(() => sessions.slice(0, 5), [sessions]);
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
  }, [selectedSessionId]);

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
    const assistantMessageId = crypto.randomUUID();
    const assistantMessage: UiMessage = {
      id: assistantMessageId,
      sessionId: initialSessionId ?? "pending",
      role: "assistant",
      content: "",
      metadata: {},
      createdAt: new Date().toISOString(),
      citations: [],
      toolCalls: [],
    };

    setActiveView("assistant");
    setIsSending(true);
    setLoadError(null);
    setStreamingAssistantId(assistantMessageId);
    setMessages((current) => [...current, userMessage, assistantMessage]);

    const runToken = activeRunTokenRef.current + 1;
    activeRunTokenRef.current = runToken;
    let workingSessionId = initialSessionId;
    let activityLog: ToolTraceEntry[] = [];

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
                  message.id === userMessage.id || message.id === assistantMessageId
                    ? { ...message, sessionId: createdSessionId }
                    : message,
                ),
              );
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
                  args: event.data.args && typeof event.data.args === "object" ? (event.data.args as Record<string, unknown>) : {},
                  state: "running",
                },
              ];
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantMessageId
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
                      result: event.data.result && typeof event.data.result === "object" ? (event.data.result as Record<string, unknown>) : undefined,
                      isError: event.data.status === "failed",
                      state: event.data.status === "failed" ? "error" : "completed",
                    }
                  : entry,
              );
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantMessageId
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
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantMessageId
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
              setMessages((current) =>
                current.map((message) =>
                  message.id === assistantMessageId
                    ? {
                        ...message,
                        citations: Array.isArray(event.data.citations) ? (event.data.citations as Citation[]) : [],
                        toolCalls: activityLog,
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
    return (
      <section className="assistant-page">
        {loadError ? <div className="thread-error-banner">{loadError}</div> : null}

        <div className="assistant-thread-shell" data-testid="thread">
          {authState.loading ? <div className="session-loading">Checking your session…</div> : null}
          {!authState.loading && authLocked ? (
          <LockedState
              compact
              icon={ChatIcon}
              title="Sign in to save your threads."
              copy="Your chats and citations live on your account."
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

  function renderExploreView() {
    return (
      <div className="view-shell">
        <section className="hero-card">
          <h1>Start a thread.</h1>
          <div className="hero-actions">
            <button type="button" className="hero-button hero-button-primary" onClick={startNewChat}>
              New assistant session
            </button>
            <button
              type="button"
              className="hero-button"
              onClick={() => queuePrompt("Trace how grief and exile move across Don Quixote, Moby-Dick, and Pride and Prejudice.")}
            >
              Trace a theme
            </button>
          </div>
        </section>

        <section className="card-grid">
          <article className="feature-card">
            <h2 className="section-title">Recent</h2>
            <div className="feature-list">
              {recentSessions.length === 0 ? (
                <p className="empty-copy">Your research threads will start appearing here.</p>
              ) : (
                recentSessions.slice(0, 3).map((session) => (
                  <button key={session.id} type="button" className="feature-row" onClick={() => openSession(session.id)}>
                    <span>{session.title ?? "Untitled chat"}</span>
                    <small>{formatRelativeTime(session.lastMessageAt)}</small>
                  </button>
                ))
              )}
            </div>
          </article>

          <article className="feature-card">
            <h2 className="section-title">Try</h2>
            <div className="prompt-stack">
              {[
                "Compare obsession in Don Quixote and Moby-Dick.",
                "Find passages where characters anticipate ruin.",
                "Map the strongest books for melancholy and grief.",
              ].map((prompt) => (
                <button key={prompt} type="button" className="prompt-card" onClick={() => queuePrompt(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
          </article>
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
            copy="Saved chats and reopened runs show up here."
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
              <p className="empty-copy">Start a conversation in the assistant and it will appear here.</p>
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
            copy="History and saved sessions show up here."
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
              <h2>Recent history</h2>
            </header>
            <div className="library-list">
              {sessions.length === 0 ? (
                <article className="feature-card">
                  <p className="empty-copy">No history yet. Ask the assistant a question to start building a trail.</p>
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
          <button type="button" className="new-chat" onClick={startNewChat} aria-label="New chat">
            <PencilIcon />
            <span>New chat</span>
          </button>
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
                onClick={() => {
                  setActiveView(item.id);
                  setMobileNavOpen(false);
                }}
              >
                <Icon />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {sessions.length > 0 ? (
          <section className="sidebar-recents">
            <div className="session-list">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={`session-link ${session.id === selectedSessionId ? "is-active" : ""}`}
                  onClick={() => openSession(session.id)}
                >
                  <span className="session-title">{session.title ?? "Untitled chat"}</span>
                  <span className="session-time">{formatRelativeTime(session.lastMessageAt)}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

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
    </div>
  );
}
