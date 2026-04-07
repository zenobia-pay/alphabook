import {
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { SemanticSearchToolUI, ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

type PlanToolTraceRecord = {
  id?: string;
  label?: string;
  rationale?: string;
  progress?: string[];
  result?: Record<string, unknown>;
  state?: "running" | "completed" | "error";
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

function readPlanToolTrace(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is PlanToolTraceRecord => Boolean(entry) && typeof entry === "object");
}

function summarizePlanToolLine(entry: PlanToolTraceRecord) {
  const progress = Array.isArray(entry.progress)
    ? entry.progress.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const latestProgress = progress.length > 0 ? progress[progress.length - 1] : "";
  const rationale = typeof entry.rationale === "string" ? entry.rationale.trim() : "";
  const error =
    entry.result && typeof entry.result.error === "string" && entry.result.error.trim().length > 0
      ? entry.result.error.trim()
      : "";
  const label = typeof entry.label === "string" && entry.label.trim().length > 0 ? entry.label.trim() : "Step";

  if (error) {
    return `${label} — ${error}`;
  }
  if (latestProgress) {
    return `${label} — ${latestProgress}`;
  }
  if (rationale) {
    return `${label} — ${rationale}`;
  }
  if (entry.state === "completed") {
    return `${label} — Completed`;
  }
  if (entry.state === "error" || entry.isError) {
    return `${label} — Failed`;
  }
  return `${label} — Running`;
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

export const Thread: FC<{
  isRunning?: boolean;
  artifacts?: RunArtifactRecord[];
  showArtifacts?: boolean;
  showWelcome?: boolean;
  suggestions?: ThreadSuggestion[];
  onSuggestionSelect?: (prompt: string) => void;
  onCancel?: () => void;
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
      <div className="assistant-thread-layout">
        <ThreadPrimitive.Viewport
          ref={viewportRef}
          turnAnchor="top"
          className="aui-thread-viewport assistant-thread-main relative flex flex-1 flex-col overflow-x-auto overflow-y-auto px-4 pt-4"
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

          <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-3 overflow-visible pb-3 md:pb-4">
            <ThreadScrollToBottom />
            <Composer
              isRunning={isRunning}
              onCancel={onCancel}
              disabled={composerDisabled}
              notice={composerDisabledNotice}
            />
            {showWelcome && isEmpty && !isRunning && suggestions.length > 0 ? (
              <ThreadSuggestions suggestions={suggestions} onSuggestionSelect={onSuggestionSelect} disabled={composerDisabled} />
            ) : null}
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>

        {showArtifacts && artifacts.length > 0 ? <ThreadOutputs artifacts={artifacts} /> : null}
      </div>
    </ThreadPrimitive.Root>
  );
};

const ThreadOutputs: FC<{
  artifacts: RunArtifactRecord[];
}> = ({ artifacts }) => {
  const visibleArtifacts = useMemo(() => selectVisibleArtifacts(artifacts), [artifacts]);
  const [isExpanded, setIsExpanded] = useState(false);

  if (visibleArtifacts.length === 0) {
    return null;
  }

  const handleOpenArtifact = useCallback((artifact: RunArtifactRecord) => {
    const content = typeof artifact.content === "string" ? artifact.content : "";
    if (!content.trim()) {
      return;
    }
    const blob = new Blob([content], { type: artifact.mimeType || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);

  return (
    <aside className={cn("assistant-outputs-rail", isExpanded && "is-expanded")} aria-label="Outputs">
      <button
        type="button"
        className="assistant-outputs-toggle"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((current) => !current)}
      >
        <span className="assistant-outputs-toggle-copy">
          <span className="assistant-outputs-label">Outputs</span>
          <span className="assistant-outputs-count">{visibleArtifacts.length}</span>
        </span>
        <ChevronDownIcon className="assistant-outputs-toggle-icon" />
      </button>
      <div className="assistant-outputs-list" role="list">
        {visibleArtifacts.map((artifact) => {
          const disabled = typeof artifact.content !== "string" || artifact.content.trim().length === 0;
          return (
            <button
              key={`${artifact.r2Key ?? artifact.filename}-${artifact.createdAt ?? ""}`}
              type="button"
              className="assistant-output-link"
              role="listitem"
              onClick={() => handleOpenArtifact(artifact)}
              disabled={disabled}
              title={disabled ? "This output is not available inline yet." : artifact.filename}
            >
              <FileTextIcon className="assistant-output-link-icon" />
              <span className="assistant-output-link-name">{formatArtifactLabel(artifact, visibleArtifacts)}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
};

function selectVisibleArtifacts(artifacts: RunArtifactRecord[]) {
  const byFilename = new Map<string, RunArtifactRecord>();
  for (const artifact of artifacts) {
    if (!isVisibleOutputArtifact(artifact)) {
      continue;
    }
    if (!byFilename.has(artifact.filename)) {
      byFilename.set(artifact.filename, artifact);
    }
  }

  const priority = new Map<string, number>([
    ["inner/briefing.md", 0],
    ["briefing.md", 0],
    ["inner/dataset.csv", 1],
    ["dataset.csv", 1],
    ["inner/citation-index.json", 2],
    ["citation-index.json", 2],
    ["wrapper/archive-manifest.json", 3],
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

function isVisibleOutputArtifact(artifact: RunArtifactRecord) {
  const kind = typeof artifact.metadata?.kind === "string" ? artifact.metadata.kind.trim() : "";
  if (kind === "tool_stream_raw" || kind === "research_document" || kind === "hermes_archive_manifest") {
    return false;
  }
  const normalized = artifact.filename.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.endsWith("tool-stream.jsonl") || normalized.endsWith("archive-manifest.json")) {
    return false;
  }
  return true;
}

function formatArtifactLabel(artifact: RunArtifactRecord, artifacts: RunArtifactRecord[]) {
  const filename = artifact.filename.trim();
  const base = filename.split("/").at(-1) ?? filename;
  const duplicateBaseCount = artifacts.filter((candidate) => {
    const candidateBase = candidate.filename.trim().split("/").at(-1) ?? candidate.filename.trim();
    return candidateBase === base;
  }).length;
  return duplicateBaseCount > 1 ? filename : base;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  disabled?: boolean;
  notice?: React.ReactNode;
}> = ({ isRunning = false, onCancel, disabled = false, notice }) => {
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
  disabled?: boolean;
}> = ({
  isRunning = false,
  onCancel,
  disabled = false,
}) => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center gap-2">
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
  const isRunning = useAuiState((state) => state.message.status?.type === "running");
  const hasVisibleParts = useAuiState((state) => state.message.content.some((part) => {
    if (!part || typeof part !== "object") {
      return false;
    }
    if ("type" in part && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
      return true;
    }
    if ("type" in part && part.type === "tool-call") {
      return true;
    }
    return false;
  }));
  const phase = useAuiState((state) => {
    const metadata = state.message.metadata;
    const custom = metadata && typeof metadata === "object" && "custom" in metadata
      ? metadata.custom as Record<string, unknown>
      : null;
    return typeof custom?.phase === "string" ? custom.phase : null;
  });
  const experimentProposalJson = useAuiState((state) => {
    const metadata = state.message.metadata;
    const custom = metadata && typeof metadata === "object" && "custom" in metadata
      ? metadata.custom as Record<string, unknown>
      : null;
    const proposal = custom?.experimentProposal && typeof custom.experimentProposal === "object"
      ? custom.experimentProposal as Record<string, unknown>
      : null;
    if (
      !proposal
      || typeof proposal.title !== "string"
      || typeof proposal.summary !== "string"
      || typeof proposal.approvalPrompt !== "string"
    ) {
      return null;
    }
    return JSON.stringify({
      title: proposal.title,
      summary: proposal.summary,
      approvalPrompt: proposal.approvalPrompt,
    });
  });
  const experimentProposal = useMemo(() => (
    experimentProposalJson
      ? JSON.parse(experimentProposalJson) as {
          title: string;
          summary: string;
          approvalPrompt: string;
        }
      : null
  ), [experimentProposalJson]);
  const isErrorMessage = phase === "error";
  const progressText = useAuiState((state) => {
    if (phase !== "progress") {
      return "";
    }
    const textParts = state.message.content.flatMap((part) => {
      if (part && typeof part === "object" && "type" in part && part.type === "text" && typeof part.text === "string") {
        return [part.text];
      }
      return [];
    });
    return textParts.join("\n\n").trim();
  });
  const rawPlanToolTrace = useAuiState((state) => {
    const metadata = state.message.metadata;
    const custom = metadata && typeof metadata === "object" && "custom" in metadata
      ? metadata.custom as Record<string, unknown>
      : null;
    return custom?.toolCalls;
  });
  const planToolTrace = useMemo(() => readPlanToolTrace(rawPlanToolTrace), [rawPlanToolTrace]);
  const hasPlanToolTrace = phase === "plan" && planToolTrace.length > 0;

  return (
    <MessagePrimitive.Root
      className="aui-assistant-message-root fade-in slide-in-from-bottom-1 relative mx-auto w-full max-w-(--thread-max-width) animate-in py-3 duration-150"
      data-role="assistant"
      data-error-message={isErrorMessage ? "true" : "false"}
      data-running-message={isRunning ? "true" : "false"}
    >
      <div className="aui-assistant-message-content wrap-break-word px-2 text-foreground leading-relaxed">
        {phase === "progress" ? <ProgressMessageCard text={progressText} /> : <MessagePrimitive.Parts components={TOOL_PART_COMPONENTS} />}
        {hasPlanToolTrace ? <PlanToolTraceCard trace={planToolTrace} isRunning={isRunning} detailText={progressText} /> : null}
        {experimentProposal ? <ExperimentApprovalCard proposal={experimentProposal} disabled={isRunning} /> : null}
        {isRunning && !hasVisibleParts && !experimentProposal ? (
          <div className="aui-assistant-running-indicator" aria-label="Assistant is thinking">
            <span className="aui-assistant-running-indicator-dot" aria-hidden="true" />
          </div>
        ) : null}
        <MessageError />
      </div>

      <div className="aui-assistant-message-footer mt-1 ml-2 flex min-h-6 items-center">
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const ProgressMessageCard: FC<{
  text: string;
}> = ({ text }) => {
  return (
    <section className="aui-agentic-trace" aria-label="Agentic Search run">
      <div className="aui-agentic-trace-header is-static">
        <div className="aui-agentic-trace-heading">
          <div className="aui-agentic-trace-title-row">
            <span className="aui-agentic-trace-title">Agentic Search</span>
            <span className="aui-agentic-trace-spinner" aria-hidden="true" />
            <span className="aui-agentic-trace-status">In Progress</span>
            {text.trim().length > 0 ? <DetailedRunOutputButton text={text} /> : null}
          </div>
        </div>
      </div>
    </section>
  );
};

const DetailedRunOutputButton: FC<{
  text: string;
}> = ({ text }) => {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="aui-progress-link-button">
          View detailed run output
        </button>
      </DialogTrigger>
      <DialogContent className="aui-run-output-dialog">
        <DialogTitle className="aui-run-output-dialog-title">
          Detailed Run Output
        </DialogTitle>
        <div className="aui-run-output-dialog-body">
          <pre className="aui-run-output-dialog-pre">{text}</pre>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const PlanToolTraceCard: FC<{
  trace: PlanToolTraceRecord[];
  isRunning: boolean;
  detailText?: string;
}> = ({ trace, isRunning, detailText = "" }) => {
  const [collapsed, setCollapsed] = useState(false);
  const lines = useMemo(
    () => trace.map((entry) => summarizePlanToolLine(entry)).filter((line) => line),
    [trace],
  );
  const statusLabel = trace.some((entry) => entry.state === "error" || entry.isError)
    ? "Failed"
    : isRunning || trace.some((entry) => entry.state === "running")
      ? "In Progress"
      : "Completed";

  return (
    <section className="aui-agentic-trace" aria-label="Agentic Search run">
      <button
        type="button"
        className="aui-agentic-trace-header"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((current) => !current)}
      >
        <div className="aui-agentic-trace-heading">
          <div className="aui-agentic-trace-title-row">
            <span className="aui-agentic-trace-title">Agentic Search</span>
            {statusLabel === "In Progress" ? <span className="aui-agentic-trace-spinner" aria-hidden="true" /> : null}
            <span className={cn(
              "aui-agentic-trace-status",
              statusLabel === "Failed" && "is-error",
              statusLabel === "Completed" && "is-complete",
            )}
            >
              {statusLabel}
            </span>
            {detailText.trim().length > 0 ? (
              <span
                className="aui-agentic-trace-inline-action"
                onClick={(event) => event.stopPropagation()}
              >
                <DetailedRunOutputButton text={detailText} />
              </span>
            ) : null}
          </div>
        </div>
        <ChevronDownIcon className={cn("aui-agentic-trace-chevron", !collapsed && "is-open")} />
      </button>
      {!collapsed ? (
        <div className="aui-agentic-trace-body">
          <div className="aui-agentic-trace-lines" role="list">
            {lines.map((line, index) => (
              <div key={`${index}-${line.slice(0, 48)}`} className="aui-agentic-trace-line" role="listitem">
                <span className="aui-agentic-trace-line-dot" aria-hidden="true" />
                <span className="aui-agentic-trace-line-text">{line}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
};


const ExperimentApprovalCard: FC<{
  proposal: {
    title: string;
    summary: string;
    approvalPrompt: string;
  };
  disabled?: boolean;
}> = ({ proposal, disabled = false }) => {
  const handleApprove = useCallback(() => {
    window.dispatchEvent(new CustomEvent("alphabook:approve-experiment", {
      detail: {
        displayText: `Approve experiment: ${proposal.title}`,
        transportMessage: proposal.approvalPrompt,
      },
    }));
  }, [proposal.approvalPrompt, proposal.title]);

  return (
    <Card className="mt-4 border-black/10 bg-neutral-50/90 shadow-none">
      <CardContent className="space-y-3 p-4">
        <div>
          <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Approval required</div>
          <h3 className="mt-1 text-base font-semibold text-foreground">{proposal.title}</h3>
        </div>
        <div className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">{proposal.summary}</div>
        <div className="flex justify-end">
          <Button type="button" onClick={handleApprove} disabled={disabled}>
            Approve
          </Button>
        </div>
      </CardContent>
    </Card>
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
