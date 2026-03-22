import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createBm25LiteRetriever,
  createCliExactRetriever,
  createCliExpandedRetriever,
  createComprehensiveLLMRetriever,
  createDistributedCliRetriever,
  createHybridLiteRetriever,
  createOpenAICompatibleExhaustiveJudge,
  createSemanticLiteRetriever,
  persistBenchmarkRun,
  runBenchmark,
  type BenchmarkLabel,
  type BenchmarkQuery,
  type BenchmarkCorpus,
  type QuerySet,
} from "@alphabook/benchmark-core";

import { loadDotEnvFile } from "./lib/benchmark-env";

interface ScriptOptions {
  corpusPath: string;
  querySetPath: string;
  outputRoot: string;
  batchSize: number;
  model: string;
  minScore: number;
  highScore: number;
  maxLabelsPerQuery: number;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    corpusPath: "output/benchmark-samples/grief-topical-10-books.json",
    querySetPath: "output/benchmark-samples/grief-10-query-set.json",
    outputRoot: "output/benchmark-runs/real-ir-benchmark",
    batchSize: 8,
    model: "z-ai/glm-4.5-air",
    minScore: 0.25,
    highScore: 0.75,
    maxLabelsPerQuery: 20,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--corpus":
        options.corpusPath = argv[++index] ?? options.corpusPath;
        break;
      case "--query-set":
        options.querySetPath = argv[++index] ?? options.querySetPath;
        break;
      case "--output-root":
        options.outputRoot = argv[++index] ?? options.outputRoot;
        break;
      case "--batch-size":
        options.batchSize = Number(argv[++index] ?? options.batchSize);
        break;
      case "--model":
        options.model = argv[++index] ?? options.model;
        break;
      case "--min-score":
        options.minScore = Number(argv[++index] ?? options.minScore);
        break;
      case "--high-score":
        options.highScore = Number(argv[++index] ?? options.highScore);
        break;
      case "--max-labels":
        options.maxLabelsPerQuery = Number(argv[++index] ?? options.maxLabelsPerQuery);
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node --import tsx packages/tooling/scripts/run-real-ir-benchmark.ts [--corpus path] [--query-set path] [--output-root path]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

async function loadJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), filePath), "utf8")) as T;
}

function toSilverLabels(input: {
  passageIds: Array<{ passageId: string; score: number }>;
  minScore: number;
  highScore: number;
  maxLabelsPerQuery: number;
}): BenchmarkLabel[] {
  return input.passageIds
    .filter((entry) => entry.score >= input.minScore)
    .slice(0, input.maxLabelsPerQuery)
    .map((entry) => ({
      passageId: entry.passageId,
      grade: entry.score >= input.highScore ? 2 : 1,
    }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnvFile();

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }

  const corpus = await loadJson<BenchmarkCorpus>(options.corpusPath);
  const querySet = await loadJson<QuerySet>(options.querySetPath);

  const silverRetriever = createComprehensiveLLMRetriever({
    judge: createOpenAICompatibleExhaustiveJudge({
      apiKey,
      model: options.model,
      id: `openrouter-${options.model}`,
      baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1/chat/completions",
      extraHeaders: {
        "HTTP-Referer": "https://alpha-book.org",
        "X-OpenRouter-Title": "AlphaBook Benchmark",
      },
      includeRationale: false,
      useJsonSchema: false,
    }),
    batchSize: options.batchSize,
    minScore: options.minScore,
  });

  const silverQueries: BenchmarkQuery[] = [];
  const silverRuns: Array<Record<string, unknown>> = [];
  for (const query of querySet.queries) {
    const result = await silverRetriever.retrieve(query, { corpus });
    const labels = toSilverLabels({
      passageIds: result.hits.map((hit) => ({ passageId: hit.passageId, score: hit.score })),
      minScore: options.minScore,
      highScore: options.highScore,
      maxLabelsPerQuery: options.maxLabelsPerQuery,
    });
    silverQueries.push({
      ...query,
      labels,
    });
    silverRuns.push({
      queryId: query.id,
      queryText: query.text,
      labelCount: labels.length,
      topLabels: labels.slice(0, 10),
      trace: result.trace ?? [],
      retainedHits: result.hits.length,
    });
  }

  const labeledQuerySet: QuerySet = {
    ...querySet,
    id: `${querySet.id}-silver-${options.model.replaceAll("/", "-")}`,
    version: `${querySet.version}-silver`,
    description: `${querySet.description} Silver-labeled with ${options.model}.`,
    queries: silverQueries,
  };

  const benchmarkRun = await runBenchmark({
    corpus,
    querySet: labeledQuerySet,
    retrievers: [
      createCliExactRetriever(),
      createCliExpandedRetriever(),
      createDistributedCliRetriever(4),
      createBm25LiteRetriever(),
      createSemanticLiteRetriever(),
      createHybridLiteRetriever(),
    ],
  });

  const outputRoot = path.resolve(process.cwd(), options.outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const artifacts = await persistBenchmarkRun(benchmarkRun, outputRoot);

  const labelsPath = path.join(path.dirname(artifacts.manifestPath), "silver-query-set.json");
  const silverRunsPath = path.join(path.dirname(artifacts.manifestPath), "silver-label-runs.json");
  await writeFile(labelsPath, JSON.stringify(labeledQuerySet, null, 2));
  await writeFile(silverRunsPath, JSON.stringify(silverRuns, null, 2));

  process.stdout.write(`${JSON.stringify({
    corpusId: corpus.id,
    querySetId: labeledQuerySet.id,
    labelsPath,
    silverRunsPath,
    artifacts,
    summaries: benchmarkRun.summaries,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
