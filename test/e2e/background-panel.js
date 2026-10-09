"use strict";
window.runBackgroundPanelTests = async function () {
  const t = window.__test, passed = [];
  const check = (name, ok) => { if (!ok) throw new Error(name); passed.push(name); };
  const id = "history-a";
  const other = { id: "history-b", agent: "codex", spec: { cwd: "/test/project", model: "test-model" },
    sessionId: "thread-other", started: true, running: false, submitted: true, turnIds: [] };
  const states = [{ id, agent: "codex", spec: { cwd: "/test/project", model: "test-model" },
    sessionId: "thread-history", started: true, running: true, submitted: true, turnIds: ["live-turn"] },
  { ...other, replayDeferred: true }];
  t.emit({ type: "backgroundRestoreStart", sessions: states });
  t.emit({ type: "ready", ok: true, version: 39, home: "/test" });
  t.emit({ type: "agentReady", agent: "codex", ok: true, version: 12 });
  const replay = (message) => t.emit({ type: "backgroundReplay", message });
  replay({ type: "backgroundPrompt", id, text: "Keep working" });
  replay({ type: "event", id, data: { type: "stream_event", event: { type: "message_start", message: { id: "live-reply", role: "assistant", content: [], usage: {} } } } });
  replay({ type: "event", id, data: { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } } });
  replay({ type: "event", id, data: { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Still working" } } } });
  t.emit({ type: "backgroundRestoreEnd" });
  check("reattaching never starts or resends a turn", !t.posted("start").length && !t.posted("prompt").length);
  check("the running count restores before another live token arrives", window.RKChat.getRunningChatCount() === 1);
  const req = t.posted("loadTranscript").at(-1);
  check("older history excludes the replayed turn", req.excludeTurnIds.includes("live-turn"));
  t.emit({ type: "transcript", id, sessionId: req.sessionId, requestId: req.requestId, paged: true,
    events: [{ type: "assistant", historyItemId: "older", message: { id: "older", content: [{ type: "text", text: "Earlier reply" }] } }], nextCursor: null });
  // The worker restores a deferred chat on its own. That one-chat snapshot
  // says nothing about the turn still running in the first chat.
  document.querySelector('.chat-tab[data-tab-id="history-b"]').click();
  check("a deferred chat asks the worker for its own replay", t.posted("backgroundReplaySession").some((m) => m.id === "history-b"));
  t.emit({ type: "backgroundRestoreStart", partial: true, sessions: [other] });
  t.emit({ type: "backgroundRestoreEnd" });
  check("opening a deferred chat keeps the running turn", window.RKChat.getRunningChatCount() === 1
    && !document.querySelector("#bed").textContent.includes("Host disconnected mid-turn"));
  document.querySelector(`.chat-tab[data-tab-id="${id}"]`).click();
  check("returning to the running chat does not start it again", !t.posted("start").length);
  t.emit({ type: "event", id, data: { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " after reopening." } } } });
  t.emit({ type: "event", id, data: { type: "assistant", message: { id: "live-reply", content: [{ type: "text", text: "Still working after reopening." }], usage: {} } } });
  t.emit({ type: "event", id, data: { type: "result", result: "", usage: {} } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const text = document.querySelector("#bed").textContent;
  check("the live answer continues once, alongside older history", (text.match(/Still working after reopening\./g) || []).length === 1 && text.includes("Earlier reply"));
  check("completion clears activity", window.RKChat.getRunningChatCount() === 0);
  check("replayed user prompt appears once", (text.match(/Keep working/g) || []).length === 1);
  check("restoration has no runtime errors", t.errors.length === 0);
  return { passed: passed.length, checks: passed };
};
