#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
RUN_DIR=""
CONSOLIDATOR_DIR=""
JOB_ID=""
MODEL="${MODEL:-gpt-5.4}"
USER_PROMPT_FILE=""

usage() {
  cat >&2 <<'EOF'
Usage: run-codex-corpus-research-consolidator.sh \
  --run-dir /srv/alphabook/logs/codex-corpus-research/<run-id> \
  --consolidator-dir /srv/alphabook/logs/codex-corpus-research/<run-id>/consolidator \
  --job-id <wrapper-job-id>-consolidator \
  --user-prompt-file /path/to/prompt.txt
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
    --consolidator-dir)
      CONSOLIDATOR_DIR="$2"
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

[[ -n "$RUN_DIR" && -n "$CONSOLIDATOR_DIR" && -n "$JOB_ID" && -n "$USER_PROMPT_FILE" ]] || usage
[[ -d "$ROOT_DIR" ]] || { echo "Missing repo root: $ROOT_DIR" >&2; exit 1; }
[[ -f "$USER_PROMPT_FILE" ]] || { echo "Missing user prompt file: $USER_PROMPT_FILE" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "Missing codex CLI on PATH" >&2; exit 1; }

mkdir -p "$CONSOLIDATOR_DIR/logs" "$CONSOLIDATOR_DIR/runtime" "$CONSOLIDATOR_DIR/input" "$CONSOLIDATOR_DIR/artifacts" "$CONSOLIDATOR_DIR/codex-home/.codex" "$CONSOLIDATOR_DIR/openai-proxy"

prompt_file="$CONSOLIDATOR_DIR/prompt.txt"
status_file="$CONSOLIDATOR_DIR/status.json"
summary_file="$CONSOLIDATOR_DIR/summary.json"
launcher_log="$CONSOLIDATOR_DIR/logs/launcher.log"
events_log="$CONSOLIDATOR_DIR/logs/codex-events.jsonl"
stderr_log="$CONSOLIDATOR_DIR/logs/codex.stderr.log"
heartbeat_log="$CONSOLIDATOR_DIR/logs/heartbeat.log"
process_log="$CONSOLIDATOR_DIR/logs/process.log"
pid_file="$CONSOLIDATOR_DIR/runtime/codex.pid"
last_message_file="$CONSOLIDATOR_DIR/last-message.txt"
artifacts_dir="$CONSOLIDATOR_DIR/artifacts"
codex_home="$CONSOLIDATOR_DIR/codex-home"

ln -sfn "logs/launcher.log" "$CONSOLIDATOR_DIR/launcher.log"
ln -sfn "logs/codex-events.jsonl" "$CONSOLIDATOR_DIR/codex-events.jsonl"
ln -sfn "logs/codex.stderr.log" "$CONSOLIDATOR_DIR/codex.stderr.log"
ln -sfn "logs/heartbeat.log" "$CONSOLIDATOR_DIR/heartbeat.log"
ln -sfn "logs/process.log" "$CONSOLIDATOR_DIR/process.log"
ln -sfn "runtime/codex.pid" "$CONSOLIDATOR_DIR/codex.pid"

python3 - "$RUN_DIR" "$CONSOLIDATOR_DIR/input" <<'PY'
from pathlib import Path
import csv
import json
import sys

run_dir = Path(sys.argv[1])
input_dir = Path(sys.argv[2])
chunks_dir = run_dir / "chunks"
input_dir.mkdir(parents=True, exist_ok=True)

chunk_rows = []
combined_dataset_path = input_dir / "combined-dataset.jsonl"
combined_dataset_path.write_text("", encoding="utf-8")
combined_citations = []

for chunk_dir in sorted(chunks_dir.glob("chunk-*")):
    status_path = chunk_dir / "status.json"
    summary_path = chunk_dir / "summary.json"
    manifest_path = chunk_dir / "artifacts" / "manifest.json"
    dataset_path = chunk_dir / "artifacts" / "dataset.jsonl"
    citation_path = chunk_dir / "artifacts" / "citation-index.json"
    row = {
        "chunk_id": chunk_dir.name,
        "chunk_dir": str(chunk_dir),
        "status": None,
        "summary": None,
        "manifest": None,
        "dataset_path": str(dataset_path) if dataset_path.exists() else None,
        "citation_index_path": str(citation_path) if citation_path.exists() else None,
    }
    for key, path in (("status", status_path), ("summary", summary_path), ("manifest", manifest_path)):
        try:
            row[key] = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            row[key] = None
    chunk_rows.append(row)
    if dataset_path.exists():
        with dataset_path.open("r", encoding="utf-8") as handle, combined_dataset_path.open("a", encoding="utf-8") as output:
            for line in handle:
                if line.strip():
                    output.write(line.rstrip() + "\n")
    if citation_path.exists():
        try:
            payload = json.loads(citation_path.read_text(encoding="utf-8"))
        except Exception:
            payload = None
        if isinstance(payload, dict):
            combined_citations.append({
                "chunk_id": chunk_dir.name,
                "citation_index": payload,
            })

