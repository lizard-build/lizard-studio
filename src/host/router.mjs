#!/usr/bin/env node
// Native-messaging router for the Lizard Studio side panel.
//
// Chrome launches this, not the agent hosts. It owns one stdio pipe to the
// browser and hands every message to whichever host the chat belongs to:
//
//   Chrome  <->  router.mjs  <->  claude-host.mjs   (agent: "claude", default)
//                           <->  codex-host.mjs    (agent: "codex")
//
// On macOS, launchd starts both hosts so every tool they run and file they
// create stays outside Chrome's inherited quarantine context. Other systems
// use direct child processes. Both paths speak Chrome's wire format — a length
// prefix plus JSON. That is exactly the format Chrome would have written to
// them directly, so `claude-host.mjs` needs no change at all: it cannot tell
// the difference between the browser and this process.
//
// Messages from a host to the panel are forwarded as the exact bytes the child
// produced. The router reads small Claude ready messages to reset restart delay.
// Only the Chrome->host direction is inspected for routing; its original bytes
// are forwarded too.
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
//   router -> panel:  { type:"agentExit", agent, code } a host died

import { existsSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { HOST_DIR, makeLog, frameReader, frameRaw, writeFrame, redact } from "./hostkit.mjs";
import { createHostSpawner } from "./codex-spawn.mjs";

const log = makeLog("router");
const daemonMode = process.env.LIZARD_STUDIO_ROUTER_DAEMON === "1";
const bridgeMode = process.platform === "darwin" && !daemonMode;
const hostSpawner = bridgeMode ? null : createHostSpawner({ hostDir: HOST_DIR, redact });

// Bumped on every router change the panel needs to know about. Reported inside
// the `agentReady` message each non-claude host sends; claude's own `ready`
// (and the HOST_VERSION in it) passes through untouched.
const ROUTER_VERSION = 2;

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
const sessionState = new Map(); // chat id -> small state plus the current turn's output
const readyFrames = new Map(); // global host state to replay after Chrome reconnects
let shuttingDown = false;
let primaryRestartDelay = 500;
let browserOutput = daemonMode ? null : process.stdout;
let idleTimer = null;

const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
function writeToBrowser(body) {
  if (!browserOutput) return false;
  try { browserOutput.write(frameRaw(body)); return true; }
  catch { return false; }
}
function notifyPanel(obj) {
  if (shuttingDown || !browserOutput) return;
  writeFrame(browserOutput, obj);
}
function recordPanelMessage(name, msg) {
  if (msg.id == null) return;
  if (msg.type === "close" || msg.type === "stop") { sessionState.delete(msg.id); return; }
  if (msg.type === "start" || msg.type === "restartSession") {
    sessionState.set(msg.id, { id: msg.id, agent: name, spec: msg, started: true,
      running: false, turnStartedAt: 0, failed: false, submitted: !!msg.resume, sessionId: msg.resume || null,
      turnIds: new Set(), journal: [], journalBytes: 0 });
    return;
  }
  const state = sessionState.get(msg.id);
  if (!state) return;
  if (msg.type === "prompt") {
    if (!state.running) { state.journal = []; state.journalBytes = 0; state.turnIds.clear(); }
    if (!state.running) state.turnStartedAt = Date.now();
    state.running = true;
    state.failed = false;
    state.submitted = true;
  }
}
function recordChildMessage(name, body) {
  let msg;
  try { msg = JSON.parse(body.toString("utf8")); } catch { return; }
  if (["ready", "agentReady", "models", "planUsage"].includes(msg.type)) {
    readyFrames.set(msg.type + (msg.agent || ""), Buffer.from(body));
  }
  const state = msg.id == null ? null : sessionState.get(msg.id);
  if (state && state.agent === name) {
    if (msg.type === "started") state.started = true;
    if (msg.type === "event" && msg.data?.subtype === "init") {
      state.started = true;
      state.sessionId = msg.data.session_id || state.sessionId;
    }
    if (msg.type === "turnStarted") {
      if (!state.running) state.turnStartedAt = Date.now();
      state.running = true;
      if (msg.turnId) state.turnIds.add(msg.turnId);
    }
    if (msg.type === "event" && msg.data?.type === "result" || msg.type === "interrupted" || msg.type === "exit") {
      state.running = false;
      state.failed = !!msg.data?.is_error || msg.type !== "event";
      if (msg.type === "exit") state.started = false;
    }
    if (!["browser", "transcript", "transcriptPart"].includes(msg.type) && state.journalBytes + body.length > MAX_JOURNAL_BYTES) {
      while (state.journal.length && state.journalBytes + body.length > MAX_JOURNAL_BYTES) {
        state.journalBytes -= state.journal.shift().length;
      }
    }
    if (!["browser", "transcript", "transcriptPart"].includes(msg.type) && body.length <= MAX_JOURNAL_BYTES) {
      state.journal.push(Buffer.from(body));
      state.journalBytes += body.length;
    }
  }
  if (daemonMode && msg.type === "browser" && !browserOutput && typeof msg.bid === "number") {
    const reply = JSON.stringify({ type: "browserResult", bid: msg.bid, ok: false,
      error: "Browser disconnected during the tool call." });
    route(Buffer.from(reply), reply);
  }
  maybeIdleExit();
}
function replayToBrowser() {
  if (!browserOutput) return;
  notifyPanel({ type: "daemonSnapshot", sessions: [...sessionState.values()].map((s) => ({
    id: s.id, agent: s.agent, spec: { cwd: s.spec.cwd, model: s.spec.model,
      effort: s.spec.effort, permissionMode: s.spec.permissionMode }, started: s.started, running: s.running,
    submitted: s.submitted, sessionId: s.sessionId, turnIds: [...s.turnIds],
    turnStartedAt: s.turnStartedAt, failed: s.failed,
  })) });
  for (const body of readyFrames.values()) writeToBrowser(body);
  for (const state of sessionState.values()) for (const body of state.journal) writeToBrowser(body);
  notifyPanel({ type: "daemonRestoreDone" });
}
function maybeIdleExit() {
  if (!daemonMode) return;
  clearTimeout(idleTimer);
  if (browserOutput || [...sessionState.values()].some((s) => s.running)) return;
  idleTimer = setTimeout(() => shutdown(0), 60000);
  idleTimer.unref?.();
}

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
    proc = hostSpawner.spawn(process.execPath, [path], {
      cwd: process.cwd(),
      env: { ...process.env, LIZARD_STUDIO_ROUTER_PID: String(process.pid) },
    });
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
      recordChildMessage(name, body);
      if (name === "claude" && body.length < 4096) {
        try {
          const message = JSON.parse(body.toString("utf8"));
          if (message.type === "ready") primaryRestartDelay = 500;
        } catch { /* forward the original bytes below */ }
      }
      try {
        writeToBrowser(body);
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
    // A host dying affects only its own chats. In particular, a Claude update
    // or crash must not stop a Codex turn running in the other child.
    for (const [id, agent] of agentById) if (agent === name) agentById.delete(id);
    for (const state of sessionState.values()) if (state.agent === name) {
      state.running = false;
      state.started = false;
      state.failed = true;
    }
    if (name === "claude") readyFrames.delete("ready");
    readyFrames.delete("agentReady" + name);
    notifyPanel({ type: "agentExit", agent: name, code: code == null ? -1 : code, signal: signal || undefined });
    if (spec.primary) {
      const delay = primaryRestartDelay;
      primaryRestartDelay = Math.min(primaryRestartDelay * 2, 30000);
      setTimeout(() => { if (!shuttingDown) spawnAgent(name); }, delay).unref();
    }
    maybeIdleExit();
  });

  return child;
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

  if (msg?.type === "runtimeAttach") {
    replayToBrowser();
    return;
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
      notifyPanel({ type: "error", id: msg && msg.id, agent: name, message: `The ${name === "codex" ? "ChatGPT" : name} helper isn't running.` });
    }
    return;
  }

  if (msg) recordPanelMessage(name, msg);

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
  setTimeout(() => {
    hostSpawner?.close();
    if (daemonServer) { try { daemonServer.close(); } catch {} }
    if (daemonMode && daemonSocket) { try { unlinkSync(daemonSocket); } catch {} }
    process.exit(code);
  }, 200).unref();
}

