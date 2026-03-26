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
  const chunkWorkTitle =
    typeof chunk.workTitle === "string" && chunk.workTitle.trim()
      ? chunk.workTitle.trim()
      : typeof chunk.title === "string" && chunk.title.trim()
        ? chunk.title.trim()
        : null;
  const chunkAuthors = Array.isArray(chunk.authors) ? chunk.authors : [];
  return {
    chunkId: String(chunk.id || chunk.chunkId || ""),
    workId,
    workTitle: typeof work?.title === "string" ? work.title : chunkWorkTitle,
    authors: Array.isArray(work?.authors) && work.authors.length > 0 ? work.authors : chunkAuthors,
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

async function listCleanTextFiles(booksRoot) {
  const entries = await readdir(booksRoot, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(booksRoot, entry.name, "clean.txt");
    if (await fileExists(candidate)) {
      files.push({
        workId: entry.name,
        path: candidate,
      });
    }
  }
  return files;
}

function sliceLocalCleanExcerpt(text, tokenMatches = []) {
  const normalized = String(text || "").replace(/\r\n/gu, "\n");
  const needle = tokenMatches.find((token) => typeof token === "string" && token.length > 0);
  const start = needle
    ? Math.max(0, normalized.toLowerCase().indexOf(needle.toLowerCase()) - 220)
    : 0;
  const excerpt = normalized.slice(start, start + 720).trim();
  return normalizeWhitespace(excerpt);
}

async function searchLocalCleanTexts(booksRoot, question, tokens, phrases, families, workById) {
  const cleanFiles = await listCleanTextFiles(booksRoot);
  const hits = [];

  for (const file of cleanFiles) {
    const content = await readFile(file.path, "utf8").catch(() => "");
    if (!content.trim()) {
      continue;
    }
    const paragraphs = content
      .split(/\n\s*\n/gu)
      .map((paragraph) => normalizeWhitespace(paragraph))
      .filter(Boolean);
    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index];
      const haystack = paragraph.toLowerCase();
      let score = scoreText(paragraph, tokens, phrases);
      const matchedConcepts = [];
      const matchedPatterns = [];
      for (const family of families) {
        const familySignals = scoreFamilySignals(haystack, family);
        score += familySignals.score;
        matchedConcepts.push(...familySignals.matchedConcepts);
        matchedPatterns.push(...familySignals.matchedPatterns);
      }
      score += workScoreAdjustment(question, workById.get(file.workId), families);
      if (score <= 0) {
        continue;
      }
      hits.push({
        id: `local-clean:${file.workId}:${index + 1}`,
        work_id: file.workId,
        workId: file.workId,
        chunk_index: index + 1,
        chunkIndex: index + 1,
        text: sliceLocalCleanExcerpt(paragraph, tokens),
        excerpt: sliceLocalCleanExcerpt(paragraph, tokens),
        r2Key: `books/${file.workId}/clean.txt`,
        matched_concepts: Array.from(new Set(matchedConcepts)),
        matched_patterns: Array.from(new Set(matchedPatterns)),
        score,
      });
    }
  }

  hits.sort((left, right) => right.score - left.score || left.work_id.localeCompare(right.work_id) || left.chunk_index - right.chunk_index);
  return {
    name: "local-clean-search",
    tokens,
    phrases,
    hits: hits.slice(0, 48),
  };
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
  const normalizedSelectedChunks = selectedChunks.slice(0, 8).map((chunk) => ({
      id: String(chunk.id || ""),
      workId: String(chunk.work_id || chunk.workId || ""),
      title: String(workById.get(String(chunk.work_id || chunk.workId || ""))?.title || ""),
      chunkIndex: Number(chunk.chunk_index || chunk.chunkIndex || 0),
      excerpt: normalizeWhitespace(String(chunk.excerpt || chunk.text || "")).slice(0, 500),
      r2Key: chunk.r2Key ?? chunk.r2_key ?? null,
    }));
  const normalizedRuntimeHits = runtimeChunks.slice(0, 10).map((chunk) => ({
      id: String(chunk.id || ""),
      workId: String(chunk.work_id || chunk.workId || ""),
      title: String(workById.get(String(chunk.work_id || chunk.workId || ""))?.title || ""),
      chunkIndex: Number(chunk.chunk_index || chunk.chunkIndex || 0),
      excerpt: normalizeWhitespace(String(chunk.text || "")).slice(0, 500),
      score: Number(chunk.score || 0),
      matchedIterations: Array.isArray(chunk.matched_iterations) ? chunk.matched_iterations : [],
      matchedConcepts: Array.isArray(chunk.matched_concepts) ? chunk.matched_concepts : [],
      r2Key: chunk.r2Key ?? chunk.r2_key ?? null,
    }));
  return {
    question,
    selectedChunks: normalizedSelectedChunks,
    runtimeHits: normalizedRuntimeHits,
    items: [...normalizedSelectedChunks, ...normalizedRuntimeHits],
    candidateWorkIds: Array.isArray(runtimeChunks)
      ? Array.from(new Set(runtimeChunks.slice(0, 12).map((chunk) => String(chunk.work_id || chunk.workId || "")))).filter(Boolean)
      : [],
  };
}

