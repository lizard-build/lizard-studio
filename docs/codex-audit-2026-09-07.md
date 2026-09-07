# Codex in Lizard Studio: audit, 7 September 2026

## Result

The screenshots exposed two real bugs: local Markdown links stayed as text,
and the context meter counted cache hits twice. The audit also found lost
quota windows, shared browser tab state, and faults in turn and session handling.
This change fixes those faults. It does not publish the host or the extension.

The **258,400-token window is not itself a bug**. Studio reads the model's
effective Codex window from the local model cache and then uses the window
reported by the active thread. A model's API context limit can differ from
that value. The screenshot alone cannot tell us the correct replacement for
its 86.1k numerator; that needs the original usage event.

## How it works

1. The panel sends a native message with the chat id and agent name.
2. `router.mjs` sends Codex requests to `codex-host.mjs`. Shared file, folder,
   shell and git actions go to `claude-host.mjs`.
3. One local `codex app-server` process serves the Codex chats. Each chat has
   its own thread id, model, effort, permission mode and browser session.
4. The host translates Codex events into the message format the panel uses
   for both agents. Text arrives as deltas and as a final copy.
5. The browser MCP relay passes requests back to the panel. The panel keeps
   a selected browser tab for each chat.
6. Codex owns chat history, authentication, model access and plan limits.
   Studio reads these through app-server. Custom provider keys enter the
   child process through its environment.

## Fixed

| Area | Before | After |
| --- | --- | --- |
| File links | Only HTTP links and some paths in backticks worked. Codex's `[label](/path)` stayed as text. | Local links keep their label and open through the native host. Spaces, parentheses, underscores and line suffixes work. Enter and Space work too. |
| Inline rendering | Later formatting passes could rewrite code, link attributes or URLs. | Each code or link token is rendered once. Raw HTML and unsafe URL schemes stay inert. |
| Context count | Codex `inputTokens` already included `cachedInputTokens`; the panel added both. | The host converts cache hits to the panel's separate input fields. A 50,000-token input with 40,000 cached tokens and 1,000 output tokens shows 51,000, not 91,000. |
| Context updates | A late usage event waited for another assistant message. Live window sizes changed a global per-model value. | Usage reaches the panel directly. Each chat keeps its own live window. Missing usage stays unknown; cumulative thread totals are not used as context. |
| Quotas | Only `rateLimits.primary` survived. Opening the menu used Claude's refresh state. | The host reads `rateLimitsByLimitId`, both windows in each bucket, and legacy responses. The panel requests Codex limits directly and shows refresh errors or unavailable data. |
| Quota labels | Claude's weekly label rewrite could claim that a Codex limit covered all models. | Codex keeps its own duration and bucket label. Reset text is computed when the menu renders. |
| Browser tabs | Every Codex relay sent `session: "codex"`, so chats shared the selected tab. | Each thread has a distinct relay key. The host maps it to the chat id, including threads opened in advance. Closed relay sessions cannot act on a new chat. |
| Turn outcome | `turn/completed` always meant success; an earlier idle event could hide a later failure. | Completion uses the turn's status and error. Old or repeated completion events cannot finish a different turn. |
| Quiet turns and Stop | Five minutes without an event, or an interrupt RPC failure, could mark a turn stopped while Codex still worked. | Silence produces a warning. A known running turn ends only after completion, process exit, or an acknowledged interrupt. |
| Questions | A pending question retained the five-minute silence timer. An answer with a comma became several answers. | Questions pause the timer; free text stays one answer. Ending or closing a turn clears pending questions. |
| Resume | A failed resume silently started a blank thread. | The failure stays visible and the saved thread id remains available for retry. |
| Start and exit | Failed starts could leave prompts queued. Closing during startup could revive a chat. An app-server exit left the panel believing the session still ran. | Failure releases the queue and marks the session stopped. Closed starts are ignored. The panel can resume the saved thread on the next prompt. |
| Corrections | A failed `turn/steer` could start another turn while one still ran. | A failed correction reports an error; it cannot start an overlapping turn. |
| Custom keys | A new provider key could restart the one app-server while other chats ran. | Key changes wait until those turns finish. |
| Model display | The host's selected model was checked only against the Claude catalog. | The panel uses the active agent's catalog. A model change clears the old context reading. |
| Logs | Debug tracing wrote fragments of replies to the host log. | Reply tracing is off by default. |

## Checks

- `npm test`: 15 tests passed. They load the shipped host and replace only OS
  boundaries, so they do not start a CLI, touch account files or spend tokens.
- `test/e2e/panel.html?regressions=codex`: 14 checks passed in a browser,
  using the real panel and renderer. Checks cover links, keyboard use, counts,
  two-chat isolation, quotas, old host messages, and duplicate streamed text.
- The installed **Codex CLI 0.153.4** generated its app-server schema. The
  thread sandbox names and the usage/request fields match that schema.
- A live, read-only app-server check returned **7 models, 2 quota buckets and
  3 quota windows**. The default bucket had a weekly window; the other bucket
  had five-hour and weekly windows. A weekly-only row can therefore be valid,
  but the old host discarded the other bucket.
- A read-only query of the production `public` schema found no table names
  containing `studio` or `codex`. This is a narrow schema check, not proof that
  no other service ever records Studio activity. The local Codex host has no
  database client.

No model turn was run against a live account in this audit. Model choice,
tool behavior, OAuth sign-in, and long-running jobs were not tested end to end.
The existing account-backed test suite remains separate.

## Remaining gaps

These are code findings, not claims that the screenshots hit them:

| Priority | Gap | Next step |
| --- | --- | --- |
| P2 | History replay handles text, commands and file changes, but omits MCP calls and web searches. Replayed file changes also lose failure status. | Share live and history conversion and test a saved mixed-tool turn. |
| P2 | MCP elicitation is declined; unsupported server request types return an error. | Add explicit UI flows for supported forms and tool requests. Keep unsupported requests visible. |
| P2 | Image and other non-text MCP results are omitted from tool output. Rich Codex artifacts have no full renderer. | Add output types one at a time, with local file and image checks. |
| P2 | Model reroutes, verification requests and several newer item types have no panel UI. | Compare the installed schema with a supported-event list in CI. |
| P2 | New panel code and host code ship separately. Existing host-version checks do not require this new usage protocol. | Set a protocol requirement when scheduling the release; verify an old installed host updates before relying on the new counters. |

## Release

The host and extension both need an update. A push to `main` touching
`src/host/**` or `package.json` triggers `.github/workflows/publish-host.yml`
and publishes to npm. The extension needs its own package and release.
Keep this change on a review branch until release approval.

The required `~/.claude/lizard-naming.md` file was absent, and a search found
no copy. This change keeps the existing product name and adds no brand claims.

## Sources

- [Official app-server protocol](https://learn.chatgpt.com/docs/app-server):
  events, turn outcomes, approvals, model lists and quota fields.
- [Codex token accounting](https://github.com/openai/codex/blob/d70044072c05e8a5c8b16cac76c75368a860c454/codex-rs/protocol/src/protocol.rs):
  `non_cached_input()` subtracts cached tokens from total input.
- Local schema generated by `codex app-server generate-json-schema --experimental`
  from CLI 0.153.4; Studio baseline `db88a5526196ee27b3ebe45eff393bcadb61547d`.
