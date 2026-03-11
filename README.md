# alphabook

`alphabook` is a local prototype for the three-loop research system you described:

1. `embeddings` loop for fast corpus-level relevance ranking.
2. `plain-text` loop for exact and lexical evidence retrieval.
3. `agent` loop for deeper per-book research, with a real Terminal Use CLI path when configured and a local fallback when it is not.

The seed corpus starts with Project Gutenberg's Don Quixote and is structured so the same pipeline can later ingest research papers or broader corpora.

## What is implemented

- Local ingestion and indexing for public-domain text.
- Built-in Don Quixote seed source.
- Chunking with overlap so both embeddings and agent runs get stable context windows.
- Local SQLite corpus store for books, chunks, and embeddings.
- OpenAI embeddings when `OPENAI_API_KEY` is present.
- Deterministic hashed embeddings fallback for local development and tests.
- Fast hybrid search that combines corpus-level embeddings with plain-text chunk ranking.
- Slow research mode that runs a deeper per-book loop across relevant books.
- Terminal Use CLI adapter that can attach a per-book filesystem and launch a remote task when `tu` is available, authenticated, and configured.

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

## Terminal Use integration

The slow loop will use Terminal Use only when all of these are true:

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
