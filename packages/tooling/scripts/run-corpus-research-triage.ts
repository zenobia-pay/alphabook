import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

import { loadDotEnvFile } from "./lib/benchmark-env";

interface ScriptOptions {
  runDir: string;
  query: string;
  nanoModel: string;
  escalationModel: string;
  synthesisModel: string;
  concurrency: number;
  candidateBatchSize: number;
  fallbackChunkWords: number;
  overlapWords: number;
  minPassageWords: number;
  maxPassageWords: number;
  maxQuoteChars: number;
  shardCount: number;
  resume: boolean;
}

interface RawMatch {
  filePath: string;
  lineNumber: number;
  keywordHits: string[];
}

interface FileShardEntry {
  filePath: string;
  lineNumber: number;
  keywordHits: string[];
}

interface PassageNeighborhood {
  lineStart: number;
  lineEnd: number;
  passageText: string;
}

interface CandidateOccurrence {
  candidateId: string;
  canonicalPassageId: string;
  sourceFile: string;
  sourceTitle: string | null;
  sourceAuthor: string | null;
  sourceYearOrPeriod: string | null;
  lineStart: number;
  lineEnd: number;
  matchedTerms: string[];
  passageText: string;
  lexicalScore: number;
  workKey: string;
}

interface CandidateProvenance {
  source_file: string;
  source_title: string | null;
  source_author: string | null;
  source_year_or_period: string | null;
  line_start: number;
  line_end: number;
  matched_terms: string[];
}

interface CanonicalCandidate {
  candidate_id: string;
  canonical_passage_id: string;
  near_duplicate_group_id: string;
  source_file: string;
  source_title: string | null;
  source_author: string | null;
  source_year_or_period: string | null;
  line_start: number;
  line_end: number;
  matched_terms: string[];
  passage_text: string;
  duplicate_count: number;
  lexical_score: number;
  work_key: string;
  provenances: CandidateProvenance[];
}

interface BaseDecision {
  candidateId: string;
  isRelevant: boolean;
  relevanceConfidence: number;
  exactQuote: string;
  themeLabel: string;
  reasoning: string;
  primaryFrame: string;
  responseFrame: string;
  needsEscalation: boolean;
}

interface NanoDecision extends BaseDecision {
  stage: "nano";
  escalate: boolean;
}

interface MiniDecision extends BaseDecision {
  stage: "mini";
}

interface ConfirmedPassageRecord {
  record_id: string;
  candidate_id: string;
  canonical_passage_id: string;
  near_duplicate_group_id: string;
  source_file: string;
  source_title: string | null;
  source_author: string | null;
  source_year_or_period: string | null;
  corpus_scope: string;
  line_start: number;
  line_end: number;
  quote: string;
  theme_label: string;
  primary_frame: string;
  response_frame: string;
  confidence: number;
  lexical_score: number;
  duplicate_count: number;
  matched_terms: string[];
  reasoning: string;
  accepted_by: "nano" | "mini";
}

interface ClusterRecord {
  cluster_id: string;
  dominant_theme: string;
  primary_frame: string;
  response_frame: string;
  canonical_quote: string;
  representative_quote: string;
  cluster_size: number;
  source_works: string[];
  confidence_summary: {
    min: number;
    max: number;
    avg: number;
  };
  record_ids: string[];
}

interface CitationRecord {
  record_id: string;
  cluster_id: string;
  candidate_id: string;
  canonical_passage_id: string;
  quote: string;
  source_file: string;
  line_start: number;
  line_end: number;
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
  candidate_count_after_exact_dedupe?: number;
  candidate_count_after_near_duplicate_grouping?: number;
  nano_accept_count?: number;
  nano_escalation_count?: number;
  mini_accept_count?: number;
  cluster_count?: number;
  estimated_cumulative_cost_usd?: number;
}

interface UsageRecord {
  phase: "nano" | "mini" | "synthesis";
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
}

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

interface OpenAiResponse<T> {
  parsed: T;
  usage: UsageRecord;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5.4": { inputPerMillion: 2.5, outputPerMillion: 15.0 },
  "gpt-5": { inputPerMillion: 2.5, outputPerMillion: 15.0 },
  "gpt-5.4-mini": { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  "gpt-5.4-nano": { inputPerMillion: 0.2, outputPerMillion: 1.25 },
  "gpt-5-nano": { inputPerMillion: 0.05, outputPerMillion: 0.4 },
  "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2.0 },
};

function openAiBaseUrl(): string {
  const configured = process.env.OPENAI_BASE_URL?.trim();
  if (!configured) {
    return "https://api.openai.com/v1";
  }
  return configured.replace(/\/+$/u, "");
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    runDir: "",
    query: "",
    nanoModel: "gpt-5-nano",
    escalationModel: "gpt-5-mini",
    synthesisModel: "gpt-5.4",
    concurrency: 8,
    candidateBatchSize: 6,
    fallbackChunkWords: 900,
    overlapWords: 180,
    minPassageWords: 220,
    maxPassageWords: 1200,
    maxQuoteChars: 320,
    shardCount: 64,
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
      case "--nano-model":
        options.nanoModel = argv[++index] ?? options.nanoModel;
        break;
      case "--escalation-model":
        options.escalationModel = argv[++index] ?? options.escalationModel;
        break;
      case "--synthesis-model":
        options.synthesisModel = argv[++index] ?? options.synthesisModel;
        break;
      case "--model":
        options.escalationModel = argv[++index] ?? options.escalationModel;
        options.synthesisModel = options.escalationModel;
        break;
      case "--concurrency":
        options.concurrency = Number(argv[++index] ?? options.concurrency);
        break;
      case "--candidate-batch-size":
        options.candidateBatchSize = Number(argv[++index] ?? options.candidateBatchSize);
        break;
      case "--fallback-chunk-words":
        options.fallbackChunkWords = Number(argv[++index] ?? options.fallbackChunkWords);
        break;
      case "--overlap-words":
        options.overlapWords = Number(argv[++index] ?? options.overlapWords);
        break;
      case "--min-passage-words":
        options.minPassageWords = Number(argv[++index] ?? options.minPassageWords);
        break;
      case "--max-passage-words":
        options.maxPassageWords = Number(argv[++index] ?? options.maxPassageWords);
        break;
      case "--max-quote-chars":
        options.maxQuoteChars = Number(argv[++index] ?? options.maxQuoteChars);
        break;
      case "--shard-count":
        options.shardCount = Number(argv[++index] ?? options.shardCount);
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
  if (options.shardCount < 1) {
    throw new Error("--shard-count must be >= 1.");
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

function sanitizeForJsonTransport(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1];
        index += 1;
      } else {
        output += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\uFFFD";
      continue;
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      output += " ";
      continue;
    }
    output += value[index]!;
  }
  return output;
}

function normalizePassageText(value: string): string {
  return normalizeWhitespace(value.replace(/[“”]/gu, "\"").replace(/[‘’]/gu, "'").toLowerCase());
}

function inferTitle(filePath: string): string | null {
  const base = path.basename(filePath).replace(/\.[^.]+$/u, "");
  return base || null;
}

function inferYearOrPeriod(filePath: string, content: string): string | null {
  const firstLines = content.split("\n").slice(0, 120).join("\n");
  const year = firstLines.match(/\b(18\d{2}|19\d{2})\b/u)?.[1];
  return year ?? null;
}

