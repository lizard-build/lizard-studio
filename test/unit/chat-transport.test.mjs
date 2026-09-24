import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  function connect() {'), source.indexOf('  // The CLI\'s OAuth', source.indexOf('  function connect() {')));

function panel() {
  const ports = [], received = [], notes = [], ended = [], timers = [], onboarding = [];
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
    activeId: "a", reconnectTimer: null, onboardingReconnectTimer: null,
    agentCheckTimer: null, hadReadyHost: true,
    lastTransportError: null, RECONNECT_MS: 1200,
    HARNESSES: [{ id: 'codex' }], harnessReady: {}, harnessChecked: {},
    connected: true, hostReady: true, codexUsage: {}, expectHostRestart: false,
    onHostMessage: msg => received.push(msg), systemNote: (_, text) => notes.push(text),
    endTurn: c => { c.turnRunning = false; ended.push(c.id); },
    reportChatActivity() {}, showOnboarding: () => onboarding.push(true),
    hideOnboarding() {}, failAsyncQuestionSends() {},
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].active = false; },
    setTimeout(fn, ms) { timers.push({ fn, ms, active: true }); return timers.length; },
  };
  vm.createContext(scope); vm.runInContext(code, scope);
  return { scope, chrome, ports, received, notes, ended, timers, onboarding, chat,
    tick(ms) { for (const timer of timers) if (timer.active && timer.ms === ms) { timer.active = false; timer.fn(); } } };
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

test('a current disconnect keeps the turn and passes its reason to the next worker', () => {
  const p = panel(); p.scope.connect();
  p.chrome.runtime.lastError = { message: 'Extension context invalidated.' };
  p.ports[0].disconnect(); delete p.chrome.runtime.lastError;
  assert.equal(p.scope.connected, false);
  assert.deepEqual(p.ended, []);
  assert.equal(p.chat.turnRunning, true);
  assert.equal(p.onboarding.length, 0);
  p.tick(1200);
  assert.equal(p.ports[1].sent[0].previousDisconnect, 'Extension context invalidated.');
  assert.equal(p.scope.lastTransportError, null);
  assert.equal(p.ports[1].sent[0].type, 'attach');
  assert.ok(!p.ports[1].sent.some(m => m.type === 'prompt'));
  p.scope.hostReady = true;
  p.tick(8000);
  assert.equal(p.onboarding.length, 0);
});

test('a persistent disconnect shows setup after the reconnect grace without ending the turn', () => {
  const p = panel(); p.scope.connect();
  p.ports[0].disconnect();
  p.tick(8000);
  assert.equal(p.onboarding.length, 1);
  assert.equal(p.chat.turnRunning, true);
  assert.deepEqual(p.notes, []);
});

test('the first failed connection waits for a retry before showing setup', () => {
  const p = panel(); p.scope.hadReadyHost = false; p.scope.connect();
  p.ports[0].disconnect();
  assert.equal(p.onboarding.length, 0);
  p.tick(3000);
  assert.equal(p.onboarding.length, 1);
});
