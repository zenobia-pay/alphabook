#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

const STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "back",
  "be",
  "been",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "during",
  "each",
  "every",
  "break",
  "find",
  "for",
  "from",
  "get",
  "getting",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "many",
  "me",
  "more",
  "most",
  "of",
  "on",
  "one",
  "or",
  "our",
  "out",
  "people",
  "person",
  "same",
  "seem",
  "seeming",
  "show",
  "that",
  "than",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "this",
  "those",
  "through",
  "times",
  "to",
  "together",
  "too",
  "up",
  "upon",
  "us",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

const NON_NARRATIVE_TITLE_PATTERN = /\b(address|constitution|bill of rights|declaration|compact)\b/i;
const ROMANTIC_RELATIONSHIP_PATTERN = /\b(love|loves|lover|lovers|beloved|husband|wife|marry|married|marriage|wedding|bride|groom|courtship)\b/i;
const KINSHIP_PATTERN = /\b(brother|sister|mother|father|son|daughter|uncle|aunt|cousin|kinsman)\b/i;
const REUNION_RETURN_PATTERN = /\b(return(?:ed)?|reconcile(?:d|r)?|reunite(?:d)?)\b/i;
const REUNION_PRIMARY_PATTERNS = [
  /\breturn again\b/i,
  /\breconciled?\b/i,
  /\breconciler\b/i,
  /\breunite(?:d)?\b/i,
  /\bbeing reconciled\b/i,
];
const REUNION_SECONDARY_SIGNALS = [
  { pattern: /\bparted\b/i, score: 12, concept: "separation" },
  { pattern: /\bseparat(?:e|ed|ion)\b/i, score: 10, concept: "separation" },
  { pattern: /\bdivorc(?:e|ed)\b/i, score: 10, concept: "separation" },
  { pattern: /\breturn(?:ed)?\b/i, score: 12, concept: "return" },
  { pattern: /\bagain\b/i, score: 7, concept: "return" },
  { pattern: /\blove(?:r|rs)?\b/i, score: 9, concept: "relationship" },
  { pattern: /\bhusband\b/i, score: 8, concept: "relationship" },
  { pattern: /\bwife\b/i, score: 8, concept: "relationship" },
  { pattern: /\bmarri(?:ed|age)\b/i, score: 9, concept: "relationship" },
];

