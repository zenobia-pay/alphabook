import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  BenchmarkCorpus,
  BenchmarkPassage,
  BenchmarkQuery,
  RetrievalHit,
  Retriever,
  RetrieverContext,
  RetrieverResult,
} from "./types";
import { expandQueryTerms } from "./expansion";
import type { JudgedPassageScore, PassageJudge } from "./llm";
import { tokenize, uniqueTokens } from "./tokenize";

const execFileAsync = promisify(execFile);

function matchesFilters(passage: BenchmarkPassage, corpus: BenchmarkCorpus, filters?: Record<string, unknown>) {
  if (!filters) {
    return true;
  }
  const document = corpus.documents.find((entry) => entry.id === passage.documentId);
  if (!document) {
    return true;
  }
  for (const [key, value] of Object.entries(filters)) {
    const passageValue = passage.metadata?.[key];
    const documentValue = document.metadata?.[key];
    if (passageValue === value || documentValue === value) {
      continue;
    }
    return false;
  }
  return true;
}

function scorePassage(passage: BenchmarkPassage, terms: string[]): number {
  const haystack = `${passage.text}\n${passage.excerpt}`.toLowerCase();
  return uniqueTokens(terms).reduce((total, term) => total + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function toHit(passage: BenchmarkPassage, score: number): RetrievalHit {
  return {
    passageId: passage.id,
    documentId: passage.documentId,
    score,
    text: passage.excerpt,
    metadata: passage.metadata,
  };
}

function sortHits(hits: RetrievalHit[]): RetrievalHit[] {
  return hits.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.passageId.localeCompare(right.passageId);
  });
}

function jsScan(query: BenchmarkQuery, context: RetrieverContext, terms: string[]): RetrieverResult {
  const filtered = context.corpus.passages.filter((passage) => matchesFilters(passage, context.corpus, query.filters));
  const hits = filtered
    .map((passage) => ({ passage, score: scorePassage(passage, terms) }))
    .filter((entry) => entry.score > 0)
    .map((entry) => toHit(entry.passage, entry.score));

  return {
    hits: sortHits(hits),
    resourceUsage: {
      scannedPassages: filtered.length,
      bytesReadApprox: filtered.reduce((total, passage) => total + passage.text.length, 0),
    },
    trace: [`fallback=js-scan terms=${terms.join(",")}`],
  };
}

