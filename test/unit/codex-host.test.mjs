import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Load the full shipped host. Only OS boundaries are replaced: no CLI,
// account, user files, live browser, or network is touched by these tests.
async function host() {
  const messages = [], requests = [], timers = new Set();
  const proc = new EventEmitter();
  Object.assign(proc, { platform: "darwin", execPath: "/test/node", env: {}, stdin: new EventEmitter(), stdout: new EventEmitter() });
  proc.stdout.write = (frame) => messages.push(JSON.parse(frame.subarray(4).toString()));
  const server = new EventEmitter();
  server.listen = (_port, _host, ready) => ready();
  server.address = () => ({ port: 9999 });
  const noop = () => {};
  const fs = { existsSync: () => true, readFileSync: () => "{}", writeFileSync: noop, mkdirSync: noop, copyFileSync: noop, renameSync: noop };
  const imports = {
    "./codex-spawn.mjs": { createCodexSpawner: () => ({ spawn: () => { throw new Error("spawn blocked in test"); }, close: noop }) },
    "node:crypto": crypto, "node:path": path, "node:fs": fs,
    "node:net": { default: { createServer: () => server } },
    "node:os": { homedir: () => "/test/home" },
    "./hostkit.mjs": {
      HOST_DIR: "/test/host", makeLog: () => noop, frameReader: () => noop,
      loadConfig: () => ({ codexPath: "/test/codex" }), buildChildEnv: () => ({}), whichBin: () => "", redact: noop,
    },
  };
  const context = createContext({
    process: proc, Buffer, console,
    setTimeout: (fn, ms) => { const timer = { fn, ms, unref: noop }; timers.add(timer); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
  });
  const source = readFileSync(new URL("../../src/host/codex-host.mjs", import.meta.url), "utf8");
  const module = new SourceTextModule(source + `\nexport { handle, loadSkills, loadTranscript, sendTranscriptPage, MODELS, effortForModel, app, sessions, byThread, makeSession, usageBlock, handleNotification, handleServerRequest, answerPermission, onAppMessage, startSession, restartSession, sendPrompt, interrupt, browserRequest, browserMcpConfig, resolveBrowser, runPrewarm, takePrewarmed, ensureProviderKey, refreshPlanUsage, closeSession };`, { context });
  await module.link((name) => {
    const values = imports[name];
    assert.ok(values, `unexpected import: ${name}`);
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const api = module.namespace;
  let reply = () => ({});
  api.app.ready = true;
  api.app.proc = { pid: 42, stdin: { writable: true, write: (line) => {
    const req = JSON.parse(line); requests.push(req);
    if (!req.method) return;
    Promise.resolve().then(() => reply(req)).then(
      (result) => api.onAppMessage({ id: req.id, result }),
      (error) => api.onAppMessage({ id: req.id, error: { message: error.message } }),
    );
  } } };
  function session(id = "a") {
    const s = api.makeSession(id, "/test/project");
    Object.assign(s, { threadId: "thread-" + id, turnId: "turn-" + id, running: true, opening: false, model: "test-model" });
    api.sessions.set(id, s); api.byThread.set(s.threadId, id);
    return s;
  }
  return { api, messages, requests, timers, session, respond: (fn) => { reply = fn; } };
}

test("context counts cache hits once, updates after the final item, and never uses cumulative totals", async () => {
  const h = await host(), s = h.session();
  h.api.handleNotification("item/completed", { threadId: s.threadId, item: { type: "agentMessage", id: "reply", text: "Done." } });
  h.api.handleNotification("thread/tokenUsage/updated", { threadId: s.threadId, tokenUsage: {
    last: { inputTokens: 50000, cachedInputTokens: 40000, outputTokens: 1000 },
    total: { inputTokens: 900000 }, modelContextWindow: 258400,
  } });
  const update = h.messages.findLast((m) => m.type === "contextUsage");
  assert.equal(update.id, "a");
  assert.equal(update.window, 258400);
  assert.equal(update.usage.input_tokens + update.usage.cache_read_input_tokens + update.usage.output_tokens, 51000);
  h.api.handleNotification("thread/tokenUsage/updated", { threadId: s.threadId, tokenUsage: { total: { inputTokens: 999999 } } });
  assert.equal(h.messages.findLast((m) => m.type === "contextUsage").usage, null);
});

test("limits keep both windows and other buckets when one bucket changes", async () => {
  const h = await host();
  h.respond(() => ({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 12, windowDurationMins: 300 }, secondary: { usedPercent: 42, windowDurationMins: 10080 } },
    other: { limitName: "Other", primary: { usedPercent: 8 } },
  } }));
  await h.api.refreshPlanUsage();
  let limits = h.messages.at(-1).limits;
  assert.equal(limits.length, 2); assert.equal(limits[0].primary.usedPercent, 12); assert.equal(limits[0].secondary.usedPercent, 42);
  h.api.handleNotification("account/rateLimits/updated", { rateLimits: { limitId: "other", primary: { usedPercent: 9 } } });
  limits = h.messages.at(-1).limits;
  assert.equal(limits.length, 2); assert.equal(limits[0].secondary.usedPercent, 42); assert.equal(limits[1].primary.usedPercent, 9);
  h.respond(() => ({ rateLimitsByLimitId: {} }));
  await h.api.refreshPlanUsage();
  assert.deepEqual(h.messages.at(-1).limits, []);
  h.respond(() => { throw new Error("offline"); });
  await h.api.refreshPlanUsage();
  assert.match(h.messages.at(-1).error, /refresh/);
});

