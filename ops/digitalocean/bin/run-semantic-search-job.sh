#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
RUN_ROOT="${RUN_ROOT:-/srv/alphabook/logs/semantic-search}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
FALLBACK_ENV_FILE="${FALLBACK_ENV_FILE:-/srv/alphabook/.ingest.env}"
CORPUS_ROOT="${CORPUS_ROOT:-/srv/alphabook/gutenberg}"
PRECOMPUTED_INDEX_DIR="${PRECOMPUTED_INDEX_DIR:-}"
HEARTBEAT_SECONDS="${HEARTBEAT_SECONDS:-15}"
MAX_RESULTS="${MAX_RESULTS:-8}"
BACKEND="${BACKEND:-alphaloop}"
ALPHABOOK_SESSION_ID="${ALPHABOOK_SESSION_ID:-}"
ALPHABOOK_RUN_ID="${ALPHABOOK_RUN_ID:-}"
CALLBACK_URL="${CALLBACK_URL:-}"
CALLBACK_TOKEN="${CALLBACK_TOKEN:-}"
ARCHIVE_PREFIX="${ARCHIVE_PREFIX:-}"

usage() {
  cat >&2 <<'EOF'
Usage: run-semantic-search-job.sh --query "..." [--max-results 8]

Options:
  --query TEXT               Semantic search query.
  --max-results N            Final kept result budget. Default: 8
  --backend NAME             Backend hint. Stored for metadata only.
  --gutenberg-id N           Scope the search to one Gutenberg id. Repeatable.
  --run-root PATH            Wrapper run root.
  --corpus-root PATH         Corpus root.
  --precomputed-index-dir PATH
  --root-dir PATH            Repo root.
  --callback-url URL         Optional AlphaBook callback URL metadata.
  --callback-token TEXT      Optional callback token metadata.
  --archive-prefix KEY       Optional archive prefix metadata.
  --alphabook-session-id ID  Optional AlphaBook session id metadata.
  --alphabook-run-id ID      Optional AlphaBook run id metadata.
EOF
  exit 1
}

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

