# Bring Your Own Corpus

This repo can support another text corpus without changing AlphaBook's live book product, but the integration path is still developer-oriented.

## What Stays AlphaBook-Specific

- `apps/frontend`
- `apps/book-content-worker`
- browser auth, social, profile, feed, and reader UX
- AlphaBook prompts and public `work` / `book` API names

## What Is Reusable

- `packages/corpus-core`
- `packages/platform`
- runtime hydration and artifact flow
- generic adapter registry and neutral document/tool contracts
- the orchestrator repository facade in `apps/orchestrator-worker`

## Current Examples

- `packages/source-gutenberg`: production book corpus adapter
- `packages/source-fixture`: minimal non-book corpus adapter and repository
- `packages/source-supreme-court`: second non-book adapter, currently a demo corpus path
- `apps/ingest`: local ingest entrypoints for fixture and Supreme Court demos

## Step-By-Step Setup For Another Text Set

Use this sequence when adding a new corpus such as court opinions, transcripts, research papers, manuals, or internal documents.

### 1. Create a new source package

Create a package under `packages/`, for example:

```text
packages/source-my-corpus/
  package.json
  tsconfig.json
  src/
    index.ts
    adapter.ts
```

Start by copying the structure of `packages/source-fixture` for a small corpus or `packages/source-gutenberg` for a production ingest path.

### 2. Define the adapter

Export a `CorpusAdapter` that describes how your corpus is normalized and stored.

The minimum adapter needs:

- `id`
- `displayName`
- `description`
- `artifactKeys`
- `text.stripSourceBoilerplate`
- `text.normalizeText`
- `text.chunkText`

Optional but commonly useful additions:

- `capabilities.renderedDocuments`
- `capabilities.staticContent`
- `hooks.normalizeQuery`
- `hooks.expandQueryTerms`
- `hooks.scoreDocumentMetadata`
- `hooks.acceptMetadataResults`
- `hooks.recommendedShardAxis`

If you are unsure where to start, mirror `packages/source-fixture/src/index.ts` first and add hooks only after basic ingest works.

### 3. Map your source records into neutral shapes

Your corpus needs to end up in the platform's neutral record types:

- `CorpusDocumentRecord`
- `CorpusChunkRecord`
- `CorpusFileRecord`

For each source document, decide:

- the stable document id
- the external id, if you have one
- the canonical title
- contributors / authors
- subjects / tags
- release or publication date
- summary / abstract
- metadata fields you want preserved in `metadata_json`

Keep this mapping neutral. Do not make the new corpus pretend to be books unless you intentionally want AlphaBook compatibility behavior.

### 4. Add a repository implementation

Implement a repository that can return:

- document listing
- document lookup
- chunk retrieval
- file lookup

For a lightweight setup, use an in-memory or fixture repository first.

For a real deployment, the active path should read from Postgres and R2 through the existing neutral repository/store interfaces in `apps/orchestrator-worker`.

### 5. Add ingest wiring

Add a new ingest command in `apps/ingest/src/index.ts`.

There are two useful phases:

1. local preview mode
2. real persistence mode to Postgres and R2

Preview mode is valuable because it lets you validate:

- normalized metadata
- artifact keys
- chunking behavior
- rendered document output

before you provision infrastructure.

Follow the pattern used by:

- `ingest-fixture`
- `ingest-supreme-court-demo`

If your corpus is production-sized, add a backfill path and a repeatable incremental ingest path instead of a one-shot demo command.

### 6. Decide on rendered content output

If you want hosted document reading pages, implement rendered artifacts.

That usually means:

- landing HTML
- manifest JSON
- page HTML files when the corpus benefits from paginated reading

If plain text retrieval is enough, you can start without a rich reader surface and add rendered artifacts later.

### 7. Add an implementation config if you want a separate branded deployment

If the new corpus should be its own product, add an implementation entry in `packages/implementations`.

That config should define:

- implementation id
- site name / product name
- site origin
- API origin
- content origin
- theme / branding values

Then add wrapper apps like:

- `apps/mycorpus-frontend`
- `apps/mycorpus-content`
- `apps/mycorpus-orchestrator`
- `apps/mycorpus-runtime`

Reuse the shared frontend, content worker, orchestrator, and runtime code just like AlphaJustice does.

If you only need the corpus inside an internal or single-product deployment, you may not need separate wrappers.

### 8. Provision the required infrastructure

For a real deployed corpus, make sure these exist:

- Postgres with the current `packages/db` migrations applied
- R2 bucket for raw / clean / chunks / rendered artifacts
- implementation-specific Worker queues
- Worker env vars and secrets
- runtime app config if workspace analysis is enabled

The shared env list lives in `docs/environment.md`.

The practical minimum for ingest persistence is:

- `DATABASE_URL`
- `R2_BUCKET_NAME`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

The practical minimum for the deployed orchestrator is:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_SYNTH_MODEL`
- `OPENAI_EMBEDDING_MODEL`
- R2 bindings / credentials
- runtime configuration if using Fly machines

For a separate branded implementation, do not reuse another implementation's bucket, queue, or runtime names. The wrapper config should point at implementation-scoped resources.

### 9. Validate locally

Run the supported validation matrix:

```bash
npm run validate:oss
```

Then run your new ingest entrypoint in preview mode first, followed by persistence mode with real env vars.

If you added wrappers, also run their typechecks explicitly.

### 10. Verify the live surface

Before calling the new corpus ready, check all of these:

1. the frontend loads
2. the Worker `/health` route succeeds
3. `/api/v1/documents` returns your new documents
4. retrieval returns relevant chunks
5. rendered content URLs resolve when enabled
6. the runtime path works if deep analysis is enabled

Do not treat a successful frontend deploy as a complete launch. A corpus deployment is only real when the Worker, DB, and blob store are all wired correctly.

## Short Checklist

Use this as the implementation checklist:

1. create `packages/source-my-corpus`
2. export a `CorpusAdapter`
3. map source data into neutral document/chunk/file records
4. add repository support
5. add ingest command(s)
6. add rendered artifact generation if needed
7. add implementation config and wrapper apps if the corpus needs its own brand
8. provision DB, implementation-scoped R2, Worker queues, Worker secrets, and runtime config
9. run `npm run validate:oss`
10. verify live `health`, `documents`, retrieval, and content endpoints

## What Is Still Required For A New Corpus

- an ingest implementation for the new source
- a repository implementation or mapping layer that can return neutral document/chunk/file records
- any source-specific scoring/query hooks you need

The platform package is the stable starting point. AlphaBook-specific packages should only be used when you explicitly want the current book product behavior.
