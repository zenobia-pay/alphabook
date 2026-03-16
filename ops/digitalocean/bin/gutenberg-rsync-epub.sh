#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
PG_RSYNC_HOST="${PG_RSYNC_HOST:-aleph.gutenberg.org}"
RSYNC_TIMEOUT="${RSYNC_TIMEOUT:-600}"
RSYNC_PARTIAL_ROOT="${RSYNC_PARTIAL_ROOT:-$ALPHABOOK_ROOT/.rsync-partial/epub}"

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

RSYNC_DIR_FLAGS=(
  -az
  --timeout="$RSYNC_TIMEOUT"
  --contimeout=60
  --human-readable
  --no-motd
  --info=stats2,flist0,name0
)

EPUB_DIR_FILTERS=(
  --include='*/'
  --exclude='*'
)

EPUB_FILE_FILTERS=(
  --include='*/'
  --include='*.rdf'
  --include='*cover*.jpg'
  --include='*cover*.jpeg'
  --include='*cover*.png'
  --include='*cover*.webp'
  --exclude='*'
)

echo "[$(date -Is)] Syncing Project Gutenberg generated EPUB/cache corpus into $GUTENBERG_MIRROR_ROOT/cache/epub"
# Precreate the directory tree so fresh IDs have a destination before file transfer starts.
rsync "${RSYNC_DIR_FLAGS[@]}" --exclude '*/mbt-*' "${EPUB_DIR_FILTERS[@]}" \
  "$PG_RSYNC_HOST::gutenberg-epub" \
  "$GUTENBERG_MIRROR_ROOT/cache/epub"

rsync "${RSYNC_FLAGS[@]}" --exclude '*/mbt-*' "${EPUB_FILE_FILTERS[@]}" \
  "$PG_RSYNC_HOST::gutenberg-epub" \
  "$GUTENBERG_MIRROR_ROOT/cache/epub"

echo "[$(date -Is)] Gutenberg EPUB/cache rsync finished successfully"
