import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { loadDotEnvFile } from "./lib/benchmark-env";

interface ScriptOptions {
  runDir: string;
  query: string;
  model: string;
  concurrency: number;
  candidateBatchSize: number;
  maxCandidatesForLlm: number;
  maxCandidatesPerFile: number;
  contextBefore: number;
  contextAfter: number;
  maxSnippetChars: number;
  maxQuoteChars: number;
  resume: boolean;
}

interface RawMatch {
  filePath: string;
  lineNumber: number;
  lineText: string;
  keywordHits: string[];
}

interface CandidateSnippet {
  candidateId: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
  keywordHits: string[];
  score: number;
}

interface TriageFinding {
  candidateId: string;
  quote: string;
  themeLabel: string;
  reasoning: string;
  confidence: number;
}

interface DatasetRecord {
  record_id: string;
  source_file: string;
  source_title: string | null;
  source_author: string | null;
  source_year_or_period: string | null;
  corpus_scope: string;
  line_start: number;
  line_end: number;
  quote: string;
  theme_label: string;
  confidence: number;
  keyword_hits: string[];
  reasoning: string;
  notes: string;
}

interface RunStatus {
  phase: string;
  query: string;
  model: string;
  total_candidates: number;
  triaged_candidates: number;
  completed_batches: number;
  total_batches: number;
  kept_records: number;
  llm_calls: number;
  state: "running" | "completed" | "failed";
  phase_progress_pct: number;
  updated_at: string;
  detail: string;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    runDir: "",
    query: "",
    model: "gpt-5-mini",
    concurrency: 8,
    candidateBatchSize: 8,
    maxCandidatesForLlm: 5000,
    maxCandidatesPerFile: 3,
    contextBefore: 4,
    contextAfter: 6,
    maxSnippetChars: 2200,
    maxQuoteChars: 320,
    resume: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--run-dir":
        options.runDir = argv[++index] ?? options.runDir;
        break;
      case "--query":
        options.query = argv[++index] ?? options.query;
        break;
      case "--model":
        options.model = argv[++index] ?? options.model;
        break;
      case "--concurrency":
        options.concurrency = Number(argv[++index] ?? options.concurrency);
        break;
      case "--candidate-batch-size":
        options.candidateBatchSize = Number(argv[++index] ?? options.candidateBatchSize);
        break;
      case "--max-candidates-for-llm":
        options.maxCandidatesForLlm = Number(argv[++index] ?? options.maxCandidatesForLlm);
        break;
      case "--max-candidates-per-file":
        options.maxCandidatesPerFile = Number(argv[++index] ?? options.maxCandidatesPerFile);
        break;
      case "--context-before":
        options.contextBefore = Number(argv[++index] ?? options.contextBefore);
        break;
      case "--context-after":
        options.contextAfter = Number(argv[++index] ?? options.contextAfter);
        break;
      case "--max-snippet-chars":
        options.maxSnippetChars = Number(argv[++index] ?? options.maxSnippetChars);
        break;
      case "--max-quote-chars":
        options.maxQuoteChars = Number(argv[++index] ?? options.maxQuoteChars);
        break;
      case "--no-resume":
        options.resume = false;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node --import tsx packages/tooling/scripts/run-corpus-research-triage.ts --run-dir /path/to/run --query <text>\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.runDir || !options.query) {
    throw new Error("--run-dir and --query are required.");
  }

  return options;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function appendRunLog(runDir: string, message: string): Promise<void> {
  const runLogPath = path.join(runDir, "run.log");
  const existing = await readFile(runLogPath, "utf8").catch(() => "");
  await writeFile(runLogPath, `${existing}${nowIso()} ${message}\n`);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n");
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

async function updateStatus(runDir: string, status: RunStatus): Promise<void> {
  const statusPath = path.join(runDir, "status.json");
  const progressPath = path.join(runDir, "triage", "progress.jsonl");
  await writeJson(statusPath, status);
  await mkdir(path.dirname(progressPath), { recursive: true });
  const existing = await readFile(progressPath, "utf8").catch(() => "");
  await writeFile(progressPath, `${existing}${JSON.stringify(status)}\n`);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function trimSnippet(snippet: string, maxChars: number): string {
  if (snippet.length <= maxChars) {
    return snippet;
  }
  return `${snippet.slice(0, maxChars - 3)}...`;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged = [{ ...sorted[0]! }];
  for (const range of sorted.slice(1)) {
    const current = merged[merged.length - 1]!;
    if (range.start <= current.end + 1) {
      current.end = Math.max(current.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

async function parseRawMatches(searchPath: string): Promise<RawMatch[]> {
  const matches: RawMatch[] = [];
  const input = createReadStream(searchPath, "utf8");
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) {
      continue;
    }
    let payload: any;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    if (payload?.type !== "match") {
      continue;
    }
    const data = payload.data ?? {};
    const filePath = data.path?.text;
    const lineNumber = data.line_number;
    if (typeof filePath !== "string" || typeof lineNumber !== "number") {
      continue;
    }
    const lineText = typeof data.lines?.text === "string" ? data.lines.text : "";
    const keywordHits = Array.isArray(data.submatches)
      ? data.submatches.map((item: any) => String(item?.match?.text ?? "")).filter((value: string) => value.length > 0)
      : [];
    matches.push({
      filePath,
      lineNumber,
      lineText,
      keywordHits,
    });
  }
  return matches;
}

async function buildCandidates(runDir: string, matches: RawMatch[], options: ScriptOptions): Promise<CandidateSnippet[]> {
  const matchesByFile = new Map<string, RawMatch[]>();
  for (const match of matches) {
    const list = matchesByFile.get(match.filePath) ?? [];
    list.push(match);
    matchesByFile.set(match.filePath, list);
  }

  const candidates: CandidateSnippet[] = [];
  for (const [filePath, fileMatches] of matchesByFile.entries()) {
    const content = await readFile(filePath, "utf8").catch(() => null);
    if (!content) {
      continue;
    }
    const lines = content.replace(/\r/gu, "").split("\n");
    const ranges = mergeRanges(
      fileMatches.map((match) => ({
        start: Math.max(0, match.lineNumber - 1 - options.contextBefore),
        end: Math.min(lines.length - 1, match.lineNumber - 1 + options.contextAfter),
      })),
    );

    for (const range of ranges) {
      const rangeMatches = fileMatches.filter((match) => match.lineNumber - 1 >= range.start && match.lineNumber - 1 <= range.end);
      const snippet = trimSnippet(lines.slice(range.start, range.end + 1).join("\n"), options.maxSnippetChars);
      const keywordHits = [...new Set(rangeMatches.flatMap((match) => match.keywordHits.map((value) => value.toLowerCase())))];
      const candidateId = createHash("sha1")
        .update(`${filePath}:${range.start + 1}:${range.end + 1}:${snippet}`)
        .digest("hex")
        .slice(0, 16);
      candidates.push({
        candidateId,
        filePath,
        lineStart: range.start + 1,
        lineEnd: range.end + 1,
        snippet,
        keywordHits,
        score: scoreCandidate(keywordHits, snippet),
      });
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath) || left.lineStart - right.lineStart);
  await writeJsonl(path.join(runDir, "triage", "candidates.jsonl"), candidates);
  await writeJson(path.join(runDir, "triage", "candidates-summary.json"), {
    totalCandidates: candidates.length,
    totalFiles: matchesByFile.size,
  });
  return candidates;
}

function scoreCandidate(keywordHits: string[], snippet: string): number {
  const weights = new Map<string, number>([
    ["grief", 5],
    ["grieve", 5],
    ["grieving", 5],
    ["mourning", 5],
    ["mourn", 5],
    ["bereft", 5],
    ["bereavement", 5],
    ["bereaved", 5],
    ["inconsolable", 5],
    ["heartbroken", 4],
    ["heart-broken", 4],
    ["sorrow", 4],
    ["sorrowful", 4],
    ["lament", 4],
    ["lamentation", 4],
    ["anguish", 4],
    ["despair", 4],
    ["despondent", 4],
    ["consolation", 3],
    ["comfort", 3],
    ["comforted", 3],
    ["comforting", 3],
    ["weep", 3],
    ["wept", 3],
    ["weeping", 3],
    ["melancholy", 2],
    ["woe", 2],
  ]);

  let score = 0;
  for (const hit of keywordHits) {
    score += weights.get(hit) ?? 1;
  }
  const lower = snippet.toLowerCase();
  for (const [term, weight] of weights.entries()) {
    if (lower.includes(term)) {
      score += weight * 0.5;
    }
  }
  return Number(score.toFixed(2));
}

function batchCandidates(candidates: CandidateSnippet[], batchSize: number): CandidateSnippet[][] {
  const batches: CandidateSnippet[][] = [];
  for (let index = 0; index < candidates.length; index += batchSize) {
    batches.push(candidates.slice(index, index + batchSize));
  }
  return batches;
}

function selectCandidatesForLlm(candidates: CandidateSnippet[], options: ScriptOptions): CandidateSnippet[] {
  const byFile = new Map<string, CandidateSnippet[]>();
  for (const candidate of candidates) {
    const list = byFile.get(candidate.filePath) ?? [];
    if (list.length < options.maxCandidatesPerFile) {
      list.push(candidate);
      byFile.set(candidate.filePath, list);
    }
  }

  const selected = Array.from(byFile.values())
    .flat()
    .sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath) || left.lineStart - right.lineStart)
    .slice(0, options.maxCandidatesForLlm);

  return selected;
}

function triageSchema() {
  return {
    name: "corpus_research_triage",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["findings"],
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["candidateId", "quote", "themeLabel", "reasoning", "confidence"],
            properties: {
              candidateId: { type: "string" },
              quote: { type: "string" },
              themeLabel: { type: "string" },
              reasoning: { type: "string" },
              confidence: { type: "number" },
            },
          },
        },
      },
    },
  };
}

