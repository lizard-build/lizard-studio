import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/host/install.mjs", import.meta.url), "utf8");
const start = source.indexOf("function install() {") + "function install() {".length;
const detection = source.slice(start, source.indexOf("  // The launcher embeds", start));

for (const installed of [[], ["codex"], ["claude"], ["codex", "claude"]]) {
  test(`installation accepts either agent: ${installed.join(", ") || "neither"}`, () => {
    const warnings = [];
    vm.runInNewContext(detection, {
      process: { execPath: "/test/node", versions: { node: "22.0.0" } },
      whichBin: (name) => installed.includes(name) ? "/test/" + name : "",
      console: { warn: (message) => warnings.push(message) },
      fail: (message) => { throw new Error(message); },
    });
    if (installed.length) assert.deepEqual(warnings, []);
    else {
      assert.match(warnings.join("\n"), /Install either Claude Code or Codex CLI/);
      assert.ok(warnings.includes("  npm i -g @openai/codex"));
      assert.ok(warnings.includes("  npm i -g @anthropic-ai/claude-code"));
    }
  });
}
