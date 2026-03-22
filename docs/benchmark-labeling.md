# Benchmark Labeling

This document defines the minimum human-labeling work still required before the CLI retrieval study is paper-ready.

## What Must Be Labeled

Each benchmark query needs passage-level labels in `QuerySet.queries[].labels`.

Use these grades:

- `2`: materially helps answer the query
- `1`: somewhat relevant or supporting context
- `0`: leave unlabeled; irrelevant passages should not be listed

## Current Grief Benchmark Status

The grief query sets currently checked into the repo are author-written but unlabeled:

- `data/benchmarks/grief-25-query-set.json`
- `output/benchmark-samples/grief-5-query-set.json`
- `output/benchmark-samples/grief-1-query-set.json`

Run the audit script to get an exact status report:

```bash
npm run benchmark:audit-labels -- \
  --query-set data/benchmarks/grief-25-query-set.json \
  --output output/benchmark-runs/grief-25-label-audit.json
```

If you also want to validate that labeled passage ids exist in a frozen corpus:

```bash
npm run benchmark:audit-labels -- \
  --query-set output/benchmark-samples/grief-5-query-set.json \
  --corpus output/benchmark-samples/grief-topical-2-books.json \
  --output output/benchmark-runs/grief-5-label-audit.json
```

## Labeling Standard

For each query:

1. Read the query and its `notes`.
2. Review the top silver-labeled and top retrieved passages.
3. Mark all passages that materially answer the query as grade `2`.
4. Mark edge-case or supporting passages as grade `1`.
5. Do not reward passages that only mention grief-adjacent words without answering the query.

## Minimum v1 Labeling Goal

To support a credible first paper slice:

- fully label the `grief-5-v1` query set against `grief-topical-2-books`
- spot-audit the silver labels used to bootstrap those queries
- freeze the resulting labeled query set as a versioned JSON artifact

The larger `grief-25-v1` set can stay in-progress until the small slice is stable.