test("idle cannot turn a failed result into success, and late completion cannot end the next turn", async () => {
  const h = await host(), s = h.session();
  h.api.handleNotification("thread/status/changed", { threadId: s.threadId, status: { type: "idle" } });
  assert.equal(s.running, true);
  h.api.handleNotification("turn/completed", { threadId: s.threadId, turn: { id: "older", status: "completed" } });
  assert.equal(s.running, true);
  h.api.handleNotification("turn/completed", { threadId: s.threadId, turn: { id: s.turnId, status: "failed", error: { message: "quota reached" } } });
  assert.equal(s.running, false);
  const result = h.messages.findLast((m) => m.data?.type === "result").data;
  assert.equal(result.is_error, true); assert.equal(result.result, "quota reached");
});

test("questions pause the silence timer and preserve commas in an answer", async () => {
  const h = await host(), s = h.session();
  h.api.handleServerRequest(17, "item/tool/requestUserInput", { threadId: s.threadId, questions: [{ id: "q1", header: "Choice", question: "Choose", options: [] }] });
  assert.equal(s.silenceTimer, null);
  assert.equal([...h.timers].filter((t) => t.ms === 300000).length, 0);
  h.api.answerPermission({ id: "a", requestId: 17, behavior: "allow", updatedInput: { answers: { Choose: "Yes, keep both" } } });
  assert.deepEqual(h.requests.at(-1).result, { answers: { q1: { answers: ["Yes, keep both"] } } });
  assert.ok(s.silenceTimer);
  h.api.closeSession("a", { quiet: true });
  assert.equal([...h.timers].filter((t) => t.ms === 300000).length, 0);
});

test("a failed resume preserves history and never starts an empty thread", async () => {
  const h = await host();
  h.respond(() => { throw new Error("temporary read failure"); });
  await h.api.startSession({ id: "a", cwd: "/test/project", resume: "saved-thread" });
  assert.deepEqual(h.requests.map((r) => r.method), ["thread/resume"]);
  assert.match(h.messages.find((m) => m.type === "error").message, /resume/);
  assert.equal(h.api.sessions.get("a").opening, false);
  assert.equal(h.messages.at(-1).type, "exit");
});

test("ending a turn clears unanswered questions and does not emit a second result", async () => {
  const h = await host(), s = h.session();
  h.api.handleServerRequest(17, "item/tool/requestUserInput", { threadId: s.threadId, questions: [] });
  const completed = { threadId: s.threadId, turn: { id: s.turnId, status: "failed", error: { message: "stopped" } } };
  h.api.handleNotification("turn/completed", completed);
  h.api.handleNotification("turn/completed", completed);
  assert.equal(s.asks.size, 0);
  assert.ok(h.messages.some((m) => m.type === "permissionCancel" && m.requestId === 17));
  assert.equal(h.messages.filter((m) => m.data?.type === "result").length, 1);
});

