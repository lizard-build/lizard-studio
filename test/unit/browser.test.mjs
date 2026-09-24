import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Load the shipped browser runtime, replacing only Chrome and the clock. No live tabs,
// accounts, host processes, or network calls take part in these tests.
function panel() {
  const timers = new Set(), replies = [], commands = [], attachments = [], detachments = [];
  const listeners = {};
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const tab = { id: 11, windowId: 1, url: "https://test.invalid/", title: "Test", active: false };
  const chrome = {
    runtime: {},
    tabs: {
      get: (_id, cb) => cb(tab), query: (_q, cb) => cb([tab]),
      create: (_opts, cb) => cb(tab),
      sendMessage: (_id, _payload, cb) => cb({ ok: true, url: tab.url, title: tab.title, text: "Page content" }),
    },
    debugger: {
      onEvent: event("debuggerEvent"), onDetach: event("detach"),
      attach: (_target, _version, cb) => { attachments.push(cb); cb(); },
      detach: (target, cb) => { detachments.push(target); cb(); },
      sendCommand: (_target, method, _params, cb) => {
        commands.push(method);
        cb(method === "Runtime.evaluate" ? { result: { value: { ok: true, url: tab.url, title: tab.title, text: "CDP content" } } } : { nodes: [] });
      },
    },
  };
  const scope = {
    chrome, console, testReplies: replies,
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.add(t); return t; },
    clearTimeout: (t) => timers.delete(t),
  };
  vm.runInNewContext(readFileSync(new URL("../../src/browser-runtime.js", import.meta.url), "utf8") +
    "\nglobalThis.browserTest = createStudioBrowser({ post: (m) => testReplies.push(m) });", scope);
  let bid = 0;
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  const expire = async (ms) => {
    const due = [...timers].filter((t) => t.ms <= ms);
    for (const t of due) { timers.delete(t); t.fn(); }
    await flush();
  };
  const call = (op, args = {}) => scope.browserTest.handleBrowserOp({ bid: ++bid, op, args, session: "chat-a" });
  return { ...scope.browserTest, chrome, call, replies, commands, attachments, detachments, timers, expire, flush, listeners };
}

test("a silent page helper falls back to CDP before the host timeout", async () => {
  const p = panel();
  let lateReply;
  p.chrome.tabs.sendMessage = (_tab, _msg, cb) => { lateReply = cb; };
  await p.call("tab_open", { url: "https://test.invalid/", active: false });
  const reading = p.call("dom", { tabId: 11 });
  await p.flush();
  await p.expire(2500);
  assert.equal(p.replies.length, 2, "reading must finish before the 30-second bridge timeout");
  await reading;
  assert.equal(p.replies[1].ok, true);
  assert.equal(p.replies[1].data.content, "CDP content");
  lateReply({ ok: true, text: "stale" });
  await p.flush();
  assert.equal(p.replies.length, 2, "a late page reply must not send a second result");
});

test("a silent debugger command returns the failed step and allows another read", async () => {
  const p = panel();
  const send = p.chrome.debugger.sendCommand;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method !== "Accessibility.getFullAXTree") send(target, method, args, cb);
  };
  const reading = p.call("snapshot", { tabId: 11 });
  await p.flush();
  await p.expire(5000);
  assert.equal(p.replies.length, 1);
  await reading;
  assert.equal(p.replies[0].ok, false);
  assert.match(p.replies[0].error, /Accessibility.getFullAXTree.*11.*timed out/i);
  assert.doesNotMatch(p.replies[0].error, /browser_tab_activate/);
  p.chrome.debugger.sendCommand = send;
  await p.call("snapshot", { tabId: 11 });
  assert.equal(p.replies[1].ok, true);
});

test("slow Page.enable setup can finish after the ordinary debugger deadline", async () => {
  const p = panel();
  let enable;
  const send = p.chrome.debugger.sendCommand;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method === "Page.enable") enable = cb;
    else send(target, method, args, cb);
  };
  const reading = p.call("snapshot", { tabId: 11 });
  await p.flush();
  await p.expire(5000);
  assert.equal(p.replies.length, 0);
  assert.equal(p.detachments.length, 0);
  enable({});
  await reading;
  assert.equal(p.replies[0].ok, true);
});

