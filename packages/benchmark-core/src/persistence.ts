import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BenchmarkArtifacts, BenchmarkRun } from "./types";

export async function persistBenchmarkRun(run: BenchmarkRun, outputRoot: string): Promise<BenchmarkArtifacts> {
  const timestamp = run.completedAt.replaceAll(":", "-");
  const directory = path.join(outputRoot, `${run.corpusId}-${run.querySetId}-${timestamp}`);
  await mkdir(directory, { recursive: true });

  const manifestPath = path.join(directory, "manifest.json");
  const queryRunsPath = path.join(directory, "query-runs.json");
  const summariesPath = path.join(directory, "summaries.json");

  await writeFile(manifestPath, JSON.stringify({
    corpusId: run.corpusId,
    querySetId: run.querySetId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    queryRunCount: run.queryRuns.length,
    retrieverCount: run.summaries.length,
  }, null, 2));
  await writeFile(queryRunsPath, JSON.stringify(run.queryRuns, null, 2));
  await writeFile(summariesPath, JSON.stringify(run.summaries, null, 2));

  return {
    manifestPath,
    queryRunsPath,
    summariesPath,
  };
}
