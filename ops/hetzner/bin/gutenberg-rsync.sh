#!/usr/bin/env bash
set -euo pipefail

ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"
PG_RSYNC_HOST="${PG_RSYNC_HOST:-aleph.gutenberg.org}"
RSYNC_TIMEOUT="${RSYNC_TIMEOUT:-600}"

mkdir -p "$GUTENBERG_MIRROR_ROOT"
mkdir -p "$GUTENBERG_MIRROR_ROOT/cache/epub"

echo "[$(date -Is)] Syncing Project Gutenberg main corpus into $GUTENBERG_MIRROR_ROOT"
rsync -avHS --timeout="$RSYNC_TIMEOUT" --delete --exclude 'cache/' \
  "$PG_RSYNC_HOST::gutenberg" \
  "$GUTENBERG_MIRROR_ROOT"

echo "[$(date -Is)] Syncing Project Gutenberg generated EPUB/cache corpus into $GUTENBERG_MIRROR_ROOT/cache/epub"
rsync -avHS --timeout="$RSYNC_TIMEOUT" --delete --exclude '*/mbt-*' \
  "$PG_RSYNC_HOST::gutenberg-epub" \
  "$GUTENBERG_MIRROR_ROOT/cache/epub"

echo "[$(date -Is)] Gutenberg rsync finished successfully"
