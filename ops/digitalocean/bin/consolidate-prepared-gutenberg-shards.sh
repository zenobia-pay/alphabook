#!/usr/bin/env bash
set -euo pipefail

FINAL_HOST="${FINAL_HOST:-qdrant}"
FINAL_PARENT_DIR="${FINAL_PARENT_DIR:-/root/alphabook-prepared/final}"
FINAL_RUN_ID="${FINAL_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
FINAL_DIR="${FINAL_DIR:-$FINAL_PARENT_DIR/$FINAL_RUN_ID}"
LOCAL_SHARDS_ROOT="${LOCAL_SHARDS_ROOT:-/root/alphabook-prepared/shards}"
SSH_KEY_PATH="${SSH_KEY_PATH:-/root/.ssh/alphabook_consolidate}"
POLL_SECONDS="${POLL_SECONDS:-30}"
WAIT_FOR_COMPLETION=0

DEFAULT_EXPECTED_SHARDS="mirror-1 mirror-2-rerun mirror-3 mirror-4 small-1 small-2 small-3 small-4 qdrant-1 qdrant-2 qdrant-3 qdrant-4 qdrant-5 qdrant-5b qdrant-6 qdrant-7 qdrant-7b qdrant-8 qdrant-8b"
EXPECTED_SHARDS="${EXPECTED_SHARDS:-$DEFAULT_EXPECTED_SHARDS}"

declare -a SOURCE_SPECS
if [[ -n "${SOURCE_SPECS_OVERRIDE:-}" ]]; then
  mapfile -t SOURCE_SPECS < <(printf '%s\n' "$SOURCE_SPECS_OVERRIDE" | sed '/^$/d')
else
  SOURCE_SPECS=(
    "mirror=root@10.116.0.3:/root/alphabook-prepared/shards"
    "small=root@10.116.0.2:/root/alphabook-prepared/shards"
    "qdrant=local:$LOCAL_SHARDS_ROOT"
  )
fi

usage() {
  cat >&2 <<'EOF'
Usage: consolidate-prepared-gutenberg-shards.sh [--wait]

Waits for all prep shard workers to stop, verifies the expected shard set exists,
then merges all shard outputs into one final directory.

Config:
  FINAL_HOST            label written to the consolidation manifest
  FINAL_PARENT_DIR      parent folder for consolidated output
  FINAL_RUN_ID          final folder name under FINAL_PARENT_DIR
  FINAL_DIR             explicit final folder path (overrides FINAL_PARENT_DIR/FINAL_RUN_ID)
  LOCAL_SHARDS_ROOT     local shard root on the consolidation box
  SSH_KEY_PATH          SSH private key used to fetch remote shard outputs
  POLL_SECONDS          poll interval when --wait is used
  EXPECTED_SHARDS       space-separated expected shard directory names
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait)
      WAIT_FOR_COMPLETION=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

mkdir -p "$FINAL_DIR/books" "$FINAL_DIR/r2" "$FINAL_DIR/manifests"

join_by() {
  local delimiter="$1"
  shift
  local first=1
  for value in "$@"; do
    if [[ $first -eq 1 ]]; then
      printf '%s' "$value"
      first=0
    else
      printf '%s%s' "$delimiter" "$value"
    fi
  done
}

remote_shell() {
  local host="$1"
  shift
  if [[ "$host" == "local" ]]; then
    bash -lc "$*"
  else
    ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no "$host" "$*"
  fi
}

list_shards() {
  local source_path="$1"
  if [[ "$source_path" == local:* ]]; then
    local local_path="${source_path#local:}"
    find "$local_path" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
  else
    local remote_host="${source_path%%:*}"
    local remote_path="${source_path#*:}"
    remote_shell "$remote_host" "find '$remote_path' -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort"
  fi
}

has_active_workers() {
  local host="$1"
  local command="pgrep -f 'prepare-local-gutenberg-artifacts' >/dev/null 2>&1"
  if remote_shell "$host" "$command"; then
    return 0
  fi
  return 1
}

if [[ $WAIT_FOR_COMPLETION -eq 1 ]]; then
  while true; do
    active=0
    for host in root@10.116.0.3 root@10.116.0.2 local; do
      if has_active_workers "$host"; then
        active=1
        break
      fi
    done
    if [[ $active -eq 0 ]]; then
      break
    fi
    sleep "$POLL_SECONDS"
  done
