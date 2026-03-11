import corpusAsset from "../generated/don-quixote.json";

export type ResearchMode = "fast" | "slow" | "naive";
export type FeedTab = "hot" | "likes" | "briefs";
export type RailPanel = "assistant" | "notes" | "comments" | "similar";
export type DocumentView = "document" | "brief" | "resources";

export interface CorpusBook {
  id: string;
  title: string;
  author: string;
  sourceUrl: string;
  textLength: number;
  chunkCount: number;
}

export interface CorpusChunk {
  id: string;
  bookId: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  content: string;
}

interface CorpusAsset {
  book: CorpusBook;
  chunks: CorpusChunk[];
}

export interface DocumentResource {
  label: string;
  url: string;
  kind: "source" | "pdf" | "blog" | "dataset" | "discussion";
}

export interface DocumentSection {
  title: string;
  body: string;
}

export interface SeedDocument {
  id: string;
  slug: string;
  kind: "book" | "paper";
  title: string;
  kicker: string;
  authors: string[];
  year: string;
  venue: string;
  summary: string;
  brief: string;
  theme: string;
  tags: string[];
  resources: DocumentResource[];
  sections: DocumentSection[];
  relatedIds: string[];
  feedScore: number;
  likesSeed: number;
  savesSeed: number;
  commentsSeed: number;
  hasFullText: boolean;
  fullTextLabel: string;
}

export interface DocumentStats {
  likes: number;
  saves: number;
  comments: number;
}

export interface DocumentCard extends SeedDocument {
  stats: DocumentStats;
  liked: boolean;
  saved: boolean;
}

export interface SearchHit {
  documentId: string;
  title: string;
  score: number;
  excerpt: string;
  strategy: string;
  href: string;
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
  documentHits: SearchHit[];
  chunkHits: SearchHit[];
}

export interface ResearchResult {
  query: string;
  mode: ResearchMode;
  synthesis: string;
  documents: Array<{
    documentId: string;
    title: string;
    summary: string;
    evidence: SearchHit[];
  }>;
}

export interface AssistantCitation {
  label: string;
  href: string;
  excerpt: string;
}

export interface AssistantReply {
  title: string;
  answer: string;
  citations: AssistantCitation[];
  relatedDocumentIds: string[];
  mode: ResearchMode;
}

export interface SearchArchitectureStep {
  title: string;
  body: string;
}

const WORD_RE = /[A-Za-z0-9']+/g;
const EMBED_DIMS = 128;
const donQuixoteAsset = corpusAsset as CorpusAsset;

const selectedDonQuixoteSections = [205, 206, 207, 440, 1466, 2136]
  .map((chunkIndex) => donQuixoteAsset.chunks.find((chunk) => chunk.chunkIndex === chunkIndex))
  .filter((chunk): chunk is CorpusChunk => Boolean(chunk))
  .map((chunk, index) => ({
    title: [
      "Windmills",
      "Giant fantasy",
      "Sancho objects",
      "Love and tears",
      "Melancholy scene",
      "Defeat and grief",
    ][index],
    body: chunk.content,
  }));

export const seededDocuments: SeedDocument[] = [
  {
    id: "don-quixote",
    slug: "don-quixote",
    kind: "book",
    title: "Don Quixote",
    kicker: "Live corpus",
    authors: ["Miguel de Cervantes"],
    year: "1605 / 1615",
    venue: "Project Gutenberg",
    summary:
      "The only fully ingested document in the current app. Search, chunk retrieval, and deeper research passes all run against this text.",
    brief:
      "This build is intentionally narrow. It keeps one real book in the system so the retrieval and agentic search surfaces are honest: fast search routes into chunk hits, and slower passes widen the sweep across the same corpus when the question needs it.",
    theme: "Errantry, delusion, sadness, performance",
    tags: ["book", "fiction", "full-text", "melancholy", "public-domain"],
    resources: [
      {
        label: "Project Gutenberg source",
        url: "https://www.gutenberg.org/cache/epub/996/pg996.txt",
        kind: "source",
      },
      {
        label: "Corpus bundle",
        url: "/api/doc/don-quixote",
        kind: "dataset",
      },
    ],
    sections: selectedDonQuixoteSections,
    relatedIds: [],
    feedScore: 100,
    likesSeed: 18,
    savesSeed: 9,
    commentsSeed: 1,
    hasFullText: true,
    fullTextLabel: `${donQuixoteAsset.book.chunkCount} searchable chunks`,
  },
];

export const searchArchitecture: SearchArchitectureStep[] = [
  {
    title: "1. Route with cheap signals",
    body:
      "The query is embedded with a local hashed embedding and scored against the document metadata and the full-book centroid. This is the fast routing pass.",
  },
  {
    title: "2. Pull chunk evidence",
    body:
      "The top route is expanded into chunk-level retrieval. Each chunk score mixes semantic similarity and lexical overlap so exact words and thematic matches both matter.",
  },
  {
    title: "3. Escalate only when needed",
    body:
      "Fast mode summarizes the top chunk hits. Slow mode broadens the evidence window. Naive mode is the exhaustive variant that would fan out across every ingested book once the corpus grows.",
  },
];

export function getDocument(documentId: string): SeedDocument | undefined {
  return seededDocuments.find((document) => document.id === documentId);
}

export function listDocuments(): SeedDocument[] {
  return seededDocuments;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? [];
}

function hashToken(token: string): Uint8Array {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const bytes = new Uint8Array(8);
  let value = hash >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    value = Math.imul(value ^ (index + 1), 2246822519) >>> 0;
    bytes[index] = value & 0xff;
  }
  return bytes;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / magnitude);
}

