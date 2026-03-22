# CLI Retrieval Benchmarking

This repo now includes a first-pass benchmark harness for the paper thesis: CLI-first retrieval pipelines can surface relevant passages for associative queries in large corpora.

The tracked paper plan and progress checklist live in [docs/cli-retrieval-research-plan.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/cli-retrieval-research-plan.md).

## What Exists Now

- `@alphabook/benchmark-core` defines the benchmark contracts:
  - `BenchmarkCorpus`
  - `QuerySet`
  - `Retriever`
  - `BenchmarkRun`
- The harness computes the paper headline metrics:
  - `recallAt20`
  - `recallAt100`
  - `ndcgAt20`
  - `successAt20`
- The harness persists benchmark artifacts:
  - manifest
  - per-query run outputs
  - aggregate summaries

## Included Retrievers

- `cli-exact`: exact CLI-style lexical search
- `cli-expanded`: CLI-style retrieval with deterministic expansion
- `distributed-cli-N`: fan-out CLI retrieval across `N` shards
- `bm25-lite`: sparse baseline scaffold
- `semantic-lite`: dense-like baseline scaffold
- `hybrid-lite`: mixed sparse/expanded scaffold
- `comprehensive-<judge>`: exhaustive LLM judge over every passage batch in the corpus

The CLI runners try to use `rg` and fall back to an in-memory lexical scan when `rg` is unavailable. This keeps local development deterministic while preserving the bare-CLI execution model.

## Comprehensive Baseline

The benchmark package now supports a "comprehensive" retriever that scores every passage in the corpus with an LLM judge.

This is intended as an exhaustive silver baseline:
- it evaluates all passages rather than retrieving a candidate subset first
- it batches passages to fit within the model context window
- it ranks passages by the model's explicit relevance score

Important caveat:
- this is not ground truth
- it is an expensive, model-dependent reference ranking
- human labels still define the benchmark truth set

The provided OpenAI-backed judge uses chat completions with JSON-schema output and expects:
- `OPENAI_API_KEY`
- optional `OPENAI_MODEL`

When those env vars are present, `npm run benchmark:fixture` automatically includes the comprehensive baseline.

For a dedicated exhaustive-truth run on one query, use:

```bash
npm run benchmark:comprehensive -- --corpus ./data/books-corpus.json --query "dealing with grief" --output ./output/grief-truth.json
```

The script also supports:
- `--fixture` for local smoke tests
- `--query-set <path> --query-id <id>` to replay a frozen benchmark query
- `--filters '<json>'` for constrained searches
- `--top-k`, `--batch-size`, and `--min-score` to control output shape and judge batching

The input corpus file should be a JSON export in `BenchmarkCorpus` shape.

## Included Fixture Benchmark

The fixture corpus is intentionally small and only proves the harness shape.

It includes:
- five query families from the paper plan
- passage-level graded relevance labels
- one metadata-constrained query
- one associative query where deterministic term expansion matters

Run it from the repo root:

```bash
node --import tsx packages/tooling/scripts/run-benchmark-fixture.ts
```

Artifacts are written under `output/benchmark-runs/`.

## How To Extend This To The Paper Study

### Layer A: existing benchmarks

Add adapters that convert BEIR-style corpora and qrels into:
- `BenchmarkCorpus`
- `QuerySet`

Important rule: convert gold labels to passage windows before evaluation, not document-only hits.

### Layer B: in-domain corpora

Use the existing corpus adapter seam to create benchmark corpora for:
- books
- long-form papers
- archival text

Keep chunking fixed across retrievers unless a baseline makes that impossible.

### Layer C: associative benchmark

Use the same `QuerySet` contract for newly authored associative queries.

Recommended metadata fields:
- `family`
- `notes`
- source constraints such as `year` or `sourceType`

Recommended adjudication workflow:
1. Draft the annotation guide.
2. Label with two annotators.
3. Adjudicate disagreements on a subset.
4. Freeze the guide before scaling.

## Experimental Workflow

1. Build a corpus adapter or import corpus snapshots into `BenchmarkCorpus`.
2. Freeze the query set and labels in versioned JSON.
3. Run the benchmark harness across CLI, sparse, dense, and hybrid retrievers.
4. Persist raw run outputs and summaries.
5. Slice summaries by query family for paper tables.

## Current Limits

- Baselines are scaffolds, not publication-grade SOTA implementations.
- Distributed CLI is a local shard fan-out model, not a production VM orchestrator yet.
- BEIR import and large-corpus adapters still need to be added.
- Cost accounting currently records rough resource usage, not cloud billing exports.

This is enough to start piloting the benchmark design inside the repo, pressure-test query families, and validate the artifact model before scaling up to publishable datasets.
