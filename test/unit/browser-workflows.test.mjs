import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createWorkflowRunner, WORKFLOW_TOOLS } from "../../src/host/browser-workflows.mjs";

const relay = readFileSync(new URL("../../src/host/mcp-browser.mjs", import.meta.url), "utf8");
const primitiveTools = vm.runInNewContext(relay.slice(relay.indexOf("const TAB_ID ="), relay.indexOf("// ---- TCP bridge")) + "\nTOOLS");
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function fixture(config = {}) {
  let clock = 0, nextTab = 10, pinned = 1;
  const calls = [], pages = new Map(), gates = {}, closes = [];
  function page(url = "https://test.invalid/") {
    const p = { url, title: "Test", text: "Test form", ready: true, submits: 0 };
    const input = { value: "", innerText: "", getClientRects: () => [{}] };
    const result = { innerText: "", getClientRects: () => [{}] };
    p.nodes = { "#name": input, "#result": result, "#save": { getClientRects: () => [{}] } };
    return p;
  }
  pages.set(1, page());
  const callHost = async (op, args = {}) => {
    calls.push({ op, args }); clock += 2;
    if (gates[op]) await gates[op](args);
    if (op === "tabs") return { ok: true, data: { activeTabId: 1, workingTabId: pinned } };
    if (op === "tab_open") {
      const tabId = ++nextTab; pages.set(tabId, page(args.url));
      if (!args.preserveWorkingTab) pinned = tabId;
      return { ok: true, data: { tabId } };
    }
    if (op === "tab_close") { closes.push(args.tabId); pages.delete(args.tabId); return { ok: true, data: { closed: true } }; }
    const p = pages.get(args.tabId);
    if (!p) return { ok: false, error: "No tab" };
    if (!args.preserveWorkingTab) pinned = args.tabId;
    if (op === "fill") { p.nodes[args.selector].value = args.value; return { ok: true, data: { filled: true } }; }
    if (op === "click") { p.submits++; p.text = p.nodes["#result"].innerText = "Saved " + p.nodes["#name"].value; return { ok: true, data: { clicked: true } }; }
    if (op === "navigate") p.url = args.url;
    if (op === "eval") {
      const document = { title: p.title, readyState: p.ready ? "complete" : "loading", body: { innerText: p.text },
        querySelector: (s) => { if (s === "[") throw new Error("Invalid selector"); return p.nodes[s] || null; },
        querySelectorAll: (s) => { if (s === "[") throw new Error("Invalid selector"); return p.nodes[s] ? [p.nodes[s]] : []; } };
      try { return { ok: true, data: { result: vm.runInNewContext(args.expression, { document, location: { href: p.url }, getComputedStyle: () => ({ visibility: "visible", display: "block" }) }) } }; }
      catch (e) { return { ok: true, data: { error: e.message } }; }
    }
    return { ok: true, data: { done: true } };
  };
  const runner = createWorkflowRunner(callHost, primitiveTools, {
    now: () => clock, sleep: async (ms) => { clock += ms; config.onSleep?.(pages, clock); }, ...config,
  });
  return { runner, callHost, calls, pages, gates, closes, pinned: () => pinned, advance: (ms) => { clock += ms; } };
}

test("a form executes, verifies and observes without intermediate model calls", async () => {
  const f = fixture();
  const result = await f.runner.execute("browser_fill_form", { tabId: 1,
    fields: [{ selector: "#name", value: "Studio" }], submit: { selector: "#save" },
    waitFor: { selector: "#result", textIncludes: "Saved Studio" } });
  assert.equal(result.status, "completed");
  assert.equal(result.completedSteps, 4);
  assert.equal(result.observation.text, "Saved Studio");
  assert.equal(f.pages.get(1).submits, 1);
  assert.equal(result.hostCalls, 4);
  const log = await f.runner.execute("browser_run_result", { runId: result.runId, limit: 2 });
  assert.equal(log.steps.length, 2); assert.equal(log.nextStep, 2);
  assert.ok(!JSON.stringify(log.steps).includes('"value":"Studio"'), "the log should not echo form inputs");
});

