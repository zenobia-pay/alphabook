#!/usr/bin/env bash
set -euo pipefail

FILE_LIST=""
OUTPUT_DIR=""
PATTERN=""
BATCH_SIZE="${BATCH_SIZE:-500}"
RESUME_MODE="auto"
MAX_BATCH_SIZE="${MAX_BATCH_SIZE:-500}"
MAX_TOTAL_FILES="${MAX_TOTAL_FILES:-0}"

usage() {
  cat >&2 <<'EOF'
Usage: run-ripgrep-progress.sh --file-list /path/to/scope-files.tsv --pattern '<regex>' --output-dir /path/to/run/search [--batch-size 500] [--resume auto|always|never] [--max-total-files 5000]

The file list must be TSV: size_bytes<TAB>absolute_path
An optional header row `size_bytes<TAB>absolute_path` is ignored.
Outputs:
  - rg_hits.jsonl
  - ripgrep-progress.jsonl
  - ripgrep-status.json
  - ripgrep.log
  - batches/batch-*.files.tsv
  - batches/batch-*.matches.jsonl
  - batches/batch-*.meta.json

The helper is resumable. Existing completed batches are reused unless --resume never is set.
The maximum supported ripgrep batch size is 500 files per invocation.
Use --max-total-files to enforce a cap on the overall helper input size.
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
    --resume)
      [[ $# -ge 2 ]] || usage
      RESUME_MODE="$2"
      shift 2
      ;;
    --max-total-files)
      [[ $# -ge 2 ]] || usage
      MAX_TOTAL_FILES="$2"
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
[[ "$RESUME_MODE" =~ ^(auto|always|never)$ ]] || { echo "Invalid --resume value: $RESUME_MODE" >&2; exit 1; }
[[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || { echo "Invalid --batch-size value: $BATCH_SIZE" >&2; exit 1; }
[[ "$MAX_BATCH_SIZE" =~ ^[0-9]+$ ]] || { echo "Invalid MAX_BATCH_SIZE value: $MAX_BATCH_SIZE" >&2; exit 1; }
[[ "$MAX_TOTAL_FILES" =~ ^[0-9]+$ ]] || { echo "Invalid --max-total-files value: $MAX_TOTAL_FILES" >&2; exit 1; }
(( BATCH_SIZE > 0 )) || { echo "Invalid --batch-size value: $BATCH_SIZE" >&2; exit 1; }
(( MAX_BATCH_SIZE > 0 )) || { echo "Invalid MAX_BATCH_SIZE value: $MAX_BATCH_SIZE" >&2; exit 1; }
(( MAX_TOTAL_FILES >= 0 )) || { echo "Invalid --max-total-files value: $MAX_TOTAL_FILES" >&2; exit 1; }
if (( BATCH_SIZE > MAX_BATCH_SIZE )); then
  echo "Bound it to a maximum of ${MAX_BATCH_SIZE} books in the corpus." >&2
  exit 1
fi
mkdir -p "$OUTPUT_DIR/batches"

HITS_PATH="$OUTPUT_DIR/rg_hits.jsonl"
PROGRESS_PATH="$OUTPUT_DIR/ripgrep-progress.jsonl"
STATUS_PATH="$OUTPUT_DIR/ripgrep-status.json"
LOG_PATH="$OUTPUT_DIR/ripgrep.log"

if [[ "$RESUME_MODE" == "never" ]]; then
  rm -f "$HITS_PATH" "$PROGRESS_PATH" "$STATUS_PATH" "$LOG_PATH"
  rm -rf "$OUTPUT_DIR/batches"
  mkdir -p "$OUTPUT_DIR/batches"
fi

touch "$HITS_PATH" "$PROGRESS_PATH" "$LOG_PATH"

total_files="$(
  awk -F '\t' '
    NF >= 2 && $1 ~ /^[0-9]+$/ && $2 != "absolute_path" { count += 1 }
    END { print count + 0 }
  ' "$FILE_LIST"
)"
if (( MAX_TOTAL_FILES > 0 && total_files > MAX_TOTAL_FILES )); then
  echo "Bound it to a maximum of ${MAX_TOTAL_FILES} books in the corpus." >&2
  exit 1
fi
total_bytes="$(
  awk -F '\t' '
    NF >= 2 && $1 ~ /^[0-9]+$/ && $2 != "absolute_path" { bytes += $1 }
    END { print bytes + 0 }
  ' "$FILE_LIST"
)"
total_batches="$(
  python3 - "$total_files" "$BATCH_SIZE" <<'PY'
import math
import sys
total_files = int(sys.argv[1])
batch_size = int(sys.argv[2])
print(math.ceil(total_files / batch_size) if total_files else 0)
PY
)"

python3 - "$FILE_LIST" "$OUTPUT_DIR/batches" "$BATCH_SIZE" <<'PY'
from pathlib import Path
import sys

file_list = Path(sys.argv[1])
batches_dir = Path(sys.argv[2])
batch_size = int(sys.argv[3])

rows = []
batch_index = 0
for raw_line in file_list.read_text(encoding="utf-8").splitlines():
    if not raw_line.strip():
        continue
    parts = raw_line.split("\t", 1)
    if len(parts) != 2:
        continue
    size_text, absolute_path = parts
    if size_text == "size_bytes" and absolute_path == "absolute_path":
        continue
    if not size_text.isdigit():
        continue
    rows.append(raw_line)
    if len(rows) >= batch_size:
        batch_index += 1
        (batches_dir / f"batch-{batch_index:05d}.files.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")
        rows = []
if rows:
    batch_index += 1
    (batches_dir / f"batch-{batch_index:05d}.files.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")
PY

python3 - "$STATUS_PATH" "$FILE_LIST" "$PATTERN" "$total_files" "$total_bytes" "$total_batches" "$BATCH_SIZE" "$RESUME_MODE" <<'PY'
from pathlib import Path
import json
import sys

status_path = Path(sys.argv[1])
payload = {
    "phase": "ripgrep",
    "file_list": sys.argv[2],
    "pattern": sys.argv[3],
    "total_files": int(sys.argv[4]),
    "total_bytes": int(sys.argv[5]),
    "total_batches": int(sys.argv[6]),
    "batch_size": int(sys.argv[7]),
    "resume_mode": sys.argv[8],
    "completed_batches": 0,
    "completed_files": 0,
    "completed_bytes": 0,
    "file_progress_pct": 0.0,
    "byte_progress_pct": 0.0,
    "rg_hits_lines": 0,
    "state": "running",
}
if status_path.exists():
    try:
        existing = json.loads(status_path.read_text(encoding="utf-8"))
        payload.update({k: v for k, v in existing.items() if k not in {"state", "resume_mode"}})
    except Exception:
        pass
payload["state"] = "running"
payload["resume_mode"] = sys.argv[8]
status_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

rebuild_hits_file() {
  python3 - "$OUTPUT_DIR/batches" "$HITS_PATH" <<'PY'
from pathlib import Path
import json
import sys

batches_dir = Path(sys.argv[1])
hits_path = Path(sys.argv[2])
with hits_path.open("w", encoding="utf-8") as output:
    for match_file in sorted(batches_dir.glob("batch-*.matches.jsonl")):
        for raw_line in match_file.read_text(encoding="utf-8").splitlines():
            if not raw_line.strip():
                continue
            try:
                payload = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if payload.get("type") == "match":
                output.write(raw_line + "\n")
PY
}

summarize_existing_progress() {
  python3 - "$OUTPUT_DIR/batches" "$STATUS_PATH" "$PROGRESS_PATH" "$total_files" "$total_bytes" <<'PY'
from pathlib import Path
import json
import sys
from datetime import datetime, timezone

batches_dir = Path(sys.argv[1])
status_path = Path(sys.argv[2])
progress_path = Path(sys.argv[3])
total_files = int(sys.argv[4])
total_bytes = int(sys.argv[5])

completed_batches = 0
completed_files = 0
completed_bytes = 0
rg_hits_lines = 0
last_meta = None

for meta_path in sorted(batches_dir.glob("batch-*.meta.json")):
    try:
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        continue
    if payload.get("state") != "completed":
        continue
    completed_batches += 1
    completed_files += int(payload.get("batch_files", 0))
    completed_bytes += int(payload.get("batch_bytes", 0))
    rg_hits_lines += int(payload.get("batch_lines", 0))
    last_meta = payload

file_pct = round((completed_files / total_files) * 100, 4) if total_files else 100.0
byte_pct = round((completed_bytes / total_bytes) * 100, 4) if total_bytes else 100.0
status = json.loads(status_path.read_text(encoding="utf-8"))
status.update({
    "completed_batches": completed_batches,
    "completed_files": completed_files,
    "completed_bytes": completed_bytes,
    "file_progress_pct": file_pct,
    "byte_progress_pct": byte_pct,
    "rg_hits_lines": rg_hits_lines,
})
status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")

if completed_batches > 0:
    progress = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "batch_index": completed_batches,
        "total_batches": status.get("total_batches"),
        "completed_files": completed_files,
        "total_files": total_files,
        "completed_bytes": completed_bytes,
        "total_bytes": total_bytes,
        "batch_lines": last_meta.get("batch_lines", 0) if last_meta else 0,
        "rg_hits_lines": rg_hits_lines,
        "batch_seconds": last_meta.get("batch_seconds", 0) if last_meta else 0,
        "file_progress_pct": file_pct,
        "byte_progress_pct": byte_pct,
        "batch_output": last_meta.get("batch_output") if last_meta else None,
        "resumed": True,
    }
    with progress_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(progress) + "\n")
PY
}

