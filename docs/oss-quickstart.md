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

## 4. Add Your Own Corpus

Start from:

- [docs/bring-your-own-corpus.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/bring-your-own-corpus.md)
- [docs/adapter-architecture.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/adapter-architecture.md)

The shortest path is:

1. add a new source adapter package
2. implement metadata normalization, storage keys, and retrieval hooks
3. wire that adapter into ingest and repository flows
4. validate with `npm run validate:oss`

## 5. Understand The Product Boundary

AlphaBook itself stays book-centric:

- the live browser product remains book-focused
- the public Worker API remains `work` shaped for compatibility
- the generic extension points live under the platform and adapter packages

If you need the AlphaBook compatibility API details, see [docs/api-contracts.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/api-contracts.md).
