# OSS Supported Surface

## Positioning

This repository is open sourced as:

- `Alpha Research`, the shared platform
- `AlphaBook`, the book-centric reference app

That split is deliberate. `alpha-book.org` remains book-specific, and the live browser product is not being rebranded into a generic corpus UI.

## Supported For OSS Consumers

The supported open-source integration surface is:

- `packages/corpus-core`
- `packages/corpus-text`
- `packages/implementations`
- `packages/platform`
- `packages/source-gutenberg`
- `packages/source-fixture`
- `apps/ingest` via adapter-aware ingest flows
- `apps/orchestrator-worker` repository, retrieval, and runtime seams used by the fixture and adapter tests
- the neutral HTTP API under `/api/v1/documents/*`

These are the packages and codepaths covered by `npm run validate:extensible` and the compatibility alias `npm run validate:oss`.

## Compatibility Surface

The AlphaBook-facing compatibility layer remains intentionally book-shaped:

- `packages/shared`
- the public HTTP API
- AlphaBook browser flows and copy

Examples:

- `search_works`
- `get_work_metadata`
- `get_work_text`
- `workId`
- `workIds`

Those names remain stable for AlphaBook compatibility even though the underlying platform now has neutral document and adapter contracts.

## AlphaBook-Specific Surfaces

These parts of the repository are reference-app code, not generic platform requirements:

- `apps/frontend`
- `apps/book-content-worker`
- book-reader and static book HTML flows
- AlphaBook auth and account UX
- AlphaBook social/profile/feed features
- production `alpha-book.org` routing and branding

## Not Yet Generic

The repository is not claiming a fully neutral product contract yet.

Current intentional limitations:

- the public AlphaBook HTTP API is still `work` and `book` shaped
- the neutral document API is additive; it does not replace the AlphaBook compatibility API
- the database schema still uses legacy `works`, `work_files`, `gutenberg_id`, and `book_html` tables/columns
- the frontend app is a book-centric reference app, not a generic corpus UI

## Isolation Contract

New implementations should be isolated by default.

That means:

- separate wrapper apps
- separate bucket names
- separate queue names
- separate runtime app names
- separate cookie namespace
- implementation-configured branding and prompts

See [implementation-isolation.md](implementation-isolation.md).

To make the schema boundary explicit, the database now also exposes additive neutral views:

- `corpus_documents`
- `corpus_document_files`
- `corpus_document_chunks`

## Validation Contract

The supported extensibility validation entry point is:

```bash
npm run validate:extensible
```

`npm run validate:oss` remains as an alias for compatibility with older docs and CI wiring.

That command covers:

- implementation config typechecks and tests
- platform typechecks and tests
- adapter typechecks and tests
- ingest typechecks and tests
- shared compatibility typechecks
- focused orchestrator repository/store tests

If you change AlphaBook app code outside that surface, run the app-specific validation for those packages as well.
