# AlphaBook

AlphaBook is now structured as a monorepo for the architecture you specified:

- `apps/frontend`: Cloudflare Pages frontend
- `apps/orchestrator-worker`: Cloudflare Worker API on `api.<domain>`
- `apps/runtime`: Fly Machine runtime service for filesystem-backed analysis
- `apps/ingest`: DigitalOcean-oriented ingest service with persistent disk
- `packages/db`: Neon schema and migration utilities
- `packages/shared`: shared tool schemas, prompts, limits, and storage conventions
- `packages/tooling`: local scripts such as migrations

## Current Status

Phase 1 is implemented:

- `POST /chat` and `GET /health` exist in the orchestrator Worker
- the planner loop is deterministic code around an LLM planner
- retrieval tools are implemented:
  - `search_works`
  - `get_work_metadata`
  - `get_relevant_chunks`
  - `get_work_text`
- tool calls and run state are persisted through the store interface
- final answer artifacts are written to R2
- a happy-path retrieval test passes

Phase 2 is implemented:

- the Worker can create and destroy Fly Machines
- runtime instances are persisted in Neon
- workspace manifests and runtime artifacts are written to R2
- the runtime hydrates `/workspace/books`, `/workspace/chunks`, and `/workspace/context` from R2 keys
- the Worker can run a bounded runtime task, read back `output/summary.md`, and persist the result
- runtimes are reused per session when they already contain the requested works

Phase 3 remains scaffolded:

- the ingest service can ingest a single Gutenberg URL or a local Gutenberg mirror copy into Neon + R2 for the V1 path
- the DigitalOcean rsync mirror box bootstrap and systemd timer are included under `ops/digitalocean`
- daily Project Gutenberg feed diffing still needs to be completed
- chunk embedding generation/upload still needs to be completed

## Monorepo Tree

```text
apps/
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
  db/
    migrations/
    src/
  shared/
    src/
  tooling/
    scripts/
docs/
  api-contracts.md
  environment.md
ops/
  digitalocean/
```

## Assistant Experience

The frontend now ships a real chat interface in `apps/frontend`:

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

## Environment

The full environment list is in [docs/environment.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/environment.md).

Core variables:

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

Install dependencies:

```bash
npm install
```

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
