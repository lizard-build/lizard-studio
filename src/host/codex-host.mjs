#!/usr/bin/env node
// Codex host for the Lizard Studio side panel.
//
// Same job as claude-host.mjs, different engine underneath. The panel speaks
// Chrome native messaging on our stdio (the router hands it through verbatim);
// we drive the real `codex` CLI in its app-server mode — JSON-RPC 2.0 over
// newline-delimited stdio — and translate in both directions.
//
//   panel  <->  codex-host.mjs  <->  codex app-server  <->  the model
//
// The translation is the point of this file. The panel already knows how to
// render one thing: Claude Code's stream-json. Rather than teach it a second
// event language, we speak the one it knows. Every Codex notification is turned
// into the closest honest equivalent:
//
//   thread/started               -> system/init
//   item/agentMessage/delta      -> stream_event content_block_delta
//   item commandExecution        -> a Bash / Read / Grep / Glob tool call
//   item fileChange              -> an Edit / Write tool call
//   item mcpToolCall             -> an mcp__server__tool call
//   item webSearch               -> a WebSearch tool call
//   turn/plan/updated            -> a TodoWrite tool call
//   turn/completed               -> result
//   */requestApproval            -> permission
//   item/tool/requestUserInput   -> an AskUserQuestion permission
//
// "Honest" is the constraint. Codex has no Read or Grep tool — it runs shell
// commands — but it ships its own parse of every command it runs
// (`commandActions`), and that parse is what decides whether a card says "Read"
// or "Bash". We never invent a tool the model didn't use.
//
// Nothing here is shared with claude-host.mjs beyond hostkit.mjs. That is
// deliberate: the Claude path works, and this file is not allowed to change it.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  HOST_DIR, makeLog, frameReader, loadConfig, buildChildEnv, whichBin, redact,
} from "./hostkit.mjs";

const log = makeLog("codex");
const CONFIG = loadConfig();

// Bumped on every change the panel needs to know about. Reported in
// `agentReady`. Claude's own HOST_VERSION is separate and untouched.
const CODEX_HOST_VERSION = 1;

// The browser bridge numbers its requests from here so the router can tell our
// `browserResult` replies from claude's by value alone, and never has to parse
// or rewrite a message. Keep in step with router.mjs.
const CODEX_BID_BASE = 1_000_000_000;

// How long a prewarmed thread is worth keeping before we assume the user
// changed their mind and let it go.
const PREWARM_TTL_MS = 10 * 60 * 1000;

// A running turn normally says something — a token, a command, a plan step — at
// least every few seconds. If one goes completely silent for this long, nothing
// is coming: the panel would spin on a turn that is never going to end. Any
// notification for the thread resets the clock, so a long tool call or a slow
// model is never cut short; only true silence trips it.
const TURN_SILENCE_MS = 5 * 60 * 1000;

// ---- panel I/O ---------------------------------------------------------------

// Chrome caps one native message at 1 MB. Same guard, same reasoning as the
// claude host: shrink the long strings rather than drop the message.
const MAX_MSG = 900 * 1024;

function send(obj) {
  let json = JSON.stringify(obj);
  if (Buffer.byteLength(json) > MAX_MSG) {
    json = JSON.stringify(truncateDeep(obj));
    if (Buffer.byteLength(json) > MAX_MSG) {
      json = JSON.stringify({ type: "error", id: obj && obj.id, message: "[message too large to display]" });
    }
  }
  const body = Buffer.from(json, "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  try {
    process.stdout.write(Buffer.concat([header, body]));
  } catch {
    /* the router went away — our stdout handler shuts us down */
  }
}

