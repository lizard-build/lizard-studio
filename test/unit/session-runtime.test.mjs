import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const flush = () => new Promise(setImmediate);
function runtime({ autoRestore = true } = {}) {
  let now = 100000;
  const intervals = new Set();
  let keepAliveCalls = 0;
  const native = [], counts = [], results = [], timers = new Set(), browserCalls = [], detached = [];
  const storage = { rkChatV2: { tabs: [], activeId: "a", draft: "keep" } };
  function port(name) {
    const messages = [], disconnects = [];
    return { name, sent: [], closed: false,
      postMessage(msg) { this.sent.push(structuredClone(msg));
        if (autoRestore && name === "native" && msg.type === "runtimeAttach") {
          this.emit({ type: "daemonSnapshot", sessions: [] });
          this.emit({ type: "daemonRestoreDone" });
        }
      },
      onMessage: { addListener(fn) { messages.push(fn); } },
      onDisconnect: { addListener(fn) { disconnects.push(fn); } },
      emit(msg) { messages.forEach((fn) => fn(structuredClone(msg))); },
      disconnect() { this.closed = true; disconnects.forEach((fn) => fn()); },
    };
  }
  const chrome = {
    runtime: { getPlatformInfo(cb) { keepAliveCalls++; cb({ os: "mac" }); }, id: "test", getURL: (p) => "chrome-extension://test/" + p, connectNative() { const p = port("native"); native.push(p); return p; } },
    storage: { local: {
      get(keys, cb) { cb(structuredClone(storage)); },
      set(value, cb) { Object.assign(storage, structuredClone(value)); cb?.(); },
    } },
  };
  const scope = { chrome, console, Date: { now: () => now },
    setInterval(fn, ms) { const timer = { fn, ms }; intervals.add(timer); return timer; }, clearInterval(t) { intervals.delete(t); },
    setTimeout(fn, ms) { const t = { fn, ms }; timers.add(t); return t; }, clearTimeout(t) { timers.delete(t); },
  };
  vm.runInNewContext(readFileSync(new URL("../../src/session-runtime.js", import.meta.url), "utf8"), scope);
  const sessions = scope.createStudioSessions({ chrome, activity: (n) => counts.push(n), resultStatus: (id, unread) => results.push({ id, unread }),
    createBrowser: ({ windowId }) => ({ detachAllCdp: () => detached.push(windowId), async handleBrowserOp(msg, reply) {
      browserCalls.push({ windowId, msg }); reply({ type: "browserResult", bid: msg.bid, ok: true });
    } }),
  });
  function panel(windowId = 1, options = {}) {
    const p = port("studio-session"); p.sender = { id: "test", url: "chrome-extension://test/src/panel/panel.html" }; sessions.connect(p); p.emit({ type: "attach", windowId, ...options }); return p;
  }
  function start(p, id = "a") {
    p.emit({ type: "start", agent: "codex", id, cwd: "/project" });
    p.emit({ type: "prompt", agent: "codex", id, text: "Work " + id });
  }
  async function settle() { await flush(); for (const t of [...timers]) { timers.delete(t); await t.fn(); } await flush(); }
  return { chrome, intervals, keepAliveCalls: () => keepAliveCalls, panel, start, native, counts, results, storage, settle, browserCalls, detached, port, sessions, advance: ms => { now += ms; } };
}
const result = (id) => ({ type: "event", id, data: { type: "result", result: "Done" } });

test("a new worker restores an active daemon turn before accepting panel commands", () => {
  const r = runtime({ autoRestore: false }), p = r.panel();
  p.emit({ type: "start", id: "a", agent: "codex", cwd: "/project" });
  assert.deepEqual(r.native[0].sent.map((m) => m.type), ["runtimeAttach"]);
  r.native[0].emit({ type: "daemonSnapshot", sessions: [{ id: "a", agent: "codex",
    spec: { cwd: "/project" }, started: true, running: true, submitted: true,
    sessionId: "thread-a", turnIds: ["turn-a"] }] });
  r.native[0].emit({ type: "event", id: "a", turnId: "turn-a",
    data: { type: "stream_event", event: { delta: { text: "Still working" } } } });
  assert.equal(p.sent.length, 0, "replay stays behind the ordered restore snapshot");
  r.native[0].emit({ type: "daemonRestoreDone" });
  assert.equal(p.sent[0].sessions[0].running, true);
  assert.equal(p.sent[0].sessions[0].fromDaemon, true);
  assert.equal(p.sent[0].sessions[0].sessionId, "thread-a");
  assert.ok(p.sent.some((m) => m.type === "backgroundReplay" && m.message.data?.event?.delta?.text === "Still working"));
  assert.equal(r.native[0].sent.some((m) => m.type === "start"), false, "the existing turn is not started twice");
  r.native[0].emit(result("a"));
  assert.ok(p.sent.some((m) => m.type === "event" && m.data?.result === "Done"));
});

