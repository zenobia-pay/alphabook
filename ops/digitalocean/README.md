# DigitalOcean Gutenberg Mirror Box

This directory bootstraps the optional Project Gutenberg rsync mirror box that the ingest service can read from via `GUTENBERG_MIRROR_ROOT`.

Target layout on the VM:

- `/srv/alphabook/gutenberg`
- `/srv/alphabook/gutenberg/cache/epub`
- `/srv/alphabook/bin/gutenberg-rsync.sh`
- `/srv/alphabook/bin/gutenberg-rsync-epub.sh`
- `/srv/alphabook/bin/gutenberg-upload.sh`
- `/srv/alphabook/bin/backfill-gutenberg-bulk-safe.sh`
- `/srv/alphabook/bin/freeze-gutenberg-ingest.sh`
- `/srv/alphabook/bin/resume-gutenberg-ingest.sh`
- `/srv/alphabook/bin/audit-cloudflare-corpus.sh`
- `/srv/alphabook/bin/validate-corpus-integrity.sh`
- `/srv/alphabook/bin/rebuild-r2-corpus-all.sh`
- `/srv/alphabook/bin/prune-orphan-vectors.sh`
- `/srv/alphabook/bin/prune-orphan-d1-records.sh`
- `/srv/alphabook/bin/prune-orphan-r2-keys.sh`
- `/srv/alphabook/bin/backfill-book-html-all.sh`
- `/srv/alphabook/bin/rebuild-book-html-all.sh`
- `/etc/systemd/system/alphabook-gutenberg-rsync.service`
- `/etc/systemd/system/alphabook-gutenberg-rsync.timer`
- `/etc/systemd/system/alphabook-gutenberg-rsync-epub.service`
- `/etc/systemd/system/alphabook-gutenberg-rsync-epub.timer`

## Bootstrap

From a fresh Ubuntu/Debian-style DigitalOcean droplet:

```bash
sudo ./ops/digitalocean/bootstrap-rsync-box.sh
```

That script:

- installs `rsync`, `curl`, `ca-certificates`, and `jq`
- installs `nodejs` and `npm` so ingest can run directly on the box
- creates `/srv/alphabook`
- installs the rsync runner into `/srv/alphabook/bin`
- installs the EPUB/RDF rsync runner into `/srv/alphabook/bin`
- installs the upload runner into `/srv/alphabook/bin`
- installs freeze/resume helpers for the recurring ingest timers
- installs Cloudflare audit/validate/prune helpers
- installs the full D1 + Vectorize rebuild runner
- installs the full book HTML backfill runner into `/srv/alphabook/bin`
- installs the full book HTML rebuild runner into `/srv/alphabook/bin`
- installs the systemd services and timers
- enables the recurring timers

## Manual Sync

```bash
sudo systemctl start alphabook-gutenberg-rsync.service
sudo systemctl start alphabook-gutenberg-rsync-epub.service
sudo journalctl -u alphabook-gutenberg-rsync.service -n 200 --no-pager
sudo journalctl -u alphabook-gutenberg-rsync-epub.service -n 200 --no-pager
```

## Ingest Integration

Set:

```bash
GUTENBERG_MIRROR_ROOT=/srv/alphabook/gutenberg
```

Then:

```bash
npm run dev:ingest -- ingest-gutenberg 12345
```

or with `tsx` directly:

```bash
npx tsx apps/ingest/src/index.ts ingest-gutenberg 12345
```

On the rsync box itself, the upload helper expects an env file at `/srv/alphabook/.ingest.env` with:

```bash
D1_DATABASE_NAME=...
R2_BUCKET_NAME=...
R2_ENDPOINT=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
EMBEDDING_PROVIDER=google # or openai
GOOGLE_AI_API_KEY=... # required when EMBEDDING_PROVIDER=google
GOOGLE_EMBEDDING_MODEL=gemini-embedding-2-preview
GOOGLE_EMBEDDING_DIMENSIONS=1536
VECTOR_INDEX_NAME=alphabook-semantic
# OPENAI_API_KEY=... # required when EMBEDDING_PROVIDER=openai
# OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

Notes:

- The live repo still requires `D1_DATABASE_NAME` today because ingest persists corpus metadata and chunk rows into the existing relational store.
- The embedding provider is now configurable. For the Cloudflare migration path, use Google embeddings with `GOOGLE_EMBEDDING_DIMENSIONS=1536`.
- For rebuild/cutover, freeze the timers first with `sudo /srv/alphabook/bin/freeze-gutenberg-ingest.sh`, run `audit-r2-corpus` and `rebuild-r2-corpus`, then resume with `sudo /srv/alphabook/bin/resume-gutenberg-ingest.sh`.
- For the full Cloudflare cleanup + rebuild path, use:
  - `sudo /srv/alphabook/bin/freeze-gutenberg-ingest.sh`
  - `sudo /srv/alphabook/bin/audit-cloudflare-corpus.sh`
  - `sudo /srv/alphabook/bin/rebuild-r2-corpus-all.sh`
  - `sudo /srv/alphabook/bin/rebuild-book-html-all.sh`
  - `sudo /srv/alphabook/bin/validate-corpus-integrity.sh`
  - dry-run prune:
    - `sudo /srv/alphabook/bin/prune-orphan-vectors.sh`
    - `sudo /srv/alphabook/bin/prune-orphan-d1-records.sh`
    - `sudo /srv/alphabook/bin/prune-orphan-r2-keys.sh`
  - apply prune only after reviewing the reports:
    - `sudo APPLY_FLAG=--apply /srv/alphabook/bin/prune-orphan-vectors.sh`
    - `sudo APPLY_FLAG=--apply /srv/alphabook/bin/prune-orphan-d1-records.sh`
    - `sudo APPLY_FLAG=--apply /srv/alphabook/bin/prune-orphan-r2-keys.sh`
  - `sudo /srv/alphabook/bin/validate-corpus-integrity.sh`
  - `sudo /srv/alphabook/bin/resume-gutenberg-ingest.sh`

Then you can run:

```bash
sudo /srv/alphabook/bin/gutenberg-upload.sh
```

For a bounded 2000-book backfill with frozen timers, a persisted checkpoint, conservative concurrency, and per-batch validation:

```bash
sudo TARGET_COUNT=2000 BATCH_SIZE=100 CONCURRENCY=4 VALIDATE_EVERY_BATCHES=1 /srv/alphabook/bin/backfill-gutenberg-bulk-safe.sh
```

That runner:

- freezes timers before any ingest work
- writes a target preview and batch reports under `/srv/alphabook/logs/gutenberg-bulk/<run-id>/`
- uses the shared checkpoint at `/srv/alphabook/.alphabook/ingest-checkpoint.json`
- validates each completed batch before continuing
- leaves timers frozen at the end so the operator can review the reports before resuming

To backfill missing static book HTML for existing works without re-running full ingest:

```bash
sudo /srv/alphabook/bin/backfill-book-html-all.sh
```

To regenerate every stored static book HTML artifact after a template or anchor update:

```bash
sudo /srv/alphabook/bin/rebuild-book-html-all.sh
```

To upload automatically after each mirror refresh, set:

```bash
BOOK_HTML_BATCH_SIZE=100
```

The shipped systemd service already enables `ALPHABOOK_UPLOAD_AFTER_SYNC=1`, so the main recurring rsync run will:

- ingest new Gutenberg mirror files in parallel
- backfill a batch of missing `book_html` artifacts
- ensure the full paginated static-book rebuild loop is running in the background

## Notes

The sync scripts mirror only the data the ingest path actually needs:

- from the `gutenberg` rsync module: text/HTML source files plus index/readme files
- from the `gutenberg-epub` rsync module: RDF metadata plus cover images

That keeps the mirror aligned with the current ingest code without pulling unnecessary EPUB, MOBI, ZIP, DOC, and PDF derivatives.

The EPUB/RDF mirror can run independently from the main corpus mirror so generated metadata does not wait behind the initial full-text sync.

The ingest parser now preserves richer browse metadata from the mirror when present, including:

- subtitle / friendly title
- description / summary
- bookshelves
- publisher
- translators, illustrators, and editors
- cover image path (local mirror path)

## Working Notes

Current operational notes that matter in practice:

- The primary rsync box is currently reachable as `root@134.209.116.167`.
- The project files live at `/srv/alphabook/repo`, but that directory may not behave like a normal git checkout. For small hotfixes, copy the changed files with `scp` instead of assuming `git pull` will work.
- The box env is in `/srv/alphabook/.ingest.env`.
- For single-book static-page fixes after a template change, run the narrow rebuild directly:

```bash
cd /srv/alphabook/repo
set -a
. /srv/alphabook/.ingest.env
set +a
npx tsx apps/ingest/src/index.ts rebuild-book-html <gutenbergIdMinusOne> 1 1
```

Example:

```bash
npx tsx apps/ingest/src/index.ts rebuild-book-html 17 1 1
```

That rebuilds Gutenberg `18` only.

- For full-corpus Cloudflare validation and cleanup, the ingest CLI now exposes:
  - `audit-cloudflare-corpus [startAfterId|-] [limit|-] [outputPath|-]`
  - `validate-corpus-integrity [startAfterId|-] [limit|-] [outputPath|-]`
  - `prune-orphan-vectors [--apply|-] [outputPath|-]`
  - `prune-orphan-d1-records [--apply|-] [outputPath|-]`
  - `prune-orphan-r2-keys [--apply|-] [outputPath|-]`

- If `rebuild-book-html` is run locally from a developer machine, be careful with `.dev.vars`:
  - the ingest CLI auto-loads `.dev.vars`
  - local `.dev.vars` may contain quoted `R2_*` values that must be unwrapped before manual export
  - local `.dev.vars` may also contain a stale `CLOUDFLARE_API_TOKEN` that breaks Wrangler D1 access even when `wrangler whoami` works
  - prefer Wrangler OAuth on the machine and unset token overrides when using `wrangler d1 execute --remote`
