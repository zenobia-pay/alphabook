#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
RUN_ROOT="${RUN_ROOT:-/srv/alphabook/logs/codex-design-experiment-wrapper}"
INNER_RUN_ROOT="${INNER_RUN_ROOT:-/srv/alphabook/logs/codex-design-experiment}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
FALLBACK_ENV_FILE="${FALLBACK_ENV_FILE:-/srv/alphabook/.ingest.env}"
CORPUS_ROOT="${CORPUS_ROOT:-/srv/alphabook/gutenberg}"
PRECOMPUTED_INDEX_DIR="${PRECOMPUTED_INDEX_DIR:-}"
MODEL="${MODEL:-gpt-5.4}"
HEARTBEAT_SECONDS="${HEARTBEAT_SECONDS:-15}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
CALLBACK_URL="${CALLBACK_URL:-}"
CALLBACK_TOKEN="${CALLBACK_TOKEN:-}"
ARCHIVE_PREFIX="${ARCHIVE_PREFIX:-}"
ALPHABOOK_SESSION_ID="${ALPHABOOK_SESSION_ID:-}"
ALPHABOOK_RUN_ID="${ALPHABOOK_RUN_ID:-}"
USER_PROMPT=""

usage() {
  cat >&2 <<'EOF'
Usage: run-codex-design-experiment.sh --user-prompt "Compare religious and secular grief coping in 19th-century English fiction."
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user-prompt)
      USER_PROMPT="$2"
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
    --inner-run-root)
      INNER_RUN_ROOT="$2"
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
    --callback-url)
      CALLBACK_URL="$2"
      shift 2
      ;;
    --callback-token)
      CALLBACK_TOKEN="$2"
      shift 2
      ;;
    --archive-prefix)
      ARCHIVE_PREFIX="$2"
      shift 2
      ;;
    --alphabook-session-id)
      ALPHABOOK_SESSION_ID="$2"
      shift 2
      ;;
    --alphabook-run-id)
      ALPHABOOK_RUN_ID="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

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

[[ -n "$USER_PROMPT" ]] || usage
[[ -d "$ROOT_DIR" ]] || { echo "Missing repo root: $ROOT_DIR" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "Missing codex CLI on PATH" >&2; exit 1; }
PRECOMPUTED_INDEX_DIR="$(resolve_precomputed_index_dir "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR")"
[[ -f "$PRECOMPUTED_INDEX_DIR/all-text-files.tsv" ]] || {
  echo "Missing precomputed text manifest: $PRECOMPUTED_INDEX_DIR/all-text-files.tsv" >&2
  exit 1
}

if [[ -f "$ENV_FILE" ]]; then
  export OPENAI_API_KEY="${OPENAI_API_KEY:-$(load_env_value "$ENV_FILE" "OPENAI_API_KEY")}"
fi
if [[ -z "${OPENAI_API_KEY:-}" && -f "$FALLBACK_ENV_FILE" ]]; then
  export OPENAI_API_KEY="$(load_env_value "$FALLBACK_ENV_FILE" "OPENAI_API_KEY")"
fi
[[ -n "${OPENAI_API_KEY:-}" ]] || { echo "OPENAI_API_KEY is not available from $ENV_FILE or $FALLBACK_ENV_FILE" >&2; exit 1; }

mkdir -p "$RUN_ROOT" "$INNER_RUN_ROOT"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_id="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(4))
PY
)"
wrapper_run_dir="$RUN_ROOT/$timestamp-$run_id"
job_id="$(basename "$wrapper_run_dir")"
inner_run_dir="$INNER_RUN_ROOT/$timestamp-$run_id"

state_dir="$wrapper_run_dir/state"
attempts_dir="$wrapper_run_dir/attempts"
attempt_id="attempt-0001"
attempt_dir="$attempts_dir/$attempt_id"
logs_dir="$attempt_dir/logs"
runtime_dir="$attempt_dir/runtime"
codex_home="$attempt_dir/codex-home"
mkdir -p "$state_dir" "$logs_dir" "$runtime_dir" "$codex_home/.codex" "$inner_run_dir" "$inner_run_dir/evidence"

