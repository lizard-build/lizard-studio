import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The real worker with fake Chrome ports. The native host stays connected.
function worker() {
  function port(name) {
    const messages = [], disconnects = [];
    return { name, sent: [],
      postMessage(msg) {
        this.sent.push(structuredClone(msg));
        if (name === "native" && msg.type === "runtimeAttach") {
          this.emit({ type: "daemonSnapshot", sessions: [] });
          this.emit({ type: "daemonRestoreDone" });
        }
      },
      onMessage: { addListener(fn) { messages.push(fn); } },
      onDisconnect: { addListener(fn) { disconnects.push(fn); } },
      emit(msg) { messages.forEach((fn) => fn(structuredClone(msg))); },
      disconnect() { disconnects.forEach((fn) => fn()); },
    };
  }
  const native = [];
  const chrome = {
    runtime: { getPlatformInfo(cb) { cb({ os: "mac" }); }, id: "test", getURL: (p) => "chrome-extension://test/" + p,
      connectNative() { const p = port("native"); native.push(p); return p; } },
    storage: { local: { get(keys, cb) { cb({}); }, set(value, cb) { cb?.(); } } },
  };
  const scope = { chrome, console, Date, setInterval: () => ({}), clearInterval() {}, setTimeout: () => ({}), clearTimeout() {} };
  vm.runInNewContext(readFileSync(new URL("../../src/session-runtime.js", import.meta.url), "utf8"), scope);
  const sessions = scope.createStudioSessions({ chrome, activity() {},
    createBrowser: () => ({ detachAllCdp() {}, async handleBrowserOp() {} }) });
  function panel(options = {}) {
    const p = port("studio-session");
    p.sender = { id: "test", url: "chrome-extension://test/src/panel/panel.html" };
    sessions.connect(p);
    p.emit({ type: "attach", windowId: 1, ...options });
    return p;
  }
  function run(p, id) {
    p.emit({ type: "start", agent: "codex", id, cwd: "/project" });
    p.emit({ type: "prompt", agent: "codex", id, text: "Work " + id });
    native[0].emit({ type: "turnStarted", id, turnId: "turn-" + id });
  }
  return { panel, run, native };
}

// The panel's restore handling from chat.js. Replayed transcript events only
// paint rows, so they are left out here.
function panelView(activeId) {
  const source = readFileSync(new URL("../../src/panel/chat.js", import.meta.url), "utf8");
  const notes = [], failedQuestions = [];
  const element = () => ({ replaceWith() {}, classList: { toggle() {} } });
  const scope = {
    chats: new Map(), order: [], activeId, connected: true, hostReady: true,
    backgroundRestoring: false, backgroundRestoreStates: [], backgroundRestorePartial: false,
    els: { stack: { appendChild() {} } }, clearTimeout,
    makeChat: (opts) => ({ ...opts, messagesEl: element(), permCards: new Map(), queue: [], bashRuns: new Map() }),
    systemNote: (chat, text) => notes.push([chat.id, text]),
    endTurn: (chat) => { chat.turnRunning = false; },
    resumeTurnIfIdle: (chat) => { chat.turnRunning = true; },
    failAsyncQuestionSends: (chat) => failedQuestions.push(chat.id),
    resumableSessionId: () => null, finishBashRun() {}, maybeReplay() {}, renderQueuedBubble() {},
    renderTabs() {}, updateTabDots() {}, syncComposer() {}, savePrefs() {},
    prewarmHarnesses() {}, finishAgentCheck() {}, dispatchNextQueued() {},
  };
  vm.createContext(scope);
  const from = "  function onHostMessage(msg)", to = '    if (msg.type === "turnStarted")';
  vm.runInContext(source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from))) + "\n}", scope);
  const receive = (messages) => { for (const msg of messages) if (msg.type !== "backgroundReplay") scope.onHostMessage(msg); };
  return { scope, notes, failedQuestions, receive };
}

test("opening a deferred chat after reopening the panel keeps every other running turn", () => {
  const w = worker(), first = w.panel();
  w.run(first, "a");
  w.run(first, "b");
  first.disconnect();
  const reopened = w.panel({ lazyReplay: true, activeId: "a" });
  const view = panelView("a");
  view.receive(reopened.sent);
  assert.equal(view.scope.chats.get("b").backgroundDeferred, true);

  const before = reopened.sent.length;
  reopened.emit({ type: "backgroundReplaySession", id: "b" });
  const replay = reopened.sent.slice(before);
  assert.deepEqual(replay[0].sessions.map((s) => s.id), ["b"]);
  view.receive(replay);

  const a = view.scope.chats.get("a");
  assert.deepEqual(view.notes, [], "a one-chat snapshot is not proof that other chats were lost");
  assert.equal(a.started, true, "a chat that still runs must not be started again");
  assert.equal(a.turnRunning, true);
  assert.deepEqual(view.failedQuestions, []);
  assert.equal(view.scope.chats.get("b").turnRunning, true);
  assert.equal(view.scope.backgroundRestorePartial, false);
  assert.equal(w.native.length, 1);
});

test("a full snapshot without a running chat still reports the lost turn", () => {
  const w = worker();
  const view = panelView("gone");
  view.scope.chats.set("gone", { id: "gone", started: true, turnRunning: true, bashRuns: new Map() });
  view.receive(w.panel({ lazyReplay: true, activeId: "gone" }).sent);
  assert.deepEqual(view.notes, [["gone", "Host disconnected mid-turn."]]);
  assert.equal(view.scope.chats.get("gone").started, false);
});
