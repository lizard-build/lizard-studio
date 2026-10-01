import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const cost = 'Total cost: $5.74\nTotal duration (API): 13m 49s\nTotal duration (wall): 33m 53s\nTotal code changes: 71 lines added, 40 lines removed\nUsage by model:\nclaude-opus-5-5: 172 input, 66.9k output';
function setup(harness = 'claude') {
  const sent = [], rendered = [], chat = { id: 'chat', harness, model: 'opus', started: true, turnRunning: false, queue: [] };
  const scope = { chats: new Map([['chat', chat]]), activeId: 'chat', connected: true, hostReady: true,
    Date, USAGE_THROTTLE_MS: 45000, codexUsage: { at: 0, fetching: false, rows: [] },
    usageState: { at: 0, fetching: false, rows: [] }, customModel: () => null,
    post: msg => { sent.push(msg); return true; },
    attachAssistantRow() {}, closeToolGroup() {}, atBottom: () => false,
    R: { markdown: text => { rendered.push(text); return text; } },
    absorbUsageDump() {}, showUsageMenu() {},
  };
  vm.createContext(scope);
  vm.runInContext(section('  const USAGE_LINE_RE', '  // Screenshot-matching labels') +
    section('  function refreshUsage(', '  // Accept replies still in flight') +
    section('  const SYNTHETIC_MODEL', '  // The CLI answers a local, zero-turn'), scope);
  return { scope, chat, sent, rendered };
}

test('Claude startup, turn completion and forced usage refresh never send chat prompts', () => {
  const { scope, sent, chat } = setup();
  for (let i = 0; i < 20; i++) { scope.refreshUsage(); scope.refreshUsage(true); }
  chat.turnRunning = true;
  scope.chats.set('idle', { ...chat, id: 'idle', turnRunning: false });
  scope.refreshUsage(true);
  scope.activeId = 'missing'; scope.refreshUsage(true);
  assert.equal(sent.length, 0);
  assert.equal(scope.usageState.fetching, false);
});

test('Codex still refreshes through its planUsage protocol with throttling', () => {
  const { scope, sent } = setup('codex');
  scope.refreshUsage(); scope.refreshUsage(true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'planUsage');
  assert.equal(sent[0].agent, 'codex');
  scope.codexUsage.fetching = false; scope.codexUsage.at = Date.now();
  scope.refreshUsage(); assert.equal(sent.length, 1);
  scope.refreshUsage(true); assert.equal(sent.length, 2);
});

test('cost output from older usage probes is recognized without hiding ordinary prose', () => {
  const { scope } = setup();
  assert.equal(scope.isUsageText(cost), true);
  assert.equal(scope.isUsageDump('<local-command-stdout>' + cost + '</local-command-stdout>'), true);
  assert.equal(scope.usageEchoText({ model: '<synthetic>', content: [{ type: 'text', text: cost }] }), cost);
  assert.equal(scope.isUsageEchoResult({ num_turns: 0, result: cost }), true);
  assert.equal(scope.isUsageEchoResult({ num_turns: 1, result: cost }), false);
  assert.equal(scope.isUsageText('Total cost: $5.74 for this change.'), false);
  assert.equal(scope.isUsageText('Here is the report:\n' + cost), false);
  assert.equal(scope.isUsageText('Current session: 20% used'), true);
});

test('unasked cost replies stay hidden, while an explicit user request keeps its report', () => {
  const { scope, chat, rendered } = setup();
  const body = { appendChild() {} };
  assert.equal(scope.takeUsageReply(chat, body, cost, false), true);
  assert.equal(rendered.length, 0);
  assert.equal(scope.takeUsageReply(chat, body, cost, true), true);
  assert.deepEqual(rendered, [cost]);
});

test('worker replay hides old usage prompt bubbles and preserves real prompts', () => {
  const { scope, chat } = setup();
  const bubbles = [];
  Object.assign(scope, { CTX_MARK_RE: /<context>.*?<\/context>/g,
    userBubble: (_chat, text) => bubbles.push(text) });
  vm.runInContext('function replay(msg) {' + section('    if (msg.type === "backgroundReplay")', '    if (msg.type === "backgroundRestoreEnd")') + '}', scope);
  for (const text of ['/usage', '/usage-credits', '/extra-usage', 'Fix the bug', '/usage explain this'])
    scope.replay({ type: 'backgroundReplay', message: { type: 'backgroundPrompt', id: chat.id, text } });
  assert.deepEqual(bubbles, ['Fix the bug', '/usage explain this']);
});

test('transcript replay drops prior command reports in each CLI output shape', () => {
  const { scope, chat, rendered } = setup();
  const bubbles = [];
  Object.assign(scope, { activeId: 'other', replayStamp: 0, CTX_MARK_RE: /<context>.*?<\/context>/g,
    SYNTHETIC_USER_TAG_RE: /<local-command-caveat>.*?<\/local-command-caveat>/g,
    commandBubbleText: () => null, scanBgNotice() {}, scanAgentNotice() {},
    userBubble: (_chat, text) => bubbles.push(text), noteCtxUsage() {},
    ensureAssistantBody: () => ({ appendChild() {} }), finalizeAssistant() {},
    addText: (_chat, _body, text) => rendered.push(text),
    renderLocalCommandOutput: (_chat, text) => rendered.push(text),
  });
  vm.runInContext(section('  function replayTranscript(', '  // Render the output of a local slash command.'), scope);
  const stdout = '<local-command-stdout>' + cost + '</local-command-stdout>';
  scope.replayTranscript(chat, [
    { type: 'user', message: { content: '/usage' } },
    { type: 'user', message: { content: [{ type: 'text', text: '/usage' }] } },
    { type: 'local_command', content: stdout },
    { type: 'user', message: { content: stdout } },
    { type: 'assistant', message: { content: [{ type: 'text', text: cost }] } },
    { type: 'user', message: { content: 'My question' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Real answer' }] } },
  ]);
  assert.deepEqual(bubbles, ['My question']);
  assert.deepEqual(rendered, ['Real answer']);
});

test('Claude usage menu shows unavailable plan data instead of a permanent loading state', () => {
  const { scope, chat } = setup();
  const node = (tag, cls, text) => ({ tag, cls, text, children: [], appendChild(child) { this.children.push(child); } });
  const menu = node('div');
  Object.assign(scope, { els: { usageMenu: menu }, el: node, contextLimit: () => 1000000,
    usageMenuRow: (...args) => ({ args }), usageSkeletonRow() { throw Error('Unexpected loading placeholder'); } });
  chat.ctxTokens = 100;
  vm.runInContext(section('  function renderUsageMenu()', '  // Open the popover on demand'), scope);
  scope.renderUsageMenu();
  assert.equal(menu.children[1].children[1].text, 'Usage unavailable');
});
