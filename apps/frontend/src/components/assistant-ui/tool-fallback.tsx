"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import {
  useScrollLock,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react";
import { Citations as AlphaloopCitations, SearchProgress as AlphaloopSearchProgress } from "alphaloop/react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const ANIMATION_DURATION = 200;

type JsonRecord = Record<string, unknown>;
type ToolStatus = ToolCallMessagePartStatus["type"];
type AlphaloopProgressEvent = {
  type: string;
  query?: string;
  chunksFound?: number;
  queries?: string[];
  newChunksFound?: number;
  totalUnique?: number;
  totalChunks?: number;
  keptChunks?: number;
  droppedChunks?: number;
  iteration?: number;
  newQueries?: string[];
};
type AlphaloopChunk = {
  id: string;
  text: string;
  relevance: number;
  rationale?: string;
  metadata?: Record<string, unknown>;
};

const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

function safeObject(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function parseArgs(argsText?: string) {
  if (!argsText) {
    return null;
  }
  try {
    return safeObject(JSON.parse(argsText));
  } catch {
    return null;
  }
}

function getInternalToolName(toolName: string, args: JsonRecord | null) {
  const internalToolName = typeof args?.__toolName === "string" ? args.__toolName.trim() : "";
  if (internalToolName) {
    return internalToolName;
  }
  return toolName.trim();
}

function isSemanticTool(toolName: string, args: JsonRecord | null) {
  const normalized = getInternalToolName(toolName, args).toLowerCase();
  return normalized === "semantic_deep_search" || normalized === "semantic search";
}

function getProgressLines(args: JsonRecord | null) {
  const progress = args?.__progress;
  if (!Array.isArray(progress)) {
    return [];
  }
  return progress.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function getRationale(args: JsonRecord | null) {
  return typeof args?.__rationale === "string" && args.__rationale.trim().length > 0
    ? args.__rationale.trim()
    : null;
}

function getSummary(value: JsonRecord | null) {
  return typeof value?.__summary === "string" && value.__summary.trim().length > 0
    ? value.__summary.trim()
    : null;
}

function getErrorText(status?: ToolCallMessagePartStatus, result?: unknown) {
  if (status?.type === "incomplete") {
    if (typeof status.error === "string" && status.error.trim().length > 0) {
      return status.error.trim();
    }
    if (status.error) {
      return JSON.stringify(status.error);
    }
  }
  const record = safeObject(result);
  return typeof record?.error === "string" && record.error.trim().length > 0
    ? record.error.trim()
    : null;
}

function getNativeLogLines(source: unknown) {
  const record = safeObject(source);
  const rawLines = record?.__logLines;
  if (!Array.isArray(rawLines)) {
    return [];
  }
  return rawLines.flatMap((line): string[] => {
    if (typeof line === "string") {
      const trimmed = line.trim();
      return trimmed ? [trimmed] : [];
    }
    const entry = safeObject(line);
    if (!entry || typeof entry.value !== "string") {
      return [];
    }
    const key = typeof entry.key === "string" && entry.key.trim().length > 0 ? `${entry.key}: ` : "";
    const value = entry.value.trim();
    return value ? [`${key}${value}`] : [];
  });
}

function uniqueLines(...groups: string[][]) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const group of groups) {
    for (const line of group) {
      const trimmed = line.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      lines.push(trimmed);
    }
  }
  return lines;
}

function getAlphaloopEvents(args: JsonRecord | null, result: JsonRecord | null) {
  return (
    Array.isArray(result?.__alphaloopEvents)
      ? result.__alphaloopEvents
      : Array.isArray(args?.__alphaloopEvents)
        ? args.__alphaloopEvents
        : []
  ).filter((value): value is AlphaloopProgressEvent =>
    Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
  );
}

function getAlphaloopChunks(result: JsonRecord | null) {
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  return chunks.flatMap((value): AlphaloopChunk[] => {
    const chunk = safeObject(value);
    if (!chunk) {
      return [];
    }
    const id = typeof chunk.id === "string" ? chunk.id : null;
    const text = typeof chunk.text === "string" ? chunk.text : null;
    const relevance = typeof chunk.relevance === "number" ? chunk.relevance : null;
    if (!id || !text || relevance === null) {
      return [];
    }
    return [{
      id,
      text,
      relevance,
      ...(typeof chunk.rationale === "string" ? { rationale: chunk.rationale } : {}),
      ...(chunk.metadata && typeof chunk.metadata === "object" ? { metadata: chunk.metadata as Record<string, unknown> } : {}),
    }];
  });
}

function summarizeTool(toolName: string, args: JsonRecord | null, result: JsonRecord | null, status?: ToolCallMessagePartStatus) {
  const error = getErrorText(status, result);
  if (error) {
    return error;
  }
  const resultSummary = getSummary(result);
  if (resultSummary) {
    return resultSummary;
  }
  const argsSummary = getSummary(args);
  if (argsSummary) {
    return argsSummary;
  }
  const progress = getProgressLines(args);
  if (progress.length > 0) {
    return progress[progress.length - 1]!;
  }
  const rationale = getRationale(args);
  if (rationale) {
    return rationale;
  }
  if (isSemanticTool(toolName, args)) {
    return "Semantic search";
  }
  return "Working";
}

