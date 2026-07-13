# Chrome Web Store listing — Lizard Studio

Copy-paste material for the Chrome Web Store Developer Dashboard. Fill each
field with the matching block below.

---

## Single purpose

> Lizard Studio is a single-purpose developer tool: it runs an AI coding
> assistant (Anthropic's Claude Code) in the browser side panel that can read,
> measure, and act on the web page you are currently building, so you can fix
> front-end issues without leaving the browser. The on-page toolkit (rulers,
> guides, grid, inspector, eyedropper, annotator, responsive preview) exists to
> feed that same assistant precise, page-derived context. Every feature serves
> the one purpose of AI-assisted front-end development against the active tab.

## Short description (132 char max)

> An AI coding agent that lives next to the page you're building — it can see,
> measure, and fix the page with you.

## Data usage disclosures (Privacy practices tab)

- **Does this extension collect user data?** Yes — it *handles* data to function
  (see below), even though the developer never receives it.
- **Data types handled:** "Website content" (page DOM, text, screenshots) and
  "User activity" only insofar as the user directs the assistant at the page.
  No authentication info, personal communications, financial, health, location,
  or web-history data is collected by the developer.
- **Certifications (check all three):**
  - I do not sell or transfer user data to third parties outside of the
    approved use cases.
  - I do not use or transfer user data for purposes unrelated to my item's
    single purpose.
  - I do not use or transfer user data to determine creditworthiness or for
    lending purposes.
- **Privacy policy URL:**
  `https://github.com/lizard-build/lizard-studio/blob/main/PRIVACY.md`

> Note: data the user sends to the assistant is transmitted only to Anthropic's
> Claude API through the user's own Claude account and their locally installed
> `claude` CLI. Dragon Labs LLC operates no server and receives no user data.

---

## Permission justifications

Paste each into the corresponding "Justification" box in the Permissions
section of the Dashboard.

### `nativeMessaging`

> The extension's entire function depends on driving the user's locally
> installed Claude Code CLI. It uses native messaging to talk to a small host
> program the user installs on their own machine, which spawns the `claude`
> process. No code is downloaded; the host only relays messages between the
> panel and the local CLI.

### Host permissions — `<all_urls>` (and content scripts on all URLs)

> The tool is a front-end development assistant, so it must operate on whatever
> site the developer is building — which can be any URL, including localhost and
> internal staging hosts. The content script injects the design toolbar and lets
> the assistant read the page the user is actively working on. It runs only to
> serve the user's own request against the tab they have open.

### `debugger`

> Required to give the assistant the same observability a developer has in
> DevTools: capturing console messages, inspecting network requests, and
> evaluating expressions in the page via the Chrome DevTools Protocol. These
> feed the AI accurate, live diagnostics about the page being debugged. Actions
> that use it are initiated by the user through the chat.

### `scripting`

> Used to programmatically inject the on-page toolkit and to run the page-
> reading and page-acting tools the assistant needs (e.g. reading the DOM,
> attaching an element to the chat) in response to the user's requests.

### `tabs`

> Used to manage the developer's working context: identifying the active tab the
> assistant should operate on, listing open tabs so the user can attach one for
> context, and coordinating the side panel with the correct tab.

### `activeTab`

> Grants access to the tab the user is currently working on when they invoke the
> extension, so the assistant and toolkit act on the intended page.

### `declarativeNetRequest`

> Used for local request handling required by the in-panel tooling (e.g.
> ensuring resources load correctly for the panel/preview). It applies static,
> local rules only; no browsing data is collected or sent anywhere.

### `sidePanel`

> Hosts the Claude Code chat UI in Chrome's side panel — the primary interface
> of the extension.

### `storage`

> Persists local user settings such as the selected working folder, chosen
> model, permission mode, and toolbar state. Stored on the user's device only.

### `clipboardWrite`

> Lets the user copy values produced by the tools — for example a color from the
> eyedropper or a selector from the inspector — to the clipboard.

---

## Assets checklist (upload separately)

- Icon 128×128 — `icons/icon128.png` (present).
- At least one screenshot 1280×800 or 640×400 (PNG/JPEG). Recommended: the side
  panel chat next to a page, and the on-page toolkit in action.
- Optional small promo tile 440×280.
- Category: **Developer Tools**.
- Language, detailed description, and this single-purpose statement.

## Pre-submit reminders

- Keep the manifest `"key"` field so the published extension ID stays
  `nhcgkijjijdinhldjohkmbbgjokobecd`, matching the native host's
  `allowed_origins`. Removing it will assign a new ID and break native
  messaging. (See README / host `install.mjs`.)
- Expect manual review because of `debugger` + `nativeMessaging` + `<all_urls>`.
- Build the upload zip with `./scripts/build-zip.sh` (excludes `.git`, the host
  `.tgz`, and docs).
