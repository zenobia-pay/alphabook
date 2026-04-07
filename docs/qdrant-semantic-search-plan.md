# Qdrant Semantic Search Migration Plan

## Summary

Migrate AlphaBook semantic retrieval from Cloudflare Vectorize to a dedicated Qdrant deployment on DigitalOcean, using Google Gemini embeddings with a clean full-corpus rebuild from the existing Gutenberg mirror.

**Final decisions**
- Vector DB: **Qdrant**
- Host: **dedicated DigitalOcean droplet**, separate from the current mirror box
- Production machine: **Storage-Optimized, 64 GiB RAM / 8 vCPU / 1.17 TB NVMe**
- Embedding model: **`gemini-embedding-001`**
- Bulk embedding path: **Google paid Batch API**
- Live query embedding path: **Google paid Standard API**
- Embedding dimensionality: **`768`**
- Chunk target size: **`2800` characters**
- Distance metric: **Cosine**
- Qdrant settings: **on-disk vectors, on-disk HNSW, on-disk payload, scalar quantization**
- Source corpus: exact raw `.txt` / `.txt.utf-8` files from `/srv/alphabook/gutenberg`
- Exact current text-only size: **63,145,480,516 bytes** (`58.81 GiB`)
- Estimated vector count at 2800 chars: **22,551,957**
- Estimated one-time corpus embedding cost: **~$1,184** at `$0.075 / 1M tokens`

**Why this configuration**
- The current droplet is too small for local vector search.
- `1400 x 1536` is too expensive in vector count, storage, and RAM.
- `2800 x 768` is the best cost/quality operating point for this corpus without over-optimizing prematurely.
- Qdrant is a better fit than Neon/pgvector, Chroma, or Cloudflare Vectorize for a `20M+` vector corpus.

## Architecture Changes

### Retrieval stack

Keep:
- DigitalOcean Gutenberg mirror as source text
- R2 as canonical artifact storage
- D1 as metadata and chunk catalog
- DigitalOcean Linux API/orchestrator as the runtime app layer

Change:
- Replace Cloudflare Vectorize as the primary semantic index with Qdrant
- Query Qdrant from the Worker over HTTPS
- Keep chunk text resolution in the existing store path after vector retrieval

### Vector provider abstraction

Extend the existing vector index abstraction so the API can instantiate either provider by config.

Implementation intent:
- keep `VectorSearchIndex` interface shape unchanged
- add `QdrantVectorIndex` implementation
- preserve `query(vector, { topK, filter, returnMetadata })`
- preserve `upsert(vectors)` semantics for ingest

Main files to update:
- [`apps/orchestrator-worker/src/vectorize.ts`](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/apps/orchestrator-worker/src/vectorize.ts)
- [`apps/orchestrator-worker/src/linux-env.ts`](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/apps/orchestrator-worker/src/linux-env.ts)
- [`apps/ingest/src/index.ts`](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/apps/ingest/src/index.ts)

### Payload design

Qdrant should store only retrieval-critical metadata, not full text.

Store in Qdrant payload:
- `work_id`
- `chunk_index`
- `adapter_id`
- `gutenberg_id`
- `language` if present
- any existing narrow filter fields used by semantic search

Do not store:
- full chunk text
- long excerpts
- redundant book metadata already available in D1/R2

### Environment and configuration

Add:
- `VECTOR_PROVIDER=qdrant`
- `QDRANT_URL`
- `QDRANT_API_KEY`
- `QDRANT_COLLECTION`
- `QDRANT_TIMEOUT_MS`
- `QDRANT_UPSERT_BATCH_SIZE`
- `QDRANT_QUERY_TIMEOUT_MS`

Change defaults:
- `EMBEDDING_PROVIDER=google`
- `GOOGLE_EMBEDDING_MODEL=gemini-embedding-001`
- `GOOGLE_EMBEDDING_DIMENSIONS=768`
- `GOOGLE_EMBEDDING_BATCH_SIZE=32`
- `GUTENBERG_CHUNK_TARGET_SIZE=2800`

## Embedding Strategy

### Bulk corpus embedding

Use **Google paid Batch API** for the full backfill.

Reason:
- standard free tier is too slow and too rate-limited for a `15.79B` token corpus
- batch is the operationally correct path for one-time full-corpus embedding
- `gemini-embedding-001` has a published price, unlike the preview model path previously used

Implementation changes:
- keep the existing Google batch embedding flow
- switch default model from `gemini-embedding-2-preview` to `gemini-embedding-001`
- switch default dimensions from `1536` to `768`
- preserve retry logic and response-length validation
- add explicit checkpointing at book-level progress so long runs can resume cleanly

### Live query embedding

Use **Google paid Standard API** for user query embeddings.

Reason:
- avoids free-tier limits and product-improvement data-sharing mode
- keeps runtime latency lower than trying to route live queries through batch
- maintains model consistency between document embeddings and query embeddings

Implementation changes:
- update Worker embedder config to use `gemini-embedding-001`
- request `768` dimensions for query embeddings
- keep graceful degradation when query embedding fails

### Chunking