prompt_file="$state_dir/prompt.txt"
status_file="$state_dir/status.json"
summary_file="$state_dir/summary.json"
launcher_log="$logs_dir/launcher.log"
stdout_log="$logs_dir/hermes.stdout.log"
stderr_log="$logs_dir/hermes.stderr.log"
heartbeat_log="$logs_dir/heartbeat.log"
process_log="$logs_dir/process.log"
pid_file="$runtime_dir/hermes.pid"
watcher_pid_file="$runtime_dir/heartbeat.pid"
inner_run_file="$runtime_dir/inner-run-dir.txt"
index_file="$wrapper_run_dir/index.json"
attempt_manifest_file="$attempt_dir/attempt.json"

ln -sfn "state/prompt.txt" "$wrapper_run_dir/prompt.txt"
ln -sfn "state/status.json" "$wrapper_run_dir/status.json"
ln -sfn "state/summary.json" "$wrapper_run_dir/summary.json"
ln -sfn "attempts/$attempt_id/logs/launcher.log" "$wrapper_run_dir/launcher.log"
ln -sfn "attempts/$attempt_id/logs/hermes.stdout.log" "$wrapper_run_dir/hermes.stdout.log"
ln -sfn "attempts/$attempt_id/logs/hermes.stderr.log" "$wrapper_run_dir/hermes.stderr.log"
ln -sfn "attempts/$attempt_id/logs/heartbeat.log" "$wrapper_run_dir/heartbeat.log"
ln -sfn "attempts/$attempt_id/logs/process.log" "$wrapper_run_dir/process.log"
ln -sfn "attempts/$attempt_id/runtime/hermes.pid" "$wrapper_run_dir/hermes.pid"
ln -sfn "attempts/$attempt_id/runtime/heartbeat.pid" "$wrapper_run_dir/heartbeat.pid"
ln -sfn "attempts/$attempt_id/runtime/inner-run-dir.txt" "$wrapper_run_dir/inner-run-dir.txt"
ln -sfn "attempts/$attempt_id" "$wrapper_run_dir/current-attempt"

printf '%s\n' "$USER_PROMPT" >"$prompt_file"
printf '%s\n' "$inner_run_dir" >"$inner_run_file"

python3 - "$status_file" "$summary_file" "$wrapper_run_dir" "$inner_run_dir" "$job_id" "$MODEL" "$USER_PROMPT" "$ALPHABOOK_SESSION_ID" "$ALPHABOOK_RUN_ID" "$ARCHIVE_PREFIX" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "job_id": sys.argv[5],
    "run_dir": sys.argv[3],
    "inner_run_dir": sys.argv[4],
    "inner_run_id": Path(sys.argv[4]).name,
    "model": sys.argv[6],
    "user_prompt": sys.argv[7],
    "alphabook_session_id": sys.argv[8] or None,
    "alphabook_run_id": sys.argv[9] or None,
    "archive_prefix": sys.argv[10] or None,
    "workflow": "design_experiment",
    "state": "launching",
}
for path in (Path(sys.argv[1]), Path(sys.argv[2])):
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

python3 - "$attempt_manifest_file" "$wrapper_run_dir" "$attempt_dir" "$attempt_id" "$timestamp" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "wrapper_run_dir": sys.argv[1],
    "attempt_dir": sys.argv[2],
    "attempt_id": sys.argv[3],
    "created_at": sys.argv[4],
    "logs_dir": str(Path(sys.argv[2]) / "logs"),
    "runtime_dir": str(Path(sys.argv[2]) / "runtime"),
    "codex_home": str(Path(sys.argv[2]) / "codex-home"),
}
Path(sys.argv[1]).joinpath("attempts", sys.argv[3], "attempt.json").write_text(json.dumps(payload, indent=2) + "\n")
PY

python3 - "$inner_run_dir/manifest.json" "$inner_run_dir/status.json" "$inner_run_dir/run.log" "$USER_PROMPT" "$timestamp" "$run_id" "$CORPUS_ROOT" <<'PY'
from pathlib import Path
import json
import sys

