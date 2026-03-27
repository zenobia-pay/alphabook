import {
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { SemanticSearchToolUI, ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  HeartIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareIcon,
} from "lucide-react";
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuiState } from "@assistant-ui/store";
import type { RunArtifactRecord } from "@/api";
import { resolveFrontendImplementation } from "@/implementation";

const AUTO_FOLLOW_THRESHOLD_PX = 96;

type AssistantEffortLevel = "semantic" | "comprehensive";

const IMPLEMENTATION = resolveFrontendImplementation();
const SITE_ORIGIN = IMPLEMENTATION.siteOrigin;
const WELCOME_HEADING = IMPLEMENTATION.assistantWelcomeHeading;
const COPY_PROMPT = `Go to ${SITE_ORIGIN}/skill.md and follow the instructions there.`;

type MessagePartRecord = {
  type?: string;
  text?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
};

function readStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function assistantMessageToMarkdown(parts: readonly MessagePartRecord[]) {
  const sections = parts.flatMap((part) => {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
      return [part.text.trim()];
    }

    if (part.type === "tool-call") {
      const args = part.args && typeof part.args === "object" ? { ...part.args } : {};
      const rationale = typeof args.__rationale === "string" ? args.__rationale : null;
      const startedLogLines = readStringList(args.__logLines);
      if ("__rationale" in args) {
        delete args.__rationale;
      }
      const progress = readStringList(args.__progress);
      if ("__progress" in args) {
        delete args.__progress;
      }
      if ("__logLines" in args) {
        delete args.__logLines;
      }
      if ("__summary" in args) {
        delete args.__summary;
      }
      const resultRecord = part.result && typeof part.result === "object" ? { ...(part.result as Record<string, unknown>) } : null;
      const completedLogLines = readStringList(resultRecord?.__logLines);
      if (resultRecord && "__logLines" in resultRecord) {
        delete resultRecord.__logLines;
      }
      if (resultRecord && "__summary" in resultRecord) {
        delete resultRecord.__summary;
      }
      const errorLine =
        typeof resultRecord?.error === "string" && resultRecord.error.trim().length > 0
          ? [resultRecord.error.trim()]
          : [];

      const toolSections = [`### Tool Call: ${part.toolName ?? "Tool"}`];
      if (rationale) {
        toolSections.push(rationale);
      }
      const toolBody = [
        ...startedLogLines,
        ...progress,
        ...completedLogLines,
        ...errorLine,
      ];
      toolSections.push(
        "```text",
        ...(toolBody.length > 0 ? toolBody : ["No tool details recorded."]),
        "```",
      );

      return [toolSections.join("\n\n")];
    }

    return [];
  });

  return sections.join("\n\n");
}

type ThreadSuggestion = {
  icon?: "search" | "heart";
  title: string;
  description?: string;
  prompt: string;
};

const suggestionIconMap = {
  search: SearchIcon,
  heart: HeartIcon,
} satisfies Record<NonNullable<ThreadSuggestion["icon"]>, typeof SearchIcon>;

const EFFORT_OPTIONS = [
  {
    value: "semantic",
    label: "Fast",
  },
  {
    value: "comprehensive",
    label: "Slow",
  },
] satisfies Array<{
  value: AssistantEffortLevel;
  label: string;
}>;

