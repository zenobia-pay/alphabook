import corpusAsset from "./generated/don-quixote.json";

interface Env {}

interface CorpusBook {
  id: string;
  title: string;
  author: string;
  sourceUrl: string;
  textLength: number;
  chunkCount: number;
}

interface CorpusChunk {
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

interface LoadedCorpus {
  book: CorpusBook;
  chunks: CorpusChunk[];
  bookEmbedding: number[];
  chunkEmbeddings: number[][];
}

type ResearchMode = "fast" | "slow" | "naive";

const WORD_RE = /[A-Za-z0-9']+/g;
const EMBED_DIMS = 128;
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

let cachedCorpusPromise: Promise<LoadedCorpus> | null = null;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(WORD_RE);
  return matches ?? [];
}

function makeExcerpt(text: string, query: string, window = 220): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
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
  if (tokens.length === 0) return 0;
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
  if (magnitude === 0) return vector.map(() => 0);
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

async function loadCorpus(_env: Env, _request: Request): Promise<LoadedCorpus> {
  if (!cachedCorpusPromise) {
    cachedCorpusPromise = (async () => {
      const asset = corpusAsset as CorpusAsset;
      const chunkEmbeddings = asset.chunks.map((chunk) => embedText(chunk.content));
      const bookEmbedding = averageVectors(chunkEmbeddings);
      return {
        book: asset.book,
        chunks: asset.chunks,
        chunkEmbeddings,
        bookEmbedding,
      };
    })();
  }
  return cachedCorpusPromise;
}

function runSearch(corpus: LoadedCorpus, query: string, topChunks = 8) {
  const queryEmbedding = embedText(query);
  const bookScore = cosineSimilarity(queryEmbedding, corpus.bookEmbedding);

  const embeddingHits = corpus.chunks
    .map((chunk, index) => ({
      book: corpus.book,
      chunk,
      score: 0.75 * cosineSimilarity(queryEmbedding, corpus.chunkEmbeddings[index]) + 0.25 * bookScore,
      strategy: "chunk-embedding",
      excerpt: makeExcerpt(chunk.content, query),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, topChunks);

  const textHits = corpus.chunks
    .map((chunk) => ({
      book: corpus.book,
      chunk,
      score: lexicalScore(query, chunk.content),
      strategy: "plain-text",
      excerpt: makeExcerpt(chunk.content, query),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, topChunks);

  return {
    query,
    relevantBooks: [
      {
        book: corpus.book,
        score: bookScore,
        strategy: "book-embedding",
      },
    ],
    embeddingHits,
    textHits,
  };
}

function runDeepScan(corpus: LoadedCorpus, query: string, searchResult: ReturnType<typeof runSearch>) {
  const queryEmbedding = embedText(query);
  const hintChunkIds = new Set(
    [...searchResult.embeddingHits, ...searchResult.textHits].map((hit) => hit.chunk.id),
  );

  const evidence = corpus.chunks
    .map((chunk, index) => {
      const semantic = cosineSimilarity(queryEmbedding, corpus.chunkEmbeddings[index]);
      const lexical = lexicalScore(query, chunk.content);
      const hintBonus = hintChunkIds.has(chunk.id) ? 0.15 : 0;
      const score = 0.7 * semantic + 0.3 * Math.min(lexical, 10) / 10 + hintBonus;
      return {
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        score,
        strategy: "local-deep-scan",
        excerpt: makeExcerpt(chunk.content, query),
        reason: `semantic=${semantic.toFixed(3)}, lexical=${lexical.toFixed(3)}, hintBonus=${hintBonus.toFixed(2)}`,
      };
    })
    .filter((item) => item.score > 0.12)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6);

  const summary =
    evidence.length > 0
      ? `Found ${evidence.length} high-signal passages in ${corpus.book.title}. Strongest chunk indexes: ${evidence
          .slice(0, 3)
          .map((item) => item.chunkIndex)
          .join(", ")}.`
      : `No high-confidence passages found in ${corpus.book.title} for this query.`;

  return {
    book: corpus.book,
    runner: "worker-local-deep-scan",
    summary,
    evidence,
  };
}

async function parseQueryPayload(request: Request): Promise<{ query: string; mode: ResearchMode; topChunks: number }> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    return {
      query: url.searchParams.get("q") ?? "",
      mode: (url.searchParams.get("mode") as ResearchMode | null) ?? "fast",
      topChunks: Number(url.searchParams.get("topChunks") ?? "8"),
    };
  }

  const body = (await request.json()) as Partial<{ query: string; mode: ResearchMode; topChunks: number }>;
  return {
    query: body.query ?? "",
    mode: body.mode ?? "fast",
    topChunks: body.topChunks ?? 8,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/" || url.pathname === "/api") {
        return jsonResponse({
          name: "alphabook",
          status: "ok",
          deployed: true,
          endpoints: {
            health: "/api/health",
            search: "/api/search?q=windmills",
            research: "/api/research?q=sadness&mode=slow",
            book: "/api/book",
          },
        });
      }

      if (url.pathname === "/api/health") {
        const corpus = await loadCorpus(env, request);
        return jsonResponse({
          status: "ok",
          corpus: corpus.book,
          modes: ["fast", "slow", "naive"],
          runtime: "cloudflare-worker",
        });
      }

      if (url.pathname === "/api/book") {
        const corpus = await loadCorpus(env, request);
        return jsonResponse(corpus.book);
      }

      if (url.pathname === "/api/search") {
        const payload = await parseQueryPayload(request);
        if (!payload.query.trim()) {
          return jsonResponse({ error: "Missing query" }, 400);
        }
        const corpus = await loadCorpus(env, request);
        return jsonResponse(runSearch(corpus, payload.query, payload.topChunks));
      }

      if (url.pathname === "/api/research") {
        const payload = await parseQueryPayload(request);
        if (!payload.query.trim()) {
          return jsonResponse({ error: "Missing query" }, 400);
        }
        const corpus = await loadCorpus(env, request);
        const searchResult = runSearch(corpus, payload.query, payload.topChunks);

        if (payload.mode === "fast") {
          return jsonResponse({
            query: payload.query,
            mode: payload.mode,
            search: searchResult,
            agentRunner: "search-only",
            synthesis: `Fast pass for '${payload.query}' routed to ${corpus.book.title}.`,
          });
        }

        const agentResult = runDeepScan(corpus, payload.query, searchResult);
        return jsonResponse({
          query: payload.query,
          mode: payload.mode,
          search: searchResult,
          agentRunner: agentResult.runner,
          agents: [agentResult],
          synthesis: `Deep research for '${payload.query}': ${agentResult.summary}`,
        });
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown worker error";
      return jsonResponse({ error: message }, 500);
    }
  },
};