function truncateDeep(value, budget = 60000) {
  if (typeof value === "string") {
    return value.length > budget ? value.slice(0, budget) + `\n…[truncated ${value.length - budget} chars]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, budget));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = truncateDeep(value[k], budget);
    return out;
  }
  return value;
}

process.on("uncaughtException", (err) => {
  log("UNCAUGHT", err && (err.stack || err.message));
  if (process.stdout.destroyed) return;
  try { send({ type: "error", message: "Codex host error: " + (err && err.message) }); } catch { /* ignore */ }
});
process.on("unhandledRejection", (reason) => log("UNHANDLED_REJECTION", String(reason)));
process.stdout.on("error", () => { log("stdout error — router gone"); shutdown(0); });

// ---- codex binary --------------------------------------------------------------

let CHILD_ENV = buildChildEnv({ CODEX_MANAGED_BY_NPM: undefined }, (warm) => {
  // The login-shell capture finished after we started. Later spawns get the
  // richer PATH; anything already running keeps what it had.
  CHILD_ENV = warm;
  if (!CODEX) {
    CODEX = resolveCodex();
    if (CODEX) announce();
  }
});

function resolveCodex() {
  if (CONFIG.codexPath && existsSync(CONFIG.codexPath)) return CONFIG.codexPath;
  const found = whichBin("codex", CHILD_ENV);
  if (found) return found;
  const home = homedir();
  const guesses = process.platform === "win32"
    ? [join(home, ".local", "bin", "codex.exe"), join(home, "AppData", "Roaming", "npm", "codex.cmd")]
    : [
      join(home, ".local/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      join(home, ".codex/bin/codex"),
      "/usr/bin/codex",
    ];
  for (const c of guesses) if (existsSync(c)) return c;
  return "";
}

let CODEX = resolveCodex();

function announce() {
  send({
    type: "agentReady",
    agent: "codex",
    version: CODEX_HOST_VERSION,
    ok: !!CODEX,
    codexPath: CODEX || null,
    home: homedir(),
  });
}

// ---- browser bridge --------------------------------------------------------------
// The same trick the claude host uses, with the same relay binary: Codex spawns
// mcp-browser.mjs as an MCP server, that relay connects back to us over
// localhost, and we forward each tool call to the panel, which runs it against
// the user's real tab.
//
// The relay is shared; the plumbing is not, because sharing it would mean the
// two hosts fighting over one socket and one token.

const MCP_RELAY = join(HOST_DIR, "mcp-browser.mjs");

let bridgePort = 0;
const browserPending = new Map(); // bid -> { resolve, timer }
// Disjoint from claude's counter so the router can tell whose reply is whose by
// value alone, and never has to parse a message to route it.
let nextBid = CODEX_BID_BASE;

// Binding to 127.0.0.1 keeps other machines out; it does not keep other local
// processes out. Only relays we spawn are told the token, and every request
// must carry it — otherwise anything running as this user could drive the tabs.
const BRIDGE_TOKEN = randomBytes(32).toString("hex");
redact(BRIDGE_TOKEN);

const bridgeServer = net.createServer((sock) => {
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.token !== BRIDGE_TOKEN) {
        log("bridge: dropping a connection with a bad token");
        sock.destroy();
        return;
      }
      const reqId = m.reqId;
      browserRequest(m.op, m.args, m.session).then((r) => {
        try { sock.write(JSON.stringify({ reqId, ...r }) + "\n"); } catch { /* relay went away */ }
      });
    }
  });
  sock.on("error", () => {});
});
bridgeServer.on("error", (err) => log("bridge server error:", err && err.message));
bridgeServer.listen(0, "127.0.0.1", () => {
  bridgePort = bridgeServer.address().port;
  log("browser bridge listening on 127.0.0.1:" + bridgePort);
});

function browserRequest(op, args, session) {
  return new Promise((resolve) => {
    const bid = nextBid++;
    const timer = setTimeout(() => {
      if (!browserPending.has(bid)) return;
      browserPending.delete(bid);
      resolve({ ok: false, error: "the extension didn't answer (is the Lizard Studio panel open?)" });
    }, 30000);
    timer.unref?.();
    browserPending.set(bid, { resolve, timer });
    send({ type: "browser", bid, op, args, session });
  });
}

function resolveBrowser(msg) {
  const p = browserPending.get(msg.bid);
  if (!p) return;
  clearTimeout(p.timer);
  browserPending.delete(msg.bid);
  p.resolve({ ok: msg.ok !== false, data: msg.data, error: msg.error });
}

/** The MCP registration handed to every thread, when the relay is available. */
function browserMcpConfig() {
  if (!bridgePort || !existsSync(MCP_RELAY)) return null;
  return {
    browser: {
      command: process.execPath,
      args: [MCP_RELAY],
      env: { RK_BRIDGE_PORT: String(bridgePort), RK_BRIDGE_TOKEN: BRIDGE_TOKEN, RK_BRIDGE_SESSION: "codex" },
    },
  };
}

// ---- the app-server -----------------------------------------------------------
// One `codex app-server` process serves every tab: threads are independent
// inside it, so a second process would only cost memory and a second start-up.

const app = {
  proc: null,
  starting: null, // Promise while the handshake is in flight
  ready: false,
  nextId: 1,
  pending: new Map(), // jsonrpc id -> { resolve, reject, timer }
};

function appSend(obj) {
  if (!app.proc || !app.proc.stdin.writable) return false;
  try {
    app.proc.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  } catch (err) {
    log("app-server write failed:", err && err.message);
    return false;
  }
}

/** One JSON-RPC request. Rejects on an error reply or if the server dies. */
function rpc(method, params, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!app.proc) return reject(new Error("codex app-server is not running"));
    const id = app.nextId++;
    const timer = setTimeout(() => {
      app.pending.delete(id);
      reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();
    app.pending.set(id, { resolve, reject, timer, method });
    if (!appSend({ id, method, params: params || {} })) {
      clearTimeout(timer);
      app.pending.delete(id);
      reject(new Error("codex app-server is not accepting requests"));
    }
  });
}

/** Reply to a request the server made of us. */
function rpcReply(id, result) {
  appSend({ id, result });
}
function rpcReplyError(id, message) {
  appSend({ id, error: { code: -32000, message: String(message) } });
}

// ---- custom providers -------------------------------------------------------
// A custom model is declared inline on thread/start, so nothing lands in the
// user's config.toml. Its credential is the one part that cannot travel in the
// request: Codex reads a provider key from an environment variable and only
// from there — `api_key` and `http_headers` in the provider table are both
// ignored (measured: the endpoint answers 401). So the key goes into the
// app-server's environment, and a server that predates it has to be restarted.

function providerEnvKey(id) {
  return "LZS_KEY_" + String(id).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function providerArgs(p) {
  return p ? { modelProvider: p.id } : {};
}

function providerConfig(p) {
  if (!p) return {};
  const cfg = {
    model_providers: {
      [p.id]: {
        name: p.id,
        base_url: p.baseUrl,
        env_key: providerEnvKey(p.id),
        wire_api: p.wireApi || "responses",
      },
    },
  };
  if (p.contextWindow) cfg.model_context_window = p.contextWindow;
  return cfg;
}

/** Returns true when a running app-server has to be replaced to see the key. */
function ensureProviderKey(p) {
  if (!p) return false;
  const name = providerEnvKey(p.id);
  if (CHILD_ENV[name] === (p.apiKey || "")) return false;
  CHILD_ENV[name] = p.apiKey || "";
  return !!app.proc;
}

function restartAppServer() {
  const proc = app.proc;
  if (!proc) return Promise.resolve();
  log("restarting app-server to pick up a custom provider key");
  return new Promise((resolve) => {
    proc.once("exit", () => resolve());
    try {
      proc.kill("SIGTERM");
    } catch {
      resolve();
    }
    // Never hang the session start on a process that will not die.
    setTimeout(resolve, 3000);
  }).then(() => startAppServer());
}

function startAppServer() {
  if (app.ready) return Promise.resolve();
  if (app.starting) return app.starting;
  if (!CODEX) return Promise.reject(new Error("Codex isn't installed."));

  app.starting = new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(CODEX, ["app-server"], { cwd: homedir(), env: CHILD_ENV, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      app.starting = null;
      return reject(err);
    }
    app.proc = proc;
    log("app-server spawned pid=", proc.pid, "from", CODEX);

    let buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        onAppMessage(msg);
      }
    });

    // Codex is chatty on stderr even when everything is fine — the models-cache
    // warning shows up on a plain handshake. It goes to our log and no further:
    // surfacing it in the chat, the way the claude host surfaces claude's
    // stderr, would paint a healthy session red.
    proc.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) log("app-server stderr:", text.slice(0, 1000));
    });

    proc.on("exit", (code, signal) => {
      log("app-server exited code=", code, "signal=", signal);
      app.ready = false;
      app.proc = null;
      app.starting = null;
      for (const p of app.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("codex app-server exited"));
      }
      app.pending.clear();
      prewarmed.clear();
      // Every live chat just lost its engine. Tell each one so the panel stops
      // spinning; the next prompt starts a fresh server.
      for (const s of sessions.values()) {
        if (s.running) endTurnWith(s, true, "Codex stopped unexpectedly.");
        s.threadId = null;
        s.started = false;
      }
    });

    proc.on("error", (err) => {
      log("app-server process error:", err && err.message);
      app.starting = null;
      reject(err);
    });

    rpc("initialize", {
      clientInfo: { name: "lizard-studio", title: "Lizard Studio", version: String(CODEX_HOST_VERSION) },
    }, 30000).then((info) => {
      appSend({ method: "initialized", params: {} });
      app.ready = true;
      app.starting = null;
      log("app-server ready, codexHome=", info && info.codexHome);
      loadModels();
      shipBundledSkills();
      resolve();
    }).catch((err) => {
      app.starting = null;
      reject(err);
    });
  });

  return app.starting;
}

function onAppMessage(msg) {
  // A reply to something we asked.
  if (msg.id != null && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
    const pending = app.pending.get(msg.id);
    if (!pending) return;
    app.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(msg.error.message || "codex error"));
    else pending.resolve(msg.result);
    return;
  }
  // A request the server is making of us — an approval, a question.
  if (msg.method && msg.id != null) {
    handleServerRequest(msg.id, msg.method, msg.params || {});
    return;
  }
  // A notification.
  if (msg.method) handleNotification(msg.method, msg.params || {});
}

// The lizard bootstrap skill ships with the host and is handed to Codex the
// same way `--plugin-dir` hands it to claude: as an extra place to look, never
// by writing into the user's own skills folder.
const SKILL_ROOT = join(HOST_DIR, "skills");

async function shipBundledSkills() {
  if (!existsSync(join(SKILL_ROOT, "lizard", "SKILL.md"))) return;
  try {
    await rpc("skills/extraRoots/set", { extraRoots: [SKILL_ROOT] }, 15000);
    log("skills: handed", SKILL_ROOT, "to codex");
  } catch (err) {
    log("skills/extraRoots/set failed:", err && err.message);
  }
}

// ---- model catalog -------------------------------------------------------------
// Codex publishes its own list, with the reasoning efforts each model actually
// supports. That beats a file we would have to keep in step by hand, so the
// panel's picker is fed from here.

let MODELS = [];
let DEFAULT_MODEL = "";

async function loadModels() {
  try {
    const res = await rpc("model/list", {}, 30000);
    const rows = (res && res.data) || [];
    MODELS = rows
      .filter((m) => m && m.id && !m.hidden)
      .map((m) => ({
        id: m.id,
        label: m.displayName || m.id,
        description: m.description || "",
        efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).filter(Boolean),
      }));
    if (!DEFAULT_MODEL && MODELS.length) DEFAULT_MODEL = MODELS[0].id;
    if (MODELS.length) send({ type: "models", agent: "codex", models: MODELS, defaultModel: DEFAULT_MODEL });
    log("model catalog:", MODELS.length, "models, default", DEFAULT_MODEL);
  } catch (err) {
    log("model/list failed:", err && err.message);
  }
}

/** Only send an effort the chosen model actually offers. */
function effortForModel(modelId, effort) {
  const want = effortFor(effort);
  if (!want) return null;
  const row = MODELS.find((m) => m.id === modelId);
  if (!row || !row.efforts.length) return want;
  if (row.efforts.includes(want)) return want;
  // Nearest rung down rather than an error from the server. The panel should
  // never offer a rung this model lacks, so reaching here means something got
  // out of step — land somewhere sane instead of failing the turn.
  const ladder = ["ultra", "max", "xhigh", "high", "medium", "low"];
  const from = ladder.indexOf(want);
  for (let i = Math.max(from, 0); i < ladder.length; i++) {
    if (row.efforts.includes(ladder[i])) return ladder[i];
  }
  return row.efforts[row.efforts.length - 1];
}

// ---- sessions -----------------------------------------------------------------

const sessions = new Map(); // panel chat id -> session
const byThread = new Map(); // codex thread id -> panel chat id
const prewarmed = new Map(); // cwd -> { threadId, at }

function makeSession(id, cwd) {
  return {
    id,
    cwd,
    model: null,
    provider: null,
    effort: null,
    mode: "default",
    threadId: null,
    turnId: null,
    started: false,
    running: false,
    // Translator state.
    seq: 0,               // synthetic message counter, for stream ids
    streamMsgId: null,    // the assistant message currently streaming
    streamText: "",       // what we have forwarded of it (see closeStream)
    execOut: new Map(),   // item id -> output collected from the deltas
    openTools: new Set(), // tool ids announced but not yet resolved
    planToolId: null,     // the TodoWrite card standing in for the turn plan
    usage: null,          // latest token usage, folded into assistant messages
    contextWindow: null,
    asks: new Map(),      // jsonrpc request id -> { kind, params }
    silenceTimer: null,   // see touchTurn
    // Opening a Codex thread takes seconds. The panel doesn't wait for it — it
    // sends `start` and then whatever the user types, which on a fast typist
    // arrives first. Those prompts wait here and go out the moment the thread
    // is up, rather than being answered with "this session isn't running".
    opening: true,
    pending: [],
  };
}

// Temporary: writes the item ids Codex uses and the stream envelope we build
// from them into host.log, so a turn that renders wrong can be read back rather
// than guessed at. Remove once the custom-provider tail is settled.
const TRACE = true;

/** Chrome-side event: one Claude-shaped stream-json object for this chat. */
function emit(s, data) {
  if (TRACE) {
    if (data.type === "stream_event") {
      const e = data.event || {};
      const t = e.type === "content_block_delta" ? `delta(${JSON.stringify((e.delta || {}).text || "").slice(0, 30)})` : e.type;
      log("TRACE emit", t, e.type === "message_start" ? "id=" + ((e.message || {}).id || "") : "");
    } else if (data.type === "assistant") {
      const txt = ((data.message || {}).content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
      log("TRACE emit assistant id=" + ((data.message || {}).id || "") + " textLen=" + txt.length + " tools=" + (((data.message || {}).content || []).filter((b) => b.type === "tool_use").length));
    } else {
      log("TRACE emit", data.type + (data.subtype ? "/" + data.subtype : ""));
    }
  }
  send({ type: "event", id: s.id, data });
}

function nextMsgId(s) {
  s.seq += 1;
  return `codex_msg_${s.threadId || s.id}_${s.seq}`;
}

// The usage block the panel reads to size its context ring. Codex reports the
// thread total; Claude reports the input side of the latest call, which is the
// same number for our purposes — what the model is carrying right now.
function usageBlock(s) {
  const u = s.usage || {};
  return {
    input_tokens: u.inputTokens || 0,
    output_tokens: u.outputTokens || 0,
    cache_read_input_tokens: u.cachedInputTokens || 0,
    cache_creation_input_tokens: 0,
  };
}

/**
 * Close the assistant message currently streaming, first topping the stream up
 * to `full` — the text Codex reports on the finished item.
 *
 * The deltas are a courtesy; that finished text is the reply. They are not
 * always the same thing: an endpoint can complete the item without having
 * streamed its last piece, and a custom provider does it routinely — the last
 * chunk arrives only in `output_text.done`. Whatever is missing goes out as one
 * more delta here, before the block closes.
 *
 * Sending it afterwards instead — as the canonical `assistant` copy, which we
 * do anyway — is not enough. The panel keeps the streamed text as canonical and
 * can only repaint it while the node the typewriter built is in the page; when
 * the tail of a turn lands in a single event-loop turn, no animation frame has
 * run yet, that node does not exist, and the complete copy is dropped. The
 * reply then ends wherever the deltas did — one word short of itself, for good.
 * Keeping the stream whole means nothing downstream has to make up the
 * difference.
 */
function closeStream(s, full) {
  if (!s.streamMsgId) return;
  const text = typeof full === "string" ? full : "";
  // Only ever extend, and only a stream this text plainly continues. A shorter
  // or divergent report is a disagreement we cannot resolve by appending, so
  // leave the stream as it is and let the canonical copy speak for itself.
  if (text.length > s.streamText.length && text.startsWith(s.streamText)) {
    emit(s, {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(s.streamText.length) } },
    });
  }
  emit(s, { type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  emit(s, { type: "stream_event", event: { type: "message_stop" } });
  s.streamMsgId = null;
  s.streamText = "";
}

// ---- translator: tool calls ----------------------------------------------------

/** Announce a tool call to the panel as a one-block assistant message. */
function toolUse(s, id, name, input) {
  s.openTools.add(id);
  emit(s, {
    type: "assistant",
    message: {
      id: `codex_tool_${id}`,
      type: "message",
      role: "assistant",
      model: s.model || DEFAULT_MODEL || "codex",
      content: [{ type: "tool_use", id, name, input: input || {} }],
      usage: usageBlock(s),
    },
  });
}

/** Resolve a tool call the panel is still showing as running. */
function toolResult(s, id, content, isError) {
  if (!s.openTools.delete(id)) return;
  emit(s, {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: String(content == null ? "" : content), is_error: !!isError }],
    },
  });
}

// Codex runs everything through the shell, but it hands us its own parse of the
// command. That parse is what lets a `sed -n 1,40p file.ts` show up as a Read
// card instead of a wall of shell. Anything it can't classify stays Bash —
// which is the truth, not a fallback.
// Codex runs every command through a login shell: the raw string is
// `/bin/zsh -lc "<script>"`. That wrapper is an implementation detail — the
// card should show what the model actually asked for, the way the Claude path
// shows a bare command.
const SHELL_WRAPPER = /^(?:\S*\/)?(?:ba|z|k|)sh\s+-[a-z]*c\s+([\s\S]+)$/;

function unwrapShell(command) {
  const m = SHELL_WRAPPER.exec(String(command || "").trim());
  if (!m) return String(command || "");
  let inner = m[1].trim();
  // Strip one balanced layer of quoting, and only when the whole string is
  // wrapped in it — a script that merely starts and ends with a quote must be
  // left alone.
  const q = inner[0];
  if ((q === '"' || q === "'") && inner.endsWith(q) && inner.length > 1) {
    const body = inner.slice(1, -1);
    if (!body.includes(q) || q === '"') inner = body;
  }
  return inner || String(command || "");
}

function commandTool(command, actions) {
  const list = Array.isArray(actions) ? actions : [];
  // Only claim a friendlier card when the whole command is that one thing. A
  // pipeline that reads a file and greps it is a shell command, not a Read.
  if (list.length === 1) {
    const a = list[0];
    if (a.type === "read" && a.path) return { name: "Read", input: { file_path: a.path } };
    if (a.type === "search") return { name: "Grep", input: { pattern: a.query || command, path: a.path || undefined } };
    if (a.type === "listFiles") return { name: "Glob", input: { pattern: a.path || command } };
  }
  // Codex parses a compound command into its parts; joining them back reads
  // better than the shell wrapper and keeps every piece the model ran.
  const readable = list.length > 1 && list.every((a) => a && a.command)
    ? list.map((a) => a.command).join(" && ")
    : unwrapShell(command);
  return { name: "Bash", input: { command: readable } };
}

// A unified diff, split back into the before and after text so the panel can
// render its usual line diff. Codex sends the patch; Claude sent the two
// strings. Neither side loses anything in the conversion — it is the same hunk,
// read twice.
function splitUnifiedDiff(diff) {
  const before = [];
  const after = [];
  for (const line of String(diff || "").split("\n")) {
    if (/^(---|\+\+\+|diff |index |@@)/.test(line)) continue;
    if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith("+")) after.push(line.slice(1));
    else if (line.startsWith(" ")) { before.push(line.slice(1)); after.push(line.slice(1)); }
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

// Not everything in `diff` is a diff. For a new file Codex sends the file's
// contents outright, with no markers at all — running that through the splitter
// yields two empty strings and a card showing nothing. Decide which it is
// before reading it.
function looksLikeUnifiedDiff(text) {
  return /^(@@|--- |\+\+\+ |diff )/m.test(String(text || ""));
}

// `kind` is a tagged object — { type: "add" | "delete" | "update" } — not the
// bare string it reads like. Comparing it to a string silently sends every
// change down the update path.
function changeKind(change) {
  const k = change && change.kind;
  if (typeof k === "string") return k;
  return (k && k.type) || "update";
}

function fileChangeTool(change) {
  const kind = changeKind(change);
  const raw = change.diff || "";
  if (kind === "add") {
    // A new file: show what it now contains.
    const content = looksLikeUnifiedDiff(raw) ? splitUnifiedDiff(raw).after : raw;
    return { name: "Write", input: { file_path: change.path, content } };
  }
  if (kind === "delete") {
    return { name: "Bash", input: { command: `rm ${change.path}` } };
  }
  const { before, after } = looksLikeUnifiedDiff(raw)
    ? splitUnifiedDiff(raw)
    // No markers on an update is unexpected; showing the text as the new side
    // beats showing an empty card.
    : { before: "", after: raw };
  return { name: "Edit", input: { file_path: change.path, old_string: before, new_string: after } };
}

// ---- translator: notifications --------------------------------------------------

function sessionFor(params) {
  const id = params && params.threadId ? byThread.get(params.threadId) : null;
  return id ? sessions.get(id) : null;
}

function handleNotification(method, params) {
  const s = sessionFor(params);
  if (s && s.running) touchTurn(s);
  if (TRACE && method !== "item/agentMessage/delta" && !method.startsWith("mcpServer/")) {
    const it = params && params.item;
    log("TRACE recv", method, it ? `item=${it.type} id=${it.id} textLen=${(it.text || "").length}` : "");
  }

  switch (method) {
    // --- turn lifecycle ---
    case "turn/started": {
      if (!s) break;
      s.running = true;
      s.turnId = (params.turn && params.turn.id) || s.turnId;
      break;
    }
    case "turn/completed": {
      if (!s) break;
      endTurnWith(s, false);
      break;
    }
    case "thread/status/changed": {
      if (!s) break;
      // The only thing the panel needs from this is "still working".
      if (params.status && params.status.type === "idle" && s.running) endTurnWith(s, false);
      break;
    }

    // --- assistant text ---
    case "item/agentMessage/delta": {
      if (!s || !s.streamMsgId) break;
      s.streamText += params.delta || "";
      emit(s, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: params.delta || "" } },
      });
      break;
    }

    // --- item lifecycle ---
    case "item/started": return onItemStarted(s, params);
    case "item/completed": return onItemCompleted(s, params);

    case "item/commandExecution/outputDelta": {
      if (!s) break;
      const prev = s.execOut.get(params.itemId) || "";
      // Keep only the tail: a chatty build can emit megabytes, and the card
      // shows the end of it anyway.
      const next = (prev + (params.delta || "")).slice(-200000);
      s.execOut.set(params.itemId, next);
      break;
    }

    // --- plan ---
    case "turn/plan/updated": {
      if (!s) break;
      const todos = (params.plan || []).map((step) => ({
        content: step.step,
        status: step.status === "inProgress" ? "in_progress" : step.status === "completed" ? "completed" : "pending",
        activeForm: step.step,
      }));
      if (!todos.length) break;
      // One card per plan revision, resolved right away — the panel's plan view
      // reads the newest TodoWrite it saw.
      const id = `codex_plan_${s.turnId || "t"}_${++s.seq}`;
      toolUse(s, id, "TodoWrite", { todos });
      toolResult(s, id, "Plan updated", false);
      break;
    }

    // --- counters ---
    case "thread/tokenUsage/updated": {
      if (!s) break;
      const tu = params.tokenUsage || {};
      // `last`, not `total`. Codex's total is the sum over every turn in the
      // thread, so it re-counts the whole prefix each time and the context ring
      // climbs to "94% full" after a handful of exchanges on a fresh session.
      // Claude's usage block is per-message, and `last` is its counterpart —
      // which also makes the two harnesses read the same.
      s.usage = tu.last || tu.total || null;
      // The window the model is actually running with. Nothing else knows it —
      // the model catalog doesn't carry one — so the panel's context ring has
      // no real denominator until this arrives.
      if (tu.modelContextWindow && tu.modelContextWindow !== s.contextWindow) {
        s.contextWindow = tu.modelContextWindow;
        if (s.model) send({ type: "contextWindow", agent: "codex", model: s.model, window: s.contextWindow });
      }
      break;
    }
    case "account/rateLimits/updated": {
      const rl = params.rateLimits || {};
      const primary = rl.primary || {};
      // At the cap the server can send a snapshot with no window in it. A
      // meter reading "null%, resets 1 Jan 1970" is worse than no meter.
      if (typeof primary.usedPercent !== "number") break;
      send({
        type: "planUsage",
        agent: "codex",
        usedPercent: typeof primary.usedPercent === "number" ? primary.usedPercent : null,
        resetsAt: primary.resetsAt || null,
        windowMins: primary.windowDurationMins || null,
        planType: rl.planType || null,
        reached: rl.rateLimitReachedType || null,
      });
      break;
    }

    // --- housekeeping we deliberately swallow ---
    case "hook/started":
    case "hook/completed":
      // The user's own hooks are not conversation. The claude path doesn't show
      // them either; showing Codex's would be noise in the transcript.
      break;
    case "mcpServer/startupStatus/updated": {
      if (params.status !== "failed") break;
      log("mcp server", params.name, "failed:", params.error);
      // Codex boots whatever MCP servers the user has configured in their own
      // config.toml, and several of ours fail every session for reasons that
      // have nothing to do with this chat — not logged in, an expired token, a
      // server that moved. That is between them and Codex; it belongs in the
      // log, not in the conversation.
      //
      // The one exception is the browser server, which is ours. If that fails,
      // the agent has quietly lost the live tab — the one thing this panel
      // exists for — and saying nothing would leave the user wondering why it
      // keeps claiming it cannot see the page.
      if (s && params.name === "browser") {
        send({ type: "mcpStatus", agent: "codex", id: s.id, server: params.name, status: "failed", error: params.error || null });
      }
      break;
    }
    case "account/login/completed": {
      loginId = null;
      // No chat owns a sign-in, so it lands on whichever one asked — or on all
      // of them, which is the same thing when only one card is open.
      for (const sess of sessions.values()) {
        send({ type: "authDone", id: sess.id, ok: !!params.success, message: params.error || "" });
      }
      if (!sessions.size) send({ type: "authDone", ok: !!params.success, message: params.error || "" });
      break;
    }
    case "error": {
      // `error` is an object, not a string, and `willRetry` says whether this
      // is even a failure yet. Treating every one of these as fatal turned a
      // hiccup Codex was about to retry into a dead turn and a red banner.
      const err = params.error || {};
      const text = [err.message, err.additionalDetails].filter(Boolean).join(" — ") || "Codex reported an error.";
      log("app-server error:", text.slice(0, 500), params.willRetry ? "(retrying)" : "(fatal)");
      if (params.willRetry) break;
      send({ type: "error", id: s ? s.id : undefined, message: text });
      // Nothing else is coming for this turn, so close it rather than leaving
      // the panel spinning on a reply that will never arrive.
      if (s) endTurnWith(s, true, text);
      break;
    }
    default:
      // Forward-compat: a Codex we don't fully know yet is not an error.
      break;
  }
}

function onItemStarted(s, params) {
  if (!s) return;
  const item = params.item || {};
  switch (item.type) {
    case "userMessage":
      // Our own prompt, echoed back. The panel drew that bubble itself the
      // moment the user hit send — rendering it again would double it.
      break;
    case "agentMessage": {
      // The same item can start twice, and the second start is not a second
      // message. A custom provider on the responses wire sends
      // `output_item.added` only once the message is finished, so the
      // app-server announces the item at the first delta and again — fully
      // formed — just before `item/completed`. Opening a block for that second
      // start would close the streamed one and leave an empty replacement,
      // which `item/completed` then fills with the whole reply through
      // `closeStream`: the answer printed twice, once typed out and once at a
      // stroke. Staying on the block we already have is the whole fix.
      if (item.id && s.streamMsgId === item.id) break;
      // A message still open here never got its own completion. Close it before
      // opening the next one: the panel drops the blocks of the message it is
      // streaming the moment a new one starts, so an orphan would keep its last
      // word hidden for the rest of the session.
      if (s.streamMsgId) closeStream(s, s.streamText);
      const id = item.id || nextMsgId(s);
      s.streamMsgId = id;
      s.streamText = "";
      emit(s, {
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id, type: "message", role: "assistant", model: s.model || DEFAULT_MODEL || "codex", content: [], usage: usageBlock(s) },
        },
      });
      emit(s, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
      break;
    }
    case "commandExecution": {
      const t = commandTool(item.command || "", item.commandActions);
      s.execOut.set(item.id, "");
      toolUse(s, item.id, t.name, t.input);
      break;
    }
    case "fileChange":
      // Deliberately nothing here. A file change is announced the moment Codex
      // decides to make it, but the patch itself only lands on completion — so
      // drawing the card now would draw an Edit with nothing in it. The card is
      // built in onItemCompleted instead, where the diff is real.
      break;
    case "mcpToolCall": {
      toolUse(s, item.id, `mcp__${item.server}__${item.tool}`, item.arguments || {});
      break;
    }
    case "webSearch": {
      toolUse(s, item.id, "WebSearch", { query: item.query || "" });
      break;
    }
    case "reasoning":
      // The transcript doesn't render thinking on the Claude side either, and
      // an empty assistant row for a block nobody sees would just open a gap.
      break;
    default:
      break;
  }
}

function onItemCompleted(s, params) {
  if (!s) return;
  const item = params.item || {};
  switch (item.type) {
    case "agentMessage": {
      const id = item.id || s.streamMsgId;
      // `closeStream` tops the stream up to this text before closing it, so the
      // panel's buffer is the whole reply whatever the deltas managed to carry.
      // A completion for some earlier message still closes the open one — a
      // block left open is a reply the typewriter never finishes.
      if (s.streamMsgId === id) closeStream(s, item.text || "");
      else if (s.streamMsgId) closeStream(s, s.streamText);
      // The canonical copy. The panel skips re-rendering a message it streamed
      // and takes the usage numbers off it.
      emit(s, {
        type: "assistant",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: s.model || DEFAULT_MODEL || "codex",
          content: [{ type: "text", text: item.text || "" }],
          usage: usageBlock(s),
        },
      });
      break;
    }
    case "commandExecution": {
      const out = item.aggregatedOutput || s.execOut.get(item.id) || "";
      s.execOut.delete(item.id);
      const failed = item.status === "failed" || item.status === "declined" || (item.exitCode != null && item.exitCode !== 0);
      const suffix = item.status === "declined" ? "Command declined." : failed && !out.trim() ? `Exit code ${item.exitCode}` : "";
      toolResult(s, item.id, out || suffix, failed);
      break;
    }
    case "fileChange": {
      const changes = item.changes || [];
      const failed = item.status === "failed" || item.status === "declined";
      // One card per file, so a multi-file patch reads the way an agent editing
      // three files reads on the Claude side. Card and result go out together:
      // by the time we know what changed, it has already changed.
      changes.forEach((change, i) => {
        const id = `${item.id}#${i}`;
        const tool = fileChangeTool(change);
        toolUse(s, id, tool.name, tool.input);
        toolResult(s, id, failed ? `Change to ${change.path} was not applied.` : `Updated ${change.path}`, failed);
      });
      break;
    }
    case "mcpToolCall": {
      const res = item.result;
      const text = res && Array.isArray(res.content)
        ? res.content.map((c) => (c && c.type === "text" ? c.text : "")).filter(Boolean).join("\n")
        : "";
      toolResult(s, item.id, item.error ? (item.error.message || "MCP call failed") : text, !!item.error);
      break;
    }
    case "webSearch": {
      toolResult(s, item.id, item.query ? `Searched: ${item.query}` : "", false);
      break;
    }
    default:
      break;
  }
}

