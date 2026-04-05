#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
QDRANT_VECTORIZE_CHECKPOINT_PATH="${QDRANT_VECTORIZE_CHECKPOINT_PATH:-$ALPHABOOK_ROOT/.alphabook/qdrant-to-vectorize-checkpoint.json}"
LOG_PATH="${LOG_PATH:-$ALPHABOOK_ROOT/logs/sync-qdrant-to-vectorize-all.log}"

mkdir -p "$(dirname "$LOG_PATH")"
mkdir -p "$(dirname "$QDRANT_VECTORIZE_CHECKPOINT_PATH")"

set -a
# shellcheck disable=SC1090
source "$INGEST_ENV_FILE"
set +a

export VECTOR_PROVIDER="vectorize"
export QDRANT_VECTORIZE_CHECKPOINT_PATH

cd "$INGEST_REPO_ROOT"
npx tsx scripts/sync-qdrant-to-vectorize.ts | tee -a "$LOG_PATH"
