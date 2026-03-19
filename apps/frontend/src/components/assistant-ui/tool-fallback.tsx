"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const ANIMATION_DURATION = 200;
const MAX_PREVIEW_ITEMS = 8;

type JsonRecord = Record<string, unknown>;
type ToolLogLine = {
  key: string;
  value: string;
  tone?: "default" | "error" | "muted";
};

type ToolStatus = ToolCallMessagePartStatus["type"];

const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

function safeObject(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function parseArgs(argsText?: string): JsonRecord | null {
  if (!argsText) {
    return null;
  }
  try {
    return safeObject(JSON.parse(argsText));
  } catch {
    return null;
  }
}

function formatValueInline(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const preview = value.slice(0, MAX_PREVIEW_ITEMS).map((item) => formatValueInline(item)).join(", ");
    return value.length > MAX_PREVIEW_ITEMS ? `${preview} (+${value.length - MAX_PREVIEW_ITEMS} more)` : preview;
  }
  if (value && typeof value === "object") {
    return "{…}";
  }
  return String(value);
}

function flattenStructuredLines(
  value: unknown,
  depth = 0,
  keyPrefix?: string,
  lines: Array<{ key: string; value: string; depth: number }> = [],
) {
  if (isPrimitive(value)) {
    if (keyPrefix) {
      lines.push({ key: keyPrefix, value: formatPrimitive(value), depth });
    }
    return lines;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (keyPrefix) {
        lines.push({ key: keyPrefix, value: "[]", depth });
      }
      return lines;
    }

    if (value.every((item) => isPrimitive(item))) {
      if (keyPrefix) {
        lines.push({ key: keyPrefix, value: formatValueInline(value), depth });
      }
      return lines;
    }

    value.slice(0, MAX_PREVIEW_ITEMS).forEach((item, index) => {
      flattenStructuredLines(item, depth + 1, keyPrefix ? `${keyPrefix}[${index}]` : `[${index}]`, lines);
    });
    if (value.length > MAX_PREVIEW_ITEMS && keyPrefix) {
      lines.push({
        key: `${keyPrefix}[+]`,
        value: `${value.length - MAX_PREVIEW_ITEMS} more`,
        depth: depth + 1,
      });
    }
    return lines;
  }

  const objectValue = safeObject(value);
  if (!objectValue) {
    if (keyPrefix) {
      lines.push({ key: keyPrefix, value: String(value), depth });
    }
    return lines;
  }

  for (const [key, child] of Object.entries(objectValue)) {
    if (key === "__rationale") {
      continue;
    }
    const nextKey = keyPrefix ? `${keyPrefix}.${key}` : key;
    if (isPrimitive(child) || (Array.isArray(child) && child.every((item) => isPrimitive(item)))) {
      lines.push({ key: nextKey, value: formatValueInline(child), depth });
      continue;
    }
    flattenStructuredLines(child, depth + 1, nextKey, lines);
  }
  return lines;
}

function flattenRawLogLines(
  value: unknown,
  prefix?: string,
  lines: ToolLogLine[] = [],
) {
  const structuredLines = flattenStructuredLines(value);
  for (const line of structuredLines) {
    lines.push({
      key: prefix ? `${prefix}.${line.key}` : line.key,
      value: line.value,
    });
  }
  return lines;
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function formatPrimitive(value: string | number | boolean | null) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function omitInternalKeys(record: JsonRecord | null) {
  if (!record) {
    return null;
  }
  const filtered = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "__rationale" && key !== "__progress" && key !== "__logLines" && key !== "__summary"),
  );
  return Object.keys(filtered).length ? filtered : null;
}