test("silent Page.enable reports its own deadline and the next read can reconnect", async () => {
  const p = panel();
  const send = p.chrome.debugger.sendCommand;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method !== "Page.enable") send(target, method, args, cb);
  };
  const reading = p.call("snapshot", { tabId: 11 });
  await p.flush();
  await p.expire(10000);
  await reading;
  assert.equal(p.replies[0].ok, false);
  assert.match(p.replies[0].error, /Page.enable.*10000 ms/);
  assert.match(p.replies[0].error, /browser_dom/);
  assert.equal(p.detachments.length, 1);
  await p.call("dom", { tabId: 11 });
  assert.equal(p.replies[1].ok, true);
  assert.equal(p.replies[1].data.content, "Page content");
  p.chrome.debugger.sendCommand = send;
  await p.call("snapshot", { tabId: 11 });
  assert.equal(p.replies[2].ok, true);
});

test("concurrent first reads wait for the same debugger setup", async () => {
  const p = panel();
  let enable;
  const send = p.chrome.debugger.sendCommand;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method === "Runtime.enable") enable = cb;
    else send(target, method, args, cb);
  };
  const first = p.call("snapshot", { tabId: 11 });
  await p.flush();
  const second = p.call("snapshot", { tabId: 11 });
  await p.flush();
  assert.equal(p.commands.includes("Accessibility.getFullAXTree"), false, "no read may bypass pending setup");
  enable({});
  await Promise.all([first, second]);
  assert.equal(p.attachments.length, 1);
  assert.equal(p.replies.length, 2);
  assert.ok(p.replies.every((r) => r.ok));
});

test("a missing helper still falls back, but an invalid selector does not", async () => {
  const p = panel();
  p.chrome.tabs.sendMessage = (_tab, _msg, cb) => cb({ ok: false, error: "Could not establish connection. Receiving end does not exist." });
  await p.call("dom");
  assert.equal(p.replies[0].data.content, "CDP content");
  const count = p.commands.length;
  p.chrome.tabs.sendMessage = (_tab, _msg, cb) => cb({ ok: false, error: "No element matched selector: #absent" });
  await p.call("dom", { selector: "#absent" });
  assert.equal(p.replies[1].ok, false);
  assert.match(p.replies[1].error, /No element matched/);
  assert.equal(p.commands.length, count);
});

test("a silent debugger attach reports its own timeout", async () => {
  const p = panel();
  p.chrome.debugger.attach = () => {};
  const reading = p.call("snapshot", { tabId: 11 });
  await p.flush();
  await p.expire(5000);
  assert.equal(p.replies.length, 1);
  await reading;
  assert.match(p.replies[0].error, /attach.*11.*timed out/i);
});

test("navigation closing the old page channel falls back to the new document", async () => {
  const p = panel();
  p.chrome.tabs.sendMessage = (_tab, _msg, cb) => {
    p.chrome.runtime.lastError = { message: "The page keeping the extension port is moved into back/forward cache, so the message channel is closed." };
    cb();
    delete p.chrome.runtime.lastError;
  };
  await p.call("dom", { tabId: 11 });
  assert.equal(p.replies[0].ok, true);
  assert.equal(p.replies[0].data.content, "CDP content");
});

test("a late attachment is cleaned up and a new request can attach", async () => {
  const p = panel();
  let complete;
  const attach = p.chrome.debugger.attach;
  p.chrome.debugger.attach = (_tab, _version, cb) => { complete = cb; };
  const reading = p.call("snapshot", { tabId: 11 });
  await p.flush();
  await p.expire(5000);
  await reading;
  complete();
  await p.flush();
  assert.equal(p.detachments.length, 1);
  assert.equal(p.cdpSessions.size, 0);
  assert.equal(p.replies.length, 1);
  p.chrome.debugger.attach = attach;
  await p.call("snapshot", { tabId: 11 });
  assert.equal(p.replies[1].ok, true);
});

