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
  let time = 0, timerId = 0, width = 400, rendered = 0, visualOffset, resize;
  let geometryReads = 0, styleReads = 0;
  const timers = new Map(), document = { body, activeElement: body };
  const search = element({ menuChild: true, focus() { document.activeElement = this; } });
  const menuBtn = element({ focus() { document.activeElement = this; } });
  menu.contains = node => node === menu || !!node.menuChild;
  menu.querySelector = () => ({ getBoundingClientRect: () => { geometryReads++; return { width }; } });
  menu.classList.add('hidden'); guard.classList.add('hidden');
  const offset = () => shell.style.transform
    ? Number(shell.style.transform.match(/translate3d\(([-.\d]+)px/)[1])
    : visualOffset ?? (shell.classList.contains('pushed') ? width : 0);
  // Direct property assignment and removeProperty share the same declaration.
  for (const node of [shell, guard]) node.style.removeProperty = key => { delete node.style[key]; };
  const scope = {
    document, getComputedStyle: node => { styleReads++; return { overflowX: node.overflowX, transform: node === shell ? String(offset()) : 'none' }; },
    performance: { now: () => time },
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} },
    requestAnimationFrame(fn) { const id = ++timerId; timers.set(id, { fn: () => fn(time), at: (Math.floor(time / 16) + 1) * 16 }); return id; },
    cancelAnimationFrame: id => timers.delete(id),
    DOMMatrixReadOnly: class { constructor(value) { this.m41 = Number(value); } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    els: { chatMenu: menu, chatShell: shell, chatMenuGuard: guard, chatMenuList: {}, chatMenuSearch: search, menuBtn },
    chatMenuMoving: false, chatMenuRenderPending: false, chatMenuDragId: null, chatMenuRename: null, chatMenuWheelReset: null, chatMenuHideTimer: null,
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
    width: value => { width = value; resize(); },
    reads: () => ({ geometryReads, styleReads }),
    draw: () => advance(16), done: () => advance(600), visualOffset: value => { visualOffset = value; },
    wheel(x, y = 0, opts = {}) {
      advance(opts.pause ?? 16);
      const event = { deltaX: x, deltaY: y, deltaMode: 0, timeStamp: time,
        composedPath: () => [body, root], preventDefault() { this.defaultPrevented = true; }, ...opts };
      handler(event); return event;
    },
    state: () => ({ open: scope.chatMenuIsOpen(), swiping: root.classList.contains('chat-menu-swiping'), rendered }),
  };
}

test('wheel input is coalesced into one paint per frame, without layout reads while moving', () => {
  const p = setup();
  p.wheel(-20); const initial = p.reads();
  for (let i = 0; i < 10; i++) p.wheel(-2, 0, { pause: 0 });
  assert.equal(p.offset(), 0); // input updates state; the compositor gets one write
  assert.deepEqual(p.reads(), initial);
  p.draw(); assert.equal(p.offset(), 40);
  assert.deepEqual(p.reads(), initial);
  assert.equal(p.guard.style.transform, p.shell.style.transform);
  assert.notEqual(p.document.activeElement, p.search);
  p.done(); assert.equal(p.state().open, true); assert.equal(p.state().swiping, false);
  assert.equal(p.document.activeElement, p.search);
});

test('opening and closing settle smoothly, then restore focus and interaction', () => {
  const p = setup(); p.wheel(-80); p.draw(); assert.equal(p.offset(), 80);
  p.advance(110); assert.ok(p.offset() > 80 && p.offset() < 400);
  p.done(); assert.equal(p.offset(), 400); assert.equal(p.shell.inert, true);
  p.wheel(90); p.draw(); assert.equal(p.offset(), 310);
  p.done(); assert.equal(p.state().open, false); assert.equal(p.shell.inert, false);
  assert.equal(p.menu.classList.contains('hidden'), true);
  assert.equal(p.state().rendered, 1);
});