test("the complete plan and both branches validate before any side effect", async () => {
  const f = fixture();
  await assert.rejects(f.runner.execute("browser_run", { tabId: 1, steps: [
    { op: "click", args: { selector: "#save" } },
    { op: "if", args: { condition: { ready: true }, then: [{ op: "eval", args: { expression: "danger()" } }] } },
  ] }), /Unsupported/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.runner.execute("browser_fill_form", { fields: [{ selector: "#name", value: "x" }], submit: { selector: "#save" } }), /requires waitFor/);
  assert.equal(f.calls.length, 0);
});

test("if chooses a branch locally and a failed assertion stops later writes", async () => {
  const f = fixture();
  const r = await f.runner.execute("browser_run", { tabId: 1, steps: [
    { op: "if", args: { condition: { selector: "#missing", state: "absent" }, then: [{ op: "fill", args: { selector: "#name", value: "A" } }], otherwise: [{ op: "click", args: { selector: "#save" } }] } },
    { op: "assert", args: { condition: { textIncludes: "not here" } } },
    { op: "click", args: { selector: "#save" } },
  ] });
  assert.equal(r.status, "failed"); assert.match(r.error, /Assertion failed/);
  assert.equal(f.pages.get(1).nodes["#name"].value, "A");
  assert.equal(f.pages.get(1).submits, 0);
});

test("waits pause and resume at the predicate without replaying the click", async () => {
  const f = fixture({ sliceMs: 100 });
  const r = await f.runner.execute("browser_run", { tabId: 1, steps: [
    { op: "click", args: { selector: "#save" } },
    { op: "wait_for", args: { condition: { textIncludes: "Ready now" }, timeoutMs: 1000 } },
    { op: "observe" },
  ] });
  assert.equal(r.status, "paused"); assert.equal(r.completedSteps, 1);
  f.pages.get(1).text = "Ready now";
  const resumed = await f.runner.execute("browser_resume", { runId: r.runId });
  assert.equal(resumed.status, "completed");
  assert.equal(f.pages.get(1).submits, 1);
});

test("a wait times out and cannot resume a failed action sequence", async () => {
  const f = fixture();
  const r = await f.runner.execute("browser_click_and_observe", { tabId: 1, target: { selector: "#save" }, waitFor: { textIncludes: "Never" } });
  assert.equal(r.status, "failed"); assert.match(r.error, /Condition timed out/);
  assert.equal(f.pages.get(1).submits, 1);
  await assert.rejects(f.runner.execute("browser_resume", { runId: r.runId }), /Only paused/);
});

test("changes are scoped by tab and selector and mark truncation", async () => {
  const f = fixture();
  const a = await f.runner.execute("browser_observe", { tabId: 1, mode: "changes", maxChars: 100 });
  assert.equal(a.observation.baseline, true);
  f.pages.get(1).text = "Updated\n" + "x".repeat(200);
  const b = await f.runner.execute("browser_observe", { tabId: 1, mode: "changes", maxChars: 100 });
  assert.equal(b.observation.changed, true); assert.equal(b.observation.truncated, true);
  assert.ok(!("text" in b.observation));
  assert.ok(b.observation.removed.includes("Test form"));
  const c = await f.runner.execute("browser_observe", { tabId: 1, selector: "#result", mode: "changes", maxChars: 100 });
  assert.equal(c.observation.baseline, true);
});

test("cancellation stops further steps after an in-flight action", async () => {
  const f = fixture(); let release;
  f.gates.click = () => new Promise((resolve) => { release = resolve; });
  const running = f.runner.execute("browser_run", { tabId: 1, steps: [
    { op: "click", args: { selector: "#save" } }, { op: "fill", args: { selector: "#name", value: "should not run" } },
  ] }, 42);
  await flush(); f.runner.cancelRequest(42);
  const r = await running;
  assert.equal(r.status, "cancelled");
  release(); await flush();
  assert.equal(f.calls.filter((c) => c.op === "fill").length, 0);
  const log = await f.runner.execute("browser_run_result", { runId: r.runId });
  assert.equal(log.steps[0].actionMayHaveRun, true);
});

