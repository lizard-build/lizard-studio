import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function setup() {
  const requests = [];
  function el(tag, classes = '', text = '') {
    const names = new Set((classes || '').split(' '));
    const listeners = new Map();
    return { tag, children: [], dataset: {}, parentNode: null, value: '', ownText: String(text),
      classList: { add(c) { names.add(c); }, remove(c) { names.delete(c); }, contains: c => names.has(c), toggle(c, on) { on ? names.add(c) : names.delete(c); } },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      set textContent(text) { this.ownText = text; this.children = []; },
      get textContent() { return this.ownText + this.children.map(c => c.textContent).join('\n'); },
      setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; },
      addEventListener(type, handler) { listeners.set(type, handler); }, focus() {},
      fire(type, event = {}) { listeners.get(type)?.(event); },
      querySelectorAll() { return this.children.flatMap(c => [c, ...c.querySelectorAll()]).filter(c => ['button', 'input'].includes(c.tag)); },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; },
    };
  }
  const chat = { id: 'chat', harness: 'codex', messagesEl: el('div'), turnIndexCounter: 0, started: true,
    permCards: new Map(), streamBlocks: new Map(), toolCards: new Map(), closedQuestionIds: [],
  };
  const effects = { status: 0, dots: 0, saves: 0 };
  const scope = { el, ICON: () => '', activeId: null, connected: true, hostReady: true,
    els: {}, append: (chat, row) => chat.messagesEl.appendChild(row), buildBubble: text => el('div', '', text),
    paintPerm() {}, tabDotWaiting: () => false, renderTurnStatus() { effects.status++; }, noteWaitingAsk() {},
    touchChat() {}, updateTabDots() { effects.dots++; }, savePrefs() { effects.saves++; }, resumeTurnIfIdle() {},
    closeToolGroup() {}, finalizeAssistant() {}, backgroundRestoring: true, sharedRendering: false,
    chats: new Map([['chat', chat]]), reportChatActivity() {}, liftSuppress() {}, failQueuedSteers() {},
    updateSetup() {}, finishAgentCheck() {}, harnessReady: {}, harnessChecked: {},
    startChatSession() {}, post: msg => { requests.push(msg); return true; }, newId: () => 'reply-id',
  };
  vm.createContext(scope);
  vm.runInContext(section('  function userBubble(', '  // Click the message text') +
    section('  function parseAsyncQuestionAnswer(', '  // ---- context-size tracking') +
    section('  function endTurn(', '  // ---- attention chime') +
    section('  function onHostMessage(', '  function post('), scope);
  const questions = [{ id: '0', question: 'Создать карточки?', options: [{ label: 'Да, по шаблону' }] }];
  function ask(target = chat, id = 'question', qs = questions, readOnly = false) {
    scope.showAsyncQuestion(target, { questionId: id, questions: qs, readOnly });
    return (target.historyOwner || target).asyncQuestions.get(id);
  }
  return { scope, chat, el, requests, ask, effects };
}

const reply = 'Создать карточки?\nДа, по шаблону';

test('an accepted answer stays in its question card without a second user bubble', () => {
  const { scope, chat, requests, ask } = setup();
  const entry = ask();
  entry.activate(0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].text, reply);
  assert.equal(requests[0].questionReplyId, 'question');
  assert.equal(entry.readOnly, false);
  scope.finishAsyncQuestionAnswer(chat, { requestId: 'reply-id', ok: true, startedTurn: true });
  assert.equal(chat.messagesEl.children.length, 1);
  assert.equal(entry.readOnly, true);
  assert.equal(chat.turnIndexCounter, 1);
  assert.equal(entry.card.textContent.split('Да, по шаблону').length - 1, 1);
  assert.match(entry.card.textContent, /Answer sent/);
  scope.finishAsyncQuestionAnswer(chat, { requestId: 'reply-id', ok: true, startedTurn: true });
  assert.equal(chat.turnIndexCounter, 1);
});

test('a failed submission stays retryable and does not create an answer bubble', () => {
  const { scope, chat, ask } = setup();
  const entry = ask(); entry.activate(0);
  scope.finishAsyncQuestionAnswer(chat, { requestId: 'reply-id', ok: false, error: 'offline' });
  assert.equal(entry.readOnly, false);
  assert.equal(entry.sending, false);
  assert.equal(chat.messagesEl.children.length, 1);
  assert.match(entry.card.textContent, /offline/);
  assert.doesNotMatch(entry.card.textContent, /Answer sent/);
});

test('shared replies fill only their question and leave other questions open', () => {
  const { scope, chat, ask } = setup();
  const first = ask();
  const other = ask(chat, 'other');
  scope.userBubble(chat, reply, [], { real: true, questionReplyId: 'question', replayQuestionReply: true });
  assert.equal(chat.messagesEl.children.length, 2);
  assert.equal(first.readOnly, true);
  assert.equal(other.readOnly, false);
});

test('saved replies merge into cards, including several questions and multiline answers', () => {
  const { scope, chat, ask } = setup();
  const questions = [{ id: 'a', question: 'First?' }, { id: 'b', question: 'Second?' }];
  const entry = ask(chat, 'many', questions, true);
  scope.userBubble(chat, 'First?\nOne\nTwo\n\nSecond?\nThree', null, { real: true, replayQuestionReply: true });
  assert.equal(chat.messagesEl.children.length, 1);
  assert.match(entry.card.textContent, /One\nTwo/);
  assert.match(entry.card.textContent, /Three/);
  assert.match(entry.card.textContent, /Answer sent/);
});

