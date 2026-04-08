#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.dev.vars}"
BOOK_ID="${1:-}"
BOOKS_HOST="${ALPHABOOK_BOOKS_HOST:-books.alpha-book.org}"
ZONE_NAME="${ALPHABOOK_CLOUDFLARE_ZONE_NAME:-alpha-book.org}"
ZONE_ID="${ALPHABOOK_CLOUDFLARE_ZONE_ID:-${CLOUDFLARE_ZONE_ID:-}}"
CLOUDFLARE_TOKEN="${ALPHABOOK_CLOUDFLARE_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"

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
  // ignore
}
NODE
}

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
  echo "Missing Cloudflare purge token." >&2
  exit 1
fi

if [[ -z "$ZONE_ID" ]]; then
  ZONE_ID="$(
    curl -fsS \
      -H "Authorization: Bearer $CLOUDFLARE_TOKEN" \
      -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}" \
      | node -e '
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const zoneId = payload?.result?.[0]?.id;
if (!zoneId) process.exit(1);
process.stdout.write(zoneId);
'
  )"
fi

payload="$(BOOKS_HOST="$BOOKS_HOST" node - <<'NODE'
const host = (process.env.BOOKS_HOST ?? "").trim();
process.stdout.write(JSON.stringify({ hosts: [host] }));
NODE
)"

curl -fsS \
  -X POST \
  -H "Authorization: Bearer $CLOUDFLARE_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$payload" \
  "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache" \
  | node -e '
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
if (!payload?.success) {
  console.error(JSON.stringify(payload?.errors ?? payload));
  process.exit(1);
}
'

if [[ -n "$BOOK_ID" ]]; then
  echo "Purged ${BOOKS_HOST} cache while refreshing book ${BOOK_ID}."
else
  echo "Purged ${BOOKS_HOST} cache."
fi
