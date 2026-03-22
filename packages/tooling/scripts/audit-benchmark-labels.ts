import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BenchmarkCorpus, QuerySet } from "@alphabook/benchmark-core";

interface ScriptOptions {
  querySetPath: string;
  corpusPath?: string;
  outputPath?: string;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    querySetPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--query-set":
        options.querySetPath = argv[++index] ?? options.querySetPath;
        break;
      case "--corpus":
        options.corpusPath = argv[++index];
        break;
      case "--output":
        options.outputPath = argv[++index];
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node --import tsx packages/tooling/scripts/audit-benchmark-labels.ts --query-set <path> [--corpus path] [--output path]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.querySetPath) {
    throw new Error("--query-set is required.");
  }

  return options;
}

async function loadJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), filePath), "utf8")) as T;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const querySet = await loadJson<QuerySet>(options.querySetPath);
  const corpus = options.corpusPath ? await loadJson<BenchmarkCorpus>(options.corpusPath) : null;
  const passageIds = new Set(corpus?.passages.map((passage) => passage.id) ?? []);

  const queries = querySet.queries.map((query) => {
    const invalidPassageIds = query.labels
      .map((label) => label.passageId)
      .filter((passageId) => passageIds.size > 0 && !passageIds.has(passageId));
    return {
      queryId: query.id,
      text: query.text,
      family: query.family,
      labelCount: query.labels.length,
      requiresHumanLabeling: query.labels.length === 0,
      invalidPassageIds,
      notes: query.notes ?? null,
    };
  });

  const summary = {
    querySetId: querySet.id,
    queryCount: querySet.queries.length,
    unlabeledQueryCount: queries.filter((query) => query.requiresHumanLabeling).length,
    invalidLabelCount: queries.reduce((total, query) => total + query.invalidPassageIds.length, 0),
    corpusId: corpus?.id ?? null,
    passageCount: corpus?.passages.length ?? null,
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    summary,
    queries,
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
