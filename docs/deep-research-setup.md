# Step-By-Step Setup For Deep Research On A Large Text Corpus

This is the fastest end-to-end guide for getting Alpha Research running on a large text corpus.

It is written for a developer who wants:

- a retrieval layer over a corpus
- runtime-backed deep research over hydrated source files
- grounded answers with citations
- a deployable implementation with its own branding and URL

If you just want to validate the repo locally first, start with [oss-quickstart.md](oss-quickstart.md). If you want to bring your own dataset all the way through ingest, retrieval, and deployment, follow this guide.

## What You Are Building

Alpha Research has three major layers:

1. a corpus adapter that defines how your dataset is normalized, chunked, and stored
2. a research stack that retrieves evidence, hydrates runtime workspaces, and synthesizes cited answers
3. an implementation layer that gives your dataset its own name, origins, prompts, and deployment wrappers

The existing examples are:

- AlphaBook: books via `packages/source-gutenberg`
- AlphaJustice: Supreme Court cases via `packages/source-supreme-court`

## Before You Start

You need:

- Node/npm
- a Postgres database for production-style ingest and retrieval
- an R2-compatible object store
- an OpenAI API key
- Cloudflare Workers credentials if you plan to deploy the web/API workers

For local validation only, you can skip Postgres and R2 and use the preview-mode ingest commands.

## Step 1: Install And Validate The Repo

```bash
npm install
npm run validate:oss
```

This confirms the supported OSS surface is healthy before you add your own dataset.

## Step 2: Study The Reference Paths

Read these first:

- [adapter-architecture.md](adapter-architecture.md)
- [bring-your-own-corpus.md](bring-your-own-corpus.md)
- [alphajustice.md](alphajustice.md)

Then inspect the concrete examples:

- `packages/source-fixture`
- `packages/source-supreme-court`
- `packages/implementations`
- `apps/ingest/src/index.ts`

If you are choosing between examples:

- start from `source-fixture` for the smallest possible non-book example
- start from `source-supreme-court` if you want a more realistic second implementation with its own deployment wrappers

## Step 3: Create A Source Adapter

Add a new package under `packages/`, for example:

```text
packages/source-my-corpus/
```

Your package should export:

- a `CorpusAdapter`
- example or real source records
- a `CorpusRepository` implementation or mapping layer

At minimum, your adapter should define:

- `id`
- `displayName`
- `description`
- `artifactKeys`
- `text.stripSourceBoilerplate`
- `text.normalizeText`
- `text.chunkText`

Optional but recommended:

- `capabilities.renderedDocuments`
- retrieval hooks for query expansion or metadata scoring
- static content hints if your corpus has its own reader pages

Use these as references:

- `packages/source-fixture/src/index.ts`
- `packages/source-supreme-court/src/index.ts`

## Step 4: Map Your Corpus Into Neutral Records

The shared platform expects neutral record shapes:

- document records
- chunk records
- file records

Your repository layer should be able to answer:

- list documents
- get one document by id
- search documents
- get metadata for a set of documents
- retrieve relevant chunks
- list document files
- resolve the main text file for a document

That is the minimum needed for retrieval plus runtime hydration.

## Step 5: Register The Adapter

Add your adapter to the shared registry in:

- `packages/shared/src/adapters.ts`

If your corpus should become the active implementation default, make that choice in the implementation config layer, not by hardcoding it into the core platform.

## Step 6: Create An Implementation Config

Add a new implementation entry in:

- `packages/implementations/src/index.ts`

This is where you define:

- implementation id
- product name
- site origin
- API origin
- content origin
- corpus labels
- site description
- theme color
- default reader/user naming
- default adapter id

This keeps the shared app code reusable while letting your corpus have its own identity.

## Step 7: Add Implementation Wrappers

Create separate app wrappers for your implementation if you want separate deployment targets.

Typical pattern:

```text
apps/my-corpus-frontend/
apps/my-corpus-orchestrator/
```

The existing examples are:

- `apps/alphajustice-frontend`
- `apps/alphajustice-orchestrator`

These wrappers provide:

- env/config for the shared frontend worker
- env/config for the shared orchestrator worker
- implementation-specific deploy targets and origins

## Step 8: Wire Ingest For Your Corpus

Add a corpus-specific ingest command in:

- `apps/ingest/src/index.ts`

There are two useful levels:

1. local preview mode
   This prepares artifact keys, chunks, and metadata without requiring DB/R2.
2. persistent ingest mode
   This writes metadata, chunks, and artifacts into Postgres and R2.

For a new corpus, get preview mode working first. Then add the production persistence path.

Existing commands to copy:

- `ingest-fixture`
- `ingest-supreme-court-demo`

## Step 9: Test The Corpus Locally

First verify preview mode:

```bash
npx tsx apps/ingest/src/index.ts ingest-fixture
npx tsx apps/ingest/src/index.ts ingest-supreme-court-demo
```

Then run your new corpus command and confirm it emits:

- adapter id
- artifact keys
- chunk count
- metadata payload

Next validate the repo again:

```bash
npm run validate:oss
```

If your new implementation has its own wrappers, also run its app-specific checks.

## Step 10: Provision Infra For Production-Style Use

To run real deep research over a large corpus, provision:

- Postgres for metadata, chunks, sessions, runs, and runtime state
- R2 for raw text, cleaned text, chunk payloads, and rendered artifacts
- runtime service infrastructure for deep workspace search

Apply DB migrations:

```bash
DATABASE_URL=postgres://... npm run migrate
```

Set the environment variables documented in [environment.md](environment.md).

## Step 11: Ingest The Corpus

Once DB and R2 are configured, run your persistent ingest path.

Your end state should be:

- corpus records in Postgres
- chunk rows indexed for retrieval
- artifact files in R2
- optional rendered HTML/manifests in R2

If your corpus is very large, plan for batch ingestion and resumable checkpoints rather than a single monolithic run.

## Step 12: Run Deep Research Locally

Start the core services:

```bash
npm run dev:orchestrator
npm run dev:runtime
npm run dev:frontend
```

If you prefer the Node-backed local API harness:

```bash
PORT=8788 npm run dev:node -w @alphabook/orchestrator-worker
```

At this point the stack should be able to:

- search your corpus
- retrieve relevant chunks
- hydrate workspace files
- run deeper runtime-backed research
- return cited answers

## Step 13: Deploy A Separate Site

If you want a separate public product, deploy:

- your implementation frontend wrapper
- your implementation orchestrator wrapper

This is the AlphaJustice pattern:

- separate worker name
- separate frontend worker
- separate URL
- shared core code underneath

## Step 14: Make It Easy For The Next Person

Before you call the setup done, document:

- where source records come from
- how ingest is resumed or retried
- what env vars are required
- what validation command should pass
- which adapter and implementation packages are the canonical entry points

If the only way to repeat your setup is “read the source,” the setup is not done.

## Practical Checklist

Use this checklist in order:

1. `npm install`
2. `npm run validate:oss`
3. read `adapter-architecture.md`
4. clone `source-fixture` or `source-supreme-court`
5. create a new adapter package
6. create a repository layer for neutral document/chunk/file records
7. register the adapter
8. add an implementation config
9. add frontend/orchestrator wrappers if needed
10. add preview-mode ingest
11. add persistent ingest
12. run local deep research against the corpus
13. deploy separate frontend/API targets

## Where To Go Next

- [oss-quickstart.md](oss-quickstart.md)
- [bring-your-own-corpus.md](bring-your-own-corpus.md)
- [adapter-architecture.md](adapter-architecture.md)
- [alphajustice.md](alphajustice.md)
