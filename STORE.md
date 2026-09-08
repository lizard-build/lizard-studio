# Chrome Web Store listing — Lizard Studio

Copy-paste material for the Chrome Web Store Developer Dashboard. Fill each
field with the matching block below.

---

## Name

> Lizard Studio — Claude Code & ChatGPT Side Panel

## Detailed description

> Use Claude Code or ChatGPT beside the page you're building. Ask your agent to inspect the page, read errors, edit your local project, and check the result in the browser.
>
> Attach an element with Selector or a marked screenshot with Annotate. Rulers, guides, grids, an eyedropper, and responsive preview help you describe the change.
>
> Each chat keeps its own model, permissions, history, and text draft. Settings and skills are separate for Claude Code and ChatGPT. Sign in with your own account through the local host.
>
> Requires the free Lizard Studio host on your computer and the CLI for your chosen agent. Account or model-provider charges may apply.

## Version 1.0.9 — what’s new

- ChatGPT naming across the agent picker, settings, sign-in, usage, and host errors.
- Separate chat drafts, reliable Save status, and retained settings drafts.
- Attachments and selections stay in their source browser window.
- Better keyboard navigation, sign-in, and history handling.

## Single purpose

> Lizard Studio is a single-purpose developer tool: it runs an AI coding
> assistant (Claude Code or ChatGPT) in the browser side panel that can read,
> measure, and act on the web page you are currently building, so you can fix
> front-end issues without leaving the browser. The on-page toolkit (rulers,
> guides, grid, inspector, eyedropper, annotator, responsive preview) exists to
> feed that same assistant precise, page-derived context. Every feature serves
> the one purpose of AI-assisted front-end development against the active tab.

## Short description (132 char max)

> Claude Code and ChatGPT in your browser side panel. Inspect, measure, and fix the page you're building.

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

> Chat data reaches the provider selected by the user: Anthropic for Claude Code,
> OpenAI for ChatGPT, or a model endpoint the user adds. The local CLI uses the
> user’s account or credentials. Dragon Labs LLC runs no chat server and receives
> no chat data.

---

## Permission justifications

Paste each into the corresponding "Justification" box in the Permissions
section of the Dashboard.

### `nativeMessaging`

> The extension's entire function depends on driving the user's locally
> installed agent CLI. It uses native messaging to talk to a small host
> program the user installs on their own machine, which runs the selected agent. No code is downloaded; the host only relays messages between the
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

> Used only by the Responsive-preview tool. When the user turns that tool on,
> the extension installs a temporary session rule that removes framing headers
> (X-Frame-Options and Content-Security-Policy frame-ancestors) from sub-frame
> responses in that one tab, so the page being developed can be re-rendered
> inside the device-preview iframe. The rule is scoped to the requesting tab and
> to sub-frame requests only, and is removed the moment the tool is switched off
> or the tab navigates/closes — it never weakens CSP for normal browsing, and no
> browsing data is collected or sent anywhere.

### `sidePanel`

> Hosts the Claude Code and ChatGPT chat UI in Chrome's side panel — the primary interface
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
- Screenshots 1280×800 (present, in `store-assets/`):
  - `store-assets/hero-1280x800.png` — the side-panel chat next to a page.
  - `store-assets/toolkit-1280x800.png` — the on-page inspector + toolkit in action.
- Optional small promo tile 440×280 (not yet made).
- Category: **Developer Tools**.
- Language, detailed description, and this single-purpose statement.

## Pre-submit reminders

- **The `"key"` field must NOT be in the uploaded manifest** — the Web Store
  rejects it ("key field is not allowed in manifest"). `scripts/build-zip.sh`
  strips it automatically from the zipped copy; the repo manifest keeps it for
  local unpacked development.
- **Extension IDs.** Without the `key`, the store assigned its own ID:
  `kgbaeoalmkabpoglpjcdmppdmcipfdeh`. Since host v1.0.15,
  `src/host/install.mjs` (`DEFAULT_EXT_IDS`) allows both this store ID and the
  dev ID `nhcgkijjijdinhldjohkmbbgjokobecd`, so store and unpacked installs
  work with the same published host. If either ID ever changes, update
  `DEFAULT_EXT_IDS` and republish the host to npm.
- Expect manual review because of `debugger` + `nativeMessaging` + `<all_urls>`.
- Build the upload zip with `./scripts/build-zip.sh` (excludes `.git`, the host
  `.tgz`, docs, and `src/host`).
