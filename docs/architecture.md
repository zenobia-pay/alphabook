# Architecture

## Goal

Build a corpus research system with three distinct loops:

1. A fast embeddings loop that decides which books are relevant.
2. A plain-text loop that finds exact passages and lexical evidence.
3. A slow agent loop that can do deeper, whole-book reasoning on the books that survive the fast pass.

The current implementation starts with Don Quixote, but the storage and orchestration model are generic enough to accept research papers later. That is the bridge to an `alphaxiv`-style paper corpus: swap the ingester, keep the loops.

## System model

### Ingestion

- Fetch raw text from a source URL.
- Normalize and strip source boilerplate.
- Save canonical text under `data/raw/<book-id>.txt`.
- Chunk the text with overlap.
- Store book metadata, chunks, and embeddings in SQLite.

### Storage

SQLite tables:

- `books`
- `chunks`
- `embeddings`

The database stores:

- one row per book
- one row per chunk
- one embedding row per book
- one embedding row per chunk

This keeps the implementation simple, inspectable, and portable.

## The three loops

### 1. Embeddings loop

Purpose:

- Answer "which books should I even look at?"

Flow:

- Embed the query once.
- Compare against corpus-level book embeddings.
- Keep the top `k` candidate books.
- Within those books, compare the query against chunk embeddings for local evidence.

Why book embeddings exist in addition to chunk embeddings:

- They make corpus-level routing cheap.
- They let the slow loop fan out only where it matters.

### 2. Plain-text loop

Purpose:

- Recover exact phrasing and literal evidence.

Flow:

- Tokenize the query.
- Score chunks by phrase presence and token overlap.
- Return snippets that can be inspected directly.

Why this is separate from embeddings:

- Embeddings are good at fuzzy routing.
- Plain-text is better for quoted evidence, exact phrases, and deterministic debugging.

### 3. Agent loop

Purpose:

- Let a book-level worker inspect the entire text and run a more involved search strategy.

There are three operating modes:

- `fast`: no deep agents; use embeddings plus text search only.
- `slow`: embeddings route to relevant books, then fan out deeper runners only on that subset.
- `naive`: run a deeper per-book runner across every indexed book.

## Agent implementation strategy

### Local fallback runner

Implemented today:

- scans every chunk in a book
- combines semantic score and lexical score
- carries forward hint chunks from the fast pass
- returns a structured evidence bundle

This gives you a working slow loop without requiring a remote agent deployment.

### Terminal Use runner

Implemented as an adapter:

- prepares a per-book workspace
- writes the full book, manifest, hints, and query into that workspace
- creates a Terminal Use filesystem from the workspace
- creates a task for the configured agent
- sends the research prompt
- pulls the completed workspace back locally
- reads `output/report.md` if the remote agent writes it

This is the production shape for the "one agent per book/task" path, while still letting the repo run locally if Terminal Use is unavailable.

## Why this is structured this way

The naive approach you described is expensive:

- one terminal agent per book
- full-book scans everywhere

The embeddings loop changes the economics:

- query once
- route cheaply
- only fan out to the books that matter

That gives you:

- a low-latency interactive mode
- a high-recall deep mode
- a fully explicit fallback path

## Request lifecycle

### Ingest

1. Download Don Quixote from Project Gutenberg.
2. Strip Gutenberg header/footer.
3. Chunk the text.
4. Compute chunk embeddings.
5. Average chunk embeddings into a book embedding.
6. Persist everything to SQLite.

### Search

1. Embed the query.
2. Rank books by embedding similarity.
3. Rank chunks by embedding similarity inside the selected books.
4. Rank chunks again by lexical score.
5. Return both result sets.

### Research

1. Run the fast search path.
2. Pick candidate books based on mode.
3. Build per-book hints from the fast pass.
4. Run the deep runner in parallel.
5. Synthesize a final report.

## Current interfaces

CLI commands:

- `alphabook ingest-seed don-quixote`
- `alphabook ingest-url ...`
- `alphabook list-books`
- `alphabook search "..."`
- `alphabook research "..." --mode fast|slow|naive`
- `alphabook terminaluse-status`

## Extension path for research papers

To move from books to papers:

- add paper ingestion sources
- parse PDF or source text into canonical plain text
- retain the same chunk, embedding, and agent orchestration layers

Likely next additions:

- citation-aware metadata
- section-level chunk labels
- PDF page anchors
- corpus manifests for arXiv/alphaXiv imports
- cached report objects per query

## Limits of the current prototype

- SQLite stores vectors as JSON, which is fine for a prototype but not ideal at scale.
- The local fallback agent is a deep scan, not a fully autonomous remote Codex worker.
- Terminal Use task output parsing is intentionally tolerant because CLI banners can wrap JSON.

Those are acceptable tradeoffs for a first end-to-end build.
