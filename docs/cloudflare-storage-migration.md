# Cloudflare Storage Migration

This document is the implementation plan for removing Neon from AlphaBook and moving the stack to Cloudflare-native storage.

## Goal

Replace the current:

- Neon/Postgres for relational state
- Neon/pgvector for semantic retrieval

with:

- D1 for relational application state
- Vectorize for semantic vector retrieval
- R2 for corpus payloads and run artifacts
- Workers/Queues for orchestration

The target product surface is:

- `semantic`: Google embeddings + Vectorize + alphaloop
- `comprehensive`: existing runtime/deep-research lane

## Why This Is Not A Simple Swap

The current repo relies on Postgres-specific features:

- `vector(1536)` and pgvector similarity in `chunks.embedding`
- `tsvector` lexical search over chunk and metadata text
- Postgres casts and array operators throughout `NeonAppStore`

See:

- `packages/db/migrations/0001_initial.sql`
- `apps/orchestrator-worker/src/store.ts`
- `apps/ingest/src/index.ts`

Because D1 is SQLite-based, the migration has to separate relational state from vector search.

## Target Architecture

### D1

Use D1 for:

- users
- chat sessions
- messages
- runs
- tool calls
- runtime instances
- artifacts metadata
- notifications
- billing events
- feed snapshots
- lightweight document/work metadata

### Vectorize

Use Vectorize for:

- chunk embeddings
- nearest-neighbor retrieval for semantic mode

Store only retrieval-critical metadata with each vector:

- `chunkId`
- `workId`
- `chunkIndex`
- `language`
- `rightsStatus`
- `year`

Chunk text remains canonical in R2 and/or D1 metadata tables.

### R2

Keep R2 for:

- raw source files
- clean text
- `chunks.jsonl`
- research artifacts
- workspace hydration payloads

## Embeddings

Recommended embedding model:

- Google `gemini-embedding-2-preview`
- `output_dimensionality=1536`

Why `1536`:

- matches the current vector width used by the repo
- fits typical Vectorize limits
- avoids unnecessarily doubling storage and query payload size

Switching embedding providers requires a full corpus re-embed.

## Migration Phases

### Phase 1: Infrastructure Abstractions

Add:

- D1 DB client wrapper
- Vectorize repository wrapper
- Google embedding client
- env/config flags for provider selection

This phase should not change production behavior by default.

### Phase 2: Semantic Retrieval Cutover

Implement a new semantic path:

- generate Google query embeddings
- query Vectorize for candidate chunks
- hydrate chunk payloads from canonical storage
- run alphaloop over those candidates

Keep `comprehensive` on the runtime lane.

### Phase 3: Ingest Cutover

Change ingest to:

- generate Google embeddings
- write chunk metadata to canonical storage
- upsert vectors to Vectorize

Dual-write during migration if rollback is required.

### Phase 4: Relational State Port

Port `NeonAppStore` responsibilities into a D1-backed store.

This is the largest phase because many queries currently assume Postgres syntax and features.

### Phase 5: Neon Removal

After D1 and Vectorize are both live and verified:

- disable Neon reads
- disable Neon writes
- remove `@neondatabase/serverless`
- remove Postgres-specific schema/migration code

## Rollout Flags

Recommended rollout controls:

- `EMBEDDING_PROVIDER=openai|google`
- `SEMANTIC_BACKEND=postgres|vectorize`
- `APP_DB` D1 binding optional until D1 store parity lands

## Immediate Next Code Tasks

1. Add `VectorSearchIndex` abstraction to worker retrieval flow.
2. Implement Vectorize-backed chunk lookup by `chunkId`.
3. Build a D1 app-store equivalent for sessions/messages/runs/tool calls.
4. Replace Postgres-only metadata search with D1-compatible indexed lookups.
5. Add migration/backfill scripts:
   - Neon -> D1 relational state
   - OpenAI embeddings -> Google embeddings -> Vectorize

## Deployment Order

1. Provision D1 database.
2. Provision Vectorize index.
3. Deploy worker with abstractions and flags defaulted to current Neon behavior.
4. Backfill Vectorize.
5. Flip semantic mode to Vectorize.
6. Backfill D1 relational state.
7. Flip app-state reads/writes to D1.
8. Remove Neon.
