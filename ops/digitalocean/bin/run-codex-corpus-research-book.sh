#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
RUN_DIR=""
BOOK_DIR=""
BOOK_ID=""
JOB_ID=""
MODEL="${MODEL:-gpt-5.4}"
USER_PROMPT_FILE=""
BOOK_DECISION_FILE=""
CORPUS_ROOT="${CORPUS_ROOT:-/srv/alphabook/gutenberg}"
PRECOMPUTED_INDEX_DIR="${PRECOMPUTED_INDEX_DIR:-}"

usage() {
  cat >&2 <<'EOF'
Usage: run-codex-corpus-research-book.sh \
  --run-dir /srv/alphabook/logs/codex-corpus-research/<run-id> \
  --book-dir /srv/alphabook/logs/codex-corpus-research/<run-id>/books/book-00001 \
  --book-id book-00001 \
  --job-id <wrapper-job-id>-book-00001 \
  --user-prompt-file /path/to/prompt.txt \
  --book-decision-file /path/to/book-decision.json
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
    --book-dir)
      BOOK_DIR="$2"
      shift 2
      ;;
    --book-id)
      BOOK_ID="$2"
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
    --book-decision-file)
      BOOK_DECISION_FILE="$2"
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

[[ -n "$RUN_DIR" && -n "$BOOK_DIR" && -n "$BOOK_ID" && -n "$JOB_ID" && -n "$USER_PROMPT_FILE" && -n "$BOOK_DECISION_FILE" ]] || usage
[[ -d "$ROOT_DIR" ]] || { echo "Missing repo root: $ROOT_DIR" >&2; exit 1; }
[[ -f "$USER_PROMPT_FILE" ]] || { echo "Missing user prompt file: $USER_PROMPT_FILE" >&2; exit 1; }
[[ -f "$BOOK_DECISION_FILE" ]] || { echo "Missing book decision file: $BOOK_DECISION_FILE" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "Missing codex CLI on PATH" >&2; exit 1; }

mkdir -p "$BOOK_DIR/logs" "$BOOK_DIR/runtime" "$BOOK_DIR/artifacts" "$BOOK_DIR/codex-home/.codex" "$BOOK_DIR/openai-proxy"

prompt_file="$BOOK_DIR/prompt.txt"
status_file="$BOOK_DIR/status.json"
summary_file="$BOOK_DIR/summary.json"
launcher_log="$BOOK_DIR/logs/launcher.log"
events_log="$BOOK_DIR/logs/codex-events.jsonl"
stderr_log="$BOOK_DIR/logs/codex.stderr.log"
heartbeat_log="$BOOK_DIR/logs/heartbeat.log"
process_log="$BOOK_DIR/logs/process.log"
pid_file="$BOOK_DIR/runtime/codex.pid"
last_message_file="$BOOK_DIR/last-message.txt"
artifacts_dir="$BOOK_DIR/artifacts"
codex_home="$BOOK_DIR/codex-home"

ln -sfn "logs/launcher.log" "$BOOK_DIR/launcher.log"
ln -sfn "logs/codex-events.jsonl" "$BOOK_DIR/codex-events.jsonl"
ln -sfn "logs/codex.stderr.log" "$BOOK_DIR/codex.stderr.log"
ln -sfn "logs/heartbeat.log" "$BOOK_DIR/heartbeat.log"
ln -sfn "logs/process.log" "$BOOK_DIR/process.log"
ln -sfn "runtime/codex.pid" "$BOOK_DIR/codex.pid"

python3 - "$prompt_file" "$USER_PROMPT_FILE" "$BOOK_DECISION_FILE" "$RUN_DIR" "$BOOK_ID" "$JOB_ID" "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR" "$artifacts_dir" <<'PY'
from pathlib import Path
import json
import sys

prompt_path = Path(sys.argv[1])
user_prompt = Path(sys.argv[2]).read_text(encoding="utf-8")
book_decision = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
run_dir = sys.argv[4]
book_id = sys.argv[5]
job_id = sys.argv[6]
corpus_root = sys.argv[7]
precomputed_index_dir = sys.argv[8]
artifacts_dir = sys.argv[9]

book_path = book_decision.get("source_file") or book_decision.get("book_path") or ""
title = book_decision.get("source_title") or book_decision.get("title") or "unknown"
author = book_decision.get("source_author") or book_decision.get("author") or "unknown"
year = book_decision.get("source_year_or_period") or book_decision.get("year") or "unknown"
reasoning = book_decision.get("reasoning") or ""
evidence = book_decision.get("evidence_snippets") or []
gutenberg_id = book_decision.get("gutenberg_id") or ""
corpus_chunk_id = book_decision.get("corpus_chunk_id") or ""

