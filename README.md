# Alpha Research

Alpha Research is an extensible platform for grounded research over large text corpora.

This repository currently keeps one active reference product:

- `AlphaBook`, the book-centric reference app backed by a Project Gutenberg-derived corpus

It also keeps one small non-book proof point:

- `packages/source-fixture`, a minimal adapter and repository example used to validate that the platform is not Gutenberg-only

The important positioning is simple:

- this repo is extensible
- it is not turnkey
- AlphaBook stays book-specific
- the reusable surface lives in the platform, adapter, ingest, and repository seams

## Quick Start

Install dependencies:

```bash
npm install
```

Run the supported extensibility validation matrix:

```bash
npm run validate:extensible
```

`npm run validate:oss` still exists as a compatibility alias, but `validate:extensible` is the clearer name for what the command actually does.

Run the fixture corpus demo without provisioning Postgres or object storage:

```bash
npx tsx apps/ingest/src/index.ts ingest-fixture
```

That command falls back to local preview mode when the persistence env vars are not set.

If you want the full setup path for your own corpus, start with:

- [docs/oss-supported-surface.md](docs/oss-supported-surface.md)
- [docs/oss-quickstart.md](docs/oss-quickstart.md)
- [docs/deep-research-setup.md](docs/deep-research-setup.md)
- [docs/bring-your-own-corpus.md](docs/bring-your-own-corpus.md)
- [docs/adapter-architecture.md](docs/adapter-architecture.md)

## What This Repo Is

This repository is published as two things at once:

- Alpha Research, the shared corpus-research platform layer
- AlphaBook, the active book-centric reference implementation

The boundary is intentional:

- the live AlphaBook product, routes, and copy stay book-centric
- the AlphaBook HTTP API stays `work` and `book` shaped for compatibility
- the generic extension points for OSS adopters live in neutral packages and the additive `/api/v1/documents/*` API
- adding a new corpus still requires adapter, ingest, implementation, and deployment work

## Repo Shape

- `apps/frontend`: AlphaBook frontend
- `apps/orchestrator-worker`: Linux API and worker service
- `apps/runtime`: Linux runtime service for filesystem-backed analysis
- `apps/ingest`: adapter-aware ingest service
- `apps/book-content-worker`: static rendered-book content worker for AlphaBook
- `packages/corpus-core`: generic runtime limits and artifact key helpers
- `packages/corpus-text`: generic text embedding helpers
- `packages/platform`: neutral contracts, repository interfaces, and adapter registry
- `packages/implementations`: implementation-level branding, origins, and prompt configuration
- `packages/source-gutenberg`: Project Gutenberg adapter for ingest and storage conventions
- `packages/source-fixture`: minimal non-book adapter and repository example
- `packages/db`: database client and migration utilities
- `packages/shared`: AlphaBook-facing contracts, prompts, and compatibility exports
- `packages/tooling`: local scripts such as migrations and implementation scaffolding

## Current Status

- Implemented:
  - Linux API chat and health endpoints
  - retrieval, workspace hydration, and cited synthesis flow
  - Linux runtime service integration
  - neutral document API plus AlphaBook compatibility API
  - adapter-aware ingest helpers
  - implementation scaffolding for future corpus-specific deployments
- Still incomplete:
  - daily Project Gutenberg feed diffing
  - full production-grade Gutenberg embedding backfill automation
  - turnkey setup for arbitrary new datasets

## Validation

The supported validation entry point for the reusable surface is:

```bash
npm run validate:extensible
```

That command covers:

- implementation config typechecks and tests
- platform typechecks and tests
- DB typechecks and tests
- Gutenberg adapter typechecks and tests
- fixture adapter typechecks and tests
- shared compatibility typechecks
- ingest typechecks and tests
- focused orchestrator repository/store tests

If you change AlphaBook product code outside that surface, run the app-specific checks too.

## Environment

The full environment list is in [docs/environment.md](docs/environment.md).

Core variables include:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_SYNTH_MODEL`
- `OPENAI_EMBEDDING_MODEL`
- `TOOL_STREAM_CLEANUP_MODEL`
- `S3_BUCKET_NAME` or `SPACES_BUCKET_NAME`
- `S3_ENDPOINT` or `SPACES_ENDPOINT`
- `S3_ACCESS_KEY_ID` or `SPACES_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY` or `SPACES_SECRET_ACCESS_KEY`
- `S3_REGION` or `SPACES_REGION`
- `GUTENBERG_MIRROR_ROOT`
- `RUNTIME_SERVICE_URL`
- `RUNTIME_SERVICE_TOKEN`
- `QUEUE_INGEST_NAME`
- `QUEUE_JOBS_NAME`
- `VITE_API_BASE_URL`

## Local Development

Run database migrations:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/alphabook npm run migrate
```

Run the API:

```bash
npm run dev:orchestrator
```

Run the local Node-backed API harness:

```bash
PORT=8788 npm run dev:node -w @alphabook/orchestrator-worker
```

Run the frontend:

```bash
npm run dev:frontend
```

Run the runtime service:

```bash
npm run dev:runtime
```

Run the ingest service:

```bash
npm run dev:ingest
```