Make Gutenberg chunk size configurable instead of hard-coded.

Chosen default:
- `2800` characters

Reason:
- reduces total vector count from ~45.1M to ~22.55M
- keeps chunks passage-sized enough for semantic retrieval
- gives a manageable storage target for Qdrant without needing a huge box

Implementation intent:
- parameterize the Gutenberg chunker in [`packages/source-gutenberg/src/text.ts`](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/packages/source-gutenberg/src/text.ts)
- pass the configured target size through ingest
- persist the resulting chunk manifests as canonical output for rebuilds

## Qdrant Deployment

### Box size

Provision a new Qdrant host:
- **DigitalOcean Storage-Optimized Droplet**
- **64 GiB RAM**
- **8 vCPU**
- **1.17 TB NVMe**
- current cited price in prior planning: **$524/mo**

Reason for this exact tier:
- local NVMe is preferable to block storage for Qdrant’s on-disk vector and HNSW access
- 64 GiB RAM provides safe headroom for Qdrant, OS page cache, background compaction, and ingest bursts
- 1.17 TB NVMe leaves room for:
  - collection data
  - HNSW graph
  - quantization state
  - WAL
  - snapshots
  - rebuild slack
  - future growth

Reject:
- current mirror box
- “just add 100 GiB” to the current mirror box
- Neon/pgvector for the full corpus
- Chroma for production at this scale

### Qdrant collection settings

Create a single collection with:
- vector size: `768`
- distance: `Cosine`
- `vectors.on_disk = true`
- `hnsw_config.on_disk = true`
- `on_disk_payload = true`

Enable scalar quantization:
- `type = int8`
- `quantile = 0.99`
- `always_ram = true`

Initial HNSW settings:
- `m = 16`
- `ef_construct = 100`
- runtime `hnsw_ef = 128`

These are the initial production defaults. Tune only after load testing.

### Service exposure

Deploy Qdrant behind HTTPS on a dedicated hostname, for example `qdrant.alpha-book.org`.

Deployment requirements:
- Qdrant bound locally/private only
- reverse proxy terminates TLS
- API key enforced
- health checks exposed
- nightly snapshots copied off-box
- restore procedure tested once before cutover

## Corpus Rebuild And Cutover

### Rebuild strategy

Do a clean semantic-index rebuild from the DigitalOcean mirror.

Sequence:
1. Freeze recurring Gutenberg timers on the mirror box.
2. Provision and secure the Qdrant host.
3. Add Qdrant provider support to the app and ingest code.
4. Make chunk size configurable and set it to `2800`.
5. Change Google embedding defaults to `gemini-embedding-001` and `768`.
6. Rebuild chunk artifacts from raw mirror text.
7. Upsert vectors into Qdrant during ingest.
8. Validate vector counts and query quality on a staged subset.
9. Switch Worker config to `VECTOR_PROVIDER=qdrant`.
10. Leave Vectorize available as temporary fallback during validation.
11. Remove fallback after parity is confirmed.

### Staged rollout

Run in three stages:
- `100` books smoke test
- `2,000` books medium validation
- full corpus rebuild

For each stage, validate:
- expected chunk count
- expected vector count
- successful Qdrant upserts
- end-to-end semantic search
- search quality on known prompts

### Migration notes

Do not:
- import stale Vectorize data into Qdrant
- preserve old chunk boundaries
- mix old `1536`-dim vectors with new `768`-dim vectors in the same production path

Do:
- re-chunk
- re-embed
- re-upsert cleanly from the mirror

## Tests And Acceptance Criteria

### Automated tests

Add or update tests for:
- Google embedding requests use `gemini-embedding-001`
- embedding requests use `768` dimensions
- Gutenberg chunking respects configured target size
- Qdrant client maps search results into `VectorSearchMatch`
- Qdrant filter translation preserves scoped semantic search behavior
- Qdrant upsert retries transient failures
- Worker uses Qdrant when configured
- Worker degrades gracefully on Qdrant failure

### Operational validation

Validate:
- collection size matches expected chunk count
- semantic retrieval works for representative book-scoped and corpus-wide prompts
- query latency is acceptable under expected concurrency
- snapshots and restore work
- Qdrant survives service restart without index corruption

### Acceptance criteria

The migration is complete when:
- all current mirror books are re-chunked at `2800`
- all chunk embeddings are rebuilt with `gemini-embedding-001` at `768`
- Qdrant vector count matches rebuilt chunk count
- Worker semantic search runs entirely against Qdrant in production
- retrieval quality on a fixed evaluation set is acceptable
- snapshot and restore have been tested successfully

## Assumptions And Defaults

- The corpus remains Gutenberg raw text only.
- One vector per chunk remains the indexing strategy.
- Full text continues to live outside Qdrant.
- `gemini-embedding-001` is the final production model.
- Free-tier Google embeddings are not used for production backfill or runtime query embedding.
- `2800` characters and `768` dimensions are the final production defaults unless evaluation proves unacceptable quality loss.
- A dedicated Qdrant droplet is required; the current mirror droplet is not reused for vector search.