test("a rejected correction cannot start an overlapping turn", async () => {
  const h = await host(); h.session();
  h.respond(() => { throw new Error("turn mismatch"); });
  await h.api.sendPrompt({ id: "a", text: "correction" });
  assert.deepEqual(h.requests.map((r) => r.method), ["turn/steer"]);
  assert.match(h.messages.at(-1).message, /correction/);
});

test("silence and a failed interrupt cannot claim that a running turn stopped", async () => {
  const h = await host(), s = h.session();
  h.api.handleNotification("turn/started", { threadId: s.threadId, turn: { id: s.turnId } });
  s.silenceTimer.fn();
  assert.equal(s.running, true);
  assert.equal(h.messages.some((m) => m.data?.type === "result"), false);
  h.respond(() => { throw new Error("offline"); });
  await h.api.interrupt({ id: "a" });
  assert.equal(s.running, true);
  assert.equal(h.messages.some((m) => m.type === "interrupted"), false);
  h.respond(() => ({}));
  await h.api.interrupt({ id: "a" });
  assert.equal(s.running, false);
  assert.ok(h.messages.some((m) => m.type === "interrupted"));
});

test("a failed app-server start releases queued prompts", async () => {
  const h = await host();
  h.api.app.ready = false; h.api.app.proc = null;
  await h.api.startSession({ id: "a", cwd: "/test/project" });
  await h.api.sendPrompt({ id: "a", text: "hello" });
  assert.equal(h.api.sessions.get("a").pending.length, 0);
  assert.equal(h.messages.findLast((m) => m.data?.type === "result").data.is_error, true);
});

test("each chat pins its own browser tab, including a prewarmed thread", async () => {
  const h = await host(), a = h.session("a"), b = h.session("b");
  assert.notEqual(h.api.browserMcpConfig(a.browserSession).browser.env.RK_BRIDGE_SESSION, h.api.browserMcpConfig(b.browserSession).browser.env.RK_BRIDGE_SESSION);
  for (const s of [a, b]) {
    const pending = h.api.browserRequest("info", {}, s.browserSession);
    const request = h.messages.at(-1); assert.equal(request.session, s.id);
    h.api.resolveBrowser({ bid: request.bid, ok: true, data: { tabId: s.id } });
    assert.equal((await pending).data.tabId, s.id);
  }
  assert.equal((await h.api.browserRequest("info", {}, "expired")).ok, false);
  a.running = b.running = false;
  let key;
  h.respond((r) => { if (r.method === "thread/start") { key = r.params.config.mcp_servers.browser.env.RK_BRIDGE_SESSION; return { thread: { id: "warm" } }; } return {}; });
  await h.api.runPrewarm("/test/project");
  await h.api.startSession({ id: "c", cwd: "/test/project" });
  assert.equal(h.api.sessions.get("c").browserSession, key);
  assert.equal(h.api.sessions.get("c").threadId, "warm");
});

test("changing a provider key cannot interrupt another running chat", async () => {
  const h = await host(), s = h.session();
  assert.throws(() => h.api.ensureProviderKey({ id: "custom", apiKey: "test-only" }), /running/);
  assert.equal(s.running, true);
  s.running = false;
  assert.equal(h.api.ensureProviderKey({ id: "custom", apiKey: "test-only" }), true);
  assert.equal(h.api.ensureProviderKey({ id: "custom", apiKey: "test-only" }), false);
});

test("closing a chat during start cannot revive it", async () => {
  const h = await host();
  let release;
  h.respond((r) => r.method === "thread/start" ? new Promise((resolve) => { release = resolve; }) : {});
  const opening = h.api.startSession({ id: "a", cwd: "/test/project" });
  while (!release) await Promise.resolve();
  h.api.closeSession("a", { quiet: true });
  release({ thread: { id: "orphan" } });
  await opening;
  assert.equal(h.api.byThread.has("orphan"), false);
  assert.equal(h.messages.some((m) => m.type === "started"), false);
  assert.ok(h.requests.some((r) => r.method === "thread/unsubscribe"));
});

