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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const ANIMATION_DURATION = 200;
const MAX_PREVIEW_ITEMS = 8;

type JsonRecord = Record<string, unknown>;

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

function humanizeKey(key: string) {
  return key
    .replace(/^__/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());
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
    Object.entries(record).filter(([key]) => key !== "__rationale"),
  );
  return Object.keys(filtered).length ? filtered : null;
}

function getRationale(args: JsonRecord | null) {
  const value = args?.__rationale;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function summarizeTool(toolName: string, args: JsonRecord | null, result: JsonRecord | null, status?: ToolCallMessagePartStatus) {
  const rationale = getRationale(args);
  if (rationale) {
    return rationale;
  }

  const query =
    typeof args?.query === "string"
      ? args.query
      : safeObject(args?.taskSpec)?.question;
  const quotedQuery =
    typeof query === "string" && query.trim() ? `“${query.trim()}”` : null;

  if (status?.type === "incomplete") {
    const error =
      typeof status.error === "string"
        ? status.error
        : typeof result?.error === "string"
          ? result.error
          : null;
    return error ? `This step failed: ${error}` : "This step failed.";
  }

  switch (toolName.toLowerCase()) {
    case "library scan":
      return quotedQuery
        ? `Looking across the current library for books related to ${quotedQuery}.`
        : "Looking across the current library for likely books.";
    case "seed passages":
      return quotedQuery
        ? `Pulling a first set of passages for ${quotedQuery}.`
        : "Pulling a first set of passages.";
    case "book metadata":
      return "Loading metadata for the books currently in scope.";
    case "full text lookup":
      return "Opening the source text directly.";
    case "workspace setup":
      return "Preparing the workspace for the longer-running search.";
    case "evidence search":
    case "deep search":
      return "Running the longer workspace search over the selected corpus files.";
    case "search notes":
    case "workspace output":
    case "briefing import":
      return "Reading the latest workspace output back into the thread.";
    default:
      return "Running the next research step.";
  }
}

function ToolSection({
  title,
  value,
}: {
  title: string;
  value: unknown;
}) {
  if (value === undefined || value === null) {
    return null;
  }

  const isEmptyObject = safeObject(value) && Object.keys(omitInternalKeys(safeObject(value)) ?? {}).length === 0;
  if (isEmptyObject) {
    return null;
  }

  const lines = flattenStructuredLines(value);
  if (!lines.length) {
    return null;
  }

  return (
    <section className="aui-tool-section">
      <h4 className="aui-tool-section-title">{title}</h4>
      <div className="aui-tool-lines">
        {lines.map((line) => (
          <div
            key={`${title}-${line.key}-${line.depth}`}
            className="aui-tool-line"
            style={{ ["--tool-line-depth" as string]: String(line.depth) }}
          >
            <span className="aui-tool-line-key">{humanizeKey(line.key)}</span>
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
  summary,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  summary: string;
  status?: ToolCallMessagePartStatus;
}) {
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";
  const isFailed = status?.type === "incomplete" && status.reason !== "cancelled";
  const Icon = statusIconMap[statusType];
  const badge = isCancelled ? "Cancelled" : isFailed ? "Failed" : isRunning ? "Running" : "Done";

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
        <span className="aui-tool-fallback-summary">{summary}</span>
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
  const args = useMemo(() => parseArgs(argsText), [argsText]);
  const cleanedArgs = useMemo(() => omitInternalKeys(args), [args]);
  const resultObject = useMemo(() => safeObject(result) ?? result, [result]);
  const summary = useMemo(
    () => summarizeTool(toolName, args, safeObject(result), status),
    [toolName, args, result, status],
  );

  return (
    <ToolFallbackRoot>
      <ToolFallbackTrigger toolName={toolName} summary={summary} status={status} />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        <ToolSection title="Request" value={cleanedArgs} />
        <ToolSection title="Response" value={resultObject} />
      </ToolFallbackContent>
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
