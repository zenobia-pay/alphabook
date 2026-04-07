#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TARGET_HOST="${ALPHABOOK_FRONTEND_HOST:-${ALPHABOOK_WEB_HOST:-178.128.159.197}}"
TARGET_USER="${ALPHABOOK_FRONTEND_USER:-root}"
TARGET_DIR="${ALPHABOOK_FRONTEND_DIR:-/srv/alphabook/frontend}"
SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout="${ALPHABOOK_SSH_CONNECT_TIMEOUT_SECONDS:-10}"
)

cd "$ROOT_DIR"

npm run build -w @alphabook/frontend

rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  "$ROOT_DIR/apps/frontend/dist/" \
  "${TARGET_USER}@${TARGET_HOST}:${TARGET_DIR}/"
