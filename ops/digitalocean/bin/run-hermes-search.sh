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
fi
if [[ -f "$FALLBACK_ENV_FILE" ]]; then
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    export OPENAI_API_KEY="$(load_env_value "$FALLBACK_ENV_FILE" "OPENAI_API_KEY")"
  fi
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
inner_run_file="$runtime_dir/inner-run-dir.txt"
status_file="$state_dir/status.json"
summary_file="$state_dir/summary.json"
index_file="$run_dir/index.json"
attempt_manifest_file="$attempt_dir/attempt.json"

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
ln -sfn "attempts/$attempt_id/runtime/inner-run-dir.txt" "$run_dir/inner-run-dir.txt"
ln -sfn "attempts/$attempt_id/hermes-home" "$run_dir/hermes-home"
ln -sfn "attempts/$attempt_id" "$run_dir/current-attempt"

if [[ -f "$HERMES_CONFIG_SOURCE" ]]; then
  cp "$HERMES_CONFIG_SOURCE" "$hermes_home/.hermes/config.yaml"
fi
if [[ -f "$HERMES_ENV_SOURCE" ]]; then
  cp "$HERMES_ENV_SOURCE" "$hermes_home/.hermes/.env"
fi

if [[ ! -f "$hermes_home/.hermes/config.yaml" ]]; then
  cat >"$hermes_home/.hermes/config.yaml" <<EOF
model:
  default: "$MODEL"
  provider: "custom"
  base_url: "http://127.0.0.1:8790/runs/$job_id/v1"
EOF
fi

python3 - "$hermes_home/.hermes/config.yaml" "$MODEL" "$job_id" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
model = sys.argv[2]
job_id = sys.argv[3]

if re.search(r'^\s*default:\s*".*"$', text, flags=re.MULTILINE):
    text = re.sub(r'^\s*default:\s*".*"$', f'  default: "{model}"', text, count=1, flags=re.MULTILINE)
if re.search(r'^\s*provider:\s*".*"$', text, flags=re.MULTILINE):
    text = re.sub(r'^\s*provider:\s*".*"$', '  provider: "custom"', text, count=1, flags=re.MULTILINE)
else:
    text += '\n  provider: "custom"\n'
if re.search(r'^\s*base_url:\s*".*"$', text, flags=re.MULTILINE):
    text = re.sub(r'^\s*base_url:\s*".*"$', f'  base_url: "http://127.0.0.1:8790/runs/{job_id}/v1"', text, count=1, flags=re.MULTILINE)
else:
    text += f'\n  base_url: "http://127.0.0.1:8790/runs/{job_id}/v1"\n'
path.write_text(text)
PY

python3 - "$prompt_file" "$CORPUS_ROOT" "$PRECOMPUTED_INDEX_DIR" "$USER_PROMPT" "$EFFORT" <<'PY'
from pathlib import Path
import sys

prompt_path = Path(sys.argv[1])
corpus_root = sys.argv[2]
precomputed_index_dir = sys.argv[3]
user_prompt = sys.argv[4]
effort = int(sys.argv[5])