manifest = {
    "run_id": sys.argv[6],
    "timestamp": sys.argv[5],
    "user_prompt": sys.argv[4],
    "corpus_root": sys.argv[7],
    "status": "running",
    "workflow": "design_experiment",
    "output_file_list": [
        str(Path(sys.argv[1])),
        str(Path(sys.argv[2])),
        str(Path(sys.argv[3])),
    ],
}
Path(sys.argv[1]).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
Path(sys.argv[2]).write_text(json.dumps({
    "phase": "launching",
    "status": "running",
    "attempt": 0,
}, indent=2) + "\n", encoding="utf-8")
Path(sys.argv[3]).write_text("", encoding="utf-8")
PY

cat >"$wrapper_run_dir/run-codex-experiment.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

write_status() {
  python3 - "$STATUS_FILE" "$SUMMARY_FILE" "$INNER_STATUS_FILE" "$1" "$2" "$3" "$4" "$5" <<'PY'
from pathlib import Path
import json
import sys

status_path = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
inner_path = Path(sys.argv[3])
state = sys.argv[4]
phase = sys.argv[5]
attempt = int(sys.argv[6])
detail = sys.argv[7]
finished_at = sys.argv[8]

wrapper = json.loads(status_path.read_text(encoding="utf-8"))
wrapper["state"] = state
wrapper["phase"] = phase
wrapper["attempt"] = attempt
wrapper["detail"] = detail or None
if finished_at:
    wrapper["finished_at"] = finished_at
for path in (status_path, summary_path):
    path.write_text(json.dumps(wrapper, indent=2) + "\n", encoding="utf-8")

inner = {}
if inner_path.exists():
    try:
        inner = json.loads(inner_path.read_text(encoding="utf-8"))
    except Exception:
        inner = {}
inner["status"] = "completed" if state == "completed" else ("failed" if state == "failed" else "running")
inner["phase"] = phase
inner["attempt"] = attempt
inner["detail"] = detail or None
if finished_at:
    inner["finished_at"] = finished_at
inner_path.write_text(json.dumps(inner, indent=2) + "\n", encoding="utf-8")
PY
}

