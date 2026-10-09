import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { EventEmitter } from "node:events";
import * as path from "node:path";

// The whole router module with its imports replaced: host files live in a map
// the test can rewrite, children are recorders, and time only moves on demand.
async function boot(env = {}) {
  let now = 1000000, exitCode = null;
  const files = new Map(["router.mjs", "hostkit.mjs", "codex-spawn.mjs", "claude-host.mjs", "codex-host.mjs", "mcp-browser.mjs"]
    .map((name) => ["/test/" + name, "v1 " + name]));
  const spawned = [], timers = [], intervals = [], notices = [];
  const proc = new EventEmitter();
  Object.assign(proc, { pid: 42, execPath: "/test/node", cwd: () => "/work", env,
    stdin: new EventEmitter(), stdout: new EventEmitter(), exit(code) { exitCode = code; } });
  proc.stdout.write = () => true;
  const imports = {
    "./codex-spawn.mjs": { createHostSpawner: () => ({ close() {}, spawn: (bin, args, options) => {
      const child = new EventEmitter();
      Object.assign(child, { args, env: options.env, killed: null, stdin: { write() {} }, stdout: new EventEmitter(), stderr: new EventEmitter(),
        kill(signal) { child.killed = signal; } });
      spawned.push(child);
      return child;
    } }) },
    "node:fs": { existsSync: () => true, chmodSync() {}, unlinkSync() {},
      readFileSync: (file) => { if (!files.has(file)) throw Error("ENOENT"); return files.get(file); } },
    "node:crypto": { createHash },
    "node:child_process": { spawn() { throw Error("unexpected detached spawn"); } },
    "node:net": { default: {
      createServer: () => Object.assign(new EventEmitter(), { listen: (_path, callback) => callback(), close() {} }),
      createConnection: () => {
        const probe = Object.assign(new EventEmitter(), { destroy() {} });
        queueMicrotask(() => probe.emit("error", Error("ENOENT")));
        return probe;
      },
    } },
    "node:path": path,
    "./hostkit.mjs": { HOST_DIR: "/test", makeLog: () => () => {}, frameReader: () => () => {}, frameRaw: (raw) => raw,
      writeFrame: (_stream, obj) => { notices.push(obj); }, redact() {} },
  };
  const context = createContext({ process: proc, Buffer, Date: { now: () => now },
    setTimeout: (fn) => { const timer = { fn, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {},
    setInterval: (fn) => { intervals.push(fn); return { unref() {} }; } });
  const source = readFileSync(new URL("../../src/host/router.mjs", import.meta.url), "utf8");
  const module = new SourceTextModule(source + "\nexport { route, recordChildMessage };", { context });
  await module.link((name) => {
    const values = imports[name];
    assert.ok(values, name);
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  for (const timer of timers.splice(0)) timer.fn(); // secondary host spawn
  const { route, recordChildMessage } = module.namespace;
  return {
    files, spawned, notices,
    send(message) { const text = JSON.stringify(message); route(Buffer.from(text), text); },
    child(agent, message) { recordChildMessage(agent, Buffer.from(JSON.stringify(message))); },
    tick() { intervals.forEach((fn) => fn()); for (const timer of timers.splice(0)) timer.fn(); },
    advance(ms) { now += ms; },
    exited: () => exitCode,
  };
}

test("an idle router restarts once its host files change on disk", async () => {
  const r = await boot();
  r.advance(60000);
  r.tick();
  assert.equal(r.exited(), null, "unchanged files must not restart anything");
  r.files.set("/test/codex-host.mjs", "v2 codex-host.mjs");
  r.tick();
  assert.equal(r.exited(), 0);
  assert.ok(r.spawned.length === 2 && r.spawned.every((child) => child.killed === "SIGTERM"));
});

test("a running turn keeps the old hosts until it ends and a queued prompt had time to arrive", async () => {
  const r = await boot();
  r.send({ type: "start", id: "a", agent: "codex", cwd: "/project" });
  r.send({ type: "prompt", id: "a", agent: "codex", text: "Work" });
  r.files.set("/test/codex-host.mjs", "v2 codex-host.mjs");
  r.advance(60000);
  r.tick();
  assert.equal(r.exited(), null, "a running turn must finish on the old host");
  r.child("codex", { type: "event", id: "a", data: { type: "result" } });
  r.tick();
  assert.equal(r.exited(), null, "the panel may send its next queued prompt right after the result");
  r.advance(5000);
  r.tick();
  assert.equal(r.exited(), 0);
});

test("a running shell command blocks the restart", async () => {
  const r = await boot();
  r.child("claude", { type: "bashStart", id: "a", execId: "dev-server", pid: 7 });
  r.files.set("/test/router.mjs", "v2 router.mjs");
  r.advance(60000);
  r.tick();
  assert.equal(r.exited(), null, "restarting would kill the user's command");
  r.child("claude", { type: "bashExit", id: "a", execId: "dev-server", code: 0 });
  r.advance(5000);
  r.tick();
  assert.equal(r.exited(), 0);
});

test("a browser reconnecting to stale hosts restarts them instead of replaying", async () => {
  const r = await boot();
  r.files.set("/test/claude-host.mjs", "v2 claude-host.mjs");
  r.advance(60000);
  r.send({ type: "runtimeAttach", windowId: 1 });
  assert.ok(!r.notices.some((m) => m.type === "daemonSnapshot"), "the old daemon must not restore its state");
  r.tick();
  assert.equal(r.exited(), 0);
});

test("hosts and the tools they run never inherit the daemon's own markers", async () => {
  const r = await boot({ LIZARD_STUDIO_ROUTER_DAEMON: "1", LIZARD_STUDIO_ROUTER_SOCKET: "/test/router-1.sock", PATH: "/test/bin" });
  await new Promise((resolve) => setImmediate(resolve));
  const { env } = r.spawned[0];
  assert.equal(env.LIZARD_STUDIO_ROUTER_DAEMON, undefined, "a router started from a chat would think it is the daemon");
  assert.equal(env.LIZARD_STUDIO_ROUTER_SOCKET, undefined);
  assert.equal(env.LIZARD_STUDIO_ROUTER_PID, "42");
  assert.equal(env.PATH, "/test/bin");
});