test("parallel page checks bound concurrency, close owned tabs and preserve pinning", async () => {
  const f = fixture(); const release = [];
  let active = 0, maxActive = 0;
  f.gates.tab_open = async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => release.push(r)); active--; };
  const running = f.runner.execute("browser_check_pages", { concurrency: 2, pages: ["a", "b", "c"].map((x) => ({ url: "https://test.invalid/" + x, checks: [{ textIncludes: "Test form" }] })) });
  await flush(); assert.equal(release.length, 2);
  release.shift()(); release.shift()();
  await flush(); assert.equal(release.length, 1); release.shift()();
  const r = await running;
  assert.equal(r.status, "completed"); assert.equal(r.passed, 3);
  assert.equal(maxActive, 2); assert.equal(f.pinned(), 1);
  assert.equal(f.closes.length, 3); assert.deepEqual([...f.pages.keys()], [1]);
  assert.equal(r.hostCalls, f.calls.length);
  assert.ok(r.pages.every((p) => p.closed));
});

test("cancelling while a batch tab opens still closes that exact tab", async () => {
  const f = fixture(); let release;
  f.gates.tab_open = () => new Promise((r) => { release = r; });
  const running = f.runner.execute("browser_check_pages", { concurrency: 1, pages: [{ url: "https://test.invalid/a" }, { url: "https://test.invalid/b" }] });
  await flush(); f.runner.cancelAll(); release();
  const r = await running;
  assert.equal(r.status, "cancelled"); assert.equal(f.closes.length, 1);
  assert.equal(f.calls.filter((c) => c.op === "tab_open").length, 1);
  assert.deepEqual([...f.pages.keys()], [1]);
});

test("invalid bulk requests create no tabs and expose no arbitrary code tool", async () => {
  const f = fixture();
  await assert.rejects(f.runner.execute("browser_check_pages", { pages: [{ url: "https://test.invalid" }, { url: "file:///etc/passwd" }] }), /http/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.runner.execute("browser_run", { steps: [{ op: "observe" }], unexpected: true }), /Unknown field/);
  assert.equal(WORKFLOW_TOOLS.some((t) => t.inputSchema.properties.code), false);
});

test("long page batches resume remaining URLs without opening completed ones twice", async () => {
  const f = fixture({ sliceMs: 3 });
  const pages = ["a", "b", "c"].map((x) => ({ url: "https://test.invalid/" + x }));
  let r = await f.runner.execute("browser_check_pages", { pages, concurrency: 1 });
  assert.equal(r.status, "paused");
  while (r.status === "paused") r = await f.runner.execute("browser_resume", { runId: r.runId });
  assert.equal(r.passed, 3);
  assert.equal(f.calls.filter((c) => c.op === "tab_open").length, 3);
});

test("one run cannot race another plan on the same tab", async () => {
  const f = fixture(); let release;
  f.gates.click = () => new Promise((r) => { release = r; });
  const first = f.runner.execute("browser_run", { tabId: 1, steps: [{ op: "click", args: { selector: "#save" } }] });
  await flush();
  const second = await f.runner.execute("browser_run", { tabId: 1, steps: [{ op: "fill", args: { selector: "#name", value: "race" } }] });
  assert.equal(second.status, "failed"); assert.match(second.error, /Another plan/);
  release(); await first;
  assert.equal(f.pages.get(1).nodes["#name"].value, "");
});

test("a missing created tab id never falls back to the user's working tab", async () => {
  const calls = [];
  const runner = createWorkflowRunner(async (op) => { calls.push(op); return { ok: true, data: {} }; }, primitiveTools);
  const r = await runner.execute("browser_check_pages", { pages: [{ url: "https://test.invalid/" }] });
  assert.equal(r.status, "failed");
  assert.match(r.pages[0].error, /no tab id/);
  assert.deepEqual(calls, ["tab_open"]);
});

test("cleanup failures remain visible and fail the page report", async () => {
  const f = fixture();
  const runner = createWorkflowRunner((op, args) => op === "tab_close"
    ? Promise.resolve({ ok: false, error: "Close failed" }) : f.callHost(op, args), primitiveTools);
  const r = await runner.execute("browser_check_pages", { pages: [{ url: "https://test.invalid/" }] });
  assert.equal(r.status, "failed"); assert.equal(r.passed, 0);
  assert.equal(r.pages[0].closed, false); assert.equal(r.pages[0].cleanupError, "Close failed");
});
