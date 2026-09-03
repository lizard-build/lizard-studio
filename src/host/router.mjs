#!/usr/bin/env node
// Native-messaging router for the Lizard Studio side panel.
//
// Chrome launches this, not the agent hosts. It owns one stdio pipe to the
// browser and hands every message to whichever host the chat belongs to:
//
//   Chrome  <->  router.mjs  <->  claude-host.mjs   (agent: "claude", default)
//                           <->  codex-host.mjs    (agent: "codex")
//
// The children are spawned as ordinary child processes with piped stdio, and
// they speak Chrome's own wire format on it — a 4-byte little-endian length
// prefix plus JSON. That is exactly the format Chrome would have written to
// them directly, so `claude-host.mjs` needs no change at all: it cannot tell
// the difference between the browser and this process.
//
// The one rule that keeps the working path safe: THIS FILE NEVER PARSES WHAT A
// CHILD SENDS. Messages from a host to the panel are forwarded as the exact
// bytes the child produced. Only the Chrome->host direction is inspected, and
// only far enough to pick a child — the original bytes are what gets forwarded
// there too. A bug here can drop or misroute a message; it can never corrupt
// one.
//
// Routing, in order:
//   1. `browserResult` — by bid range (see CODEX_BID_BASE below)
//   2. an explicit `agent` field on the message
//   3. the agent remembered for that chat id (set by `start` / `prewarm`)
//   4. claude — the default, so a panel that knows nothing about any of this
//      behaves exactly as it did before
//
// Protocol additions the panel may use (every one is optional; a panel that
// never sends them gets today's behaviour):
//   panel -> router:  { type:"prewarm", agent, id? }   spin a host up early
//   panel -> any:     { ..., agent }                   pick the host explicitly
//   router -> panel:  { type:"agentExit", agent, code } a non-claude host died

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOST_DIR, makeLog, frameReader, frameRaw, writeFrame } from "./hostkit.mjs";

const log = makeLog("router");

// Bumped on every router change the panel needs to know about. Reported inside
// the `agentReady` message each non-claude host sends; claude's own `ready`
// (and the HOST_VERSION in it) passes through untouched.
const ROUTER_VERSION = 1;

// The browser bridge correlates requests by `bid`, and each host numbers its
// own from scratch. Rather than rewrite ids in flight — which would mean
// parsing and re-serializing every message — the hosts are given disjoint
// ranges: claude counts up from 1, codex counts up from this base. Routing a
// `browserResult` is then a comparison, and the router still never touches a
// byte of what a child wrote. Keep in step with codex-host.mjs.
const CODEX_BID_BASE = 1_000_000_000;

// Messages that have nothing to do with which agent runs a chat: picking a
// folder, opening a file, git, the composer's shell mode, the host's own
// updater. They are implemented once, in the claude host, and they go there
// whatever agent the chat belongs to — duplicating them into every new host
// would be four copies of the same code waiting to drift apart.
const SHARED_OPS = new Set([
  "pickFolder", "openPath", "stashFile",
  "gitBranches", "checkoutBranch", "gitDiff",
  "bashExec", "bashKill",
  "killShell", "probeShellPort", "probeShells",
  "selfUpdate",
]);
// Deliberately NOT shared:
//   signing in — `/login` in a Codex chat has to sign in to Codex;
//   config files — each agent keeps its own, in its own places, so a read or a
//   write has to reach the host that knows where they live. The panel names the
//   agent on those two messages explicitly, because the section of the Settings
//   modal you are looking at is what decides it, not the chat you came from.

const AGENTS = {
  claude: { file: "claude-host.mjs", primary: true },
  codex: { file: "codex-host.mjs", primary: false },
};

// How long after startup the secondary hosts are spawned. Claude's host is
// what the panel waits on for `ready`, so nothing else is allowed to compete
// with its start-up for the first moments of a panel open.
const SECONDARY_SPAWN_DELAY_MS = 400;

const children = new Map(); // name -> { proc, name, alive }
const agentById = new Map(); // chat id -> agent name
let shuttingDown = false;

// ---- children ---------------------------------------------------------------

