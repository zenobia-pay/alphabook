# Architecture

AlphaBook is now organized as a core-plus-reference-app monorepo.

## Layers

### Generic substrate

- `packages/corpus-core`
  - runtime limits
  - artifact key generation
- `packages/corpus-text`
  - text embedding helpers
- `packages/db`
  - database client and migrations

### Source adapters

- `packages/source-gutenberg`
  - Project Gutenberg mirror parsing
  - Gutenberg text cleanup and chunking
  - Gutenberg storage key conventions
  - Gutenberg-specific workspace schema description

### Reference app

- `packages/shared`
  - AlphaBook-specific prompts
  - AlphaBook API contracts and book/work schemas
  - compatibility exports while extraction continues
- `apps/orchestrator-worker`
  - routing, planning, tool execution, billing, auth, analytics
- `apps/runtime`
  - hydrated workspace execution in a bounded environment
- `apps/ingest`
  - import path for source adapters into Neon + R2
- `apps/frontend`
  - AlphaBook web UI

## Design Intent

The repo is intentionally not split into multiple repositories yet.

Reasons:

- the abstractions are still settling
- AlphaBook is the primary proving ground
- the Gutenberg adapter is the only real source adapter today

The current strategy is:

1. Extract generic concerns into workspace packages.
2. Keep AlphaBook running as the flagship implementation.
3. Add more source adapters before considering a repo split.
