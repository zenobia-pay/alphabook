#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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

function normalizeChunkRecord(chunk, workById) {
  const workId = String(chunk.work_id || chunk.workId || "");
  const work = workById.get(workId);
  return {
    chunkId: String(chunk.id || chunk.chunkId || ""),
    workId,
    workTitle: typeof work?.title === "string" ? work.title : null,
    authors: Array.isArray(work?.authors) ? work.authors : [],
    chunkIndex:
      typeof chunk.chunk_index === "number"
        ? chunk.chunk_index
        : typeof chunk.chunkIndex === "number"
          ? chunk.chunkIndex
          : null,
    excerpt:
      typeof chunk.text === "string"
        ? normalizeWhitespace(chunk.text).slice(0, 420)
        : typeof chunk.excerpt === "string"
          ? normalizeWhitespace(chunk.excerpt).slice(0, 420)
          : "",
    r2Key: typeof chunk.r2Key === "string" ? chunk.r2Key : null,
  };
}

function buildViewedChunksArtifact(selectedChunks, iterations, evidence, topRuntimeHits, workById) {
  const byChunkId = new Map();

  function ensureChunk(chunk) {
    const record = normalizeChunkRecord(chunk, workById);
    if (!record.chunkId) {
      return null;
    }
    const existing = byChunkId.get(record.chunkId);
    if (existing) {
      if (!existing.excerpt && record.excerpt) {
        existing.excerpt = record.excerpt;
      }
      if (existing.chunkIndex === null && record.chunkIndex !== null) {
        existing.chunkIndex = record.chunkIndex;
      }
      if (!existing.r2Key && record.r2Key) {
        existing.r2Key = record.r2Key;
      }
      if (!existing.workTitle && record.workTitle) {
        existing.workTitle = record.workTitle;
      }
      if ((!Array.isArray(existing.authors) || existing.authors.length === 0) && record.authors.length > 0) {
        existing.authors = record.authors;
      }
      return existing;
    }
    const created = {
      ...record,
      viewedIn: [],
      matchedIterations: [],
      scores: [],
    };
    byChunkId.set(record.chunkId, created);
    return created;
  }

  for (const chunk of Array.isArray(selectedChunks) ? selectedChunks : []) {
    const entry = ensureChunk(chunk);
    if (!entry) {
      continue;
    }
    entry.viewedIn.push("workspace_selected_chunks");
  }

  for (const iteration of Array.isArray(iterations) ? iterations : []) {
    const iterationName = typeof iteration?.name === "string" ? iteration.name : "unknown";
    for (const hit of Array.isArray(iteration?.hits) ? iteration.hits : []) {
      const entry = ensureChunk(hit);
      if (!entry) {
        continue;
      }
      entry.viewedIn.push("search_iteration");
      entry.matchedIterations.push(iterationName);
      if (typeof hit.score === "number") {
        entry.scores.push(hit.score);
      }
    }
  }

  for (const chunk of Array.isArray(topRuntimeHits) ? topRuntimeHits : []) {
    const entry = ensureChunk(chunk);
    if (!entry) {
      continue;
    }
    entry.viewedIn.push("top_runtime_hits");
    if (typeof chunk.score === "number") {
      entry.scores.push(chunk.score);
    }
  }

  for (const chunk of Array.isArray(evidence?.runtimeHits) ? evidence.runtimeHits : []) {
    const entry = ensureChunk(chunk);
    if (!entry) {
      continue;
    }
    entry.viewedIn.push("briefing_evidence");
  }

  const chunks = [...byChunkId.values()]
    .map((entry) => ({
      ...entry,
      viewedIn: Array.from(new Set(entry.viewedIn)),
      matchedIterations: Array.from(new Set(entry.matchedIterations)),
      maxScore: entry.scores.length > 0 ? Math.max(...entry.scores) : null,
      scores: undefined,
    }))
    .sort((left, right) => {
      const scoreDelta = (right.maxScore ?? -1) - (left.maxScore ?? -1);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      if (left.workTitle && right.workTitle && left.workTitle !== right.workTitle) {
        return left.workTitle.localeCompare(right.workTitle);
      }
      return (left.chunkIndex ?? 0) - (right.chunkIndex ?? 0);
    });

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      uniqueChunkCount: chunks.length,
      selectedChunkCount: Array.isArray(selectedChunks) ? selectedChunks.length : 0,
      topRuntimeHitCount: Array.isArray(topRuntimeHits) ? topRuntimeHits.length : 0,
      iterationCount: Array.isArray(iterations) ? iterations.length : 0,
    },
    chunks,
  };
}

