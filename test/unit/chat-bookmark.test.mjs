import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const consts = source.slice(source.indexOf('  const BOOKMARK_COLORS = ['), source.indexOf('  let tabTip = null'));
const picker = source.slice(source.indexOf('  function bookmarkPicker('), source.indexOf('  // The chat menu\'s bookmark picker'));

// Just enough of an element for bookmarkPicker: attributes, children, click handlers.
function el(tag, className) {
  const node = {
    tag, className, dataset: {}, style: {}, attrs: {}, children: [], handlers: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelectorAll() { return this.children; },
    click() { this.handlers.click({ stopPropagation() {} }); },
  };
  return node;
}

function setup(bookmarkColor) {
  const scope = { el };
  vm.createContext(scope);
  vm.runInContext(consts.replace(/^  const /gm, 'var ') + picker, scope);
  const target = { id: 'a', bookmarkColor };
  let changes = 0;
  const box = scope.bookmarkPicker(target, () => changes++);
  const pressed = () => box.children.filter((b) => b.attrs['aria-pressed'] === 'true').map((b) => b.dataset.bookmarkColor);
  const choice = (id) => box.children.find((b) => b.dataset.bookmarkColor === id);
  return { target, box, pressed, choice, changes: () => changes };
}

test('the picker offers no bookmark plus every color and marks the current one', () => {
  const p = setup(null);
  assert.deepEqual(p.box.children.map((b) => b.dataset.bookmarkColor), ['', 'violet', 'pink', 'coral', 'white']);
  assert.deepEqual(p.pressed(), ['']);
  assert.equal(p.choice('').attrs['aria-label'], 'No bookmark');
  assert.equal(p.choice('coral').attrs['aria-label'], 'Coral bookmark');
  assert.deepEqual(setup('pink').pressed(), ['pink']);
});

test('picking a color sets it, and picking it again or no bookmark clears it', () => {
  const p = setup(null);
  p.choice('violet').click();
  assert.equal(p.target.bookmarkColor, 'violet'); assert.deepEqual(p.pressed(), ['violet']);
  p.choice('violet').click();
  assert.equal(p.target.bookmarkColor, null); assert.deepEqual(p.pressed(), ['']);
  p.choice('white').click(); p.choice('').click();
  assert.equal(p.target.bookmarkColor, null); assert.equal(p.changes(), 4);
});

const filter = source.slice(source.indexOf('  // One button per color at the end of the search field'), source.indexOf('  function hideTabTip('));

function setupFilter() {
  const box = el('div');
  const list = { scrollTop: 120 };
  let renders = 0;
  const scope = { el, els: { chatMenuBookmarkFilter: box, chatMenuList: list }, menuBookmarkFilter: '', HISTORY_PAGE_SIZE: 40, historyVisibleLimit: 120, renderChatMenuList: () => renders++ };
  vm.createContext(scope);
  vm.runInContext(consts.replace(/^  const /gm, 'var ') + filter.replace(/^  function /gm, 'function '), scope);
  scope.renderBookmarkFilter();
  const choice = (id) => box.children.find((b) => b.dataset.bookmarkColor === id);
  const pressed = () => box.children.filter((b) => b.attrs['aria-pressed'] === 'true').map((b) => b.dataset.bookmarkColor);
  return { scope, box, list, choice, pressed, renders: () => renders };
}

test('the menu filter offers one button per color, none picked', () => {
  const f = setupFilter();
  assert.deepEqual(f.box.children.map((b) => b.dataset.bookmarkColor), ['violet', 'pink', 'coral', 'white']);
  assert.deepEqual(f.pressed(), []);
  assert.equal(f.choice('pink').attrs['aria-label'], 'Pink bookmarks');
  assert.equal(f.choice('pink').title, 'Show pink bookmarks');
  f.scope.renderBookmarkFilter();
  assert.equal(f.box.children.length, 4);
});

test('picking a filter color narrows to it, another color swaps, the same color shows all', () => {
  const f = setupFilter();
  f.choice('violet').click();
  assert.equal(f.scope.menuBookmarkFilter, 'violet'); assert.deepEqual(f.pressed(), ['violet']);
  assert.equal(f.choice('violet').title, 'Show all chats');
  assert.equal(f.scope.historyVisibleLimit, 40); assert.equal(f.list.scrollTop, 0);
  f.choice('white').click();
  assert.equal(f.scope.menuBookmarkFilter, 'white'); assert.deepEqual(f.pressed(), ['white']);
  f.choice('white').click();
  assert.equal(f.scope.menuBookmarkFilter, ''); assert.deepEqual(f.pressed(), []);
  assert.equal(f.renders(), 3);
});
