#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
FALLBACK_ENV_FILE="${FALLBACK_ENV_FILE:-/srv/alphabook/.ingest.env}"

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "Missing repo root: $ROOT_DIR" >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 --query 'Find me every example of grief in all of the books in this database.' [extra args...]" >&2
  exit 1
fi

cd "$ROOT_DIR"

if [[ -f "$ENV_FILE" ]]; then
  export OPENAI_API_KEY="$(
    python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.startswith("OPENAI_API_KEY="):
        value = line.split("=", 1)[1].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        print(value)
        break
PY
  )"
elif [[ -f "$FALLBACK_ENV_FILE" ]]; then
  export OPENAI_API_KEY="$(
    python3 - "$FALLBACK_ENV_FILE" <<'PY'
from pathlib import Path
import sys
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.startswith("OPENAI_API_KEY="):
        value = line.split("=", 1)[1].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        print(value)
        break
PY
  )"
fi

exec node --import tsx packages/tooling/scripts/run-gutenberg-agentic-search.ts "$@"
