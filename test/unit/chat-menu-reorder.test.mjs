import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('  function moveOpenChat('), source.indexOf('  function reopenFromHistory('));
function node(tag, cls = '') {
  const classes = new Set(cls.split(' ').filter(Boolean));
  return {
    tag, children: [], dataset: {}, listeners: {}, style: {}, isConnected: true,
    setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {},
    classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x) },
    appendChild(child) { this.children.push(child); },
    setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    getBoundingClientRect: () => ({ top: 100, height: 40 }),
    contains: () => false, focus() {}, closest: () => null,
  };
}
function setup() {
  const list = node('div'); list.querySelectorAll = () => list.children.filter(n => n.dataset.chatId);
  list.scrollTop = 0; list.clientHeight = 400;
  list.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
  const events = {}, frames = new Map(); let nextFrame = 0;
  const eventTarget = { addEventListener: (type, fn) => { events[type] = fn; }, removeEventListener: type => { delete events[type]; } };
  const saved = [], tabOrders = [];
  let menuRenders = 0;
  const scope = {
    order: ['a', 'b', 'c', 'd'], chats: new Map(['a','b','c','d'].map(id => [id, { id }])),
    history: [{ id: 'old', title: 'Old chat', ts: 10 }], activeId: 'b', chatMenuDragId: null, chatMenuDragFinish: null,
    document: eventTarget, window: eventTarget,
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id),
    els: { chatMenuList: list }, BOOKMARK_COLORS: [],
    el: node, ICON: () => '', tabDotWaiting: () => false, tabDotRunning: () => false, relTime: () => '',
    renderTabs: () => tabOrders.push([...scope.order]), savePrefs: () => saved.push([...scope.order]),
    renderChatMenuList: () => { menuRenders++; },
  };
  vm.createContext(scope); vm.runInContext(helpers, scope);
  const row = (id, open = true) => {
    const entry = { open, title: id, ...(open ? { chat: scope.chats.get(id) } : { item: scope.history[0] }) };
    const r = scope.chatMenuRow(entry); const top = list.children.length * 42;
    r.getBoundingClientRect = () => ({ top, height: 40 });
    list.children.push(r); return r;
  };
  return { scope, row, saved, tabOrders, events, frames, list, menuRenders: () => menuRenders };
}
function pointer(y, target = { closest: () => null }) {
  return { clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, target,
    preventDefault() { this.prevented = true; } };
}

test('only Active rows support pointer reordering; browser drag ghosts are disabled', () => {
  const p = setup(), active = p.row('a'), history = p.row('old', false);
  assert.equal(typeof active.listeners.pointerdown, 'function');
  assert.equal(active.draggable, undefined);
  assert.equal(history.listeners.pointerdown, undefined);
  assert.equal(history.listeners.keydown, undefined);
  const event = pointer(0); active.listeners.dragstart(event); assert.equal(event.prevented, true);
});

test('crossing a row moves tabs immediately, animates neighbors, and saves only on release', () => {
  const p = setup(), a = p.row('a'); p.row('b'); const c = p.row('c'); p.row('d');
  a.listeners.pointerdown(pointer(20));
  p.events.pointermove(pointer(108));
  assert.deepEqual([...p.scope.order], ['b', 'c', 'a', 'd']);
  assert.deepEqual(p.tabOrders.at(-1), ['b', 'c', 'a', 'd']);
  assert.equal(p.saved.length, 0);
  assert.equal(c.style.transform, 'translateY(-42px)');
  assert.equal(p.scope.activeId, 'b'); assert.equal(p.scope.history[0].id, 'old');
  p.events.pointerup(pointer(108));
  assert.deepEqual(p.saved.at(-1), ['b', 'c', 'a', 'd']);
  assert.equal(p.scope.chatMenuDragId, null); assert.equal(p.frames.size, 0);
  assert.equal(p.events.pointermove, undefined);
});

