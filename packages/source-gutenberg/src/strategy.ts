import type { CorpusDocument } from "@alphabook/corpus-core";

const WORK_SEARCH_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "from",
  "into",
  "about",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "this",
  "those",
  "these",
  "their",
  "there",
  "have",
  "has",
  "had",
  "your",
  "ours",
  "more",
  "less",
  "than",
  "them",
  "they",
  "book",
  "books",
  "text",
  "texts",
  "work",
  "works",
]);

const PASSAGE_SEARCH_QUERY_STOP_WORDS = new Set(["book", "books", "novel", "novels", "story", "stories"]);
const METADATA_SEARCH_QUERY_STOP_WORDS = new Set(["book", "books", "novel", "novels", "story", "stories", "text", "texts"]);

const QUERY_SYNONYMS: Record<string, string[]> = {
  grief: ["mourning", "bereavement", "loss", "sorrow", "lament", "consolation", "despair"],
  mourning: ["grief", "bereavement", "lament", "sorrow"],
  funeral: ["mourning", "burial", "grief"],
  loss: ["grief", "mourning", "bereavement"],
};

const GRIEF_THEME_TOKENS = new Set([
  "grief",
  "mourning",
  "bereavement",
  "funeral",
  "sorrow",
  "lament",
  "loss",
  "consolation",
  "despair",
]);

const GRIEF_BROADENING_TERMS = ["mourning", "bereavement", "loss", "sorrow", "lament", "consolation", "despair"];
const GRIEF_EXPLICIT_MATCH_PATTERN = /\b(grief|mourning|bereavement|funeral|sorrow|lament|weep|wept|weeping|tears?|loss|consolation|despair)\b/u;
const GRIEF_METADATA_STRONG_MATCH_PATTERN = /\b(grief|mourning|bereavement|funeral|sorrow|lament|weep|wept|weeping|tears?|loss|consolation|despair)\b/u;
const JUVENILE_MATCH_PATTERN = /\b(juvenile|children|child|girls|boys|school|schools|orphans?|pz)\b/u;
const ORPHAN_MATCH_PATTERN = /\borphans?\b/u;
const DEATH_TITLE_ONLY_PATTERN = /\b(dead|death)\b/u;
const LOW_SIGNAL_GENRE_PATTERN = /\b(science fiction|horror|drama|satire)\b/u;
const FICTION_SIGNAL_PATTERN = /\b(fiction|novel|novels|story|stories|tale|tales|romance|romances|short stories)\b/u;
const NONFICTION_SIGNAL_PATTERN = /\b(biography|biographies|diary|diaries|history|registers of dead|funeral rites|ceremonies|folklore|personal narratives|memoir|memoirs)\b/u;
const SHORT_FORM_PATTERN = /\b(short stories|short story)\b/u;

function normalizeSearchQuery(query: string): string {
  const tokens = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !WORK_SEARCH_STOP_WORDS.has(token)),
    ),
  );
  return tokens.join(" ");
}

function searchTokens(query: string): string[] {
  const normalized = normalizeSearchQuery(query);
  return Array.from(
    new Set(
      normalized
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !WORK_SEARCH_STOP_WORDS.has(token)),
    ),
  ).slice(0, 8);
}

function expandedSearchTokens(query: string): string[] {
  const baseTokens = searchTokens(query);
  const expanded = new Set(baseTokens);
  for (const token of baseTokens) {
    for (const synonym of QUERY_SYNONYMS[token] ?? []) {
      if (synonym.length >= 3 && !WORK_SEARCH_STOP_WORDS.has(synonym)) {
        expanded.add(synonym);
      }
    }
  }
  return [...expanded].slice(0, 16);
}

function isBroadMetadataSurveyQuery(query: string) {
  return /\b(all|every|compare|comparison|trace|theme|pattern|survey|synthesize|search|find|why|how|where|when|across|identify|different|examples|kinds|types)\b/iu.test(
    query,
  );
}

export function gutenbergQueryTerms(
  query: string,
  mode: "search" | "metadata" | "passage" | "scope",
): string[] {
  const expanded = expandedSearchTokens(query);
  const hasStrongGriefSignal = expanded.some((token) => GRIEF_THEME_TOKENS.has(token) || token === "grief");
  const broadSurveyQuery = isBroadMetadataSurveyQuery(query);
  const terms = hasStrongGriefSignal
    ? Array.from(new Set([...expanded, ...GRIEF_BROADENING_TERMS]))
    : expanded;
  const stopWords = mode === "passage"
    ? PASSAGE_SEARCH_QUERY_STOP_WORDS
    : mode === "metadata" || mode === "scope"
      ? METADATA_SEARCH_QUERY_STOP_WORDS
      : new Set<string>();
  const filtered = terms
    .filter((token) => !stopWords.has(token))
    .filter((token) => !(hasStrongGriefSignal && mode !== "passage" && (token === "widow" || token === "widows")))
    .filter((token) => !(hasStrongGriefSignal && mode !== "passage" && (token === "orphan" || token === "orphans")))
    .filter((token) => !(hasStrongGriefSignal && mode !== "passage" && (token === "child" || token === "children" || token === "juvenile")))
    .filter((token) => !/^\d{4}$/u.test(token));
  const limit = mode === "scope"
    ? 24
    : mode === "metadata"
      ? broadSurveyQuery ? 24 : 16
      : mode === "passage"
        ? broadSurveyQuery ? 14 : 10
        : 16;
  return filtered.slice(0, limit);
}