function embedText(text: string): number[] {
  const vector = new Array<number>(EMBED_DIMS).fill(0);
  for (const token of tokenize(text)) {
    const digest = hashToken(token);
    const bucket = ((digest[0] << 8) | digest[1]) % EMBED_DIMS;
    const sign = digest[2] % 2 === 0 ? 1 : -1;
    vector[bucket] += sign;
  }
  return normalize(vector);
}

function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    return [];
  }
  const totals = new Array<number>(vectors[0].length).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < vector.length; index += 1) {
      totals[index] += vector[index];
    }
  }
  return normalize(totals.map((value) => value / vectors.length));
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += left[index] * right[index];
  }
  return total;
}

function makeExcerpt(text: string, query: string, window = 220): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  const lower = collapsed.toLowerCase();
  const positions = tokenize(query)
    .map((token) => lower.indexOf(token))
    .filter((position) => position >= 0);
  const center = positions.length > 0 ? positions[0] : Math.max(0, Math.floor(collapsed.length / 2));
  const start = Math.max(0, center - Math.floor(window / 3));
  const end = Math.min(collapsed.length, start + window);
  return `${start > 0 ? "..." : ""}${collapsed.slice(start, end)}${end < collapsed.length ? "..." : ""}`;
}

function lexicalScore(query: string, text: string): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return 0;
  }
  const lower = text.toLowerCase();
  let score = 0;
  const joined = tokens.join(" ");
  if (joined && lower.includes(joined)) {
    score += 6;
  }
  for (const token of tokens) {
    const count = lower.split(token).length - 1;
    if (count > 0) {
      score += 1 + Math.min(count, 5) * 0.5;
    }
  }
  return score;
}

const documentEmbeddings = new Map(
  seededDocuments.map((document) => [
    document.id,
    embedText(`${document.title}\n${document.summary}\n${document.brief}\n${document.tags.join(" ")}`),
  ]),
);

const corpusChunkEmbeddings = donQuixoteAsset.chunks.map((chunk) => embedText(chunk.content));
const corpusBookEmbedding = averageVectors(corpusChunkEmbeddings);

export function buildDocumentCards(
  statsByDocument: Record<string, DocumentStats>,
  viewerState?: { likedDocIds: string[]; savedDocIds: string[]; interests?: string[] },
): DocumentCard[] {
  const interests = new Set(viewerState?.interests ?? []);
  return seededDocuments.map((document) => {
    const stats = statsByDocument[document.id] ?? {
      likes: document.likesSeed,
      saves: document.savesSeed,
      comments: document.commentsSeed,
    };
    const interestBoost = document.tags.some((tag) => interests.has(tag)) ? 4 : 0;
    return {
      ...document,
      feedScore: document.feedScore + interestBoost,
      stats,
      liked: viewerState?.likedDocIds.includes(document.id) ?? false,
      saved: viewerState?.savedDocIds.includes(document.id) ?? false,
    };
  });
}

export function getFeedDocuments(
  tab: FeedTab,
  statsByDocument: Record<string, DocumentStats>,
  viewerState?: { likedDocIds: string[]; savedDocIds: string[]; interests?: string[] },
): DocumentCard[] {
  const cards = buildDocumentCards(statsByDocument, viewerState);
  const sorted = [...cards];
  if (tab === "likes") {
    sorted.sort((left, right) => right.stats.likes - left.stats.likes);
  } else if (tab === "briefs") {
    sorted.sort((left, right) => right.brief.length - left.brief.length);
  } else {
    sorted.sort((left, right) => right.feedScore - left.feedScore);
  }
  return sorted;
}

