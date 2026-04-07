#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TARGET_HOST="${ALPHABOOK_WEB_HOST:-178.128.159.197}"
TARGET_USER="${ALPHABOOK_WEB_USER:-root}"
TARGET_REPO_DIR="${ALPHABOOK_WEB_REPO_DIR:-/srv/alphabook/repo}"
TARGET_COMPOSE_DIR="${ALPHABOOK_WEB_COMPOSE_DIR:-$TARGET_REPO_DIR/ops/digitalocean/linux/web}"
SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout="${ALPHABOOK_SSH_CONNECT_TIMEOUT_SECONDS:-10}"
)

cd "$ROOT_DIR"

rsync -az --delete --relative -e "ssh ${SSH_OPTS[*]}" \
  package.json \
  package-lock.json \
  tsconfig.json \
  tsconfig.base.json \
  apps/orchestrator-worker \
  apps/runtime \
  packages \
  ops/digitalocean/linux/web \
  "${TARGET_USER}@${TARGET_HOST}:${TARGET_REPO_DIR}/"

ssh "${SSH_OPTS[@]}" "${TARGET_USER}@${TARGET_HOST}" \
  "cd ${TARGET_COMPOSE_DIR} && docker compose up -d --build alphabook-api caddy"
