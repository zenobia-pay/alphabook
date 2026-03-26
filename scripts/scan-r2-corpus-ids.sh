#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars.codexrun}"
OUTPUT_IDS="${OUTPUT_IDS:-$ROOT_DIR/output/canonical-gutenberg-ids-r2.txt}"
OUTPUT_MISSING="${OUTPUT_MISSING:-$ROOT_DIR/output/canonical-gutenberg-ids-r2-missing-required.txt}"
OUTPUT_ORPHANED_COUNT="${OUTPUT_ORPHANED_COUNT:-$ROOT_DIR/output/r2-orphaned-key-count.txt}"

mkdir -p "$(dirname "$OUTPUT_IDS")"

eval "$(
  python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys

wanted = {"R2_BUCKET_NAME", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"}
for line in Path(sys.argv[1]).read_text().splitlines():
    if "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key in wanted:
        print(f"export {key}={value}")
PY
)"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
aws s3 ls "s3://$R2_BUCKET_NAME/gutenberg/" \
  --recursive \
  --endpoint-url "$R2_ENDPOINT" |
awk -v output_ids="$tmp_dir/ids.txt" \
    -v output_missing="$tmp_dir/missing.txt" \
    -v output_orphaned="$tmp_dir/orphaned.txt" '
{
  key = $4
  n = split(key, parts, "/")
  id = ""
  kind = ""

  if (parts[1] == "gutenberg" && parts[2] == "raw" && parts[3] ~ /^[0-9]+$/) {
    if (n == 4 && parts[4] == "raw.txt") kind = "raw"
    else if (n == 4 && parts[4] == "metadata.json") kind = "metadata"
    else if (n == 4 && parts[4] ~ /^cover\./) kind = "cover"
    if (kind != "") id = parts[3]
  } else if (parts[1] == "gutenberg" && parts[2] == "clean" && parts[3] ~ /^[0-9]+$/) {
    if (n == 4 && parts[4] == "clean.txt") kind = "clean"
    else if (n == 4 && parts[4] == "chunks.jsonl") kind = "chunks"
    else if (n == 4 && parts[4] == "book.html") kind = "book_html"
    else if (n == 5 && parts[4] == "book" && parts[5] == "manifest.json") kind = "book_manifest"
    else if (n == 6 && parts[4] == "book" && parts[5] == "pages" && parts[6] ~ /^page-[0-9]+\.html$/) kind = "book_page"
    if (kind != "") id = parts[3]
  }

  if (id == "") {
    orphaned += 1
    next
  }

  seen[id] = 1
  kinds[id, kind] = 1
}
END {
  for (id in seen) {
    if (kinds[id, "raw"] && kinds[id, "metadata"] && kinds[id, "clean"] && kinds[id, "chunks"] && kinds[id, "book_html"]) {
      print id >> output_ids
    } else {
      print id >> output_missing
    }
  }
  print orphaned + 0 > output_orphaned
}'

sort -n "$tmp_dir/ids.txt" > "$OUTPUT_IDS"
sort -n "$tmp_dir/missing.txt" > "$OUTPUT_MISSING"
cp "$tmp_dir/orphaned.txt" "$OUTPUT_ORPHANED_COUNT"

printf 'canonical=%s missing=%s orphaned=%s\n' \
  "$(wc -l < "$OUTPUT_IDS")" \
  "$(wc -l < "$OUTPUT_MISSING")" \
  "$(cat "$OUTPUT_ORPHANED_COUNT")"
