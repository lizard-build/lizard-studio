import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function setup() {
  const requests = [], delivered = [], queued = [], timers = new Set();
  function el(tag, classes = '', text = '') {
    const names = new Set((classes || '').split(' '));
    return { tag, children: [], dataset: {}, parentNode: null, value: '', ownText: String(text),
      classList: { add(c) { names.add(c); }, remove(c) { names.delete(c); }, contains: c => names.has(c), toggle(c, on) { on ? names.add(c) : names.delete(c); } },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      set textContent(text) { this.ownText = text; this.children = []; },
      get textContent() { return this.ownText + this.children.map(c => c.textContent).join('\n'); },
      setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; },
      addEventListener() {}, focus() {},
      querySelectorAll() { return this.children.flatMap(c => [c, ...c.querySelectorAll()]).filter(c => ['button', 'input'].includes(c.tag)); },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; },
    };
  }
  const chat = { id: 'chat', harness: 'codex', messagesEl: el('div'), turnIndexCounter: 0, started: true };
  const scope = { el, ICON: () => '', activeId: null, connected: true, hostReady: true,
    els: {}, append: (chat, row) => chat.messagesEl.appendChild(row), buildBubble: text => el('div', '', text),
    paintPerm() {}, tabDotWaiting: () => false, renderTurnStatus() {}, noteWaitingAsk() {},
    touchChat() {}, updateTabDots() {}, savePrefs() {}, resumeTurnIfIdle() {},
    startChatSession() {}, post: msg => { requests.push(msg); return true; }, newId: () => 'reply-id',
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }, failQueuedSteers() {},
    chats: new Map([[chat.id, chat]]), liveSelection: null, claimSession() {}, autosize() {},
    deliverPrompt: async (_, text) => delivered.push(text),
    queuePrompt(_, text) { queued.push(text); scope.els.input.value = ''; },
  };
  vm.createContext(scope);
  vm.runInContext(section('  function userBubble(', '  // Click the message text') +
    section('  function parseAsyncQuestionAnswer(', '  function removePermCard(') +
    section('  async function sendPrompt()', '  // Stashes a prompt'), scope);
  const questions = [{ id: '0', question: 'Создать карточки?', options: [{ label: 'Да, по шаблону' }] }];
  function ask(target = chat, id = 'question', qs = questions, readOnly = false) {
    scope.showAsyncQuestion(target, { questionId: id, questions: qs, readOnly });
    return (target.historyOwner || target).asyncQuestions.get(id);
  }
  return { scope, chat, el, requests, ask, delivered, queued, timers,
    compose(text) {
      scope.activeId = chat.id; chat.cwd = '/project'; scope.els.input = { value: text };
      return scope.sendPrompt();
    },
    timeout() {
      const timer = [...timers].find(t => t.ms === 30000);
      assert.ok(timer); timers.delete(timer); timer.fn();
    },
  };
}

const reply = 'Создать карточки?\nДа, по шаблону';

for (const state of ['open', 'sending', 'failed', 'answered']) {
  test(`a ${state} question cannot intercept a new composer message`, async () => {
    const p = setup(), entry = p.ask();
    if (state !== 'open') entry.activate(0);
    if (state === 'failed') p.scope.failAsyncQuestionSends(p.chat);
    if (state === 'answered') p.scope.finishAsyncQuestionAnswer(p.chat, { requestId: 'reply-id', ok: true });
    const requests = p.requests.length;
    await p.compose('What can we post about Redis?');
    assert.deepEqual(p.delivered, ['What can we post about Redis?']);
    assert.equal(p.requests.length, requests);
    assert.equal(p.scope.els.input.value, '');
  });
}

test('a pending question does not prevent offline messages from entering the queue', async () => {
  const p = setup(); p.ask(); p.scope.connected = false;
  await p.compose('Save this for when the connection returns');
  assert.deepEqual(p.queued, ['Save this for when the connection returns']);
  assert.equal(p.scope.els.input.value, '');
});

test('a missing answer receipt unlocks the card and a late success still settles it once', () => {
  const p = setup(), entry = p.ask(); entry.activate(0);
  p.timeout();
  assert.equal(entry.sending, false); assert.equal(entry.readOnly, false);
  assert.match(entry.card.textContent, /Couldn't confirm/);
  assert.equal(p.requests.length, 1, 'a timeout must not resend an answer');
  p.scope.finishAsyncQuestionAnswer(p.chat, { requestId: 'reply-id', ok: true, startedTurn: true });
  p.scope.finishAsyncQuestionAnswer(p.chat, { requestId: 'reply-id', ok: true, startedTurn: true });
  assert.equal(entry.readOnly, true); assert.equal(p.chat.turnIndexCounter, 1);
  assert.equal(p.timers.size, 0);
});

test('an accepted plain-text reply from an older panel cannot leave its card sending', () => {
  const p = setup(), entry = p.ask();
  p.scope.sendAsyncQuestionAnswer(p.chat, entry, 'finished?');
  p.scope.finishAsyncQuestionAnswer(p.chat, { requestId: 'reply-id', ok: true, startedTurn: true });
  assert.equal(entry.sending, false); assert.equal(entry.readOnly, true);
  assert.match(entry.card.textContent, /Answer sent in chat/);
  assert.equal(p.chat.messagesEl.children.length, 2);
  assert.match(p.chat.messagesEl.children[1].textContent, /finished\?/);
  assert.equal(p.timers.size, 0);
});

test('a restored worker that lost the session releases its pending answer', () => {
  const p = setup(), entry = p.ask(); entry.activate(0);
  p.chat.turnRunning = true; p.chat.bashRuns = new Map();
  Object.assign(p.scope, {
    backgroundRestoreStates: [], backgroundRestoring: true,
    systemNote() {}, endTurn(chat) { chat.turnRunning = false; },
    renderTabs() {}, syncComposer() {}, prewarmHarnesses() {}, finishAgentCheck() {},
  });
  vm.runInContext('function restoreEnd(msg) {\n' +
    section('    if (msg.type === "backgroundRestoreEnd")', '    if (msg.type === "turnStarted")') + '\n}', p.scope);
  p.scope.restoreEnd({ type: 'backgroundRestoreEnd' });
  assert.equal(p.chat.started, false); assert.equal(p.chat.turnRunning, false);
  assert.equal(entry.sending, false); assert.equal(entry.sentText, reply);
  assert.equal(p.timers.size, 0); assert.equal(p.requests.length, 1);
  assert.match(entry.card.textContent, /Connection lost/);
});

test('connection loss unlocks a sending card without resending it', () => {
  const p = setup(), entry = p.ask(); entry.activate(0);
  p.scope.failAsyncQuestionSends(p.chat);
  assert.equal(entry.sending, false); assert.equal(p.timers.size, 0);
  assert.match(entry.card.textContent, /Connection lost/);
  assert.equal(p.requests.length, 1);
});

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
  assert.equal(entry.readOnly, false);
});
