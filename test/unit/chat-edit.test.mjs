import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/panel/chat.js", import.meta.url), "utf8");
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function setup(harness = "codex") {
  let focused, accepts = true;
  const sent = [], notes = [], replaced = [];
  function el(tag, classes = "", text = "") {
    const names = new Set(classes.split(" ")), listeners = new Map();
    return {
      tag, textContent: text, children: [], dataset: {}, style: {}, scrollHeight: 60, value: "",
      classList: { add: c => names.add(c), remove: c => names.delete(c), contains: c => names.has(c) },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      append(...children) { children.forEach(child => this.appendChild(child)); },
      setAttribute(key, value) { this[key] = value; },
      addEventListener(type, fn) { listeners.set(type, fn); },
      fire(type, extra = {}) { listeners.get(type)?.({ preventDefault() {}, target: { closest: () => null }, ...extra }); },
      focus() { focused = this; }, setSelectionRange() {},
      set disabled(value) { this._disabled = value; if (value && focused === this) this.fire("blur"); },
      get disabled() { return !!this._disabled; },
      replaceWith(node) { const parent = this.parentNode; parent.children[parent.children.indexOf(this)] = node; node.parentNode = parent; this.parentNode = null; },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; },
      querySelector(selector) { return this.children.find(c => c.classList.contains(selector.slice(1))) || null; },
    };
  }
  const bubble = el("div", "bubble"), row = el("div"), messagesEl = el("div");
  bubble.appendChild(el("div", "md", "Original")); row.appendChild(bubble); messagesEl.appendChild(row);
  row.dataset.turnIndex = "1";
  row.codexEdit = { text: "Original", turnId: "turn", itemId: "user", attachments: [] };
  const chat = { id: "chat", harness, messagesEl, queue: [] };
  const scope = {
    el, window: { getSelection: () => "" }, R: { markdown: text => el("div", "md", text) }, newId: () => "request",
    post: msg => { sent.push(msg); return accepts; },
    systemNote: (_, text) => notes.push(text), endTurn: () => { chat.turnRunning = false; },
    historyNav() {}, touchChat() {}, savePrefs() {},
    resendEdited: (...args) => replaced.push(args),
  };
  vm.createContext(scope);
  vm.runInContext(section("  function wireCodexEdit(", "  // Click the message text") +
    section("  function wireEditableBubble(", "  // Truncates the rendered transcript"), scope);
  if (harness === "codex") scope.wireCodexEdit(chat, row);
  else scope.wireEditableBubble(chat, bubble, 1, "Original", []);
  bubble.fire("click");
  return { chat, row, bubble, sent, notes, replaced, input: bubble.querySelector(".msg-edit"),
    finish: msg => scope.finishCodexEdit(chat, { requestId: "request", ...msg }),
    disconnect: () => { accepts = false; }, focused: () => focused };
}

for (const harness of ["codex", "claude"]) {
  test(`${harness} edits inline with no extra controls and Shift+Enter keeps editing`, () => {
    const p = setup(harness);
    assert.deepEqual(p.row.children.map(c => c.tag), ["div"]);
    assert.deepEqual(p.bubble.children.map(c => c.tag), ["textarea"]);
    p.input.value = "Changed\ntext";
    p.input.fire("keydown", { key: "Enter", shiftKey: true });
    assert.equal(p.sent.length, 0); assert.equal(p.replaced.length, 0);
    assert.equal(p.input.value, "Changed\ntext");
    assert.equal(p.bubble.classList.contains("editing"), true);
  });

  for (const cancel of ["Escape", "blur", "empty"]) {
    test(`${harness} cancels an edit on ${cancel}`, () => {
      const p = setup(harness); p.input.value = cancel === "empty" ? "  " : "Unsent";
      if (cancel === "blur") p.input.fire("blur");
      else p.input.fire("keydown", { key: cancel === "empty" ? "Enter" : cancel });
      assert.equal(p.sent.length, 0); assert.equal(p.replaced.length, 0);
      assert.equal(p.bubble.querySelector(".md").textContent, "Original");
      assert.equal(p.bubble.classList.contains("editing"), false);
    });
  }
}

test("Codex keeps the draft while pending, ignores duplicate Enter, and allows retry after failure", () => {
  const p = setup(); p.input.value = "Changed";
  p.input.fire("keydown", { key: "Enter", isComposing: true });
  assert.equal(p.sent.length, 0);
  p.input.fire("keydown", { key: "Enter" });
  p.input.fire("keydown", { key: "Enter" });
  p.input.fire("keydown", { key: "Escape" });
  assert.equal(p.sent.length, 1); assert.equal(p.replaced.length, 0);
  assert.equal(p.input.disabled, true);
  assert.equal(p.bubble.querySelector(".msg-edit"), p.input);
  assert.equal(p.sent[0].turnId, "turn"); assert.equal(p.sent[0].text, "Changed");
  p.finish({ ok: false, error: "Try again" });
  assert.equal(p.input.disabled, false); assert.equal(p.input.value, "Changed");
  assert.equal(p.focused(), p.input); assert.equal(p.chat.rewindPending, null);
  p.input.fire("keydown", { key: "Enter" });
  assert.equal(p.sent.length, 2);
});

test("Codex keeps a disconnected edit ready to retry", () => {
  const p = setup(); p.disconnect(); p.input.value = "Keep this";
  p.input.fire("keydown", { key: "Enter" });
  assert.equal(p.input.value, "Keep this"); assert.equal(p.input.disabled, false);
  assert.equal(p.replaced.length, 0); assert.match(p.notes[0], /disconnected/);
});

test("a confirmed edit keeps the server cursor when all loaded messages were replaced", () => {
  const p = setup(); p.chat.historyCursor = { kind: "turns", value: "old" };
  p.input.value = "Changed"; p.input.fire("keydown", { key: "Enter" });
  const cursor = { kind: "turns", value: "retained" };
  p.finish({ ok: true, historyCursor: cursor });
  assert.equal(p.chat.historyCursor, cursor);
  assert.equal(p.replaced.length, 1); assert.equal(p.replaced[0][2], "Changed");
});
