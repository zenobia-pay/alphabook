#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
FALLBACK_ENV_FILE="${FALLBACK_ENV_FILE:-$ROOT_DIR/.dev.vars.codexrun}"
ACTIVE_ENV_FILE="$ENV_FILE"

if [[ ! -f "$ACTIVE_ENV_FILE" ]]; then
  ACTIVE_ENV_FILE="$FALLBACK_ENV_FILE"
fi

LOG_DIR="${LOG_DIR:-$ROOT_DIR/output/live-corpus-migration}"
SCAN_IDS_PATH="${SCAN_IDS_PATH:-$ROOT_DIR/output/canonical-gutenberg-ids-r2.txt}"
SCAN_MISSING_PATH="${SCAN_MISSING_PATH:-$ROOT_DIR/output/canonical-gutenberg-ids-r2-missing-required.txt}"
SCAN_ORPHANED_PATH="${SCAN_ORPHANED_PATH:-$ROOT_DIR/output/r2-orphaned-key-count.txt}"
REBUILD_LOG="${REBUILD_LOG:-$LOG_DIR/rebuild-r2-corpus.log}"
BOOK_HTML_LOG="${BOOK_HTML_LOG:-$LOG_DIR/rebuild-book-html.log}"
VALIDATE_LOG="${VALIDATE_LOG:-$LOG_DIR/validate.log}"
PRUNE_LOG="${PRUNE_LOG:-$LOG_DIR/prune.log}"
CHECKPOINT_PATH="${CHECKPOINT_PATH:-$LOG_DIR/rebuild-checkpoint.json}"
BOOK_HTML_BATCH_SIZE="${BOOK_HTML_BATCH_SIZE:-250}"
BOOK_HTML_REBUILD_CONCURRENCY="${BOOK_HTML_REBUILD_CONCURRENCY:-8}"
MIRROR_BATCH_SIZE="${MIRROR_BATCH_SIZE:-25}"

mkdir -p "$LOG_DIR"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

printf '[%s] scanning canonical R2 corpus ids\n' "$(timestamp)" | tee -a "$REBUILD_LOG"
ENV_FILE="$ACTIVE_ENV_FILE" \
OUTPUT_IDS="$SCAN_IDS_PATH" \
OUTPUT_MISSING="$SCAN_MISSING_PATH" \
OUTPUT_ORPHANED_COUNT="$SCAN_ORPHANED_PATH" \
"$ROOT_DIR/scripts/scan-r2-corpus-ids.sh" | tee -a "$REBUILD_LOG"

if [[ ! -s "$SCAN_IDS_PATH" ]]; then
  echo "No canonical R2 ids found at $SCAN_IDS_PATH" >&2
  exit 1
fi

backup_env=""
if [[ -f "$ENV_FILE" ]]; then
  backup_env="$ENV_FILE.migration.$$"
  mv "$ENV_FILE" "$backup_env"
fi

restore_env() {
  if [[ -n "$backup_env" && -f "$backup_env" ]]; then
    mv "$backup_env" "$ENV_FILE"
  fi
}
trap restore_env EXIT

eval "$(
  python3 - "$ACTIVE_ENV_FILE" <<'PY'
from pathlib import Path
import sys

wanted = {
    "R2_BUCKET_NAME",
    "R2_ENDPOINT",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "GOOGLE_AI_API_KEY",
    "EMBEDDING_PROVIDER",
    "GOOGLE_EMBEDDING_MODEL",
    "GOOGLE_EMBEDDING_DIMENSIONS",
    "VECTOR_INDEX_NAME",
}
for line in Path(sys.argv[1]).read_text().splitlines():
    if "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key in wanted:
        print(f"export {key}={value}")
PY
)"

unset CLOUDFLARE_API_TOKEN CF_API_TOKEN CF_ACCOUNT_ID
export CANONICAL_CORPUS_IDS_PATH="$SCAN_IDS_PATH"
export MIRROR_CHECKPOINT_PATH="$CHECKPOINT_PATH"