process.on("uncaughtException", (err) => {
  log("UNCAUGHT", err && (err.stack || err.message));
});
process.on("unhandledRejection", (reason) => {
  log("UNHANDLED_REJECTION", String(reason));
});

const daemonSocket = daemonMode ? process.env.LIZARD_STUDIO_ROUTER_SOCKET : null;
let daemonServer = null;
function startHosts() {
  log("router v" + ROUTER_VERSION + " starting, node=" + process.version + ", dir=" + HOST_DIR);
  spawnAgent("claude");
  setTimeout(() => {
    if (shuttingDown) return;
    for (const [name, spec] of Object.entries(AGENTS)) if (!spec.primary) spawnAgent(name);
  }, SECONDARY_SPAWN_DELAY_MS).unref();
}

function startBridge() {
  let link = null;
  let connecting = false;
  let launched = false;
  let pending = [];
  let pendingBytes = 0;
  function dial(socketPath, attempt = 0) {
    const sock = net.createConnection(socketPath);
    sock.once("connect", () => {
      sock.off("error", onConnectError);
      link = sock;
      connecting = false;
      for (const frame of pending) sock.write(frame);
      pending = [];
      pendingBytes = 0;
      sock.on("data", (chunk) => process.stdout.write(chunk));
      sock.on("error", () => { if (link === sock) process.exit(1); });
      sock.on("close", () => { if (link === sock) process.exit(1); });
    });
    function onConnectError() {
      sock.destroy();
      if (!launched) {
        launched = true;
        const child = spawn(process.execPath, [join(HOST_DIR, "router.mjs")], {
          detached: true, stdio: "ignore",
          env: { ...process.env, LIZARD_STUDIO_ROUTER_DAEMON: "1", LIZARD_STUDIO_ROUTER_SOCKET: socketPath },
        });
        child.unref();
      }
      if (attempt >= 50) { log("could not reach session daemon"); process.exit(1); }
      else setTimeout(() => dial(socketPath, attempt + 1), 100);
    }
    sock.once("error", onConnectError);
  }
  const feed = frameReader((body, text) => {
    const frame = frameRaw(body);
    if (link) { link.write(frame); return; }
    pending.push(frame);
    pendingBytes += frame.length;
    if (pendingBytes > 64 * 1024 * 1024) { log("bridge input overflow"); process.exit(1); }
    if (connecting) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg?.type !== "runtimeAttach" || !Number.isInteger(msg.windowId) || msg.windowId < 0) return;
    connecting = true;
    dial(join(HOST_DIR, `router-${msg.windowId}.sock`));
  }, () => process.exit(1));
  process.stdin.on("data", feed);
  process.stdin.on("end", () => { if (link) link.end(); else process.exit(0); });
  process.stdout.on("error", () => { link?.end(); process.exit(0); });
}

