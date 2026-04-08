#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
RUN_ROOT="${RUN_ROOT:-/srv/alphabook/logs/codex-corpus-research}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
FALLBACK_ENV_FILE="${FALLBACK_ENV_FILE:-/srv/alphabook/.ingest.env}"
CORPUS_ROOT="${CORPUS_ROOT:-/srv/alphabook/gutenberg}"
PRECOMPUTED_INDEX_DIR="${PRECOMPUTED_INDEX_DIR:-}"
MODEL="${MODEL:-gpt-5.4}"
CHUNK_SIZE="${CHUNK_SIZE:-5000}"
MAX_PARALLEL="${MAX_PARALLEL:-5}"
HEARTBEAT_SECONDS="${HEARTBEAT_SECONDS:-15}"
USER_PROMPT=""
USER_PROMPT_FILE=""

usage() {
  cat >&2 <<'EOF'
Usage: run-codex-corpus-research.sh --user-prompt "Find me all the different ways that authors deal with grief in 19th century literature."

Options:
  --user-prompt TEXT       User research request to shard across Codex runs.
  --user-prompt-file PATH  Read the user research request from a file.
  --model NAME             Override Codex model. Default: gpt-5.4
  --run-root PATH          Output root. Default: /srv/alphabook/logs/codex-corpus-research
  --corpus-root PATH       Corpus root. Default: /srv/alphabook/gutenberg
  --precomputed-index-dir PATH
                           Reusable text manifest dir. Defaults to <corpus-root>/research-corpus-index
                           or <corpus-root> when it already contains all-text-files.tsv.
  --root-dir PATH          Repo root. Default: /srv/alphabook/repo
  --chunk-size N           Files per Codex shard. Default: 5000
  --max-parallel N         Concurrent Codex shards. Must be between 5 and 10. Default: 5
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      ;;
    --user-prompt)
      USER_PROMPT="$2"
      shift 2
      ;;
    --user-prompt-file)
      USER_PROMPT_FILE="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --run-root)
      RUN_ROOT="$2"
      shift 2
      ;;
    --corpus-root)
      CORPUS_ROOT="$2"
      shift 2
      ;;
    --precomputed-index-dir)
      PRECOMPUTED_INDEX_DIR="$2"
      shift 2
      ;;
    --root-dir)
      ROOT_DIR="$2"
      shift 2
      ;;
    --chunk-size)
      CHUNK_SIZE="$2"
      shift 2
      ;;
    --max-parallel)
      MAX_PARALLEL="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

resolve_precomputed_index_dir() {
  local corpus_root="$1"
  local explicit_dir="${2:-}"
  if [[ -n "$explicit_dir" ]]; then
    printf '%s\n' "$explicit_dir"
    return 0
  fi
  if [[ -f "$corpus_root/all-text-files.tsv" ]]; then
    printf '%s\n' "$corpus_root"
    return 0
  fi
  printf '%s\n' "$corpus_root/research-corpus-index"
}

load_env_value() {
  local source_file="$1"
  local key="$2"
  python3 - "$source_file" "$key" <<'PY'
from pathlib import Path
import sys
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    if line.startswith(sys.argv[2] + "="):
        value = line.split("=", 1)[1].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        print(value)
        break
PY
}

[[ -d "$ROOT_DIR" ]] || { echo "Missing repo root: $ROOT_DIR" >&2; exit 1; }
[[ "$CHUNK_SIZE" =~ ^[0-9]+$ ]] || { echo "Invalid --chunk-size value: $CHUNK_SIZE" >&2; exit 1; }
[[ "$MAX_PARALLEL" =~ ^[0-9]+$ ]] || { echo "Invalid --max-parallel value: $MAX_PARALLEL" >&2; exit 1; }
(( CHUNK_SIZE > 0 )) || { echo "Invalid --chunk-size value: $CHUNK_SIZE" >&2; exit 1; }
(( MAX_PARALLEL >= 5 && MAX_PARALLEL <= 10 )) || { echo "--max-parallel must be between 5 and 10" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "Missing codex CLI on PATH" >&2; exit 1; }

if [[ -z "$USER_PROMPT" && -z "$USER_PROMPT_FILE" ]]; then
  usage
