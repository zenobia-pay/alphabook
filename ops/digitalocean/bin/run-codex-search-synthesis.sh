#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
INNER_RUN_DIR=""
JOB_ID=""
MODEL="${MODEL:-gpt-5.4}"
USER_PROMPT_FILE=""

usage() {
  cat >&2 <<'EOF'
Usage: run-codex-search-synthesis.sh \
  --inner-run-dir /srv/alphabook/logs/corpus-search/<run-id> \
  --job-id <wrapper-job-id>-synthesis \
  --user-prompt-file /path/to/prompt.txt
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      ;;
    --inner-run-dir)
      INNER_RUN_DIR="$2"
      shift 2
      ;;
    --job-id)
      JOB_ID="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --root-dir)
      ROOT_DIR="$2"
      shift 2
      ;;
    --user-prompt-file)
      USER_PROMPT_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$INNER_RUN_DIR" && -n "$JOB_ID" && -n "$USER_PROMPT_FILE" ]] || usage
[[ -d "$ROOT_DIR" ]] || { echo "Missing repo root: $ROOT_DIR" >&2; exit 1; }
[[ -d "$INNER_RUN_DIR" ]] || { echo "Missing inner run dir: $INNER_RUN_DIR" >&2; exit 1; }
[[ -f "$USER_PROMPT_FILE" ]] || { echo "Missing user prompt file: $USER_PROMPT_FILE" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "Missing codex CLI on PATH" >&2; exit 1; }

mkdir -p "$INNER_RUN_DIR/synthesis/logs" "$INNER_RUN_DIR/synthesis/runtime" "$INNER_RUN_DIR/synthesis/codex-home/.codex"

prompt_file="$INNER_RUN_DIR/synthesis/prompt.txt"
status_file="$INNER_RUN_DIR/synthesis/status.json"
summary_file="$INNER_RUN_DIR/synthesis/summary.json"
launcher_log="$INNER_RUN_DIR/synthesis/logs/launcher.log"
events_log="$INNER_RUN_DIR/synthesis/logs/codex-events.jsonl"
stderr_log="$INNER_RUN_DIR/synthesis/logs/codex.stderr.log"
heartbeat_log="$INNER_RUN_DIR/synthesis/logs/heartbeat.log"
process_log="$INNER_RUN_DIR/synthesis/logs/process.log"
pid_file="$INNER_RUN_DIR/synthesis/runtime/codex.pid"
last_message_file="$INNER_RUN_DIR/synthesis/last-message.txt"
codex_home="$INNER_RUN_DIR/synthesis/codex-home"
final_answer_md="$INNER_RUN_DIR/final-answer.md"
final_answer_json="$INNER_RUN_DIR/final-answer.json"

python3 - "$prompt_file" "$USER_PROMPT_FILE" "$INNER_RUN_DIR" "$final_answer_md" "$final_answer_json" <<'PY'
from pathlib import Path
import sys

prompt_path = Path(sys.argv[1])
user_prompt = Path(sys.argv[2]).read_text(encoding="utf-8").strip()
inner_run_dir = Path(sys.argv[3])
final_answer_md = Path(sys.argv[4])
final_answer_json = Path(sys.argv[5])

scope_report_path = inner_run_dir / "scope-report.json"
scope_report_line = f"- scope report: {scope_report_path}" if scope_report_path.exists() else "- scope report: not present"

prompt = f"""You are writing the final user-facing synthesis for a completed AlphaBook corpus-search run.

You are already inside the run outputs directory:
- run directory: {inner_run_dir}

Original user request:

<USER_RESEARCH_PROMPT>
{user_prompt}
</USER_RESEARCH_PROMPT>

Available local evidence artifacts:
- manifest: {inner_run_dir / "manifest.json"}
- run log: {inner_run_dir / "run.log"}
{scope_report_line}
- hits index: {inner_run_dir / "hits" / "index.json"}
- hit files: {inner_run_dir / "hits"}

Hard requirements:
- Do not rerun retrieval, grep, or corpus-search helpers.
- Work only from the existing run artifacts in this directory.
- Read the hit files and synthesize a direct answer to the user's request.
- Prefer a compact, high-signal answer over a procedural report.
- Use representative examples across the requested scope, not just the first few hits.
- If the evidence supports differences across periods, genres, or patterns, say so clearly.
- Ground every claim in the kept evidence.
- If a hit record includes `alphabook_url`, cite with a markdown link to that AlphaBook reader URL.
- Also include the hit file name for auditability, for example `[Robinson Crusoe](https://alpha-book.org/?view=explore&...) (hits/hit-0001.md)`.
- Do not dump raw file lists as the main answer.

Write these required outputs:
1. {final_answer_md}
2. {final_answer_json}

`final-answer.md` requirements:
- Open with a direct answer in prose.
- Then include short sections:
  - `## Main Patterns`
  - `## Representative Examples`
  - `## Limits`
- Keep it readable by a product user, not an engineer.
- Prefer clickable AlphaBook reader links inline when available, with hit file names as secondary audit references.

`final-answer.json` requirements:
- Valid JSON object with keys:
  - `user_prompt`
  - `answer`
  - `main_patterns`
  - `representative_examples`
  - `limits`
  - `citations`
- `main_patterns` should be an array of strings.
- `representative_examples` should be an array of objects with:
  - `title`
  - `author`
  - `period`
  - `point`
  - `citation`
- `citations` should be an array of objects with:
  - `hit`
  - `title`
  - `alphabook_url`

When finished:
- Print a short confirmation mentioning `final-answer.md` and `final-answer.json`.
"""

