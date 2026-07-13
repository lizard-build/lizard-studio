#!/usr/bin/env bash
#
# Build the Chrome Web Store upload package for Lizard Studio.
#
# Produces dist/lizard-studio-<version>.zip containing ONLY the files the
# extension needs at runtime (manifest, icons, and src/ without the native
# host, which ships separately on npm). Docs, .git, build artifacts, and the
# host installer are excluded.
#
# Usage: ./scripts/build-zip.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MANIFEST="manifest.json"
[ -f "$MANIFEST" ] || { echo "error: $MANIFEST not found (run from repo root)"; exit 1; }

# Version from manifest.
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
[ -n "$VERSION" ] || { echo "error: could not read version from $MANIFEST"; exit 1; }

# The "key" field pins the published extension ID to the one the native host
# trusts (allowed_origins). Refuse to build without it — dropping it would give
# the store a different ID and break native messaging.
if ! grep -q '"key"' "$MANIFEST"; then
  echo "error: manifest.json has no \"key\" field."
  echo "       Publishing without it changes the extension ID and breaks the"
  echo "       native host's allowed_origins. Restore the key before building."
  exit 1
fi

OUT_DIR="$ROOT/dist"
ZIP="$OUT_DIR/lizard-studio-$VERSION.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# --- whitelist: copy exactly what the extension loads --------------------------
mkdir -p "$STAGE/lizard-studio"
DEST="$STAGE/lizard-studio"

cp "$MANIFEST" "$DEST/"

# Icons referenced by the manifest.
mkdir -p "$DEST/icons"
cp icons/icon16.png icons/icon48.png icons/icon128.png "$DEST/icons/"

# All extension source EXCEPT the native host (src/host ships via npm).
mkdir -p "$DEST/src"
( cd src && find . -type d -name host -prune -o -type f -print ) | while read -r f; do
  mkdir -p "$DEST/src/$(dirname "$f")"
  cp "src/$f" "$DEST/src/$f"
done

# Strip any stray macOS metadata.
find "$DEST" -name '.DS_Store' -delete

# --- zip ----------------------------------------------------------------------
mkdir -p "$OUT_DIR"
rm -f "$ZIP"
( cd "$DEST" && zip -qr -X "$ZIP" . )

echo "built: ${ZIP#$ROOT/}"
echo "version: $VERSION"
echo "contents:"
( cd "$DEST" && find . -type f | sort | sed 's/^/  /' )
