import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function page() {
  const listeners = {}, sent = [];
  let text = "", focused = true;
  const document = { activeElement: null, title: "Test page", hasFocus: () => focused,
    addEventListener: (name, fn) => (listeners[name] ||= []).push(fn) };
  const window = { getSelection: () => text, addEventListener: document.addEventListener };
  const sandbox = { window, document, location: { href: "https://example.test/" },
    chrome: { runtime: { sendMessage: async (m) => sent.push(m) } } };
  const source = readFileSync(new URL("../../src/selection.js", import.meta.url), "utf8");
  vm.runInNewContext(source, sandbox);
  return { sent, document, window, reinject: () => vm.runInNewContext(source, sandbox),
    select: (value) => { text = value; }, focus: (value) => { focused = value; },
    fire: (name) => (listeners[name] || []).forEach((fn) => fn()) };
}

test("selection appears, updates and clears synchronously without polling", () => {
  const p = page();
  p.select("  First selection  "); p.fire("selectionchange");
  assert.equal(p.sent.at(-1).selection.text, "First selection");
  p.select("Second"); p.fire("selectionchange");
  assert.equal(p.sent.at(-1).selection.text, "Second");
  const count = p.sent.length; p.fire("pointerup"); assert.equal(p.sent.length, count);
  p.select(""); p.fire("selectionchange"); assert.equal(p.sent.at(-1).selection.text, "");
});

test("input and textarea ranges work; password fields never expose text", () => {
  const p = page();
  p.document.activeElement = { tagName: "INPUT", type: "text", value: "abcdef", selectionStart: 1, selectionEnd: 4 };
  p.fire("select"); assert.equal(p.sent.at(-1).selection.text, "bcd");
  p.document.activeElement.tagName = "TEXTAREA";
  p.document.activeElement.selectionEnd = 5;
  p.fire("keyup"); assert.equal(p.sent.at(-1).selection.text, "bcde");
  p.document.activeElement.tagName = "INPUT"; p.document.activeElement.type = "password";
  p.select("stale page selection"); p.fire("focusin");
  assert.equal(p.sent.at(-1).selection.text, "");
});

test("panel focus keeps a range; pagehide clears it and reinjection adds no listeners", () => {
  const p = page(); p.reinject();
  p.select("Selected"); p.fire("selectionchange");
  assert.equal(p.sent.length, 2);
  p.focus(false); assert.equal(p.window.__rkLiveSelection.read().text, "Selected");
  p.fire("pagehide"); assert.equal(p.sent.at(-1).selection.text, "");
});

test("large selections are bounded and iframe focus belongs to the child", () => {
  const p = page(); p.select("x".repeat(15000)); p.fire("selectionchange");
  assert.equal(p.sent.at(-1).selection.text.length, 14000);
  assert.equal(p.sent.at(-1).selection.truncated, true);
  p.document.activeElement = { tagName: "IFRAME" };
  assert.equal(p.window.__rkLiveSelection.read().focused, false);
});
