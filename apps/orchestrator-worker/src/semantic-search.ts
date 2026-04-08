import { generateObject, generateText, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";

import type { BillingContext } from "./billing";
import { openAIUsageFromResponse, type BillingService } from "./billing";
import type { Embedder } from "./embeddings";
import { parseModelJsonObject } from "./json";
import type { AppStore } from "./store";
import type { Citation, ChunkSearchResult } from "@alphabook/shared";
import type { VectorSearchIndex } from "./vectorize";

type IterationRecord = {
  iteration: number;
  newQueries: string[];
  chunksFound: number;
  totalUniqueChunks: number;
};

type AlphaloopEvent = { type: string } & Record<string, unknown>;
const SEMANTIC_SEARCH_STEP_TIMEOUT_MS = 30_000;
const SEMANTIC_SEARCH_MAX_PARALLEL_SUBQUERIES = 2;
const SEMANTIC_ALPHALOOP_NEXT_TIMEOUT_MS = 45_000;
const SEMANTIC_PROGRESS_HEARTBEAT_MS = 15_000;
export type SemanticModelProvider = "openai" | "google";

export interface SemanticSearchService {
  search(args: {
    query: string;
    workIds?: string[];
    maxResults?: number;
    backend?: "alphaloop" | "context1";
    billingContext?: BillingContext;
    onProgress?: (text: string, detail?: Record<string, unknown>) => Promise<void>;
    auditLog?: (event: string, payload: Record<string, unknown>) => void | Promise<void>;
  }): Promise<{
    briefing: string;
    citations: Citation[];
    chunks: ChunkSearchResult[];
    rankedChunks: ChunkSearchResult[];
    alphaloopEvents: AlphaloopEvent[];
    iterations: IterationRecord[];
    totalChunksConsidered: number;
  }>;
}

export interface SemanticSearchOptions {
  store: AppStore;
  embedder: Embedder;
  vectorIndex: VectorSearchIndex;
  openAIApiKey?: string;
  openAIModel?: string;
  googleAIApiKey?: string;
  googleModel?: string;
}

export interface Context1SemanticSearchOptions {
  store: AppStore;
  embedder: Embedder;
  vectorIndex: VectorSearchIndex;
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTurns?: number;
  totalTokenBudget?: number;
  softTokenBudget?: number;
  hardTokenBudget?: number;
  perToolTokenBudget?: number;
  fetchImpl?: typeof fetch;
  billing?: BillingService;
}

function looksLikeExpansionQuery(originalQuery: string, candidateQuery: string) {
  return candidateQuery.trim().toLowerCase() !== originalQuery.trim().toLowerCase();
}

function excerptForChunk(chunk: ChunkSearchResult) {
  return chunk.excerpt.trim().length > 0 ? chunk.excerpt.trim() : chunk.text.trim().slice(0, 280);
}

function citationsFromChunks(chunks: ChunkSearchResult[]): Citation[] {
  return chunks.slice(0, 8).map((chunk) => ({
    workId: chunk.workId,
    chunkId: chunk.id,
    label: `${chunk.workId}#${chunk.chunkIndex}`,
    excerpt: excerptForChunk(chunk),
    ...(chunk.r2Key ? { r2Key: chunk.r2Key } : {}),
    ...(chunk.readerPath ? { readerPath: chunk.readerPath } : {}),
  }));
}

function summarizeSemanticQuery(query: string, maxLength = 96) {
  const normalized = query.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

async function withTimeoutAndHeartbeat<T>(
  promiseFactory: () => Promise<T>,
  ms: number,
  label: string,
  onHeartbeat: () => void | Promise<void>,
  intervalMs = SEMANTIC_PROGRESS_HEARTBEAT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let heartbeatInFlight = false;

  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    const settle = (handler: (value: T | Error) => void, value: T | Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      handler(value);
    };

    timeoutId = setTimeout(() => {
      settle(reject as (value: T | Error) => void, new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`));
    }, ms);

    timer = setInterval(() => {
      if (settled || heartbeatInFlight) {
        return;
      }
      heartbeatInFlight = true;
      Promise.resolve(onHeartbeat()).catch(() => {}).finally(() => {
        heartbeatInFlight = false;
      });
    }, Math.max(1, intervalMs));

    Promise.resolve()
      .then(promiseFactory)
      .then(
        (value) => settle(resolve as (value: T | Error) => void, value),
        (error) => settle(reject as (value: T | Error) => void, error instanceof Error ? error : new Error(String(error))),
      );
  });
}

function progressTextFromEvent(event: AlphaloopEvent) {
  switch (event.type) {
    case "embedding_search":
      return `Searching the semantic index for “${String(event.query ?? "").trim()}” (${Number(event.chunksFound ?? 0)} matches).`;
    case "query_expansion": {
      const variantCount = Number(event.queries && Array.isArray(event.queries) ? event.queries.length : 0);
      return `Expanded into ${variantCount} follow-up queries and found ${Number(event.newChunksFound ?? 0)} new passages.`;
    }
    case "rerank":
      return `Re-ranked ${Number(event.totalChunks ?? 0)} passages and kept ${Number(event.keptChunks ?? 0)} of them.`;
    case "iterative_search":
      return `Finished semantic pass ${Number(event.iteration ?? 0)} and found ${Number(event.newChunksFound ?? 0)} more passages.`;
    case "classifier":
      return `Filtered ${Number(event.dropped ?? 0)} weaker matches out of ${Number(event.classified ?? 0)} candidates.`;
    case "complete":
      return `Semantic retrieval finished with ${Number(event.totalChunks ?? 0)} ranked passages. Writing the answer now.`;
    case "error":
      return typeof event.message === "string" ? event.message : "Semantic retrieval failed.";
    default:
      return null;
  }
}

export function resolveSemanticModelProvider(options: SemanticSearchOptions): SemanticModelProvider {
  if (options.openAIApiKey) {
    return "openai";
  }
  if (options.googleAIApiKey) {
    return "google";
  }
  throw new Error("Semantic search requires either OPENAI_API_KEY or GOOGLE_AI_API_KEY.");
}

function buildLanguageModel(options: SemanticSearchOptions): {
  model: LanguageModel;
  provider: SemanticModelProvider;
  modelName: string;
} {
  const provider = resolveSemanticModelProvider(options);
  if (provider === "google") {
    const google = createGoogleGenerativeAI({
      apiKey: options.googleAIApiKey,
    });
    const modelName = options.googleModel ?? "gemini-2.5-flash";
    return {
      model: google(modelName),
      provider,
      modelName,
    };
  }
  const openai = createOpenAI({
    apiKey: options.openAIApiKey,
  });
  const modelName = options.openAIModel ?? "gpt-5.2";
  return {
    model: openai(modelName),
    provider,
    modelName,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Date.now() - startedAt);
}

function createConcurrencyLimiter(limit: number) {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const pump = () => {
    if (activeCount >= limit) {
      return;
    }
    const next = queue.shift();
    if (!next) {
      return;
    }
    activeCount += 1;
    next();
  };

  return {
    getActiveCount() {
      return activeCount;
    },
    getQueuedCount() {
      return queue.length;
    },
    async run<T>(task: () => Promise<T>) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
        pump();
      });
      try {
        return await task();
      } finally {
        activeCount = Math.max(0, activeCount - 1);
        pump();
      }
    },
  };
}

export class AlphaloopSemanticSearchService implements SemanticSearchService {
  private readonly model: LanguageModel;
  private readonly modelProvider: SemanticModelProvider;
  private readonly modelName: string;

  constructor(private readonly options: SemanticSearchOptions) {
    const resolvedModel = buildLanguageModel(options);
    this.model = resolvedModel.model;
    this.modelProvider = resolvedModel.provider;
    this.modelName = resolvedModel.modelName;
  }

  private async fetchSemanticMatches(
    query: string,
    topK: number,
    args: {
      workIds?: string[];
      billingContext?: BillingContext;
      auditLog?: (event: string, payload: Record<string, unknown>) => void | Promise<void>;
    },
    meta: {
      subqueryId: string;
      expansionQuery: boolean;
    },
  ) {
    const boundedTopK = Math.max(12, Math.min(256, topK));
    args.auditLog?.("semantic.search.embed.started", {
      subqueryId: meta.subqueryId,
      query,
      scopedWorkCount: Array.isArray(args.workIds) ? args.workIds.length : 0,
      expansionQuery: meta.expansionQuery,
    });
    const embedStartedAt = Date.now();
    const embedding = await withTimeout(
      this.options.embedder.embedQuery(query, args.billingContext),
      SEMANTIC_SEARCH_STEP_TIMEOUT_MS,
      "Semantic query embedding",
    );
    args.auditLog?.("semantic.search.embed.completed", {
      subqueryId: meta.subqueryId,
      query,
      elapsedMs: elapsedMs(embedStartedAt),
      dimensions: Array.isArray(embedding) ? embedding.length : 0,
      expansionQuery: meta.expansionQuery,
    });

    args.auditLog?.("semantic.search.vector_query.started", {
      subqueryId: meta.subqueryId,
      query,
      topK: boundedTopK,
      expansionQuery: meta.expansionQuery,
    });
    const vectorQueryStartedAt = Date.now();
    const matches = await withTimeout(
      this.options.vectorIndex.query(embedding, {
        topK: boundedTopK,
        returnMetadata: true,
      }),
      SEMANTIC_SEARCH_STEP_TIMEOUT_MS,
      "Semantic vector query",
    );
    args.auditLog?.("semantic.search.vector_query.completed", {
      subqueryId: meta.subqueryId,
      query,
      topK: boundedTopK,
      elapsedMs: elapsedMs(vectorQueryStartedAt),
      matchCount: matches.length,
      expansionQuery: meta.expansionQuery,
    });

    return rerankHydratedMatches(
      this.options.store,
      matches.map((match) => ({ id: match.id, score: match.score })),
      args.workIds,
    );
  }

  private async generateQueryVariants(
    originalQuery: string,
    contextChunks: ChunkSearchResult[],
    count: number,
    promptLabel: "query_expansion" | "iterative_search",
  ) {
    const schema = z.object({
      queries: z.array(z.string()),
    });
    const context = contextChunks
      .slice(0, 6)
      .map((chunk, index) => `[${index + 1}] ${excerptForChunk(chunk).slice(0, 220)}`)
      .join("\n---\n");
    const prompt = promptLabel === "query_expansion"
      ? [
          `Original query: "${originalQuery}"`,
          "",
          context.length > 0 ? `Evidence snippets:\n${context}` : "No evidence snippets were found yet.",
          "",
          `Generate ${count} distinct semantic search queries that broaden recall while staying relevant.`,
          "Focus on synonyms, related concepts, adjacent themes, and concrete phrasings found in the evidence.",
          "Return JSON only.",
        ].join("\n")
      : [
          `Original query: "${originalQuery}"`,
          "",
          `Top retrieved passages:\n${context}`,
          "",
          `Generate ${count} new search queries that follow promising themes discovered in the passages.`,
          "Return JSON only.",
        ].join("\n");
    const { object } = await generateObject({
      model: this.model,
      schema,
      prompt,
    });
    return object.queries
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  async search(args: {
    query: string;
    workIds?: string[];
    maxResults?: number;
    backend?: "alphaloop" | "context1";
    billingContext?: BillingContext;
    onProgress?: (text: string, detail?: Record<string, unknown>) => Promise<void>;
    auditLog?: (event: string, payload: Record<string, unknown>) => void | Promise<void>;
  }) {
    const searchStartedAt = Date.now();
    const maxResults = Math.max(1, Math.min(args.maxResults ?? 8, 12));
    const initialTopK = Math.max(40, Math.min(200, maxResults * 10));
    const alphaloopEvents: AlphaloopEvent[] = [];
    const seenQueries = new Set<string>();
    const retained = new Map<string, ChunkSearchResult & { rawScore: number; hitCount: number }>();
    const iterations: IterationRecord[] = [];

    const recordChunks = (chunks: ChunkSearchResult[]) => {
      let added = 0;
      for (const chunk of chunks) {
        const existing = retained.get(chunk.id);
        if (existing) {
          existing.rawScore = Math.max(existing.rawScore, chunk.score ?? 0);
          existing.hitCount += 1;
          continue;
        }
        retained.set(chunk.id, {
          ...chunk,
          excerpt: excerptForChunk(chunk),
          rawScore: chunk.score ?? 0,
          hitCount: 1,
        });
        added += 1;
      }
      return added;
    };

    args.auditLog?.("semantic.search.started", {
      query: args.query,
      scopedWorkCount: Array.isArray(args.workIds) ? args.workIds.length : 0,
      maxResults,
      modelProvider: this.modelProvider,
      modelName: this.modelName,
    });
    await args.onProgress?.(
      `Semantic search is using ${this.modelProvider === "openai" ? "OpenAI" : "Google"} ${this.modelName} to review and rank retrieved passages.`,
      {
        type: "semantic.step",
        step: "model_selected",
        modelProvider: this.modelProvider,
        modelName: this.modelName,
      },
    );
    await args.onProgress?.("Thinking mode is running semantic retrieval passes over the vector index.", {
      type: "semantic.step",
      step: "alphaloop_stream_start",
      query: args.query,
      modelProvider: this.modelProvider,
      modelName: this.modelName,
    });

    const initialChunks = await this.fetchSemanticMatches(args.query, initialTopK, args, {
      subqueryId: "sq_001",
      expansionQuery: false,
    });
    seenQueries.add(args.query.trim().toLowerCase());
    recordChunks(initialChunks);
    alphaloopEvents.push({
      type: "embedding_search",
      query: args.query,
      chunksFound: initialChunks.length,
    });

    const expansionQueries = (await this.generateQueryVariants(args.query, initialChunks, 4, "query_expansion"))
      .filter((query) => {
        const normalized = query.trim().toLowerCase();
        if (!normalized || seenQueries.has(normalized)) {
          return false;
        }
        seenQueries.add(normalized);
        return true;
      })
      .slice(0, 4);
    let expansionNewCount = 0;
    for (let index = 0; index < expansionQueries.length; index += 1) {
      const query = expansionQueries[index]!;
      const chunks = await this.fetchSemanticMatches(query, Math.ceil(initialTopK / 2), args, {
        subqueryId: `sq_${String(index + 2).padStart(3, "0")}`,
        expansionQuery: true,
      });
      expansionNewCount += recordChunks(chunks);
    }
    alphaloopEvents.push({
      type: "query_expansion",
      queries: expansionQueries,
      newChunksFound: expansionNewCount,
      totalUnique: retained.size,
    });

    const iterativeSeedChunks = [...retained.values()]
      .sort((left, right) => (right.rawScore - left.rawScore))
      .slice(0, 8);
    const iterativeQueries = iterativeSeedChunks.length > 0
      ? (await this.generateQueryVariants(args.query, iterativeSeedChunks, 3, "iterative_search"))
        .filter((query) => {
          const normalized = query.trim().toLowerCase();
          if (!normalized || seenQueries.has(normalized)) {
            return false;
          }
          seenQueries.add(normalized);
          return true;
        })
        .slice(0, 3)
      : [];
    let iterativeNewCount = 0;
    for (let index = 0; index < iterativeQueries.length; index += 1) {
      const query = iterativeQueries[index]!;
      const chunks = await this.fetchSemanticMatches(query, Math.ceil(initialTopK / 3), args, {
        subqueryId: `sq_${String(index + expansionQueries.length + 2).padStart(3, "0")}`,
        expansionQuery: true,
      });
      iterativeNewCount += recordChunks(chunks);
    }
    iterations.push({
      iteration: 1,
      newQueries: iterativeQueries,
      chunksFound: iterativeNewCount,
      totalUniqueChunks: retained.size,
    });
    alphaloopEvents.push({
      type: "iterative_search",
      iteration: 1,
      newQueries: iterativeQueries,
      newChunksFound: iterativeNewCount,
      totalUnique: retained.size,
    });

    const rankedChunks = [...retained.values()]
      .map((chunk) => ({
        ...chunk,
        score: lexicalRerankScore(
          args.query,
          chunk,
          chunk.rawScore + ((chunk.hitCount - 1) * 0.05),
        ),
      }))
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
    const chunks = rankedChunks.slice(0, Math.max(4, maxResults));
    alphaloopEvents.push({
      type: "rerank",
      totalChunks: retained.size,
      keptChunks: rankedChunks.length,
      droppedChunks: 0,
      topChunkPreview: rankedChunks[0]?.excerpt.slice(0, 100),
    });
    alphaloopEvents.push({
      type: "complete",
      totalChunks: rankedChunks.length,
      iterations: iterations.length,
    });

    if (chunks.length === 0) {
      args.auditLog?.("semantic.search.completed_without_chunks", {
        query: args.query,
        elapsedMs: elapsedMs(searchStartedAt),
        totalChunksConsidered: retained.size,
        iterationCount: iterations.length,
      });
      return {
        briefing: "I couldn’t find strong semantic matches for that question in the indexed corpus yet.",
        citations: [],
        chunks: [],
        rankedChunks: [],
        alphaloopEvents,
        iterations,
        totalChunksConsidered: retained.size,
      };
    }

    const evidence = chunks
      .map((chunk, index) => [
        `[${index + 1}] ${chunk.workId}#${chunk.chunkIndex}`,
        excerptForChunk(chunk),
      ].join("\n"))
      .join("\n\n");
    args.auditLog?.("semantic.search.answer.started", {
      query: args.query,
      chunkCount: chunks.length,
    });
    await args.onProgress?.("AlphaLoop finished ranking passages. Writing the answer from the strongest evidence.", {
      type: "semantic.step",
      step: "write_answer",
      chunkCount: chunks.length,
    });
    const { text } = await generateText({
      model: this.model,
      prompt: [
        "You are writing AlphaBook semantic-search answers.",
        "Use only the supplied excerpts.",
        "Answer directly in 2-4 short paragraphs.",
        "Call out uncertainty instead of inventing support.",
        "Do not mention internal retrieval systems or planning.",
        "",
        `User question: ${args.query}`,
        "",
        "Evidence:",
        evidence,
      ].join("\n"),
    });
    args.auditLog?.("semantic.search.answer.completed", {
      query: args.query,
      chunkCount: chunks.length,
      elapsedMs: elapsedMs(searchStartedAt),
      answerLength: text.trim().length,
    });

    return {
      briefing: text.trim(),
      citations: citationsFromChunks(chunks),
      chunks,
      rankedChunks,
      alphaloopEvents,
      iterations,
      totalChunksConsidered: retained.size,
    };
  }
}

type Context1Action =
  | { type: "search_corpus"; query: string }
  | { type: "grep_corpus"; pattern: string }
  | { type: "read_document"; docId: string }
  | { type: "prune_chunks"; chunkIds: string[] }
  | { type: "final"; selectedChunkIds?: string[]; answer?: string };

type Context1RetainedChunk = {
  chunk: ChunkSearchResult;
  score: number;
  source: string;
};

type Context1ObservedChunk = {
  id: string;
  workId: string;
  chunkIndex: number;
  score: number;
  excerpt: string;
  tokenEstimate: number;
};

function estimateTokenCount(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}

function reciprocalRankFusion(ranks: number[]) {
  return ranks.reduce((sum, rank) => sum + (1 / (60 + rank)), 0);
}

function lexicalRerankScore(query: string, chunk: ChunkSearchResult, rrfScore: number) {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedExcerpt = excerptForChunk(chunk).trim().toLowerCase();
  const normalizedText = chunk.text.trim().toLowerCase();
  const exactPhraseBonus = normalizedQuery.length > 0 && normalizedText.includes(normalizedQuery) ? 2 : 0;
  const excerptBonus = normalizedQuery.length > 0 && normalizedExcerpt.includes(normalizedQuery) ? 1 : 0;
  const overlap = normalizedQuery
    .split(/\s+/u)
    .filter((token) => token.length >= 4)
    .reduce((count, token) => (normalizedText.includes(token) ? count + 1 : count), 0);
  return (rrfScore * 10) + exactPhraseBonus + excerptBonus + overlap;
}

function parseContext1Action(content: string): Context1Action {
  const parsed = parseModelJsonObject<Record<string, unknown>>(content);
  if (parsed.type === "search_corpus" && typeof parsed.query === "string" && parsed.query.trim()) {
    return { type: "search_corpus", query: parsed.query.trim() };
  }
  if (parsed.type === "grep_corpus" && typeof parsed.pattern === "string" && parsed.pattern.trim()) {
    return { type: "grep_corpus", pattern: parsed.pattern.trim() };
  }
  if (parsed.type === "read_document" && typeof parsed.docId === "string" && parsed.docId.trim()) {
    return { type: "read_document", docId: parsed.docId.trim() };
  }
  if (parsed.type === "prune_chunks" && Array.isArray(parsed.chunkIds)) {
    return {
      type: "prune_chunks",
      chunkIds: parsed.chunkIds.filter((value): value is string => typeof value === "string").slice(0, 24),
    };
  }
  if (parsed.type === "final") {
    return {
      type: "final",
      selectedChunkIds: Array.isArray(parsed.selectedChunkIds)
        ? parsed.selectedChunkIds.filter((value): value is string => typeof value === "string").slice(0, 12)
        : undefined,
      answer: typeof parsed.answer === "string" ? parsed.answer.trim() : undefined,
    };
  }
  throw new Error("Context-1 action response was not a supported JSON action.");
}

async function rerankHydratedMatches(
  store: AppStore,
  matches: Array<{ id: string; score: number }>,
  workIds?: string[],
) {
  const hydrated = matches.length > 0 ? await store.getChunksByIds(matches.map((match) => match.id)) : [];
  const hydratedById = new Map(hydrated.map((chunk) => [chunk.id, chunk]));
  return matches
    .map((match) => {
      const chunk = hydratedById.get(match.id);
      if (!chunk) {
        return null;
      }
      if (Array.isArray(workIds) && workIds.length > 0 && !workIds.includes(chunk.workId)) {
        return null;
      }
      return {
        ...chunk,
        score: match.score,
        excerpt: excerptForChunk(chunk),
      };
    })
    .filter((chunk): chunk is ChunkSearchResult => Boolean(chunk));
}

export class Context1SemanticSearchService implements SemanticSearchService {
  private readonly maxTurns: number;
  private readonly totalTokenBudget: number;
  private readonly softTokenBudget: number;
  private readonly hardTokenBudget: number;
  private readonly perToolTokenBudget: number;
  private readonly responseReserveTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: Context1SemanticSearchOptions) {
    this.maxTurns = Math.max(2, options.maxTurns ?? 8);
    this.totalTokenBudget = Math.max(4_096, options.totalTokenBudget ?? 32_768);
    this.softTokenBudget = Math.max(2_048, Math.min(this.totalTokenBudget - 512, options.softTokenBudget ?? 24_576));
    this.hardTokenBudget = Math.max(this.softTokenBudget + 256, Math.min(this.totalTokenBudget, options.hardTokenBudget ?? 30_720));
    this.perToolTokenBudget = Math.max(512, options.perToolTokenBudget ?? 4_096);
    this.responseReserveTokens = Math.max(256, Math.min(1_024, Math.floor(this.totalTokenBudget * 0.05)));
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  private retainedTokenUsage(retained: Map<string, Context1RetainedChunk>) {
    let total = 0;
    for (const { chunk } of retained.values()) {
      total += estimateTokenCount(chunk.text) + 32;
    }
    return total;
  }

  private summarizeRetained(retained: Map<string, Context1RetainedChunk>) {
    return [...retained.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, 12)
      .map(({ chunk, score, source }) => ({
        id: chunk.id,
        workId: chunk.workId,
        chunkIndex: chunk.chunkIndex,
        score: Number(score.toFixed(4)),
        source,
        excerpt: excerptForChunk(chunk).slice(0, 280),
      }));
  }

  private formatTokenUsageObservation(retained: Map<string, Context1RetainedChunk>) {
    const used = this.retainedTokenUsage(retained);
    return `[Token usage: ${used.toLocaleString()}/${this.totalTokenBudget.toLocaleString()}]`;
  }

  private truncateChunksToBudget(chunks: ChunkSearchResult[], tokenBudget: number): {
    chunks: Context1ObservedChunk[];
    consumedTokens: number;
    truncated: boolean;
  } {
    const observed: Context1ObservedChunk[] = [];
    let consumedTokens = 0;
    let truncated = false;
    for (const chunk of chunks) {
      const excerpt = excerptForChunk(chunk);
      const tokenEstimate = estimateTokenCount(excerpt) + 24;
      if (observed.length > 0 && consumedTokens + tokenEstimate > tokenBudget) {
        truncated = true;
        break;
      }
      observed.push({
        id: chunk.id,
        workId: chunk.workId,
        chunkIndex: chunk.chunkIndex,
        score: Number((chunk.score ?? 0).toFixed(4)),
        excerpt,
        tokenEstimate,
      });
      consumedTokens += tokenEstimate;
    }
    return { chunks: observed, consumedTokens, truncated };
  }

  private async inferAction(args: {
    query: string;
    turn: number;
    workIds?: string[];
    retained: Map<string, Context1RetainedChunk>;
    observations: Array<Record<string, unknown>>;
    encounteredCount: number;
    billingContext?: BillingContext;
  }) {
    const body = {
      model: this.options.model,
      response_format: { type: "json_object" as const },
      messages: [
        {
          role: "system",
          content: [
            "You are AlphaBook Context-1 mode, a retrieval subagent.",
            "Do not answer the user directly unless you choose the final action.",
            "Use only these tools: search_corpus, grep_corpus, read_document, prune_chunks, final.",
            "search_corpus should broaden or refine discovery using semantic + lexical retrieval.",
            "grep_corpus should look for exact phrases, names, or regex-like patterns.",
            "read_document should drill into one book when you need more evidence from it.",
            "prune_chunks should remove lower-value chunks when token pressure rises.",
            "Return exactly one JSON object for the next action.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Choose the next retrieval action.",
            query: args.query,
            turn: args.turn,
            maxTurns: this.maxTurns,
            workIds: args.workIds ?? [],
            tokenUsage: {
              used: this.retainedTokenUsage(args.retained),
              total: this.totalTokenBudget,
              soft: this.softTokenBudget,
              hard: this.hardTokenBudget,
            },
            encounteredChunkCount: args.encounteredCount,
            retainedChunks: this.summarizeRetained(args.retained),
            recentObservations: args.observations.slice(-6),
            outputSchema: {
              type: "search_corpus | grep_corpus | read_document | prune_chunks | final",
              query: "string for search_corpus",
              pattern: "string for grep_corpus",
              docId: "work id for read_document",
              chunkIds: ["chunk ids for prune_chunks"],
              selectedChunkIds: ["best chunk ids for final"],
              answer: "optional short retrieval note for final",
            },
          }),
        },
      ],
    };
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEMANTIC_ALPHALOOP_NEXT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Context-1 request failed: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, unknown>;
      id?: string;
    };
    if (this.options.billing && args.billingContext) {
      const usage = openAIUsageFromResponse(payload as Record<string, unknown>);
      if (usage) {
        await this.options.billing.track(args.billingContext, {
          provider: "openai-compatible",
          model: this.options.model,
          operation: "chat.completions.create",
          ...usage,
          requestId: payload.id ?? null,
          requestJson: body as unknown as Record<string, unknown>,
          responseJson: { usage: payload.usage ?? null },
          metadata: { phase: "semantic_search", backend: "context1" },
        });
      }
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Context-1 returned an empty action.");
    }
    return parseContext1Action(content);
  }

  private async searchCorpus(query: string, workIds: string[] | undefined, encounteredChunkIds: Set<string>) {
    const embedding = await withTimeout(
      this.options.embedder.embedQuery(query),
      SEMANTIC_SEARCH_STEP_TIMEOUT_MS,
      "Context-1 query embedding",
    );
    const [vectorMatches, lexicalMatches] = await Promise.all([
      this.options.vectorIndex.query(embedding, {
        topK: 50,
      }),
      this.options.store.getRelevantChunks(query, workIds, 50, undefined),
    ]);
    const fused = new Map<string, { id: string; ranks: number[]; vectorScore?: number; lexicalScore?: number }>();
    for (const [index, match] of vectorMatches.entries()) {
      if (encounteredChunkIds.has(match.id)) {
        continue;
      }
      const entry = fused.get(match.id) ?? { id: match.id, ranks: [] };
      entry.ranks.push(index + 1);
      entry.vectorScore = match.score;
      fused.set(match.id, entry);
    }
    for (const [index, chunk] of lexicalMatches.entries()) {
      if (encounteredChunkIds.has(chunk.id)) {
        continue;
      }
      const entry = fused.get(chunk.id) ?? { id: chunk.id, ranks: [] };
      entry.ranks.push(index + 1);
      entry.lexicalScore = chunk.score;
      fused.set(chunk.id, entry);
    }
    const hydrated = await rerankHydratedMatches(
      this.options.store,
      [...fused.values()]
        .map((entry) => ({
          id: entry.id,
          score: reciprocalRankFusion(entry.ranks),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, 50),
      workIds,
    );
    return hydrated
      .map((chunk) => ({
        ...chunk,
        score: lexicalRerankScore(query, chunk, chunk.score ?? 0),
      }))
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  }

  private async grepCorpus(pattern: string, workIds: string[] | undefined, encounteredChunkIds: Set<string>) {
    const probeWorks = workIds?.length
      ? await this.options.store.getWorkMetadata(workIds.slice(0, 12))
      : await this.options.store.searchWorks(pattern, { limit: 12 });
    let matcher: RegExp | null = null;
    try {
      matcher = new RegExp(pattern, "iu");
    } catch {
      matcher = null;
    }
    const results: ChunkSearchResult[] = [];
    for (const work of probeWorks.slice(0, 8)) {
      const chunks = await this.options.store.getRelevantChunks(pattern, [work.id], 12, undefined);
      for (const chunk of chunks) {
        if (encounteredChunkIds.has(chunk.id)) {
          continue;
        }
        if (matcher && !matcher.test(chunk.text) && !matcher.test(chunk.excerpt)) {
          continue;
        }
        results.push({
          ...chunk,
          excerpt: excerptForChunk(chunk),
          score: chunk.score,
        });
        if (results.length >= 5) {
          return results;
        }
      }
    }
    return results.slice(0, 5);
  }

  private async readDocument(docId: string, query: string, encounteredChunkIds: Set<string>) {
    const anchorChunks = await this.options.store.getRelevantChunks(query, [docId], 4, undefined);
    const hydrated: ChunkSearchResult[] = [];
    for (const anchor of anchorChunks) {
      for (const offset of [-1, 0, 1]) {
        const candidate = await this.options.store.getChunkByWorkAndIndex(docId, anchor.chunkIndex + offset);
        if (!candidate || encounteredChunkIds.has(candidate.id)) {
          continue;
        }
        hydrated.push({
          ...candidate,
          excerpt: excerptForChunk(candidate),
          score: anchor.score,
        });
      }
    }
    return hydrated
      .map((chunk) => ({
        ...chunk,
        score: lexicalRerankScore(query, chunk, chunk.score ?? 0),
      }))
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, 16);
  }

  async search(args: {
    query: string;
    workIds?: string[];
    maxResults?: number;
    backend?: "alphaloop" | "context1";
    billingContext?: BillingContext;
    onProgress?: (text: string, detail?: Record<string, unknown>) => Promise<void>;
    auditLog?: (event: string, payload: Record<string, unknown>) => void | Promise<void>;
  }) {
    const retained = new Map<string, Context1RetainedChunk>();
    const encounteredChunkIds = new Set<string>();
    const trajectoryRecallIds = new Set<string>();
    const observations: Array<Record<string, unknown>> = [];
    const events: AlphaloopEvent[] = [];
    const iterations: IterationRecord[] = [];
    const maxResults = Math.max(1, Math.min(args.maxResults ?? 8, 12));
    let finalAction: Extract<Context1Action, { type: "final" }> | null = null;

    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      const usedTokens = this.retainedTokenUsage(retained);
      observations.push({
        type: "token_usage",
        message: this.formatTokenUsageObservation(retained),
        usedTokens,
        totalTokens: this.totalTokenBudget,
      });
      args.auditLog?.("semantic.search.context1.turn.started", {
        query: args.query,
        turn,
        retainedChunkCount: retained.size,
        encounteredChunkCount: encounteredChunkIds.size,
        usedTokens,
      });
      if (usedTokens >= this.softTokenBudget) {
        observations.push({
          type: "soft_threshold",
          message: "Token usage is above the soft threshold. Prune chunks or conclude if you have enough evidence.",
          usedTokens,
          softThreshold: this.softTokenBudget,
        });
        await args.onProgress?.("Context-1 mode is near its evidence budget and may prune weaker chunks.", {
          type: "semantic.context1",
          event: { type: "token_budget", usedTokens, totalTokens: this.totalTokenBudget },
        });
      }
      const action = await this.inferAction({
        query: args.query,
        turn,
        workIds: args.workIds,
        retained,
        observations,
        encounteredCount: encounteredChunkIds.size,
        billingContext: args.billingContext,
      });
      events.push({ type: "context1_action", turn, actionType: action.type });
      if (action.type === "final") {
        finalAction = action;
        break;
      }
      if (usedTokens >= this.hardTokenBudget && action.type !== "prune_chunks") {
        observations.push({
          type: "tool_error",
          tool: action.type,
          message: "Hard token cutoff reached. Prune chunks or conclude.",
        });
        events.push({ type: "hard_cutoff_reject", turn, actionType: action.type });
        continue;
      }
      if (action.type === "prune_chunks") {
        for (const chunkId of action.chunkIds) {
          retained.delete(chunkId);
        }
        observations.push({
          type: "prune_chunks",
          chunkIds: action.chunkIds,
          retainedChunkCount: retained.size,
        });
        await args.onProgress?.(`Pruned ${action.chunkIds.length} weaker chunks to keep the search moving.`, {
          type: "semantic.context1",
          event: { type: "prune_chunks", chunkIds: action.chunkIds },
        });
        continue;
      }

      let freshChunks: ChunkSearchResult[] = [];
      let source = "";
      if (action.type === "search_corpus") {
        source = action.query;
        await args.onProgress?.(`Context-1 searching the corpus for “${action.query}”.`, {
          type: "semantic.context1",
          event: { type: "search_corpus", query: action.query },
        });
        freshChunks = await this.searchCorpus(action.query, args.workIds, encounteredChunkIds);
      } else if (action.type === "grep_corpus") {
        source = action.pattern;
        await args.onProgress?.(`Context-1 running exact-match search for “${action.pattern}”.`, {
          type: "semantic.context1",
          event: { type: "grep_corpus", pattern: action.pattern },
        });
        freshChunks = await this.grepCorpus(action.pattern, args.workIds, encounteredChunkIds);
      } else if (action.type === "read_document") {
        source = action.docId;
        await args.onProgress?.(`Context-1 drilling into ${action.docId}.`, {
          type: "semantic.context1",
          event: { type: "read_document", docId: action.docId },
        });
        freshChunks = await this.readDocument(action.docId, args.query, encounteredChunkIds);
      }

      const remainingBudget = Math.max(
        0,
        Math.min(
          this.perToolTokenBudget,
          this.totalTokenBudget - this.retainedTokenUsage(retained) - this.responseReserveTokens,
        ),
      );
      const truncatedToolResult = this.truncateChunksToBudget(freshChunks, remainingBudget);
      let addedChunks = 0;
      for (const observed of truncatedToolResult.chunks) {
        const chunk = freshChunks.find((candidate) => candidate.id === observed.id);
        if (!chunk) {
          continue;
        }
        encounteredChunkIds.add(chunk.id);
        trajectoryRecallIds.add(chunk.id);
        retained.set(chunk.id, {
          chunk,
          score: chunk.score ?? 0,
          source,
        });
        addedChunks += 1;
      }
      observations.push({
        type: action.type,
        source,
        query: action.type === "search_corpus" ? action.query : undefined,
        pattern: action.type === "grep_corpus" ? action.pattern : undefined,
        docId: action.type === "read_document" ? action.docId : undefined,
        returnedChunks: truncatedToolResult.chunks,
        totalRetainedChunks: retained.size,
        returnedChunkCount: truncatedToolResult.chunks.length,
        truncated: truncatedToolResult.truncated,
        consumedTokens: truncatedToolResult.consumedTokens,
        tokenBudget: remainingBudget,
        tokenUsage: this.formatTokenUsageObservation(retained),
      });
      iterations.push({
        iteration: turn,
        newQueries: [source],
        chunksFound: addedChunks,
        totalUniqueChunks: trajectoryRecallIds.size,
      });
    }

    const rankedChunks = [...retained.values()]
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.chunk);
    const selectedChunks = Array.isArray(finalAction?.selectedChunkIds) && finalAction.selectedChunkIds.length > 0
      ? finalAction.selectedChunkIds
        .map((chunkId) => retained.get(chunkId)?.chunk ?? null)
        .filter((chunk): chunk is ChunkSearchResult => Boolean(chunk))
      : [];
    const chunks = (selectedChunks.length > 0 ? selectedChunks : rankedChunks).slice(0, maxResults);
    if (chunks.length === 0) {
      return {
        briefing: "I couldn’t find strong matches in Context-1 mode yet.",
        citations: [],
        chunks: [],
        rankedChunks: [],
        alphaloopEvents: events,
        iterations,
        totalChunksConsidered: encounteredChunkIds.size,
      };
    }
    const briefing = finalAction?.answer && finalAction.answer.length > 0
      ? finalAction.answer
      : [
          "Context-1 mode searched iteratively and kept the strongest passages after pruning weaker ones.",
          `It retained ${chunks.length} top passages across ${new Set(chunks.map((chunk) => chunk.workId)).size} books.`,
        ].join(" ");
    return {
      briefing,
      citations: citationsFromChunks(chunks),
      chunks,
      rankedChunks,
      alphaloopEvents: events,
      iterations,
      totalChunksConsidered: encounteredChunkIds.size,
    };
  }
}

export class DelegatingSemanticSearchService implements SemanticSearchService {
  constructor(
    private readonly backends: {
      alphaloop?: SemanticSearchService;
      context1?: SemanticSearchService;
    },
    private readonly defaultBackend: "alphaloop" | "context1" = "alphaloop",
  ) {}

  async search(args: {
    query: string;
    workIds?: string[];
    maxResults?: number;
    backend?: "alphaloop" | "context1";
    billingContext?: BillingContext;
    onProgress?: (text: string, detail?: Record<string, unknown>) => Promise<void>;
    auditLog?: (event: string, payload: Record<string, unknown>) => void | Promise<void>;
  }) {
    const backend = args.backend ?? this.defaultBackend;
    const service = backend === "context1" ? this.backends.context1 : this.backends.alphaloop;
    if (!service) {
      throw new Error(`${backend} semantic backend is not configured.`);
    }
    return service.search(args);
  }
}
