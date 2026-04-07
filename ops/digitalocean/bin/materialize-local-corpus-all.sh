#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
INGEST_ENV_FILE="${INGEST_ENV_FILE:-$ALPHABOOK_ROOT/.ingest.env}"
INGEST_REPO_ROOT="${INGEST_REPO_ROOT:-$ALPHABOOK_ROOT/repo}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
OUTPUT_DIR="${OUTPUT_DIR:-/mnt/alphabook_consolidation/final/latest}"
STATE_DIR="${STATE_DIR:-$ALPHABOOK_ROOT/.alphabook/local-corpus-materialize}"
MISSING_IDS_PATH="${MISSING_IDS_PATH:-$STATE_DIR/missing-ids.txt}"
CURSOR_PATH="${CURSOR_PATH:-$STATE_DIR/cursor.txt}"
BATCH_IDS_PATH="${BATCH_IDS_PATH:-$STATE_DIR/current-batch-ids.txt}"
PREP_BATCH_SIZE="${PREP_BATCH_SIZE:-250}"
PREP_CONCURRENCY="${PREP_CONCURRENCY:-8}"
LOG_PATH="${LOG_PATH:-$ALPHABOOK_ROOT/logs/materialize-local-corpus-all.log}"
IMPORT_TO_POSTGRES="${IMPORT_TO_POSTGRES:-0}"
DATABASE_URL="${DATABASE_URL:-}"

mkdir -p "$(dirname "$LOG_PATH")"
mkdir -p "$STATE_DIR"
mkdir -p "$OUTPUT_DIR"

set -a
if [[ -f "$INGEST_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$INGEST_ENV_FILE"
fi
set +a

cd "$INGEST_REPO_ROOT"

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*" | tee -a "$LOG_PATH"
}

if [[ ! -f "$MISSING_IDS_PATH" ]]; then
  log "building missing Gutenberg id list for $OUTPUT_DIR"
  node --import tsx - "$GUTENBERG_MIRROR_ROOT" "$OUTPUT_DIR/books" "$MISSING_IDS_PATH" <<'EOF' | tee -a "$LOG_PATH"
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { listMirrorIds } from "./packages/source-gutenberg/src/mirror.ts";

const [, , mirrorRootArg, booksRootArg, outputPathArg] = process.argv;
if (!mirrorRootArg || !booksRootArg || !outputPathArg) {
  throw new Error("Usage: node --import tsx - <mirrorRoot> <booksRoot> <outputPath>");
}

const mirrorRoot = resolve(mirrorRootArg);
const booksRoot = resolve(booksRootArg);
const outputPath = resolve(outputPathArg);
const allIds = Array.from(
  new Set(
    (await listMirrorIds(mirrorRoot))
      .filter((value) => /^\d+$/u.test(value))
      .map((value) => String(Number(value))),
  ),
).sort((left, right) => Number(left) - Number(right));
let existingIds: string[] = [];
try {
  existingIds = (await readdir(booksRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => String(Number(entry.name)));
} catch {
  existingIds = [];
}
const existingIdSet = new Set(existingIds);
const missingIds = allIds.filter((id) => !existingIdSet.has(id));
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${missingIds.join("\n")}\n`, "utf8");
console.log(JSON.stringify({
  mirrorBookCount: allIds.length,
  existingBookCount: existingIds.length,
  missingBookCount: missingIds.length,
  outputPath,
}, null, 2));
EOF
fi

if [[ ! -f "$CURSOR_PATH" ]]; then
  printf '1\n' > "$CURSOR_PATH"
fi

while true; do
  start_line="$(tr -dc '0-9' < "$CURSOR_PATH")"
  if [[ -z "$start_line" ]]; then
    start_line=1
  fi

  tail -n +"$start_line" "$MISSING_IDS_PATH" | head -n "$PREP_BATCH_SIZE" > "$BATCH_IDS_PATH"
  batch_count="$(grep -c '^[0-9]\+$' "$BATCH_IDS_PATH" || true)"
  if [[ "$batch_count" == "0" ]]; then
    log "local corpus materialization complete"
    break
  fi

  log "materializing batch start_line=$start_line batch_count=$batch_count"
  output="$(
    npx tsx apps/ingest/src/index.ts prepare-local-gutenberg-artifacts \
      - \
      "$OUTPUT_DIR" \
      "$PREP_BATCH_SIZE" \
      "$PREP_CONCURRENCY" \
      "$BATCH_IDS_PATH"
  )"
  printf '%s\n' "$output" | tee -a "$LOG_PATH"

  next_line=$((start_line + batch_count))
  printf '%s\n' "$next_line" > "$CURSOR_PATH"
done

if [[ "$IMPORT_TO_POSTGRES" == "1" ]]; then
  if [[ -z "$DATABASE_URL" ]]; then
    log "IMPORT_TO_POSTGRES=1 but DATABASE_URL is empty"
    exit 1
  fi
  log "importing manifests from $OUTPUT_DIR/books into Postgres"
  DATABASE_URL="$DATABASE_URL" node --import tsx packages/tooling/scripts/import-corpus-manifests.ts "$OUTPUT_DIR/books" | tee -a "$LOG_PATH"
fi
