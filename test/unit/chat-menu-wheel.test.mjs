import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  function chatMenuIsOpen('), source.indexOf('  // Open tabs come first'));
function element(props = {}) {
  const classes = new Set(), listeners = {};
  return { nodeType: 1, scrollWidth: 400, clientWidth: 400, scrollLeft: 0, overflowX: 'visible',
    style: {}, matches: () => false,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    setAttribute(k, v) { this[k] = v; },
    addEventListener(k, fn) { listeners[k] = fn; },
    fire(k, event) { listeners[k]?.(event); }, ...props };
}
function setup() {
  const viewport = element(), body = element(), shell = element(), menu = element(), guard = element();
  let time = 0, width = 400, resize, rendered = 0;
  const requests = [], document = { body, activeElement: body };
  const search = element({ menuChild: true, focus() { document.activeElement = this; } });
  const menuBtn = element({ focus() { document.activeElement = this; } });
  menu.contains = node => node === menu || !!node.menuChild;
  menu.getBoundingClientRect = () => ({ width });
  guard.classList.add('hidden');
  viewport.scrollTo = args => {
    requests.push(args);
    if (args.behavior === 'instant') viewport.scrollLeft = args.left;
  };
  const scope = {
    document, getComputedStyle: node => ({ overflowX: node.overflowX }),
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} },
    els: { chatMenu: menu, chatShell: shell, chatMenuGuard: guard, chatMenuList: {}, chatMenuSearch: search, menuBtn },
    chatMenuScroller: null, chatMenuMoving: false, chatMenuRenderPending: false, chatMenuDragId: null, chatMenuRename: null,
    reducedMotion: { matches: false }, HISTORY_PAGE_SIZE: 40, historyVisibleLimit: 40,
    menuRegistry: [], menuFilter: '', renderChatMenuList: () => rendered++, finishChatMenuRename() {}, finishChatMenuDrag() {},
    // Any JS animation/release timer is a regression: Chrome owns this gesture.
    setTimeout() { throw Error('Native menu must not infer release from time'); },
    requestAnimationFrame() { throw Error('Native menu must not animate scroll with JS'); },
  };
  vm.createContext(scope); vm.runInContext(code, scope);
  scope.chatMenuScroller = scope.setupChatMenuScroller(viewport);
  viewport.fire('scrollend');
  return {
    scope, viewport, body, shell, menu, guard, search, menuBtn, document, requests,
    resize: value => { width = value; resize(); },
    scroll(left, end = false) { viewport.scrollLeft = left; viewport.fire('scroll'); if (end) viewport.fire('scrollend'); },
    wheel(x, y = 0, opts = {}) {
      time += opts.pause ?? 16;
      const event = { deltaX: x, deltaY: y, timeStamp: time, composedPath: () => [body, viewport],
        preventDefault() { this.defaultPrevented = true; }, ...opts };
      scope.chatMenuScroller.onWheel(event); return event;
    },
    state: () => ({ open: scope.chatMenuIsOpen(), moving: scope.chatMenuMoving, rendered }),
  };
}

test('mount starts closed at the native chat snap position', () => {
  const p = setup();
  assert.equal(p.viewport.scrollLeft, 400);
  assert.equal(p.viewport.classList.contains('ready'), true);
  assert.equal(p.shell.inert, false); assert.equal(p.menu.inert, true);
  assert.equal(p.menu['aria-hidden'], 'true'); assert.equal(p.menuBtn['aria-expanded'], 'false');
});

test('wheel deltas, shrinking speeds and long pauses never write positions or infer release', () => {
  const p = setup(), writes = p.requests.length;
  p.scroll(280);
  for (const [x, pause] of [[-60, 16], [-30, 16], [-15, 16], [-5, 16], [-1, 1000], [20, 16]]) {
    const event = p.wheel(x, 0, { pause });
    assert.equal(event.defaultPrevented, undefined);
    assert.equal(p.viewport.scrollLeft, 280);
  }
  assert.equal(p.requests.length, writes);
  assert.equal(p.state().moving, true); // only a native scrollend can finish
  assert.deepEqual(p.shell.style, {}); assert.deepEqual(p.guard.style, {});
});

test('scrollend commits open and closed states and restores interaction', () => {
  const p = setup(); p.scroll(220);
  assert.equal(p.shell.inert, true); assert.equal(p.menu.inert, false);
  assert.equal(p.guard.classList.contains('hidden'), false);
  assert.equal(p.state().moving, true);
  p.scroll(0, true); assert.equal(p.state().open, true); assert.equal(p.state().moving, false);
  p.search.focus(); p.scroll(400, true);
  assert.equal(p.state().open, false); assert.equal(p.shell.inert, false); assert.equal(p.menu.inert, true);
  assert.equal(p.document.activeElement, p.menuBtn); assert.equal(p.guard.classList.contains('hidden'), true);
});

