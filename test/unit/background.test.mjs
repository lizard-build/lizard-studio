import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function worker(options = {}) {
  const { decode, executeScript = async () => [] } = typeof options === "function" ? { executeScript: options } : options;
  const listeners = {}, tabsSent = [], opened = [], contexts = [], icons = [], titles = [];
  const event = (name) => ({ addListener(fn) { (listeners[name] ||= []).push(fn); } });
  const tabs = [{ id: 11, windowId: 101, active: true }, { id: 22, windowId: 202, active: true }];
  const chrome = {
    scripting: { executeScript },
    runtime: { getManifest: () => ({ content_scripts: [{ js: [] }], icons: { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" }, action: { default_title: "Studio idle" } }), getURL: (path) => `chrome-extension://test/${path}`, onInstalled: event("installed"), onConnect: event("connect"), onMessage: event("message"), getContexts: async () => contexts },
    tabs: { query: (query, cb) => cb(tabs.filter((tab) => Object.entries(query).every(([key, value]) => key === "currentWindow" || tab[key] === value))), sendMessage: async (id, msg) => tabsSent.push({ id, ...msg }), onRemoved: event("removed"), onUpdated: event("updated"), onActivated: event("activated") },
    sidePanel: { setPanelBehavior: async () => {}, open: async (opts) => opened.push(opts) },
    action: { onClicked: event("clicked"), setIcon: async (icon) => icons.push(icon), setTitle: async ({ title }) => titles.push(title) }, commands: { onCommand: event("command") },
    windows: { WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1, onFocusChanged: event("focus") },
    declarativeNetRequest: { updateSessionRules: async () => {} },
  };
  const canvas = class {
    constructor(width, height) { this.size = { width, height }; }
    getContext() { return { drawImage() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, getImageData: () => this.size }; }
  };
  vm.runInNewContext(readFileSync(new URL("../../src/background.js", import.meta.url), "utf8"), {
    chrome, console, setTimeout, clearTimeout, OffscreenCanvas: canvas,
    fetch: async () => ({ blob: async () => ({}) }),
    createImageBitmap: async () => { if (decode) await decode(); return { close() {} }; },
  });
  const fire = (name, ...args) => (listeners[name] || []).map((fn) => fn(...args));
  function panel(windowId, ready = true) {
    const received = [], disconnect = [], messages = [];
    const port = { name: "rk-sidepanel", postMessage: (m) => received.push(m), onMessage: { addListener: (fn) => messages.push(fn) }, onDisconnect: { addListener: (fn) => disconnect.push(fn) } };
    fire("connect", port);
    const identify = (id = windowId) => messages.forEach((fn) => fn({ type: "panelReady", windowId: id }));
    if (ready) { identify(); received.length = 0; }
    return { received, identify, activity: (active) => messages.forEach((fn) => fn({ type: "chatActivity", active })), close: () => disconnect.forEach((fn) => fn()) };
  }
  const message = (msg, windowId) => fire("message", msg, { tab: { windowId, id: 11 } }, () => {});
  return { panel, message, fire, tabsSent, opened, tabs, contexts, icons, titles };
}

test("attachments, selected elements, and close only reach the source window", () => {
  const w = worker(), a = w.panel(101), b = w.panel(202);
  for (const [type, cmd] of [["RK_ADD_TO_CHAT", "addImage"], ["RK_PICK_ELEMENT", "pickElement"], ["RK_CLOSE_SIDEPANEL", "close"]]) {
    w.message({ type, dataUrl: "data:image/png;base64,TEST", element: { text: "private selection" } }, 101);
    assert.equal(a.received.at(-1).cmd, cmd);
    assert.equal(b.received.length, 0);
  }
  w.message({ type: "RK_ADD_TO_CHAT", dataUrl: "unknown source" }, undefined);
  assert.equal(a.received.length, 3); assert.equal(b.received.length, 0);
});

test("unregistered panels receive nothing and cannot change windows after registration", () => {
  const w = worker(), p = w.panel(101, false);
  w.message({ type: "RK_ADD_TO_CHAT" }, 101); assert.equal(p.received.length, 0);
  p.identify(); p.received.length = 0; p.identify(202);
  w.message({ type: "RK_ADD_TO_CHAT" }, 202); assert.equal(p.received.length, 0);
  w.message({ type: "RK_ADD_TO_CHAT" }, 101); assert.equal(p.received.length, 1);
});

test("panel lifecycle only changes toolbars in its own window", () => {
  const w = worker(), a = w.panel(101), b = w.panel(202);
  assert.deepEqual(w.tabsSent.map((m) => m.id), [11, 22]);
  a.close(); assert.deepEqual(w.tabsSent.at(-1), { id: 11, type: "RK_HIDE_TOOLBAR" });
  const count = w.tabsSent.length;
  w.fire("activated", { tabId: 11, windowId: 101 }); assert.equal(w.tabsSent.length, count);
  w.fire("activated", { tabId: 22, windowId: 202 }); assert.deepEqual(w.tabsSent.at(-1), { id: 22, type: "RK_SHOW_TOOLBAR" });
  b.close(); assert.deepEqual(w.tabsSent.at(-1), { id: 22, type: "RK_HIDE_TOOLBAR" });
});

test("opening a panel in another window does not close an existing panel", async () => {
  const w = worker(), a = w.panel(101);
  w.contexts.push({ windowId: 101 });
  w.fire("clicked", w.tabs[1]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(a.received.length, 0); assert.equal(w.opened.length, 1); assert.equal(w.opened[0].tabId, 22);
  w.fire("clicked", w.tabs[0]); assert.equal(a.received.at(-1).cmd, "close");
});

test("the panel identifies its own window on every worker connection", () => {
  const sent = [], callbacks = [], disconnects = [];
  const port = { postMessage: (msg) => sent.push(msg), onMessage: { addListener() {} }, onDisconnect: { addListener: (fn) => disconnects.push(fn) } };
  const chrome = { runtime: { id: "test-extension", connect: () => port }, windows: { getCurrent: (cb) => cb({ id: 202 }) } };
  vm.runInNewContext(readFileSync(new URL("../../src/panel/panel.js", import.meta.url), "utf8"), {
    chrome, document: { getElementById: () => null }, window: { addEventListener() {} }, setTimeout: (fn) => callbacks.push(fn), setInterval() {},
  });
  assert.equal(sent[0].type, "panelReady"); assert.equal(sent[0].windowId, 202);
  disconnects[0](); callbacks[0]();
  assert.equal(sent.length, 4); assert.equal(sent[2].windowId, 202);
});

const flush = () => new Promise(setImmediate);

test("the activity icon covers all panels and clears only after the last active panel", async () => {
  const w = worker(), a = w.panel(101), b = w.panel(202);
  await flush(); assert.equal(w.icons.at(-1).path[16], "chrome-extension://test/icons/icon16.png");
  a.activity(true); await flush();
  assert.deepEqual(Object.keys(w.icons.at(-1).imageData), ["16", "32", "48"]);
  assert.match(w.titles.at(-1), /a chat is active/);
  const count = w.icons.length;
  b.activity(true); a.activity(false); await flush(); assert.equal(w.icons.length, count);
  b.close(); await flush(); assert.ok(w.icons.at(-1).path); assert.equal(w.titles.at(-1), "Studio idle");
});

test("unregistered, disconnected, and malformed activity reports cannot light the icon", async () => {
  const w = worker(), p = w.panel(101, false);
  p.activity(true); await flush(); assert.ok(w.icons.at(-1).path);
  p.identify(); p.activity("true"); await flush(); assert.ok(w.icons.at(-1).path);
  p.close(); p.activity(true); await flush(); assert.ok(w.icons.at(-1).path);
});

test("finishing while the active icon decodes cannot leave a stale dot", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const w = worker({ decode: () => pending }), p = w.panel(101);
  await flush(); p.activity(true); await flush(); p.activity(false); release();
  await flush(); assert.ok(w.icons.at(-1).path);
  assert.equal(w.icons.filter((icon) => icon.imageData).length, 0);
});

test("the panel replays current activity after reconnect and reports later changes", () => {
  const sent = [], retries = [], intervals = [], events = {}, disconnects = [], selections = [];
  let active = true;
  const chrome = {
    runtime: { id: "test", connect: () => ({ postMessage: (m) => sent.push(m), onMessage: { addListener() {} }, onDisconnect: { addListener: (fn) => disconnects.push(fn) } }) },
    windows: { getCurrent: (cb) => cb({ id: 101 }) },
  };
  vm.runInNewContext(readFileSync(new URL("../../src/panel/panel.js", import.meta.url), "utf8"), {
    chrome, document: { getElementById: () => null },
    window: { RKChat: { hasActiveChats: () => active, setLiveSelection: (selection) => selections.push(selection) }, addEventListener: (name, fn) => { events[name] = fn; } },
    setTimeout: (fn) => retries.push(fn), setInterval: (fn) => intervals.push(fn),
  });
  assert.equal(sent.at(-1).active, true);
  active = false; events["rk-chat-activity"](); assert.equal(sent.at(-1).active, false);
  disconnects[0](); assert.deepEqual(selections, [null]); const count = sent.length; active = true; intervals[0](); assert.equal(sent.length, count);
  retries[0](); assert.equal(sent.at(-2).type, "panelReady"); assert.equal(sent.at(-1).active, true);
  active = false; intervals[0](); assert.equal(sent.at(-1).active, false);
});

test("chat activity includes background and queued work but excludes idle and disconnected chats", () => {
  const source = readFileSync(new URL("../../src/panel/chat.js", import.meta.url), "utf8");
  const functions = source.slice(source.indexOf("  function hasActiveChats()"), source.indexOf("  // Retargets the dot classes"));
  const events = [], chats = new Map([["idle", {}], ["background", { turnRunning: true }]]);
  const scope = { chats, connected: true, Event: class {}, window: { dispatchEvent: (e) => events.push(e) } };
  vm.createContext(scope); vm.runInContext(functions, scope);
  scope.reportChatActivity(); scope.reportChatActivity(); assert.equal(events.length, 1);
  chats.get("background").turnRunning = false; assert.equal(scope.hasActiveChats(), false);
  chats.get("background").queue = [{}]; assert.equal(scope.hasActiveChats(), true);
  scope.connected = false; assert.equal(scope.hasActiveChats(), false);
  scope.reportChatActivity(); assert.equal(events.length, 2);
  scope.connected = true; chats.clear(); chats.set("waiting", { permCards: new Map([["ask", {}]]) });
  assert.equal(scope.hasActiveChats(), true);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
const selectionEvent = (w, text, tab = w.tabs[0], frameId = 0, focused = true) =>
  w.fire("message", { type: "RK_SELECTION_CHANGED", selection: { text, focused, url: "https://example.test/" } }, { tab, frameId }, () => {});

test("live ranges stay in the active tab and source window, including clears", async () => {
  const w = worker(), a = w.panel(101), b = w.panel(202); await tick();
  selectionEvent(w, "First"); assert.equal(a.received.at(-1).selection.text, "First");
  assert.ok(!b.received.some((m) => m.selection?.text));
  selectionEvent(w, "Other tab", { id: 33, windowId: 101, active: false });
  assert.equal(a.received.at(-1).selection.text, "First");
  selectionEvent(w, ""); assert.equal(a.received.at(-1).selection, null);
});

test("frame clears do not erase another frame, but an active frame can clear it", async () => {
  const w = worker(), p = w.panel(101); await tick();
  selectionEvent(w, "Child text", w.tabs[0], 7);
  selectionEvent(w, "", w.tabs[0], 0, false);
  assert.equal(p.received.at(-1).selection.text, "Child text");
  selectionEvent(w, "", w.tabs[0], 0, true);
  assert.equal(p.received.at(-1).selection, null);
});

test("navigation clears immediately and a late old-tab snapshot cannot revive a range", async () => {
  let finish;
  const w = worker(async (args) => args.files ? [] : new Promise((resolve) => { finish = resolve; }));
  const p = w.panel(101); await tick();
  selectionEvent(w, "Old range");
  w.fire("updated", 11, { status: "loading" });
  assert.equal(p.received.at(-1).selection, null);
  finish([{ frameId: 0, result: { text: "Late snapshot", focused: true } }]); await tick();
  assert.equal(p.received.at(-1).selection, null);
  w.tabs[0] = { id: 33, windowId: 101, active: true };
  w.fire("activated", { tabId: 33, windowId: 101 });
  selectionEvent(w, "Old event", { id: 11, windowId: 101, active: true });
  assert.equal(p.received.at(-1).selection, null);
});

test("a live event wins over an initial snapshot", async () => {
  let finish;
  const w = worker(async (args) => args.files ? [] : new Promise((resolve) => { finish = resolve; }));
  const p = w.panel(101); await tick();
  selectionEvent(w, "Latest");
  finish([{ frameId: 0, result: { text: "Stale", focused: true } }]); await tick();
  assert.equal(p.received.at(-1).selection.text, "Latest");
});