/** Restart the silence clock for a session that is mid-turn. */
function touchTurn(s) {
  if (!s) return;
  if (s.silenceTimer) clearTimeout(s.silenceTimer);
  s.silenceTimer = null;
  if (!s.running) return;
  // A turn waiting on an approval is silent for a good reason: someone has to
  // read the dialog. The clock starts again when they answer.
  if (s.asks.size) return;
  s.silenceTimer = setTimeout(() => {
    if (!s.running) return;
    log("turn went silent for", TURN_SILENCE_MS, "ms — ending it");
    send({ type: "error", id: s.id, message: "Codex stopped responding. The turn was ended." });
    endTurnWith(s, true, "Codex stopped responding.");
  }, TURN_SILENCE_MS);
  s.silenceTimer.unref?.();
}

function endTurnWith(s, isError, message) {
  if (s.silenceTimer) { clearTimeout(s.silenceTimer); s.silenceTimer = null; }
  if (!s.running && !isError) return;
  s.running = false;
  // Close anything still showing a spinner — an interrupted turn leaves tool
  // cards open, and a card that pulses forever reads as a hung session.
  for (const id of [...s.openTools]) {
    toolResult(s, id, message || "Stopped.", true);
  }
  // The turn ended with a message still open, so no finished item is coming for
  // it: the deltas are all there is, and they close the block as they stand.
  closeStream(s, s.streamText);
  const u = s.usage || {};
  emit(s, {
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: !!isError,
    result: message || "",
    session_id: s.threadId,
    num_turns: 1,
    usage: { input_tokens: u.inputTokens || 0, output_tokens: u.outputTokens || 0 },
  });
  s.turnId = null;
}