const QUERY_FAMILIES = [
  {
    id: "anger",
    pattern: /\b(angry|anger|rage|furious|fury|wrath|resentment|resentful|mad)\b/i,
    tokens: ["angry", "anger", "rage", "furious", "fury", "wrath", "resentment", "resentful", "mad", "outrage"],
    phrases: ["grew angry", "was angry", "in anger", "full of wrath", "in a rage"],
    concepts: [
      { name: "anger", terms: ["angry", "anger", "rage", "furious", "fury", "wrath", "resentment", "outrage"] },
      { name: "outburst", terms: ["shouted", "cried out", "stormed", "choler", "fret", "swore"] },
    ],
    strongPatterns: [/\bin anger\b/i, /\bin a rage\b/i, /\bfull of wrath\b/i, /\bcholer(?:ic)?\b/i],
  },
  {
    id: "reunion",
    pattern: /\b(break ?up|broke ?up|back together|reconcile|reconciled|reunion|reunite|reunited|lovers)\b/i,
    tokens: ["separated", "parted", "reconcile", "reconciled", "reconciler", "reunion", "reunite", "reunited", "return", "again", "lover", "lovers", "love", "marry", "married", "marriage", "husband", "wife", "courtship", "divorce", "divorced"],
    phrases: ["back together", "came back", "return again", "returned to her", "returned to him", "joined again", "met again", "reunited with", "being reconciled", "reconciled to"],
    concepts: [
      { name: "separation", terms: ["parted", "separate", "separated", "divorce", "divorced", "forsook", "forsaken", "left"] },
      { name: "return", terms: ["return", "returned", "again", "reconcile", "reconciled", "reconciler", "reunite", "reunited", "joined again", "met again"] },
      { name: "relationship", terms: ["love", "lover", "lovers", "marry", "married", "marriage", "husband", "wife", "courtship", "wedding"] },
    ],
    strongPatterns: [
      /\bparted from .* return again\b/i,
      /\breconciled? to\b/i,
      /\breturned? to (?:her|him)\b/i,
      /\bbeing reconciled\b/i,
      /\bhusband and wife may be divorced\b/i,
    ],
    downweightNonNarrativeTitles: true,
  },
  {
    id: "grief",
    pattern: /\b(grief|grieve|mourning|sorrow|lament)\b/i,
    tokens: ["grief", "grieve", "grieving", "mourning", "mourn", "sorrow", "sorrows", "lament", "lamentation"],
    phrases: ["full of grief", "in sorrow", "began to mourn"],
    concepts: [
      { name: "grief", terms: ["grief", "grieve", "mourning", "mourn", "sorrow", "lament"] },
      { name: "loss", terms: ["death", "dead", "buried", "loss", "weep", "wept"] },
    ],
    strongPatterns: [/\bfull of grief\b/i, /\bin sorrow\b/i, /\bbegan to mourn\b/i],
  },
  {
    id: "obsession",
    pattern: /\b(obsession|obsessed|fixation|consumed)\b/i,
    tokens: ["obsession", "obsessed", "fixation", "consumed", "consume", "monomania"],
    phrases: ["could not stop", "fixed upon", "consumed by"],
    concepts: [
      { name: "fixation", terms: ["obsession", "obsessed", "fixation", "consumed", "consume", "monomania"] },
      { name: "persistence", terms: ["could not stop", "fixed upon", "again and again"] },
    ],
    strongPatterns: [/\bcould not stop\b/i, /\bfixed upon\b/i, /\bconsumed by\b/i],
  },
];

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function semanticExpansions(question) {
  const expansions = {
    tokens: [],
    phrases: [],
    families: [],
  };

  for (const family of QUERY_FAMILIES) {
    if (!family.pattern.test(question)) {
      continue;
    }
    expansions.families.push(family);
    expansions.tokens.push(...family.tokens);
    expansions.phrases.push(...family.phrases);
  }

  return {
    tokens: Array.from(new Set(expansions.tokens)),
    phrases: Array.from(new Set(expansions.phrases)),
    families: expansions.families,
  };
}

