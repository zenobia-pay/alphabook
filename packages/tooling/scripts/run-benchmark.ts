import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  createBm25LiteRetriever,
  createCliExactRetriever,
  createCliExpandedRetriever,
  createDistributedCliRetriever,
  createHybridLiteRetriever,
  createSemanticLiteRetriever,
  persistBenchmarkRun,
  runBenchmark,
  type BenchmarkCorpus,
  type QuerySet,
} from "@alphabook/benchmark-core";

interface ScriptOptions {
  corpusPath: string;
  querySetPath: string;
  outputRoot: string;
  shardCount: number;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    corpusPath: "",
    querySetPath: "",
    outputRoot: "output/benchmark-runs/manual",
    shardCount: 4,
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
      case "--shards":
        options.shardCount = Number(argv[++index] ?? options.shardCount);
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node --import tsx packages/tooling/scripts/run-benchmark.ts --corpus <path> --query-set <path> [--output-root path] [--shards 4]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.corpusPath || !options.querySetPath) {
    throw new Error("--corpus and --query-set are required.");
  }

  return options;
}

async function loadJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), filePath), "utf8")) as T;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpus = await loadJson<BenchmarkCorpus>(options.corpusPath);
  const querySet = await loadJson<QuerySet>(options.querySetPath);

  const run = await runBenchmark({
    corpus,
    querySet,
    retrievers: [
      createCliExactRetriever(),
      createCliExpandedRetriever(),
      createDistributedCliRetriever(options.shardCount),
      createBm25LiteRetriever(),
      createSemanticLiteRetriever(),
      createHybridLiteRetriever(),
    ],
  });

  const artifacts = await persistBenchmarkRun(run, path.resolve(process.cwd(), options.outputRoot));
  process.stdout.write(`${JSON.stringify({
    corpusId: corpus.id,
    querySetId: querySet.id,
    summaries: run.summaries,
    artifacts,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
