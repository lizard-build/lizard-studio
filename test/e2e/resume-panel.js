"use strict";

window.runResumePanelTests = async function (scenario) {
  const t = window.__test, checks = [];
  const check = (name, ok) => { if (!ok) throw new Error(name); checks.push(name); };
  const saved = () => t.storage.rkChatV2.tabs.find((c) => c.id === "resume-a");
  const emit = (msg) => t.emit({ id: "resume-a", ...msg });
  t.emit({ type: "ready", version: 32, ok: true, home: "/test" });
  t.emit({ type: "agentReady", agent: "codex", ok: true });
  t.emit({ type: "models", agent: "codex", defaultModel: "test-model", models: [{ id: "test-model", label: "Test model", efforts: ["medium"], defaultEffort: "medium" }] });
  if (scenario === "resume-empty") {
    check("a new chat starts without a resume ID", !t.posted("start").at(-1).resume);
    emit({ type: "started", cwd: "/test/project", permissionMode: "full" });
    emit({ type: "event", data: { type: "system", subtype: "init", agent: "codex", session_id: "empty-thread", cwd: "/test/project", model: "test-model" } });
    check("an empty thread ID is not persisted", saved().sessionId === null);
    check("draft survives startup", document.querySelector("#composer-input").value === "Keep this draft");
    const before = t.posted("loadTranscript").length;
    emit({ type: "exit", code: 1 });
    t.click(".session-failure-action");
    check("empty reconnect does not resume the temporary thread ID", !t.posted("start").at(-1).resume);
    check("empty reconnect does not try to load nonexistent history", t.posted("loadTranscript").length === before);
    emit({ type: "started", cwd: "/test/project", permissionMode: "full" });
    emit({ type: "event", data: { type: "system", subtype: "init", agent: "codex", session_id: "next-thread", cwd: "/test/project", model: "test-model" } });
    const input = document.querySelector("#composer-input");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    check("the first message goes out once", t.posted("prompt").length === 1);
    check("submitted chats keep a resume ID", saved().sessionId === "next-thread");
  } else {
    check("old saved threads remain eligible for resume", t.posted("start").at(-1).resume === "missing-thread");
    emit({ type: "error", code: "CHAT_HISTORY_MISSING", message: "Couldn't open a ChatGPT session: Couldn't resume this chat: no rollout found for thread id missing-thread" });
    emit({ type: "exit", code: 1, quiet: true });
    check("missing history has an honest title", t.text(".session-failure-title") === "Chat history unavailable");
    check("missing history offers a new chat instead of a retry loop", t.text(".session-failure-action") === "Start new chat");
    check("failure preserves the saved ID", saved().sessionId === "missing-thread");
    const before = t.posted("prompt").length;
    t.click(".session-failure-action");
    const state = t.storage.rkChatV2;
    const fresh = state.tabs.find((c) => c.id === state.activeId);
    check("recovery creates another chat and keeps the original", state.tabs.length === 2 && fresh.id !== "resume-a" && saved().sessionId === "missing-thread");
    check("recovery keeps the user's draft", fresh.draft === "Keep this draft" && document.querySelector("#composer-input").value === "Keep this draft");
    check("recovery keeps agent, folder, model, effort, and permission mode", fresh.harness === "codex" && fresh.cwd === "/test/project" && fresh.model === "test-model" && fresh.effort === "medium" && fresh.mode === "full");
    check("the new chat has no stale resume ID", !t.posted("start").at(-1).resume);
    check("opening the new chat does not submit the draft", t.posted("prompt").length === before);
  }
  check("panel has no runtime errors", t.errors.length === 0);
  return { passed: checks.length, checks };
};
