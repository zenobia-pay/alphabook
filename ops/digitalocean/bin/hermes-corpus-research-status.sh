#!/usr/bin/env bash
set -euo pipefail

RUN_ROOT="${RUN_ROOT:-/srv/alphabook/logs/hermes-corpus-research}"
TAIL_LINES="${TAIL_LINES:-20}"

usage() {
  cat >&2 <<'EOF'
Usage: hermes-corpus-research-status.sh [run-dir]

Without a run-dir, the most recent Hermes corpus-research run is used.
EOF
  exit 1
}

if [[ $# -gt 1 ]]; then
  usage
fi

if [[ $# -eq 1 ]]; then
  run_dir="$1"
else
  run_dir="$(find "$RUN_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | tail -n1)"
fi

[[ -n "${run_dir:-}" && -d "$run_dir" ]] || { echo "No Hermes corpus-research run directory found" >&2; exit 1; }

pid_file="$run_dir/hermes.pid"
status_file="$run_dir/status.json"
stdout_log="$run_dir/hermes.stdout.log"
stderr_log="$run_dir/hermes.stderr.log"
launcher_log="$run_dir/launcher.log"
heartbeat_log="$run_dir/heartbeat.log"
profile_file="$run_dir/profile.jsonl"
profile_summary_file="$run_dir/profile-summary.json"
command_log_file="$run_dir/command-snapshots.jsonl"
latest_inner=""
latest_ripgrep_status=""

if [[ -d /srv/alphabook/logs/corpus-research ]]; then
  latest_inner="$(find /srv/alphabook/logs/corpus-research -mindepth 1 -maxdepth 1 -type d | sort | tail -n1)"
  if [[ -n "$latest_inner" && -f "$latest_inner/search/ripgrep-status.json" ]]; then
    latest_ripgrep_status="$latest_inner/search/ripgrep-status.json"
  fi
fi

echo "run_dir=$run_dir"

if [[ -f "$pid_file" ]]; then
  pid="$(cat "$pid_file")"
  echo "pid=$pid"
  if kill -0 "$pid" 2>/dev/null; then
    echo "process_state=running"
    ps -p "$pid" -o pid=,etimes=,%cpu=,%mem=,command=
  else
    echo "process_state=not-running"
  fi
else
  echo "pid=missing"
fi

if [[ -f "$status_file" ]]; then
  echo "--- status.json ---"
  cat "$status_file"
fi

if [[ -f "$heartbeat_log" ]]; then
  echo "--- heartbeat tail ---"
  tail -n "$TAIL_LINES" "$heartbeat_log"
fi

if [[ -f "$launcher_log" ]]; then
  echo "--- launcher tail ---"
  tail -n "$TAIL_LINES" "$launcher_log"
fi

if [[ -f "$profile_file" ]]; then
  echo "--- profile tail ---"
  tail -n "$TAIL_LINES" "$profile_file"
fi

if [[ -f "$command_log_file" ]]; then
  echo "--- command snapshots tail ---"
  tail -n "$TAIL_LINES" "$command_log_file"
fi

if [[ -f "$profile_summary_file" ]]; then
  echo "--- profile summary ---"
  cat "$profile_summary_file"
fi

if [[ -n "$latest_inner" ]]; then
  echo "--- latest inner run ---"
  echo "$latest_inner"
fi

if [[ -n "$latest_ripgrep_status" ]]; then
  echo "--- ripgrep status ---"
  cat "$latest_ripgrep_status"
fi

if [[ -f "$stdout_log" ]]; then
  echo "--- hermes stdout tail ---"
  tail -n "$TAIL_LINES" "$stdout_log"
fi

if [[ -f "$stderr_log" ]]; then
  echo "--- hermes stderr tail ---"
  tail -n "$TAIL_LINES" "$stderr_log"
fi
