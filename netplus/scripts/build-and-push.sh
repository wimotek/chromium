#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# NetPulse Compile-First Build & Push Script
# Step 1: Type-check TypeScript (tsc --noEmit)
# Step 2: Compile Frontend (Vite -> dist/) & Backend (esbuild -> dist-server/server.mjs)
# Step 3: Run local production runtime smoke test (/api/health + /)
# Step 4: Build & push multi-arch Docker image via Dockerfile.release
#
# Usage:
#   ./scripts/build-and-push.sh <image-repo> [tag] [platforms]
#
# Examples:
#   ./scripts/build-and-push.sh wimotek/netplus latest
#   ./scripts/build-and-push.sh ghcr.io/wimotek/netplus latest
#   NO_PUSH=true ./scripts/build-and-push.sh wimotek/netplus local
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_DIR}"

IMAGE_REPO="${1:-wimotek/netplus}"
IMAGE_TAG="${2:-latest}"
PLATFORMS="${3:-linux/amd64,linux/arm64}"
NO_PUSH="${NO_PUSH:-false}"

if [ -z "${IMAGE_REPO}" ]; then
  echo "Usage: $0 [image-repo=wimotek/netplus] [tag=latest] [platforms=linux/amd64,linux/arm64]"
  echo "Example: $0 wimotek/netplus latest"
  echo "Example (GHCR): $0 ghcr.io/wimotek/netplus latest"
  echo "Local dry-run without push: NO_PUSH=true $0 wimotek/netplus local"
  exit 1
fi

echo "==> [1/4] Checking dependencies..."
if [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then
    npm ci --include=dev
  else
    npm install --include=dev
  fi
fi

echo "==> [2/4] Cleaning previous build output & compiling source..."
rm -rf dist dist-server
npm run build:all

test -f dist/index.html || { echo "ERROR: dist/index.html not generated"; exit 1; }
test -f dist-server/server.mjs || { echo "ERROR: dist-server/server.mjs not generated"; exit 1; }
echo "Compiled artifacts ready:"
ls -lh dist/index.html dist-server/server.mjs

echo "==> [3/4] Running production runtime smoke test..."
SMOKE_DATA_DIR="$(mktemp -d)"
SMOKE_LOG="$(mktemp)"
SMOKE_PORT="${SMOKE_PORT:-3099}"

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${SMOKE_DATA_DIR}" "${SMOKE_LOG}"
}
trap cleanup EXIT

NODE_ENV=production \
PORT="${SMOKE_PORT}" \
HTTPS_PORT=0 \
DATA_DIR="${SMOKE_DATA_DIR}" \
node dist-server/server.mjs > "${SMOKE_LOG}" 2>&1 &
SERVER_PID=$!

HEALTH_OK=false
for _ in $(seq 1 25); do
  if curl -fsS "http://127.0.0.1:${SMOKE_PORT}/api/health" | grep -q '"status":"ok"'; then
    HEALTH_OK=true
    break
  fi
  sleep 0.4
done

if [ "${HEALTH_OK}" != "true" ]; then
  echo "ERROR: Compiled server failed /api/health smoke check! Logs:"
  cat "${SMOKE_LOG}"
  exit 1
fi

curl -fsS "http://127.0.0.1:${SMOKE_PORT}/" | grep -qi "<!doctype html>" \
  || { echo "ERROR: Compiled frontend index.html failed to serve"; exit 1; }

kill "${SERVER_PID}" 2>/dev/null || true
wait "${SERVER_PID}" 2>/dev/null || true
unset SERVER_PID
echo "Smoke test passed (HTTP /api/health=200 & frontend HTML served)."

echo "==> [4/4] Building Docker image from pre-compiled artifacts (${IMAGE_REPO}:${IMAGE_TAG})..."
if [ "${NO_PUSH}" = "true" ]; then
  docker build -f Dockerfile.release -t "${IMAGE_REPO}:${IMAGE_TAG}" .
  echo "Local image built successfully (push skipped): ${IMAGE_REPO}:${IMAGE_TAG}"
else
  docker buildx build \
    -f Dockerfile.release \
    --platform "${PLATFORMS}" \
    --push \
    -t "${IMAGE_REPO}:${IMAGE_TAG}" \
    .
  echo "Multi-arch image pushed successfully: ${IMAGE_REPO}:${IMAGE_TAG} (${PLATFORMS})"
fi
