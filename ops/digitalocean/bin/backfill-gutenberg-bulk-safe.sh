#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
TARGET_COUNT="${TARGET_COUNT:-2000}"
BATCH_SIZE="${BATCH_SIZE:-100}"
CONCURRENCY="${CONCURRENCY:-4}"
VALIDATE_EVERY_BATCHES="${VALIDATE_EVERY_BATCHES:-1}"
CHECKPOINT_PATH="${CHECKPOINT_PATH:-$ALPHABOOK_ROOT/.alphabook/ingest-checkpoint.json}"
RUN_ROOT="${RUN_ROOT:-$ALPHABOOK_ROOT/logs/gutenberg-bulk}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="$RUN_ROOT/$RUN_ID"
TARGET_FILE="$RUN_DIR/target.json"

if [[ ! -f "$INGEST_ENV_FILE" ]]; then
  echo "[$(date -Is)] Ingest env file not found: $INGEST_ENV_FILE" >&2
  exit 1
fi

mkdir -p "$RUN_DIR"

sudo "$ALPHABOOK_ROOT/bin/freeze-gutenberg-ingest.sh"
trap 'echo "[$(date -Is)] Bulk run stopped with timers still frozen. Resume manually after review: sudo /srv/alphabook/bin/resume-gutenberg-ingest.sh" >&2' EXIT

set -a
# shellcheck disable=SC1090
source "$INGEST_ENV_FILE"
set +a

unset CLOUDFLARE_API_TOKEN CF_API_TOKEN CF_ACCOUNT_ID CLOUDFLARE_ACCOUNT_ID

export GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
export MIRROR_CHECKPOINT_PATH="$CHECKPOINT_PATH"

cd "$INGEST_REPO_ROOT"

python3 - <<'PY' > "$TARGET_FILE"
import json
import os
from pathlib import Path

target_count = int(os.environ["TARGET_COUNT"])
start_after = None
checkpoint_path = Path(os.environ["CHECKPOINT_PATH"])
if checkpoint_path.exists():
    try:
        start_after = json.loads(checkpoint_path.read_text()).get("lastProcessedId")
    except Exception:
        start_after = None

root = Path(os.environ["GUTENBERG_MIRROR_ROOT"])
ids = sorted(
    [entry.name for entry in root.iterdir() if entry.is_dir() and entry.name.isdigit()],
    key=lambda value: int(value),
)
if start_after is not None:
    ids = [value for value in ids if int(value) > int(start_after)]

print(json.dumps({
    "targetCount": target_count,
    "startAfterId": start_after,
    "checkpointPath": str(checkpoint_path),
    "candidatePreview": ids[:target_count],
}, indent=2))
PY

echo "[$(date -Is)] Frozen timers. Checkpoint: $CHECKPOINT_PATH"
echo "[$(date -Is)] Run directory: $RUN_DIR"
echo "[$(date -Is)] Conservative settings: batch=$BATCH_SIZE concurrency=$CONCURRENCY validateEveryBatches=$VALIDATE_EVERY_BATCHES"

processed_total=0
batch_number=0
while (( processed_total < TARGET_COUNT )); do
  remaining=$((TARGET_COUNT - processed_total))
  batch_limit=$BATCH_SIZE
  if (( remaining < batch_limit )); then
    batch_limit=$remaining
  fi

  batch_number=$((batch_number + 1))
  batch_result="$RUN_DIR/batch-$(printf '%04d' "$batch_number")-upload.json"
  batch_ids="$RUN_DIR/batch-$(printf '%04d' "$batch_number")-ids.txt"
  batch_validate="$RUN_DIR/batch-$(printf '%04d' "$batch_number")-validate.json"

  echo "[$(date -Is)] Starting batch $batch_number with limit=$batch_limit"
  npx tsx apps/ingest/src/index.ts backfill-mirror-parallel - "$batch_limit" "$CONCURRENCY" > "$batch_result"

  batch_processed="$(python3 - <<'PY' "$batch_result" "$batch_ids"
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
ids = []
for entry in payload.get("results", []):
    external_id = entry.get("externalId")
    if external_id is not None:
        ids.append(str(external_id))
for entry in payload.get("errors", []):
    gutenberg_id = entry.get("gutenbergId")
    if gutenberg_id is not None:
        ids.append(str(gutenberg_id))

deduped = []
seen = set()
for value in ids:
    if value not in seen:
      seen.add(value)
      deduped.append(value)

Path(sys.argv[2]).write_text("\n".join(deduped) + ("\n" if deduped else ""))
print(int(payload.get("processed", 0)))
PY
)"

  if [[ "$batch_processed" == "0" ]]; then
    echo "[$(date -Is)] No additional books were processed. Stopping." >&2
    break
  fi

  processed_total=$((processed_total + batch_processed))
  echo "[$(date -Is)] Batch $batch_number processed=$batch_processed totalProcessed=$processed_total"

  if (( batch_number % VALIDATE_EVERY_BATCHES == 0 )); then
    if [[ ! -s "$batch_ids" ]]; then
      echo "[$(date -Is)] Batch $batch_number produced no IDs to validate." >&2
      exit 1
    fi
    CANONICAL_CORPUS_IDS_PATH="$batch_ids" \
      npx tsx apps/ingest/src/index.ts validate-corpus-integrity - - "$batch_validate" > /tmp/alphabook-batch-validate.stdout
    python3 - <<'PY' "$batch_validate"
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
if not payload.get("ok"):
    raise SystemExit(f"Validation failed for batch report {sys.argv[1]} with {payload.get('blockingIssueCount')} blocking issues.")
PY
    echo "[$(date -Is)] Validation passed for batch $batch_number"
  fi
done

trap - EXIT
echo "[$(date -Is)] Bulk run finished with timers still frozen for manual review."
echo "[$(date -Is)] Resume when ready: sudo /srv/alphabook/bin/resume-gutenberg-ingest.sh"
