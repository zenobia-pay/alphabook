import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface RetrievalHit {
  passageId: string;
  score: number;
}

interface ModelResult {
  label: string;
  skipped?: boolean;
  elapsedMs?: number;
  retainedHits?: number;
  topHits?: RetrievalHit[];
  reason?: string;
}

interface QueryRun {
  query: {
    id: string;
    text: string;
  };
  referenceLabel: string | null;
  results: ModelResult[];
}

interface ScriptOptions {
  inputDir: string;
  outputPath: string;
  referenceLabel?: string;
  k: number;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    inputDir: "output/benchmark-runs/grief-10-glm-selection-1-book",
    outputPath: "output/benchmark-runs/grief-10-glm-selection-1-book-analysis.json",
    k: 100,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--input-dir":
        options.inputDir = argv[++index] ?? options.inputDir;
        break;
      case "--output":
        options.outputPath = argv[++index] ?? options.outputPath;
        break;
      case "--reference-label":
        options.referenceLabel = argv[++index] ?? options.referenceLabel;
        break;
      case "--k":
        options.k = Number(argv[++index] ?? options.k);
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: node --import tsx packages/tooling/scripts/analyze-model-selection.ts [--input-dir path] [--output path] [--reference-label label] [--k number]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function topPassageIds(result: ModelResult, k: number): string[] {
  return (result.topHits ?? []).slice(0, k).map((hit) => hit.passageId);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputDir = path.resolve(process.cwd(), options.inputDir);
  const outputPath = path.resolve(process.cwd(), options.outputPath);
  const files = (await readdir(inputDir))
    .filter((entry) => entry.endsWith(".json") && entry !== "manifest.json")
    .sort();

  const aggregateByModel = new Map<string, {
    queries: number;
    skipped: number;
    missingCount: number;
    falsePositiveCount: number;
    overlapAtK: number;
    retainedHits: number;
    elapsedMs: number;
  }>();
  const perQuery: Array<Record<string, unknown>> = [];

  for (const file of files) {
    const run = JSON.parse(await readFile(path.join(inputDir, file), "utf8")) as QueryRun;
    const referenceResult = run.results.find((result) =>
      result.label === (options.referenceLabel ?? run.referenceLabel ?? run.results.find((entry) => entry.skipped !== true)?.label),
    );

    if (!referenceResult || referenceResult.skipped) {
      continue;
    }

    const referenceIds = topPassageIds(referenceResult, options.k);
    const referenceSet = new Set(referenceIds);
    const queryModels: Array<Record<string, unknown>> = [];

    for (const result of run.results) {
      const aggregate = aggregateByModel.get(result.label) ?? {
        queries: 0,
        skipped: 0,
        missingCount: 0,
        falsePositiveCount: 0,
        overlapAtK: 0,
        retainedHits: 0,
        elapsedMs: 0,
      };

      aggregate.queries += 1;
      if (result.skipped) {
        aggregate.skipped += 1;
        aggregateByModel.set(result.label, aggregate);
        queryModels.push({
          label: result.label,
          skipped: true,
          reason: result.reason ?? "skipped",
        });
        continue;
      }

      const resultIds = topPassageIds(result, options.k);
      const resultSet = new Set(resultIds);
      const missing = referenceIds.filter((passageId) => !resultSet.has(passageId));
      const falsePositives = resultIds.filter((passageId) => !referenceSet.has(passageId));
      const overlapAtK = resultIds.filter((passageId) => referenceSet.has(passageId)).length;

      aggregate.missingCount += missing.length;
      aggregate.falsePositiveCount += falsePositives.length;
      aggregate.overlapAtK += overlapAtK;
      aggregate.retainedHits += result.retainedHits ?? 0;
      aggregate.elapsedMs += result.elapsedMs ?? 0;
      aggregateByModel.set(result.label, aggregate);

      queryModels.push({
        label: result.label,
        overlapAtK,
        missingCount: missing.length,
        falsePositiveCount: falsePositives.length,
        missingPassageIds: missing,
        falsePositivePassageIds: falsePositives,
        elapsedMs: result.elapsedMs ?? null,
      });
    }

    perQuery.push({
      queryId: run.query.id,
      queryText: run.query.text,
      referenceLabel: referenceResult.label,
      models: queryModels,
    });
  }

  const aggregate = Array.from(aggregateByModel.entries())
    .map(([label, stats]) => ({
      label,
      ...stats,
      averageElapsedMs: stats.queries - stats.skipped > 0 ? stats.elapsedMs / (stats.queries - stats.skipped) : null,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  const payload = {
    generatedAt: new Date().toISOString(),
    inputDir,
    k: options.k,
    aggregate,
    perQuery,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2));
  process.stdout.write(`${JSON.stringify({ outputPath, queryCount: perQuery.length }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
