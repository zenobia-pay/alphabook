import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createComprehensiveLLMRetriever,
  createOpenAICompatibleExhaustiveJudge,
  type BenchmarkCorpus,
  type BenchmarkQuery,
} from "@alphabook/benchmark-core";

import { loadDotEnvFile } from "./lib/benchmark-env";

interface ModelSpec {
  label: string;
  provider: "openai" | "glm" | "openrouter";
  model: string;
}

interface ScriptOptions {
  corpusPath: string;
  query: string;
  family: BenchmarkQuery["family"];
  filters?: Record<string, unknown>;
  outputPath: string;
  topK: number;
  batchSize: number;
  minScore: number;
  includeRationale: boolean;
  models: ModelSpec[];
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

function parseModelSpec(raw: string): ModelSpec {
  const [label, provider, model] = raw.split(":");
  if (!label || (provider !== "openai" && provider !== "glm" && provider !== "openrouter") || !model) {
    throw new Error(`Invalid --model spec: ${raw}. Expected label:provider:model`);
  }
  return { label, provider: provider as ModelSpec["provider"], model };
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    corpusPath: "output/benchmark-samples/random-1000-books.json",
    query: "dealing with grief",
    family: "associative",
    outputPath: "output/benchmark-runs/model-comparison.json",
    topK: 100,
    batchSize: 8,
    minScore: 0,
    includeRationale: false,
    models: [
      { label: "gpt-5.4", provider: "openai", model: "gpt-5.4" },
      { label: "gpt-5-mini", provider: "openai", model: "gpt-5-mini" },
      { label: "glm-4.6", provider: "openrouter", model: "z-ai/glm-4.6" },
      { label: "glm-4.5", provider: "openrouter", model: "z-ai/glm-4.5" },
    ],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--corpus":
        options.corpusPath = argv[++index] ?? options.corpusPath;
        break;
      case "--query":
        options.query = argv[++index] ?? options.query;
        break;
      case "--family":
        options.family = (argv[++index] as BenchmarkQuery["family"]) ?? options.family;
        break;
      case "--filters": {
        const raw = argv[++index];
        options.filters = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
        break;
      }
      case "--output":
        options.outputPath = argv[++index] ?? options.outputPath;
        break;
      case "--top-k":
        options.topK = parseNumber(argv[++index], options.topK);
        break;
      case "--batch-size":
        options.batchSize = parseNumber(argv[++index], options.batchSize);
        break;
      case "--min-score":
        options.minScore = parseNumber(argv[++index], options.minScore);
        break;
      case "--with-rationale":
        options.includeRationale = true;
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
          "Usage: node --import tsx packages/tooling/scripts/run-comprehensive-model-comparison.ts [--corpus path] [--query text] [--model label:provider:model]\n",
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotEnvFile();

  const corpus = JSON.parse(
    await readFile(path.resolve(process.cwd(), options.corpusPath), "utf8"),
  ) as BenchmarkCorpus;

  const query: BenchmarkQuery = {
    id: "adhoc-query",
    text: options.query,
    family: options.family,
    filters: options.filters,
    labels: [],
  };

  const results: Array<Record<string, unknown>> = [];
  const destination = path.resolve(process.cwd(), options.outputPath);

  async function flushPartial() {
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

    const payload = {
      generatedAt: new Date().toISOString(),
      corpus: {
        id: corpus.id,
        documentCount: corpus.documents.length,
        passageCount: corpus.passages.length,
      },
      query,
      comparison: {
        referenceLabel: reference?.label ?? null,
        includeRationale: options.includeRationale,
        batchSize: options.batchSize,
        topK: options.topK,
      },
      summary,
      results,
    };

    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(payload, null, 2));
  }

  for (const spec of options.models) {
    let apiKey: string | undefined;
    let baseUrl: string | undefined;
    let idPrefix: string;
    let extraHeaders: Record<string, string> | undefined;

    if (spec.provider === "openai") {
      apiKey = process.env.OPENAI_API_KEY;
      baseUrl = "https://api.openai.com/v1/chat/completions";
      idPrefix = "openai";
    } else if (spec.provider === "glm") {
      apiKey = process.env.GLM_API_KEY ?? process.env.BIGMODEL_API_KEY ?? process.env.ZHIPU_API_KEY;
      baseUrl = process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4/chat/completions";
      idPrefix = "glm";
    } else {
      apiKey = process.env.OPENROUTER_API_KEY;
      baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1/chat/completions";
      idPrefix = "openrouter";
      extraHeaders = {
        "HTTP-Referer": "https://alpha-book.org",
        "X-OpenRouter-Title": "AlphaBook Benchmark",
      };
    }

    if (!apiKey) {
      process.stderr.write(`Skipping ${spec.label}: missing API key for provider ${spec.provider}\n`);
      results.push({
        label: spec.label,
        provider: spec.provider,
        model: spec.model,
        skipped: true,
        reason: `Missing API key for provider ${spec.provider}`,
      });
      await flushPartial();
      continue;
    }

    process.stderr.write(`Starting ${spec.label} (${spec.provider}:${spec.model})\n`);
    const retriever = createComprehensiveLLMRetriever({
      judge: createOpenAICompatibleExhaustiveJudge({
        apiKey,
        model: spec.model,
        id: `${idPrefix}-${spec.model}`,
        baseUrl,
        includeRationale: options.includeRationale,
        extraHeaders,
        useJsonSchema: spec.provider !== "openrouter",
      }),
      batchSize: options.batchSize,
      minScore: options.minScore,
    });

    const started = performance.now();
    try {
      const result = await retriever.retrieve(query, { corpus });
      const elapsedMs = performance.now() - started;

      process.stderr.write(`Finished ${spec.label} in ${Math.round(elapsedMs)} ms with ${result.hits.length} retained hits\n`);
      results.push({
        label: spec.label,
        provider: spec.provider,
        model: spec.model,
        skipped: false,
        elapsedMs,
        retainedHits: result.hits.length,
        topHits: result.hits.slice(0, options.topK),
        trace: result.trace ?? [],
        resourceUsage: result.resourceUsage ?? {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Failed ${spec.label}: ${message}\n`);
      results.push({
        label: spec.label,
        provider: spec.provider,
        model: spec.model,
        skipped: true,
        reason: message,
      });
    }
    await flushPartial();
  }
  const finalPayload = JSON.parse(await readFile(destination, "utf8")) as {
    comparison: { referenceLabel: string | null };
    results: Array<{ label: string; skipped?: boolean }>;
  };
  process.stdout.write(`${JSON.stringify({
    outputPath: destination,
    referenceLabel: finalPayload.comparison.referenceLabel,
    completedModels: finalPayload.results.filter((entry) => entry.skipped !== true).map((entry) => entry.label),
    skippedModels: finalPayload.results.filter((entry) => entry.skipped === true).map((entry) => entry.label),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
