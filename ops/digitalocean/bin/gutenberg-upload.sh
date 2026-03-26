#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
INGEST_IMAGE="${INGEST_IMAGE:-alphabook-ingest:latest}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
MIRROR_BATCH_SIZE="${MIRROR_BATCH_SIZE:-25}"
MIRROR_BACKFILL_CONCURRENCY="${MIRROR_BACKFILL_CONCURRENCY:-12}"
MIRROR_CHECKPOINT_PATH="${MIRROR_CHECKPOINT_PATH:-$ALPHABOOK_ROOT/.alphabook/ingest-checkpoint.json}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
LOCAL_RUNNER="${LOCAL_RUNNER:-npx}"
UPLOAD_LOCK_PATH="${UPLOAD_LOCK_PATH:-$ALPHABOOK_ROOT/.locks/gutenberg-upload.lock}"

if [[ ! -d "$GUTENBERG_MIRROR_ROOT" ]]; then
  echo "[$(date -Is)] Mirror root not found: $GUTENBERG_MIRROR_ROOT" >&2
  exit 1
fi

if [[ ! -f "$INGEST_ENV_FILE" ]]; then
  echo "[$(date -Is)] Ingest env file not found: $INGEST_ENV_FILE" >&2
  echo "[$(date -Is)] Expected D1_DATABASE_NAME, R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and embedding credentials (OPENAI_API_KEY or GOOGLE_AI_API_KEY)." >&2
  exit 1
fi

mkdir -p "$(dirname "$MIRROR_CHECKPOINT_PATH")"
mkdir -p "$(dirname "$UPLOAD_LOCK_PATH")"

exec 9>"$UPLOAD_LOCK_PATH"
if ! flock -n 9; then
  echo "[$(date -Is)] Gutenberg upload already running; exiting." >&2
  exit 0
fi

if command -v "$DOCKER_BIN" >/dev/null 2>&1; then
  echo "[$(date -Is)] Uploading mirrored Gutenberg metadata and text via $INGEST_IMAGE"
  "$DOCKER_BIN" run --rm \
    --env-file "$INGEST_ENV_FILE" \
    -e GUTENBERG_MIRROR_ROOT=/mirror \
    -e MIRROR_BATCH_SIZE="$MIRROR_BATCH_SIZE" \
    -e MIRROR_BACKFILL_CONCURRENCY="$MIRROR_BACKFILL_CONCURRENCY" \
    -e MIRROR_CHECKPOINT_PATH=/state/ingest-checkpoint.json \
    -v "$GUTENBERG_MIRROR_ROOT:/mirror:ro" \
    -v "$(dirname "$MIRROR_CHECKPOINT_PATH"):/state" \
    "$INGEST_IMAGE" \
    npx tsx apps/ingest/src/index.ts backfill-mirror-parallel - "$MIRROR_BATCH_SIZE" "$MIRROR_BACKFILL_CONCURRENCY"
else
  if ! command -v "$LOCAL_RUNNER" >/dev/null 2>&1; then
    echo "[$(date -Is)] Neither docker nor $LOCAL_RUNNER is available to run the Gutenberg uploader." >&2
    exit 1
  fi

  if [[ ! -d "$INGEST_REPO_ROOT" ]]; then
    echo "[$(date -Is)] Ingest repo root not found: $INGEST_REPO_ROOT" >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "$INGEST_ENV_FILE"
  set +a

  # Prefer the host's Wrangler OAuth session over any stale API token in env files.
  unset CLOUDFLARE_API_TOKEN CF_API_TOKEN CF_ACCOUNT_ID CLOUDFLARE_ACCOUNT_ID

  export GUTENBERG_MIRROR_ROOT
  export MIRROR_BATCH_SIZE
  export MIRROR_BACKFILL_CONCURRENCY
  export MIRROR_CHECKPOINT_PATH

  echo "[$(date -Is)] Uploading mirrored Gutenberg metadata and text via checked-out repo at $INGEST_REPO_ROOT"
  (
    cd "$INGEST_REPO_ROOT"
    "$LOCAL_RUNNER" tsx apps/ingest/src/index.ts backfill-mirror-parallel - "$MIRROR_BATCH_SIZE" "$MIRROR_BACKFILL_CONCURRENCY"
  )
fi

echo "[$(date -Is)] Gutenberg upload finished successfully"
