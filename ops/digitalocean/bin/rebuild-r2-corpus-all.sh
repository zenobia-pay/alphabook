#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
MIRROR_BATCH_SIZE="${MIRROR_BATCH_SIZE:-100}"
MIRROR_CHECKPOINT_PATH="${MIRROR_CHECKPOINT_PATH:-$ALPHABOOK_ROOT/.alphabook/rebuild-checkpoint.json}"
LOG_PATH="${LOG_PATH:-$ALPHABOOK_ROOT/logs/rebuild-r2-corpus-all.log}"

mkdir -p "$(dirname "$LOG_PATH")"
mkdir -p "$(dirname "$MIRROR_CHECKPOINT_PATH")"

set -a
# shellcheck disable=SC1090
source "$INGEST_ENV_FILE"
set +a

export GUTENBERG_MIRROR_ROOT
export MIRROR_CHECKPOINT_PATH

start_after="-"
batch_num=0

while true; do
  batch_num=$((batch_num + 1))
  output="$(
    cd "$INGEST_REPO_ROOT"
    npx tsx apps/ingest/src/index.ts rebuild-r2-corpus "$start_after" "$MIRROR_BATCH_SIZE"
  )"

  printf '[%s] batch=%s start_after=%s\n%s\n' "$(date -Is)" "$batch_num" "$start_after" "$output" | tee -a "$LOG_PATH"

  processed="$(printf '%s' "$output" | jq -r '.processed')"
  next_start_after="$(printf '%s' "$output" | jq -r '.nextStartAfterId // empty')"

  if [[ "$processed" == "0" ]]; then
    printf '[%s] rebuilt all canonical corpus rows\n' "$(date -Is)" | tee -a "$LOG_PATH"
    break
  fi

  if [[ -z "$next_start_after" || "$next_start_after" == "null" ]]; then
    printf '[%s] stopping because nextStartAfterId was empty\n' "$(date -Is)" | tee -a "$LOG_PATH"
    break
  fi

  start_after="$next_start_after"
done
