# Contributing

AlphaBook is an open-source reference application for grounded research over large text corpora.

## Repo Shape

- `apps/frontend`: AlphaBook web app
- `apps/orchestrator-worker`: API and orchestration layer
- `apps/runtime`: bounded runtime for hydrated workspace analysis
- `apps/ingest`: ingest pipeline for source adapters
- `packages/corpus-core`: runtime limits and artifact storage primitives
- `packages/corpus-text`: text embedding helpers
- `packages/source-gutenberg`: Project Gutenberg-specific ingest and storage adapter
- `packages/shared`: AlphaBook-facing contracts and compatibility exports
- `packages/db`: database client and migrations

## Local Setup

```bash
npm install
npm run typecheck
npm run test
```

For app-specific commands, start with [README.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/README.md).

## Guidelines

- Keep reusable infrastructure generic when practical.
- Put source-specific logic behind a source adapter package instead of in app code.
- Prefer additive compatibility shims over sweeping breaking renames.
- Add or update tests when behavior changes.
- Keep docs in sync when package boundaries move.

## Pull Requests

- Explain the user-facing or maintainer-facing outcome.
- Call out any schema, environment, or deploy changes.
- Mention validation run results in the PR description.
