import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Exercise the shipped request/reply handlers with a clock and no live browser.
function host(name) {
  const source = readFileSync(new URL(`../../src/host/${name}-host.mjs`, import.meta.url), "utf8");
  const start = source.indexOf("function browserRequest(");
  const end = source.indexOf("\n}", source.indexOf("function resolveBrowser(", start)) + 2;
  const timers = new Set(), messages = [];
  const scope = {
    nextBid: 1, browserPending: new Map(),
    sessions: new Map([["chat", { id: "chat", browserSession: "session" }]]),
    send: (m) => messages.push(m),
    setTimeout(fn, ms) { const t = { fn, ms, unref() {} }; timers.add(t); return t; },
    clearTimeout: (t) => timers.delete(t),
  };
  vm.runInNewContext(source.slice(start, end), scope);
  return { ...scope, timers, messages };
}

for (const name of ["claude", "codex"]) {
  for (const op of ["navigate", "reload", "screenshot"]) {
    test(`${name} keeps ${op} pending past 30 seconds and accepts its reply once`, async () => {
      const h = host(name);
      const pending = h.browserRequest(op, {}, "session");
      for (const timer of [...h.timers]) if (timer.ms <= 30000) timer.fn();
      assert.equal(h.browserPending.size, 1);
      const { bid } = h.messages[0];
      h.resolveBrowser({ bid, ok: true, data: "finished after 30 seconds" });
      assert.equal((await pending).data, "finished after 30 seconds");
      h.resolveBrowser({ bid, ok: false, error: "late duplicate" });
      assert.equal(h.timers.size, 0);
      assert.equal(h.messages.length, 1, "must never repeat the browser operation");
    });
  }

  test(`${name} still bounds stalled requests and discards late replies`, async () => {
    for (const [op, deadline] of [["navigate", 45000], ["click", 30000]]) {
      const h = host(name);
      const pending = h.browserRequest(op, {}, "session");
      const timer = [...h.timers][0];
      assert.equal(timer.ms, deadline);
      timer.fn();
      assert.equal((await pending).ok, false);
      h.resolveBrowser({ bid: h.messages[0].bid, ok: true, data: "late" });
      assert.equal(h.browserPending.size, 0);
      assert.equal(h.messages.length, 1);
    }
  });
}
