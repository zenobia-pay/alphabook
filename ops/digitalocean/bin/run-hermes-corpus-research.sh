#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
RUN_ROOT="${RUN_ROOT:-/srv/alphabook/logs/hermes-corpus-research}"
HERMES_CONFIG_SOURCE="${HERMES_CONFIG_SOURCE:-/root/.hermes/config.yaml}"
HERMES_ENV_SOURCE="${HERMES_ENV_SOURCE:-/root/.hermes/.env}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
FALLBACK_ENV_FILE="${FALLBACK_ENV_FILE:-/srv/alphabook/.ingest.env}"
CORPUS_ROOT="${CORPUS_ROOT:-/srv/alphabook/gutenberg}"
MODEL="${MODEL:-gpt-5.4}"
MAX_TURNS="${MAX_TURNS:-60}"
HEARTBEAT_SECONDS="${HEARTBEAT_SECONDS:-15}"
RESUME_RUN_DIR=""
RESUME_SESSION_ID=""

usage() {
  cat >&2 <<'EOF'
Usage: run-hermes-corpus-research.sh --user-prompt "Find me all the different ways that authors deal with grief in 19th century literature."

Options:
  --user-prompt TEXT     User research request to insert into the Hermes template.
  --max-turns N          Override Hermes max turns. Default: 60
  --model NAME           Override Hermes model. Default: gpt-5.4
  --run-root PATH        Output root. Default: /srv/alphabook/logs/hermes-corpus-research
  --corpus-root PATH     Corpus root. Default: /srv/alphabook/gutenberg
  --root-dir PATH        Repo root. Default: /srv/alphabook/repo
  --resume-run-dir PATH  Prior wrapper run dir to resume Hermes thread from
  --resume-session-id ID Prior Hermes session id to resume
EOF
  exit 1
}

