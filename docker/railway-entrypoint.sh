#!/usr/bin/env sh
set -eu

if [ -n "${TU_CREDENTIALS_JSON:-}" ]; then
  mkdir -p /root/.terminaluse
  printf '%s' "${TU_CREDENTIALS_JSON}" > /root/.terminaluse/credentials.json
  chmod 600 /root/.terminaluse/credentials.json
fi

if [ -n "${TU_TOKEN:-}" ]; then
  tu login --token "${TU_TOKEN}"
fi

exec alphabook-agent-server --host 0.0.0.0 --port "${PORT:-8080}"