test("results are recorded with no panel and replaying a session does not mark it read", async () => {
  const r = runtime(), p = r.panel(); r.start(p, "a");
  p.disconnect(); r.native[0].emit(result("a")); await r.settle();
  assert.deepEqual(r.results.at(-1), { id: "a", unread: true });
  const reopened = r.panel();
  reopened.emit({ type: "start", agent: "codex", id: "a", resume: "thread-a" });
  assert.deepEqual(r.results.at(-1), { id: "a", unread: true });
  reopened.emit({ type: "prompt", agent: "codex", id: "a", text: "Continue" });
  assert.deepEqual(r.results.at(-1), { id: "a", unread: false });
});

test("a resumed chat keeps its saved history across panel reloads without a new prompt", async () => {
  const r = runtime(), p = r.panel();
  p.emit({ type: "start", agent: "codex", id: "a", cwd: "/project", resume: "saved-thread" });
  p.disconnect();
  const reopened = r.panel();
  const state = reopened.sent[0].sessions[0];
  assert.equal(state.sessionId, "saved-thread");
  assert.equal(state.submitted, true);
  assert.equal(state.running, false);
  reopened.disconnect(); await r.settle();
  assert.equal(r.storage.rkChatV2.tabs[0].sessionId, "saved-thread");
});

test("starting a fresh chat clears the previous session's submitted flag", () => {
  const r = runtime(), p = r.panel(); r.start(p);
  p.emit({ type: "start", agent: "codex", id: "a", cwd: "/other-project" });
  r.native[0].emit({ type: "event", id: "a", data: { type: "system", subtype: "init", session_id: "empty-thread" } });
  p.disconnect();
  const state = r.panel().sent[0].sessions[0];
  assert.equal(state.sessionId, "empty-thread");
  assert.equal(state.submitted, false);
});

test("closing the last panel preserves every active session and releases only after the last result", async () => {
  const r = runtime(), p = r.panel(); r.start(p, "a"); r.start(p, "b");
  assert.equal(r.counts.at(-1), 2); p.disconnect(); await r.settle();
  assert.equal(r.native[0].closed, false); assert.equal(r.counts.at(-1), 2);
  r.native[0].emit(result("a")); await r.settle();
  assert.equal(r.counts.at(-1), 1); assert.equal(r.native[0].closed, false);
  r.native[0].emit(result("b")); await r.settle();
  assert.equal(r.counts.at(-1), 0); assert.equal(r.native[0].closed, true);
  assert.deepEqual(r.detached, [1]);
});

test("a helper update waits until running chats finish", () => {
  const r = runtime(), p = r.panel(); r.start(p, "a");
  p.emit({ type: "selfUpdate" });
  assert.equal(r.native[0].sent.some((m) => m.type === "selfUpdate"), false);
  assert.ok(p.sent.some((m) => m.type === "selfUpdate" && m.deferred));
  r.native[0].emit(result("a"));
  assert.equal(r.native[0].sent.filter((m) => m.type === "selfUpdate").length, 1);
});

