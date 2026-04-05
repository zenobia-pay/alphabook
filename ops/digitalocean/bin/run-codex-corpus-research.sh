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
elif [[ -f "$FALLBACK_ENV_FILE" ]]; then
  export OPENAI_API_KEY="${OPENAI_API_KEY:-$(load_env_value "$FALLBACK_ENV_FILE" "OPENAI_API_KEY")}"
  export R2_BUCKET_NAME="${R2_BUCKET_NAME:-$(load_env_value "$FALLBACK_ENV_FILE" "R2_BUCKET_NAME")}"
  export R2_ENDPOINT="${R2_ENDPOINT:-$(load_env_value "$FALLBACK_ENV_FILE" "R2_ENDPOINT")}"
  export R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-$(load_env_value "$FALLBACK_ENV_FILE" "R2_ACCESS_KEY_ID")}"
  export R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-$(load_env_value "$FALLBACK_ENV_FILE" "R2_SECRET_ACCESS_KEY")}"
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

cat >"$run_dir/run-codex-manager.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

chunk_runner="$ROOT_DIR/ops/digitalocean/bin/run-codex-corpus-research-chunk.sh"
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

failed_chunks="$(
  python3 - "$RUN_DIR" <<'PY'
from pathlib import Path
import json
import sys

failed = 0
for chunk_dir in sorted((Path(sys.argv[1]) / "chunks").glob("chunk-*")):
    try:
        status = json.loads((chunk_dir / "status.json").read_text(encoding="utf-8"))
    except Exception:
        status = {}
    if status.get("state") != "completed":
        failed += 1
print(failed)
PY
)"

log_line "chunks_complete failed_chunks=$failed_chunks"

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

python3 - "$STATUS_FILE" "$SUMMARY_FILE" "$failed_chunks" "$consolidator_exit" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys

status_path = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
failed_chunks = int(sys.argv[3])
consolidator_exit = int(sys.argv[4])
finished_at = sys.argv[5]

payload = json.loads(status_path.read_text(encoding="utf-8"))
payload["finished_at"] = finished_at
payload["failed_chunks"] = failed_chunks
payload["consolidator_exit_code"] = consolidator_exit
payload["state"] = "completed" if failed_chunks == 0 and consolidator_exit == 0 else "failed"

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