function startDaemon() {
  if (!daemonSocket || !daemonSocket.startsWith(HOST_DIR + "/")) process.exit(1);
  daemonServer = net.createServer((sock) => {
    if (browserOutput && browserOutput !== sock) browserOutput.destroy();
    browserOutput = sock;
    clearTimeout(idleTimer);
    const feed = frameReader(route, (len) => { log("bad browser frame", len); sock.destroy(); });
    sock.on("data", feed);
    sock.on("error", () => {});
    sock.on("close", () => {
      if (browserOutput !== sock) return;
      browserOutput = null;
      log("browser bridge disconnected; active turns continue");
      maybeIdleExit();
    });
  });
  daemonServer.on("error", (err) => { log("daemon socket error:", err?.message); process.exit(1); });
  const listen = () => daemonServer.listen(daemonSocket, () => {
    try { chmodSync(daemonSocket, 0o600); } catch {}
    startHosts();
    maybeIdleExit();
  });
  const probe = net.createConnection(daemonSocket);
  probe.once("connect", () => { probe.destroy(); process.exit(0); });
  probe.once("error", () => {
    probe.destroy();
    try { unlinkSync(daemonSocket); } catch {}
    listen();
  });
}

if (bridgeMode) startBridge();
else {
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  if (daemonMode) startDaemon();
  else {
    process.stdout.on("error", () => { log("stdout error — worker connection gone"); shutdown(0); });
    const feed = frameReader(route, (len) => { log("bad browser frame", len); shutdown(1); });
    process.stdin.on("data", feed);
    process.stdin.on("end", () => { log("stdin closed — shutting down"); shutdown(0); });
    startHosts();
  }
}
