import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createBm25LiteRetriever,
  createCliExactRetriever,
  createCliExpandedRetriever,
  createDistributedCliRetriever,
  createHybridLiteRetriever,
  createSemanticLiteRetriever,
  fixtureBenchmarkCorpus,
  fixtureQuerySet,
  persistBenchmarkRun,
  runBenchmark,
} from "../src/index";

test("expanded CLI and hybrid retrievers recover associative passages in the fixture set", async () => {
  const run = await runBenchmark({
    corpus: fixtureBenchmarkCorpus,
    querySet: fixtureQuerySet,
    retrievers: [
      createCliExactRetriever(),
      createCliExpandedRetriever(),
      createDistributedCliRetriever(2),
      createBm25LiteRetriever(),
      createSemanticLiteRetriever(),
      createHybridLiteRetriever(),
    ],
  });

  const exactAssociative = run.queryRuns.find((entry) => entry.retrieverId === "cli-exact" && entry.queryId === "q-associative");
  const expandedAssociative = run.queryRuns.find((entry) => entry.retrieverId === "cli-expanded" && entry.queryId === "q-associative");
  const distributedAssociative = run.queryRuns.find((entry) => entry.retrieverId === "distributed-cli-2" && entry.queryId === "q-associative");

  assert.ok(exactAssociative);
  assert.ok(expandedAssociative);
  assert.ok(distributedAssociative);
  assert.ok((expandedAssociative?.metrics.recallAt20 ?? 0) >= (exactAssociative?.metrics.recallAt20 ?? 0));
  assert.equal(distributedAssociative?.metrics.recallAt20, expandedAssociative?.metrics.recallAt20);
});

test("benchmark runs persist manifest, summaries, and query outputs", async () => {
  const run = await runBenchmark({
    corpus: fixtureBenchmarkCorpus,
    querySet: fixtureQuerySet,
    retrievers: [createCliExpandedRetriever()],
  });

  const root = await mkdtemp(path.join(tmpdir(), "alphabook-benchmark-output-"));
  try {
    const artifacts = await persistBenchmarkRun(run, root);
    const manifest = JSON.parse(await readFile(artifacts.manifestPath, "utf8")) as { queryRunCount: number };
    const summaries = JSON.parse(await readFile(artifacts.summariesPath, "utf8")) as Array<{ retrieverId: string }>;

    assert.equal(manifest.queryRunCount, fixtureQuerySet.queries.length);
    assert.deepEqual(summaries.map((entry) => entry.retrieverId), ["cli-expanded"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
