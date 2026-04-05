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
- `/srv/alphabook/bin/hermes-job-api.mjs`
- `/srv/alphabook/bin/openai-logging-proxy.mjs`
- `/etc/systemd/system/alphabook-gutenberg-rsync.service`
- `/etc/systemd/system/alphabook-gutenberg-rsync.timer`
- `/etc/systemd/system/alphabook-gutenberg-rsync-epub.service`
- `/etc/systemd/system/alphabook-gutenberg-rsync-epub.timer`
- `/etc/systemd/system/alphabook-hermes-job-api.service`
- `/etc/systemd/system/alphabook-openai-logging-proxy.service`

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
- installs corpus audit/validate/prune helpers
- installs the full D1 + R2 + Qdrant rebuild runner
- installs the full book HTML backfill runner into `/srv/alphabook/bin`
- installs the full book HTML rebuild runner into `/srv/alphabook/bin`
- installs the Hermes job API runner and systemd unit
- installs the OpenAI-compatible logging proxy and systemd unit
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
CLOUDFLARE_API_TOKEN=...
R2_BUCKET_NAME=...
R2_ENDPOINT=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
VECTOR_PROVIDER=qdrant
QDRANT_URL=http://10.116.0.4:6333
QDRANT_API_KEY=...
QDRANT_COLLECTION=alphabook-semantic
EMBEDDING_PROVIDER=openai # current live path
# GOOGLE_AI_API_KEY=... # only if EMBEDDING_PROVIDER=google
# GOOGLE_EMBEDDING_MODEL=gemini-embedding-001
# GOOGLE_EMBEDDING_DIMENSIONS=768
# OPENAI_API_KEY=... # required when EMBEDDING_PROVIDER=openai
# OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

Notes:

- The live repo still requires `D1_DATABASE_NAME` today because ingest persists corpus metadata and chunk rows into the existing relational store.
- The droplet ingest path still expects explicit Cloudflare API-token auth via `CLOUDFLARE_API_TOKEN` (or `CF_API_TOKEN`) for Wrangler-backed D1 access.
- The live semantic store is Qdrant, not Cloudflare Vectorize.
- `EMBEDDING_PROVIDER` controls which embedding API is called before vectors are written into the configured vector store.
- For the full live rebuild path, use:
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

The naming on some of these helpers is older than the current system. In particular:

- `audit-cloudflare-corpus.sh` audits the live corpus shape across R2, D1, and the active vector store
- `rebuild-r2-corpus-all.sh` rebuilds live corpus state from canonical R2 artifacts into D1 and the active vector store
- neither helper implies Cloudflare Vectorize any more when `VECTOR_PROVIDER=qdrant`

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

## Precomputed Research Corpus Index

For the full picture of how the mirror, live ingest, prepared shards, and mounted consolidation tree relate to each other, see [docs/gutenberg-mirror-to-consolidation.md](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/docs/gutenberg-mirror-to-consolidation.md).

For Hermes-style corpus research runs, do not rebuild the text manifest on every run once
prepared Gutenberg artifacts exist. Build a reusable canonical text index from the prepared
artifact tree instead:

```bash
python3 /srv/alphabook/repo/ops/digitalocean/bin/precompute-text-corpus-index.py \
  --prepared-root /root/alphabook-prepared/final/<run-id> \
  --output-dir /srv/alphabook/precomputed-corpus/latest \
  --no-primary-text
```

That produces:

- `all-text-files.tsv`:
  `size_bytes<TAB>absolute_path`
- `metadata-table.jsonl`
- `metadata-table.csv`
- `metadata-table.sqlite`
- `manifest.json`

Primary text policy:

- require `gutenberg/clean/<id>/clean.txt`
- skip books that do not yet have clean text

To derive scoped file lists deterministically from the metadata table:

```bash
python3 /srv/alphabook/repo/ops/digitalocean/bin/build-scoped-text-file-list.py \
  --index-dir /srv/alphabook/precomputed-corpus/latest \
  --output-path /tmp/scoped-text-files.tsv \
  --publication-year-from 1800 \
  --publication-year-to 1919
```

To reuse the precomputed manifest directly in ad hoc runs, point your scoped-file-list logic at the index:

```bash
cp /srv/alphabook/precomputed-corpus/latest/all-text-files.tsv /tmp/run/all-text-files.tsv
```

## Hermes Run Layout

When `--no-primary-text` is used, `all-text-files.tsv` points directly at the consolidated canonical clean text files under `r2/gutenberg/clean/<id>/clean.txt`, so no alias folder is created.