function inferAuthor(content: string): string | null {
  const firstLines = content.split("\n").slice(0, 80);
  for (const line of firstLines) {
    const normalized = normalizeWhitespace(line);
    const match = normalized.match(/^(?:author|by)\s*[:\-]?\s+(.{2,120})$/iu);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function workKeyForCandidate(sourceTitle: string | null, sourceAuthor: string | null, filePath: string): string {
  return normalizeWhitespace(`${sourceAuthor ?? ""} ${sourceTitle ?? inferTitle(filePath) ?? filePath}`).toLowerCase();
}

function hashToShard(value: string, shardCount: number): number {
  const hash = createHash("sha1").update(value).digest("hex");
  return Number.parseInt(hash.slice(0, 8), 16) % shardCount;
}

function wordCount(value: string): number {
  const normalized = normalizeWhitespace(value);
  return normalized ? normalized.split(/\s+/u).length : 0;
}

function scoreLexicalTerms(terms: string[], text: string): number {
  const lower = text.toLowerCase();
  const normalizedTerms = [...new Set(terms.map((value) => normalizeWhitespace(value).toLowerCase()).filter(Boolean))];
  let score = 0;
  for (const term of normalizedTerms) {
    const specificity = Math.min(4, Math.max(1, Math.ceil(term.length / 6)));
    score += specificity;
    if (lower.includes(term)) {
      score += 0.5;
    }
  }
  score += Math.log2(1 + normalizedTerms.length);
  return Number(score.toFixed(2));
}

function createNearDuplicateGroupId(text: string): string {
  const tokens = normalizePassageText(text).split(/\s+/u).filter(Boolean);
  const key = tokens.length <= 64 ? tokens.join(" ") : [...tokens.slice(0, 40), ...tokens.slice(-24)].join(" ");
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
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

function pricingForModel(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? MODEL_PRICING["gpt-5-mini"];
}

function usageToCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = pricingForModel(model);
  return Number(
    (((promptTokens / 1_000_000) * pricing.inputPerMillion) + ((completionTokens / 1_000_000) * pricing.outputPerMillion)).toFixed(6),
  );
}

function paragraphGroups(lines: string[]): Array<{ startLine: number; endLine: number; text: string; words: number }> {
  const groups: Array<{ startLine: number; endLine: number; text: string; words: number }> = [];
  let currentStart = -1;
  const currentLines: string[] = [];
  const flush = (endLine: number) => {
    if (currentStart < 0) {
      return;
    }
    const text = currentLines.join("\n");
    groups.push({
      startLine: currentStart,
      endLine,
      text,
      words: wordCount(text),
    });
    currentStart = -1;
    currentLines.length = 0;
  };

  lines.forEach((line, index) => {
    if (!line.trim()) {
      flush(index - 1);
      return;
    }
    if (currentStart < 0) {
      currentStart = index + 1;
    }
    currentLines.push(line);
  });
  flush(lines.length);
  return groups;
}

function buildLineToParagraphIndex(groups: Array<{ startLine: number; endLine: number }>, totalLines: number): number[] {
  const index = new Array<number>(totalLines).fill(-1);
  groups.forEach((group, groupIndex) => {
    for (let line = group.startLine; line <= group.endLine; line += 1) {
      index[line - 1] = groupIndex;
    }
  });
  return index;
}

function fallbackChunkAroundLine(lines: string[], matchLine: number, options: ScriptOptions): PassageNeighborhood {
  const targetWords = options.fallbackChunkWords;
  let start = Math.max(1, matchLine);
  let end = Math.max(1, matchLine);
  let totalWords = wordCount(lines[matchLine - 1] ?? "");

  while (totalWords < targetWords && (start > 1 || end < lines.length)) {
    const canGrowPrev = start > 1;
    const canGrowNext = end < lines.length;
    if (canGrowPrev) {
      start -= 1;
      totalWords += wordCount(lines[start - 1] ?? "");
    }
    if (totalWords >= targetWords) {
      break;
    }
    if (canGrowNext) {
      end += 1;
      totalWords += wordCount(lines[end - 1] ?? "");
    }
  }

  const overlapWords = options.overlapWords;
  while (start > 1 && totalWords < targetWords + overlapWords) {
    start -= 1;
    totalWords += wordCount(lines[start - 1] ?? "");
  }

  return {
    lineStart: start,
    lineEnd: end,
    passageText: lines.slice(start - 1, end).join("\n"),
  };
}

function buildPassageNeighborhoodForMatch(
  lines: string[],
  groups: Array<{ startLine: number; endLine: number; text: string; words: number }>,
  lineToParagraph: number[],
  matchLine: number,
  options: ScriptOptions,
): PassageNeighborhood {
  const paragraphIndex = lineToParagraph[Math.max(0, Math.min(lines.length - 1, matchLine - 1))] ?? -1;
  if (paragraphIndex < 0 || !groups[paragraphIndex]) {
    return fallbackChunkAroundLine(lines, matchLine, options);
  }

  let startGroup = paragraphIndex;
  let endGroup = paragraphIndex;
  let totalWords = groups[paragraphIndex]!.words;

  while (totalWords < options.minPassageWords && (startGroup > 0 || endGroup < groups.length - 1)) {
    const leftGroup = startGroup > 0 ? groups[startGroup - 1] : null;
    const rightGroup = endGroup < groups.length - 1 ? groups[endGroup + 1] : null;
    if (leftGroup && (!rightGroup || leftGroup.words <= rightGroup.words)) {
      startGroup -= 1;
      totalWords += leftGroup.words;
      continue;
    }
    if (rightGroup) {
      endGroup += 1;
      totalWords += rightGroup.words;
      continue;
    }
    break;
  }

  const passageText = groups.slice(startGroup, endGroup + 1).map((group) => group.text).join("\n\n");
  if (totalWords > options.maxPassageWords) {
    return fallbackChunkAroundLine(lines, matchLine, options);
  }

  return {
    lineStart: groups[startGroup]!.startLine,
    lineEnd: groups[endGroup]!.endLine,
    passageText,
  };
}

function canonicalPassageIdForText(text: string): string {
  return createHash("sha1").update(normalizePassageText(text)).digest("hex").slice(0, 16);
}

function normalizeThemeLabel(value: string): string {
  const normalized = normalizeWhitespace(value).toLowerCase().replace(/[^\w]+/gu, "_");
  return normalized || "other";
}

function lexicalEscalationFloor(lexicalScore: number): boolean {
  return lexicalScore >= 10;
}

async function parseRawMatchesSummary(searchPath: string): Promise<{ totalMatches: number }> {
  const input = createReadStream(searchPath, "utf8");
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let totalMatches = 0;
  for await (const line of reader) {
    if (!line.trim()) {
      continue;
    }
    try {
      const payload = JSON.parse(line) as any;
      if (payload?.type === "match") {
        totalMatches += 1;
      }
    } catch {
      continue;
    }
  }
  return { totalMatches };
}

async function shardRawMatches(runDir: string, searchPath: string, options: ScriptOptions, status: RunStatus): Promise<void> {
  const shardDir = path.join(runDir, "triage", "raw-match-shards");
  const doneMarker = path.join(shardDir, "_done.json");
  if (options.resume) {
    const existing = await readFile(doneMarker, "utf8").then((value) => JSON.parse(value) as { totalMatches: number }).catch(() => null);
    if (existing) {
      status.detail = `Reused raw match shards (${existing.totalMatches} match events)`;
      status.updated_at = nowIso();
      await updateStatus(runDir, status);
      return;
    }
  }

  await rm(shardDir, { recursive: true, force: true });
  await mkdir(shardDir, { recursive: true });
  const streams = new Map<number, ReturnType<typeof createWriteStream>>();
  const getStream = (index: number) => {
    const existing = streams.get(index);
    if (existing) {
      return existing;
    }
    const stream = createWriteStream(path.join(shardDir, `shard-${String(index).padStart(3, "0")}.jsonl`), { flags: "a" });
    streams.set(index, stream);
    return stream;
  };

  const input = createReadStream(searchPath, "utf8");
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let totalMatches = 0;
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
    const entry: FileShardEntry = {
      filePath,
      lineNumber,
      keywordHits: Array.isArray(data.submatches)
        ? data.submatches.map((item: any) => String(item?.match?.text ?? "")).filter((value: string) => value.length > 0)
        : [],
    };
    getStream(hashToShard(filePath, options.shardCount)).write(`${JSON.stringify(entry)}\n`);
    totalMatches += 1;
    if (totalMatches % 50_000 === 0) {
      status.phase_progress_pct = 5;
      status.detail = `Sharded ${totalMatches} raw match events`;
      status.updated_at = nowIso();
      await updateStatus(runDir, status);
    }
  }

  await Promise.all(Array.from(streams.values()).map((stream) => new Promise<void>((resolve, reject) => {
    stream.end((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  })));

  await writeJson(doneMarker, { totalMatches });
  status.detail = `Sharded ${totalMatches} raw match events`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);
}

async function buildCandidateOccurrences(runDir: string, options: ScriptOptions, status: RunStatus): Promise<{ exactCandidates: number }> {
  const rawShardDir = path.join(runDir, "triage", "raw-match-shards");
  const occurrenceDir = path.join(runDir, "triage", "occurrence-shards");
  const doneMarker = path.join(occurrenceDir, "_done.json");
  if (options.resume) {
    const existing = await readFile(doneMarker, "utf8").then((value) => JSON.parse(value) as { exactCandidates: number }).catch(() => null);
    if (existing) {
      status.detail = `Reused occurrence shards (${existing.exactCandidates} passage occurrences)`;
      status.updated_at = nowIso();
      await updateStatus(runDir, status);
      return existing;
    }
  }

  await rm(occurrenceDir, { recursive: true, force: true });
  await mkdir(occurrenceDir, { recursive: true });
  const outStreams = new Map<number, ReturnType<typeof createWriteStream>>();
  const getOutStream = (index: number) => {
    const existing = outStreams.get(index);
    if (existing) {
      return existing;
    }
    const stream = createWriteStream(path.join(occurrenceDir, `occurrence-${String(index).padStart(3, "0")}.jsonl`), { flags: "a" });
    outStreams.set(index, stream);
    return stream;
  };

  const shardPaths = Array.from({ length: options.shardCount }, (_, index) => path.join(rawShardDir, `shard-${String(index).padStart(3, "0")}.jsonl`));
  let occurrenceCount = 0;
  let shardIndex = 0;
  for (const shardPath of shardPaths) {
    shardIndex += 1;
    const exists = await stat(shardPath).then(() => true).catch(() => false);
    if (!exists) {
      continue;
    }
    const fileMatches = new Map<string, RawMatch[]>();
    const input = createReadStream(shardPath, "utf8");
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.trim()) {
        continue;
      }
      const entry = JSON.parse(line) as FileShardEntry;
      const list = fileMatches.get(entry.filePath) ?? [];
      list.push({
        filePath: entry.filePath,
        lineNumber: entry.lineNumber,
        keywordHits: entry.keywordHits,
      });
      fileMatches.set(entry.filePath, list);
    }

    for (const [filePath, matches] of fileMatches.entries()) {
      const content = await readFile(filePath, "utf8").catch(() => null);
      if (!content) {
        continue;
      }
      const lines = content.replace(/\r/gu, "").split("\n");
      const paragraphs = paragraphGroups(lines);
      const lineToParagraph = buildLineToParagraphIndex(paragraphs, lines.length);
      const sourceTitle = inferTitle(filePath);
      const sourceAuthor = inferAuthor(content);
      const sourceYearOrPeriod = inferYearOrPeriod(filePath, content);
      const workKey = workKeyForCandidate(sourceTitle, sourceAuthor, filePath);
      const byNeighborhood = new Map<string, { passage: PassageNeighborhood; matchedTerms: Set<string> }>();

      for (const match of matches) {
        const passage = buildPassageNeighborhoodForMatch(lines, paragraphs, lineToParagraph, match.lineNumber, options);
        const neighborhoodKey = `${passage.lineStart}:${passage.lineEnd}`;
        const bucket = byNeighborhood.get(neighborhoodKey) ?? { passage, matchedTerms: new Set<string>() };
        match.keywordHits.forEach((term) => bucket.matchedTerms.add(term.toLowerCase()));
        byNeighborhood.set(neighborhoodKey, bucket);
      }

      for (const { passage, matchedTerms } of byNeighborhood.values()) {
        const canonicalPassageId = canonicalPassageIdForText(passage.passageText);
        const occurrence: CandidateOccurrence = {
          candidateId: createHash("sha1").update(`${filePath}:${passage.lineStart}:${passage.lineEnd}:${canonicalPassageId}`).digest("hex").slice(0, 16),
          canonicalPassageId,
          sourceFile: filePath,
          sourceTitle,
          sourceAuthor,
          sourceYearOrPeriod,
          lineStart: passage.lineStart,
          lineEnd: passage.lineEnd,
          matchedTerms: [...matchedTerms].sort(),
          passageText: passage.passageText,
          lexicalScore: scoreLexicalTerms([...matchedTerms], passage.passageText),
          workKey,
        };
        getOutStream(hashToShard(canonicalPassageId, options.shardCount)).write(`${JSON.stringify(occurrence)}\n`);
        occurrenceCount += 1;
      }
    }

    status.phase_progress_pct = Number(((shardIndex / Math.max(1, shardPaths.length)) * 25).toFixed(2));
    status.detail = `Built passage neighborhoods from shard ${shardIndex}/${shardPaths.length}; occurrences=${occurrenceCount}`;
    status.updated_at = nowIso();
    await updateStatus(runDir, status);
  }

  await Promise.all(Array.from(outStreams.values()).map((stream) => new Promise<void>((resolve, reject) => {
    stream.end((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  })));
  await writeJson(doneMarker, { exactCandidates: occurrenceCount });
  status.detail = `Built ${occurrenceCount} passage occurrences`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);
  return { exactCandidates: occurrenceCount };
}

async function canonicalizeCandidates(runDir: string, options: ScriptOptions, status: RunStatus): Promise<{
  canonicalCandidateCount: number;
  nearDuplicateGroupCount: number;
}> {
  const occurrenceDir = path.join(runDir, "triage", "occurrence-shards");
  const candidatePath = path.join(runDir, "triage", "canonical-candidates.jsonl");
  const doneMarker = path.join(runDir, "triage", "canonical-candidates-summary.json");
  if (options.resume) {
    const existing = await readFile(doneMarker, "utf8").then((value) => JSON.parse(value) as {
      canonicalCandidateCount: number;
      nearDuplicateGroupCount: number;
    }).catch(() => null);
    const fileExists = await stat(candidatePath).then(() => true).catch(() => false);
    if (existing && fileExists) {
      status.candidate_count_after_exact_dedupe = existing.canonicalCandidateCount;
      status.candidate_count_after_near_duplicate_grouping = existing.nearDuplicateGroupCount;
      status.detail = `Reused ${existing.canonicalCandidateCount} canonical candidates`;
      status.updated_at = nowIso();
      await updateStatus(runDir, status);
      return existing;
    }
  }

  await writeFile(candidatePath, "");
  const candidateStream = createWriteStream(candidatePath, { flags: "a" });
  const nearGroups = new Set<string>();
  let canonicalCandidateCount = 0;
  let shardIndex = 0;
  for (let index = 0; index < options.shardCount; index += 1) {
    shardIndex += 1;
    const shardPath = path.join(occurrenceDir, `occurrence-${String(index).padStart(3, "0")}.jsonl`);
    const exists = await stat(shardPath).then(() => true).catch(() => false);
    if (!exists) {
      continue;
    }
    const grouped = new Map<string, CandidateOccurrence[]>();
    const input = createReadStream(shardPath, "utf8");
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line.trim()) {
        continue;
      }
      const occurrence = JSON.parse(line) as CandidateOccurrence;
      const list = grouped.get(occurrence.canonicalPassageId) ?? [];
      list.push(occurrence);
      grouped.set(occurrence.canonicalPassageId, list);
    }

    for (const [canonicalPassageId, occurrences] of grouped.entries()) {
      occurrences.sort((left, right) => right.lexicalScore - left.lexicalScore || left.sourceFile.localeCompare(right.sourceFile));
      const representative = occurrences[0]!;
      const matchedTerms = [...new Set(occurrences.flatMap((occurrence) => occurrence.matchedTerms))].sort();
      const lexicalScore = Number((occurrences.reduce((sum, occurrence) => sum + occurrence.lexicalScore, 0) / Math.max(1, occurrences.length)).toFixed(2));
      const nearDuplicateGroupId = createNearDuplicateGroupId(representative.passageText);
      nearGroups.add(nearDuplicateGroupId);
      const candidate: CanonicalCandidate = {
        candidate_id: representative.candidateId,
        canonical_passage_id: canonicalPassageId,
        near_duplicate_group_id: nearDuplicateGroupId,
        source_file: representative.sourceFile,
        source_title: representative.sourceTitle,
        source_author: representative.sourceAuthor,
        source_year_or_period: representative.sourceYearOrPeriod,
        line_start: representative.lineStart,
        line_end: representative.lineEnd,
        matched_terms: matchedTerms,
        passage_text: representative.passageText,
        duplicate_count: occurrences.length,
        lexical_score: lexicalScore,
        work_key: representative.workKey,
        provenances: occurrences.map((occurrence) => ({
          source_file: occurrence.sourceFile,
          source_title: occurrence.sourceTitle,
          source_author: occurrence.sourceAuthor,
          source_year_or_period: occurrence.sourceYearOrPeriod,
          line_start: occurrence.lineStart,
          line_end: occurrence.lineEnd,
          matched_terms: occurrence.matchedTerms,
        })),
      };
      candidateStream.write(`${JSON.stringify(candidate)}\n`);
      canonicalCandidateCount += 1;
    }

    status.phase_progress_pct = 25 + Number(((shardIndex / Math.max(1, options.shardCount)) * 20).toFixed(2));
    status.candidate_count_after_exact_dedupe = canonicalCandidateCount;
    status.candidate_count_after_near_duplicate_grouping = nearGroups.size;
    status.detail = `Canonicalized shard ${shardIndex}/${options.shardCount}; exact=${canonicalCandidateCount} near_groups=${nearGroups.size}`;
    status.updated_at = nowIso();
    await updateStatus(runDir, status);
  }

  await new Promise<void>((resolve, reject) => {
    candidateStream.end((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  const summary = {
    canonicalCandidateCount,
    nearDuplicateGroupCount: nearGroups.size,
  };
  await writeJson(doneMarker, summary);
  status.candidate_count_after_exact_dedupe = canonicalCandidateCount;
  status.candidate_count_after_near_duplicate_grouping = nearGroups.size;
  status.detail = `Canonicalized ${canonicalCandidateCount} exact candidates into ${nearGroups.size} near-duplicate groups`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);
  return summary;
}

function batchItems<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

async function loadCanonicalCandidates(runDir: string): Promise<CanonicalCandidate[]> {
  const items: CanonicalCandidate[] = [];
  const input = createReadStream(path.join(runDir, "triage", "canonical-candidates.jsonl"), "utf8");
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) {
      continue;
    }
    const parsed = JSON.parse(line) as CanonicalCandidate;
    items.push({
      ...parsed,
      provenances: [],
    });
  }
  return items;
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
            required: [
              "candidateId",
              "isRelevant",
              "relevanceConfidence",
              "exactQuote",
              "themeLabel",
              "reasoning",
              "primaryFrame",
              "responseFrame",
              "needsEscalation",
            ],
            properties: {
              candidateId: { type: "string" },
              isRelevant: { type: "boolean" },
              relevanceConfidence: { type: "number" },
              exactQuote: { type: "string" },
              themeLabel: { type: "string" },
              reasoning: { type: "string" },
              primaryFrame: { type: "string" },
              responseFrame: { type: "string" },
              needsEscalation: { type: "boolean" },
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

async function callOpenAI<T>(input: {
  apiKey: string;
  model: string;
  phase: "nano" | "mini" | "synthesis";
  system: string;
  prompt: string;
  schema: ReturnType<typeof triageSchema> | ReturnType<typeof briefingSchema>;
}): Promise<OpenAiResponse<T>> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${input.apiKey}`,
  };
  const buildRequestBody = (system: string, prompt: string) => JSON.stringify({
    model: input.model,
    response_format: {
      type: "json_schema",
      json_schema: input.schema,
    },
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  });
  const primarySystem = sanitizeForJsonTransport(input.system);
  const primaryPrompt = sanitizeForJsonTransport(input.prompt);
  let response = await fetch(`${openAiBaseUrl()}/chat/completions`, {
    method: "POST",
    headers,
    body: buildRequestBody(primarySystem, primaryPrompt),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 400 && /parse the json body of your request/iu.test(errorText)) {
      const fallbackSystem = sanitizeForJsonTransport(primarySystem.normalize("NFKC"));
      const fallbackPrompt = sanitizeForJsonTransport(primaryPrompt.normalize("NFKC"));
      if (fallbackSystem !== primarySystem || fallbackPrompt !== primaryPrompt) {
        response = await fetch(`${openAiBaseUrl()}/chat/completions`, {
          method: "POST",
          headers,
          body: buildRequestBody(fallbackSystem, fallbackPrompt),
        });
        if (response.ok) {
          const payload = await response.json() as {
            choices?: Array<{
              message?: {
                content?: string | null;
              };
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
            };
          };
          const content = payload.choices?.[0]?.message?.content;
          if (!content) {
            throw new Error("OpenAI request returned no content.");
          }
          const promptTokens = payload.usage?.prompt_tokens ?? 0;
          const completionTokens = payload.usage?.completion_tokens ?? 0;
          return {
            parsed: JSON.parse(extractJsonObject(content)) as T,
            usage: {
              phase: input.phase,
              model: input.model,
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              estimated_cost_usd: usageToCost(input.model, promptTokens, completionTokens),
            },
          };
        }
      }
    }
    throw new Error(`OpenAI request failed with status ${response.status}: ${errorText.slice(0, 400)}`);
  }

  const payload = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string | null;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
    };
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI request returned no content.");
  }
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const completionTokens = payload.usage?.completion_tokens ?? 0;
  return {
    parsed: JSON.parse(extractJsonObject(content)) as T,
    usage: {
      phase: input.phase,
      model: input.model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      estimated_cost_usd: usageToCost(input.model, promptTokens, completionTokens),
    },
  };
}

function candidateBlock(candidate: CanonicalCandidate): string {
  return [
    `candidateId: ${candidate.candidate_id}`,
    `canonicalPassageId: ${candidate.canonical_passage_id}`,
    `sourceFile: ${candidate.source_file}`,
    `sourceTitle: ${candidate.source_title ?? "(unknown)"}`,
    `sourceAuthor: ${candidate.source_author ?? "(unknown)"}`,
    `sourceYearOrPeriod: ${candidate.source_year_or_period ?? "(unknown)"}`,
    `lineStart: ${candidate.line_start}`,
    `lineEnd: ${candidate.line_end}`,
    `matchedTerms: ${candidate.matched_terms.join(", ") || "(none)"}`,
    `duplicateCount: ${candidate.duplicate_count}`,
    `lexicalScore: ${candidate.lexical_score}`,
    "passage:",
    candidate.passage_text,
  ].join("\n");
}

function buildNanoPrompt(query: string, batch: CanonicalCandidate[], maxQuoteChars: number): string {
  return [
    "You are doing first-pass semantic triage on literary passages.",
    "Judge each passage, not the file as a whole.",
    "Decide whether each passage is genuinely relevant to the user's research request.",
    "Use the user query, passage text, and source metadata together.",
    "Reject lexical noise and superficially similar passages that do not materially address the request.",
    "themeLabel should be a short descriptive theme grounded in the passage and the query.",
    "primaryFrame should describe the passage's main interpretive frame.",
    "responseFrame should describe a secondary or response-oriented frame when relevant; otherwise use other.",
    `Keep exactQuote under ${maxQuoteChars} characters.`,
    "If the passage is ambiguous, set needsEscalation=true.",
    "",
    `User query: ${query}`,
    "",
    ...batch.map((candidate, index) => [`Candidate ${index + 1}`, candidateBlock(candidate)].join("\n")),
  ].join("\n\n");
}

function buildMiniPrompt(query: string, batch: Array<{ candidate: CanonicalCandidate; nano: NanoDecision }>, maxQuoteChars: number): string {
  return [
    "You are the escalation reviewer for a corpus research run.",
    "Resolve ambiguous cases carefully. Prefer supported judgments over recall-maximizing guesses.",
    `Keep exactQuote under ${maxQuoteChars} characters.`,
    "",
    `User query: ${query}`,
    "",
    ...batch.map(({ candidate, nano }, index) => [
      `Candidate ${index + 1}`,
      candidateBlock(candidate),
      "Nano decision:",
      JSON.stringify(nano),
    ].join("\n")),
  ].join("\n\n");
}

function normalizeDecision(decision: BaseDecision, maxQuoteChars: number): BaseDecision {
  return {
    candidateId: decision.candidateId,
    isRelevant: Boolean(decision.isRelevant),
    relevanceConfidence: Math.max(0, Math.min(1, Number.isFinite(decision.relevanceConfidence) ? decision.relevanceConfidence : 0)),
    exactQuote: normalizeWhitespace(decision.exactQuote ?? "").slice(0, maxQuoteChars),
    themeLabel: normalizeThemeLabel(decision.themeLabel),
    reasoning: normalizeWhitespace(decision.reasoning ?? ""),
    primaryFrame: normalizeThemeLabel(decision.primaryFrame),
    responseFrame: normalizeThemeLabel(decision.responseFrame),
    needsEscalation: Boolean(decision.needsEscalation),
  };
}

function nanoDecisionRequiresEscalation(decision: BaseDecision, candidate: CanonicalCandidate): boolean {
  if (decision.needsEscalation) {
    return true;
  }
  if (!decision.exactQuote) {
    return true;
  }
  if (decision.relevanceConfidence >= 0.45 && decision.relevanceConfidence < 0.85) {
    return true;
  }
  if (decision.relevanceConfidence < 0.45 && lexicalEscalationFloor(candidate.lexical_score)) {
    return true;
  }
  if (decision.isRelevant && decision.relevanceConfidence < 0.85) {
    return true;
  }
  return false;
}

function acceptanceFromDecision(decision: BaseDecision): boolean {
  return decision.isRelevant && Boolean(decision.exactQuote) && decision.relevanceConfidence >= 0.85;
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

async function appendJsonLines(filePath: string, rows: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (rows.length === 0) {
    return;
  }
  const serialized = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await appendFile(filePath, serialized, "utf8");
}

async function runNanoTriage(
  runDir: string,
  options: ScriptOptions,
  apiKey: string,
  candidates: CanonicalCandidate[],
  corpusScope: string,
  status: RunStatus,
  costProfile: { usage: UsageRecord[] },
): Promise<{ accepted: ConfirmedPassageRecord[]; escalations: Array<{ candidate: CanonicalCandidate; nano: NanoDecision }> }> {
  const nanoOutputPath = path.join(runDir, "triage", "triage-nano.jsonl");
  await writeFile(nanoOutputPath, "");
  const accepted: ConfirmedPassageRecord[] = [];
  const escalations: Array<{ candidate: CanonicalCandidate; nano: NanoDecision }> = [];
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
  const batches = batchItems(candidates, options.candidateBatchSize);

  status.phase = "triage_nano";
  status.total_candidates = candidates.length;
  status.total_batches = batches.length;
  status.completed_batches = 0;
  status.triaged_candidates = 0;
  status.detail = `Running nano triage across ${batches.length} batches`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);
  await appendRunLog(runDir, status.detail);

  await mapLimit(batches, options.concurrency, async (batch, index) => {
    const batchPath = path.join(runDir, "triage", "batches", `nano-batch-${String(index + 1).padStart(5, "0")}.json`);
    let decisions: NanoDecision[];
    let usage: UsageRecord | null = null;
    if (options.resume) {
      const existing = await readFile(batchPath, "utf8").then((value) => JSON.parse(value) as { decisions: NanoDecision[]; usage?: UsageRecord }).catch(() => null);
      if (existing) {
        decisions = existing.decisions;
        usage = existing.usage ?? null;
      } else {
        const response = await callOpenAI<{ findings?: BaseDecision[] }>({
          apiKey,
          model: options.nanoModel,
          phase: "nano",
          system: "Return only valid JSON. Keep quotes exact and grounded in the supplied passage.",
          prompt: buildNanoPrompt(options.query, batch, options.maxQuoteChars),
          schema: triageSchema(),
        });
        usage = response.usage;
        decisions = (response.parsed.findings ?? []).map((item) => {
          const normalized = normalizeDecision(item, options.maxQuoteChars);
          const candidate = candidateById.get(normalized.candidateId);
          return {
            ...normalized,
            stage: "nano" as const,
            escalate: candidate ? nanoDecisionRequiresEscalation(normalized, candidate) : true,
          };
        });
        await writeJson(batchPath, { decisions, usage });
      }
    } else {
      const response = await callOpenAI<{ findings?: BaseDecision[] }>({
        apiKey,
        model: options.nanoModel,
        phase: "nano",
        system: "Return only valid JSON. Keep quotes exact and grounded in the supplied passage.",
        prompt: buildNanoPrompt(options.query, batch, options.maxQuoteChars),
        schema: triageSchema(),
      });
      usage = response.usage;
      decisions = (response.parsed.findings ?? []).map((item) => {
        const normalized = normalizeDecision(item, options.maxQuoteChars);
        const candidate = candidateById.get(normalized.candidateId);
        return {
          ...normalized,
          stage: "nano" as const,
          escalate: candidate ? nanoDecisionRequiresEscalation(normalized, candidate) : true,
        };
      });
      await writeJson(batchPath, { decisions, usage });
    }

    const matchedDecisions = batch.map((candidate) => decisions.find((decision) => decision.candidateId === candidate.candidate_id) ?? {
      candidateId: candidate.candidate_id,
      isRelevant: false,
      relevanceConfidence: 0,
      exactQuote: "",
      themeLabel: "other",
      reasoning: "Model returned no decision for this candidate.",
      primaryFrame: "other",
      responseFrame: "other",
      needsEscalation: true,
      stage: "nano" as const,
      escalate: true,
    });

    for (const decision of matchedDecisions) {
      const candidate = candidateById.get(decision.candidateId);
      if (!candidate) {
        continue;
      }
      if (decision.escalate) {
        escalations.push({ candidate, nano: decision });
        continue;
      }
      if (acceptanceFromDecision(decision)) {
        accepted.push(buildConfirmedRecord(candidate, decision, corpusScope, "nano"));
      }
    }

    if (usage) {
      costProfile.usage.push(usage);
    }
    await appendJsonLines(nanoOutputPath, matchedDecisions);
    status.completed_batches += 1;
    status.triaged_candidates += batch.length;
    status.llm_calls += usage ? 1 : 0;
    status.nano_accept_count = accepted.length;
    status.nano_escalation_count = escalations.length;
    status.phase_progress_pct = Number(((status.completed_batches / Math.max(1, status.total_batches)) * 100).toFixed(2));
    status.estimated_cumulative_cost_usd = estimateCost(costProfile.usage);
    status.detail = `Nano triage batch ${index + 1}/${status.total_batches}; accepted=${accepted.length} escalations=${escalations.length}`;
    status.updated_at = nowIso();
    await updateStatus(runDir, status);
  });

  return { accepted, escalations };
}

function buildConfirmedRecord(candidate: CanonicalCandidate, decision: BaseDecision, corpusScope: string, acceptedBy: "nano" | "mini"): ConfirmedPassageRecord {
  const recordId = createHash("sha1")
    .update(`${candidate.canonical_passage_id}:${decision.exactQuote}:${decision.themeLabel}:${decision.responseFrame}`)
    .digest("hex")
    .slice(0, 16);
  return {
    record_id: recordId,
    candidate_id: candidate.candidate_id,
    canonical_passage_id: candidate.canonical_passage_id,
    near_duplicate_group_id: candidate.near_duplicate_group_id,
    source_file: candidate.source_file,
    source_title: candidate.source_title,
    source_author: candidate.source_author,
    source_year_or_period: candidate.source_year_or_period,
    corpus_scope: corpusScope,
    line_start: candidate.line_start,
    line_end: candidate.line_end,
    quote: decision.exactQuote,
    theme_label: decision.themeLabel,
    primary_frame: decision.primaryFrame,
    response_frame: decision.responseFrame,
    confidence: decision.relevanceConfidence,
    lexical_score: candidate.lexical_score,
    duplicate_count: candidate.duplicate_count,
    matched_terms: candidate.matched_terms,
    reasoning: decision.reasoning,
    accepted_by: acceptedBy,
  };
}

function estimateCost(usage: UsageRecord[]): number {
  return Number(usage.reduce((sum, item) => sum + item.estimated_cost_usd, 0).toFixed(6));
}

async function runMiniEscalation(
  runDir: string,
  options: ScriptOptions,
  apiKey: string,
  escalations: Array<{ candidate: CanonicalCandidate; nano: NanoDecision }>,
  status: RunStatus,
  costProfile: { usage: UsageRecord[] },
): Promise<ConfirmedPassageRecord[]> {
  const miniOutputPath = path.join(runDir, "triage", "triage-mini.jsonl");
  await writeFile(miniOutputPath, "");
  if (escalations.length === 0) {
    status.phase = "triage_mini";
    status.total_batches = 0;
    status.completed_batches = 0;
    status.phase_progress_pct = 100;
    status.detail = "No escalation cases required mini triage";
    status.updated_at = nowIso();
    await updateStatus(runDir, status);
    return [];
  }

  const accepted: ConfirmedPassageRecord[] = [];
  const corpusScope = String(JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8")).chosen_scope ?? "scoped raw-text corpus");
  const batches = batchItems(escalations, options.candidateBatchSize);
  status.phase = "triage_mini";
  status.total_batches = batches.length;
  status.completed_batches = 0;
  status.detail = `Running mini escalation across ${batches.length} batches`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);
  await appendRunLog(runDir, status.detail);

  await mapLimit(batches, options.concurrency, async (batch, index) => {
    const batchPath = path.join(runDir, "triage", "batches", `mini-batch-${String(index + 1).padStart(5, "0")}.json`);
    let decisions: MiniDecision[];
    let usage: UsageRecord | null = null;
    if (options.resume) {
      const existing = await readFile(batchPath, "utf8").then((value) => JSON.parse(value) as { decisions: MiniDecision[]; usage?: UsageRecord }).catch(() => null);
      if (existing) {
        decisions = existing.decisions;
        usage = existing.usage ?? null;
      } else {
        const response = await callOpenAI<{ findings?: BaseDecision[] }>({
          apiKey,
          model: options.escalationModel,
          phase: "mini",
          system: "Return only valid JSON. Resolve ambiguity carefully and keep quotes exact.",
          prompt: buildMiniPrompt(options.query, batch, options.maxQuoteChars),
          schema: triageSchema(),
        });
        usage = response.usage;
        decisions = (response.parsed.findings ?? []).map((item) => ({
          ...normalizeDecision(item, options.maxQuoteChars),
          stage: "mini" as const,
        }));
        await writeJson(batchPath, { decisions, usage });
      }
    } else {
      const response = await callOpenAI<{ findings?: BaseDecision[] }>({
        apiKey,
        model: options.escalationModel,
        phase: "mini",
        system: "Return only valid JSON. Resolve ambiguity carefully and keep quotes exact.",
        prompt: buildMiniPrompt(options.query, batch, options.maxQuoteChars),
        schema: triageSchema(),
      });
      usage = response.usage;
      decisions = (response.parsed.findings ?? []).map((item) => ({
        ...normalizeDecision(item, options.maxQuoteChars),
        stage: "mini" as const,
      }));
      await writeJson(batchPath, { decisions, usage });
    }

    const decisionById = new Map(decisions.map((decision) => [decision.candidateId, decision]));
    const matchedDecisions = batch.map(({ candidate, nano }) => decisionById.get(candidate.candidate_id) ?? {
      ...nano,
      stage: "mini" as const,
    });

    for (const [batchIndex, { candidate }] of batch.entries()) {
      const decision = matchedDecisions[batchIndex]!;
      if (acceptanceFromDecision(decision)) {
        accepted.push(buildConfirmedRecord(candidate, decision, corpusScope, "mini"));
      }
    }

    if (usage) {
      costProfile.usage.push(usage);
    }
    await appendJsonLines(miniOutputPath, matchedDecisions);
    status.completed_batches += 1;
    status.llm_calls += usage ? 1 : 0;
    status.mini_accept_count = accepted.length;
    status.phase_progress_pct = Number(((status.completed_batches / Math.max(1, status.total_batches)) * 100).toFixed(2));
    status.estimated_cumulative_cost_usd = estimateCost(costProfile.usage);
    status.detail = `Mini triage batch ${index + 1}/${status.total_batches}; accepted=${accepted.length}`;
    status.updated_at = nowIso();
    await updateStatus(runDir, status);
  });

  return accepted;
}

function normalizeQuoteKey(record: ConfirmedPassageRecord): string {
  return normalizeWhitespace(record.quote).toLowerCase().replace(/[\W_]+/gu, " ").trim();
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/gu, "\"\"")}"`;
}

function noveltyByWork(records: ConfirmedPassageRecord[]): Map<string, number> {
  const counts = records.reduce<Map<string, number>>((map, record) => {
    map.set(record.source_title ?? record.source_file, (map.get(record.source_title ?? record.source_file) ?? 0) + 1);
    return map;
  }, new Map<string, number>());
  return new Map(Array.from(counts.entries()).map(([key, count]) => [key, Number((1 / count).toFixed(4))]));
}

function clusterConfirmedPassages(records: ConfirmedPassageRecord[]): { clusters: ClusterRecord[]; ranked: Array<ConfirmedPassageRecord & { rank_score: number; cluster_id: string }> } {
  const deduped = Array.from(new Map(records.map((record) => [`${record.canonical_passage_id}:${normalizeQuoteKey(record)}:${record.theme_label}:${record.response_frame}`, record])).values());
  const themeCounts = deduped.reduce<Map<string, number>>((map, record) => {
    map.set(record.theme_label, (map.get(record.theme_label) ?? 0) + 1);
    return map;
  }, new Map<string, number>());
  const workNovelty = noveltyByWork(deduped);
  const clusterMap = new Map<string, ConfirmedPassageRecord[]>();
  for (const record of deduped) {
    const clusterKey = `${normalizeQuoteKey(record)}::${record.theme_label}::${record.response_frame}`;
    const list = clusterMap.get(clusterKey) ?? [];
    list.push(record);
    clusterMap.set(clusterKey, list);
  }

  const clusters: ClusterRecord[] = [];
  const clusterIdByRecordId = new Map<string, string>();
  for (const [clusterKey, items] of clusterMap.entries()) {
    const representative = [...items].sort((left, right) => right.confidence - left.confidence || right.duplicate_count - left.duplicate_count)[0]!;
    const confidenceValues = items.map((item) => item.confidence);
    const clusterId = createHash("sha1").update(clusterKey).digest("hex").slice(0, 16);
    items.forEach((item) => clusterIdByRecordId.set(item.record_id, clusterId));
    clusters.push({
      cluster_id: clusterId,
      dominant_theme: representative.theme_label,
      primary_frame: representative.primary_frame,
      response_frame: representative.response_frame,
      canonical_quote: representative.quote,
      representative_quote: representative.quote,
      cluster_size: items.length,
      source_works: [...new Set(items.map((item) => item.source_title ?? inferTitle(item.source_file) ?? item.source_file))].sort(),
      confidence_summary: {
        min: Math.min(...confidenceValues),
        max: Math.max(...confidenceValues),
        avg: Number((confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length).toFixed(3)),
      },
      record_ids: items.map((item) => item.record_id),
    });
  }

  const ranked = deduped
    .map((record) => {
      const rarity = 1 / Math.max(1, themeCounts.get(record.theme_label) ?? 1);
      const workNoveltyScore = workNovelty.get(record.source_title ?? record.source_file) ?? 1;
      const rankScore = Number((
        (record.confidence * 10) +
        Math.log2(1 + record.duplicate_count) +
        (record.lexical_score * 0.15) +
        (rarity * 3) +
        workNoveltyScore
      ).toFixed(4));
      return {
        ...record,
        rank_score: rankScore,
        cluster_id: clusterIdByRecordId.get(record.record_id) ?? "",
      };
    })
    .sort((left, right) => right.rank_score - left.rank_score || right.confidence - left.confidence);

  clusters.sort((left, right) => right.cluster_size - left.cluster_size || right.confidence_summary.avg - left.confidence_summary.avg);
  return { clusters, ranked };
}

function buildBriefingPrompt(input: {
  query: string;
  chosenScope: string;
  canonicalCandidates: number;
  confirmedCount: number;
  clusterCount: number;
  themeCounts: Record<string, number>;
  topClusters: ClusterRecord[];
  topPassages: Array<ConfirmedPassageRecord & { rank_score: number; cluster_id: string }>;
}): string {
  const topThemes = Object.entries(input.themeCounts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([label, count]) => ({ label, count }));
  return [
    "Write a polished literary research briefing in Markdown.",
    "This is a research artifact intended to be read by a human decision-maker, not a raw system dump.",
    "Ground every claim in the supplied confirmed findings and clusters.",
    "Do not write a generic theme inventory or headings like 'sample top matches'.",
    "Make real interpretive points.",
    "Prioritize findings that are memorable, surprising, or sharply representative.",
    "Prefer concrete passages from identifiable works over vague fragments, metadata, contents pages, legal boilerplate, or keyword-noise.",
    "If a supplied passage looks like front matter, index text, Project Gutenberg boilerplate, donation text, or other obvious non-literary noise, do not feature it in the prose briefing.",
    "Use a confident research-memo voice.",
    "Structure the briefing like this:",
    "1. Title",
    "2. Executive summary: 1 short paragraph with the strongest thesis",
    "3. Method and scope",
    "4. Key findings: 3 to 6 claim-driven sections",
    "5. Caveats and limits",
    "6. What the dataset suggests overall",
    "In each key finding section:",
    "- start with a claim, not a label dump",
    "- explain why that pattern matters",
    "- include 2 to 3 exact quotes with inline citation markers [CIT:record_id]",
    "- introduce each quote with source context when available: title, author, year",
    "- briefly synthesize across the quotes instead of listing them mechanically",
    "Do not claim exhaustiveness beyond the supplied data.",
    "Use short paragraphs and flat bullets only when they improve readability.",
    "",
    `User query: ${input.query}`,
    `Chosen scope: ${input.chosenScope}`,
    `Canonical candidate passages: ${input.canonicalCandidates}`,
    `Confirmed passages: ${input.confirmedCount}`,
    `Clusters: ${input.clusterCount}`,
    `Theme counts: ${JSON.stringify(input.themeCounts)}`,
    `Top themes by count: ${JSON.stringify(topThemes)}`,
    "",
    "Top clusters:",
    ...input.topClusters.slice(0, 12).map((cluster) => JSON.stringify(cluster)),
    "",
    "Top passages:",
    ...input.topPassages.slice(0, 20).map((passage) => JSON.stringify({
      record_id: passage.record_id,
      quote: passage.quote,
      theme: passage.theme_label,
      primary_frame: passage.primary_frame,
      response_frame: passage.response_frame,
      confidence: passage.confidence,
      source_title: passage.source_title,
      source_author: passage.source_author,
      source_year_or_period: passage.source_year_or_period,
      source_file: passage.source_file,
    })),
  ].join("\n");
}

async function finalizeOutputs(
  runDir: string,
  options: ScriptOptions,
  costProfile: { usage: UsageRecord[] },
  status: RunStatus,
  canonicalCandidateCount: number,
  confirmed: ConfirmedPassageRecord[],
): Promise<void> {
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
  const { clusters, ranked } = clusterConfirmedPassages(confirmed);
  const themeCounts = ranked.reduce<Record<string, number>>((accumulator, record) => {
    accumulator[record.theme_label] = (accumulator[record.theme_label] ?? 0) + 1;
    return accumulator;
  }, {});

  status.phase = "clustering";
  status.cluster_count = clusters.length;
  status.kept_records = ranked.length;
  status.detail = `Clustered ${ranked.length} confirmed passages into ${clusters.length} clusters`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);
  await appendRunLog(runDir, status.detail);

  await writeFile(path.join(runDir, "confirmed-passages.jsonl"), ranked.map((row) => JSON.stringify(row)).join("\n") + (ranked.length ? "\n" : ""));
  await writeJson(path.join(runDir, "clusters.json"), clusters);

  const citationIndex: CitationRecord[] = ranked.map((record) => ({
    record_id: record.record_id,
    cluster_id: record.cluster_id,
    candidate_id: record.candidate_id,
    canonical_passage_id: record.canonical_passage_id,
    quote: record.quote,
    source_file: record.source_file,
    line_start: record.line_start,
    line_end: record.line_end,
  }));
  await writeJson(path.join(runDir, "citation-index.json"), citationIndex);

  const csvHeader = [
    "record_id",
    "cluster_id",
    "rank_score",
    "source_file",
    "source_title",
    "source_author",
    "source_year_or_period",
    "corpus_scope",
    "line_start",
    "line_end",
    "quote",
    "theme_label",
    "primary_frame",
    "response_frame",
    "confidence",
    "lexical_score",
    "duplicate_count",
    "matched_terms",
    "reasoning",
    "accepted_by",
  ];
  const csvRows = [
    csvHeader.join(","),
    ...ranked.map((record) => [
      csvEscape(record.record_id),
      csvEscape(record.cluster_id),
      String(record.rank_score),
      csvEscape(record.source_file),
      csvEscape(record.source_title ?? ""),
      csvEscape(record.source_author ?? ""),
      csvEscape(record.source_year_or_period ?? ""),
      csvEscape(record.corpus_scope),
      String(record.line_start),
      String(record.line_end),
      csvEscape(record.quote),
      csvEscape(record.theme_label),
      csvEscape(record.primary_frame),
      csvEscape(record.response_frame),
      String(record.confidence),
      String(record.lexical_score),
      String(record.duplicate_count),
      csvEscape(record.matched_terms.join("|")),
      csvEscape(record.reasoning),
      csvEscape(record.accepted_by),
    ].join(",")),
  ];
  await writeFile(path.join(runDir, "ranked-passages.csv"), `${csvRows.join("\n")}\n`);
  await writeFile(path.join(runDir, "dataset.jsonl"), ranked.map((row) => JSON.stringify(row)).join("\n") + (ranked.length ? "\n" : ""));
  await writeFile(path.join(runDir, "dataset.csv"), `${csvRows.join("\n")}\n`);
  await writeJson(path.join(runDir, "visualizations", "theme-counts.json"), themeCounts);
  await writeFile(
    path.join(runDir, "visualizations", "theme-counts.csv"),
    `theme_label,count\n${Object.entries(themeCounts).map(([label, count]) => `${csvEscape(label)},${count}`).join("\n")}\n`,
  );

  status.phase = "synthesis";
  status.detail = `Synthesizing briefing from ${ranked.length} confirmed passages`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);

  let briefingMarkdown = [
    "# Corpus Research Briefing",
    "",
    `Query: ${options.query}`,
    `Chosen scope: ${manifest.chosen_scope ?? "scoped raw-text corpus"}`,
    `Canonical candidate passages: ${canonicalCandidateCount}`,
    `Confirmed passages: ${ranked.length}`,
    `Clusters: ${clusters.length}`,
    "",
    "Theme counts:",
    ...Object.entries(themeCounts).sort((left, right) => right[1] - left[1]).map(([label, count]) => `- ${label}: ${count}`),
  ].join("\n");

  if (ranked.length > 0) {
    try {
      const apiKey = process.env.OPENAI_API_KEY ?? "";
      const response = await callOpenAI<{ briefingMarkdown?: string }>({
        apiKey,
        model: options.synthesisModel,
        phase: "synthesis",
        system: "Return only valid JSON. Keep the markdown concise and grounded in the supplied clusters.",
        prompt: buildBriefingPrompt({
          query: options.query,
          chosenScope: String(manifest.chosen_scope ?? "scoped raw-text corpus"),
          canonicalCandidates: canonicalCandidateCount,
          confirmedCount: ranked.length,
          clusterCount: clusters.length,
          themeCounts,
          topClusters: clusters,
          topPassages: ranked,
        }),
        schema: briefingSchema(),
      });
      costProfile.usage.push(response.usage);
      status.llm_calls += 1;
      status.estimated_cumulative_cost_usd = estimateCost(costProfile.usage);
      if (response.parsed.briefingMarkdown?.trim()) {
        briefingMarkdown = response.parsed.briefingMarkdown.trim();
      }
    } catch (error) {
      await appendRunLog(runDir, `briefing fallback due to synthesis error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await writeFile(path.join(runDir, "briefing.md"), `${briefingMarkdown}\n`);
  await writeJson(path.join(runDir, "cost-profile.json"), {
    usage: costProfile.usage,
    totals: {
      llm_calls: costProfile.usage.length,
      prompt_tokens: costProfile.usage.reduce((sum, item) => sum + item.prompt_tokens, 0),
      completion_tokens: costProfile.usage.reduce((sum, item) => sum + item.completion_tokens, 0),
      estimated_cost_usd: estimateCost(costProfile.usage),
    },
    by_phase: ["nano", "mini", "synthesis"].map((phase) => ({
      phase,
      llm_calls: costProfile.usage.filter((item) => item.phase === phase).length,
      prompt_tokens: costProfile.usage.filter((item) => item.phase === phase).reduce((sum, item) => sum + item.prompt_tokens, 0),
      completion_tokens: costProfile.usage.filter((item) => item.phase === phase).reduce((sum, item) => sum + item.completion_tokens, 0),
      estimated_cost_usd: Number(costProfile.usage.filter((item) => item.phase === phase).reduce((sum, item) => sum + item.estimated_cost_usd, 0).toFixed(6)),
    })),
  });

  manifest.schema_summary = {
    candidate_id: "representative canonical passage candidate identifier",
    canonical_passage_id: "exact normalized passage hash",
    near_duplicate_group_id: "lightweight near-duplicate passage group",
    quote: "exact extracted quote from the confirmed passage",
    theme_label: "primary theme label grounded in the query",
    primary_frame: "main interpretive frame for the passage",
    response_frame: "secondary or response-oriented frame for the passage",
    confidence: "0-1 semantic relevance confidence",
    reasoning: "why the quote is relevant to the user query",
  };
  manifest.output_file_list = [
    "manifest.json",
    "run.log",
    "triage/canonical-candidates.jsonl",
    "triage/triage-nano.jsonl",
    "triage/triage-mini.jsonl",
    "confirmed-passages.jsonl",
    "clusters.json",
    "ranked-passages.csv",
    "dataset.jsonl",
    "dataset.csv",
    "citation-index.json",
    "briefing.md",
    "cost-profile.json",
    "visualizations/theme-counts.json",
    "visualizations/theme-counts.csv",
  ];
  manifest.record_counts = {
    ...(manifest.record_counts ?? {}),
    canonical_candidates: canonicalCandidateCount,
    confirmed_passages: ranked.length,
    clusters: clusters.length,
  };
  manifest.status = "completed";
  await writeJson(manifestPath, manifest);

  status.phase = "completed";
  status.state = "completed";
  status.phase_progress_pct = 100;
  status.kept_records = ranked.length;
  status.cluster_count = clusters.length;
  status.estimated_cumulative_cost_usd = estimateCost(costProfile.usage);
  status.detail = `Completed run with ${ranked.length} confirmed passages across ${clusters.length} clusters`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);
  await appendRunLog(runDir, status.detail);
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
  await mkdir(path.join(runDir, "triage", "batches"), { recursive: true });
  await mkdir(path.join(runDir, "visualizations"), { recursive: true });

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
  const corpusScope = String(manifest.chosen_scope ?? "scoped raw-text corpus");
  const rawMatchSummary = await parseRawMatchesSummary(searchPath);
  await writeJson(path.join(runDir, "triage", "raw-match-summary.json"), rawMatchSummary);

  const status: RunStatus = {
    phase: "canonicalization",
    query: options.query,
    model: `${options.nanoModel} -> ${options.escalationModel} -> ${options.synthesisModel}`,
    total_candidates: 0,
    triaged_candidates: 0,
    completed_batches: 0,
    total_batches: 0,
    kept_records: 0,
    llm_calls: 0,
    state: "running",
    phase_progress_pct: 0,
    updated_at: nowIso(),
    detail: `Starting canonicalization from ${rawMatchSummary.totalMatches} raw match events`,
    estimated_cumulative_cost_usd: 0,
  };
  await updateStatus(runDir, status);
  await appendRunLog(runDir, "triage phase started");
  await appendRunLog(runDir, status.detail);

  await shardRawMatches(runDir, searchPath, options, status);
  const occurrenceSummary = await buildCandidateOccurrences(runDir, options, status);
  const canonicalSummary = await canonicalizeCandidates(runDir, options, status);
  await appendRunLog(
    runDir,
    `canonicalization complete exact_candidates=${canonicalSummary.canonicalCandidateCount} near_groups=${canonicalSummary.nearDuplicateGroupCount} occurrences=${occurrenceSummary.exactCandidates}`,
  );

  const candidates = await loadCanonicalCandidates(runDir);
  status.total_candidates = candidates.length;
  status.candidate_count_after_exact_dedupe = canonicalSummary.canonicalCandidateCount;
  status.candidate_count_after_near_duplicate_grouping = canonicalSummary.nearDuplicateGroupCount;
  status.detail = `Loaded ${candidates.length} canonical candidates for semantic triage`;
  status.updated_at = nowIso();
  await updateStatus(runDir, status);

  const costProfile = { usage: [] as UsageRecord[] };
  const nano = await runNanoTriage(runDir, options, apiKey, candidates, corpusScope, status, costProfile);
  const miniAccepted = await runMiniEscalation(runDir, options, apiKey, nano.escalations, status, costProfile);
  const confirmed = [...nano.accepted, ...miniAccepted];
  await appendRunLog(
    runDir,
    `triage complete nano_accept=${nano.accepted.length} escalations=${nano.escalations.length} mini_accept=${miniAccepted.length}`,
  );
  await finalizeOutputs(runDir, options, costProfile, status, canonicalSummary.canonicalCandidateCount, confirmed);

  manifest.record_counts = {
    ...(manifest.record_counts ?? {}),
    raw_match_events: rawMatchSummary.totalMatches,
    passage_occurrences: occurrenceSummary.exactCandidates,
    canonical_candidates: canonicalSummary.canonicalCandidateCount,
    near_duplicate_groups: canonicalSummary.nearDuplicateGroupCount,
    nano_escalations: nano.escalations.length,
    confirmed_passages: confirmed.length,
  };
  manifest.status = "completed";
  await writeJson(manifestPath, manifest);
}

main().catch(async (error) => {
  let runDir = "";
  let query = "";
  try {
    const options = parseArgs(process.argv.slice(2));
    runDir = path.resolve(process.cwd(), options.runDir);
    query = options.query;
  } catch {
    runDir = process.cwd();
  }
  const status: RunStatus = {
    phase: "failed",
    query,
    model: "unknown",
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