test("effort uses the selected model's levels and omits unknown or unsupported choices", async () => {
  const h = await host();
  h.api.MODELS.push({ id: "four-levels", efforts: ["low", "medium", "high", "xhigh"] });
  h.api.MODELS.push({ id: "six-levels", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] });
  h.api.MODELS.push({ id: "no-levels", efforts: [] });
  assert.equal(h.api.effortForModel("four-levels", "xhigh"), "xhigh");
  assert.equal(h.api.effortForModel("four-levels", "max"), null);
  assert.equal(h.api.effortForModel("six-levels", "ultra"), "ultra");
  assert.equal(h.api.effortForModel("six-levels", "ultracode"), "ultra");
  assert.equal(h.api.effortForModel("no-levels", "high"), null);
  assert.equal(h.api.effortForModel("unknown", "max"), null);
});


test("history reads the newest five full turns and passes the older cursor", async () => {
  const h = await host();
  h.respond((req) => {
    assert.equal(req.method, "thread/turns/list");
    assert.equal(req.params.limit, 5);
    assert.equal(req.params.sortDirection, "desc");
    assert.equal(req.params.itemsView, "full");
    return { data: [3, 2].map((n) => ({ id: "t" + n, startedAt: 1000 + n, items: [{ id: "m" + n, type: "agentMessage", text: "Reply " + n }] })), nextCursor: "older" };
  });
  await h.api.loadTranscript({ id: "a", sessionId: "thread-a", requestId: "r1", paged: true });
  const page = h.messages.at(-1);
  assert.deepEqual(page.events.map((e) => e.message.content[0].text), ["Reply 2", "Reply 3"]);
  assert.equal(page.nextCursor.value, "older");
  assert.equal(page.requestId, "r1");
  await h.api.loadTranscript({ id: "a", sessionId: "thread-a", requestId: "r2", cursor: page.nextCursor });
  assert.equal(h.requests.at(-1).params.cursor, "older");
});

test("oversized Unicode history survives native frames without truncation", async () => {
  const h = await host();
  const original = { type: "transcript", id: "a", sessionId: "thread-a", requestId: "large", events: [{ text: 'Привет 🦎 \"\\'.repeat(120000) }], paged: true, done: true };
  h.api.sendTranscriptPage(original);
  const frames = h.messages.filter((m) => m.type === "transcriptPart");
  assert.ok(frames.length > 1);
  for (const frame of frames) assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 900 * 1024);
  assert.deepEqual(JSON.parse(frames.map((f) => f.text).join("")), original);
  assert.equal(h.messages.some((m) => m.type === "error"), false);
});

test("older CLI history fallback pages without offset drift or swallowed failures", async () => {
  const h = await host();
  let turns = Array.from({ length: 12 }, (_, i) => ({ id: "t" + i, items: [] }));
  h.respond((req) => { if (req.method === "thread/turns/list") throw new Error("method not found"); return { thread: { turns } }; });
  await h.api.loadTranscript({ id: "a", sessionId: "thread-a", requestId: "r1" });
  const cursor = h.messages.at(-1).nextCursor;
  assert.deepEqual(cursor, { kind: "legacy", before: "t7" });
  turns.push({ id: "new", items: [] });
  await h.api.loadTranscript({ id: "a", sessionId: "thread-a", requestId: "r2", cursor });
  assert.equal(h.messages.at(-1).nextCursor.before, "t2");
  h.respond(() => { throw new Error("read failed"); });
  await h.api.loadTranscript({ id: "a", sessionId: "thread-a", requestId: "r3", cursor });
  assert.equal(h.messages.at(-1).requestId, "r3");
  assert.match(h.messages.at(-1).error, /read failed/);
});

test("unsupported Codex actions return a failure instead of silently hanging", async () => {
  const h = await host(); h.session();
  for (const [type, response] of [["rewind", "error"], ["remoteControl", "remoteControl"], ["authCode", "authDone"]]) {
    const before = h.messages.length;
    h.api.handle({ type, id: "a", code: "test-only", text: "changed" });
    assert.equal(h.messages.length, before + 1); assert.equal(h.messages.at(-1).type, response);
    assert.equal(h.messages.at(-1).id, "a");
    if (response !== "error") assert.equal(h.messages.at(-1).ok, false);
  }
  assert.equal(h.requests.length, 0);
});

