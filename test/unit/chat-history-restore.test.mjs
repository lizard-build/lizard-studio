import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/panel/chat.js", import.meta.url), "utf8");

function restore({ savedId = null, resume = null, submitted = false } = {}) {
  const requests = [];
  const element = () => ({ replaceWith() {}, classList: { toggle() {} } });
  const old = { id: "a", harness: "codex", sessionId: savedId, codexHasSubmittedTurn: !!savedId, messagesEl: element() };
  const scope = {
    chats: new Map([["a", old]]), order: ["a"], activeId: "a",
    backgroundRestoring: false, backgroundRestoreStates: [], connected: true, hostReady: true,
    els: { stack: { appendChild() {} } }, clearTimeout,
    makeChat: (opts) => ({ ...opts, empty: !opts.sessionId, codexHasSubmittedTurn: !!opts.sessionId,
      messagesEl: element(), permCards: new Map(), queue: [] }),
    requestHistoryPage: (chat) => requests.push(chat.sessionId),
    renderTabs() {}, updateTabDots() {}, syncComposer() {}, savePrefs() {},
    prewarmHarnesses() {}, finishAgentCheck() {}, dispatchNextQueued() {},
  };
  vm.createContext(scope);
  const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  vm.runInContext([
    section("  function resumableSessionId(chat)", "  function savePrefs(done)"),
    section("  function maybeReplay(chat)", "  function historyNav(chat)"),
    section("  function onHostMessage(msg)", '    if (msg.type === "turnStarted")') + "\n}",
  ].join("\n"), scope);
  scope.onHostMessage({ type: "backgroundRestoreStart", sessions: [{ id: "a", agent: "codex",
    spec: { cwd: "/project", resume }, sessionId: resume || savedId || "unused-thread",
    started: true, running: false, submitted, turnIds: [] }] });
  scope.onHostMessage({ type: "backgroundRestoreEnd" });
  const chat = scope.chats.get("a");
  return { requests, empty: chat.empty, persistedId: scope.resumableSessionId(chat) };
}

test("an older worker's idle snapshot cannot erase the saved thread or skip its history", () => {
  const r = restore({ savedId: "saved-thread", resume: "saved-thread" });
  assert.equal(r.empty, false, "saved history must not become a new chat while loading");
  assert.equal(r.persistedId, "saved-thread");
  assert.deepEqual(r.requests, ["saved-thread"]);
});

test("a resumed worker session restores history even when the panel has no saved tab", () => {
  const r = restore({ resume: "saved-thread" });
  assert.equal(r.empty, false, "saved history must not become a new chat while loading");
  assert.equal(r.persistedId, "saved-thread");
  assert.deepEqual(r.requests, ["saved-thread"]);
});

test("a saved thread survives a snapshot without the original start options", () => {
  const r = restore({ savedId: "saved-thread" });
  assert.equal(r.empty, false, "saved history must not become a new chat while loading");
  assert.equal(r.persistedId, "saved-thread");
  assert.deepEqual(r.requests, ["saved-thread"]);
});

test("an unused prewarmed thread stays unsaved and does not load history", () => {
  const r = restore();
  assert.equal(r.persistedId, null);
  assert.equal(r.empty, true, "an unused session must keep the empty-chat logo and setup visible");
  assert.deepEqual(r.requests, []);
});
