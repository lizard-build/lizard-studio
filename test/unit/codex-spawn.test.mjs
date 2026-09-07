import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import * as path from "node:path";
import * as crypto from "node:crypto";

async function harness(platform = "darwin") {
  const calls = [], files = new Map(), timers = new Set(), kills = [];
  const direct = {};
  let accept, listen;
  const server = new EventEmitter();
  server.listen = (_port, _host, callback) => { listen = callback; };
  server.address = () => ({ port: 9998 });
  server.close = () => { server.closed = true; };
  const imports = {
    "node:child_process": {
      spawn: (...args) => { calls.push({ direct: args }); return direct; },
      execFile: (file, args, ...rest) => { calls.push({ file, args, callback: rest.at(-1) }); },
    },
    "node:events": { EventEmitter }, "node:stream": { PassThrough },
    "node:crypto": crypto, "node:path": path,
    "node:fs": {
      existsSync: (p) => files.has(p), readFileSync: (p) => files.get(p).data,
      writeFileSync: (p, data, opts) => files.set(p, { data, opts }),
      renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
      unlinkSync: (p) => files.delete(p),
    },
    "node:net": { default: { createServer: (callback) => { accept = callback; return server; } } },
  };
  const context = createContext({
    Buffer, process: { platform, pid: 12, execPath: "/node", kill: (...args) => kills.push(args) },
    setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.add(t); return t; },
    clearTimeout: (t) => timers.delete(t),
  });
  const source = readFileSync(new URL("../../src/host/codex-spawn.mjs", import.meta.url), "utf8");
  const module = new SourceTextModule(source, { context });
  await module.link((name) => {
    const values = imports[name];
    assert.ok(values, `unexpected import ${name}`);
    return new SyntheticModule(Object.keys(values), function () {
      for (const [k, v] of Object.entries(values)) this.setExport(k, v);
    }, { context });
  });
  await module.evaluate();
  const launcher = module.namespace.createCodexSpawner({ hostDir: "/host" });
  const token = [...files].find(([p]) => p.includes(".codex-spawn-token-"));
  function connect(child, chan, suppliedToken = token?.[1].data) {
    const sock = new EventEmitter();
    sock.writes = [];
    Object.assign(sock, {
      setTimeout() {}, setEncoding() {}, pause() {}, resume() {},
      write: (value) => { sock.writes.push(value.toString()); return true; },
      end() {}, destroy() { sock.destroyed = true; sock.emit("close"); },
    });
    accept(sock);
    sock.emit("data", Buffer.from(JSON.stringify({ token: suppliedToken, spawnId: child._spawnId, chan }) + "\n"));
    return sock;
  }
  return { launcher, calls, files, timers, kills, direct, server, token, connect, ready: async () => { listen(); await Promise.resolve(); } };
}
const opts = { cwd: "/work", env: { TEST_SECRET: "socket-only-value" } };

test("macOS waits for the listener and sends credentials only after both authenticated channels connect", async () => {
  const h = await harness();
  const child = h.launcher.spawn("/codex", ["app-server"], opts);
  child.on("error", assert.fail);
  child.stdin.write("queued-rpc\n");
  assert.equal(h.calls.length, 0);
  await h.ready();
  assert.equal(h.calls[0].file, "/bin/launchctl");
  assert.equal(h.calls[0].args[0], "submit");
  assert.ok(!JSON.stringify(h.calls).includes(opts.env.TEST_SECRET));
  assert.equal(h.token[1].opts.mode, 0o600);
  assert.equal(h.token[1].opts.flag, "wx");
  assert.ok(!JSON.stringify([...h.files]).includes(opts.env.TEST_SECRET));
  assert.equal(h.connect(child, "ctl", "wrong-token").destroyed, true);
  const ctl = h.connect(child, "ctl");
  assert.equal(ctl.writes.length, 0);
  const io = h.connect(child, "io");
  assert.deepEqual(JSON.parse(ctl.writes[0]), { cmd: "/codex", args: ["app-server"], ...opts });
  await new Promise(setImmediate);
  assert.deepEqual(io.writes, ["queued-rpc\n"]);
  h.launcher.close();
});

test("launchd failure reports one failure and never falls back to a quarantined direct child", async () => {
  const h = await harness(), errors = [], exits = [];
  const child = h.launcher.spawn("/codex", [], opts);
  child.on("error", (e) => errors.push(e.message));
  child.on("exit", (...args) => exits.push(args));
  await h.ready();
  h.calls[0].callback(new Error("service unavailable"));
  h.calls[0].callback(new Error("late failure"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /service unavailable/);
  assert.deepEqual(exits, [[1, null]]);
  assert.equal(h.calls.filter(c => c.direct).length, 0);
  assert.equal(h.timers.size, 1); // stream cleanup only
  h.launcher.close();
});

test("startup timeout also covers a shim that connects but never starts the child", async () => {
  const h = await harness(), errors = [];
  const child = h.launcher.spawn("/codex", [], opts);
  child.on("error", (e) => errors.push(e.message));
  await h.ready();
  h.connect(child, "ctl"); h.connect(child, "io");
  const timeout = [...h.timers].find(t => t.ms === 10000);
  assert.ok(timeout);
  timeout.fn();
  assert.match(errors[0], /Timed out/);
  assert.equal(h.calls.filter(c => c.direct).length, 0);
  h.launcher.close();
});

test("stop before spawn delivers the signal once and exit waits for the final stdout bytes", async () => {
  const h = await harness(), exits = [], output = [];
  const child = h.launcher.spawn("/codex", [], opts);
  child.on("error", assert.fail);
  child.on("exit", (...args) => exits.push(args));
  child.stdout.on("data", c => output.push(c.toString()));
  child.kill("SIGTERM");
  await h.ready();
  const ctl = h.connect(child, "ctl"), io = h.connect(child, "io");
  ctl.emit("data", '{"type":"spawned","pid":42}\n');
  assert.deepEqual(h.kills, [[42, "SIGTERM"]]);
  assert.equal([...h.timers].filter(t => t.ms === 10000).length, 0);
  ctl.emit("data", '{"type":"exit","code":0}\n');
  assert.equal(exits.length, 0);
  io.emit("data", Buffer.from("final reply"));
  io.emit("end");
  assert.deepEqual(output, ["final reply"]);
  assert.deepEqual(exits, [[0, null]]);
  assert.equal(child.kill(), false);
  h.launcher.close();
  assert.equal(h.server.closed, true);
  assert.equal(h.files.has(h.token[0]), false);
});

test("closing before the listener is ready never submits a new job", async () => {
  const h = await harness();
  h.launcher.spawn("/codex", [], opts).on("error", assert.fail);
  h.launcher.close();
  await h.ready();
  assert.equal(h.calls.filter(c => c.args?.[0] === "submit").length, 0);
  assert.throws(() => h.launcher.spawn("/codex", [], opts), /closed/);
});

test("Linux keeps direct spawning without macOS files or jobs", async () => {
  const h = await harness("linux");
  assert.equal(h.launcher.spawn("/codex", [], opts), h.direct);
  assert.equal(h.files.size, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].direct[0], "/codex");
  h.launcher.close();
});
