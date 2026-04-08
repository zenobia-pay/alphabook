# Contributing

Alpha Research is an open-source corpus research platform with `AlphaBook` as the current reference implementation.

## Repo Shape

- `apps/frontend`: AlphaBook web app
- `apps/orchestrator-worker`: API and orchestration layer
- `apps/runtime`: bounded runtime for hydrated workspace analysis
- `apps/ingest`: ingest pipeline for source adapters
- `packages/corpus-core`: runtime limits and artifact storage primitives
- `packages/corpus-text`: text embedding helpers
- `packages/implementations`: implementation-specific origins, branding, and prompt configuration
- `packages/source-gutenberg`: Project Gutenberg-specific ingest and storage adapter
- `packages/source-fixture`: minimal non-book adapter used to validate extensibility
- `packages/shared`: AlphaBook-facing compatibility contracts and exports
- `packages/db`: database client and migrations

## Local Setup

```bash
npm install
npm run validate:extensible
```

For app-specific commands, start with [README.md](README.md).

`npm run validate:extensible` is the main repo check for the reusable platform surface. If you change AlphaBook-specific app code outside that surface, run the relevant package-level checks too.

## License

This repository is released under the MIT license in [LICENSE](LICENSE).

Unless explicitly stated otherwise in a file or directory, contributions are assumed to be submitted under that same license.

## Guidelines

- Keep reusable infrastructure generic when practical.
- Put source-specific logic behind a source adapter package instead of in app code.
- Keep implementation-specific branding and product copy in the implementation layer instead of the shared platform packages.
- Prefer additive compatibility shims over sweeping breaking renames.
- Add or update tests when behavior changes.
- Keep docs in sync when package boundaries move.

## Pull Requests

- Explain the user-facing or maintainer-facing outcome.
- Call out any schema, environment, or deploy changes.
- Mention validation run results in the PR description.
- If a change affects the launch story or OSS boundary, update the README or docs alongside the code.
