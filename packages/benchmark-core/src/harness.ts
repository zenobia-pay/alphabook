import type {
  BenchmarkCorpus,
  BenchmarkQuery,
  BenchmarkRun,
  QueryRun,
  QuerySet,
  Retriever,
  RetrieverSummary,
} from "./types";
import { averageMetric, computeMetrics } from "./metrics";

function summarizeRetriever(
  retriever: Retriever,
  queryRuns: QueryRun[],
): RetrieverSummary {
  const overall = averageMetric(queryRuns.map((run) => run.metrics));
  const families = new Map<string, QueryRun[]>();
  for (const run of queryRuns) {
    const familyRuns = families.get(run.family) ?? [];
    familyRuns.push(run);
    families.set(run.family, familyRuns);
  }

  return {
    retrieverId: retriever.id,
    displayName: retriever.displayName,
    kind: retriever.kind,
    overall,
    byFamily: Object.fromEntries(
      Array.from(families.entries()).map(([family, runs]) => [family, averageMetric(runs.map((run) => run.metrics))]),
    ),
  };
}

export async function runBenchmark(input: {
  corpus: BenchmarkCorpus;
  querySet: QuerySet;
  retrievers: Retriever[];
}): Promise<BenchmarkRun> {
  const { corpus, querySet, retrievers } = input;
  const startedAt = new Date().toISOString();
  const queryRuns: QueryRun[] = [];

  for (const retriever of retrievers) {
    const preparation = await retriever.prepare?.({ corpus });
    const baseSetupTimeMs = preparation?.setupTimeMs ?? 0;
    const baseTrace = preparation?.trace ?? [];

    for (const query of querySet.queries) {
      const started = performance.now();
      const result = await retriever.retrieve(query, { corpus });
      const latencyMs = performance.now() - started;
      queryRuns.push({
        retrieverId: retriever.id,
        queryId: query.id,
        family: query.family,
        hits: result.hits,
        metrics: computeMetrics(query.labels, result.hits),
        latencyMs,
        setupTimeMs: baseSetupTimeMs + (result.setupTimeMs ?? 0),
        resourceUsage: result.resourceUsage ?? {},
        trace: [...baseTrace, ...(result.trace ?? [])],
      });
    }
  }

  const summaries = retrievers.map((retriever) =>
    summarizeRetriever(
      retriever,
      queryRuns.filter((run) => run.retrieverId === retriever.id),
    ),
  );

  return {
    corpusId: corpus.id,
    querySetId: querySet.id,
    startedAt,
    completedAt: new Date().toISOString(),
    queryRuns,
    summaries,
  };
}