test('slow short drags cancel, while short fast flicks finish the slide', () => {
  const p = setup();
  for (let i = 0; i < 10; i++) p.wheel(-8, 0, { pause: 32 });
  p.draw(); assert.equal(p.offset(), 80);
  p.done(); assert.equal(p.state().open, false);
  p.wheel(-70); p.done(); assert.equal(p.state().open, true);
});

test('direction changes follow the next frame and can cancel in either direction', () => {
  const p = setup(); p.wheel(-180); p.wheel(150); p.draw(); assert.equal(p.offset(), 30);
  p.done(); assert.equal(p.state().open, false);
  p.scope.openChatMenu(); p.advance(200);
  p.wheel(180); p.wheel(-150); p.draw(); assert.equal(p.offset(), 370);
  p.done(); assert.equal(p.state().open, true);
});

test('a shrinking macOS momentum tail starts settling before wheel events stop', () => {
  const p = setup();
  for (const x of [-60, -40, -25, -12]) p.wheel(x);
  p.draw(); const released = p.offset();
  assert.ok(released >= 137);
  for (const x of [-6, -3, -1, -0.5, -0.1]) p.wheel(x);
  p.draw(); assert.ok(p.offset() > 200); // spring is moving, not just adding the tail
  p.done(); assert.equal(p.state().open, true);
});

test('momentum and tiny rebounds at an endpoint do not start another gesture', () => {
  const p = setup(); p.wheel(-450); p.draw(); assert.equal(p.offset(), 400);
  const reads = p.reads();
  for (const x of [-80, -40, -10, 1, -1, 0.3]) p.wheel(x);
  p.done(); assert.equal(p.state().open, true); assert.deepEqual(p.reads(), reads);
  p.wheel(450); p.draw();
  for (const x of [80, 40, 10, -1, 1, -0.3]) p.wheel(x);
  p.done(); assert.equal(p.state().open, false);
});

test('a deliberate reversal can grab a settling spring without waiting for a burst timeout', () => {
  const p = setup();
  for (const x of [-60, -40, -25, -12]) p.wheel(x);
  p.draw(); const x = p.offset();
  p.wheel(20, 0, { pause: 0 }); p.draw();
  assert.ok(Math.abs(p.offset() - (x - 20)) < 0.01);
  p.wheel(50); p.done(); assert.equal(p.state().open, false);
});

test('small initial diagonal noise does not lock out a horizontal gesture', () => {
  const p = setup(); p.wheel(-1, 2); assert.equal(p.state().swiping, false);
  p.wheel(-25, 3); p.draw(); assert.equal(p.offset(), 26);
  p.wheel(-25, 50); p.draw(); assert.equal(p.offset(), 51);
});

test('vertical scroll, zoom and controls cannot open the menu', () => {
  for (const [x, y, opts] of [[0, 100, {}], [-30, 40, {}], [-100, 0, { ctrlKey: true }], [-100, 0, { metaKey: true }], [-100, 0, { defaultPrevented: true }]]) {
    const p = setup(); const e = p.wheel(x, y, opts); p.wheel(-100);
    assert.equal(p.state().open, false); assert.equal(p.state().rendered, 0);
    assert.equal(e.defaultPrevented, opts.defaultPrevented);
    p.wheel(-100, 0, { pause: 200 }); p.done(); assert.equal(p.state().open, true);
  }
  for (const selector of ['input', 'textarea', 'select', 'contenteditable', 'slider', 'dialog']) {
    const p = setup(), control = element({ matches: value => selector === 'dialog' ? value.startsWith('dialog') : value.startsWith('input') });
    const e = p.wheel(-100, 0, { composedPath: () => [control, p.root] });
    assert.equal(e.defaultPrevented, undefined); assert.equal(p.state().open, false);
  }
});

test('wrong-direction input at a closed edge does not build the list or prevent a reversal', () => {
  const p = setup(); assert.equal(p.wheel(100).defaultPrevented, undefined);
  assert.equal(p.state().rendered, 0);
  p.wheel(-50); p.draw(); assert.equal(p.offset(), 50);
});

