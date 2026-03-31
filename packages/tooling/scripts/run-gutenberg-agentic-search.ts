import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { loadDotEnvFile } from "./lib/benchmark-env";

interface ScriptOptions {
  corpusRoot: string;
  outputDir: string;
  query: string;
  provider: "openai";
  model: string;
  concurrency: number;
  shardSize: number;
  maxFiles: number | null;
  maxMatchesPerFile: number;
  contextLines: number;
  maxSnippetChars: number;
  maxShardSnippetChars: number;
  reduceOnly: boolean;
  skipReduce: boolean;
  resume: boolean;
  pattern: string;
}

interface CandidateSnippet {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  snippet: string;
}

interface ShardResult {
  shardId: string;
  query: string;
  model: string;
  files: string[];
  candidateCount: number;
  findings: Finding[];
  skipped?: boolean;
  error?: string;
}

interface Finding {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  label: string;
  explanation: string;
  evidenceQuote: string;
  confidence: number;
}

interface ReduceOutput {
  query: string;
  model: string;
  shardCount: number;
  completedShardCount: number;
  totalFindings: number;
  findings: Finding[];
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    corpusRoot: "/srv/alphabook/gutenberg",
    outputDir: "output/gutenberg-agentic-search",
    query: "",
    provider: "openai",
    model: "gpt-5-mini",
    concurrency: 8,
    shardSize: 24,
    maxFiles: null,
    maxMatchesPerFile: 8,
    contextLines: 2,
    maxSnippetChars: 1_600,
    maxShardSnippetChars: 24_000,
    reduceOnly: false,
    skipReduce: false,
    resume: true,
    pattern: "\\b(grief|grieve|grieved|grieving|sorrow|sorrowful|mourning|mourn|mourned|mourner|bereav(?:e|ed|ement)|lament|lamented|lamentation|heartbroken|heart-broken|despair|despairing)\\b",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--corpus-root":
        options.corpusRoot = argv[++index] ?? options.corpusRoot;
        break;
      case "--output-dir":
        options.outputDir = argv[++index] ?? options.outputDir;
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
      case "--shard-size":
        options.shardSize = Number(argv[++index] ?? options.shardSize);
        break;
      case "--max-files":
        options.maxFiles = Number(argv[++index] ?? options.maxFiles);
        break;
      case "--max-matches-per-file":
        options.maxMatchesPerFile = Number(argv[++index] ?? options.maxMatchesPerFile);
        break;
      case "--context-lines":
        options.contextLines = Number(argv[++index] ?? options.contextLines);
        break;
      case "--max-snippet-chars":
        options.maxSnippetChars = Number(argv[++index] ?? options.maxSnippetChars);
        break;
      case "--max-shard-snippet-chars":
        options.maxShardSnippetChars = Number(argv[++index] ?? options.maxShardSnippetChars);
        break;
      case "--pattern":
        options.pattern = argv[++index] ?? options.pattern;
        break;
      case "--reduce-only":
        options.reduceOnly = true;
        break;
      case "--skip-reduce":
        options.skipReduce = true;
        break;
      case "--no-resume":
        options.resume = false;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node --import tsx packages/tooling/scripts/run-gutenberg-agentic-search.ts --query <text> [--corpus-root path] [--output-dir path]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.query) {
    throw new Error("--query is required.");
  }

  return options;
}