should_resume=1
if [[ "$RESUME_MODE" == "never" ]]; then
  should_resume=0
fi

if [[ "$should_resume" -eq 1 ]]; then
  rebuild_hits_file
  summarize_existing_progress
fi

files_done="$(python3 - "$STATUS_PATH" <<'PY'
from pathlib import Path
import json
import sys
status = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(status.get("completed_files", 0))
PY
)"
bytes_done="$(python3 - "$STATUS_PATH" <<'PY'
from pathlib import Path
import json
import sys
status = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(status.get("completed_bytes", 0))
PY
)"
completed_batches="$(python3 - "$STATUS_PATH" <<'PY'
from pathlib import Path
import json
import sys
status = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(status.get("completed_batches", 0))
PY
)"
total_hit_lines="$(python3 - "$STATUS_PATH" <<'PY'
from pathlib import Path
import json
import sys
status = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(status.get("rg_hits_lines", 0))
PY
)"

run_batch() {
  local batch_files_path="$1"
  local batch_index="$2"

  local batch_match_path="$OUTPUT_DIR/batches/batch-$(printf '%05d' "$batch_index").matches.jsonl"
  local batch_meta_path="$OUTPUT_DIR/batches/batch-$(printf '%05d' "$batch_index").meta.json"

  if [[ "$should_resume" -eq 1 && -f "$batch_meta_path" ]]; then
    local existing_state
    existing_state="$(python3 - "$batch_meta_path" <<'PY'
from pathlib import Path
import json
import sys
try:
    print(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")).get("state", ""))
except Exception:
    print("")
PY
)"
    if [[ "$existing_state" == "completed" ]]; then
      return 0
    fi
  fi

  local batch_count batch_bytes batch_start batch_end batch_seconds batch_lines file_pct byte_pct
  batch_count="$(wc -l < "$batch_files_path" | tr -d ' ')"
  batch_bytes="$(awk -F '\t' '{s+=$1} END {print s+0}' "$batch_files_path")"
  batch_start="$(date +%s)"

  python3 - "$batch_meta_path" "$batch_index" "$batch_files_path" "$batch_count" "$batch_bytes" <<'PY'
from pathlib import Path
import json
import sys
payload = {
    "batch_index": int(sys.argv[2]),
    "batch_files_path": sys.argv[3],
    "batch_files": int(sys.argv[4]),
    "batch_bytes": int(sys.argv[5]),
    "state": "running",
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

  local batch_paths=()
  while IFS=$'\t' read -r _batch_size _batch_path; do
    [[ -n "${_batch_path:-}" ]] || continue
    batch_paths+=("$_batch_path")
  done < "$batch_files_path"
  if rg --json -n -i -S -e "$PATTERN" "${batch_paths[@]}" >"$batch_match_path"; then
    true
  else
    rg_rc=$?
    if [[ "$rg_rc" -ne 1 ]]; then
      printf '%s batch=%s rg_exit=%s\n' "$(date -u +%FT%TZ)" "$batch_index" "$rg_rc" >>"$LOG_PATH"
      python3 - "$batch_meta_path" "$rg_rc" <<'PY'
from pathlib import Path
import json
import sys
payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
payload["state"] = "failed"
payload["rg_exit"] = int(sys.argv[2])
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
      return "$rg_rc"
    fi
  fi

  batch_lines="$(
    python3 - "$batch_match_path" <<'PY'
from pathlib import Path
import json
import sys
count = 0
for raw_line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    if not raw_line.strip():
        continue
    try:
        payload = json.loads(raw_line)
    except json.JSONDecodeError:
        continue
    if payload.get("type") == "match":
        count += 1
print(count)
PY
  )"
  python3 - "$batch_match_path" "$HITS_PATH" <<'PY'
from pathlib import Path
import json
import sys

match_path = Path(sys.argv[1])
hits_path = Path(sys.argv[2])
matches = []
for raw_line in match_path.read_text(encoding="utf-8").splitlines():
    if not raw_line.strip():
        continue
    try:
        payload = json.loads(raw_line)
    except json.JSONDecodeError:
        continue
    if payload.get("type") == "match":
        matches.append(raw_line)

if matches:
    with hits_path.open("a", encoding="utf-8") as output:
        output.write("\n".join(matches) + "\n")
PY

  files_done=$((files_done + batch_count))
  bytes_done=$((bytes_done + batch_bytes))
  total_hit_lines=$((total_hit_lines + batch_lines))
  completed_batches=$((completed_batches + 1))

  batch_end="$(date +%s)"
  batch_seconds=$((batch_end - batch_start))
  file_pct="$(
    python3 - "$files_done" "$total_files" <<'PY'
import sys
done = int(sys.argv[1]); total = int(sys.argv[2])
print(round((done / total) * 100, 4) if total else 100.0)
PY
  )"
  byte_pct="$(
    python3 - "$bytes_done" "$total_bytes" <<'PY'
