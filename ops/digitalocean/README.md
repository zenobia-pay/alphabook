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
- installs Cloudflare audit/validate/prune helpers
- installs the full D1 + Vectorize rebuild runner
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
- The droplet ingest path now expects explicit Cloudflare API-token auth via `CLOUDFLARE_API_TOKEN` (or `CF_API_TOKEN`) for Wrangler D1 and Vectorize commands. It no longer relies on a local Wrangler OAuth login.
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

## Precomputed Research Corpus Index

For Hermes-style corpus research runs, do not rebuild the text manifest on every run once
prepared Gutenberg artifacts exist. Build a reusable canonical text index from the prepared
artifact tree instead:

```bash
python3 /srv/alphabook/repo/ops/digitalocean/bin/precompute-text-corpus-index.py \
  --prepared-root /root/alphabook-prepared/final/<run-id> \
  --output-dir /srv/alphabook/precomputed-corpus/latest \
  --prefer-source clean
```

That produces:

- `primary-text/`:
  one canonical text path per Gutenberg ID, symlinked by default
- `all-text-files.tsv`:
  `size_bytes<TAB>absolute_path`
- `metadata-table.jsonl`
- `metadata-table.csv`
- `metadata-table.sqlite`
- `manifest.json`

Primary text policy:

- prefer `gutenberg/clean/<id>/clean.txt`
- fall back to `gutenberg/raw/<id>/raw.txt` when clean text is missing

To derive scoped file lists deterministically from the metadata table:

```bash
python3 /srv/alphabook/repo/ops/digitalocean/bin/build-scoped-text-file-list.py \
  --index-dir /srv/alphabook/precomputed-corpus/latest \
  --output-path /tmp/scoped-text-files.tsv \
  --publication-year-from 1800 \
  --publication-year-to 1919
```

To reuse the precomputed manifest in existing helper-driven runs:

```bash
/srv/alphabook/repo/ops/digitalocean/bin/prepare-text-corpus-manifest.sh \
  --output-dir /tmp/run/prepared \
  --precomputed-index-dir /srv/alphabook/precomputed-corpus/latest
```

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

For ripgrep progress-aware corpus scans, the expected helper flow is:

```bash
ops/digitalocean/bin/prepare-text-corpus-manifest.sh \
  --corpus-root /srv/alphabook/gutenberg \
  --output-dir /srv/alphabook/logs/corpus-research/<run-id>/prepared
```

That writes a sorted text-only TSV manifest:

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