test('moving back over a row restores its slot before release without jitter', () => {
  const p = setup(), a = p.row('a'); p.row('b'); p.row('c');
  a.listeners.pointerdown(pointer(20)); p.events.pointermove(pointer(108));
  p.events.pointermove(pointer(25));
  assert.deepEqual([...p.scope.order], ['a', 'b', 'c', 'd']);
  p.events.pointermove(pointer(25)); assert.equal(p.tabOrders.length, 2);
  p.events.pointerup(pointer(25));
});

test('Escape restores and saves the original order, preserving chats added mid-drag', () => {
  const p = setup(), a = p.row('a'); p.row('b'); p.row('c');
  a.listeners.pointerdown(pointer(20)); p.events.pointermove(pointer(108));
  p.scope.order.push('new'); p.scope.chats.set('new', { id: 'new' });
  p.events.keydown({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  assert.deepEqual([...p.scope.order], ['a', 'b', 'c', 'd', 'new']);
  assert.deepEqual(p.saved.at(-1), ['a', 'b', 'c', 'd', 'new']);
  assert.equal(p.scope.chatMenuDragId, null);
});

test('filtered moves preserve hidden chats, and history cannot become a target', () => {
  const p = setup(), b = p.row('b'), d = p.row('d'); p.row('old', false);
  d.listeners.pointerdown(pointer(62)); p.events.pointermove(pointer(0));
  assert.deepEqual([...p.scope.order], ['a', 'd', 'b', 'c']);
  p.events.pointerup(pointer(0)); assert.equal(p.saved.length, 1);
  assert.equal(p.scope.moveOpenChat('a', 'old', false), false);
});

test('clicks, close buttons, tiny movements and secondary pointers do not reorder', () => {
  const p = setup(), a = p.row('a'); p.row('b');
  a.listeners.pointerdown(pointer(20, { closest: () => ({}) })); assert.equal(p.events.pointermove, undefined);
  a.listeners.pointerdown(pointer(20)); p.events.pointermove({ ...pointer(100), pointerId: 2 });
  p.events.pointermove(pointer(22)); p.events.pointerup(pointer(22));
  assert.equal(p.saved.length, 0); assert.equal(p.scope.chatMenuDragId, null);
  assert.deepEqual([...p.scope.order], ['a', 'b', 'c', 'd']);
});

test('pointer cancellation restores order and Alt+arrow still uses the shared order', () => {
  const p = setup(), a = p.row('a'), b = p.row('b');
  a.listeners.pointerdown(pointer(20)); p.events.pointermove(pointer(65)); p.events.pointercancel();
  assert.deepEqual([...p.scope.order], ['a', 'b', 'c', 'd']);
  b.listeners.keydown({ target: b, altKey: true, key: 'ArrowDown', preventDefault() {} });
  assert.deepEqual([...p.scope.order], ['a', 'c', 'b', 'd']);
});

test('edge scrolling moves through Active rows and stops when the gesture ends', () => {
  const p = setup(), a = p.row('a'); p.row('b'); p.row('c'); p.row('d'); p.row('old', false);
  p.list.clientHeight = 80; p.list.getBoundingClientRect = () => ({ top: 0, bottom: 80 });
  a.listeners.pointerdown(pointer(20)); p.events.pointermove(pointer(78));
  const [id, frame] = p.frames.entries().next().value; p.frames.delete(id); frame(16);
  assert.ok(p.list.scrollTop > 0); assert.ok(p.list.scrollTop <= 86);
  p.events.pointerup(pointer(78)); assert.equal(p.frames.size, 0);
  assert.equal(p.scope.history[0].id, 'old');
});

test('a chat closed during the drag stays closed when the gesture cancels', () => {
  const p = setup(), a = p.row('a'); p.row('b'); p.row('c');
  a.listeners.pointerdown(pointer(20)); p.events.pointermove(pointer(108));
  p.scope.chats.delete('a'); p.scope.order = p.scope.order.filter(id => id !== 'a');
  const [id, frame] = p.frames.entries().next().value; p.frames.delete(id); frame(16);
  assert.deepEqual([...p.scope.order], ['b', 'c', 'd']);
  assert.equal(p.scope.chatMenuDragId, null); assert.equal(p.frames.size, 0);
});
