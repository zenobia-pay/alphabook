# Gutenberg Mirror To Consolidation

This guide explains the current AlphaBook corpus workflow and the specific path that produced the mounted prepared corpus under `/mnt/alphabook_consolidation`.

The core source of confusion has been treating two different workflows as if they were one:

- the live ingest path for `alpha-book.org`
- the prepared-artifacts path for Hermes-style research and bulk local corpus work

They are related, but they do different jobs.

## Short Version

There are two distinct pipelines:

1. Live product pipeline

`/srv/alphabook/gutenberg` mirror -> ingest on the mirror box -> R2 canonical artifacts + D1 metadata/chunks + Qdrant embeddings

2. Prepared research pipeline

`/srv/alphabook/gutenberg` mirror -> `prepare-local-gutenberg-artifacts` shard jobs -> per-box shard folders under `/root/alphabook-prepared/shards` -> consolidated tree under `/root/alphabook-prepared/final/...` -> mounted copy under `/mnt/alphabook_consolidation/final/latest`

The prepared research pipeline does **not** create live embeddings.

## Current Live Reality

The active ingest env on the mirror box at `/srv/alphabook/.ingest.env` now points at:

- `R2_BUCKET_NAME=alphabook-corpus-live`
- `D1_DATABASE_NAME=alphabook-app`
- `VECTOR_PROVIDER=qdrant`
- `QDRANT_URL=http://10.116.0.4:6333`
- `QDRANT_COLLECTION=alphabook-semantic`

So the live embedding store is Qdrant, not Cloudflare Vectorize.

The live rebuild wrappers on the mirror box still have older names like:

- `/srv/alphabook/bin/audit-cloudflare-corpus.sh`
- `/srv/alphabook/bin/rebuild-r2-corpus-all.sh`

but they run against the current ingest code and inherit the live Qdrant config from `/srv/alphabook/.ingest.env`.

## Step 1: Mirror The Gutenberg Source Data

The DigitalOcean rsync box keeps the Gutenberg mirror under:

- `/srv/alphabook/gutenberg`
- `/srv/alphabook/gutenberg/cache/epub`

That mirror is the shared source input for both the live ingest pipeline and the prepared-artifacts pipeline.

Relevant recurring sync helpers:

- [ops/digitalocean/bin/gutenberg-rsync.sh](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/ops/digitalocean/bin/gutenberg-rsync.sh)
- [ops/digitalocean/bin/gutenberg-rsync-epub.sh](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/ops/digitalocean/bin/gutenberg-rsync-epub.sh)

## Step 2: Live Ingest Writes Production State

For `alpha-book.org`, the mirror box runs ingest commands that write into:

- R2 canonical artifacts
- D1 work, work_files, chunk metadata, authors, and subjects
- Qdrant embeddings

The active helpers for that path are:

- [ops/digitalocean/bin/gutenberg-upload.sh](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/ops/digitalocean/bin/gutenberg-upload.sh)
- [ops/digitalocean/bin/backfill-gutenberg-bulk-safe.sh](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/ops/digitalocean/bin/backfill-gutenberg-bulk-safe.sh)
- [ops/digitalocean/bin/rebuild-r2-corpus-all.sh](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/ops/digitalocean/bin/rebuild-r2-corpus-all.sh)
- [ops/digitalocean/bin/rebuild-book-html-all.sh](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/ops/digitalocean/bin/rebuild-book-html-all.sh)

At the code level, this is the path that calls `upsertChunkVectors(...)` in [apps/ingest/src/index.ts](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/apps/ingest/src/index.ts).

That is why the live embeddings came from mirror-box ingest runs, not from the later prepared-artifacts jobs.

## Step 3: The Older Vectorize Path Failed

Before the Qdrant cutover, the older live-ingest path was still trying to write to Cloudflare Vectorize.

The clearest evidence is the mirror-box log:

- `/srv/alphabook/logs/gutenberg-bulk/20260328T042931Z/batch-0001-upload.json`

That run shows:

- `backfill-mirror-parallel`
- Cloudflare `wrangler vectorize upsert alphabook-semantic`
- `413 Payload Too Large`
- Google embedding `429 RESOURCE_EXHAUSTED`

