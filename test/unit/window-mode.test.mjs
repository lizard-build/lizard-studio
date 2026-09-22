import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/panel/window-mode.js", import.meta.url), "utf8");
const flush = () => new Promise(setImmediate);
const panelURL = "chrome-extension://test/src/panel/panel.html";
function setup(search = "") {
  const listeners = new Set(), timers = new Set(), created = [], updates = [], messages = [], order = [];
  let closed = 0, reloads = 0;
  const chrome = {
    runtime: { id: "test", getURL: p => "chrome-extension://test/" + p,
      onMessage: { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f) },
      sendMessage: (m, cb) => { messages.push(m); cb(); } },
    windows: {
      getCurrent: cb => cb({ id: 7, type: "normal" }),
      get: (id, cb) => cb({ id, type: "normal" }),
      create() { throw Error("must not create a window"); },
    },
    sidePanel: { open: opts => { order.push("sidePanel.open"); updates.push(opts); return Promise.resolve(); } },
    tabs: {
      getCurrent: cb => cb({ id: 80 }),
      remove: (id, cb) => { assert.equal(id, 80); closed++; cb(); },
      query: (_, cb) => cb([{ id: 12, windowId: 7, url: "https://work.invalid" }]),
      get: (id, cb) => cb({ id, windowId: 7, url: "https://work.invalid" }),
      create: (opts, cb) => { created.push(opts); cb({ id: 80, windowId: 7 }); },
      update: (id, opts, cb) => { updates.push({ id, opts }); cb({ id }); },
    },
  };
  const window = { close: () => { order.push("close"); closed++; } };
  vm.runInNewContext(source, { chrome, window, location: { search, reload() { reloads++; } }, URL, URLSearchParams,
    crypto: { randomUUID: () => "handoff-token" },
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
  });
  const receive = (msg, sender, respond = () => {}) => { for (const fn of listeners) fn(msg, sender, respond); };
  return { chrome, api: window.RKPanelWindow, created, updates, messages, listeners, timers, order, receive,
    get closed() { return closed; }, get reloads() { return reloads; },
    ready(url = created[0].url, id = "test", tab = { id: 80 }) {
      receive({ type: "studioWindowReady", handoff: "handoff-token", sourceWindowId: 7 }, { id, url, tab });
    },
  };
}

test("opening a Chrome tab saves first and closes the panel only after the trusted tab renders", async () => {
  const p = setup(); let saved;
  const moving = p.api.open(() => new Promise(resolve => { saved = resolve; }));
  await flush(); assert.equal(p.created.length, 0);
  saved(); await flush();
  assert.equal(p.created[0].windowId, 7); assert.equal(p.created[0].active, true);
  const url = new URL(p.created[0].url);
  assert.equal(url.searchParams.get("mode"), "tab"); assert.equal(url.searchParams.get("sourceTabId"), "12");
  assert.equal(p.closed, 0);
  p.ready("https://untrusted.invalid/"); p.ready(p.created[0].url, "another-extension");
  await flush(); assert.equal(p.closed, 0);
  p.ready(); await moving;
  assert.equal(p.closed, 1); assert.equal(p.api.transferring, true); assert.equal(p.timers.size, 0);
});

test("repeated clicks share one open and reuse a Studio tab in the same window", async () => {
  const p = setup();
  p.chrome.tabs.query = (opts, cb) => cb(opts.active ? [{ id: 12 }] : [{ id: 9, windowId: 7, url: panelURL + "?mode=tab&sourceWindowId=7" }]);
  const moving = p.api.open(async () => {});
  assert.equal(p.api.open(async () => { throw Error("duplicate save"); }), moving);
  await flush(); assert.equal(p.created.length, 0); assert.equal(p.updates[0].id, 9); assert.equal(p.updates[0].opts.active, true);
  p.ready(p.updates[0].opts.url); await moving;
  assert.equal(p.closed, 1);
});

test("failed saves, failed tab creation and load timeouts keep the source view open", async () => {
  const p = setup();
  await assert.rejects(p.api.open(async () => { throw Error("storage failed"); }), /storage failed/);
  p.chrome.tabs.create = (_, cb) => { p.chrome.runtime.lastError = { message: "tab failed" }; cb(); delete p.chrome.runtime.lastError; };
  await assert.rejects(p.api.open(async () => {}), /tab failed/);
  assert.equal(p.closed, 0); assert.equal(p.listeners.size, 1); assert.equal(p.timers.size, 0);
  const slow = setup(), moving = slow.api.open(async () => {});
  await flush(); for (const fn of slow.timers) fn();
  await assert.rejects(moving, /not finished opening/); assert.equal(slow.closed, 0);
});

