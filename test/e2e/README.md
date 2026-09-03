# End-to-end tests

Two harnesses, because the panel and the hosts fail in different ways.

## Protocol tests — `run.mjs`

A stand-in for Chrome drives the real `router.mjs` over a real stdio pipe, in
Chrome's own wire format. Below that pipe nothing is mocked: these run the real
`claude` and `codex` CLIs against a throwaway git repo in your temp folder.

```bash
npm run test:e2e          # everything (spends a few model tokens)
npm run test:e2e:cheap    # only what costs nothing
node test/e2e/run.mjs --filter codex
```

What they cover:

- **The pipe.** Claude's handshake is byte-identical with and without the
  router. An unknown message type is ignored rather than fatal. Killing the
  Codex host leaves Claude working. Nothing crosses Chrome's 1 MB cap.
- **Shared operations.** Picking a folder, git, the composer's shell mode — sent
  from a Codex chat, answered by the host that implements them.
- **Codex.** Session start, streaming, shell and file cards, read-only refusing
  to write, stop, transcript replay, token counts, prewarming.
- **Claude.** A session still starts, streams and finishes; the permission round
  trip still lands; the slash-command list still arrives.
- **Both at once.** Two agents, one pipe, no crossed wires.

### Two rules learned the hard way

**Claude emits `system init` on the first turn, not on spawn.** Waiting for it
before sending a prompt waits forever.

**Never assert that a model chooses to do something.** The first draft of the
permission test asked Claude to "present a plan for approval" and hoped it
reached for a tool. It did, about two times in three. Name the tool outright, or
assert the invariant instead of the manners — "a read-only session cannot write"
is a fact about the sandbox; "it asks first" is a fact about the model's mood.

Approvals must be answered or the turn sits on a dialog nobody is looking at:
`panel.autoApprove()` and `panel.autoDeny()` stand in for the person.

## Panel tests — `panel.html`

The panel's own code, running in a browser, with everything below it faked: the
native port becomes a recorder, `chrome.storage` an object. `window.__test`
exposes what the panel sent, pushes host messages back in, and reads the DOM.

```bash
python3 -m http.server 8791
open http://127.0.0.1:8791/test/e2e/panel.html
```

Then drive it from the console — `__test.emit({type:"ready", …})`,
`__test.toolCards()`, `__test.rows("#harness-menu")`. A `?seed=<json>` parameter
starts the panel from a remembered state, which is how the persistence and
per-tab checks are done.