test("reopening attaches to the same host and replays without sending prompts or tool actions", async () => {
  const r = runtime(), p = r.panel(); r.start(p);
  const host = r.native[0];
  host.emit({ type: "started", id: "a", cwd: "/project" });
  host.emit({ type: "event", id: "a", data: { type: "system", subtype: "init", session_id: "thread-a" } });
  host.emit({ type: "turnStarted", id: "a", turnId: "turn-a" });
  host.emit({ type: "event", id: "a", turnId: "turn-a", data: { type: "assistant", message: { content: [{ type: "text", text: "Partial" }] } } });
  p.disconnect(); const sentBefore = host.sent.length;
  const reopened = r.panel();
  assert.equal(r.native.length, 1); assert.equal(host.sent.length, sentBefore);
  assert.equal(reopened.sent[0].sessions[0].sessionId, "thread-a");
  assert.deepEqual(reopened.sent[0].sessions[0].turnIds, ["turn-a"]);
  assert.ok(reopened.sent.some((m) => m.message?.data?.message?.content?.[0]?.text === "Partial"));
  host.emit(result("a")); await r.settle();
  assert.equal(host.closed, false, "an open panel retains its idle host");
});

test("browser tools keep running with no panel and use their original window", async () => {
  const r = runtime(), p = r.panel(7); r.start(p); p.disconnect();
  r.native[0].emit({ type: "browser", bid: 42, session: "a", op: "snapshot" });
  await flush();
  assert.equal(r.browserCalls[0].windowId, 7);
  assert.deepEqual(r.native[0].sent.at(-1), { type: "browserResult", bid: 42, ok: true });
});

test("permissions stay pending, exclude the waiting session from the badge, and survive reopening", async () => {
  const r = runtime(), p = r.panel(); r.start(p);
  r.native[0].emit({ type: "permission", id: "a", requestId: "ask" });
  assert.equal(r.counts.at(-1), 0); p.disconnect(); await r.settle();
  assert.equal(r.native[0].closed, false);
  const reopened = r.panel();
  assert.ok(reopened.sent.some((m) => m.message?.requestId === "ask"));
  reopened.emit({ type: "permissionResult", id: "a", requestId: "ask", behavior: "allow" });
  assert.equal(r.counts.at(-1), 1);
});

test("a first reply after closing saves its thread id without replacing drafts", async () => {
  const r = runtime(), p = r.panel(); r.start(p); p.disconnect();
  r.native[0].emit({ type: "event", id: "a", data: { type: "system", subtype: "init", session_id: "thread-a" } });
  r.native[0].emit(result("a")); await r.settle();
  assert.equal(r.storage.rkChatV2.tabs[0].sessionId, "thread-a");
  assert.equal(r.storage.rkChatV2.draft, "keep");
});

test("separate windows share chat events while retaining each task's host and count", async () => {
  const r = runtime(), a = r.panel(1), b = r.panel(2); r.start(a, "a"); r.start(b, "b");
  assert.equal(r.counts.at(-1), 2); a.disconnect();
  r.native[0].emit(result("a")); await r.settle();
  assert.equal(r.native[0].closed, false); assert.equal(r.native[1].closed, false);
  assert.equal(r.counts.at(-1), 1);
  assert.ok(b.sent.some((m) => m.id === "a" || m.message?.id === "a"));
});

test("host failure clears the badge and disconnects the panel without restarting work", () => {
  const r = runtime(), p = r.panel(); r.start(p); r.native[0].disconnect();
  assert.equal(r.counts.at(-1), 0); assert.equal(p.closed, true); assert.equal(r.native.length, 1);
});

test("a new turn replaces its replay and uses only that turn's history exclusion", () => {
  const r = runtime(), p = r.panel(); r.start(p);
  const host = r.native[0];
  host.emit({ type: "turnStarted", id: "a", turnId: "one" }); host.emit(result("a"));
  p.emit({ type: "prompt", id: "a", text: "Second" });
  host.emit({ type: "turnStarted", id: "a", turnId: "two" });
  p.disconnect(); const reopened = r.panel();
  assert.deepEqual(reopened.sent[0].sessions[0].turnIds, ["two"]);
  assert.deepEqual(reopened.sent.filter((m) => m.message?.type === "backgroundPrompt").map((m) => m.message.text), ["Second"]);
});