function buildInitialEvidenceNotes(question, evidence) {
  void question;
  const lines = [];

  if (Array.isArray(evidence.selectedChunks) && evidence.selectedChunks.length > 0) {
    for (const chunk of evidence.selectedChunks.slice(0, 6)) {
      const title = normalizeWhitespace(String(chunk.title || chunk.workId || "Source"));
      const excerpt = normalizeWhitespace(String(chunk.excerpt || "")).slice(0, 420);
      if (!excerpt) {
        continue;
      }
      lines.push(`### ${title}`);
      lines.push("");
      lines.push(`> ${excerpt}`);
      lines.push("");
    }
  }

  if (Array.isArray(evidence.runtimeHits) && evidence.runtimeHits.length > 0) {
    for (const chunk of evidence.runtimeHits.slice(0, 8)) {
      const title = normalizeWhitespace(String(chunk.title || chunk.workId || "Source"));
      const excerpt = normalizeWhitespace(String(chunk.excerpt || "")).slice(0, 420);
      if (!excerpt) {
        continue;
      }
      lines.push(`### ${title}`);
      lines.push("");
      lines.push(`> ${excerpt}`);
      lines.push("");
      if (Array.isArray(chunk.matchedConcepts) && chunk.matchedConcepts.length > 0) {
        lines.push(`Matched concepts: ${chunk.matchedConcepts.join(", ")}`);
        lines.push("");
      }
    }
  }

  return `${lines.join("\n").trim()}\n`;
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
    taskIntent: typeof normalized.taskIntent === "string" ? normalized.taskIntent : null,
    prompt: typeof normalized.prompt === "string" ? normalizeWhitespace(normalized.prompt).slice(0, 220) : null,
    question: typeof normalized.question === "string" ? normalizeWhitespace(normalized.question).slice(0, 220) : null,
    runtimeId: typeof normalized.runtimeId === "string" ? normalized.runtimeId : null,
    corpusWorkCount: typeof normalized.corpusWorkCount === "number" ? normalized.corpusWorkCount : null,
    hydratedWorkCount: typeof normalized.hydratedWorkCount === "number" ? normalized.hydratedWorkCount : null,
    candidateWorkIds: sampleStrings(normalized.candidateWorkIds, 8),
    frontierWorkIds: sampleStrings(normalized.frontierWorkIds, 8),
    verifiedWorkIds: sampleStrings(normalized.verifiedWorkIds, 8),
    selectedChunkIds: sampleStrings(normalized.selectedChunkIds, 8),
    topChunkIds: Array.isArray(normalized.topChunks)
      ? normalized.topChunks
        .slice(0, 6)
        .map((chunk) => (chunk && typeof chunk === "object" && typeof chunk.chunkId === "string" ? chunk.chunkId : null))
        .filter(Boolean)
      : [],
    followUpContext: normalized.followUpContext && typeof normalized.followUpContext === "object"
      ? {
          priorUserMessages: sampleStrings(normalized.followUpContext.priorUserMessages, 3),
          priorAssistantSummary: typeof normalized.followUpContext.priorAssistantSummary === "string"
            ? normalizeWhitespace(normalized.followUpContext.priorAssistantSummary).slice(0, 220)
            : null,
        }
      : null,
  };
}