test("failed debugger setup is not cached as ready", async () => {
  const p = panel();
  const send = p.chrome.debugger.sendCommand;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method !== "Runtime.enable") send(target, method, args, cb);
  };
  const reading = p.call("snapshot", { tabId: 11 });
  await p.flush();
  await p.expire(5000);
  await reading;
  assert.equal(p.replies[0].ok, false);
  assert.match(p.replies[0].error, /Runtime.enable/);
  assert.equal(p.cdpSessions.size, 0);
  p.chrome.debugger.sendCommand = send;
  await p.call("snapshot", { tabId: 11 });
  assert.equal(p.replies[1].ok, true);
  assert.equal(p.attachments.length, 2);
});

test("a failed fallback preserves the debugger error instead of blaming the helper", async () => {
  const p = panel();
  p.chrome.tabs.sendMessage = () => {};
  p.chrome.debugger.attach = (_tab, _version, cb) => {
    p.chrome.runtime.lastError = { message: "Another debugger is already attached" };
    cb();
    delete p.chrome.runtime.lastError;
  };
  const reading = p.call("dom", { tabId: 11 });
  await p.flush();
  await p.expire(2500);
  await reading;
  assert.equal(p.replies[0].ok, false);
  assert.match(p.replies[0].error, /Another debugger/);
});

test("a timed-out click is not replayed", async () => {
  const p = panel();
  let clicks = 0;
  const send = p.chrome.debugger.sendCommand;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method === "Input.dispatchMouseEvent" && args.type === "mousePressed") { clicks++; return; }
    send(target, method, args, cb);
  };
  const click = p.call("click", { tabId: 11, x: 10, y: 20 });
  await p.flush();
  await p.expire(5000);
  await click;
  assert.equal(p.replies[0].ok, false);
  assert.equal(clicks, 1);
});


test("batch reads and opens preserve the chat working tab", async () => {
  const p = panel();
  p.pinnedTabBySession.set("chat-a", 99);
  await p.call("tab_open", { url: "https://test.invalid/", active: false, preserveWorkingTab: true });
  await p.call("dom", { tabId: 11, preserveWorkingTab: true });
  assert.equal(p.pinnedTabBySession.get("chat-a"), 99);
  await p.call("dom", { tabId: 11 });
  assert.equal(p.pinnedTabBySession.get("chat-a"), 11);
});


test("new tabs stay in the background unless activation is explicit", async () => {
  const p = panel(), opened = [];
  p.chrome.tabs.create = (options, cb) => { opened.push(options); cb({ id: 12, windowId: 1 }); };
  await p.call("tab_open", { url: "https://test.invalid/" });
  await p.call("tab_open", { url: "https://test.invalid/", active: false });
  await p.call("tab_open", { url: "https://test.invalid/", active: true });
  assert.deepEqual(opened.map(o => o.active), [false, false, true]);
  assert.equal(p.pinnedTabBySession.get("chat-a"), 12);
});

test("background input emulates page focus and stays pinned when the user changes tabs", async () => {
  const p = panel(), sent = [], changes = [];
  const send = p.chrome.debugger.sendCommand;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    sent.push({ tabId: target.tabId, method, args });
    send(target, method, args, cb);
  };
  p.chrome.tabs.update = (...args) => changes.push(args);
  p.chrome.windows = { update: (...args) => changes.push(args) };
  await p.call("click", { tabId: 11, x: 10, y: 20 });
  p.chrome.tabs.query = (_q, cb) => cb([{ id: 99, active: true }]);
  await p.call("type", { text: "hello" });
  await p.call("key", { key: "Enter" });
  assert.ok(p.replies.every(r => r.ok));
  assert.ok(sent.every(c => c.tabId === 11));
  const focus = sent.findIndex(c => c.method === "Emulation.setFocusEmulationEnabled");
  assert.equal(sent[focus].args.enabled, true);
  assert.ok(focus < sent.findIndex(c => c.method === "Input.dispatchMouseEvent"));
  assert.ok(sent.some(c => c.method === "Input.insertText"));
  assert.ok(sent.some(c => c.method === "Input.dispatchKeyEvent"));
  assert.deepEqual(changes, []);
});