QUERY=""
declare -a GUTENBERG_IDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      ;;
    --query)
      [[ $# -ge 2 ]] || usage
      QUERY="$2"
      shift 2
      ;;
    --max-results)
      [[ $# -ge 2 ]] || usage
      MAX_RESULTS="$2"
      shift 2
      ;;
    --backend)
      [[ $# -ge 2 ]] || usage
      BACKEND="$2"
      shift 2
      ;;
    --gutenberg-id)
      [[ $# -ge 2 ]] || usage
      GUTENBERG_IDS+=("$2")
      shift 2
      ;;
    --run-root)
      [[ $# -ge 2 ]] || usage
      RUN_ROOT="$2"
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
    --root-dir)
      [[ $# -ge 2 ]] || usage
      ROOT_DIR="$2"
      shift 2
      ;;
    --callback-url)
      [[ $# -ge 2 ]] || usage
      CALLBACK_URL="$2"
      shift 2
      ;;
    --callback-token)
      [[ $# -ge 2 ]] || usage
      CALLBACK_TOKEN="$2"
      shift 2
      ;;
    --archive-prefix)
      [[ $# -ge 2 ]] || usage
      ARCHIVE_PREFIX="$2"
      shift 2
      ;;
    --alphabook-session-id)
      [[ $# -ge 2 ]] || usage
      ALPHABOOK_SESSION_ID="$2"
      shift 2
      ;;
    --alphabook-run-id)
      [[ $# -ge 2 ]] || usage
      ALPHABOOK_RUN_ID="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$QUERY" ]] || usage
[[ "$MAX_RESULTS" =~ ^[0-9]+$ ]] || { echo "Invalid --max-results value: $MAX_RESULTS" >&2; exit 1; }
(( MAX_RESULTS > 0 )) || { echo "Invalid --max-results value: $MAX_RESULTS" >&2; exit 1; }
[[ -d "$ROOT_DIR" ]] || { echo "Missing repo root: $ROOT_DIR" >&2; exit 1; }

PRECOMPUTED_INDEX_DIR="$(resolve_precomputed_index_dir "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR")"
[[ -f "$PRECOMPUTED_INDEX_DIR/metadata-table.jsonl" ]] || {
  echo "Missing precomputed metadata table: $PRECOMPUTED_INDEX_DIR/metadata-table.jsonl" >&2
  exit 1
}

if [[ -f "$ENV_FILE" ]]; then
  export OPENAI_API_KEY="${OPENAI_API_KEY:-$(load_env_value "$ENV_FILE" "OPENAI_API_KEY")}"
  export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$(load_env_value "$ENV_FILE" "OPENAI_BASE_URL")}"
  export OPENAI_EMBEDDING_MODEL="${OPENAI_EMBEDDING_MODEL:-$(load_env_value "$ENV_FILE" "OPENAI_EMBEDDING_MODEL")}"
  export OPENAI_EMBEDDING_DIMENSIONS="${OPENAI_EMBEDDING_DIMENSIONS:-$(load_env_value "$ENV_FILE" "OPENAI_EMBEDDING_DIMENSIONS")}"
  export QDRANT_URL="${QDRANT_URL:-$(load_env_value "$ENV_FILE" "QDRANT_URL")}"
  export QDRANT_API_KEY="${QDRANT_API_KEY:-$(load_env_value "$ENV_FILE" "QDRANT_API_KEY")}"
  export QDRANT_COLLECTION="${QDRANT_COLLECTION:-$(load_env_value "$ENV_FILE" "QDRANT_COLLECTION")}"
fi
if [[ -f "$FALLBACK_ENV_FILE" ]]; then
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    export OPENAI_API_KEY="$(load_env_value "$FALLBACK_ENV_FILE" "OPENAI_API_KEY")"
  fi
  export OPENAI_BASE_URL="${OPENAI_BASE_URL:-$(load_env_value "$FALLBACK_ENV_FILE" "OPENAI_BASE_URL")}"
  export OPENAI_EMBEDDING_MODEL="${OPENAI_EMBEDDING_MODEL:-$(load_env_value "$FALLBACK_ENV_FILE" "OPENAI_EMBEDDING_MODEL")}"
  export OPENAI_EMBEDDING_DIMENSIONS="${OPENAI_EMBEDDING_DIMENSIONS:-$(load_env_value "$FALLBACK_ENV_FILE" "OPENAI_EMBEDDING_DIMENSIONS")}"
  export QDRANT_URL="${QDRANT_URL:-$(load_env_value "$FALLBACK_ENV_FILE" "QDRANT_URL")}"
  export QDRANT_API_KEY="${QDRANT_API_KEY:-$(load_env_value "$FALLBACK_ENV_FILE" "QDRANT_API_KEY")}"
  export QDRANT_COLLECTION="${QDRANT_COLLECTION:-$(load_env_value "$FALLBACK_ENV_FILE" "QDRANT_COLLECTION")}"
fi
: "${OPENAI_BASE_URL:=https://api.openai.com/v1}"
export OPENAI_BASE_URL
[[ -n "${OPENAI_API_KEY:-}" ]] || { echo "OPENAI_API_KEY is not available from $ENV_FILE or $FALLBACK_ENV_FILE" >&2; exit 1; }
[[ -n "${QDRANT_URL:-}" ]] || { echo "QDRANT_URL is not available from $ENV_FILE or $FALLBACK_ENV_FILE" >&2; exit 1; }
[[ -n "${QDRANT_COLLECTION:-}" ]] || { echo "QDRANT_COLLECTION is not available from $ENV_FILE or $FALLBACK_ENV_FILE" >&2; exit 1; }

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
inner_run_dir="$attempt_dir/semantic-run"
mkdir -p "$state_dir" "$logs_dir" "$runtime_dir" "$inner_run_dir"

query_file="$state_dir/query.txt"
launcher_log="$logs_dir/launcher.log"
stdout_log="$logs_dir/semantic.stdout.log"
stderr_log="$logs_dir/semantic.stderr.log"
heartbeat_log="$logs_dir/heartbeat.log"
process_log="$logs_dir/process.log"
pid_file="$runtime_dir/semantic.pid"
watcher_pid_file="$runtime_dir/heartbeat.pid"
status_file="$state_dir/status.json"
summary_file="$state_dir/summary.json"
index_file="$run_dir/index.json"
inner_run_file="$runtime_dir/inner-run-dir.txt"
run_log="$inner_run_dir/run.log"
inner_status_file="$inner_run_dir/status.json"
gutenberg_ids_file="$runtime_dir/gutenberg-ids.json"

printf '%s\n' "$QUERY" >"$query_file"
printf '%s\n' "$inner_run_dir" >"$inner_run_file"

if [[ ${#GUTENBERG_IDS[@]} -gt 0 ]]; then
  python3 - "$gutenberg_ids_file" "${GUTENBERG_IDS[@]}" <<'PY'
from pathlib import Path
import json
import sys
Path(sys.argv[1]).write_text(
    json.dumps({"gutenberg_ids": [value for value in sys.argv[2:] if value.strip()]}, indent=2) + "\n",
    encoding="utf-8",
)
PY
fi

ln -sfn "state/query.txt" "$run_dir/query.txt"
ln -sfn "state/status.json" "$run_dir/status.json"
ln -sfn "state/summary.json" "$run_dir/summary.json"
ln -sfn "attempts/$attempt_id/logs/launcher.log" "$run_dir/launcher.log"
ln -sfn "attempts/$attempt_id/logs/semantic.stdout.log" "$run_dir/semantic.stdout.log"
ln -sfn "attempts/$attempt_id/logs/semantic.stderr.log" "$run_dir/semantic.stderr.log"
ln -sfn "attempts/$attempt_id/logs/heartbeat.log" "$run_dir/heartbeat.log"
ln -sfn "attempts/$attempt_id/logs/process.log" "$run_dir/process.log"
ln -sfn "attempts/$attempt_id/runtime/semantic.pid" "$run_dir/semantic.pid"
ln -sfn "attempts/$attempt_id/runtime/heartbeat.pid" "$run_dir/heartbeat.pid"
ln -sfn "attempts/$attempt_id/runtime/inner-run-dir.txt" "$run_dir/inner-run-dir.txt"
ln -sfn "attempts/$attempt_id/semantic-run" "$run_dir/current-output"
ln -sfn "attempts/$attempt_id" "$run_dir/current-attempt"

python3 - "$status_file" "$summary_file" "$timestamp" "$run_id" "$job_id" "$ROOT_DIR" "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR" "$QUERY" "$MAX_RESULTS" "$BACKEND" "$ALPHABOOK_SESSION_ID" "$ALPHABOOK_RUN_ID" "$CALLBACK_URL" "$ARCHIVE_PREFIX" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "timestamp": sys.argv[3],
    "run_id": sys.argv[4],
    "job_id": sys.argv[5],
    "job_type": "semantic_search",
    "root_dir": sys.argv[6],
    "corpus_root": sys.argv[7],
    "precomputed_index_dir": sys.argv[8],
    "query": sys.argv[9],
    "max_results": int(sys.argv[10]),
    "backend": sys.argv[11],
    "alphabook_session_id": sys.argv[12] or None,
    "alphabook_run_id": sys.argv[13] or None,
    "callback_url": sys.argv[14] or None,
    "archive_prefix": sys.argv[15] or None,
    "state": "launching",
    "run_dir": str(Path(sys.argv[1]).parent.parent),
    "state_dir": str(Path(sys.argv[1]).parent),
    "attempt_id": "attempt-0001",
    "attempt_dir": str(Path(sys.argv[1]).parent.parent / "attempts" / "attempt-0001"),
    "logs_dir": str(Path(sys.argv[1]).parent.parent / "attempts" / "attempt-0001" / "logs"),
    "runtime_dir": str(Path(sys.argv[1]).parent.parent / "attempts" / "attempt-0001" / "runtime"),
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n")
Path(sys.argv[2]).write_text(json.dumps(payload, indent=2) + "\n")
PY

python3 - "$inner_status_file" "$QUERY" "$MAX_RESULTS" "$BACKEND" <<'PY'
from pathlib import Path
import json
import sys
Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "phase": "launching",
            "detail": f"Preparing semantic retrieval for {sys.argv[2]}",
            "query": sys.argv[2],
            "max_results": int(sys.argv[3]),
            "backend": sys.argv[4],
        },
        indent=2,
    ) + "\n",
    encoding="utf-8",
)
PY

cat >"$run_dir/run-semantic.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

echo "semantic_launcher_started_at=$(date -u +%FT%TZ)"
echo "query=$QUERY"
echo "max_results=$MAX_RESULTS"
echo "backend=$BACKEND"
echo "inner_run_dir=$INNER_RUN_DIR"
echo "precomputed_index_dir=$PRECOMPUTED_INDEX_DIR"
echo "alphabook_session_id=${ALPHABOOK_SESSION_ID:-}"
echo "alphabook_run_id=${ALPHABOOK_RUN_ID:-}"

python3 - "$STATUS_FILE" "$SUMMARY_FILE" "running" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys
for target in (Path(sys.argv[1]), Path(sys.argv[2])):
    data = json.loads(target.read_text())
    data["state"] = sys.argv[3]
    data["started_at"] = sys.argv[4]
    target.write_text(json.dumps(data, indent=2) + "\n")
PY

python3 - "$INNER_STATUS_FILE" <<'PY'
from pathlib import Path
import json
import sys
path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["phase"] = "retrieving"
data["detail"] = "Running Qdrant-first retrieval and reranking."
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

echo "$(date -u +%FT%TZ) Starting Qdrant retrieval for semantic search." >>"$RUN_LOG"
retrieval_args=(
  python3 "$ROOT_DIR/ops/digitalocean/bin/run-qdrant-rag-retrieval.py"
  --query "$QUERY"
  --output-dir "$INNER_RUN_DIR"
  --precomputed-index-dir "$PRECOMPUTED_INDEX_DIR"
  --rerank-keep "$(( MAX_RESULTS * 3 ))"
  --vector-limit 40
  --variant-count 12
)
if [[ -f "$GUTENBERG_IDS_FILE" ]]; then
  retrieval_args+=(--gutenberg-ids-file "$GUTENBERG_IDS_FILE")
fi

set +e
"${retrieval_args[@]}" >>"$RUN_LOG" 2>&1
exit_code=$?
set -e

python3 - "$INNER_STATUS_FILE" "$exit_code" "$QUERY" "$MAX_RESULTS" <<'PY'
from pathlib import Path
import json
import sys
path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["phase"] = "completed" if int(sys.argv[2]) == 0 else "failed"
data["detail"] = (
    f"Retrieved ranked packets for {sys.argv[3]}"
    if int(sys.argv[2]) == 0
    else "Remote semantic retrieval failed."
)
data["query"] = sys.argv[3]
data["max_results"] = int(sys.argv[4])
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

python3 - "$STATUS_FILE" "$SUMMARY_FILE" "$exit_code" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys
for target in (Path(sys.argv[1]), Path(sys.argv[2])):
    data = json.loads(target.read_text())
    data["finished_at"] = sys.argv[4]
    data["exit_code"] = int(sys.argv[3])
    data["state"] = "completed" if int(sys.argv[3]) == 0 else "failed"
    target.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "$(date -u +%FT%TZ) Semantic retrieval finished with exit_code=$exit_code." >>"$RUN_LOG"
exit "$exit_code"
EOS

chmod +x "$run_dir/run-semantic.sh"

cat >"$run_dir/watch-heartbeat.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

while true; do
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      printf '%s pid=%s status=alive\n' "$(date -u +%FT%TZ)" "$pid" >>"$HEARTBEAT_LOG"
      sleep "$HEARTBEAT_SECONDS"
      continue
    fi
  fi
  printf '%s status=exited\n' "$(date -u +%FT%TZ)" >>"$HEARTBEAT_LOG"
  exit 0
done
EOS

chmod +x "$run_dir/watch-heartbeat.sh"

(
  cd "$ROOT_DIR"
  QUERY="$QUERY" \
  MAX_RESULTS="$MAX_RESULTS" \
  BACKEND="$BACKEND" \
  ROOT_DIR="$ROOT_DIR" \
  PRECOMPUTED_INDEX_DIR="$PRECOMPUTED_INDEX_DIR" \
  INNER_RUN_DIR="$inner_run_dir" \
  INNER_STATUS_FILE="$inner_status_file" \
  GUTENBERG_IDS_FILE="$gutenberg_ids_file" \
  RUN_LOG="$run_log" \
  STATUS_FILE="$status_file" \
  SUMMARY_FILE="$summary_file" \
  ALPHABOOK_SESSION_ID="$ALPHABOOK_SESSION_ID" \
  ALPHABOOK_RUN_ID="$ALPHABOOK_RUN_ID" \
  bash "$run_dir/run-semantic.sh"
) >>"$launcher_log" 2>&1 &
runner_pid=$!
printf '%s\n' "$runner_pid" >"$pid_file"

(
  PID_FILE="$pid_file" \
  HEARTBEAT_LOG="$heartbeat_log" \
  HEARTBEAT_SECONDS="$HEARTBEAT_SECONDS" \
  bash "$run_dir/watch-heartbeat.sh"
) >>"$process_log" 2>&1 &
watcher_pid=$!
printf '%s\n' "$watcher_pid" >"$watcher_pid_file"

printf '%s pid=%s started attempt=%s\n' "$(date -u +%FT%TZ)" "$runner_pid" "$attempt_id" >>"$process_log"

python3 - "$index_file" "$run_dir" "$attempt_id" "$job_id" "$QUERY" "$MAX_RESULTS" "$BACKEND" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "run_dir": sys.argv[2],
    "job_id": sys.argv[4],
    "job_type": "semantic_search",
    "attempt_id": sys.argv[3],
    "query_file": str(Path(sys.argv[2]) / "query.txt"),
    "status_file": str(Path(sys.argv[2]) / "status.json"),
    "summary_file": str(Path(sys.argv[2]) / "summary.json"),
    "launcher_log": str(Path(sys.argv[2]) / "launcher.log"),
    "stdout_log": str(Path(sys.argv[2]) / "semantic.stdout.log"),
    "stderr_log": str(Path(sys.argv[2]) / "semantic.stderr.log"),
    "heartbeat_log": str(Path(sys.argv[2]) / "heartbeat.log"),
    "process_log": str(Path(sys.argv[2]) / "process.log"),
    "semantic_pid_file": str(Path(sys.argv[2]) / "semantic.pid"),
    "heartbeat_pid_file": str(Path(sys.argv[2]) / "heartbeat.pid"),
    "inner_run_file": str(Path(sys.argv[2]) / "attempts" / "attempt-0001" / "runtime" / "inner-run-dir.txt"),
    "query": sys.argv[5],
    "max_results": int(sys.argv[6]),
    "backend": sys.argv[7],
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n")
PY

python3 - "$status_file" "$summary_file" "$runner_pid" "$run_dir" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys

for target in (Path(sys.argv[1]), Path(sys.argv[2])):
    data = json.loads(target.read_text())
    data["state"] = "running"
    data["pid"] = int(sys.argv[3])
    data["run_dir"] = sys.argv[4]
    data["launched_at"] = sys.argv[5]
    data["index_file"] = str(Path(sys.argv[4]) / "index.json")
    target.write_text(json.dumps(data, indent=2) + "\n")
PY

(
  while kill -0 "$runner_pid" 2>/dev/null; do
    sleep "$HEARTBEAT_SECONDS"
  done
  printf '%s pid=%s exited attempt=%s\n' "$(date -u +%FT%TZ)" "$runner_pid" "$attempt_id" >>"$process_log"
) >/dev/null 2>&1 &

printf '%s\n' "$run_dir"
