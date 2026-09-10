// Emit a browser-side regression test for the shipped permission UI.
// Pipe stdout into an isolated agent-browser session's `eval --stdin`.
import { readFileSync } from "node:fs";

const source = readFileSync(process.env.PERMISSION_PANEL_SOURCE || new URL("../../src/panel/chat.js", import.meta.url), "utf8");
const start = source.indexOf("  const PERM_DENY_MESSAGE");
const end = source.indexOf("  // ---- context-size tracking", start);
if (start < 0 || end < 0) throw new Error("Permission UI section not found");
const setup = `
  document.body.replaceChildren();
  const messages = [], links = [], passed = [];
  const chat = { id: 'a', harness: 'codex', permCards: new Map() };
  const activeId = 'a', TOOL_META = {};
  function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; }
  const els = { input: el('textarea') }; document.body.appendChild(els.input);
  const ICON = () => '', R = { codeBlock: (text) => el('pre', null, text) };
  const toolDetail = () => null, shortPathFor = (_, path) => path;
  const renderTurnStatus = () => {}, updateTabDots = () => {}, noteWaitingAsk = () => {}, scrollToBottom = () => {}, tabDotWaiting = () => false;
  const append = (_, node) => document.body.appendChild(node), post = (msg) => messages.push(msg), openExternal = (url) => links.push(url);
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const ask = (id, input) => showPermission(chat, { requestId: id, toolName: 'McpElicitation', input, description: input.message });
  const choice = (id, label) => { const entry = chat.permCards.get(id); check(!!entry, 'Missing card ' + id); const row = entry.rows.find((r) => r.textContent.includes(label)); check(!!row, 'Missing option ' + label); row.click(); };
`;
const checks = `
  showPermission(chat, { requestId: 0, toolName: 'Bash', input: { command: 'ls /Volumes' } });
  check(chat.permCards.has(0) && messages.length === 0, 'Request zero must wait for a user');
  chat.permCards.get(0).rows[0].click();
  check(messages.at(-1).requestId === 0 && messages.at(-1).behavior === 'allow', 'Request zero did not return Allow');
  passed.push('numeric request id zero');

  showPermission(chat, { requestId: 0, toolName: 'AskUserQuestion', input: { questions: [{ question: 'Allow browser access?', options: [{ label: 'Accept' }, { label: 'Decline' }, { label: 'Cancel' }] }] } });
  check(document.body.textContent.includes('ChatGPT is asking'), 'Wrong question title');
  chat.permCards.get(0).rows[0].click();
  check(messages.at(-1).updatedInput.answers['Allow browser access?'] === 'Accept', 'MCP tool question was not answered');
  passed.push('connector approval question');

  els.input.value = 'unfinished draft';
  ask('form', { mode: 'form', serverName: 'browser', message: 'Allow access?', requestedSchema: { type: 'object', properties: {
    decision: { type: 'string', oneOf: [{ const: 'once', title: 'Only this time' }, { const: 'deny', title: 'No access' }] },
    network: { type: 'boolean' }, count: { type: 'integer', minimum: 1, maximum: 5 },
    folders: { type: 'array', items: { enum: ['videos', 'photos'] }, minItems: 1, maxItems: 1 },
  }, required: ['decision', 'network', 'count', 'folders'] } });
  let before = messages.length;
  choice('form', 'Allow'); check(messages.length === before && chat.permCards.has('form'), 'Blank form was accepted');
  const fields = chat.permCards.get('form').card.querySelectorAll('select, input');
  fields[0].value = 'once'; fields[1].value = 'false'; fields[2].value = '2'; fields[3].options[0].selected = true;
  fields[2].dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
  check(messages.length === before, 'Typing a number answered the permission');
  choice('form', 'Allow');
  const content = messages.at(-1).updatedInput.content;
  check(content.decision === 'once' && content.network === false && content.count === 2 && content.folders[0] === 'videos', 'Typed form values were lost');
  check(els.input.value === 'unfinished draft', 'Draft was changed');
  passed.push('form validation, typed values, keyboard and draft');

  ask('url', { mode: 'url', serverName: 'browser', message: 'Complete sign-in', url: 'https://example.com/auth' });
  before = messages.length;
  chat.permCards.get('url').card.querySelector('form button').click();
  check(links.at(-1) === 'https://example.com/auth' && messages.length === before, 'Opening a link accepted the request');
  choice('url', "I've completed"); check(messages.at(-1).updatedInput.content === null, 'URL confirmation must have null content');
  passed.push('URL flow waits for completion');

  for (const [label, interrupt] of [['Decline', false], ['Cancel', true]]) {
    ask(label, { mode: 'form', requestedSchema: { type: 'object', properties: {} } });
    choice(label, label);
    check(messages.at(-1).behavior === 'deny' && messages.at(-1).interrupt === interrupt, 'Decline and Cancel were mixed');
  }
  passed.push('separate decline and cancel');

  ask('unsupported', { mode: 'form', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } });
  check(!chat.permCards.get('unsupported').opts.some((o) => o.allow), 'Unsupported form offered Allow');
  check(document.body.textContent.includes('cannot display'), 'Unsupported form was hidden');
  clearPermCards(chat);
  ask('bad-url', { mode: 'url', url: 'javascript:alert(1)' });
  check(!chat.permCards.get('bad-url').opts.some((o) => o.allow), 'Unsafe URL offered Allow');
  clearPermCards(chat);
  passed.push('unsupported requests stay visible');
  return { passed, count: passed.length };
`;
process.stdout.write(`(() => {\n${setup}\n${source.slice(start, end)}\n${checks}\n})()`);