function compactTaskSpec(task, openBookMode) {
  const retrieval = task && typeof task.retrieval === "object" ? task.retrieval : null;
  const broadCorpusMode = !openBookMode && typeof task?.mode === "string" && task.mode === "exhaustive_corpus_search";
  const workLimit = broadCorpusMode ? 24 : 12;
  const chunkLimit = broadCorpusMode ? 32 : 16;
  return {
    runtimeId: typeof task.runtimeId === "string" ? task.runtimeId : null,
    taskType: typeof task.taskType === "string" ? task.taskType : null,
    taskIntent: typeof task.taskIntent === "string" ? task.taskIntent : null,
    mode: typeof task.mode === "string" ? task.mode : null,
    intensity: typeof task.intensity === "string" ? task.intensity : null,
    timeBudgetMinutes: typeof task.timeBudgetMinutes === "number" ? task.timeBudgetMinutes : null,
    parallelism: typeof task.parallelism === "number" ? task.parallelism : null,
    shardAxis: typeof task.shardAxis === "string" ? task.shardAxis : null,
    shardPlan: Array.isArray(task.shardPlan)
      ? task.shardPlan.slice(0, 16).map((shard) => ({
          shardId: typeof shard?.shardId === "string" ? shard.shardId : null,
          axis: typeof shard?.axis === "string" ? shard.axis : null,
          label: typeof shard?.label === "string" ? normalizeWhitespace(shard.label).slice(0, 120) : null,
          targetWorkCount: typeof shard?.targetWorkCount === "number" ? shard.targetWorkCount : null,
          strategy: typeof shard?.strategy === "string" ? shard.strategy : null,
        }))
      : [],
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
    workIds: sampleStrings(task.workIds, workLimit),
    chunkIds: sampleStrings(task.chunkIds, chunkLimit),
    candidateWorkIds: sampleStrings(task.candidateWorkIds, workLimit),
    frontierWorkIds: sampleStrings(task.frontierWorkIds, workLimit),
    verifiedWorkIds: sampleStrings(task.verifiedWorkIds, workLimit),
    followUpContext: task.followUpContext && typeof task.followUpContext === "object"
      ? {
          priorUserMessages: sampleStrings(task.followUpContext.priorUserMessages, 3),
          priorAssistantSummary: typeof task.followUpContext.priorAssistantSummary === "string"
            ? normalizeWhitespace(task.followUpContext.priorAssistantSummary).slice(0, 220)
            : null,
        }
      : null,
    searchHints: task.searchHints && typeof task.searchHints === "object"
      ? {
          passageSearchFocus: typeof task.searchHints.passageSearchFocus === "string"
            ? normalizeWhitespace(task.searchHints.passageSearchFocus).slice(0, 220)
            : null,
          supportingEvidenceFocus: typeof task.searchHints.supportingEvidenceFocus === "string"
            ? normalizeWhitespace(task.searchHints.supportingEvidenceFocus).slice(0, 220)
            : null,
          opposingEvidenceFocus: typeof task.searchHints.opposingEvidenceFocus === "string"
            ? normalizeWhitespace(task.searchHints.opposingEvidenceFocus).slice(0, 220)
            : null,
          verificationFocus: typeof task.searchHints.verificationFocus === "string"
            ? normalizeWhitespace(task.searchHints.verificationFocus).slice(0, 220)
            : null,
          priorAnswerFocus: typeof task.searchHints.priorAnswerFocus === "string"
            ? normalizeWhitespace(task.searchHints.priorAnswerFocus).slice(0, 220)
            : null,
          synthesisMode: typeof task.searchHints.synthesisMode === "string"
            ? task.searchHints.synthesisMode
            : null,
        }
      : null,
    retrieval: retrieval
      ? {
          frontierWorks: Array.isArray(retrieval.frontierWorks)
            ? retrieval.frontierWorks.slice(0, workLimit).map((work) => ({
                id: typeof work?.id === "string" ? work.id : null,
                title: typeof work?.title === "string" ? work.title : null,
                authors: Array.isArray(work?.authors) ? work.authors.slice(0, 3) : [],
                summary: typeof work?.summary === "string" ? normalizeWhitespace(work.summary).slice(0, 220) : null,
              }))
            : [],
          searchWorks: Array.isArray(retrieval.searchWorks)
            ? retrieval.searchWorks.slice(0, workLimit).map((work) => ({
                id: typeof work?.id === "string" ? work.id : null,
                title: typeof work?.title === "string" ? work.title : null,
                authors: Array.isArray(work?.authors) ? work.authors.slice(0, 3) : [],
                summary: typeof work?.summary === "string" ? normalizeWhitespace(work.summary).slice(0, 220) : null,
              }))
            : [],
          metadataWorks: Array.isArray(retrieval.metadataWorks)
            ? retrieval.metadataWorks.slice(0, workLimit).map((work) => ({
                id: typeof work?.id === "string" ? work.id : null,
                title: typeof work?.title === "string" ? work.title : null,
                authors: Array.isArray(work?.authors) ? work.authors.slice(0, 3) : [],
                summary: typeof work?.summary === "string" ? normalizeWhitespace(work.summary).slice(0, 220) : null,
              }))
            : [],
          seedChunks: Array.isArray(retrieval.seedChunks)
            ? retrieval.seedChunks.slice(0, chunkLimit).map((chunk) => ({
                id: typeof chunk?.id === "string" ? chunk.id : null,
                workId: typeof chunk?.workId === "string" ? chunk.workId : null,
                title: typeof chunk?.title === "string" ? chunk.title : null,
                chunkIndex: typeof chunk?.chunkIndex === "number" ? chunk.chunkIndex : null,
                excerpt: typeof chunk?.excerpt === "string" ? normalizeWhitespace(chunk.excerpt).slice(0, 180) : null,
              }))
            : [],
          verifiedChunks: Array.isArray(retrieval.verifiedChunks)
            ? retrieval.verifiedChunks.slice(0, chunkLimit).map((chunk) => ({
                id: typeof chunk?.id === "string" ? chunk.id : null,
                workId: typeof chunk?.workId === "string" ? chunk.workId : null,
                title: typeof chunk?.title === "string" ? chunk.title : null,
                chunkIndex: typeof chunk?.chunkIndex === "number" ? chunk.chunkIndex : null,
                excerpt: typeof chunk?.excerpt === "string" ? normalizeWhitespace(chunk.excerpt).slice(0, 180) : null,
              }))
            : [],
        }
      : null,
    searchPlan: task.searchPlan && typeof task.searchPlan === "object"
      ? {
          recommendedIntensity: typeof task.searchPlan.recommendedIntensity === "string" ? task.searchPlan.recommendedIntensity : null,
          recommendedWallClockMinutes: typeof task.searchPlan.recommendedWallClockMinutes === "number" ? task.searchPlan.recommendedWallClockMinutes : null,
          recommendedParallelism: typeof task.searchPlan.recommendedParallelism === "number" ? task.searchPlan.recommendedParallelism : null,
          recommendedShardAxis: typeof task.searchPlan.recommendedShardAxis === "string" ? task.searchPlan.recommendedShardAxis : null,
          recommendedFrontierWorks: typeof task.searchPlan.recommendedFrontierWorks === "number" ? task.searchPlan.recommendedFrontierWorks : null,
          recommendedShards: Array.isArray(task.searchPlan.recommendedShards)
            ? task.searchPlan.recommendedShards.slice(0, 16).map((shard) => ({
                shardId: typeof shard?.shardId === "string" ? shard.shardId : null,
                axis: typeof shard?.axis === "string" ? shard.axis : null,
                label: typeof shard?.label === "string" ? normalizeWhitespace(shard.label).slice(0, 120) : null,
              }))
            : [],
          breadthBand: typeof task.searchPlan.breadthBand === "string" ? task.searchPlan.breadthBand : null,
          metadataWorkEstimate: typeof task.searchPlan.metadataWorkEstimate === "number" ? task.searchPlan.metadataWorkEstimate : null,
          chunkMatchEstimate: typeof task.searchPlan.chunkMatchEstimate === "number" ? task.searchPlan.chunkMatchEstimate : null,
          chunkWorkEstimate: typeof task.searchPlan.chunkWorkEstimate === "number" ? task.searchPlan.chunkWorkEstimate : null,
        }
      : null,
    taskContext: compactTaskContext(task.taskContext),
  };
}

