#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
RUN_DIR=""
CHUNK_DIR=""
CHUNK_ID=""
JOB_ID=""
MODEL="${MODEL:-gpt-5.4}"
USER_PROMPT_FILE=""
SCOPE_FILE_LIST=""
CORPUS_ROOT="${CORPUS_ROOT:-/srv/alphabook/gutenberg}"
PRECOMPUTED_INDEX_DIR="${PRECOMPUTED_INDEX_DIR:-}"

usage() {
  cat >&2 <<'EOF'
Usage: run-codex-corpus-research-chunk.sh \
  --run-dir /srv/alphabook/logs/codex-corpus-research/<run-id> \
  --chunk-dir /srv/alphabook/logs/codex-corpus-research/<run-id>/chunks/chunk-00001 \
  --chunk-id chunk-00001 \
  --job-id <wrapper-job-id>-chunk-00001 \
  --user-prompt-file /path/to/prompt.txt \
  --scope-file-list /path/to/chunk.scope.tsv
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      ;;
    --run-dir)
      RUN_DIR="$2"
      shift 2
      ;;
    --chunk-dir)
      CHUNK_DIR="$2"
      shift 2
      ;;
    --chunk-id)
      CHUNK_ID="$2"
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
    --scope-file-list)
      SCOPE_FILE_LIST="$2"
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
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$RUN_DIR" && -n "$CHUNK_DIR" && -n "$CHUNK_ID" && -n "$JOB_ID" && -n "$USER_PROMPT_FILE" && -n "$SCOPE_FILE_LIST" ]] || usage
[[ -d "$ROOT_DIR" ]] || { echo "Missing repo root: $ROOT_DIR" >&2; exit 1; }
[[ -f "$USER_PROMPT_FILE" ]] || { echo "Missing user prompt file: $USER_PROMPT_FILE" >&2; exit 1; }
[[ -f "$SCOPE_FILE_LIST" ]] || { echo "Missing scope file list: $SCOPE_FILE_LIST" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "Missing codex CLI on PATH" >&2; exit 1; }

mkdir -p "$CHUNK_DIR/logs" "$CHUNK_DIR/runtime" "$CHUNK_DIR/artifacts" "$CHUNK_DIR/codex-home/.codex" "$CHUNK_DIR/openai-proxy"

prompt_file="$CHUNK_DIR/prompt.txt"
status_file="$CHUNK_DIR/status.json"
summary_file="$CHUNK_DIR/summary.json"
launcher_log="$CHUNK_DIR/logs/launcher.log"
events_log="$CHUNK_DIR/logs/codex-events.jsonl"
stderr_log="$CHUNK_DIR/logs/codex.stderr.log"
heartbeat_log="$CHUNK_DIR/logs/heartbeat.log"
process_log="$CHUNK_DIR/logs/process.log"
pid_file="$CHUNK_DIR/runtime/codex.pid"
last_message_file="$CHUNK_DIR/last-message.txt"
artifacts_dir="$CHUNK_DIR/artifacts"
codex_home="$CHUNK_DIR/codex-home"

ln -sfn "logs/launcher.log" "$CHUNK_DIR/launcher.log"
ln -sfn "logs/codex-events.jsonl" "$CHUNK_DIR/codex-events.jsonl"
ln -sfn "logs/codex.stderr.log" "$CHUNK_DIR/codex.stderr.log"
ln -sfn "logs/heartbeat.log" "$CHUNK_DIR/heartbeat.log"
ln -sfn "logs/process.log" "$CHUNK_DIR/process.log"
ln -sfn "runtime/codex.pid" "$CHUNK_DIR/codex.pid"

scope_file_count="$(
  awk -F '\t' '
    NF >= 2 && $1 ~ /^[0-9]+$/ && $2 != "absolute_path" { count += 1 }
    END { print count + 0 }
  ' "$SCOPE_FILE_LIST"
)"
scope_total_bytes="$(
  awk -F '\t' '
    NF >= 2 && $1 ~ /^[0-9]+$/ && $2 != "absolute_path" { bytes += $1 }
    END { print bytes + 0 }
  ' "$SCOPE_FILE_LIST"
)"