async function rgScan(query: BenchmarkQuery, context: RetrieverContext, terms: string[], shardCount = 1): Promise<RetrieverResult> {
  const root = await mkdtemp(path.join(tmpdir(), "alphabook-benchmark-"));
  const trace = [`engine=rg shardCount=${shardCount}`];
  try {
    const filtered = context.corpus.passages.filter((passage) => matchesFilters(passage, context.corpus, query.filters));
    const passagesWithShard = filtered.map((passage, index) => ({
      passage,
      shardIndex: index % shardCount,
    }));

    await Promise.all(passagesWithShard.map(async ({ passage, shardIndex }) => {
      const shardDir = path.join(root, `shard-${String(shardIndex).padStart(2, "0")}`);
      const documentDir = path.join(shardDir, passage.documentId);
      await mkdir(documentDir, { recursive: true });
      await writeFile(path.join(documentDir, `${passage.id}.txt`), passage.text, { encoding: "utf8" });
    }));

    const pattern = uniqueTokens(terms).join("|");
    const shardRoots = Array.from({ length: shardCount }, (_, index) =>
      path.join(root, `shard-${String(index).padStart(2, "0")}`),
    );
    const results = await Promise.all(shardRoots.map(async (shardRoot) => {
      try {
        const { stdout } = await execFileAsync("rg", ["-i", "-n", "-e", pattern, shardRoot], {
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        });
        return stdout;
      } catch (error) {
        const exitCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (exitCode === 1) {
          return "";
        }
        throw error;
      }
    }));

    const scoreMap = new Map<string, number>();
    for (const stdout of results) {
      for (const line of stdout.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        const match = line.match(/([^:\n]+)\.txt:\d+:(.*)$/u);
        if (!match) {
          continue;
        }
        const passageId = path.basename(match[1] ?? "", ".txt");
        const text = (match[2] ?? "").toLowerCase();
        const increment = uniqueTokens(terms).reduce((total, term) => total + (text.includes(term.toLowerCase()) ? 1 : 0), 0);
        scoreMap.set(passageId, (scoreMap.get(passageId) ?? 0) + Math.max(1, increment));
      }
    }

    const hits = context.corpus.passages
      .filter((passage) => scoreMap.has(passage.id))
      .map((passage) => toHit(passage, scoreMap.get(passage.id) ?? 0));

    trace.push(`pattern=${pattern}`);
    return {
      hits: sortHits(hits),
      resourceUsage: {
        scannedPassages: filtered.length,
        shardCount,
        bytesReadApprox: filtered.reduce((total, passage) => total + passage.text.length, 0),
      },
      trace,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace.push(`fallback=js-scan reason=${message}`);
    const fallback = jsScan(query, context, terms);
    return {
      ...fallback,
      trace: [...trace, ...(fallback.trace ?? [])],
      resourceUsage: {
        ...fallback.resourceUsage,
        shardCount,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function createCliExactRetriever(): Retriever {
  return {
    id: "cli-exact",
    displayName: "CLI Exact Lexical",
    kind: "cli",
    async retrieve(query, context) {
      return rgScan(query, context, tokenize(query.text));
    },
  };
}

export function createCliExpandedRetriever(): Retriever {
  return {
    id: "cli-expanded",
    displayName: "CLI Expanded Lexical",
    kind: "cli",
    async retrieve(query, context) {
      return rgScan(query, context, expandQueryTerms(query.text));
    },
  };
}

export function createDistributedCliRetriever(shardCount = 4): Retriever {
  return {
    id: `distributed-cli-${shardCount}`,
    displayName: `Distributed CLI (${shardCount} shards)`,
    kind: "distributed-cli",
    async retrieve(query, context) {
      return rgScan(query, context, expandQueryTerms(query.text), shardCount);
    },
  };
}

function createInMemoryRetriever(
  id: string,
  displayName: string,
  kind: Retriever["kind"],
  scorer: (passage: BenchmarkPassage, query: BenchmarkQuery, corpus: BenchmarkCorpus) => number,
): Retriever {
  return {
    id,
    displayName,
    kind,
    async retrieve(query, context) {
      const filtered = context.corpus.passages.filter((passage) => matchesFilters(passage, context.corpus, query.filters));
      const hits = filtered
        .map((passage) => ({ passage, score: scorer(passage, query, context.corpus) }))
        .filter((entry) => entry.score > 0)
        .map((entry) => toHit(entry.passage, entry.score));
      return {
        hits: sortHits(hits),
        resourceUsage: {
          scannedPassages: filtered.length,
          bytesReadApprox: filtered.reduce((total, passage) => total + passage.text.length, 0),
        },
        trace: [`engine=in-memory retriever=${id}`],
      };
    },
  };
}

export function createBm25LiteRetriever(): Retriever {
  return createInMemoryRetriever("bm25-lite", "BM25 Lite", "sparse", (passage, query) => {
    const terms = tokenize(query.text);
    return scorePassage(passage, terms) / Math.sqrt(Math.max(1, tokenize(passage.text).length));
  });
}

export function createSemanticLiteRetriever(): Retriever {
  return createInMemoryRetriever("semantic-lite", "Semantic Lite", "dense", (passage, query) => {
    const terms = expandQueryTerms(query.text);
    return scorePassage(passage, terms);
  });
}

export function createHybridLiteRetriever(): Retriever {
  return createInMemoryRetriever("hybrid-lite", "Hybrid Lite", "hybrid", (passage, query) => {
    const lexical = scorePassage(passage, tokenize(query.text));
    const expanded = scorePassage(passage, expandQueryTerms(query.text));
    return (lexical * 0.6) + (expanded * 0.4);
  });
}

export function createComprehensiveLLMRetriever(input: {
  judge: PassageJudge;
  batchSize?: number;
  minScore?: number;
}): Retriever {
  const { judge, batchSize = 8, minScore = 0.05 } = input;

  async function judgeWithAdaptiveBatching(
    query: BenchmarkQuery,
    passages: BenchmarkPassage[],
    currentBatchSize: number,
    traces: string[],
  ): Promise<JudgedPassageScore[]> {
    const judged: JudgedPassageScore[] = [];

    for (let index = 0; index < passages.length; index += currentBatchSize) {
      const batch = passages.slice(index, index + currentBatchSize);
      try {
        const batchResult = await judge.judgeBatch({ query, passages: batch });
        traces.push(`batch=${Math.floor(index / currentBatchSize) + 1} size=${batch.length}`);
        judged.push(...batchResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const likelyOversized = /status 400|context|maximum context|too large|token|timed out|timeout|no content|empty response|unexpected end|json/i.test(message);
        const likelyTransient = /timed out|timeout|429|5\d\d|rate limit/i.test(message);
        if (likelyTransient && batch.length <= 1) {
          traces.push(`batch_fallback_zero size=${batch.length} reason=${message}`);
          judged.push(...batch.map((passage) => ({
            passageId: passage.id,
            score: 0,
            rationale: `fallback-zero: ${message}`,
          })));
          continue;
        }
        if (!likelyOversized || batch.length <= 1) {
          throw error;
        }
        const nextBatchSize = Math.max(1, Math.floor(batch.length / 2));
        traces.push(`batch_split original_size=${batch.length} next_batch_size=${nextBatchSize} reason=${message}`);
        judged.push(...await judgeWithAdaptiveBatching(query, batch, nextBatchSize, traces));
      }
    }

    return judged;
  }

  return {
    id: `comprehensive-${judge.id}`,
    displayName: `Comprehensive LLM (${judge.id})`,
    kind: "llm-exhaustive",
    async retrieve(query, context) {
      const filtered = context.corpus.passages.filter((passage) => matchesFilters(passage, context.corpus, query.filters));
      const traces = [
        `engine=llm-exhaustive judge=${judge.id}`,
        `batchSize=${batchSize}`,
      ];
      const scoreMap = new Map<string, number>();
      const rationales = new Map<string, string>();

      const judged = await judgeWithAdaptiveBatching(query, filtered, batchSize, traces);
      for (const item of judged) {
        scoreMap.set(item.passageId, item.score);
        if (item.rationale) {
          rationales.set(item.passageId, item.rationale);
        }
      }

      const hits = filtered
        .map((passage) => ({
          passage,
          score: scoreMap.get(passage.id) ?? 0,
        }))
        .filter((entry) => entry.score >= minScore)
        .map((entry) => toHit(entry.passage, entry.score));

      for (const hit of hits) {
        const rationale = rationales.get(hit.passageId);
        if (rationale) {
          hit.metadata = {
            ...(hit.metadata ?? {}),
            rationale,
          };
        }
      }

      return {
        hits: sortHits(hits),
        resourceUsage: {
          scannedPassages: filtered.length,
          bytesReadApprox: filtered.reduce((total, passage) => total + passage.text.length, 0),
        },
        trace: traces,
      };
    },
  };
}
