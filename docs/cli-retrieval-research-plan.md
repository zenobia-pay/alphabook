# CLI Retrieval Research Plan

This document preserves the original research plan for the CLI-first retrieval paper and tracks implementation progress against it.

Last updated: 2026-03-22

## Status Snapshot

### Implemented

- Benchmark harness contracts in `@alphabook/benchmark-core`
- Core metrics:
  - `recallAt20`
  - `recallAt100`
  - `ndcgAt20`
  - `successAt20`
- Retrieval scaffolds:
  - `cli-exact`
  - `cli-expanded`
  - `distributed-cli`
  - `bm25-lite`
  - `semantic-lite`
  - `hybrid-lite`
- Exhaustive silver-label scoring pipeline
- Cheap-model selection workflow
- Topical corpus export for grief-themed benchmark slices
- End-to-end real IR benchmark runner:
  - silver label generation
  - retriever evaluation
  - artifact persistence

### In Progress

- First real topical IR benchmark run on a grief-themed corpus slice
- Scaling silver-label generation beyond tiny/small slices

### Not Yet Done

- BEIR or other standard benchmark adapters
- Human annotation workflow and adjudication metrics
- Large-corpus scaling experiments with shard-count sweeps
- Publishable-quality dense and hybrid baselines
- Final paper tables and figures

## Original Plan

### Summary

Goal: produce a paper that defends the claim that a composable architecture of bare CLI tools running across one or more VMs can recover a high share of relevant passages for associative queries in very large corpora.

Core contribution: a hybrid benchmark.

- Reuse standard IR datasets for comparability.
- Add a new, smaller associative-query passage benchmark to measure the failure mode existing benchmarks underweight.
- Treat retrieval quality and multi-VM scaling as co-primary results.

Success criteria:

- CLI pipelines are competitive on passage recall against strong lexical, dense, and hybrid baselines.
- CLI pipelines show especially strong recall on associative queries where exact keywords are unknown or incomplete.
- Multi-VM composition shows a credible scaling story on throughput, latency, or time-to-first-use without requiring heavyweight indexing up front.

## Benchmark Design

### 1. Task definition

Primary task: passage retrieval for associative queries.

- Input: a natural-language research query where relevance may be implied by theme, analogy, relation, or indirect description rather than exact lexical overlap.
- Output: ranked passages.
- A hit counts when any returned passage matches a gold relevant passage or passage window.

Query families:

- Lexical-easy: direct term overlap.
- Paraphrase: same concept, different wording.
- Associative: indirect relation, analogy, motif, or latent concept.
- Multi-hop thematic: asks for examples sharing a pattern across documents.
- Constraint-heavy: includes metadata filters such as period, author, or source type.

Recommendation: target 150-250 total queries for v1.

- 60-100 from existing datasets adapted to passage evaluation.
- 80-150 newly authored associative queries with human labels.

### 2. Dataset mix

Use a hybrid suite with three layers.

Layer A: existing benchmark datasets for comparability.

- Start with BEIR subsets that are passage-friendly or can be converted to passage windows.
- Prefer heterogeneous domains rather than only web/MS MARCO-style corpora.
- Report results both pooled and per dataset.

Layer B: in-domain large-text corpora.

- Use one or two corpora that match the CLI-VM thesis well: long-form books, papers, or archival text.
- Keep at least one corpus where indexing is costly enough that setup time matters.

Layer C: new associative passage benchmark.

- Build a benchmark centered on queries that do not reduce to obvious keyword lookup.
- Create gold labels at the passage level, not just document level.
- Use 2 annotators plus adjudication on a smaller subset to estimate agreement.

Annotation protocol:

- Define relevance as “materially helps answer the query,” not just “mentions overlapping words.”
- Allow multiple relevant passages per query.
- Store graded labels if possible: highly relevant, somewhat relevant, irrelevant.
- Freeze the annotation guide before labeling the full set.

### 3. Systems under test

CLI systems:

- Single-node CLI baseline: `rg`/`grep`/`awk`/`sed`/`find` style pipeline with deterministic query expansion and chunking.
- Distributed CLI system: same retrieval logic sharded across VMs, with fan-out/fan-in aggregation.
- CLI ablations:
  - exact lexical only
  - regex/pattern expansion
  - query rewrite or synonym expansion
  - shard-aware fan-out
  - optional lightweight reranking after recall stage

Non-CLI baselines:

- BM25 or Lucene-style sparse retrieval.
- One strong dense retriever.
- One hybrid sparse+dense retriever.
- One reranked stack if feasible.
- If you include agentic systems, treat them as secondary baselines, not the primary comparison.

Important rule: equalize chunking, corpus contents, and evaluation targets across systems as much as possible.

### 4. Metrics

Primary metrics:

- Recall@K at the passage level.
- nDCG@K if you keep graded relevance.
- Success@K: whether at least one highly relevant passage appears in top K.

Secondary metrics:

- Time-to-first-query on a fresh corpus.
- Query latency.
- Throughput under concurrent workloads.
- Compute cost and storage overhead.
- Index build time and index size for indexed baselines.

Scaling metrics:

- Recall retained as corpus size and shard count increase.
- Latency versus number of VMs.
- Cost-normalized recall and latency.

Recommended headline metric set:

- Recall@20, Recall@100, nDCG@20, time-to-first-query, p95 latency, dollars/query or machine-seconds/query.

## Implementation Changes / Study Execution

### 1. Evaluation harness