// ---- approvals ------------------------------------------------------------------

function handleServerRequest(reqId, method, params) {
  const s = sessionFor(params);
  if (s) touchTurn(s);
  if (!s) {
    // No chat owns this thread — refuse rather than leave Codex waiting.
    rpcReplyError(reqId, "no session for thread " + params.threadId);
    return;
  }

  switch (method) {
    case "item/commandExecution/requestApproval": {
      const t = commandTool(params.command || "", params.commandActions);
      s.asks.set(reqId, { kind: "command", params });
      send({
        type: "permission",
        id: s.id,
        requestId: reqId,
        toolName: t.name,
        input: t.input,
        suggestions: null,
        description: params.reason || null,
        toolUseId: params.itemId || null,
      });
      break;
    }
    case "item/fileChange/requestApproval": {
      s.asks.set(reqId, { kind: "fileChange", params });
      send({
        type: "permission",
        id: s.id,
        requestId: reqId,
        toolName: "Edit",
        input: { file_path: params.grantRoot || s.cwd || "", reason: params.reason || "" },
        suggestions: null,
        description: params.reason || "Codex wants to change files.",
        toolUseId: params.itemId || null,
      });
      break;
    }
    case "item/permissions/requestApproval": {
      s.asks.set(reqId, { kind: "permissions", params });
      send({
        type: "permission",
        id: s.id,
        requestId: reqId,
        toolName: "Permissions",
        input: { cwd: params.cwd, permissions: params.permissions || {} },
        suggestions: null,
        description: params.reason || "Codex is asking for extra access.",
        toolUseId: params.itemId || null,
      });
      break;
    }
    case "item/tool/requestUserInput": {
      const questions = (params.questions || []).map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: false,
        options: (q.options || []).map((o) => ({
          label: o.label || o.value || String(o),
          description: o.description || "",
        })),
      }));
      s.asks.set(reqId, { kind: "userInput", params });
      send({
        type: "permission",
        id: s.id,
        requestId: reqId,
        toolName: "AskUserQuestion",
        input: { questions },
        suggestions: null,
      });
      break;
    }
    case "mcpServer/elicitation/request": {
      // Nothing in the panel asks this yet — decline politely rather than hang.
      rpcReply(reqId, { action: "decline" });
      break;
    }
    default:
      log("unhandled server request:", method);
      rpcReplyError(reqId, "unsupported request: " + method);
      break;
  }
}