function isBroadCorpusTask(task, openBookMode) {
  if (openBookMode) {
    return false;
  }
  if (typeof task?.mode === "string" && task.mode === "exhaustive_corpus_search") {
    return true;
  }
  const query = String(task?.researchObjective || task?.question || task?.goal || "");
  return /\b(all|every|compare|comparison|trace|theme|pattern|survey|synthesize|search|find|why|how|where|when|corpus|across)\b/i.test(query);
}

function buildBriefingPrompt(runtimePrompt, manifest, task, evidence, question) {
  const taskContext = manifest.taskContext && typeof manifest.taskContext === "object"
    ? manifest.taskContext
    : {};
  const openBookMode = taskContext.mode === "open_book_analysis";
  const spriteShardMode = typeof task?.mode === "string" && task.mode === "sprite_shard_search";
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
  const taskIntent = compactTask.taskIntent || compactTask.taskContext?.taskIntent || "broad_evidence_survey";
  const searchHints = compactTask.searchHints || null;
  const seededCandidateCount = Array.isArray(compactTask.frontierWorkIds) && compactTask.frontierWorkIds.length > 0
    ? compactTask.frontierWorkIds.length
    : Array.isArray(compactTask.candidateWorkIds) ? compactTask.candidateWorkIds.length : 0;
  const seededChunkCount = Array.isArray(compactTask.chunkIds) ? compactTask.chunkIds.length : 0;
  const broadCorpusTask = isBroadCorpusTask(task, openBookMode);
  const intensity = compactTask.intensity || (broadCorpusTask ? "high" : "normal");
  const commandBudget = openBookMode
    ? 5
    : intensity === "maximum"
      ? 48
      : intensity === "high"
        ? 28
        : 14;
  if (spriteShardMode) {
    const shard = task?.shard && typeof task.shard === "object" ? task.shard : {};
    const shardLabel = typeof shard.label === "string"
      ? shard.label
      : typeof shard.shardId === "string"
        ? shard.shardId
        : "this shard";
    const shardBookCount = typeof shard.bookCount === "number"
      ? shard.bookCount
      : Array.isArray(manifest.works) ? manifest.works.length : 0;
    return [
      runtimePrompt,
      "",
      "You are running one AlphaBook Sprite shard search.",
      `Goal: answer the research objective using only the books hydrated into ${shardLabel}.`,
      "Constraints:",
      "- Only use local files under /workspace.",
      "- This VM is responsible for one fixed shard of the corpus. Do not widen outside this shard.",
      "- Do not use the remote Postgres corpus CLI for discovery. Search the hydrated local shard directly.",
      "- Use shell tools like rg, jq, python3, sed, awk, grep, and cat over /workspace/books.",
      `- This shard currently contains about ${shardBookCount} hydrated books.`,
      `- Keep the search bounded but thorough: use at most ${commandBudget} shell commands total.`,
      "- Search repeatedly across the local shard until you have the strongest quotations and representative books for this shard.",
      "- Favor explicit grief-, mourning-, bereavement-, lament-, consolation-, funeral-, and loss-related evidence over generic sadness or death references.",
      "- Pull surrounding paragraphs from the local clean text files when you need context.",
      "- Create a focused local evidence set in /workspace/scratch/research-corpus if it helps you compare books.",
      "- Your required deliverable is one file: /workspace/output/briefing.md",
      "- The briefing should summarize what this shard contributes to the overall answer, with direct quotations and source identifiers.",
      "- Every quote should preserve the work title and chunk/source identifier when available.",
      "- If this shard has thin evidence, say that clearly in the briefing instead of forcing a conclusion.",
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
      "When finished, return one short plain-text sentence confirming that the shard briefing has been written.",
    ].filter(Boolean).join("\n");
  }
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
    "- If the task spec already includes candidate books or seed chunks, start there before you widen the search.",
    (!openBookMode && (seededCandidateCount >= 3 || seededChunkCount >= 4))
      ? `- This run already starts with ${seededCandidateCount} candidate books and ${seededChunkCount} seed passages. Review those first, draft the strongest categories from them, and widen only if major coping strategies or book variety are still missing.`
      : null,
    (!openBookMode && seededCandidateCount >= 3)
      ? "- Do not roam outside the supplied candidate/frontier books unless those books are exhausted and a new book is directly justified by a relevant passage hit."
      : null,
    (!openBookMode && seededCandidateCount >= 3)
      ? "- Reject incidental fuzzy matches. A title touching death, sadness, war, or generic suffering is not enough by itself; stay with books that have explicit grief, mourning, consolation, bereavement, lament, tears, funeral, or loss evidence."
      : null,
    openBookMode
      ? "- Stay inside the current hydrated book unless the local evidence is clearly insufficient."
      : "- Start from the best available seed evidence, but widen across the full corpus whenever the prompt asks for a broad theme, comparison, or survey.",
    openBookMode
      ? "- Use at most 5 shell commands total before you return your answer."
      : `- Keep the search bounded but wide: use at most ${commandBudget} shell commands total before you return your answer.`,
    !openBookMode && compactTask.timeBudgetMinutes
      ? `- This run has a target wall-clock budget of about ${compactTask.timeBudgetMinutes} minutes at ${intensity} intensity.`
      : null,
    !openBookMode && compactTask.parallelism
      ? `- Plan your sweep as one shard of a larger search plan that expects about ${compactTask.parallelism} parallel shard(s) over ${compactTask.shardAxis || "work_id_hash"}.`
      : null,
    !openBookMode && Array.isArray(compactTask.shardPlan) && compactTask.shardPlan.length > 0
      ? `- The orchestrator's shard plan is: ${compactTask.shardPlan.map((shard) => shard.label || shard.shardId || "unnamed shard").join("; ")}.`
      : null,
    !openBookMode && compactTask.searchPlan?.recommendedFrontierWorks
      ? `- The orchestrator wants a frontier of about ${compactTask.searchPlan.recommendedFrontierWorks} active books before final verification narrows it.`
      : null,
    !openBookMode
      ? `- This run's task intent is ${taskIntent.replaceAll("_", " ")}.`
      : null,
    !openBookMode && taskIntent === "hypothesis_test"
      ? "- Separate supporting evidence from opposing or complicating evidence as you search, then finish with a clear verdict grounded in both."
      : null,
    !openBookMode && taskIntent === "counterexample_search"
      ? "- Prioritize counterexamples, exceptions, and disconfirming passages over generic supporting evidence."
      : null,
    !openBookMode && taskIntent === "follow_up_refinement"
      ? "- Treat this as a follow-up to earlier work: reuse the strongest prior evidence first, then fill the most obvious gaps."
      : null,
    !openBookMode && taskIntent === "verification"
      ? "- Focus on checking whether the earlier conclusion is actually supported by direct quotations."
      : null,
    !openBookMode && searchHints?.supportingEvidenceFocus
      ? `- Supporting-evidence focus: ${searchHints.supportingEvidenceFocus}.`
      : null,
    !openBookMode && searchHints?.opposingEvidenceFocus
      ? `- Opposing-evidence focus: ${searchHints.opposingEvidenceFocus}.`
      : null,
    !openBookMode && searchHints?.verificationFocus
      ? `- Verification target: ${searchHints.verificationFocus}.`
      : null,
    !openBookMode && (compactTask.followUpContext?.priorAssistantSummary || compactTask.taskContext?.followUpContext?.priorAssistantSummary)
      ? `- Prior answer summary to refine: ${compactTask.followUpContext?.priorAssistantSummary || compactTask.taskContext.followUpContext.priorAssistantSummary}.`
      : null,
    "- Prefer finishing with a good briefing over exhaustively exploring every possible lead.",
    "- Search the local clean text and local chunks first with rg, sed, jq, and python3. Do not assume any remote database search surface exists.",
    "- If a broad regex query times out or returns too much noise, narrow with the manifest, selected chunks, and hydrated file set before repeating it.",
    "- Preserve any year, language, or fiction constraints from the question when you query works metadata or widen into passage search.",
    "- Guaranteed tools in this runtime image: node, python/python3, jq, rg, sed, awk, grep, cat, mkdir.",
    "- Example commands:",
    "  rg -n -i 'anger|furious|wrath' /workspace/books /workspace/chunks",
    "  rg -n -i 'reconcile|reunite|return again' /workspace/books /workspace/chunks | sed -n '1,40p'",
    "  jq '.selectedChunkIds[:20]' /workspace/context/manifest.json",
    "  jq '.documents[:10] | map({id: (.documentId // .workId), title})' /workspace/context/manifest.json",
    "- Keep chunk IDs and work IDs exactly as they appear in the manifest or selected chunk files.",
    "- Use repeated regex, keyword, metadata, and nearby-passage inspection over the hydrated local files until you have enough direct quoted evidence to answer the question or until you exhaust the command budget.",
    openBookMode
      ? "- You do not need to hydrate more books for this task unless the question explicitly asks for a comparison."
      : "- Hydrate local book files only after the available manifest and selected chunks identify a promising final set of candidates and you need local verification or extra context.",
    "- Use shell tools like rg, sed, jq, and python3 to inspect local files, the manifest, and saved chunk bundles.",
    "- To pull files into the workspace, run node /workspace/context/hydrate-files.mjs with one or more of these forms:",
    "  node /workspace/context/hydrate-files.mjs --work <workId> --kind chunks",
    "  node /workspace/context/hydrate-files.mjs --work <workId> --kind clean",
    "- Use the schema, books, and metadata to decide what to hydrate only after the local evidence narrows the scope.",
    "- Do not browse the internet.",
    "- Expand across more books until the candidate search space is exhausted or clearly irrelevant.",
    broadCorpusTask
      ? "- For broad corpus questions, do not stop after the first few promising books. Sweep widely first, keep a larger active set, then narrow only after repeated search passes converge."
      : null,
    broadCorpusTask
      ? "- Aim to touch dozens of books when the corpus evidence supports it, and prefer at least 6 distinct books in the final evidence set before you stop widening."
      : null,
    broadCorpusTask
      ? "- After broad search surfaces many hits, cluster by work, keep the best 12 to 24 works active, and fetch neighbors or hydrated local text for the strongest subset before writing."
      : null,
    "- Create a focused local corpus in /workspace/scratch/research-corpus by copying or excerpting only the most relevant passages or files.",
    "- Your required deliverable is one file: /workspace/output/briefing.md",
    "- The briefing should mix primary-source quotes with short explanations.",
    "- Every quote should include a nearby source reference using the work title and chunk/source identifier when available.",
    "- Prefer primary-source quotations and preserve source identifiers.",
    (!openBookMode && seededChunkCount >= 4)
      ? broadCorpusTask
        ? "- If the seed passages already give you strong quotations but only from a narrow slice of books, keep widening until the broader search stops adding new categories or clearly relevant works."
        : "- If the seed passages already give you 2 to 8 strong quotations across multiple books, stop widening and write the briefing from that grounded evidence."
      : null,
    broadCorpusTask
      ? "- Once you have roughly 8 to 16 strong quotations across several books and additional wide searches are no longer adding new categories, stop searching and write the briefing."
      : "- Once you have 2 to 8 strong quotations, stop searching and write the briefing.",
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
  ].filter(Boolean).join("\n");
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

