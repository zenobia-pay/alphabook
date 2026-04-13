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
  if (/\brg\b/u.test(normalized)) {
    if (quotedTerms.length > 0) {
      return truncateText(`Searching ${sourceVolume ? `source volume ${sourceVolume}` : "source texts"} for: ${quotedTerms.join("; ")}`);
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
    if (quotedTerms.length > 0) {
      return truncateText(`Running a comparison script for: ${quotedTerms.join("; ")}`);
    }
    return "Running a comparison script across the selected sources.";
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
    if (base === "run.log") {
      return "Reading the current run log.";
    }
    if (base === "status.json") {
      return "Checking the current run status.";
    }
    if (base === "manifest.json") {
      return "Reading the run manifest.";
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

function summarizePlainTextLine(text: string) {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return null;
  }
  if (/^\d+\s+\/srv\/alphabook\/logs\/.+\/scoped-files\.tsv$/u.test(normalized)) {
    const count = normalized.split(/\s+/u)[0] ?? "";
    return Number.isFinite(Number(count))
      ? `Scoped ${Number(count).toLocaleString("en-US")} candidate files for search.`
      : "Scoped candidate files for search.";
  }
  if (/^PART\s+\/srv\/alphabook\/logs\/.+\/partitions\/part-\d+\.files\.tsv$/u.test(normalized)) {
    return "Partitioned the scoped file list into search batches.";
  }
  if (/^Loaded \d+ available .* skills\.?$/iu.test(normalized)) {
    return normalized.endsWith(".") ? normalized : `${normalized}.`;
  }
  if (/^Determine corpus scope and write initial manifest\/run log\/scoped-files setup$/u.test(normalized)) {
    return normalized;
  }
  if (/^Run bounded searches over scoped TSV, inspect context, and keep representative evidence hits$/u.test(normalized)) {
    return normalized;
  }
  if (/^Read the .* instructions\.?$/iu.test(normalized)) {
    return normalized.endsWith(".") ? normalized : `${normalized}.`;
  }
  if (/^Unknown argument:/u.test(normalized)) {
    return truncateText(`Search helper failed: ${normalized}`);
  }
  if (/^KeyError:/u.test(normalized)) {
    return truncateText(`Workspace script failed: ${normalized}`);
  }
  if (/^Initialized run\./u.test(normalized)) {
    return truncateText(normalized);
  }
  if (/^Wrote `[^`]+`/u.test(normalized)) {
    return truncateText(normalized);
  }
  if (/^Launching the analysis workspace\.?$/u.test(normalized)) {
    return "Launching the analysis workspace.";
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
      return truncateText(`Launching the analysis workspace for: ${objective.trim()}`);
    }
    const rationale = typeof data.rationale === "string" ? data.rationale.trim() : "";
    return rationale ? truncateText(rationale) : "Launching the analysis workspace.";
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
    return truncateText(detail.endsWith(".") ? detail : `${detail}.`);
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
  const trimmed = stripLogTimestampPrefix(text.trim());
  if (!trimmed || commandLooksLikeJsonFragment(trimmed)) {
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
  const plainText = summarizePlainTextLine(trimmed);
  if (plainText) {
    return {
      text: plainText,
      kind: "activity",
      meaningful: true,
    };
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
