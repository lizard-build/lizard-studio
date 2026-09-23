import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  function connect() {'), source.indexOf('  // The CLI\'s OAuth', source.indexOf('  function connect() {')));

function panel() {
  const ports = [], received = [], notes = [], ended = [], timers = [];
  const chat = { id: 'a', turnRunning: true, started: true, bashRuns: new Map() };
  const chrome = {
    runtime: { connect() {
      const p = { sent: [], onMessage: { addListener(fn) { p.receive = fn; } },
        onDisconnect: { addListener(fn) { p.disconnect = fn; } }, postMessage(m) { p.sent.push(m); } };
      ports.push(p); return p;
    } },
    windows: { getCurrent: cb => cb({ id: 1 }) },
  };
  const scope = { chrome, window: {}, chats: new Map([['a', chat]]), port: null,
    activeId: "a", reconnectTimer: null, lastTransportError: null, RECONNECT_MS: 1200,
    HARNESSES: [{ id: 'codex' }], harnessReady: {}, harnessChecked: {},
    connected: true, hostReady: true, codexUsage: {}, expectHostRestart: false,
    onHostMessage: msg => received.push(msg), systemNote: (_, text) => notes.push(text),
    endTurn: c => { c.turnRunning = false; ended.push(c.id); },
    reportChatActivity() {}, showOnboarding() {}, failAsyncQuestionSends() {},
    clearTimeout() {}, setTimeout: fn => { timers.push(fn); return timers.length; },
  };
  vm.createContext(scope); vm.runInContext(code, scope);
  return { scope, chrome, ports, received, notes, ended, timers, chat };
}

test('late messages and disconnects from a replaced port cannot stop a live chat', () => {
  const p = panel(); p.scope.connect(); const old = p.ports[0];
  p.scope.connect(); const current = p.ports[1];
  old.receive({ type: 'exit', id: 'a' }); old.disconnect();
  assert.equal(p.scope.port, current);
  assert.equal(p.scope.connected, true);
  assert.equal(p.chat.turnRunning, true);
  assert.deepEqual(p.received, []);
  assert.deepEqual(p.notes, []);
  assert.deepEqual(p.ended, []);
  assert.equal(p.timers.length, 0);
  current.receive({ type: 'event', id: 'a' });
  assert.equal(p.received.length, 1);
});

test('a current disconnect still ends the turn and passes its reason to the next worker', () => {
  const p = panel(); p.scope.connect();
  p.chrome.runtime.lastError = { message: 'Extension context invalidated.' };
  p.ports[0].disconnect(); delete p.chrome.runtime.lastError;
  assert.equal(p.scope.connected, false);
  assert.deepEqual(p.ended, ['a']);
  assert.equal(p.timers.length, 1);
  p.timers[0]();
  assert.equal(p.ports[1].sent[0].previousDisconnect, 'Extension context invalidated.');
  assert.equal(p.scope.lastTransportError, null);
  assert.equal(p.ports[1].sent[0].type, 'attach');
  assert.ok(!p.ports[1].sent.some(m => m.type === 'prompt'));
});