function isCodexScaffoldingLine(line) {
  const trimmed = compactText(line, 800);
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith("ALPHABOOK_PROGRESS ")) {
    return false;
  }
  if (
    /^(OpenAI Codex v|workdir:|model:|provider:|approval:|sandbox:|reasoning effort:|reasoning summaries:|session id:|user|--------)$/i.test(trimmed)
    || /^(You are |You operate |Your goal is |Goal:|Constraints:|Research objective:|Task spec:|Workspace manifest summary:|Seed evidence from the orchestrator:|When finished,|Only use local files under |Start from |If the task spec already includes |Keep the search bounded:|Guaranteed tools in this runtime image:|Keep chunk IDs and work IDs exactly |Use repeated regex, keyword, metadata|Hydrate local book files only |Use shell tools like |To pull files into the workspace|Expand across more books |Create a focused local corpus |Your required deliverable is |The briefing should |Every quote should |Prefer primary-source quotations |Once you have 2 to 8 |If the evidence is thin|You may optionally write helper notes |Do not stop after searching\\.)/i.test(trimmed)
    || /^(node \/workspace\/context\/|node \/research run\/context\/|\/bin\/bash\b|#!\/usr\/bin\/env\b|import\s)/i.test(trimmed)
    || /^mcp startup:/i.test(trimmed)
    || /^(?:[-*•]\s+|[→✓]\s+)/u.test(trimmed)
    || /^(?:#|##|\*\*)/u.test(trimmed)
    || /^(?:Briefing saved to|Briefing written to|EOF$)/i.test(trimmed)
    || /(?:in \/research run succeeded in|\/research run\/output\/briefing\.md)/i.test(trimmed)
    || /^(?:os\.|with open\(|f\.write\(|briefing\s*=|quotes\s*=)/i.test(trimmed)
    || /^[\[\]{}]+,?$/u.test(trimmed)
    || /^".*":\s*(?:.+)?$/u.test(trimmed)
    || /^".*",?$/u.test(trimmed)
  ) {
    return true;
  }
  return false;
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
          if (isCodexScaffoldingLine(line)) {
            return;
          }
          void appendProgressEvent(outputDir, {
            type: "codex.stdout",
            step,
            line: compactText(line, 400),
            message: compactText(line, 400),
          });
        },
        onStderrLine: (line) => {
          if (isCodexScaffoldingLine(line)) {
            return;
          }
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

function dedupeSpriteCitations(citations) {
  const seen = new Set();
  const deduped = [];
  for (const citation of Array.isArray(citations) ? citations : []) {
    if (!citation || typeof citation !== "object") {
      continue;
    }
    const key = [
      typeof citation.workId === "string" ? citation.workId : "",
      typeof citation.chunkId === "string" ? citation.chunkId : "",
      typeof citation.excerpt === "string" ? citation.excerpt.trim().toLowerCase() : "",
    ].join("::");
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(citation);
  }
  return deduped;
}

async function writeBriefingJson(outputDir, briefing, citations, metadata = {}) {
  await writeFile(
    join(outputDir, "briefing.json"),
    JSON.stringify({
      briefing,
      citations,
      ...metadata,
    }, null, 2),
    "utf8",
  );
}

async function runSpriteAggregator({
  outputDir,
  workspaceRoot,
  model,
  runtimePrompt,
  manifest,
  task,
}) {
  const shardResults = Array.isArray(task.shardResults) ? task.shardResults : [];
  const successful = shardResults.filter((entry) => entry && typeof entry === "object" && entry.ok === true);
  const mergedCitations = dedupeSpriteCitations(
    successful.flatMap((entry) => Array.isArray(entry.citations) ? entry.citations : []),
  ).slice(0, 24);
  const mergedEvidence = {
    question: typeof task.question === "string" ? task.question : "",
    shardCount: shardResults.length,
    successfulShardCount: successful.length,
    items: mergedCitations.map((citation, index) => ({
      rank: index + 1,
      workId: typeof citation.workId === "string" ? citation.workId : null,
      chunkId: typeof citation.chunkId === "string" ? citation.chunkId : null,
      label: typeof citation.label === "string" ? citation.label : null,
      excerpt: typeof citation.excerpt === "string" ? citation.excerpt : "",
      r2Key: typeof citation.r2Key === "string" ? citation.r2Key : null,
    })),
    shardResults: shardResults.map((entry) => ({
      shardId: typeof entry?.shardId === "string" ? entry.shardId : null,
      label: typeof entry?.label === "string" ? entry.label : null,
      ok: entry?.ok === true,
      error: typeof entry?.error === "string" ? entry.error : null,
    })),
  };
  await appendProgressEvent(outputDir, {
    type: "research.aggregate.started",
    shardCount: shardResults.length,
    successfulShardCount: successful.length,
    message: `Aggregating ${successful.length} completed shard briefings.`,
  });
  await writeFile(join(outputDir, "evidence.json"), JSON.stringify(mergedEvidence, null, 2), "utf8");
  await writeFile(join(outputDir, "search-plan.json"), JSON.stringify({
    question: mergedEvidence.question,
    mode: "sprite_aggregate",
    shardCount: shardResults.length,
    successfulShardCount: successful.length,
  }, null, 2), "utf8");
  await writeFile(join(outputDir, "search-iterations.json"), JSON.stringify(
    successful.map((entry) => ({
      shardId: entry.shardId ?? null,
      label: entry.label ?? null,
      briefingPreview: typeof entry.briefing === "string" ? compactText(entry.briefing, 400) : null,
      citationCount: Array.isArray(entry.citations) ? entry.citations.length : 0,
    })),
    null,
    2,
  ), "utf8");
  await writeFile(join(outputDir, "evidence-notes.md"), [
    "# Aggregation Notes",
    "",
    `Successful shards: ${successful.length}/${shardResults.length}`,
    "",
    ...successful.flatMap((entry) => [
      `## ${entry.label || entry.shardId || "Shard"}`,
      "",
      typeof entry.briefing === "string" && entry.briefing.trim().length > 0
        ? compactText(entry.briefing, 1200)
        : "No shard briefing was returned.",
      "",
    ]),
  ].join("\n"), "utf8");
  const promptText = [
    runtimePrompt,
    "",
    "You are aggregating multiple shard-level corpus research briefings.",
    `Research objective: ${mergedEvidence.question || "Analyze the corpus evidence."}`,
    `Workspace manifest summary: ${compactText(JSON.stringify({ works: Array.isArray(manifest.works) ? manifest.works.length : 0 }), 200)}`,
    "Use only the shard evidence below. Write /workspace/output/briefing.md and keep it grounded in the supplied quotations.",
    "Also write /workspace/output/evidence-notes.md if you need additional analysis notes.",
    "",
    "Merged citations:",
    JSON.stringify(mergedEvidence.items, null, 2),
    "",
    "Shard outcomes:",
    JSON.stringify(mergedEvidence.shardResults, null, 2),
  ].join("\n");
  const briefingRun = await runCodexStep({
    workspaceRoot,
    outputDir,
    model,
    step: "codex-briefing",
    promptText,
  });
  const briefingPath = join(outputDir, "briefing.md");
  if (!(await fileExists(briefingPath))) {
    throw new Error("Codex did not write /workspace/output/briefing.md.");
  }
  const briefing = await readFile(briefingPath, "utf8");
  if (!briefing.trim()) {
    throw new Error("Codex wrote an empty /workspace/output/briefing.md.");
  }
  await writeBriefingJson(outputDir, briefing, mergedCitations, {
    successfulShardCount: successful.length,
    shardCount: shardResults.length,
  });
  await writeFile(join(outputDir, "aggregation-summary.json"), JSON.stringify({
    successfulShardCount: successful.length,
    shardCount: shardResults.length,
    citations: mergedCitations.slice(0, 12),
  }, null, 2), "utf8");
  const previousCodexRuns = await readJsonIfPresent(join(outputDir, "codex-runs.json"), []);
  const nextCodexRuns = Array.isArray(previousCodexRuns) ? [...previousCodexRuns, briefingRun] : [briefingRun];
  await writeFile(join(outputDir, "codex-runs.json"), JSON.stringify(nextCodexRuns, null, 2), "utf8");
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
  const booksRoot = join(workspaceRoot, "books");
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

  if (task && typeof task === "object" && task.mode === "sprite_aggregate") {
    await runSpriteAggregator({
      outputDir,
      workspaceRoot,
      model,
      runtimePrompt,
      manifest,
      task,
    });
    return;
  }

  const question = String(task.researchObjective || task.question || task.goal || task.prompt || task.task || "Analyze the workspace corpus.");
  const broadCorpusTask = isBroadCorpusTask(task, false);
  const retrievalWorkLimit = broadCorpusTask ? 24 : 12;
  const seedChunkLimit = broadCorpusTask ? 32 : 16;
  const runtimeHitLimit = broadCorpusTask ? 24 : 12;
  const tokens = queryTokens(question);
  const expansions = semanticExpansions(question);
  const searchTokens = Array.from(new Set([...tokens, ...expansions.tokens]));
  const searchPhrases = Array.from(new Set([normalizeWhitespace(question.toLowerCase()), ...expansions.phrases]));
  const retrieval = task?.retrieval && typeof task.retrieval === "object" ? task.retrieval : null;
  const retrievalWorks = [
    ...(Array.isArray(retrieval?.searchWorks) ? retrieval.searchWorks : []),
    ...(Array.isArray(retrieval?.metadataWorks) ? retrieval.metadataWorks : []),
  ];
  const workById = new Map(
    [
      ...(Array.isArray(manifest.works)
        ? manifest.works.map((work) => [String(work.workId || ""), work])
        : []),
      ...retrievalWorks
        .filter((work) => work && typeof work === "object" && typeof work.id === "string")
        .map((work) => [String(work.id || ""), {
          workId: String(work.id || ""),
          title: typeof work.title === "string" ? work.title : "",
          authors: Array.isArray(work.authors) ? work.authors : [],
          language: typeof work.language === "string" ? work.language : null,
        }]),
    ],
  );
  const chunkFiles = await listChunkFiles(chunksRoot);
  if (chunkFiles.length === 0 && !spriteShardMode) {
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
  let iterations = [];
  let topRuntimeHits = [];
  if (spriteShardMode && chunkFiles.length === 0) {
    iterations = [
      await searchLocalCleanTexts(booksRoot, question, searchTokens, searchPhrases, expansions.families, workById),
    ];
    const mergedHits = mergeHits(iterations);
    topRuntimeHits = diversifyHits(mergedHits, broadCorpusTask ? 24 : 10, broadCorpusTask ? 6 : 3);
    await appendProgressEvent(outputDir, {
      type: "workspace.local_clean_search",
      hitCount: topRuntimeHits.length,
      message: `Searched the local shard clean text and found ${topRuntimeHits.length} candidate passages.`,
    });
  } else {
    iterations = [
      searchCorpus(allChunks, question, searchTokens, searchPhrases, expansions.families, workById, "family-search"),
    ];
    if (expansions.families.some((family) => family.id === "reunion")) {
      iterations.push(searchReunionWindows(chunkIndex, workById, question));
    }
    const mergedHits = mergeHits(iterations);
    const filteredHits = prioritizeFamilyHits(filterFamilyHits(mergedHits, chunkIndex, expansions.families), expansions.families);
    topRuntimeHits = diversifyHits(expandWithNeighbors(filteredHits, chunkIndex), broadCorpusTask ? 24 : 10, broadCorpusTask ? 6 : 3);
  }
  const seedChunks = gatherSeedChunks(task, selectedChunks, workById);
  const evidence = buildSearchEvidence(question, seedChunks.slice(0, seedChunkLimit), topRuntimeHits.slice(0, runtimeHitLimit), workById);
  const seededWorkIds = Array.from(new Set([
    ...(Array.isArray(task.workIds) ? task.workIds.map((value) => String(value || "")) : []),
    ...(Array.isArray(task.candidateWorkIds) ? task.candidateWorkIds.map((value) => String(value || "")) : []),
    ...retrievalWorks.map((work) => String(work?.id || "")),
  ])).filter(Boolean);

  await appendProgressEvent(outputDir, {
    type: "research.seed_summary",
    candidateWorkCount: seededWorkIds.length,
    seedChunkCount: seedChunks.length,
    runtimeHitCount: topRuntimeHits.length,
    message: `Seeded the deeper research run with ${seededWorkIds.length} candidate books, ${seedChunks.length} seed passages, and ${topRuntimeHits.length} local runtime hits.`,
  });

  for (const work of retrievalWorks.slice(0, retrievalWorkLimit)) {
    if (!work || typeof work !== "object" || typeof work.id !== "string") {
      continue;
    }
    await appendProgressEvent(outputDir, {
      type: "research.work",
      workId: work.id,
      workTitle: typeof work.title === "string" ? work.title : "",
      authors: Array.isArray(work.authors) ? work.authors : [],
      message: `Surfaced ${typeof work.title === "string" ? work.title : work.id}.`,
    });
  }

  for (const chunk of seedChunks.slice(0, seedChunkLimit)) {
    await appendProgressEvent(outputDir, {
      type: "research.chunk",
      chunkId: chunk.id,
      workId: chunk.workId,
      workTitle: typeof chunk.title === "string" ? chunk.title : "",
      chunkIndex: typeof chunk.chunkIndex === "number" ? chunk.chunkIndex : null,
      excerpt: chunk.excerpt,
      r2Key: typeof chunk.r2Key === "string" ? chunk.r2Key : null,
      message: `Reviewed a seeded passage from ${chunk.title || chunk.workId}.`,
    });
  }

  for (const chunk of topRuntimeHits.slice(0, runtimeHitLimit)) {
    const normalized = normalizeChunkRecord(chunk, workById);
    await appendProgressEvent(outputDir, {
      type: "research.chunk",
      chunkId: normalized.chunkId,
      workId: normalized.workId,
      workTitle: normalized.workTitle,
      authors: normalized.authors,
      chunkIndex: normalized.chunkIndex,
      excerpt: normalized.excerpt,
      r2Key: normalized.r2Key,
      message: `Identified a likely passage in ${normalized.workTitle || normalized.workId}.`,
    });
  }

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
          ...(Array.isArray(task.frontierWorkIds) ? task.frontierWorkIds.map((value) => String(value || "")) : []),
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
  await writeFile(join(outputDir, "evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
  await writeFile(
    join(outputDir, "evidence.jsonl"),
    [
      ...evidence.selectedChunks.map((chunk) => JSON.stringify({ kind: "seed", ...chunk })),
      ...evidence.runtimeHits.map((chunk) => JSON.stringify({ kind: "runtime_hit", ...chunk })),
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(outputDir, "evidence-notes.md"),
    buildInitialEvidenceNotes(question, evidence),
    "utf8",
  );
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
    const citations = dedupeSpriteCitations(
      evidence.items.map((item, index) => ({
        workId: typeof item.workId === "string" ? item.workId : typeof item.documentId === "string" ? item.documentId : "unknown",
        chunkId: typeof item.chunkId === "string" ? item.chunkId : `sprite-${index}`,
        label: typeof item.label === "string"
          ? item.label
          : `${typeof item.workId === "string" ? item.workId : "work"}#${typeof item.chunkIndex === "number" ? item.chunkIndex : index}`,
        excerpt: typeof item.excerpt === "string" ? item.excerpt : "",
        r2Key: typeof item.r2Key === "string" ? item.r2Key : undefined,
      })),
    ).slice(0, 24);
    await writeBriefingJson(outputDir, briefing, citations, {
      mode: typeof task.mode === "string" ? task.mode : null,
    });
    if (task.mode === "sprite_shard_search") {
      await writeFile(join(outputDir, "shard-summary.json"), JSON.stringify({
        shard: task.shard && typeof task.shard === "object" ? task.shard : null,
        question,
        citationCount: citations.length,
        topCitations: citations.slice(0, 12),
        briefingPreview: compactText(briefing, 1200),
      }, null, 2), "utf8");
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
