import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function faviconDocument() {
  let icon = null;
  return {
    getElementById: id => id === "studio-favicon" ? icon : null,
    head: { appendChild(node) { icon = node; } },
    createElement: () => ({ replaceWith(node) { icon = node; } }),
  };
}

function worker(options = {}) {
  const { writeBadge, sessionStorage, executeScript = async () => [], setPanelBehavior = async () => {}, timer = setTimeout, log = console } = typeof options === "function" ? { executeScript: options } : options;
  const listeners = {}, tabsSent = [], opened = [], contexts = [], icons = [], titles = [], badges = [], backgrounds = [], textColors = [];
  const event = (name) => ({ addListener(fn) { (listeners[name] ||= []).push(fn); } });
  const tabs = [{ id: 11, windowId: 101, active: true }, { id: 22, windowId: 202, active: true }];
  const chrome = {
    scripting: { executeScript },
    storage: { session: sessionStorage },
    runtime: { id: "test", getManifest: () => ({ content_scripts: [{ js: [] }], icons: { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" }, action: { default_title: "Studio idle" } }), getURL: (path) => `chrome-extension://test/${path}`, onInstalled: event("installed"), onStartup: event("startup"), onConnect: event("connect"), onMessage: event("message"), getContexts: async () => contexts },
    tabs: { query: (query, cb) => cb(tabs.filter((tab) => Object.entries(query).every(([key, value]) => key === "currentWindow" || tab[key] === value))), sendMessage: async (id, msg) => tabsSent.push({ id, ...msg }), onRemoved: event("removed"), onUpdated: event("updated"), onActivated: event("activated") },
    sidePanel: { setPanelBehavior, open: async (opts) => opened.push(opts) },
    action: { onClicked: event("clicked"), setIcon: async (icon) => icons.push(icon), setTitle: async ({ title }) => titles.push(title), setBadgeText: async ({ text }) => { if (writeBadge) await writeBadge(text); badges.push(text); }, setBadgeBackgroundColor: async ({ color }) => backgrounds.push(color), setBadgeTextColor: async ({ color }) => textColors.push(color) }, commands: { onCommand: event("command") },
    windows: { WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1, onFocusChanged: event("focus") },
    declarativeNetRequest: { updateSessionRules: async () => {} },
  };
  let nativeActivity, nativeResult;
  vm.runInNewContext(readFileSync(new URL("../../src/background.js", import.meta.url), "utf8"), {
    chrome, console: log, setTimeout: timer, clearTimeout, importScripts() {}, createStudioBrowser() {}, StudioPrefsSync: { createStore() { return {}; } },
    createStudioSessions({ activity, resultStatus }) { nativeActivity = activity; nativeResult = resultStatus; return { connect() { return false; } }; },
  });
  const fire = (name, ...args) => (listeners[name] || []).map((fn) => fn(...args));
  function panel(windowId, ready = true) {
    const received = [], disconnect = [], messages = [];
    const port = { name: "rk-sidepanel", sender: { id: "test", url: "chrome-extension://test/src/panel/panel.html" }, postMessage: (m) => received.push(m), onMessage: { addListener: (fn) => messages.push(fn) }, onDisconnect: { addListener: (fn) => disconnect.push(fn) } };
    fire("connect", port);
    const identify = (id = windowId) => messages.forEach((fn) => fn({ type: "panelReady", windowId: id }));
    if (ready) { identify(); received.length = 0; }
    return { received, identify, read: (id, token) => messages.forEach(fn => fn({ type: "resultRead", id, token })), activity: (count) => messages.forEach((fn) => fn({ type: "chatActivity", count })), close: () => disconnect.forEach((fn) => fn()) };
  }
  const message = (msg, windowId) => fire("message", msg, { tab: { windowId, id: 11 } }, () => {});
  return { result: (id, unread = true) => nativeResult(id, unread), activity: (count) => nativeActivity(count), panel, message, fire, tabsSent, opened, tabs, contexts, icons, titles, badges, backgrounds, textColors };
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
  const chrome = { runtime: { id: "test-extension", getURL: path => "chrome-extension://test/" + path, connect: () => port }, windows: { getCurrent: (cb) => cb({ id: 202 }) } };
  vm.runInNewContext(readFileSync(new URL("../../src/panel/panel.js", import.meta.url), "utf8"), {
    chrome, document: faviconDocument(), Image: class {}, window: { addEventListener() {} }, setTimeout: (fn) => callbacks.push(fn), setInterval() {},
  });
  assert.equal(sent[0].type, "panelReady"); assert.equal(sent[0].windowId, 202);
  disconnects[0](); callbacks[0]();
  assert.equal(sent.length, 4); assert.equal(sent[2].windowId, 202);
});

const flush = () => new Promise(setImmediate);

const activityState = panel => panel.received.filter(m => m.cmd === "sessionActivity").at(-1);

test("running sessions take priority, including when unread count has the same number", async () => {
  const w = worker(), a = w.panel(101), b = w.panel(202);
  w.result("one"); w.result("two"); await flush();
  assert.equal(w.badges.at(-1), "2"); assert.equal(w.backgrounds.at(-1), "#10b981");
  assert.equal(activityState(a).unread.length, 2); assert.equal(activityState(b).unread.length, 2);
  w.activity(2); await flush();
  assert.equal(w.badges.at(-1), "2"); assert.equal(w.backgrounds.at(-1), "#fbbf24");
  w.activity(0); await flush();
  assert.equal(w.badges.at(-1), "2"); assert.equal(w.backgrounds.at(-1), "#10b981");
  const token = activityState(a).unread.find(([id]) => id === "one")[1];
  a.read("one", token); await flush();
  assert.equal(w.badges.at(-1), "1"); assert.match(w.titles.at(-1), /1 unread result$/);
  b.read("one", token); await flush(); assert.equal(w.badges.at(-1), "1");
  const [id, lastToken] = activityState(b).unread[0];
  b.read(id, lastToken); await flush(); assert.equal(w.badges.at(-1), "");
});

test("a stale acknowledgement cannot mark a newer result as read", async () => {
  const w = worker(), p = w.panel(101);
  w.result("one"); const old = activityState(p).unread[0][1];
  w.result("one"); p.read("one", old); await flush();
  assert.equal(w.badges.at(-1), "1");
  assert.notEqual(activityState(p).unread[0][1], old);
  p.close(); await flush(); assert.equal(w.badges.at(-1), "1");
});

test("unread results survive a worker restart without restoring a stale overwritten result", async () => {
  const data = {};
  const sessionStorage = { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) };
  const w = worker({ sessionStorage });
  w.result("finished"); await flush();
  const reopened = worker({ sessionStorage }); await flush();
  assert.equal(reopened.badges.at(-1), "1"); assert.equal(reopened.backgrounds.at(-1), "#10b981");
  let release;
  const delayed = worker({ sessionStorage: { get: () => new Promise(resolve => { release = resolve; }), set: sessionStorage.set } });
  delayed.result("finished", false);
  delayed.result("new");
  release({ studioUnreadResults: [["finished", "old-token"]] }); await flush();
  assert.equal(delayed.badges.at(-1), "1");
  assert.deepEqual(data.studioUnreadResults.map(([id]) => id), ["new"]);
});

test("web content cannot subscribe to result ids through the panel port", () => {
  const w = worker(), received = [];
  w.fire("connect", { name: "rk-sidepanel", sender: { id: "test", url: "https://example.test" },
    postMessage: m => received.push(m), onMessage: { addListener() { throw new Error("untrusted listener"); } } });
  w.result("private-chat"); assert.equal(received.length, 0);
});

test("only a visible, loaded chat can acknowledge a result", () => {
  const source = readFileSync(new URL("../../src/panel/chat.js", import.meta.url), "utf8");
  const chat = { id: "a", messagesEl: { childElementCount: 1 } };
  const scope = { chats: new Map([["a", chat]]), activeId: "a", connected: true, backgroundRestoring: false, document: { hidden: false } };
  vm.createContext(scope);
  vm.runInContext(source.slice(source.indexOf("  function getVisibleChatId()"), source.indexOf("  function getRunningChatCount()")), scope);
  assert.equal(scope.getVisibleChatId(), "a");
  scope.document.hidden = true; assert.equal(scope.getVisibleChatId(), null);
  scope.document.hidden = false;
  chat.historyRequest = {}; assert.equal(scope.getVisibleChatId(), null);
  chat.historyRequest = null;
  chat.historyError = true; assert.equal(scope.getVisibleChatId(), null);
  chat.historyError = false;
  scope.backgroundRestoring = true; assert.equal(scope.getVisibleChatId(), null);
});

test("favicon changes from yellow to green and acknowledges only the visible result", () => {
  let receive;
  const sent = [], images = [], colors = [], labels = [], events = {};
  const document = faviconDocument();
  const ctx = { drawImage() {}, measureText: text => ({ width: text.length * 7 }), beginPath() {}, roundRect() {},
    fill() { colors.push(this.fillStyle); }, fillText: text => labels.push(text) };
  let visible = null;
  const chrome = { runtime: { id: "test", getURL: path => "chrome-extension://test/" + path,
    connect: () => ({ postMessage: msg => sent.push(msg), onMessage: { addListener: fn => { receive = fn; } }, onDisconnect: { addListener() {} } }) },
    windows: { getCurrent: cb => cb({ id: 101 }) } };
  vm.runInNewContext(readFileSync(new URL("../../src/panel/panel.js", import.meta.url), "utf8"), {
    chrome, Image: class { constructor() { images.push(this); } },
    document: { ...document, addEventListener: (name, fn) => { events[name] = fn; },
      createElement: tag => tag === "link" ? document.createElement(tag) : ({ getContext: () => ctx,
        toDataURL: () => "data:image/png;base64," + colors.at(-1) + labels.at(-1) }) },
    window: { RKChat: { getVisibleChatId: () => visible }, addEventListener: (name, fn) => { events[name] = fn; } },
    setInterval() {}, setTimeout() {},
  });
  const unread = [["a", "token-a"], ["b", "token-b"]];
  receive({ cmd: "sessionActivity", count: 2, unread });
  images[0].complete = true; images[0].naturalWidth = 48; images[0].onload();
  assert.equal(labels.at(-1), "2"); assert.equal(colors.at(-1), "#fbbf24");
  const yellowIcon = document.getElementById("studio-favicon");
  receive({ cmd: "sessionActivity", count: 0, unread });
  assert.notEqual(document.getElementById("studio-favicon"), yellowIcon);
  assert.equal(labels.at(-1), "2"); assert.equal(colors.at(-1), "#10b981");
  assert.ok(!sent.some(m => m.type === "resultRead"));
  visible = "b"; events["rk-chat-view"]();
  assert.equal(sent.at(-1).id, "b"); assert.equal(sent.at(-1).token, "token-b");
  receive({ cmd: "sessionActivity", count: 0, unread: [] });
  assert.equal(document.getElementById("studio-favicon").href, "chrome-extension://test/icons/icon48.png");
});

test("the yellow badge follows native sessions even after all panels close", async () => {
  const w = worker(), a = w.panel(101), b = w.panel(202);
  await flush();
  assert.equal(w.icons.at(-1).path[16], "chrome-extension://test/icons/icon16.png");
  assert.equal(w.backgrounds.at(-1), "#fbbf24");
  assert.equal(w.textColors.at(-1), "#121212");
  w.activity(5); await flush();
  assert.equal(w.badges.at(-1), "5");
  a.close(); b.close(); await flush();
  assert.equal(w.badges.at(-1), "5");
  w.activity(1); await flush();
  assert.equal(w.titles.at(-1), "Lizard Studio — 1 session running");
  w.activity(0); await flush();
  assert.equal(w.badges.at(-1), ""); assert.equal(w.titles.at(-1), "Studio idle");
});

test("panel activity cannot overwrite the native session count", async () => {
  const w = worker(), p = w.panel(101);
  w.activity(2);
  for (const value of [0, 12, true, "3", -1, 1.5, NaN, Infinity]) p.activity(value);
  await flush(); assert.equal(w.badges.at(-1), "2");
});

test("finishing during a delayed badge write cannot leave a stale count", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const w = worker({ writeBadge: (text) => text === "2" ? pending : undefined });
  await flush(); w.activity(2); await flush(); w.activity(0); release();
  await flush(); assert.equal(w.badges.at(-1), "");
});

test("large counts fit the badge while the tooltip keeps the exact total", async () => {
  const w = worker(); w.activity(1200); await flush();
  assert.equal(w.badges.at(-1), "999+");
  assert.equal(w.titles.at(-1), "Lizard Studio — 1200 sessions running");
});

test("the panel replays its count after reconnect and reports changes above zero", () => {
  const sent = [], retries = [], intervals = [], events = {}, disconnects = [], selections = [];
  let count = 2;
  const chrome = {
    runtime: { id: "test", getURL: path => "chrome-extension://test/" + path, connect: () => ({ postMessage: (m) => sent.push(m), onMessage: { addListener() {} }, onDisconnect: { addListener: (fn) => disconnects.push(fn) } }) },
    windows: { getCurrent: (cb) => cb({ id: 101 }) },
  };
  vm.runInNewContext(readFileSync(new URL("../../src/panel/panel.js", import.meta.url), "utf8"), {
    chrome, document: faviconDocument(), Image: class {},
    window: { RKChat: { getRunningChatCount: () => count, setLiveSelection: (selection) => selections.push(selection) }, addEventListener: (name, fn) => { events[name] = fn; } },
    setTimeout: (fn) => retries.push(fn), setInterval: (fn) => intervals.push(fn),
  });
  assert.equal(sent.at(-1).count, 2);
  count = 3; events["rk-chat-activity"](); assert.equal(sent.at(-1).count, 3);
  disconnects[0](); assert.deepEqual(selections, [null]);
  const messages = sent.length; count = 1; intervals[0](); assert.equal(sent.length, messages);
  retries[0](); assert.equal(sent.at(-2).type, "panelReady"); assert.equal(sent.at(-1).count, 1);
  count = 0; intervals[0](); assert.equal(sent.at(-1).count, 0);
});

test("the running count follows yellow tab states, excluding waiting, idle and disconnected chats", () => {
  const source = readFileSync(new URL("../../src/panel/chat.js", import.meta.url), "utf8");
  const functions = source.slice(source.indexOf("  function getRunningChatCount()"), source.indexOf("  // Retargets the dot classes"));
  const events = [], chats = new Map([["idle", {}], ["background", { turnRunning: true }]]);
  const scope = { chats, connected: true, Event: class {}, window: { dispatchEvent: (e) => events.push(e) } };
  vm.createContext(scope); vm.runInContext(functions, scope);
  assert.equal(scope.getRunningChatCount(), 1);
  scope.reportChatActivity(); scope.reportChatActivity(); assert.equal(events.length, 1);
  chats.set("second", { turnRunning: true, queue: [{}] });
  assert.equal(scope.getRunningChatCount(), 2);
  scope.reportChatActivity(); assert.equal(events.length, 2);
  chats.get("background").permCards = new Map([["ask", {}]]);
  assert.equal(scope.getRunningChatCount(), 1);
  chats.delete("second"); assert.equal(scope.getRunningChatCount(), 0);
  chats.set("queued", { queue: [{}] }); assert.equal(scope.getRunningChatCount(), 1);
  scope.connected = false; assert.equal(scope.getRunningChatCount(), 0);
  scope.reportChatActivity(); assert.equal(events.length, 3);
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

test("No SW retries setup without blocking clicks or starting duplicate attempts", async () => {
  let calls = 0;
  const timers = [], errors = [];
  const w = worker({
    setPanelBehavior: async (opts) => {
      assert.equal(opts.openPanelOnActionClick, true);
      if (++calls === 1) throw new Error("No SW");
    },
    timer: (fn, delay) => timers.push({ fn, delay }), log: { error: (...args) => errors.push(args) },
  });
  await flush();
  assert.equal(timers[0].delay, 250);
  w.fire("startup"); w.fire("installed"); w.fire("clicked", w.tabs[0]);
  await flush();
  assert.equal(calls, 1); assert.equal(w.opened.length, 1);
  timers[0].fn(); await flush();
  assert.equal(calls, 2); assert.equal(errors.length, 0);
  w.fire("startup"); w.fire("installed"); await flush();
  assert.equal(calls, 2);
});

test("persistent No SW is bounded and can recover on a later startup event without an extension error", async () => {
  let calls = 0, broken = true;
  const timers = [], errors = [];
  const w = worker({
    setPanelBehavior: async () => { calls++; if (broken) throw new Error("No SW"); },
    timer: (fn, delay) => timers.push({ fn, delay }), log: { error: (...args) => errors.push(args) },
  });
  await flush();
  for (let i = 0; i < 3; i++) { timers[i].fn(); await flush(); }
  assert.deepEqual(timers.map(t => t.delay), [250, 1000, 3000]);
  assert.equal(calls, 4); assert.equal(errors.length, 0);
  broken = false; w.fire("startup"); await flush();
  assert.equal(calls, 5); assert.equal(errors.length, 0);
});

test("panel reconnect retries exhausted setup and keeps the click fallback available", async () => {
  let calls = 0, broken = true;
  const timers = [], errors = [];
  const w = worker({
    setPanelBehavior: async () => { calls++; if (broken) throw new Error("No SW"); },
    timer: (fn, delay) => timers.push({ fn, delay }), log: { error: (...args) => errors.push(args) },
  });
  await flush();
  for (let i = 0; i < 3; i++) { timers[i].fn(); await flush(); }
  assert.equal(calls, 4);
  w.fire("connect", { name: "unrelated" }); await flush();
  assert.equal(calls, 4);
  broken = false;
  w.panel(101); await flush();
  assert.equal(calls, 5);
  w.fire("clicked", w.tabs[1]); await flush();
  assert.equal(w.opened.at(-1).tabId, 22);
  w.fire("startup"); w.panel(202); await flush();
  assert.equal(calls, 5); assert.equal(errors.length, 0);
});

test("other API errors are reported immediately without repeated setup calls", async () => {
  for (const synchronous of [false, true]) {
    const timers = [], errors = [];
    worker({
      setPanelBehavior: () => {
        const error = new Error("Permission denied");
        if (synchronous) throw error;
        return Promise.reject(error);
      },
      timer: (fn, delay) => timers.push({ fn, delay }), log: { error: (...args) => errors.push(args) },
    });
    await flush();
    assert.equal(timers.length, 0); assert.equal(errors.length, 1);
    assert.equal(errors[0][1].message, "Permission denied");
  }
});

test("the detached shell routes page selections to its source window", () => {
  const sent = [];
  const port = { postMessage: m => sent.push(m), onMessage: { addListener() {} }, onDisconnect: { addListener() {} } };
  vm.runInNewContext(readFileSync(new URL("../../src/panel/panel.js", import.meta.url), "utf8"), {
    chrome: { runtime: { id: "test", getURL: path => "chrome-extension://test/" + path, connect: () => port }, windows: { getCurrent() { throw Error("must not use popup window"); } } },
    document: faviconDocument(), Image: class {},
    window: { addEventListener() {}, RKPanelWindow: { sourceWindow: cb => cb({ id: 7 }) } },
    setTimeout() {}, setInterval() {},
  });
  assert.equal(sent[0].type, "panelReady"); assert.equal(sent[0].windowId, 7);
});

test("favicon uses local activity until the worker sends the global state", () => {
  let receive, disconnect, count = 3;
  const events = {}, document = faviconDocument(), labels = [];
  const ctx = { drawImage() {}, measureText: () => ({ width: 7 }), beginPath() {}, roundRect() {}, fill() {}, fillText: text => labels.push(text) };
  const images = [];
  vm.runInNewContext(readFileSync(new URL("../../src/panel/panel.js", import.meta.url), "utf8"), {
    chrome: { runtime: { id: "test", getURL: p => "chrome-extension://test/" + p,
      connect: () => ({ postMessage() {}, onMessage: { addListener: fn => { receive = fn; } },
        onDisconnect: { addListener: fn => { disconnect = fn; } } }) }, windows: { getCurrent: cb => cb({ id: 1 }) } },
    Image: class { constructor() { images.push(this); } },
    document: { ...document, createElement: tag => tag === "link" ? document.createElement(tag) :
      ({ getContext: () => ctx, toDataURL: () => "data:image/png;base64," + labels.at(-1) }) },
    window: { RKChat: { getRunningChatCount: () => count, setLiveSelection() {} }, addEventListener: (name, fn) => { events[name] = fn; } },
    setTimeout() {}, setInterval() {},
  });
  images[0].complete = true; images[0].naturalWidth = 48; images[0].onload();
  assert.equal(labels.at(-1), "3");
  assert.ok(document.getElementById("studio-favicon").href.startsWith("data:image/png"));
  receive({ cmd: "sessionActivity", count: 5 });
  count = 2; events["rk-chat-activity"]();
  assert.equal(labels.at(-1), "5", "local chats must not overwrite the total across windows");
  disconnect();
  assert.equal(labels.at(-1), "2");
});
