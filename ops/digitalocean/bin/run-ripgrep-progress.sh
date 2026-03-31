#!/usr/bin/env bash
set -euo pipefail

FILE_LIST=""
OUTPUT_DIR=""
PATTERN=""
BATCH_SIZE="${BATCH_SIZE:-500}"

usage() {
  cat >&2 <<'EOF'
Usage: run-ripgrep-progress.sh --file-list /path/to/scope-files.tsv --pattern '<regex>' --output-dir /path/to/run/search [--batch-size 500]

The file list must be TSV: size_bytes<TAB>absolute_path
Outputs:
  - rg_hits.jsonl
  - ripgrep-progress.jsonl
  - ripgrep-status.json
  - ripgrep.log
  - batches/batch-*.jsonl
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file-list)
      [[ $# -ge 2 ]] || usage
      FILE_LIST="$2"
      shift 2
      ;;
    --pattern)
      [[ $# -ge 2 ]] || usage
      PATTERN="$2"
      shift 2
      ;;
    --output-dir)
      [[ $# -ge 2 ]] || usage
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --batch-size)
      [[ $# -ge 2 ]] || usage
      BATCH_SIZE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$FILE_LIST" && -n "$PATTERN" && -n "$OUTPUT_DIR" ]] || usage
[[ -f "$FILE_LIST" ]] || { echo "Missing file list: $FILE_LIST" >&2; exit 1; }
mkdir -p "$OUTPUT_DIR/batches"

HITS_PATH="$OUTPUT_DIR/rg_hits.jsonl"
PROGRESS_PATH="$OUTPUT_DIR/ripgrep-progress.jsonl"
STATUS_PATH="$OUTPUT_DIR/ripgrep-status.json"
LOG_PATH="$OUTPUT_DIR/ripgrep.log"
: >"$HITS_PATH"
: >"$PROGRESS_PATH"
: >"$LOG_PATH"

total_files="$(wc -l < "$FILE_LIST" | tr -d ' ')"
total_bytes="$(awk -F '\t' '{s+=$1} END {print s+0}' "$FILE_LIST")"
total_batches="$(
  python3 - "$total_files" "$BATCH_SIZE" <<'PY'
import math
import sys
total_files = int(sys.argv[1])
batch_size = int(sys.argv[2])
print(math.ceil(total_files / batch_size) if total_files else 0)
PY
)"

python3 - "$STATUS_PATH" "$FILE_LIST" "$PATTERN" "$total_files" "$total_bytes" "$total_batches" "$BATCH_SIZE" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "phase": "ripgrep",
    "file_list": sys.argv[2],
    "pattern": sys.argv[3],
    "total_files": int(sys.argv[4]),
    "total_bytes": int(sys.argv[5]),
    "total_batches": int(sys.argv[6]),
    "batch_size": int(sys.argv[7]),
    "completed_batches": 0,
    "completed_files": 0,
    "completed_bytes": 0,
    "file_progress_pct": 0.0,
    "byte_progress_pct": 0.0,
    "rg_hits_lines": 0,
    "state": "running",
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n")
PY

declare -a batch_paths=()
batch_bytes=0
files_done=0
bytes_done=0
batch_index=0
total_hit_lines=0

run_batch() {
  local batch_count="$1"
  [[ "$batch_count" -gt 0 ]] || return 0

  batch_index=$((batch_index + 1))
  local batch_out="$OUTPUT_DIR/batches/batch-$(printf '%05d' "$batch_index").jsonl"
  local batch_start batch_end batch_seconds batch_lines file_pct byte_pct
  batch_start="$(date +%s)"

  if rg --json -n -i -S -e "$PATTERN" "${batch_paths[@]}" >"$batch_out"; then
    true
  else
    rg_rc=$?
    if [[ "$rg_rc" -ne 1 ]]; then
      echo "batch=$batch_index rg_exit=$rg_rc" >>"$LOG_PATH"
      return "$rg_rc"
    fi
  fi

  cat "$batch_out" >>"$HITS_PATH"
  batch_lines="$(wc -l < "$batch_out" | tr -d ' ')"
  total_hit_lines=$((total_hit_lines + batch_lines))
  files_done=$((files_done + batch_count))
  bytes_done=$((bytes_done + batch_bytes))

  batch_end="$(date +%s)"
  batch_seconds=$((batch_end - batch_start))
  file_pct="$(
    python3 - "$files_done" "$total_files" <<'PY'
import sys
done = int(sys.argv[1])
total = int(sys.argv[2])
print(round((done / total) * 100, 4) if total else 100.0)
PY
  )"
  byte_pct="$(
    python3 - "$bytes_done" "$total_bytes" <<'PY'
import sys
done = int(sys.argv[1])
total = int(sys.argv[2])
print(round((done / total) * 100, 4) if total else 100.0)
PY
  )"

  printf '%s batch=%s/%s files=%s/%s file_pct=%s bytes=%s/%s byte_pct=%s batch_lines=%s total_lines=%s batch_seconds=%s\n' \
    "$(date -u +%FT%TZ)" \
    "$batch_index" \
    "$total_batches" \
    "$files_done" \
    "$total_files" \
    "$file_pct" \
    "$bytes_done" \
    "$total_bytes" \
    "$byte_pct" \
    "$batch_lines" \
    "$total_hit_lines" \
    "$batch_seconds" >>"$LOG_PATH"

  python3 - "$PROGRESS_PATH" "$STATUS_PATH" "$batch_index" "$total_batches" "$files_done" "$total_files" "$bytes_done" "$total_bytes" "$batch_lines" "$total_hit_lines" "$batch_seconds" "$file_pct" "$byte_pct" "$batch_out" <<'PY'
from pathlib import Path
import json
import sys
from datetime import datetime, timezone

progress = {
    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "batch_index": int(sys.argv[3]),
    "total_batches": int(sys.argv[4]),
    "completed_files": int(sys.argv[5]),
    "total_files": int(sys.argv[6]),
    "completed_bytes": int(sys.argv[7]),
    "total_bytes": int(sys.argv[8]),
    "batch_lines": int(sys.argv[9]),
    "rg_hits_lines": int(sys.argv[10]),
    "batch_seconds": int(sys.argv[11]),
    "file_progress_pct": float(sys.argv[12]),
    "byte_progress_pct": float(sys.argv[13]),
    "batch_output": sys.argv[14],
}
progress_path = Path(sys.argv[1])
status_path = Path(sys.argv[2])
with progress_path.open("a") as f:
    f.write(json.dumps(progress) + "\n")
status = json.loads(status_path.read_text())
status.update({
    "completed_batches": progress["batch_index"],
    "completed_files": progress["completed_files"],
    "completed_bytes": progress["completed_bytes"],
    "file_progress_pct": progress["file_progress_pct"],
    "byte_progress_pct": progress["byte_progress_pct"],
    "rg_hits_lines": progress["rg_hits_lines"],
    "last_batch_seconds": progress["batch_seconds"],
    "last_batch_output": progress["batch_output"],
})
status_path.write_text(json.dumps(status, indent=2) + "\n")
PY

  batch_paths=()
  batch_bytes=0
}

batch_count=0
while IFS=$'\t' read -r size path; do
  [[ -n "${path:-}" ]] || continue
  batch_paths+=("$path")
  batch_bytes=$((batch_bytes + size))
  batch_count=$((batch_count + 1))
  if [[ "$batch_count" -ge "$BATCH_SIZE" ]]; then
    run_batch "$batch_count"
    batch_count=0
  fi
done <"$FILE_LIST"

run_batch "$batch_count"

python3 - "$STATUS_PATH" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["state"] = "completed"
path.write_text(json.dumps(data, indent=2) + "\n")
PY
