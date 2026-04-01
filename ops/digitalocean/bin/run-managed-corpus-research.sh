#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
RUN_ROOT="${RUN_ROOT:-/srv/alphabook/logs/corpus-research}"
CORPUS_ROOT="${CORPUS_ROOT:-/srv/alphabook/gutenberg}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
FALLBACK_ENV_FILE="${FALLBACK_ENV_FILE:-/srv/alphabook/.ingest.env}"
NANO_MODEL="${NANO_MODEL:-gpt-5-nano}"
ESCALATION_MODEL="${ESCALATION_MODEL:-gpt-5-mini}"
SYNTHESIS_MODEL="${SYNTHESIS_MODEL:-gpt-5-mini}"
CONCURRENCY="${CONCURRENCY:-8}"
STREAM_SECONDS="${STREAM_SECONDS:-2}"

usage() {
  cat >&2 <<'EOF'
Usage: run-managed-corpus-research.sh --user-prompt "<research prompt>"
EOF
  exit 1
}

load_key() {
  local source_file="$1"
  python3 - "$source_file" <<'PY'
from pathlib import Path
import sys
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.startswith("OPENAI_API_KEY="):
        value = line.split("=", 1)[1].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        print(value)
        break
PY
}

USER_PROMPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user-prompt)
      USER_PROMPT="$2"
      shift 2
      ;;
    --model)
      ESCALATION_MODEL="$2"
      SYNTHESIS_MODEL="$2"
      shift 2
      ;;
    --nano-model)
      NANO_MODEL="$2"
      shift 2
      ;;
    --escalation-model)
      ESCALATION_MODEL="$2"
      shift 2
      ;;
    --synthesis-model)
      SYNTHESIS_MODEL="$2"
      shift 2
      ;;
    --concurrency)
      CONCURRENCY="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$USER_PROMPT" ]] || usage
[[ -d "$ROOT_DIR" ]] || { echo "Missing repo root: $ROOT_DIR" >&2; exit 1; }

if [[ -f "$ENV_FILE" ]]; then
  export OPENAI_API_KEY="$(load_key "$ENV_FILE")"
elif [[ -f "$FALLBACK_ENV_FILE" ]]; then
  export OPENAI_API_KEY="$(load_key "$FALLBACK_ENV_FILE")"
fi
[[ -n "${OPENAI_API_KEY:-}" ]] || { echo "OPENAI_API_KEY is not available" >&2; exit 1; }

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_id="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(4))
PY
)"
run_dir="$RUN_ROOT/$timestamp-$run_id"
mkdir -p "$run_dir" "$run_dir/search" "$run_dir/prepared" "$run_dir/triage" "$run_dir/visualizations"

status_file="$run_dir/status.json"
run_log="$run_dir/run.log"
stream_log="$run_dir/stream.log"
pid_file="$run_dir/runner.pid"
heartbeat_pid_file="$run_dir/streamer.pid"