export const Thread: FC<{
  isRunning?: boolean;
  artifacts?: RunArtifactRecord[];
  showArtifacts?: boolean;
  showWelcome?: boolean;
  suggestions?: ThreadSuggestion[];
  onSuggestionSelect?: (prompt: string) => void;
  onCancel?: () => void;
  effortLevel: AssistantEffortLevel;
  onEffortLevelChange: (value: AssistantEffortLevel) => void;
  composerDisabled?: boolean;
  composerDisabledNotice?: React.ReactNode;
}> = ({
  isRunning = false,
  artifacts = [],
  showArtifacts = true,
  showWelcome = true,
  suggestions = [],
  onSuggestionSelect,
  onCancel,
  effortLevel,
  onEffortLevelChange,
  composerDisabled = false,
  composerDisabledNotice,
}) => {
  const isEmpty = useAuiState((state) => state.thread.isEmpty);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoFollowRef = useRef(true);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const handleScroll = () => {
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      shouldAutoFollowRef.current = distanceFromBottom < AUTO_FOLLOW_THRESHOLD_PX;
    };

    handleScroll();
    element.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", handleScroll);
    };
  }, []);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col bg-background"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-radius" as string]: "24px",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        turnAnchor="top"
        className="aui-thread-viewport relative flex flex-1 flex-col overflow-x-auto overflow-y-auto px-4 pt-4"
      >
        <AuiIf condition={(s) => s.thread.isEmpty && showWelcome && !isRunning}>
          <ThreadWelcome />
        </AuiIf>

        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
          }}
        />

        <ThreadAutoFollow active={isRunning} viewportRef={viewportRef} shouldAutoFollowRef={shouldAutoFollowRef} />

        {showArtifacts && artifacts.length > 0 ? <ThreadArtifacts artifacts={artifacts} /> : null}

        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-3 overflow-visible pb-3 md:pb-4">
          <ThreadScrollToBottom />
          <Composer
            isRunning={isRunning}
            onCancel={onCancel}
            effortLevel={effortLevel}
            onEffortLevelChange={onEffortLevelChange}
            disabled={composerDisabled}
            notice={composerDisabledNotice}
          />
          {showWelcome && isEmpty && !isRunning && suggestions.length > 0 ? (
            <ThreadSuggestions suggestions={suggestions} onSuggestionSelect={onSuggestionSelect} disabled={composerDisabled} />
          ) : null}
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadArtifacts: FC<{
  artifacts: RunArtifactRecord[];
}> = ({ artifacts }) => {
  const visibleArtifacts = useMemo(() => selectVisibleArtifacts(artifacts), [artifacts]);

  if (visibleArtifacts.length === 0) {
    return null;
  }

  return (
    <section className="assistant-artifact-strip" aria-label="Run files">
      {visibleArtifacts.map((artifact) => (
        <ArtifactChip
          key={`${artifact.r2Key ?? artifact.filename}-${artifact.createdAt ?? ""}`}
          artifact={artifact}
        />
      ))}
    </section>
  );
};

function selectVisibleArtifacts(artifacts: RunArtifactRecord[]) {
  const relevant = artifacts.filter((artifact) => {
    const kind = typeof artifact.metadata?.kind === "string" ? artifact.metadata.kind : "";
    return (
      artifact.filename === "briefing.md"
      || artifact.filename === "every-single-reference.md"
      || artifact.filename === "evidence-notes.md"
      || kind === "reference_file"
    );
  });

  const byFilename = new Map<string, RunArtifactRecord>();
  for (const artifact of relevant) {
    if (!byFilename.has(artifact.filename)) {
      byFilename.set(artifact.filename, artifact);
    }
  }

  const priority = new Map<string, number>([
    ["briefing.md", 0],
    ["every-single-reference.md", 1],
    ["evidence-notes.md", 2],
  ]);

  return [...byFilename.values()].sort((left, right) => {
    const leftPriority = priority.get(left.filename) ?? 10;
    const rightPriority = priority.get(right.filename) ?? 10;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.filename.localeCompare(right.filename);
  });
}

const ArtifactChip: FC<{
  artifact: RunArtifactRecord;
}> = ({ artifact }) => {
  const title =
    typeof artifact.metadata?.title === "string"
      ? artifact.metadata.title
      : artifact.filename === "briefing.md"
        ? "Briefing"
        : artifact.filename === "evidence-notes.md"
          ? "Search Notes"
          : artifact.filename;
  const content = typeof artifact.content === "string" ? artifact.content.trim() : "";

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="assistant-artifact-chip">
          <FileTextIcon className="assistant-artifact-chip-icon" />
          <span className="assistant-artifact-chip-label">{title}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="assistant-artifact-dialog">
        <DialogHeader className="assistant-artifact-dialog-header">
          <DialogTitle>{title}</DialogTitle>
          <div className="assistant-artifact-dialog-meta">{artifact.filename}</div>
        </DialogHeader>
        {content ? (
          <pre className="assistant-artifact-dialog-content">{content}</pre>
        ) : (
          <div className="assistant-artifact-dialog-empty">Stored in R2 for this run.</div>
        )}
      </DialogContent>
    </Dialog>
  );
};