prompt = f"""You are on a DigitalOcean droplet with a prepared Project Gutenberg corpus at {corpus_root}.

Use {precomputed_index_dir}/all-text-files.tsv as the source of truth for searchable raw text files.
Use {precomputed_index_dir}/metadata-table.jsonl for metadata lookup.

Search for evidence related to the following:

<USER_SEARCH_PROMPT>
{user_prompt}
</USER_SEARCH_PROMPT>

Effort budget:
- Keep at most {effort} evidence hits. Stop earlier once you have enough representative evidence or the scoped corpus is exhausted.
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
   - If the scoped result is a tiny bounded set of exact works, for example 1 to 3 clearly identified books, treat that as a direct-reading handoff case rather than a normal bounded-hit retrieval case.
   - In that tiny-scope case, you may stop after scope resolution and artifact setup instead of doing a full kept-hit search.
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
  - resolved_work_count if inferable
  - synthesis_mode
  - synthesis_rationale
  - kept_hit_count
  - status
- If the scope collapses to a tiny bounded set of exact works, for example one clearly identified book or a few exact books:
  - set `synthesis_mode` to `small_scope_direct_read`
  - set `synthesis_rationale` to explain why the final answer should be written from direct reading of the whole scoped work(s), not just the kept-hit subset
  - include `direct_source_files` listing the exact raw text files that should be read during synthesis if you can determine them
  - if `resolved_work_count` is 1, 2, or 3 and the direct source files are known, you may finish the run immediately after writing:
    - `manifest.json`
    - `scoped-files.tsv`
    - `run.log`
    - a lightweight `hits/index.json` noting that synthesis should read the full scoped work(s) directly
  - in that tiny-scope case, do not spend time forcing a normal kept-hit set just to satisfy the old retrieval pattern
- Otherwise:
  - set `synthesis_mode` to `standard_hits`
  - set `synthesis_rationale` briefly
- Save kept evidence chunks in:
  - `hits/`
- Save a lightweight machine-readable index at:
  - `hits/index.json`
- Save the final scoped searchable file list at:
  - `scoped-files.tsv`
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
- Treat the effort cap as a hard maximum, not a quota. Stop once you have enough strong, representative evidence, or sooner if the scoped corpus is exhausted.
- Keep the output inspectable and lightweight.
- Do not spend time building a full synthesis, labels, or a large structured dataset.
- If the query resolves to 1 to 3 exact books, prefer the tiny-scope direct-reading handoff over a normal capped evidence search.

At the end:
- Print the inner run directory path.
- Print a concise summary exactly once with:
  - chosen scope
  - searched file count
  - kept hit count
  - a few representative example titles if available
  - the main output files
- Do not repeat the same summary block multiple times.
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

python3 - "$attempt_manifest_file" "$run_dir" "$attempt_dir" "$attempt_id" "$timestamp" <<'PY'
from pathlib import Path
import json
import sys

payload = {
    "wrapper_run_dir": sys.argv[2],
    "attempt_dir": sys.argv[3],
    "attempt_id": sys.argv[4],
    "created_at": sys.argv[5],
    "logs_dir": str(Path(sys.argv[3]) / "logs"),
    "runtime_dir": str(Path(sys.argv[3]) / "runtime"),
    "hermes_home": str(Path(sys.argv[3]) / "hermes-home"),
}
Path(sys.argv[1]).write_text(json.dumps(payload, indent=2) + "\n")
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
echo "inner_run_file=${WRAPPER_INNER_RUN_FILE:-}"
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
synthesis_script="${ROOT_DIR}/ops/digitalocean/bin/run-codex-search-synthesis.sh"
resolve_hits_script="${ROOT_DIR}/ops/digitalocean/bin/resolve-search-hit-links.py"

resolve_inner_run_dir() {
  python3 - "$WRAPPER_INNER_RUN_FILE" "$STDOUT_LOG" <<'PY'
from pathlib import Path
import re
import sys

inner_run_file = Path(sys.argv[1])
stdout_log = Path(sys.argv[2])

try:
    value = inner_run_file.read_text(encoding="utf-8").strip()
except Exception:
    value = ""
if value:
    candidate = Path(value)
    if candidate.is_dir():
        print(candidate)
        raise SystemExit

try:
    text = stdout_log.read_text(encoding="utf-8", errors="ignore")
    matches = re.findall(r"/srv/alphabook/logs/corpus-search/[^\s\"'`]+", text)
    for value in reversed(matches):
        candidate = Path(value)
        if candidate.is_dir():
            print(candidate)
            raise SystemExit
except Exception:
    pass
PY
}

if [[ "$exit_code" -eq 0 && -x "$synthesis_script" ]]; then
  inner_run_dir="$(resolve_inner_run_dir || true)"
  if [[ -n "$inner_run_dir" && -d "$inner_run_dir" ]]; then
    if [[ -x "$resolve_hits_script" ]]; then
      if python3 "$resolve_hits_script" \
        --inner-run-dir "$inner_run_dir" \
        --site-origin "https://alpha-book.org" \
        --session-id "${ALPHABOOK_SESSION_ID:-}" >>"$STDOUT_LOG" 2>>"$STDERR_LOG"; then
        echo "hit_link_resolution=completed inner_run_dir=$inner_run_dir" >>"$STDOUT_LOG"
      else
        echo "hit_link_resolution=failed inner_run_dir=$inner_run_dir" >>"$STDERR_LOG"
      fi
    fi
    if "$synthesis_script" \
      --root-dir "$ROOT_DIR" \
      --inner-run-dir "$inner_run_dir" \
      --job-id "${JOB_ID}-synthesis" \
      --model "$MODEL" \
      --user-prompt-file "$PROMPT_FILE" >>"$STDOUT_LOG" 2>>"$STDERR_LOG"; then
      echo "codex_synthesis=completed" >>"$STDOUT_LOG"
    else
      echo "codex_synthesis=failed inner_run_dir=$inner_run_dir" >>"$STDERR_LOG"
    fi
  else
    echo "codex_synthesis=skipped reason=missing_inner_run_dir" >>"$STDERR_LOG"
  fi
fi

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
  OPENAI_BASE_URL="http://127.0.0.1:8790/runs/$job_id/v1" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
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

printf '%s pid=%s started attempt=%s\n' "$(date -u +%FT%TZ)" "$runner_pid" "$attempt_id" >>"$process_log"

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

materialize_script="$ROOT_DIR/ops/digitalocean/bin/materialize-hermes-run-index.py"
if [[ -x "$materialize_script" ]]; then
  (
    while kill -0 "$runner_pid" 2>/dev/null; do
      python3 "$materialize_script" --run-dir "$run_dir" >/dev/null 2>&1 || true
      sleep "$HEARTBEAT_SECONDS"
    done
    python3 "$materialize_script" --run-dir "$run_dir" >/dev/null 2>&1 || true
    printf '%s pid=%s exited attempt=%s\n' "$(date -u +%FT%TZ)" "$runner_pid" "$attempt_id" >>"$process_log"
  ) >/dev/null 2>&1 &
else
  (
    while kill -0 "$runner_pid" 2>/dev/null; do
      sleep "$HEARTBEAT_SECONDS"
    done
    printf '%s pid=%s exited attempt=%s\n' "$(date -u +%FT%TZ)" "$runner_pid" "$attempt_id" >>"$process_log"
  ) >/dev/null 2>&1 &
fi

printf '%s\n' "$run_dir"
