import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createComprehensiveLLMRetriever,
  createOpenAICompatibleExhaustiveJudge,
  type BenchmarkCorpus,
  type BenchmarkQuery,
  type QuerySet,
} from "@alphabook/benchmark-core";

import { loadDotEnvFile } from "./lib/benchmark-env";

interface ModelSpec {
  label: string;
  provider: "openai" | "openrouter";
  model: string;
}

interface ScriptOptions {
  corpusPath: string;
  querySetPath: string;
  outputDir: string;
  batchSize: number;
  topK: number;
  models: ModelSpec[];
}

function parseModelSpec(raw: string): ModelSpec {
  const [label, provider, model] = raw.split(":");
  if (!label || (provider !== "openai" && provider !== "openrouter") || !model) {
    throw new Error(`Invalid --model spec: ${raw}. Expected label:provider:model`);
  }
  return { label, provider: provider as ModelSpec["provider"], model };
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    corpusPath: "output/benchmark-samples/grief-random-250-books.json",
    querySetPath: "data/benchmarks/grief-25-query-set.json",
    outputDir: "output/benchmark-runs/grief-25-v1",
    batchSize: 64,
    topK: 100,
    models: [
      { label: "mini", provider: "openai", model: "gpt-5-mini" },
      { label: "glm45", provider: "openrouter", model: "z-ai/glm-4.5" },
      { label: "glm46", provider: "openrouter", model: "z-ai/glm-4.6" },
    ],
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
      case "--output-dir":
        options.outputDir = argv[++index] ?? options.outputDir;
        break;
      case "--batch-size":
        options.batchSize = Number(argv[++index] ?? options.batchSize);
        break;
      case "--top-k":
        options.topK = Number(argv[++index] ?? options.topK);
        break;
      case "--model":
        if (index === 0 || !argv.slice(0, index).includes("--model")) {
          options.models = [];
        }
        options.models.push(parseModelSpec(argv[++index] ?? ""));
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node --import tsx packages/tooling/scripts/run-grief-benchmark.ts [--corpus path] [--query-set path] [--output-dir path] [--model label:provider:model]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function topOverlap(left: string[], right: string[], k: number) {
  const leftTop = left.slice(0, k);
  const rightSet = new Set(right.slice(0, k));
  return leftTop.filter((id) => rightSet.has(id)).length;
}

function buildSummary(results: Array<Record<string, unknown>>) {
  const comparable = results.filter((entry) => entry.skipped !== true) as Array<{
    label: string;
    topHits: Array<{ passageId: string }>;
  } & Record<string, unknown>>;
  const reference = comparable[0] ?? null;

  const summary = comparable.map((entry) => ({
    label: entry.label,
    top20OverlapWithReference: reference ? topOverlap(
      entry.topHits.map((hit) => hit.passageId),
      reference.topHits.map((hit) => hit.passageId),
      20,
    ) : null,
    top100OverlapWithReference: reference ? topOverlap(
      entry.topHits.map((hit) => hit.passageId),
      reference.topHits.map((hit) => hit.passageId),
      100,
    ) : null,
  }));

  return { comparable, reference, summary };
}

async function runModelOnQuery(
  model: ModelSpec,
  query: BenchmarkQuery,
  corpus: BenchmarkCorpus,
  batchSize: number,
  topK: number,
) {
  let apiKey: string | undefined;
  let baseUrl: string;
  let extraHeaders: Record<string, string> | undefined;

  if (model.provider === "openai") {
    apiKey = process.env.OPENAI_API_KEY;
    baseUrl = "https://api.openai.com/v1/chat/completions";
  } else {
    apiKey = process.env.OPENROUTER_API_KEY;
    baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1/chat/completions";
    extraHeaders = {
      "HTTP-Referer": "https://alpha-book.org",
      "X-OpenRouter-Title": "AlphaBook Benchmark",
    };
  }

  if (!apiKey) {
    return {
      label: model.label,
      provider: model.provider,
      model: model.model,
      skipped: true,
      reason: `Missing API key for ${model.provider}`,
    };
  }

  const retriever = createComprehensiveLLMRetriever({
    judge: createOpenAICompatibleExhaustiveJudge({
      apiKey,
      model: model.model,
      id: `${model.provider}-${model.model}`,
      baseUrl,
      extraHeaders,
      includeRationale: false,
      useJsonSchema: model.provider === "openai",
    }),
    batchSize,
    minScore: 0,
  });

  const started = performance.now();
  try {
    const result = await retriever.retrieve(query, { corpus });
    return {
      label: model.label,
      provider: model.provider,
      model: model.model,
      skipped: false,
      elapsedMs: performance.now() - started,
      retainedHits: result.hits.length,
      topHits: result.hits.slice(0, topK),
      trace: result.trace ?? [],
    };
  } catch (error) {
    return {
      label: model.label,
      provider: model.provider,
      model: model.model,
      skipped: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnvFile();

  const corpus = JSON.parse(await readFile(path.resolve(process.cwd(), options.corpusPath), "utf8")) as BenchmarkCorpus;
  const querySet = JSON.parse(await readFile(path.resolve(process.cwd(), options.querySetPath), "utf8")) as QuerySet;

  await mkdir(path.resolve(process.cwd(), options.outputDir), { recursive: true });

  const aggregate: Array<Record<string, unknown>> = [];

  for (const query of querySet.queries) {
    process.stderr.write(`Running query ${query.id}: ${query.text}\n`);
    const filePath = path.resolve(process.cwd(), options.outputDir, `${query.id}.json`);
    let results: Array<Record<string, unknown>> = [];

    try {
      const existing = JSON.parse(await readFile(filePath, "utf8")) as {
        results?: Array<Record<string, unknown>>;
      };
      results = existing.results ?? [];
      if (results.length > 0) {
        process.stderr.write(`  Resuming from ${results.length} saved model result(s)\n`);
      }
    } catch {
      results = [];
    }

    for (const model of options.models) {
      const alreadyCompleted = results.some((entry) => entry.label === model.label);
      if (alreadyCompleted) {
        process.stderr.write(`  Model ${model.label} (${model.model}) already saved, skipping\n`);
        continue;
      }

      process.stderr.write(`  Model ${model.label} (${model.model})\n`);
      results.push(await runModelOnQuery(model, query, corpus, options.batchSize, options.topK));

      const { reference, summary } = buildSummary(results);
      const partialPayload = {
        generatedAt: new Date().toISOString(),
        status: "partial",
        query,
        corpus: {
          id: corpus.id,
          documentCount: corpus.documents.length,
          passageCount: corpus.passages.length,
        },
        referenceLabel: reference?.label ?? null,
        summary,
        results,
      };

      await writeFile(filePath, JSON.stringify(partialPayload, null, 2));
    }

    const { comparable, reference, summary } = buildSummary(results);

    const payload = {
      generatedAt: new Date().toISOString(),
      status: "complete",
      query,
      corpus: {
        id: corpus.id,
        documentCount: corpus.documents.length,
        passageCount: corpus.passages.length,
      },
      referenceLabel: reference?.label ?? null,
      summary,
      results,
    };

    await writeFile(filePath, JSON.stringify(payload, null, 2));
    aggregate.push({
      queryId: query.id,
      queryText: query.text,
      referenceLabel: reference?.label ?? null,
      summary,
      completedModels: comparable.map((entry) => entry.label),
      skippedModels: results.filter((entry) => entry.skipped === true).map((entry) => entry.label),
    });
  }

  const manifestPath = path.resolve(process.cwd(), options.outputDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    corpusPath: path.resolve(process.cwd(), options.corpusPath),
    querySetPath: path.resolve(process.cwd(), options.querySetPath),
    queryCount: querySet.queries.length,
    models: options.models,
    aggregate,
  }, null, 2));

  process.stdout.write(`${JSON.stringify({
    manifestPath,
    queryCount: querySet.queries.length,
    corpusPath: path.resolve(process.cwd(), options.corpusPath),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
