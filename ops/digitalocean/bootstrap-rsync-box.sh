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
apt-get install -y rsync curl ca-certificates jq nodejs npm openssl

mkdir -p "$ALPHABOOK_ROOT/bin"
mkdir -p "$GUTENBERG_MIRROR_ROOT/cache/epub"
mkdir -p "$ALPHABOOK_ROOT/logs"

install -m 0755 "$SCRIPT_DIR/bin/gutenberg-rsync.sh" "$ALPHABOOK_ROOT/bin/gutenberg-rsync.sh"
install -m 0755 "$SCRIPT_DIR/bin/gutenberg-rsync-epub.sh" "$ALPHABOOK_ROOT/bin/gutenberg-rsync-epub.sh"
install -m 0755 "$SCRIPT_DIR/bin/gutenberg-upload.sh" "$ALPHABOOK_ROOT/bin/gutenberg-upload.sh"
install -m 0755 "$SCRIPT_DIR/bin/backfill-gutenberg-bulk-safe.sh" "$ALPHABOOK_ROOT/bin/backfill-gutenberg-bulk-safe.sh"
install -m 0755 "$SCRIPT_DIR/bin/freeze-gutenberg-ingest.sh" "$ALPHABOOK_ROOT/bin/freeze-gutenberg-ingest.sh"
install -m 0755 "$SCRIPT_DIR/bin/resume-gutenberg-ingest.sh" "$ALPHABOOK_ROOT/bin/resume-gutenberg-ingest.sh"
install -m 0755 "$SCRIPT_DIR/bin/audit-cloudflare-corpus.sh" "$ALPHABOOK_ROOT/bin/audit-cloudflare-corpus.sh"
install -m 0755 "$SCRIPT_DIR/bin/validate-corpus-integrity.sh" "$ALPHABOOK_ROOT/bin/validate-corpus-integrity.sh"
install -m 0755 "$SCRIPT_DIR/bin/rebuild-r2-corpus-all.sh" "$ALPHABOOK_ROOT/bin/rebuild-r2-corpus-all.sh"
install -m 0755 "$SCRIPT_DIR/bin/prune-orphan-vectors.sh" "$ALPHABOOK_ROOT/bin/prune-orphan-vectors.sh"
install -m 0755 "$SCRIPT_DIR/bin/prune-orphan-d1-records.sh" "$ALPHABOOK_ROOT/bin/prune-orphan-d1-records.sh"
install -m 0755 "$SCRIPT_DIR/bin/prune-orphan-r2-keys.sh" "$ALPHABOOK_ROOT/bin/prune-orphan-r2-keys.sh"
install -m 0755 "$SCRIPT_DIR/bin/hermes-job-api.mjs" "$ALPHABOOK_ROOT/bin/hermes-job-api.mjs"
install -m 0755 "$SCRIPT_DIR/bin/openai-logging-proxy.mjs" "$ALPHABOOK_ROOT/bin/openai-logging-proxy.mjs"
install -m 0644 "$SCRIPT_DIR/systemd/alphabook-gutenberg-rsync.service" /etc/systemd/system/alphabook-gutenberg-rsync.service
install -m 0644 "$SCRIPT_DIR/systemd/alphabook-gutenberg-rsync.timer" /etc/systemd/system/alphabook-gutenberg-rsync.timer
install -m 0644 "$SCRIPT_DIR/systemd/alphabook-gutenberg-rsync-epub.service" /etc/systemd/system/alphabook-gutenberg-rsync-epub.service
install -m 0644 "$SCRIPT_DIR/systemd/alphabook-gutenberg-rsync-epub.timer" /etc/systemd/system/alphabook-gutenberg-rsync-epub.timer
install -m 0644 "$SCRIPT_DIR/systemd/alphabook-hermes-job-api.service" /etc/systemd/system/alphabook-hermes-job-api.service
install -m 0644 "$SCRIPT_DIR/systemd/alphabook-openai-logging-proxy.service" /etc/systemd/system/alphabook-openai-logging-proxy.service

if [[ ! -f "$ALPHABOOK_ROOT/.hermes-job-api-token" ]]; then
  openssl rand -hex 24 > "$ALPHABOOK_ROOT/.hermes-job-api-token"
  chmod 600 "$ALPHABOOK_ROOT/.hermes-job-api-token"
fi

systemctl daemon-reload
systemctl enable --now alphabook-gutenberg-rsync.timer
systemctl enable --now alphabook-gutenberg-rsync-epub.timer

cat <<EOF
AlphaBook Gutenberg rsync box is bootstrapped.

Mirror root: $GUTENBERG_MIRROR_ROOT
Runner: $ALPHABOOK_ROOT/bin/gutenberg-rsync.sh
EPUB runner: $ALPHABOOK_ROOT/bin/gutenberg-rsync-epub.sh
Uploader: $ALPHABOOK_ROOT/bin/gutenberg-upload.sh
Safe bulk backfill: $ALPHABOOK_ROOT/bin/backfill-gutenberg-bulk-safe.sh
Audit: $ALPHABOOK_ROOT/bin/audit-cloudflare-corpus.sh
Validate: $ALPHABOOK_ROOT/bin/validate-corpus-integrity.sh
Rebuild: $ALPHABOOK_ROOT/bin/rebuild-r2-corpus-all.sh
Hermes job API runner: $ALPHABOOK_ROOT/bin/hermes-job-api.mjs
OpenAI logging proxy: $ALPHABOOK_ROOT/bin/openai-logging-proxy.mjs
Useful commands:
  systemctl status alphabook-gutenberg-rsync.timer
  systemctl status alphabook-gutenberg-rsync-epub.timer
  systemctl start alphabook-gutenberg-rsync.service
  systemctl start alphabook-gutenberg-rsync-epub.service
  systemctl enable --now alphabook-hermes-job-api.service   # requires /srv/alphabook/repo
  systemctl enable --now alphabook-openai-logging-proxy.service
  journalctl -u alphabook-gutenberg-rsync.service -n 200 --no-pager
  journalctl -u alphabook-gutenberg-rsync-epub.service -n 200 --no-pager
EOF