(input_dir / "chunk-statuses.json").write_text(json.dumps(chunk_rows, indent=2) + "\n", encoding="utf-8")
(input_dir / "combined-citation-index.json").write_text(json.dumps(combined_citations, indent=2) + "\n", encoding="utf-8")

summary_csv_path = input_dir / "chunk-summary.csv"
with summary_csv_path.open("w", encoding="utf-8", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["chunk_id", "state", "exit_code", "artifact_file_count", "scope_file_count"])
    for row in chunk_rows:
        status = row["status"] or {}
        writer.writerow([
            row["chunk_id"],
            status.get("state"),
            status.get("exit_code"),
            status.get("artifact_file_count"),
            status.get("scope_file_count"),
        ])
PY

python3 - "$prompt_file" "$USER_PROMPT_FILE" "$RUN_DIR" "$JOB_ID" "$CONSOLIDATOR_DIR/input" "$artifacts_dir" <<'PY'
from pathlib import Path
import sys

prompt_path = Path(sys.argv[1])
user_prompt = Path(sys.argv[2]).read_text(encoding="utf-8")
run_dir = sys.argv[3]
job_id = sys.argv[4]
input_dir = sys.argv[5]
artifacts_dir = sys.argv[6]

prompt = f"""You are consolidating a chunked Codex corpus research run on a DigitalOcean droplet.

Original user research request:

<USER_RESEARCH_PROMPT>
{user_prompt.rstrip()}
</USER_RESEARCH_PROMPT>

Consolidation inputs:
- wrapper run dir: {run_dir}
- proxy run id: {job_id}
- chunk statuses: {input_dir}/chunk-statuses.json
- chunk summary csv: {input_dir}/chunk-summary.csv
- combined shard dataset: {input_dir}/combined-dataset.jsonl
- combined shard citation payload: {input_dir}/combined-citation-index.json

Hard requirements:
- Consolidate the chunk run logs and artifacts. Do not re-run corpus retrieval.
- Work only from the existing shard outputs, logs, and summaries under the wrapper run directory.
- Write every consolidation artifact under {artifacts_dir}.

Required outputs:
- manifest.json
- consolidated-summary.json
- consolidated-briefing.md
- consolidated-citation-index.json
- run.log

Required manifest fields:
- proxy_run_id
- wrapper_run_dir
- user_prompt
- source_chunk_count
- completed_chunk_count
- failed_chunk_count
- output_file_list
- status

Quality bar:
- Identify cross-shard themes and contradictions.
- Call out failed or thin shards explicitly if they affect confidence.
- Prefer grounded synthesis over repetition.

At the end:
- Print the consolidation artifacts directory path.
- Print a short summary with the source chunk count and main output files.
"""
prompt_path.write_text(prompt, encoding="utf-8")
PY

python3 - "$status_file" "$summary_file" "$RUN_DIR" "$CONSOLIDATOR_DIR" "$JOB_ID" "$MODEL" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "wrapper_run_dir": sys.argv[3],
    "consolidator_dir": sys.argv[4],
    "job_id": sys.argv[5],
    "model": sys.argv[6],
    "state": "launching",
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
Path(sys.argv[2]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

{
  echo "run_dir=$RUN_DIR"
  echo "consolidator_dir=$CONSOLIDATOR_DIR"
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
  cd "$ROOT_DIR"
  export HOME="$codex_home"
  export OPENAI_BASE_URL="http://127.0.0.1:8790/runs/$JOB_ID/v1"
  export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
  codex -a never exec \
    -s danger-full-access \
    --color never \
    --json \
    --cd "$ROOT_DIR" \
    --output-last-message "$last_message_file" \
    --add-dir "$RUN_DIR" \
    --add-dir "$CONSOLIDATOR_DIR" \
    --model "$MODEL" \
    - <"$prompt_file" >>"$events_log" 2>>"$stderr_log"
) &
codex_pid=$!
echo "$codex_pid" >"$pid_file"
printf '%s pid=%s consolidator started\n' "$(date -u +%FT%TZ)" "$codex_pid" >>"$process_log"

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

printf '%s pid=%s consolidator exit_code=%s\n' "$(date -u +%FT%TZ)" "$(cat "$pid_file")" "$exit_code" >>"$process_log"
exit "$exit_code"