USER_PROMPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user-prompt)
      [[ $# -ge 2 ]] || usage
      USER_PROMPT="$2"
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
    --root-dir)
      [[ $# -ge 2 ]] || usage
      ROOT_DIR="$2"
      shift 2
      ;;
    --resume-run-dir)
      [[ $# -ge 2 ]] || usage
      RESUME_RUN_DIR="$2"
      shift 2
      ;;
    --resume-session-id)
      [[ $# -ge 2 ]] || usage
      RESUME_SESSION_ID="$2"
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
if [[ -n "$RESUME_RUN_DIR" ]]; then
  [[ -d "$RESUME_RUN_DIR" ]] || { echo "Missing resume run dir: $RESUME_RUN_DIR" >&2; exit 1; }
fi
mkdir -p "$RUN_ROOT"

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

if [[ -f "$ENV_FILE" ]]; then
  export OPENAI_API_KEY="$(load_key "$ENV_FILE")"
elif [[ -f "$FALLBACK_ENV_FILE" ]]; then
  export OPENAI_API_KEY="$(load_key "$FALLBACK_ENV_FILE")"
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
profiler_pid_file="$runtime_dir/profiler.pid"
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
ln -sfn "attempts/$attempt_id/logs/profile.jsonl" "$run_dir/profile.jsonl"
ln -sfn "attempts/$attempt_id/logs/profile-summary.json" "$run_dir/profile-summary.json"
ln -sfn "attempts/$attempt_id/logs/command-snapshots.jsonl" "$run_dir/command-snapshots.jsonl"
ln -sfn "attempts/$attempt_id/runtime/hermes.pid" "$run_dir/hermes.pid"
ln -sfn "attempts/$attempt_id/runtime/heartbeat.pid" "$run_dir/heartbeat.pid"
ln -sfn "attempts/$attempt_id/runtime/profiler.pid" "$run_dir/profiler.pid"
ln -sfn "attempts/$attempt_id/runtime/inner-run-dir.txt" "$run_dir/inner-run-dir.txt"
ln -sfn "attempts/$attempt_id/hermes-home" "$run_dir/hermes-home"
ln -sfn "attempts/$attempt_id" "$run_dir/current-attempt"

if [[ -n "$RESUME_RUN_DIR" && -d "$RESUME_RUN_DIR/hermes-home/.hermes" ]]; then
  mkdir -p "$hermes_home/.hermes"
  cp -R "$RESUME_RUN_DIR/hermes-home/.hermes/." "$hermes_home/.hermes/"
  mkdir -p "$hermes_home/.hermes/sessions"
fi

if [[ -z "$RESUME_SESSION_ID" && -n "$RESUME_RUN_DIR" ]]; then
  RESUME_SESSION_ID="$(python3 - "$RESUME_RUN_DIR" <<'PY'
from pathlib import Path
import json
import sys

run_dir = Path(sys.argv[1])
for candidate in (run_dir / "status.json", run_dir / "hermes.session.json"):
    if not candidate.exists():
        continue
    try:
        payload = json.loads(candidate.read_text())
    except Exception:
        continue
    session_id = payload.get("hermes_session_id") or payload.get("session_id")
    if isinstance(session_id, str) and session_id.strip():
        print(session_id.strip())
        raise SystemExit
sessions_dir = run_dir / "hermes-home" / ".hermes" / "sessions"
session_files = sorted(sessions_dir.glob("session_*.json"))
if session_files:
    print(session_files[-1].stem.removeprefix("session_"))
PY
)"
fi

if [[ -f "$HERMES_CONFIG_SOURCE" ]]; then
  cp "$HERMES_CONFIG_SOURCE" "$hermes_home/.hermes/config.yaml"
else
  cat >"$hermes_home/.hermes/config.yaml" <<EOF
model:
  default: "$MODEL"
  provider: "custom"
  base_url: "http://127.0.0.1:8790/runs/$job_id/v1"
EOF
fi

if [[ -f "$HERMES_ENV_SOURCE" ]]; then
  cp "$HERMES_ENV_SOURCE" "$hermes_home/.hermes/.env"
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
if re.search(r'^\s*base_url:\s*".*"$', text, flags=re.MULTILINE):
    text = re.sub(r'^\s*base_url:\s*".*"$', f'  base_url: "http://127.0.0.1:8790/runs/{job_id}/v1"', text, count=1, flags=re.MULTILINE)
else:
    text += f'\n  base_url: "http://127.0.0.1:8790/runs/{job_id}/v1"\n'
path.write_text(text)
PY

python3 - "$prompt_file" "$CORPUS_ROOT" "$USER_PROMPT" "$RESUME_SESSION_ID" "$RESUME_RUN_DIR" <<'PY'
from pathlib import Path
import sys
import json

prompt_path = Path(sys.argv[1])
corpus_root = sys.argv[2]
user_prompt = sys.argv[3]
resume_session_id = sys.argv[4].strip()
resume_run_dir = Path(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5].strip() else None

if resume_session_id:
    inner_run_dir = None
    if resume_run_dir:
        for candidate in (
            resume_run_dir / "index.json",
            resume_run_dir / "status.json",
            resume_run_dir / "summary.json",
        ):
            if not candidate.exists():
                continue
            try:
                payload = json.loads(candidate.read_text())
            except Exception:
                continue
            value = payload.get("inner_run_dir")
            if isinstance(value, str) and value.strip():
                inner_run_dir = value.strip()
                break

    follow_up_prompt = f"""You are continuing an existing Hermes research thread on this droplet.

This is a follow-up user message, not a fresh top-level run.

Resume behavior requirements:
- Do not restart corpus setup, manifest generation, or broad retrieval if the prior run artifacts already contain what you need.
- Reuse the existing thread context, prior findings, existing dataset files, and prior briefing artifacts first.
- Only create a new corpus-research run directory if the follow-up genuinely requires new extraction or a materially different search.
- If you do need a new run, say why in the new manifest and keep it incremental.
- Prefer inspecting existing artifacts and answering from them over rerunning broad helper scripts.
- Treat helper scripts as optional tools, not mandatory first steps on a follow-up.

Prior wrapper run directory:
- {resume_run_dir if resume_run_dir else "unknown"}

Prior inner corpus run directory:
- {inner_run_dir or "unknown"}

User follow-up:
{user_prompt}
"""
    prompt_path.write_text(follow_up_prompt)
    raise SystemExit

prompt = f"""You are on a DigitalOcean droplet with a Project Gutenberg mirror at {corpus_root}.

A user has submitted this research request:

<USER_RESEARCH_PROMPT>
{user_prompt}
</USER_RESEARCH_PROMPT>

Your job is to turn that request into a self-contained corpus research run.

Core objective:
Produce:
1. A structured dataset extracted from the Gutenberg mirror.
2. A briefing based on that dataset.
3. A citation index over that dataset.
4. Any lightweight visualizations that materially improve the briefing.

This is a reproducible research run, not a quick grep report.

Run structure:
- Create a timestamped run directory with a run ID under:
  /srv/alphabook/logs/corpus-research/<timestamp>-<run-id>/
- Log your work as you go in that run directory.
- Save all outputs there so the run is inspectable and idempotent.

Required first step:
1. Interpret the user request.
2. Decide the corpus scope for this request.
   - You may use the entire Project Gutenberg mirror if the request truly applies to the full corpus.
   - Only narrow to a subset if a subset is actually relevant and materially improves the quality of the run.
   - If you choose a subset, explicitly state:
     - the chosen subset
     - why it is relevant
     - how you approximated it from the locally available data
   - If you choose the full corpus, state that explicitly and explain why.
   - Save the scope decision and rationale in the manifest and briefing.

Required second step:
3. Decide the dataset schema before extraction.
   - Decide whether quotes/passages should be labeled or structured.
   - Be pragmatic and consistent.
   - At minimum consider fields like:
     - record_id
     - source_file
     - source_title if inferable
     - source_author if inferable
     - source_year_or_period if inferable
     - corpus_scope
     - quote
     - theme_label
     - confidence
     - keyword_hits
     - reasoning
     - notes
   - Briefly justify the schema, then use it consistently.

Extraction requirements:
- Use terminal tools.
- Use ripgrep as the primary search and extraction mechanism over the chosen corpus scope.
- Use multiple query terms, variants, and concept clusters, not just one literal phrase.
- Prefer high recall first, then structure and deduplicate.
- For every candidate hit found by ripgrep, inspect the matched passage and the relevant text immediately before and after it.
- Use reasoning over that local context to determine whether the quote is actually relevant to the user's request.
- Do not keep a quote just because it matched a keyword.
- Extract exact quotes/passages with enough context to stand alone.
- Each extracted quote must include a short reasoning field explaining why it is relevant.
- Record provenance for every extracted item.
- Deduplicate repeated/near-duplicate hits where practical.

Process requirements:
- Avoid long single shell commands that are likely to time out.
- Prefer bounded terminal commands and append progress updates to run.log frequently.
- If a search step is large, break it into smaller chunks and persist intermediate files in the run directory.
- Decide and record the chosen scope before starting any ripgrep search.
- Search raw text only. Do not use HTML, RDF, EPUB metadata, cache files, or other non-text derivatives for the main corpus search.
- Use the provided helper scripts when available:
  - /srv/alphabook/repo/ops/digitalocean/bin/prepare-text-corpus-manifest.sh
  - /srv/alphabook/repo/ops/digitalocean/bin/run-ripgrep-progress.sh
- Use the helpers with their actual CLI syntax. Example invocations:
  - `/srv/alphabook/repo/ops/digitalocean/bin/prepare-text-corpus-manifest.sh --output-dir "$RUN_DIR/prepared" --corpus-root "{corpus_root}"`
  - `/srv/alphabook/repo/ops/digitalocean/bin/run-ripgrep-progress.sh --file-list "$RUN_DIR/prepared/scoped-text-files.tsv" --pattern '<regex>' --output-dir "$RUN_DIR/search"`
- Do not pass `{corpus_root}` as a bare positional argument to helper scripts.
- The manifest helper writes `all-text-files.tsv` under the output dir; if you derive a scoped subset, write it as another TSV with the same `size_bytes<TAB>absolute_path` format before calling the ripgrep helper.
- The wrapper exported an explicit handoff file path in `$WRAPPER_INNER_RUN_FILE`. After you create the inner corpus run directory, write that absolute path into `$WRAPPER_INNER_RUN_FILE` immediately so the wrapper can associate the run without parsing logs.
- The required order is:
  1. decide scope
  2. write chosen_scope and scope_rationale into the run manifest
  3. prepare the text-only manifest
  4. derive a scoped text-only file list
  5. run the progress-aware ripgrep helper over that scoped text-only file list
- When you invoke repo helpers on this droplet, use the repo-root absolute paths under `/srv/alphabook/repo/...`, not `/srv/alphabook/ops/...`.
- Do not run a single raw `rg` command directly over /srv/alphabook/gutenberg.

Analysis requirements:
- Build the structured dataset.
- Build the citation index.
- Build a markdown briefing that explains:
  - the interpreted user request
  - the chosen corpus scope and why
  - extraction method
  - schema
  - main findings/themes
  - caveats, limits, and likely false positives/false negatives
- The briefing should read like a polished research memo, not a mechanical report.
- It should make clear interpretive points, not just dump themes or counts.
- Prefer findings that are memorable, surprising, or sharply representative.
- For the briefing and synthesis stage, use your own model judgment to select evidence and write the prose.
- Do not generate a deterministic script whose job is to mechanically write the final briefing for you.
- Terminal tools are for retrieval, extraction, filtering, inspection, and artifact assembly; the interpretive briefing itself should be authored by the agent from the evidence.
- In each main finding section, make a claim, explain why it matters, and support it with exact quotes plus citation markers.
- Introduce quotes with source context when available, such as title, author, and year.
- Avoid prose like `sample top matches` or empty label-dump headings.
- Exclude obvious front matter, tables of contents, legal boilerplate, donation text, and other non-literary noise from the featured briefing examples when better literary evidence exists.
- Build lightweight visualizations if useful.
  - Markdown tables, CSV summaries, JSON summaries, or SVG charts are fine.

Required outputs:
- manifest.json
- run.log
- dataset.jsonl
- dataset.csv
- citation-index.json
- briefing.md
- any visualization artifacts you generate

Manifest must include:
- run_id
- timestamp
- user_prompt
- corpus_root
- chosen_scope
- scope_rationale
- search_strategy_summary
- schema_summary
- output_file_list
- record_counts
- status

Quality bar:
- Do not stop after a tiny sample unless the chosen scope is intentionally tiny and well justified.
- Search the full chosen scope.
- Use exact quotes in the dataset.
- Every kept quote must have a reasoning field explaining relevance.
- The briefing must make synthesized, defensible points from the evidence rather than mechanically sampling records.
- Prefer a useful, inspectable dataset over a clever but opaque workflow.

At the end:
- Print the run directory path.
- Print a short summary of:
  - chosen scope
  - record count
  - labels/themes used
  - main output files
"""

prompt_path.write_text(prompt)
PY

python3 - "$status_file" "$summary_file" "$timestamp" "$run_id" "$job_id" "$ROOT_DIR" "$CORPUS_ROOT" "$MODEL" "$MAX_TURNS" "$USER_PROMPT" "$RESUME_RUN_DIR" "$RESUME_SESSION_ID" <<'PY'
from pathlib import Path
import json
import sys

status_path = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
payload = {
    "timestamp": sys.argv[3],
    "run_id": sys.argv[4],
    "job_id": sys.argv[5],
    "root_dir": sys.argv[6],
    "corpus_root": sys.argv[7],
    "model": sys.argv[8],
    "max_turns": int(sys.argv[9]),
    "user_prompt": sys.argv[10],
    "resumed_from_run_dir": sys.argv[11] or None,
    "resumed_session_id": sys.argv[12] or None,
    "state": "launching",
    "run_dir": str(status_path.parent.parent),
    "state_dir": str(status_path.parent),
    "attempt_id": "attempt-0001",
    "attempt_dir": str(status_path.parent.parent / "attempts" / "attempt-0001"),
    "logs_dir": str(status_path.parent.parent / "attempts" / "attempt-0001" / "logs"),
    "runtime_dir": str(status_path.parent.parent / "attempts" / "attempt-0001" / "runtime"),
}
status_path.write_text(json.dumps(payload, indent=2) + "\n")
summary_path.write_text(json.dumps(payload, indent=2) + "\n")
PY

python3 - "$attempt_manifest_file" "$run_dir" "$attempt_dir" "$attempt_id" "$timestamp" <<'PY'
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
    "hermes_home": str(Path(sys.argv[2]) / "hermes-home"),
}
Path(sys.argv[1]).joinpath("attempts", sys.argv[3], "attempt.json").write_text(json.dumps(payload, indent=2) + "\n")
PY

cat >"$run_dir/run-hermes.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

echo "launcher_started_at=$(date -u +%FT%TZ)"
echo "pwd=$(pwd)"
echo "model=$MODEL"
echo "max_turns=$MAX_TURNS"
echo "prompt_file=$PROMPT_FILE"
echo "job_id=$JOB_ID"
echo "hermes_home=$HOME"
echo "resume_session_id=${RESUME_SESSION_ID:-}"
echo "attempt_id=${ATTEMPT_ID:-}"
echo "attempt_dir=${ATTEMPT_DIR:-}"
echo "inner_run_file=${WRAPPER_INNER_RUN_FILE:-}"

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
if [[ -n "${RESUME_SESSION_ID:-}" ]]; then
  hermes chat --resume "$RESUME_SESSION_ID" -m "$MODEL" -q "$(cat "$PROMPT_FILE")" -Q --max-turns "$MAX_TURNS" --yolo > >(stdbuf -oL tee -a "$STDOUT_LOG") 2> >(stdbuf -oL tee -a "$STDERR_LOG" >&2)
else
  hermes chat -m "$MODEL" -q "$(cat "$PROMPT_FILE")" -Q --max-turns "$MAX_TURNS" --yolo > >(stdbuf -oL tee -a "$STDOUT_LOG") 2> >(stdbuf -oL tee -a "$STDERR_LOG" >&2)
fi
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
data = json.loads(status_path.read_text())
data["finished_at"] = finished_at
data["exit_code"] = exit_code
data["state"] = "completed" if exit_code == 0 else "failed"
status_path.write_text(json.dumps(data, indent=2) + "\n")
summary_path.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "$exit_code" > "$RUN_DIR/exit_code"
echo "launcher_finished_at=$(date -u +%FT%TZ)"
echo "exit_code=$exit_code"

exit "$exit_code"
EOS
chmod +x "$run_dir/run-hermes.sh"

{
  echo "timestamp=$timestamp"
  echo "run_id=$run_id"
  echo "run_dir=$run_dir"
  echo "state_dir=$state_dir"
  echo "attempt_dir=$attempt_dir"
  echo "logs_dir=$logs_dir"
  echo "runtime_dir=$runtime_dir"
  echo "root_dir=$ROOT_DIR"
  echo "corpus_root=$CORPUS_ROOT"
  echo "model=$MODEL"
  echo "max_turns=$MAX_TURNS"
  echo "resume_run_dir=$RESUME_RUN_DIR"
  echo "resume_session_id=$RESUME_SESSION_ID"
} >"$launcher_log"

(
  cd "$ROOT_DIR"
  export PATH="$HOME/.local/bin:$PATH"
  export MODEL
  export MAX_TURNS
  export PROMPT_FILE="$prompt_file"
  export STDOUT_LOG="$stdout_log"
  export STDERR_LOG="$stderr_log"
  export STATUS_FILE="$status_file"
  export SUMMARY_FILE="$summary_file"
  export RUN_DIR="$run_dir"
  export JOB_ID="$job_id"
  export RESUME_SESSION_ID="$RESUME_SESSION_ID"
  export ATTEMPT_ID="$attempt_id"
  export ATTEMPT_DIR="$attempt_dir"
  export WRAPPER_RUN_DIR="$run_dir"
  export WRAPPER_INNER_RUN_FILE="$inner_run_file"
  export HOME="$hermes_home"
  nohup "$run_dir/run-hermes.sh" >>"$launcher_log" 2>&1 &
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

profile_script="$ROOT_DIR/ops/digitalocean/bin/profile-hermes-corpus-research.sh"
if [[ -x "$profile_script" ]]; then
  (
    nohup "$profile_script" --run-dir "$run_dir" >>"$launcher_log" 2>&1 &
    echo $! >"$profiler_pid_file"
  ) >/dev/null
fi

materialize_script="$ROOT_DIR/ops/digitalocean/bin/materialize-hermes-run-index.py"
if [[ -x "$materialize_script" ]]; then
  (
    while kill -0 "$pid" 2>/dev/null; do
      python3 "$materialize_script" --run-dir "$run_dir" >/dev/null 2>&1 || true
      sleep "$HEARTBEAT_SECONDS"
    done
    python3 "$materialize_script" --run-dir "$run_dir" >/dev/null 2>&1 || true
  ) >/dev/null 2>&1 &
fi

python3 - "$status_file" "$pid" "$run_dir" "$(date -u +%FT%TZ)" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["state"] = "running"
data["pid"] = int(sys.argv[2])
data["run_dir"] = sys.argv[3]
data["launched_at"] = sys.argv[4]
data["index_file"] = str(Path(sys.argv[3]) / "index.json")
path.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "$run_dir"
