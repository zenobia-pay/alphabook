const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "to",
  "what",
  "where",
  "which",
  "with",
]);

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function uniqueTokens(tokens: string[]): string[] {
  return Array.from(new Set(tokens));
}
