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
  };
  vm.createContext(scope);
  vm.runInContext(section('  function userBubble(', '  // Click the message text') +
    section('  function parseAsyncQuestionAnswer(', '  function removePermCard('), scope);
  const questions = [{ id: '0', question: 'Создать карточки?', options: [{ label: 'Да, по шаблону' }] }];
  function ask(target = chat, id = 'question', qs = questions, readOnly = false) {
    scope.showAsyncQuestion(target, { questionId: id, questions: qs, readOnly });
    return (target.historyOwner || target).asyncQuestions.get(id);
  }
  return { scope, chat, el, requests, ask };
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
  assert.equal(entry.readOnly, false);
});
