#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
RUN_ROOT="${RUN_ROOT:-/srv/alphabook/logs/hermes-search}"
HERMES_CONFIG_SOURCE="${HERMES_CONFIG_SOURCE:-/root/.hermes/config.yaml}"
HERMES_ENV_SOURCE="${HERMES_ENV_SOURCE:-/root/.hermes/.env}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
FALLBACK_ENV_FILE="${FALLBACK_ENV_FILE:-/srv/alphabook/.ingest.env}"
CORPUS_ROOT="${CORPUS_ROOT:-/srv/alphabook/gutenberg}"
PRECOMPUTED_INDEX_DIR="${PRECOMPUTED_INDEX_DIR:-}"
MODEL="${MODEL:-gpt-5.4}"
MAX_TURNS="${MAX_TURNS:-40}"
HEARTBEAT_SECONDS="${HEARTBEAT_SECONDS:-15}"
HERMES_BIN="${HERMES_BIN:-}"
CALLBACK_URL="${CALLBACK_URL:-}"
CALLBACK_TOKEN="${CALLBACK_TOKEN:-}"
ARCHIVE_PREFIX="${ARCHIVE_PREFIX:-}"
ALPHABOOK_SESSION_ID="${ALPHABOOK_SESSION_ID:-}"
ALPHABOOK_RUN_ID="${ALPHABOOK_RUN_ID:-}"

