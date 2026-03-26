#!/usr/bin/env bash
set -euo pipefail

sudo systemctl enable --now alphabook-gutenberg-rsync.timer alphabook-gutenberg-rsync-epub.timer

echo "Resumed Gutenberg mirror refresh timers."
