# Implementation Isolation

Every branded corpus implementation in Alpha Research should be isolated by default.

That means a new implementation must not silently reuse another implementation's:

- frontend app
- static content surface
- API/orchestrator service
- runtime app
- object-storage buckets
- background-job queues
- cookie namespace
- branded copy or setup prompt

## Required Wrapper Shape

For an implementation id like `mycorpus`, the repo shape should be:

- `apps/mycorpus-frontend`
- `apps/mycorpus-content`
- `apps/mycorpus-runtime`

Those wrappers should point at shared code, but they must use implementation-scoped resource names:

- `mycorpus-corpus`
- `mycorpus-corpus-preview`
- `mycorpus-ingest`
- `mycorpus-jobs`
- `mycorpus-runtime`

## Required Config Shape

Each implementation entry in `packages/implementations` should define:

- implementation id
- product and site names
- site origin
- API origin
- content origin
- adapter id
- implementation-specific welcome copy and feed labels

Shared app code should read those values from implementation config rather than branching on a specific implementation id.

## Scaffolding

Use the scaffold command to create isolated wrappers:

```bash
npm run implementation:scaffold -- \
  --id mycorpus \
  --product-name "MyCorpus" \
  --site-origin https://mycorpus.org \
  --api-origin https://api.mycorpus.org \
  --content-origin https://content.mycorpus.org
```

This creates the wrapper directories only. You still need to:

1. add the implementation entry
2. add the corpus adapter
3. provision the named resources
4. deploy the implementation-specific surfaces

## Review Rule

If a new implementation reuses another implementation's bucket, queue, runtime app, or content origin in committed config, treat that as a bug unless it is explicitly documented as intentional shared infrastructure.
