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

OUT_DIR="$ROOT/dist"
ZIP="$OUT_DIR/lizard-studio-$VERSION.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# --- whitelist: copy exactly what the extension loads --------------------------
mkdir -p "$STAGE/lizard-studio"
DEST="$STAGE/lizard-studio"

# Copy the manifest but strip the "key" field: the Chrome Web Store rejects it
# ("key field is not allowed in manifest"). The key stays in the repo manifest
# for local unpacked development; only the uploaded copy has it removed.
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  delete m.key;
  fs.writeFileSync(process.argv[2], JSON.stringify(m, null, 2) + "\n");
' "$MANIFEST" "$DEST/manifest.json"

# Icons referenced by the manifest.
mkdir -p "$DEST/icons"
cp icons/icon16.png icons/icon48.png icons/icon128.png "$DEST/icons/"

# All extension source EXCEPT:
#   - the native host (src/host ships via npm), and
#   - the disabled terminal view: xterm vendor JS/CSS + src/panel/terminal.js.
#     The panel.html never loads them, so ~290 KB of dead third-party code would
#     otherwise bloat the store zip and draw reviewer questions. The *fonts*
#     under src/terminal/vendor/fonts/ ARE used by panel.css, so keep those.
mkdir -p "$DEST/src"
( cd src && find . -type d -name host -prune -o \
    -type f \
    ! -path './terminal/vendor/xterm*' \
    ! -path './panel/terminal.js' \
    -print ) | while read -r f; do
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
