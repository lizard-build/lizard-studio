import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/panel/chat.js", import.meta.url), "utf8");

function restore({ savedId = null, resume = null, submitted = false, running = false, turnStartedAt, waiting = false, replayDeferred = false } = {}) {
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
    refreshStatusWord() {}, setRunningUI() {}, startStatusTicker() {}, renderTurnStatus() {},
  };
  vm.createContext(scope);
  const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  vm.runInContext([
    section("  function resumableSessionId(chat)", "  function savePrefs(done)"),
    section("  function maybeReplay(chat)", "  function historyNav(chat)"),
    section("  function resumeTurnIfIdle(", "  // The interrupt→respawn"),
    section("  function onHostMessage(msg)", '    if (msg.type === "turnStarted")') + "\n}",
  ].join("\n"), scope);
  scope.onHostMessage({ type: "backgroundRestoreStart", sessions: [{ id: "a", agent: "codex",
    spec: { cwd: "/project", resume }, sessionId: resume || savedId || "unused-thread",
    started: true, running, turnStartedAt, submitted, waiting, replayDeferred, turnIds: [] }] });
  scope.onHostMessage({ type: "backgroundRestoreEnd" });
  const chat = scope.chats.get("a");
  return { chat, requests, empty: chat.empty, persistedId: scope.resumableSessionId(chat) };
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

test("restoring a running chat keeps its original elapsed time", () => {
  const start = Date.now() - 11000;
  const { chat } = restore({ savedId: "saved-thread", submitted: true, running: true, turnStartedAt: start });
  assert.equal(chat.turnRunning, true);
  assert.equal(chat.turnStartedAt, start);
});

test("an older worker without a timestamp still gets a valid timer", () => {
  const before = Date.now();
  const { chat } = restore({ savedId: "saved-thread", submitted: true, running: true });
  assert.ok(chat.turnStartedAt >= before && chat.turnStartedAt <= Date.now());
});

test("a restored chat uses replayed permission cards instead of retaining a stale waiting flag", () => {
  const { chat } = restore({ savedId: "saved-thread", waiting: true });
  assert.equal(chat.backgroundWaiting, false);
});

test("history loads only for the selected chat and requests deferred live replay once", () => {
  const requests = [], scope = { backgroundRestoring: false, connected: true, hostReady: true, activeId: "a",
    resumableSessionId: chat => chat.sessionId,
    requestHistoryPage: chat => requests.push(chat.id), post: msg => { requests.push(msg); return true; } };
  vm.createContext(scope);
  vm.runInContext(source.slice(source.indexOf("  function maybeReplay(chat)"), source.indexOf("  function historyNav(chat)")), scope);
  const a = { id: "a", harness: "codex", sessionId: "thread-a" };
  const b = { id: "b", harness: "codex", sessionId: "thread-b", backgroundDeferred: true };
  scope.maybeReplay(b); assert.equal(requests.length, 0); assert.equal(b.replayed, undefined);
  scope.maybeReplay(a); assert.deepEqual(requests, ["a"]);
  scope.activeId = "b"; scope.maybeReplay(b); scope.maybeReplay(b);
  assert.equal(requests.length, 2); assert.equal(requests[1].type, "backgroundReplaySession");
  b.backgroundDeferred = false; scope.maybeReplay(b);
  assert.equal(requests.at(-1), "b");
});
