# Adapter Architecture

AlphaBook remains a book-focused product, but the codebase now has an explicit adapter seam so the underlying research stack can be reused with non-book corpora.

## Design Goals

- keep `alpha-book.org` unchanged
- keep Gutenberg as the active production adapter
- make internal runtime, storage, and ingest concepts reusable
- preserve legacy `work`/`book` terminology for AlphaBook compatibility

## Generic Core

`packages/corpus-core` now defines neutral domain contracts:

- `CorpusAdapter`
- `CorpusDocument`
- `CorpusFile`
- `CorpusChunk`
- `CorpusWorkspaceManifest`

These types are intentionally generic and do not assume books, authors, or Gutenberg.

## Compatibility Layer

AlphaBook still uses legacy shapes such as `workId`, `authors`, and `book_html`.

To avoid breaking the live app, the runtime path uses compatibility helpers that:

- accept generic `documentId`/`contributors` internals
- emit legacy `workId`/`authors` aliases for existing AlphaBook code
- preserve the current Gutenberg R2 key layout and rendered book artifacts

## Production Adapter

`packages/source-gutenberg` now exposes `gutenbergCorpusAdapter`, which owns:

- workspace schema hints
- artifact key generation
- Gutenberg boilerplate cleanup
- text normalization and chunking hooks

AlphaBook continues to use this adapter by default.

## Adding Another Corpus

To add a new corpus without changing AlphaBook UX:

1. Implement a new `CorpusAdapter`.
2. Provide ingest logic and source-specific normalization in a new package.
3. Map the new corpus into generic `CorpusDocument` / `CorpusChunk` shapes.
4. Reuse the existing compatibility helpers if you need to interoperate with AlphaBook's current `work`-based runtime flow.

The `packages/corpus-core/test/workspace.test.ts` fixture adapter is the minimal non-book example of the contract in use.
