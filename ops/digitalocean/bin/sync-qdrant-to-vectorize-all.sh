#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
QDRANT_VECTORIZE_CHECKPOINT_PATH="${QDRANT_VECTORIZE_CHECKPOINT_PATH:-$ALPHABOOK_ROOT/.alphabook/qdrant-to-vectorize-checkpoint.json}"
LOG_PATH="${LOG_PATH:-$ALPHABOOK_ROOT/logs/sync-qdrant-to-vectorize-all.log}"
WORKER_COUNT="${WORKER_COUNT:-4}"
VECTORIZE_UPSERT_BATCH_SIZE="${VECTORIZE_UPSERT_BATCH_SIZE:-1000}"
QDRANT_POINT_LOOKUP_BATCH_SIZE="${QDRANT_POINT_LOOKUP_BATCH_SIZE:-256}"
PARTITION_DIR="${PARTITION_DIR:-$ALPHABOOK_ROOT/.alphabook/qdrant-vectorize-source-ids}"
BOOK_HTML_ROOT="${BOOK_HTML_ROOT:-/mnt/alphabook_consolidation/final/latest/r2/gutenberg/clean}"
QDRANT_RANGE_SPEC="${QDRANT_RANGE_SPEC:-1:20000,20001:40000,40001:60000,60001:999999}"

mkdir -p "$(dirname "$LOG_PATH")"
mkdir -p "$(dirname "$QDRANT_VECTORIZE_CHECKPOINT_PATH")"

set -a
# shellcheck disable=SC1090
source "$INGEST_ENV_FILE"
set +a

export VECTOR_PROVIDER="vectorize"
export QDRANT_VECTORIZE_CHECKPOINT_PATH
export VECTORIZE_UPSERT_BATCH_SIZE
export QDRANT_POINT_LOOKUP_BATCH_SIZE

cd "$INGEST_REPO_ROOT"

IFS=',' read -r -a RANGE_LIST <<< "$QDRANT_RANGE_SPEC"

if [[ "${#RANGE_LIST[@]}" -ne "$WORKER_COUNT" ]]; then
  echo "WORKER_COUNT=$WORKER_COUNT does not match QDRANT_RANGE_SPEC entries=${#RANGE_LIST[@]}" >&2
  exit 1
fi

mkdir -p "$PARTITION_DIR"

python3 - "$BOOK_HTML_ROOT" "$PARTITION_DIR" "${RANGE_LIST[@]}" <<'PY'
import json
import sys
from pathlib import Path

clean_root = Path(sys.argv[1])
partition_dir = Path(sys.argv[2])
ranges = []
for spec in sys.argv[3:]:
  min_id, max_id = spec.split(":", 1)
  ranges.append((int(min_id), int(max_id)))

writers = []
try:
  for index in range(len(ranges)):
    path = partition_dir / f"worker-{index + 1}.txt"
    writers.append(path.open("w", encoding="utf-8"))

  for book_dir in sorted(clean_root.iterdir(), key=lambda entry: int(entry.name) if entry.name.isdigit() else entry.name):
    if not book_dir.is_dir() or not book_dir.name.isdigit():
      continue
    gutenberg_id = int(book_dir.name)
    worker_index = None
    for index, (min_id, max_id) in enumerate(ranges):
      if min_id <= gutenberg_id <= max_id:
        worker_index = index
        break
    if worker_index is None:
      continue
    chunks_path = book_dir / "chunks.jsonl"
    if not chunks_path.exists():
      continue
    with chunks_path.open("r", encoding="utf-8") as handle:
      for line in handle:
        line = line.strip()
        if not line:
          continue
        payload = json.loads(line)
        source_id = payload.get("id") or payload.get("chunkId") or payload.get("source_id")
        if source_id:
          writers[worker_index].write(f"{source_id}\n")
finally:
  for writer in writers:
    writer.close()
PY

pids=()
for index in "${!RANGE_LIST[@]}"; do
  worker=$((index + 1))
  worker_checkpoint="${QDRANT_VECTORIZE_CHECKPOINT_PATH%.json}.worker-${worker}.json"
  worker_log="${LOG_PATH%.log}.worker-${worker}.log"
  worker_source_ids="$PARTITION_DIR/worker-${worker}.txt"
  (
    export QDRANT_VECTORIZE_WORKER_LABEL="worker-${worker}"
    export QDRANT_VECTORIZE_CHECKPOINT_PATH="$worker_checkpoint"
    export QDRANT_SOURCE_IDS_FILE="$worker_source_ids"
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