test("queued prompts drain in order after closing and are not sent again on reopen", async () => {
  const r = runtime(), p = r.panel(); r.start(p);
  p.emit({ type: "backgroundQueue", id: "a", agent: "codex", entries: ["second", "third"].map((text) => ({ ui: { text }, message: { type: "prompt", agent: "codex", id: "a", text } })) });
  p.disconnect(); r.native[0].emit(result("a"));
  assert.equal(r.native[0].sent.at(-1).text, "second");
  r.native[0].emit(result("a")); assert.equal(r.native[0].sent.at(-1).text, "third");
  const before = r.native[0].sent.length, reopened = r.panel();
  assert.deepEqual(reopened.sent[0].sessions[0].queue, []);
  assert.equal(r.native[0].sent.length, before);
});

test("a pending steer cannot be sent again from the background queue", async () => {
  const r = runtime(), p = r.panel(); r.start(p);
  p.emit({ type: "backgroundQueue", id: "a", agent: "codex", entries: [{ held: true, ui: { text: "correction", backgroundId: "q1" }, message: { type: "prompt", id: "a", text: "correction" } }] });
  assert.equal(r.counts.at(-1), 1, "editing a queued prompt does not hide active work");
  p.emit({ type: "prompt", id: "a", text: "correction", promptRequestId: "steer1", backgroundQueueId: "q1" });
  p.disconnect(); r.native[0].emit({ type: "promptResult", id: "a", requestId: "steer1", ok: true });
  r.native[0].emit(result("a")); await r.settle();
  assert.equal(r.native[0].sent.filter((m) => m.text === "correction").length, 1);
  assert.equal(r.native[0].closed, true);
});

test("a rejected answer cannot leave an idle session counted as running", async () => {
  const r = runtime(), p = r.panel(); r.start(p); r.native[0].emit(result("a"));
  p.emit({ type: "prompt", id: "a", text: "Answer", promptRequestId: "answer1" });
  r.native[0].emit({ type: "promptResult", id: "a", requestId: "answer1", ok: false, error: "Rejected" });
  assert.equal(r.counts.at(-1), 0);
});

test("reattaching during thread startup does not create a second session", () => {
  const r = runtime(), p = r.panel(); r.start(p); p.disconnect();
  const reopened = r.panel();
  assert.equal(reopened.sent[0].sessions[0].started, true);
  assert.equal(r.native[0].sent.filter((m) => m.type === "start").length, 1);
});

test("history waits for the first turn id when reopening immediately after Send", () => {
  const r = runtime(), p = r.panel(); r.start(p);
  p.emit({ type: "loadTranscript", id: "a", backgroundRestore: true, excludeTurnIds: [] });
  assert.equal(r.native[0].sent.filter((m) => m.type === "loadTranscript").length, 0);
  r.native[0].emit({ type: "turnStarted", id: "a", turnId: "first" });
  assert.deepEqual(r.native[0].sent.at(-1).excludeTurnIds, ["first"]);
});


test("web page content scripts cannot connect to native sessions or read chat replays", () => {
  const r = runtime(), p = r.port("studio-session");
  p.sender = { id: "test", url: "https://untrusted.invalid", tab: { id: 1 } };
  r.sessions.connect(p); p.emit({ type: "attach", windowId: 1 });
  assert.equal(p.closed, true); assert.equal(r.native.length, 0); assert.equal(p.sent.length, 0);
});

test("a detached extension view shares the original host, replay and pending permissions", async () => {
  const r = runtime(), side = r.panel(7); r.start(side);
  const host = r.native[0];
  host.emit({ type: "permission", id: "a", requestId: "approval", input: {} });
  const detached = r.port("studio-session");
  detached.sender = { id: "test", url: "chrome-extension://test/src/panel/panel.html?mode=window&sourceWindowId=7", tab: { id: 80, windowId: 90 } };
  r.sessions.connect(detached); detached.emit({ type: "attach", windowId: 7 });
  side.disconnect(); await r.settle();
  assert.equal(r.native.length, 1); assert.equal(host.closed, false);
  assert.ok(detached.sent.some(m => m.type === "backgroundReplay" && m.message.requestId === "approval"));
  assert.equal(host.sent.filter(m => m.type === "prompt").length, 1);
  host.emit({ type: "browser", bid: 1, op: "dom", session: "a" }); await flush();
  assert.equal(r.browserCalls.at(-1).windowId, 7);
});

