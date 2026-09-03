// A stand-in for Chrome, for driving the native-messaging host end to end.
//
// The real panel talks to `router.mjs` over a stdio pipe using Chrome's wire
// format. So does this: it spawns the router exactly as the browser would,
// speaks the same framing, and records everything that comes back. Nothing is
// mocked below the router — the tests drive the real `claude` and `codex` CLIs.
//
// Node built-ins only, like the host it tests.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..", "..");
export const ROUTER = join(REPO, "src", "host", "router.mjs");

export class FakeChrome {
  constructor(target = ROUTER) {
    this.target = target;
    this.messages = [];
    this.stderr = "";
    this.exited = null;
    this.t0 = Date.now();
    this.proc = spawn(process.execPath, [target], { stdio: ["pipe", "pipe", "pipe"] });

    let pending = Buffer.alloc(0);
    this.proc.stdout.on("data", (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        if (pending.length < 4) return;
        const len = pending.readUInt32LE(0);
        if (pending.length < 4 + len) return;
        const body = pending.subarray(4, 4 + len);
        pending = pending.subarray(4 + len);
        let msg = null;
        try {
          msg = JSON.parse(body.toString("utf8"));
        } catch {
          /* a frame we can't read is itself a finding — record the raw size */
          msg = { type: "__unparsable__" };
        }
        msg.__at = Date.now() - this.t0;
        msg.__bytes = len;
        // A streaming shell command can push megabytes through here. The tests
        // only ever assert on shape and on the odd short string, so keep the
        // envelope and drop the bulk rather than holding a run's whole output
        // in memory.
        if (len > 64 * 1024) msg = trimBulk(msg);
        this.messages.push(msg);
        for (const w of [...this._waiters]) if (w.test(msg)) w.hit(msg);
      }
    });
    this.proc.stderr.on("data", (c) => { this.stderr += String(c); });
    this.proc.on("exit", (code) => { this.exited = code; });
    this._waiters = [];
  }

  send(obj) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32LE(body.length, 0);
    this.proc.stdin.write(Buffer.concat([head, body]));
  }

  /** Every message so far that matches, oldest first. */
  all(test) {
    return this.messages.filter(test);
  }

  find(test) {
    return this.messages.find(test);
  }

  /**
   * Resolve once a matching message arrives (or immediately if one already
   * has). Rejects on timeout with what *did* arrive, which is the difference
   * between a useful failure and a stare.
   */
  wait(test, ms = 30000, label = "message") {
    const already = this.messages.find(test);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== waiter);
        const seen = this.messages.slice(-8).map((m) => m.type).join(", ");
        reject(new Error(`timed out after ${ms}ms waiting for ${label}. Last seen: ${seen || "(nothing)"}`));
      }, ms);
      const waiter = {
        test,
        hit: (msg) => {
          clearTimeout(timer);
          this._waiters = this._waiters.filter((w) => w !== waiter);
          resolve(msg);
        },
      };
      this._waiters.push(waiter);
    });
  }

  /** Events for one chat, unwrapped to the stream-json object inside. */
  events(id) {
    return this.messages.filter((m) => m.type === "event" && m.id === id).map((m) => m.data);
  }

  /** Assistant text the panel would have rendered for one chat. */
  text(id) {
    return this.events(id)
      .filter((d) => d.type === "assistant")
      .flatMap((d) => (d.message && d.message.content) || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  /** Text as it arrived through the live stream, not the final copy. */
  streamedText(id) {
    return this.events(id)
      .filter((d) => d.type === "stream_event" && d.event && d.event.type === "content_block_delta")
      .map((d) => (d.event.delta && d.event.delta.text) || "")
      .join("");
  }

  /** Tool calls the panel would have drawn cards for. */
  toolCalls(id) {
    return this.events(id)
      .filter((d) => d.type === "assistant")
      .flatMap((d) => (d.message && d.message.content) || [])
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
  }

  toolResults(id) {
    return this.events(id)
      .filter((d) => d.type === "user")
      .flatMap((d) => (d.message && Array.isArray(d.message.content) ? d.message.content : []))
      .filter((b) => b.type === "tool_result")
      .map((b) => ({ id: b.tool_use_id, text: typeof b.content === "string" ? b.content : "", isError: !!b.is_error }));
  }

  /**
   * Answer every approval the way a person clicking "allow" would. Without
   * this a test that asks an agent to change a file just hangs on a dialog
   * nobody is looking at.
   *
   * Returns a counter so a test can assert an ask actually happened.
   */
  autoApprove() {
    const seen = [];
    this._waiters.push({
      test: (m) => m.type === "permission",
      hit: (m) => {
        seen.push(m);
        // A question wants a choice; anything else wants a yes.
        if (m.toolName === "AskUserQuestion") {
          const answers = {};
          for (const q of (m.input && m.input.questions) || []) {
            answers[q.question] = (q.options && q.options[0] && q.options[0].label) || "Yes";
          }
          this.send({ type: "permissionResult", id: m.id, requestId: m.requestId, behavior: "allow", updatedInput: { answers } });
        } else {
          this.send({ type: "permissionResult", id: m.id, requestId: m.requestId, behavior: "allow" });
        }
        // Nothing removes this waiter, so it stays armed — one turn can ask
        // several times, and every ask has to be answered or the turn stalls.
      },
    });
    return seen;
  }

  /** Refuse every approval, the way clicking "deny" would. */
  autoDeny() {
    const seen = [];
    this._waiters.push({
      test: (m) => m.type === "permission",
      hit: (m) => {
        seen.push(m);
        this.send({ type: "permissionResult", id: m.id, requestId: m.requestId, behavior: "deny", message: "not allowed by the test", interrupt: false });
      },
    });
    return seen;
  }

  kill() {
    try { this.proc.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

/** Shrink the long strings in a message, keeping its structure intact. */
function trimBulk(value, budget = 4096) {
  if (typeof value === "string") {
    return value.length > budget ? value.slice(0, budget) + `…[+${value.length - budget}]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => trimBulk(v, budget));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = trimBulk(value[k], budget);
    return out;
  }
  return value;
}

// ---- a very small test runner -------------------------------------------------

const results = [];
let only = null;

export function setFilter(pattern) {
  only = pattern ? new RegExp(pattern, "i") : null;
}

export async function test(name, fn, { timeout = 180000, skip = false } = {}) {
  // No function means the case was filtered out by the caller — cheap mode
  // hands back nothing for the tests that spend tokens.
  if (!fn || skip || (only && !only.test(name))) {
    results.push({ name, state: "skip" });
    process.stdout.write(`  ○ ${name} (skipped)\n`);
    return;
  }
  const started = Date.now();
  let timer;
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`test timed out after ${timeout}ms`)), timeout); }),
    ]);
    clearTimeout(timer);
    const ms = Date.now() - started;
    results.push({ name, state: "pass", ms });
    process.stdout.write(`  ✓ ${name} (${(ms / 1000).toFixed(1)}s)\n`);
  } catch (err) {
    clearTimeout(timer);
    const ms = Date.now() - started;
    results.push({ name, state: "fail", ms, error: err && err.message });
    process.stdout.write(`  ✗ ${name} (${(ms / 1000).toFixed(1)}s)\n      ${err && err.message}\n`);
  }
}

export function group(title) {
  process.stdout.write(`\n${title}\n`);
}

export function summary() {
  const pass = results.filter((r) => r.state === "pass").length;
  const fail = results.filter((r) => r.state === "fail");
  const skip = results.filter((r) => r.state === "skip").length;
  process.stdout.write(`\n${"─".repeat(64)}\n`);
  process.stdout.write(`${pass} passed, ${fail.length} failed, ${skip} skipped\n`);
  if (fail.length) {
    process.stdout.write(`\nFailures:\n`);
    for (const f of fail) process.stdout.write(`  ✗ ${f.name}\n      ${f.error}\n`);
  }
  return fail.length === 0;
}

// ---- assertions ----------------------------------------------------------------

export function ok(cond, message) {
  if (!cond) throw new Error(message || "expected a truthy value");
}

export function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function includes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message || "missing"}: expected to find ${JSON.stringify(needle)} in ${JSON.stringify(String(haystack).slice(0, 300))}`);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
