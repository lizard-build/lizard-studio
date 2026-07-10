#!/usr/bin/env bash
# Compatibility wrapper. The installer is now a cross-platform Node script
# (install.mjs) published to npm as @lizard-build/lizard-studio-host. This shim
# keeps the old commands working:
#
#   bash src/host/install.sh              # install (uses the local install.mjs)
#   bash src/host/install.sh --uninstall  # remove
#   curl -fsSL .../install.sh | bash      # install (falls back to npx)
#
# On Windows use the Node installer directly:
#
#   npx @lizard-build/lizard-studio-host install
#
# All the real work lives in install.mjs — see it for the full rationale.

set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' not found on PATH. Install Node 18+ and re-run." >&2
  echo "       (The host is a Node program; the CLI needs it too.)" >&2
  exit 1
fi

# Map the legacy flag to the subcommand the Node installer expects.
cmd="install"
if [[ "${1:-}" == "--uninstall" || "${1:-}" == "uninstall" ]]; then
  cmd="uninstall"
fi

# Prefer the install.mjs sitting next to this script (repo checkout) so local
# host changes are what gets installed; otherwise pull the published package.
HERE=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [[ -n "$HERE" && -f "$HERE/install.mjs" ]]; then
  exec node "$HERE/install.mjs" "$cmd"
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "error: 'npx' not found on PATH. Install Node 18+ (which bundles npx) and re-run." >&2
  exit 1
fi
exec npx --yes @lizard-build/lizard-studio-host@latest "$cmd"
