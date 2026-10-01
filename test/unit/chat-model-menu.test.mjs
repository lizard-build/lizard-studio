import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  function normalizeCodexModel('), source.indexOf('  function hideModelMenu('));
function setup() {
  const document = { activeElement: null }, requests = [], timers = new Set();
  function el(tag, classes = '', text = '') {
    const names = new Set(classes.split(' ').filter(Boolean));
    const node = { tag, textContent: text, children: [], dataset: {}, listeners: {},
      classList: { contains: c => names.has(c), toggle: (c, on) => on ? names.add(c) : names.delete(c) },
      appendChild(child) { this.children.push(child); return child; },
      contains(child) { return this === child || this.children.some(c => c.contains(child)); },
      setAttribute(k, v) { this[k] = v; },
      addEventListener(k, fn) { this.listeners[k] = fn; },
      focus() { document.activeElement = this; },
      querySelectorAll(selector) {
        const all = this.children.flatMap(c => [c, ...c.querySelectorAll('*')]);
        return selector === '*' ? all : all.filter(c => c.tag === 'button');
      },
      querySelector() { return this.querySelectorAll('button').find(c => c.classList.contains('model-refresh') && !c.disabled); },
      set innerHTML(value) { this.html = value; this.children = []; },
    };
    return node;
  }
  const menu = el('div'), chat = { model: 'gpt-5.5', harness: 'codex' };
  const scope = { document, el, Date, CODEX_DEFAULT_MODEL: 'gpt-6-astra', DEFAULT_HARNESS: 'codex',
    codexCatalog: { at: 0, fetching: false, error: '', timer: null },
    claudeCatalog: { at: 0, fetching: false, error: '', timer: null },
    ICON: name => name, HARNESS_ICON: name => name, window: { RKClaudeHTML: () => 'claude' },
    chats: new Map([['chat', chat]]), activeId: 'chat', els: { modelMenu: menu },
    closeMenu: () => {}, menuIsOpen: () => true, openMenu: () => {}, anchorPopover: () => {},
    applyModel: (c, id) => { c.model = id; }, modelsFor: () => [],
    post: msg => { requests.push(msg); return true; },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
  };
  vm.createContext(scope); vm.runInContext(code, scope);
  return { scope, document, menu, chat, requests, timers };
}
const rows = [
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'For demanding work.', efforts: ['max', 'ultra'] },
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', description: 'For coding and everyday work.', efforts: ['max', 'ultra'] },
  { id: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'For fast, focused tasks.', efforts: ['max'] },
  { id: 'custom-local', label: 'My local model', custom: true },
];

test('new model names have readable spacing without changing ids or supported efforts', () => {
  const { scope } = setup();
  const models = rows.map(scope.normalizeCodexModel);
  assert.deepEqual(models.map(m => m.label), ['GPT-5.5', 'GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna', 'My local model']);
  assert.equal(models[2].id, 'gpt-6-sol');
  assert.deepEqual(models[2].efforts, ['max', 'ultra']);
  assert.deepEqual(models[3].efforts, ['max']);
  assert.equal(scope.normalizeCodexModel({ id: 'future', label: 'Future-model' }).label, 'Future-model');
});

test('groups put newer GPT families first and retain custom and future models', () => {
  const { scope } = setup();
  const groups = scope.modelGroups([...rows, { id: 'gpt-10-sol' }, { id: 'o9' }], 'codex');
  assert.deepEqual(Array.from(groups, g => g.label), ['GPT-10', 'GPT-6', 'GPT-5.5', 'Other models', 'Custom models']);
  assert.deepEqual(Array.from(groups[1].items, m => m.id), ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
  assert.equal(scope.modelGroups(rows, 'claude')[0].items, rows);
});

test('picker shows descriptions, default and current separately, and selecting keeps the real id', () => {
  const { scope, menu, chat } = setup();
  scope.renderPickerMenu(menu, 'ChatGPT models', rows.map(scope.normalizeCodexModel), chat.model, scope.applyModel, 'codex');
  const nodes = menu.querySelectorAll('*');
  assert.equal(nodes.find(n => n.classList.contains('model-default')).textContent, 'Default');
  assert.equal(nodes.find(n => n.classList.contains('current')).dataset.modelId, 'gpt-5.5');
  assert.equal(nodes.filter(n => n.classList.contains('model-description')).length, 3);
  const sol = nodes.find(n => n.dataset.modelId === 'gpt-6-sol');
  sol.listeners.click();
  assert.equal(chat.model, 'gpt-6-sol');
  assert.equal(nodes.find(n => n.dataset.modelId === 'custom-local').children[0].html, 'sparkle');
});

test('catalog redraw preserves keyboard focus on a model', () => {
  const { scope, menu, document } = setup();
  const render = () => scope.renderPickerMenu(menu, 'Models', rows, 'gpt-5.5', scope.applyModel, 'codex');
  render();
  menu.querySelectorAll('button').find(n => n.dataset.modelId === 'gpt-6-luna').focus();
  render();
  assert.equal(document.activeElement.dataset.modelId, 'gpt-6-luna');
  assert.equal(menu.contains(document.activeElement), true);
});

test('refresh is single-flight, leaves the selected model alone and offers retry after a timeout', () => {
  const { scope, requests, timers, chat } = setup();
  scope.refreshCodexModels(); scope.refreshCodexModels();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, 'refreshModels');
  assert.equal(requests[0].agent, 'codex');
  assert.equal(chat.model, 'gpt-5.5');
  [...timers][0]();
  assert.equal(scope.codexCatalog.fetching, false);
  assert.match(scope.codexCatalog.error, /timed out/);
  scope.refreshCodexModels();
  assert.equal(requests.length, 2);
});


test('receiving a refreshed catalog retains a chat selection and all live metadata', () => {
  const { scope, chat } = setup();
  Object.assign(scope, { CODEX_MODELS: [], CODEX_DEFAULT_EFFORT: null, CODEX_CONTEXT_LIMITS: {},
    lastBy: { codex: { effort: "high" } }, clampEffort() {}, syncComposer() {}, renderEffortMenu() {} });
  const receive = source.slice(source.indexOf('      case "models":'), source.indexOf('      // Codex\'s plan limits'));
  vm.runInContext('function receive(msg) { switch (msg.type) { ' + receive + ' } }', scope);
  scope.receive({ type: 'models', agent: 'codex', models: rows.slice(0, 4), defaultModel: 'gpt-6-sol' });
  assert.equal(chat.model, 'gpt-5.5');
  assert.equal(scope.CODEX_DEFAULT_MODEL, 'gpt-6-sol');
  assert.equal(scope.CODEX_MODELS[2].description, 'For coding and everyday work.');
  const catalog = scope.CODEX_MODELS;
  scope.receive({ type: 'modelsError', agent: 'codex', error: 'offline' });
  assert.equal(scope.CODEX_MODELS, catalog);
  assert.equal(chat.model, 'gpt-5.5');
  assert.equal(scope.codexCatalog.error, 'offline');
});


test('Claude picker refreshes on open, keeps selection and sends the project folder', () => {
  const { scope, menu, chat, requests } = setup();
  Object.assign(chat, { harness: 'claude', model: 'claude-opus-5', cwd: '/project' });
  scope.menuIsOpen = () => false;
  scope.toggleModelMenu();
  scope.refreshClaudeModels();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), { type: 'refreshModels', agent: 'claude', cwd: '/project' });
  assert.equal(chat.model, 'claude-opus-5');
  assert.equal(menu.querySelectorAll('button').find(n => n.classList.contains('model-refresh')).disabled, true);
  scope.claudeCatalog.fetching = false;
  scope.toggleModelMenu();
  assert.equal(requests.length, 2);
});

