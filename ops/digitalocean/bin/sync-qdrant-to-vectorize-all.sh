#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
QDRANT_VECTORIZE_CHECKPOINT_PATH="${QDRANT_VECTORIZE_CHECKPOINT_PATH:-$ALPHABOOK_ROOT/.alphabook/qdrant-to-vectorize-checkpoint.json}"
LOG_PATH="${LOG_PATH:-$ALPHABOOK_ROOT/logs/sync-qdrant-to-vectorize-all.log}"
WORKER_COUNT="${WORKER_COUNT:-4}"
QDRANT_SCROLL_LIMIT="${QDRANT_SCROLL_LIMIT:-1000}"
VECTORIZE_UPSERT_BATCH_SIZE="${VECTORIZE_UPSERT_BATCH_SIZE:-1000}"
QDRANT_RANGE_SPEC="${QDRANT_RANGE_SPEC:-1:20000,20001:40000,40001:60000,60001:999999}"

mkdir -p "$(dirname "$LOG_PATH")"
mkdir -p "$(dirname "$QDRANT_VECTORIZE_CHECKPOINT_PATH")"

set -a
# shellcheck disable=SC1090
source "$INGEST_ENV_FILE"
set +a

export VECTOR_PROVIDER="vectorize"
export QDRANT_VECTORIZE_CHECKPOINT_PATH
export QDRANT_SCROLL_LIMIT
export VECTORIZE_UPSERT_BATCH_SIZE

cd "$INGEST_REPO_ROOT"

IFS=',' read -r -a RANGE_LIST <<< "$QDRANT_RANGE_SPEC"

if [[ "${#RANGE_LIST[@]}" -ne "$WORKER_COUNT" ]]; then
  echo "WORKER_COUNT=$WORKER_COUNT does not match QDRANT_RANGE_SPEC entries=${#RANGE_LIST[@]}" >&2
  exit 1
fi

pids=()
for index in "${!RANGE_LIST[@]}"; do
  worker=$((index + 1))
  range_spec="${RANGE_LIST[$index]}"
  min_id="${range_spec%%:*}"
  max_id="${range_spec##*:}"
  worker_checkpoint="${QDRANT_VECTORIZE_CHECKPOINT_PATH%.json}.worker-${worker}.json"
  worker_log="${LOG_PATH%.log}.worker-${worker}.log"
  (
    export QDRANT_GUTENBERG_ID_MIN="$min_id"
    export QDRANT_GUTENBERG_ID_MAX="$max_id"
    export QDRANT_VECTORIZE_WORKER_LABEL="worker-${worker}"
    export QDRANT_VECTORIZE_CHECKPOINT_PATH="$worker_checkpoint"
    npx tsx scripts/sync-qdrant-to-vectorize.ts
  ) | tee -a "$worker_log" &
  pids+=("$!")
done

status=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    status=1
  fi
done

exit "$status"