The checked-in consolidation helper at [ops/digitalocean/bin/consolidate-prepared-gutenberg-shards.sh](/Users/ryanprendergast/Documents/Zenobia%20Pay/alphabook/ops/digitalocean/bin/consolidate-prepared-gutenberg-shards.sh) represents the intended repo flow for merging prepared shard outputs. The live boxes have also used ad hoc qdrant-box copies of that script during the April 2026 shard runs, so verify the live script location before assuming the repo copy is what last ran.

The intended repo helper can kick off the post-index build after the final merge:

```bash
POST_INDEX_ENABLED=1 \
POST_INDEX_OUTPUT_DIR=/mnt/alphabook_consolidation/final/latest/research-corpus-index \
POST_INDEX_NO_PRIMARY_TEXT=1 \
/srv/alphabook/repo/ops/digitalocean/bin/consolidate-prepared-gutenberg-shards.sh --wait
```

If `research-corpus-index/` is empty under `/mnt/alphabook_consolidation/final/latest`, that means the post-consolidation index build did not actually run to completion for the mounted copy even if the prepared `books/` and `r2/` trees are present.

Wrapper-managed Hermes research runs are now isolated into explicit subfolders:

- `state/`
  - `prompt.txt`
  - `status.json`
  - `summary.json`
- `attempts/attempt-0001/logs/`
  - `launcher.log`
  - `hermes.stdout.log`
  - `hermes.stderr.log`
  - `heartbeat.log`
  - `process.log`
  - `profile.jsonl`
  - `profile-summary.json`
  - `command-snapshots.jsonl`
- `attempts/attempt-0001/runtime/`
  - `hermes.pid`
  - `heartbeat.pid`
  - `profiler.pid`
  - `inner-run-dir.txt`

Top-level files such as `status.json`, `launcher.log`, and `profile.jsonl` are compatibility symlinks into those subfolders. The explicit `inner-run-dir.txt` handoff file is the canonical association between a wrapper run and its inner corpus-research run; the system should no longer need to guess from mixed log text.

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
  - local `.dev.vars` may contain a stale `CLOUDFLARE_API_TOKEN`; if D1 auth behaves unexpectedly, verify the token rather than assuming Wrangler OAuth will override it

## Agentic Corpus Search

For large one-off semantic scans over the mirrored Gutenberg corpus, use the shard-and-reduce runner instead of a single `rlm` process. It enumerates corpus files locally on the droplet, extracts bounded lexical candidate snippets, fans them out to many small LLM shard workers, and then reduces the shard outputs into one deduped result set.

From the droplet repo:

```bash
cd /srv/alphabook/repo
ops/digitalocean/bin/run-gutenberg-agentic-search.sh \
  --query "Find me every example of grief in all of the books in this database." \
  --corpus-root /srv/alphabook/gutenberg \
  --output-dir /srv/alphabook/logs/gutenberg-agentic-search/grief-run \
  --shard-size 24 \
  --concurrency 8
```

Artifacts are written under the chosen output directory:

- `manifest.json`
- `shards/shard-*.json`
- `reduced.json`

Useful flags:

- `--max-files 500` for a bounded smoke test
- `--max-matches-per-file 8` to cap lexical candidates per file
- `--max-shard-snippet-chars 24000` to keep shard prompts bounded
- `--reduce-only` to recompute `reduced.json` from existing shard outputs

## Hermes Corpus Research

For long-running Hermes-driven corpus research, use the dedicated launcher instead of a one-off `hermes chat` shell command. It creates a durable run directory, stores the exact prompt, writes separate launcher/stdout/stderr logs, records a PID, and appends heartbeat entries while the process is alive.

From the droplet repo:

```bash
cd /srv/alphabook/repo
ops/digitalocean/bin/run-hermes-corpus-research.sh \
  --corpus-root /mnt/alphabook_consolidation/final/latest \
  --precomputed-index-dir /mnt/alphabook_consolidation/final/latest/research-corpus-index \
  --user-prompt "Find me all the different ways that authors deal with grief in 19th century literature."
```

That command prints the run directory, for example:

```text
/srv/alphabook/logs/hermes-corpus-research/20260331T201500Z-deadbeef
```

To check progress:

```bash
ops/digitalocean/bin/hermes-corpus-research-status.sh \
  /srv/alphabook/logs/hermes-corpus-research/20260331T201500Z-deadbeef
```

Artifacts written per run:

- `index.json`
- `prompt.txt`
- `launcher.log`
- `hermes.stdout.log`
- `hermes.stderr.log`
- `heartbeat.log`
- `profile.jsonl`
- `command-snapshots.jsonl`
- `profile-summary.json`
- `status.json`
- `summary.json`
- `hermes.pid`
- `hermes-home/.hermes/config.yaml`
- `hermes-home/.hermes/sessions/*`
- `hermes.session.json`
- `openai-requests.jsonl`
- `openai-proxy/*.request.json`
- `openai-proxy/*.response.json`

The wrapper run ID is now the canonical handle for a Hermes job. `index.json` explicitly records:

- wrapper run directory
- inner corpus run directory and inner run ID
- Hermes session ID and captured session snapshot
- per-run OpenAI request log and copied request/response JSON
- primary wrapper and inner artifacts

## Codex Corpus Research

For chunked Codex-driven corpus research on the droplet, use the Codex wrapper instead of a single large Hermes session. The wrapper partitions the precomputed text manifest into deterministic `<=5000`-file shards, runs a bounded number of Codex shard jobs in parallel, and then launches a Codex consolidator over the shard logs and artifacts.

From the droplet repo:

```bash
cd /srv/alphabook/repo
ops/digitalocean/bin/run-codex-corpus-research.sh \
  --corpus-root /mnt/alphabook_consolidation/final/latest \
  --precomputed-index-dir /mnt/alphabook_consolidation/final/latest/research-corpus-index \
  --max-parallel 5 \
  --user-prompt "Find me all the different ways that authors deal with grief in 19th century literature."
```

That command prints the wrapper run directory, for example:

```text
/srv/alphabook/logs/codex-corpus-research/20260405T193000Z-deadbeef
```

To check progress:

```bash
ops/digitalocean/bin/codex-corpus-research-status.sh \
  /srv/alphabook/logs/codex-corpus-research/20260405T193000Z-deadbeef
```

Wrapper layout:

- `state/`
  - `prompt.txt`
  - `status.json`
  - `summary.json`
  - `partitions.json`
- `attempts/attempt-0001/logs/`
  - `launcher.log`
  - `manager.stdout.log`
  - `manager.stderr.log`
  - `heartbeat.log`
  - `process.log`
- `attempts/attempt-0001/runtime/`
  - `manager.pid`
  - `heartbeat.pid`
- `chunks/chunk-*/`
  - `scope-files.tsv`
  - `prompt.txt`
  - `status.json`
  - `summary.json`
  - `logs/codex-events.jsonl`
  - `logs/codex.stderr.log`
  - `logs/heartbeat.log`
  - `runtime/codex.pid`
  - `codex-home/.codex/...`
  - `artifacts/*`
  - `openai-requests.jsonl`
  - `openai-proxy/*.request.json`
  - `openai-proxy/*.response.json`
- `consolidator/`
  - `input/*`
  - `status.json`
  - `logs/*`
  - `artifacts/*`
  - `openai-requests.jsonl`
  - `openai-proxy/*.request.json`
  - `openai-proxy/*.response.json`

Top-level convenience files include:

- `status.json`
- `summary.json`
- `launcher.log`
- `manager.stdout.log`
- `manager.stderr.log`
- `heartbeat.log`
- `process.log`
- `pricing-summary.json`
- `consolidated-briefing.md`
- `consolidated-summary.json`
- `consolidated-citation-index.json`

Operational notes:

- `--max-parallel` is intentionally capped to `5..10` to avoid exhausting droplet RAM.
- Each shard routes Codex traffic through the local OpenAI logging proxy using a shard-specific proxy run ID, so `pricing-summary.json` and per-shard `openai-requests.jsonl` stay attributable.
- The consolidator does not rerun corpus retrieval. It works from the shard logs, summaries, datasets, and citation payloads already written into the wrapper run folder.

## Hermes Job API

For external products that need to kick off and monitor droplet-side research runs, use the Hermes job API service.

Systemd unit:

```bash
sudo cp ops/digitalocean/bin/hermes-job-api.mjs /srv/alphabook/bin/hermes-job-api.mjs
sudo cp ops/digitalocean/systemd/alphabook-hermes-job-api.service /etc/systemd/system/alphabook-hermes-job-api.service
sudo install -d -m 755 /srv/alphabook/logs/hermes-job-api
sudo test -f /srv/alphabook/.hermes-job-api-token || openssl rand -hex 24 | sudo tee /srv/alphabook/.hermes-job-api-token >/dev/null
sudo chmod 600 /srv/alphabook/.hermes-job-api-token
sudo systemctl daemon-reload
sudo systemctl enable --now alphabook-hermes-job-api.service
sudo systemctl status alphabook-hermes-job-api.service --no-pager
```

Default bind:

- `0.0.0.0:8788`
- bearer token read from `/srv/alphabook/.hermes-job-api-token`

