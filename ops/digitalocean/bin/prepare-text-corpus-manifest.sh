#!/usr/bin/env bash
set -euo pipefail

CORPUS_ROOT="${CORPUS_ROOT:-/srv/alphabook/gutenberg}"
OUTPUT_DIR=""

usage() {
  cat >&2 <<'EOF'
Usage: prepare-text-corpus-manifest.sh --output-dir /path/to/run/prepared [--corpus-root /srv/alphabook/gutenberg]

Builds a sorted text-only corpus manifest without copying corpus files.
Outputs:
  - all-text-files.tsv   size_bytes<TAB>absolute_path
  - manifest.json
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      [[ $# -ge 2 ]] || usage
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --corpus-root)
      [[ $# -ge 2 ]] || usage
      CORPUS_ROOT="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$OUTPUT_DIR" ]] || usage
[[ -d "$CORPUS_ROOT" ]] || { echo "Missing corpus root: $CORPUS_ROOT" >&2; exit 1; }
mkdir -p "$OUTPUT_DIR"

TSV_PATH="$OUTPUT_DIR/all-text-files.tsv"
MANIFEST_PATH="$OUTPUT_DIR/manifest.json"

python3 - "$CORPUS_ROOT" "$TSV_PATH" "$MANIFEST_PATH" <<'PY'
from pathlib import Path
import json
import sys

corpus_root = Path(sys.argv[1])
tsv_path = Path(sys.argv[2])
manifest_path = Path(sys.argv[3])

paths = sorted(corpus_root.rglob("*.txt"))
total_bytes = 0
rows = []
for path in paths:
    try:
        size = path.stat().st_size
    except OSError:
        continue
    total_bytes += size
    rows.append(f"{size}\t{path}\n")

tsv_path.write_text("".join(rows))
manifest = {
    "corpus_root": str(corpus_root),
    "file_type": "raw-text-only",
    "total_files": len(rows),
    "total_bytes": total_bytes,
    "tsv_path": str(tsv_path),
}
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
PY

echo "$OUTPUT_DIR"