python3 - "$run_dir/manifest.json" "$USER_PROMPT" "$CORPUS_ROOT" "$timestamp" "$run_id" <<'PY'
from pathlib import Path
import json
import sys
payload = {
    "user_prompt": sys.argv[2],
    "corpus_root": sys.argv[3],
    "timestamp": sys.argv[4],
    "run_id": sys.argv[5],
    "status": "launching",
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n")
PY

python3 - "$status_file" "$USER_PROMPT" "$NANO_MODEL -> $ESCALATION_MODEL -> $SYNTHESIS_MODEL" <<'PY'
from pathlib import Path
import json
import sys
payload = {
    "phase": "launching",
    "query": sys.argv[2],
    "model": sys.argv[3],
    "total_candidates": 0,
    "triaged_candidates": 0,
    "completed_batches": 0,
    "total_batches": 0,
    "kept_records": 0,
    "llm_calls": 0,
    "state": "running",
    "phase_progress_pct": 0,
    "updated_at": "",
    "detail": "launching",
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n")
PY

cat >"$run_dir/run.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" >>"$RUN_LOG"
}

update_phase() {
  python3 - "$STATUS_FILE" "$1" "$2" "$3" <<'PY'
from pathlib import Path
import json
import sys
path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["phase"] = sys.argv[2]
data["phase_progress_pct"] = float(sys.argv[3])
data["detail"] = sys.argv[4]
from datetime import datetime, timezone
data["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
path.write_text(json.dumps(data, indent=2) + "\n")
PY
}

log "run_start"
update_phase "scope_selection" "0" "choosing scope"

"$ROOT_DIR/ops/digitalocean/bin/prepare-text-corpus-manifest.sh" \
  --corpus-root "$CORPUS_ROOT" \
  --output-dir "$RUN_DIR/prepared" >/dev/null

python3 - "$RUN_DIR" "$USER_PROMPT" <<'PY'
from pathlib import Path
import json
import re
import sys

run_dir = Path(sys.argv[1])
user_prompt = sys.argv[2].lower()
manifest_path = run_dir / "manifest.json"
manifest = json.loads(manifest_path.read_text())
tsv_path = run_dir / "prepared" / "all-text-files.tsv"
scope_path = run_dir / "scope-files.tsv"
rows = tsv_path.read_text().splitlines()

if "19th century" in user_prompt or "nineteenth century" in user_prompt:
    selected = []
    total_bytes = 0
    year_pattern = re.compile(r"\b18\d{2}\b")
    for row in rows:
        if not row:
            continue
        size, file_path = row.split("\t", 1)
        path = Path(file_path)
        try:
            with path.open("r", encoding="utf-8", errors="ignore") as handle:
                header = "".join([next(handle) for _ in range(200)])
        except (OSError, StopIteration):
            try:
                header = path.read_text(encoding="utf-8", errors="ignore")[:16000]
            except OSError:
                continue
        if year_pattern.search(header):
            selected.append(row)
            total_bytes += int(size)
    chosen_scope = "19th-century-approx (raw text files with 18xx in first 200 lines)"
    scope_rationale = "Approximate 19th century by scanning raw text headers/front matter for 1800-1899 year markers before ripgrep."
else:
    selected = [row for row in rows if row]
    total_bytes = sum(int(row.split("\t", 1)[0]) for row in selected)
    chosen_scope = "full raw-text corpus"
    scope_rationale = "The query applies to the entire mirrored corpus."

scope_path.write_text("\n".join(selected) + ("\n" if selected else ""))
manifest["chosen_scope"] = chosen_scope
manifest["scope_rationale"] = scope_rationale
manifest["search_strategy_summary"] = "text-only manifest, chosen scope before grep, chunked progress-aware ripgrep, explicit triage, synthesis"
manifest["record_counts"] = {
    "scope_files": len(selected),
    "scope_bytes": total_bytes,
}
manifest["status"] = "scoped"
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
PY

scope_files="$(wc -l < "$RUN_DIR/scope-files.tsv" | tr -d ' ')"
log "scope_selection_complete scope_files=$scope_files"
update_phase "search" "0" "starting progress-aware ripgrep"

node --import tsx packages/tooling/scripts/build-corpus-research-search-plan.ts \
  --query "$USER_PROMPT" \
  --output "$RUN_DIR/search-plan.json" >/dev/null

python3 - "$RUN_DIR/manifest.json" "$RUN_DIR/search-plan.json" <<'PY'
from pathlib import Path
import json
import sys
manifest_path = Path(sys.argv[1])
plan_path = Path(sys.argv[2])
manifest = json.loads(manifest_path.read_text())
plan = json.loads(plan_path.read_text())
manifest["search_strategy_summary"] = f"query-derived retrieval plan: {plan['focusSummary']}"
manifest["search_plan"] = {
    "search_terms": plan.get("searchTerms", []),
    "exclusion_terms": plan.get("exclusionTerms", []),
    "rationale": plan.get("rationale", ""),
}
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
PY

PATTERN="$(python3 - "$RUN_DIR/search-plan.json" <<'PY'
from pathlib import Path
import json
import sys
plan = json.loads(Path(sys.argv[1]).read_text())
print(plan["searchRegex"])
PY
)"
"$ROOT_DIR/ops/digitalocean/bin/run-ripgrep-progress.sh" \
  --file-list "$RUN_DIR/scope-files.tsv" \
  --pattern "$PATTERN" \
  --output-dir "$RUN_DIR/search" \
  --batch-size 500

log "search_complete"
update_phase "triage" "0" "starting LLM candidate triage"

cd "$ROOT_DIR"
node --import tsx packages/tooling/scripts/run-corpus-research-triage.ts \
  --run-dir "$RUN_DIR" \
  --query "$USER_PROMPT" \
  --nano-model "$NANO_MODEL" \
  --escalation-model "$ESCALATION_MODEL" \
  --synthesis-model "$SYNTHESIS_MODEL" \
  --concurrency "$CONCURRENCY" \
  --candidate-batch-size 6

log "run_complete"
EOS
chmod +x "$run_dir/run.sh"

(
  export ROOT_DIR CORPUS_ROOT RUN_DIR="$run_dir" USER_PROMPT NANO_MODEL ESCALATION_MODEL SYNTHESIS_MODEL CONCURRENCY RUN_LOG="$run_log" STATUS_FILE="$status_file"
  cd "$ROOT_DIR"
  nohup "$run_dir/run.sh" >"$run_dir/stdout.log" 2>"$run_dir/stderr.log" &
  echo $! >"$pid_file"
) >/dev/null

runner_pid="$(cat "$pid_file")"
(
  while kill -0 "$runner_pid" 2>/dev/null; do
    python3 - "$status_file" "$run_dir/search/ripgrep-status.json" <<'PY' >>"$stream_log" 2>/dev/null
from pathlib import Path
import json
import sys
from datetime import datetime, timezone

path = Path(sys.argv[1])
ripgrep_path = Path(sys.argv[2])
data = json.loads(path.read_text())
progress = data.get("phase_progress_pct")
detail = data.get("detail")
if data.get("phase") == "search" and ripgrep_path.exists():
    ripgrep = json.loads(ripgrep_path.read_text())
    progress = ripgrep.get("file_progress_pct", progress)
    detail = (
        f"ripgrep files={ripgrep.get('completed_files')}/{ripgrep.get('total_files')} "
        f"bytes_pct={ripgrep.get('byte_progress_pct')} hits={ripgrep.get('rg_hits_lines')}"
    )
timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
print(f"{timestamp} phase={data.get('phase')} state={data.get('state')} pct={progress} detail={detail}")
PY
    sleep "$STREAM_SECONDS"
  done
  printf '%s phase=finished state=stopped detail=runner-exited\n' "$(date -u +%FT%TZ)" >>"$stream_log"
) >/dev/null 2>&1 &
echo $! >"$heartbeat_pid_file"

echo "$run_dir"
