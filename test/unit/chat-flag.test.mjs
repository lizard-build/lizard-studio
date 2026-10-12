import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/panel/chat.js', import.meta.url), 'utf8');
const consts = source.slice(source.indexOf('  const BOOKMARK_COLORS = ['), source.indexOf('  let tabTip = null'));
const picker = source.slice(source.indexOf('  function flagPicker('), source.indexOf('  // The chat menu\'s flag picker'));

// Just enough of an element for flagPicker: attributes, children, click handlers.
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
  const box = scope.flagPicker(target, () => changes++);
  const pressed = () => box.children.filter((b) => b.attrs['aria-pressed'] === 'true').map((b) => b.dataset.bookmarkColor);
  const choice = (id) => box.children.find((b) => b.dataset.bookmarkColor === id);
  return { target, box, pressed, choice, changes: () => changes };
}

test('the picker offers no flag plus every color and marks the current one', () => {
  const p = setup(null);
  assert.deepEqual(p.box.children.map((b) => b.dataset.bookmarkColor), ['', 'violet', 'pink', 'coral', 'white']);
  assert.deepEqual(p.pressed(), ['']);
  assert.equal(p.choice('').attrs['aria-label'], 'No flag');
  assert.equal(p.choice('coral').attrs['aria-label'], 'Coral flag');
  assert.deepEqual(setup('pink').pressed(), ['pink']);
});

test('picking a color sets it, and picking it again or no flag clears it', () => {
  const p = setup(null);
  p.choice('violet').click();
  assert.equal(p.target.bookmarkColor, 'violet'); assert.deepEqual(p.pressed(), ['violet']);
  p.choice('violet').click();
  assert.equal(p.target.bookmarkColor, null); assert.deepEqual(p.pressed(), ['']);
  p.choice('white').click(); p.choice('').click();
  assert.equal(p.target.bookmarkColor, null); assert.equal(p.changes(), 4);
});
