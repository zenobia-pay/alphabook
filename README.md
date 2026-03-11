# alphabook

`alphabook` is a local prototype for the research system you described:

1. `fast` embeddings plus plain-text retrieval inside the Worker.
2. `agent` research via a separate server that can run CLI tools such as `codex exec`.
3. fallback local deep-scan research when no CLI agent is enabled.

The seed corpus starts with Project Gutenberg's Don Quixote and is structured so the same pipeline can later ingest research papers or broader corpora.

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

## Cloudflare Worker

This repo now also includes a deployable Cloudflare Worker that serves the Don Quixote corpus over HTTP.

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