function getProgress(args: JsonRecord | null) {
  const progress = args?.__progress;
  if (!Array.isArray(progress)) {
    return [];
  }
  return progress.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function getDisplayLogLines(value: unknown) {
  const record = safeObject(value);
  const logLines = record?.__logLines;
  if (!Array.isArray(logLines)) {
    return [];
  }
  return logLines.flatMap((line): ToolLogLine[] => {
    if (typeof line === "string") {
      const trimmed = line.trim();
      return trimmed ? [{ key: "", value: trimmed }] : [];
    }
    const entry = safeObject(line);
    if (!entry) {
      return [];
    }
    const valueText = typeof entry.value === "string" ? entry.value.trim() : "";
    if (!valueText) {
      return [];
    }
    return [{
      key: typeof entry.key === "string" ? entry.key : "",
      value: valueText,
      tone:
        entry.tone === "default" || entry.tone === "error" || entry.tone === "muted"
          ? entry.tone
          : undefined,
    }];
  });
}

function pruneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => pruneValue(entry))
      .filter((entry) => entry !== undefined)
      .slice(0, MAX_PREVIEW_ITEMS);
  }
  const record = safeObject(value);
  if (!record) {
    return value;
  }

  const hiddenKeys = new Set([
    "__rationale",
    "__progress",
    "__logLines",
    "__summary",
    "downloads",
    "fileCatalog",
    "manifest",
    "runtimeId",
    "providerMachineId",
    "promptPreview",
    "schemaPath",
    "outputPath",
    "logPath",
    "billingEvents",
    "baseUrl",
    "hydratedWorkCount",
  ]);
  const nextEntries = Object.entries(record)
    .filter(([key]) => !hiddenKeys.has(key))
    .map(([key, entry]) => {
      const entryObject = safeObject(entry);
      if (key === "taskContext" && entryObject) {
        const taskContext = { ...entryObject };
        delete taskContext.hydratedWorkIds;
        delete taskContext.mode;
        return [key, pruneValue(taskContext)];
      }
      if (key === "taskSpec" && entryObject) {
        const taskSpec = { ...entryObject };
        delete taskSpec.fileCatalog;
        delete taskSpec.downloads;
        return [key, pruneValue(taskSpec)];
      }
      return [key, pruneValue(entry)];
    })
    .filter(([, entry]) => entry !== undefined);

  return Object.fromEntries(nextEntries);
}

function getRationale(args: JsonRecord | null) {
  const value = args?.__rationale;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function summarizeQuoted(value: string, maxLength = 44) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return `'${normalized}'`;
  }
  return `'${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…'`;
}

function summarizeSearchPromptFromLogs(args: JsonRecord | null) {
  const rawLogLines = args?.__logLines;
  if (Array.isArray(rawLogLines)) {
    const candidates = rawLogLines
      .map((line) => {
        if (typeof line === "string") {
          return line;
        }
        const record = safeObject(line);
        return typeof record?.value === "string" ? record.value : null;
      })
      .filter((line): line is string => typeof line === "string")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => {
        const machineTokenCount = line
          .split(" ")
          .filter((token) => /^id?[a-f0-9-]{8,}$/i.test(token)).length;
        return (
          line.length > 24
          && /[A-Za-z]/.test(line)
          && (line.match(/[A-Za-z]{3,}/g)?.length ?? 0) >= 5
          && machineTokenCount === 0
          && !/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i.test(line)
          && !/gutenberg\/|output\/|runtimeId|chunk\s+[a-f0-9-]{6,}|work\s+[a-f0-9-]{6,}/i.test(line)
          && !/^(Scanning the library|Loading context|Pulling a few seed passages|Preparing the deeper research run|The research run is ready)/i.test(line)
        );
      });
    if (candidates.length > 0) {
      return summarizeQuoted(candidates[0]);
    }
  }
  return null;
}

function summarizeSearchPrompt(args: JsonRecord | null, options?: { includeLogs?: boolean }) {
  const taskContext = safeObject(args?.taskContext);
  if (typeof taskContext?.question === "string") {
    return summarizeQuoted(taskContext.question);
  }
  if (typeof taskContext?.researchObjective === "string") {
    return summarizeQuoted(taskContext.researchObjective);
  }
  if (typeof taskContext?.prompt === "string") {
    return summarizeQuoted(taskContext.prompt);
  }

  const taskSpec = safeObject(args?.taskSpec);
  if (typeof taskSpec?.question === "string") {
    return summarizeQuoted(taskSpec.question);
  }
  if (typeof taskSpec?.query === "string") {
    return summarizeQuoted(taskSpec.query);
  }

  const directQuery = typeof args?.query === "string" ? args.query : null;
  if (directQuery) {
    return summarizeQuoted(directQuery);
  }
  return options?.includeLogs === false ? null : summarizeSearchPromptFromLogs(args);
}

function summarizeWorkCount(result: JsonRecord | null) {
  if (typeof result?.workCount === "number") {
    return `${result.workCount} works`;
  }
  const works = Array.isArray(result?.works) ? result.works : [];
  if (works.length > 0) {
    return `${works.length} works`;
  }
  return null;
}

function summarizeChunkCount(result: JsonRecord | null) {
  if (typeof result?.chunkCount === "number") {
    return `${result.chunkCount} passages`;
  }
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  if (chunks.length > 0) {
    return `${chunks.length} passages`;
  }
  return null;
}