build_prompt() {
  python3 - "$1" "$USER_PROMPT_FILE" "$INNER_RUN_DIR" "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR" "$ATTEMPT_NUMBER" "$VALIDATOR_REPORT" "$ROOT_DIR" <<'PY'
from pathlib import Path
import json
import sys

prompt_path = Path(sys.argv[1])
user_prompt = Path(sys.argv[2]).read_text(encoding="utf-8").strip()
run_dir = Path(sys.argv[3])
corpus_root = sys.argv[4]
index_dir = sys.argv[5]
attempt_number = int(sys.argv[6])
validator_report_path = Path(sys.argv[7]) if sys.argv[7] else None
root_dir = sys.argv[8]

validator_report = None
if validator_report_path and validator_report_path.exists():
    try:
        validator_report = json.loads(validator_report_path.read_text(encoding="utf-8"))
    except Exception:
        validator_report = None

base = f"""You are running an AlphaBook corpus experiment inside a prepared Codex workspace on a DigitalOcean droplet.

Work only inside this experiment directory:
- {run_dir}

Available corpus resources:
- raw corpus root: {corpus_root}
- searchable text manifest: {index_dir}/all-text-files.tsv
- metadata lookup table: {index_dir}/metadata-table.jsonl
- repo helpers: {root_dir}/ops/digitalocean/bin

Original user request:

<USER_EXPERIMENT_PROMPT>
{user_prompt}
</USER_EXPERIMENT_PROMPT>

Execution model:
- You are the execution engine, not just a planner.
- Use Codex sub-agents when they materially help bounded parts of the work.
- Search broadly enough to answer the question, but keep the run inspectable and finishable.
- Labeling is optional. Use it only when the question truly needs quantitative classification.
- Prefer the lightest method that can answer the question well.

Important constraints:
- Do not browse the internet.
- Keep all artifacts in this directory.
- Update run.log as you make progress.
- Reuse existing files in this directory instead of restarting from scratch.
- If earlier attempts already produced useful evidence, build on it.
- For broad lexical search over the corpus, use the provided text manifest and helper scripts rather than one giant unbounded grep.
- When the question can be answered qualitatively, you do not need to force a large labeling dataset.

Required artifacts for this run:
- {run_dir / "manifest.json"}
- {run_dir / "run.log"}
- {run_dir / "experiment-plan.md"}
- {run_dir / "results.json"}
- At least one evidence artifact:
  - {run_dir / "evidence" / "index.json"}
  - {run_dir / "dataset.jsonl"}
  - {run_dir / "dataset.csv"}
  - {run_dir / "labels.jsonl"} (optional but valid as evidence if you choose labeling)

Artifact requirements:
- experiment-plan.md:
  - concise scope
  - method
  - whether labeling is used
  - what evidence you collected
- results.json:
  - valid JSON object
  - include question, method, findings, and artifacts
- evidence/index.json if present:
  - valid JSON list or object describing the kept evidence used in the answer

When you cite sources, prefer exact AlphaBook reader links whenever you can resolve them from available metadata.

If the experiment question is mostly qualitative:
- it is acceptable to produce a qualitative comparison with representative evidence and only light counting.

If the experiment question truly requires counting or comparison:
- create a lightweight structured results file and explain the counting method and limits clearly.

Finish only when the required artifacts exist with real content.
"""

if attempt_number > 1:
    continuation = [
        "",
        f"This is continuation attempt {attempt_number}.",
        "Do not restart the experiment. Inspect the existing files and continue from where the previous attempt stopped.",
    ]
    if isinstance(validator_report, dict):
        continuation.extend([
            "",
            "The validator reported these missing artifacts or issues:",
            json.dumps(validator_report, indent=2),
            "",
            "Your job is to fix the missing pieces and complete the same run directory.",
        ])
    prompt = base + "\n".join(continuation) + "\n"
else:
    prompt = base + "\nStart by deciding the smallest robust method that can answer the question, then execute it.\n"

prompt_path.write_text(prompt, encoding="utf-8")
PY
}

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
VALIDATOR="$ROOT_DIR/ops/digitalocean/bin/validate-design-experiment.py"
SYNTHESIS_SCRIPT="$ROOT_DIR/ops/digitalocean/bin/run-codex-experiment-synthesis.sh"
LAST_MESSAGE_FILE="$INNER_RUN_DIR/last-message.txt"
FINAL_ANSWER_MD="$INNER_RUN_DIR/final-answer.md"
FINAL_ANSWER_JSON="$INNER_RUN_DIR/final-answer.json"
EVENTS_LOG="$STDOUT_LOG"
VALIDATOR_REPORT=""
touch "$EVENTS_LOG" "$STDERR_LOG" "$RUN_LOG"

