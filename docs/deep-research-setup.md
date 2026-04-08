# Step-By-Step Setup For Deep Research On A Large Text Corpus

This is the fastest end-to-end guide for getting Alpha Research running on your own corpus.

The repo is extensible, not turnkey. You can adapt it to another corpus, but you should expect to add adapter code, ingest wiring, implementation config, and deployment setup.

## What You Are Building

Alpha Research has three major layers:

1. a corpus adapter that defines how your dataset is normalized, chunked, and stored
2. a research stack that retrieves evidence, hydrates runtime workspaces, and synthesizes cited answers
3. an implementation layer that gives your dataset its own name, origins, prompts, and deployment wrappers

The reference points in this repo are:

- `packages/source-gutenberg` for the production adapter path
- `packages/source-fixture` for the smallest non-book example
- `packages/implementations` for implementation metadata
- `apps/ingest/src/index.ts` for ingest entrypoints

## Before You Start

You need:

- Node/npm
- a relational database for production-style ingest and retrieval
- an R2-compatible object store
- an OpenAI API key
- Cloudflare credentials only if you plan to use D1, Vectorize, or the static content worker

For local validation only, you can skip the relational DB and R2 and use the preview-mode ingest command.

## Step 1: Install And Validate The Repo

```bash
npm install
npm run validate:extensible
```

This confirms the supported extensible surface is healthy before you add your own dataset.

## Step 2: Study The Reference Paths

Read these first:

- [adapter-architecture.md](adapter-architecture.md)
- [bring-your-own-corpus.md](bring-your-own-corpus.md)
- [oss-supported-surface.md](oss-supported-surface.md)

Then inspect:

- `packages/source-fixture`
- `packages/source-gutenberg`
- `packages/implementations`
- `apps/ingest/src/index.ts`

If you are choosing between examples:

- start from `source-fixture` for the smallest non-book example
- start from `source-gutenberg` only when you need a production-scale adapter with source-specific ingest and artifact logic

## Step 3: Create A Source Adapter

Add a new package under `packages/`, for example:

```text
packages/source-my-corpus/
```

Your package should export:

- a `CorpusAdapter`
- source records or a mapping layer
- a `CorpusRepository` implementation or repository adapter

At minimum, your adapter should define:

- `id`
- `displayName`
- `description`
- `artifactKeys`
- `text.stripSourceBoilerplate`
- `text.normalizeText`
- `text.chunkText`

Use these as references:

- `packages/source-fixture/src/index.ts`
- `packages/source-gutenberg/src/adapter.ts`

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

Add your adapter to the registry in:

- `packages/shared/src/adapters.ts`

If your corpus should become the active implementation default, make that choice in the implementation config layer, not by hardcoding it into the platform packages.

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

## Step 7: Add Implementation Wrappers

If your corpus should have its own deployment surface, scaffold wrappers with:

```bash
npm run implementation:scaffold -- \
  --id mycorpus \
  --product-name "MyCorpus" \
  --site-origin https://mycorpus.org \
  --api-origin https://api.mycorpus.org \
  --content-origin https://content.mycorpus.org
```

That creates:

- `apps/mycorpus-frontend`
- `apps/mycorpus-deployment`
- `apps/mycorpus-runtime`

## Step 8: Wire Ingest For Your Corpus

Add a corpus-specific ingest command in:

- `apps/ingest/src/index.ts`

There are two useful levels:

1. local preview mode
2. persistent ingest mode

For a new corpus, get preview mode working first. Then add the production persistence path.

Existing commands to copy:

- `ingest-fixture`
- `ingest-gutenberg`

## Step 9: Test The Corpus Locally

Verify preview mode:

```bash
npx tsx apps/ingest/src/index.ts ingest-fixture
```

Then run your new corpus command and confirm it emits:

- adapter id
- artifact keys
- chunk count
- metadata payload

Next validate the repo again:

```bash
npm run validate:extensible
```

## Step 10: Provision Infra For Production-Style Use

To run real deep research over a large corpus, provision:

- a relational database for metadata, chunks, sessions, runs, and runtime state
- R2 for raw text, cleaned text, chunk payloads, and rendered artifacts
- runtime service infrastructure for deep workspace search

Apply DB migrations:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/alphabook npm run migrate
```

Set the environment variables documented in [environment.md](environment.md).

## Step 11: Ingest The Corpus

Once DB and R2 are configured, run your persistent ingest path.

Your end state should be:

- corpus records in the relational store
- chunk rows indexed for retrieval
- artifact files in object storage
- optional rendered HTML/manifests in object storage

If your corpus is very large, plan for batch ingestion and resumable checkpoints rather than a single monolithic run.

## Step 12: Run Deep Research Locally

Start the core services:

```bash
npm run dev:orchestrator
npm run dev:runtime
npm run dev:frontend
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
- your API and worker config from `apps/<id>-deployment`
- your runtime service if deep workspace analysis is enabled

The scaffold is Linux-first. It is not a one-click deploy.

## Step 14: Make It Easy For The Next Person

Before you call the setup done, document:

- where source records come from
- how ingest is resumed or retried
- what env vars are required
- what validation command should pass
- which adapter and implementation packages are the canonical entry points

If the only way to repeat your setup is “read the source,” the setup is not done.

## Practical Checklist

1. `npm install`
2. `npm run validate:extensible`
3. read `adapter-architecture.md`
4. clone `source-fixture` or study `source-gutenberg`
5. create a new adapter package
6. create a repository layer for neutral document/chunk/file records
7. register the adapter
8. add an implementation config
9. add wrappers if needed
10. add preview-mode ingest
11. add persistent ingest
12. run local deep research against the corpus
13. deploy separate frontend/API/runtime targets as needed

## Where To Go Next

- [oss-quickstart.md](oss-quickstart.md)
- [bring-your-own-corpus.md](bring-your-own-corpus.md)
- [adapter-architecture.md](adapter-architecture.md)
- [oss-supported-surface.md](oss-supported-surface.md)