Endpoints:

- `GET /health`
- `GET /v1/jobs`
- `GET /v1/jobs/active`
- `POST /v1/jobs`
- `GET /v1/jobs/:jobId`
- `GET /v1/jobs/:jobId/logs`
- `GET /v1/jobs/:jobId/artifacts`

Submit a new job:

```bash
TOKEN="$(sudo cat /srv/alphabook/.hermes-job-api-token)"
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userPrompt":"Find me all the different ways that authors deal with grief in literature."}' \
  http://127.0.0.1:8788/v1/jobs
```

Poll active jobs:

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8788/v1/jobs/active
```

Poll logs:

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8788/v1/jobs/<job-id>/logs?limit=100"
```

Notes:

- The API is a thin wrapper over `/srv/alphabook/logs/hermes-corpus-research/*`.
- `POST /v1/jobs` launches the existing `run-hermes-corpus-research.sh`.
- `index.json` is the authoritative per-run pointer to the inner run, Hermes session, and OpenAI request logs.
- cost fields are exposed when the inner run writes `cost-profile.json` or a compatible `status.json`; otherwise wrapper-level OpenAI proxy totals are exposed when available.
- `GET /v1/jobs/:jobId/logs` is poll-friendly and returns per-source line tails plus a cursor for incremental fetches.
- Bootstrap installs the runner, unit, and token file, but you still need the repo present at `/srv/alphabook/repo` before enabling the service.

## OpenAI Logging Proxy

To persist the raw OpenAI request and response JSON for Hermes runs, use the local OpenAI-compatible logging proxy.

Install and enable:

```bash
sudo cp ops/digitalocean/bin/openai-logging-proxy.mjs /srv/alphabook/bin/openai-logging-proxy.mjs
sudo cp ops/digitalocean/systemd/alphabook-openai-logging-proxy.service /etc/systemd/system/alphabook-openai-logging-proxy.service
sudo install -d -m 755 /srv/alphabook/logs/openai-proxy
sudo systemctl daemon-reload
sudo systemctl enable --now alphabook-openai-logging-proxy.service
sudo systemctl status alphabook-openai-logging-proxy.service --no-pager
```

Default bind:

- `127.0.0.1:8790`

Log files:

- `/srv/alphabook/logs/openai-proxy/requests.jsonl`
- `/srv/alphabook/logs/openai-proxy/<request-id>.request.json`
- `/srv/alphabook/logs/openai-proxy/<request-id>.response.json`

To route Hermes through the proxy, point Hermes custom-model base URL at:

```yaml
model:
  default: "gpt-5.4"
  provider: "custom"
  base_url: "http://127.0.0.1:8790/v1"
```

Notes:

- The proxy forwards to `https://api.openai.com` and logs both the request and response bodies.
- It also records token usage and an estimated cost when the upstream response includes a `usage` block.
- The proxy is intended for debugging and auditing; logs can become large on long runs.

For ripgrep progress-aware corpus scans, assume the corpus index already exists and use it directly:

```bash
cp /mnt/alphabook_consolidation/final/latest/research-corpus-index/all-text-files.tsv \
  /srv/alphabook/logs/corpus-research/<run-id>/all-text-files.tsv
```

That gives you the sorted text-only TSV manifest:

- `all-text-files.tsv` as `size_bytes<TAB>absolute_path`

Then run the chunked progress-aware ripgrep helper over a scoped TSV file list:

```bash
ops/digitalocean/bin/run-ripgrep-progress.sh \
  --file-list /srv/alphabook/logs/corpus-research/<run-id>/scope-files.tsv \
  --pattern '\\b(grief|mourning|bereaved|bereavement|bereft|sorrow|lament|woe|anguish)\\b' \
  --output-dir /srv/alphabook/logs/corpus-research/<run-id>/search \
  --batch-size 500
```

That writes:

- `search/rg_hits.jsonl`
- `search/ripgrep-progress.jsonl`
- `search/ripgrep-status.json`
- `search/ripgrep.log`
- `search/batches/batch-*.jsonl`

The launcher also starts a profiler that samples:

- wrapper PID liveness and elapsed time
- Hermes PID liveness and elapsed time
- active `rg --json` process metrics when present
- current phase inference (`launching`, `ripgrep`, `post-ripgrep`, `scoped`)
- active Hermes and ripgrep command snapshots
- inner corpus-run directory discovery
- `rg_hits.jsonl` line counts and byte growth
- ripgrep batch/file/byte progress when the helper script is used
- per-sample line/byte throughput
- artifact counts and file sizes