test('an answer loaded before its older question stays visible until it can be merged', () => {
  const { scope, chat, ask, el } = setup();
  const row = scope.userBubble(chat, reply, null, { real: true, replayQuestionReply: true });
  assert.equal(chat.messagesEl.children.length, 1);
  const olderPage = { id: 'history-chat', harness: 'codex', historyPage: true, historyOwner: chat, messagesEl: el('div') };
  const entry = ask(olderPage, 'question', undefined, true);
  assert.equal(row.parentNode, null);
  assert.equal(chat.asyncAnswerBubbles.size, 0);
  assert.match(entry.card.textContent, /Да, по шаблону/);
  assert.match(entry.card.textContent, /Answer sent/);
  assert.equal(olderPage.messagesEl.children.length, 1);
});

test('ordinary messages, attachments and replies for unknown ids remain visible', () => {
  const { scope, chat, ask } = setup();
  const entry = ask();
  scope.userBubble(chat, 'Unrelated message', null, { real: true, replayQuestionReply: true });
  scope.userBubble(chat, reply, null, { real: true });
  scope.userBubble(chat, reply, [{ image: true }], { real: true, replayQuestionReply: true });
  scope.userBubble(chat, reply, null, { real: true, questionReplyId: 'missing' });
  assert.equal(chat.messagesEl.children.length, 5);
  assert.equal(entry.readOnly, true);
  assert.match(entry.card.textContent, /No longer needed/);
});


test('Dismiss closes only its question, refreshes status and sends no answer', () => {
  const { chat, ask, requests, effects } = setup();
  const first = ask();
  const other = ask(chat, 'other');
  const button = first.card.querySelectorAll().find(c => c.classList.contains('ask-dismiss'));
  const before = { ...effects };
  button.fire('click');
  assert.equal(first.readOnly, true);
  assert.equal(other.readOnly, false);
  assert.equal(button.hidden, true);
  assert.equal(requests.length, 0);
  assert.ok(effects.status > before.status);
  assert.ok(effects.dots > before.dots);
  assert.ok(effects.saves > before.saves);
  assert.deepEqual(Array.from(chat.closedQuestionIds), ['question']);
  assert.match(first.card.textContent, /Dismissed/);
});

test('a dismissed question stays closed when history is replayed after a reload', () => {
  const first = setup();
  const entry = first.ask();
  entry.card.fire('keydown', { key: 'Escape', preventDefault() {} });
  const next = setup();
  next.chat.closedQuestionIds = JSON.parse(JSON.stringify(first.chat.closedQuestionIds));
  const replay = next.ask();
  assert.equal(replay.readOnly, true);
  replay.activate?.(0);
  assert.equal(next.requests.length, 0);
});

test('Dismiss cannot race an answer waiting for host acknowledgement', () => {
  const { ask, scope, chat, requests } = setup();
  const entry = ask();
  entry.activate(0);
  const button = entry.card.querySelectorAll().find(c => c.classList.contains('ask-dismiss'));
  assert.equal(button.disabled, true);
  button.fire('click');
  assert.equal(entry.readOnly, false);
  scope.finishAsyncQuestionAnswer(chat, { requestId: 'reply-id', ok: true, startedTurn: true });
  assert.match(entry.card.textContent, /Answer sent/);
  assert.equal(requests.length, 1);
});

test('normal turn completion leaves async questions answerable', () => {
  const { scope, chat, ask } = setup();
  const entry = ask();
  chat.turnRunning = true;
  scope.endTurn(chat, { is_error: false, result: '' });
  assert.equal(chat.turnRunning, false);
  assert.equal(entry.readOnly, false);
});

for (const result of [null, { is_error: true, result: 'Server failed' }, { is_error: false, result: 'Stopped.' }]) {
  test(`stopped or failed turns retire async questions (${JSON.stringify(result)})`, () => {
    const { scope, chat, ask, requests } = setup();
    const entry = ask();
    chat.turnRunning = true;
    scope.endTurn(chat, result);
    assert.equal(entry.readOnly, true);
    assert.equal(chat.turnRunning, false);
    assert.match(entry.card.textContent, /Closed/);
    entry.activate(0);
    entry.setError('A late failure');
    assert.doesNotMatch(entry.card.textContent, /A late failure|Retry answer/);
    assert.equal(requests.length, 0);
  });
}

test('replaying an older user message does not close a current question', () => {
  const { scope, chat, ask, el } = setup();
  const entry = ask();
  const page = { harness: 'codex', historyPage: true, historyOwner: chat, messagesEl: el('div') };
  scope.userBubble(page, 'An older task', null, { real: true, replayQuestionReply: true });
  assert.equal(entry.readOnly, false);
});


for (const event of [
  { type: 'interrupted', id: 'chat', respawn: false },
  { type: 'exit', id: 'chat', quiet: true },
  { type: 'agentExit', agent: 'codex' },
]) {
  test(`host ${event.type} closes unanswered cards even when the turn is already idle`, () => {
    const { scope, chat, ask } = setup();
    const entry = ask();
    chat.turnRunning = false;
    scope.onHostMessage(event);
    assert.equal(entry.readOnly, true);
    assert.ok(chat.closedQuestionIds.includes('question'));
  });
}

test('a new task leaves answered cards intact and retires unanswered ones', () => {
  const { scope, chat, ask } = setup();
  const answered = ask();
  scope.userBubble(chat, reply, null, { real: true, questionReplyId: 'question' });
  const pending = ask(chat, 'pending');
  scope.userBubble(chat, 'Move on to a new task', null, { real: true });
  assert.match(answered.card.textContent, /Answer sent/);
  assert.match(pending.card.textContent, /No longer needed/);
});
