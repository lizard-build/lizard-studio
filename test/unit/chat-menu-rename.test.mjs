import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  function chatMenuRenameTarget('), source.indexOf('  function finishChatMenuRename('));
function setup() {
  const chat = { id: 'a', title: 'Original', sessionId: 'session-a', cwd: '/project', bookmarkColor: 'violet' };
  const item = { id: 'h', title: 'Closed chat', sessionId: 'session-h', ts: 123 };
  let saves = 0;
  const scope = { chats: new Map([['a', chat]]), history: [item], savePrefs: () => saves++ };
  vm.createContext(scope); vm.runInContext(code, scope);
  return { scope, chat, item, saves: () => saves, open: { open: true, chat }, closed: { open: false, item } };
}

test('an open chat gets a saved custom title without changing its session or bookmark', () => {
  const p = setup(); assert.equal(p.scope.renameChatMenuEntry(p.open, '  New   name\n here '), true);
  assert.equal(p.chat.title, 'New name here'); assert.equal(p.chat.titleEdited, true);
  assert.equal(p.chat.sessionId, 'session-a'); assert.equal(p.chat.cwd, '/project');
  assert.equal(p.chat.bookmarkColor, 'violet'); assert.equal(p.item.title, 'Closed chat'); assert.equal(p.saves(), 1);
});

test('renaming history preserves its session and date and does not open a chat', () => {
  const p = setup(); p.scope.renameChatMenuEntry(p.closed, 'Archive name');
  assert.equal(p.item.title, 'Archive name'); assert.equal(p.item.titleEdited, true);
  assert.equal(p.item.ts, 123); assert.equal(p.item.sessionId, 'session-h'); assert.equal(p.scope.chats.size, 1);
});

test('blank or unchanged names do not replace the title or write again', () => {
  const p = setup(); assert.equal(p.scope.renameChatMenuEntry(p.open, ' \n\t '), false);
  assert.equal(p.chat.title, 'Original'); assert.equal(p.saves(), 0);
  p.scope.renameChatMenuEntry(p.open, 'Custom');
  assert.equal(p.scope.renameChatMenuEntry(p.open, 'Custom'), false); assert.equal(p.saves(), 1);
});

test('closed or deleted targets cannot be renamed through a stale editor', () => {
  const p = setup(); p.scope.chats.delete('a'); p.scope.history.length = 0;
  assert.equal(p.scope.renameChatMenuEntry(p.open, 'Changed'), false);
  assert.equal(p.scope.renameChatMenuEntry(p.closed, 'Changed'), false); assert.equal(p.saves(), 0);
});

test('custom default names stay marked as intentional and markup stays plain text', () => {
  const p = setup(); p.scope.renameChatMenuEntry(p.open, 'New chat');
  assert.equal(p.chat.titleEdited, true);
  p.scope.renameChatMenuEntry(p.open, '<img src=x onerror=alert(1)>');
  assert.equal(p.chat.title, '<img src=x onerror=alert(1)>');
  p.scope.renameChatMenuEntry(p.open, 'x'.repeat(500)); assert.equal(p.chat.title.length, 200);
});