function answerPermission(msg) {
  const s = sessions.get(msg.id);
  if (!s) return;
  const ask = s.asks.get(msg.requestId);
  if (!ask) return;
  s.asks.delete(msg.requestId);
  touchTurn(s); // answered — the turn is expected to move again

  const allow = msg.behavior === "allow";
  // "Allow and don't ask again" arrives as a permission update on the Claude
  // side; Codex has its own word for the same intent.
  const forSession = allow && !!msg.updatedPermissions;

  switch (ask.kind) {
    case "command":
      rpcReply(msg.requestId, { decision: allow ? (forSession ? "acceptForSession" : "accept") : msg.interrupt ? "cancel" : "decline" });
      break;
    case "fileChange":
      rpcReply(msg.requestId, { decision: allow ? (forSession ? "acceptForSession" : "accept") : msg.interrupt ? "cancel" : "decline" });
      break;
    case "permissions":
      rpcReply(msg.requestId, {
        permissions: allow ? (ask.params.permissions || {}) : {},
        scope: forSession ? "session" : "turn",
      });
      break;
    case "userInput": {
      // The panel answers by question TEXT (that is Claude Code's own shape);
      // Codex wants them keyed by question id. We kept the original questions,
      // so the two line up here rather than in the panel.
      const given = (msg.updatedInput && msg.updatedInput.answers) || {};
      const answers = {};
      for (const q of ask.params.questions || []) {
        const picked = given[q.question];
        if (picked == null) continue;
        answers[q.id] = { answers: String(picked).split(", ").filter(Boolean) };
      }
      rpcReply(msg.requestId, { answers });
      break;
    }
    default:
      rpcReplyError(msg.requestId, "unknown ask");
      break;
  }
}

// ---- permission modes -----------------------------------------------------------
// The panel speaks Claude's five modes. Codex has two axes — a sandbox and an
// approval policy — and exactly three profiles built on them. Rather than make
// the panel learn a new vocabulary, we accept either and land on the same three.

const PROFILES = {
  "read-only": { sandbox: "read-only", approvalPolicy: "on-request", policy: { type: "readOnly" } },
  workspace: { sandbox: "workspace-write", approvalPolicy: "on-request", policy: { type: "workspaceWrite" } },
  "full-access": { sandbox: "danger-full-access", approvalPolicy: "never", policy: { type: "dangerFullAccess" } },
};

const MODE_MAP = {
  // Codex's own names
  "read-only": "read-only",
  workspace: "workspace",
  "full-access": "full-access",
  // Claude's names, so a chat carrying a remembered mode still starts
  plan: "read-only",
  default: "workspace",
  acceptEdits: "workspace",
  auto: "workspace",
  bypassPermissions: "full-access",
};

