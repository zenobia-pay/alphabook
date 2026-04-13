export type UserProgressKind = "activity" | "heartbeat" | "status";

export type UserProgressCandidate = {
  text: string;
  kind: UserProgressKind;
  phase?: string | null;
  meaningful?: boolean;
};

type ProgressEventInput = {
  event: string;
  data: Record<string, unknown>;
  lastMeaningfulText?: string | null;
};

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function truncateText(value: string, maxChars = 160) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function stripSurroundingQuotes(value: string) {
  return value.replace(/^['"]+|['"]+$/gu, "").trim();
}

function extractQuotedTerms(command: string) {
  const matches = [...command.matchAll(/'([^']{2,120})'|"([^"]{2,120})"/gu)];
  const rawTerms = matches.flatMap((match) => [match[1], match[2]].filter((value): value is string => Boolean(value)));
  const terms = rawTerms
    .flatMap((term) => term.split("|"))
    .map((term) => stripSurroundingQuotes(term.replace(/\\x27/giu, "'").replace(/\\n/gu, " ")))
    .filter((term) =>
      term.length > 1
      && !term.startsWith("/bin/")
      && !term.includes("<<'PY'")
      && !/[\\/]/u.test(term)
      && !/^(?:head|sed|rg|python3?|bash|sh|json|utf-8|in_progress|completed)$/iu.test(term),
    );
  return [...new Set(terms)].slice(0, 6);
}

function extractFlagValue(command: string, flag: string) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = command.match(new RegExp(`${escaped}\\s+(?:'([^']+)'|"([^"]+)"|(\\S+))`, "u"));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim() || null;
}

function formatSearchTerms(rawPattern: string | null) {
  if (!rawPattern) {
    return null;
  }
  const cleaned = rawPattern
    .replace(/\\[bBsSdDwW]/gu, " ")
    .replace(/[()[\]^$+*?]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const terms = cleaned
    .split("|")
    .map((part) => stripSurroundingQuotes(part))
    .map((part) => part.replace(/\s+/gu, " ").trim())
    .filter((part) => part.length > 1)
    .filter((part) => !/[\\/]/u.test(part))
    .slice(0, 6);
  return terms.length > 0 ? terms.join("; ") : null;
}

function extractSourceVolume(command: string) {
  const match = command.match(/\/(?:gutenberg\/clean|clean)\/(\d{3,8})\//u);
  return match?.[1] ?? null;
}

function extractSedRange(command: string) {
  const match = command.match(/sed\s+-n\s+'?(\d+),(\d+)p'?/u);
  if (!match) {
    return null;
  }
  const start = Number.parseInt(match[1] ?? "", 10);
  const end = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return { start, end };
}

function commandLooksLikeJsonFragment(line: string) {
  return /^[\[\]{}],?$/u.test(line)
    || /^"(?:path|bytes|updated_at|started_at|finished_at|name|run_id|timestamp|wrapper_run_dir|inner_run_dir|status)"\s*:/u.test(line);
}

function stripLogTimestampPrefix(value: string) {
  return value
    .replace(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\]\s*/u, "")
    .replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+/u, "")
    .trim();
}

function normalizeProgressLine(value: string) {
  return stripLogTimestampPrefix(value.replace(/\s+/gu, " ").trim());
}

function genericProgressNoise(text: string) {
  const normalized = normalizeProgressLine(text).toLowerCase();
  if (!normalized) {
    return true;
  }
  return (
    /^(?:launching the analysis workspace|working through launching|started a workspace task|workspace task started|task run initialized|task status: running|task is running|workspace task heartbeat(?:: .*?)?|task heartbeat received(?:: .*?)?|still working: pid=\d+ status=alive|pid=\d+ status=alive)\.?$/u.test(normalized)
    || /^(?:preparing|prepared)\s+(?:the\s+)?(?:terminal|skills list|list of skills|code execution(?: environment| step)?|run environment|prompt input file|working directory|output folder structure|analysis workspace)\.?$/u.test(normalized)
    || /^(?:a|an)\s+(?:log file|process log file|inner run directory record|manifest file|session snapshot)\s+(?:was referenced|was created|was prepared|was generated).?$/u.test(normalized)
    || /^(?:generated|created)\s+(?:status\.json|run\.log|manifest\.json|scoped-files\.tsv|the output folder structure).?$/u.test(normalized)
    || /^(?:requested|sent|prepared)\s+.*\bopenai proxy\b.*$/u.test(normalized)
    || /^(?:used|selected|prepared).*\bgpt-[\w.:-]+\b.*$/u.test(normalized)
    || /^(?:openai request logging was enabled|used the openai proxy service|a new session was created and a session snapshot was prepared)\.?$/u.test(normalized)
  );
}

export function shouldIgnoreRawProgressText(text: string) {
  const normalized = normalizeProgressLine(text);
  if (!normalized || commandLooksLikeJsonFragment(normalized)) {
    return true;
  }
  return genericProgressNoise(normalized);
}

function humanizeAgentText(text: string) {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return null;
  }
  const firstSentence = normalized.split(/(?<=[.!?])\s+/u)[0] ?? normalized;
  const cleaned = firstSentence
    .replace(/^I(?:'m| am)\s+/iu, "")
    .replace(/^Next,\s*I(?:'m| am)\s+/iu, "")
    .replace(/^Next I(?:'m| am)\s+/iu, "")
    .replace(/^I have\s+/iu, "Found ")
    .replace(/^I’ve\s+/iu, "")
    .replace(/^I've\s+/iu, "")
    .replace(/^The workspace is\s+/iu, "Workspace is ")
    .trim();
  if (!cleaned) {
    return null;
  }
  const capitalized = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return truncateText(capitalized.endsWith(".") ? capitalized : `${capitalized}.`);
}

function summarizeCommand(command: string) {
  const normalized = command.replace(/\s+/gu, " ").trim();
  const sourceVolume = extractSourceVolume(normalized);
  const quotedTerms = extractQuotedTerms(normalized);
  const explicitPattern = formatSearchTerms(extractFlagValue(normalized, "--pattern"));
  if (normalized.includes("manifest.json") && normalized.includes("run.log") && normalized.includes("scoped-files.tsv")) {
    return "Initializing the search workspace, manifest, and scoped file list.";
  }
  if (normalized.includes("run-ripgrep-progress.sh")) {
    return explicitPattern
      ? truncateText(`Running a bounded corpus search for: ${explicitPattern}`)
      : "Running a bounded corpus search across the current file batch.";
  }
  if (normalized.includes("partition-file-list.sh")) {
    return "Partitioning the scoped corpus into search batches.";
  }
  if (normalized.includes("all-text-files.tsv") && normalized.includes("scoped-files.tsv")) {
    return "Copying the corpus file index into the search workspace.";
  }
  if (/\brg\b/u.test(normalized)) {
    const rgTerms = explicitPattern ?? (quotedTerms.length > 0 ? quotedTerms.join("; ") : null);
    if (rgTerms) {
      return truncateText(`Searching ${sourceVolume ? `source volume ${sourceVolume}` : "source texts"} for: ${rgTerms}`);
    }
    return `Searching ${sourceVolume ? `source volume ${sourceVolume}` : "source texts"}.`;
  }
  if (/\b(?:sed|head|cat)\b/u.test(normalized)) {
    const range = extractSedRange(normalized);
    if (range && range.start <= 5) {
      return `Reading the opening pages of ${sourceVolume ? `source volume ${sourceVolume}` : "a source text"}.`;
    }
    if (normalized.includes("book.html")) {
      return `Reading the HTML structure of ${sourceVolume ? `source volume ${sourceVolume}` : "a source text"}.`;
    }
    return `Reading sampled passages from ${sourceVolume ? `source volume ${sourceVolume}` : "a source text"}.`;
  }
  if (/\bpython(?:3)?\b/u.test(normalized)) {
    if (normalized.includes("manifest.json") || normalized.includes("run.log") || normalized.includes("scoped-files.tsv")) {
      return "Initializing the search workspace, manifest, and scoped file list.";
    }
    if (quotedTerms.length > 0) {
      return truncateText(`Running a comparison script for: ${quotedTerms.join("; ")}`);
    }
    if (normalized.includes(".tsv") || normalized.includes("collect") || normalized.includes("catalog") || normalized.includes("preserve")) {
      return "Running a scripted search-processing step across the current corpus batch.";
    }
    return null;
  }
  if (normalized.includes("for spec in") || normalized.includes("ifs=: read -r gid start end")) {
    return "Sampling passages across the selected source volumes.";
  }
  if (/\bls\b/u.test(normalized) || normalized.includes("manifest.json") || normalized.includes("status.json")) {
    return "Inspecting the run manifest and available inputs.";
  }
  return null;
}

function summarizePromptLine(text: string) {
  const searchMatch = text.match(/^Launching agentic search with user query '(.+)'$/u);
  if (searchMatch?.[1]) {
    return truncateText(`Search brief: ${searchMatch[1]}`);
  }
  const experimentMatch = text.match(/^Launching experiment with user query '(.+)'$/u);
  if (experimentMatch?.[1]) {
    return truncateText(`Experiment brief: ${experimentMatch[1]}`);
  }
  return null;
}

function summarizePrettyCliLine(text: string) {
  const normalized = text.trim();
  if (!normalized.startsWith("┊")) {
    return null;
  }
  const preparing = normalized.match(/^┊\s+[\p{Emoji}\u{1F300}-\u{1FAFF}]?\s*preparing\s+([a-z0-9_-]+)\.\.\.$/iu);
  if (preparing?.[1]) {
    return null;
  }
  const read = normalized.match(/^┊\s+[\p{Emoji}\u{1F300}-\u{1FAFF}]?\s*read\s+(\S+)\s+([\d.]+s)$/iu);
  if (read?.[1]) {
    const path = read[1];
    const base = path.split("/").at(-1) ?? path;
    if (base === "all-text-files.tsv") {
      return "Reviewing the corpus file index to choose search scope.";
    }
    if (base === "metadata-table.jsonl" || base === "metadata-table.json") {
      return "Reviewing corpus metadata to narrow candidate books.";
    }
    if (base === "ripgrep.log" || base === "ripgrep-status.json" || base === "ripgrep-progress.jsonl") {
      return "Checking whether the current bounded search batch is producing strong matches.";
    }
    if (base === "scoped-files.tsv") {
      return "Checking the scoped corpus file list.";
    }
    if (base === "run.log") {
      return null;
    }
    if (base === "status.json") {
      return null;
    }
    if (base === "manifest.json") {
      return "Reviewing the run manifest and search scope.";
    }
    if (base.endsWith(".md")) {
      return truncateText(`Reading ${base.replace(/[-_]+/gu, " ")}.`);
    }
    return truncateText(`Reading ${base}.`);
  }
  const shell = normalized.match(/^┊\s+[\p{Emoji}\u{1F300}-\u{1FAFF}]?\s*\$\s+(.+)$/u);
  if (shell?.[1]) {
    return summarizeCommand(shell[1]);
  }
  const find = normalized.match(/^┊\s+[\p{Emoji}\u{1F300}-\u{1FAFF}]?\s*find\s+(.+?)\s+([\d.]+s)$/iu);
  if (find?.[1]) {
    const target = find[1];
    if (/\.txt\b/iu.test(target)) {
      return "Scanning text files in the current run workspace.";
    }
  }
  return null;
}

function summarizeToolStarted(toolName: string, data: Record<string, unknown>) {
  const args = safeRecord(data.args);
  const query = typeof args?.query === "string" ? truncateText(args.query, 140) : null;
  const taskSpec = safeRecord(args?.taskSpec);
  const objective =
    typeof taskSpec?.question === "string" ? taskSpec.question
      : typeof taskSpec?.researchObjective === "string" ? taskSpec.researchObjective
        : typeof safeRecord(taskSpec?.searchHints)?.passageSearchFocus === "string" ? String(safeRecord(taskSpec?.searchHints)?.passageSearchFocus)
          : null;
  if (toolName === "search_works") {
    return query ? `Searching books for: ${query}` : "Searching books relevant to the request.";
  }
  if (toolName === "get_relevant_chunks" || toolName === "semantic_deep_search") {
    return query ? `Searching passages for: ${query}` : "Searching passages relevant to the request.";
  }
  if (toolName === "run_workspace_task") {
    if (objective && objective.trim().length > 0) {
      return truncateText(`Started agentic workspace for: ${objective.trim()}`);
    }
    const rationale = typeof data.rationale === "string" ? data.rationale.trim() : "";
    return rationale ? truncateText(rationale) : "Started the agentic workspace.";
  }
  return null;
}

function summarizeJobProgress(data: Record<string, unknown>) {
  const detail = typeof data.detail === "string" ? data.detail.trim() : "";
  const phase = typeof data.phase === "string" ? data.phase.trim() : "";
  if (!detail && !phase) {
    return null;
  }
  if (detail) {
    if (shouldIgnoreRawProgressText(detail)) {
      return null;
    }
    return truncateText(detail.endsWith(".") ? detail : `${detail}.`);
  }
  if (!phase || /^(?:launching|running)$/iu.test(phase)) {
    return null;
  }
  return truncateText(`Working through ${phase.replace(/[_-]+/gu, " ")}.`);
}

function summarizeHeartbeat(lastMeaningfulText?: string | null) {
  if (lastMeaningfulText && lastMeaningfulText.trim().length > 0) {
    const trimmed = lastMeaningfulText.replace(/[.]+$/u, "").trim();
    return truncateText(`Still working: ${trimmed}.`);
  }
  return "Still working on the current analysis step.";
}

function parseJsonLine(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function summarizePartialHermesJson(text: string) {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const agentMessageMatch = normalized.match(/"type":"agent_message","text":"(.+?)(?<!\\)"/u);
  if (agentMessageMatch?.[1]) {
    const candidate = humanizeAgentText(agentMessageMatch[1].replace(/\\"/gu, "\"").replace(/\\n/gu, " "));
    if (candidate) {
      return candidate;
    }
  }
  const commandMatch = normalized.match(/"type":"command_execution","command":"(.+?)(?<!\\)"/u);
  if (commandMatch?.[1]) {
    const command = commandMatch[1].replace(/\\"/gu, "\"").replace(/\\n/gu, " ");
    const candidate = summarizeCommand(command);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function summarizeLogLine(
  text: string,
  data: Record<string, unknown>,
  lastMeaningfulText?: string | null,
): UserProgressCandidate | null {
  const trimmed = normalizeProgressLine(text);
  if (!trimmed || shouldIgnoreRawProgressText(trimmed)) {
    return null;
  }
  if (trimmed.length > 280 || /^##\s+/u.test(trimmed)) {
    return null;
  }
  if (/pid=\d+\s+alive$/iu.test(trimmed) || typeof safeRecord(data.detail)?.source === "string" && safeRecord(data.detail)?.source === "heartbeat") {
    return {
      text: summarizeHeartbeat(lastMeaningfulText),
      kind: "heartbeat",
      meaningful: false,
    };
  }
  if (/^(?:timestamp|run_id|job_id|wrapper_run_dir|inner_run_dir|root_dir|corpus_root|archive_prefix|alphabook_session_id|alphabook_run_id|model)=/u.test(trimmed)) {
    return null;
  }
  if (/exit code 1/iu.test(trimmed) && /failed/iu.test(trimmed)) {
    return {
      text: "Several search-processing steps failed with exit code 1; inspecting the failure output before retrying.",
      kind: "activity",
      meaningful: true,
    };
  }
  if (/processing failed .*?(catalog|collect\/preserve|craft\/tinker|long years|meticulous|obsession)/iu.test(trimmed)) {
    return {
      text: "The first bounded search term groups failed across several TSV partitions; checking the failure output before retrying.",
      kind: "activity",
      meaningful: true,
    };
  }
  const promptLine = summarizePromptLine(trimmed);
  if (promptLine) {
    return {
      text: promptLine,
      kind: "status",
      meaningful: true,
    };
  }
  const prettyCliLine = summarizePrettyCliLine(trimmed);
  if (prettyCliLine) {
    return {
      text: prettyCliLine,
      kind: "activity",
      meaningful: true,
    };
  }
  const partialHermesJson = summarizePartialHermesJson(trimmed);
  if (partialHermesJson) {
    return {
      text: partialHermesJson,
      kind: "activity",
      meaningful: true,
    };
  }

  const parsed = parseJsonLine(trimmed);
  if (parsed) {
    if (parsed.type === "thread.started" || parsed.type === "turn.started") {
      return null;
    }
    const item = safeRecord(parsed.item);
    const itemType = typeof item?.type === "string" ? item.type : "";
    if (itemType === "agent_message" && typeof item?.text === "string") {
      const humanized = humanizeAgentText(item.text);
      return humanized
        ? { text: humanized, kind: "activity", meaningful: true }
        : null;
    }
    if (itemType === "command_execution" && typeof item?.command === "string") {
      const summary = summarizeCommand(item.command);
      if (!summary) {
        return null;
      }
      return {
        text: summary,
        kind: "activity",
        meaningful: true,
      };
    }
    return null;
  }
  return null;
}

export function deriveUserProgressCandidate(input: ProgressEventInput): UserProgressCandidate | null {
  const { event, data, lastMeaningfulText } = input;
  if (event === "tool.started" && typeof data.toolName === "string") {
    const summary = summarizeToolStarted(data.toolName, data);
    return summary ? { text: summary, kind: "activity", meaningful: true } : null;
  }
  if (event === "job.started" || event === "job.progress" || event === "job.updated") {
    const summary = summarizeJobProgress(data);
    return summary
      ? {
          text: summary,
          kind: "status",
          phase: typeof data.phase === "string" ? data.phase : null,
          meaningful: !/running codex attempt \d+\.?$/iu.test(summary),
        }
      : null;
  }
  if ((event === "job.log" || event === "tool.progress") && typeof data.text === "string") {
    return summarizeLogLine(data.text, data, lastMeaningfulText);
  }
  if (event === "assistant.completed") {
    return {
      text: "Answer ready.",
      kind: "status",
      meaningful: true,
    };
  }
  if (event === "run.completed") {
    const completionMode = typeof data.completionMode === "string" ? data.completionMode : null;
    if (completionMode === "direct_response") {
      return null;
    }
    const status = typeof data.status === "string" ? data.status : "completed";
    if (status === "completed") {
      return {
        text: "Run completed.",
        kind: "status",
        meaningful: true,
      };
    }
    const error = typeof data.error === "string" && data.error.trim().length > 0
      ? truncateText(data.error)
      : "Run failed.";
    return {
      text: error,
      kind: "status",
      meaningful: true,
    };
  }
  return null;
}
