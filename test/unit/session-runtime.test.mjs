import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const flush = () => new Promise(setImmediate);
function runtime() {
  const native = [], counts = [], timers = new Set(), browserCalls = [], detached = [];
  const storage = { rkChatV2: { tabs: [], activeId: "a", draft: "keep" } };
  function port(name) {
    const messages = [], disconnects = [];
    return { name, sent: [], closed: false,
      postMessage(msg) { this.sent.push(structuredClone(msg)); },
      onMessage: { addListener(fn) { messages.push(fn); } },
      onDisconnect: { addListener(fn) { disconnects.push(fn); } },
      emit(msg) { messages.forEach((fn) => fn(structuredClone(msg))); },
      disconnect() { this.closed = true; disconnects.forEach((fn) => fn()); },
    };
  }
  const chrome = {
    runtime: { id: "test", getURL: (p) => "chrome-extension://test/" + p, connectNative() { const p = port("native"); native.push(p); return p; } },
    storage: { local: {
      get(keys, cb) { cb(structuredClone(storage)); },
      set(value, cb) { Object.assign(storage, structuredClone(value)); cb?.(); },
    } },
  };
  const scope = { chrome, console,
    setTimeout(fn, ms) { const t = { fn, ms }; timers.add(t); return t; }, clearTimeout(t) { timers.delete(t); },
  };
  vm.runInNewContext(readFileSync(new URL("../../src/session-runtime.js", import.meta.url), "utf8"), scope);
  const sessions = scope.createStudioSessions({ chrome, activity: (n) => counts.push(n),
    createBrowser: ({ windowId }) => ({ detachAllCdp: () => detached.push(windowId), async handleBrowserOp(msg, reply) {
      browserCalls.push({ windowId, msg }); reply({ type: "browserResult", bid: msg.bid, ok: true });
    } }),
  });
  function panel(windowId = 1) {
    const p = port("studio-session"); p.sender = { id: "test", url: "chrome-extension://test/src/panel/panel.html" }; sessions.connect(p); p.emit({ type: "attach", windowId }); return p;
  }
  function start(p, id = "a") {
    p.emit({ type: "start", agent: "codex", id, cwd: "/project" });
    p.emit({ type: "prompt", agent: "codex", id, text: "Work " + id });
  }
  async function settle() { await flush(); for (const t of [...timers]) { timers.delete(t); await t.fn(); } await flush(); }
  return { panel, start, native, counts, storage, settle, browserCalls, detached, port, sessions };
}
const result = (id) => ({ type: "event", id, data: { type: "result", result: "Done" } });

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

test("separate windows cannot overwrite each other's host, count or replay", async () => {
  const r = runtime(), a = r.panel(1), b = r.panel(2); r.start(a, "a"); r.start(b, "b");
  assert.equal(r.counts.at(-1), 2); a.disconnect();
  r.native[0].emit(result("a")); await r.settle();
  assert.equal(r.native[0].closed, true); assert.equal(r.native[1].closed, false);
  assert.equal(r.counts.at(-1), 1);
  assert.ok(!b.sent.some((m) => m.id === "a"));
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