prompt_path.write_text(prompt, encoding="utf-8")
PY

python3 - "$status_file" "$summary_file" "$INNER_RUN_DIR" "$JOB_ID" "$MODEL" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "inner_run_dir": sys.argv[3],
    "job_id": sys.argv[4],
    "model": sys.argv[5],
    "state": "launching",
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
Path(sys.argv[2]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

{
  echo "inner_run_dir=$INNER_RUN_DIR"
  echo "job_id=$JOB_ID"
  echo "model=$MODEL"
  echo "started_at=$(date -u +%FT%TZ)"
} >"$launcher_log"

touch "$events_log" "$stderr_log" "$heartbeat_log" "$process_log"

python3 - "$status_file" "running" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
payload = json.loads(path.read_text(encoding="utf-8"))
payload["state"] = sys.argv[2]
payload["started_at"] = sys.argv[3]
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

(
  cd "$INNER_RUN_DIR"
  export HOME="$codex_home"
  export OPENAI_BASE_URL="http://127.0.0.1:8790/runs/$JOB_ID/v1"
  export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
  codex -a never exec \
    -s danger-full-access \
    --color never \
    --json \
    --cd "$INNER_RUN_DIR" \
    --skip-git-repo-check \
    --output-last-message "$last_message_file" \
    --add-dir "$INNER_RUN_DIR" \
    --model "$MODEL" \
    - <"$prompt_file" >>"$events_log" 2>>"$stderr_log"
) &
codex_pid=$!
echo "$codex_pid" >"$pid_file"
printf '%s pid=%s synthesis started\n' "$(date -u +%FT%TZ)" "$codex_pid" >>"$process_log"

(
  while kill -0 "$codex_pid" 2>/dev/null; do
    printf '%s pid=%s alive\n' "$(date -u +%FT%TZ)" "$codex_pid" >>"$heartbeat_log"
    sleep 15
  done
  printf '%s pid=%s exited\n' "$(date -u +%FT%TZ)" "$codex_pid" >>"$heartbeat_log"
) >/dev/null 2>&1 &
heartbeat_pid=$!

set +e
wait "$codex_pid"
exit_code=$?
set -e

wait "$heartbeat_pid" 2>/dev/null || true

python3 - "$status_file" "$summary_file" "$exit_code" "$(date -u +%FT%TZ)" "$last_message_file" "$final_answer_md" "$final_answer_json" "$INNER_RUN_DIR/manifest.json" "$INNER_RUN_DIR/run.log" <<'PY'
from pathlib import Path
import json
import sys

status_path = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
exit_code = int(sys.argv[3])
finished_at = sys.argv[4]
last_message_file = Path(sys.argv[5])
final_answer_md = Path(sys.argv[6])
final_answer_json = Path(sys.argv[7])
manifest_path = Path(sys.argv[8])
run_log_path = Path(sys.argv[9])

payload = json.loads(status_path.read_text(encoding="utf-8"))
payload["finished_at"] = finished_at
payload["exit_code"] = exit_code
payload["state"] = "completed" if exit_code == 0 else "failed"
payload["last_message_file"] = str(last_message_file)
payload["final_answer_md"] = str(final_answer_md) if final_answer_md.exists() else None
payload["final_answer_json"] = str(final_answer_json) if final_answer_json.exists() else None

for target in (status_path, summary_path):
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

if exit_code == 0 and manifest_path.exists():
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        manifest = None
    if isinstance(manifest, dict):
        output_files = manifest.get("output_file_list")
        if not isinstance(output_files, list):
            output_files = []
        existing = {str(item) for item in output_files}
        for path in (final_answer_md, final_answer_json):
            if path.exists() and str(path) not in existing:
                output_files.append(str(path))
        manifest["output_file_list"] = output_files
        manifest["compiled_answer_files"] = [str(path) for path in (final_answer_md, final_answer_json) if path.exists()]
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

if run_log_path.exists():
    with run_log_path.open("a", encoding="utf-8") as handle:
        if exit_code == 0:
            handle.write(f"[{finished_at}] Codex synthesis wrote final-answer.md and final-answer.json\\n")
        else:
            handle.write(f"[{finished_at}] Codex synthesis failed with exit code {exit_code}\\n")
PY

exit "$exit_code"
