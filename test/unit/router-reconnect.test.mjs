import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { frame, frameReader } from "../../src/host/hostkit.mjs";

function daemon() {
  let accept;
  const timers = new Set(), routed = [];
  const server = new EventEmitter();
  server.listen = (_path, callback) => callback();
  const context = {
    HOST_DIR: "/test", daemonSocket: "/test/router-1.sock", daemonServer: null,
    browserOutput: null, idleTimer: null, frameReader,
    process: { exit() { throw Error("unexpected exit"); } },
    net: { createServer(fn) { accept = fn; return server; }, createConnection: () => new EventEmitter() },
    route: (_body, text) => routed.push(JSON.parse(text)),
    log() {}, maybeIdleExit() {}, restartIfStale: () => false, chmodSync() {}, unlinkSync() {}, startHosts() {},
    setTimeout(fn) { const timer = { fn, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  };
  const source = readFileSync(new URL("../../src/host/router.mjs", import.meta.url), "utf8");
  runInNewContext(source.slice(source.indexOf("function startDaemon()"), source.indexOf("\nif (bridgeMode)")) + "\nstartDaemon();", context);
  function connect() {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = () => { socket.destroyed = true; socket.emit("close"); };
    socket.send = (message) => socket.emit("data", frame(message));
    accept(socket);
    return socket;
  }
  return { context, connect, timers, routed };
}

test("a daemon startup probe cannot disconnect the attached browser", () => {
  const d = daemon(), browser = d.connect();
  browser.send({ type: "runtimeAttach", windowId: 1 });
  const probe = d.connect();
  probe.destroy();
  assert.equal(browser.destroyed, false);
  assert.equal(d.context.browserOutput, browser);
  browser.send({ type: "browserResult", bid: 1, ok: true });
  assert.equal(d.routed.at(-1).type, "browserResult");
});

test("only a complete attach frame replaces the browser after restart", () => {
  const d = daemon(), old = d.connect();
  old.send({ type: "runtimeAttach", windowId: 1 });
  const next = d.connect(), bytes = frame({ type: "runtimeAttach", windowId: 1 });
  next.emit("data", bytes.subarray(0, 6));
  assert.equal(d.context.browserOutput, old);
  next.emit("data", bytes.subarray(6));
  assert.equal(d.context.browserOutput, next);
  assert.equal(old.destroyed, true);
  const count = d.routed.length;
  old.send({ type: "prompt", id: "stale", text: "must not send" });
  assert.equal(d.routed.length, count);
  next.destroy();
  assert.equal(d.context.browserOutput, null);
});

test("unattached connections cannot route commands or displace a live browser", () => {
  const d = daemon(), browser = d.connect();
  browser.send({ type: "runtimeAttach", windowId: 1 });
  for (const message of [{ type: "prompt", id: "a" }, { type: "runtimeAttach", windowId: -1 }]) {
    const invalid = d.connect();
    invalid.send(message);
    assert.equal(invalid.destroyed, true);
  }
  assert.equal(d.context.browserOutput, browser);
  assert.equal(d.routed.length, 1);
});

test("silent connections expire without touching the attached browser", () => {
  const d = daemon(), browser = d.connect();
  browser.send({ type: "runtimeAttach", windowId: 1 });
  const silent = d.connect();
  for (const timer of [...d.timers]) timer.fn();
  assert.equal(silent.destroyed, true);
  assert.equal(browser.destroyed, false);
  assert.equal(d.context.browserOutput, browser);
});