finalize_wrapper() {
  local exit_code="$1"
  local archive_script="$ROOT_DIR/ops/digitalocean/bin/archive-hermes-run.mjs"
  local materialize_script="$ROOT_DIR/ops/digitalocean/bin/materialize-hermes-run-index.py"
  if [[ -x "$materialize_script" ]]; then
    python3 "$materialize_script" --run-dir "$WRAPPER_RUN_DIR" >>"$STDOUT_LOG" 2>>"$STDERR_LOG" || true
  fi
  if [[ -n "${ARCHIVE_PREFIX:-}" && -n "${ALPHABOOK_SESSION_ID:-}" && -n "${ALPHABOOK_RUN_ID:-}" && -x "$archive_script" ]]; then
    local -a archive_args=(
      --run-dir "$WRAPPER_RUN_DIR"
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
  return "$exit_code"
}

write_status "running" "starting" 0 "Launching Codex experiment." ""

attempt=1
while [[ "$attempt" -le "$MAX_ATTEMPTS" ]]; do
  ATTEMPT_NUMBER="$attempt"
  attempt_prefix="$(printf 'attempt-%04d' "$attempt")"
  attempt_prompt="$INNER_RUN_DIR/${attempt_prefix}.prompt.md"
  validator_report_path="$INNER_RUN_DIR/${attempt_prefix}.validator.json"
  VALIDATOR_REPORT="$validator_report_path"
  build_prompt "$attempt_prompt"

  printf '%s attempt=%s codex_started\n' "$(date -u +%FT%TZ)" "$attempt" >>"$PROCESS_LOG"
  write_status "running" "codex_attempt" "$attempt" "Running Codex attempt $attempt." ""

  set +e
  (
    cd "$INNER_RUN_DIR"
    export HOME="$CODEX_HOME"
    export OPENAI_BASE_URL="http://127.0.0.1:8790/runs/$JOB_ID/v1"
    export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
    codex -a never exec \
      -s danger-full-access \
      --color never \
      --json \
      --cd "$INNER_RUN_DIR" \
      --skip-git-repo-check \
      --output-last-message "$LAST_MESSAGE_FILE" \
      --add-dir "$INNER_RUN_DIR" \
      --add-dir "$ROOT_DIR" \
      --add-dir "$PRECOMPUTED_INDEX_DIR" \
      --model "$MODEL" \
      - <"$attempt_prompt" >>"$EVENTS_LOG" 2>>"$STDERR_LOG"
  )
  codex_exit=$?
  set -e
  printf '%s attempt=%s codex_exited exit_code=%s\n' "$(date -u +%FT%TZ)" "$attempt" "$codex_exit" >>"$PROCESS_LOG"
  if [[ "$codex_exit" -ne 0 ]]; then
    write_status "running" "attempt_failed" "$attempt" "Codex exited with code $codex_exit." ""
  fi

  python3 "$VALIDATOR" --run-dir "$INNER_RUN_DIR" >"$validator_report_path"
  validator_ok="$(python3 - "$validator_report_path" <<'PY'
from pathlib import Path
import json
import sys
payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print("true" if payload.get("ok") else "false")
PY
)"

  if [[ "$validator_ok" == "true" ]]; then
    write_status "running" "synthesizing" "$attempt" "Writing final experiment synthesis." ""
    printf '%s attempt=%s synthesis_started\n' "$(date -u +%FT%TZ)" "$attempt" >>"$PROCESS_LOG"
    "$SYNTHESIS_SCRIPT" \
      --inner-run-dir "$INNER_RUN_DIR" \
      --job-id "$JOB_ID-synthesis" \
      --model "$MODEL" \
      --root-dir "$ROOT_DIR" \
      --user-prompt-file "$USER_PROMPT_FILE" >>"$STDOUT_LOG" 2>>"$STDERR_LOG"
    printf '%s attempt=%s synthesis_completed\n' "$(date -u +%FT%TZ)" "$attempt" >>"$PROCESS_LOG"

    python3 - "$INNER_RUN_DIR/manifest.json" "$FINAL_ANSWER_MD" "$FINAL_ANSWER_JSON" "$INNER_RUN_DIR/results.json" "$INNER_RUN_DIR/experiment-plan.md" "$INNER_RUN_DIR/evidence/index.json" "$INNER_RUN_DIR/dataset.jsonl" "$INNER_RUN_DIR/dataset.csv" "$INNER_RUN_DIR/labels.jsonl" <<'PY'
from pathlib import Path
import json
import sys

manifest_path = Path(sys.argv[1])
manifest = {}
try:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
except Exception:
    manifest = {}
output_file_list = manifest.get("output_file_list")
if not isinstance(output_file_list, list):
    output_file_list = []
for candidate in sys.argv[2:]:
    path = Path(candidate)
    if path.exists() and str(path) not in output_file_list:
        output_file_list.append(str(path))
manifest["output_file_list"] = output_file_list
manifest["status"] = "completed"
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
    write_status "completed" "completed" "$attempt" "Experiment completed successfully." "$(date -u +%FT%TZ)"
    finalize_wrapper 0
    exit 0
  fi

  if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
    printf '%s attempt=%s validator_retry\n' "$(date -u +%FT%TZ)" "$attempt" >>"$PROCESS_LOG"
    write_status "running" "validator_retry" "$attempt" "Validator requested a continuation attempt." ""
  fi
  attempt=$((attempt + 1))
