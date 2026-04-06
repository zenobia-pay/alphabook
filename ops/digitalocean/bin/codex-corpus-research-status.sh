#!/usr/bin/env bash
set -euo pipefail

RUN_ROOT="${RUN_ROOT:-/srv/alphabook/logs/codex-corpus-research}"
TAIL_LINES="${TAIL_LINES:-20}"

usage() {
  cat >&2 <<'EOF'
Usage: codex-corpus-research-status.sh [run-dir]

Without a run-dir, the most recent Codex corpus-research run is used.
EOF
  exit 1
}

if [[ $# -gt 1 ]]; then
  usage
fi

if [[ $# -eq 1 && ( "$1" == "--help" || "$1" == "-h" ) ]]; then
  usage
fi

if [[ $# -eq 1 ]]; then
  run_dir="$1"
else
  run_dir="$(find "$RUN_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | tail -n1)"
fi

[[ -n "${run_dir:-}" && -d "$run_dir" ]] || { echo "No Codex corpus-research run directory found" >&2; exit 1; }

echo "run_dir=$run_dir"

if [[ -f "$run_dir/status.json" ]]; then
  echo "--- status.json ---"
  cat "$run_dir/status.json"
fi

if [[ -f "$run_dir/pricing-summary.json" ]]; then
  echo "--- pricing-summary.json ---"
  cat "$run_dir/pricing-summary.json"
fi

python3 - "$run_dir" <<'PY'
from pathlib import Path
import json
import sys

run_dir = Path(sys.argv[1])
chunks = []
for chunk_dir in sorted((run_dir / "chunks").glob("chunk-*")):
    status_path = chunk_dir / "status.json"
    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
    except Exception:
        status = {}
    chunks.append({
        "chunk_id": chunk_dir.name,
        "state": status.get("state"),
        "exit_code": status.get("exit_code"),
        "scope_file_count": status.get("scope_file_count"),
        "artifact_file_count": status.get("artifact_file_count"),
        "estimated_openai_cost_usd": status.get("estimated_openai_cost_usd"),
    })

print("--- chunk summary ---")
for chunk in chunks:
    print(json.dumps(chunk, sort_keys=True))

books = []
for book_dir in sorted((run_dir / "books").glob("book-*")):
    status_path = book_dir / "status.json"
    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
    except Exception:
        status = {}
    books.append({
        "book_id": book_dir.name,
        "state": status.get("state"),
        "exit_code": status.get("exit_code"),
        "artifact_file_count": status.get("artifact_file_count"),
        "estimated_openai_cost_usd": status.get("estimated_openai_cost_usd"),
    })

print("--- book summary ---")
for book in books:
    print(json.dumps(book, sort_keys=True))

consolidator_status = run_dir / "consolidator" / "status.json"
if consolidator_status.exists():
    try:
        payload = json.loads(consolidator_status.read_text(encoding="utf-8"))
    except Exception:
        payload = {}
    print("--- consolidator ---")
    print(json.dumps(payload, indent=2, sort_keys=True))
PY

for path in \
  "$run_dir/heartbeat.log" \
  "$run_dir/launcher.log" \
  "$run_dir/manager.stdout.log" \
  "$run_dir/manager.stderr.log"
do
  if [[ -f "$path" ]]; then
    echo "--- $(basename "$path") tail ---"
    tail -n "$TAIL_LINES" "$path"
  fi
done
