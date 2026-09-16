import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('  function moveOpenChat('), source.indexOf('  function reopenFromHistory('));
function node(tag, cls = '') {
  const classes = new Set(cls.split(' ').filter(Boolean));
  return {
    tag, children: [], dataset: {}, listeners: {},
    classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x) },
    appendChild(child) { this.children.push(child); },
    setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    getBoundingClientRect: () => ({ top: 100, height: 40 }),
    contains: () => false, focus() {}, closest: () => null,
  };
}
function setup() {
  const list = node('div'); list.querySelectorAll = () => list.children;
  const saved = [], tabOrders = [];
  let menuRenders = 0;
  const scope = {
    order: ['a', 'b', 'c', 'd'], chats: new Map(['a','b','c','d'].map(id => [id, { id }])),
    history: [{ id: 'old', title: 'Old chat', ts: 10 }], activeId: 'b', chatMenuDragId: null,
    els: { chatMenuList: list }, BOOKMARK_COLORS: [],
    el: node, ICON: () => '', tabDotWaiting: () => false, tabDotRunning: () => false, relTime: () => '',
    renderTabs: () => tabOrders.push([...scope.order]), savePrefs: () => saved.push([...scope.order]),
    renderChatMenuList: () => { menuRenders++; },
  };
  vm.createContext(scope); vm.runInContext(helpers, scope);
  const row = (id, open = true) => {
    const entry = { open, title: id, ...(open ? { chat: scope.chats.get(id) } : { item: scope.history[0] }) };
    const r = scope.chatMenuRow(entry); list.children.push(r); return r;
  };
  return { scope, row, saved, tabOrders, menuRenders: () => menuRenders };
}
function dragEvent(y) {
  return { clientY: y, dataTransfer: { setData() {} }, preventDefault() { this.prevented = true; } };
}

test('only Active rows can be dragged or accept a reorder', () => {
  const p = setup(), active = p.row('a'), history = p.row('old', false);
  assert.equal(active.draggable, true);
  assert.equal(typeof active.listeners.drop, 'function');
  assert.equal(history.draggable, undefined);
  assert.equal(history.listeners.drop, undefined);
  assert.equal(history.listeners.keydown, undefined);
});

test('dropping an Active chat changes tab order and saved order without selecting it or changing history', () => {
  const p = setup(), a = p.row('a'), c = p.row('c');
  a.listeners.dragstart(dragEvent());
  const hover = dragEvent(135); c.listeners.dragover(hover);
  assert.equal(hover.prevented, true); assert.equal(c.classList.contains('drop-after'), true);
  c.listeners.drop(dragEvent(135));
  assert.deepEqual([...p.scope.order], ['b', 'c', 'a', 'd']);
  assert.deepEqual(p.tabOrders.at(-1), p.saved.at(-1));
  assert.deepEqual(p.saved.at(-1), ['b', 'c', 'a', 'd']);
  assert.equal(p.scope.activeId, 'b'); assert.equal(p.scope.history[0].id, 'old');
  assert.equal(p.scope.chatMenuDragId, null); assert.equal(p.menuRenders(), 1);
});

test('moving before a filtered target preserves hidden chats and persists once', () => {
  const p = setup(), d = p.row('d'), b = p.row('b');
  d.listeners.dragstart(dragEvent()); b.listeners.drop(dragEvent(101));
  assert.deepEqual([...p.scope.order], ['a', 'd', 'b', 'c']);
  assert.equal(p.saved.length, 1);
});

test('cancelled drags, same-slot drops and closed chats do not change order', () => {
  const p = setup(), a = p.row('a');
  a.listeners.dragstart(dragEvent()); a.listeners.dragend();
  assert.equal(p.scope.chatMenuDragId, null); assert.equal(p.saved.length, 0);
  assert.equal(p.scope.moveOpenChat('a', 'b', false), false);
  assert.equal(p.scope.moveOpenChat('a', 'a', true), false);
  p.scope.chats.delete('d'); assert.equal(p.scope.moveOpenChat('a', 'd', true), false);
  assert.equal(p.scope.moveOpenChat('a', 'old', false), false);
  assert.deepEqual([...p.scope.order], ['a', 'b', 'c', 'd']); assert.equal(p.saved.length, 0);
});

test('the close button cannot start a drag and Alt+arrow uses the same saved tab order', () => {
  const p = setup(), b = p.row('b');
  b.listeners.mousedown({ target: { closest: () => ({}) } });
  const drag = dragEvent(); b.listeners.dragstart(drag);
  assert.equal(drag.prevented, true); assert.equal(p.scope.chatMenuDragId, null);
  b.listeners.keydown({ target: b, altKey: true, key: 'ArrowDown', preventDefault() {} });
  assert.deepEqual([...p.scope.order], ['a', 'c', 'b', 'd']); assert.equal(p.saved.length, 1);
});
