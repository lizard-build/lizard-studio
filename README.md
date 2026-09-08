# Lizard Studio

**[Install from the Chrome Web Store →](https://chromewebstore.google.com/detail/kgbaeoalmkabpoglpjcdmppdmcipfdeh)**

**Claude Code and ChatGPT in your browser's side panel — inspect, measure, and fix the page you're building.**

A Chrome extension (Manifest V3) with two halves that feed each other:

- **Claude Code and ChatGPT chats** in the side panel — each uses its local CLI on your machine (your account, your folder, your permissions), wired into the browser so your agent can read the DOM, take screenshots, watch the console/network, and click and type into the live tab.
- **A design overlay toolkit** on the page: rulers, guides, grids, responsive preview, eyedropper, DevTools-style inspection, and an annotator whose screenshots drop straight into the chat.

The loop: notice something off → measure or circle it on the page → send it to your agent with the element and screenshot attached → the agent inspects the live tab, edits the code in your project folder, and you watch the page update.

The extension and its host run locally. Chats connect through your chosen agent and account. You can also add your own model endpoint. Dragon Labs LLC runs no chat server and collects no telemetry.

## Setup

### 1. The extension

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/kgbaeoalmkabpoglpjcdmppdmcipfdeh), or load this folder yourself:

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Pin it. Click the icon to toggle the toolbar; open the side panel for the chat. Set a toolbar shortcut at `chrome://extensions/shortcuts` if you want one.

> Content scripts can't run on `chrome://` pages, the New Tab page, or the Chrome Web Store.

### 2. The local host (one-time)

The chat talks to the CLI through a small local native-messaging host (Node, zero deps). Install once — macOS, Linux, Windows:

```sh
npx @lizard-build/lizard-studio-host install
```

(`npx … uninstall` removes it. Hacking on the host? `bash src/host/install.sh` installs the local copy.)

It resolves your Node.js and agent paths, copies the host to `~/.lizard-studio/host`, and registers the origin-locked `com.lizard.code` manifest. Reload the extension and the panel connects. Install the CLI for the agent you want to use: `npm i -g @anthropic-ai/claude-code` for Claude Code, or `npm i -g @openai/codex` for ChatGPT. The package and command names are the names required by the underlying CLI; the agent appears as **ChatGPT** in Lizard Studio.

> The host runs from `~/.lizard-studio/host`, **not** the repo, on purpose: macOS TCC blocks browsers from launching hosts under `~/Desktop`/`~/Documents`/`~/Downloads`. Re-run the installer after `git pull`. Logs: `~/.lizard-studio/host/host.log`.
>
> On macOS it launches each `claude` via `launchd` to dodge Chrome's quarantine propagation (which otherwise trips a "could not verify … is free of malware" dialog every session — [claude-code#14911](https://github.com/anthropics/claude-code/issues/14911)); it silently falls back to a direct spawn if that path fails.

## The chat

Choose **Claude Code** or **ChatGPT** when you start a chat. Each chat keeps its own folder, model, permissions, history, and text draft. The agent can inspect and act on the page with browser tools. Use Selector to attach an element, or Annotate to attach a marked screenshot. Attachments stay in the browser window where you added them.

Both agents support streaming replies, file links, tool cards, model and reasoning controls, usage details, and in-panel `/login`. The `/` menu lists the commands and skills available to the selected agent. A skill's package name can contain `claude` even when ChatGPT provides it; that name does not change which agent runs the chat.

Claude Code supports editing past messages and `/remote-control` for continuing a session in the Claude app. ChatGPT offers its own sign-in flow and permission modes; Remote Control and editing past messages are unavailable there. Settings provide separate files and skills for each agent. Real CLI paths, such as `~/.codex/config.toml`, retain their required names.

Every session includes the [Lizard Skill](https://github.com/lizard-build/skill) bootstrap for deployment tasks.

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

No build step — plain JS. `src/core.js` (Shadow-DOM overlay, state, tool registry) + `src/tools/*.js` + `src/toolbar.js` are the content scripts; `src/background.js` is the service worker; `src/panel/` is the side-panel app (`chat.js` is the chat client, `render.js` is XSS-safe markdown). A disabled terminal view (`terminal.js` + vendored xterm) lives in the tree but is excluded from the store build.

`src/host/` contains the local hosts — `router.mjs` routes each chat to its agent, `codex-host.mjs` connects ChatGPT through its CLI, `claude-host.mjs` (spawns `claude` in stream-json mode, one process per tab; bridges permissions + browser tools; replays transcripts; drives `/login` and `/remote-control`), `mcp-browser.mjs` (the `browser_*` MCP relay), `install.mjs` (cross-platform installer). It ships separately on npm as `@lizard-build/lizard-studio-host`. The host's login-shell env-capture is adapted from [21st-dev/1Code](https://github.com/21st-dev/1Code) (Apache-2.0).

The UI follows the Lizard Brand Design System; the accent (emerald by default) is user-configurable via `--rk-accent*`. Roadmap, not yet built: baseline grid, WCAG contrast checker, font inspector, outline-all, palette extractor, smart guides, onion-skin diff.

## License

MIT © Dragon Labs LLC. See [LICENSE](LICENSE) and [PRIVACY.md](PRIVACY.md).
