#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TARGET_HOST="${ALPHABOOK_FRONTEND_HOST:-${ALPHABOOK_WEB_HOST:-178.128.159.197}}"
TARGET_USER="${ALPHABOOK_FRONTEND_USER:-root}"
TARGET_DIR="${ALPHABOOK_FRONTEND_DIR:-/srv/alphabook/frontend}"
TARGET_REPO_DIR="${ALPHABOOK_WEB_REPO_DIR:-/srv/alphabook/repo}"
TARGET_COMPOSE_DIR="${ALPHABOOK_WEB_COMPOSE_DIR:-$TARGET_REPO_DIR/ops/digitalocean/linux/web}"
SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout="${ALPHABOOK_SSH_CONNECT_TIMEOUT_SECONDS:-10}"
)

cd "$ROOT_DIR"

npm run build -w @alphabook/frontend

ssh "${SSH_OPTS[@]}" "${TARGET_USER}@${TARGET_HOST}" "mkdir -p '${TARGET_DIR}'"

rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  "$ROOT_DIR/apps/frontend/dist/" \
  "${TARGET_USER}@${TARGET_HOST}:${TARGET_DIR}/"

rsync -az --relative -e "ssh ${SSH_OPTS[*]}" \
  ops/digitalocean/linux/web/Caddyfile \
  "${TARGET_USER}@${TARGET_HOST}:${TARGET_REPO_DIR}/"

ssh "${SSH_OPTS[@]}" "${TARGET_USER}@${TARGET_HOST}" \
  "cd ${TARGET_COMPOSE_DIR} && docker compose up -d --force-recreate caddy"

bash "$ROOT_DIR/ops/digitalocean/bin/purge-cloudflare-frontend-cache.sh"