function summarizeTool(toolName: string, args: JsonRecord | null, result: JsonRecord | null, status?: ToolCallMessagePartStatus) {
  if (status?.type === "incomplete") {
    const error =
      typeof status.error === "string"
        ? status.error
        : typeof result?.error === "string"
          ? result.error
          : null;
    return error ? `This step failed: ${error}` : "This step failed.";
  }

  const progress = getProgress(args);
  if (progress.length > 0) {
    return progress[progress.length - 1];
  }

  const searchPrompt = summarizeSearchPrompt(args);
  const workCount = summarizeWorkCount(result);
  const chunkCount = summarizeChunkCount(result);
  const rationale = getRationale(args);
  const structuredSearchPrompt = summarizeSearchPrompt(args, { includeLogs: false });

  switch (toolName.toLowerCase()) {
    case "library scan":
    case "corpus search":
      return searchPrompt
        ? `Search quote: ${searchPrompt}`
        : workCount
          ? `Search quote: ${workCount}`
          : "Search quote";
    case "seed passages":
    case "passage search":
      return searchPrompt
        ? `Find passages: ${searchPrompt}`
        : chunkCount
          ? `Find passages: ${chunkCount}`
          : "Find passages";
    case "book metadata":
    case "book context":
      return workCount ? `Load book context: ${workCount}` : "Load book context";
    case "full text lookup":
      return "Open source text";
    case "workspace setup":
    case "research setup":
      return searchPrompt ? `Set up research: ${searchPrompt}` : "Set up research";
    case "evidence search":
    case "deep search":
    case "deep research":
    case "corpus briefing":
      return structuredSearchPrompt ? `Deep search: ${structuredSearchPrompt}` : "Deep search";
    case "search notes":
    case "workspace output":
    case "briefing import":
      return "Import briefing";
    default:
      if (rationale) {
        return rationale;
      }
      return searchPrompt ? `Research step: ${searchPrompt}` : "Research step";
  }
}

