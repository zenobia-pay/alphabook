#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function queryTokens(value) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
    ),
  );
}

function scoreText(text, tokens, phrase) {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    const count = haystack.split(token).length - 1;
    score += count * 2;
  }
  if (phrase && haystack.includes(phrase.toLowerCase())) {
    score += 8;
  }
  return score;
}

function topTermsFromHits(hits, seedTokens, limit = 6) {
  const counts = new Map();
  const seed = new Set(seedTokens);

  for (const hit of hits.slice(0, 8)) {
    for (const token of queryTokens(String(hit.text || ""))) {
      if (seed.has(token)) {
        continue;
      }
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

function mergeHits(iterations) {
  const merged = new Map();

  for (const iteration of iterations) {
    for (const hit of iteration.hits) {
      const key = String(hit.id || `${hit.work_id}:${hit.chunk_index}`);
      const existing = merged.get(key);
      if (!existing || existing.score < hit.score) {
        merged.set(key, {
          ...hit,
          matched_iterations: [iteration.name],
        });
        continue;
      }
      if (!existing.matched_iterations.includes(iteration.name)) {
        existing.matched_iterations.push(iteration.name);
      }
      existing.score = Math.max(existing.score, hit.score);
    }
  }

  return [...merged.values()].sort(
    (left, right) => right.score - left.score || left.work_id.localeCompare(right.work_id) || left.chunk_index - right.chunk_index,
  );
}

function buildChunkIndex(allChunks) {
  const byWork = new Map();
  for (const chunk of allChunks) {
    const workId = String(chunk.work_id || "unknown-work");
    const existing = byWork.get(workId) || [];
    existing.push(chunk);
    byWork.set(workId, existing);
  }
  for (const chunks of byWork.values()) {
    chunks.sort((left, right) => Number(left.chunk_index || 0) - Number(right.chunk_index || 0));
  }
  return byWork;
}

function expandWithNeighbors(hits, byWork) {
  const expanded = [];
  const seen = new Set();

  for (const hit of hits.slice(0, 6)) {
    const workChunks = byWork.get(String(hit.work_id || "")) || [];
    const hitIndex = workChunks.findIndex((candidate) => String(candidate.id || "") === String(hit.id || ""));
    const window = hitIndex >= 0 ? workChunks.slice(Math.max(0, hitIndex - 1), hitIndex + 2) : [hit];

    for (const chunk of window) {
      const key = String(chunk.id || `${chunk.work_id}:${chunk.chunk_index}`);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      expanded.push({
        ...chunk,
        score: typeof chunk.score === "number" ? chunk.score : hit.score,
        matched_iterations: chunk.matched_iterations || hit.matched_iterations || [],
      });
    }
  }

  return expanded;
}

function searchCorpus(allChunks, tokens, phrase, name) {
  const hits = [];
  for (const chunk of allChunks) {
    const text = String(chunk.text || "");
    const score = scoreText(text, tokens, phrase);
    if (score <= 0) {
      continue;
    }
    hits.push({
      ...chunk,
      score,
    });
  }
  hits.sort((left, right) => right.score - left.score || left.chunk_index - right.chunk_index);
  return {
    name,
    tokens,
    hits: hits.slice(0, 12),
  };
}

async function parseJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listChunkFiles(chunksRoot) {
  const entries = await readdir(chunksRoot, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(chunksRoot, entry.name, "chunks.jsonl");
    if (await fileExists(candidate)) {
      files.push(candidate);
    }
  }
  return files;
}

async function parseChunkJsonl(path) {
  const content = await readFile(path, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readJsonIfPresent(path, fallback) {
  return (await fileExists(path)) ? parseJson(path) : fallback;
}

function buildSearchEvidence(question, selectedChunks, runtimeChunks) {
  return {
    question,
    selectedChunks: selectedChunks.slice(0, 8).map((chunk) => ({
      id: String(chunk.id || ""),
      workId: String(chunk.work_id || chunk.workId || ""),
      chunkIndex: Number(chunk.chunk_index || chunk.chunkIndex || 0),
      excerpt: normalizeWhitespace(String(chunk.excerpt || chunk.text || "")).slice(0, 500),
      text: String(chunk.text || ""),
      r2Key: chunk.r2Key ?? chunk.r2_key ?? null,
    })),
    runtimeHits: runtimeChunks.slice(0, 10).map((chunk) => ({
      id: String(chunk.id || ""),
      workId: String(chunk.work_id || chunk.workId || ""),
      chunkIndex: Number(chunk.chunk_index || chunk.chunkIndex || 0),
      excerpt: normalizeWhitespace(String(chunk.text || "")).slice(0, 500),
      text: String(chunk.text || ""),
      score: Number(chunk.score || 0),
      matchedIterations: Array.isArray(chunk.matched_iterations) ? chunk.matched_iterations : [],
      r2Key: chunk.r2Key ?? chunk.r2_key ?? null,
    })),
  };
}

function fallbackBriefing(question, evidence) {
  const lines = [
    "# Briefing",
    "",
    `Question: ${question}`,
    "",
    "## Findings",
  ];

  if (!evidence.runtimeHits.length && !evidence.selectedChunks.length) {
    lines.push("I searched the hydrated workspace, but did not find enough grounded passages to answer confidently.");
    return lines.join("\n");
  }

  for (const entry of [...evidence.runtimeHits, ...evidence.selectedChunks].slice(0, 6)) {
    lines.push(
      `- ${entry.workId}#${entry.chunkIndex}: "${normalizeWhitespace(entry.excerpt).slice(0, 360)}"`,
      `  This passage appears relevant to the question because it surfaced during the deterministic local search.`,
    );
  }

  lines.push("", "## Notes", "- This fallback briefing was assembled from local retrieval evidence.");
  return lines.join("\n");
}

function fallbackCitations(evidence) {
  const seen = new Set();
  return [...evidence.runtimeHits, ...evidence.selectedChunks]
    .map((entry) => ({
      workId: entry.workId,
      chunkId: entry.id || undefined,
      label: `${entry.workId}#${entry.chunkIndex}`,
      excerpt: normalizeWhitespace(entry.excerpt).slice(0, 420),
      r2Key: entry.r2Key || undefined,
    }))
    .filter((citation) => {
      const key = `${citation.workId}:${citation.chunkId ?? citation.label}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function buildSearchPrompt(runtimePrompt, manifest, task, evidence, question) {
  return [
    runtimePrompt,
    "",
    "You are running pass 1 of 2.",
    "Goal: use the local workspace metadata and files to assemble a focused evidence set for the user question.",
    "Constraints:",
    "- Only use local files under /workspace.",
    "- Use shell tools like rg, sed, and jq to inspect local files.",
    "- Do not browse the internet.",
    "- Do not answer the user yet.",
    "- Create a focused local corpus in /workspace/scratch/research-corpus by copying or excerpting only the most relevant passages/files.",
    "- Write /workspace/output/search-plan.json with the search strategy, chosen files, and why they matter.",
    "- Write /workspace/output/download-manifest.json with the files or excerpts you copied into scratch/research-corpus.",
    "- Write /workspace/output/evidence.json as JSON with an array field named evidence containing objects shaped like { workId, chunkId?, chunkIndex?, sourcePath, label, excerpt, rationale, r2Key? }.",
    "- Prefer exact quotes and preserve source identifiers.",
    "",
    `Question: ${question}`,
    "",
    "Task spec:",
    JSON.stringify(task, null, 2),
    "",
    "Workspace manifest summary:",
    JSON.stringify({
      works: manifest.works,
      dataSchema: manifest.dataSchema,
      fileCatalog: manifest.fileCatalog,
      selectedChunkIds: manifest.selectedChunkIds,
      selectedChunks: manifest.selectedChunks,
      taskContext: manifest.taskContext,
    }, null, 2),
    "",
    "Seed evidence from the orchestrator:",
    JSON.stringify(evidence, null, 2),
    "",
    "When finished, reply with JSON describing the files you created and the strongest work IDs you selected.",
  ].join("\n");
}

function buildBriefingPrompt(runtimePrompt, manifest, task, question) {
  return [
    runtimePrompt,
    "",
    "You are running pass 2 of 2.",
    "Goal: produce the final briefing for the chat based on the focused evidence assembled in pass 1.",
    "Constraints:",
    "- Only use local files under /workspace.",
    "- Read /workspace/output/evidence.json and the files under /workspace/scratch/research-corpus.",
    "- Write /workspace/output/briefing.md as polished markdown for the user.",
    "- Write /workspace/output/briefing.json as JSON shaped like { question, briefing, citations }.",
    "- citations must be an array of { workId, chunkId?, label, excerpt, r2Key?, sourcePath? }.",
    "- The markdown briefing should mix quotes with short explanations.",
    "- Every quote must include an adjacent source reference that maps back to the original work.",
    "- Prefer many grounded quotes over broad unsupported claims.",
    "",
    `Question: ${question}`,
    "",
    "Task spec:",
    JSON.stringify(task, null, 2),
    "",
    "Workspace manifest summary:",
    JSON.stringify({
      works: manifest.works,
      selectedChunkIds: manifest.selectedChunkIds,
      selectedChunks: manifest.selectedChunks,
    }, null, 2),
    "",
    "When finished, reply with JSON describing the briefing path, number of citations, and a short one-sentence summary.",
  ].join("\n");
}

function schemaForSearchStep() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      strongestWorkIds: {
        type: "array",
        items: { type: "string" },
      },
      createdFiles: {
        type: "array",
        items: { type: "string" },
      },
      note: {
        type: "string",
      },
    },
    required: ["strongestWorkIds", "createdFiles", "note"],
  };
}

function schemaForBriefingStep() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      briefingPath: { type: "string" },
      citationCount: { type: "integer" },
      summary: { type: "string" },
    },
    required: ["briefingPath", "citationCount", "summary"],
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    child.stdin.end(options.input ?? "");
  });
}

async function resolveCodexCommand(workspaceRoot) {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    join(workspaceRoot, "node_modules", ".bin", "codex"),
    "/app/node_modules/.bin/codex",
    "codex",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "codex") {
      return candidate;
    }
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return "codex";
}

async function runCodexStep({
  workspaceRoot,
  outputDir,
  model,
  step,
  promptText,
  schema,
}) {
  const codexCommand = await resolveCodexCommand(workspaceRoot);
  const promptPath = join(outputDir, `${step}.prompt.md`);
  const schemaPath = join(outputDir, `${step}.schema.json`);
  const outputPath = join(outputDir, `${step}.last-message.json`);
  const logPath = join(outputDir, `${step}.log.txt`);

  await writeFile(promptPath, promptText, "utf8");
  await writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf8");

  const result = await runProcess(
    codexCommand,
    [
      "exec",
      "--skip-git-repo-check",
      "-C",
      workspaceRoot,
      "--sandbox",
      "workspace-write",
      "--model",
      model,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-",
    ],
    {
      cwd: workspaceRoot,
      env: process.env,
      input: promptText,
    },
  );

  await writeFile(
    logPath,
    [
      `step=${step}`,
      `exitCode=${result.exitCode}`,
      "",
      "# stdout",
      result.stdout,
      "",
      "# stderr",
      result.stderr,
    ].join("\n"),
    "utf8",
  );

  if (result.exitCode !== 0) {
    throw new Error(`Codex step ${step} failed with exit code ${result.exitCode}.`);
  }

  return {
    step,
    promptPath,
    outputPath,
    logPath,
    exitCode: result.exitCode,
  };
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function main() {
  const taskPath = process.env.ALPHABOOK_TASK_PATH;
  const outputDir = process.env.ALPHABOOK_OUTPUT_DIR;
  const runtimePrompt = process.env.ALPHABOOK_RUNTIME_PROMPT || "";
  const model = process.env.RUNTIME_AGENT_MODEL || "gpt-5-codex";

  if (!taskPath || !outputDir) {
    throw new Error("ALPHABOOK_TASK_PATH and ALPHABOOK_OUTPUT_DIR are required.");
  }

  const contextDir = dirname(taskPath);
  const workspaceRoot = dirname(contextDir);
  const chunksRoot = join(workspaceRoot, "chunks");
  const manifestPath = join(contextDir, "manifest.json");
  const selectedChunksPath = join(contextDir, "selected-chunks.json");
  const scratchCorpusDir = join(workspaceRoot, "scratch", "research-corpus");

  await ensureDir(outputDir);
  await ensureDir(scratchCorpusDir);

  const [manifest, task, selectedChunks] = await Promise.all([
    parseJson(manifestPath),
    parseJson(taskPath),
    readJsonIfPresent(selectedChunksPath, []),
  ]);

  const question = String(task.question || task.prompt || task.task || "Analyze the workspace corpus.");
  const tokens = queryTokens(question);
  const chunkFiles = await listChunkFiles(chunksRoot);
  const allChunks = [];

  for (const chunkFile of chunkFiles) {
    const chunks = await parseChunkJsonl(chunkFile);
    allChunks.push(...chunks);
  }

  const iterationOne = searchCorpus(allChunks, tokens, question, "question-tokens");
  const expansionTokens = topTermsFromHits(iterationOne.hits, tokens);
  const iterationTwo = searchCorpus(
    allChunks,
    Array.from(new Set([...tokens, ...expansionTokens])),
    question,
    "expanded-tokens",
  );
  const selectedChunkTokens = topTermsFromHits(selectedChunks, Array.from(new Set([...tokens, ...expansionTokens])), 4);
  const iterationThree = searchCorpus(
    allChunks,
    Array.from(new Set([...tokens, ...expansionTokens, ...selectedChunkTokens])),
    question,
    "retrieval-refinement",
  );

  const iterations = [iterationOne, iterationTwo, iterationThree];
  const mergedHits = mergeHits(iterations);
  const chunkIndex = buildChunkIndex(allChunks);
  const topRuntimeHits = expandWithNeighbors(mergedHits, chunkIndex).slice(0, 10);
  const evidence = buildSearchEvidence(question, selectedChunks.slice(0, 8), topRuntimeHits);

  await writeFile(
    join(outputDir, "search-plan.json"),
    JSON.stringify(
      {
        question,
        seedTokens: tokens,
        expansionTokens,
        refinementTokens: selectedChunkTokens,
        candidateWorkIds: Array.from(new Set(topRuntimeHits.map((chunk) => String(chunk.work_id || "")))).filter(Boolean),
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(outputDir, "search-iterations.json"),
    JSON.stringify(
      iterations.map((iteration) => ({
        name: iteration.name,
        tokens: iteration.tokens,
        hits: iteration.hits.map((hit) => ({
          id: hit.id,
          work_id: hit.work_id,
          chunk_index: hit.chunk_index,
          score: hit.score,
        })),
      })),
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(join(outputDir, "evidence.seed.json"), JSON.stringify(evidence, null, 2), "utf8");

  const codexRuns = [];
  let briefing = "";
  let citations = [];

  try {
    const searchRun = await runCodexStep({
      workspaceRoot,
      outputDir,
      model,
      step: "codex-pass-1-search",
      promptText: buildSearchPrompt(runtimePrompt, manifest, task, evidence, question),
      schema: schemaForSearchStep(),
    });
    codexRuns.push(searchRun);

    const briefingRun = await runCodexStep({
      workspaceRoot,
      outputDir,
      model,
      step: "codex-pass-2-briefing",
      promptText: buildBriefingPrompt(runtimePrompt, manifest, task, question),
      schema: schemaForBriefingStep(),
    });
    codexRuns.push(briefingRun);

    const briefingJsonPath = join(outputDir, "briefing.json");
    const briefingMarkdownPath = join(outputDir, "briefing.md");
    const briefingJson = await readJsonIfPresent(briefingJsonPath, null);
    const briefingMarkdown = (await fileExists(briefingMarkdownPath))
      ? await readFile(briefingMarkdownPath, "utf8")
      : "";

    if (briefingJson && typeof briefingJson === "object") {
      briefing = typeof briefingJson.briefing === "string" ? briefingJson.briefing : briefingMarkdown;
      citations = Array.isArray(briefingJson.citations) ? briefingJson.citations : [];
    } else {
      briefing = briefingMarkdown;
    }

    if (!briefing.trim()) {
      throw new Error("Codex did not produce output/briefing.md or a usable briefing.json.");
    }
  } catch (error) {
    const fallback = {
      error: error instanceof Error ? error.message : String(error),
      note: "Falling back to the built-in deterministic local search summarizer.",
    };
    await writeFile(join(outputDir, "codex-fallback.json"), JSON.stringify(fallback, null, 2), "utf8");
    await writeFile(
      join(outputDir, "evidence.json"),
      JSON.stringify(
        {
          evidence: [...evidence.runtimeHits, ...evidence.selectedChunks].slice(0, 10).map((entry) => ({
            workId: entry.workId,
            chunkId: entry.id || undefined,
            chunkIndex: entry.chunkIndex,
            sourcePath: `chunks/${entry.workId}/chunks.jsonl`,
            label: `${entry.workId}#${entry.chunkIndex}`,
            excerpt: entry.excerpt,
            rationale: "Recovered from deterministic local search fallback.",
            r2Key: entry.r2Key || undefined,
          })),
        },
        null,
        2,
      ),
      "utf8",
    );
    briefing = fallbackBriefing(question, evidence);
    citations = fallbackCitations(evidence);
    await writeFile(join(outputDir, "briefing.md"), briefing, "utf8");
    await writeFile(
      join(outputDir, "briefing.json"),
      JSON.stringify(
        {
          question,
          briefing,
          citations,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  if (!(await fileExists(join(outputDir, "evidence.json")))) {
    await writeFile(
      join(outputDir, "evidence.json"),
      JSON.stringify(
        {
          evidence: [...evidence.runtimeHits, ...evidence.selectedChunks].slice(0, 10).map((entry) => ({
            workId: entry.workId,
            chunkId: entry.id || undefined,
            chunkIndex: entry.chunkIndex,
            sourcePath: `chunks/${entry.workId}/chunks.jsonl`,
            label: `${entry.workId}#${entry.chunkIndex}`,
            excerpt: entry.excerpt,
            rationale: "Recovered from deterministic local search results.",
            r2Key: entry.r2Key || undefined,
          })),
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  await writeFile(join(outputDir, "briefing.md"), briefing, "utf8");
  await writeFile(
    join(outputDir, "briefing.json"),
    JSON.stringify(
      {
        question,
        briefing,
        citations,
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(join(outputDir, "codex-runs.json"), JSON.stringify(codexRuns, null, 2), "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