start_after="-"
batch_num=0
while true; do
  batch_num=$((batch_num + 1))
  output="$(
    cd "$ROOT_DIR"
    npx tsx apps/ingest/src/index.ts rebuild-r2-corpus "$start_after" "$MIRROR_BATCH_SIZE"
  )"

  printf '[%s] batch=%s start_after=%s\n%s\n' "$(timestamp)" "$batch_num" "$start_after" "$output" | tee -a "$REBUILD_LOG"

  processed="$(printf '%s' "$output" | jq -r '.processed')"
  next_start_after="$(printf '%s' "$output" | jq -r '.nextStartAfterId // empty')"

  if [[ "$processed" == "0" ]]; then
    printf '[%s] rebuilt all canonical corpus rows\n' "$(timestamp)" | tee -a "$REBUILD_LOG"
    break
  fi

  if [[ -z "$next_start_after" || "$next_start_after" == "null" ]]; then
    printf '[%s] stopping because nextStartAfterId was empty\n' "$(timestamp)" | tee -a "$REBUILD_LOG"
    break
  fi

  start_after="$next_start_after"
done

start_after="-"
batch_num=0
while true; do
  batch_num=$((batch_num + 1))
  output="$(
    cd "$ROOT_DIR"
    npx tsx apps/ingest/src/index.ts rebuild-book-html "$start_after" "$BOOK_HTML_BATCH_SIZE" "$BOOK_HTML_REBUILD_CONCURRENCY"
  )"

  printf '[%s] batch=%s start_after=%s\n%s\n' "$(timestamp)" "$batch_num" "$start_after" "$output" | tee -a "$BOOK_HTML_LOG"

  processed="$(printf '%s' "$output" | jq -r '.processed')"
  next_start_after="$(printf '%s' "$output" | jq -r '.nextStartAfterId // empty')"

  if [[ "$processed" == "0" ]]; then
    printf '[%s] rebuilt all book_html artifacts\n' "$(timestamp)" | tee -a "$BOOK_HTML_LOG"
    break
  fi

  if [[ -z "$next_start_after" || "$next_start_after" == "null" ]]; then
    printf '[%s] stopping because nextStartAfterId was empty\n' "$(timestamp)" | tee -a "$BOOK_HTML_LOG"
    break
  fi

  start_after="$next_start_after"
done

printf '[%s] validating corpus integrity\n' "$(timestamp)" | tee -a "$VALIDATE_LOG"
(
  cd "$ROOT_DIR"
  npx tsx apps/ingest/src/index.ts validate-corpus-integrity - - "$LOG_DIR/validate-corpus-integrity.json"
) | tee -a "$VALIDATE_LOG"

printf '[%s] pruning orphan vectors\n' "$(timestamp)" | tee -a "$PRUNE_LOG"
(
  cd "$ROOT_DIR"
  npx tsx apps/ingest/src/index.ts prune-orphan-vectors --apply "$LOG_DIR/prune-orphan-vectors.json"
) | tee -a "$PRUNE_LOG"

printf '[%s] pruning orphan D1 records\n' "$(timestamp)" | tee -a "$PRUNE_LOG"
(
  cd "$ROOT_DIR"
  npx tsx apps/ingest/src/index.ts prune-orphan-d1-records --apply "$LOG_DIR/prune-orphan-d1-records.json"
) | tee -a "$PRUNE_LOG"

printf '[%s] pruning orphan R2 keys\n' "$(timestamp)" | tee -a "$PRUNE_LOG"
(
  cd "$ROOT_DIR"
  npx tsx apps/ingest/src/index.ts prune-orphan-r2-keys --apply "$LOG_DIR/prune-orphan-r2-keys.json"
) | tee -a "$PRUNE_LOG"

printf '[%s] validating corpus integrity after prune\n' "$(timestamp)" | tee -a "$VALIDATE_LOG"
(
  cd "$ROOT_DIR"
  npx tsx apps/ingest/src/index.ts validate-corpus-integrity - - "$LOG_DIR/validate-corpus-integrity-post-prune.json"
) | tee -a "$VALIDATE_LOG"
