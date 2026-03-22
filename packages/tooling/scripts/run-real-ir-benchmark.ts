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
  type PassageJudge,
  type QuerySet,
} from "@alphabook/benchmark-core";

import { loadDotEnvFile } from "./lib/benchmark-env";

interface ScriptOptions {
  corpusPath: string;
  querySetPath: string;
  outputRoot: string;
  provider: "auto" | "openai" | "openrouter";
  batchSize: number;
  model: string;
  minScore: number;
  highScore: number;
  maxLabelsPerQuery: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    corpusPath: "output/benchmark-samples/grief-topical-10-books.json",
    querySetPath: "output/benchmark-samples/grief-10-query-set.json",
    outputRoot: "output/benchmark-runs/real-ir-benchmark",
    provider: "auto",
    batchSize: 8,
    model: "z-ai/glm-4.5-air",
    minScore: 0.25,
    highScore: 0.75,
    maxLabelsPerQuery: 20,
    requestTimeoutMs: 10_000,
    maxRetries: 1,
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
      case "--provider":
        options.provider = (argv[++index] as ScriptOptions["provider"]) ?? options.provider;
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
      case "--request-timeout-ms":
        options.requestTimeoutMs = Number(argv[++index] ?? options.requestTimeoutMs);
        break;
      case "--max-retries":
        options.maxRetries = Number(argv[++index] ?? options.maxRetries);
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

function resolveJudgeProvider(options: ScriptOptions): {
  provider: "openai" | "openrouter";
  apiKey: string;
  baseUrl: string;
  judgeId: string;
  extraHeaders?: Record<string, string>;
  useJsonSchema: boolean;
} {
  const explicitProvider = options.provider === "auto" ? null : options.provider;
  const inferredProvider = explicitProvider
    ?? (options.model.startsWith("gpt-") || options.model.startsWith("o") ? "openai" : "openrouter");
  if (inferredProvider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required when provider=openai.");
    }
    return {
      provider: "openai",
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/chat/completions",
      judgeId: `openai-${options.model}`,
      useJsonSchema: true,
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required when provider=openrouter.");
  }
  return {
    provider: "openrouter",
    apiKey,
    baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1/chat/completions",
    judgeId: `openrouter-${options.model}`,
    extraHeaders: {
      "HTTP-Referer": "https://alpha-book.org",
      "X-OpenRouter-Title": "AlphaBook Benchmark",
    },
    useJsonSchema: false,
  };
}

function sanitizeFileComponent(value: string): string {
  return value.replace(/[^a-z0-9._-]+/giu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "").toLowerCase();
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
  const judgeProvider = resolveJudgeProvider(options);

  const corpus = await loadJson<BenchmarkCorpus>(options.corpusPath);
  const querySet = await loadJson<QuerySet>(options.querySetPath);
  const outputRoot = path.resolve(process.cwd(), options.outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const stagingDir = path.join(
    outputRoot,
    `${sanitizeFileComponent(corpus.id)}-${sanitizeFileComponent(querySet.id)}-${sanitizeFileComponent(options.model)}-staging`,
  );
  await mkdir(stagingDir, { recursive: true });

  const progressPath = path.join(stagingDir, "progress.json");
  const silverRunsPath = path.join(stagingDir, "silver-label-runs.partial.json");
  const partialQuerySetPath = path.join(stagingDir, "silver-query-set.partial.json");
  let batchProgress: {
    queryId: string | null;
    processedPassages: number;
    totalPassages: number;
    completedBatches: number;
  } = {
    queryId: null,
    processedPassages: 0,
    totalPassages: corpus.passages.length,
    completedBatches: 0,
  };

  async function flushProgress(input: {
    stage: "silver-labeling" | "retrieval" | "completed";
    completedQueries: number;
    totalQueries: number;
    silverQueries: BenchmarkQuery[];
    silverRuns: Array<Record<string, unknown>>;
    finalArtifacts?: Record<string, unknown>;
  }) {
    await writeFile(progressPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      stage: input.stage,
      corpusId: corpus.id,
      querySetId: querySet.id,
      model: options.model,
      completedQueries: input.completedQueries,
      totalQueries: input.totalQueries,
      batchProgress,
      finalArtifacts: input.finalArtifacts ?? null,
    }, null, 2));
    await writeFile(silverRunsPath, JSON.stringify(input.silverRuns, null, 2));
    await writeFile(partialQuerySetPath, JSON.stringify({
      ...querySet,
      id: `${querySet.id}-silver-${options.model.replaceAll("/", "-")}`,
      version: `${querySet.version}-silver`,
      description: `${querySet.description} Silver-labeled with ${options.model}.`,
      queries: input.silverQueries,
    }, null, 2));
  }

