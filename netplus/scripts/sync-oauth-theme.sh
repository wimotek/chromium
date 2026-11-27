#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Sync NetPulse Hosted Login Theme to wimotek/Oauth
# Usage:
#   WIMOTEK_ADMIN_SESSION_TOKEN="<token>" ./scripts/sync-oauth-theme.sh
# Optional overrides:
#   OAUTH_ISSUER="http://ca.wimotek.com"
#   OAUTH_CLIENT_ID="wimotek_ebb129ddb83c"
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THEME_FILE="${THEME_FILE:-$SCRIPT_DIR/oauth-theme.json}"
OAUTH_ISSUER="${OAUTH_ISSUER:-http://ca.wimotek.com}"
OAUTH_CLIENT_ID="${OAUTH_CLIENT_ID:-wimotek_ebb129ddb83c}"

if [[ -z "${WIMOTEK_ADMIN_SESSION_TOKEN:-}" ]]; then
  echo "Error: WIMOTEK_ADMIN_SESSION_TOKEN environment variable is required." >&2
  echo "Example: WIMOTEK_ADMIN_SESSION_TOKEN='<your-admin-token>' $0" >&2
  exit 1
fi

if [[ ! -f "$THEME_FILE" ]]; then
  echo "Error: Theme file not found at $THEME_FILE" >&2
  exit 1
fi

UPDATE_URL="${OAUTH_ISSUER%/}/api/applications/${OAUTH_CLIENT_ID}/theme"
VERIFY_URL="${OAUTH_ISSUER%/}/api/public/theme?client_id=${OAUTH_CLIENT_ID}"

echo "Syncing NetPulse theme to ${UPDATE_URL} ..."
curl -fsS -X PUT "$UPDATE_URL" \
  -H "Authorization: Bearer ${WIMOTEK_ADMIN_SESSION_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@${THEME_FILE}"
echo ""
echo "Theme updated successfully. Verifying public read endpoint (${VERIFY_URL}) ..."
curl -fsS "$VERIFY_URL"
echo ""