import sys
done = int(sys.argv[1]); total = int(sys.argv[2])
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

  python3 - "$batch_meta_path" "$batch_lines" "$batch_seconds" "$batch_match_path" <<'PY'
from pathlib import Path
import json
import sys
payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
payload.update({
    "state": "completed",
    "batch_lines": int(sys.argv[2]),
    "batch_seconds": int(sys.argv[3]),
    "batch_output": sys.argv[4],
})
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

  python3 - "$PROGRESS_PATH" "$STATUS_PATH" "$batch_index" "$total_batches" "$files_done" "$total_files" "$bytes_done" "$total_bytes" "$batch_lines" "$total_hit_lines" "$batch_seconds" "$file_pct" "$byte_pct" "$batch_match_path" <<'PY'
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
with progress_path.open("a", encoding="utf-8") as f:
    f.write(json.dumps(progress) + "\n")
status = json.loads(status_path.read_text(encoding="utf-8"))
status.update({
    "completed_batches": progress["batch_index"],
    "completed_files": progress["completed_files"],
    "completed_bytes": progress["completed_bytes"],
    "file_progress_pct": progress["file_progress_pct"],
    "byte_progress_pct": progress["byte_progress_pct"],
    "rg_hits_lines": progress["rg_hits_lines"],
    "last_batch_seconds": progress["batch_seconds"],
    "last_batch_output": progress["batch_output"],
    "state": "running",
})
status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
PY
}

for batch_files_path in "$OUTPUT_DIR"/batches/batch-*.files.tsv; do
  [[ -f "$batch_files_path" ]] || continue
  batch_index="$(basename "$batch_files_path" .files.tsv | sed 's/^batch-//')"
  run_batch "$batch_files_path" "$((10#$batch_index))"
done

python3 - "$STATUS_PATH" <<'PY'
from pathlib import Path
import json
import sys
status_path = Path(sys.argv[1])
status = json.loads(status_path.read_text(encoding="utf-8"))
status["state"] = "completed"
status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
PY