test("Claude permission requests survive moving to another view", () => {
  const r = runtime(), side = r.panel(7);
  side.emit({ type: "start", agent: "claude", id: "a" });
  side.emit({ type: "prompt", agent: "claude", id: "a", text: "work" });
  r.native[0].emit({ type: "permission", id: "a", requestId: "claude-approval", input: {} });
  const next = r.panel(7);
  assert.ok(next.sent.some(m => m.type === "backgroundReplay" && m.message.requestId === "claude-approval"));
});

test('the same chat in two windows has one session and shares prompts and streaming events', () => {
  const r = runtime(), a = r.panel(1), b = r.panel(2);
  r.start(a);
  b.emit({ type: 'start', id: 'a', agent: 'codex', cwd: '/project' });
  assert.equal(r.native.flatMap(p => p.sent).filter(m => m.type === 'start').length, 1);
  assert.ok(b.sent.some(m => m.type === 'sharedPrompt' && m.message.text === 'Work a'));
  const delta = { type: 'event', id: 'a', data: { type: 'stream_event', event: { delta: { text: 'Hello' } } } };
  r.native[0].emit(delta);
  assert.deepEqual(b.sent.at(-1), { type: 'sharedEvent', message: delta });
  assert.deepEqual(a.sent.at(-1), delta);
  b.emit({ type: 'prompt', id: 'a', text: 'Continue' });
  assert.equal(r.native[0].sent.at(-1).text, 'Continue');
  assert.equal(r.native[1].sent.filter(m => m.type === 'prompt').length, 0);
  assert.ok(a.sent.some(m => m.type === 'sessionRole' && m.observer));
});

