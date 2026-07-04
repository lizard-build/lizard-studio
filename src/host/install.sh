#!/usr/bin/env bash
# Installs the native-messaging host that lets the Lizard Studio side panel
# drive the real `claude` CLI. Run once:
#
#   bash src/host/install.sh
#
# It resolves your node + claude binaries, copies the host into a stable runtime
# directory, writes a launcher and a host config there, and registers an
# origin-locked native-messaging manifest in every Chrome-family browser found on
# this machine. Re-run it any time those paths change (it re-copies the host too).
#
# Why a separate runtime dir: macOS TCC protects ~/Desktop, ~/Documents and
# ~/Downloads. A browser is a GUI app and cannot launch a native-messaging host
# living under those folders without an explicit per-folder grant — the host just
# fails to start and the panel shows "Native host has exited", with nothing in the
# log (the process never runs). Running it from Terminal works, which makes this
# baffling. We sidestep it entirely by running the host from ~/.lizard-studio, which
# no browser is ever blocked from. (Bonus: the repo can move freely afterwards.)
#
# Uninstall:  bash src/host/install.sh --uninstall

set -euo pipefail

HOST_NAME="com.lizard.code"
# Fixed by the extension's manifest "key" — do not change unless the key changes.
DEFAULT_EXT_ID="nhcgkijjijdinhldjohkmbbgjokobecd"
EXT_ID="${RK_EXT_ID:-$DEFAULT_EXT_ID}"
RAW_BASE="https://raw.githubusercontent.com/lizard-build/lizard-studio/main/src/host"

# The directory this script lives in — empty when there isn't one, e.g. run via
# `curl … | bash` (no real BASH_SOURCE). Sibling host files are fetched from
# GitHub in that case instead of copied off disk; see fetch_host_file below.
HERE=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# Stable, non-TCC-protected home for the running host. Never put this under
# Desktop/Documents/Downloads — that's the whole bug this avoids.
RUNTIME_DIR="$HOME/.lizard-studio/host"

# macOS + Linux native-messaging host directories, per browser.
host_dirs() {
  case "$(uname -s)" in
    Darwin)
      local base="$HOME/Library/Application Support"
      printf '%s\n' \
        "$base/Google/Chrome/NativeMessagingHosts" \
        "$base/Google/Chrome Beta/NativeMessagingHosts" \
        "$base/Google/Chrome Canary/NativeMessagingHosts" \
        "$base/Chromium/NativeMessagingHosts" \
        "$base/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
        "$base/Microsoft Edge/NativeMessagingHosts" \
        "$base/Arc/User Data/NativeMessagingHosts" \
        "$base/DiaBrowser/NativeMessagingHosts" \
        "$base/Vivaldi/NativeMessagingHosts" \
        "$base/com.operasoftware.Opera/NativeMessagingHosts"
      ;;
    *)
      printf '%s\n' \
        "$HOME/.config/google-chrome/NativeMessagingHosts" \
        "$HOME/.config/chromium/NativeMessagingHosts" \
        "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
        "$HOME/.config/microsoft-edge/NativeMessagingHosts" \
        "$HOME/.config/vivaldi/NativeMessagingHosts" \
        "$HOME/.config/opera/NativeMessagingHosts"
      ;;
  esac
}

uninstall() {
  while IFS= read -r dir; do
    rm -f "$dir/$HOST_NAME.json" 2>/dev/null || true
  done < <(host_dirs)
  # Old in-repo artifacts (pre-relocation) and the runtime dir.
  if [[ -n "$HERE" ]]; then
    rm -f "$HERE/host-config.json" "$HERE/launch.sh" "$HERE/host.log" 2>/dev/null || true
  fi
  rm -rf "$RUNTIME_DIR" 2>/dev/null || true
  echo "Removed $HOST_NAME from all Chrome-family browsers."
}

if [[ "${1:-}" == "--uninstall" ]]; then
  uninstall
  exit 0
fi

NODE_BIN="$(command -v node || true)"
CLAUDE_BIN="$(command -v claude || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "error: 'node' not found on PATH. Install Node 18+ and re-run." >&2
  exit 1
fi
# The host is ESM and relies on Node 18+ behavior — an ancient system node
# would install "successfully" and then die at launch with nothing but
# "Native host has exited" to go on. Fail here with an actionable message.
if ! "$NODE_BIN" -e 'process.exit(parseInt(process.versions.node, 10) >= 18 ? 0 : 1)'; then
  echo "error: Node 18+ required (found $("$NODE_BIN" -v)). Upgrade node and re-run." >&2
  exit 1
fi
# The launcher heredoc double-quotes these paths, which covers spaces — but
# not quotes/backslashes. Refuse those outright rather than writing a broken
# launcher that fails opaquely at browser launch.
case "$NODE_BIN$RUNTIME_DIR" in
  *\"* | *\\*)
    echo "error: node or runtime path contains a quote/backslash — unsupported." >&2
    exit 1
    ;;