function buildViewedChunksMarkdown(reference) {
  const lines = [
    "# Every Single Reference",
    "",
    `Generated: ${reference.generatedAt}`,
    "",
    `Unique chunks viewed: ${reference.summary.uniqueChunkCount}`,
    `Selected workspace chunks: ${reference.summary.selectedChunkCount}`,
    `Top runtime hits: ${reference.summary.topRuntimeHitCount}`,
    `Search iterations: ${reference.summary.iterationCount}`,
    "",
  ];

  for (const chunk of Array.isArray(reference.chunks) ? reference.chunks : []) {
    const title = chunk.workTitle || chunk.workId || "Unknown work";
    const location = chunk.chunkIndex === null ? chunk.chunkId : `${chunk.chunkId}#${chunk.chunkIndex}`;
    lines.push(`## ${title}`);
    lines.push("");
    lines.push(`- Work ID: ${chunk.workId}`);
    lines.push(`- Chunk: ${location}`);
    if (Array.isArray(chunk.authors) && chunk.authors.length > 0) {
      lines.push(`- Authors: ${chunk.authors.join(", ")}`);
    }
    if (Array.isArray(chunk.viewedIn) && chunk.viewedIn.length > 0) {
      lines.push(`- Seen in: ${chunk.viewedIn.join(", ")}`);
    }
    if (Array.isArray(chunk.matchedIterations) && chunk.matchedIterations.length > 0) {
      lines.push(`- Matched iterations: ${chunk.matchedIterations.join(", ")}`);
    }
    if (chunk.maxScore !== null && chunk.maxScore !== undefined) {
      lines.push(`- Max score: ${chunk.maxScore}`);
    }
    if (typeof chunk.excerpt === "string" && chunk.excerpt.length > 0) {
      lines.push("");
      lines.push(`> ${chunk.excerpt}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

function normalizeSeedChunk(chunk, workById) {
  if (!chunk || typeof chunk !== "object") {
    return null;
  }
  const record = normalizeChunkRecord(chunk, workById);
  if (!record.chunkId || !record.workId) {
    return null;
  }
  return {
    id: record.chunkId,
    workId: record.workId,
    title: record.workTitle || "",
    chunkIndex: typeof record.chunkIndex === "number" ? record.chunkIndex : 0,
    excerpt: record.excerpt,
    r2Key: record.r2Key,
  };
}

function gatherSeedChunks(task, selectedChunks, workById) {
  const seedChunks = [];
  const seen = new Set();

  function push(chunk) {
    const normalized = normalizeSeedChunk(chunk, workById);
    if (!normalized || seen.has(normalized.id)) {
      return;
    }
    seen.add(normalized.id);
    seedChunks.push(normalized);
  }

  for (const chunk of Array.isArray(selectedChunks) ? selectedChunks : []) {
    push(chunk);
  }

  const retrieval = task?.retrieval;
  if (retrieval && typeof retrieval === "object") {
    for (const chunk of Array.isArray(retrieval.seedChunks) ? retrieval.seedChunks : []) {
      push(chunk);
    }
  }

  return seedChunks;
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
    candidateWorkIds: Array.isArray(runtimeChunks)
      ? Array.from(new Set(runtimeChunks.slice(0, 12).map((chunk) => String(chunk.work_id || chunk.workId || "")))).filter(Boolean)
      : [],
  };
}

function sampleStrings(values, limit = 8) {
  return Array.isArray(values)
    ? values.filter((value) => typeof value === "string").slice(0, limit)
    : [];
}

function compactTaskContext(taskContext) {
  if (!taskContext || typeof taskContext !== "object") {
    return {};
  }

  const normalized = taskContext;
  return {
    mode: typeof normalized.mode === "string" ? normalized.mode : null,
    prompt: typeof normalized.prompt === "string" ? normalizeWhitespace(normalized.prompt).slice(0, 220) : null,
    question: typeof normalized.question === "string" ? normalizeWhitespace(normalized.question).slice(0, 220) : null,
    runtimeId: typeof normalized.runtimeId === "string" ? normalized.runtimeId : null,
    corpusWorkCount: typeof normalized.corpusWorkCount === "number" ? normalized.corpusWorkCount : null,
    hydratedWorkCount: typeof normalized.hydratedWorkCount === "number" ? normalized.hydratedWorkCount : null,
    candidateWorkIds: sampleStrings(normalized.candidateWorkIds, 8),
    selectedChunkIds: sampleStrings(normalized.selectedChunkIds, 8),
    topChunkIds: Array.isArray(normalized.topChunks)
      ? normalized.topChunks
        .slice(0, 6)
        .map((chunk) => (chunk && typeof chunk === "object" && typeof chunk.chunkId === "string" ? chunk.chunkId : null))
        .filter(Boolean)
      : [],
  };
}

function compactTaskSpec(task, openBookMode) {
  return {
    runtimeId: typeof task.runtimeId === "string" ? task.runtimeId : null,
    taskType: typeof task.taskType === "string" ? task.taskType : null,
    mode: typeof task.mode === "string" ? task.mode : null,
    researchObjective:
      typeof task.researchObjective === "string"
        ? normalizeWhitespace(task.researchObjective).slice(0, 320)
        : typeof task.question === "string"
          ? normalizeWhitespace(task.question).slice(0, 320)
          : typeof task.goal === "string"
            ? normalizeWhitespace(task.goal).slice(0, 320)
            : null,
    retrievalQuery: typeof task.query === "string" ? normalizeWhitespace(task.query).slice(0, 220) : null,
    goal: typeof task.goal === "string" ? normalizeWhitespace(task.goal).slice(0, 280) : null,
    topK: typeof task.topK === "number" ? task.topK : null,
    dedupe: typeof task.dedupe === "boolean" ? task.dedupe : null,
    prefer: Array.isArray(task.prefer) ? task.prefer.slice(0, 6).map((item) => normalizeWhitespace(String(item)).slice(0, 120)) : [],
    openBookMode,
    taskContext: compactTaskContext(task.taskContext),
  };
}

function buildBriefingPrompt(runtimePrompt, manifest, task, evidence, question) {
  const taskContext = manifest.taskContext && typeof manifest.taskContext === "object"
    ? manifest.taskContext
    : {};
  const openBookMode = taskContext.mode === "open_book_analysis";
  const manifestSummary = {
    corpusWorkCount:
      typeof manifest.taskContext?.corpusWorkCount === "number"
        ? manifest.taskContext.corpusWorkCount
        : Array.isArray(manifest.works) ? manifest.works.length : 0,
    hydratedWorkCount: Array.isArray(manifest.works) ? manifest.works.length : 0,
    hydratedWorks: Array.isArray(manifest.works)
      ? manifest.works.slice(0, 12).map((work) => ({
        workId: work.workId,
        title: work.title,
        authors: work.authors ?? [],
        language: work.language ?? null,
      }))
      : [],
    fileKinds: Array.isArray(manifest.fileCatalog)
      ? [...new Set(manifest.fileCatalog.map((file) => file.kind).filter(Boolean))].slice(0, 6)
      : [],
    selectedChunkCount: Array.isArray(manifest.selectedChunkIds) ? manifest.selectedChunkIds.length : 0,
    selectedChunks: Array.isArray(manifest.selectedChunks)
      ? manifest.selectedChunks.slice(0, 8).map((chunk) => ({
        workId: chunk.workId,
        chunkId: chunk.id ?? chunk.chunkId ?? null,
        excerpt: typeof chunk.excerpt === "string" ? normalizeWhitespace(chunk.excerpt).slice(0, 220) : "",
      }))
      : [],
    taskContext: compactTaskContext(manifest.taskContext),
  };
  const compactTask = compactTaskSpec(task, openBookMode);
  const researchObjective = compactTask.researchObjective || question;
  return [
    runtimePrompt,
    "",
    "You are running the single AlphaBook Codex workspace pass.",
    openBookMode
      ? "Goal: answer the question from the currently open book, using the hydrated local files first and widening scope only if absolutely necessary."
      : "Goal: search as broadly as needed across the corpus, collect the strongest primary-source passages, and write the final user-facing briefing in one run.",
    "Constraints:",
    "- Only use local files under /workspace.",
    "- Start from the local schema, the book metadata, the file catalog, and any seed evidence already in the workspace.",
    openBookMode
      ? "- Stay inside the current hydrated book unless the local evidence is clearly insufficient."
      : "- Start from the best available seed evidence, but widen across the full corpus whenever the prompt asks for a broad theme, comparison, or survey.",
    openBookMode
      ? "- Use at most 5 shell commands total before you return your answer."
      : "- Keep the search bounded: use at most 14 shell commands total before you return your answer.",
    "- Prefer finishing with a good briefing over exhaustively exploring every possible lead.",
    openBookMode
      ? "- Search the local clean text and local chunks first with rg and sed. Use the remote Postgres corpus CLI only as a fallback."
      : "- Use the remote Postgres database through the local corpus CLI at node /workspace/context/search-db.mjs as your main corpus-wide search surface. Do not assume relevant books are hydrated locally.",
    "- The CLI turns corpus-wide search requests into SQL over the remote chunks table and returns results in plain text or JSON so you can keep working with normal shell tools.",
    "- Guaranteed tools in this runtime image: node, python/python3, jq, rg, sed, awk, grep, cat, mkdir.",
    "- node /workspace/context/search-db.mjs rg behaves like ripgrep over the remote chunks table and can be piped into sed, awk, jq, and other shell tools.",
    "- It also supports --glob and --kind filters, plus -U/--multiline and --window for wider cross-chunk search windows.",
    "- node /workspace/context/search-db.mjs works searches book metadata in the remote DB to help decide where to search next.",
    "- node /workspace/context/search-db.mjs neighbors fetches nearby chunks from the remote DB for context around a match.",
    "- Example commands:",
    "  node /workspace/context/search-db.mjs rg -i 'anger|furious|wrath' -C 1",
    "  node /workspace/context/search-db.mjs rg -i 'reconcile|reunite|return again' --json | jq '.hits[:20]'",
    "  node /workspace/context/search-db.mjs rg -i 'anger|rage' | sed -n '1,40p'",
    "  node /workspace/context/search-db.mjs rg -U --window 2 'love.*again' --kind clean_text --json | jq '.hits[:10]'",
    "  node /workspace/context/search-db.mjs rg -i 'wrath|anger' --glob 'gutenberg/clean/**/clean.txt' --json | jq '.hits[:10]'",
    "  node /workspace/context/search-db.mjs works --query 'break up reconcile lovers'",
    "  node /workspace/context/search-db.mjs neighbors --chunk-id <chunkId> --radius 2",
    "- Always copy chunk IDs exactly as returned by the CLI, including hyphens.",
    "- Use repeated regex, keyword, metadata, and neighbor queries until you have enough direct quoted evidence to answer the question or until you exhaust the command budget.",
    openBookMode
      ? "- You do not need to hydrate more books for this task unless the question explicitly asks for a comparison."
      : "- Hydrate local book files only after the corpus-wide search identifies a small final set of candidates and you need local verification or extra context.",
    "- Use shell tools like rg, sed, jq, and python3 to inspect local files and Postgres-backed search results.",
    "- To pull files into the workspace, run node /workspace/context/hydrate-files.mjs with one or more of these forms:",
    "  node /workspace/context/hydrate-files.mjs --work <workId> --kind chunks",
    "  node /workspace/context/hydrate-files.mjs --work <workId> --kind clean",
    "- Use the schema, books, and metadata to decide what to hydrate only after the corpus-wide search narrows the scope.",
    "- Do not browse the internet.",
    "- Expand across more books until the candidate search space is exhausted or clearly irrelevant.",
    "- Create a focused local corpus in /workspace/scratch/research-corpus by copying or excerpting only the most relevant passages or files.",
    "- Your required deliverable is one file: /workspace/output/briefing.md",
    "- The briefing should mix primary-source quotes with short explanations.",
    "- Every quote should include a nearby source reference using the work title and chunk/source identifier when available.",
    "- Prefer primary-source quotations and preserve source identifiers.",
    "- Once you have 2 to 8 strong quotations, stop searching and write the briefing.",
    "- If the evidence is thin, still write /workspace/output/briefing.md and say that clearly.",
    "- You may optionally write helper notes under /workspace/output, but only /workspace/output/briefing.md is required.",
    "- Do not stop after searching. A run is incomplete until /workspace/output/briefing.md exists with real content.",
    "",
    `Research objective: ${researchObjective}`,
    "",
    "Task spec:",
    JSON.stringify(compactTask, null, 2),
    "",
    "Workspace manifest summary:",
    JSON.stringify(manifestSummary, null, 2),
    "",
    "Seed evidence from the orchestrator:",
    JSON.stringify(evidence, null, 2),
    "",
    "When finished, return one short plain-text sentence confirming that the briefing has been written.",
  ].join("\n");
}

function normalizePhase(task) {
  return typeof task.phase === "string" ? task.phase : "collect_and_brief";
}

function emitStreamLines(bufferRef, chunk, onLine) {
  if (!onLine) {
    return;
  }
  bufferRef.value += Buffer.from(chunk).toString("utf8");
  while (true) {
    const newlineIndex = bufferRef.value.indexOf("\n");
    if (newlineIndex < 0) {
      break;
    }
    const line = bufferRef.value.slice(0, newlineIndex).trim();
    bufferRef.value = bufferRef.value.slice(newlineIndex + 1);
    if (line) {
      onLine(line);
    }
  }
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
    const stdoutBuffer = { value: "" };
    const stderrBuffer = { value: "" };
    let forcedExitCode = null;
    let killedForAuthFailure = false;

    const killForFatalAuthFailure = () => {
      if (killedForAuthFailure) {
        return;
      }
      killedForAuthFailure = true;
      forcedExitCode = 88;
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
      }, 2_000).unref();
    };

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
      emitStreamLines(stdoutBuffer, chunk, options.onStdoutLine);
    });
    child.stderr.on("data", (chunk) => {
      const text = Buffer.from(chunk).toString("utf8");
      stderrChunks.push(Buffer.from(chunk));
      emitStreamLines(stderrBuffer, chunk, options.onStderrLine);
      if (
        /refresh_token_reused/i.test(text)
        || /Your refresh token has already been used to generate a new access token/i.test(text)
      ) {
        killForFatalAuthFailure();
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: forcedExitCode ?? code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    child.stdin.end(options.input ?? "");
  });
}

function nowIso() {
  return new Date().toISOString();
}

function compactText(text, maxLength = 320) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function codexStepLabel(step) {
  if (step === "codex-briefing") {
    return "Codex corpus briefing";
  }
  return "Codex step";
}

async function appendProgressEvent(outputDir, event) {
  await appendFile(
    join(outputDir, "codex-progress.jsonl"),
    `${JSON.stringify({
      timestamp: nowIso(),
      ...event,
    })}\n`,
    "utf8",
  );
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
}) {
  const codexCommand = await resolveCodexCommand(workspaceRoot);
  const promptPath = join(outputDir, `${step}.prompt.md`);
  const outputPath = join(outputDir, `${step}.last-message.txt`);
  const logPath = join(outputDir, `${step}.log.txt`);

  await writeFile(promptPath, promptText, "utf8");
  await appendProgressEvent(outputDir, {
    type: "codex.step.prepared",
    step,
    promptPath,
    promptPreview: compactText(promptText, 700),
    message: `${codexStepLabel(step)} is ready to run.`,
  });

  const attemptLogs = [];
  let result = null;
  let exitCode = 1;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await appendProgressEvent(outputDir, {
      type: "codex.step.attempt",
      step,
      attempt,
      model,
      baseUrl: process.env.OPENAI_BASE_URL ?? null,
      message: attempt === 1
        ? `Sending ${codexStepLabel(step).toLowerCase()} to Codex.`
        : `Retrying ${codexStepLabel(step).toLowerCase()} with Codex.`,
    });
    result = await runProcess(
      codexCommand,
      [
        "exec",
        "--skip-git-repo-check",
        "-C",
        workspaceRoot,
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        model,
        "--output-last-message",
        outputPath,
        "-",
      ],
      {
        cwd: workspaceRoot,
        env: process.env,
        input: promptText,
        onStdoutLine: (line) => {
          void appendProgressEvent(outputDir, {
            type: "codex.stdout",
            step,
            line: compactText(line, 400),
            message: compactText(line, 400),
          });
        },
        onStderrLine: (line) => {
          void appendProgressEvent(outputDir, {
            type: "codex.stderr",
            step,
            line: compactText(line, 400),
            message: compactText(line, 400),
          });
        },
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
      await appendProgressEvent(outputDir, {
        type: "codex.step.completed",
        step,
        attempt,
        logPath,
        outputPath,
        message: `${codexStepLabel(step)} completed.`,
      });
      break;
    }

    await appendProgressEvent(outputDir, {
      type: "codex.step.attempt_failed",
      step,
      attempt,
      exitCode: result.exitCode,
      logPath,
      stderrPreview: compactText(result.stderr, 400),
      stdoutPreview: compactText(result.stdout, 400),
      message: `${codexStepLabel(step)} failed on attempt ${attempt}.`,
    });

    if (
      /refresh_token_reused/i.test(result.stderr)
      || /Your refresh token has already been used to generate a new access token/i.test(result.stderr)
    ) {
      await appendProgressEvent(outputDir, {
        type: "codex.auth_failed",
        step,
        attempt,
        exitCode: result.exitCode,
        message: "Codex authentication failed because the refresh token was already reused.",
      });
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
    await appendProgressEvent(outputDir, {
      type: "codex.step.failed",
      step,
      exitCode,
      logPath,
      message: `${codexStepLabel(step)} failed.`,
    });
    throw new Error(`Codex step ${step} failed with exit code ${exitCode}.`);
  }

  const lastMessage = await readFile(outputPath, "utf8").catch(() => "");

  return {
    step,
    promptPath,
    outputPath,
    logPath,
    exitCode: result.exitCode,
    lastMessage,
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
  await writeFile(join(outputDir, "codex-progress.jsonl"), "", "utf8");

  const [manifest, task, selectedChunks] = await Promise.all([
    parseJson(manifestPath),
    parseJson(taskPath),
    readJsonIfPresent(selectedChunksPath, []),
  ]);

  const question = String(task.researchObjective || task.question || task.goal || task.prompt || task.task || "Analyze the workspace corpus.");
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
  if (chunkFiles.length === 0) {
    await appendProgressEvent(outputDir, {
      type: "workspace.local_chunks.missing",
      message: "No local chunk files are hydrated yet; starting from seed evidence and remote corpus search.",
    });
  }
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
  const seedChunks = gatherSeedChunks(task, selectedChunks, workById);
  const evidence = buildSearchEvidence(question, seedChunks.slice(0, 12), topRuntimeHits, workById);

  await writeFile(
    join(outputDir, "search-plan.json"),
    JSON.stringify(
      {
        question,
        seedTokens: tokens,
        semanticTokens: expansions.tokens,
        semanticFamilies: expansions.families.map((family) => family.id),
        phraseBoosts: searchPhrases,
        candidateWorkIds: Array.from(new Set([
          ...topRuntimeHits.map((chunk) => String(chunk.work_id || "")),
          ...(Array.isArray(task.candidateWorkIds) ? task.candidateWorkIds.map((value) => String(value || "")) : []),
        ])).filter(Boolean),
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
  const viewedChunksReference = buildViewedChunksArtifact(seedChunks, iterations, evidence, topRuntimeHits, workById);
  await writeFile(join(outputDir, "viewed-chunks.json"), JSON.stringify(viewedChunksReference, null, 2), "utf8");
  await writeFile(join(outputDir, "every-single-reference.md"), buildViewedChunksMarkdown(viewedChunksReference), "utf8");

  const phase = normalizePhase(task);
  const codexRuns = [];
  let briefing = "";

  if (phase === "collect_evidence" || phase === "write_briefing" || phase === "collect_and_brief") {
    const briefingRun = await runCodexStep({
      workspaceRoot,
      outputDir,
      model,
      step: "codex-briefing",
      promptText: buildBriefingPrompt(runtimePrompt, manifest, task, evidence, question),
    });
    codexRuns.push(briefingRun);
    const briefingPath = join(outputDir, "briefing.md");
    const notesPath = join(outputDir, "evidence-notes.md");
    if (!(await fileExists(briefingPath))) {
      throw new Error("Codex did not write /workspace/output/briefing.md.");
    }
    briefing = await readFile(briefingPath, "utf8");
    if (!briefing.trim()) {
      throw new Error("Codex wrote an empty /workspace/output/briefing.md.");
    }
    if (!(await fileExists(notesPath))) {
      await writeFile(
        notesPath,
        [
          "# Search Notes",
          "",
          "This run did not write separate notes, so the final briefing is the primary artifact.",
          "",
          `Codex completion: ${briefingRun.lastMessage.trim() || "completed"}`,
        ].join("\n"),
        "utf8",
      );
    }
  }

  const previousCodexRuns = await readJsonIfPresent(join(outputDir, "codex-runs.json"), []);
  const nextCodexRuns = Array.isArray(previousCodexRuns) ? [...previousCodexRuns, ...codexRuns] : codexRuns;
  await writeFile(join(outputDir, "codex-runs.json"), JSON.stringify(nextCodexRuns, null, 2), "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