function metadataTextHaystack(document: CorpusDocument) {
  return [
    document.title,
    document.summary ?? "",
    ...(document.contributors ?? []),
    ...(document.subjects ?? []),
    JSON.stringify(document.metadata ?? {}),
  ].join(" ").toLowerCase();
}

export function gutenbergMetadataScoreBonus(query: string, document: CorpusDocument): number {
  const terms = gutenbergQueryTerms(query, "metadata");
  const hasStrongGriefSignal = terms.some((token) => GRIEF_THEME_TOKENS.has(token));
  const asksForJuvenile = /\b(children|child|juvenile|girl|girls|boy|boys|school|orphan|orphans)\b/iu.test(query);
  const asksForFiction = /\bfiction|novel|novels|short fiction|story|stories|tale|tales|romance\b/iu.test(query);
  const haystack = metadataTextHaystack(document);
  let bonus = 0;
  for (const term of terms) {
    if (!haystack.includes(term)) {
      continue;
    }
    bonus += GRIEF_THEME_TOKENS.has(term) ? 0.35 : 0.12;
  }
  const hasExplicitGriefMatch = GRIEF_EXPLICIT_MATCH_PATTERN.test(haystack);
  const titleHasDeathWord = DEATH_TITLE_ONLY_PATTERN.test(document.title.toLowerCase());
  if (hasStrongGriefSignal && !hasExplicitGriefMatch) {
    bonus -= 0.4;
  }
  if (hasStrongGriefSignal && /\bwidows?\b/u.test(haystack) && !hasExplicitGriefMatch) {
    bonus -= 0.45;
  }
  if (hasStrongGriefSignal && titleHasDeathWord && !hasExplicitGriefMatch) {
    bonus -= 1.2;
  }
  if (hasStrongGriefSignal && LOW_SIGNAL_GENRE_PATTERN.test(haystack) && !hasExplicitGriefMatch) {
    bonus -= 0.9;
  }
  if (asksForFiction && !FICTION_SIGNAL_PATTERN.test(haystack)) {
    bonus -= 1.1;
  }
  if (asksForFiction && NONFICTION_SIGNAL_PATTERN.test(haystack)) {
    bonus -= 1.25;
  }
  if (hasStrongGriefSignal && !asksForJuvenile) {
    if (JUVENILE_MATCH_PATTERN.test(haystack) && !hasExplicitGriefMatch) {
      bonus -= 1.15;
    } else if (JUVENILE_MATCH_PATTERN.test(haystack)) {
      bonus -= 0.55;
    }
    if (ORPHAN_MATCH_PATTERN.test(haystack) && !hasExplicitGriefMatch) {
      bonus -= 0.35;
    }
    if (SHORT_FORM_PATTERN.test(haystack) && !hasExplicitGriefMatch) {
      bonus -= 0.45;
    }
  }
  if (hasStrongGriefSignal && hasExplicitGriefMatch) {
    bonus += 0.45;
  }
  return bonus;
}

export function gutenbergAcceptMetadataResults(query: string, limit: number, documents: CorpusDocument[]): boolean {
  const terms = gutenbergQueryTerms(query, "metadata");
  const hasStrongGriefSignal = terms.some((token) => GRIEF_THEME_TOKENS.has(token));
  const broadSurveyQuery = isBroadMetadataSurveyQuery(query);
  if (!hasStrongGriefSignal) {
    const target = broadSurveyQuery ? Math.min(limit, 12) : Math.min(limit, 6);
    return documents.length >= target;
  }
  const strongMatches = documents
    .slice(0, Math.min(documents.length, broadSurveyQuery ? 14 : 8))
    .filter((document) => GRIEF_METADATA_STRONG_MATCH_PATTERN.test(metadataTextHaystack(document)));
  return strongMatches.length >= Math.min(limit, broadSurveyQuery ? 6 : 4);
}

function isTemporalAnalysisQuery(query: string) {
  return /\b(by decade|over time|through time|throughout the century|changed over time|change over time|evolution of|evolve|earlier vs later|early vs late|before and after|first half|second half)\b/iu.test(query);
}

function isBroadSurveyShardQuery(query: string) {
  return /\b(all|every|trace|theme|pattern|survey|synthesize|search|find|identify|examples|different ways|ways that|kinds of|types of)\b/iu.test(
    query,
  );
}

export function gutenbergRecommendedShardAxis(
  query: string,
  estimatedDocumentBreadth: number,
): "none" | "work_id_hash" | "author_initial" | "publication_year" | "retrieval_strategy" {
  if (estimatedDocumentBreadth <= 24) {
    return "none";
  }
  if (/\b(hypothesis|test whether|for and against|support and oppose|support or refute|prove or disprove|verdict|counterexample|exception|exceptions|disconfirm)\b/iu.test(query)) {
    return "retrieval_strategy";
  }
  if (/\b(what about|go deeper|follow up|follow-up|focus on|expand on|narrow|zoom in)\b/iu.test(query)) {
    return "retrieval_strategy";
  }
  if (isBroadSurveyShardQuery(query) && !isTemporalAnalysisQuery(query)) {
    return "work_id_hash";
  }
  if (
    isTemporalAnalysisQuery(query)
    || /\b(180\d|181\d|182\d|183\d|184\d|185\d|186\d|187\d|188\d|189\d|decade|era|period)\b/iu.test(query)
  ) {
    return "publication_year";
  }
  if (/\b(compare|comparison|across|survey|pattern|types|different ways|kinds of)\b/iu.test(query)) {
    return "work_id_hash";
  }
  if (/\b(author|authors|writer|writers|novelist|novelists)\b/iu.test(query)) {
    return "author_initial";
  }
  return "retrieval_strategy";
}
