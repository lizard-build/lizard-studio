#!/bin/sh
# Build "Lizard Studio.app" into macos/dist.
set -eu
cd "$(dirname "$0")/.."
cargo build --release
app="dist/Lizard Studio.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp target/release/lizard-studio "$app/Contents/MacOS/"
cp bundle/Info.plist "$app/Contents/"
if [ -f bundle/AppIcon.icns ]; then cp bundle/AppIcon.icns "$app/Contents/Resources/"; fi
codesign --force --sign - "$app" >/dev/null 2>&1 || true
echo "built $app"