That older path is what made the repo's old "Cloudflare corpus migration" framing misleading.

## Step 4: Prepared Shards Were Built Separately

After the live path moved toward Qdrant, a separate artifact-prep workflow ran on the qdrant box and companion boxes.

Those jobs used:

- `prepare-local-gutenberg-artifacts`

in [apps/ingest/src/index.ts](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/apps/ingest/src/index.ts).

That command writes only local artifacts:

- `books/<gutenberg-id>/manifest.json`
- `r2/gutenberg/raw/...`
- `r2/gutenberg/clean/...`
- rendered `book.html`, manifest, and page files

It does **not** call `upsertChunkVectors(...)`.

That means:

- it does not write to Qdrant
- it does not create the live embedding store

The qdrant-box shard logs show these shard families:

- `qdrant-1`
- `qdrant-2`
- `qdrant-3`
- `qdrant-4`
- `qdrant-5`
- `qdrant-5b`
- `qdrant-6`
- `qdrant-7`
- `qdrant-7b`
- `qdrant-8`
- `qdrant-8b`

The qdrant box also has ad hoc split and restart helpers outside the repo checkout:

- `/root/start_qdrant_workers.sh`
- `/root/split_remaining_qdrant.mjs`
- `/root/split_restart_qdrant.mjs`
- `/root/run-backfill-remaining-part3.sh`

Those scripts were used to repair incomplete shard coverage after the initial shard run.

## Step 5: Shards Were Consolidated

Each prep worker produced shard outputs under:

- `/root/alphabook-prepared/shards/<shard-name>`

with at least:

- `books/`
- `r2/`
- `run-manifest.json`

Those shards were then merged into final directories under:

- `/root/alphabook-prepared/final/...`

and exposed through the mounted path:

- `/mnt/alphabook_consolidation/final/latest`

The intended repo consolidation helper is:

- [ops/digitalocean/bin/consolidate-prepared-gutenberg-shards.sh](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/ops/digitalocean/bin/consolidate-prepared-gutenberg-shards.sh)

But the live boxes also used ad hoc copies, including:

- `/root/consolidate-prepared-gutenberg-shards.sh` on the qdrant box

So the mounted final tree is the product of both repo-managed logic and box-local ad hoc fixes.

## What `/mnt/alphabook_consolidation` Actually Contains

The mounted tree under `/mnt/alphabook_consolidation/final/latest` is a prepared local corpus, not the live product database.

It is intended to contain:

- `books/`
- `r2/`
- `manifests/`
- `research-corpus-index/`

In the April 2026 mounted state, the prepared corpus was only partially clean:

- `books/` was populated
- `r2/` was populated
- `manifests/` was incomplete relative to the expected shard list
- `research-corpus-index/` existed but was empty

So treat this mount as a useful prepared artifact tree, not as an authoritative proof that the full prep-and-index workflow completed cleanly.

## Why The Mounted Tree And Qdrant Diverged

The live embeddings and the prepared tree came from different commands:

- live embeddings: mirror-box ingest writing to Qdrant
- mounted prepared tree: shard jobs writing local `books/` and `r2/` artifacts

That is why you can have:

- a healthy Qdrant collection
- an incomplete or inconsistent prepared consolidation tree

without those facts contradicting each other.

## What To Trust Going Forward

For `alpha-book.org`, trust the live ingest pipeline:

- mirror box ingest
- R2
- D1
- Qdrant

For Hermes-style research and large local text sweeps, trust the prepared-artifacts pipeline:

- `prepare-local-gutenberg-artifacts`
- shard outputs
- consolidation
- optional `research-corpus-index`

Do not assume one pipeline automatically refreshes the other.

## Practical Rule

When asking "where did this come from?", first decide which of these you mean:

- live product search and retrieval state
- prepared local corpus files for research

If the question is about embeddings, start from the mirror-box ingest runs and Qdrant.

If the question is about `/mnt/alphabook_consolidation`, start from the qdrant-box shard jobs and consolidation scripts.
