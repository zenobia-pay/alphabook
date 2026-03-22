import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  benchmarkCorpusFromWorkspaceManifest,
  loadBeirBenchmarkDataset,
  type QueryFamily,
} from "@alphabook/benchmark-core";
import type { CorpusWorkspaceManifest } from "@alphabook/corpus-core";

interface ScriptOptions {
  format: "beir" | "workspace";
  inputPath: string;
  outputDir: string;
  corpusId?: string;
  corpusName?: string;
  corpusDescription?: string;
  querySetId?: string;
  querySetVersion?: string;
  querySetDescription?: string;
  defaultFamily?: QueryFamily;
  maxQueries?: number;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    format: "beir",
    inputPath: "",
    outputDir: "output/benchmark-imports",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--format":
        options.format = (argv[++index] as ScriptOptions["format"]) ?? options.format;
        break;
      case "--input":
        options.inputPath = argv[++index] ?? options.inputPath;
        break;
      case "--output-dir":
        options.outputDir = argv[++index] ?? options.outputDir;
        break;
      case "--corpus-id":
        options.corpusId = argv[++index];
        break;
      case "--corpus-name":
        options.corpusName = argv[++index];
        break;
      case "--corpus-description":
        options.corpusDescription = argv[++index];
        break;
      case "--query-set-id":
        options.querySetId = argv[++index];
        break;
      case "--query-set-version":
        options.querySetVersion = argv[++index];
        break;
      case "--query-set-description":
        options.querySetDescription = argv[++index];
        break;
      case "--default-family":
        options.defaultFamily = argv[++index] as QueryFamily;
        break;
      case "--max-queries":
        options.maxQueries = Number(argv[++index]);
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node --import tsx packages/tooling/scripts/import-benchmark-dataset.ts --format <beir|workspace> --input <path> [--output-dir path]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.inputPath) {
    throw new Error("--input is required.");
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(process.cwd(), options.outputDir);
  await mkdir(outputDir, { recursive: true });

  let corpus;
  let querySet = null;

  if (options.format === "beir") {
    const loaded = await loadBeirBenchmarkDataset(options.inputPath, {
      corpusId: options.corpusId,
      displayName: options.corpusName,
      description: options.corpusDescription,
      querySetId: options.querySetId,
      querySetVersion: options.querySetVersion,
      querySetDescription: options.querySetDescription,
      defaultFamily: options.defaultFamily,
      maxQueries: options.maxQueries,
    });
    corpus = loaded.corpus;
    querySet = loaded.querySet;
  } else {
    const manifest = JSON.parse(
      await readFile(path.resolve(process.cwd(), options.inputPath), "utf8"),
    ) as CorpusWorkspaceManifest;
    corpus = benchmarkCorpusFromWorkspaceManifest(manifest, {
      corpusId: options.corpusId,
      displayName: options.corpusName,
      description: options.corpusDescription,
    });
  }

  const corpusPath = path.join(outputDir, `${corpus.id}.corpus.json`);
  await writeFile(corpusPath, JSON.stringify(corpus, null, 2));

  let querySetPath: string | null = null;
  if (querySet) {
    querySetPath = path.join(outputDir, `${querySet.id}.queries.json`);
    await writeFile(querySetPath, JSON.stringify(querySet, null, 2));
  }

  process.stdout.write(`${JSON.stringify({
    format: options.format,
    corpusPath,
    querySetPath,
    documentCount: corpus.documents.length,
    passageCount: corpus.passages.length,
    queryCount: querySet?.queries.length ?? 0,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
