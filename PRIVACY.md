# Privacy Policy — Lizard Studio

_Last updated: September 8, 2026_

Lizard Studio is a Chrome extension (Manifest V3) that runs an AI coding agent
(Claude Code or ChatGPT) in your browser's side panel, together with an
on-page design toolkit. This policy explains what the extension does with your
data.

Lizard Studio runs its extension and host on your computer. Dragon Labs LLC
runs no chat server and receives no chat data. Chat content goes to the provider
you choose through your local agent: Anthropic for Claude Code, OpenAI for
ChatGPT, or a model endpoint you add in Settings.

## Who operates this extension

Lizard Studio is published by **Dragon Labs LLC** as an open-source project.
Dragon Labs LLC operates no backend service for the extension and receives no
user data through it. The extension talks only to:

1. A small **native messaging host** that you install on your own machine,
   which runs the selected agent locally; and
2. The **provider you select**, reached through that agent using your account
   or credentials. Claude Code uses Anthropic; ChatGPT uses OpenAI. Custom models
   use the endpoint you configure.

We (the extension's authors) never receive your data.

## What data the extension handles, and where it goes

When you actively use the chat or the browser-aware tools, the following data
may be read from the current tab and sent to your selected provider as part of
your conversation, so that the agent can help you:

- **Page content you point it at** — the DOM, accessibility snapshot, visible
  text, the list of your open tabs, and elements you attach with the Selector
  tool.
- **Observations you request** — screenshots (including annotated ones),
  console logs, network activity, and the results of page evaluation, when a
  browser tool that produces them is used.
- **Your chat messages and attachments** — text you type, images you paste or
  drop, and files/paths in the working directory you choose.

Your selected provider's privacy policy and account terms govern its handling
of chat data. Connected tools may send data to the services you configure.

Actions follow the permission mode you choose for the chat. Modes that allow
actions without a prompt do not ask for each action.

## What is stored, and where

- **Chat sessions** are saved locally by the selected agent. Chat content also
  reaches your selected provider as part of the conversation.
- **Extension settings and text drafts** (e.g. your selected folder, model,
  and toolbar state) are kept in Chrome's local `storage` on your device.
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

- **`nativeMessaging`** — to communicate with the local host that runs your selected agent.
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
repository (<https://github.com/lizard-build/lizard-studio>) or directed to
Dragon Labs LLC.
