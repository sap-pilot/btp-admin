#!/usr/bin/env bash
# Build the app locally, package it into a Docker image, and push to the registry.
# Tags the image with the current git commit SHA (immutable, one tag per commit)
# and also as :latest.
#
# Using a SHA tag guarantees Cloud Foundry pulls a fresh image on every deploy
# instead of reusing a cached :latest layer from a previous cf restage.
#
# Usage:
#   ./docker/build.sh                          # default registry: docker.io/sapux
#   REGISTRY=ghcr.io/myorg ./docker/build.sh  # custom registry
#   SKIP_BUILD=1 ./docker/build.sh            # skip npm run build (use existing dist/)
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

# Build the app locally so the Docker image copies pre-built artifacts
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "==> Building application (npm run build)"
  npm --prefix "${REPO_ROOT}" run build
else
  echo "==> Skipping local build (SKIP_BUILD=1)"
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
