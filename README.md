# Lizard Studio

**Claude Code in your browser's side panel — an AI coding agent that can see, measure, and fix the page you're building.**

A Chrome extension (Manifest V3) with two halves that feed each other:

- **A real Claude Code chat** in the side panel — it drives the actual `claude` CLI on your machine (your account, your folder, your permissions), wired into the browser so Claude can read the DOM, take screenshots, watch the console/network, and click and type into the live tab.
- **A design overlay toolkit** on the page: rulers, guides, grids, responsive preview, eyedropper, DevTools-style inspection, and an annotator whose screenshots drop straight into the chat.

The loop: notice something off → measure or circle it on the page → send it to Claude with the element and screenshot attached → Claude inspects the live tab, edits the code in your project folder, and you watch the page update.

Everything runs locally. The extension talks to a tiny native host that spawns `claude`. No servers of ours, no telemetry — the only network traffic is Claude itself.

## Setup

### 1. The extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Pin it. Click the icon to toggle the toolbar; open the side panel for the chat. Set a toolbar shortcut at `chrome://extensions/shortcuts` if you want one.

> Content scripts can't run on `chrome://` pages, the New Tab page, or the Chrome Web Store.

### 2. The Claude Code host (one-time)

The chat talks to the CLI through a small local native-messaging host (Node, zero deps). Install once — macOS, Linux, Windows:

```sh
npx @lizard-build/lizard-studio-host install
```

(`npx … uninstall` removes it. Hacking on the host? `bash src/host/install.sh` installs the local copy.)

It resolves your `node`/`claude` paths, copies the host to `~/.lizard-studio/host`, and registers the origin-locked `com.lizard.code` manifest. Reload the extension and the panel connects. Requires the Claude Code CLI (`npm i -g @anthropic-ai/claude-code`).

> The host runs from `~/.lizard-studio/host`, **not** the repo, on purpose: macOS TCC blocks browsers from launching hosts under `~/Desktop`/`~/Documents`/`~/Downloads`. Re-run the installer after `git pull`. Logs: `~/.lizard-studio/host/host.log`.
>
> On macOS it launches each `claude` via `launchd` to dodge Chrome's quarantine propagation (which otherwise trips a "could not verify … is free of malware" dialog every session — [claude-code#14911](https://github.com/anthropics/claude-code/issues/14911)); it silently falls back to a direct spawn if that path fails.

## The chat

Each tab is its own `claude` process with its own folder, model, and permission mode; sessions persist as normal Claude Code transcripts (they show up in `claude --resume`). Claude gets `browser_*` tools over MCP — read (`dom`, `snapshot`, `info`), observe (`console`, `network`, `screenshot`, `eval`), and drive (`click`, `type`, `fill`, `key`, `navigate`, tabs); read-only tools are pre-approved, anything that acts on the page goes through Claude Code's permission dialog (**Ask · Accept edits · Plan · Auto · Bypass**, Shift+Tab to cycle). Point at elements with the Selector tool, send marked-up screenshots with Annotate. Streaming markdown, syntax highlighting, `Edit` diffs, collapsible tool cards, a live status pill, `/usage` plan card, multi-tab chats + history, folder picker, git branch chip, slash-command autocomplete, in-panel `/login`, model picker. Every session ships the [lizard-build/skill](https://github.com/lizard-build/skill) bootstrap, so "deploy this" works out of the box.

## The on-page toolkit

| Tool | What it does |
|------|------|
| **Selector** | DevTools-style hover inspection; one click attaches the element to the chat. |
| **Annotate** | Draw on the page, then **Add to chat** snaps a composited screenshot. |
| **Eyedropper** | Zoomed loupe over any pixel; click to copy the color (hex/RGB/HSL). |
| **Rulers** | Px rulers along the edges + live cursor read-out. |
| **Distance** | Hover an element, hold **⌥/Alt**, hover another → the gaps between them. |
| **Guides** | Drag from the edges to place snap-to-element guides. |
| **Column grid** | Configurable 12/16-col grid (columns, gutter, max-width, margins, opacity). |
| **Responsive** | Re-renders the page in a device frame — presets, custom W/H, orientation, zoom. |

Tools toggle independently from a draggable toolbar; several run at once. Number keys `1–9` toggle in bar order; right-click a tool for its settings. State is per-page and ephemeral.

## Architecture

No build step — plain JS. `src/core.js` (Shadow-DOM overlay, state, tool registry) + `src/tools/*.js` + `src/toolbar.js` are the content scripts; `src/background.js` is the service worker; `src/panel/` is the side-panel app (`chat.js` is the Claude Code client, `render.js` is XSS-safe markdown). A disabled terminal view (`terminal.js` + vendored xterm) lives in the tree but is excluded from the store build.

`src/host/` is the native host — `claude-host.mjs` (spawns `claude` in stream-json mode, one process per tab; bridges permissions + browser tools; replays transcripts; drives `/login`), `mcp-browser.mjs` (the `browser_*` MCP relay), `install.mjs` (cross-platform installer). It ships separately on npm as `@lizard-build/lizard-studio-host`. The host's login-shell env-capture is adapted from [21st-dev/1Code](https://github.com/21st-dev/1Code) (Apache-2.0).

The UI follows the Lizard Brand Design System; the accent (emerald by default) is user-configurable via `--rk-accent*`. Roadmap, not yet built: baseline grid, WCAG contrast checker, font inspector, outline-all, palette extractor, smart guides, onion-skin diff.

## License

MIT © Dragon Labs LLC. See [LICENSE](LICENSE) and [PRIVACY.md](PRIVACY.md).
