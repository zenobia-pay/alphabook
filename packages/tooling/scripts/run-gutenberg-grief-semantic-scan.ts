import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { loadDotEnvFile } from "./lib/benchmark-env";

interface ScriptOptions {
  corpusRoot: string;
  outputDir: string;
  query: string;
  model: string;
  concurrency: number;
  maxFiles: number | null;
  chunkTargetChars: number;
  chunkMaxChars: number;
  chunkBatchSize: number;
  maxQuoteChars: number;
  resume: boolean;
}

interface PassageChunk {
  chunkId: string;
  filePath: string;
  chunkIndex: number;
  text: string;
}

interface Finding {
  filePath: string;
  chunkId: string;
  chunkIndex: number;
  quote: string;
  explanation: string;
  confidence: number;
}

interface FileResult {
  fileIndex: number;
  filePath: string;
  chunkCount: number;
  batchCount: number;
  findings: Finding[];
  error?: string;
}

interface ProgressState {
  startedAt: string;
  updatedAt: string;
  query: string;
  model: string;
  fileCount: number;
  processedFiles: number;
  completedFiles: number;
  erroredFiles: number;
  llmCalls: number;
  findings: number;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    corpusRoot: "/srv/alphabook/gutenberg",
    outputDir: "output/gutenberg-grief-semantic-scan",
    query: "Find me every passage involving grief in this dataset.",
    model: "gpt-5-mini",
    concurrency: 8,
    maxFiles: null,
    chunkTargetChars: 1400,
    chunkMaxChars: 2200,
    chunkBatchSize: 6,
    maxQuoteChars: 280,
    resume: true,
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
      case "--max-files":
        options.maxFiles = Number(argv[++index] ?? options.maxFiles);
        break;
      case "--chunk-target-chars":
        options.chunkTargetChars = Number(argv[++index] ?? options.chunkTargetChars);
        break;
      case "--chunk-max-chars":
        options.chunkMaxChars = Number(argv[++index] ?? options.chunkMaxChars);
        break;
      case "--chunk-batch-size":
        options.chunkBatchSize = Number(argv[++index] ?? options.chunkBatchSize);
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
          "Usage: node --import tsx packages/tooling/scripts/run-gutenberg-grief-semantic-scan.ts [--query text] [--corpus-root path] [--output-dir path]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

async function runCommand(args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), {
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
  const stdout = await runCommand([
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
  ]);
  const files = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
  return options.maxFiles ? files.slice(0, options.maxFiles) : files;
}

function stripHtml(content: string): string {
  return content
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/\r/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n");
}

function normalizeText(filePath: string, content: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".htm") || lower.endsWith(".html")) {
    return stripHtml(content);
  }
  return content.replace(/\r/gu, "");
}

function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/u).filter((sentence) => sentence.trim().length > 0);
  if (sentences.length <= 1) {
    const chunks: string[] = [];
    for (let index = 0; index < paragraph.length; index += maxChars) {
      chunks.push(paragraph.slice(index, index + maxChars));
    }
    return chunks;
  }

  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = sentence;
      continue;
    }
    current = next;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function buildChunks(filePath: string, content: string, options: ScriptOptions): PassageChunk[] {
  const normalized = normalizeText(filePath, content);
  const paragraphs = normalized
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .flatMap((paragraph) => paragraph.length > options.chunkMaxChars
      ? splitLongParagraph(paragraph, options.chunkMaxChars)
      : [paragraph]);

  const chunks: PassageChunk[] = [];
  let current = "";
  let chunkIndex = 0;

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > options.chunkMaxChars && current) {
      chunks.push({
        chunkId: `${createHash("sha1").update(filePath).digest("hex").slice(0, 12)}-${String(chunkIndex).padStart(5, "0")}`,
        filePath,
        chunkIndex,
        text: current,
      });
      chunkIndex += 1;
      current = paragraph;
      continue;
    }

    current = next;
    if (current.length >= options.chunkTargetChars) {
      chunks.push({
        chunkId: `${createHash("sha1").update(filePath).digest("hex").slice(0, 12)}-${String(chunkIndex).padStart(5, "0")}`,
        filePath,
        chunkIndex,
        text: current,
      });
      chunkIndex += 1;
      current = "";
    }
  }

  if (current) {
    chunks.push({
      chunkId: `${createHash("sha1").update(filePath).digest("hex").slice(0, 12)}-${String(chunkIndex).padStart(5, "0")}`,
      filePath,
      chunkIndex,
      text: current,
    });
  }

  return chunks;
}