function profileFor(mode) {
  return PROFILES[MODE_MAP[mode] || "workspace"];
}

/** What `thread/start` / `thread/resume` want: a sandbox *mode* name. */
function threadProfile(mode) {
  const p = profileFor(mode);
  return { sandbox: p.sandbox, approvalPolicy: p.approvalPolicy };
}

/**
 * What `turn/start` wants: a sandbox *policy* object. These are not the same
 * shape, and sending the thread form here fails silently — the turn would keep
 * the thread's original sandbox. Setting it per turn is what lets a mode change
 * (or a thread taken from the prewarm pool) apply without opening a new thread.
 */
function turnProfile(mode) {
  const p = profileFor(mode);
  return { sandboxPolicy: p.policy, approvalPolicy: p.approvalPolicy };
}

// Codex has its own ladder, and it is not the same on every model: gpt-5.6-terra
// runs low → medium → high → xhigh → max → ultra, while gpt-5.5 stops at xhigh.
// Only one rung needs translating — Claude calls its top one ultracode, Codex
// calls it ultra. Everything else is already the same word.
//
// This used to fold `max` into `xhigh` as well, which meant the slider could
// read Max while the turn actually ran a rung lower.
function effortFor(effort) {
  if (!effort) return null;
  if (effort === "ultracode") return "ultra";
  return effort;
}

// ---- session control --------------------------------------------------------------

async function startSession(msg) {
  const id = msg.id || "default";
  const cwd = msg.cwd;
  if (!cwd || !existsSync(cwd)) {
    send({ type: "needsFolder", id, message: "Choose a project folder to start a session." });
    return;
  }

  closeSession(id, { quiet: true });
  openedCwds.add(cwd);

  const s = makeSession(id, cwd);
  // A custom model brings its own provider, declared inline on thread/start.
  // It is deliberately checked before the catalog test below: its id is ours,
  // not Codex's, so that test would throw it away.
  s.provider = msg.provider && msg.provider.baseUrl ? msg.provider : null;
  s.model = s.provider ? s.provider.model : msg.model || null;
  // A model id from the Claude picker means nothing here — take the catalog
  // default rather than handing Codex a name it will reject.
  if (!s.provider && s.model && !MODELS.some((m) => m.id === s.model)) s.model = null;
  s.effort = msg.effort || null;
  s.mode = msg.permissionMode || "default";
  sessions.set(id, s);

  try {
    if (ensureProviderKey(s.provider)) await restartAppServer();
    await startAppServer();
  } catch (err) {
    log("app-server start failed:", err && err.message);
    send({ type: "error", id, message: `Couldn't start Codex: ${err && err.message}` });
    return;
  }

  const profile = threadProfile(s.mode);
  try {
    let thread;
    if (msg.resume) {
      const mcp = browserMcpConfig();
      try {
        thread = await rpc("thread/resume", {
          threadId: msg.resume, ...profile, cwd, model: s.model || undefined,
          config: mcp ? { mcp_servers: mcp } : undefined,
        });
      } catch (err) {
        // The id may be from another agent entirely (a tab whose harness was
        // switched), or a thread the user has since deleted. Neither is worth
        // stranding the tab over — open a fresh one and carry on.
        log("resume failed for", msg.resume, "—", err && err.message, "— starting fresh");
        thread = null;
      }
    }
    if (!thread) {
      // A prewarmed thread was opened on the default model and provider, so it
      // is useless to a custom one — reusing it would silently answer from the
      // wrong endpoint.
      const spare = msg.resume || s.provider ? null : takePrewarmed(cwd);
      if (spare) {
        thread = { thread: { id: spare } };
        log("used a prewarmed thread for", cwd);
      } else {
        const mcp = browserMcpConfig();
        thread = await rpc("thread/start", {
          cwd,
          model: s.model || undefined,
          ...providerArgs(s.provider),
          ...profile,
          developerInstructions: BROWSER_HINT,
          config: mcp || s.provider ? { ...(mcp ? { mcp_servers: mcp } : {}), ...providerConfig(s.provider) } : undefined,
        });
      }
    }
    s.threadId = (thread && thread.thread && thread.thread.id) || null;
    if (!s.threadId) throw new Error("Codex didn't return a thread id");
    byThread.set(s.threadId, id);
    s.started = true;
    s.opening = false;
  } catch (err) {
    log("thread start failed:", err && err.message);
    s.opening = false;
    send({ type: "error", id, message: `Couldn't open a Codex session: ${err && err.message}` });
    // Anything the user typed while we were opening has nowhere to go. Say so
    // once and close the turn, rather than leaving a spinner running.
    if (s.pending.length) {
      s.pending.length = 0;
      endTurnWith(s, true, "The session couldn't be opened.");
    }
    return;
  }

  if (!s.model) s.model = DEFAULT_MODEL || null;
  send({ type: "started", id, pid: app.proc ? app.proc.pid : null, cwd, model: s.model, effort: s.effort, permissionMode: s.mode });

  // The panel's own init: this is what tells it the session is live, which
  // folder it is in, and what to put in its pickers.
  emit(s, {
    type: "system",
    subtype: "init",
    cwd,
    session_id: s.threadId,
    model: s.model || undefined,
    permissionMode: s.mode,
    tools: [],
    slash_commands: [],
    skills: [],
    plugins: [],
    agent: "codex",
  });

  // Whatever the user typed while the thread was opening goes out now, in the
  // order they typed it.
  const queued = s.pending.splice(0, s.pending.length);
  for (const q of queued) sendPrompt(q);

  loadSkills(s);
  // Whatever the user picks next is likely in the same folder — have a thread
  // waiting for it. Codex takes seconds to open one, and that wait is the
  // difference between "instant" and "stuck".
  schedulePrewarm(cwd);
}

// The tool briefing handed to every Codex session as developerInstructions.
//
// It is a copy of the one in claude-host.mjs, and stays a copy on purpose: the
// tools are the same, but sharing the string would mean importing from the
// working path, and nothing in the Codex work reaches in there. When the
// browser tools change, both copies change.
const BROWSER_HINT =
  "You have a set of browser_* tools (MCP server `browser`) that inspect AND control the user's Chrome tabs in real time — not just the active one. " +
  "Tabs: browser_tabs lists every open tab (tabId, windowId, title, url, active); almost every other browser_* tool accepts an optional tabId to target any tab in the background without switching to it. " +
  "Tab pinning: the FIRST browser_* call in a task that omits tabId resolves to the active tab and PINS this conversation to it — every later call that also omits tabId reuses that same pinned tab, even if the user switches which tab is active in the meantime. " +
  "So once you've started working with a tab, keep omitting tabId to keep targeting it; only pass tabId explicitly when you deliberately mean a different tab (that re-pins to the new one). browser_tabs' response includes workingTabId, the tab currently pinned for this conversation. " +
  "browser_tab_activate brings a tab to the front for the user; browser_tab_open / browser_tab_close open and close tabs. " +
  "Read/observe: browser_info (url/title/selection — cheap, call first), browser_dom (visible text or HTML, optional CSS selector), browser_snapshot (accessibility tree with stable @refs — the best way to understand a page before acting), " +
  "browser_eval (run JS and read anything — DOM, app state, localStorage, fetch), browser_console (recent logs + exceptions), browser_network (recent requests), browser_screenshot. " +
  "Act: browser_click, browser_type, browser_fill, browser_key, browser_navigate, browser_reload, browser_upload_file (attach a local file to a page's file input or drop zone by absolute path — no need to click the input or deal with the OS file dialog). " +
  "Prefer browser_snapshot to get @refs, then target clicks/typing/fills by ref rather than guessing selectors. " +
  "The FIRST user message of a conversation may be preceded by a one-time '[Open browser tabs]' snapshot listing the tabs open at that moment (title + a SHORTENED URL — query string and #fragment stripped), with a leading → marking the one the user was viewing — that's environment context the extension injected, not something the user typed. It is NOT resent on later turns and it can go stale, so call browser_tabs whenever you need the current list, a tab's full URL, or its numeric tabId. " +
  "Since the snapshot only has title/truncated-URL, when the user refers to \"this page\", \"the open tab\", what they're \"looking at\", or asks you to debug or drive a live site, still call browser_info / browser_dom / browser_snapshot (targeting that tabId if it's not the active one) instead of guessing from the title alone. " +
  "Console and network capture begin when browser_console / browser_network first attach to a tab, so if they come back empty, call browser_reload (or re-trigger the action yourself, e.g. browser_click) rather than asking the user to reload — then call browser_console / browser_network again.";

