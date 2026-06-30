# Lizard Studio — UI Polish Tools

A Chrome extension (Manifest V3) that overlays rulers, measurements, guides, grids
and a design-comparison image overlay onto any web page — so you can polish UI
without leaving the browser. **100% local: no network, no accounts.**

## Tools

| Group | Tool | What it does |
|-------|------|--------------|
| Measure | **Rulers** | Px rulers on the top/left edges + live `x, y` cursor read-out. |
| Measure | **Measure (drag)** | Drag to draw a measurement — distance, Δx, Δy. Shift = straight axis, Esc clears. |
| Measure | **Distance (hold ⌥/Alt)** | Hover an element, hold **⌥ Option** (macOS) / **Alt**, hover another → gaps between them. |
| Layout | **Guides** | Drag from the top/left strips to create guides. They **snap** to element edges. Hover a guide and press **Backspace/Delete** (or double-click) to remove it. |
| Layout | **Column grid** | Configurable 12/16-col grid (columns, gutter, max-width, margin, opacity). |
| Layout | **Image overlay** | Drop a mockup over the page; adjust opacity & scale, drag to position, lock to click through. |
| Inspect | **Eyedropper** | Pick any pixel on screen and copy its color to the clipboard. Choose the format (hex / RGB / HSL) in the right-click panel — hex by default. |

## Side panel — Claude Code chat + Terminal

The extension's side panel is a two-tab surface:

- **Chat** (default) — a Claude Code chat interface that drives the **real `claude` CLI** locally
  in stream-json mode. It renders the streamed conversation as a rich chat: markdown, syntax-highlighted
  code, `Edit` diffs, and `Bash`/`Read`/`Write`/… tool cards with collapsible output. You get real folder
  selection (working directory), real command execution, and real edits — because it *is* Claude Code.
  - **Folder** pill (top-left) opens a native folder chooser; double-click to type a path.
  - **Model** selector and a **permission-mode** button that cycles `Ask → Auto-edit → Plan → Bypass`
    (also via **Shift+Tab**, like the CLI).
  - **Enter** sends · **Shift+Enter** newline · **■** interrupts the current turn.
- **Terminal** — the original xterm.js terminal, kept as a secondary tab.

### One-time setup (Claude Code host)

The chat talks to the CLI through a tiny local native-messaging host (Node, no dependencies — it spawns
`claude` as a child process). Install it once from the extension folder:

```sh
bash src/host/install.sh        # registers com.lizard.code for Chrome-family browsers
bash src/host/install.sh --uninstall
```

It resolves your `node` and `claude` paths, copies the host into `~/.lizard-code/host`, and writes a launcher
+ the origin-locked native-messaging manifest pointing there. Then you reload the extension and open the side
panel. Requires the Claude Code CLI (`npm i -g @anthropic-ai/claude-code`). The terminal tab uses a separate
`com.lizard.term` helper.

> The host runs from `~/.lizard-code/host`, **not** from the repo, on purpose: macOS TCC blocks browsers from
> launching native-messaging hosts that live under `~/Desktop`, `~/Documents`, or `~/Downloads`. A host placed
> there just fails with *"Native host has exited"* (it works from a terminal, which makes it baffling). Running
> from `~/.lizard-code` sidesteps that and lets the repo live anywhere. Re-run `install.sh` after `git pull` to
> refresh the copied host. Logs: `~/.lizard-code/host/host.log`.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (`ruler/`).
4. Pin the extension. Click its icon — or press the toggle shortcut — to show/hide the toolbar:
   - **macOS:** `⌃ Control + ⇧ Shift + R`
   - **Windows / Linux:** `Alt + Shift + R`

> Content scripts can't run on `chrome://` pages, the New Tab page, or the Chrome Web Store.
>
> To rebind the shortcut, open `chrome://extensions/shortcuts`.

## Usage notes

- Each tool toggles independently from the toolbar; several can run at once.
- Hover any toolbar button for an instant tooltip. Tool buttons show their **number hotkey** — press **1–9** (in the order they sit on the bar) to toggle a tool without reaching for the mouse. Keys are ignored while you're typing in a field or settings panel.
- Tools with settings (Column grid, Image overlay, Eyedropper) expand an inline panel on **right-click**.
- The **Eyedropper** opens the browser's native screen color picker the moment you activate it; click any pixel and the color lands on your clipboard. Re-open it from its right-click panel's **Pick color** button, switch format, or **Copy** the last-picked value again. (Needs Chrome/Edge 95+ for the EyeDropper API.)
- The toolbar is draggable, and can be **minimized** to a small handle docked at the bottom via the caret-down button — tools keep running; click the handle to bring it back. The **✕** button hides the toolbar entirely and turns every tool off.
- **Tool state is per-page and ephemeral** — which tools are active and their settings live only in memory for the current page and reset on reload. The only remembered preference is the accent color.
- While **Measure** is active, a transparent capture layer sits over the page (so you can't scroll/click the page until you disable it).

## Architecture

- `src/core.js` — namespace, Shadow DOM overlay (isolated SVG + HTML + UI layers), in-memory state, tool registry.
- `src/tools/*.js` — one file per tool; each registers `{ enable, disable, panel? }`.
- `src/toolbar.js` — floating toolbar rendered in the overlay UI layer.
- `src/main.js` — restores state, handles the toggle command.
- `src/background.js` — service worker; relays the toolbar toggle (action click / keyboard command) and side-panel open/close.
- `src/panel/` — the side-panel app: `panel.{html,js,css}` shell + tab switching, `chat.js` (Claude Code chat client), `terminal.js` (xterm terminal view), `render.js` (XSS-safe markdown / code highlighting / diff renderer).
- `src/host/` — the native-messaging host: `claude-host.mjs` (drives the `claude` CLI), `install.sh` (registers it).
- `src/terminal/vendor/` — vendored xterm.js + Geist font, shared by the terminal view.

No build step — plain JS loaded directly as content scripts and side-panel scripts.

> The login-shell environment-capture technique used by the host (to recover the full `PATH` when Chrome
> launches it with a minimal one) is adapted from [21st-dev/1Code](https://github.com/21st-dev/1Code) (Apache-2.0).

### Design

The toolbar, panels and on-page overlays follow the **Lizard Brand Design System**
(`lizard-client/DESIGN.md`): Geist font, the `#070707 / #141414` surfaces, `#2E2E2E`
borders, and the `#E9EDF4 / #858B94 / #5F646D` text ramp. The accent (emerald `#10B981`
by default) is user-configurable via the header swatch and flows through `--rk-accent*`
CSS custom properties on the shadow `:host`, so tools and UI re-theme live.

## Roadmap (not yet built)

Baseline grid, contrast checker (WCAG), font inspector, outline-all, breakpoint ruler, palette extractor, smart guides, onion-skin diff, region screenshot.
