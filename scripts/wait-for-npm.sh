#!/usr/bin/env bash
# Wait until a published npm package version is available on the registry.
# Usage: ./scripts/wait-for-npm.sh [version]
# If version is omitted, reads from package.json in the current directory.
set -euo pipefail

PACKAGE="@kody-ade/kody-engine-lite"
VERSION="${1:-$(node -p "require('./package.json').version")}"
REGISTRY="https://registry.npmjs.org"
MAX_ATTEMPTS=30
SLEEP_SECONDS=10

echo "Waiting for ${PACKAGE}@${VERSION} on ${REGISTRY}..."

for i in $(seq 1 $MAX_ATTEMPTS); do
  FOUND=$(npm view "${PACKAGE}@${VERSION}" version --registry "${REGISTRY}" 2>/dev/null || true)
  if [ "$FOUND" = "$VERSION" ]; then
    echo "✓ ${PACKAGE}@${VERSION} is available (attempt ${i}/${MAX_ATTEMPTS})"
    exit 0
  fi
  echo "  Attempt ${i}/${MAX_ATTEMPTS} — not yet propagated, retrying in ${SLEEP_SECONDS}s..."
  sleep "$SLEEP_SECONDS"
done

echo "✗ Timed out after $((MAX_ATTEMPTS * SLEEP_SECONDS))s waiting for ${PACKAGE}@${VERSION}"
exit 1
