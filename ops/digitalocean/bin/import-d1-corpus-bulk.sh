#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
BOOKS_ROOT="${BOOKS_ROOT:-/mnt/alphabook_consolidation/final/20260402T044501Z/books}"
CANONICAL_CORPUS_IDS_PATH="${CANONICAL_CORPUS_IDS_PATH:-$ALPHABOOK_ROOT/logs/cloudflare-rebuild-recovery/20260405T205210Z/canonical_ids.txt}"
OUTPUT_DIR="${OUTPUT_DIR:-$ALPHABOOK_ROOT/tmp/d1-corpus-import}"
EXISTING_WORK_IDS_JSON="${EXISTING_WORK_IDS_JSON:-$ALPHABOOK_ROOT/tmp/existing-work-ids.json}"
BATCH_SIZE="${BATCH_SIZE:-1000}"
LOG_PATH="${LOG_PATH:-$ALPHABOOK_ROOT/logs/import-d1-corpus-bulk.log}"

mkdir -p "$(dirname "$LOG_PATH")"
mkdir -p "$OUTPUT_DIR"
mkdir -p "$(dirname "$EXISTING_WORK_IDS_JSON")"

set -a
# shellcheck disable=SC1090
source "$INGEST_ENV_FILE"
set +a

cd "$INGEST_REPO_ROOT"

npx wrangler d1 execute "${D1_DATABASE_NAME:-alphabook-app}" \
  --remote \
  --json \
  --command "SELECT id, CAST(gutenberg_id AS TEXT) AS gutenberg_id FROM works WHERE gutenberg_id IS NOT NULL ORDER BY gutenberg_id" \
  --config "${D1_WRANGLER_CONFIG:-ops/cloudflare/resources.toml}" > "$EXISTING_WORK_IDS_JSON"

npx tsx scripts/build-d1-corpus-import.ts \
  "$BOOKS_ROOT" \
  "$CANONICAL_CORPUS_IDS_PATH" \
  "$OUTPUT_DIR" \
  "$EXISTING_WORK_IDS_JSON" \
  "$BATCH_SIZE" | tee -a "$LOG_PATH"

for sql_file in "$OUTPUT_DIR"/*.sql; do
  printf '[%s] importing %s\n' "$(date -Is)" "$sql_file" | tee -a "$LOG_PATH"
  npx tsx packages/tooling/scripts/import-d1-sql.ts \
    "${D1_DATABASE_NAME:-alphabook-app}" \
    "$sql_file" | tee -a "$LOG_PATH"
done

printf '[%s] completed bulk D1 import\n' "$(date -Is)" | tee -a "$LOG_PATH"
