#!/usr/bin/env bash
set -euo pipefail

# Synchronizes wimotek/url design tokens to the wimotek/Oauth hosted login page.
# Usage:
#   export WIMOTEK_ADMIN_SESSION_TOKEN="your_admin_session_token"
#   ./scripts/sync-oauth-theme.sh

ISSUER_URL="${OAUTH_ISSUER:-https://auth.wimotek.com}"
CLIENT_ID="${OAUTH_CLIENT_ID:-wimotek_c41ac24274c6}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THEME_FILE="${SCRIPT_DIR}/../oauth-theme.json"

if [[ -z "${WIMOTEK_ADMIN_SESSION_TOKEN:-}" ]]; then
  echo "Error: WIMOTEK_ADMIN_SESSION_TOKEN environment variable is required." >&2
  echo "Example: WIMOTEK_ADMIN_SESSION_TOKEN=... $0" >&2
  exit 1
fi

echo "Syncing wimotek/url theme to ${ISSUER_URL}/api/applications/${CLIENT_ID}/theme ..."

curl -fsS -X PUT "${ISSUER_URL}/api/applications/${CLIENT_ID}/theme" \
  -H "Authorization: Bearer ${WIMOTEK_ADMIN_SESSION_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@${THEME_FILE}"

echo ""
echo "Theme synchronized successfully. Verify public theme via:"
echo "  curl -s \"${ISSUER_URL}/api/public/theme?client_id=${CLIENT_ID}\""
