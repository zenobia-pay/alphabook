"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  SparklesIcon,
  XCircleIcon,
} from "lucide-react";
import {
  useScrollLock,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const ANIMATION_DURATION = 200;

type JsonRecord = Record<string, unknown>;

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

type ToolStatus = ToolCallMessagePartStatus["type"];

type ToolCardData = {
  rationale: string | null;
  summary: string | null;
  query: string | null;
  filePath: string | null;
  phase: string | null;
  metrics: Array<{ label: string; value: string }>;
  preview: string | null;
  error: string | null;
};

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

function quoted(value: unknown) {
  return typeof value === "string" && value.trim() ? `“${value.trim()}”` : null;
}

function countLabel(value: unknown, singular: string, plural = `${singular}s`) {
  if (!Array.isArray(value)) {
    return null;
  }
  const count = value.length;
  return `${count} ${count === 1 ? singular : plural}`;
}

function phaseLabel(value: unknown) {
  if (value === "collect_evidence") {
    return "evidence search";
  }
  if (value === "write_briefing") {
    return "briefing draft";
  }
  return typeof value === "string" ? value.replaceAll("_", " ") : null;
}

function summarizeToolCard(
  toolName: string,
  args: JsonRecord | null,
  result: unknown,
  status?: ToolCallMessagePartStatus,
): ToolCardData {
  const resultObject = safeObject(result);
  const taskSpec = safeObject(args?.taskSpec);
  const rationale =
    typeof args?.__rationale === "string" && args.__rationale.trim()
      ? args.__rationale.trim()
      : null;
  const query =
    quoted(args?.query) ??
    quoted(taskSpec?.query) ??
    quoted(taskSpec?.goal) ??
    quoted(taskSpec?.question);
  const filePath =
    typeof args?.path === "string"
      ? args.path
      : typeof resultObject?.path === "string"
        ? resultObject.path
        : null;
  const phase = phaseLabel(taskSpec?.phase);
  const metrics: Array<{ label: string; value: string }> = [];

  const worksCount = countLabel(resultObject?.works, "book");
  if (worksCount) {
    metrics.push({ label: "Matches", value: worksCount });
  }
  const chunksCount = countLabel(resultObject?.chunks, "passage");
  if (chunksCount) {
    metrics.push({ label: "Passages", value: chunksCount });
  }
  const workScope = countLabel(args?.workIds, "book");
  if (workScope) {
    metrics.push({ label: "Scope", value: workScope });
  }
  const seedCount = countLabel(args?.chunkIds, "seed");
  if (seedCount) {
    metrics.push({ label: "Seeds", value: seedCount });
  }
  if (typeof resultObject?.hydratedWorkCount === "number") {
    metrics.push({
      label: "Hydrated",
      value: `${resultObject.hydratedWorkCount} book${resultObject.hydratedWorkCount === 1 ? "" : "s"}`,
    });
  }
  if (typeof resultObject?.artifactCount === "number") {
    metrics.push({
      label: "Artifacts",
      value: `${resultObject.artifactCount}`,
    });
  }
  if (typeof resultObject?.citationCount === "number") {
    metrics.push({
      label: "Citations",
      value: `${resultObject.citationCount}`,
    });
  }

  const preview =
    typeof resultObject?.contentPreview === "string" && resultObject.contentPreview.trim()
      ? resultObject.contentPreview.trim()
      : typeof resultObject?.briefing === "string" && resultObject.briefing.trim()
        ? resultObject.briefing.trim().slice(0, 220)
        : null;

  const error =
    status?.type === "incomplete"
      ? typeof status.error === "string"
        ? status.error
        : status.error
          ? JSON.stringify(status.error)
          : null
      : typeof resultObject?.error === "string"
        ? resultObject.error
        : null;

  let summary = rationale;
  if (!summary) {
    switch (toolName.toLowerCase()) {
      case "library scan":
        summary = query ? `Looking across the current library for books related to ${query}.` : "Looking across the current library for likely books.";
        break;
      case "seed passages":
        summary = query ? `Pulling a first set of passages for ${query}.` : "Pulling a first set of passages from the corpus.";
        break;
      case "workspace setup":
        summary = "Preparing the workspace that will run the deeper corpus search.";
        break;
      case "evidence search":
      case "deep search":
        summary = phase
          ? `Running the ${phase} inside the workspace.`
          : "Running a deeper local search across the hydrated corpus files.";
        break;
      case "search notes":
      case "workspace output":
      case "briefing import":
        summary = filePath
          ? `Reading ${filePath.split("/").pop()} back into the thread.`
          : "Reading the workspace output back into the thread.";
        break;
      default:
        summary = "Running the next research step.";
        break;
    }
  }

  if ((status?.type ?? "complete") === "complete" && !error) {
    if (Array.isArray(resultObject?.works) && resultObject.works.length === 0) {
      summary = query
        ? `No strong book matches surfaced yet for ${query}.`
        : "No strong book matches surfaced yet.";
    }
    if (Array.isArray(resultObject?.chunks) && resultObject.chunks.length === 0) {
      summary = query
        ? `No seed passages surfaced yet for ${query}.`
        : "No seed passages surfaced yet.";
    }
  }

  return {
    rationale,
    summary,
    query,
    filePath,
    phase,
    metrics,
    preview,
    error,
  };
}

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
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "aui-tool-fallback-root group/tool-fallback-root w-full overflow-hidden rounded-2xl",
        className,
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
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
  summary: string | null;
  status?: ToolCallMessagePartStatus;
}) {
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";

  const Icon = statusIconMap[statusType];
  const badge = isCancelled ? "Cancelled" : isRunning ? "Working" : "Done";

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={cn(
        "aui-tool-fallback-trigger group/trigger flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors",
        className,
      )}
      {...props}
    >
      <span className="aui-tool-fallback-status-shell mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full">
        <Icon
          data-slot="tool-fallback-trigger-icon"
          className={cn(
            "aui-tool-fallback-trigger-icon size-3.5 shrink-0",
            isCancelled && "text-muted-foreground",
            isRunning && "animate-spin",
          )}
        />
      </span>
      <span className="min-w-0 grow">
        <span className="aui-tool-fallback-trigger-head flex items-center gap-2">
          <b className="aui-tool-fallback-title">{toolName}</b>
          <span className="aui-tool-fallback-badge">{badge}</span>
        </span>
        {summary ? (
          <span className="aui-tool-fallback-trigger-summary mt-1 block">
            {summary}
          </span>
        ) : null}
      </span>
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          "aui-tool-fallback-trigger-chevron mt-1 size-4 shrink-0 transition-transform duration-(--animation-duration) ease-out",
          "group-data-[state=closed]/trigger:-rotate-90",
          "group-data-[state=open]/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolMetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="aui-tool-fallback-metric">
      <span className="aui-tool-fallback-metric-label">{label}</span>
      <span className="aui-tool-fallback-metric-value">{value}</span>
    </div>
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
        "aui-tool-fallback-content relative overflow-hidden text-sm outline-none",
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

function ToolFallbackDetails({
  data,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  data: ToolCardData;
}) {
  if (!data.metrics.length && !data.filePath && !data.phase && !data.preview) {
    return null;
  }

  return (
    <div
      data-slot="tool-fallback-details"
      className={cn("aui-tool-fallback-details", className)}
      {...props}
    >
      {data.metrics.length ? (
        <div className="aui-tool-fallback-metrics">
          {data.metrics.map((metric) => (
            <ToolMetricRow key={`${metric.label}-${metric.value}`} label={metric.label} value={metric.value} />
          ))}
        </div>
      ) : null}
      {data.phase ? <ToolMetricRow label="Phase" value={data.phase} /> : null}
      {data.filePath ? <ToolMetricRow label="File" value={data.filePath} /> : null}
      {data.preview ? (
        <div className="aui-tool-fallback-preview">
          <SparklesIcon className="aui-tool-fallback-preview-icon" />
          <p>{data.preview}</p>
        </div>
      ) : null}
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  status?: ToolCallMessagePartStatus;
}) {
  if (status?.type !== "incomplete") return null;

  const error = status.error;
  const errorText = error
    ? typeof error === "string"
      ? error
      : JSON.stringify(error)
    : null;

  if (!errorText) return null;

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn("aui-tool-fallback-error", className)}
      {...props}
    >
      <p className="aui-tool-fallback-error-title">Something went wrong</p>
      <p className="aui-tool-fallback-error-reason">{errorText}</p>
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
}) => {
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";
  const args = useMemo(() => parseArgs(argsText), [argsText]);
  const cardData = useMemo(
    () => summarizeToolCard(toolName, args, result, status),
    [toolName, args, result, status],
  );

  return (
    <ToolFallbackRoot
      className={cn(isCancelled && "aui-tool-fallback-root-cancelled")}
    >
      <ToolFallbackTrigger toolName={toolName} status={status} summary={cardData.summary} />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        {!isCancelled ? <ToolFallbackDetails data={cardData} /> : null}
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
