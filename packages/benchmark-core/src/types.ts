import type { CorpusChunk, CorpusDocument } from "@alphabook/corpus-core";

export type QueryFamily =
  | "lexical-easy"
  | "paraphrase"
  | "associative"
  | "multi-hop-thematic"
  | "constraint-heavy";

export type RelevanceGrade = 0 | 1 | 2;

export interface BenchmarkPassage extends CorpusChunk {
  metadata?: Record<string, unknown> & {
    year?: number;
    tags?: string[];
    shardHint?: string;
  };
}

export interface BenchmarkDocument extends CorpusDocument {
  metadata?: Record<string, unknown> & {
    year?: number;
    sourceType?: string;
    tags?: string[];
  };
}

export interface BenchmarkCorpus {
  id: string;
  displayName: string;
  description: string;
  documents: BenchmarkDocument[];
  passages: BenchmarkPassage[];
}

export interface BenchmarkLabel {
  passageId: string;
  grade: RelevanceGrade;
}

export interface BenchmarkQuery {
  id: string;
  text: string;
  family: QueryFamily;
  filters?: Record<string, unknown>;
  labels: BenchmarkLabel[];
  notes?: string;
}

export interface QuerySet {
  id: string;
  version: string;
  description: string;
  queries: BenchmarkQuery[];
}

export interface RetrievalHit {
  passageId: string;
  documentId: string;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RetrieverResourceUsage {
  scannedPassages?: number;
  shardCount?: number;
  machineSeconds?: number;
  bytesReadApprox?: number;
}

export interface RetrieverResult {
  hits: RetrievalHit[];
  setupTimeMs?: number;
  resourceUsage?: RetrieverResourceUsage;
  trace?: string[];
}

export interface RetrieverContext {
  corpus: BenchmarkCorpus;
}

export interface Retriever {
  id: string;
  displayName: string;
  kind: "cli" | "distributed-cli" | "sparse" | "dense" | "hybrid";
  prepare?(context: RetrieverContext): Promise<{ setupTimeMs?: number; trace?: string[] } | void>;
  retrieve(query: BenchmarkQuery, context: RetrieverContext): Promise<RetrieverResult>;
}

export interface QueryRun {
  retrieverId: string;
  queryId: string;
  family: QueryFamily;
  hits: RetrievalHit[];
  metrics: Record<string, number>;
  latencyMs: number;
  setupTimeMs: number;
  resourceUsage: RetrieverResourceUsage;
  trace: string[];
}

export interface RetrieverSummary {
  retrieverId: string;
  displayName: string;
  kind: Retriever["kind"];
  overall: Record<string, number>;
  byFamily: Partial<Record<QueryFamily, Record<string, number>>>;
}

export interface BenchmarkRun {
  corpusId: string;
  querySetId: string;
  startedAt: string;
  completedAt: string;
  queryRuns: QueryRun[];
  summaries: RetrieverSummary[];
}

export interface BenchmarkArtifacts {
  manifestPath: string;
  queryRunsPath: string;
  summariesPath: string;
}