function spawnAgent(name) {
  const spec = AGENTS[name];
  if (!spec) return null;
  const existing = children.get(name);
  if (existing && existing.alive) return existing;

  const path = join(HOST_DIR, spec.file);
  if (!existsSync(path)) {
    log("no host for", name, "at", path);
    // A runtime dir from before this file shipped simply has no codex host.
    // That is not an error worth surfacing for the claude path.
    if (!spec.primary) notifyPanel({ type: "agentExit", agent: name, code: -1, error: "host not installed" });
    return null;
  }

  let proc;
  try {
    proc = spawn(process.execPath, [path], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    log("spawn failed for", name, err && err.message);
    if (!spec.primary) notifyPanel({ type: "agentExit", agent: name, code: -1, error: String(err && err.message) });
    return null;
  }

  const child = { proc, name, alive: true };
  children.set(name, child);
  log("spawned", name, "pid=", proc.pid);

  // Straight through to Chrome, byte for byte. We re-frame rather than pipe the
  // stream so a child that dies mid-message can never leave a half-written
  // frame in the browser's pipe — the browser would desync and the panel would
  // go quiet with no way back short of a reload.
  const feed = frameReader(
    (body) => {
      if (shuttingDown) return;
      try {
        process.stdout.write(frameRaw(body));
      } catch {
        /* Chrome went away — the stdout error handler shuts us down */
      }
    },
    (len) => {
      log(name, "sent an impossible frame length", len, "— killing it");
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }
  );
  proc.stdout.on("data", feed);

  // A host's stderr is for us, not for the panel. claude-host reports its own
  // errors as proper messages; anything on this pipe is noise or a crash trace.
  proc.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) log(name, "stderr:", text.slice(0, 2000));
  });

  proc.on("error", (err) => {
    log(name, "process error:", err && err.message);
  });

  proc.on("exit", (code, signal) => {
    child.alive = false;
    children.delete(name);
    log(name, "exited code=", code, "signal=", signal);
    if (shuttingDown) return;
    if (spec.primary) {
      // The claude host going away is the host going away, exactly as it was
      // before this router existed: Chrome sees the pipe close, the panel drops
      // to "waiting for the helper" and reconnects, which relaunches us. This
      // is also how a self-update lands — it rewrites the files and exits.
      log("primary host gone — router exiting so the panel reconnects");
      shutdown(code == null ? 0 : code);
      return;
    }
    // A secondary host dying is a per-agent problem. Say so, forget its chats
    // and let the next message for that agent spawn a fresh one.
    for (const [id, agent] of agentById) if (agent === name) agentById.delete(id);
    notifyPanel({ type: "agentExit", agent: name, code: code == null ? -1 : code, signal: signal || undefined });
  });

  return child;
}

/** A message from the router itself (never from a child) to the panel. */
function notifyPanel(obj) {
  if (shuttingDown) return;
  writeFrame(process.stdout, obj);
}

// ---- routing ----------------------------------------------------------------

function agentFor(msg) {
  if (!msg || typeof msg !== "object") return "claude";
  // The browser bridge has no chat id of its own — only the request id the
  // host handed out. Disjoint ranges make that enough.
  if (msg.type === "browserResult") {
    return typeof msg.bid === "number" && msg.bid >= CODEX_BID_BASE ? "codex" : "claude";
  }
  if (SHARED_OPS.has(msg.type)) return "claude";
  if (typeof msg.agent === "string" && AGENTS[msg.agent]) return msg.agent;
  if (msg.id != null && agentById.has(msg.id)) return agentById.get(msg.id);
  return "claude";
}

function route(raw, text) {
  let msg = null;
  try {
    msg = JSON.parse(text);
  } catch {
    // Unparsable input can only have come from a broken sender. Give it to the
    // default host, which logs and ignores what it doesn't understand.
    log("unparsable message from the panel —", text.slice(0, 200));
  }

  const name = agentFor(msg);

  if (msg && msg.id != null) {
    // `start` and `prewarm` are where a chat is bound to its agent; every later
    // message for that chat can then arrive without an `agent` field and still
    // land in the right place.
    if (msg.type === "start" || msg.type === "prewarm") agentById.set(msg.id, name);
  }

  const child = children.get(name) || spawnAgent(name);
  if (!child || !child.alive) {
    log("no live host for", name, "— dropping", (msg && msg.type) || "?");
    if (name !== "claude") {
      notifyPanel({ type: "error", id: msg && msg.id, agent: name, message: `The ${name} helper isn't running.` });
    }
    return;
  }

  try {
    child.proc.stdin.write(frameRaw(raw));
  } catch (err) {
    log("write to", name, "failed:", err && err.message);
  }

  // Done with the chat: stop remembering where it lived.
  if (msg && msg.type === "close" && msg.id != null) agentById.delete(msg.id);
}

// ---- lifecycle ---------------------------------------------------------------

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) {
    try { child.proc.kill("SIGTERM"); } catch { /* ignore */ }
  }
  // Give the children a moment to stop their own trees, then go.
  setTimeout(() => process.exit(code), 200).unref();
}

process.on("uncaughtException", (err) => {
  log("UNCAUGHT", err && (err.stack || err.message));
});
process.on("unhandledRejection", (reason) => {
  log("UNHANDLED_REJECTION", String(reason));
});

// Chrome closing the pipe means the panel is gone. Take the children with us —
// otherwise a claude process keeps streaming into a dead file descriptor.
process.stdout.on("error", () => {
  log("stdout error — panel gone, shutting down");
  shutdown(0);
});

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

const feedFromChrome = frameReader(route, (len) => {
  log("impossible frame length from the panel:", len);
  shutdown(1);
});
process.stdin.on("data", feedFromChrome);
process.stdin.on("end", () => {
  log("stdin closed — shutting down");
  shutdown(0);
});

log("router v" + ROUTER_VERSION + " starting, node=" + process.version + ", dir=" + HOST_DIR);

// The claude host comes up straight away: the panel's whole startup waits on
// its `ready`, and that timing must not change.
spawnAgent("claude");

// Everything else follows once that is out of the way.
setTimeout(() => {
  if (shuttingDown) return;
  for (const [name, spec] of Object.entries(AGENTS)) {
    if (!spec.primary) spawnAgent(name);
  }
}, SECONDARY_SPAWN_DELAY_MS).unref();
