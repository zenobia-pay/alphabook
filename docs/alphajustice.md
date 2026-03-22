# AlphaJustice

AlphaJustice is the Supreme Court implementation of Alpha Research.

It shares the same major architecture as AlphaBook:

- shared frontend code in `apps/frontend`
- shared orchestrator code in `apps/orchestrator-worker`
- shared runtime and ingest infrastructure
- implementation-specific configuration in `packages/implementations`
- implementation-specific corpus adapter in `packages/source-supreme-court`

## Deployment Shape

AlphaJustice is deployed as separate wrappers around the shared apps:

- `apps/alphajustice-frontend`
- `apps/alphajustice-orchestrator`

Those wrappers provide:

- implementation id
- API origin
- site origin
- content origin
- product naming
- theme values

The shared app code remains the same.

## Corpus

The initial AlphaJustice corpus path uses the `supreme_court` adapter in `packages/source-supreme-court`.

That package currently includes:

- Supreme Court case fixture metadata
- case text fixture sources
- corpus adapter hooks
- a neutral repository implementation for local validation and demos

Use the local demo ingest command to exercise the path:

```bash
npx tsx apps/ingest/src/index.ts ingest-supreme-court-demo
```

If local DB and R2 env vars are configured, the command persists demo records through the shared ingest flow. Otherwise it prints a local preview of the prepared AlphaJustice artifacts so contributors can validate the path without provisioning infra first.

## Validation

AlphaJustice is part of the supported OSS validation matrix:

```bash
npm run validate:oss
```

For implementation-specific checks:

```bash
npm run typecheck -w @alphabook/alphajustice-frontend
npm run typecheck -w @alphabook/alphajustice-orchestrator
```