  const baseJudge = createOpenAICompatibleExhaustiveJudge({
      apiKey: judgeProvider.apiKey,
      model: options.model,
      id: judgeProvider.judgeId,
      baseUrl: judgeProvider.baseUrl,
      extraHeaders: judgeProvider.extraHeaders,
      includeRationale: false,
      useJsonSchema: judgeProvider.useJsonSchema,
      requestTimeoutMs: options.requestTimeoutMs,
      maxRetries: options.maxRetries,
    });
  const loggingJudge: PassageJudge = {
    id: baseJudge.id,
    async judgeBatch(input) {
      const batchNumber = batchProgress.completedBatches + 1;
      process.stderr.write(
        `  batch ${batchNumber} query=${input.query.id} size=${input.passages.length} processed=${batchProgress.processedPassages}/${batchProgress.totalPassages}\n`,
      );
      try {
        const result = await baseJudge.judgeBatch(input);
        batchProgress = {
          queryId: input.query.id,
          processedPassages: batchProgress.processedPassages + input.passages.length,
          totalPassages: batchProgress.totalPassages,
          completedBatches: batchNumber,
        };
        process.stderr.write(
          `  batch ${batchNumber} complete query=${input.query.id} processed=${batchProgress.processedPassages}/${batchProgress.totalPassages}\n`,
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  batch ${batchNumber} failed query=${input.query.id} reason=${message}\n`);
        throw error;
      }
    },
  };

  const silverRetriever = createComprehensiveLLMRetriever({
    judge: loggingJudge,
    batchSize: options.batchSize,
    minScore: options.minScore,
  });

  const silverQueries: BenchmarkQuery[] = [];
  const silverRuns: Array<Record<string, unknown>> = [];
  for (const query of querySet.queries) {
    process.stderr.write(`Silver labeling ${query.id}: ${query.text}\n`);
    batchProgress = {
      queryId: query.id,
      processedPassages: 0,
      totalPassages: corpus.passages.length,
      completedBatches: 0,
    };
    await flushProgress({
      stage: "silver-labeling",
      completedQueries: silverQueries.length,
      totalQueries: querySet.queries.length,
      silverQueries,
      silverRuns,
    });
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
    await flushProgress({
      stage: "silver-labeling",
      completedQueries: silverQueries.length,
      totalQueries: querySet.queries.length,
      silverQueries,
      silverRuns,
    });
  }

  const labeledQuerySet: QuerySet = {
    ...querySet,
    id: `${querySet.id}-silver-${options.model.replaceAll("/", "-")}`,
    version: `${querySet.version}-silver`,
    description: `${querySet.description} Silver-labeled with ${options.model}.`,
    queries: silverQueries,
  };

  await flushProgress({
    stage: "retrieval",
    completedQueries: silverQueries.length,
    totalQueries: querySet.queries.length,
    silverQueries,
    silverRuns,
  });

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

  const artifacts = await persistBenchmarkRun(benchmarkRun, outputRoot);

  const labelsPath = path.join(path.dirname(artifacts.manifestPath), "silver-query-set.json");
  const finalSilverRunsPath = path.join(path.dirname(artifacts.manifestPath), "silver-label-runs.json");
  await writeFile(labelsPath, JSON.stringify(labeledQuerySet, null, 2));
  await writeFile(finalSilverRunsPath, JSON.stringify(silverRuns, null, 2));
  await flushProgress({
    stage: "completed",
    completedQueries: silverQueries.length,
    totalQueries: querySet.queries.length,
    silverQueries,
    silverRuns,
    finalArtifacts: {
      manifestPath: artifacts.manifestPath,
      queryRunsPath: artifacts.queryRunsPath,
      summariesPath: artifacts.summariesPath,
      labelsPath,
      silverRunsPath: finalSilverRunsPath,
    },
  });

  process.stdout.write(`${JSON.stringify({
    corpusId: corpus.id,
    querySetId: labeledQuerySet.id,
    labelsPath,
    silverRunsPath: finalSilverRunsPath,
    artifacts,
    summaries: benchmarkRun.summaries,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
