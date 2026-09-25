import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import * as path from "node:path";

async function relay() {
  const output = [], requests = [], timers = new Set();
  const sock = new EventEmitter(); sock.setEncoding = () => {};
  let respond = (m) => ({ ok: true, data: m.op === "tab_open" ? { tabId: 22 } : m.op === "eval" ? { result: { matched: true, url: "https://test.invalid/", title: "Test", text: "Ready", truncated: false } } : { done: true } });
  sock.write = (line) => {
    const m = JSON.parse(line); requests.push(m);
    Promise.resolve().then(() => respond(m)).then((res) => {
      if (res) sock.emit("data", JSON.stringify({ reqId: m.reqId, ...res }) + "\n");
    });
  };
  const proc = { env: { RK_BRIDGE_PORT: "1234", RK_BRIDGE_TOKEN: "test-token", RK_BRIDGE_SESSION: "test-session" },
    stdin: new EventEmitter(), stdout: { write: (line) => output.push(JSON.parse(line)) }, exit: () => {} };
  proc.stdin.setEncoding = () => {};
  // No sibling modules: legacy self-updaters copy only the known relay file.
  const imports = { "node:net": { default: { connect: () => sock } }, "node:fs": { readFileSync() {}, statSync() {} }, "node:path": path };
  const context = createContext({ process: proc, console, Buffer, URL,
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.add(t); return t; }, clearTimeout: (t) => timers.delete(t) });
  const source = readFileSync(new URL("../../src/host/mcp-browser.mjs", import.meta.url), "utf8");
  const module = new SourceTextModule(source + "\nexport { handle };", { context });
  await module.link((name) => {
    const values = imports[name]; assert.ok(values, name);
    return new SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, { context });
  });
  await module.evaluate(); sock.emit("connect");
  return { api: module.namespace, output, requests, timers, sock, respond: (fn) => { respond = fn; } };
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

test("MCP publishes workflow schemas alongside existing browser tools", async () => {
  const r = await relay(); await r.api.handle({ id: 1, method: "tools/list" });
  const names = r.output[0].result.tools.map((t) => t.name);
  for (const name of ["browser_click", "browser_run", "browser_fill_form", "browser_check_pages", "browser_cancel", "browser_dialog", "browser_handle_dialog"]) assert.ok(names.includes(name), name);
  assert.equal(new Set(names).size, names.length);
});

test("MCP relays an explicit dialog answer and preserves recovery errors", async () => {
  const r = await relay();
  await r.api.handle({ id: 1, method: "tools/list" });
  const schema = r.output[0].result.tools.find(t => t.name === "browser_handle_dialog").inputSchema;
  assert.deepEqual(Array.from(schema.required), ["tabId", "dialogId", "accept"]);
  const args = { tabId: 11, dialogId: "dialog-1", accept: false };
  await r.api.handle({ id: 2, method: "tools/call", params: { name: "browser_handle_dialog", arguments: args } });
  assert.equal(r.requests[0].op, "handle_dialog");
  assert.deepEqual(r.requests[0].args, args);
  r.respond(() => ({ ok: false, error: 'BROWSER_DIALOG_OPEN: {"dialogId":"dialog-2","type":"beforeunload"}. Call browser_handle_dialog.' }));
  await r.api.handle({ id: 3, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "https://test.invalid/" } } });
  assert.equal(r.output.at(-1).result.isError, true);
  assert.match(r.output.at(-1).result.content[0].text, /dialog-2.*beforeunload.*browser_handle_dialog/);
});

for (const failure of ["disconnect", "timeout"]) test(`a browser ${failure} calls for a read without asking to reopen the panel`, async () => {
  const r = await relay(); r.respond(() => null);
  const pending = r.api.handle({ id: 7, method: "tools/call", params: { name: "browser_click", arguments: { selector: "#save" } } });
  await flush();
  if (failure === "disconnect") r.sock.emit("close");
  else [...r.timers].find(t => t.ms === 30000).fn();
  await pending;
  const error = r.output.at(-1).result.content[0].text;
  assert.match(error, failure === "disconnect" ? /lost its browser connection/ : /connection timed out/);
  assert.match(error, /Check browser access with a read before retrying an action/);
  assert.match(error, /continue work that does not need browser access/);
  assert.doesNotMatch(error, /reopen Lizard Studio|open (?:the |its )?side panel|restart the extension/i);
  assert.deepEqual(r.requests.map(m => m.op), ["click"]);
  assert.equal(r.output.at(-1).result.isError, true);
});

test("one MCP request performs multiple bridge operations and returns one compact result", async () => {
  const r = await relay();
  await r.api.handle({ id: 2, method: "tools/call", params: { name: "browser_open_page", arguments: { url: "https://test.invalid/" } } });
  assert.equal(r.output.length, 1);
  const result = JSON.parse(r.output[0].result.content[0].text);
  assert.equal(result.status, "completed"); assert.equal(result.hostCalls, 3);
  assert.deepEqual(r.requests.map((m) => m.op), ["tab_open", "eval", "eval"]);
  assert.ok(r.requests.every((m) => m.token === "test-token" && m.session === "test-session"));
  assert.equal(r.timers.size, 0, "completed bridge calls must clear timeout handles");
});

test("a rejected plan produces an MCP error without browser operations", async () => {
  const r = await relay();
  await r.api.handle({ id: 3, method: "tools/call", params: { name: "browser_run", arguments: { steps: [{ op: "eval", args: { expression: "process.exit()" } }] } } });
  assert.equal(r.output[0].result.isError, true); assert.equal(r.requests.length, 0);
});

test("MCP cancellation stops the plan after its current operation", async () => {
  const r = await relay(); r.respond(() => null);
  const running = r.api.handle({ id: 4, method: "tools/call", params: { name: "browser_run", arguments: { tabId: 1, steps: [
    { op: "click", args: { selector: "#save" } }, { op: "fill", args: { selector: "#name", value: "later" } },
  ] } } });
  await flush();
  await r.api.handle({ method: "notifications/cancelled", params: { requestId: 4 } });
  await running;
  assert.equal(JSON.parse(r.output[0].result.content[0].text).status, "cancelled");
  assert.deepEqual(r.requests.map((m) => m.op), ["click"]);
});

test("host stop messages cancel a workflow without another model request", async () => {
  const r = await relay(); r.respond(() => null);
  const running = r.api.handle({ id: 5, method: "tools/call", params: { name: "browser_run", arguments: { tabId: 1, steps: [{ op: "click", args: { selector: "#save" } }] } } });
  await flush(); r.sock.emit("data", JSON.stringify({ type: "workflowCancel" }) + "\n");
  await running;
  assert.equal(JSON.parse(r.output[0].result.content[0].text).status, "cancelled");
});
