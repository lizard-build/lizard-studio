import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const start = source.indexOf('  function updateSetup()');
const code = source.slice(start, source.indexOf('  // ---- git branch chip', start));
function visibility(overrides = {}) {
  let hidden, setupHidden;
  const chat = { empty: true, turnRunning: false, messagesEl: { children: [] }, ...overrides };
  const scope = { chats: new Map([['active', chat]]), activeId: 'active',
    els: { setup: { classList: { toggle: (_, value) => { setupHidden = value; } } }, emptyMark: { classList: { toggle: (_, value) => { hidden = value; } } } } };
  vm.runInNewContext(code + '\nupdateSetup();', scope);
  return { logo: !hidden, setup: !setupHidden };
}

function visible(overrides) { return visibility(overrides).logo; }

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


test('project and agent selectors appear for a restored empty chat', () => {
  const historyNav = { hidden: true };
  assert.deepEqual(visibility({ empty: false, historyLoaded: true, historyNav,
    messagesEl: { children: [historyNav] } }), { logo: true, setup: true });
});

test('project and agent selectors stay hidden for existing or unresolved conversations', () => {
  for (const state of [{}, { historyRequest: {} }, { historyError: true },
    { historyLoaded: true, messagesEl: { children: [{}] } },
    { historyLoaded: true, sessionFailure: {} }]) {
    assert.equal(visibility({ empty: false, ...state }).setup, false);
  }
});