test('nested scrollers own the whole burst at both edges, including shadow content', () => {
  for (const scrollLeft of [0, 600]) {
    const p = setup(), scroller = element({ scrollWidth: 1000, overflowX: 'auto', scrollLeft });
    const e = p.wheel(-100, 0, { composedPath: () => [p.body, { nodeType: 11 }, scroller, p.root] });
    assert.equal(e.defaultPrevented, undefined);
    p.wheel(-100); assert.equal(p.state().open, false);
    p.wheel(-100, 0, { pause: 200 }); p.done(); assert.equal(p.state().open, true);
    p.wheel(100, 0, { composedPath: () => [scroller, p.root] }); p.done();
    assert.equal(p.state().open, true);
  }
});

test('ownership persists when motion exposes a control under the pointer', () => {
  const p = setup(); p.wheel(-20);
  const control = element({ matches: value => value.startsWith('input') });
  assert.equal(p.wheel(-30, 0, { composedPath: () => [control, p.root] }).defaultPrevented, true);
  p.draw(); assert.equal(p.offset(), 50);
});

test('fitting content, clipped labels, line/page deltas and Shift+wheel work', () => {
  for (const overflowX of ['auto', 'hidden', 'clip']) {
    const p = setup(), label = element({ overflowX, scrollWidth: overflowX === 'auto' ? 400 : 900 });
    p.wheel(-80, 0, { composedPath: () => [label, p.root] }); p.draw(); assert.equal(p.offset(), 80);
  }
  for (const [x, y, opts, expected] of [[-4, 0, { deltaMode: 1 }, 64], [-1, 0, { deltaMode: 2 }, 400], [0, -80, { shiftKey: true }, 80]]) {
    const p = setup(); p.wheel(x, y, opts); p.draw(); assert.equal(p.offset(), expected);
    p.done(); assert.equal(p.state().open, true);
  }
});

test('manual close cancels queued frames and snaps, including reduced motion', () => {
  for (const reduced of [false, true]) {
    const p = setup(); p.scope.reducedMotion.matches = reduced; p.wheel(-300);
    p.scope.closeChatMenu(); p.done();
    assert.equal(p.state().open, false); assert.equal(p.state().swiping, false);
    assert.equal(p.shell.style.transform, undefined); assert.equal(p.guard.style.transform, undefined);
    assert.equal(p.guard.classList.contains('hidden'), true);
    assert.equal(p.menu.classList.contains('hidden'), true); assert.equal(p.shell.inert, false);
  }
});

test('a swipe interrupts a button animation at its visual position and follows resize', () => {
  const p = setup(); p.scope.openChatMenu(); p.visualOffset(150);
  p.wheel(25); p.draw(); assert.equal(p.offset(), 125);
  p.width(200); p.draw(); assert.equal(p.offset(), 62.5);
  p.wheel(25); p.draw(); assert.equal(p.offset(), 37.5);
});

test('pending live list updates render once after motion ends', () => {
  const p = setup(); p.wheel(-80); p.scope.chatMenuRenderPending = true;
  const rendered = p.state().rendered;
  p.draw(); assert.equal(p.state().rendered, rendered);
  p.done(); assert.equal(p.state().rendered, rendered + 1);
});

test('chat dragging or title editing prevents menu gestures', () => {
  for (const prop of ['chatMenuDragId', 'chatMenuRename']) {
    const p = setup(); p.scope[prop] = 'a'; p.wheel(-100); assert.equal(p.state().open, false);
    p.scope[prop] = null; p.wheel(-100, 0, { pause: 200 }); p.draw(); assert.equal(p.offset(), 100);
  }
});

test('a frame timestamp before the input timestamp cannot move an endpoint backwards', () => {
  const p = setup(); p.scope.performance.now = () => 1000;
  p.wheel(-450); p.draw(); assert.equal(p.offset(), 400);
  p.draw(); assert.equal(p.offset(), 400); assert.equal(p.state().swiping, false);
});