const ThreadAutoFollow: FC<{
  active: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  shouldAutoFollowRef: React.MutableRefObject<boolean>;
}> = ({
  active,
  viewportRef,
  shouldAutoFollowRef,
}) => {
  const messages = useAuiState((state) => state.thread.messages);

  useEffect(() => {
    if (!active || !viewportRef.current || !shouldAutoFollowRef.current) {
      return;
    }
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
  }, [active, messages, viewportRef, shouldAutoFollowRef]);

  return null;
};

const TOOL_PART_COMPONENTS = {
  Text: MarkdownText,
  tools: {
    by_name: {
      semantic_deep_search: SemanticSearchToolUI,
      "Semantic Search": SemanticSearchToolUI,
    },
    Fallback: ToolFallback,
  },
} as const;

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        side="top"
        variant="outline"
        className="aui-thread-scroll-to-bottom absolute -top-10 z-10 self-center rounded-full p-3 disabled:invisible dark:border-border dark:bg-background dark:hover:bg-accent"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  const [copied, setCopied] = useState(false);

  const handleCopyPrompt = useCallback(() => {
    void navigator.clipboard.writeText(COPY_PROMPT).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, []);

  return (
    <div data-testid="empty-state" className="aui-thread-welcome-root mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col">
      <div className="aui-thread-welcome-center flex w-full grow flex-col items-center justify-center">
        <div className="aui-thread-welcome-message flex size-full flex-col justify-center px-4">
          <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both font-semibold text-2xl duration-200">
            {WELCOME_HEADING}
          </h1>
          <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-base text-muted-foreground/70 delay-75 duration-200">
            Or: Want your agent to use this? Copy{" "}
            <button
              type="button"
              className="aui-thread-welcome-copy-button"
              onClick={handleCopyPrompt}
              aria-label="Copy agent setup prompt"
            >
              <span className="aui-thread-welcome-copy-button-text">
                {copied ? "copied prompt" : "this prompt"}
              </span>
              <span aria-hidden="true" className="aui-thread-welcome-copy-button-emoji">
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              </span>
            </button>
            .
          </p>
        </div>
      </div>
    </div>
  );
};

const ThreadSuggestions: FC<{
  suggestions: ThreadSuggestion[];
  onSuggestionSelect?: (prompt: string) => void;
  disabled?: boolean;
}> = ({
  suggestions,
  onSuggestionSelect,
  disabled = false,
}) => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-col items-start gap-2 pb-4">
      {suggestions.map((suggestion) => (
        <ThreadSuggestionItem
          key={suggestion.prompt}
          suggestion={suggestion}
          onSuggestionSelect={onSuggestionSelect}
          disabled={disabled}
        />
      ))}
    </div>
  );
};

const ThreadSuggestionItem: FC<{
  suggestion: ThreadSuggestion;
  onSuggestionSelect?: (prompt: string) => void;
  disabled?: boolean;
}> = ({
  suggestion,
  onSuggestionSelect,
  disabled = false,
}) => {
  const aui = useAui();
  const SuggestionIcon = suggestion.icon ? suggestionIconMap[suggestion.icon] : SearchIcon;

  const handleClick = useCallback(() => {
    if (disabled) {
      return;
    }
    aui.composer().setText(suggestion.prompt);
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLTextAreaElement>("[aria-label='Message input']");
      input?.focus();
      const cursorPosition = suggestion.prompt.length;
      input?.setSelectionRange(cursorPosition, cursorPosition);
    });
    onSuggestionSelect?.(suggestion.prompt);
  }, [aui, disabled, onSuggestionSelect, suggestion.prompt]);

  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 nth-[n+3]:hidden @md:nth-[n+3]:block w-full animate-in fill-mode-both duration-200 @md:w-[72%]">
      <Button
        type="button"
        variant="ghost"
        className="aui-thread-welcome-suggestion h-auto w-full min-w-0 items-center justify-start gap-2.5 overflow-hidden rounded-full border px-4 py-2.5 text-left text-sm transition-colors"
        onClick={handleClick}
        disabled={disabled}
      >
        <span className="aui-thread-welcome-suggestion-icon shrink-0" aria-hidden="true">
          <SuggestionIcon className="size-3.5" />
        </span>
        <span className="aui-thread-welcome-suggestion-text-1 min-w-0 truncate font-medium">{suggestion.title}</span>
        {suggestion.description ? (
          <span className="aui-thread-welcome-suggestion-text-2 sr-only">{suggestion.description}</span>
        ) : null}
      </Button>
    </div>
  );
};