fi
if [[ -n "$USER_PROMPT_FILE" ]]; then
  [[ -f "$USER_PROMPT_FILE" ]] || { echo "Missing user prompt file: $USER_PROMPT_FILE" >&2; exit 1; }
fi

PRECOMPUTED_INDEX_DIR="$(resolve_precomputed_index_dir "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR")"
[[ -f "$PRECOMPUTED_INDEX_DIR/all-text-files.tsv" ]] || {
  echo "Missing precomputed text manifest: $PRECOMPUTED_INDEX_DIR/all-text-files.tsv" >&2
  exit 1
}

if [[ -f "$ENV_FILE" ]]; then
  export OPENAI_API_KEY="${OPENAI_API_KEY:-$(load_env_value "$ENV_FILE" "OPENAI_API_KEY")}"
  export R2_BUCKET_NAME="${R2_BUCKET_NAME:-$(load_env_value "$ENV_FILE" "R2_BUCKET_NAME")}"
  export R2_ENDPOINT="${R2_ENDPOINT:-$(load_env_value "$ENV_FILE" "R2_ENDPOINT")}"
  export R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-$(load_env_value "$ENV_FILE" "R2_ACCESS_KEY_ID")}"
  export R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-$(load_env_value "$ENV_FILE" "R2_SECRET_ACCESS_KEY")}"
  export QDRANT_URL="${QDRANT_URL:-$(load_env_value "$ENV_FILE" "QDRANT_URL")}"
  export QDRANT_API_KEY="${QDRANT_API_KEY:-$(load_env_value "$ENV_FILE" "QDRANT_API_KEY")}"
  export QDRANT_COLLECTION="${QDRANT_COLLECTION:-$(load_env_value "$ENV_FILE" "QDRANT_COLLECTION")}"
fi
if [[ -f "$FALLBACK_ENV_FILE" ]]; then
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    export OPENAI_API_KEY="$(load_env_value "$FALLBACK_ENV_FILE" "OPENAI_API_KEY")"
  fi
  export R2_BUCKET_NAME="${R2_BUCKET_NAME:-$(load_env_value "$FALLBACK_ENV_FILE" "R2_BUCKET_NAME")}"
  export R2_ENDPOINT="${R2_ENDPOINT:-$(load_env_value "$FALLBACK_ENV_FILE" "R2_ENDPOINT")}"
  export R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-$(load_env_value "$FALLBACK_ENV_FILE" "R2_ACCESS_KEY_ID")}"
  export R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-$(load_env_value "$FALLBACK_ENV_FILE" "R2_SECRET_ACCESS_KEY")}"
  export QDRANT_URL="${QDRANT_URL:-$(load_env_value "$FALLBACK_ENV_FILE" "QDRANT_URL")}"
  export QDRANT_API_KEY="${QDRANT_API_KEY:-$(load_env_value "$FALLBACK_ENV_FILE" "QDRANT_API_KEY")}"
  export QDRANT_COLLECTION="${QDRANT_COLLECTION:-$(load_env_value "$FALLBACK_ENV_FILE" "QDRANT_COLLECTION")}"
fi
[[ -n "${OPENAI_API_KEY:-}" ]] || { echo "OPENAI_API_KEY is not available from $ENV_FILE or $FALLBACK_ENV_FILE" >&2; exit 1; }

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_id="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(4))
PY
)"
run_dir="$RUN_ROOT/$timestamp-$run_id"
mkdir -p "$run_dir"
job_id="$(basename "$run_dir")"
state_dir="$run_dir/state"
attempts_dir="$run_dir/attempts"
attempt_id="attempt-0001"
attempt_dir="$attempts_dir/$attempt_id"
logs_dir="$attempt_dir/logs"
runtime_dir="$attempt_dir/runtime"
mkdir -p "$state_dir" "$logs_dir" "$runtime_dir" "$run_dir/chunks" "$run_dir/consolidator"

prompt_file="$state_dir/prompt.txt"
status_file="$state_dir/status.json"
summary_file="$state_dir/summary.json"
partitions_file="$state_dir/partitions.json"
launcher_log="$logs_dir/launcher.log"
stdout_log="$logs_dir/manager.stdout.log"
stderr_log="$logs_dir/manager.stderr.log"
heartbeat_log="$logs_dir/heartbeat.log"
process_log="$logs_dir/process.log"
pid_file="$runtime_dir/manager.pid"
watcher_pid_file="$runtime_dir/heartbeat.pid"
index_file="$run_dir/index.json"

