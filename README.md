# Alpha Research

Grounded research infrastructure for large text corpora, with `AlphaBook` and `AlphaJustice` as reference implementations.

Alpha Research is an open-source platform for retrieval, runtime analysis, and cited synthesis over large corpora.

This repository currently ships two implementations on the same architecture:

- `AlphaBook`: the book-centric reference application that powers `alpha-book.org`
- `AlphaJustice`: a Supreme Court research implementation built on the same platform and adapter seams

## Quick Start

Install dependencies:

```bash
npm install
```

Run the supported OSS validation matrix:

```bash
npm run validate:oss
```

Try the Supreme Court demo corpus without provisioning DB or R2:

```bash
npx tsx apps/ingest/src/index.ts ingest-supreme-court-demo
```

That command falls back to local preview mode when infra env vars are not set.

## What This Repo Is

This repository is published as three things at once:

- Alpha Research, the shared corpus-research platform layer
- AlphaBook, the book-centric implementation that powers `alpha-book.org`
- AlphaJustice, the Supreme Court implementation that can be deployed separately

The boundary is intentional:

- the live AlphaBook product, routes, and user-facing copy stay book-centric
- AlphaJustice can have separate origins, branding, and dataset copy without forking the shared app structure
- the AlphaBook HTTP API stays `work` and `book` shaped for compatibility
- the generic extension points for OSS adopters live in the platform and adapter packages, plus the neutral document API under `/api/v1/documents/*`

If you want to reuse the generic internals, start with:

- [docs/oss-supported-surface.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/oss-supported-surface.md)
- [docs/oss-quickstart.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/oss-quickstart.md)
- [docs/bring-your-own-corpus.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/bring-your-own-corpus.md)
- [docs/adapter-architecture.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/adapter-architecture.md)

The repo is structured as a shared core-plus-implementations monorepo:

- `apps/frontend`: Cloudflare Pages frontend
- `apps/alphajustice-frontend`: AlphaJustice frontend wrapper over the shared frontend app
- `apps/orchestrator-worker`: Cloudflare Worker API on `api.<domain>`
- `apps/alphajustice-orchestrator`: AlphaJustice API wrapper over the shared orchestrator Worker
- `apps/runtime`: Fly Machine runtime service for filesystem-backed analysis
- `apps/ingest`: adapter-aware ingest service with Gutenberg production flows plus fixture and Supreme Court demo corpus paths
- `packages/corpus-core`: generic runtime limits and artifact key helpers
- `packages/corpus-text`: generic text embedding helpers
- `packages/implementations`: implementation-level branding, origins, and prompt configuration
- `packages/source-gutenberg`: Project Gutenberg adapter for ingest and storage conventions
- `packages/source-supreme-court`: Supreme Court corpus adapter and repository fixture for AlphaJustice
- `packages/db`: Neon schema and migration utilities
- `packages/shared`: AlphaBook-facing contracts, prompts, and compatibility exports
- `packages/tooling`: local scripts such as migrations

AlphaBook and AlphaJustice are both implementation layers on top of the same reusable platform packages.

If you want launch copy for the repo, see [docs/github-launch.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/github-launch.md).

## Implementations

- `packages/corpus-core` and `packages/corpus-text` are generic substrate.
- `packages/implementations` carries the implementation-specific configuration for AlphaBook and AlphaJustice.
- `packages/source-gutenberg` and `packages/source-supreme-court` are source adapters.
- AlphaBook and AlphaJustice are separate deployments built on top of that substrate.

The architecture overview lives in [docs/architecture.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/architecture.md).
The internal adapter seam for non-book corpora is documented in [docs/adapter-architecture.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/adapter-architecture.md).
The developer quickstart for adding another corpus is in [docs/bring-your-own-corpus.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/bring-your-own-corpus.md).
The supported open-source boundary is documented in [docs/oss-supported-surface.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/oss-supported-surface.md).
The local validation and fixture-corpus path is documented in [docs/oss-quickstart.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/oss-quickstart.md).
The open-source release checklist is in [docs/oss-release-checklist.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/oss-release-checklist.md).
The retrieval benchmark scaffold for the CLI-first research paper lives in [docs/benchmarking-cli-retrieval.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/benchmarking-cli-retrieval.md).
The additive neutral API and compatibility contract details live in [docs/api-contracts.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/api-contracts.md).

## Current Status

- Implemented:
  - Worker chat and health endpoints
  - retrieval, workspace hydration, and cited synthesis flow
  - Fly runtime creation and reuse
  - neutral document API plus AlphaBook compatibility API
  - adapter-aware ingest helpers
  - separate AlphaBook and AlphaJustice deployments
- Still incomplete:
  - daily Project Gutenberg feed diffing
  - full production-grade Gutenberg embedding backfill automation
  - broader turnkey scaffolding for arbitrary new datasets

## Monorepo Tree

```text
apps/
  alphajustice-frontend/
  alphajustice-orchestrator/
  frontend/
  orchestrator-worker/
    src/
    test/
    wrangler.toml
  runtime/
    src/
    Dockerfile
    fly.toml
  ingest/
    src/
    Dockerfile
packages/
  corpus-core/
    src/
  corpus-text/
    src/
  implementations/
    src/
  source-gutenberg/
    src/
  source-supreme-court/
    src/
  db/
    migrations/
    src/
  shared/
    src/
  tooling/
    scripts/
docs/
  architecture.md
  api-contracts.md
  environment.md
ops/
  digitalocean/
```

## Assistant Experience

The shared frontend in `apps/frontend` now ships a real chat interface:

- ChatGPT-style session sidebar
- one persistent assistant thread per session
- streaming answers from the Worker over SSE
- inline research log showing retrieval, workspace creation, runtime search, and synthesis
- screenshot-tested empty, active-thread, and history-reopen states

The orchestrator flow is now explicit:

1. `search_works` narrows the corpus
2. `get_relevant_chunks` runs lexical + embedding-aware retrieval
3. the planner decides whether a deeper workspace search is needed
4. `create_workspace`, `run_workspace_task`, and `read_workspace_file` pull back long-search evidence from a Fly runtime
5. a separate synthesis step compiles the retrieved evidence and runtime output into the final plain-English answer with citations

## CLI Agent Access

The orchestrator exposes a generic agent-facing path alongside browser auth:

- `GET /skill.md` publishes an installable prompt for agents
- `POST /api/v1/agents/register` creates a claimable API key plus a human-facing `claim_url`
- `GET /api/v1/agents/me` verifies a Bearer token
- `POST /api/v1/chat` streams the same research pipeline over CLI-friendly HTTP
- `GET /api/v1/sessions` and `GET /api/v1/sessions/:sessionId/messages` let agents reopen their own threads

The claim flow works like this:

1. an agent registers itself and receives an `api_key`
2. the agent sends the `claim_url` back to its human
3. the human opens that URL while signed into AlphaBook
4. the agent keeps using the same API key for headless research requests

This keeps the transport generic for non-browser agents while leaving room to attach billing and account ownership later through the claimed owner account.

## Environment

The full environment list is in [docs/environment.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/environment.md).

Operational runbooks:

- [docs/session-debugging.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/session-debugging.md) for tracing failed assistant sessions from the live API

Core variables include:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_SYNTH_MODEL`
- `OPENAI_EMBEDDING_MODEL`
- `TOOL_STREAM_CLEANUP_MODEL`
- `R2_BUCKET_NAME`
- `FLY_API_TOKEN`
- `FLY_RUNTIME_APP_NAME`
- `FLY_RUNTIME_APP_URL`
- `FLY_RUNTIME_IMAGE`
- `FLY_RUNTIME_REGION`
- `FLY_RUNTIME_SHARED_TOKEN`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `GUTENBERG_MIRROR_ROOT`
- `RUNTIME_SERVICE_URL`
- `RUNTIME_SERVICE_TOKEN`
- `QUEUE_INGEST_NAME`
- `QUEUE_JOBS_NAME`
- `VITE_API_BASE_URL`

## Local Development

Run Neon migrations:

```bash
DATABASE_URL=postgres://... npm run migrate
```

Run the Worker locally:

```bash
cd apps/orchestrator-worker
npx wrangler dev
```

Run the local Node-backed assistant API harness used by Playwright:

```bash
PORT=8788 npm run dev:node -w @alphabook/orchestrator-worker
```

Run the frontend locally:

```bash
npm run dev:frontend
```

Run the Fly runtime service locally:

```bash
npm run dev:runtime
```

Run the ingest service locally:

```bash
npm run dev:ingest
```

Ingest from a local Gutenberg mirror:

```bash
GUTENBERG_MIRROR_ROOT=/srv/alphabook/gutenberg \
npx tsx apps/ingest/src/index.ts ingest-gutenberg 12345
```

Run the local non-book fixture ingest demo:

```bash
npx tsx apps/ingest/src/index.ts ingest-fixture
```

Run the Supreme Court demo ingest:

```bash
npx tsx apps/ingest/src/index.ts ingest-supreme-court-demo
```

Backfill the local mirror into Neon + R2 in batches:

```bash
GUTENBERG_MIRROR_ROOT=/srv/alphabook/gutenberg \
OPENAI_API_KEY=... \
npx tsx apps/ingest/src/index.ts backfill-mirror - 100
```

Run validation:

```bash
npm run typecheck
npm run test
npm run test:ui
```

## Open Source

- License: [LICENSE](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/LICENSE)
- Contributing guide: [CONTRIBUTING.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/CONTRIBUTING.md)
- Security policy: [SECURITY.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/SECURITY.md)

## API Contracts

The request/response contracts are documented in [docs/api-contracts.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/api-contracts.md).

## Notes

- The frontend uses `assistant-ui` for the thread/composer surface and streams `POST /chat` responses over SSE.
- The orchestrator Worker is now configured for Cloudflare Workers AI as well as OpenAI. The intended cheap lane is `@cf/zai-org/glm-4.7-flash` for future tool-stream cleanup and normalization, while the main research path remains on OpenAI.
- `GET /me`, `/auth/sign-in`, `/auth/callback`, and `/auth/sign-out` provide the WorkOS-backed login flow.
- `GET /sessions` plus `GET /sessions/:sessionId/messages` power the session history and sidebar reopening flow.
- The runtime service is designed to sit behind a Fly app URL and uses the `fly-force-instance-id` header so the Worker can talk to a specific Machine.
- The runtime service expects `RUNTIME_SHARED_TOKEN` plus R2 credentials so it can hydrate the workspace directly from R2 keys.
- The runtime agent now writes `summary.md`, `search-plan.json`, `search-iterations.json`, and `evidence.json` for each long VM search.
- The ingest service supports single-URL ingestion plus local Gutenberg mirror ingestion through `GUTENBERG_MIRROR_ROOT`.
- `run-once` now processes a mirror batch, and `backfill-mirror` can drain the rsync mirror into Neon + R2 with chunk embeddings.
- The Gutenberg mirror box bootstrap is documented in [ops/digitalocean/README.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/ops/digitalocean/README.md).
- Daily feed diffing is still the remaining ingest gap.