fi

mapfile -t expected_shards < <(printf '%s\n' $EXPECTED_SHARDS | sed '/^$/d' | sort -u)
declare -A seen_shards=()
declare -A expected_shard_lookup=()
for shard_name in "${expected_shards[@]}"; do
  expected_shard_lookup["$shard_name"]=1
done

sync_local_tree() {
  local shard_path="$1"
  local shard_name="$2"
  [[ -d "$shard_path/books" ]] && rsync -a "$shard_path/books/" "$FINAL_DIR/books/"
  [[ -d "$shard_path/r2" ]] && rsync -a "$shard_path/r2/" "$FINAL_DIR/r2/"
  [[ -f "$shard_path/run-manifest.json" ]] && cp "$shard_path/run-manifest.json" "$FINAL_DIR/manifests/$shard_name.json"
}

sync_remote_tree() {
  local remote_host="$1"
  local remote_path="$2"
  local shard_name="$3"
  local ssh_cmd=("ssh" "-i" "$SSH_KEY_PATH" "-o" "StrictHostKeyChecking=no")
  if remote_shell "$remote_host" "test -d '$remote_path/books'"; then
    rsync -a -e "${ssh_cmd[*]}" "$remote_host:$remote_path/books/" "$FINAL_DIR/books/"
  fi
  if remote_shell "$remote_host" "test -d '$remote_path/r2'"; then
    rsync -a -e "${ssh_cmd[*]}" "$remote_host:$remote_path/r2/" "$FINAL_DIR/r2/"
  fi
  if remote_shell "$remote_host" "test -f '$remote_path/run-manifest.json'"; then
    rsync -a -e "${ssh_cmd[*]}" "$remote_host:$remote_path/run-manifest.json" "$FINAL_DIR/manifests/$shard_name.json"
  fi
}

for spec in "${SOURCE_SPECS[@]}"; do
  source_name="${spec%%=*}"
  source_value="${spec#*=}"
  mapfile -t shard_names < <(list_shards "$source_value")
  for shard_name in "${shard_names[@]}"; do
    if [[ -z "${expected_shard_lookup[$shard_name]:-}" ]]; then
      continue
    fi
    seen_shards["$shard_name"]=1
    if [[ "$source_value" == local:* ]]; then
      sync_local_tree "${source_value#local:}/$shard_name" "$shard_name"
    else
      sync_remote_tree "${source_value%%:*}" "${source_value#*:}/$shard_name" "$shard_name"
    fi
  done
done

missing_shards=()
for shard_name in "${expected_shards[@]}"; do
  if [[ -z "${seen_shards[$shard_name]:-}" ]]; then
    missing_shards+=("$shard_name")
  fi
done

if [[ ${#missing_shards[@]} -gt 0 ]]; then
  echo "Missing expected shards: $(join_by ', ' "${missing_shards[@]}")" >&2
  exit 1
fi

TOTAL_BOOKS="$(find "$FINAL_DIR/books" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
TOTAL_MANIFESTS="$(find "$FINAL_DIR/manifests" -mindepth 1 -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"
R2_FILE_COUNT="$(find "$FINAL_DIR/r2" -type f | wc -l | tr -d ' ')"

python3 - "$FINAL_DIR" "$FINAL_HOST" "$FINAL_RUN_ID" "$TOTAL_BOOKS" "$TOTAL_MANIFESTS" "$R2_FILE_COUNT" "$(join_by ' ' "${expected_shards[@]}")" <<'PY'
from pathlib import Path
import json
import sys

final_dir = Path(sys.argv[1])
payload = {
    "finalHost": sys.argv[2],
    "finalRunId": sys.argv[3],
    "totalBooks": int(sys.argv[4]),
    "totalShardManifests": int(sys.argv[5]),
    "totalR2Files": int(sys.argv[6]),
    "expectedShards": [value for value in sys.argv[7].split(" ") if value],
}
(final_dir / "consolidation-manifest.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

ln -sfn "$FINAL_DIR" "$FINAL_PARENT_DIR/latest"
echo "$FINAL_DIR"
