import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/panel/window-mode.js", import.meta.url), "utf8");
const flush = () => new Promise(setImmediate);
function setup(search = "") {
  const listeners = new Set(), timers = new Set(), created = [], updates = [], messages = [], order = [];
  let closed = 0;
  const chrome = {
    runtime: { id: "test", getURL: p => "chrome-extension://test/" + p,
      onMessage: { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f) },
      sendMessage: (m, cb) => { messages.push(m); cb(); } },
    windows: {
      getCurrent: cb => cb({ id: 7, type: "normal" }),
      get: (id, cb) => cb({ id, type: "normal" }),
      create: (opts, cb) => { order.push("create"); created.push(opts); cb({ id: 80 }); },
      update: (id, opts, cb) => { updates.push({ id, opts }); cb({ id }); },
    },
    tabs: { query: (_, cb) => cb([]), update: (id, opts, cb) => { updates.push({ id, opts }); cb({ id }); } },
  };
  const window = { close: () => { order.push("close"); closed++; } };
  vm.runInNewContext(source, { chrome, window, location: { search }, URL, URLSearchParams,
    crypto: { randomUUID: () => "handoff-token" },
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
  });
  return { chrome, api: window.RKPanelWindow, created, updates, messages, listeners, timers, order,
    get closed() { return closed; },
    ready(url = created[0].url, id = "test") { for (const fn of listeners) fn({ type: "studioWindowReady", handoff: "handoff-token" }, { id, url }); },
  };
}

test("window mode saves before opening and closes the side panel only after the trusted view is ready", async () => {
  const p = setup(); let saved;
  const moving = p.api.open(() => new Promise(resolve => { saved = resolve; }));
  await flush(); assert.equal(p.created.length, 0);
  saved(); await flush();
  assert.equal(p.created[0].type, "popup");
  assert.equal(new URL(p.created[0].url).searchParams.get("sourceWindowId"), "7");
  assert.equal(p.closed, 0);
  p.ready("https://untrusted.invalid/"); p.ready(p.created[0].url, "another-extension");
  await flush(); assert.equal(p.closed, 0);
  p.ready(); await moving;
  assert.equal(p.closed, 1); assert.equal(p.listeners.size, 0); assert.equal(p.timers.size, 0);
});

test("repeated clicks share one open and an existing detached window is reused", async () => {
  const p = setup();
  p.chrome.tabs.query = (_, cb) => cb([{ id: 9, windowId: 80, url: "chrome-extension://test/src/panel/panel.html?mode=window&sourceWindowId=7&handoff=old" }]);
  const moving = p.api.open(async () => {});
  assert.equal(p.api.open(async () => { throw Error("duplicate save"); }), moving);
  await flush(); assert.equal(p.created.length, 0);
  assert.equal(p.updates[0].id, 9); assert.equal(p.updates[1].id, 80);
  p.ready(p.updates[0].opts.url); await moving;
  assert.equal(p.closed, 1);
});

test("a failed create or a failed save keeps the side panel open", async () => {
  const p = setup();
  await assert.rejects(p.api.open(async () => { throw Error("storage failed"); }), /storage failed/);
  assert.equal(p.created.length, 0);
  p.chrome.windows.create = (_, cb) => { p.chrome.runtime.lastError = { message: "window failed" }; cb(); delete p.chrome.runtime.lastError; };
  await assert.rejects(p.api.open(async () => {}), /window failed/);
  assert.equal(p.closed, 0); assert.equal(p.listeners.size, 0); assert.equal(p.timers.size, 0);
});

test("a view that never mounts times out without closing the side panel", async () => {
  const p = setup(), moving = p.api.open(async () => {});
  await flush(); for (const fn of p.timers) fn();
  await assert.rejects(moving, /not finished opening/);
  assert.equal(p.closed, 0); assert.equal(p.listeners.size, 0);
});

test("detached views keep using their original window for context and send a ready receipt", async () => {
  const p = setup("?mode=window&sourceWindowId=7&handoff=receipt");
  p.chrome.windows.getCurrent = () => { throw Error("must not target the popup"); };
  assert.equal((await new Promise(p.api.sourceWindow)).id, 7);
  p.api.ready(); assert.equal(p.messages[0].handoff, "receipt");
  await p.api.open(() => { throw Error("already detached"); });
  assert.equal(p.created.length, 0);
});

test("missing or closed source windows never fall back to another browser window", async () => {
  for (const search of ["?mode=window", "?mode=window&sourceWindowId=-1", "?mode=window&sourceWindowId=abc"]) {
    const p = setup(search); assert.equal(await new Promise(p.api.sourceWindow), null);
  }
  const p = setup("?mode=window&sourceWindowId=7");
  p.chrome.windows.get = (_, cb) => { p.chrome.runtime.lastError = { message: "closed" }; cb(); delete p.chrome.runtime.lastError; };
  assert.equal(await new Promise(p.api.sourceWindow), null);
});
