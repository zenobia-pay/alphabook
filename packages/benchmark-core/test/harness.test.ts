import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createBm25LiteRetriever,
  createCliExactRetriever,
  createCliExpandedRetriever,
  createComprehensiveLLMRetriever,
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

test("comprehensive llm retriever scores every passage batch and surfaces the gold associative evidence", async () => {
  const judgedBatches: string[][] = [];
  const run = await runBenchmark({
    corpus: fixtureBenchmarkCorpus,
    querySet: {
      ...fixtureQuerySet,
      queries: fixtureQuerySet.queries.filter((query) => query.id === "q-associative"),
    },
    retrievers: [
      createComprehensiveLLMRetriever({
        judge: {
          id: "mock-judge",
          async judgeBatch({ passages }) {
            judgedBatches.push(passages.map((passage) => passage.id));
            return passages.map((passage) => ({
              passageId: passage.id,
              score: passage.id === "ops-memo-p1" ? 0.99 : passage.id === "ops-memo-p2" ? 0.7 : 0.01,
              rationale: `judged ${passage.id}`,
            }));
          },
        },
        batchSize: 2,
      }),
    ],
  });

  assert.deepEqual(judgedBatches, [
    ["ops-memo-p1", "ops-memo-p2"],
    ["maintenance-journal-p1", "maintenance-journal-p2"],
    ["field-guide-p1", "field-guide-p2"],
  ]);

  const queryRun = run.queryRuns[0];
  assert.equal(queryRun?.retrieverId, "comprehensive-mock-judge");
  assert.equal(queryRun?.metrics.recallAt20, 1);
  assert.equal(queryRun?.hits[0]?.passageId, "ops-memo-p1");
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
