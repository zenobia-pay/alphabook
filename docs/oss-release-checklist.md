# OSS Release Checklist

## Package Boundaries

- confirm reusable code lives in `packages/corpus-core` or `packages/platform`
- confirm AlphaBook-specific compatibility code stays in `packages/shared`
- confirm Gutenberg-only behavior stays in `packages/source-gutenberg`

## Secrets And Infra

- verify docs do not require production-only hostnames unless clearly marked AlphaBook-specific
- audit env vars and runbooks for private credentials or internal assumptions
- keep production deployment docs separated from generic platform docs

## Extension Story

- ensure the adapter registry works with at least one non-book adapter
- keep the fixture corpus example passing
- keep repository facade tests passing against the legacy store

## Compatibility

- preserve AlphaBook routes, hostnames, and live copy
- preserve existing `work`-shaped public API responses
- preserve Gutenberg static content routing and artifact keys

## Docs

- keep `docs/adapter-architecture.md` current
- keep `docs/bring-your-own-corpus.md` current
- clearly label AlphaBook-only vs platform vs Gutenberg-only docs
