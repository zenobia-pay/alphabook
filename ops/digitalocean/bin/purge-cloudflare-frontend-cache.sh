#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
ZONE_NAME="${ALPHABOOK_CLOUDFLARE_ZONE_NAME:-alpha-book.org}"
PRIMARY_HOST="${ALPHABOOK_CLOUDFLARE_PRIMARY_HOST:-alpha-book.org}"
SECONDARY_HOST="${ALPHABOOK_CLOUDFLARE_SECONDARY_HOST:-www.alpha-book.org}"
PURGE_ENABLED="${ALPHABOOK_CLOUDFLARE_PURGE_ENABLED:-1}"
PURGE_REQUIRED="${ALPHABOOK_CLOUDFLARE_PURGE_REQUIRED:-0}"

read_env_var() {
  local key="$1"
  local file="$2"
  node - "$key" "$file" <<'NODE'
const fs = require("node:fs");

const key = process.argv[2];
const file = process.argv[3];
try {
  const content = fs.readFileSync(file, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) continue;
    const entryKey = line.slice(0, separatorIndex).trim();
    if (entryKey !== key) continue;
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.stdout.write(value);
    process.exit(0);
  }
} catch {
  // Ignore missing or unreadable env files.
}
NODE
}

if [[ "$PURGE_ENABLED" != "1" ]]; then
  echo "Cloudflare frontend cache purge disabled via ALPHABOOK_CLOUDFLARE_PURGE_ENABLED=$PURGE_ENABLED"
  exit 0
fi

CLOUDFLARE_TOKEN="${ALPHABOOK_CLOUDFLARE_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
ZONE_ID="${ALPHABOOK_CLOUDFLARE_ZONE_ID:-${CLOUDFLARE_ZONE_ID:-}}"

if [[ -z "$CLOUDFLARE_TOKEN" && -f "$ENV_FILE" ]]; then
  CLOUDFLARE_TOKEN="$(read_env_var "ALPHABOOK_CLOUDFLARE_API_TOKEN" "$ENV_FILE")"
fi

if [[ -z "$CLOUDFLARE_TOKEN" && -f "$ENV_FILE" ]]; then
  CLOUDFLARE_TOKEN="$(read_env_var "CLOUDFLARE_API_TOKEN" "$ENV_FILE")"
fi

if [[ -z "$ZONE_ID" && -f "$ENV_FILE" ]]; then
  ZONE_ID="$(read_env_var "ALPHABOOK_CLOUDFLARE_ZONE_ID" "$ENV_FILE")"
fi

if [[ -z "$ZONE_ID" && -f "$ENV_FILE" ]]; then
  ZONE_ID="$(read_env_var "CLOUDFLARE_ZONE_ID" "$ENV_FILE")"
fi

if [[ -z "$CLOUDFLARE_TOKEN" ]]; then
  echo "Skipping Cloudflare frontend cache purge because no API token is configured." >&2
  exit 0
fi

warn_or_fail() {
  local message="$1"
  if [[ "$PURGE_REQUIRED" == "1" ]]; then
    echo "$message" >&2
    exit 1
  fi
  echo "$message" >&2
  exit 0
}

zone_lookup_body=""
purge_body=""
cleanup() {
  [[ -n "$zone_lookup_body" ]] && rm -f "$zone_lookup_body"
  [[ -n "$purge_body" ]] && rm -f "$purge_body"
}
trap cleanup EXIT

if [[ -z "$ZONE_ID" ]]; then
  zone_lookup_body="$(mktemp)"

  zone_lookup_status="$(
    curl -sS -o "$zone_lookup_body" -w '%{http_code}' \
      -H "Authorization: Bearer $CLOUDFLARE_TOKEN" \
      -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}"
  )"

  if [[ "$zone_lookup_status" != "200" ]]; then
    warn_or_fail "Skipping Cloudflare frontend cache purge because zone lookup returned HTTP ${zone_lookup_status}. Configure a token with Zone Read and Cache Purge permissions or set ALPHABOOK_CLOUDFLARE_ZONE_ID."
  fi

  ZONE_ID="$(
    node - "$zone_lookup_body" <<'NODE'
const fs = require("node:fs");
const filePath = process.argv[2];
const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
const zoneId = payload?.result?.[0]?.id;
if (!zoneId) {
  process.exit(1);
}
process.stdout.write(zoneId);
NODE
  )" || {
    warn_or_fail "Skipping Cloudflare frontend cache purge because the Cloudflare zone lookup response did not include a zone ID for ${ZONE_NAME}."
  }
fi

PAYLOAD="$(PRIMARY_HOST="$PRIMARY_HOST" SECONDARY_HOST="$SECONDARY_HOST" node - <<'NODE'
const hosts = [
  process.env.PRIMARY_HOST,
  process.env.SECONDARY_HOST,
].map((value) => (value ?? "").trim()).filter(Boolean);
process.stdout.write(JSON.stringify({ hosts: [...new Set(hosts)] }));
NODE
)"

purge_body="$(mktemp)"

purge_status="$(
  curl -sS -o "$purge_body" -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer $CLOUDFLARE_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$PAYLOAD" \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache"
)"

if [[ "$purge_status" != "200" ]]; then
  warn_or_fail "Skipping Cloudflare frontend cache purge because the purge request returned HTTP ${purge_status}. Configure a token with Cache Purge permission or set ALPHABOOK_CLOUDFLARE_PURGE_REQUIRED=1 to make this fatal."
fi

if ! node - "$purge_body" <<'NODE'
const fs = require("node:fs");
const filePath = process.argv[2];
const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
if (!payload?.success) {
  process.exitCode = 1;
  const errors = JSON.stringify(payload?.errors ?? payload);
  console.error(`Cloudflare purge failed: ${errors}`);
}
NODE
then
  warn_or_fail "Skipping Cloudflare frontend cache purge because Cloudflare rejected the purge request payload. Configure a token with Cache Purge permission or set ALPHABOOK_CLOUDFLARE_PURGE_REQUIRED=1 to make this fatal."
fi

echo "Purged Cloudflare frontend cache for hosts ${PRIMARY_HOST} and ${SECONDARY_HOST} in zone ${ZONE_NAME}."