test("a focus setup failure detaches and never falls back to activating the tab", async () => {
  const p = panel(), send = p.chrome.debugger.sendCommand;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method !== "Emulation.setFocusEmulationEnabled") return send(target, method, args, cb);
    p.chrome.runtime.lastError = { message: "Focus emulation unavailable" };
    cb();
    delete p.chrome.runtime.lastError;
  };
  await p.call("type", { tabId: 11, text: "hello" });
  assert.equal(p.replies[0].ok, false);
  assert.match(p.replies[0].error, /Focus emulation unavailable/);
  assert.equal(p.detachments.length, 1);
  assert.equal(p.commands.includes("Input.insertText"), false);
});

test("an active Studio tab cannot replace the page used by browser tools", async () => {
  const p = panel(), panelURL = "chrome-extension://test/src/panel/panel.html";
  p.chrome.runtime.getURL = () => panelURL;
  p.chrome.tabs.query = (_, cb) => cb([{ id: 80, windowId: 1, url: panelURL + "?mode=tab" }]);
  p.setContextTab(11);
  await p.call("snapshot");
  assert.equal(p.pinnedTabBySession.get("chat-a"), 11);
  assert.equal(p.replies[0].ok, true);
});

const openDialog = (p, type = "beforeunload", tabId = 11) => p.listeners.debuggerEvent({ tabId }, "Page.javascriptDialogOpening", {
  type, message: "Changes may not be saved.", url: "https://test.invalid/", defaultPrompt: type === "prompt" ? "default" : "",
});

test("beforeunload interrupts navigation immediately and can be cancelled without replay", async () => {
  const p = panel(), send = p.chrome.debugger.sendCommand, responses = [];
  let lateNavigation, navigations = 0;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method === "Page.navigate") { navigations++; lateNavigation = cb; openDialog(p); return; }
    if (method === "Page.handleJavaScriptDialog") {
      responses.push(args);
      p.listeners.debuggerEvent(target, "Page.javascriptDialogClosed", { result: args.accept });
    }
    send(target, method, args, cb);
  };
  await p.call("navigate", { url: "https://test.invalid/next" });
  assert.equal(p.replies[0].ok, false);
  assert.match(p.replies[0].error, /BROWSER_DIALOG_OPEN.*browser_handle_dialog/);
  const dialog = p.replies[0].data.dialog;
  assert.equal(dialog.type, "beforeunload");
  assert.equal(p.detachments.length, 0);
  assert.ok([...p.timers].every(t => t.ms === 180000), "no navigation or step timer remains");
  await p.call("dialog", { tabId: 11 });
  assert.equal(p.replies[1].data.dialog.dialogId, dialog.dialogId);
  await p.call("handle_dialog", { tabId: 11, dialogId: dialog.dialogId, accept: false });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].accept, false);
  lateNavigation({});
  await p.flush();
  assert.equal(p.replies.length, 3, "late navigation must not reply twice");
  await p.call("snapshot", { tabId: 11 });
  assert.equal(p.replies[3].ok, true);
  assert.equal(navigations, 1);
  assert.equal(p.attachments.length, 1);
});

test("a dialog during the load wait cancels that wait without reading the blocked page", async () => {
  const p = panel(), send = p.chrome.debugger.sendCommand;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    send(target, method, args, cb);
    if (method === "Page.reload") queueMicrotask(() => openDialog(p));
  };
  await p.call("reload");
  assert.match(p.replies[0].error, /BROWSER_DIALOG_OPEN/);
  assert.equal(p.commands.includes("Runtime.evaluate"), false);
  assert.ok([...p.timers].every(t => t.ms === 180000));
});

test("a dialog interrupts JavaScript and blocks later page actions without detaching", async () => {
  const p = panel(), send = p.chrome.debugger.sendCommand;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method === "Runtime.evaluate") { openDialog(p, "confirm"); return; }
    send(target, method, args, cb);
  };
  await p.call("eval", { expression: "confirm('Continue?')" });
  const commands = p.commands.length;
  for (const op of ["snapshot", "dom", "click", "reload", "tab_close"]) {
    await p.call(op, { tabId: 11, x: 1, y: 1 });
    assert.match(p.replies.at(-1).error, /BROWSER_DIALOG_OPEN/);
  }
  assert.equal(p.commands.length, commands);
  await p.expire(180000);
  assert.equal(p.detachments.length, 0, "idle cleanup must preserve the pending dialog");
});