function ToolLogSection({
  lines,
  autoFollow = false,
}: {
  lines: ToolLogLine[];
  autoFollow?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoFollow || !containerRef.current) {
      return;
    }
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [autoFollow, lines]);

  if (!lines.length) {
    return null;
  }

  return (
    <section className="aui-tool-section">
      <div ref={containerRef} className="aui-tool-progress-log">
        {lines.map((line, index) => (
          <div key={`${line.key}-${index}`} className={cn("aui-tool-progress-line", line.tone === "error" && "aui-tool-progress-line-error")}>
            <span className={cn("aui-tool-line-key aui-tool-log-line-key", line.tone === "muted" && "aui-tool-log-line-key-muted")}>
              {line.key}
            </span>
            <span className="aui-tool-line-value">{line.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        lockScroll();
      }
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [controlledOnOpenChange, isControlled, lockScroll],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn("aui-tool-fallback-root group/tool-fallback-root w-full", className)}
      style={{ ["--animation-duration" as string]: `${ANIMATION_DURATION}ms` }}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

function ToolFallbackTrigger({
  toolName,
  status,
  result,
  summary,
  progressPreview,
  open = false,
  hasDetailLines = false,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  summary: string;
  progressPreview?: string[];
  status?: ToolCallMessagePartStatus;
  result?: JsonRecord | null;
  open?: boolean;
  hasDetailLines?: boolean;
}) {
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";
  const resultIndicatesFailure =
    result?.ok === false
    || (typeof result?.error === "string" && result.error.trim().length > 0);
  const isFailed = (status?.type === "incomplete" && status.reason !== "cancelled") || resultIndicatesFailure;
  const Icon = isFailed ? XCircleIcon : statusIconMap[statusType];
  const badge = isCancelled ? "Cancelled" : isFailed ? "Failed" : isRunning ? "Running" : "Done";
  const latestProgress = progressPreview && progressPreview.length > 0
    ? progressPreview[progressPreview.length - 1]
    : null;
  const showHeaderSummary = !open || !hasDetailLines;
  const showProgressPreview = Boolean(latestProgress) && showHeaderSummary && latestProgress !== summary;

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn("aui-tool-fallback-trigger group/trigger flex w-full items-start gap-3 text-left", className)}
      {...props}
    >
      <span className={cn("aui-tool-fallback-status-shell", isFailed && "aui-tool-fallback-status-shell-error")}>
        <Icon className={cn("size-3.5", isRunning && "animate-spin")} />
      </span>
      <span className="min-w-0 grow">
        <span className="aui-tool-fallback-head">
          <b className="aui-tool-fallback-title">{toolName}</b>
          <span className={cn("aui-tool-fallback-badge", isFailed && "aui-tool-fallback-badge-error")}>{badge}</span>
        </span>
        {showHeaderSummary ? <span className="aui-tool-fallback-summary">{summary}</span> : null}
        {showProgressPreview ? (
          <span className="aui-tool-fallback-progress-preview">
            <span className="aui-tool-fallback-progress-preview-line line-clamp-1">
              {latestProgress}
            </span>
          </span>
        ) : null}
      </span>
      <ChevronDownIcon
        className={cn(
          "aui-tool-fallback-chevron size-4 shrink-0 transition-transform duration-(--animation-duration) ease-out",
          "group-data-[state=closed]/trigger:-rotate-90",
          "group-data-[state=open]/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content overflow-hidden outline-none",
        "group/collapsible-content ease-out",
        "data-[state=closed]:animate-collapsible-up",
        "data-[state=open]:animate-collapsible-down",
        "data-[state=closed]:fill-mode-forwards",
        "data-[state=closed]:pointer-events-none",
        "data-[state=open]:duration-(--animation-duration)",
        "data-[state=closed]:duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      <div className="aui-tool-fallback-detail-shell">{children}</div>
    </CollapsibleContent>
  );
}

function ToolFallbackError({
  status,
}: {
  status?: ToolCallMessagePartStatus;
}) {
  if (status?.type !== "incomplete") {
    return null;
  }

  const error =
    typeof status.error === "string"
      ? status.error
      : status.error
        ? JSON.stringify(status.error)
        : null;
  if (!error) {
    return null;
  }

  return (
    <section className="aui-tool-section aui-tool-section-error">
      <h4 className="aui-tool-section-title">Error</h4>
      <p className="aui-tool-error-text">{error}</p>
    </section>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
}) => {
  const [open, setOpen] = useState(status?.type === "running");
  const args = useMemo(() => parseArgs(argsText), [argsText]);
  const progress = useMemo(() => getProgress(args), [args]);
  const startedLogLines = useMemo(() => getDisplayLogLines(args), [args]);
  const cleanedArgs = useMemo(() => pruneValue(omitInternalKeys(args)), [args]);
  const safeResultObject = useMemo(() => safeObject(result), [result]);
  const resultObject = useMemo(() => pruneValue(safeResultObject ?? result), [result, safeResultObject]);
  const completedLogLines = useMemo(() => getDisplayLogLines(result), [result]);
  const errorText = useMemo(() => {
    if (status?.type !== "incomplete") {
      return null;
    }
    if (typeof status.error === "string" && status.error.trim()) {
      return status.error.trim();
    }
    if (status.error) {
      return JSON.stringify(status.error);
    }
    return null;
  }, [status]);
  const logLines = useMemo(() => {
    const lines: ToolLogLine[] = [];
    if (startedLogLines.length > 0) {
      lines.push(...startedLogLines);
    } else if (cleanedArgs !== undefined && cleanedArgs !== null) {
      flattenRawLogLines(cleanedArgs, undefined, lines);
    }
    progress.forEach((item) => {
      lines.push({
        key: "",
        value: item,
        tone: "muted",
      });
    });
    if (completedLogLines.length > 0) {
      lines.push(...completedLogLines);
    } else if (resultObject !== undefined && resultObject !== null) {
      flattenRawLogLines(resultObject, undefined, lines);
    }
    if (errorText) {
      lines.push({
        key: "error",
        value: errorText,
        tone: "error",
      });
    }
    return lines.filter((line, index) => {
      if (index === 0) {
        return true;
      }
      const previous = lines[index - 1];
      return previous.key !== line.key || previous.value !== line.value || previous.tone !== line.tone;
    });
  }, [cleanedArgs, completedLogLines, errorText, progress, resultObject, startedLogLines]);
  const summary = useMemo(
    () => summarizeTool(toolName, args, safeResultObject, status),
    [toolName, args, safeResultObject, status],
  );

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen} defaultOpen={status?.type === "running" || progress.length > 0}>
      <ToolFallbackTrigger
        toolName={toolName}
        summary={summary}
        progressPreview={progress}
        status={status}
        result={safeResultObject}
        open={open}
        hasDetailLines={logLines.length > 0}
      />
      {logLines.length > 0 ? (
        <ToolFallbackContent>
          <ToolLogSection lines={logLines} autoFollow={open} />
        </ToolFallbackContent>
      ) : null}
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(
  ToolFallbackImpl,
) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Error: typeof ToolFallbackError;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Error = ToolFallbackError;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackError,
};
