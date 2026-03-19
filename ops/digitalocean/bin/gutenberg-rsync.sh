#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
PG_RSYNC_HOST="${PG_RSYNC_HOST:-aleph.gutenberg.org}"
RSYNC_TIMEOUT="${RSYNC_TIMEOUT:-600}"
ALPHABOOK_UPLOAD_AFTER_SYNC="${ALPHABOOK_UPLOAD_AFTER_SYNC:-0}"
UPLOAD_SCRIPT="${UPLOAD_SCRIPT:-$ALPHABOOK_ROOT/bin/gutenberg-upload.sh}"
RSYNC_PARTIAL_ROOT="${RSYNC_PARTIAL_ROOT:-$ALPHABOOK_ROOT/.rsync-partial/main}"

run_rsync() {
  local exit_code=0
  set +e
  rsync "$@"
  exit_code=$?
  set -e

  if [[ "$exit_code" -eq 23 ]]; then
    echo "[$(date -Is)] rsync reported code 23; keeping the mirror and continuing so upload/backfill can still run." >&2
    return 0
  fi

  return "$exit_code"
}

mkdir -p "$GUTENBERG_MIRROR_ROOT"
mkdir -p "$GUTENBERG_MIRROR_ROOT/cache/epub"
mkdir -p "$RSYNC_PARTIAL_ROOT"

RSYNC_FLAGS=(
  -az
  --delete
  --partial
  --partial-dir="$RSYNC_PARTIAL_ROOT"
  --timeout="$RSYNC_TIMEOUT"
  --contimeout=60
  --human-readable
  --no-motd
  --info=stats2,flist0,name0
)

MAIN_FILTERS=(
  --include='*/'
  --include='GUTINDEX*'
  --include='README*'
  --include='favicon.ico'
  --include='*.txt'
  --include='*.txt.utf-8'
  --include='*.htm'
  --include='*.html'
  --exclude='*'
)

EPUB_FILTERS=(
  --include='*/'
  --include='*.rdf'
  --include='*cover*.jpg'
  --include='*cover*.jpeg'
  --include='*cover*.png'
  --include='*cover*.webp'
  --exclude='*'
)

echo "[$(date -Is)] Syncing Project Gutenberg main corpus into $GUTENBERG_MIRROR_ROOT"
run_rsync "${RSYNC_FLAGS[@]}" --exclude 'cache/' "${MAIN_FILTERS[@]}" \
  "$PG_RSYNC_HOST::gutenberg" \
  "$GUTENBERG_MIRROR_ROOT"

echo "[$(date -Is)] Syncing Project Gutenberg generated EPUB/cache corpus into $GUTENBERG_MIRROR_ROOT/cache/epub"
run_rsync "${RSYNC_FLAGS[@]}" --exclude '*/mbt-*' "${EPUB_FILTERS[@]}" \
  "$PG_RSYNC_HOST::gutenberg-epub" \
  "$GUTENBERG_MIRROR_ROOT/cache/epub"

if [[ "$ALPHABOOK_UPLOAD_AFTER_SYNC" == "1" ]]; then
  echo "[$(date -Is)] Running Gutenberg uploader"
  "$UPLOAD_SCRIPT"
fi

echo "[$(date -Is)] Gutenberg rsync finished successfully"
