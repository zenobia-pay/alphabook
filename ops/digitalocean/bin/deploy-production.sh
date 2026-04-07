#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

cd "$ROOT_DIR"

# Production AlphaBook now runs as:
# - static frontend on alphabook-web-01
# - Linux API on alphabook-web-01
# - Linux worker/runtime on alphabook-worker-01
# Cloudflare remains only as DNS/TLS/proxy in front of those boxes.

bash "$ROOT_DIR/ops/digitalocean/bin/deploy-linux-frontend.sh"
bash "$ROOT_DIR/ops/digitalocean/bin/deploy-linux-web.sh"
bash "$ROOT_DIR/ops/digitalocean/bin/deploy-linux-worker.sh"
