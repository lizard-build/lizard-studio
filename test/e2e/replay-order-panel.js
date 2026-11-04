"use strict";
// A finished ChatGPT turn replayed from the host journal when the panel opens
// again: question, a note, tools, more notes, the answer — all in one burst.
window.runReplayOrderPanelTests = async function () {
  const t = window.__test, passed = [];
  const check = (name, ok) => { if (!ok) throw new Error(name); passed.push(name); };
  const id = "history-a";
  t.emit({ type: "backgroundRestoreStart", sessions: [{ id, agent: "codex", spec: { cwd: "/test/project", model: "test-model" },
    sessionId: "thread-history", started: true, running: false, submitted: true, turnIds: ["turn-new"] }] });
  t.emit({ type: "ready", ok: true, version: 41, home: "/test" });
  t.emit({ type: "agentReady", agent: "codex", ok: true, version: 12 });
  t.emit({ type: "backgroundReplay", message: { type: "backgroundPrompt", id, text: "Post it on both sites" } });
  const replay = (data) => t.emit({ type: "backgroundReplay", message: { type: "event", id, data } });
  const note = (msgId, text, phase = "commentary") => {
    for (const event of [
      { type: "message_start", message: { id: msgId, role: "assistant", content: [], usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]) replay({ type: "stream_event", event });
    replay({ type: "assistant", message: { id: msgId, role: "assistant", content: [{ type: "text", text }], usage: {}, phase } });
  };
  const tool = (toolId) => {
    replay({ type: "assistant", message: { id: "codex_tool_" + toolId, role: "assistant",
      content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "echo " + toolId } }], usage: {} } });
    replay({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok", is_error: false }] } });
  };
  note("note-1", "First note before any tool.");
  tool("a"); tool("b");
  note("note-2", "Second note between tools.");
  tool("c");
  note("answer", "Final answer.", "final_answer");
  replay({ type: "result", result: "Final answer.", usage: {} });
  t.emit({ type: "backgroundRestoreEnd" });
  const req = t.posted("loadTranscript").at(-1);
  check("older history excludes the replayed turn", req.excludeTurnIds.includes("turn-new"));
  t.emit({ type: "transcript", id, sessionId: req.sessionId, requestId: req.requestId, paged: true, nextCursor: null, events: [
    { type: "user", historyTurnId: "turn-old", historyItemId: "u", message: { role: "user", content: [{ type: "text", text: "Earlier question" }] } },
    { type: "assistant", historyTurnId: "turn-old", historyItemId: "r", message: { id: "older", content: [{ type: "text", text: "Earlier reply" }] } },
  ] });
  // The finished turn folds 600 ms after it ends.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const bed = document.querySelector("#bed");
  const rows = [...bed.querySelectorAll(".chat-messages:not(.hidden) > .msg")];
  const text = rows.map((row) => row.textContent).join("\n");
  check("the replayed question appears once", (text.match(/Post it on both sites/g) || []).length === 1);
  const turn = rows.at(-1);
  check("the replayed turn is one row, after its question",
    rows.at(-2)?.textContent.includes("Post it on both sites") && turn.textContent.includes("First note") && turn.textContent.includes("Final answer"));
  const body = turn.querySelector(":scope > .assistant-body");
  const tray = body.querySelector(":scope > .work-tray");
  check("the work folds into one line", !!tray && tray.querySelectorAll(".tool-card").length === 3);
  const order = [...tray.querySelector(".work-tray-list").children].map((n) =>
    n.querySelectorAll(".tool-card").length || (n.classList.contains("tool-card") ? 1 : n.textContent.trim().split(" ")[0]));
  check("notes keep their place between the tools: " + order, order.join(",") === "First,2,Second,1");
  check("only the answer stays below the tray", [...body.children].filter((n) => n !== tray && !n.classList.contains("msg-footer"))
    .map((n) => n.textContent.trim()).join("|") === "Final answer.");
  check("the answer has its copy and time row", body.lastElementChild?.classList.contains("msg-footer"));
  check("replay has no runtime errors", t.errors.length === 0);
  return { passed: passed.length, checks: passed };
};
