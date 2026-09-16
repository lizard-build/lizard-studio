import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  function chatMenuIsOpen('), source.indexOf('  // Open tabs come first'));
const element = (props = {}) => {
  const classes = new Set(), styles = new Map();
  return { nodeType: 1, scrollWidth: 400, clientWidth: 400, overflowX: 'visible', matches: () => false,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    style: { setProperty: (k, v) => styles.set(k, v), removeProperty: k => styles.delete(k), getPropertyValue: k => styles.get(k) },
    setAttribute(k, v) { this[k] = v; }, ...props };
};
function setup() {
  const root = element(), body = element(), shell = element(), menu = element(), guard = element();
  let time = 0, timerId = 0, width = 400, rendered = 0, visualOffset;
  const timers = new Map(), document = { body, activeElement: body };
  const search = element({ menuChild: true, focus() { document.activeElement = this; } });
  const menuBtn = element({ focus() { document.activeElement = this; } });
  menu.contains = node => node === menu || !!node.menuChild;
  menu.querySelector = () => ({ getBoundingClientRect: () => ({ width }) });
  menu.classList.add('hidden'); guard.classList.add('hidden');
  const offset = () => root.classList.contains('chat-menu-swiping')
    ? Number(root.style.getPropertyValue('--chat-menu-progress')) * width
    : visualOffset ?? (shell.classList.contains('pushed') ? width : 0);
  const scope = {
    document, getComputedStyle: node => ({ overflowX: node.overflowX, transform: node === shell ? String(offset()) : 'none' }),
    DOMMatrixReadOnly: class { constructor(value) { this.m41 = Number(value); } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    els: { chatMenu: menu, chatShell: shell, chatMenuGuard: guard, chatMenuList: {}, chatMenuSearch: search, menuBtn },
    chatMenuDragId: null, chatMenuRename: null, chatMenuWheelReset: null, chatMenuHideTimer: null,
    reducedMotion: { matches: false }, MENU_SLIDE_MS: 340, HISTORY_PAGE_SIZE: 40, historyVisibleLimit: 40,
    menuRegistry: [], menuFilter: '', renderChatMenuList: () => rendered++, finishChatMenuRename() {}, finishChatMenuDrag() {},
  };
  vm.createContext(scope); vm.runInContext(code, scope);
  const handler = scope.createChatMenuWheelHandler(root);
  const advance = ms => {
    const end = time + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    time = end;
  };
  return {
    scope, root, body, shell, menu, guard, search, document, advance, offset,
    width: value => { width = value; }, visualOffset: value => { visualOffset = value; },
    wheel(x, y = 0, opts = {}) {
      advance(opts.pause ?? 16);
      const event = { deltaX: x, deltaY: y, deltaMode: 0, timeStamp: time,
        composedPath: () => [body, root], preventDefault() { this.defaultPrevented = true; }, ...opts };
      handler(event); return event;
    },
    state: () => ({ open: scope.chatMenuIsOpen(), swiping: root.classList.contains('chat-menu-swiping'), rendered }),
  };
}

test('trackpad follows each frame in both directions and snaps only after idle', () => {
  const p = setup();
  p.wheel(-20); assert.equal(p.offset(), 20); assert.equal(p.state().swiping, true);
  assert.notEqual(p.document.activeElement, p.search);
  p.wheel(-60); assert.equal(p.offset(), 80);
  p.advance(119); assert.equal(p.offset(), 80);
  p.advance(1); assert.equal(p.offset(), 400); assert.equal(p.state().swiping, false);
  assert.equal(p.document.activeElement, p.search); assert.equal(p.shell.inert, true);
  p.wheel(30); assert.equal(p.offset(), 370);
  p.wheel(60); assert.equal(p.offset(), 310);
  p.advance(120); assert.equal(p.state().open, false); assert.equal(p.shell.inert, false);
  p.advance(340); assert.equal(p.menu.classList.contains('hidden'), true);
  assert.equal(p.state().rendered, 1);
});

test('small slow motion cancels, while a short fast flick finishes the slide', () => {
  const p = setup();
  for (let i = 0; i < 10; i++) p.wheel(-8, 0, { pause: 32 });
  assert.ok(Math.abs(p.offset() - 80) < 0.01);
  p.advance(120); assert.equal(p.state().open, false);
  p.wheel(-70); p.advance(120); assert.equal(p.state().open, true);
});

test('direction changes move immediately and can cancel either opening or closing', () => {
  const p = setup();
  p.wheel(-180); p.wheel(150); assert.ok(Math.abs(p.offset() - 30) < 0.01);
  p.advance(120); assert.equal(p.state().open, false);
  p.scope.openChatMenu(); p.advance(121);
  p.wheel(180); p.wheel(-150); assert.ok(Math.abs(p.offset() - 370) < 0.01);
  p.advance(120); assert.equal(p.state().open, true);
});

test('momentum stays clamped at the endpoint and tiny rebounds do not toggle it', () => {
  const p = setup(); p.wheel(-450);
  for (const x of [-80, -40, -10, 1, -1, 0.3]) p.wheel(x);
  assert.ok(p.offset() > 399 && p.offset() <= 400);
  p.advance(120); assert.equal(p.state().open, true);
  p.wheel(450);
  for (const x of [80, 40, 10, -1, 1, -0.3]) p.wheel(x);
  assert.ok(p.offset() < 1 && p.offset() >= 0);
  p.advance(120); assert.equal(p.state().open, false);
});

test('small initial diagonal noise does not lock out a horizontal gesture', () => {
  const p = setup(); p.wheel(-1, 2); assert.equal(p.state().swiping, false);
  p.wheel(-25, 3); assert.equal(p.offset(), 26);
  p.wheel(-25, 50); assert.equal(p.offset(), 51); // ownership stays horizontal
});

test('vertical scroll, zoom, wrong direction and controls cannot open the menu', () => {
  for (const [x, y, opts] of [[0, 100, {}], [-30, 40, {}], [-100, 0, { ctrlKey: true }], [-100, 0, { metaKey: true }], [100, 0, {}], [-100, 0, { defaultPrevented: true }]]) {
    const p = setup(); const e = p.wheel(x, y, opts); p.wheel(-100);
    assert.equal(p.state().open, false); assert.equal(p.state().rendered, 0);
    assert.equal(e.defaultPrevented, opts.defaultPrevented);
    p.wheel(-100, 0, { pause: 121 }); p.advance(120); assert.equal(p.state().open, true);
  }
  for (const selector of ['input', 'textarea', 'select', 'contenteditable', 'slider', 'dialog']) {
    const p = setup(), control = element({ matches: value => selector === 'dialog' ? value.startsWith('dialog') : value.startsWith('input') });
    const e = p.wheel(-100, 0, { composedPath: () => [control, p.root] });
    assert.equal(e.defaultPrevented, undefined); assert.equal(p.state().open, false);
  }
});

test('nested scrollers own the entire burst at both edges, including shadow content', () => {
  for (const scrollLeft of [0, 600]) {
    const p = setup(), scroller = element({ scrollWidth: 1000, overflowX: 'auto', scrollLeft });
    const e = p.wheel(-100, 0, { composedPath: () => [p.body, { nodeType: 11 }, scroller, p.root] });
    assert.equal(e.defaultPrevented, undefined);
    p.wheel(-100); assert.equal(p.state().open, false);
    p.wheel(-100, 0, { pause: 121 }); p.advance(120); assert.equal(p.state().open, true);
    p.wheel(100, 0, { composedPath: () => [scroller, p.root] }); p.advance(120);
    assert.equal(p.state().open, true);
  }
});

test('ownership persists when the moving shell exposes a control under the pointer', () => {
  const p = setup(); p.wheel(-20);
  const control = element({ matches: value => value.startsWith('input') });
  assert.equal(p.wheel(-30, 0, { composedPath: () => [control, p.root] }).defaultPrevented, true);
  assert.equal(p.offset(), 50);
});

test('fitting content, clipped labels, line/page deltas and Shift+wheel work', () => {
  for (const overflowX of ['auto', 'hidden', 'clip']) {
    const p = setup(), label = element({ overflowX, scrollWidth: overflowX === 'auto' ? 400 : 900 });
    p.wheel(-80, 0, { composedPath: () => [label, p.root] }); assert.equal(p.offset(), 80);
  }
  for (const [x, y, opts, expected] of [[-4, 0, { deltaMode: 1 }, 64], [-1, 0, { deltaMode: 2 }, 400], [0, -80, { shiftKey: true }, 80]]) {
    const p = setup(); p.wheel(x, y, opts); assert.equal(p.offset(), expected);
    p.advance(120); assert.equal(p.state().open, true);
  }
});

test('manual close cancels a swipe and its pending snap, including reduced motion', () => {
  for (const reduced of [false, true]) {
    const p = setup(); p.scope.reducedMotion.matches = reduced; p.wheel(-300);
    p.scope.closeChatMenu(); p.advance(500);
    assert.equal(p.state().open, false); assert.equal(p.state().swiping, false);
    assert.equal(p.root.style.getPropertyValue('--chat-menu-progress'), undefined);
    assert.equal(p.guard.classList.contains('hidden'), true);
    assert.equal(p.menu.classList.contains('hidden'), true);
    assert.equal(p.shell.inert, false);
  }
});

test('a new swipe picks up an unfinished snap at its visual position', () => {
  const p = setup(); p.scope.openChatMenu(); p.visualOffset(150);
  p.wheel(25); assert.equal(p.offset(), 125);
  p.width(200); assert.equal(p.offset(), 62.5); // resize preserves the fraction
  p.wheel(25); assert.equal(p.offset(), 37.5);
});

test('chat dragging or title editing prevents menu gestures', () => {
  for (const prop of ['chatMenuDragId', 'chatMenuRename']) {
    const p = setup(); p.scope[prop] = 'a'; p.wheel(-100); assert.equal(p.state().open, false);
    p.scope[prop] = null; p.wheel(-100, 0, { pause: 121 }); assert.equal(p.offset(), 100);
  }
});