const Composer: FC<{
  isRunning?: boolean;
  onCancel?: () => void;
  effortLevel: AssistantEffortLevel;
  onEffortLevelChange: (value: AssistantEffortLevel) => void;
  disabled?: boolean;
  notice?: React.ReactNode;
}> = ({ isRunning = false, onCancel, effortLevel, onEffortLevelChange, disabled = false, notice }) => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="composer-shell"
          className="flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-background p-(--composer-padding) transition-shadow focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/20 data-[dragging=true]:border-ring data-[dragging=true]:border-dashed data-[dragging=true]:bg-accent/50"
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder="Send a message..."
            className="aui-composer-input max-h-28 min-h-8 w-full resize-none bg-transparent px-1.5 py-0.5 text-[0.98rem] leading-6 outline-none placeholder:text-muted-foreground/80"
            rows={1}
            autoFocus
            aria-label="Message input"
            disabled={isRunning || disabled}
          />
          <ComposerAction
            isRunning={isRunning}
            onCancel={onCancel}
            effortLevel={effortLevel}
            onEffortLevelChange={onEffortLevelChange}
            disabled={disabled}
          />
          {disabled && notice ? <div className="aui-composer-disabled-note px-1.5 pb-1 text-sm text-muted-foreground">{notice}</div> : null}
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<{
  isRunning?: boolean;
  onCancel?: () => void;
  effortLevel: AssistantEffortLevel;
  onEffortLevelChange: (value: AssistantEffortLevel) => void;
  disabled?: boolean;
}> = ({
  isRunning = false,
  onCancel,
  effortLevel,
  onEffortLevelChange,
  disabled = false,
}) => {
  const [isEffortMenuOpen, setIsEffortMenuOpen] = useState(false);
  const effortMenuRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = EFFORT_OPTIONS.find((option) => option.value === effortLevel) ?? EFFORT_OPTIONS[0];

  useEffect(() => {
    if (!isEffortMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!effortMenuRef.current?.contains(event.target as Node)) {
        setIsEffortMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsEffortMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isEffortMenuOpen]);

  useEffect(() => {
    if (isRunning || disabled) {
      setIsEffortMenuOpen(false);
    }
  }, [disabled, isRunning]);

  return (
    <div className="aui-composer-action-wrapper relative flex items-center gap-2">
      <div className="relative ml-1 shrink-0" ref={effortMenuRef}>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            "h-8 min-w-24 rounded-full border border-transparent bg-neutral-100/95 px-3 text-left shadow-none transition hover:bg-neutral-200/90 disabled:bg-neutral-100/70",
            isEffortMenuOpen && "bg-neutral-200/95",
          )}
          aria-label="Effort level"
          aria-haspopup="listbox"
          aria-expanded={isEffortMenuOpen}
          disabled={isRunning || disabled}
          onClick={() => setIsEffortMenuOpen((open) => !open)}
        >
          <span className="flex w-full items-center gap-2">
            <span className="truncate text-[0.82rem] font-medium leading-none text-foreground">{selectedOption.label}</span>
            <ChevronDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
          </span>
        </Button>
        {isEffortMenuOpen ? (
          <div
            className="absolute bottom-full left-0 z-30 mb-2 min-w-44 overflow-hidden rounded-3xl border border-black/12 bg-white/98 p-1.5 shadow-[0_14px_36px_rgba(15,23,42,0.12)] backdrop-blur-xl"
            role="listbox"
            aria-label="Effort options"
          >
            <div className="px-2.5 pb-1.5 pt-1 text-[0.8rem] font-medium text-muted-foreground">
              Select reasoning
            </div>
            {EFFORT_OPTIONS.map((option) => {
              const isSelected = option.value === effortLevel;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition",
                    isSelected ? "bg-neutral-100 text-foreground" : "text-foreground hover:bg-neutral-50",
                  )}
                  onClick={() => {
                    onEffortLevelChange(option.value);
                    setIsEffortMenuOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 text-[0.95rem] font-medium leading-none">{option.label}</span>
                  {isSelected ? <CheckIcon className="size-3.5 shrink-0" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <AuiIf condition={() => !isRunning}>
        <ComposerPrimitive.Send asChild>
          <TooltipIconButton
            tooltip="Send message"
            side="top"
            type="button"
            variant="ghost"
            size="icon"
            className="aui-composer-send ml-auto size-8 rounded-full !bg-black !text-white hover:!bg-neutral-800"
            aria-label="Send message"
            disabled={isRunning || disabled}
          >
            <ArrowUpIcon className="aui-composer-send-icon size-4" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={() => isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <Button
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-cancel ml-auto size-8 rounded-full"
            aria-label="Stop generating"
            onClick={onCancel}
          >
            <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
          </Button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive text-sm dark:bg-destructive/5 dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  const phase = useAuiState((state) => {
    const metadata = state.message.metadata;
    const custom = metadata && typeof metadata === "object" && "custom" in metadata
      ? metadata.custom as Record<string, unknown>
      : null;
    return typeof custom?.phase === "string" ? custom.phase : null;
  });
  const isErrorMessage = phase === "error";

  return (
    <MessagePrimitive.Root
      className="aui-assistant-message-root fade-in slide-in-from-bottom-1 relative mx-auto w-full max-w-(--thread-max-width) animate-in py-3 duration-150"
      data-role="assistant"
      data-error-message={isErrorMessage ? "true" : "false"}
    >
      <div className="aui-assistant-message-content wrap-break-word px-2 text-foreground leading-relaxed">
        <MessagePrimitive.Parts components={TOOL_PART_COMPONENTS} />
        <MessageError />
      </div>

      <div className="aui-assistant-message-footer mt-1 ml-2 flex min-h-6 items-center">
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  const parts = useAuiState((s) => s.message.content) as MessagePartRecord[];
  const isRunning = useAuiState((s) => s.message.status?.type === "running");
  const [isCopied, setIsCopied] = useState(false);
  const markdown = useMemo(() => assistantMessageToMarkdown(parts), [parts]);

  const handleCopy = useCallback(() => {
    if (!markdown) {
      return;
    }
    void navigator.clipboard.writeText(markdown).then(() => {
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), 3000);
    });
  }, [markdown]);

  const handleExport = useCallback(() => {
    if (!markdown) {
      return;
    }
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `message-${Date.now()}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }, [markdown]);

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root col-start-3 row-start-2 -ml-1 flex gap-1 text-muted-foreground"
    >
      <TooltipIconButton tooltip="Copy" onClick={handleCopy} disabled={!markdown || isRunning}>
          <AuiIf condition={() => isCopied}>
            <CheckIcon />
          </AuiIf>
          <AuiIf condition={() => !isCopied}>
            <CopyIcon />
          </AuiIf>
      </TooltipIconButton>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Refresh">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          className="aui-action-bar-more-content z-50 min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <ActionBarMorePrimitive.Item
            className="aui-action-bar-more-item flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50"
            onSelect={handleExport}
            data-disabled={!markdown || isRunning ? "true" : undefined}
          >
              <DownloadIcon className="size-4" />
              Export as Markdown
          </ActionBarMorePrimitive.Item>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="aui-user-message-root fade-in slide-in-from-bottom-1 mx-auto grid w-full max-w-(--thread-max-width) animate-in auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 py-3 duration-150 [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content wrap-break-word rounded-2xl bg-muted px-4 py-2.5 text-foreground">
          <MessagePrimitive.Parts />
        </div>
      </div>

      <BranchPicker className="aui-user-branch-picker col-span-full col-start-1 row-start-3 -mr-1 justify-end" />
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root mr-2 -ml-2 inline-flex items-center text-muted-foreground text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
