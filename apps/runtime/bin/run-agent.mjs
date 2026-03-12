#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
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

function buildEvidenceMarkdown(question, selectedChunks, runtimeChunks) {
  const sections = [];
  if (selectedChunks.length) {
    sections.push(
      "## Selected Chunks From Retrieval",
      ...selectedChunks.map((chunk) =>
        `- ${chunk.work_id}#${chunk.chunk_index}: "${normalizeWhitespace(String(chunk.text)).slice(0, 420)}"`,
      ),
    );
  }
  if (runtimeChunks.length) {
    sections.push(
      "## Additional Runtime Search Hits",
      ...runtimeChunks.map((chunk) =>
        `- ${chunk.work_id}#${chunk.chunk_index} (score ${chunk.score}): "${normalizeWhitespace(String(chunk.text)).slice(0, 420)}"`,
      ),
    );
  }

  return [
    `Question: ${question}`,
    "",
    ...sections,
  ].join("\n");
}

function fallbackSummary(question, selectedChunks, runtimeChunks, iterations) {
  const evidence = runtimeChunks.length ? runtimeChunks : selectedChunks;
  const lines = [
    "# Workspace Summary",
    "",
    `Question: ${question}`,
    "",
    evidence.length
      ? "I searched the hydrated workspace files and found the strongest local evidence below."
      : "I searched the hydrated workspace files, but I did not find strong matching passages.",
    "",
  ];

  if (evidence.length) {
    lines.push("## Evidence");
    for (const chunk of evidence.slice(0, 6)) {
      lines.push(`- ${chunk.work_id}#${chunk.chunk_index}: "${normalizeWhitespace(String(chunk.text)).slice(0, 360)}"`);
    }
  }

  if (iterations.length) {
    lines.push("", "## Iterations");
    for (const iteration of iterations) {
      lines.push(`- ${iteration.name}: ${iteration.tokens.join(", ") || "no tokens"} (${iteration.hits.length} hits)`);
    }
  }

  lines.push("", "## Notes", "- This summary was generated from iterative local workspace searches.");
  return lines.join("\n");
}

async function callOpenAI(prompt, question, selectedChunks, runtimeChunks) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const model = process.env.RUNTIME_AGENT_MODEL || "gpt-5-codex";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: prompt,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Use the workspace evidence to answer the task.",
                "Return plain markdown only.",
                "Include exact file or chunk references when you cite evidence.",
                "",
                buildEvidenceMarkdown(question, selectedChunks, runtimeChunks),
              ].join("\n"),
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI runtime request failed: ${await response.text()}`);
  }

  const payload = await response.json();
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const fragments = [];
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        fragments.push(content.text);
      }
    }
  }
  return fragments.join("\n").trim() || null;
}

async function main() {
  const taskPath = process.env.ALPHABOOK_TASK_PATH;
  const outputDir = process.env.ALPHABOOK_OUTPUT_DIR;
  const runtimePrompt = process.env.ALPHABOOK_RUNTIME_PROMPT || "";

  if (!taskPath || !outputDir) {
    throw new Error("ALPHABOOK_TASK_PATH and ALPHABOOK_OUTPUT_DIR are required.");
  }

  const contextDir = dirname(taskPath);
  const workspaceRoot = dirname(contextDir);
  const chunksRoot = join(workspaceRoot, "chunks");
  const selectedChunksPath = join(contextDir, "selected-chunks.json");

  const task = await parseJson(taskPath);
  const question = String(task.question || task.prompt || task.task || "Analyze the workspace corpus.");
  const tokens = queryTokens(question);

  const selectedChunks = await fileExists(selectedChunksPath) ? await parseJson(selectedChunksPath) : [];
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

  await writeFile(
    join(outputDir, "search-plan.json"),
    JSON.stringify(
      {
        question,
        seedTokens: tokens,
        expansionTokens,
        refinementTokens: selectedChunkTokens,
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
  await writeFile(
    join(outputDir, "evidence.json"),
    JSON.stringify(
      {
        selectedChunks: selectedChunks.slice(0, 6),
        runtimeHits: topRuntimeHits,
      },
      null,
      2,
    ),
    "utf8",
  );
  const summary =
    (await callOpenAI(runtimePrompt, question, selectedChunks.slice(0, 6), topRuntimeHits).catch(() => null)) ||
    fallbackSummary(question, selectedChunks.slice(0, 6), topRuntimeHits, iterations);

  await writeFile(join(outputDir, "summary.md"), summary, "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