python3 - "$prompt_file" "$USER_PROMPT_FILE" "$RUN_DIR" "$CHUNK_ID" "$JOB_ID" "$SCOPE_FILE_LIST" "$scope_file_count" "$scope_total_bytes" "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR" "$artifacts_dir" <<'PY'
from pathlib import Path
import sys

prompt_path = Path(sys.argv[1])
user_prompt = Path(sys.argv[2]).read_text(encoding="utf-8")
run_dir = sys.argv[3]
chunk_id = sys.argv[4]
job_id = sys.argv[5]
scope_file = sys.argv[6]
scope_count = sys.argv[7]
scope_bytes = sys.argv[8]
corpus_root = sys.argv[9]
precomputed_index_dir = sys.argv[10]
artifacts_dir = sys.argv[11]

prompt = f"""You are running one bounded shard of an AlphaBook corpus research job on a DigitalOcean droplet.

Original user research request:

<USER_RESEARCH_PROMPT>
{user_prompt.rstrip()}
</USER_RESEARCH_PROMPT>

This shard must execute that same request, but only for the files in this exact TSV:
- {scope_file}

Shard contract:
- shard id: {chunk_id}
- proxy run id: {job_id}
- wrapper run dir: {run_dir}
- scope file count: {scope_count}
- scope total bytes: {scope_bytes}
- corpus root: {corpus_root}
- precomputed index dir: {precomputed_index_dir}
- output dir: {artifacts_dir}

Hard requirements:
- Treat the TSV above as the full and only allowed corpus scope for the main search.
- Do not expand to the full corpus, regenerate manifests, or search outside this shard TSV for primary retrieval.
- Write every research artifact under {artifacts_dir}.
- Keep the run inspectable. Persist intermediate search outputs instead of relying on terminal scrollback.
- Use /srv/alphabook/repo/ops/digitalocean/bin/run-ripgrep-progress.sh for corpus search and pass:
  - --file-list "{scope_file}"
  - --max-total-files 5000
  - --batch-size 500
- Search raw text only.
- Never invoke the ripgrep helper on more than the shard TSV.
- Use ripgrep only for retrieval and candidate gathering. Relevance triage, keep/discard decisions, theme labeling, and synthesis must be done with model judgment over local context.
- Do not use hard-coded quote scoring, regex-weight scoring, static relevance formulas, top-N ranking scripts, or deterministic keyword-based triage as the decision-maker.
- Do not impose arbitrary hard caps like "top 700 files", "top 36 records", "max 3 quotes per file", or "max 8 per theme". Coverage should be driven by the shard evidence, not fixed caps.
- Do not generate a Python or TypeScript script whose job is to mechanically score quotes or mechanically decide relevance from hand-written weights or thresholds.
- If you write helper scripts, limit them to parsing, batching, deduplication, artifact assembly, and ledger/progress tracking. The actual research judgment must remain model-authored.
- Review the shard evidence progressively in batches until you have covered the shard's candidate material. Maintain an inspectable reviewed ledger or notes if needed, but do not shortcut coverage with deterministic ranking heuristics.
- When candidate volume is large, batch the candidate passages and evaluate them with the model against the user request using local context windows from the source text.

Required outputs under {artifacts_dir}:
- manifest.json
- run.log
- dataset.jsonl
- dataset.csv
- citation-index.json
- briefing.md
- summary.json
- search/...

Required manifest fields:
- shard_id
- proxy_run_id
- wrapper_run_dir
- user_prompt
- scope_file_list
- scope_file_count
- scope_total_bytes
- search_strategy_summary
- schema_summary
- output_file_list
- record_counts
- status

Quality bar:
- This is not a quick grep dump.
- Build a real structured dataset from this shard.
- Every kept quote needs provenance and a short reasoning field.
- The briefing must synthesize the shard-level findings and caveats.
- The kept dataset must reflect LLM-reviewed passages, not deterministic score thresholds.
- If you exclude a large candidate subset, explain the exclusion rule in model-authored prose in the manifest/run log rather than hiding it behind a numeric heuristic.

At the end:
- Print the shard artifacts directory path.
- Print a short summary with the searched file count, kept record count, and main output files.
"""
prompt_path.write_text(prompt, encoding="utf-8")
PY

