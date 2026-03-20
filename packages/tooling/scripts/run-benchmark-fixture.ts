import path from "node:path";

import {
  createBm25LiteRetriever,
  createCliExactRetriever,
  createCliExpandedRetriever,
  createComprehensiveLLMRetriever,
  createDistributedCliRetriever,
  createHybridLiteRetriever,
  createOpenAIExhaustiveJudge,
  createSemanticLiteRetriever,
  fixtureBenchmarkCorpus,
  fixtureQuerySet,
  persistBenchmarkRun,
  runBenchmark,
} from "@alphabook/benchmark-core";

async function main() {
  const exhaustiveApiKey = process.env.OPENAI_API_KEY;
  const exhaustiveModel = process.env.OPENAI_MODEL ?? "gpt-5.2";
  const run = await runBenchmark({
    corpus: fixtureBenchmarkCorpus,
    querySet: fixtureQuerySet,
    retrievers: [
      createCliExactRetriever(),
      createCliExpandedRetriever(),
      createDistributedCliRetriever(4),
      createBm25LiteRetriever(),
      createSemanticLiteRetriever(),
      createHybridLiteRetriever(),
      ...(exhaustiveApiKey
        ? [createComprehensiveLLMRetriever({
          judge: createOpenAIExhaustiveJudge({
            apiKey: exhaustiveApiKey,
            model: exhaustiveModel,
          }),
        })]
        : []),
    ],
  });

  const artifacts = await persistBenchmarkRun(
    run,
    path.resolve(process.cwd(), "output", "benchmark-runs"),
  );

  process.stdout.write(`${JSON.stringify({
    corpusId: run.corpusId,
    querySetId: run.querySetId,
    summaries: run.summaries,
    artifacts,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
