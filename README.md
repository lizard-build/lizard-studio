# Lizard Studio

**Claude Code in your browser's side panel — an AI coding agent that can see, measure, and fix the page you're building.**

Lizard Studio is a Chrome extension (Manifest V3) with two halves that feed each other:

- **A real Claude Code chat** in the side panel. Not a lookalike — it drives the actual `claude` CLI on your machine, with your account, your permissions, your working directory. And unlike the terminal, it's wired into the browser: Claude can read the DOM, take screenshots, watch the console and network, click and type into the live tab it's helping you fix.
- **A design-grade overlay toolkit** on the page itself: rulers, guides, grids, a mockup overlay, responsive preview, eyedropper, DevTools-style element inspection — and an annotator whose screenshots drop straight into the chat.

The loop this buys you: notice something off → measure it or circle it on the page → send it to Claude with the element and screenshot attached → Claude inspects the live tab, edits the code in your project folder, and you watch the page update. No copy-pasting selectors, no describing what you see — the agent is looking at the same page you are.

Everything runs locally: the extension talks to a tiny native host on your machine, which spawns `claude`. No accounts of ours, no telemetry, no middleman servers — the only network traffic is Claude itself.

## The chat — real Claude Code, browser-aware

- **Real sessions.** Each chat tab is its own `claude` process with its own folder, model, and permission mode. Sessions persist as normal Claude Code transcripts on disk — close the panel, reopen it, and the conversation replays; they even show up in `claude --resume` in your terminal.
- **It sees your browser.** Claude gets a set of `browser_*` tools over MCP: read the page (`dom`, accessibility `snapshot` with stable refs, `info`), observe it (`console`, `network`, `screenshot`, `eval`), and drive it (`click`, `type`, `fill`, `key`, `navigate`, tab management). Read-only tools are pre-approved; anything that acts on the page goes through permissions.
- **Claude Code's permission UX, faithfully.** When Claude wants to run something that isn't pre-approved, the panel shows the same ask dialog the CLI does — the tool and its exact input (command, diff, JS expression), then **Yes / Yes, don't ask again this session / No, and tell Claude what to do differently**. Keys `1–3`, arrows + Enter, Esc. Denials land as inline errors on the tool call they belong to. Permission modes (**Ask · Accept edits · Plan · Auto · Bypass**) cycle with Shift+Tab, like the CLI.
- **Point at things instead of describing them.** The Selector tool attaches any page element (tag, selector, computed styles, size) to your next message as a chip. The Annotate tool sends marked-up screenshots. You can attach the current tab's text, paste or drop images, and Claude quietly gets a list of your open tabs for context.
- **Rich transcript.** Streaming tokens, markdown, syntax-highlighted code, `Edit` diffs, collapsible tool cards with output, a live status pill (elapsed · tokens · thinking time), `/usage` rendered as a plan-usage card.
- **Quality of life.** Multi-tab chats + history of closed ones, native folder picker, git branch chip with one-click checkout, slash-command autocomplete, in-panel `/login` OAuth flow, model picker (Opus 4.8 · Sonnet 5 · Haiku 4.5 · Fable 5).
- **Lizard skill built in.** Every spawned session ships with the [lizard-build/skill](https://github.com/lizard-build/skill) bootstrap (auto-refreshed, injected via `--plugin-dir`), so "deploy this" works out of the box on Lizard.

## The on-page toolkit

| Group | Tool | What it does |
|-------|------|--------------|
| Inspect | **Selector** | DevTools-style hover inspection: box model bands with size labels, selector chip, computed-styles card — and one click attaches the element to the chat. |
| Inspect | **Annotate** | Draw on the page — freehand, line, arrow, rectangle, ellipse, text, four colors — then **Add to chat** snaps a clean screenshot with your annotations composited in. |
| Inspect | **Eyedropper** | A zoomed loupe over any pixel of the rendered page; click to copy the color (hex / RGB / HSL). Works on canvases, images, iframes — anything the tab renders. |
| Measure | **Rulers** | Px rulers along the top/left edges + live `x, y` cursor read-out. |
| Measure | **Distance (hold ⌥/Alt)** | Hover an element, hold **⌥/Alt**, hover another → the gaps between them. |
| Layout | **Guides** | Drag from the edges to place snap-to-element guides; Backspace or double-click removes one. |
| Layout | **Column grid** | Configurable 12/16-col grid (columns, gutter, max-width, margins, opacity). |
| Layout | **Responsive mode** | Re-renders the page in a device frame — presets, custom W/H, orientation, zoom — with real media queries responding. |

Tools toggle independently from a draggable, minimizable toolbar; several can run at once. Number keys `1–9` toggle tools in bar order; tools with settings open an inline panel on right-click. Tool state is per-page and ephemeral by design.

## Setup

### 1. The extension (developer mode)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder (`lizard-studio/`).
3. Pin the extension. Click its icon to toggle the toolbar; open the side panel for the chat. Assign a toolbar shortcut at `chrome://extensions/shortcuts` if you want one.

> Content scripts can't run on `chrome://` pages, the New Tab page, or the Chrome Web Store.

### 2. The Claude Code host (one-time)

The chat talks to the CLI through a tiny local native-messaging host (Node, zero dependencies). Install it once with npm — works on macOS, Linux and Windows:

```sh
npx @lizard-build/lizard-studio-host install
```

`npx … uninstall` removes it. Have the repo checked out? `bash src/host/install.sh` (macOS/Linux) or `node src/host/install.mjs install` (any OS) installs the local copy — handy while hacking on the host. The old `curl … | install.sh | bash` one-liner still works; it now just delegates to the npm installer.

It resolves your `node` and `claude` paths, copies the host to `~/.lizard-studio/host`, and registers the origin-locked `com.lizard.code` manifest (a file per browser on macOS/Linux, a `HKCU` registry key per browser on Windows). Reload the extension and the panel connects automatically. Requires the Claude Code CLI (`npm i -g @anthropic-ai/claude-code`).

> The host runs from `~/.lizard-studio/host`, **not** from the repo, on purpose: macOS TCC blocks browsers from launching native-messaging hosts under `~/Desktop`, `~/Documents`, or `~/Downloads` — they fail with a baffling *"Native host has exited"*. Re-run `install.sh` after `git pull` to refresh the copy. Logs: `~/.lizard-studio/host/host.log`.

> **No Gatekeeper pop-ups, by design.** Chrome carries macOS's `LSFileQuarantineEnabled` flag, and the OS propagates it down the whole process tree — so a `claude` spawned the naive way writes quarantined files, and the native modules it extracts at runtime trip a *"could not verify … is free of malware"* dialog on every session ([claude-code#14911](https://github.com/anthropics/claude-code/issues/14911)). The host sidesteps this by launching every `claude` through `launchd` (a tiny self-materialized shim + `launchctl submit`, stdio relayed over a localhost socket), which starts the process outside Chrome's quarantine context. If the launchd path fails, it silently falls back to a direct spawn — the chat always works.

## Architecture

- `src/core.js` — namespace, Shadow-DOM overlay (isolated SVG + UI layers), state, tool registry.
- `src/tools/*.js` — one file per tool; each registers `{ enable, disable, panel? }`.
- `src/toolbar.js` — the floating toolbar; `src/main.js` — state restore + toggle command.
- `src/background.js` — service worker: toolbar toggle, side-panel open/close, capture + chat relays.
- `src/panel/` — the side-panel app: `chat.js` (Claude Code client: streaming, tool cards, permission asks, browser-tool executor over `chrome.debugger`/CDP), `render.js` (XSS-safe markdown / highlighting / diffs), `panel.{html,js,css}`. A terminal view (`terminal.js` + vendored xterm) is kept in the codebase but currently disabled in the UI.
- `src/host/` — the native host: `claude-host.mjs` (spawns `claude` in stream-json mode via launchd to dodge Chrome's quarantine propagation — see the Gatekeeper note above — one process per chat tab; bridges permission control-requests and browser tool calls; replays transcripts; drives `/login`), `mcp-browser.mjs` (the MCP relay exposing `browser_*` tools), `spawn-shim.mjs` (generated at runtime by the host), `install.mjs` (cross-platform npm installer; `install.sh` is a thin wrapper over it).

No build step — plain JS loaded directly as content scripts and side-panel scripts.

> The login-shell environment-capture technique used by the host (to recover the full `PATH` when Chrome
> launches it with a minimal one) is adapted from [21st-dev/1Code](https://github.com/21st-dev/1Code) (Apache-2.0).

### Design

The toolbar, panels and overlays follow the **Lizard Brand Design System** (`lizard-client/DESIGN.md`): Geist, the `#070707 / #141414` surfaces, `#2E2E2E` borders, the `#E9EDF4 / #858B94 / #5F646D` text ramp. The accent (emerald `#10B981` by default) is user-configurable and flows through `--rk-accent*` custom properties, so tools re-theme live.

## Roadmap (not yet built)

Baseline grid, contrast checker (WCAG), font inspector, outline-all, palette extractor, smart guides, onion-skin diff.