test('Claude refresh shows connection and timeout errors and allows retry', () => {
  const { scope, timers, chat } = setup();
  chat.harness = 'claude';
  scope.post = () => false;
  scope.refreshClaudeModels();
  assert.match(scope.claudeCatalog.error, /Connect to Claude Code/);
  assert.equal(scope.claudeCatalog.fetching, false);
  assert.equal(timers.size, 0);
  scope.post = () => true;
  scope.refreshClaudeModels();
  [...timers][0]();
  assert.match(scope.claudeCatalog.error, /timed out/);
  scope.refreshClaudeModels();
  assert.equal(scope.claudeCatalog.fetching, true);
});

function claudeCatalogSetup() {
  const result = setup(), { scope } = result;
  const storage = {}, callbacks = [];
  Object.assign(scope, {
    DEFAULT_MODEL_FALLBACK: 'default', DEFAULT_CONTEXT_LIMIT_FALLBACK: 200000,
    CONTEXT_LIMITS_FALLBACK: { 'claude-sonnet-5': 1000000 }, canonicalModel: id => id,
    MODELS: [{ id: 'default', label: 'Default' }], CONTEXT_LIMITS: {}, DEFAULT_MODEL: 'default',
    mounted: false, chrome: { storage: { local: {
      get(keys, cb) { callbacks.push(cb); }, set(values) { Object.assign(storage, values); },
    } } },
  });
  const catalogCode = source.slice(source.indexOf('  // ---- Claude Code model catalog'), source.indexOf('  // Account-wide plan usage'));
  vm.runInContext(catalogCode, scope);
  const receive = source.slice(source.indexOf('      case "models":'), source.indexOf('      // Codex\'s plan limits'));
  vm.runInContext('function receive(msg) { switch (msg.type) { ' + receive + ' } }', scope);
  return { ...result, storage, callbacks };
}
const claudeRows = [
  { id: 'default', label: 'Default (recommended)', resolvedModel: 'claude-opus-new[1m]', contextLimit: 1000000 },
  { id: 'sonnet', label: 'Sonnet', resolvedModel: 'claude-sonnet-5', description: 'From the CLI' },
  { id: 'future[1m]', label: 'Future model', contextLimit: 1000000 },
];

