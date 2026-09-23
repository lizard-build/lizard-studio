import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/panel/startup.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../../src/panel/panel.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup({ complete = false, viewportReady = true } = {}) {
  const nodes = new Map(), events = new Map(), timers = new Map(), resources = [], reports = [];
  let reloads = 0, nextTimer = 0, mutation;
  for (const id of ['panel-startup', 'panel-startup-message', 'panel-startup-retry']) {
    nodes.set(id, { hidden: id.endsWith('retry'), addEventListener(type, fn) { this[type] = fn; } });
  }
  const viewport = { classList: { contains: () => viewportReady } };
  nodes.set('chat-menu-viewport', viewport);
  const scope = {
    document: {
      readyState: complete ? 'complete' : 'loading',
      getElementById: id => nodes.get(id), createElement: tag => ({ tag }),
      head: { appendChild: node => resources.push(node) },
    },
    window: {
      addEventListener: (type, fn) => events.set(type, fn),
      removeEventListener: type => events.delete(type),
    },
    performance: { now: () => 25, timeOrigin: 1000 }, console: { warn: (...args) => reports.push(args) },
    location: { reload: () => reloads++ },
    setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    MutationObserver: class {
      constructor(fn) { mutation = fn; }
      observe() {} disconnect() { mutation = null; }
    },
  };
  vm.runInNewContext(source, scope);
  return {
    nodes, events, timers, resources, reports, scope, api: scope.window.RKPanelStartup,
    get reloads() { return reloads; },
    tick(delay) { for (const [id, timer] of timers) if (timer.delay === delay) { timers.delete(id); timer.fn(); } },
    measured() { viewportReady = true; mutation?.(); },
    async loaded() { resources.at(-1).onload(); await flush(); },
  };
}

test('full UI resources start in a new task after the document load event', async () => {
  const p = setup();
  assert.equal(p.resources.length, 0);
  p.events.get('load')();
  assert.equal(p.resources.length, 0);
  p.tick(0);
  assert.equal(p.resources[0].href, 'panel.css');
  await p.loaded();
  assert.equal(p.resources[1].src, 'window-mode.js');
  await p.loaded();
  assert.equal(p.resources[2].src, 'icons.js');
  await p.loaded();
  assert.equal(p.resources[3].src, 'render.js');
  assert.equal(p.nodes.get('panel-startup').hidden, false);
});

test('slow loading keeps the screen and offers retry without reloading or skipping restoration', async () => {
  const p = setup({ complete: true }); p.tick(0); p.tick(10000);
  assert.equal(p.nodes.get('panel-startup-retry').hidden, false);
  assert.match(p.nodes.get('panel-startup-message').textContent, /longer/);
  assert.equal(p.reloads, 0);
  await p.loaded();
  assert.equal(p.resources.at(-1).src, 'window-mode.js');
  p.api.ready();
  assert.equal(p.nodes.get('panel-startup').hidden, true);
  assert.equal(p.reloads, 0);
});

test('a failed stylesheet does not mount a broken UI and retry needs an explicit click', async () => {
  const p = setup({ complete: true }); p.tick(0);
  p.resources[0].onerror(); await flush();
  assert.equal(p.resources.length, 1);
  assert.match(p.nodes.get('panel-startup-message').textContent, /Couldn't open/);
  p.api.ready();
  assert.equal(p.nodes.get('panel-startup').hidden, false);
  assert.equal(p.reloads, 0);
  p.nodes.get('panel-startup-retry').click(); assert.equal(p.reloads, 1);
});

test('startup errors and rejected restoration remain visible instead of leaving a blank panel', () => {
  for (const type of ['error', 'unhandledrejection']) {
    const p = setup();
    p.events.get(type)({ error: new Error('restore failed'), reason: 'restore failed' });
    assert.equal(p.nodes.get('panel-startup-retry').hidden, false);
    p.tick(10000); p.api.ready();
    assert.equal(p.nodes.get('panel-startup').hidden, false);
    assert.match(p.nodes.get('panel-startup-message').textContent, /Couldn't open/);
    assert.equal(p.reports.length, 1);
  }
});

test('a panel mounted at zero width waits for layout without requiring animation frames', () => {
  const p = setup({ viewportReady: false }); p.api.ready();
  assert.equal(p.nodes.get('panel-startup').hidden, false);
  p.measured();
  assert.equal(p.nodes.get('panel-startup').hidden, true);
  assert.equal(p.events.has('error'), false);
  assert.equal(p.events.has('unhandledrejection'), false);
  p.tick(10000); assert.equal(p.nodes.get('panel-startup-retry').hidden, true);
});

test('startup diagnostics distinguish pending resources from restoration and return a copy', async () => {
  const p = setup({ complete: true }); p.tick(0);
  assert.equal(p.api.snapshot().stage, 'styles');
  assert.equal(p.api.snapshot().timings['panel.css:loaded'], undefined);
  await p.loaded();
  assert.equal(p.api.snapshot().timings['panel.css:loaded'], 25);
  p.api.mark('saved-chats');
  const snapshot = p.api.snapshot();
  assert.equal(snapshot.stage, 'saved-chats');
  assert.equal(snapshot.timeOrigin, 1000);
  assert.equal(snapshot.finished, false);
  snapshot.timings.document = -1;
  assert.equal(p.api.snapshot().timings.document, 25);
  p.api.ready();
  assert.equal(p.api.snapshot().stage, 'ready');
  assert.equal(p.api.snapshot().finished, true);
});

function shell({ broken = false } = {}) {
  let restored, activated = 0, ready = 0, bridge = 0, failed = 0;
  const scope = {
    chrome: {
      runtime: { id: 'test', getURL: path => path, connect() { bridge++; return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; } },
      windows: { getCurrent: cb => cb({ id: 1 }) },
    },
    document: { getElementById: () => ({ replaceWith() {} }), createElement: () => ({}) },
    window: {
      addEventListener() {},
      RKPanelStartup: { mark() {}, ready() { ready++; }, fail() { failed++; } },
      RKChat: { mount(root, cb) { if (broken) throw new Error('mount failed'); restored = cb; }, activate() { activated++; } },
    },
    setInterval() {}, setTimeout() {},
  };
  vm.runInNewContext(panel, scope);
  return { state: () => ({ activated, ready, bridge, failed }), restore: () => restored() };
}

test('host activation waits for restored chats while the panel can already close through its bridge', () => {
  const p = shell();
  assert.deepEqual(p.state(), { activated: 0, ready: 0, bridge: 1, failed: 0 });
  p.restore();
  assert.deepEqual(p.state(), { activated: 1, ready: 1, bridge: 1, failed: 0 });
});

test('mount failure leaves the background bridge alive and reports the startup failure', () => {
  assert.deepEqual(shell({ broken: true }).state(), { activated: 0, ready: 0, bridge: 1, failed: 1 });
});