function batched<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

function buildPrompt(query: string, chunks: PassageChunk[], maxQuoteChars: number): string {
  return [
    "You are scanning literary passages for grief-related material.",
    "Return every exact quote in these passages that involves grief, mourning, bereavement, lamentation, coping with loss, remembrance after loss, consolation after loss, or emotional processing of death or separation.",
    "Use broad semantic judgment, not just the literal word grief.",
    "Do not return abstract rhetoric or unrelated sadness unless the passage is materially about grief, loss, mourning, or coping with loss.",
    "Each finding must quote text exactly from the passage.",
    `Keep each quote under ${maxQuoteChars} characters.`,
    "Return strict JSON only.",
    "",
    `User query: ${query}`,
    "",
    "Passages:",
    ...chunks.map((chunk, index) => [
      `Passage ${index + 1}`,
      `chunkId: ${chunk.chunkId}`,
      `filePath: ${chunk.filePath}`,
      `chunkIndex: ${chunk.chunkIndex}`,
      chunk.text,
    ].join("\n")),
  ].join("\n");
}

function responseSchema() {
  return {
    name: "gutenberg_grief_quotes",
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
            required: ["chunkId", "quote", "explanation", "confidence"],
            properties: {
              chunkId: { type: "string" },
              quote: { type: "string" },
              explanation: { type: "string" },
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

async function callOpenAI(apiKey: string, model: string, prompt: string) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: {
        type: "json_schema",
        json_schema: responseSchema(),
      },
      messages: [
        {
          role: "system",
          content: "Return only valid JSON. Every quote must be copied exactly from the supplied passages.",
        },
        {
          role: "user",
          content: prompt,
        },
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
  return JSON.parse(extractJsonObject(content)) as {
    findings?: Array<{
      chunkId: string;
      quote: string;
      explanation: string;
      confidence: number;
    }>;
  };
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

function resultPathFor(outputDir: string, fileIndex: number): string {
  const bucket = String(Math.floor(fileIndex / 1000)).padStart(4, "0");
  const name = `${String(fileIndex).padStart(7, "0")}.json`;
  return path.join(outputDir, "results", bucket, name);
}

async function processFile(input: {
  fileIndex: number;
  filePath: string;
  options: ScriptOptions;
  apiKey: string;
  outputDir: string;
}): Promise<{ result: FileResult; llmCalls: number }> {
  const fileResultPath = resultPathFor(input.outputDir, input.fileIndex);
  if (input.options.resume) {
    const existing = await readJsonIfExists<FileResult>(fileResultPath);
    if (existing) {
      return { result: existing, llmCalls: 0 };
    }
  }

  let content: string;
  try {
    content = await readFile(input.filePath, "utf8");
  } catch (error) {
    const result: FileResult = {
      fileIndex: input.fileIndex,
      filePath: input.filePath,
      chunkCount: 0,
      batchCount: 0,
      findings: [],
      error: error instanceof Error ? error.message : String(error),
    };
    await writeJson(fileResultPath, result);
    return { result, llmCalls: 0 };
  }

  const chunks = buildChunks(input.filePath, content, input.options);
  const batches = batched(chunks, input.options.chunkBatchSize);
  const findings: Finding[] = [];
  let llmCalls = 0;

  for (const batch of batches) {
    if (batch.length === 0) {
      continue;
    }
    llmCalls += 1;
    const response = await callOpenAI(
      input.apiKey,
      input.options.model,
      buildPrompt(input.options.query, batch, input.options.maxQuoteChars),
    );
    const chunkById = new Map(batch.map((chunk) => [chunk.chunkId, chunk]));
    for (const rawFinding of response.findings ?? []) {
      const chunk = chunkById.get(rawFinding.chunkId);
      if (!chunk) {
        continue;
      }
      findings.push({
        filePath: input.filePath,
        chunkId: chunk.chunkId,
        chunkIndex: chunk.chunkIndex,
        quote: rawFinding.quote.trim().slice(0, input.options.maxQuoteChars),
        explanation: rawFinding.explanation.trim(),
        confidence: Math.max(0, Math.min(1, Number.isFinite(rawFinding.confidence) ? rawFinding.confidence : 0)),
      });
    }
  }

  const result: FileResult = {
    fileIndex: input.fileIndex,
    filePath: input.filePath,
    chunkCount: chunks.length,
    batchCount: batches.length,
    findings,
  };
  await writeJson(fileResultPath, result);
  return { result, llmCalls };
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

async function flushProgress(outputDir: string, state: ProgressState) {
  await writeJson(path.join(outputDir, "progress.json"), state);
}

async function reduceResults(outputDir: string, query: string, model: string) {
  const resultsDir = path.join(outputDir, "results");
  const findings: Finding[] = [];

  async function walk(dirPath: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith(".json")) {
        continue;
      }
      const result = await readJsonIfExists<FileResult>(fullPath);
      if (!result) {
        continue;
      }
      findings.push(...result.findings);
    }
  }

  await walk(resultsDir);
  findings.sort((left, right) => right.confidence - left.confidence);
  await writeJson(path.join(outputDir, "reduced.json"), {
    query,
    model,
    totalFindings: findings.length,
    findings,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnvFile().catch(() => undefined);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const outputDir = path.resolve(process.cwd(), options.outputDir);
  await mkdir(outputDir, { recursive: true });

  const files = await enumerateFiles(options);
  await writeJson(path.join(outputDir, "manifest.json"), {
    startedAt: new Date().toISOString(),
    query: options.query,
    model: options.model,
    corpusRoot: options.corpusRoot,
    fileCount: files.length,
    concurrency: options.concurrency,
    chunkTargetChars: options.chunkTargetChars,
    chunkMaxChars: options.chunkMaxChars,
    chunkBatchSize: options.chunkBatchSize,
  });
  await writeFile(path.join(outputDir, "files.txt"), `${files.join("\n")}\n`);

  const progress: ProgressState = {
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    query: options.query,
    model: options.model,
    fileCount: files.length,
    processedFiles: 0,
    completedFiles: 0,
    erroredFiles: 0,
    llmCalls: 0,
    findings: 0,
  };
  await flushProgress(outputDir, progress);

  process.stderr.write(`Enumerated ${files.length} files\n`);

  await mapLimit(files, options.concurrency, async (filePath, index) => {
    const fileIndex = index + 1;
    const { result, llmCalls } = await processFile({
      fileIndex,
      filePath,
      options,
      apiKey,
      outputDir,
    });
    progress.processedFiles += 1;
    progress.completedFiles += result.error ? 0 : 1;
    progress.erroredFiles += result.error ? 1 : 0;
    progress.llmCalls += llmCalls;
    progress.findings += result.findings.length;
    progress.updatedAt = new Date().toISOString();
    if (progress.processedFiles % 10 === 0 || result.findings.length > 0 || result.error) {
      await flushProgress(outputDir, progress);
    }
    process.stderr.write(
      `file ${fileIndex}/${files.length} chunks=${result.chunkCount} batches=${result.batchCount} findings=${result.findings.length}${result.error ? ` error=${result.error}` : ""}\n`,
    );
    return result;
  });

  progress.updatedAt = new Date().toISOString();
  await flushProgress(outputDir, progress);
  await reduceResults(outputDir, options.query, options.model);
  process.stdout.write(`${JSON.stringify(progress, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