function briefingSchema() {
  return {
    name: "corpus_research_briefing",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["briefingMarkdown"],
      properties: {
        briefingMarkdown: { type: "string" },
      },
    },
  };
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

async function callOpenAI(input: {
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  schema: ReturnType<typeof triageSchema> | ReturnType<typeof briefingSchema>;
}): Promise<any> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      response_format: {
        type: "json_schema",
        json_schema: input.schema,
      },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with status ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  const payload = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string | null;
      };
    }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI request returned no content.");
  }
  return JSON.parse(extractJsonObject(content));
}

function buildTriagePrompt(query: string, batch: CandidateSnippet[], maxQuoteChars: number): string {
  const themeLabels = [
    "withdrawal_or_isolation",
    "weeping_or_lament",
    "religious_consolation",
    "stoicism_or_duty",
    "memorialization_or_remembrance",
    "companionship_or_caretaking",
    "anger_or_revenge",
    "despair_or_melancholy",
    "acceptance_or_reconciliation",
    "work_or_activity",
    "travel_or_escape",
    "art_or_writing",
    "philosophical_reflection",
    "other",
  ];

  return [
    "You are in the candidate-triage stage of a literary research run.",
    "The user is asking about how authors deal with grief in 19th century literature.",
    "For each candidate, decide whether the passage is genuinely relevant to grief, mourning, bereavement, coping with loss, remembrance after loss, or a concrete response to grief.",
    "Discard passages that are just keyword noise, political rhetoric, decorative mourning language, or unrelated sadness.",
    "When a candidate is relevant, extract one exact quote from the snippet and assign the closest theme label.",
    `Allowed theme labels: ${themeLabels.join(", ")}`,
    `Keep quotes under ${maxQuoteChars} characters.`,
    "Return only supported findings. Zero findings for a candidate is acceptable.",
    "",
    `User query: ${query}`,
    "",
    "Candidates:",
    ...batch.map((candidate, index) => [
      `Candidate ${index + 1}`,
      `candidateId: ${candidate.candidateId}`,
      `filePath: ${candidate.filePath}`,
      `lineStart: ${candidate.lineStart}`,
      `lineEnd: ${candidate.lineEnd}`,
      `keywordHits: ${candidate.keywordHits.join(", ") || "(none)"}`,
      candidate.snippet,
    ].join("\n")),
  ].join("\n");
}

