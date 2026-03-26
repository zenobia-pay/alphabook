#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
OUTPUT_PATH="${OUTPUT_PATH:-$ALPHABOOK_ROOT/logs/corpus-integrity.json}"
START_AFTER_ID="${START_AFTER_ID:--}"
LIMIT="${LIMIT:--}"

mkdir -p "$(dirname "$OUTPUT_PATH")"

set -a
# shellcheck disable=SC1090
source "$INGEST_ENV_FILE"
set +a

cd "$INGEST_REPO_ROOT"
npx tsx apps/ingest/src/index.ts validate-corpus-integrity "$START_AFTER_ID" "$LIMIT" "$OUTPUT_PATH"
