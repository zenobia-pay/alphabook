# OSS Quickstart

## Goal

This quickstart is for developers who want to validate the reusable corpus-platform layer without changing AlphaBook's book-facing product.

It does not require deploying `alpha-book.org`.

## 1. Install Dependencies

```bash
npm install
```

## 2. Run The Supported OSS Validation Matrix

```bash
npm run validate:oss
```

This validates the supported reusable surface:

- neutral platform contracts
- adapter implementations
- ingest helpers
- shared compatibility exports
- focused orchestrator repository and store seams

## 3. Run The Fixture Corpus Demo

```bash
npx tsx apps/ingest/src/index.ts ingest-fixture
```

This exercises a non-book corpus path through:

- adapter registration
- metadata normalization
- ingest persistence helpers
- repository search/chunk/file contracts

If `DATABASE_URL` and the R2 env vars are not set, this command falls back to a local preview mode and prints the prepared artifact keys and metadata payload instead of persisting them.

## 4. Run The Supreme Court Demo

```bash
npx tsx apps/ingest/src/index.ts ingest-supreme-court-demo
```

This exercises a second implementation path that is not book-shaped:

- the `supreme_court` corpus adapter
- AlphaJustice implementation metadata
- case-oriented rendered content keys
- neutral repository search/chunk/file contracts

Like the fixture command, this runs in local preview mode when DB and R2 env vars are absent.

The implementation layout is documented in [alphajustice.md](alphajustice.md).

## 5. Add Your Own Corpus

Start from:

- [bring-your-own-corpus.md](bring-your-own-corpus.md)
- [adapter-architecture.md](adapter-architecture.md)

The shortest path is:

1. add a new source adapter package
2. implement metadata normalization, storage keys, and retrieval hooks
3. wire that adapter into ingest and repository flows
4. validate with `npm run validate:oss`

## 6. Understand The Product Boundary

AlphaBook itself stays book-centric:

- the live browser product remains book-focused
- the public Worker API remains `work` shaped for compatibility
- the generic extension points live under the platform and adapter packages

If you need the AlphaBook compatibility API details, see [api-contracts.md](api-contracts.md).