async function loadSkills(s) {
  try {
    const res = await rpc("skills/list", {}, 15000);
    const entries = (res && res.data) || [];
    const names = [];
    for (const entry of entries) {
      for (const skill of entry.skills || []) if (skill.name) names.push(skill.name);
    }
    if (!names.length) return;
    // Codex has no slash commands, but it does have skills — and the panel's
    // "/" menu is the natural place for them.
    send({ type: "commands", id: s.id, list: names, skills: names });
  } catch (err) {
    log("skills/list failed:", err && err.message);
  }
}

function takePrewarmed(cwd) {
  const spare = prewarmed.get(cwd);
  if (!spare) return null;
  prewarmed.delete(cwd);
  if (Date.now() - spare.at > PREWARM_TTL_MS) return null;
  if (byThread.has(spare.threadId)) return null;
  return spare.threadId;
}

let prewarmTimer = null;
function schedulePrewarm(cwd) {
  if (!cwd || prewarmed.has(cwd)) return;
  clearTimeout(prewarmTimer);
  // Opening a thread costs the server several seconds of work. Doing it while
  // the user's own turn is in flight would steal exactly the time we are trying
  // to give back, so it waits for a quiet moment and re-checks when it wakes.
  prewarmTimer = setTimeout(() => {
    if (anyTurnRunning()) return schedulePrewarm(cwd);
    runPrewarm(cwd);
  }, 8000);
  prewarmTimer.unref?.();
}

function anyTurnRunning() {
  for (const s of sessions.values()) if (s.running) return true;
  return false;
}

async function runPrewarm(cwd) {
  if (!CODEX || prewarmed.has(cwd) || anyTurnRunning()) return;
  try {
    await startAppServer();
    const mcp = browserMcpConfig();
    const res = await rpc("thread/start", {
      cwd,
      ...threadProfile("default"),
      model: DEFAULT_MODEL || undefined,
      developerInstructions: BROWSER_HINT,
      config: mcp ? { mcp_servers: mcp } : undefined,
    }, 90000);
    const threadId = res && res.thread && res.thread.id;
    if (threadId) {
      prewarmed.set(cwd, { threadId, at: Date.now() });
      log("prewarmed a thread for", cwd);
    }
  } catch (err) {
    log("prewarm failed:", err && err.message);
  }
}

async function sendPrompt(msg) {
  const s = sessions.get(msg.id);
  if (!s) {
    // No session at all — nothing is coming, so end the turn as well as saying
    // so. An error on its own leaves the panel spinning on a reply that will
    // never arrive.
    send({ type: "error", id: msg.id, message: "This Codex chat has no session. Reopen it to start one." });
    send({ type: "event", id: msg.id, data: { type: "result", subtype: "error_during_execution", is_error: true, result: "No session.", num_turns: 0 } });
    return;
  }
  if (!s.threadId) {
    if (s.opening) {
      s.pending.push(msg);
      log("queued a prompt for", msg.id, "— the thread is still opening");
      return;
    }
    send({ type: "error", id: s.id, message: "This Codex session isn't running." });
    endTurnWith(s, true, "The session isn't running.");
    return;
  }

  const input = [];
  const text = String(msg.text || "");
  if (text) input.push({ type: "text", text });
  for (const img of msg.images || []) {
    if (img && img.path) input.push({ type: "localImage", path: img.path });
    else if (img && img.data) input.push({ type: "image", url: `data:${img.mediaType || "image/png"};base64,${img.data}` });
  }
  if (!input.length) return;

  // A prompt sent while a turn runs is a correction, not a queue entry — Codex
  // can take it mid-flight, which is better than making the user wait.
  if (s.running && s.turnId) {
    try {
      await rpc("turn/steer", { threadId: s.threadId, expectedTurnId: s.turnId, input });
      return;
    } catch (err) {
      log("steer failed, falling back to a new turn:", err && err.message);
    }
  }

  try {
    const res = await rpc("turn/start", {
      threadId: s.threadId,
      input,
      model: s.model || undefined,
      effort: effortForModel(s.model, s.effort) || undefined,
      ...turnProfile(s.mode),
    });
    s.turnId = (res && res.turn && res.turn.id) || null;
    s.running = true;
    touchTurn(s);
  } catch (err) {
    log("turn/start failed:", err && err.message);
    send({ type: "error", id: s.id, message: String(err && err.message) });
    endTurnWith(s, true, String(err && err.message));
  }
}

async function interrupt(msg) {
  const s = sessions.get(msg.id);
  if (!s || !s.threadId) return;
  // `respawn: false`: the thread survives an interrupt, so the panel must not
  // gate events waiting for a restart that will never happen.
  send({ type: "interrupted", id: s.id, respawn: false });
  if (!s.turnId) {
    endTurnWith(s, false, "Stopped.");
    return;
  }
  try {
    await rpc("turn/interrupt", { threadId: s.threadId, turnId: s.turnId }, 15000);
  } catch (err) {
    log("interrupt failed:", err && err.message);
  }
  endTurnWith(s, false, "Stopped.");
}

function closeSession(id, opts) {
  const s = sessions.get(id);
  if (!s) return;
  for (const reqId of s.asks.keys()) {
    send({ type: "permissionCancel", id, requestId: reqId });
    rpcReplyError(reqId, "session closed");
  }
  s.asks.clear();
  if (s.threadId) {
    byThread.delete(s.threadId);
    // Let the server drop its subscription; the thread itself stays on disk so
    // the panel can resume it later.
    rpc("thread/unsubscribe", { threadId: s.threadId }, 8000).catch(() => {});
  }
  sessions.delete(id);
  if (!opts || !opts.quiet) send({ type: "exit", id, code: 0 });
}

async function restartSession(msg) {
  const s = sessions.get(msg.id);
  if (!s) return;
  const resume = s.threadId;
  await startSession({
    type: "start",
    id: msg.id,
    cwd: s.cwd,
    model: msg.model || s.model,
    // `provider` has to be forwarded explicitly: the restart rebuilds the
    // session from scratch, and without it a custom model would quietly fall
    // back to the default endpoint.
    provider: msg.provider || s.provider || undefined,
    effort: msg.effort || s.effort,
    permissionMode: msg.permissionMode || s.mode,
    resume,
  });
}

async function loadTranscript(msg) {
  const threadId = msg.sessionId;
  if (!threadId) return;
  try {
    await startAppServer();
    // The panel asks for the transcript the moment it reconnects, which can land
    // in the same millisecond as a session start that replaces the app-server to
    // pick up a custom provider key. The read then dies with the old process and
    // the tab comes back empty — so a dead server is not a failure here, it is a
    // reason to wait for the new one and ask again.
    let res;
    try {
      res = await rpc("thread/read", { threadId, includeTurns: true }, 60000);
    } catch (err) {
      if (!/app-server exited/i.test((err && err.message) || "")) throw err;
      log("thread/read raced an app-server restart — retrying");
      await startAppServer();
      res = await rpc("thread/read", { threadId, includeTurns: true }, 60000);
    }
    const thread = (res && res.thread) || {};
    const turns = thread.turns || [];
    const s = sessions.get(msg.id) || makeSession(msg.id, msg.cwd);
    const events = [];
    for (const turn of turns) {
      for (const item of turn.items || []) {
        const replay = replayItem(s, item);
        if (replay) events.push(...replay);
      }
    }
    send({ type: "transcript", id: msg.id, events, done: true });
  } catch (err) {
    log("thread/read failed:", err && err.message);
    send({ type: "transcript", id: msg.id, events: [], done: true, error: String(err && err.message) });
  }
}