usage() {
  cat >&2 <<'EOF'
Usage: run-hermes-search.sh --effort N --user-prompt "grief rituals and mourning practices"

Options:
  --user-prompt TEXT     Search target to insert into the Hermes search prompt.
  --effort N             Maximum number of kept evidence hits before stopping.
  --max-turns N          Override Hermes max turns. Default: 40
  --model NAME           Override Hermes model. Default: gpt-5.4
  --hermes-bin PATH      Override Hermes CLI path. Defaults to PATH lookup, then
                         /root/.hermes/hermes-agent/venv/bin/hermes when present.
  --run-root PATH        Output root. Default: /srv/alphabook/logs/hermes-search
  --corpus-root PATH     Corpus root. Default: /srv/alphabook/gutenberg
  --precomputed-index-dir PATH
                         Reusable text manifest dir. Defaults to <corpus-root>/research-corpus-index
                         or <corpus-root> when it already contains all-text-files.tsv.
  --root-dir PATH        Repo root. Default: /srv/alphabook/repo
  --callback-url URL     AlphaBook callback URL to notify on completion
  --callback-token TEXT  Bearer token used for the completion callback
  --archive-prefix KEY   R2 prefix where the wrapper archives this run
  --alphabook-session-id ID  AlphaBook session id associated with this Hermes run
  --alphabook-run-id ID      AlphaBook run id associated with this Hermes run
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

USER_PROMPT=""
EFFORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      ;;
    --user-prompt)
      [[ $# -ge 2 ]] || usage
      USER_PROMPT="$2"
      shift 2
      ;;
    --effort)
      [[ $# -ge 2 ]] || usage
      EFFORT="$2"
      shift 2
      ;;
    --max-turns)
      [[ $# -ge 2 ]] || usage
      MAX_TURNS="$2"
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || usage
      MODEL="$2"
      shift 2
      ;;
    --hermes-bin)
      [[ $# -ge 2 ]] || usage
      HERMES_BIN="$2"
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

[[ -n "$USER_PROMPT" ]] || usage
[[ -n "$EFFORT" ]] || usage
[[ "$EFFORT" =~ ^[0-9]+$ ]] || { echo "Invalid --effort value: $EFFORT" >&2; exit 1; }
(( EFFORT > 0 )) || { echo "Invalid --effort value: $EFFORT" >&2; exit 1; }
[[ -d "$ROOT_DIR" ]] || { echo "Missing repo root: $ROOT_DIR" >&2; exit 1; }

if [[ -z "$HERMES_BIN" ]]; then
  if command -v hermes >/dev/null 2>&1; then
    HERMES_BIN="$(command -v hermes)"
  elif [[ -x /root/.hermes/hermes-agent/venv/bin/hermes ]]; then
    HERMES_BIN="/root/.hermes/hermes-agent/venv/bin/hermes"
  else
    echo "Unable to find hermes CLI. Set --hermes-bin or ensure hermes is on PATH." >&2
    exit 1
  fi
fi
[[ -x "$HERMES_BIN" ]] || { echo "Hermes CLI is not executable: $HERMES_BIN" >&2; exit 1; }

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
hermes_home="$attempt_dir/hermes-home"
mkdir -p "$state_dir" "$logs_dir" "$runtime_dir" "$hermes_home/.hermes/sessions"

prompt_file="$state_dir/prompt.txt"
launcher_log="$logs_dir/launcher.log"
stdout_log="$logs_dir/hermes.stdout.log"
stderr_log="$logs_dir/hermes.stderr.log"
heartbeat_log="$logs_dir/heartbeat.log"
process_log="$logs_dir/process.log"
pid_file="$runtime_dir/hermes.pid"
watcher_pid_file="$runtime_dir/heartbeat.pid"
status_file="$state_dir/status.json"
summary_file="$state_dir/summary.json"
index_file="$run_dir/index.json"

ln -sfn "state/prompt.txt" "$run_dir/prompt.txt"
ln -sfn "state/status.json" "$run_dir/status.json"
ln -sfn "state/summary.json" "$run_dir/summary.json"
ln -sfn "attempts/$attempt_id/logs/launcher.log" "$run_dir/launcher.log"
ln -sfn "attempts/$attempt_id/logs/hermes.stdout.log" "$run_dir/hermes.stdout.log"
ln -sfn "attempts/$attempt_id/logs/hermes.stderr.log" "$run_dir/hermes.stderr.log"
ln -sfn "attempts/$attempt_id/logs/heartbeat.log" "$run_dir/heartbeat.log"
ln -sfn "attempts/$attempt_id/logs/process.log" "$run_dir/process.log"
ln -sfn "attempts/$attempt_id/runtime/hermes.pid" "$run_dir/hermes.pid"
ln -sfn "attempts/$attempt_id/runtime/heartbeat.pid" "$run_dir/heartbeat.pid"
ln -sfn "attempts/$attempt_id/hermes-home" "$run_dir/hermes-home"
ln -sfn "attempts/$attempt_id" "$run_dir/current-attempt"

if [[ -f "$HERMES_CONFIG_SOURCE" ]]; then
  cp "$HERMES_CONFIG_SOURCE" "$hermes_home/.hermes/config.yaml"
fi
if [[ -f "$HERMES_ENV_SOURCE" ]]; then
  cp "$HERMES_ENV_SOURCE" "$hermes_home/.hermes/.env"
fi

python3 - "$prompt_file" "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR" "$USER_PROMPT" "$EFFORT" <<'PY'
from pathlib import Path
import sys

prompt_path = Path(sys.argv[1])
corpus_root = sys.argv[2]
precomputed_index_dir = sys.argv[3]
user_prompt = sys.argv[4]
effort = int(sys.argv[5])

prompt = f"""You are on a DigitalOcean droplet with a prepared Project Gutenberg corpus at {corpus_root}.

The reusable text-only manifest for this corpus lives at {precomputed_index_dir}.

Search for evidence related to the following:

<USER_SEARCH_PROMPT>
{user_prompt}
</USER_SEARCH_PROMPT>

Effort budget:
- Stop after you keep {effort} evidence hits, unless the scoped corpus is exhausted first.
- Interpret effort strictly as the maximum number of kept hits, not as a license for broad open-ended research.

This is a bounded evidence search, not a full corpus research memo.

Core objective:
Produce a compact, inspectable folder of exact evidence chunks that materially relate to the query.

Required first step:
1. Interpret the search request.
2. Decide the corpus scope before any retrieval.
   - You may use the full corpus if the query is broad.
   - Narrow only when a subset clearly improves relevance or speed.
   - Record the chosen_scope and scope_rationale in the manifest before running ripgrep.
3. Decide what should count as a kept evidence hit.
   - A kept hit must materially bear on the query, not merely contain a matching word.
   - Save exact text with enough surrounding context to stand alone.

Search requirements:
- Use terminal tools.
- Use the precomputed text-only manifest as the source of truth for searchable files.
- Derive a scoped TSV of `size_bytes<TAB>absolute_path` entries before searching.
- Use multiple search terms, variants, and concept clusters when that improves recall.
- Inspect local context around each candidate hit before keeping it.
- Do not keep a passage just because it matched a keyword.
- Stop once you have kept {effort} good evidence hits.
- Search raw text only. Do not use HTML, RDF, EPUB metadata, or cache artifacts for the main search.
- Do not regenerate corpus metadata or the text manifest.
- Do not run a single raw `rg` over {corpus_root}.
- Use the provided progress-aware helper:
  - /srv/alphabook/repo/ops/digitalocean/bin/run-ripgrep-progress.sh
- If the scoped TSV exceeds 5000 files, partition it first with:
  - /srv/alphabook/repo/ops/digitalocean/bin/partition-file-list.sh
- Never send more than 5000 files to a single helper call.
- Use helper calls with `--max-total-files 5000` and `--batch-size 500`.
- When invoking repo helpers on this droplet, use repo-root absolute paths under `/srv/alphabook/repo/...`.

Artifact requirements:
- Create a timestamped inner run directory under:
  /srv/alphabook/logs/corpus-search/<timestamp>-<run-id>/
- Immediately write that absolute inner run directory path into `$WRAPPER_INNER_RUN_FILE` after you create it, if that environment variable is set.
- Log progress in `run.log`.
- Write `manifest.json` with at least:
  - run_id
  - timestamp
  - user_prompt
  - effort
  - corpus_root
  - chosen_scope
  - scope_rationale
  - search_strategy_summary
  - kept_hit_count
  - status
- Save kept evidence chunks in:
  - `hits/`
- Save a lightweight machine-readable index at:
  - `hits/index.json`
- Each kept hit should get its own file in `hits/`, for example `hit-0001.md`.
- Each hit file should include:
  - hit_id
  - source_file
  - source_title if inferable
  - source_author if inferable
  - matched_terms
  - why_this_is_relevant
  - the exact quoted chunk

Quality bar:
- Scope first, then search.
- Prefer exact, representative evidence over lots of weak matches.
- Keep searching until you reach the effort cap or genuinely exhaust the scoped corpus.
- Keep the output inspectable and lightweight.
- Do not spend time building a full synthesis, labels, or a large structured dataset.

At the end:
- Print the inner run directory path.
- Print a short summary of:
  - chosen scope
  - searched file count
  - kept hit count
  - output files
"""

prompt_path.write_text(prompt)
PY

python3 - "$status_file" "$summary_file" "$timestamp" "$run_id" "$job_id" "$ROOT_DIR" "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR" "$MODEL" "$MAX_TURNS" "$USER_PROMPT" "$EFFORT" "$ALPHABOOK_SESSION_ID" "$ALPHABOOK_RUN_ID" "$CALLBACK_URL" "$ARCHIVE_PREFIX" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "timestamp": sys.argv[3],
    "run_id": sys.argv[4],
    "job_id": sys.argv[5],
    "root_dir": sys.argv[6],
    "corpus_root": sys.argv[7],
    "precomputed_index_dir": sys.argv[8],
    "model": sys.argv[9],
    "max_turns": int(sys.argv[10]),
    "user_prompt": sys.argv[11],
    "effort": int(sys.argv[12]),
    "alphabook_session_id": sys.argv[13] or None,
    "alphabook_run_id": sys.argv[14] or None,
    "callback_url": sys.argv[15] or None,
    "archive_prefix": sys.argv[16] or None,
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

cat >"$run_dir/run-hermes.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

echo "launcher_started_at=$(date -u +%FT%TZ)"
echo "pwd=$(pwd)"
echo "model=$MODEL"
echo "max_turns=$MAX_TURNS"
echo "hermes_bin=$HERMES_BIN"
echo "prompt_file=$PROMPT_FILE"
echo "job_id=$JOB_ID"
echo "effort=${EFFORT:-}"
echo "hermes_home=$HOME"
echo "attempt_id=${ATTEMPT_ID:-}"
echo "attempt_dir=${ATTEMPT_DIR:-}"
echo "alphabook_session_id=${ALPHABOOK_SESSION_ID:-}"
echo "alphabook_run_id=${ALPHABOOK_RUN_ID:-}"
echo "archive_prefix=${ARCHIVE_PREFIX:-}"
echo "callback_url=${CALLBACK_URL:-}"

python3 - "$STATUS_FILE" "running" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["state"] = sys.argv[2]
data["started_at"] = sys.argv[3]
path.write_text(json.dumps(data, indent=2) + "\n")
PY

set +e
"$HERMES_BIN" chat -m "$MODEL" -q "$(cat "$PROMPT_FILE")" -Q --max-turns "$MAX_TURNS" --yolo > >(stdbuf -oL tee -a "$STDOUT_LOG") 2> >(stdbuf -oL tee -a "$STDERR_LOG" >&2)
exit_code=$?
set -e

python3 - "$STATUS_FILE" "$SUMMARY_FILE" "$exit_code" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys

status_path = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
exit_code = int(sys.argv[3])
finished_at = sys.argv[4]
status = json.loads(status_path.read_text())
status["finished_at"] = finished_at
status["exit_code"] = exit_code
status["state"] = "completed" if exit_code == 0 else "failed"
status_path.write_text(json.dumps(status, indent=2) + "\n")
summary_path.write_text(json.dumps(status, indent=2) + "\n")
PY

materialize_script="${ROOT_DIR}/ops/digitalocean/bin/materialize-hermes-run-index.py"
if [[ -x "$materialize_script" ]]; then
  python3 "$materialize_script" --run-dir "$RUN_DIR" >>"$STDOUT_LOG" 2>>"$STDERR_LOG" || true
fi

archive_script="${ROOT_DIR}/ops/digitalocean/bin/archive-hermes-run.mjs"
if [[ -n "${ARCHIVE_PREFIX:-}" && -n "${ALPHABOOK_SESSION_ID:-}" && -n "${ALPHABOOK_RUN_ID:-}" && -x "$archive_script" ]]; then
  archive_args=(
    --run-dir "$RUN_DIR"
    --job-id "$JOB_ID"
    --session-id "$ALPHABOOK_SESSION_ID"
    --run-id "$ALPHABOOK_RUN_ID"
    --archive-prefix "$ARCHIVE_PREFIX"
  )
  if [[ -n "${CALLBACK_URL:-}" ]]; then
    archive_args+=(--callback-url "$CALLBACK_URL")
  fi
  if [[ -n "${CALLBACK_TOKEN:-}" ]]; then
    archive_args+=(--callback-token "$CALLBACK_TOKEN")
  fi
  node "$archive_script" "${archive_args[@]}" >>"$STDOUT_LOG" 2>>"$STDERR_LOG" || true
fi

exit "$exit_code"
EOS

chmod +x "$run_dir/run-hermes.sh"

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
  HOME="$hermes_home" \
  MODEL="$MODEL" \
  MAX_TURNS="$MAX_TURNS" \
  HERMES_BIN="$HERMES_BIN" \
  EFFORT="$EFFORT" \
  JOB_ID="$job_id" \
  PROMPT_FILE="$prompt_file" \
  STATUS_FILE="$status_file" \
  SUMMARY_FILE="$summary_file" \
  STDOUT_LOG="$stdout_log" \
  STDERR_LOG="$stderr_log" \
  ATTEMPT_ID="$attempt_id" \
  ATTEMPT_DIR="$attempt_dir" \
  RUN_DIR="$run_dir" \
  ALPHABOOK_SESSION_ID="$ALPHABOOK_SESSION_ID" \
  ALPHABOOK_RUN_ID="$ALPHABOOK_RUN_ID" \
  CALLBACK_URL="$CALLBACK_URL" \
  CALLBACK_TOKEN="$CALLBACK_TOKEN" \
  ARCHIVE_PREFIX="$ARCHIVE_PREFIX" \
  R2_BUCKET_NAME="${R2_BUCKET_NAME:-}" \
  R2_ENDPOINT="${R2_ENDPOINT:-}" \
  R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}" \
  R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}" \
  WRAPPER_INNER_RUN_FILE="$runtime_dir/inner-run-dir.txt" \
  bash "$run_dir/run-hermes.sh"
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

python3 - "$index_file" "$run_dir" "$attempt_id" "$job_id" "$USER_PROMPT" "$EFFORT" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "run_dir": sys.argv[2],
    "job_id": sys.argv[4],
    "attempt_id": sys.argv[3],
    "prompt_file": str(Path(sys.argv[2]) / "prompt.txt"),
    "status_file": str(Path(sys.argv[2]) / "status.json"),
    "summary_file": str(Path(sys.argv[2]) / "summary.json"),
    "launcher_log": str(Path(sys.argv[2]) / "launcher.log"),
    "stdout_log": str(Path(sys.argv[2]) / "hermes.stdout.log"),
    "stderr_log": str(Path(sys.argv[2]) / "hermes.stderr.log"),
    "heartbeat_log": str(Path(sys.argv[2]) / "heartbeat.log"),
    "process_log": str(Path(sys.argv[2]) / "process.log"),
    "hermes_pid_file": str(Path(sys.argv[2]) / "hermes.pid"),
    "heartbeat_pid_file": str(Path(sys.argv[2]) / "heartbeat.pid"),
    "inner_run_file": str(Path(sys.argv[2]) / "attempts" / "attempt-0001" / "runtime" / "inner-run-dir.txt"),
    "user_prompt": sys.argv[5],
    "effort": int(sys.argv[6]),
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

printf '%s\n' "$run_dir"
