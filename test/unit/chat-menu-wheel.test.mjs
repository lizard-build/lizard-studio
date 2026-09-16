import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  function chatMenuWheelHasScroller('), source.indexOf('  function toggleChatMenu()'));
const element = (props = {}) => ({ nodeType: 1, scrollWidth: 300, clientWidth: 300, overflowX: 'visible', matches: () => false, ...props });
function setup() {
  const root = element({ clientWidth: 400 }), body = element();
  let open = false, opened = 0, closed = 0, time = 0;
  const scope = {
    getComputedStyle: node => ({ overflowX: node.overflowX }),
    els: { chatMenu: { contains: node => !!node.menuDialog } }, chatMenuDragId: null,
    chatMenuIsOpen: () => open,
    openChatMenu: () => { open = true; opened++; }, closeChatMenu: () => { open = false; closed++; },
  };
  vm.createContext(scope); vm.runInContext(code, scope);
  const handler = scope.createChatMenuWheelHandler(root);
  return {
    scope, root, body,
    wheel(x, y = 0, opts = {}) {
      time += opts.pause || 16;
      const event = { deltaX: x, deltaY: y, deltaMode: 0, timeStamp: time,
        composedPath: () => [body, root], preventDefault() { this.defaultPrevented = true; }, ...opts };
      handler(event); return event;
    },
    state: () => ({ open, opened, closed }),
  };
}

test('horizontal wheel opens and closes with a threshold and one toggle per gesture', () => {
  const p = setup();
  p.wheel(-25); assert.equal(p.state().open, false);
  p.wheel(-40); assert.equal(p.state().opened, 1);
  p.wheel(-80); p.wheel(100); assert.deepEqual(p.state(), { open: true, opened: 1, closed: 0 });
  p.wheel(70, 0, { pause: 300 }); assert.deepEqual(p.state(), { open: false, opened: 1, closed: 1 });
  p.wheel(-100); assert.equal(p.state().opened, 1);
});

test('vertical scroll, diagonal jitter, zoom, and a wrong-direction gesture cannot toggle', () => {
  for (const [x, y, opts] of [[0, 100, {}], [-30, 40, {}], [-100, 0, { ctrlKey: true }], [-100, 0, { metaKey: true }], [100, 0, {}], [-100, 0, { defaultPrevented: true }]]) {
    const p = setup(); p.wheel(x, y, opts); p.wheel(-100);
    assert.equal(p.state().open, false);
    p.wheel(-100, 0, { pause: 300 }); assert.equal(p.state().open, true);
  }
});

test('scrollable ancestors own the entire gesture at both edges, including nested and shadow content', () => {
  for (const scrollLeft of [0, 600]) {
    const p = setup(), scroller = element({ scrollWidth: 900, overflowX: 'auto', scrollLeft });
    const e = p.wheel(-100, 0, { composedPath: () => [p.body, { nodeType: 11 }, scroller, p.root] });
    assert.equal(e.defaultPrevented, undefined);
    p.wheel(-100); assert.equal(p.state().open, false);
    p.wheel(-100, 0, { pause: 300 }); assert.equal(p.state().open, true);
  }
});

test('fitting content and clipped labels allow the gesture but controls and other dialogs do not', () => {
  for (const overflowX of ['auto', 'hidden', 'clip']) {
    const p = setup(), label = element({ overflowX, scrollWidth: overflowX === 'auto' ? 300 : 900 });
    p.wheel(-80, 0, { composedPath: () => [label, p.root] }); assert.equal(p.state().open, true);
  }
  for (const selector of ['input', 'textarea', 'select', '[contenteditable]', '[role=slider]', 'dialog']) {
    const p = setup(), control = element({ matches: value => selector === 'dialog' ? value.startsWith('dialog') : value.startsWith('input') });
    const e = p.wheel(-100, 0, { composedPath: () => [control, p.root] });
    assert.equal(e.defaultPrevented, undefined); assert.equal(p.state().open, false);
  }
  const p = setup(), menu = element({ menuDialog: true, matches: value => value.startsWith('dialog') });
  p.wheel(-80); p.wheel(80, 0, { pause: 300, composedPath: () => [menu, p.root] });
  assert.equal(p.state().closed, 1);
});

test('line/page deltas and Shift+wheel work, and separate small gestures do not accumulate', () => {
  for (const [x, y, opts] of [[-4, 0, { deltaMode: 1 }], [-1, 0, { deltaMode: 2 }], [0, -80, { shiftKey: true }]]) {
    const p = setup(); p.wheel(x, y, opts); assert.equal(p.state().opened, 1);
  }
  const p = setup(); p.wheel(-35); p.wheel(-35, 0, { pause: 300 }); assert.equal(p.state().open, false);
  p.wheel(-30); assert.equal(p.state().open, true);
});

test('dragging a chat prevents menu gestures and nested scrollers can also keep the menu open', () => {
  const p = setup(); p.scope.chatMenuDragId = 'a'; p.wheel(-100); assert.equal(p.state().open, false);
  p.scope.chatMenuDragId = null; p.wheel(-100, 0, { pause: 300 });
  const scroller = element({ scrollWidth: 900, overflowX: 'scroll' });
  p.wheel(100, 0, { pause: 300, composedPath: () => [p.body, scroller, p.root] });
  assert.equal(p.state().open, true);
});
