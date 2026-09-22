import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const start = source.indexOf('  function updateEmptyMark()');
const code = source.slice(start, source.indexOf('  // ---- git branch chip', start));
function visible(overrides = {}) {
  let hidden;
  const chat = { empty: true, turnRunning: false, messagesEl: { children: [] }, ...overrides };
  const scope = { chats: new Map([['active', chat]]), activeId: 'active',
    els: { emptyMark: { classList: { toggle: (_, value) => { hidden = value; } } } } };
  vm.runInNewContext(code + '\nupdateEmptyMark();', scope);
  return !hidden;
}

test('a new empty chat shows its logo', () => {
  assert.equal(visible(), true);
});

test('an empty restored transcript shows its logo despite hidden history navigation', () => {
  const historyNav = { hidden: true };
  assert.equal(visible({ empty: false, historyLoaded: true, historyNav,
    messagesEl: { children: [historyNav] } }), true);
});

test('messages, queued bubbles and shell output hide the empty-chat logo', () => {
  for (const type of ['message', 'queued', 'shell']) {
    assert.equal(visible({ messagesEl: { children: [{ type }] } }), false);
  }
});

test('running turns and unresolved history never display an empty-chat logo', () => {
  for (const state of [{ turnRunning: true }, { empty: false }, { historyRequest: {} },
    { historyError: true }, { historyCursor: 'more' }]) {
    assert.equal(visible(state), false);
  }
  const historyNav = { hidden: false };
  assert.equal(visible({ historyNav, messagesEl: { children: [historyNav] } }), false);
});
