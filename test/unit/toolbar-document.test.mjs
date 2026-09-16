import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
const core = read('core.js'), toolbar = read('toolbar.js'), main = read('main.js');
function page(contentType) {
  const listeners = [], writes = [], timers = [];
  const document = {
    contentType, visibilityState: 'visible', title: 'Asset',
    documentElement: { outerHTML: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    createElement() { throw new Error('Attempted to build HTML controls in an XML document'); },
    addEventListener() {},
  };
  const window = { addEventListener() {}, getSelection: () => '' };
  const scope = { window, document, navigator: { platform: 'MacIntel' },
    location: { href: 'https://example.test/admin-favicon.svg' },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    chrome: {
      runtime: { id: 'test-extension', onMessage: { addListener: fn => listeners.push(fn) } },
      storage: { local: {
        get: (key, cb) => cb({ [key]: key === 'rk.ui' ? { visible: true, minimized: false } : null }),
        set: value => writes.push(value),
      }, onChanged: { addListener() {} } },
    },
  };
  vm.createContext(scope);
  for (const source of [core, toolbar, main]) vm.runInContext(source, scope);
  return { scope, listeners, writes, timers, reinject: () => vm.runInContext(main, scope) };
}

for (const type of ['image/svg+xml', 'application/xml', 'text/xml', 'application/xhtml+xml']) {
  test(`toolbar restore and show/toggle messages skip ${type}, while context still works`, async () => {
    const p = page(type);
    await Promise.resolve(); // restored preferences call toolbar.show asynchronously
    for (const msg of ['RK_SHOW_TOOLBAR', 'RK_TOGGLE_TOOLBAR', 'RK_SHOW_TOOLBAR', 'RK_HIDE_TOOLBAR']) {
      p.listeners.forEach(fn => fn({ type: msg }));
    }
    const RK = p.scope.window.RK;
    assert.equal(RK.overlay, null);
    assert.equal(RK.state.visible, false);
    assert.equal(p.timers.length, 0); // no change to the saved visibility preference
    assert.equal(p.writes.length, 0);
    let response;
    p.listeners.forEach(fn => fn({ type: 'RK_PAGE_CONTEXT', format: 'html' }, {}, value => { response = value; }));
    assert.equal(response.ok, true);
    assert.equal(response.html, p.scope.document.documentElement.outerHTML);
    assert.equal(response.url, p.scope.location.href);
    const listenerCount = p.listeners.length;
    p.reinject(); assert.equal(p.listeners.length, listenerCount);
  });
}

test('HTML toolbar still opens and saves its visible state', () => {
  const start = toolbar.indexOf('    show() {') + '    show() {'.length;
  const end = toolbar.indexOf('\n    },', start);
  const called = [];
  const RK = { alive: () => true, ensureOverlay: () => called.push('overlay'),
    state: { visible: false, minimized: false }, persistUI: () => called.push('save') };
  vm.runInNewContext(`(() => { ${toolbar.slice(start, end)} })()`, {
    RK, document: { contentType: 'text/html' }, root: null,
    build: () => called.push('build'), restore: () => called.push('restore'), minimize() {},
  });
  assert.equal(RK.state.visible, true);
  assert.deepEqual(called, ['overlay', 'build', 'restore', 'save']);
});
