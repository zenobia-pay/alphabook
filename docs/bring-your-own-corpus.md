# Bring Your Own Corpus

This repo can now support a second corpus without changing AlphaBook's live product surfaces, but the extension path is still intended for developers.

## What Stays AlphaBook-Specific

- `apps/frontend`
- `apps/book-content-worker`
- browser auth, social, profile, feed, and reader UX
- AlphaBook prompts and public `work` / `book` API names

## What Is Reusable

- `packages/corpus-core`
- `packages/platform`
- runtime hydration and artifact flow
- generic adapter registry and neutral document/tool contracts
- the orchestrator repository facade in `apps/orchestrator-worker`

## Minimal Steps

1. Create a new source package like `packages/source-fixture`.
2. Export a `CorpusAdapter` with:
   - `artifactKeys`
   - `text`
   - optional `capabilities`
   - optional `hooks`
3. If your source needs dataset-specific retrieval behavior, implement optional hooks for:
   - query-term expansion
   - metadata scoring
   - metadata acceptance thresholds
   - shard-axis hints
4. Map your source records into neutral document/chunk/file shapes.
5. Implement a repository returning `CorpusDocumentRecord`, `CorpusChunkRecord`, and `CorpusFileRecord`.
6. Register the adapter through `createCorpusAdapterRegistry`.
7. Reuse the compatibility helpers if you need AlphaBook's legacy `work` surface.

## Current Examples

- `packages/source-gutenberg`: production book corpus adapter
- `packages/source-fixture`: minimal non-book corpus adapter and repository
- `apps/ingest`: now supports `ingest-fixture` as a local non-book ingest demo path

## What Is Still Required For A New Corpus

- an ingest implementation for the new source
- a repository implementation or mapping layer that can return neutral document/chunk/file records
- any source-specific scoring/query hooks you need

The platform package is the stable starting point. AlphaBook-specific packages should only be used when you explicitly want the current book product behavior.
