#!/usr/bin/env bash
# Package locally built artifacts into a Docker image and push to the registry.
# Assumes `npm run build` has already been run (server/dist/ and server/public/ exist).
#
# Usage:
#   ./docker/publish.sh                          # default registry: docker.io/sapux
#   REGISTRY=ghcr.io/myorg ./docker/publish.sh  # custom registry
#
# After pushing, update the running CF app without a full MTA redeploy:
#   cf push btp-admin --docker-image <SHA tag printed below>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

REGISTRY="${REGISTRY:-docker.io/sapux}"
IMAGE="${REGISTRY}/btp-admin"
SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
SHA_TAG="${IMAGE}:${SHA}"
LATEST_TAG="${IMAGE}:latest"

# Verify the build output exists before trying to package it
if [[ ! -d "${REPO_ROOT}/server/dist" || ! -d "${REPO_ROOT}/server/public" ]]; then
  echo "ERROR: server/dist or server/public not found — run 'npm run build' first." >&2
  exit 1
fi

echo "==> Building Docker image ${SHA_TAG}"
docker build -f "${SCRIPT_DIR}/Dockerfile" \
  -t "${SHA_TAG}" \
  -t "${LATEST_TAG}" \
  "${REPO_ROOT}"

echo "==> Pushing ${SHA_TAG}"
docker push "${SHA_TAG}"
echo "==> Pushing ${LATEST_TAG}"
docker push "${LATEST_TAG}"

echo ""
echo "Images pushed:"
echo "  ${SHA_TAG}"
echo "  ${LATEST_TAG}"
echo ""
echo "To update the running CF app (no MTA rebuild needed):"
echo "  cf push btp-admin --docker-image ${SHA_TAG}"
