# Distributed Run Setup

This is the manual one-time provisioning path for persistent Fly shard machines.

It is intentionally separate from the runtime sprite fanout flow. The goal is:

- pick a deterministic 1,000-book shard
- copy that shard's prepared book files onto a Fly volume
- re-embed all stored chunk records for that shard with OpenAI Batch
- leave the Fly machine in place after provisioning

## Shard Contract

Shard ids are ordinal slices over the present Gutenberg ids in the consolidated source tree, sorted ascending numerically.

That means:

- `shard-0001` = first 1,000 present Gutenberg ids
- `shard-0002` = next 1,000 present Gutenberg ids
- and so on

This is intentionally not "Gutenberg ids 1 through 1000", because Gutenberg numbering has gaps.

## New Scripts

- `npm run distributed:build-shard`
  Build the deterministic shard manifest.
- `npm run distributed:stage-shard`
  Pull `books/<id>/` from the consolidated-books source into a local stage directory.
- `npm run distributed:reembed-shard`
  Read the shard's existing `chunks.jsonl` artifacts from the consolidated corpus, submit an OpenAI Batch embedding job, wait for completion, download results, and materialize shard-local vector files.
- `npm run distributed:provision-shard`
  Create or reuse a Fly app, volume, and machine, then upload the staged shard data onto the mounted volume.
- `npm run distributed:setup`
  One-shot orchestration for the full flow.

## Required Inputs

For the books side:

- a consolidated books root, for example `/mnt/alphabook_consolidation/final/latest`
- optionally a host like `root@<books-host>` if that root only exists remotely

For the embedding side:

- `OPENAI_API_KEY`
- optionally `OPENAI_EMBEDDING_MODEL`
- optionally `OPENAI_EMBEDDING_DIMENSIONS`

For Fly:

- `FLY_API_TOKEN`
- `FLY_RUNTIME_IMAGE` or `FLY_DISTRIBUTED_IMAGE`
- if you want the machine to run the runtime service immediately:
  - `RUNTIME_SHARED_TOKEN` or `FLY_RUNTIME_SHARED_TOKEN`

## Pilot: shard-0001

Dry run:

```bash
npm run distributed:setup -- \
  --shard-id shard-0001 \
  --source-host root@<books-host> \
  --source-root /mnt/alphabook_consolidation/final/latest \
  --fly-app alphabook-distributed-run \
  --fly-image registry.fly.io/alphabook-runtime:<tag> \
  --dry-run
```

Real run:

```bash
npm run distributed:setup -- \
  --shard-id shard-0001 \
  --source-host root@<books-host> \
  --source-root /mnt/alphabook_consolidation/final/latest \
  --fly-app alphabook-distributed-run \
  --fly-image registry.fly.io/alphabook-runtime:<tag> \
  --runtime-shared-token <token>
```

Default outputs land under:

- `output/distributed-run/shard-0001/manifest.json`
- `output/distributed-run/shard-0001/stage/`
- `output/distributed-run/shard-0001/stage/vectors/vectors.ndjson`
- `output/distributed-run/shard-0001/stage/vectors/vector-manifest.json`

On the Fly volume, the shard lands at:

- `/data/distributed-run/shard-0001`

## Notes

- The staged vector output contains all chunk embeddings for the shard's books, not just 1,000 vectors total.
- The re-embed step uses the already-stored `chunks.jsonl` artifacts from the consolidated corpus; it does not invent new chunk boundaries.
- The Fly machine provisioning path is idempotent enough for reruns. If the machine already exists, the script reuses it and refreshes the shard directory on the mounted volume.
- This workflow does not modify the existing sprite fanout catalog or runtime orchestration path.
