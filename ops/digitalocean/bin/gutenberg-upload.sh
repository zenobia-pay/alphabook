#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
INGEST_IMAGE="${INGEST_IMAGE:-alphabook-ingest:latest}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
MIRROR_BATCH_SIZE="${MIRROR_BATCH_SIZE:-25}"
MIRROR_BACKFILL_CONCURRENCY="${MIRROR_BACKFILL_CONCURRENCY:-12}"
BOOK_HTML_BATCH_SIZE="${BOOK_HTML_BATCH_SIZE:-100}"
BOOK_HTML_BACKFILL_CONCURRENCY="${BOOK_HTML_BACKFILL_CONCURRENCY:-8}"
BOOK_HTML_REBUILD_CONCURRENCY="${BOOK_HTML_REBUILD_CONCURRENCY:-12}"
BOOK_HTML_TRIGGER_FULL_REBUILD="${BOOK_HTML_TRIGGER_FULL_REBUILD:-1}"
MIRROR_CHECKPOINT_PATH="${MIRROR_CHECKPOINT_PATH:-$ALPHABOOK_ROOT/.alphabook/ingest-checkpoint.json}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
LOCAL_RUNNER="${LOCAL_RUNNER:-npx}"
FULL_REBUILD_SCRIPT="${FULL_REBUILD_SCRIPT:-$ALPHABOOK_ROOT/bin/rebuild-book-html-all.sh}"
FULL_REBUILD_LOG_PATH="${FULL_REBUILD_LOG_PATH:-$ALPHABOOK_ROOT/logs/book-html-rebuild-all.nohup.log}"
UPLOAD_LOCK_PATH="${UPLOAD_LOCK_PATH:-$ALPHABOOK_ROOT/.locks/gutenberg-upload.lock}"

if [[ ! -d "$GUTENBERG_MIRROR_ROOT" ]]; then
  echo "[$(date -Is)] Mirror root not found: $GUTENBERG_MIRROR_ROOT" >&2
  exit 1
fi

if [[ ! -f "$INGEST_ENV_FILE" ]]; then
  echo "[$(date -Is)] Ingest env file not found: $INGEST_ENV_FILE" >&2
  echo "[$(date -Is)] Expected DATABASE_URL, R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and optional OPENAI_API_KEY." >&2
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
    -e BOOK_HTML_BATCH_SIZE="$BOOK_HTML_BATCH_SIZE" \
    -e BOOK_HTML_REBUILD_CONCURRENCY="$BOOK_HTML_REBUILD_CONCURRENCY" \
    -e MIRROR_CHECKPOINT_PATH=/state/ingest-checkpoint.json \
    -v "$GUTENBERG_MIRROR_ROOT:/mirror:ro" \
    -v "$(dirname "$MIRROR_CHECKPOINT_PATH"):/state" \
    "$INGEST_IMAGE" \
    npx tsx apps/ingest/src/index.ts backfill-mirror-parallel - "$MIRROR_BATCH_SIZE" "$MIRROR_BACKFILL_CONCURRENCY"

  if [[ "$BOOK_HTML_BATCH_SIZE" =~ ^[0-9]+$ ]] && [[ "$BOOK_HTML_BATCH_SIZE" -gt 0 ]]; then
    echo "[$(date -Is)] Backfilling up to $BOOK_HTML_BATCH_SIZE missing static book HTML artifacts"
    "$DOCKER_BIN" run --rm \
      --env-file "$INGEST_ENV_FILE" \
      -e BOOK_HTML_BATCH_SIZE="$BOOK_HTML_BATCH_SIZE" \
      -e BOOK_HTML_BACKFILL_CONCURRENCY="$BOOK_HTML_BACKFILL_CONCURRENCY" \
      -v "$GUTENBERG_MIRROR_ROOT:/mirror:ro" \
      -v "$(dirname "$MIRROR_CHECKPOINT_PATH"):/state" \
      "$INGEST_IMAGE" \
      npx tsx apps/ingest/src/index.ts backfill-book-html - "$BOOK_HTML_BATCH_SIZE" "$BOOK_HTML_BACKFILL_CONCURRENCY"
  fi
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

  export GUTENBERG_MIRROR_ROOT
  export MIRROR_BATCH_SIZE
  export MIRROR_BACKFILL_CONCURRENCY
  export BOOK_HTML_BATCH_SIZE
  export BOOK_HTML_BACKFILL_CONCURRENCY
  export BOOK_HTML_REBUILD_CONCURRENCY
  export MIRROR_CHECKPOINT_PATH

  echo "[$(date -Is)] Uploading mirrored Gutenberg metadata and text via checked-out repo at $INGEST_REPO_ROOT"
  (
    cd "$INGEST_REPO_ROOT"
    "$LOCAL_RUNNER" tsx apps/ingest/src/index.ts backfill-mirror-parallel - "$MIRROR_BATCH_SIZE" "$MIRROR_BACKFILL_CONCURRENCY"
  )

  if [[ "$BOOK_HTML_BATCH_SIZE" =~ ^[0-9]+$ ]] && [[ "$BOOK_HTML_BATCH_SIZE" -gt 0 ]]; then
    echo "[$(date -Is)] Backfilling up to $BOOK_HTML_BATCH_SIZE missing static book HTML artifacts"
    (
      cd "$INGEST_REPO_ROOT"
      "$LOCAL_RUNNER" tsx apps/ingest/src/index.ts backfill-book-html - "$BOOK_HTML_BATCH_SIZE" "$BOOK_HTML_BACKFILL_CONCURRENCY"
    )
  fi
fi

if [[ "$BOOK_HTML_TRIGGER_FULL_REBUILD" == "1" && -x "$FULL_REBUILD_SCRIPT" ]]; then
  if pgrep -af "$FULL_REBUILD_SCRIPT" >/dev/null 2>&1 || pgrep -af "rebuild-book-html " >/dev/null 2>&1; then
    echo "[$(date -Is)] Full book HTML rebuild already running"
  else
    echo "[$(date -Is)] Starting full book HTML rebuild in background"
    nohup "$FULL_REBUILD_SCRIPT" >>"$FULL_REBUILD_LOG_PATH" 2>&1 &
  fi
fi

echo "[$(date -Is)] Gutenberg upload finished successfully"
