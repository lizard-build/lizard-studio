# Lizard Studio for macOS

A native window for the Lizard Studio chat, built with [GPUI](https://gpui.rs) through [GPUI Kit](https://gpui-kit.com). It copies the side panel's window mode: chats on the left, the open chat on the right, the same composer, tool groups, permission cards and running indicator.

The app has no agent code of its own. It starts the same local host as the Chrome extension (`~/.lizard-studio/host/router.mjs`), speaks the same native-messaging frames, and attaches to its own session daemon (`router-4242424242.sock`), so its chats never mix with a browser window's.

## What works

- Claude Code and ChatGPT chats: streaming replies, markdown, tool groups ("Ran 3 commands, read a file"), expandable tool cards with diffs and output.
- Permission cards and AskUserQuestion, with the panel's keys (1-9, ↑↓, enter, esc).
- Model, effort and permission mode pickers, shift+tab to cycle modes, the context ring.
- Chat list with Active and History, search, rename, bookmarks, status dots.
- History from the agent's own transcript, paged in as you scroll up.
- Image attachments; other files go in as paths.

There is no browser here, so the `browser_*` tools answer "No browser is attached". Use the extension for page work.

**Local or Cloud.** The first chip of a new chat picks where it runs. Local is this Mac, in a folder you choose, through the host. Cloud runs the chat's agent in a new Lizard sandbox from its template (`claude` or `codex`) through your `lizard` CLI: `sandbox create`, then `sandbox prompt --json` for each message (the conversation continues with `-c`), `sandbox interrupt` for Stop. The sandbox lives an hour after the last message and is replaced if it has stopped. The agent uses the credentials connected to your Lizard account (`lizard agents`). The CLI can't read a finished conversation back, so the app keeps what a cloud chat showed in `~/Library/Application Support/Lizard Studio/cloud/`.

**Run in a sandbox** (sidebar foot, above Settings) starts Lizard Studio in a new Lizard desktop sandbox through your `lizard` CLI and opens its stream in the browser, as the panel does. It needs host v41 (`cloudStudio`, branch `feat/cloud-studio` until it ships) and stays hidden with an older host or inside a sandbox. To try a branch host without touching the installed one, copy its `src/host` files and `host-config.json` into another folder and start the app with `LIZARD_STUDIO_HOST_DIR=<that folder>`; it runs its own daemon there.

## Run

Requires the host (`npx @lizard-build/lizard-studio-host install`) and Xcode. The Rust version is pinned in `rust-toolchain.toml`.

```sh
cargo run                 # debug
./scripts/bundle.sh       # dist/Lizard Studio.app
```

Chats are saved in `~/Library/Application Support/Lizard Studio/chats.json`.

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
- `LIZARD_STUDIO_DEBUG=1` logs host messages.

Neither kind of test chat is saved.
