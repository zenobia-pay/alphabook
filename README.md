# alphabook

`alphabook` is a local prototype for the research system you described:

1. `fast` embeddings plus plain-text retrieval inside the Worker.
2. `agent` research via a separate server that can run CLI tools such as `codex exec`.
3. fallback local deep-scan research when no CLI agent is enabled.

The repo still ships with Don Quixote as the seeded demo corpus, but the live ingestion path now accepts arbitrary Project Gutenberg book URLs and opens them in a dedicated `/book/:id` reading surface with the assistant rail beside the text.

## What is implemented

- Local ingestion and indexing for public-domain text.
- Built-in Don Quixote seed source.
- Chunking with overlap so both embeddings and agent runs get stable context windows.
- Local SQLite corpus store for books, chunks, and embeddings.
- OpenAI embeddings when `OPENAI_API_KEY` is present.
- Deterministic hashed embeddings fallback for local development and tests.
- Fast hybrid search that combines corpus-level embeddings with plain-text chunk ranking.
- Slow research mode that prefers a Codex CLI runner, then Terminal Use, then a local deep scan.
- Terminal Use CLI adapter that can attach a per-book filesystem and launch a remote task when `tu` is available, authenticated, and configured.
- FastAPI agent server for running Codex-backed jobs outside the Worker runtime.
- Gutenberg import path for HTML reading pages such as `https://www.gutenberg.org/cache/epub/41687/pg41687-images.html`.
- Gutenberg import path for plain-text URLs such as `https://www.gutenberg.org/cache/epub/996/pg996.txt`.

## Quickstart

```bash
uv venv
source .venv/bin/activate
uv pip install -e ".[dev]"
```

Index Don Quixote:

```bash
alphabook ingest-seed don-quixote
```

Run the fast search loop:

```bash
alphabook search "windmills and knightly delusion"
```

Run the slow research loop:

```bash
alphabook research "all the times people are talking about sadness" --mode slow
```

Enable the Codex runner explicitly:

```bash
export ALPHABOOK_ENABLE_CODEX_RUNNER=1
alphabook research "all the times people are talking about sadness" --mode slow
```

List indexed books:

```bash
alphabook list-books
```

Import a Gutenberg book directly into the agent backend:

```bash
curl -X POST http://127.0.0.1:9001/books/import-gutenberg \
  -H 'content-type: application/json' \
  --data '{"url":"https://www.gutenberg.org/cache/epub/41687/pg41687-images.html"}'
```

## Cloudflare Worker

This repo also includes a Cloudflare Worker web app. The Worker serves the frontend and the fast path. Imported Gutenberg books are fetched from the agent backend.

Build and deploy it:

```bash
npm install
npm run build:corpus
npm run deploy
```

Useful endpoints:

```bash
curl https://alphabook.founders-0e1.workers.dev/api/health
curl "https://alphabook.founders-0e1.workers.dev/api/search?q=windmills"
curl "https://alphabook.founders-0e1.workers.dev/api/research?q=sadness&mode=slow"
```

Local web flow for Gutenberg books:

```bash
export AGENT_BACKEND_URL=http://127.0.0.1:9001
npx wrangler dev
```

Then open `/`, paste a Project Gutenberg URL, and the app will redirect to `/book/<gutenberg-id>` with the assistant rail on the right.

## Agent server

Cloudflare Workers cannot spawn local CLI tools. The real `agent` path therefore lives in a separate Python service that the Worker can call.

Run it locally:

```bash
export ALPHABOOK_ENABLE_CODEX_RUNNER=1
alphabook-agent-server --host 127.0.0.1 --port 9001
```

Then point the Worker at it:

```bash
export AGENT_BACKEND_URL=http://127.0.0.1:9001
```

Optional hardening:

```bash
export ALPHABOOK_AGENT_API_TOKEN=change-me
export AGENT_BACKEND_TOKEN=change-me
```

The Worker keeps the fast path local and only uses the agent server for the slower CLI-backed route.

## Railway backend

The repo now includes a root [Dockerfile](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/Dockerfile) for deploying the agent server to Railway.

Recommended Railway variables:

```bash
ALPHABOOK_DATA_DIR=/data
ALPHABOOK_AGENT_API_TOKEN=...
ALPHABOOK_ENABLE_CODEX_RUNNER=0
ALPHABOOK_TERMINALUSE_PROJECT_ID=...
ALPHABOOK_TERMINALUSE_AGENT_NAME=agile-rattlesnake/alphabook-book-research
TU_TOKEN=... # optional, required if you want Railway to authenticate the tu CLI
```

The startup script is [docker/railway-entrypoint.sh](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docker/railway-entrypoint.sh).

## Terminal Use agent

The Terminal Use agent scaffold lives in [terminaluse/book_research_agent](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/terminaluse/book_research_agent). Deploy it with:

```bash
cd terminaluse/book_research_agent
tu deploy
```

## Terminal Use integration

The slow loop will use Terminal Use only when Codex is disabled or unavailable and all of these are true:

- `tu` is installed.
- `tu whoami --json` reports a non-expired session.
- `ALPHABOOK_TERMINALUSE_PROJECT_ID` is set.
- `ALPHABOOK_TERMINALUSE_AGENT_NAME` is set.

Optional:

- `ALPHABOOK_TERMINALUSE_BRANCH`

Example:

```bash
export ALPHABOOK_TERMINALUSE_PROJECT_ID=proj_...
export ALPHABOOK_TERMINALUSE_AGENT_NAME=namespace/book-research
alphabook research "melancholy and grief" --mode slow
```

When Terminal Use is unavailable, the same command falls back to a local deep-scan runner.

## Embeddings behavior

- Production path: OpenAI embeddings via `OPENAI_API_KEY`.
- Local/test path: hashed lexical embeddings.

The fallback keeps the pipeline runnable without external credentials, but the semantic quality is lower than real embeddings.

## Layout

- [docs/architecture.md](/Users/ryanprendergast/Documents/Zenobia Pay/alphabook/docs/architecture.md)
- [src/alphabook](/Users/ryanprendergast/Documents/Zenobia Pay/alphabook/src/alphabook)
- [tests](/Users/ryanprendergast/Documents/Zenobia Pay/alphabook/tests)
- [terminaluse/README.md](/Users/ryanprendergast/Documents/Zenobia Pay/alphabook/terminaluse/README.md)