function scoreText(text, tokens, phrases) {
  const haystack = normalizeWhitespace(text).toLowerCase();
  let score = 0;
  for (const token of tokens) {
    const count = countOccurrences(haystack, token.toLowerCase());
    if (count === 0) {
      continue;
    }
    score += count * (token.length >= 7 ? 4 : 3);
  }
  for (const phrase of phrases) {
    if (haystack.includes(phrase.toLowerCase())) {
      score += 10;
    }
  }
  return score;
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

  for (const hit of hits.slice(0, 8)) {
    const workChunks = byWork.get(String(hit.work_id || "")) || [];
    const hitIndex = workChunks.findIndex((candidate) => String(candidate.id || "") === String(hit.id || ""));
    const neighbors = hitIndex >= 0
      ? workChunks.slice(Math.max(0, hitIndex - 1), hitIndex + 2).filter((chunk) => String(chunk.id || "") !== String(hit.id || ""))
      : [];
    const window = [hit, ...neighbors];

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

function countOccurrences(text, term) {
  if (!term) {
    return 0;
  }
  const normalizedTerm = normalizeWhitespace(term.toLowerCase());
  if (!normalizedTerm) {
    return 0;
  }
  const escaped = escapeRegex(normalizedTerm).replace(/\s+/g, "\\s+");
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "gi");
  return [...text.matchAll(pattern)].length;
}

function conceptMatches(text, concept) {
  let count = 0;
  for (const term of concept.terms) {
    count += countOccurrences(text, term.toLowerCase());
  }
  return count;
}

function scoreFamilySignals(text, family) {
  const matchedConcepts = [];
  const matchedPatterns = [];
  let score = 0;

  for (const concept of family.concepts ?? []) {
    const count = conceptMatches(text, concept);
    if (count <= 0) {
      continue;
    }
    matchedConcepts.push(concept.name);
    score += 8 + Math.min(count, 3) * 5;
  }

  for (const pattern of family.strongPatterns ?? []) {
    if (!pattern.test(text)) {
      continue;
    }
    matchedPatterns.push(pattern.source);
    score += 18;
  }

  if (family.id === "reunion") {
    const hasRomanticRelationship = ROMANTIC_RELATIONSHIP_PATTERN.test(text);
    const hasKinshipOnly = KINSHIP_PATTERN.test(text) && !hasRomanticRelationship;
    if (matchedConcepts.includes("return") && matchedConcepts.includes("relationship")) {
      score += 24;
    }
    if (matchedConcepts.includes("return") && matchedConcepts.includes("separation")) {
      score += 22;
    }
    if (matchedConcepts.includes("return") && hasRomanticRelationship) {
      score += 16;
    }
    if (hasKinshipOnly) {
      score -= 26;
    }
    if (!matchedConcepts.includes("return") && matchedPatterns.length === 0) {
      score -= 22;
    }
    if (matchedConcepts.includes("relationship") && !matchedConcepts.includes("return")) {
      score -= 10;
    }
    if (matchedConcepts.length < 2 && matchedPatterns.length === 0) {
      score -= 12;
    }
  }

  return {
    score,
    matchedConcepts,
    matchedPatterns,
  };
}

function contextWindowText(chunk, byWork, radius = 2) {
  const workChunks = byWork.get(String(chunk.work_id || "")) || [];
  const hitIndex = workChunks.findIndex((candidate) => String(candidate.id || "") === String(chunk.id || ""));
  if (hitIndex < 0) {
    return normalizeWhitespace(String(chunk.text || ""));
  }
  return normalizeWhitespace(
    workChunks
      .slice(Math.max(0, hitIndex - radius), hitIndex + radius + 1)
      .map((candidate) => String(candidate.text || ""))
      .join(" "),
  );
}

function isStrongReunionHit(hit, byWork) {
  const windowText = contextWindowText(hit, byWork, 2).toLowerCase();
  const hasPrimaryPattern = REUNION_PRIMARY_PATTERNS.some((pattern) => pattern.test(windowText));
  const hasReturnSignal =
    hasPrimaryPattern ||
    REUNION_RETURN_PATTERN.test(windowText) ||
    (Array.isArray(hit.matched_concepts) && hit.matched_concepts.includes("return"));
  const hasSeparationSignal =
    /\b(parted|separate|separated|separation|divorce|divorced|left|forsook|forsaken)\b/i.test(windowText) ||
    (Array.isArray(hit.matched_concepts) && hit.matched_concepts.includes("separation"));
  const hasRomanticSignal =
    ROMANTIC_RELATIONSHIP_PATTERN.test(windowText) ||
    (Array.isArray(hit.matched_concepts) && hit.matched_concepts.includes("relationship"));
  const hasKinshipOnly = KINSHIP_PATTERN.test(windowText) && !hasRomanticSignal;

  if (!hasReturnSignal) {
    return false;
  }
  if (hasKinshipOnly) {
    return false;
  }
  return hasPrimaryPattern || hasRomanticSignal || hasSeparationSignal;
}

function filterFamilyHits(hits, byWork, families) {
  if (!families.some((family) => family.id === "reunion")) {
    return hits;
  }
  const strictHits = hits.filter((hit) => isStrongReunionHit(hit, byWork));
  return strictHits.length > 0 ? strictHits : hits;
}

function prioritizeFamilyHits(hits, families) {
  if (!families.some((family) => family.id === "reunion")) {
    return hits;
  }
  return [...hits].sort((left, right) => {
    const leftWindow = Array.isArray(left.matched_iterations) && left.matched_iterations.includes("reunion-window-search") ? 1 : 0;
    const rightWindow = Array.isArray(right.matched_iterations) && right.matched_iterations.includes("reunion-window-search") ? 1 : 0;
    if (leftWindow !== rightWindow) {
      return rightWindow - leftWindow;
    }
    return right.score - left.score || left.chunk_index - right.chunk_index;
  });
}

function workScoreAdjustment(question, work, activeFamilies) {
  if (!work) {
    return 0;
  }
  let score = 0;
  const title = String(work.title || "");

  if (activeFamilies.some((family) => family.downweightNonNarrativeTitles) && NON_NARRATIVE_TITLE_PATTERN.test(title)) {
    score -= 32;
  }

  if (/\b(love|lover|marry|married|husband|wife|break ?up|reconcile|reunite)\b/i.test(question) && /shakespeare|twain/i.test(String(work.authors || ""))) {
    score += 8;
  }

  return score;
}

function searchCorpus(allChunks, question, tokens, phrases, families, workById, name) {
  const hits = [];
  for (const chunk of allChunks) {
    const text = String(chunk.text || "");
    const normalizedText = normalizeWhitespace(text).toLowerCase();
    let score = scoreText(text, tokens, phrases);
    const matchedConcepts = [];
    const matchedPatterns = [];

    for (const family of families) {
      const familySignals = scoreFamilySignals(normalizedText, family);
      score += familySignals.score;
      matchedConcepts.push(...familySignals.matchedConcepts);
      matchedPatterns.push(...familySignals.matchedPatterns);
    }

    score += workScoreAdjustment(question, workById.get(String(chunk.work_id || "")), families);
    if (score <= 0) {
      continue;
    }
    hits.push({
      ...chunk,
      score,
      matched_concepts: Array.from(new Set(matchedConcepts)),
      matched_patterns: Array.from(new Set(matchedPatterns)),
    });
  }
  hits.sort((left, right) => right.score - left.score || left.chunk_index - right.chunk_index);
  return {
    name,
    tokens,
    phrases,
    hits: hits.slice(0, 24),
  };
}

function diversifyHits(hits, limit = 10, perWorkLimit = 4) {
  const selected = [];
  const perWorkCounts = new Map();

  for (const hit of hits) {
    const workId = String(hit.work_id || "");
    const count = perWorkCounts.get(workId) || 0;
    if (count >= perWorkLimit) {
      continue;
    }
    perWorkCounts.set(workId, count + 1);
    selected.push(hit);
    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
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

function searchReunionWindows(chunkIndex, workById, question) {
  const hits = [];
  const reunionFamily = QUERY_FAMILIES.find((family) => family.id === "reunion");

  for (const workChunks of chunkIndex.values()) {
    for (let index = 0; index < workChunks.length; index += 1) {
      const windowChunks = workChunks.slice(Math.max(0, index - 2), index + 3);
      const currentChunk = workChunks[index];
      const windowText = normalizeWhitespace(windowChunks.map((chunk) => String(chunk.text || "")).join(" ")).toLowerCase();

      let score = 0;
      const matchedPatterns = [];
      const matchedConcepts = new Set();
      let hasPrimarySignal = false;

      for (const pattern of REUNION_PRIMARY_PATTERNS) {
        if (!pattern.test(windowText)) {
          continue;
        }
        hasPrimarySignal = true;
        matchedPatterns.push(pattern.source);
        score += 28;
        matchedConcepts.add("return");
      }

      if (!hasPrimarySignal) {
        continue;
      }

      for (const signal of REUNION_SECONDARY_SIGNALS) {
        if (!signal.pattern.test(windowText)) {
          continue;
        }
        score += signal.score;
        matchedConcepts.add(signal.concept);
      }

      if (matchedConcepts.has("return") && matchedConcepts.has("relationship")) {
        score += 18;
      }
      if (matchedConcepts.has("return") && matchedConcepts.has("separation")) {
        score += 16;
      }

      score += workScoreAdjustment(question, workById.get(String(currentChunk.work_id || "")), reunionFamily ? [reunionFamily] : []);

      hits.push({
        ...currentChunk,
        score,
        matched_concepts: Array.from(matchedConcepts),
        matched_patterns: matchedPatterns,
      });
    }
  }

  hits.sort((left, right) => right.score - left.score || left.chunk_index - right.chunk_index);
  return {
    name: "reunion-window-search",
    tokens: [],
    phrases: [],
    hits: hits.slice(0, 24),
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

function buildSearchEvidence(question, selectedChunks, runtimeChunks, workById) {
  return {
    question,
    selectedChunks: selectedChunks.slice(0, 8).map((chunk) => ({
      id: String(chunk.id || ""),
      workId: String(chunk.work_id || chunk.workId || ""),
      title: String(workById.get(String(chunk.work_id || chunk.workId || ""))?.title || ""),
      chunkIndex: Number(chunk.chunk_index || chunk.chunkIndex || 0),
      excerpt: normalizeWhitespace(String(chunk.excerpt || chunk.text || "")).slice(0, 500),
      r2Key: chunk.r2Key ?? chunk.r2_key ?? null,
    })),
    runtimeHits: runtimeChunks.slice(0, 10).map((chunk) => ({
      id: String(chunk.id || ""),
      workId: String(chunk.work_id || chunk.workId || ""),
      title: String(workById.get(String(chunk.work_id || chunk.workId || ""))?.title || ""),
      chunkIndex: Number(chunk.chunk_index || chunk.chunkIndex || 0),
      excerpt: normalizeWhitespace(String(chunk.text || "")).slice(0, 500),
      score: Number(chunk.score || 0),
      matchedIterations: Array.isArray(chunk.matched_iterations) ? chunk.matched_iterations : [],
      matchedConcepts: Array.isArray(chunk.matched_concepts) ? chunk.matched_concepts : [],
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
    lines.push("I searched the current corpus snapshot, but did not find enough quoted passages to answer confidently.");
    return lines.join("\n");
  }

  for (const entry of [...evidence.runtimeHits, ...evidence.selectedChunks].slice(0, 6)) {
    const sourceLabel = entry.title ? `${entry.title} (${entry.workId}#${entry.chunkIndex})` : `${entry.workId}#${entry.chunkIndex}`;
    const conceptSummary = Array.isArray(entry.matchedConcepts) && entry.matchedConcepts.length > 0
      ? `it matches the local search signals for ${entry.matchedConcepts.join(", ")}`
      : "it surfaced during the local corpus scan";
    lines.push(
      `- ${sourceLabel}: "${normalizeWhitespace(entry.excerpt).slice(0, 360)}"`,
      `  This passage appears relevant to the question because ${conceptSummary}.`,
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
  const manifestSummary = {
    works: Array.isArray(manifest.works)
      ? manifest.works.slice(0, 30).map((work) => ({
        workId: work.workId,
        title: work.title,
        authors: work.authors ?? [],
        language: work.language ?? null,
        cleanTextKey: work.cleanTextKey ?? null,
        chunksKey: work.chunksKey ?? null,
      }))
      : [],
    dataSchema: manifest.dataSchema,
    selectedChunkIds: manifest.selectedChunkIds,
    selectedChunks: Array.isArray(manifest.selectedChunks)
      ? manifest.selectedChunks.slice(0, 12).map((chunk) => ({
        workId: chunk.workId,
        chunkId: chunk.chunkId,
        excerpt: typeof chunk.excerpt === "string" ? normalizeWhitespace(chunk.excerpt).slice(0, 220) : "",
      }))
      : [],
    taskContext: manifest.taskContext,
  };
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
    "- Write /workspace/output/evidence-notes.md as markdown notes summarizing what you found so far and which texts look most relevant.",
    "- Prefer exact quotes and preserve source identifiers.",
    "",
    `Question: ${question}`,
    "",
    "Task spec:",
    JSON.stringify(task, null, 2),
    "",
    "Workspace manifest summary:",
    JSON.stringify(manifestSummary, null, 2),
    "",
    "Seed evidence from the orchestrator:",
    JSON.stringify(evidence, null, 2),
    "",
    "When finished, reply with JSON describing the files you created and the strongest work IDs you selected.",
  ].join("\n");
}

function buildBriefingPrompt(runtimePrompt, manifest, task, question) {
  const manifestSummary = {
    works: Array.isArray(manifest.works)
      ? manifest.works.slice(0, 30).map((work) => ({
        workId: work.workId,
        title: work.title,
        authors: work.authors ?? [],
        language: work.language ?? null,
      }))
      : [],
    selectedChunkIds: manifest.selectedChunkIds,
    selectedChunks: Array.isArray(manifest.selectedChunks)
      ? manifest.selectedChunks.slice(0, 12).map((chunk) => ({
        workId: chunk.workId,
        chunkId: chunk.chunkId,
        excerpt: typeof chunk.excerpt === "string" ? normalizeWhitespace(chunk.excerpt).slice(0, 220) : "",
      }))
      : [],
  };
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
    "Existing evidence:",
    "Read /workspace/output/evidence.json and /workspace/output/evidence-notes.md before writing the briefing.",
    "",
    "Workspace manifest summary:",
    JSON.stringify(manifestSummary, null, 2),
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

function normalizePhase(task) {
  return typeof task.phase === "string" ? task.phase : "collect_and_brief";
}

function evidenceItemsFromSeed(evidence) {
  return [...evidence.runtimeHits, ...evidence.selectedChunks].slice(0, 10).map((entry) => ({
    workId: entry.workId,
    chunkId: entry.id || undefined,
    chunkIndex: entry.chunkIndex,
    sourcePath: `chunks/${entry.workId}/chunks.jsonl`,
    label: `${entry.workId}#${entry.chunkIndex}`,
    title: entry.title || undefined,
    excerpt: entry.excerpt,
    rationale:
      Array.isArray(entry.matchedConcepts) && entry.matchedConcepts.length > 0
        ? `Recovered from deterministic local search results matching ${entry.matchedConcepts.join(", ")}.`
        : "Recovered from deterministic local search results.",
    r2Key: entry.r2Key || undefined,
  }));
}

async function ensureEvidenceArtifacts(outputDir, question, evidence, reason = "Recovered from deterministic local search results.") {
  const evidenceJsonPath = join(outputDir, "evidence.json");
  const notesPath = join(outputDir, "evidence-notes.md");
  const items = evidenceItemsFromSeed(evidence).map((entry) => ({
    ...entry,
    rationale: reason,
  }));
  await writeFile(
    evidenceJsonPath,
    JSON.stringify(
      {
        question,
        evidence: items,
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    notesPath,
    [
      "# Evidence Notes",
      "",
      `Question: ${question}`,
      "",
      "## Current Leads",
      ...items.slice(0, 8).map((entry) =>
        `- ${entry.title ? `${entry.title} (${entry.label})` : entry.label}: "${normalizeWhitespace(entry.excerpt).slice(0, 360)}"`,
      ),
      "",
      "## Notes",
      "- These notes summarize the current evidence set before the final briefing step.",
    ].join("\n"),
    "utf8",
  );
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

  const attemptLogs = [];
  let result = null;
  let exitCode = 1;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await runProcess(
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

    exitCode = result.exitCode;
    attemptLogs.push(
      [
        `attempt=${attempt}`,
        `exitCode=${result.exitCode}`,
        "",
        "# stdout",
        result.stdout,
        "",
        "# stderr",
        result.stderr,
      ].join("\n"),
    );

    if (result.exitCode === 0) {
      break;
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }

  await writeFile(
    logPath,
    [
      `step=${step}`,
      `exitCode=${exitCode}`,
      `attempts=${attemptLogs.length}`,
      "",
      ...attemptLogs,
    ].join("\n\n"),
    "utf8",
  );

  if (!result || result.exitCode !== 0) {
    throw new Error(`Codex step ${step} failed with exit code ${exitCode}.`);
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
  const expansions = semanticExpansions(question);
  const searchTokens = Array.from(new Set([...tokens, ...expansions.tokens]));
  const searchPhrases = Array.from(new Set([normalizeWhitespace(question.toLowerCase()), ...expansions.phrases]));
  const workById = new Map(
    Array.isArray(manifest.works)
      ? manifest.works.map((work) => [String(work.workId || ""), work])
      : [],
  );
  const chunkFiles = await listChunkFiles(chunksRoot);
  const allChunks = [];

  for (const chunkFile of chunkFiles) {
    const chunks = await parseChunkJsonl(chunkFile);
    allChunks.push(...chunks);
  }

  const chunkIndex = buildChunkIndex(allChunks);
  const iterations = [
    searchCorpus(allChunks, question, searchTokens, searchPhrases, expansions.families, workById, "family-search"),
  ];
  if (expansions.families.some((family) => family.id === "reunion")) {
    iterations.push(searchReunionWindows(chunkIndex, workById, question));
  }
  const mergedHits = mergeHits(iterations);
  const filteredHits = prioritizeFamilyHits(filterFamilyHits(mergedHits, chunkIndex, expansions.families), expansions.families);
  const topRuntimeHits = diversifyHits(expandWithNeighbors(filteredHits, chunkIndex), 10, 3);
  const evidence = buildSearchEvidence(question, selectedChunks.slice(0, 8), topRuntimeHits, workById);

  await writeFile(
    join(outputDir, "search-plan.json"),
    JSON.stringify(
      {
        question,
        seedTokens: tokens,
        semanticTokens: expansions.tokens,
        semanticFamilies: expansions.families.map((family) => family.id),
        phraseBoosts: searchPhrases,
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
          matched_concepts: Array.isArray(hit.matched_concepts) ? hit.matched_concepts : [],
        })),
      })),
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(join(outputDir, "evidence.seed.json"), JSON.stringify(evidence, null, 2), "utf8");

  const phase = normalizePhase(task);
  const codexRuns = [];
  let briefing = "";
  let citations = [];

  try {
    if (phase === "collect_evidence" || phase === "collect_and_brief") {
      const searchRun = await runCodexStep({
        workspaceRoot,
        outputDir,
        model,
        step: "codex-pass-1-search",
        promptText: buildSearchPrompt(runtimePrompt, manifest, task, evidence, question),
        schema: schemaForSearchStep(),
      });
      codexRuns.push(searchRun);
      if (!(await fileExists(join(outputDir, "evidence.json"))) || !(await fileExists(join(outputDir, "evidence-notes.md")))) {
        await ensureEvidenceArtifacts(outputDir, question, evidence, "Recovered after the Codex evidence pass did not write all expected artifacts.");
      }
    }

    if (phase === "write_briefing" || phase === "collect_and_brief") {
      if (!(await fileExists(join(outputDir, "evidence.json"))) || !(await fileExists(join(outputDir, "evidence-notes.md")))) {
        await ensureEvidenceArtifacts(outputDir, question, evidence);
      }

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
    }
  } catch (error) {
    const fallback = {
      error: error instanceof Error ? error.message : String(error),
      note: "Falling back to the built-in deterministic local search summarizer.",
    };
    await writeFile(join(outputDir, "codex-fallback.json"), JSON.stringify(fallback, null, 2), "utf8");
    await ensureEvidenceArtifacts(outputDir, question, evidence, "Recovered from deterministic local search fallback.");
    if (phase === "write_briefing" || phase === "collect_and_brief") {
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
  }

  if (!(await fileExists(join(outputDir, "evidence.json"))) || !(await fileExists(join(outputDir, "evidence-notes.md")))) {
    await ensureEvidenceArtifacts(outputDir, question, evidence);
  }

  if (phase === "write_briefing" || phase === "collect_and_brief") {
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

  const previousCodexRuns = await readJsonIfPresent(join(outputDir, "codex-runs.json"), []);
  const nextCodexRuns = Array.isArray(previousCodexRuns) ? [...previousCodexRuns, ...codexRuns] : codexRuns;
  await writeFile(join(outputDir, "codex-runs.json"), JSON.stringify(nextCodexRuns, null, 2), "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
