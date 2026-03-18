#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
INGEST_IMAGE="${INGEST_IMAGE:-alphabook-ingest:latest}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
MIRROR_BATCH_SIZE="${MIRROR_BATCH_SIZE:-25}"
BOOK_HTML_BATCH_SIZE="${BOOK_HTML_BATCH_SIZE:-100}"
MIRROR_CHECKPOINT_PATH="${MIRROR_CHECKPOINT_PATH:-$ALPHABOOK_ROOT/.alphabook/ingest-checkpoint.json}"
DOCKER_BIN="${DOCKER_BIN:-docker}"

if ! command -v "$DOCKER_BIN" >/dev/null 2>&1; then
  echo "[$(date -Is)] docker is required to run the Gutenberg uploader." >&2
  exit 1
fi

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

echo "[$(date -Is)] Uploading mirrored Gutenberg metadata and text via $INGEST_IMAGE"
"$DOCKER_BIN" run --rm \
  --env-file "$INGEST_ENV_FILE" \
  -e GUTENBERG_MIRROR_ROOT=/mirror \
  -e MIRROR_BATCH_SIZE="$MIRROR_BATCH_SIZE" \
  -e BOOK_HTML_BATCH_SIZE="$BOOK_HTML_BATCH_SIZE" \
  -e MIRROR_CHECKPOINT_PATH=/state/ingest-checkpoint.json \
  -v "$GUTENBERG_MIRROR_ROOT:/mirror:ro" \
  -v "$(dirname "$MIRROR_CHECKPOINT_PATH"):/state" \
  "$INGEST_IMAGE" \
  npx tsx apps/ingest/src/index.ts run-once

if [[ "$BOOK_HTML_BATCH_SIZE" =~ ^[0-9]+$ ]] && [[ "$BOOK_HTML_BATCH_SIZE" -gt 0 ]]; then
  echo "[$(date -Is)] Backfilling up to $BOOK_HTML_BATCH_SIZE missing static book HTML artifacts"
  "$DOCKER_BIN" run --rm \
    --env-file "$INGEST_ENV_FILE" \
    -e BOOK_HTML_BATCH_SIZE="$BOOK_HTML_BATCH_SIZE" \
    -v "$GUTENBERG_MIRROR_ROOT:/mirror:ro" \
    -v "$(dirname "$MIRROR_CHECKPOINT_PATH"):/state" \
    "$INGEST_IMAGE" \
    npx tsx apps/ingest/src/index.ts backfill-book-html - "$BOOK_HTML_BATCH_SIZE"
fi

echo "[$(date -Is)] Gutenberg upload finished successfully"
