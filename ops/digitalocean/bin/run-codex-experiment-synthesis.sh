#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
INNER_RUN_DIR=""
JOB_ID=""
MODEL="${MODEL:-gpt-5.4}"
USER_PROMPT_FILE=""
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
FALLBACK_ENV_FILE="${FALLBACK_ENV_FILE:-/srv/alphabook/.ingest.env}"

usage() {
  cat >&2 <<'EOF'
Usage: run-codex-experiment-synthesis.sh \
  --inner-run-dir /srv/alphabook/logs/corpus-research/<run-id> \
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

if [[ -f "$ENV_FILE" ]]; then
  export OPENAI_API_KEY="${OPENAI_API_KEY:-$(load_env_value "$ENV_FILE" "OPENAI_API_KEY")}"
fi
if [[ -z "${OPENAI_API_KEY:-}" && -f "$FALLBACK_ENV_FILE" ]]; then
  export OPENAI_API_KEY="$(load_env_value "$FALLBACK_ENV_FILE" "OPENAI_API_KEY")"
fi
[[ -n "${OPENAI_API_KEY:-}" ]] || { echo "OPENAI_API_KEY is not available from $ENV_FILE or $FALLBACK_ENV_FILE" >&2; exit 1; }

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

dataset_jsonl = inner_run_dir / "dataset.jsonl"
dataset_csv = inner_run_dir / "dataset.csv"
results_json = inner_run_dir / "results.json"
briefing_md = inner_run_dir / "briefing.md"
citation_index = inner_run_dir / "citation-index.json"
evidence_index = inner_run_dir / "evidence" / "index.json"
manifest_path = inner_run_dir / "manifest.json"
run_log = inner_run_dir / "run.log"

prompt = f"""You are writing the final user-facing synthesis for a completed AlphaBook experiment run.

You are already inside the experiment outputs directory:
- run directory: {inner_run_dir}

Original user request:

<USER_EXPERIMENT_PROMPT>
{user_prompt}
</USER_EXPERIMENT_PROMPT>

Available local artifacts:
- manifest: {manifest_path}
- run log: {run_log}
- experiment plan: {inner_run_dir / "experiment-plan.md"}
- results: {results_json}
- briefing: {briefing_md}
- dataset jsonl: {dataset_jsonl}
- dataset csv: {dataset_csv}
- citation index: {citation_index}
- evidence index: {evidence_index}
- labels: {inner_run_dir / "labels.jsonl"}

Hard requirements:
- Do not rerun the experiment.
- Do not launch additional retrieval or labeling.
- Work only from the existing files in this directory.
- Read the dataset/results/briefing artifacts and synthesize a direct answer to the user's question.
- Prefer a compact, high-signal answer over a methods dump.
- Ground every substantive claim in the collected records.
- Use representative examples, not just counts.
- If the evidence is mixed or limited, say that clearly.
- If any record/citation metadata includes `alphabook_url`, cite with a markdown link to that AlphaBook reader URL.
- Also include the local artifact reference for auditability, for example `(dataset.jsonl)` or `(citation-index.json)`.

Style guide:
- Voice: synthesize intellectual rigor with gleeful provocation. Write like someone who genuinely loves ideas and equally loves watching them get weird, uncomfortable, or self-defeating. Default to confident curiosity, not academic hedging.
- Sentence architecture: open with the sharpest declarative claim first, then unpack it. Vary sentence length aggressively: long build, short punch. Build paragraphs by stating the thesis, complicating it, giving examples, then landing a conclusion that is more right, more wrong, or weirder than expected.
- Point of view: use "I" for judgments, conclusions, and reactions when staking a position. Use "you" for thought experiments or procedures. Use "we" only for genuinely shared epistemic situations.
- Punctuation: use em dashes for interruptions that stay on track, parenthetical asides only for genuinely secondary material, rhetorical questions sparingly at moments of maximum tension, and colons to introduce evidence, examples, or quotations without filler transitions.
- Vocabulary: prefer precision over impressiveness. Use technical terms when they are the right terms, plain language when it hits harder, and active verbs with attitude. Avoid vague corporate verbs like utilize, leverage, or explore.
- Metaphors and analogies: draw from medicine, physics experiments, legal proceedings, and everyday mechanical processes. Keep metaphors rigorous enough to cash out.
- Tone: stay amused by how ideas deform under pressure, but say directly when something is impressive or alarming. Humor should stay dry and embedded in the reasoning, not bolted on as performance.
- Assertions: when uncertain, assert with ownership using "I think," "my impression is," or "I predict." Do not hedge with phrases like "it could be argued" or "one might suggest." Own the claim or drop it.
- Formatting: use numbered lists and block quotations as breathing room inside argumentative prose when helpful, then resume the argument immediately. Use lots of direct quotation and raw source material when the evidence supports it.
- Non-negotiables: never bury the point at the end of a clause when it can go at the front, and never dilute a clear conclusion into generic synthesis.

Write these required outputs:
1. {final_answer_md}
2. {final_answer_json}

`final-answer.md` requirements:
- Open with a direct answer in prose.
- Then include short sections:
  - `## Main Finding`
  - `## Representative Evidence`
  - `## Method And Limits`
- Keep it readable by a product user, not a research engineer.
- Prefer clickable AlphaBook reader links inline when available.

`final-answer.json` requirements:
- Valid JSON object with keys:
  - `user_prompt`
  - `answer`
  - `main_finding`
  - `representative_evidence`
  - `method_and_limits`
  - `citations`
- `representative_evidence` should be an array of objects with:
  - `title`
  - `author`
  - `label`
  - `point`
  - `citation`
- `citations` should be an array of objects with:
  - `title`
  - `source`
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
        output_file_list = manifest.get("output_file_list")
        if not isinstance(output_file_list, list):
            output_file_list = []
        for candidate in (final_answer_md, final_answer_json, status_path, summary_path):
            if candidate.exists() and str(candidate) not in output_file_list:
                output_file_list.append(str(candidate))
        manifest["output_file_list"] = output_file_list
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

if last_message_file.exists():
    finished_message = last_message_file.read_text(encoding="utf-8").strip()
else:
    finished_message = ""
if run_log_path.exists():
    with run_log_path.open("a", encoding="utf-8") as handle:
        if finished_message:
            handle.write(f"[{finished_at}] {finished_message}\n")
        elif exit_code == 0:
            handle.write(f"[{finished_at}] Codex synthesis wrote final-answer.md and final-answer.json\n")
        else:
            handle.write(f"[{finished_at}] Codex synthesis failed with exit code {exit_code}\n")
PY

if [[ "$exit_code" -ne 0 ]]; then
  echo "Codex experiment synthesis failed with exit code $exit_code" >&2
  exit "$exit_code"
fi

[[ -s "$final_answer_md" ]] || { echo "Missing final-answer.md after synthesis" >&2; exit 1; }
[[ -s "$final_answer_json" ]] || { echo "Missing final-answer.json after synthesis" >&2; exit 1; }
