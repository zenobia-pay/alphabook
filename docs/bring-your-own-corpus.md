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
3. Map your source records into neutral document/chunk/file shapes.
4. Register the adapter through `createCorpusAdapterRegistry`.
5. Reuse the compatibility helpers if you need AlphaBook's legacy `work` surface.

## Current Examples

- `packages/source-gutenberg`: production book corpus adapter
- `packages/source-fixture`: minimal non-book corpus adapter

## What Is Still Required For A New Corpus

- an ingest implementation for the new source
- a repository implementation or mapping layer that can return neutral document records
- any source-specific scoring/query hooks you need

The platform package is the stable starting point. AlphaBook-specific packages should only be used when you explicitly want the current book product behavior.
