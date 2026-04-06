#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"

exec python3 "$ROOT_DIR/ops/digitalocean/bin/run-qdrant-rag-retrieval.py" "$@"
