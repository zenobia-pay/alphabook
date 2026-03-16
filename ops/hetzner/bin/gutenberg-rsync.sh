#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
PG_RSYNC_HOST="${PG_RSYNC_HOST:-aleph.gutenberg.org}"
RSYNC_TIMEOUT="${RSYNC_TIMEOUT:-600}"
ALPHABOOK_UPLOAD_AFTER_SYNC="${ALPHABOOK_UPLOAD_AFTER_SYNC:-0}"
UPLOAD_SCRIPT="${UPLOAD_SCRIPT:-$ALPHABOOK_ROOT/bin/gutenberg-upload.sh}"

mkdir -p "$GUTENBERG_MIRROR_ROOT"
mkdir -p "$GUTENBERG_MIRROR_ROOT/cache/epub"

RSYNC_FLAGS=(
  -aH
  --delete
  --partial
  --partial-dir=.rsync-partial
  --timeout="$RSYNC_TIMEOUT"
  --contimeout=60
  --human-readable
  --no-motd
  --info=stats2,flist0,name0
)

echo "[$(date -Is)] Syncing Project Gutenberg main corpus into $GUTENBERG_MIRROR_ROOT"
rsync "${RSYNC_FLAGS[@]}" --exclude 'cache/' \
  "$PG_RSYNC_HOST::gutenberg" \
  "$GUTENBERG_MIRROR_ROOT"

echo "[$(date -Is)] Syncing Project Gutenberg generated EPUB/cache corpus into $GUTENBERG_MIRROR_ROOT/cache/epub"
rsync "${RSYNC_FLAGS[@]}" --exclude '*/mbt-*' \
  "$PG_RSYNC_HOST::gutenberg-epub" \
  "$GUTENBERG_MIRROR_ROOT/cache/epub"

if [[ "$ALPHABOOK_UPLOAD_AFTER_SYNC" == "1" ]]; then
  echo "[$(date -Is)] Running Gutenberg uploader"
  "$UPLOAD_SCRIPT"
fi

echo "[$(date -Is)] Gutenberg rsync finished successfully"