test('CLI catalog replaces fallback, persists new models and leaves saved chat models unchanged', () => {
  const { scope, storage, chat } = claudeCatalogSetup();
  Object.assign(chat, { harness: 'claude', model: 'claude-retired-model' });
  scope.refreshClaudeModels();
  scope.receive({ type: 'models', agent: 'claude', models: claudeRows, defaultModel: 'default' });
  assert.deepEqual(Array.from(scope.MODELS, m => m.id), ['default', 'sonnet', 'future[1m]']);
  assert.equal(scope.MODELS[1].description, 'From the CLI');
  assert.equal(scope.CONTEXT_LIMITS.sonnet, 1000000);
  assert.equal(scope.CONTEXT_LIMITS.default, 1000000);
  assert.equal(scope.DEFAULT_MODEL, 'default');
  assert.equal(chat.model, 'claude-retired-model');
  assert.equal(scope.claudeCatalog.fetching, false);
  assert.ok(storage.rkClaudeModelCatalog);
  const catalog = scope.MODELS;
  scope.receive({ type: 'modelsError', agent: 'claude', error: 'offline' });
  assert.equal(scope.MODELS, catalog);
  assert.equal(scope.claudeCatalog.error, 'offline');
  scope.receive({ type: 'models', agent: 'claude', models: [{ id: '', label: 'invalid' }] });
  assert.equal(scope.MODELS, catalog);
});

test('late storage reads cannot overwrite live CLI models, while offline cache still works', () => {
  const { scope, callbacks } = claudeCatalogSetup();
  let done = 0;
  scope.loadModelCatalog(() => done++);
  const cache = { rkClaudeModelCatalog: { models: [{ id: 'cached', label: 'Cached' }] } };
  callbacks.shift()(cache);
  assert.equal(scope.MODELS[0].id, 'cached');
  scope.loadModelCatalog(() => done++);
  scope.receiveClaudeModels({ type: 'models', agent: 'claude', models: claudeRows });
  callbacks.shift()(cache);
  assert.equal(scope.MODELS[0].id, 'default');
  assert.equal(done, 2);
});
