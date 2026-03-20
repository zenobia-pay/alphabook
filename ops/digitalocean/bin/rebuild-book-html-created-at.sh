#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
BOOK_HTML_BATCH_SIZE="${BOOK_HTML_BATCH_SIZE:-500}"
BOOK_HTML_REBUILD_CONCURRENCY="${BOOK_HTML_REBUILD_CONCURRENCY:-8}"
LOG_PATH="${LOG_PATH:-$ALPHABOOK_ROOT/logs/book-html-rebuild-created-at.log}"

if [[ $# -lt 2 ]]; then
  echo "Usage: rebuild-book-html-created-at.sh <createdAtFrom> <createdAtTo> [startAfterId|-]" >&2
  exit 1
fi

created_at_from="$1"
created_at_to="$2"
start_after="${3:--}"
batch_num=0

mkdir -p "$(dirname "$LOG_PATH")"

set -a
# shellcheck disable=SC1090
source "$INGEST_ENV_FILE"
set +a

export GUTENBERG_MIRROR_ROOT
export BOOK_HTML_REBUILD_CONCURRENCY

while true; do
  batch_num=$((batch_num + 1))
  output="$(
    cd "$INGEST_REPO_ROOT"
    npx tsx apps/ingest/src/index.ts rebuild-book-html-created-at \
      "$created_at_from" \
      "$created_at_to" \
      "$start_after" \
      "$BOOK_HTML_BATCH_SIZE" \
      "$BOOK_HTML_REBUILD_CONCURRENCY"
  )"

  printf '[%s] batch=%s created_at_from=%s created_at_to=%s start_after=%s\n%s\n' \
    "$(date -Is)" \
    "$batch_num" \
    "$created_at_from" \
    "$created_at_to" \
    "$start_after" \
    "$output" | tee -a "$LOG_PATH"

  processed="$(printf '%s' "$output" | jq -r '.processed')"
  next_start_after="$(printf '%s' "$output" | jq -r '.nextStartAfterId // empty')"

  if [[ "$processed" == "0" ]]; then
    printf '[%s] rebuilt all matching book_html artifacts\n' "$(date -Is)" | tee -a "$LOG_PATH"
    break
  fi

  if [[ -z "$next_start_after" || "$next_start_after" == "null" ]]; then
    printf '[%s] stopping because nextStartAfterId was empty\n' "$(date -Is)" | tee -a "$LOG_PATH"
    break
  fi

  start_after="$next_start_after"
done
