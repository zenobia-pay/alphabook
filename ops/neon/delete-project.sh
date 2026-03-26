#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${NEON_API_KEY:-}" ]]; then
  echo "NEON_API_KEY is required." >&2
  exit 1
fi

if [[ -z "${NEON_PROJECT_ID:-}" ]]; then
  echo "NEON_PROJECT_ID is required." >&2
  exit 1
fi

if [[ "${CONFIRM_DELETE_NEON_PROJECT:-}" != "yes" ]]; then
  echo "Refusing to delete Neon project without CONFIRM_DELETE_NEON_PROJECT=yes" >&2
  exit 1
fi

curl --fail-with-body \
  --request DELETE \
  --url "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}" \
  --header "Authorization: Bearer ${NEON_API_KEY}" \
  --header "Accept: application/json"