async function runCommand(args: string[], cwd?: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${args.join(" ")} failed with exit ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function enumerateFiles(options: ScriptOptions): Promise<string[]> {
  const findArgs = [
    "find",
    options.corpusRoot,
    "-type",
    "f",
    "(",
    "-name",
    "*.txt",
    "-o",
    "-name",
    "*.htm",
    "-o",
    "-name",
    "*.html",
    ")",
    "-print",
  ];
  const stdout = await runCommand(findArgs);
  const files = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();

  return options.maxFiles ? files.slice(0, options.maxFiles) : files;
}

function splitIntoShards<T>(items: T[], shardSize: number): T[][] {
  const shards: T[][] = [];
  for (let index = 0; index < items.length; index += shardSize) {
    shards.push(items.slice(index, index + shardSize));
  }
  return shards;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged = [sorted[0]!];
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

function trimSnippet(snippet: string, maxChars: number): string {
  if (snippet.length <= maxChars) {
    return snippet;
  }
  return `${snippet.slice(0, maxChars - 3)}...`;
}

function extractCandidateSnippets(input: {
  filePath: string;
  content: string;
  pattern: RegExp;
  contextLines: number;
  maxMatchesPerFile: number;
  maxSnippetChars: number;
}): CandidateSnippet[] {
  const lines = input.content.split(/\r?\n/u);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (input.pattern.test(lines[index] ?? "")) {
      ranges.push({
        start: Math.max(0, index - input.contextLines),
        end: Math.min(lines.length - 1, index + input.contextLines),
      });
      if (ranges.length >= input.maxMatchesPerFile) {
        break;
      }
    }
  }

  return mergeRanges(ranges).map((range) => ({
    filePath: input.filePath,
    lineStart: range.start + 1,
    lineEnd: range.end + 1,
    snippet: trimSnippet(lines.slice(range.start, range.end + 1).join("\n"), input.maxSnippetChars),
  }));
}

async function collectShardCandidates(files: string[], options: ScriptOptions): Promise<CandidateSnippet[]> {
  const pattern = new RegExp(options.pattern, "iu");
  const snippets: CandidateSnippet[] = [];
  let totalChars = 0;

  for (const filePath of files) {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const fileSnippets = extractCandidateSnippets({
      filePath,
      content,
      pattern,
      contextLines: options.contextLines,
      maxMatchesPerFile: options.maxMatchesPerFile,
      maxSnippetChars: options.maxSnippetChars,
    });

    for (const snippet of fileSnippets) {
      const projectedSize = totalChars + snippet.snippet.length;
      if (projectedSize > options.maxShardSnippetChars) {
        return snippets;
      }
      snippets.push(snippet);
      totalChars = projectedSize;
    }
  }

  return snippets;
}

function buildShardPrompt(query: string, candidates: CandidateSnippet[]): string {
  return [
    "You are one tiny shard worker in a map/reduce search over Project Gutenberg text.",
    "Your job is to inspect candidate snippets for grief and return only concrete examples supported by the snippets.",
    "Treat grief as actual grieving, mourning, bereavement, sorrow, lamentation, or despair experienced by a person, character, speaker, or narrator.",
    "Do not include abstract moral condemnation, political rhetoric, or generic mentions of suffering unless the snippet clearly depicts grief itself.",
    "Do not include mere keyword mentions with no evidence of grief.",
    "Deduplicate repeated hits from the same passage.",
    "Return strict JSON matching the schema.",
    "",
    `User query: ${query}`,
    "",
    "Candidate snippets:",
    ...candidates.map((candidate, index) => [
      `Snippet ${index + 1}`,
      `filePath: ${candidate.filePath}`,
      `lineStart: ${candidate.lineStart}`,
      `lineEnd: ${candidate.lineEnd}`,
      candidate.snippet,
    ].join("\n")),
  ].join("\n");
}

function responseSchema() {
  return {
    name: "gutenberg_grief_findings",
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
            required: ["filePath", "lineStart", "lineEnd", "label", "explanation", "evidenceQuote", "confidence"],
            properties: {
              filePath: { type: "string" },
              lineStart: { type: "number" },
              lineEnd: { type: "number" },
              label: { type: "string" },
              explanation: { type: "string" },
              evidenceQuote: { type: "string" },
              confidence: { type: "number" },
            },
          },
        },
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
  prompt: string;
}): Promise<{ findings: Finding[] }> {
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
        json_schema: responseSchema(),
      },
      messages: [
        {
          role: "system",
          content: "Return only valid JSON. Keep evidence quotes short and grounded in the provided snippets.",
        },
        {
          role: "user",
          content: input.prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed with status ${response.status}: ${body.slice(0, 400)}`);
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
  return JSON.parse(extractJsonObject(content)) as { findings: Finding[] };
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function processShard(input: {
  shardIndex: number;
  files: string[];
  options: ScriptOptions;
  apiKey: string;
  shardDir: string;
}): Promise<ShardResult> {
  const shardId = `shard-${String(input.shardIndex + 1).padStart(5, "0")}`;
  const resultPath = path.join(input.shardDir, `${shardId}.json`);
  if (input.options.resume) {
    const existing = await readJsonIfExists<ShardResult>(resultPath);
    if (existing) {
      return existing;
    }
  }

  const candidates = await collectShardCandidates(input.files, input.options);
  if (candidates.length === 0) {
    const emptyResult: ShardResult = {
      shardId,
      query: input.options.query,
      model: input.options.model,
      files: input.files,
      candidateCount: 0,
      findings: [],
      skipped: true,
    };
    await writeJson(resultPath, emptyResult);
    return emptyResult;
  }

  const prompt = buildShardPrompt(input.options.query, candidates);
  try {
    const response = await callOpenAI({
      apiKey: input.apiKey,
      model: input.options.model,
      prompt,
    });
    const result: ShardResult = {
      shardId,
      query: input.options.query,
      model: input.options.model,
      files: input.files,
      candidateCount: candidates.length,
      findings: response.findings ?? [],
    };
    await writeJson(resultPath, result);
    return result;
  } catch (error) {
    const failedResult: ShardResult = {
      shardId,
      query: input.options.query,
      model: input.options.model,
      files: input.files,
      candidateCount: candidates.length,
      findings: [],
      error: error instanceof Error ? error.message : String(error),
    };
    await writeJson(resultPath, failedResult);
    return failedResult;
  }
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

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function normalizeFinding(finding: Finding): Finding {
  return {
    ...finding,
    confidence: Math.max(0, Math.min(1, Number.isFinite(finding.confidence) ? finding.confidence : 0)),
    evidenceQuote: finding.evidenceQuote.trim().slice(0, 240),
  };
}

async function reduceResults(shardDir: string, options: ScriptOptions): Promise<ReduceOutput> {
  const files = (await readdir(shardDir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const shardResults = await Promise.all(
    files.map(async (file) => await readJsonIfExists<ShardResult>(path.join(shardDir, file))),
  );
  const completed = shardResults.filter((result): result is ShardResult => result !== null);
  const deduped = new Map<string, Finding>();

  for (const shard of completed) {
    for (const finding of shard.findings.map(normalizeFinding)) {
      const key = `${finding.filePath}:${finding.lineStart}:${finding.lineEnd}:${finding.evidenceQuote}`;
      const existing = deduped.get(key);
      if (!existing || finding.confidence > existing.confidence) {
        deduped.set(key, finding);
      }
    }
  }

  const findings = [...deduped.values()].sort((left, right) => right.confidence - left.confidence);
  return {
    query: options.query,
    model: options.model,
    shardCount: files.length,
    completedShardCount: completed.length,
    totalFindings: findings.length,
    findings,
  };
}

async function writeManifest(filePath: string, value: unknown) {
  await writeJson(filePath, value);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnvFile().catch(() => undefined);

  if (options.provider !== "openai") {
    throw new Error(`Unsupported provider: ${options.provider}`);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const outputDir = path.resolve(process.cwd(), options.outputDir);
  const shardDir = path.join(outputDir, "shards");
  const manifestPath = path.join(outputDir, "manifest.json");
  const reducedPath = path.join(outputDir, "reduced.json");
  await mkdir(shardDir, { recursive: true });

  if (!options.reduceOnly) {
    const files = await enumerateFiles(options);
    const shards = splitIntoShards(files, options.shardSize);
    await writeManifest(manifestPath, {
      generatedAt: new Date().toISOString(),
      query: options.query,
      corpusRoot: options.corpusRoot,
      outputDir,
      model: options.model,
      concurrency: options.concurrency,
      shardSize: options.shardSize,
      maxFiles: options.maxFiles,
      fileCount: files.length,
      shardCount: shards.length,
      pattern: options.pattern,
    });

    process.stderr.write(`Enumerated ${files.length} files into ${shards.length} shard(s)\n`);

    await mapLimit(shards, options.concurrency, async (shardFiles, index) => {
      process.stderr.write(`Starting shard ${index + 1}/${shards.length}\n`);
      const result = await processShard({
        shardIndex: index,
        files: shardFiles,
        options,
        apiKey,
        shardDir,
      });
      process.stderr.write(
        `Finished ${result.shardId} findings=${result.findings.length} candidates=${result.candidateCount}${result.error ? ` error=${result.error}` : ""}\n`,
      );
      return result;
    });
  }

  if (!options.skipReduce) {
    const reduced = await reduceResults(shardDir, options);
    await writeJson(reducedPath, reduced);
    process.stdout.write(`${JSON.stringify(reduced, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
