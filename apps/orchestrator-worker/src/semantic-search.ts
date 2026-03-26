import { generateText, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAlphaloop } from "alphaloop";

import type { BillingContext } from "./billing";
import type { Embedder } from "./embeddings";
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

export interface SemanticSearchService {
  search(args: {
    query: string;
    workIds?: string[];
    maxResults?: number;
    billingContext?: BillingContext;
    onProgress?: (text: string, detail?: Record<string, unknown>) => Promise<void>;
  }): Promise<{
    briefing: string;
    citations: Citation[];
    chunks: ChunkSearchResult[];
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
  }));
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

function buildLanguageModel(options: SemanticSearchOptions): LanguageModel {
  if (options.googleAIApiKey) {
    const google = createGoogleGenerativeAI({
      apiKey: options.googleAIApiKey,
    });
    return google(options.googleModel ?? "gemini-2.5-flash");
  }
  if (!options.openAIApiKey) {
    throw new Error("Semantic search requires either OPENAI_API_KEY or GOOGLE_AI_API_KEY.");
  }
  const openai = createOpenAI({
    apiKey: options.openAIApiKey,
  });
  return openai(options.openAIModel ?? "gpt-5.2");
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

export class AlphaloopSemanticSearchService implements SemanticSearchService {
  private readonly model: LanguageModel;

  constructor(private readonly options: SemanticSearchOptions) {
    this.model = buildLanguageModel(options);
  }

  async search(args: {
    query: string;
    workIds?: string[];
    maxResults?: number;
    billingContext?: BillingContext;
    onProgress?: (text: string, detail?: Record<string, unknown>) => Promise<void>;
  }) {
    const loop = createAlphaloop({
      model: this.model,
      rerankModel: this.model,
      initialTopK: Math.max(40, Math.min(200, (args.maxResults ?? 8) * 10)),
      maxExpandedQueries: 6,
      maxIterations: 3,
      relevanceThreshold: 0.35,
      search: async (query, { topK }) => {
        await args.onProgress?.("Embedding the semantic query.", {
          type: "semantic.step",
          step: "embed_query",
          query,
        });
        const embedding = await withTimeout(
          this.options.embedder.embedQuery(query, args.billingContext),
          SEMANTIC_SEARCH_STEP_TIMEOUT_MS,
          "Semantic query embedding",
        );
        await args.onProgress?.("Querying the vector index.", {
          type: "semantic.step",
          step: "vector_query",
          query,
          topK: Math.max(12, Math.min(256, topK)),
        });
        const matches = await withTimeout(
          this.options.vectorIndex.query(embedding, {
            topK: Math.max(12, Math.min(256, topK)),
            returnMetadata: true,
          }),
          SEMANTIC_SEARCH_STEP_TIMEOUT_MS,
          "Semantic vector query",
        );
        const candidateIds = matches.map((match) => match.id);
        await args.onProgress?.(
          candidateIds.length > 0 ? "Loading the matched passages." : "No semantic matches came back from the vector index.",
          {
            type: "semantic.step",
            step: "hydrate_chunks",
            candidateCount: candidateIds.length,
          },
        );
        const hydrated = candidateIds.length > 0
          ? await withTimeout(
            this.options.store.getChunksByIds(candidateIds),
            SEMANTIC_SEARCH_STEP_TIMEOUT_MS,
            "Semantic chunk hydration",
          )
          : [];
        const hydratedById = new Map(hydrated.map((chunk) => [chunk.id, chunk]));
        const candidates = matches
          .map((match) => {
            const chunk = hydratedById.get(match.id);
            if (!chunk) {
              return null;
            }
            if (Array.isArray(args.workIds) && args.workIds.length > 0 && !args.workIds.includes(chunk.workId)) {
              return null;
            }
            return {
              id: chunk.id,
              text: chunk.text,
              score: match.score,
              metadata: {
                workId: chunk.workId,
                chunkIndex: chunk.chunkIndex,
                r2Key: chunk.r2Key,
                excerpt: excerptForChunk(chunk),
              },
            };
          });
        return candidates.filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk));
      },
    });

    const stream = loop.stream(args.query);
    const alphaloopEvents: AlphaloopEvent[] = [];
    let finalResult: Awaited<ReturnType<typeof loop.run>> | null = null;
    try {
      while (true) {
        const next = await stream.next();
        if (next.done) {
          finalResult = next.value;
          break;
        }
        const event = next.value as AlphaloopEvent;
        alphaloopEvents.push(structuredClone(event));
        const text = progressTextFromEvent(event);
        if (text) {
          await args.onProgress?.(text, {
            type: "semantic.alphaloop",
            event,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await args.onProgress?.(message, {
        type: "semantic.error",
        error: message,
      });
      throw error;
    }
    if (!finalResult) {
      throw new Error("Semantic retrieval completed without returning a result.");
    }

    const rankedChunkIds = finalResult.chunks.map((chunk) => chunk.id);
    const hydratedChunks = rankedChunkIds.length > 0 ? await this.options.store.getChunksByIds(rankedChunkIds) : [];
    const hydratedById = new Map(hydratedChunks.map((chunk) => [chunk.id, chunk]));
    const chunks = finalResult.chunks
      .map((ranked) => {
        const hydrated = hydratedById.get(ranked.id);
        if (!hydrated) {
          return null;
        }
        return {
          ...hydrated,
          score: ranked.relevance,
          excerpt: excerptForChunk(hydrated),
        };
      })
      .filter((chunk): chunk is ChunkSearchResult => Boolean(chunk))
      .slice(0, Math.max(4, Math.min(args.maxResults ?? 8, 12)));

    if (chunks.length === 0) {
      return {
        briefing: "I couldn’t find strong semantic matches for that question in the indexed corpus yet.",
        citations: [],
        chunks: [],
        alphaloopEvents,
        iterations: finalResult.iterations,
        totalChunksConsidered: finalResult.totalChunksConsidered,
      };
    }

    const evidence = chunks
      .map((chunk, index) => [
        `[${index + 1}] ${chunk.workId}#${chunk.chunkIndex}`,
        excerptForChunk(chunk),
      ].join("\n"))
      .join("\n\n");
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

    return {
      briefing: text.trim(),
      citations: citationsFromChunks(chunks),
      chunks,
      alphaloopEvents,
      iterations: finalResult.iterations,
      totalChunksConsidered: finalResult.totalChunksConsidered,
    };
  }
}