test('buttons use native smooth scroll, with focus after completion and immediate reduced motion', () => {
  const p = setup(); p.scope.openChatMenu();
  assert.equal(p.requests.at(-1).left, 0); assert.equal(p.requests.at(-1).behavior, 'smooth');
  assert.notEqual(p.document.activeElement, p.search);
  p.scroll(0, true); assert.equal(p.document.activeElement, p.search);
  p.scope.closeChatMenu(); assert.equal(p.requests.at(-1).left, 400);
  p.scroll(400, true); p.scope.reducedMotion.matches = true; p.scope.openChatMenu();
  assert.equal(p.requests.at(-1).behavior, 'instant');
});

test('an immediate second click cancels a pending opening at its first frame', () => {
  const p = setup(); p.scope.toggleChatMenu(); p.scope.toggleChatMenu();
  assert.equal(p.requests.at(-1).left, 400); assert.equal(p.requests.at(-1).behavior, 'instant');
  assert.equal(p.state().open, false); assert.equal(p.state().moving, false);
});

test('nested horizontal scrollers keep the whole gesture at either edge', () => {
  for (const [scrollLeft, x] of [[0, -100], [600, 100]]) {
    const p = setup(), scroller = element({ scrollWidth: 1000, overflowX: 'auto', scrollLeft });
    const event = p.wheel(x, 0, { composedPath: () => [p.body, { nodeType: 11 }, scroller, p.viewport] });
    assert.equal(event.defaultPrevented, true);
    assert.equal(scroller.style.overscrollBehaviorX, 'contain');
    assert.equal(p.wheel(-100).defaultPrevented, true); // pointer leaving must not transfer the tail
    assert.equal(p.viewport.scrollLeft, 400); assert.equal(p.state().open, false);
    assert.equal(p.wheel(-100, 0, { pause: 200 }).defaultPrevented, undefined);
  }
});

test('scroll inside a nested code block remains native until its edge', () => {
  const p = setup(), scroller = element({ scrollWidth: 1000, overflowX: 'scroll', scrollLeft: 200 });
  assert.equal(p.wheel(-100, 0, { composedPath: () => [scroller, p.viewport] }).defaultPrevented, undefined);
  assert.equal(p.state().open, false);
  scroller.scrollLeft = 0;
  assert.equal(p.wheel(-100, 0, { composedPath: () => [scroller, p.viewport] }).defaultPrevented, true);
});

test('controls, editing and chat reordering cannot start menu scrolling', () => {
  const p = setup(), control = element({ matches: value => value.startsWith('input') });
  assert.equal(p.wheel(-100, 0, { composedPath: () => [control, p.viewport] }).defaultPrevented, true);
  for (const prop of ['chatMenuDragId', 'chatMenuRename']) {
    p.scope[prop] = 'active';
    assert.equal(p.wheel(-100, 0, { pause: 200 }).defaultPrevented, true);
    p.scope[prop] = null;
  }
  assert.equal(p.state().open, false);
});

test('vertical scrolling and zoom are left to the browser', () => {
  const p = setup();
  for (const opts of [{}, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(p.wheel(opts.ctrlKey ? -40 : 0, 100, opts).defaultPrevented, undefined);
  }
  assert.equal(p.state().open, false);
});

test('resize keeps a settled endpoint but never writes during a held gesture', () => {
  const p = setup(); p.resize(260); assert.equal(p.viewport.scrollLeft, 260);
  p.scroll(0, true); p.resize(400); assert.equal(p.viewport.scrollLeft, 0);
  p.scroll(150); const writes = p.requests.length; p.resize(260);
  assert.equal(p.requests.length, writes); assert.equal(p.viewport.scrollLeft, 150);
});

test('pending list updates wait for native scrollend and are flushed once', () => {
  const p = setup(); p.scroll(100); const count = p.state().rendered;
  p.scope.chatMenuRenderPending = true;
  p.wheel(-10); p.wheel(-5, 0, { pause: 1000 });
  assert.equal(p.state().rendered, count);
  p.scroll(0, true); assert.equal(p.state().rendered, count + 1);
  p.viewport.fire('scrollend'); assert.equal(p.state().rendered, count + 1);
});

test('wheel events without native movement never reveal the menu or disable the chat', () => {
  const p = setup();
  for (const [x, y] of [[-1, 120], [-2, 0], [-60, 0]]) p.wheel(x, y);
  assert.equal(p.state().open, false); assert.equal(p.shell.inert, false);
  assert.equal(p.state().rendered, 0);
});

test('a nested scroller finishing cannot end an active menu gesture', () => {
  const p = setup(); p.scroll(180);
  p.viewport.fire('scrollend', { target: element() });
  assert.equal(p.state().moving, true);
  p.scroll(0, true); assert.equal(p.state().moving, false);
});
