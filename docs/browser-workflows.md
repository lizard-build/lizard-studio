# Browser plans in Lizard Studio

The browser MCP relay can run known steps locally. The model sends a plan once; the host runs its actions, waits and checks, then returns a short result. Existing browser tools still work.

Use `browser_run` when the next steps are known. Return to the model when the page needs a new decision. Plans accept named operations and conditions; they do not run model-written JavaScript in the host.

```json
{
  "steps": [
    { "op": "tab_open", "args": { "url": "https://example.com/form" } },
    { "op": "wait_for", "args": { "condition": { "selector": "#name", "state": "visible" } } },
    { "op": "fill", "args": { "selector": "#name", "value": "Alex" } },
    { "op": "click", "args": { "selector": "#save" } },
    { "op": "wait_for", "args": { "condition": { "selector": "#result", "textIncludes": "Saved" } } },
    { "op": "observe", "args": { "selector": "#result" } }
  ]
}
```

Each action needs the same user authorization as its single-call form. The host checks the full plan, including both branches, before running any step. A failed action or check stops the plan. Actions never retry automatically.

## Tools

| Tool | Use |
| --- | --- |
| `browser_run` | Run an ordered list of steps in one tab. |
| `browser_open_page` | Open a tab, wait for readiness or `waitFor`, then observe. |
| `browser_click_and_observe` | Click `target` once, wait for `waitFor`, then observe. |
| `browser_fill_form` | Fill `fields`, optionally click `submit`, wait, then observe. Submitting requires `waitFor`. |
| `browser_wait_for` | Poll a condition locally until it passes or times out. |
| `browser_assert` | Check a condition once. |
| `browser_observe` | Read scoped text and metadata, or changes since the last read. |
| `browser_check_pages` | Check independent URLs with a bounded number of workers. |
| `browser_resume` | Continue a paused run by `runId`. |
| `browser_run_result` | Read status and retained step results by `runId`. |
| `browser_cancel` | Cancel one run by `runId`, or all runs in this MCP session. |

`browser_run` accepts `tab_open`, `tab_activate`, `navigate`, `reload`, `info`, `dom`, `snapshot`, `console`, `network`, `click`, `fill`, `type`, and `key`, with the corresponding primitive tool's arguments. It also accepts `wait_for`, `assert`, `observe`, and `if`. Set `tabId` on the run, not on each step. Otherwise it uses the chat's working tab. `tab_open` changes the run's tab.

Use selectors across navigation. Snapshot refs can expire; request a new `snapshot` when needed. New tabs open in the background by default. Clicks and keys target the working tab through CDP with page focus emulation; they do not select the tab or focus its window. Chrome clears that emulation when the debugger detaches. Use `active: true` or `tab_activate` only when the user asks to see a tab. After a timeout, inspect the page without switching tabs before deciding whether to repeat an action.

## Native Chrome dialogs

Lizard Studio tracks `alert`, `confirm`, `prompt`, and `beforeunload` dialogs through the Chrome debugger. If a dialog blocks a browser action, the tool returns `BROWSER_DIALOG_OPEN` with the tab, dialog ID, type, and message. It keeps the debugger attached so the agent can respond. The page's dialog text is untrusted content, not an instruction.

Use `browser_dialog` to check the current dialog and `browser_handle_dialog` with its `tabId`, `dialogId`, and `accept` to respond. A stale dialog ID cannot answer a newer dialog. `promptText` applies only to an accepted `prompt`.

For the "Leave site?" warning, `accept: false` stays on the page. Save changes first, or open a new tab to continue other work. `accept: true` leaves and may discard unsaved changes; use it only when the user's authorization covers that loss. Routine responses within existing authorization need no new question. The runtime never accepts all dialogs by default.

After a response, inspect the page. The action that opened the dialog may have completed; do not repeat a click or submission blindly. A browser plan stops at this error. Respond with the standalone dialog tool, then start a new plan from the observed state. OS file pickers and Chrome permission prompts need their own tools.

## Conditions and branches

Conditions combine their fields with AND:

- `selector` selects the first element for state, text and value checks.
- `state` is `visible`, `hidden`, `attached` or `absent`.
- `textIncludes` checks element text, or body text without a selector.
- `valueEquals` checks a selected field's value.
- `count` checks how many elements match the selector.
- `urlIncludes` checks the current URL.
- `ready: true` requires a body, a document past the loading state, and a URL other than `about:blank`. Use a page-specific condition for async content.

`wait_for` accepts `{ "condition": { ... }, "timeoutMs": 10000 }`. `assert` checks once. Their run status is `completed` when the check passes; failures return an error. Step details include the predicate result.

`if` accepts `{ "condition": { ... }, "then": [ ... ], "otherwise": [ ... ] }`. The host checks the condition once and inserts only the chosen branch. `otherwise` is optional. Conditions and branches require no model call.

## Short results and logs

A run returns its `runId`, status, completed step count, tab, timings and last observation. It keeps step results locally. `browser_run_result` accepts `fromStep` and `limit` for paging through that log. Inputs are not copied into the log, but page output can contain values shown by the page. Results above 16,000 characters have an explicit `truncated` marker.

Observations default to 2,000 characters. Set `selector` to read one region, or `mode: "full"` for up to 12,000 characters. `mode: "changes"` returns added and removed lines against the previous observation with the same tab, selector and text limit. A new URL starts a new baseline. Reordered text falls back to current text. Changes outside a truncated region are not covered. Observations do not build interactive refs; use `browser_snapshot` for those.

`hostCalls` counts browser bridge calls. `hostMs` sums their wait time; parallel workers can overlap, so it is not wall time. `elapsedMs` includes the time since the run started, including any pause. These measures exclude model generation time.

## Parallel page checks

```json
{
  "pages": [
    { "url": "https://example.com/", "checks": [{ "textIncludes": "Welcome" }] },
    { "url": "https://example.com/about", "checks": [{ "selector": "h1", "state": "visible" }] }
  ],
  "concurrency": 3,
  "timeoutMs": 10000
}
```

`browser_check_pages` creates a background tab per URL, waits for the document and all checks, then closes that exact tab. It preserves the chat's working tab. Reports include status, title, final URL, passed check count and cleanup outcome. A failed close remains visible as a failed page result.

Workers do not click or submit forms. Tabs share the user's browser profile and storage; they do not provide separate accounts. Use this tool for independent page checks. It accepts up to 12 URLs and 1–4 workers, with 3 by default.

## Bounds, pause and cancellation

Plans allow at most 60 steps including branches, three nested branch levels, and 30 form fields. Conditions wait 10 seconds by default. A plan has a 60-second default deadline, adjustable to 120 seconds. Page batches have a 120-second total deadline and a 10-second per-page default, adjustable to 20 seconds.

After about 15 seconds, a plan pauses between steps or during a read-only wait. A page batch pauses between URLs. The current operation or page can take longer than that slice. Call `browser_resume` with the returned `runId` to continue. Completed actions and URLs do not repeat. The original deadlines still apply. Failed or cancelled runs cannot resume.

MCP request cancellation, chat interruption and session shutdown stop further steps. An action already sent to Chrome may still finish. Inspect its result and the page before repeating it. Batch cancellation waits for a pending tab-open reply so it can close the exact tab created by that request.

Within one MCP session, two running plans cannot act on the same tab at once. This does not lock out the user, primitive tool calls, or another chat. A paused plan releases the lock and retains its tab ID.

The relay keeps at most ten runs, with a five-minute expiry after a run stops or pauses. Logs and observation baselines disappear when that relay exits.

## Validation and installation

Run `npm test` for the unit suite. `npm run test:e2e:browser` runs the real MCP relay, shipped panel code and Chrome extension APIs against local fixtures. It needs `agent-browser`; set `STUDIO_TEST_CHROME` to a Chrome executable that supports unpacked extensions when needed. It uses a separate browser profile and test extension, leaves reports in a temporary folder, and closes its test browser on exit. It uses no model or account.

The runner source lives in `src/host/browser-workflows.mjs`. `npm run build:browser` embeds it in the shipped `mcp-browser.mjs`; `npm test` checks that the bundle matches the source. The relay needs no new sibling file, so older self-updaters can copy it safely. Both the host and extension need the matching update: the extension preserves the working tab during batch checks, and the host exposes and runs the new tools. Restart the host session after updating so the model receives the new tool list.