ln -sfn "state/prompt.txt" "$run_dir/prompt.txt"
ln -sfn "state/status.json" "$run_dir/status.json"
ln -sfn "state/summary.json" "$run_dir/summary.json"
ln -sfn "state/partitions.json" "$run_dir/partitions.json"
ln -sfn "attempts/$attempt_id/logs/launcher.log" "$run_dir/launcher.log"
ln -sfn "attempts/$attempt_id/logs/manager.stdout.log" "$run_dir/manager.stdout.log"
ln -sfn "attempts/$attempt_id/logs/manager.stderr.log" "$run_dir/manager.stderr.log"
ln -sfn "attempts/$attempt_id/logs/heartbeat.log" "$run_dir/heartbeat.log"
ln -sfn "attempts/$attempt_id/logs/process.log" "$run_dir/process.log"
ln -sfn "attempts/$attempt_id/runtime/manager.pid" "$run_dir/manager.pid"
ln -sfn "attempts/$attempt_id/runtime/heartbeat.pid" "$run_dir/heartbeat.pid"
ln -sfn "attempts/$attempt_id" "$run_dir/current-attempt"
ln -sfn "consolidator/artifacts/consolidated-briefing.md" "$run_dir/consolidated-briefing.md"
ln -sfn "consolidator/artifacts/consolidated-summary.json" "$run_dir/consolidated-summary.json"
ln -sfn "consolidator/artifacts/consolidated-citation-index.json" "$run_dir/consolidated-citation-index.json"

if [[ -n "$USER_PROMPT_FILE" ]]; then
  cp "$USER_PROMPT_FILE" "$prompt_file"
else
  printf '%s\n' "$USER_PROMPT" >"$prompt_file"
fi

partitions_dir="$run_dir/partitions"
"$ROOT_DIR/ops/digitalocean/bin/partition-file-list.sh" \
  --file-list "$PRECOMPUTED_INDEX_DIR/all-text-files.tsv" \
  --output-dir "$partitions_dir" \
  --max-files "$CHUNK_SIZE" >/dev/null

python3 - "$partitions_file" "$partitions_dir" "$CHUNK_SIZE" "$MAX_PARALLEL" <<'PY'
from pathlib import Path
import json
import sys

