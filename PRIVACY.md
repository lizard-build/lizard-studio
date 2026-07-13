# Privacy Policy — Lizard Studio

_Last updated: July 13, 2026_

Lizard Studio is a Chrome extension (Manifest V3) that runs an AI coding agent
(Anthropic's Claude Code) in your browser's side panel, together with an
on-page design toolkit. This policy explains what the extension does with your
data.

**Short version:** Lizard Studio does not have any servers. We do not collect,
store, transmit, sell, or share your data with anyone. Everything runs on your
own machine. The only data that leaves your computer is what you send to
Anthropic's Claude API through your own Claude account — exactly as it would if
you ran the `claude` CLI in a terminal.

## Who operates this extension

Lizard Studio is an open-source project. There is no backend service and no
company account behind it. The extension talks only to:

1. A small **native messaging host** that you install on your own machine,
   which launches the `claude` command-line tool locally; and
2. **Anthropic's Claude API**, reached by that local `claude` process using
   your own Claude credentials.

We (the extension's authors) never receive your data.

## What data the extension handles, and where it goes

When you actively use the chat or the browser-aware tools, the following data
may be read from the current tab and sent to Anthropic's Claude API as part of
your conversation, so that the agent can help you:

- **Page content you point it at** — the DOM, accessibility snapshot, visible
  text, the list of your open tabs, and elements you attach with the Selector
  tool.
- **Observations you request** — screenshots (including annotated ones),
  console logs, network activity, and the results of page evaluation, when a
  browser tool that produces them is used.
- **Your chat messages and attachments** — text you type, images you paste or
  drop, and files/paths in the working directory you choose.

This data is transmitted only to Anthropic and is governed by
**Anthropic's Privacy Policy** (<https://www.anthropic.com/legal/privacy>) and
the terms of your Claude account. Lizard Studio adds no additional recipients.

Read-only browser tools are pre-approved; any tool that acts on the page (click,
type, navigate, run a command, edit a file) is gated behind an explicit
permission prompt that shows you the exact action first.

## What is stored, and where

- **Chat sessions** are saved locally on your machine as ordinary Claude Code
  transcripts (the same files `claude --resume` uses). They never leave your
  disk except as part of your conversation with Claude.
- **Extension settings** (e.g. your selected folder, model, and toolbar state)
  are kept in Chrome's local `storage` on your device.
- The on-page toolkit's state (rulers, guides, grids, etc.) is ephemeral and
  per-tab; it is not persisted.

Nothing is written to any server operated by us, because none exists.

## What we do NOT collect

- No analytics, telemetry, crash reporting, or usage tracking.
- No advertising or advertising identifiers.
- No selling or sharing of personal data with third parties.
- No collection of browsing history for our own purposes.

## Permissions and why they are needed

The extension requests broad permissions solely to let the agent see and act on
the page you are working on, on your instruction:

- **`nativeMessaging`** — to communicate with the local host that runs `claude`.
- **`<all_urls>` / content scripts** — so the design toolkit and page-reading
  tools work on whatever site you are building.
- **`debugger`** — to capture console/network activity and run page evaluation
  requested through the browser tools (via the Chrome DevTools Protocol).
- **`scripting`, `tabs`, `activeTab`** — to inject the toolbar and read/act on
  the active tab.
- **`declarativeNetRequest`** — for local request handling required by the
  in-panel tooling.
- **`storage`, `clipboardWrite`, `sidePanel`** — settings persistence, copying
  values (e.g. from the eyedropper), and hosting the side-panel chat.

These permissions are used only in service of the features described above and
never to collect data for us.

## Children

Lizard Studio is a developer tool and is not directed to children under 13.

## Changes to this policy

If this policy changes, the update will be published in this file in the
project's public repository, with a new "Last updated" date.

## Contact

Questions about this policy can be raised as an issue in the project's GitHub
repository: <https://github.com/lizard-build/lizard-studio>.