export function runSearch(query: string): SearchResponse {
  const document = seededDocuments[0];
  const queryEmbedding = embedText(query);
  const documentHit = {
    documentId: document.id,
    title: document.title,
    score:
      cosineSimilarity(queryEmbedding, documentEmbeddings.get(document.id) ?? []) * 0.72 +
      Math.min(lexicalScore(query, `${document.title}\n${document.summary}\n${document.brief}`) / 10, 1) * 0.28,
    excerpt: document.summary,
    strategy: "document-routing",
    href: `/doc/${document.id}`,
  } satisfies SearchHit;

  const bookScore = cosineSimilarity(queryEmbedding, corpusBookEmbedding);
  const chunkHits = donQuixoteAsset.chunks
    .map((chunk, index) => ({
      documentId: document.id,
      title: document.title,
      score:
        0.74 * cosineSimilarity(queryEmbedding, corpusChunkEmbeddings[index]) +
        0.2 * bookScore +
        Math.min(lexicalScore(query, chunk.content), 10) / 25,
      excerpt: makeExcerpt(chunk.content, query),
      strategy: "chunk-retrieval",
      href: `/doc/${document.id}?panel=assistant&q=${encodeURIComponent(query)}#chunk-${chunk.chunkIndex}`,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 10);

  return {
    query,
    results: [documentHit, ...chunkHits].slice(0, 10),
    documentHits: [documentHit],
    chunkHits,
  };
}

function evidenceCountForMode(mode: ResearchMode): number {
  if (mode === "fast") {
    return 3;
  }
  if (mode === "slow") {
    return 8;
  }
  return 14;
}

function chunkLabels(evidence: SearchHit[]): string {
  return evidence
    .slice(0, 4)
    .map((hit) => hit.href.match(/chunk-(\d+)/)?.[1] ?? "?")
    .join(", ");
}

export function runResearch(query: string, mode: ResearchMode, activeDocumentId?: string): ResearchResult {
  const onlyDocument = seededDocuments[0];
  if (activeDocumentId && activeDocumentId !== onlyDocument.id) {
    return {
      query,
      mode,
      synthesis: `No ingested full-text document matched ${activeDocumentId}.`,
      documents: [],
    };
  }

  const search = runSearch(query);
  const evidence = search.chunkHits.slice(0, evidenceCountForMode(mode));
  const documentSummary = evidence.length
    ? `${mode === "fast" ? "Fast mode" : mode === "slow" ? "Slow mode" : "Naive mode"} pulled ${evidence.length} chunk hits from Don Quixote. The strongest evidence clusters around chunk indexes ${chunkLabels(
        evidence,
      )}.`
    : "The book is ingested, but this query did not produce strong evidence.";

  return {
    query,
    mode,
    synthesis: evidence.length
      ? `${mode === "fast" ? "Fast search" : mode === "slow" ? "Agentic slow search" : "Naive exhaustive search"} routed into Don Quixote, then widened the evidence window to synthesize a book-level answer from chunk matches.`
      : `No usable evidence was retrieved for "${query}".`,
    documents: [
      {
        documentId: onlyDocument.id,
        title: onlyDocument.title,
        summary: documentSummary,
        evidence,
      },
    ],
  };
}

export function buildAssistantReply(prompt: string, activeDocumentId?: string): AssistantReply {
  const lowered = prompt.toLowerCase();
  const mode: ResearchMode =
    lowered.includes("all the times") || lowered.includes("every time") || lowered.includes("deep")
      ? "slow"
      : lowered.includes("everything") || lowered.includes("entire book")
        ? "naive"
        : "fast";

  const research = runResearch(prompt, mode, activeDocumentId);
  const topDocument = research.documents[0];
  const citations = topDocument
    ? topDocument.evidence.slice(0, mode === "fast" ? 2 : 4).map((evidence) => ({
        label: topDocument.title,
        href: evidence.href,
        excerpt: evidence.excerpt,
      }))
    : [];

  return {
    title: `Search reply (${mode})`,
    answer: topDocument
      ? `${research.synthesis} ${topDocument.summary}`
      : `I could not route that query into the current corpus.`,
    citations,
    relatedDocumentIds: topDocument ? [topDocument.documentId] : [],
    mode,
  };
}

export function buildDocumentContext(documentId: string, query?: string) {
  const document = getDocument(documentId);
  if (!document) {
    return undefined;
  }

  const search = query ? runSearch(query) : undefined;
  const sections =
    query && search
      ? search.chunkHits.slice(0, 6).map((hit, index) => ({
          title: `Search hit ${index + 1}`,
          body: hit.excerpt,
        }))
      : document.sections;

  return {
    document,
    search,
    sections,
  };
}
