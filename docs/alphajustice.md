# AlphaJustice

AlphaJustice is the Supreme Court implementation of Alpha Research.

It shares the same platform code as AlphaBook, but it is intended to deploy as its own implementation with implementation-scoped infrastructure:

- shared frontend code in `apps/frontend`
- shared orchestrator code in `apps/orchestrator-worker`
- shared content worker code in `apps/book-content-worker`
- shared runtime and ingest code
- implementation-specific configuration in `packages/implementations`
- implementation-specific corpus adapter in `packages/source-supreme-court`

## Deployment Shape

The repo currently keeps only the AlphaJustice frontend wrapper around the shared app:

- `apps/alphajustice-frontend`
- `apps/alphajustice-runtime`

Those implementation-specific entrypoints provide:

- implementation id
- API origin
- site origin
- content origin
- product naming
- theme values
- implementation-scoped bucket / queue / runtime names

The shared app code remains the same.

The active architecture is Linux-first for API and runtime, with the static content surface remaining separate from the main app.

## Corpus

AlphaJustice uses the `supreme_court` adapter in `packages/source-supreme-court`.

That package currently includes:

- Supreme Court case fixture metadata for local validation
- a real CourtListener-backed ingest path for historical SCOTUS opinions
- corpus adapter hooks
- a neutral repository implementation for local validation and demos

Use the local demo ingest command to exercise the path without any external source dependency:

```bash
npx tsx apps/ingest/src/index.ts ingest-supreme-court-demo
```

If local DB and R2 env vars are configured, the command persists demo records through the shared ingest flow. Otherwise it prints a local preview of the prepared AlphaJustice artifacts so contributors can validate the path without provisioning infra first.

For the real corpus path, use a CourtListener API token and the production ingest commands:

```bash
npx tsx apps/ingest/src/index.ts count-supreme-court
npx tsx apps/ingest/src/index.ts ingest-supreme-court-cluster <clusterId>
npx tsx apps/ingest/src/index.ts backfill-supreme-court - 25
```

The current production source strategy is:

- CourtListener case law API for SCOTUS clusters and opinions
- one AlphaJustice document per CourtListener opinion cluster
- all linked sub-opinions combined into the stored case text for that case

The ingest expects `COURTLISTENER_API_TOKEN` plus the usual relational-DB and R2 variables from [environment.md](environment.md).

## Validation

AlphaJustice is part of the supported OSS validation matrix:

```bash
npm run validate:oss
```

For implementation-specific checks:

```bash
npm run typecheck -w @alphabook/alphajustice-frontend
```
