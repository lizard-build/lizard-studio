# Lizard Studio for macOS

A native window for the Lizard Studio chat, built with [GPUI](https://gpui.rs) through [GPUI Kit](https://gpui-kit.com). It copies the side panel's window mode: chats on the left, the open chat on the right, the same composer, tool groups, permission cards and running indicator.

The app has no agent code of its own. It starts the same local host as the Chrome extension (`~/.lizard-studio/host/router.mjs`), speaks the same native-messaging frames, and attaches to its own session daemon (`router-4242424242.sock`), so its chats never mix with a browser window's.

## What works

- Claude Code and ChatGPT chats: streaming replies, markdown, tool groups ("Ran 3 commands, read a file"), expandable tool cards with diffs and output.
- Permission cards and AskUserQuestion, with the panel's keys (1-9, ↑↓, enter, esc).
- The panel's pickers: models with their descriptions (ChatGPT's grouped by family, Refresh asks the agent again), the effort slider with Ultracode's green field, permission modes, shift+tab to cycle modes, the context ring.
- Settings, as the panel's modal: General (completion sound, host status, links), Claude and ChatGPT (CLAUDE.md or AGENTS.md, hooks, MCP, config.toml, plugin switches, skills) read and written through the host, and Models for your own OpenAI-compatible endpoints, which then show up in the ChatGPT picker. The host only edits a project's files for a folder a session has opened, so opening one starts the chat's agent, as the panel does when it shows a chat.
- Chat list with Active and History, search, rename, bookmarks, status dots.
- History from the agent's own transcript, paged in as you scroll up.
- Attachments from the + button, a paste (an image, or files copied in Finder) or a drop on the composer: images as thumbnails scaled to 1568px and sent inline, other files as chips the agent reads by path. In a cloud chat every attachment is put in the sandbox under `/workspace/attachments` (`lizard sandbox files put`) and named in the message.
- The context ring opens the usage popover: the chat's context window, then the plan's limits. Claude's come from the `rate_limit_event` each turn streams (five-hour and weekly windows), ChatGPT's from the host's `planUsage`. A cloud chat shows the context window only.

There is no browser here, so the `browser_*` tools answer "No browser is attached". Use the extension for page work.

**Local or Cloud.** The first chip of a new chat picks where it runs. Local is this Mac, in a folder you choose, through the host. Cloud runs the chat's agent in a new Lizard sandbox from its template (`claude` or `codex`) through your `lizard` CLI: `sandbox create`, then `sandbox prompt --json` for each message (the conversation continues with `-c`), `sandbox interrupt` for Stop. The sandbox lives an hour after the last message and is replaced if it has stopped. The agent uses the credentials connected to your Lizard account (`lizard agents`). The CLI can't read a finished conversation back, so the app keeps what a cloud chat showed in `~/Library/Application Support/Lizard Studio/cloud/`.

**Connecting an agent.** A cloud chat runs on a credential connected to your Lizard account. If the agent has none, the app checks before it starts a sandbox, and the chat shows a card instead of an error: Sign in with Claude runs the real `claude setup-token` on this Mac (in a pseudo-terminal, with an empty HOME, so your own Claude Code login is untouched), opens the browser, catches the one-year token on its localhost callback and stores it with `lizard agents add claude`; Sign in with ChatGPT shows the device code from `lizard agents login chatgpt`; or paste a key (Claude token, Anthropic, OpenRouter or OpenAI), which goes to `lizard agents add` on stdin. Once connected, the refused message is sent again.

**Run in a sandbox** (sidebar foot, above Settings) starts Lizard Studio in a new Lizard desktop sandbox through your `lizard` CLI and opens its stream in the browser, as the panel does. It needs host v41 (`cloudStudio`, branch `feat/cloud-studio` until it ships) and stays hidden with an older host or inside a sandbox. To try a branch host without touching the installed one, copy its `src/host` files and `host-config.json` into another folder and start the app with `LIZARD_STUDIO_HOST_DIR=<that folder>`; it runs its own daemon there.

## Run

Requires the host (`npx @lizard-build/lizard-studio-host install`) and Xcode. The Rust version is pinned in `rust-toolchain.toml`.

```sh
cargo run                 # debug
./scripts/bundle.sh       # dist/Lizard Studio.app
```

Chats are saved in `~/Library/Application Support/Lizard Studio/chats.json`, with your own models and the sound setting. The file is readable only by you, since custom models carry API keys.

## Visual checks

The `snapshot` feature renders the window to PNG without showing it or taking focus:

```sh
cargo build --features snapshot
LIZARD_STUDIO_SHOT=/tmp/shot.png LIZARD_STUDIO_SHOT_AT=3000,15000 \
LIZARD_STUDIO_SHOT_QUIT=1 ./target/debug/lizard-studio
```

- `LIZARD_STUDIO_OPEN=<session id>:<folder>` opens a saved Claude session read-only.
- `LIZARD_STUDIO_SEND=<folder>|<mode>|<prompt>` starts a chat and sends the prompt; `LIZARD_STUDIO_ALLOW_AFTER=<ms>` answers "Yes" to permission asks.
- `LIZARD_STUDIO_EXPAND=1` opens every tool group.
- `LIZARD_STUDIO_SIZE=<w>x<h>` sizes the window; `LIZARD_STUDIO_STORE=<file>` reads a fixture chat list; `LIZARD_STUDIO_RUNNING=<id,id>` shows those chats as running; `LIZARD_STUDIO_OPEN_AT` and `LIZARD_STUDIO_OPEN_WORKDIR` place the opened session in the list and set its working folder.
- `LIZARD_STUDIO_SEND_CLOUD=1` makes the `LIZARD_STUDIO_SEND` chat a cloud one.
- `LIZARD_STUDIO_CLOUD_START=1` presses Run in a sandbox once the host is ready; the stream URL is not opened in test runs.
- `LIZARD_STUDIO_ATTACH=<path,path>` puts files in the tray (or, with `LIZARD_STUDIO_SEND`, sends them with the test prompt).
- `LIZARD_STUDIO_CONNECT=claude|codex` starts that sign-in 4 seconds in (put a fake `open` first in PATH to keep the browser shut).
- `LIZARD_STUDIO_PICK=<model>,<effort>,<mode>` sets the new chat's settings; `LIZARD_STUDIO_MENU=model|effort|mode|agent|place|usage|settings[:claude|codex|models[:<file>|new]]` opens that picker or Settings tab once the window has drawn. Popovers fade in, so take two shots (`LIZARD_STUDIO_SHOT_AT=3000,4500`) and use the second.
- `LIZARD_STUDIO_DEBUG=1` logs host messages; with `LIZARD_STUDIO_DUMP=<dir>` it also saves the `models`, `ready`, `agentReady` and `commands` messages there.

Neither kind of test chat is saved.