function csvEscape(value: string): string {
  const escaped = value.replace(/"/gu, "\"\"");
  return `"${escaped}"`;
}

function inferTitle(filePath: string): string | null {
  const base = path.basename(filePath).replace(/\.[^.]+$/u, "");
  return base || null;
}

function normalizeQuoteKey(record: DatasetRecord): string {
  return `${record.source_file}::${record.quote.toLowerCase().replace(/[\W_]+/gu, " ").trim()}`;
}

async function mapLimit<T, U>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await worker(items[current]!, current);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker()));
  return results;
}

function buildBriefingPrompt(input: {
  query: string;
  chosenScope: string;
  totalCandidates: number;
  totalRecords: number;
  themeCounts: Record<string, number>;
  records: DatasetRecord[];
}): string {
  const representative = Object.entries(
    input.records.reduce<Record<string, DatasetRecord[]>>((accumulator, record) => {
      const items = accumulator[record.theme_label] ?? [];
      if (items.length < 3) {
        items.push(record);
      }
      accumulator[record.theme_label] = items;
      return accumulator;
    }, {}),
  )
    .map(([theme, records]) => [
      `Theme: ${theme}`,
      ...records.map((record) => `- ${record.quote} (${record.source_file}:${record.line_start}-${record.line_end})`),
    ].join("\n"))
    .join("\n\n");

  return [
    "Write a concise research briefing in Markdown.",
    "The briefing must include: method, scope, schema summary, main findings, theme breakdown, caveats, and what the dataset suggests.",
    "Use short paragraphs and flat bullets where useful.",
    "Do not invent records beyond the supplied dataset summary.",
    "",
    `User query: ${input.query}`,
    `Chosen scope: ${input.chosenScope}`,
    `Candidate passages triaged: ${input.totalCandidates}`,
    `Dataset records kept: ${input.totalRecords}`,
    `Theme counts: ${JSON.stringify(input.themeCounts)}`,
    "",
    "Representative records:",
    representative || "(none)",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnvFile().catch(() => undefined);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const runDir = path.resolve(process.cwd(), options.runDir);
  const searchPath = path.join(runDir, "search", "rg_hits.jsonl");
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;

  await mkdir(path.join(runDir, "triage", "batches"), { recursive: true });
  await mkdir(path.join(runDir, "visualizations"), { recursive: true });

  const status: RunStatus = {
    phase: "candidate_extraction",
    query: options.query,
    model: options.model,
    total_candidates: 0,
    triaged_candidates: 0,
    completed_batches: 0,
    total_batches: 0,
    kept_records: 0,
    llm_calls: 0,
    state: "running",
    phase_progress_pct: 0,
    updated_at: nowIso(),
    detail: "Parsing ripgrep match events",
  };
  await updateStatus(runDir, status);
  await appendRunLog(runDir, "triage phase started");

  const rawMatches = await parseRawMatches(searchPath);
  await writeJson(path.join(runDir, "triage", "raw-match-summary.json"), {
    totalMatches: rawMatches.length,
  });
  const candidates = await buildCandidates(runDir, rawMatches, options);
  const selectedCandidates = selectCandidatesForLlm(candidates, options);
  await writeJsonl(path.join(runDir, "triage", "candidates-ranked.jsonl"), selectedCandidates);
  await writeJson(path.join(runDir, "triage", "selection-summary.json"), {
    totalCandidates: candidates.length,
    selectedForLlm: selectedCandidates.length,
    maxCandidatesForLlm: options.maxCandidatesForLlm,
    maxCandidatesPerFile: options.maxCandidatesPerFile,
  });

  status.total_candidates = selectedCandidates.length;
  status.detail = `Built ${candidates.length} candidate snippets from ${rawMatches.length} match events; selected ${selectedCandidates.length} for LLM triage`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);
  await appendRunLog(runDir, status.detail);

  const batches = batchCandidates(selectedCandidates, options.candidateBatchSize);
  status.phase = "triage";
  status.total_batches = batches.length;
  status.detail = `Triaging ${selectedCandidates.length} scored candidates across ${batches.length} batches`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);
  await appendRunLog(runDir, status.detail);

  const batchResults = await mapLimit(batches, options.concurrency, async (batch, index) => {
    const batchPath = path.join(runDir, "triage", "batches", `batch-${String(index + 1).padStart(5, "0")}.json`);
    if (options.resume) {
      const existing = await readFile(batchPath, "utf8").then((value) => JSON.parse(value) as { findings: TriageFinding[] }).catch(() => null);
      if (existing) {
        status.completed_batches += 1;
        status.triaged_candidates += batch.length;
        status.kept_records += existing.findings.length;
        status.phase_progress_pct = Number(((status.completed_batches / Math.max(1, status.total_batches)) * 100).toFixed(2));
        status.updated_at = nowIso();
        status.detail = `Reused triage batch ${index + 1}/${status.total_batches}`;
        await updateStatus(runDir, status);
        return existing.findings;
      }
    }

    const response = await callOpenAI({
      apiKey,
      model: options.model,
      system: "Return only valid JSON. Keep each quote exact and grounded in the supplied snippet.",
      prompt: buildTriagePrompt(options.query, batch, options.maxQuoteChars),
      schema: triageSchema(),
    }) as { findings?: TriageFinding[] };

    const findings = (response.findings ?? []).map((finding) => ({
      ...finding,
      quote: normalizeWhitespace(finding.quote).slice(0, options.maxQuoteChars),
      reasoning: normalizeWhitespace(finding.reasoning),
      themeLabel: normalizeWhitespace(finding.themeLabel).toLowerCase().replace(/[^\w]+/gu, "_"),
      confidence: Math.max(0, Math.min(1, Number.isFinite(finding.confidence) ? finding.confidence : 0)),
    }));
    await writeJson(batchPath, { findings });

    status.completed_batches += 1;
    status.triaged_candidates += batch.length;
    status.kept_records += findings.length;
    status.llm_calls += 1;
    status.phase_progress_pct = Number(((status.completed_batches / Math.max(1, status.total_batches)) * 100).toFixed(2));
    status.updated_at = nowIso();
    status.detail = `Triaged batch ${index + 1}/${status.total_batches}; kept ${findings.length} findings`;
    await updateStatus(runDir, status);
    await appendRunLog(runDir, status.detail);
    return findings;
  });

  const candidateById = new Map(selectedCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const records: DatasetRecord[] = [];
  for (const finding of batchResults.flat()) {
    const candidate = candidateById.get(finding.candidateId);
    if (!candidate || !finding.quote) {
      continue;
    }
    const recordId = createHash("sha1")
      .update(`${candidate.filePath}:${candidate.lineStart}:${finding.quote}:${finding.themeLabel}`)
      .digest("hex")
      .slice(0, 16);
    records.push({
      record_id: recordId,
      source_file: candidate.filePath,
      source_title: inferTitle(candidate.filePath),
      source_author: null,
      source_year_or_period: "19th century approx",
      corpus_scope: String(manifest.chosen_scope ?? "scoped raw-text corpus"),
      line_start: candidate.lineStart,
      line_end: candidate.lineEnd,
      quote: finding.quote,
      theme_label: finding.themeLabel || "other",
      confidence: finding.confidence,
      keyword_hits: candidate.keywordHits,
      reasoning: finding.reasoning,
      notes: "",
    });
  }

  const deduped = Array.from(
    new Map(records.map((record) => [normalizeQuoteKey(record), record])).values(),
  ).sort((left, right) => right.confidence - left.confidence);

  const datasetJsonlPath = path.join(runDir, "dataset.jsonl");
  const datasetCsvPath = path.join(runDir, "dataset.csv");
  const citationIndexPath = path.join(runDir, "citation-index.json");
  const themeCounts = deduped.reduce<Record<string, number>>((accumulator, record) => {
    accumulator[record.theme_label] = (accumulator[record.theme_label] ?? 0) + 1;
    return accumulator;
  }, {});

  await writeJsonl(datasetJsonlPath, deduped);
  const csvHeader = [
    "record_id",
    "source_file",
    "source_title",
    "source_author",
    "source_year_or_period",
    "corpus_scope",
    "line_start",
    "line_end",
    "quote",
    "theme_label",
    "confidence",
    "keyword_hits",
    "reasoning",
    "notes",
  ];
  const csvRows = [
    csvHeader.join(","),
    ...deduped.map((record) => [
      csvEscape(record.record_id),
      csvEscape(record.source_file),
      csvEscape(record.source_title ?? ""),
      csvEscape(record.source_author ?? ""),
      csvEscape(record.source_year_or_period ?? ""),
      csvEscape(record.corpus_scope),
      String(record.line_start),
      String(record.line_end),
      csvEscape(record.quote),
      csvEscape(record.theme_label),
      String(record.confidence),
      csvEscape(record.keyword_hits.join("|")),
      csvEscape(record.reasoning),
      csvEscape(record.notes),
    ].join(",")),
  ];
  await writeFile(datasetCsvPath, `${csvRows.join("\n")}\n`);
  await writeJson(citationIndexPath, deduped.map((record) => ({
    record_id: record.record_id,
    source_file: record.source_file,
    line_start: record.line_start,
    line_end: record.line_end,
    quote: record.quote,
  })));
  await writeJson(path.join(runDir, "visualizations", "theme-counts.json"), themeCounts);
  await writeFile(
    path.join(runDir, "visualizations", "theme-counts.csv"),
    `theme_label,count\n${Object.entries(themeCounts).map(([label, count]) => `${csvEscape(label)},${count}`).join("\n")}\n`,
  );

  status.phase = "synthesis";
  status.kept_records = deduped.length;
  status.phase_progress_pct = 0;
  status.detail = `Writing briefing from ${deduped.length} deduplicated records`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);
  await appendRunLog(runDir, status.detail);

  let briefingMarkdown = [
    "# Corpus Research Briefing",
    "",
    `Query: ${options.query}`,
    "",
    `Chosen scope: ${manifest.chosen_scope ?? "scoped raw-text corpus"}`,
    "",
    `Records kept: ${deduped.length}`,
    "",
    "Theme counts:",
    ...Object.entries(themeCounts).sort((left, right) => right[1] - left[1]).map(([label, count]) => `- ${label}: ${count}`),
  ].join("\n");

  if (deduped.length > 0) {
    try {
      const briefingResponse = await callOpenAI({
        apiKey,
        model: options.model,
        system: "Return only valid JSON. The markdown should stay concise and grounded in the supplied dataset summary.",
        prompt: buildBriefingPrompt({
          query: options.query,
          chosenScope: String(manifest.chosen_scope ?? "scoped raw-text corpus"),
          totalCandidates: selectedCandidates.length,
          totalRecords: deduped.length,
          themeCounts,
          records: deduped.slice(0, 60),
        }),
        schema: briefingSchema(),
      }) as { briefingMarkdown?: string };
      if (briefingResponse.briefingMarkdown?.trim()) {
        briefingMarkdown = briefingResponse.briefingMarkdown.trim();
      }
      status.llm_calls += 1;
    } catch (error) {
      await appendRunLog(runDir, `briefing fallback due to synthesis error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await writeFile(path.join(runDir, "briefing.md"), `${briefingMarkdown}\n`);
  manifest.schema_summary = {
    record_id: "stable quote record identifier",
    source_file: "absolute corpus path",
    quote: "exact extracted quote",
    theme_label: "coping/grief strategy label",
    confidence: "0-1 triage score",
    reasoning: "why the quote is relevant",
  };
  manifest.output_file_list = [
    "manifest.json",
    "run.log",
    "search/rg_hits.jsonl",
    "dataset.jsonl",
    "dataset.csv",
    "citation-index.json",
    "briefing.md",
    "visualizations/theme-counts.json",
    "visualizations/theme-counts.csv",
  ];
  manifest.record_counts = {
    ...(manifest.record_counts ?? {}),
    raw_match_events: rawMatches.length,
    candidate_snippets: candidates.length,
    llm_triage_candidates: selectedCandidates.length,
    dataset_records: deduped.length,
  };
  manifest.status = "completed";
  await writeJson(manifestPath, manifest);

  status.phase = "completed";
  status.state = "completed";
  status.phase_progress_pct = 100;
  status.updated_at = nowIso();
  status.detail = `Completed run with ${deduped.length} dataset records`;
  await updateStatus(runDir, status);
  await appendRunLog(runDir, status.detail);
}

main().catch(async (error) => {
  const options = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(process.cwd(), options.runDir);
  const status: RunStatus = {
    phase: "failed",
    query: options.query,
    model: options.model,
    total_candidates: 0,
    triaged_candidates: 0,
    completed_batches: 0,
    total_batches: 0,
    kept_records: 0,
    llm_calls: 0,
    state: "failed",
    phase_progress_pct: 0,
    updated_at: nowIso(),
    detail: error instanceof Error ? error.message : String(error),
  };
  await updateStatus(runDir, status).catch(() => undefined);
  await appendRunLog(runDir, `triage failed: ${status.detail}`).catch(() => undefined);
  process.stderr.write(`${status.detail}\n`);
  process.exitCode = 1;
});