python3 - "$status_file" "$summary_file" "$RUN_DIR" "$CHUNK_DIR" "$CHUNK_ID" "$JOB_ID" "$MODEL" "$SCOPE_FILE_LIST" "$scope_file_count" "$scope_total_bytes" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "wrapper_run_dir": sys.argv[3],
    "chunk_dir": sys.argv[4],
    "chunk_id": sys.argv[5],
    "job_id": sys.argv[6],
    "model": sys.argv[7],
    "scope_file_list": sys.argv[8],
    "scope_file_count": int(sys.argv[9]),
    "scope_total_bytes": int(sys.argv[10]),
    "state": "launching",
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
Path(sys.argv[2]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

{
  echo "run_dir=$RUN_DIR"
  echo "chunk_dir=$CHUNK_DIR"
  echo "chunk_id=$CHUNK_ID"
  echo "job_id=$JOB_ID"
  echo "model=$MODEL"
  echo "scope_file_list=$SCOPE_FILE_LIST"
  echo "scope_file_count=$scope_file_count"
  echo "scope_total_bytes=$scope_total_bytes"
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
  cd "$ROOT_DIR"
  export HOME="$codex_home"
  export OPENAI_BASE_URL="http://127.0.0.1:8790/runs/$JOB_ID/v1"
  export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
  export R2_BUCKET_NAME="${R2_BUCKET_NAME:-}"
  export R2_ENDPOINT="${R2_ENDPOINT:-}"
  export R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
  export R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
  export ALPHABOOK_CODEX_CHUNK_DIR="$CHUNK_DIR"
  export ALPHABOOK_CODEX_ARTIFACTS_DIR="$artifacts_dir"
  export ALPHABOOK_CODEX_SCOPE_FILE_LIST="$SCOPE_FILE_LIST"
  codex -a never exec \
    -s danger-full-access \
    --color never \
    --json \
    --cd "$ROOT_DIR" \
    --skip-git-repo-check \
    --output-last-message "$last_message_file" \
    --add-dir "$CHUNK_DIR" \
    --add-dir "$CORPUS_ROOT" \
    --add-dir "$PRECOMPUTED_INDEX_DIR" \
    --model "$MODEL" \
    - <"$prompt_file" >>"$events_log" 2>>"$stderr_log"
) &
codex_pid=$!
echo "$codex_pid" >"$pid_file"
printf '%s pid=%s shard=%s started\n' "$(date -u +%FT%TZ)" "$codex_pid" "$CHUNK_ID" >>"$process_log"

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

python3 - "$status_file" "$summary_file" "$exit_code" "$(date -u +%FT%TZ)" "$last_message_file" "$artifacts_dir" <<'PY'
from pathlib import Path
import json
import sys

status_path = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
exit_code = int(sys.argv[3])
finished_at = sys.argv[4]
last_message_file = Path(sys.argv[5])
artifacts_dir = Path(sys.argv[6])

payload = json.loads(status_path.read_text(encoding="utf-8"))
payload["finished_at"] = finished_at
payload["exit_code"] = exit_code
payload["state"] = "completed" if exit_code == 0 else "failed"
payload["last_message_file"] = str(last_message_file)
payload["artifacts_dir"] = str(artifacts_dir)

artifact_files = []
if artifacts_dir.exists():
    for path in sorted(artifacts_dir.rglob("*")):
        if path.is_file():
            artifact_files.append(str(path))
payload["artifact_file_count"] = len(artifact_files)
payload["artifact_files"] = artifact_files[:128]

for target in (status_path, summary_path):
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

printf '%s pid=%s shard=%s exit_code=%s\n' "$(date -u +%FT%TZ)" "$(cat "$pid_file")" "$CHUNK_ID" "$exit_code" >>"$process_log"
exit "$exit_code"