// A past item, rendered the way a live one would have been. The panel reuses
// its live renderers for history, so history has to look like the real thing.
function replayItem(s, item) {
  switch (item.type) {
    case "userMessage": {
      const text = (item.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (!text) return null;
      return [{ type: "user", message: { role: "user", content: [{ type: "text", text }] } }];
    }
    case "agentMessage":
      if (!item.text) return null;
      return [{
        type: "assistant",
        message: { id: item.id, type: "message", role: "assistant", model: s.model || DEFAULT_MODEL || "codex", content: [{ type: "text", text: item.text }], usage: {} },
      }];
    case "commandExecution": {
      const t = commandTool(item.command || "", item.commandActions);
      return [
        { type: "assistant", message: { id: `codex_tool_${item.id}`, type: "message", role: "assistant", model: s.model || DEFAULT_MODEL || "codex", content: [{ type: "tool_use", id: item.id, name: t.name, input: t.input }], usage: {} } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: item.id, content: item.aggregatedOutput || "", is_error: item.exitCode != null && item.exitCode !== 0 }] } },
      ];
    }
    case "fileChange": {
      const out = [];
      (item.changes || []).forEach((change, i) => {
        const t = fileChangeTool(change);
        const id = `${item.id}#${i}`;
        out.push({ type: "assistant", message: { id: `codex_tool_${id}`, type: "message", role: "assistant", model: s.model || DEFAULT_MODEL || "codex", content: [{ type: "tool_use", id, name: t.name, input: t.input }], usage: {} } });
        out.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Updated ${change.path}`, is_error: false }] } });
      });
      return out;
    }
    default:
      return null;
  }
}

// ---- panel messages ----------------------------------------------------------------

function handle(msg) {
  switch (msg.type) {
    case "start": startSession(msg); break;
    case "prompt": sendPrompt(msg); break;
    case "interrupt": interrupt(msg); break;
    case "stop": closeSession(msg.id, { quiet: false }); break;
    case "close": closeSession(msg.id, { quiet: true }); break;
    case "restartSession": restartSession(msg); break;
    case "loadTranscript": loadTranscript(msg); break;
    case "permissionResult": answerPermission(msg); break;
    case "browserResult": resolveBrowser(msg); break;
    case "configRead": codexConfigRead(msg.id, msg); break;
    case "configWrite": codexConfigWrite(msg.id, msg); break;
    case "authLogin": startLogin(msg.id); break;
    case "authCancel": cancelLogin(msg.id); break;
    case "prewarm":
      startAppServer().then(() => { if (msg.cwd) runPrewarm(msg.cwd); }).catch((err) => log("prewarm start failed:", err && err.message));
      break;
    case "planUsage":
      refreshPlanUsage();
      break;
    default:
      // Everything the panel sends that isn't ours yet — folder pickers, git,
      // bash mode, config editors. Those live in the claude host today and the
      // panel doesn't route them here; log and ignore rather than fail loudly.
      log("ignoring message type:", msg && msg.type);
      break;
  }
}

async function refreshPlanUsage() {
  try {
    await startAppServer();
    const res = await rpc("account/rateLimits/read", {}, 20000);
    const rl = (res && res.rateLimits) || {};
    const primary = rl.primary || {};
    if (typeof primary.usedPercent !== "number") return;
    send({
      type: "planUsage",
      agent: "codex",
      usedPercent: typeof primary.usedPercent === "number" ? primary.usedPercent : null,
      resetsAt: primary.resetsAt || null,
      windowMins: primary.windowDurationMins || null,
      planType: rl.planType || null,
      reached: rl.rateLimitReachedType || null,
    });
  } catch (err) {
    log("rateLimits/read failed:", err && err.message);
  }
}

// ---- settings config files -------------------------------------------------------
// The Settings modal edits files the browser sandbox can't reach. Codex keeps
// its own set, in its own places, which is the whole reason the modal now has a
// section per agent rather than one list that half-applies to each.
//
//   agents  AGENTS.md          the project memory Codex reads
//   hooks   hooks.json         whole file, not a sub-object like Claude's
//   config  config.toml        everything else, MCP servers included
//
// Writes are confined to folders the user actually opened this run, for the
// same reason the claude host confines its own: a crafted message must not be
// able to drop a hooks file into an arbitrary directory that would then run
// commands the next time someone opened it.

const CODEX_HOME = join(homedir(), ".codex");
const openedCwds = new Set();

function codexConfigResolve(key, scope, cwd) {
  const proj = scope === "project";
  if (proj && !(cwd && existsSync(cwd))) return null;
  switch (key) {
    case "agents":
      return { path: proj ? join(cwd, "AGENTS.md") : join(CODEX_HOME, "AGENTS.md"), kind: "text" };
    case "hooks":
      return { path: proj ? join(cwd, ".codex", "hooks.json") : join(CODEX_HOME, "hooks.json"), kind: "json" };
    case "config":
      // There is no project-level config.toml — Codex reads one, in its home.
      return proj ? null : { path: join(CODEX_HOME, "config.toml"), kind: "text" };
    default:
      return null;
  }
}

function codexConfigCwd(id, msg) {
  const s = sessions.get(id);
  const own = (s && s.cwd) || null;
  if (msg.cwd && openedCwds.has(msg.cwd)) return msg.cwd;
  return own;
}

function codexConfigRead(id, msg) {
  const base = { type: "configRead", id, key: msg.key, scope: msg.scope, agent: "codex" };
  const spec = codexConfigResolve(msg.key, msg.scope, codexConfigCwd(id, msg));
  if (!spec) {
    const why = msg.key === "config" ? "Codex keeps one config.toml, in its own folder." : "No project folder selected.";
    send({ ...base, ok: false, error: why });
    return;
  }
  const exists = existsSync(spec.path);
  try {
    let content = "";
    if (exists) {
      content = readFileSync(spec.path, "utf8");
      if (spec.kind === "json") {
        // Round-trip it so a hand-edited file comes back tidy, but never lose
        // the original if it doesn't parse — showing the raw text is far more
        // use than an error when the whole point is to go and fix it.
        try { content = JSON.stringify(JSON.parse(content || "{}"), null, 2); } catch { /* keep the raw text */ }
      }
    } else if (spec.kind === "json") {
      content = "{}";
    }
    send({ ...base, ok: true, content, path: spec.path, exists });
  } catch (err) {
    send({ ...base, ok: false, path: spec.path, exists, error: "Couldn't read this file: " + (err && err.message) });
  }
}

function codexConfigWrite(id, msg) {
  const base = { type: "configWrite", id, key: msg.key, scope: msg.scope, agent: "codex" };
  const spec = codexConfigResolve(msg.key, msg.scope, codexConfigCwd(id, msg));
  if (!spec) { send({ ...base, ok: false, error: "No project folder selected." }); return; }
  const raw = String(msg.content == null ? "" : msg.content);
  if (spec.kind === "json") {
    try { JSON.parse(raw || "{}"); } catch (err) {
      send({ ...base, ok: false, path: spec.path, error: "That isn't valid JSON: " + (err && err.message) });
      return;
    }
  }
  try {
    mkdirSync(dirname(spec.path), { recursive: true });
    // Keep the last good copy next to the file, the way the claude host does —
    // a config editor with no undo is a config editor people stop trusting.
    if (existsSync(spec.path)) {
      try { copyFileSync(spec.path, spec.path + ".bak"); } catch { /* best-effort */ }
    }
    const tmp = spec.path + ".tmp";
    writeFileSync(tmp, raw, "utf8");
    renameSync(tmp, spec.path);
    send({ ...base, ok: true, path: spec.path });
  } catch (err) {
    send({ ...base, ok: false, path: spec.path, error: "Couldn't save: " + (err && err.message) });
  }
}

// ---- sign-in ---------------------------------------------------------------------
// The panel's `/login` flow, answered by Codex's own OAuth rather than Claude's.
// Same two messages back either way, so the panel's card doesn't care which
// agent it is talking to.

let loginId = null;

async function startLogin(id) {
  try {
    await startAppServer();
    const res = await rpc("account/login/start", { type: "chatgpt", codexStreamlinedLogin: true, useHostedLoginSuccessPage: true }, 30000);
    if (res && res.type === "chatgpt" && res.authUrl) {
      loginId = res.loginId || null;
      send({ type: "authUrl", id, url: res.authUrl });
      return;
    }
    if (res && res.type === "chatgptDeviceCode") {
      loginId = res.loginId || null;
      send({ type: "authUrl", id, url: res.verificationUrl, code: res.userCode });
      return;
    }
    // An API-key login needs nothing from the browser.
    send({ type: "authDone", id, ok: true, message: "" });
  } catch (err) {
    send({ type: "authDone", id, ok: false, message: `Couldn't start sign-in: ${err && err.message}` });
  }
}

async function cancelLogin(id) {
  if (!loginId) {
    send({ type: "authDone", id, ok: false, message: "No sign-in is in progress." });
    return;
  }
  try {
    await rpc("account/login/cancel", { loginId }, 15000);
  } catch (err) {
    log("login cancel failed:", err && err.message);
  }
  loginId = null;
  send({ type: "authDone", id, ok: false, message: "Sign-in cancelled." });
}

// ---- lifecycle -------------------------------------------------------------------

function shutdown(code) {
  try { if (app.proc) app.proc.kill("SIGTERM"); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 120).unref();
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

const feed = frameReader(
  (raw, text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    log("recv", msg && msg.type);
    handle(msg);
  },
  (len) => {
    log("framing desync: header claims " + len + " bytes — shutting down");
    shutdown(1);
  }
);
process.stdin.on("data", feed);
process.stdin.on("end", () => { log("stdin end — shutting down"); shutdown(0); });

log("codex host v" + CODEX_HOST_VERSION + " starting, codex=" + (CODEX || "(not found)"));
announce();

export { CODEX_BID_BASE };
