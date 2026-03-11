#!/usr/bin/env sh
set -eu

if [ -n "${TU_TOKEN:-}" ]; then
  tu login --token "${TU_TOKEN}"
fi

exec alphabook-agent-server --host 0.0.0.0 --port "${PORT:-8080}"
