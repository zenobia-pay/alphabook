#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
PG_RSYNC_HOST="${PG_RSYNC_HOST:-aleph.gutenberg.org}"
RSYNC_TIMEOUT="${RSYNC_TIMEOUT:-600}"

mkdir -p "$GUTENBERG_MIRROR_ROOT/cache/epub"

RSYNC_FLAGS=(
  -az
  --delete
  --partial
  --partial-dir=.rsync-partial
  --timeout="$RSYNC_TIMEOUT"
  --contimeout=60
  --human-readable
  --no-motd
  --info=stats2,flist0,name0
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

echo "[$(date -Is)] Syncing Project Gutenberg generated EPUB/cache corpus into $GUTENBERG_MIRROR_ROOT/cache/epub"
rsync "${RSYNC_FLAGS[@]}" --exclude '*/mbt-*' "${EPUB_FILTERS[@]}" \
  "$PG_RSYNC_HOST::gutenberg-epub" \
  "$GUTENBERG_MIRROR_ROOT/cache/epub"

echo "[$(date -Is)] Gutenberg EPUB/cache rsync finished successfully"
