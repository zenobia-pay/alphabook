#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
INGEST_IMAGE="${INGEST_IMAGE:-alphabook-ingest:latest}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
MIRROR_BATCH_SIZE="${MIRROR_BATCH_SIZE:-25}"
MIRROR_BACKFILL_CONCURRENCY="${MIRROR_BACKFILL_CONCURRENCY:-1}"
MIRROR_CHECKPOINT_PATH="${MIRROR_CHECKPOINT_PATH:-$ALPHABOOK_ROOT/.alphabook/ingest-checkpoint.json}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
LOCAL_RUNNER="${LOCAL_RUNNER:-npx}"
UPLOAD_LOCK_PATH="${UPLOAD_LOCK_PATH:-$ALPHABOOK_ROOT/.locks/gutenberg-upload.lock}"
GUTENBERG_SINGLE_ID="${GUTENBERG_SINGLE_ID:-}"
UPLOAD_MODE="${UPLOAD_MODE:-}"
UPLOAD_METRICS_PATH="${UPLOAD_METRICS_PATH:-$ALPHABOOK_ROOT/logs/gutenberg-upload-metrics.json}"
UPLOAD_RESULT_PATH="${UPLOAD_RESULT_PATH:-$ALPHABOOK_ROOT/logs/gutenberg-upload-result.json}"

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
mkdir -p "$(dirname "$UPLOAD_METRICS_PATH")"
mkdir -p "$(dirname "$UPLOAD_RESULT_PATH")"

exec 9>"$UPLOAD_LOCK_PATH"
if ! flock -n 9; then
  echo "[$(date -Is)] Gutenberg upload already running; exiting." >&2
  exit 0
fi

if ! command -v "$LOCAL_RUNNER" >/dev/null 2>&1; then
  echo "[$(date -Is)] $LOCAL_RUNNER is required so the uploader can invoke Wrangler with the configured Cloudflare API token." >&2
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

if [[ -z "${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}" ]]; then
  echo "[$(date -Is)] CLOUDFLARE_API_TOKEN (or CF_API_TOKEN) is required for Wrangler-backed D1 access during ingest." >&2
  exit 1
fi

export GUTENBERG_MIRROR_ROOT
export MIRROR_BATCH_SIZE
export MIRROR_BACKFILL_CONCURRENCY
export MIRROR_CHECKPOINT_PATH

if [[ -n "$GUTENBERG_SINGLE_ID" ]]; then
  UPLOAD_MODE="single"
fi
if [[ -z "$UPLOAD_MODE" ]]; then
  UPLOAD_MODE="backfill"
fi

STARTED_AT="$(date -Is)"
STARTED_TS="$(date +%s)"

if [[ "$UPLOAD_MODE" == "single" ]]; then
  if [[ -z "$GUTENBERG_SINGLE_ID" ]]; then
    echo "[$(date -Is)] GUTENBERG_SINGLE_ID is required when UPLOAD_MODE=single." >&2
    exit 1
  fi
  COMMAND=(tsx apps/ingest/src/index.ts ingest-gutenberg "$GUTENBERG_SINGLE_ID")
else
  COMMAND=(tsx apps/ingest/src/index.ts backfill-mirror-parallel - "$MIRROR_BATCH_SIZE" "$MIRROR_BACKFILL_CONCURRENCY")
fi

echo "[$(date -Is)] Uploading mirrored Gutenberg metadata and text via checked-out repo at $INGEST_REPO_ROOT"
(
  cd "$INGEST_REPO_ROOT"
  "$LOCAL_RUNNER" "${COMMAND[@]}" | tee "$UPLOAD_RESULT_PATH"
)

ENDED_AT="$(date -Is)"
ENDED_TS="$(date +%s)"
export UPLOAD_RESULT_PATH UPLOAD_METRICS_PATH UPLOAD_MODE GUTENBERG_SINGLE_ID STARTED_AT ENDED_AT STARTED_TS ENDED_TS
python3 - <<'PY'
import json, os

result_path = os.environ["UPLOAD_RESULT_PATH"]
metrics_path = os.environ["UPLOAD_METRICS_PATH"]
mode = os.environ["UPLOAD_MODE"]
single_id = os.environ.get("GUTENBERG_SINGLE_ID") or None
started_at = os.environ["STARTED_AT"]
ended_at = os.environ["ENDED_AT"]
started_ts = int(os.environ["STARTED_TS"])
ended_ts = int(os.environ["ENDED_TS"])

with open(result_path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

embedding = payload.get("embeddingMetrics") if isinstance(payload, dict) else None
metrics = {
    "mode": mode,
    "gutenbergId": single_id,
    "startedAt": started_at,
    "endedAt": ended_at,
    "durationSeconds": max(0, ended_ts - started_ts),
    "result": payload,
}
if isinstance(embedding, dict):
    metrics["embedding"] = embedding

with open(metrics_path, "w", encoding="utf-8") as handle:
    json.dump(metrics, handle, indent=2)
    handle.write("\n")
PY

echo "[$(date -Is)] Gutenberg upload finished successfully"