partitions_dir = Path(sys.argv[2])
entries = []
for path in sorted(partitions_dir.glob("part-*.files.tsv")):
    count = 0
    total_bytes = 0
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if not raw_line.strip():
            continue
        parts = raw_line.split("\t", 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        count += 1
        total_bytes += int(parts[0])
    entries.append({
        "partition_file": str(path),
        "partition_name": path.name,
        "file_count": count,
        "total_bytes": total_bytes,
    })
Path(sys.argv[1]).write_text(json.dumps({
    "chunk_size": int(sys.argv[3]),
    "max_parallel": int(sys.argv[4]),
    "partitions": entries,
}, indent=2) + "\n", encoding="utf-8")
PY

python3 - "$status_file" "$summary_file" "$timestamp" "$run_id" "$job_id" "$ROOT_DIR" "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR" "$MODEL" "$CHUNK_SIZE" "$MAX_PARALLEL" "$prompt_file" <<'PY'
from pathlib import Path
import json
import sys

prompt_text = Path(sys.argv[12]).read_text(encoding="utf-8")
payload = {
    "timestamp": sys.argv[3],
    "run_id": sys.argv[4],
    "job_id": sys.argv[5],
    "root_dir": sys.argv[6],
    "corpus_root": sys.argv[7],
    "precomputed_index_dir": sys.argv[8],
    "model": sys.argv[9],
    "chunk_size": int(sys.argv[10]),
    "max_parallel": int(sys.argv[11]),
    "user_prompt": prompt_text,
    "state": "launching",
    "run_dir": str(Path(sys.argv[1]).parent.parent),
    "state_dir": str(Path(sys.argv[1]).parent),
    "attempt_id": "attempt-0001",
    "attempt_dir": str(Path(sys.argv[1]).parent.parent / "attempts" / "attempt-0001"),
    "logs_dir": str(Path(sys.argv[1]).parent.parent / "attempts" / "attempt-0001" / "logs"),
    "runtime_dir": str(Path(sys.argv[1]).parent.parent / "attempts" / "attempt-0001" / "runtime"),
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
Path(sys.argv[2]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

python3 - "$run_dir" "$partitions_file" <<'PY'
from pathlib import Path
import json
import shutil
import sys

run_dir = Path(sys.argv[1])
partitions = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))["partitions"]
for index, partition in enumerate(partitions, start=1):
    chunk_name = f"chunk-{index:05d}"
    chunk_dir = run_dir / "chunks" / chunk_name
    chunk_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(partition["partition_file"], chunk_dir / "scope-files.tsv")
PY

python3 - "$run_dir" "$PRECOMPUTED_INDEX_DIR/metadata-table.jsonl" "$CHUNK_SIZE" <<'PY'
from pathlib import Path
import json
import sys

run_dir = Path(sys.argv[1])
metadata_path = Path(sys.argv[2])
chunk_size = int(sys.argv[3])

path_to_gutenberg: dict[str, str] = {}
for raw_line in metadata_path.read_text(encoding="utf-8").splitlines():
    raw_line = raw_line.strip()
    if not raw_line:
        continue
    row = json.loads(raw_line)
    gutenberg_id = str(row.get("gutenberg_id") or "").strip()
    if not gutenberg_id:
        continue
    for key in ("primary_text_path", "primary_text_link_path", "clean_path"):
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            path_to_gutenberg[value] = gutenberg_id

for index, chunk_dir in enumerate(sorted((run_dir / "chunks").glob("chunk-*")), start=1):
    corpus_chunk_id = f"corpus-files{chunk_size}-{index:05d}"
    source_file_map: dict[str, str] = {}
    gutenberg_ids: list[str] = []
    for raw_line in (chunk_dir / "scope-files.tsv").read_text(encoding="utf-8").splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        parts = raw_line.split("\t", 1)
        if len(parts) != 2:
            continue
        size_text, absolute_path = parts
        if size_text == "size_bytes" and absolute_path == "absolute_path":
            continue
        gutenberg_id = path_to_gutenberg.get(absolute_path)
        if gutenberg_id:
            source_file_map[absolute_path] = gutenberg_id
            gutenberg_ids.append(gutenberg_id)
    payload = {
        "chunk_id": chunk_dir.name,
        "corpus_chunk_id": corpus_chunk_id,
        "chunk_size": chunk_size,
        "gutenberg_ids": sorted(set(gutenberg_ids), key=lambda value: int(value)),
        "source_file_to_gutenberg_id": source_file_map,
    }
    (chunk_dir / "vector-scope.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    (chunk_dir / "corpus-chunk-id.txt").write_text(corpus_chunk_id + "\n", encoding="utf-8")
PY

cat >"$run_dir/run-codex-manager.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

chunk_runner="$ROOT_DIR/ops/digitalocean/bin/run-codex-corpus-research-chunk.sh"
book_runner="$ROOT_DIR/ops/digitalocean/bin/run-codex-corpus-research-book.sh"
consolidator_runner="$ROOT_DIR/ops/digitalocean/bin/run-codex-corpus-research-consolidator.sh"
materialize_script="$ROOT_DIR/ops/digitalocean/bin/materialize-codex-run-index.py"

log_line() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$1"
}

python3 - "$STATUS_FILE" "running" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
payload = json.loads(path.read_text(encoding="utf-8"))
payload["state"] = sys.argv[2]
payload["started_at"] = sys.argv[3]
payload["phase"] = "chunk_classification"
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

mapfile -t chunk_dirs < <(find "$RUN_DIR/chunks" -mindepth 1 -maxdepth 1 -type d | sort)
log_line "manager_start chunk_count=${#chunk_dirs[@]} max_parallel=$MAX_PARALLEL"

launch_chunk() {
  local chunk_dir="$1"
  local chunk_id
  chunk_id="$(basename "$chunk_dir")"
  local chunk_job_id="${JOB_ID}-${chunk_id}"
  log_line "launch_chunk chunk_id=$chunk_id job_id=$chunk_job_id"
  "$chunk_runner" \
    --run-dir "$RUN_DIR" \
    --chunk-dir "$chunk_dir" \
    --chunk-id "$chunk_id" \
    --job-id "$chunk_job_id" \
    --model "$MODEL" \
    --root-dir "$ROOT_DIR" \
    --user-prompt-file "$PROMPT_FILE" \
    --scope-file-list "$chunk_dir/scope-files.tsv" \
    --corpus-root "$CORPUS_ROOT" \
    --precomputed-index-dir "$PRECOMPUTED_INDEX_DIR" &
}

for chunk_dir in "${chunk_dirs[@]}"; do
  while (( $(jobs -pr | wc -l | tr -d ' ') >= MAX_PARALLEL )); do
    wait -n || true
    python3 "$materialize_script" --run-dir "$RUN_DIR" >/dev/null 2>&1 || true
  done
  launch_chunk "$chunk_dir"
done

while (( $(jobs -pr | wc -l | tr -d ' ') > 0 )); do
  wait -n || true
  python3 "$materialize_script" --run-dir "$RUN_DIR" >/dev/null 2>&1 || true
done

python3 "$materialize_script" --run-dir "$RUN_DIR" >/dev/null 2>&1 || true
python3 - "$STATUS_FILE" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
payload = json.loads(path.read_text(encoding="utf-8"))
payload["phase"] = "book_fanout"
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

python3 - "$RUN_DIR" <<'PY'
from pathlib import Path
import json
import csv
import hashlib
import re
import sys

run_dir = Path(sys.argv[1])
books_dir = run_dir / "books"
books_dir.mkdir(parents=True, exist_ok=True)
rows = []
seen = set()
scope_lookup: dict[str, dict[str, object]] = {}

for chunk_dir in sorted((run_dir / "chunks").glob("chunk-*")):
    vector_scope_path = chunk_dir / "vector-scope.json"
    if vector_scope_path.exists():
        try:
            scope_lookup[chunk_dir.name] = json.loads(vector_scope_path.read_text(encoding="utf-8"))
        except Exception:
            scope_lookup[chunk_dir.name] = {}
    relevant_path = chunk_dir / "artifacts" / "relevant-books.jsonl"
    if not relevant_path.exists():
        continue
    for raw_line in relevant_path.read_text(encoding="utf-8").splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            payload = json.loads(raw_line)
        except Exception:
            continue
        source_file = payload.get("source_file") or payload.get("book_path")
        if not isinstance(source_file, str) or not source_file.strip():
            continue
        key = source_file.strip()
        if key in seen:
            continue
        seen.add(key)
        payload["source_file"] = key
        payload["origin_chunk_id"] = chunk_dir.name
        scope = scope_lookup.get(chunk_dir.name) or {}
        source_file_to_gutenberg = scope.get("source_file_to_gutenberg_id") if isinstance(scope.get("source_file_to_gutenberg_id"), dict) else {}
        if not payload.get("gutenberg_id") and isinstance(source_file_to_gutenberg, dict):
            inferred = source_file_to_gutenberg.get(key)
            if isinstance(inferred, str) and inferred.strip():
                payload["gutenberg_id"] = inferred.strip()
        if not payload.get("corpus_chunk_id") and isinstance(scope.get("corpus_chunk_id"), str):
            payload["corpus_chunk_id"] = scope["corpus_chunk_id"]
        rows.append(payload)

rows.sort(key=lambda item: (
    str(item.get("source_author") or item.get("author") or "").lower(),
    str(item.get("source_title") or item.get("title") or "").lower(),
    item["source_file"],
))

manifest_rows = []
for index, row in enumerate(rows, start=1):
    book_name = f"book-{index:05d}"
    book_dir = books_dir / book_name
    book_dir.mkdir(parents=True, exist_ok=True)
    row["book_id"] = book_name
    row["book_dir"] = str(book_dir)
    decision_path = book_dir / "book-decision.json"
    decision_path.write_text(json.dumps(row, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    manifest_rows.append({
        "book_id": book_name,
        "book_dir": str(book_dir),
        "decision_file": str(decision_path),
        "source_file": row["source_file"],
        "source_title": row.get("source_title") or row.get("title"),
        "source_author": row.get("source_author") or row.get("author"),
        "source_year_or_period": row.get("source_year_or_period") or row.get("year"),
        "origin_chunk_id": row.get("origin_chunk_id"),
        "gutenberg_id": row.get("gutenberg_id"),
        "corpus_chunk_id": row.get("corpus_chunk_id"),
    })

(run_dir / "state" / "relevant-books.json").write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
with (run_dir / "state" / "relevant-books.csv").open("w", encoding="utf-8", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=[
        "book_id", "origin_chunk_id", "source_title", "source_author", "source_year_or_period", "source_file"
    ])
    writer.writeheader()
    for row in rows:
        writer.writerow({
            "book_id": row.get("book_id"),
            "origin_chunk_id": row.get("origin_chunk_id"),
            "source_title": row.get("source_title") or row.get("title"),
            "source_author": row.get("source_author") or row.get("author"),
            "source_year_or_period": row.get("source_year_or_period") or row.get("year"),
            "source_file": row.get("source_file"),
        })

(run_dir / "state" / "book-jobs.json").write_text(json.dumps(manifest_rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(len(manifest_rows))
PY

book_job_count="$(python3 - "$RUN_DIR/state/book-jobs.json" <<'PY'
from pathlib import Path
import json
import sys
rows = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(len(rows))
PY
)"

log_line "book_fanout_prepared book_count=$book_job_count"

launch_book() {
  local book_dir="$1"
  local book_id
  book_id="$(basename "$book_dir")"
  local book_job_id="${JOB_ID}-${book_id}"
  log_line "launch_book book_id=$book_id job_id=$book_job_id"
  "$book_runner" \
    --run-dir "$RUN_DIR" \
    --book-dir "$book_dir" \
    --book-id "$book_id" \
    --job-id "$book_job_id" \
    --model "$MODEL" \
    --root-dir "$ROOT_DIR" \
    --user-prompt-file "$PROMPT_FILE" \
    --book-decision-file "$book_dir/book-decision.json" \
    --corpus-root "$CORPUS_ROOT" \
    --precomputed-index-dir "$PRECOMPUTED_INDEX_DIR" &
}

mapfile -t book_dirs < <(find "$RUN_DIR/books" -mindepth 1 -maxdepth 1 -type d | sort)
for book_dir in "${book_dirs[@]}"; do
  while (( $(jobs -pr | wc -l | tr -d ' ') >= MAX_PARALLEL )); do
    wait -n || true
    python3 "$materialize_script" --run-dir "$RUN_DIR" >/dev/null 2>&1 || true
  done
  launch_book "$book_dir"
done

while (( $(jobs -pr | wc -l | tr -d ' ') > 0 )); do
  wait -n || true
  python3 "$materialize_script" --run-dir "$RUN_DIR" >/dev/null 2>&1 || true
done

python3 "$materialize_script" --run-dir "$RUN_DIR" >/dev/null 2>&1 || true

python3 - "$STATUS_FILE" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
payload = json.loads(path.read_text(encoding="utf-8"))
payload["phase"] = "consolidation"
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

failed_counts="$(
  python3 - "$RUN_DIR" <<'PY'
from pathlib import Path
import json
import sys

run_dir = Path(sys.argv[1])
failed_chunks = 0
failed_books = 0
for chunk_dir in sorted((run_dir / "chunks").glob("chunk-*")):
    try:
        status = json.loads((chunk_dir / "status.json").read_text(encoding="utf-8"))
    except Exception:
        status = {}
    if status.get("state") != "completed":
        failed_chunks += 1
for book_dir in sorted((run_dir / "books").glob("book-*")):
    try:
        status = json.loads((book_dir / "status.json").read_text(encoding="utf-8"))
    except Exception:
        status = {}
    if status.get("state") != "completed":
        failed_books += 1
print(f"{failed_chunks} {failed_books}")
PY
)"
read -r failed_chunks failed_books <<<"$failed_counts"

log_line "classification_and_books_complete failed_chunks=$failed_chunks failed_books=$failed_books"

set +e
"$consolidator_runner" \
  --run-dir "$RUN_DIR" \
  --consolidator-dir "$RUN_DIR/consolidator" \
  --job-id "${JOB_ID}-consolidator" \
  --model "$MODEL" \
  --root-dir "$ROOT_DIR" \
  --user-prompt-file "$PROMPT_FILE"
consolidator_exit=$?
set -e

python3 "$materialize_script" --run-dir "$RUN_DIR" >/dev/null 2>&1 || true

python3 - "$STATUS_FILE" "$SUMMARY_FILE" "$failed_chunks" "$failed_books" "$consolidator_exit" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys

status_path = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
failed_chunks = int(sys.argv[3])
failed_books = int(sys.argv[4])
consolidator_exit = int(sys.argv[5])
finished_at = sys.argv[6]

payload = json.loads(status_path.read_text(encoding="utf-8"))
payload["finished_at"] = finished_at
payload["failed_chunks"] = failed_chunks
payload["failed_books"] = failed_books
payload["consolidator_exit_code"] = consolidator_exit
payload["phase"] = "completed" if failed_chunks == 0 and failed_books == 0 and consolidator_exit == 0 else "failed"
payload["state"] = "completed" if failed_chunks == 0 and failed_books == 0 and consolidator_exit == 0 else "failed"

for target in (status_path, summary_path):
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

python3 "$materialize_script" --run-dir "$RUN_DIR" >/dev/null 2>&1 || true
EOS
chmod +x "$run_dir/run-codex-manager.sh"

{
  echo "timestamp=$timestamp"
  echo "run_id=$run_id"
  echo "run_dir=$run_dir"
  echo "root_dir=$ROOT_DIR"
  echo "corpus_root=$CORPUS_ROOT"
  echo "precomputed_index_dir=$PRECOMPUTED_INDEX_DIR"
  echo "model=$MODEL"
  echo "chunk_size=$CHUNK_SIZE"
  echo "max_parallel=$MAX_PARALLEL"
} >"$launcher_log"

(
  cd "$ROOT_DIR"
  export ROOT_DIR
  export RUN_DIR="$run_dir"
  export JOB_ID="$job_id"
  export MODEL
  export MAX_PARALLEL
  export CORPUS_ROOT
  export PRECOMPUTED_INDEX_DIR
  export PROMPT_FILE="$prompt_file"
  export STATUS_FILE="$status_file"
  export SUMMARY_FILE="$summary_file"
  export OPENAI_API_KEY
  export R2_BUCKET_NAME="${R2_BUCKET_NAME:-}"
  export R2_ENDPOINT="${R2_ENDPOINT:-}"
  export R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
  export R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
  export QDRANT_URL="${QDRANT_URL:-}"
  export QDRANT_API_KEY="${QDRANT_API_KEY:-}"
  export QDRANT_COLLECTION="${QDRANT_COLLECTION:-}"
  nohup "$run_dir/run-codex-manager.sh" >>"$stdout_log" 2>>"$stderr_log" &
  echo $! >"$pid_file"
) >/dev/null

pid="$(cat "$pid_file")"
printf '%s pid=%s started attempt=%s\n' "$(date -u +%FT%TZ)" "$pid" "$attempt_id" >>"$process_log"

(
  while kill -0 "$pid" 2>/dev/null; do
    printf '%s pid=%s alive\n' "$(date -u +%FT%TZ)" "$pid" >>"$heartbeat_log"
    sleep "$HEARTBEAT_SECONDS"
  done
  printf '%s pid=%s exited\n' "$(date -u +%FT%TZ)" "$pid" >>"$heartbeat_log"
) >/dev/null 2>&1 &
echo $! >"$watcher_pid_file"

if [[ -x "$ROOT_DIR/ops/digitalocean/bin/materialize-codex-run-index.py" ]]; then
  (
    while kill -0 "$pid" 2>/dev/null; do
      python3 "$ROOT_DIR/ops/digitalocean/bin/materialize-codex-run-index.py" --run-dir "$run_dir" >/dev/null 2>&1 || true
      sleep "$HEARTBEAT_SECONDS"
    done
    python3 "$ROOT_DIR/ops/digitalocean/bin/materialize-codex-run-index.py" --run-dir "$run_dir" >/dev/null 2>&1 || true
  ) >/dev/null 2>&1 &
fi

python3 - "$status_file" "$pid" "$run_dir" "$(date -u +%FT%TZ)" "$index_file" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
payload = json.loads(path.read_text(encoding="utf-8"))
payload["state"] = "running"
payload["pid"] = int(sys.argv[2])
payload["run_dir"] = sys.argv[3]
payload["launched_at"] = sys.argv[4]
payload["index_file"] = sys.argv[5]
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

echo "$run_dir"
