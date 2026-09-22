import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const scope = {};
vm.runInNewContext(readFileSync(new URL('../../src/prefs-sync.js', import.meta.url), 'utf8'), scope);
const { diff, merge, createClient, createStore } = scope.StudioPrefsSync;
const clone = value => JSON.parse(JSON.stringify(value));
const initial = { tabs: [{ id: 'a', title: 'A', draft: '' }, { id: 'b', title: 'B', draft: '' }], history: [], activeId: 'a' };

test('concurrent windows merge chat fields and additions without dropping other chats', () => {
  const a = clone(initial), b = clone(initial);
  a.tabs[0].title = 'Renamed';
  b.tabs[0].draft = 'Draft'; b.tabs.push({ id: 'c', title: 'New' });
  const merged = merge(merge(initial, diff(initial, a)), diff(initial, b));
  assert.equal(merged.tabs[0].title, 'Renamed');
  assert.equal(merged.tabs[0].draft, 'Draft');
  assert.deepEqual(Array.from(merged.tabs, t => t.id), ['a', 'b', 'c']);
});

test('an edit from a stale window cannot resurrect a closed chat', () => {
  const closed = clone(initial), stale = clone(initial);
  closed.tabs.shift(); stale.tabs[0].title = 'Late title';
  const merged = merge(merge(initial, diff(initial, closed)), diff(initial, stale));
  assert.deepEqual(Array.from(merged.tabs, t => t.id), ['b']);
});

function environment() {
  let prefs = clone(initial), listener;
  const events = [], writes = [];
  const worker = { runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p,
    onMessage: { addListener(fn) { listener = fn; } } }, storage: { local: {
    get(_, callback) { setImmediate(() => callback({ rkChatV2: clone(prefs) })); },
    set(data, callback) {
      prefs = clone(data.rkChatV2); writes.push(prefs);
      for (const event of events) event({ rkChatV2: { newValue: clone(prefs) } }, 'local');
      callback();
    },
  } } };
  const store = createStore(worker);
  function view() {
    let state = clone(prefs);
    const chrome = { runtime: { sendMessage(msg, reply) {
      listener(msg, { id: 'test', url: 'chrome-extension://test/src/panel/panel.html?mode=tab' }, reply);
    } }, storage: { onChanged: { addListener(fn) { events.push(fn); } } } };
    const client = createClient(chrome, prefs, () => state, value => { state = clone(value); });
    return { get state() { return state; }, save: () => new Promise((resolve, reject) => client.save(state, error => error ? reject(error) : resolve())) };
  }
  return { view, store, get prefs() { return prefs; }, writes, send: (msg, sender, reply) => listener(msg, sender, reply) };
}

test('two mounted views converge after concurrent saves and a worker update', async () => {
  const env = environment(), a = env.view(), b = env.view();
  a.state.tabs[0].title = 'Renamed'; b.state.tabs[1].draft = 'Local draft';
  await Promise.all([a.save(), b.save()]);
  await env.store.update(p => ({ ...p, tabs: p.tabs.map(t => t.id === 'a' ? { ...t, sessionId: 'thread' } : t) }));
  assert.deepEqual(a.state, b.state);
  assert.equal(a.state.tabs[0].title, 'Renamed');
  assert.equal(a.state.tabs[1].draft, 'Local draft');
  assert.equal(a.state.tabs[0].sessionId, 'thread');
});

test('remote list changes preserve an unsaved local draft', async () => {
  const env = environment(), a = env.view(), b = env.view();
  b.state.tabs[0].draft = 'Still typing';
  a.state.tabs.push({ id: 'c', title: 'New chat' }); await a.save();
  assert.equal(b.state.tabs[0].draft, 'Still typing');
  assert.equal(b.state.tabs.length, 3);
  await b.save();
  assert.equal(env.prefs.tabs[0].draft, 'Still typing');
});

test('web pages cannot modify saved chats through the worker', () => {
  const env = environment(); let replied = false;
  assert.equal(env.send({ type: 'studioPrefsPatch', patch: diff(initial, { tabs: [], history: [] }) },
    { id: 'test', url: 'https://untrusted.example' }, () => { replied = true; }), undefined);
  assert.equal(replied, false); assert.equal(env.writes.length, 0);
});
