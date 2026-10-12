import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function renderer(paths = true) {
  const window = {};
  runInNewContext(readFileSync(new URL("../../src/panel/render.js", import.meta.url), "utf8"), { window });
  if (paths) window.RKRender.enablePathLinks();
  return window.RKRender.inlineMarkdown;
}

test("Codex file links keep labels, spaces, underscores, parentheses and line suffixes", () => {
  const render = renderer();
  for (const [input, path, label] of [
    ["[план на 8 недель](/Users/me/lizard/AEO-PLAN.md)", "/Users/me/lizard/AEO-PLAN.md", "план на 8 недель"],
    ["[My report](</Users/me/My Project/_draft_(1).md:12>)", "/Users/me/My Project/_draft_(1).md", "My report"],
    ["[source](src/main.js#L42)", "src/main.js", "source"],
    ["[file](C:\\work\\file.md:10:2)", "C:\\work\\file.md", "file"],
  ]) {
    const html = render(input);
    assert.ok(html.includes(`data-path="${path}"`), html);
    assert.ok(html.includes(`>${label}</a>`), html);
  }
});

test("code and URLs never get rewritten by later formatting passes", () => {
  const render = renderer();
  assert.equal(render("`**plain**`"), '<code class="inline">**plain**</code>');
  assert.ok(render("`/tmp/_draft_.md`").includes('data-path="/tmp/_draft_.md"'));
  const html = render("[https://example.com/_x_](https://example.com/_x_)");
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.ok(html.includes('href="https://example.com/_x_"'));
  assert.equal(render("`https://example.com`"), '<code class="inline">https://example.com</code>');
});

test("untrusted schemes and markup stay inert, and paths remain opt-in", () => {
  const render = renderer();
  for (const text of ["[bad](javascript:alert(1))", "[bad](data:text/html,hello)", "[bad](//evil.example/path)", "<img src=x onerror=alert(1)>"]) {
    const html = render(text);
    assert.ok(!html.includes("<a ") && !html.includes("<img"), html);
  }
  const html = render('[file](</tmp/a" onclick="bad.md>)');
  assert.ok(html.includes("&quot;")); assert.ok(!html.includes(' onclick="'));
  assert.equal(renderer(false)("[file](/tmp/report.md)"), "[file](/tmp/report.md)");
});

test("emphasis wraps code, links and URLs, and stray marks stay text", () => {
  const render = renderer(false);
  assert.equal(render("**1. A `sandbox` skill** (`4a63e56`)"),
    '<strong>1. A <code class="inline">sandbox</code> skill</strong> (<code class="inline">4a63e56</code>)');
  assert.equal(render("**see [docs](https://x.com)**"),
    '<strong>see <a href="https://x.com" target="_blank" rel="noopener noreferrer">docs</a></strong>');
  assert.equal(render("**https://x.com**, then"),
    '<strong><a href="https://x.com" target="_blank" rel="noopener noreferrer">https://x.com</a></strong>, then');
  assert.equal(render("_note `x`_"), '<em>note <code class="inline">x</code></em>');
  assert.equal(render("**foo *bar* baz**"), "<strong>foo <em>bar</em> baz</strong>");
  assert.equal(render("***both*** ~~old~~"), "<strong><em>both</em></strong> <del>old</del>");
  for (const text of ["files *.md or *.txt", "2 * 3 * 4", "**a", "snake_case_name", "при_мер_тест"]) {
    assert.equal(render(text), text);
  }
  assert.equal(render("\\*not italic\\* and \\_x\\_"), "*not italic* and _x_");
  assert.equal(render("``a ` b``"), '<code class="inline">a ` b</code>');
});

// Just enough DOM for markdown(): elements, innerHTML strings, moves.
function fakeDocument() {
  const detach = (n) => {
    if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1);
    n.parentNode = null;
  };
  class El {
    constructor(tag) {
      Object.assign(this, { tagName: tag.toUpperCase(), childNodes: [], parentNode: null, className: "", dataset: {}, attrs: {} });
      this.style = { setProperty() {} };
      this.classList = { add() {}, remove() {} };
    }
    set innerHTML(html) { this.childNodes = [{ html, parentNode: this }]; }
    set start(n) { this.attrs.start = n; }
    get firstElementChild() { return this.childNodes.find((c) => c.tagName) || null; }
    appendChild(c) { detach(c); c.parentNode = this; this.childNodes.push(c); return c; }
    append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
    replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
    replaceWith(...nodes) {
      const parent = this.parentNode;
      nodes.forEach(detach);
      parent.childNodes.splice(parent.childNodes.indexOf(this), 1, ...nodes);
      nodes.forEach((n) => (n.parentNode = parent));
      this.parentNode = null;
    }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener() {}
    get outerHTML() {
      if (this.className === "code-wrap") return `<pre>${this.childNodes[0].childNodes[0].childNodes[0].html.replace(/<[^>]+>/g, "")}</pre>`;
      const tag = this.tagName.toLowerCase();
      const start = this.attrs.start ? ` start="${this.attrs.start}"` : "";
      return `<${tag}${start}>${this.childNodes.map((c) => c.html ?? c.outerHTML).join("")}</${tag}>`;
    }
  }
  return { createElement: (tag) => new El(tag) };
}

function blocks(text) {
  const window = { RKIconHTML: () => "" };
  runInNewContext(readFileSync(new URL("../../src/panel/render.js", import.meta.url), "utf8"), { window, document: fakeDocument() });
  return window.RKRender.markdown(text).outerHTML.replace(/^<div>|<\/div>$/g, "");
}

test("lists nest, and keep wrapped text and code fences inside their item", () => {
  assert.equal(blocks("- a\n  - nested\n    - deeper\n- b"),
    "<ul><li>a<ul><li>nested<ul><li>deeper</li></ul></li></ul></li><li>b</li></ul>");
  assert.equal(blocks("1. one\n   - sub\n2. two"), "<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol>");
  assert.equal(blocks("1. step\n   ```text\n   echo *a*\n   ```\n2. next"),
    "<ol><li>step<pre>echo *a*</pre></li><li>next</li></ol>");
  assert.equal(blocks("1. a\n   wrapped\n\n3) c"), "<ol><li>a<br>wrapped</li><li>c</li></ol>");
  assert.equal(blocks("- a\n\nafter"), "<ul><li>a</li></ul><p>after</p>");
});

test("quotes, rules, headings and fences beyond the basics", () => {
  assert.equal(blocks("> **quoted**\n> - item"), "<blockquote><p><strong>quoted</strong></p><ul><li>item</li></ul></blockquote>");
  assert.equal(blocks("a\n---\n* * *\nb"), "<p>a</p><hr></hr><hr></hr><p>b</p>");
  assert.equal(blocks("##### Five ##"), "<h5>Five</h5>");
  assert.equal(blocks("````text\n```js\nx\n```\n````"), "<pre>```js\nx\n```</pre>");
  assert.equal(blocks("| a |\n|---|\n| `x\\|y` |"), '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td><code class="inline">x|y</code></td></tr></tbody></table>');
});
