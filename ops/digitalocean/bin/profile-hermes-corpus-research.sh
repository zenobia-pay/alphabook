#!/usr/bin/env bash
set -euo pipefail

RUN_ROOT_DEFAULT="/srv/alphabook/logs/hermes-corpus-research"
INNER_ROOT_DEFAULT="/srv/alphabook/logs/corpus-research"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-15}"

usage() {
  cat >&2 <<'EOF'
Usage: profile-hermes-corpus-research.sh --run-dir /srv/alphabook/logs/hermes-corpus-research/<run-id>

Samples wrapper, Hermes, ripgrep, and inner corpus-run metrics into profile.jsonl
until the wrapper pid exits.
EOF
  exit 1
}

run_dir=""
inner_root="$INNER_ROOT_DEFAULT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dir)
      [[ $# -ge 2 ]] || usage
      run_dir="$2"
      shift 2
      ;;
    --inner-root)
      [[ $# -ge 2 ]] || usage
      inner_root="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n "$run_dir" ]] || usage
[[ -d "$run_dir" ]] || { echo "Missing run dir: $run_dir" >&2; exit 1; }

pid_file="$run_dir/hermes.pid"
status_file="$run_dir/status.json"
profile_file="$run_dir/profile.jsonl"
profile_summary_file="$run_dir/profile-summary.json"
command_log_file="$run_dir/command-snapshots.jsonl"

[[ -f "$pid_file" ]] || { echo "Missing pid file: $pid_file" >&2; exit 1; }

wrapper_pid="$(cat "$pid_file")"
start_epoch="$(date +%s)"

sample_once() {
  python3 - "$run_dir" "$inner_root" "$wrapper_pid" "$profile_file" "$status_file" "$command_log_file" <<'PY'
from pathlib import Path
import json
import subprocess
import sys
import time

run_dir = Path(sys.argv[1])
inner_root = Path(sys.argv[2])
wrapper_pid = sys.argv[3]
profile_file = Path(sys.argv[4])
status_file = Path(sys.argv[5])
command_log_file = Path(sys.argv[6])

def sh(*args):
    return subprocess.run(args, capture_output=True, text=True, check=False)

def ps_for(pid: str):
    proc = sh("ps", "-p", pid, "-o", "pid=,ppid=,etimes=,%cpu=,%mem=,command=")
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    parts = proc.stdout.strip().split(None, 5)
    if len(parts) < 6:
        return None
    return {
        "pid": int(parts[0]),
        "ppid": int(parts[1]),
        "elapsed_seconds": int(parts[2]),
        "cpu_percent": float(parts[3]),
        "mem_percent": float(parts[4]),
        "command": parts[5],
    }

wrapper = ps_for(wrapper_pid)

hermes = None
rg = None
pgrep = sh("pgrep", "-af", "/root/.local/bin/hermes chat")
for line in pgrep.stdout.splitlines():
    pid = line.split(None, 1)[0]
    candidate = ps_for(pid)
    if candidate and candidate["ppid"] == int(wrapper_pid):
        hermes = candidate
        break

rgrep = sh("pgrep", "-af", "rg --json")
for line in rgrep.stdout.splitlines():
    pid = line.split(None, 1)[0]
    candidate = ps_for(pid)
    if candidate and "/srv/alphabook/gutenberg" in candidate["command"]:
        rg = candidate
        break

inner_dir = None
if inner_root.exists():
    candidates = [p for p in inner_root.iterdir() if p.is_dir()]
    if candidates:
      inner_dir = max(candidates, key=lambda p: p.stat().st_mtime)

inner = None
if inner_dir:
    manifest = inner_dir / "manifest.json"
    rg_hits = inner_dir / "rg_hits.jsonl"
    run_log = inner_dir / "run.log"
    ripgrep_status = inner_dir / "search" / "ripgrep-status.json"
    ripgrep_progress = inner_dir / "search" / "ripgrep-progress.jsonl"
    files = sorted(p.name for p in inner_dir.iterdir() if p.is_file())
    inner = {
        "run_dir": str(inner_dir),
        "files": files,
        "file_count": len(files),
        "run_log_size": run_log.stat().st_size if run_log.exists() else None,
        "rg_hits_size": rg_hits.stat().st_size if rg_hits.exists() else None,
        "rg_hits_mtime": rg_hits.stat().st_mtime if rg_hits.exists() else None,
    }
    if manifest.exists():
        try:
            manifest_data = json.loads(manifest.read_text())
            inner["chosen_scope"] = manifest_data.get("chosen_scope")
            inner["scope_rationale"] = manifest_data.get("scope_rationale")
            inner["manifest_status"] = manifest_data.get("status")
        except Exception:
            pass
    if rg_hits.exists():
        wc = sh("wc", "-l", str(rg_hits))
        try:
            inner["rg_hits_lines"] = int(wc.stdout.strip().split()[0])
        except Exception:
            inner["rg_hits_lines"] = None
    if ripgrep_status.exists():
        try:
            inner["ripgrep_status"] = json.loads(ripgrep_status.read_text())
        except Exception:
            pass
    if ripgrep_progress.exists():
        try:
            lines = [line for line in ripgrep_progress.read_text().splitlines() if line.strip()]
            if lines:
                inner["ripgrep_progress_tail"] = json.loads(lines[-1])
        except Exception:
            pass
    if run_log.exists():
        try:
            tail = run_log.read_text()[-4000:]
            inner["run_log_tail"] = tail
        except Exception:
            pass

phase = "launching"
if inner and inner.get("ripgrep_status") and inner["ripgrep_status"].get("state") == "running":
    phase = "ripgrep"
elif rg:
    phase = "ripgrep"
elif inner and inner.get("rg_hits_lines"):
    phase = "post-ripgrep"
if inner and inner.get("chosen_scope"):
    phase = "scoped"

state = None
if status_file.exists():
    try:
        state = json.loads(status_file.read_text()).get("state")
    except Exception:
        state = None

previous = None
if profile_file.exists():
    lines = [line for line in profile_file.read_text().splitlines() if line.strip()]
    if lines:
        try:
            previous = json.loads(lines[-1])
        except Exception:
            previous = None

throughput = {}
if previous and inner and previous.get("inner"):
    prev_inner = previous["inner"]
    prev_ts = previous.get("timestamp")
    try:
        prev_epoch = int(time.mktime(time.strptime(prev_ts, "%Y-%m-%dT%H:%M:%SZ")))
        now_epoch = int(time.time())
        dt = max(now_epoch - prev_epoch, 1)
        if inner.get("rg_hits_lines") is not None and prev_inner.get("rg_hits_lines") is not None:
            throughput["lines_delta"] = inner["rg_hits_lines"] - prev_inner["rg_hits_lines"]
            throughput["lines_per_second"] = throughput["lines_delta"] / dt
        if inner.get("rg_hits_size") is not None and prev_inner.get("rg_hits_size") is not None:
            throughput["bytes_delta"] = inner["rg_hits_size"] - prev_inner["rg_hits_size"]
            throughput["bytes_per_second"] = throughput["bytes_delta"] / dt
        throughput["sample_interval_seconds"] = dt
    except Exception:
        throughput = {}

sample = {
    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "phase": phase,
    "wrapper": wrapper,
    "hermes": hermes,
    "ripgrep": rg,
    "inner": inner,
    "wrapper_state": state,
    "throughput": throughput,
}

with profile_file.open("a") as f:
    f.write(json.dumps(sample) + "\n")

command_snapshot = {
    "timestamp": sample["timestamp"],
    "phase": phase,
    "hermes_command": hermes["command"] if hermes else None,
    "ripgrep_command": rg["command"] if rg else None,
    "chosen_scope": inner.get("chosen_scope") if inner else None,
    "ripgrep_status": inner.get("ripgrep_status") if inner else None,
}
with command_log_file.open("a") as f:
    f.write(json.dumps(command_snapshot) + "\n")

if status_file.exists():
    try:
        status_data = json.loads(status_file.read_text())
    except Exception:
        status_data = {}
    if inner_dir:
        status_data["inner_run_dir"] = str(inner_dir)
        status_data["inner_run_id"] = inner_dir.name
    hermes_home = run_dir / "hermes-home"
    sessions_dir = hermes_home / ".hermes" / "sessions"
    session_files = sorted(sessions_dir.glob("session_*.json"), key=lambda p: p.stat().st_mtime)
    if session_files:
        latest = session_files[-1]
        status_data["hermes_session_file"] = str(latest)
        status_data["hermes_session_id"] = latest.stem.removeprefix("session_")
    status_file.write_text(json.dumps(status_data, indent=2) + "\n")
PY
}

while kill -0 "$wrapper_pid" 2>/dev/null; do
  sample_once
  sleep "$INTERVAL_SECONDS"
done

sample_once || true

python3 - "$profile_file" "$profile_summary_file" "$start_epoch" <<'PY'
from pathlib import Path
import json
import sys
import time

profile_path = Path(sys.argv[1])
summary_path = Path(sys.argv[2])
start_epoch = int(sys.argv[3])
samples = []
if profile_path.exists():
    for line in profile_path.read_text().splitlines():
        line = line.strip()
        if line:
            samples.append(json.loads(line))

summary = {
    "sample_count": len(samples),
    "started_epoch": start_epoch,
    "finished_epoch": int(time.time()),
}

if samples:
    first = samples[0]
    last = samples[-1]
    summary["first_timestamp"] = first.get("timestamp")
    summary["last_timestamp"] = last.get("timestamp")
    for key in ("wrapper", "hermes", "ripgrep"):
        if first.get(key):
            summary[f"{key}_first"] = first[key]
        if last.get(key):
            summary[f"{key}_last"] = last[key]
    if first.get("inner") and last.get("inner"):
        summary["inner_run_dir"] = last["inner"].get("run_dir")
        summary["rg_hits_lines_first"] = first["inner"].get("rg_hits_lines")
        summary["rg_hits_lines_last"] = last["inner"].get("rg_hits_lines")
        summary["rg_hits_size_first"] = first["inner"].get("rg_hits_size")
        summary["rg_hits_size_last"] = last["inner"].get("rg_hits_size")
        summary["chosen_scope"] = last["inner"].get("chosen_scope")
        summary["manifest_status"] = last["inner"].get("manifest_status")
    summary["last_phase"] = last.get("phase")
    if last.get("throughput"):
        summary["last_throughput"] = last["throughput"]

summary_path.write_text(json.dumps(summary, indent=2) + "\n")
PY
