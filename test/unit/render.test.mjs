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