done

python3 - "$INNER_RUN_DIR/manifest.json" <<'PY'
from pathlib import Path
import json
import sys

manifest_path = Path(sys.argv[1])
try:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
except Exception:
    manifest = {}
manifest["status"] = "failed"
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
write_status "failed" "failed_validation" "$MAX_ATTEMPTS" "Experiment did not satisfy the validator after the maximum number of attempts." "$(date -u +%FT%TZ)"
finalize_wrapper 1
exit 1
EOS
chmod +x "$wrapper_run_dir/run-codex-experiment.sh"

{
  echo "timestamp=$timestamp"
  echo "run_id=$run_id"
  echo "job_id=$job_id"
  echo "wrapper_run_dir=$wrapper_run_dir"
  echo "inner_run_dir=$inner_run_dir"
  echo "root_dir=$ROOT_DIR"
  echo "corpus_root=$CORPUS_ROOT"
  echo "precomputed_index_dir=$PRECOMPUTED_INDEX_DIR"
  echo "model=$MODEL"
  echo "alphabook_session_id=$ALPHABOOK_SESSION_ID"
  echo "alphabook_run_id=$ALPHABOOK_RUN_ID"
  echo "archive_prefix=$ARCHIVE_PREFIX"
} >"$launcher_log"

(
  cd "$ROOT_DIR"
  export PATH="$HOME/.local/bin:$PATH"
  export ROOT_DIR
  export MODEL
  export MAX_ATTEMPTS
  export USER_PROMPT_FILE="$prompt_file"
  export INNER_RUN_DIR="$inner_run_dir"
  export PRECOMPUTED_INDEX_DIR="$PRECOMPUTED_INDEX_DIR"
  export CORPUS_ROOT="$CORPUS_ROOT"
  export RUN_LOG="$inner_run_dir/run.log"
  export STATUS_FILE="$status_file"
  export SUMMARY_FILE="$summary_file"
  export INNER_STATUS_FILE="$inner_run_dir/status.json"
  export STDOUT_LOG="$stdout_log"
  export STDERR_LOG="$stderr_log"
  export PROCESS_LOG="$process_log"
  export CODEX_HOME="$codex_home"
  export JOB_ID="$job_id"
  export CALLBACK_URL="$CALLBACK_URL"
  export CALLBACK_TOKEN="$CALLBACK_TOKEN"
  export ARCHIVE_PREFIX="$ARCHIVE_PREFIX"
  export ALPHABOOK_SESSION_ID="$ALPHABOOK_SESSION_ID"
  export ALPHABOOK_RUN_ID="$ALPHABOOK_RUN_ID"
  export WRAPPER_RUN_DIR="$wrapper_run_dir"
  nohup "$wrapper_run_dir/run-codex-experiment.sh" >>"$launcher_log" 2>&1 &
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
  printf '%s pid=%s exited attempt=%s\n' "$(date -u +%FT%TZ)" "$pid" "$attempt_id" >>"$process_log"
) >/dev/null 2>&1 &
echo $! >"$watcher_pid_file"

materialize_script="$ROOT_DIR/ops/digitalocean/bin/materialize-hermes-run-index.py"
if [[ -x "$materialize_script" ]]; then
  (
    while kill -0 "$pid" 2>/dev/null; do
      python3 "$materialize_script" --run-dir "$wrapper_run_dir" >/dev/null 2>&1 || true
      sleep "$HEARTBEAT_SECONDS"
    done
    python3 "$materialize_script" --run-dir "$wrapper_run_dir" >/dev/null 2>&1 || true
  ) >/dev/null 2>&1 &
fi

python3 - "$status_file" "$pid" "$wrapper_run_dir" "$inner_run_dir" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
data["state"] = "running"
data["pid"] = int(sys.argv[2])
data["run_dir"] = sys.argv[3]
data["inner_run_dir"] = sys.argv[4]
data["inner_run_id"] = Path(sys.argv[4]).name
data["launched_at"] = sys.argv[5]
data["index_file"] = str(Path(sys.argv[3]) / "index.json")
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

echo "$wrapper_run_dir"