test('opening another window during a response restores that response and its session', () => {
  const r = runtime(), a = r.panel(1); r.start(a);
  r.native[0].emit({ type: 'turnStarted', id: 'a', turnId: 'turn' });
  r.native[0].emit({ type: 'event', id: 'a', data: { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial answer' }] } } });
  const b = r.panel(2);
  assert.equal(b.sent[0].sessions[0].observer, true);
  assert.equal(b.sent[0].sessions[0].running, true);
  assert.ok(b.sent.some(m => m.message?.data?.message?.content?.[0]?.text === 'Partial answer'));
});

test('a mirror cannot overwrite the queue and a permission is resolved only once', () => {
  const r = runtime(), a = r.panel(1), b = r.panel(2); r.start(a);
  a.emit({ type: 'backgroundQueue', id: 'a', entries: [{ ui: { text: 'next' }, message: { type: 'prompt', id: 'a', text: 'next' } }] });
  assert.equal(b.sent.at(-1).type, 'sharedQueue');
  b.emit({ type: 'backgroundQueue', id: 'a', entries: [] });
  r.native[0].emit({ type: 'permission', id: 'a', requestId: 'approve' });
  b.emit({ type: 'permissionResult', id: 'a', requestId: 'approve', behavior: 'allow' });
  a.emit({ type: 'permissionResult', id: 'a', requestId: 'approve', behavior: 'allow' });
  assert.equal(r.native[0].sent.filter(m => m.type === 'permissionResult').length, 1);
  a.disconnect();
  assert.ok(b.sent.some(m => m.type === 'sessionRole' && !m.observer));
  const c = r.panel(3);
  assert.equal(c.sent[0].sessions[0].queue[0].text, 'next');
});

test('Claude live prompts and responses reach other windows without repeating commands', () => {
  const r = runtime(), a = r.panel(1), b = r.panel(2);
  a.emit({ type: 'start', id: 'a', agent: 'claude', cwd: '/project' });
  a.emit({ type: 'prompt', id: 'a', agent: 'claude', text: 'Hello' });
  r.native[0].emit(result('a'));
  assert.ok(b.sent.some(m => m.type === 'sharedPrompt' && m.message.text === 'Hello'));
  assert.ok(b.sent.some(m => m.type === 'sharedEvent' && m.message.data?.result === 'Done'));
  assert.equal(r.native[0].sent.filter(m => m.type === 'prompt').length, 1);
});

test('a rejected steer never appears as an accepted prompt in another window', () => {
  const r = runtime(), a = r.panel(1), b = r.panel(2); r.start(a);
  a.emit({ type: 'prompt', id: 'a', text: 'Correction', promptRequestId: 'steer' });
  assert.ok(!b.sent.some(m => m.type === 'sharedPrompt' && m.message.text === 'Correction'));
  r.native[0].emit({ type: 'promptResult', id: 'a', requestId: 'steer', ok: false });
  assert.ok(!b.sent.some(m => m.type === 'sharedPrompt' && m.message.text === 'Correction'));
});

test('accepted question replies keep their question id in other windows and after reconnect', () => {
  const r = runtime(), a = r.panel(1), b = r.panel(2); r.start(a);
  a.emit({ type: 'prompt', id: 'a', text: 'Question?\nAnswer', promptRequestId: 'answer', questionReplyId: 'question-id' });
  assert.ok(!b.sent.some(m => m.type === 'sharedPrompt' && m.message.questionReplyId));
  r.native[0].emit({ type: 'promptResult', id: 'a', requestId: 'answer', ok: true });
  assert.equal(b.sent.find(m => m.type === 'sharedPrompt' && m.message.questionReplyId)?.message.questionReplyId, 'question-id');
  const c = r.panel(3);
  assert.ok(c.sent.some(m => m.type === 'backgroundReplay' && m.message.questionReplyId === 'question-id'));
});

for (const agent of ["claude", "codex"]) test(`${agent} keeps elapsed time across reloads and steering, then starts a new timer`, () => {
  const r = runtime(), p = r.panel();
  p.emit({ type: "start", id: "a", agent });
  p.emit({ type: "prompt", id: "a", agent, text: "Work" });
  r.advance(11000);
  r.native[0].emit({ type: "turnStarted", id: "a", turnId: "one" });
  p.disconnect();
  const reopened = r.panel();
  assert.equal(reopened.sent[0].sessions[0].turnStartedAt, 100000);
  reopened.emit({ type: "prompt", id: "a", text: "Also do this", promptRequestId: "steer" });
  r.native[0].emit({ type: "promptResult", id: "a", requestId: "steer", ok: true, startedTurn: false });
  reopened.disconnect();
  const again = r.panel();
  assert.equal(again.sent[0].sessions[0].turnStartedAt, 100000);
  r.native[0].emit(result("a"));
  r.advance(9000);
  again.emit({ type: "prompt", id: "a", text: "Next" });
  again.disconnect();
  assert.equal(r.panel().sent[0].sessions[0].turnStartedAt, 120000);
});

test("an acknowledged prompt keeps its submission time when turnStarted arrives first", () => {
  const r = runtime(), p = r.panel();
  p.emit({ type: "start", id: "a", agent: "codex" });
  p.emit({ type: "prompt", id: "a", text: "Work", promptRequestId: "request" });
  r.advance(5000);
  r.native[0].emit({ type: "turnStarted", id: "a", turnId: "one" });
  r.advance(5000);
  r.native[0].emit({ type: "promptResult", id: "a", requestId: "request", ok: true, startedTurn: true });
  p.disconnect();
  assert.equal(r.panel().sent[0].sessions[0].turnStartedAt, 100000);
});

test("a silent turn keeps the worker awake without any open panel, then releases its timer", async () => {
  const r = runtime(), p = r.panel(); r.start(p);
  assert.equal(r.intervals.size, 1);
  assert.equal(r.keepAliveCalls(), 1);
  p.disconnect();
  for (let i = 0; i < 30; i++) {
    r.advance(20000);
    for (const timer of r.intervals) { assert.equal(timer.ms, 20000); timer.fn(); }
  }
  assert.equal(r.keepAliveCalls(), 31);
  assert.equal(r.native[0].closed, false);
  assert.equal(r.native[0].sent.filter(m => m.type === "prompt").length, 1);
  r.native[0].emit(result("a"));
  assert.equal(r.intervals.size, 0);
  await r.settle();
  assert.equal(r.native[0].closed, true);
  assert.ok(r.storage.studioSessionDiagnostics.some(e => e.event === "idle-release"));
});

test("waiting for approval stays alive even with a zero yellow badge", () => {
  const r = runtime(), p = r.panel(); r.start(p);
  r.native[0].emit({ type: "permission", id: "a", requestId: "approval" });
  p.disconnect();
  assert.equal(r.counts.at(-1), 0);
  assert.equal(r.intervals.size, 1);
  for (const timer of r.intervals) timer.fn();
  assert.equal(r.keepAliveCalls(), 2);
  r.native[0].disconnect();
  assert.equal(r.intervals.size, 0);
});

test("a disconnected host keeps Chrome's reason and transport metadata, not chat content", async () => {
  const r = runtime(), p = r.panel(); r.start(p);
  r.chrome.runtime.lastError = { message: "Native host has exited." };
  r.native[0].disconnect();
  delete r.chrome.runtime.lastError;
  await r.settle();
  const entry = r.storage.studioSessionDiagnostics.find(e => e.event === "native-disconnected");
  assert.equal(entry.error, "Native host has exited.");
  assert.equal(entry.busy, 1);
  assert.equal(entry.panels, 1);
  assert.ok(entry.workerId);
  assert.ok(!JSON.stringify(r.storage.studioSessionDiagnostics).includes("Work a"));
  assert.equal(r.intervals.size, 0);
});

test("opening many large chats replays only the selected chat until another is opened", () => {
  const r = runtime(), original = r.panel();
  for (let i = 0; i < 80; i++) {
    r.start(original, "chat-" + i);
    r.native[0].emit({ type: "event", id: "chat-" + i, data: { type: "assistant", text: "x".repeat(50000) } });
  }
  original.disconnect();
  const nativeBefore = r.native[0].sent.length;
  const lazy = r.panel(1, { lazyReplay: true, activeId: "chat-0" });
  const snapshot = lazy.sent.find(m => m.type === "backgroundRestoreStart");
  assert.equal(snapshot.sessions.length, 80);
  assert.equal(snapshot.sessions.filter(s => s.replayDeferred).length, 79);
  assert.ok(lazy.sent.filter(m => m.type === "backgroundReplay").every(m => m.message.id === "chat-0"));
  assert.ok(JSON.stringify(lazy.sent).length < 100000, "hidden transcripts must not cross the panel port");
  assert.equal(r.native[0].sent.length, nativeBefore);
  r.native[0].emit({ type: "permission", id: "chat-1", requestId: "ask" });
  assert.equal(lazy.sent.at(-1).type, "backgroundSessionState");
  assert.equal(lazy.sent.at(-1).waiting, true);
  const before = lazy.sent.length;
  lazy.emit({ type: "backgroundReplaySession", id: "chat-1" });
  const restored = lazy.sent.slice(before);
  assert.equal(restored[0].sessions[0].replayDeferred, false);
  assert.equal(restored[0].sessions[0].observer, false);
  assert.ok(restored.some(m => m.message?.data?.text?.length === 50000));
  assert.ok(restored.some(m => m.message?.type === "permission"));
  assert.equal(restored.at(-1).type, "backgroundRestoreEnd");
  assert.equal(r.native[0].sent.length, nativeBefore, "opening a chat must not resend any prompt");
  const once = lazy.sent.length;
  lazy.emit({ type: "backgroundReplaySession", id: "chat-1" });
  assert.equal(lazy.sent.length, once);
});

test("a hidden deferred chat completes and drains its queue without rendering its transcript", () => {
  const r = runtime(), original = r.panel(); r.start(original, "a"); r.start(original, "b");
  original.emit({ type: "backgroundQueue", id: "b", entries: [{ ui: { text: "Next", backgroundId: "q" },
    message: { type: "prompt", id: "b", agent: "codex", text: "Next" } }] });
  original.disconnect();
  const lazy = r.panel(1, { lazyReplay: true, activeId: "a" });
  r.native[0].emit(result("b"));
  assert.equal(r.native[0].sent.at(-1).text, "Next");
  assert.ok(lazy.sent.some(m => m.type === "backgroundSessionState" && m.id === "b" && !m.running));
  assert.ok(!lazy.sent.some(m => m.type === "backgroundReplay" && m.message.id === "b"));
  lazy.emit({ type: "backgroundReplaySession", id: "b" });
  const snapshot = lazy.sent.filter(m => m.type === "backgroundRestoreStart").at(-1).sessions[0];
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.queue.length, 0);
});
