import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createComprehensiveLLMRetriever,
  createOpenAIExhaustiveJudge,
  fixtureBenchmarkCorpus,
  fixtureQuerySet,
  type BenchmarkCorpus,
  type BenchmarkQuery,
  type QuerySet,
} from "@alphabook/benchmark-core";

interface ScriptOptions {
  corpusPath?: string;
  fixture: boolean;
  query?: string;
  family: BenchmarkQuery["family"];
  filters?: Record<string, unknown>;
  queryId?: string;
  querySetPath?: string;
  outputPath?: string;
  topK: number;
  batchSize: number;
  minScore: number;
  model: string;
}

function printHelp() {
  process.stdout.write(`
Usage:
  node --import tsx packages/tooling/scripts/run-comprehensive-baseline.ts [options]

Options:
  --fixture
      Use the built-in fixture corpus and query set.

  --corpus <path>
      Path to a BenchmarkCorpus JSON file.

  --query "<text>"
      Ad hoc query text to score against the full corpus.

  --family <family>
      Query family for ad hoc queries.
      Default: associative

  --filters '<json>'
      JSON object of query filters for ad hoc queries.
      Example: --filters '{"year":2024,"sourceType":"guide"}'

  --query-set <path>
      Path to a QuerySet JSON file.

  --query-id <id>
      Query id from the provided query set or fixture query set.

  --output <path>
      Optional output JSON path. Defaults to stdout only.

  --top-k <n>
      Number of ranked passages to include in the printed result.
      Default: 100

  --batch-size <n>
      Number of passages per LLM batch.
      Default: 8

  --min-score <n>
      Minimum score threshold to retain a passage.
      Default: 0

  --model <name>
      OpenAI model for exhaustive judging.
      Default: OPENAI_MODEL or gpt-5.2

Environment:
  OPENAI_API_KEY is required.

Examples:
  node --import tsx packages/tooling/scripts/run-comprehensive-baseline.ts \\
    --fixture \\
    --query "dealing with grief"

  node --import tsx packages/tooling/scripts/run-comprehensive-baseline.ts \\
    --corpus ./data/books-corpus.json \\
    --query "dealing with grief" \\
    --family associative \\
    --output ./output/grief-truth.json

  node --import tsx packages/tooling/scripts/run-comprehensive-baseline.ts \\
    --corpus ./data/books-corpus.json \\
    --query-set ./data/associative-queries.json \\
    --query-id grief-001
`.trimStart());
}

function parseNumber(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${flag}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    fixture: false,
    family: "associative",
    topK: 100,
    batchSize: 8,
    minScore: 0,
    model: process.env.OPENAI_MODEL ?? "gpt-5.2",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      case "--fixture":
        options.fixture = true;
        break;
      case "--corpus":
        options.corpusPath = argv[++index];
        break;
      case "--query":
        options.query = argv[++index];
        break;
      case "--family":
        options.family = (argv[++index] as BenchmarkQuery["family"]) ?? "associative";
        break;
      case "--filters": {
        const raw = argv[++index];
        options.filters = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
        break;
      }
      case "--query-id":
        options.queryId = argv[++index];
        break;
      case "--query-set":
        options.querySetPath = argv[++index];
        break;
      case "--output":
        options.outputPath = argv[++index];
        break;
      case "--top-k":
        options.topK = parseNumber(argv[++index], "--top-k", 100);
        break;
      case "--batch-size":
        options.batchSize = parseNumber(argv[++index], "--batch-size", 8);
        break;
      case "--min-score":
        options.minScore = parseNumber(argv[++index], "--min-score", 0);
        break;
      case "--model":
        options.model = argv[++index] ?? options.model;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

async function loadJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function loadCorpus(options: ScriptOptions): Promise<BenchmarkCorpus> {
  if (options.fixture) {
    return fixtureBenchmarkCorpus;
  }
  if (!options.corpusPath) {
    throw new Error("Provide either --fixture or --corpus <path>.");
  }
  return loadJsonFile<BenchmarkCorpus>(path.resolve(process.cwd(), options.corpusPath));
}

async function loadQuerySet(options: ScriptOptions): Promise<QuerySet | null> {
  if (options.fixture) {
    return fixtureQuerySet;
  }
  if (!options.querySetPath) {
    return null;
  }
  return loadJsonFile<QuerySet>(path.resolve(process.cwd(), options.querySetPath));
}

function resolveQuery(options: ScriptOptions, querySet: QuerySet | null): BenchmarkQuery {
  if (options.queryId) {
    const resolved = querySet?.queries.find((entry) => entry.id === options.queryId);
    if (!resolved) {
      throw new Error(`Could not find query id "${options.queryId}" in the supplied query set.`);
    }
    return resolved;
  }

  if (!options.query) {
    throw new Error("Provide either --query-id <id> with a query set, or an ad hoc --query \"...\".");
  }

  return {
    id: "adhoc-query",
    text: options.query,
    family: options.family,
    filters: options.filters,
    labels: [],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for the comprehensive baseline.");
  }
  const corpus = await loadCorpus(options);
  const querySet = await loadQuerySet(options);
  const query = resolveQuery(options, querySet);

  const retriever = createComprehensiveLLMRetriever({
    judge: createOpenAIExhaustiveJudge({
      apiKey,
      model: options.model,
    }),
    batchSize: options.batchSize,
    minScore: options.minScore,
  });

  const started = performance.now();
  const result = await retriever.retrieve(query, { corpus });
  const elapsedMs = performance.now() - started;

  const payload = {
    generatedAt: new Date().toISOString(),
    corpus: {
      id: corpus.id,
      displayName: corpus.displayName,
      passageCount: corpus.passages.length,
      documentCount: corpus.documents.length,
    },
    query: {
      id: query.id,
      text: query.text,
      family: query.family,
      filters: query.filters ?? {},
    },
    retriever: {
      id: retriever.id,
      displayName: retriever.displayName,
      model: options.model,
      batchSize: options.batchSize,
      minScore: options.minScore,
    },
    elapsedMs,
    resourceUsage: result.resourceUsage ?? {},
    trace: result.trace ?? [],
    retainedHits: result.hits.length,
    topK: options.topK,
    hits: result.hits.slice(0, options.topK),
  };

  if (options.outputPath) {
    const destination = path.resolve(process.cwd(), options.outputPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(payload, null, 2));
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