prompt = f"""You are running a dedicated single-book Codex research job on a DigitalOcean droplet.

Original user research request:

<USER_RESEARCH_PROMPT>
{user_prompt.rstrip()}
</USER_RESEARCH_PROMPT>

This run is restricted to one book that was classified as relevant during shard triage.

Book contract:
- book run id: {book_id}
- proxy run id: {job_id}
- wrapper run dir: {run_dir}
- source file: {book_path}
- source title: {title}
- source author: {author}
- source year or period: {year}
- source Gutenberg id: {gutenberg_id or "unknown"}
- deterministic corpus chunk id: {corpus_chunk_id or "unknown"}
- shard triage reasoning: {reasoning}
- shard evidence snippets: {json.dumps(evidence, ensure_ascii=False)}
- corpus root: {corpus_root}
- precomputed index dir: {precomputed_index_dir}
- output dir: {artifacts_dir}

Hard requirements:
- Restrict the main analysis to this single source file.
- Do not broaden back out to the shard or full corpus.
- Write every artifact under {artifacts_dir}.
- Use model judgment over local context to explain how this book deals with grief.
- Exact quotes must be grounded in the source text with line references or local provenance.
- You may use helper scripts for parsing or note-taking, but not to mechanically decide relevance from hand-written weights.
- A bounded Qdrant helper is available at `/srv/alphabook/repo/ops/digitalocean/bin/run-qdrant-bounded-search.py`.
- If you use semantic retrieval for this book, bound it to this specific book with `--gutenberg-id "{gutenberg_id}"`.
- Do not run an unbounded semantic search against the full Qdrant collection from this book run.

Required outputs under {artifacts_dir}:
- manifest.json
- run.log
- book-summary.json
- quotes.jsonl
- citation-index.json
- briefing.md

Required manifest fields:
- book_id
- proxy_run_id
- wrapper_run_dir
- user_prompt
- source_file
- source_title
- source_author
- source_year_or_period
- shard_reasoning
- output_file_list
- record_counts
- status

Quality bar:
- Explain the main grief-handling patterns in this book, not just isolated sad lines.
- Keep multiple quotes when the book presents distinct grief responses.
- Be explicit when the shard triage looked plausible but the book turns out to be thin or only marginally relevant.

At the end:
- Print the book artifacts directory path.
- Print a short summary with quote count and main output files.
"""
prompt_path.write_text(prompt, encoding="utf-8")
PY

python3 - "$status_file" "$summary_file" "$RUN_DIR" "$BOOK_DIR" "$BOOK_ID" "$JOB_ID" "$MODEL" "$BOOK_DECISION_FILE" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "wrapper_run_dir": sys.argv[3],
    "book_dir": sys.argv[4],
    "book_id": sys.argv[5],
    "job_id": sys.argv[6],
    "model": sys.argv[7],
    "book_decision_file": sys.argv[8],
    "state": "launching",
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
Path(sys.argv[2]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

{
  echo "run_dir=$RUN_DIR"
  echo "book_dir=$BOOK_DIR"
  echo "book_id=$BOOK_ID"
  echo "job_id=$JOB_ID"
  echo "model=$MODEL"
  echo "book_decision_file=$BOOK_DECISION_FILE"
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
  export QDRANT_URL="${QDRANT_URL:-}"
  export QDRANT_API_KEY="${QDRANT_API_KEY:-}"
  export QDRANT_COLLECTION="${QDRANT_COLLECTION:-}"
  export ALPHABOOK_CODEX_QDRANT_GUTENBERG_ID="$(python3 - "$BOOK_DECISION_FILE" <<'PY'
from pathlib import Path
import json
import sys

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
value = payload.get("gutenberg_id")
print(value if isinstance(value, str) else "")
PY
)"
  codex -a never exec \
    -s danger-full-access \
    --color never \
    --json \
    --cd "$ROOT_DIR" \
    --skip-git-repo-check \
    --output-last-message "$last_message_file" \
    --add-dir "$BOOK_DIR" \
    --add-dir "$CORPUS_ROOT" \
    --add-dir "$PRECOMPUTED_INDEX_DIR" \
    --model "$MODEL" \
    - <"$prompt_file" >"$events_log" 2>"$stderr_log"
)
exit_code=$?

python3 - "$status_file" "$summary_file" "$exit_code" "$artifacts_dir" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys

status_path = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
exit_code = int(sys.argv[3])
artifacts_dir = Path(sys.argv[4])
finished_at = sys.argv[5]
artifact_count = sum(1 for path in artifacts_dir.rglob("*") if path.is_file()) if artifacts_dir.exists() else 0

payload = json.loads(status_path.read_text(encoding="utf-8"))
payload["exit_code"] = exit_code
payload["artifact_file_count"] = artifact_count
payload["finished_at"] = finished_at
payload["state"] = "completed" if exit_code == 0 else "failed"

for target in (status_path, summary_path):
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

printf '%s pid=%s exit=%s\n' "$(date -u +%FT%TZ)" "$$" "$exit_code" >>"$process_log"
printf '%s pid=%s exited\n' "$(date -u +%FT%TZ)" "$$" >>"$heartbeat_log"

exit "$exit_code"
