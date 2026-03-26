# Cloudflare Corpus Recovery

## Short answer

This got complicated because we tried to migrate from a mixed, partially-corrupted state instead of doing a clean rebuild from one source of truth.

What we actually need in production is simple:

- canonical book artifacts in R2
- metadata and chunk rows in D1
- embeddings in Vectorize

The hard part is that the current Cloudflare state is inconsistent:

- some books are complete
- some books have D1 rows but missing vectors
- some books have vectors but stale or replaced chunk ids
- some static book HTML is stale
- there is old junk from earlier Neon/OpenAI-backed runs

Trying to incrementally reconcile that mixed state is what has been expensive and brittle.

## What is currently broken

### 1. There is no single trusted corpus inventory

We have been bouncing between three different definitions of “the corpus”:

- the full Gutenberg mirror on the DigitalOcean droplet
- the existing canonical artifacts already present in R2
- the rows currently present in D1 / Vectorize

Those are not the same set of books.

The biggest concrete mistake was using the full mirror id list as the rebuild target. That list contains about `78k` Gutenberg ids, but many of those do not have the full canonical R2 artifact set that the Cloudflare corpus actually needs.

### 2. Cloudflare state is mixed from old and new pipelines

The old system used:

- Neon Postgres for metadata/chunks
- OpenAI embeddings

The new system uses:

- D1 for metadata/chunks
- Vectorize for embeddings
- R2 for canonical artifacts

That means the current Cloudflare state contains a mix of:

- valid new Google-embedded vectors
- stale vectors from old chunk ids
- D1 rows from partial rebuild attempts
- stale static `book.html` / page assets

### 3. The local tooling kept reloading the wrong auth

The ingest app was reloading `.dev.vars` internally. That reintroduced a stale `CLOUDFLARE_API_TOKEN` even when the shell env had already been fixed to use Wrangler OAuth. Direct Wrangler commands worked; the app-run workflow failed because it kept pulling the stale token back in.

### 4. The operational path has been trying to be too clever

The current path tries to:

- audit existing Cloudflare state
- preserve good data
- surgically repair missing pieces
- prune old junk

That is the right thing only if we trust the current Cloudflare state enough to preserve it.

Right now that trust is not deserved.

## Why this feels more complicated than it should

If we were starting clean, the actual data flow is straightforward:

`DigitalOcean mirror -> ingest -> R2 canonical artifacts -> D1 metadata/chunks -> Vectorize embeddings`

What makes it complicated is not the target architecture. It is the attempt to reuse and repair a partially-migrated production state.

So yes: the complexity is mostly because we have been trying to backfill from existing R2 / D1 / Vectorize state instead of doing a clean rebuild from one source of truth.

## Recommended path

The simplest, safest path is:

1. Treat the DigitalOcean Gutenberg mirror as the source input.
2. Treat Cloudflare as fully rebuildable state.
3. Delete the current D1 corpus rows.
4. Delete the current Vectorize index contents.
5. Delete the current generated Gutenberg artifacts in R2.
6. Re-run ingest from scratch from the DigitalOcean droplet using the Google embeddings + Vectorize + D1 path only.

That is much simpler than trying to reconcile the current mixed state.

## Recommendation on R2

Do **not** wipe all of R2 blindly.

Split R2 into two categories:

- canonical source artifacts we are willing to regenerate from the droplet
- generated / derived artifacts we should absolutely wipe and rebuild

For the current corpus workflow, the best reset is:

- wipe generated Gutenberg corpus artifacts under the existing corpus prefixes
- regenerate them from the DigitalOcean droplet

That is better than trying to preserve a half-good R2 corpus.

## Recommended clean-reset plan

### Phase 1. Freeze

- keep the DigitalOcean timers disabled
- stop all ad hoc rebuild jobs
- stop trying to patch individual books

### Phase 2. Pick one source of truth

Use the DigitalOcean Gutenberg mirror as the only source input for the rebuild.

That means:

- do not use Neon
- do not use existing D1 rows as source
- do not use existing Vectorize rows as source
- do not trust current R2 generated book assets as source

### Phase 3. Clear derived Cloudflare state

Delete:

- D1 corpus tables or all corpus rows in `works`, `work_files`, `chunks`, and related join tables
- all vectors from the `alphabook-semantic` index
- generated Gutenberg artifacts in R2 under the corpus prefixes

Keep only what we explicitly intend to regenerate or what lives outside this corpus pipeline.

### Phase 4. Rebuild from the droplet

Run one clean ingestion path from the droplet:

- read mirror files
- generate canonical raw / metadata / clean / chunks / book_html artifacts into R2
- write metadata and chunk rows to D1
- embed chunk text with Google `gemini-embedding-2-preview`
- upsert vectors into Vectorize

### Phase 5. Validate

For every rebuilt book:

- D1 has a `works` row
- D1 has `work_files`
- D1 has `chunks`
- Vectorize has one vector per chunk id
- static reader pages load correctly

### Phase 6. Remove dead paths

After the clean rebuild works:

- remove Neon from env and codepaths
- delete Neon

## Why I recommend reset over repair

Reset is better here because:

- the intended data model is simple
- the old state is not trustworthy
- the existing repair path has already cost more time than a clean rebuild should
- the clean rebuild is easier to reason about, verify, and operate

If we keep trying to “preserve what looks good,” we keep paying for hidden inconsistency.

## Concrete decision

If the goal is to get to a correct production state quickly, the best path is:

- **yes, clear the current Cloudflare corpus state**
- **yes, rebuild from the DigitalOcean droplet**
- **no, do not keep trying to reconcile the mixed partial state**

The only caveat is that the wipe should be targeted to the corpus data, not a blind delete of unrelated bucket contents.

## Immediate next step

Implement and run a clean reset workflow:

1. export final backup of current D1 / Vectorize state if desired
2. purge Cloudflare corpus state
3. re-run ingest from the droplet into R2 + D1 + Vectorize
4. validate sample books
5. continue full rebuild