Define one benchmark harness with stable interfaces:

- `CorpusAdapter`: loads corpus, chunking policy, metadata filters.
- `QuerySet`: query text, family, gold passage ids, optional relevance grades.
- `Retriever`: standardized runner for CLI, BM25, dense, hybrid, and distributed systems.
- `RunResult`: ranked passages, scores, latency, resource usage, setup time.
- `JudgeRecord`: labels, annotator ids, adjudication status.

Artifacts to persist:

- frozen corpora manifests
- query set versions
- gold labels
- system configs
- raw ranked outputs
- per-query traces
- aggregate metric tables

### 2. Experimental matrix

Run four experiment groups.

Group A: comparability.

- Evaluate all systems on existing benchmark subsets.
- Goal: show CLI is not obviously non-competitive on standard retrieval.

Group B: associative retrieval.

- Evaluate all systems on the new associative benchmark.
- Goal: show where CLI pipelines recover relevant passages better, or with better recall-cost tradeoffs.

Group C: scaling/system experiments.

- Increase corpus size and shard count.
- Compare fresh-start behavior of CLI fan-out versus indexed systems requiring preprocessing.

Group D: ablations.

- Remove expansion, reranking, or distribution one at a time.
- Identify what actually drives gains.

### 3. Threat model and fairness controls

Control for the common failure modes up front.

- Same chunk size and overlap policy across systems unless impossible.
- Same corpus snapshots for every run.
- Same metadata filtering privileges.
- Separate retrieval from answer synthesis; the benchmark judges retrieved passages only.
- If any LLM-based query expansion is used, report it as a distinct condition, not hidden inside “CLI.”
- Prevent contamination by ensuring newly authored associative queries are not tuned directly on the held-out test split.

### 4. Paper structure

Target paper arc:

1. Existing IR benchmarks emphasize exact-match or standard semantic retrieval, but under-measure associative passage search in massive corpora.
2. CLI-first retrieval is a viable retrieval substrate, especially when composable and distributed.
3. On standard datasets it is competitive enough to be credible.
4. On associative passage retrieval it performs better on recall or on recall-vs-setup-time.
5. Distributed CLI execution scales without the upfront indexing burden.

## Test Plan

Before writing the paper, require these validation checks.

Benchmark validity checks:

- Inter-annotator agreement on the new benchmark.
- Gold-label spot audit by a third reviewer.
- Query-family balance review to ensure associative queries are not just synonym tests.
- Leakage audit between dev and test queries.

System correctness checks:

- Deterministic reruns for the same config.
- Passage-id alignment check across corpora/chunkers.
- Per-query trace inspection for at least 20 random failures.

Result scenarios that must be reported:

- Standard-dataset head-to-head on passage recall.
- Associative-only subset performance.
- Performance by query family.
- Fresh corpus with zero indexing.
- Large corpus with increasing VM count.
- Cost-normalized comparison.
- At least 5-10 qualitative error analyses where CLI wins and loses.

## Assumptions and Defaults

- Main claim: passage-level retrieval recall, not full end-to-end QA quality.
- Benchmark type: hybrid, with existing datasets plus a new associative benchmark.
- Baseline scope: maximal enough to be publishable, but keep agentic baselines secondary.
- Multi-VM scaling is co-primary with retrieval quality.
- Human labeling budget: moderate, sufficient for a targeted publishable benchmark rather than a massive public benchmark release.
- Default paper thesis: CLI pipelines do not need to win every metric; they need to show credible recall plus superior fresh-start, composability, or scaling tradeoffs on the workloads they target.
- If early pilots show CLI loses badly on standard BEIR-style tasks, narrow the claim explicitly to associative passage retrieval in large corpora rather than general IR.

## Progress Tracker

### Benchmark Design

- Task definition and query-family structure: `implemented`
- Passage-level benchmark contracts: `implemented`
- Associative grief query pilots: `implemented`
- Full v1 query inventory at 150-250 queries: `not started`

### Dataset Mix

- In-domain AlphaBook book corpus slices: `implemented`
- Topical corpus export for associative pilots: `implemented`
- BEIR / standard benchmark adapters: `not started`
- Human-labeled associative benchmark: `not started`

### Systems Under Test

- CLI exact baseline: `implemented`
- CLI expanded baseline: `implemented`
- Distributed CLI baseline: `implemented`
- Sparse baseline scaffold: `implemented`
- Dense baseline scaffold: `implemented`
- Hybrid baseline scaffold: `implemented`
- Publication-grade strong baselines: `not started`

### Metrics

- Core IR metrics: `implemented`
- Persistence of raw runs and summaries: `implemented`
- Time-to-first-query / setup-time hooks: `partially implemented`
- Cost-normalized reporting: `partially implemented`
- p95 latency reporting: `not started`

### Experimental Matrix

- Group A, standard benchmark comparability: `not started`
- Group B, associative topical pilots: `in progress`
- Group C, scaling and shard-count experiments: `not started`
- Group D, ablations: `not started`

### Validation

- Deterministic reruns on fixture benchmark: `implemented`
- Passage-id alignment through shared chunk ids: `implemented`
- Error analysis / disagreement analysis tooling: `implemented`
- Inter-annotator agreement and adjudication: `not started`

### Paper Readiness

- Cheap-model selection completed: `implemented`
- Real IR benchmark runner implemented: `implemented`
- First real topical IR run: `in progress`
- Final paper tables / figures / narrative: `not started`
