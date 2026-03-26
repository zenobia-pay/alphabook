#!/usr/bin/env bash
set -euo pipefail

sudo systemctl stop alphabook-gutenberg-rsync.timer alphabook-gutenberg-rsync-epub.timer || true
sudo systemctl disable alphabook-gutenberg-rsync.timer alphabook-gutenberg-rsync-epub.timer || true
sudo systemctl stop alphabook-gutenberg-rsync.service alphabook-gutenberg-rsync-epub.service || true

echo "Frozen Gutenberg mirror refresh and upload timers."
