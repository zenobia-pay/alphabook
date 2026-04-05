#!/usr/bin/env bash
set -euo pipefail

FILE_LIST=""
OUTPUT_DIR=""
MAX_FILES_PER_PARTITION="${MAX_FILES_PER_PARTITION:-5000}"

usage() {
  cat >&2 <<'EOF'
Usage: partition-file-list.sh --file-list /path/to/scoped-files.tsv --output-dir /path/to/partitions [--max-files 5000]

Input must be TSV: size_bytes<TAB>absolute_path
An optional header row `size_bytes<TAB>absolute_path` is ignored.

Outputs:
  - part-00001.files.tsv
  - part-00002.files.tsv
  - ...
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
    --output-dir)
      [[ $# -ge 2 ]] || usage
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --max-files)
      [[ $# -ge 2 ]] || usage
      MAX_FILES_PER_PARTITION="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$FILE_LIST" && -n "$OUTPUT_DIR" ]] || usage
[[ -f "$FILE_LIST" ]] || { echo "Missing file list: $FILE_LIST" >&2; exit 1; }
[[ "$MAX_FILES_PER_PARTITION" =~ ^[0-9]+$ ]] || { echo "Invalid --max-files value: $MAX_FILES_PER_PARTITION" >&2; exit 1; }
(( MAX_FILES_PER_PARTITION > 0 )) || { echo "Invalid --max-files value: $MAX_FILES_PER_PARTITION" >&2; exit 1; }

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

python3 - "$FILE_LIST" "$OUTPUT_DIR" "$MAX_FILES_PER_PARTITION" <<'PY'
from pathlib import Path
import sys

file_list = Path(sys.argv[1])
output_dir = Path(sys.argv[2])
max_files = int(sys.argv[3])

rows = []
part_index = 0

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
    if len(rows) >= max_files:
        part_index += 1
        (output_dir / f"part-{part_index:05d}.files.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")
        rows = []

if rows:
    part_index += 1
    (output_dir / f"part-{part_index:05d}.files.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")

print(part_index)
PY
