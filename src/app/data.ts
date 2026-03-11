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

const WORD_RE = /[A-Za-z0-9']+/g;
const EMBED_DIMS = 128;
const donQuixoteAsset = corpusAsset as CorpusAsset;

const selectedDonQuixoteSections = [205, 206, 207, 440, 1466, 2136]
  .map((chunkIndex) => donQuixoteAsset.chunks.find((chunk) => chunk.chunkIndex === chunkIndex))
  .filter((chunk): chunk is CorpusChunk => Boolean(chunk))
  .map((chunk, index) => ({
    title: [
      "Windmill collision",
      "The giant delusion",
      "Sancho’s warning",
      "Love and tears",
      "Melancholy waters",
      "Grief after defeat",
    ][index],
    body: chunk.content,
  }));

export const seededDocuments: SeedDocument[] = [
  {
    id: "don-quixote",
    slug: "don-quixote",
    kind: "book",
    title: "Don Quixote",
    kicker: "Public-domain field text",
    authors: ["Miguel de Cervantes"],
    year: "1605 / 1615",
    venue: "Project Gutenberg corpus",
    summary:
      "A knight-errant fantasy that repeatedly folds delusion, grief, theatricality, and social satire into one long narrative. This is the primary full-text corpus in the current prototype.",
    brief:
      "Use this document when you want to test the full research stack. It supports chunk-level search, fast semantic routing, and deep worker-side scans for themes like sadness, delusion, longing, or theatrical self-fashioning.",
    theme: "Errantry, hallucination, emotion, social comedy",
    tags: ["books", "fiction", "melancholy", "quest", "classic"],
    resources: [
      {
        label: "Project Gutenberg source",
        url: "https://www.gutenberg.org/cache/epub/996/pg996.txt",
        kind: "source",
      },
      {
        label: "alphaXiv-style brief prototype",
        url: "/doc/don-quixote?view=brief",
        kind: "blog",
      },
    ],
    sections: selectedDonQuixoteSections,
    relatedIds: ["meditations", "bitter-lesson", "attention-is-all-you-need"],
    feedScore: 98,
    likesSeed: 188,
    savesSeed: 94,
    commentsSeed: 21,
    hasFullText: true,
    fullTextLabel: "2212 searchable chunks",
  },
  {
    id: "meditations",
    slug: "meditations",
    kind: "book",
    title: "Meditations",
    kicker: "Private notes as public operating system",
    authors: ["Marcus Aurelius"],
    year: "2nd century",
    venue: "Stoic notebook tradition",
    summary:
      "A notebook of self-instruction organized around attention, impermanence, duty, restraint, and the management of inner life under pressure.",
    brief:
      "This works as a philosophical counterweight to Don Quixote: less spectacle, more discipline. In product terms it is a good testbed for note-taking, highlight workflows, and quote-grounded assistant answers.",
    theme: "Attention, duty, self-governance",
    tags: ["books", "philosophy", "stoicism", "journals"],
    resources: [
      { label: "Internet Classics text", url: "https://classics.mit.edu/Antoninus/meditations.html", kind: "source" },
      { label: "Reading notes scaffold", url: "/doc/meditations?view=brief", kind: "blog" },
    ],
    sections: [
      {
        title: "Attention before reaction",
        body:
          "What matters is not merely exposure to information but the formation of a stable inner protocol for processing it. The interface should foreground this by turning saved notes into operating instructions, not scraps.",
      },
      {
        title: "Private writing, public utility",
        body:
          "Meditations is ideal for a note-first reader because the text itself feels like a stitched sequence of margin notes. The product should make that reading mode native.",
      },
    ],
    relatedIds: ["don-quixote", "bitter-lesson"],
    feedScore: 89,
    likesSeed: 140,
    savesSeed: 102,
    commentsSeed: 9,
    hasFullText: false,
    fullTextLabel: "Metadata + editorial brief",
  },
  {
    id: "attention-is-all-you-need",
    slug: "attention-is-all-you-need",
    kind: "paper",
    title: "Attention Is All You Need",
    kicker: "The canonical transformer paper",
    authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit", "Llion Jones"],
    year: "2017",
    venue: "NeurIPS",
    summary:
      "Introduced the transformer architecture, replacing recurrence with self-attention and dramatically changing how sequence modeling scales.",
    brief:
      "For the frontend, this is the archetypal paper-card: high citation gravity, broad familiarity, and a clear need for concise briefs, resources, and assistant explanations instead of raw PDF-first navigation.",
    theme: "Architectures, scaling, attention",
    tags: ["papers", "transformers", "ml", "foundation-models"],
    resources: [
      { label: "arXiv", url: "https://arxiv.org/abs/1706.03762", kind: "source" },
      { label: "PDF", url: "https://arxiv.org/pdf/1706.03762", kind: "pdf" },
    ],
    sections: [
      {
        title: "Why it belongs in the feed",
        body:
          "This document is the canonical example of why the product needs a strong brief and similar-doc rail. Most users know the headline and need a faster route to implications, variants, and adjacent work.",
      },
      {
        title: "Ideal UI treatment",
        body:
          "The right rail should surface cited descendants, implementation notes, and explanatory glosses so the paper becomes an entry node rather than a dead-end PDF.",
      },
    ],
    relatedIds: ["gpt-4-technical-report", "bitter-lesson", "don-quixote"],
    feedScore: 95,
    likesSeed: 244,
    savesSeed: 176,
    commentsSeed: 34,
    hasFullText: false,
    fullTextLabel: "Metadata + resources",
  },
  {
    id: "bitter-lesson",
    slug: "the-bitter-lesson",
    kind: "paper",
    title: "The Bitter Lesson",
    kicker: "A short essay with long product consequences",
    authors: ["Rich Sutton"],
    year: "2019",
    venue: "Essay",
    summary:
      "Argues that general methods leveraging computation win over hand-built domain heuristics over the long term.",
    brief:
      "This is a product-shaping document for alphabook. It justifies why the system should invest in scalable retrieval, reusable embeddings, and agentic passes rather than too many brittle handcrafted ontologies.",
    theme: "Scaling laws, research strategy",
    tags: ["papers", "essay", "ai-strategy", "agents"],
    resources: [
      { label: "Original essay", url: "http://www.incompleteideas.net/IncIdeas/BitterLesson.html", kind: "source" },
      { label: "Product note", url: "/doc/bitter-lesson?view=brief", kind: "blog" },
    ],
    sections: [
      {
        title: "Product implication",
        body:
          "The frontend should make expensive deep-research passes visible and intentional, but it should rely on cheap routing and ranking by default. The UI should teach that distinction instead of hiding it.",
      },
      {
        title: "Why it maps to Labs",
        body:
          "This is the conceptual bridge between the feed and the research engine. Labs can expose exactly how the cheap and expensive loops cooperate.",
      },
    ],
    relatedIds: ["attention-is-all-you-need", "gpt-4-technical-report", "don-quixote"],
    feedScore: 91,
    likesSeed: 167,
    savesSeed: 118,
    commentsSeed: 12,
    hasFullText: false,
    fullTextLabel: "Metadata + editorial brief",
  },
  {
    id: "gpt-4-technical-report",
    slug: "gpt-4-technical-report",
    kind: "paper",
    title: "GPT-4 Technical Report",
    kicker: "Capability reporting as product surface",
    authors: ["OpenAI"],
    year: "2023",
    venue: "Technical report",
    summary:
      "A capability and evaluation report that matters not only for its claims but for what it reveals about product communication, omission, and public benchmarking.",
    brief:
      "This item exists to stress the profile, comments, and notes systems. It is the type of document users want to annotate socially, argue about, and cross-link to adjacent papers or model cards.",
    theme: "Capability evals, transparency, product communication",
    tags: ["papers", "llms", "evaluation", "policy"],
    resources: [
      { label: "Technical report", url: "https://arxiv.org/abs/2303.08774", kind: "source" },
      { label: "PDF", url: "https://arxiv.org/pdf/2303.08774", kind: "pdf" },
    ],
    sections: [
      {
        title: "Discussion-heavy document",
        body:
          "Some documents are primarily discussion generators. The UI should handle comments, quote replies, and saved counterarguments as first-class objects rather than tacking them on below the fold.",
      },
    ],
    relatedIds: ["attention-is-all-you-need", "bitter-lesson"],
    feedScore: 87,
    likesSeed: 152,
    savesSeed: 111,
    commentsSeed: 28,
    hasFullText: false,
    fullTextLabel: "Metadata + resources",
  },
  {
    id: "federalist-10",
    slug: "federalist-10",
    kind: "paper",
    title: "Federalist No. 10",
    kicker: "Faction, scale, and system design",
    authors: ["James Madison"],
    year: "1787",
    venue: "Federalist Papers",
    summary:
      "A system-design text about factions, incentives, and institutional scale. It is useful as a bridge between political theory and modern networked coordination questions.",
    brief:
      "Included to push the product beyond ML-only feeds. alphabook should feel comfortable spanning books, essays, and papers without losing coherence.",
    theme: "Institutions, scale, conflict",
    tags: ["politics", "essays", "institutions", "history"],
    resources: [
      { label: "Library of Congress", url: "https://guides.loc.gov/federalist-papers/text-1-20", kind: "source" },
    ],
    sections: [
      {
        title: "Why it belongs here",
        body:
          "The point is not only research papers. The interface should support long-form texts whose value emerges through comparison, annotation, and synthesis.",
      },
    ],
    relatedIds: ["don-quixote", "meditations"],
    feedScore: 80,
    likesSeed: 74,
    savesSeed: 52,
    commentsSeed: 7,
    hasFullText: false,
    fullTextLabel: "Metadata + source link",
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
  const queryEmbedding = embedText(query);
  const metadataHits = seededDocuments
    .map((document) => {
      const embeddingScore = cosineSimilarity(queryEmbedding, documentEmbeddings.get(document.id) ?? []);
      const textScore =
        lexicalScore(query, `${document.title}\n${document.summary}\n${document.brief}\n${document.tags.join(" ")}`) /
        10;
      return {
        documentId: document.id,
        title: document.title,
        score: embeddingScore * 0.7 + textScore * 0.3,
        excerpt: document.summary,
        strategy: "document-routing",
        href: `/doc/${document.id}`,
      } satisfies SearchHit;
    })
    .sort((left, right) => right.score - left.score);

  const bookScore = cosineSimilarity(queryEmbedding, corpusBookEmbedding);
  const chunkHits = donQuixoteAsset.chunks
    .map((chunk, index) => ({
      documentId: donQuixoteAsset.book.id,
      title: donQuixoteAsset.book.title,
      score:
        0.75 * cosineSimilarity(queryEmbedding, corpusChunkEmbeddings[index]) +
        0.25 * bookScore +
        Math.min(lexicalScore(query, chunk.content), 10) / 25,
      excerpt: makeExcerpt(chunk.content, query),
      strategy: "full-text",
      href: `/doc/don-quixote?panel=assistant&q=${encodeURIComponent(query)}#chunk-${chunk.chunkIndex}`,
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);

  const results = [...metadataHits.slice(0, 6), ...chunkHits.slice(0, 4)]
    .sort((left, right) => right.score - left.score)
    .slice(0, 10);

  return {
    query,
    results,
    documentHits: metadataHits.slice(0, 6),
    chunkHits,
  };
}

export function runResearch(query: string, mode: ResearchMode, activeDocumentId?: string): ResearchResult {
  const search = runSearch(query);
  const topDocuments = (activeDocumentId
    ? search.documentHits.filter((hit) => hit.documentId === activeDocumentId)
    : search.documentHits
  )
    .slice(0, mode === "naive" ? seededDocuments.length : 3)
    .map((hit) => getDocument(hit.documentId))
    .filter((document): document is SeedDocument => Boolean(document));

  const documents = topDocuments.map((document) => {
    if (document.id === "don-quixote") {
      const evidence = search.chunkHits.slice(0, mode === "fast" ? 3 : 6);
      return {
        documentId: document.id,
        title: document.title,
        summary:
          evidence.length > 0
            ? `Don Quixote remains the best full-text match. The strongest passages cluster around chunk indexes ${evidence
                .slice(0, 3)
                .map((hit) => hit.href.match(/chunk-(\d+)/)?.[1] ?? "?")
                .join(", ")}.`
            : "Don Quixote is in corpus but did not produce strong evidence for this query.",
        evidence,
      };
    }

    return {
      documentId: document.id,
      title: document.title,
      summary: `${document.title} is included as a metadata-first document. The current research loop can synthesize from its brief, tags, and resources, but not yet perform full-text deep scans.`,
      evidence: [
        {
          documentId: document.id,
          title: document.title,
          score: 0.5,
          excerpt: document.brief,
          strategy: "editorial-brief",
          href: `/doc/${document.id}?view=brief`,
        },
      ],
    };
  });

  const synthesis = documents.length
    ? `The research loop routes this query toward ${documents.map((document) => document.title).join(", ")}. In the current product build, only Don Quixote has bundled full-text evidence; the rest are brief-backed and resource-backed documents.`
    : `No routed documents were strong enough for "${query}".`;

  return {
    query,
    mode,
    synthesis,
    documents,
  };
}

export function buildAssistantReply(prompt: string, activeDocumentId?: string): AssistantReply {
  const lowered = prompt.toLowerCase();
  const mode: ResearchMode =
    lowered.includes("all the times") || lowered.includes("every time") || lowered.includes("deep")
      ? "slow"
      : "fast";

  if (activeDocumentId && activeDocumentId !== "don-quixote") {
    const document = getDocument(activeDocumentId);
    if (!document) {
      return {
        title: "Document not found",
        answer: "I could not locate that document in the current bundle.",
        citations: [],
        relatedDocumentIds: [],
        mode,
      };
    }

    return {
      title: `Assistant brief for ${document.title}`,
      answer: `${document.brief} The most productive next step is to open the resources tab and then compare this document against ${document.relatedIds
        .slice(0, 2)
        .map((id) => getDocument(id)?.title ?? id)
        .join(" and ")}.`,
      citations: document.resources.slice(0, 2).map((resource) => ({
        label: resource.label,
        href: resource.url,
        excerpt: document.summary,
      })),
      relatedDocumentIds: document.relatedIds,
      mode,
    };
  }

  const research = runResearch(prompt, mode, activeDocumentId);
  const citations = research.documents.flatMap((document) =>
    document.evidence.slice(0, 2).map((evidence) => ({
      label: document.title,
      href: evidence.href,
      excerpt: evidence.excerpt,
    })),
  );

  return {
    title: `Research loop response (${mode})`,
    answer: `${research.synthesis} ${
      research.documents[0]
        ? `Primary evidence currently points to ${research.documents[0].title}.`
        : "No document produced usable evidence."
    }`,
    citations,
    relatedDocumentIds: research.documents.map((document) => document.documentId),
    mode,
  };
}

export function buildDocumentContext(documentId: string, query?: string) {
  const document = getDocument(documentId);
  if (!document) {
    return undefined;
  }

  const search = query ? runSearch(query) : undefined;
  const highlightedSections =
    documentId === "don-quixote" && search
      ? search.chunkHits.slice(0, 3).map((hit) => ({
          title: `Search hit`,
          body: hit.excerpt,
        }))
      : document.sections;

  return {
    document,
    search,
    sections: highlightedSections,
  };
}

