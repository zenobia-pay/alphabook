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
vector_scope_file="$CHUNK_DIR/vector-scope.json"
corpus_chunk_id="$(tr -d '\r\n' <"$CHUNK_DIR/corpus-chunk-id.txt" 2>/dev/null || true)"

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

python3 - "$prompt_file" "$USER_PROMPT_FILE" "$RUN_DIR" "$CHUNK_ID" "$JOB_ID" "$SCOPE_FILE_LIST" "$scope_file_count" "$scope_total_bytes" "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR" "$artifacts_dir" "$vector_scope_file" "$corpus_chunk_id" <<'PY'
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
vector_scope_file = sys.argv[12]
corpus_chunk_id = sys.argv[13]

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
- Prefer the bounded Qdrant-first retrieval helper at `/srv/alphabook/repo/ops/digitalocean/bin/run-qdrant-rag-retrieval.sh` before broad ripgrep fanout.
- Use the Qdrant-first helper to:
  - expand the query into semantically diverse variants,
  - run bounded dense retrieval with a score threshold and pagination,
  - hydrate and deduplicate candidate chunks,
  - group nearby chunk hits into larger review packets,
  - optionally rerank those packets against the original query.
- Keep that retrieval bounded to this shard by passing:
  - `--precomputed-index-dir "{precomputed_index_dir}"`
  - `--scope-file "{scope_file}"`
  - `--corpus-chunk-id "{corpus_chunk_id}"`
  - `--gutenberg-ids-file "{vector_scope_file}"` as fallback if needed
- Persist the Qdrant-first retrieval artifacts under `{artifacts_dir}/rag-retrieval/`.
- Use /srv/alphabook/repo/ops/digitalocean/bin/run-ripgrep-progress.sh for corpus search and pass:
  - --file-list "{scope_file}"
  - --max-total-files 5000
  - --batch-size 500
- Use ripgrep as a secondary lexical follow-up or fallback path once the bounded semantic retrieval has narrowed the candidate books or packets.
- Search raw text only.
- Never invoke the ripgrep helper on more than the shard TSV.
- Use ripgrep only for retrieval and candidate gathering. Relevance triage, keep/discard decisions, theme labeling, and synthesis must be done with model judgment over local context.
- After retrieval, explicitly use Codex sub-agents for triage work rather than doing all review in one monolithic thread.
- Split the candidate review workload into bounded sub-agent batches, for example by contiguous slices of candidate books or contiguous slices of the persisted hit ledger.
- Each sub-agent must review only its assigned slice, inspect the local context for those candidate books, and return per-book relevance decisions with reasoning and evidence snippets.
- The parent shard run must then merge those sub-agent outputs into the final shard-level `relevant-books.jsonl`, `relevant-books.csv`, and `excluded-books.jsonl`.
- Do not let sub-agents search outside this shard TSV or outside persisted shard artifacts.
- Persist the sub-agent assignments and outputs under `{artifacts_dir}` so the shard remains inspectable.
- Do not use hard-coded quote scoring, regex-weight scoring, static relevance formulas, top-N ranking scripts, or deterministic keyword-based triage as the decision-maker.
- Do not impose arbitrary hard caps like "top 700 files", "top 36 records", "max 3 quotes per file", or "max 8 per theme". Coverage should be driven by the shard evidence, not fixed caps.
- Do not generate a Python or TypeScript script whose job is to mechanically score quotes or mechanically decide relevance from hand-written weights or thresholds.
- If you write helper scripts, limit them to parsing, batching, deduplication, artifact assembly, and ledger/progress tracking. The actual research judgment must remain model-authored.
- Review the shard evidence progressively in batches until you have covered the shard's candidate material. Maintain an inspectable reviewed ledger or notes if needed, but do not shortcut coverage with deterministic ranking heuristics.
- When candidate volume is large, batch the candidate passages and evaluate them with the model against the user request using local context windows from the source text.
- A correct triage pass means an LLM sees the candidate passage text and decides whether it is relevant to the user request. Keyword matches or regex hits alone are not triage.
- If you want an existing implementation, prefer the repo's LLM triage workflow at `/srv/alphabook/repo/packages/tooling/scripts/run-corpus-research-triage.ts` and adapt the shard artifacts to feed it, rather than inventing heuristic scoring code.
- Never write a script that reads natural-language passages and decides relevance with hand-written weights, term counts, or threshold rules. If a script decides relevance, it must be calling an LLM on the passage text.
- If you use a script to orchestrate triage, it must persist the raw candidate passages, LLM decisions, reasoning, and acceptance/exclusion outcomes under `{artifacts_dir}` so the shard remains inspectable.
- This shard phase is book classification, not final passage extraction. Its job is to decide which books in the shard materially deal with the user request and should advance to dedicated per-book Codex runs.
- You must produce one decision row per book in the shard. Do not stop after a small sample.
- Favor recall over premature exclusion. If a book materially engages grief even as a secondary thread, mark it relevant and let the later single-book run decide depth.
- Treat the sub-agents as the primary triage mechanism for book relevance. The parent shard run should coordinate, reconcile, and serialize the final per-book decisions.
- Use `/mnt/alphabook_consolidation/final/latest/research-corpus-index/metadata-table.jsonl` or the equivalent metadata table under `{precomputed_index_dir}` to recover title/author/year for shard files when possible.
- A bounded Qdrant helper is available at `/srv/alphabook/repo/ops/digitalocean/bin/run-qdrant-bounded-search.py`.
- If you use semantic retrieval, you must keep it bounded to this shard by passing:
  - `--corpus-chunk-id "{corpus_chunk_id}"` when the live index has shard payloads
  - or `--gutenberg-ids-file "{vector_scope_file}"` as the fallback bounded filter
- Never run an unbounded semantic search against the full Qdrant collection from this shard.

Required outputs under {artifacts_dir}:
- manifest.json
- run.log
- relevant-books.jsonl
- relevant-books.csv
- excluded-books.jsonl
- shard-briefing.md
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
- decision_schema_summary
- output_file_list
- record_counts
- status

Quality bar:
- This is not a quick grep dump.
- The relevant-books output must reflect LLM-reviewed book decisions, not deterministic score thresholds.
- Each relevant book row must include reasoning and at least one supporting evidence snippet or explanation of the grief signal.
- The reasoning and evidence on each relevant book row should come from sub-agent review of the book's local evidence, not from deterministic aggregation rules alone.
- If you exclude a large candidate subset, explain the exclusion logic in model-authored prose in the manifest/run log rather than hiding it behind a numeric heuristic.
- The shard briefing should summarize what kinds of books in this shard appear relevant, what kinds were excluded, and any uncertainty carried into the per-book phase.

At the end:
- Print the shard artifacts directory path.
- Print a short summary with the searched file count, relevant book count, and main output files.
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
  export QDRANT_URL="${QDRANT_URL:-}"
  export QDRANT_API_KEY="${QDRANT_API_KEY:-}"
  export QDRANT_COLLECTION="${QDRANT_COLLECTION:-}"
  export ALPHABOOK_CODEX_CHUNK_DIR="$CHUNK_DIR"
  export ALPHABOOK_CODEX_ARTIFACTS_DIR="$artifacts_dir"
  export ALPHABOOK_CODEX_SCOPE_FILE_LIST="$SCOPE_FILE_LIST"
  export ALPHABOOK_CODEX_QDRANT_VECTOR_SCOPE_FILE="$vector_scope_file"
  export ALPHABOOK_CODEX_QDRANT_CORPUS_CHUNK_ID="$corpus_chunk_id"
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
