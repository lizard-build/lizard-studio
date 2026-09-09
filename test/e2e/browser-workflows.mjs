// Real MCP relay + TCP bridge + shipped panel code + Chrome extension APIs.
// The test host uses local HTTP in place of Chrome native messaging. No model,
// account, installed extension, or user browser profile is used.
// Run: STUDIO_TEST_CHROME=/path/to/chrome node test/e2e/browser-workflows.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "studio-workflow-test-"));
const session = "studio-workflow-test-" + process.pid;
const queue = [], waiters = [], pending = new Map(), rpcPending = new Map();
const sockets = new Set();
const trace = (...args) => { if (process.env.STUDIO_TEST_TRACE) console.error(new Date().toISOString(), ...args); };
let bid = 0, rpcId = 0, child, browserOpened = false;
const html = (detail = false) => detail
  ? '<!doctype html><title>Details</title><h1>Detail page</h1><a href="/form">Home</a>'
  : '<!doctype html><title>Workflow test</title><h1>Test form</h1><label>Name <input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=\'Saved \'+document.querySelector(\'#name\').value">Save</button><p id="result"></p><a id="details" href="/detail">Details</a>';
const http = createServer(async (req, res) => {
  if (req.url === "/command") {
    res.setHeader("Content-Type", "application/json");
    if (queue.length) return res.end(JSON.stringify(queue.shift()));
    const timer = setTimeout(() => { const i = waiters.indexOf(res); if (i >= 0) waiters.splice(i, 1); res.writeHead(204); res.end(); }, 1000);
    res.on("close", () => { clearTimeout(timer); const i = waiters.indexOf(res); if (i >= 0) waiters.splice(i, 1); });
    waiters.push(res); return;
  }
  if (req.url === "/result" && req.method === "POST") {
    let body = ""; for await (const part of req) body += part;
    const m = JSON.parse(body), request = pending.get(m.bid);
    trace("result", m.bid, m.ok, m.error || "");
    if (request) { pending.delete(m.bid); request.sock.write(JSON.stringify({ reqId: request.reqId, ok: m.ok, data: m.data, error: m.error }) + "\n"); }
    res.end("ok"); return;
  }
  res.setHeader("Content-Type", "text/html");
  if (req.url.startsWith("/slow")) setTimeout(() => res.end(html()), 600);
  else res.end(html(req.url === "/detail"));
});
const bridge = net.createServer((sock) => {
  sockets.add(sock); sock.on("close", () => sockets.delete(sock));
  let input = ""; sock.setEncoding("utf8"); sock.on("error", () => {});
  sock.on("data", (chunk) => {
    input += chunk;
    let nl;
    while ((nl = input.indexOf("\n")) >= 0) {
      const m = JSON.parse(input.slice(0, nl)); input = input.slice(nl + 1);
      assert.equal(m.token, "local-test-token");
      const id = ++bid; pending.set(id, { sock, reqId: m.reqId });
      trace("request", id, m.op);
      const command = { type: "browser", bid: id, op: m.op, args: m.args, session: m.session };
      if (waiters.length) waiters.shift().end(JSON.stringify(command)); else queue.push(command);
    }
  });
});
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
async function browser(...args) {
  const result = await exec("agent-browser", ["--session", session, ...args, "--json"], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  const value = JSON.parse(result.stdout);
  if (!value.success) throw new Error(value.error);
  return value.data;
}
function rpc(method, params) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { rpcPending.delete(id); reject(new Error(method + " timed out")); }, 60000);
    rpcPending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function tool(name, args) {
  trace("tool", name);
  const response = await rpc("tools/call", { name, arguments: args });
  const parsed = JSON.parse(response.result.content[0].text);
  assert.ok(!response.result.isError, JSON.stringify(parsed));
  return parsed;
}
const report = {};
try {
  const port = await listen(http), bridgePort = await listen(bridge), origin = "http://127.0.0.1:" + port;
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Studio workflow test", version: "1.0.0", key: manifest.key,
    permissions: ["tabs", "debugger", "scripting"], host_permissions: [origin + "/*"] }));
  writeFileSync(join(dir, "harness.html"), '<!doctype html><title>Studio workflow test</title><h1>Studio workflow test</h1><script src="setup.js"></script><script src="chat.js"></script><script src="poll.js"></script>');
  writeFileSync(join(dir, "setup.js"), 'window.RKRender={};window.RKIconHTML=()=>"";');
  const source = readFileSync(join(root, "src/panel/chat.js"), "utf8").replace("  window.RKChat =", `  window.browserTest={handleBrowserOp}; port={postMessage:m=>fetch(${JSON.stringify(origin + "/result")},{method:"POST",body:JSON.stringify(m)})};\n  window.RKChat =`);
  writeFileSync(join(dir, "chat.js"), source);
  writeFileSync(join(dir, "poll.js"), `(async()=>{while(true){const r=await fetch(${JSON.stringify(origin + "/command")});if(r.status===200)browserTest.handleBrowserOp(await r.json());}})().catch(console.error);`);
  const launch = ["--profile", join(dir, "profile"), "--extension", dir];
  if (process.env.STUDIO_TEST_CHROME) launch.push("--executable-path", process.env.STUDIO_TEST_CHROME);
  await browser(...launch, "open", "chrome-extension://nhcgkijjijdinhldjohkmbbgjokobecd/harness.html"); browserOpened = true;
  child = spawn(process.execPath, [join(root, "src/host/mcp-browser.mjs")], { env: { ...process.env, RK_BRIDGE_PORT: String(bridgePort), RK_BRIDGE_TOKEN: "local-test-token", RK_BRIDGE_SESSION: "workflow-test" }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => {
    output += chunk; let nl;
    while ((nl = output.indexOf("\n")) >= 0) { const m = JSON.parse(output.slice(0, nl)); output = output.slice(nl + 1); const p = rpcPending.get(m.id); if (p) { rpcPending.delete(m.id); p.resolve(m); } }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "workflow-test", version: "1" } });
  const definitions = await rpc("tools/list", {});
  assert.ok(definitions.result.tools.some((t) => t.name === "browser_run"));
  let started = performance.now();
  report.scenario = await tool("browser_run", { steps: [
    { op: "tab_open", args: { url: origin + "/form", active: true } },
    { op: "wait_for", args: { condition: { selector: "#save", state: "visible" } } },
    { op: "fill", args: { selector: "#name", value: "Studio" } },
    { op: "click", args: { selector: "#save" } },
    { op: "wait_for", args: { condition: { selector: "#result", textIncludes: "Saved Studio" } } },
    { op: "observe", args: { selector: "#result" } },
    { op: "click", args: { selector: "#details" } },
    { op: "wait_for", args: { condition: { urlIncludes: "/detail", textIncludes: "Detail page" } } },
    { op: "reload" },
    { op: "assert", args: { condition: { textIncludes: "Detail page" } } },
    { op: "observe" },
  ] });
  report.scenario.wallMs = Math.round(performance.now() - started);
  assert.equal(report.scenario.status, "completed"); assert.equal(report.scenario.completedSteps, 11);
  assert.ok(report.scenario.observation.text.includes("Detail page"));
  await tool("browser_open_page", { url: origin + "/form", active: true });
  report.form = await tool("browser_fill_form", { fields: [{ selector: "#name", value: "One call" }], submit: { selector: "#save" }, waitFor: { selector: "#result", textIncludes: "Saved One call" }, observe: { selector: "#result" } });
  assert.ok(report.form.observation.text.includes("Saved One call"));
  report.click = await tool("browser_click_and_observe", { target: { selector: "#details" }, waitFor: { urlIncludes: "/detail", textIncludes: "Detail page" } });
  const before = await rpc("tools/call", { name: "browser_tabs", arguments: {} });
  const beforeTab = JSON.parse(before.result.content[0].text).workingTabId;
  const pages = [1, 2, 3, 4].map((i) => ({ url: origin + "/slow?" + i, checks: [{ textIncludes: "Test form" }] }));
  started = performance.now(); report.parallel = await tool("browser_check_pages", { pages, concurrency: 3 }); report.parallel.wallMs = Math.round(performance.now() - started);
  assert.equal(report.parallel.passed, 4); assert.ok(report.parallel.pages.every((p) => p.closed));
  started = performance.now(); report.serial = await tool("browser_check_pages", { pages, concurrency: 1 }); report.serial.wallMs = Math.round(performance.now() - started);
  assert.equal(report.serial.passed, 4); assert.ok(report.serial.pages.every((p) => p.closed));
  report.pageCheckSpeedup = Number((report.serial.wallMs / report.parallel.wallMs).toFixed(2));
  const after = await rpc("tools/call", { name: "browser_tabs", arguments: {} });
  const afterTabs = JSON.parse(after.result.content[0].text);
  assert.equal(afterTabs.workingTabId, beforeTab);
  assert.ok(afterTabs.tabs.every((t) => !t.url.includes("/slow?")));
  report.pinPreserved = true;
  report.outputBytes = JSON.stringify(report.scenario).length;
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, artifacts: dir, report }, null, 2));
} finally {
  child?.stdin.end(); child?.kill("SIGTERM");
  if (browserOpened) await browser("close").catch(() => {});
  for (const sock of sockets) sock.destroy();
  for (const res of waiters) res.end();
  http.closeAllConnections(); http.close(); bridge.close();
}