test("a dialog present during setup can be answered before setup resumes", async () => {
  const p = panel(), send = p.chrome.debugger.sendCommand;
  let first = true;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method === "Page.enable" && first) { first = false; openDialog(p, "alert"); return; }
    send(target, method, args, cb);
  };
  await p.call("dialog");
  const dialog = p.replies[0].data.dialog;
  assert.equal(dialog.type, "alert");
  assert.equal(p.commands.includes("Runtime.enable"), false);
  await p.call("handle_dialog", { tabId: 11, dialogId: dialog.dialogId, accept: true });
  await p.call("snapshot");
  assert.equal(p.replies[2].ok, true);
  assert.equal(p.attachments.length, 1);
  assert.ok(p.commands.includes("Runtime.enable"));
});

test("dialog replies require a current id, explicit tab and boolean decision", async () => {
  const p = panel();
  await p.call("snapshot");
  openDialog(p);
  await p.call("dialog");
  const old = p.replies.at(-1).data.dialog;
  openDialog(p, "confirm");
  await p.call("dialog");
  const dialog = p.replies.at(-1).data.dialog;
  for (const args of [
    { tabId: 11, dialogId: old.dialogId, accept: true },
    { dialogId: dialog.dialogId, accept: true },
    { tabId: 11, dialogId: dialog.dialogId, accept: "false" },
    { tabId: 11, dialogId: dialog.dialogId, accept: true, promptText: "text" },
  ]) {
    await p.call("handle_dialog", args);
    assert.equal(p.replies.at(-1).ok, false);
  }
  assert.equal(p.commands.includes("Page.handleJavaScriptDialog"), false);
});

test("prompt response preserves text and cannot clear a following dialog", async () => {
  const p = panel(), send = p.chrome.debugger.sendCommand;
  await p.call("snapshot");
  openDialog(p, "prompt");
  await p.call("dialog");
  const dialog = p.replies.at(-1).data.dialog;
  assert.equal(dialog.defaultPrompt, "default");
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method === "Page.handleJavaScriptDialog") {
      assert.equal(args.promptText, "Typed value");
      p.listeners.debuggerEvent(target, "Page.javascriptDialogClosed", {});
      openDialog(p, "alert");
    }
    send(target, method, args, cb);
  };
  await p.call("handle_dialog", { tabId: 11, dialogId: dialog.dialogId, accept: true, promptText: "Typed value" });
  assert.equal(p.replies.at(-1).ok, true);
  assert.equal(p.replies.at(-1).data.dialog.type, "alert");
  assert.notEqual(p.replies.at(-1).data.dialog.dialogId, dialog.dialogId);
});

test("a failed dialog response keeps its state and attachment for recovery", async () => {
  const p = panel(), send = p.chrome.debugger.sendCommand;
  await p.call("snapshot");
  openDialog(p);
  await p.call("dialog");
  const dialog = p.replies.at(-1).data.dialog;
  p.chrome.debugger.sendCommand = (target, method, args, cb) => {
    if (method !== "Page.handleJavaScriptDialog") send(target, method, args, cb);
  };
  const handling = p.call("handle_dialog", { tabId: 11, dialogId: dialog.dialogId, accept: false });
  await p.flush();
  await p.expire(5000);
  await handling;
  assert.match(p.replies.at(-1).error, /timed out/);
  assert.equal(p.detachments.length, 0);
  await p.call("dialog");
  assert.equal(p.replies.at(-1).data.dialog.dialogId, dialog.dialogId);
});

test("a dialog blocks only its own tab and a manual response restores reads", async () => {
  const p = panel();
  p.chrome.tabs.get = (id, cb) => cb({ id, windowId: 1, url: "https://test.invalid/", active: false });
  await p.call("snapshot", { tabId: 11 });
  await p.call("snapshot", { tabId: 12 });
  openDialog(p);
  await p.call("snapshot", { tabId: 12 });
  assert.equal(p.replies.at(-1).ok, true);
  p.listeners.debuggerEvent({ tabId: 11 }, "Page.javascriptDialogClosed", {});
  await p.call("snapshot", { tabId: 11 });
  assert.equal(p.replies.at(-1).ok, true);
  await p.call("dialog", { tabId: 11 });
  assert.equal(p.replies.at(-1).data.dialog, null);
});
