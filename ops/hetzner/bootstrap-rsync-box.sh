#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALPHABOOK_ROOT="${ALPHABOOK_ROOT:-/srv/alphabook}"
GUTENBERG_MIRROR_ROOT="${GUTENBERG_MIRROR_ROOT:-$ALPHABOOK_ROOT/gutenberg}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y rsync curl ca-certificates jq

mkdir -p "$ALPHABOOK_ROOT/bin"
mkdir -p "$GUTENBERG_MIRROR_ROOT/cache/epub"
mkdir -p "$ALPHABOOK_ROOT/logs"

install -m 0755 "$SCRIPT_DIR/bin/gutenberg-rsync.sh" "$ALPHABOOK_ROOT/bin/gutenberg-rsync.sh"
install -m 0644 "$SCRIPT_DIR/systemd/alphabook-gutenberg-rsync.service" /etc/systemd/system/alphabook-gutenberg-rsync.service
install -m 0644 "$SCRIPT_DIR/systemd/alphabook-gutenberg-rsync.timer" /etc/systemd/system/alphabook-gutenberg-rsync.timer

systemctl daemon-reload
systemctl enable --now alphabook-gutenberg-rsync.timer

cat <<EOF
AlphaBook Gutenberg rsync box is bootstrapped.

Mirror root: $GUTENBERG_MIRROR_ROOT
Runner: $ALPHABOOK_ROOT/bin/gutenberg-rsync.sh

Useful commands:
  systemctl status alphabook-gutenberg-rsync.timer
  systemctl start alphabook-gutenberg-rsync.service
  journalctl -u alphabook-gutenberg-rsync.service -n 200 --no-pager
EOF
