import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

test('remote chat changes update the list while preserving the selected chat and message DOM', () => {
  const node = () => ({ removed: false, classList: { toggle() {} }, remove() { this.removed = true; } });
  const messages = node(), removed = node();
  const a = { id: 'a', title: 'A', messagesEl: messages, draft: 'Draft' };
  const scope = { mounted: true, applyingSharedPrefs: false, chats: new Map([['a', a], ['b', { id: 'b', messagesEl: removed }]]),
    activeId: 'a', composerChatId: 'a', order: ['a', 'b'], history: [],
    els: { stack: { appendChild() {} }, input: { value: 'Draft' } },
    makeChat: saved => ({ ...saved, messagesEl: node() }), syncComposer() {}, renderTabs() {}, autosize() {}, clearTimeout,
    setActive() { throw Error('Remote updates must not change the active chat'); } };
  vm.createContext(scope);
  vm.runInContext(section('  function applySharedPrefs(', '  // Remember a folder'), scope);
  scope.applySharedPrefs({ tabs: [{ id: 'a', title: 'Renamed', draft: 'Draft' }, { id: 'c', title: 'New' }], history: [{ id: 'b' }] });
  assert.equal(scope.chats.get('a').messagesEl, messages);
  assert.equal(scope.chats.get('a').title, 'Renamed');
  assert.equal(scope.activeId, 'a');
  assert.equal(scope.els.input.value, 'Draft');
  assert.equal(removed.removed, true);
  assert.ok(scope.chats.has('c'));
  assert.equal(scope.applyingSharedPrefs, false);
});

test('passive rendering cannot post commands or save stale state', () => {
  const scope = { sharedRendering: true, applyingSharedPrefs: false, backgroundRestoring: false,
    port: { postMessage() { throw Error('A passive event repeated a host command'); } },
    prefsSync: { save() { throw Error('A passive event wrote stale preferences'); } } };
  vm.createContext(scope);
  vm.runInContext(section('  function post(obj)', '  // ---- session control') +
    section('  function savePrefs(done)', '  function applySharedPrefs'), scope);
  assert.equal(scope.post({ type: 'prompt', id: 'a' }), true);
  scope.savePrefs();
});

test('an observer never drains a second copy of the prompt queue', () => {
  const scope = { backgroundRestoring: false, deliverPrompt() { throw Error('Duplicate queued prompt'); } };
  vm.createContext(scope);
  vm.runInContext(section('  function dispatchNextQueued(', '  async function deliverPrompt('), scope);
  const chat = { sessionObserver: true, queue: [{ text: 'next' }] };
  scope.dispatchNextQueued(chat);
  assert.equal(chat.queue.length, 1);
});
