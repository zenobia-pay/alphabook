#!/usr/bin/env bash
set -euo pipefail

PRECOMPUTED_INDEX_DIR="${PRECOMPUTED_INDEX_DIR:-}"
OUTPUT_DIR=""

usage() {
  cat >&2 <<'EOF'
Usage: prepare-text-corpus-manifest.sh --output-dir /path/to/run/prepared --precomputed-index-dir /srv/alphabook/...

Copies a precomputed canonical text manifest into a run-local prepared directory.
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
    --precomputed-index-dir)
      [[ $# -ge 2 ]] || usage
      PRECOMPUTED_INDEX_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$OUTPUT_DIR" ]] || usage
[[ -n "$PRECOMPUTED_INDEX_DIR" ]] || { echo "--precomputed-index-dir is required; raw corpus walking is no longer supported here." >&2; exit 1; }
mkdir -p "$OUTPUT_DIR"

TSV_PATH="$OUTPUT_DIR/all-text-files.tsv"
MANIFEST_PATH="$OUTPUT_DIR/manifest.json"
PRECOMPUTED_TSV="$PRECOMPUTED_INDEX_DIR/all-text-files.tsv"
PRECOMPUTED_MANIFEST="$PRECOMPUTED_INDEX_DIR/manifest.json"
[[ -f "$PRECOMPUTED_TSV" ]] || { echo "Missing precomputed TSV: $PRECOMPUTED_TSV" >&2; exit 1; }
cp "$PRECOMPUTED_TSV" "$TSV_PATH"
python3 - "$PRECOMPUTED_MANIFEST" "$MANIFEST_PATH" "$TSV_PATH" "$PRECOMPUTED_INDEX_DIR" <<'PY'
from pathlib import Path
import json
import sys

precomputed_manifest = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
tsv_path = Path(sys.argv[3])
index_dir = Path(sys.argv[4])

payload = {}
if precomputed_manifest.exists():
    payload = json.loads(precomputed_manifest.read_text(encoding="utf-8"))
payload["prepared_from"] = str(index_dir)
payload["tsv_path"] = str(tsv_path)
payload["source"] = "precomputed-index"
manifest_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

echo "$OUTPUT_DIR"