test("cold start preserves the chosen model even when the catalog is empty", async () => {
  const h = await host();
  assert.equal(h.api.MODELS.length, 0);
  h.respond((r) => r.method === "thread/start" ? { thread: { id: "cold-thread" } } : {});
  await h.api.startSession({ id: "cold", cwd: "/test/project", model: "saved-valid-model" });
  assert.equal(h.requests.find((r) => r.method === "thread/start").params.model, "saved-valid-model");
  assert.equal(h.api.sessions.get("cold").model, "saved-valid-model");
});

test("skills discovery scopes the request and removes disabled and duplicate entries", async () => {
  const h = await host();
  h.respond(() => ({ data: [{ cwd: "/test/project", skills: [{ name: "enabled", enabled: true }, { name: "disabled", enabled: false }, { name: "enabled" }] }] }));
  await h.api.loadSkills({ id: "a", cwd: "/test/project" });
  assert.deepEqual(h.requests[0].params, { cwds: ["/test/project"] });
  assert.deepEqual(h.messages.at(-1), { type: "commands", id: "a", agent: "codex", cwd: "/test/project", list: ["enabled"], skills: ["enabled"] });
  h.respond(() => ({ data: [] })); await h.api.loadSkills({ id: "a", cwd: "/test/project" });
  assert.deepEqual(h.messages.at(-1).skills, []);
  h.respond(() => { throw new Error("offline"); }); await h.api.loadSkills({ id: "a", cwd: "/test/project" });
  assert.ok(h.messages.at(-1).error);
});

test("config responses echo the request identity even on validation errors", async () => {
  const h = await host();
  for (const type of ["configRead", "configWrite"]) {
    h.api.handle({ type, id: "a", requestId: "request-" + type, key: "invalid-key", scope: "user", cwd: "/test/project", content: "test" });
    const reply = h.messages.at(-1);
    assert.equal(reply.type, type); assert.equal(reply.requestId, "request-" + type);
    assert.equal(reply.agent, "codex"); assert.equal(reply.cwd, "/test/project"); assert.equal(reply.ok, false);
  }
});

test("changing settings before the first prompt starts a fresh thread without resume", async () => {
  const h = await host(); let next = 0;
  h.respond((r) => r.method === "thread/start" ? { thread: { id: "empty-" + (++next) } } : {});
  await h.api.startSession({ id: "a", cwd: "/test/project", model: "first-model", permissionMode: "workspace" });
  assert.equal(h.api.sessions.get("a").hasSubmittedTurn, false);
  await h.api.restartSession({ id: "a", model: "second-model", permissionMode: "full", effort: "medium" });
  assert.equal(h.requests.filter((r) => r.method === "thread/resume").length, 0);
  const starts = h.requests.filter((r) => r.method === "thread/start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].params.model, "second-model");
  assert.equal(h.api.sessions.get("a").mode, "full");
  assert.equal(h.api.sessions.get("a").threadId, "empty-2");
});

test("missing saved history has a distinct error and never starts an empty replacement", async () => {
  const h = await host();
  h.respond(() => { throw new Error("no rollout found for thread id saved-thread"); });
  await h.api.startSession({ id: "a", cwd: "/test/project", resume: "saved-thread" });
  assert.equal(h.messages.find((m) => m.type === "error").code, "CHAT_HISTORY_MISSING");
  await h.api.restartSession({ id: "a", permissionMode: "full" });
  assert.deepEqual(h.requests.map((r) => r.method), ["thread/resume", "thread/resume"]);
  assert.ok(h.requests.every((r) => r.params.threadId === "saved-thread"));
});

test("an uncertain first prompt cannot make a later restart drop its history", async () => {
  const h = await host();
  h.respond((r) => {
    if (r.method === "turn/start") throw new Error("request timed out");
    if (r.method === "thread/start" || r.method === "thread/resume") return { thread: { id: "submitted-thread" } };
    return {};
  });
  await h.api.startSession({ id: "a", cwd: "/test/project" });
  await h.api.sendPrompt({ id: "a", text: "Keep this message" });
  assert.equal(h.api.sessions.get("a").hasSubmittedTurn, true);
  await h.api.restartSession({ id: "a", permissionMode: "full" });
  assert.equal(h.requests.filter((r) => r.method === "thread/start").length, 1);
  assert.equal(h.requests.find((r) => r.method === "thread/resume").params.threadId, "submitted-thread");
});
