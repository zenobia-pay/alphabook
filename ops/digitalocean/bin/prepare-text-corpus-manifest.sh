#!/usr/bin/env bash
set -euo pipefail

CORPUS_ROOT="${CORPUS_ROOT:-/srv/alphabook/gutenberg}"
PRECOMPUTED_INDEX_DIR="${PRECOMPUTED_INDEX_DIR:-}"
OUTPUT_DIR=""

usage() {
  cat >&2 <<'EOF'
Usage: prepare-text-corpus-manifest.sh --output-dir /path/to/run/prepared [--corpus-root /srv/alphabook/gutenberg] [--precomputed-index-dir /srv/alphabook/...]

Builds a sorted text-only corpus manifest without copying corpus files.
Outputs:
  - all-text-files.tsv   size_bytes<TAB>absolute_path
  - manifest.json

If --precomputed-index-dir is provided, reuse all-text-files.tsv from that directory
instead of re-walking the corpus root.
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
[[ -d "$CORPUS_ROOT" ]] || { echo "Missing corpus root: $CORPUS_ROOT" >&2; exit 1; }
mkdir -p "$OUTPUT_DIR"

TSV_PATH="$OUTPUT_DIR/all-text-files.tsv"
MANIFEST_PATH="$OUTPUT_DIR/manifest.json"

if [[ -n "$PRECOMPUTED_INDEX_DIR" ]]; then
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
  exit 0
fi

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