test("return opens the side panel synchronously and waits for saved chats and a side-panel receipt", async () => {
  const p = setup("?mode=tab&sourceWindowId=7&sourceTabId=12"); let saved;
  const moving = p.api.open(() => { p.order.push("save"); return new Promise(resolve => { saved = resolve; }); });
  assert.deepEqual(p.order, ["sidePanel.open"], "Chrome must receive the click before any await");
  await flush();
  let state;
  p.receive({ type: "studioDockState", sourceWindowId: 7 }, { id: "test", url: panelURL }, value => { state = value; });
  await flush(); assert.equal(state, undefined);
  saved(); await flush(); assert.equal(state.handoff, "handoff-token");
  p.ready(panelURL); await flush(); assert.equal(p.closed, 0, "a tab cannot impersonate the side panel");
  p.receive({ type: "studioWindowReady", handoff: state.handoff, sourceWindowId: 7 }, { id: "test", url: panelURL });
  await moving;
  assert.equal(p.closed, 1); assert.equal(p.updates.at(-1).id, 12); assert.equal(p.api.transferring, true);
});

test("a side panel waits for handoff storage before loading and reports readiness", async () => {
  const p = setup(); let reply;
  p.chrome.runtime.sendMessage = (msg, cb) => { p.messages.push(msg); if (msg.type === "studioDockState") reply = cb; else cb(); };
  let prepared = false;
  const prepare = p.api.prepare().then(() => { prepared = true; });
  await flush(); assert.equal(prepared, false);
  reply({ handoff: "receipt" }); await prepare;
  p.api.ready(); await flush();
  assert.equal(p.messages.at(-1).type, "studioWindowReady"); assert.equal(p.messages.at(-1).handoff, "receipt");
  p.receive({ type: "studioDockReload", sourceWindowId: 7, handoff: "receipt" }, { id: "test", url: panelURL, tab: { id: 80 } });
  assert.equal(p.reloads, 0, "a fresh panel that loaded this handoff must not reload");
  p.receive({ type: "studioDockReload", sourceWindowId: 8 }, { id: "test", url: panelURL, tab: { id: 80 } });
  assert.equal(p.reloads, 0);
  p.receive({ type: "studioDockReload", sourceWindowId: 7 }, { id: "test", url: panelURL, tab: { id: 80 } });
  assert.equal(p.reloads, 1); assert.equal(p.api.transferring, true, "old panel must not overwrite the saved draft during reload");
});

test("a denied side-panel open preserves the Studio tab", async () => {
  const p = setup("?mode=tab&sourceWindowId=7");
  p.chrome.sidePanel.open = () => Promise.reject(new Error("gesture denied"));
  await assert.rejects(p.api.open(async () => {}), /gesture denied/);
  assert.equal(p.closed, 0); assert.equal(p.listeners.size, 1); assert.equal(p.timers.size, 0);
});

test("page context remains on the original page while Studio is the active Chrome tab", async () => {
  const p = setup("?mode=tab&sourceWindowId=7&sourceTabId=12");
  p.chrome.tabs.query = (_, cb) => cb([{ id: 80, url: panelURL + "?mode=tab", windowId: 7 }]);
  assert.equal((await p.api.activeTab()).id, 12);
  p.chrome.tabs.get = (_, cb) => { p.chrome.runtime.lastError = { message: "closed" }; cb(); delete p.chrome.runtime.lastError; };
  assert.equal(await p.api.activeTab(), null);
  p.chrome.tabs.query = (_, cb) => cb([{ id: 13, url: "https://other.invalid", windowId: 7 }]);
  assert.equal((await p.api.activeTab()).id, 13);
});

test("missing or closed source windows never fall back to another browser window", async () => {
  for (const search of ["?mode=tab", "?mode=tab&sourceWindowId=-1", "?mode=window&sourceWindowId=abc"]) {
    const p = setup(search); assert.equal(await new Promise(p.api.sourceWindow), null);
  }
  const p = setup("?mode=tab&sourceWindowId=7");
  p.chrome.windows.get = (_, cb) => { p.chrome.runtime.lastError = { message: "closed" }; cb(); delete p.chrome.runtime.lastError; };
  assert.equal(await new Promise(p.api.sourceWindow), null);
});
