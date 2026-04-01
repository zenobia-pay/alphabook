#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/srv/alphabook/repo}"
RUN_ROOT="${RUN_ROOT:-/srv/alphabook/logs/hermes-corpus-research}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
FALLBACK_ENV_FILE="${FALLBACK_ENV_FILE:-/srv/alphabook/.ingest.env}"
CORPUS_ROOT="${CORPUS_ROOT:-/srv/alphabook/gutenberg}"
MODEL="${MODEL:-gpt-5.4}"
MAX_TURNS="${MAX_TURNS:-60}"
HEARTBEAT_SECONDS="${HEARTBEAT_SECONDS:-15}"

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
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$USER_PROMPT" ]] || usage
[[ -d "$ROOT_DIR" ]] || { echo "Missing repo root: $ROOT_DIR" >&2; exit 1; }
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

prompt_file="$run_dir/prompt.txt"
launcher_log="$run_dir/launcher.log"
stdout_log="$run_dir/hermes.stdout.log"
stderr_log="$run_dir/hermes.stderr.log"
heartbeat_log="$run_dir/heartbeat.log"
pid_file="$run_dir/hermes.pid"
watcher_pid_file="$run_dir/heartbeat.pid"
profiler_pid_file="$run_dir/profiler.pid"
status_file="$run_dir/status.json"
summary_file="$run_dir/summary.json"

python3 - "$prompt_file" "$CORPUS_ROOT" "$USER_PROMPT" <<'PY'
from pathlib import Path
import sys

prompt_path = Path(sys.argv[1])
corpus_root = sys.argv[2]
user_prompt = sys.argv[3]

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
  - ops/digitalocean/bin/prepare-text-corpus-manifest.sh
  - ops/digitalocean/bin/run-ripgrep-progress.sh
- The required order is:
  1. decide scope
  2. write chosen_scope and scope_rationale into the run manifest
  3. prepare the text-only manifest
  4. derive a scoped text-only file list
  5. run the progress-aware ripgrep helper over that scoped text-only file list
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

python3 - "$status_file" "$summary_file" "$timestamp" "$run_id" "$ROOT_DIR" "$CORPUS_ROOT" "$MODEL" "$MAX_TURNS" "$USER_PROMPT" <<'PY'
from pathlib import Path
import json
import sys

status_path = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
payload = {
    "timestamp": sys.argv[3],
    "run_id": sys.argv[4],
    "root_dir": sys.argv[5],
    "corpus_root": sys.argv[6],
    "model": sys.argv[7],
    "max_turns": int(sys.argv[8]),
    "user_prompt": sys.argv[9],
    "state": "launching",
}
status_path.write_text(json.dumps(payload, indent=2) + "\n")
summary_path.write_text(json.dumps(payload, indent=2) + "\n")
PY

cat >"$run_dir/run-hermes.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

echo "launcher_started_at=$(date -u +%FT%TZ)"
echo "pwd=$(pwd)"
echo "model=$MODEL"
echo "max_turns=$MAX_TURNS"
echo "prompt_file=$PROMPT_FILE"

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
hermes chat -m "$MODEL" -q "$(cat "$PROMPT_FILE")" -Q --max-turns "$MAX_TURNS" --yolo > >(stdbuf -oL tee -a "$STDOUT_LOG") 2> >(stdbuf -oL tee -a "$STDERR_LOG" >&2)
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
  echo "root_dir=$ROOT_DIR"
  echo "corpus_root=$CORPUS_ROOT"
  echo "model=$MODEL"
  echo "max_turns=$MAX_TURNS"
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
  nohup "$run_dir/run-hermes.sh" >>"$launcher_log" 2>&1 &
  echo $! >"$pid_file"
) >/dev/null

pid="$(cat "$pid_file")"

(
  while kill -0 "$pid" 2>/dev/null; do
    printf '%s pid=%s alive\n' "$(date -u +%FT%TZ)" "$pid" >>"$heartbeat_log"
    sleep "$HEARTBEAT_SECONDS"
  done
  printf '%s pid=%s exited\n' "$(date -u +%FT%TZ)" "$pid" >>"$heartbeat_log"
) >/dev/null 2>&1 &
echo $! >"$watcher_pid_file"

profile_script="$ROOT_DIR/ops/digitalocean/bin/profile-hermes-corpus-research.sh"
if [[ -x "$profile_script" ]]; then
  (
    nohup "$profile_script" --run-dir "$run_dir" >>"$launcher_log" 2>&1 &
    echo $! >"$profiler_pid_file"
  ) >/dev/null
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
path.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "$run_dir"