esac
if [[ -z "$CLAUDE_BIN" ]]; then
  echo "warning: 'claude' not found on PATH. Install it with:  npm i -g @anthropic-ai/claude-code" >&2
  echo "         The host will still install and look in common locations at runtime." >&2
fi

# Stages a host file into the runtime dir as "<name>.tmp" — copied from the
# local checkout when we have one, otherwise fetched from GitHub (with retries)
# so `curl … | bash` works without a git clone.
stage_host_file() {
  mkdir -p "$(dirname "$RUNTIME_DIR/$1")"
  if [[ -n "$HERE" && -f "$HERE/$1" ]]; then
    cp "$HERE/$1" "$RUNTIME_DIR/$1.tmp"
  else
    curl -fsSL --retry 3 "$RAW_BASE/$1" -o "$RUNTIME_DIR/$1.tmp"
  fi
}

# 0) copy the (self-contained, dependency-free) host into the runtime dir so the
#    manifest can point outside any TCC-protected folder. Re-copied every run so
#    `git pull` (or re-running the curl one-liner) picks up host changes.
#    Everything is staged first and only swapped into place once ALL files are
#    in hand — an install interrupted mid-download (set -e aborts on a failed
#    curl) must not leave a mismatched claude-host/mcp-browser pair behind.
#    Files: the host, the browser MCP relay it hands to claude, and a bundled
#    fallback copy of the lizard-build/skill bootstrap skill (the host refreshes
#    the skill from upstream itself afterwards — see claude-host.mjs).
HOST_FILES=(
  claude-host.mjs
  mcp-browser.mjs
  skills/lizard/SKILL.md
  skills/lizard/README.md
  skills/lizard/skills.sh.json
)
mkdir -p "$RUNTIME_DIR"
for f in "${HOST_FILES[@]}"; do stage_host_file "$f"; done
for f in "${HOST_FILES[@]}"; do mv "$RUNTIME_DIR/$f.tmp" "$RUNTIME_DIR/$f"; done

# 1) host config the runtime reads (Chrome launches us with a minimal PATH).
#    Written via JSON.stringify so a path containing quotes/backslashes can't
#    produce invalid JSON (which would silently degrade the host to discovery).
"$NODE_BIN" -e '
  const [node, claude, home, out] = process.argv.slice(1);
  require("fs").writeFileSync(out, JSON.stringify({ nodePath: node, claudePath: claude, home }, null, 2) + "\n");
' "$NODE_BIN" "${CLAUDE_BIN:-claude}" "$HOME" "$RUNTIME_DIR/host-config.json"

# 2) launcher: a tiny wrapper so the manifest points at a stable executable that
#    runs our .mjs with the resolved node, regardless of Chrome's PATH.
cat > "$RUNTIME_DIR/launch.sh" <<SH
#!/bin/sh
exec "$NODE_BIN" "$RUNTIME_DIR/claude-host.mjs" "\$@"
SH
chmod +x "$RUNTIME_DIR/launch.sh"

# 3) native-messaging manifest, origin-locked to our extension. One master copy
#    (JSON.stringify — same quoting rationale as the config) is copied into
#    every browser's host dir.
MANIFEST_MASTER="$RUNTIME_DIR/$HOST_NAME.json"
"$NODE_BIN" -e '
  const [name, path, origin, out] = process.argv.slice(1);
  require("fs").writeFileSync(out, JSON.stringify({
    name,
    description: "Lizard Claude Code chat host",
    path,
    type: "stdio",
    allowed_origins: [origin],
  }, null, 2) + "\n");
' "$HOST_NAME" "$RUNTIME_DIR/launch.sh" "chrome-extension://$EXT_ID/" "$MANIFEST_MASTER"

count=0
while IFS= read -r dir; do
  parent="$(dirname "$dir")"
  # Only install where the browser itself is present (its profile dir exists) —
  # no more force-creating Chrome's dir on machines that don't have Chrome.
  if [[ -d "$parent" ]]; then
    mkdir -p "$dir"
    cp "$MANIFEST_MASTER" "$dir/$HOST_NAME.json"
    echo "  installed -> $dir/$HOST_NAME.json"
    count=$((count + 1))
  fi
done < <(host_dirs)

echo
echo "Done. Registered '$HOST_NAME' in $count location(s)."
echo "  node    : $NODE_BIN"
echo "  claude  : ${CLAUDE_BIN:-(not found — install @anthropic-ai/claude-code)}"
echo "  ext id  : $EXT_ID"
echo "  runtime : $RUNTIME_DIR  (log: $RUNTIME_DIR/host.log)"
case "$HERE" in
  "$HOME/Desktop/"* | "$HOME/Documents/"* | "$HOME/Downloads/"*)
    echo
    echo "  note: this repo lives in a macOS TCC-protected folder, but the host now"
    echo "        runs from $RUNTIME_DIR, so the browser can launch it fine."
    ;;
esac
echo
echo "Reload the extension (chrome://extensions) and open the side panel."