function ToolStatusBadge({
  status,
  result,
  hideLabel = false,
}: {
  status?: ToolCallMessagePartStatus;
  result: JsonRecord | null;
  hideLabel?: boolean;
}) {
  const statusType = status?.type ?? "complete";
  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";
  const hasError = Boolean(getErrorText(status, result));
  const Icon = hasError ? XCircleIcon : statusIconMap[statusType];
  const label = isCancelled ? "Cancelled" : hasError ? "Failed" : statusType === "running" ? "Running" : null;

  return (
    <>
      <span className={cn("aui-tool-fallback-status-shell", hasError && "aui-tool-fallback-status-shell-error")}>
        <Icon className={cn("size-3.5", statusType === "running" && "animate-spin")} />
      </span>
      {hideLabel || !label ? null : (
        <span className={cn("aui-tool-fallback-badge", hasError && "aui-tool-fallback-badge-error")}>{label}</span>
      )}
    </>
  );
}

const GenericToolUI: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
}) => {
  const [open, setOpen] = useState(status?.type === "running");
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);
  const args = useMemo(() => parseArgs(argsText), [argsText]);
  const resultObject = useMemo(() => safeObject(result), [result]);
  const summary = useMemo(() => summarizeTool(toolName, args, resultObject, status), [toolName, args, resultObject, status]);
  const rationale = useMemo(() => getRationale(args), [args]);
  const progressLines = useMemo(() => getProgressLines(args), [args]);
  const errorText = useMemo(() => getErrorText(status, result), [result, status]);
  const logLines = useMemo(
    () => uniqueLines(getNativeLogLines(args), getNativeLogLines(result)),
    [args, result],
  );
  const detailLines = useMemo(
    () => uniqueLines(
      rationale ? [rationale] : [],
      progressLines,
      logLines,
      errorText ? [errorText] : [],
    ),
    [errorText, logLines, progressLines, rationale],
  );
  const shouldShowDetail = detailLines.length > 0;

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      lockScroll();
    }
    setOpen(nextOpen);
  }, [lockScroll]);

  return (
    <Collapsible
      ref={collapsibleRef}
      open={open}
      onOpenChange={handleOpenChange}
      className="aui-tool-fallback-root group/tool-fallback-root w-full"
      style={{ ["--animation-duration" as string]: `${ANIMATION_DURATION}ms` }}
    >
      <CollapsibleTrigger
        className="aui-tool-fallback-trigger group/trigger flex w-full items-start gap-3 text-left"
      >
        <ToolStatusBadge status={status} result={resultObject} />
        <span className="min-w-0 grow">
          <span className="aui-tool-fallback-head">
            <b className="aui-tool-fallback-title">{toolName}</b>
          </span>
          <span className="aui-tool-fallback-summary">{summary}</span>
        </span>
        {shouldShowDetail ? (
          <ChevronDownIcon
            className={cn(
              "aui-tool-fallback-chevron size-4 shrink-0 transition-transform duration-(--animation-duration) ease-out",
              "group-data-[state=closed]/trigger:-rotate-90",
              "group-data-[state=open]/trigger:rotate-0",
            )}
          />
        ) : null}
      </CollapsibleTrigger>
      {shouldShowDetail ? (
        <CollapsibleContent
          className={cn(
            "aui-tool-fallback-content overflow-hidden outline-none",
            "group/collapsible-content ease-out",
            "data-[state=closed]:animate-collapsible-up",
            "data-[state=open]:animate-collapsible-down",
            "data-[state=closed]:fill-mode-forwards",
            "data-[state=closed]:pointer-events-none",
            "data-[state=open]:duration-(--animation-duration)",
            "data-[state=closed]:duration-(--animation-duration)",
          )}
        >
          <div className="aui-tool-fallback-detail-shell">
            <section className="aui-tool-section">
              <div className="aui-tool-progress-log">
                {detailLines.map((line, index) => (
                  <div
                    key={`${toolName}-${index}`}
                    className={cn("aui-tool-progress-line", errorText && line === errorText && "aui-tool-progress-line-error")}
                  >
                    <span className="aui-tool-line-value">{line}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
};

GenericToolUI.displayName = "GenericToolUI";

const SemanticSearchToolUI: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
}) => {
  const args = useMemo(() => parseArgs(argsText), [argsText]);
  const resultObject = useMemo(() => safeObject(result), [result]);
  const alphaloopEvents = useMemo(() => getAlphaloopEvents(args, resultObject), [args, resultObject]);
  const alphaloopChunks = useMemo(() => getAlphaloopChunks(resultObject), [resultObject]);
  const errorText = useMemo(() => getErrorText(status, result), [result, status]);

  return (
    <div className="py-2">
      <div className="mb-2 flex items-start gap-3">
        <ToolStatusBadge status={status} result={resultObject} hideLabel />
        <div className="min-w-0">
          <div className="aui-tool-fallback-title">{toolName}</div>
          {errorText ? <p className="aui-tool-error-text">{errorText}</p> : null}
        </div>
      </div>
      <AlphaloopSearchProgress events={alphaloopEvents} isRunning={status?.type === "running"} />
      <AlphaloopCitations chunks={alphaloopChunks} />
    </div>
  );
};

SemanticSearchToolUI.displayName = "SemanticSearchToolUI";

const ToolFallback = memo(GenericToolUI);
ToolFallback.displayName = "ToolFallback";

export {
  SemanticSearchToolUI,
  ToolFallback,
};
