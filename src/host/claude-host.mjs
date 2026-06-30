#!/usr/bin/env node
// Native-messaging host for the Lizard Studio "Claude Code chat" side panel.
//
// It bridges the Chrome side panel and the real `claude` CLI. The panel speaks
// Chrome native messaging (4-byte little-endian length prefix + JSON body) over
// this process's stdin/stdout. We spawn `claude` in headless stream-json mode
// (`claude -p --input-format stream-json --output-format stream-json`), keep it
// alive across turns, and relay every line it emits back to the panel verbatim
// (including the incremental `stream_event` objects from --include-partial-messages).
//
// 100% local: no network of our own, no deps. `claude` does the real work in the
// chosen working directory — real tools, real edits, real shell.
//
// Every message carries an `id` naming the chat tab it belongs to, so the host
// can run one independent `claude` process per tab and the panel can route each
// stream back to the right conversation.
//
// Protocol — panel -> host:
//   { type:"start",   id, cwd, model?, permissionMode?, resume? }  spawn (or respawn) claude
//   { type:"prompt",  id, text, images? }                          send one user turn (images: [{mediaType,data}])
//   { type:"interrupt", id }                                       cancel the current turn
//   { type:"stop",    id }                                         kill the claude process
//   { type:"close",   id }                                         kill + forget the session
//   { type:"setMode", id, permissionMode }                         restart, resuming the session
//   { type:"setModel", id, model }                                 restart, resuming the session
//   { type:"loadTranscript", id, sessionId, cwd }                  replay a past session's messages
//   { type:"pickFolder", id }                                      native folder chooser
//   { type:"gitBranches", id, cwd }                                list local branches + current
//   { type:"checkoutBranch", id, cwd, branch }                     git checkout <branch>
//   { type:"browserResult", bid, ok, data?, error? }              reply to a `browser` request
//
// Protocol — host -> panel:
//   { type:"ready",   home, claudePath, ok }                   sent once on connect (no id)
//   { type:"started", id, pid, cwd, model, permissionMode }
//   { type:"event",   id, data }                               one claude stream-json object
//   { type:"exit",    id, code }
//   { type:"folder",  id, path }                               null path == cancelled
//   { type:"gitBranches", id, cwd, isRepo, current, branches, checkedOut? }
//   { type:"transcript", id, events, done }                    a chunk of replayed past messages
//   { type:"browser", bid, op, args }                          ask the panel to inspect the live tab
//   { type:"error",   id, message }

import { spawn, execFile, execSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
// Sibling MCP relay that exposes the browser tools to claude (see mcp-browser.mjs).
const MCP_RELAY = join(HERE, "mcp-browser.mjs");

// Append-only debug log so we can see what Chrome's launch actually does (its
// environment differs from a shell's and is hard to reproduce). Tail src/host/host.log.
const LOG_FILE = join(HERE, "host.log");
function log(...args) {
  try {
    appendFileSync(LOG_FILE, new Date().toISOString() + " " + args.join(" ") + "\n");
  } catch {
    /* logging must never break the host */
  }
}

// Never let an unexpected throw take the whole host down — that surfaces in the
// panel as "Native host has exited". Log it and keep running.
process.on("uncaughtException", (err) => {
  log("UNCAUGHT", err && (err.stack || err.message));
  try {
    send({ type: "error", message: "Host error: " + (err && err.message) });
  } catch {
    /* ignore */
  }
});
process.on("unhandledRejection", (reason) => {
  log("UNHANDLED_REJECTION", String(reason));
});

log("=== host starting ===", "node", process.version, "argv", JSON.stringify(process.argv.slice(2)));

// install.sh writes resolved binary paths here, since Chrome launches native
// hosts with a minimal PATH that usually misses /opt/homebrew, nvm, etc.
function loadConfig() {
  const p = join(HERE, "host-config.json");
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* fall through to discovery */
    }
  }
  return {};
}
const CONFIG = loadConfig();

// Capture the user's real login-shell environment. Chrome launches native hosts
// with a minimal PATH (no homebrew / nvm / asdf), so `claude` and the tools it
// shells out to (git, rg, node) can be missing. Spawning an interactive login
// shell and reading its `env` recovers the full PATH the user actually has.
// (Technique adapted from 21st-dev/1Code, Apache-2.0, and the `shell-env` pkg.)
function getShellEnv() {
  if (process.platform === "win32") return { ...process.env };
  const DELIM = "__RK_ENV__";
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const out = execSync(`${shell} -ilc 'echo -n "${DELIM}"; env; echo -n "${DELIM}"; exit'`, {
      encoding: "utf8",
      timeout: 5000,
      env: { HOME: homedir(), USER: userInfo().username, SHELL: shell, DISABLE_AUTO_UPDATE: "true" },
    });
    const section = out.split(DELIM)[1] || "";
    const env = {};
    for (const line of section.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
    }
    return Object.keys(env).length ? env : { ...process.env };
  } catch {
    return { ...process.env };
  }
}

// Merge captured shell env over the process env, keeping the richer PATH, and
// fill in the essentials claude expects.
function buildChildEnv() {
  const shellEnv = getShellEnv();
  const env = { ...process.env, ...shellEnv };
  if (shellEnv.PATH) env.PATH = shellEnv.PATH;
  // Make sure our known good locations are always reachable too.
  env.PATH = [env.PATH || "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", join(homedir(), ".local/bin")]
    .filter(Boolean)
    .join(":");
  if (!env.HOME) env.HOME = homedir();
  if (!env.TERM) env.TERM = "xterm-256color";
  if (!env.SHELL) env.SHELL = process.env.SHELL || "/bin/zsh";
  env.CLAUDE_CODE_ENTRYPOINT = "lizard-chat";
  return env;
}
const CHILD_ENV = buildChildEnv();
log("env built", "PATH=", (CHILD_ENV.PATH || "").slice(0, 200), "HOME=", CHILD_ENV.HOME, "SHELL=", CHILD_ENV.SHELL);

// Resolve the claude binary: config first, then the captured PATH, then well-known spots.
function resolveClaude() {
  if (CONFIG.claudePath && existsSync(CONFIG.claudePath)) return CONFIG.claudePath;
  try {
    const found = execSync("command -v claude", { encoding: "utf8", env: CHILD_ENV }).trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* not on PATH — fall through */
  }
  const home = homedir();
  for (const c of [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".local/bin/claude"),
    join(home, ".claude/local/claude"),
    "/usr/bin/claude",
  ]) {
    if (existsSync(c)) return c;
  }
  return "claude"; // last resort: hope it's on PATH
}
const CLAUDE = resolveClaude();
log("claude resolved to", CLAUDE, "exists=", existsSync(CLAUDE));

// The node that runs this host also runs the MCP relay we hand to claude.
const NODE = (CONFIG.nodePath && existsSync(CONFIG.nodePath)) ? CONFIG.nodePath : process.execPath;

// ---- browser bridge (claude MCP relay <-> the extension) -------------------
// The MCP relay (mcp-browser.mjs) connects here over TCP; we forward each tool
// call to the extension as a `browser` native message and resolve it when the
// panel sends back a `browserResult`. This is how claude reaches the live tab.
let bridgePort = 0;
const browserPending = new Map(); // bid -> { resolve, timer }
let nextBid = 1;

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
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const reqId = m.reqId;
      browserRequest(m.op, m.args).then((r) => {
        try {
          sock.write(JSON.stringify({ reqId, ...r }) + "\n");
        } catch {
          /* relay went away */
        }
      });
    }
  });
  sock.on("error", () => {});
});
bridgeServer.on("error", (err) => log("bridge server error", err && err.message));
bridgeServer.listen(0, "127.0.0.1", () => {
  bridgePort = bridgeServer.address().port;
  log("browser bridge listening on 127.0.0.1:" + bridgePort);
});

function browserRequest(op, args) {
  return new Promise((resolve) => {
    const bid = nextBid++;
    const timer = setTimeout(() => {
      if (browserPending.has(bid)) {
        browserPending.delete(bid);
        resolve({ ok: false, error: "extension did not respond (is the Lizard side panel open?)" });
      }
    }, 30000);
    browserPending.set(bid, { resolve, timer });
    send({ type: "browser", bid, op, args });
  });
}

function resolveBrowser(msg) {
  const p = browserPending.get(msg.bid);
  if (!p) return;
  clearTimeout(p.timer);
  browserPending.delete(msg.bid);
  p.resolve({ ok: msg.ok !== false, data: msg.data, error: msg.error });
}

// Appended to claude's system prompt so it knows the live-tab tools exist.
const BROWSER_HINT =
  "You have a set of browser_* tools (MCP server `browser`) that inspect AND control the user's CURRENTLY ACTIVE Chrome tab in real time. " +
  "Read/observe: browser_info (url/title/selection), browser_dom (visible text or HTML), browser_snapshot (accessibility tree with stable @refs — the best way to understand the page before acting), " +
  "browser_eval (run JS and read anything — DOM, app state, localStorage, fetch), browser_console (recent logs + exceptions), browser_network (recent requests), browser_screenshot. " +
  "Act: browser_click, browser_type, browser_fill, browser_key, browser_navigate. " +
  "Prefer browser_snapshot to get @refs, then target clicks/typing by ref rather than guessing selectors. " +
  "When the user refers to \"this page\", \"the open tab\", what they're \"looking at\", or asks you to debug or drive a live site, USE THESE TOOLS instead of guessing. " +
  "Console and network capture begin when you first call those tools, so if they're empty, ask the user to reload the page or re-trigger the action, then call again.";

// ---- Chrome native-messaging framing ---------------------------------------
// Read loop: a 4-byte uint32 LE length, then that many bytes of UTF-8 JSON.
let inbuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  for (;;) {
    if (inbuf.length < 4) return;
    const len = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + len) return;
    const body = inbuf.subarray(4, 4 + len);
    inbuf = inbuf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body.toString("utf8"));
    } catch {
      continue;
    }
    log("recv", msg && msg.type);
    handle(msg);
  }
});
process.stdin.on("end", () => {
  log("stdin end — shutting down");
  shutdown(0);
});

// Chrome caps a single native message at 1 MB. Keep us safely under it; oversized
// payloads (e.g. a huge file Read) get their long string fields truncated.
const MAX_MSG = 900 * 1024;
function send(obj) {
  let json = JSON.stringify(obj);
  if (Buffer.byteLength(json) > MAX_MSG) {
    json = JSON.stringify(truncateDeep(obj));
    if (Buffer.byteLength(json) > MAX_MSG) {
      json = JSON.stringify({ type: "error", message: "[message too large to display]" });
    }
  }
  const body = Buffer.from(json, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  try {
    process.stdout.write(Buffer.concat([header, body]));
  } catch {
    /* stdout closed — panel went away */
  }
}

function truncateDeep(value, budget = 60000) {
  if (typeof value === "string") {
    return value.length > budget
      ? value.slice(0, budget) + `\n…[truncated ${value.length - budget} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, budget));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = truncateDeep(value[k], budget);
    return out;
  }
  return value;
}

// ---- claude process management (multi-session) ------------------------------
// Every chat tab in the panel maps to one independent `claude` process, keyed by
// a panel-supplied `id`. Each session tracks its own cwd / model / mode and its
// resumable sessionId. Every host->panel message is tagged with the id so the
// panel can route the stream back to the right tab.
const sessions = new Map(); // id -> { id, child, cwd, model, mode, sessionId, stdoutBuf, stderrBuf }

function startClaude({ id, cwd, model, permissionMode, resume }) {
  id = id || "default";
  killSession(id);

  const s = {
    id,
    child: null,
    cwd: cwd && existsSync(cwd) ? cwd : homedir(),
    model: model || null,
    mode: permissionMode || "default",
    sessionId: resume || null,
    stdoutBuf: "",
    stderrBuf: "",
  };

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    // Emit incremental `stream_event` objects (message_start / content_block_delta
    // / …) so the panel can render assistant text and thinking token-by-token
    // instead of waiting for the whole message. The final `assistant` message
    // still arrives afterwards as the canonical copy.
    "--include-partial-messages",
    "--verbose",
    "--permission-mode", s.mode,
  ];
  if (s.model) args.push("--model", s.model);
  if (resume) args.push("--resume", resume);

  // Register the browser MCP server so claude can inspect the live tab. The
  // read-only tools are pre-allowed; browser_eval still goes through the normal
  // permission flow since it can run arbitrary JS.
  if (bridgePort && existsSync(MCP_RELAY)) {
    const mcp = JSON.stringify({
      mcpServers: {
        browser: { command: NODE, args: [MCP_RELAY], env: { RK_BRIDGE_PORT: String(bridgePort), RK_BRIDGE_SESSION: id } },
      },
    });
    args.push("--mcp-config", mcp);
    args.push(
      "--allowedTools",
      "mcp__browser__browser_info,mcp__browser__browser_dom,mcp__browser__browser_console,mcp__browser__browser_network,mcp__browser__browser_screenshot,mcp__browser__browser_snapshot"
    );
    args.push("--append-system-prompt", BROWSER_HINT);
  }

  log("spawning", CLAUDE, args.join(" "), "cwd=", s.cwd, "id=", id);
  let proc;
  try {
    proc = spawn(CLAUDE, args, {
      cwd: s.cwd,
      env: CHILD_ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    log("spawn threw", err.message);
    send({ type: "error", id, message: `Failed to start claude: ${err.message}` });
    return;
  }
  s.child = proc;
  sessions.set(id, s);

  send({ type: "started", id, pid: proc.pid, cwd: s.cwd, model: s.model, permissionMode: s.mode });
  ensureCommands(id, s.cwd, s.model);

  proc.stdout.on("data", (chunk) => {
    s.stdoutBuf += chunk.toString("utf8");
    let nl;
    while ((nl = s.stdoutBuf.indexOf("\n")) >= 0) {
      const line = s.stdoutBuf.slice(0, nl);
      s.stdoutBuf = s.stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // not JSON (shouldn't happen in stream-json) — skip
      }
      if (obj.type === "system" && obj.subtype === "init" && obj.session_id) {
        s.sessionId = obj.session_id;
      }
      send({ type: "event", id, data: obj });
    }
  });

  proc.stderr.on("data", (chunk) => {
    s.stderrBuf += chunk.toString("utf8");
    if (s.stderrBuf.length > 4000) s.stderrBuf = s.stderrBuf.slice(-4000);
  });

  proc.on("exit", (code) => {
    // Only drop the session if this is still the live process — a restart may
    // already have replaced it with a newer spawn under the same id.
    if (sessions.get(id) === s) sessions.delete(id);
    // A SIGTERM we issued ourselves (folder/model/mode change, close, shutdown)
    // is an expected restart, not a crash — stay quiet.
    if (proc._intentional) {
      log("claude exited (intentional) id=", id, "code=", code);
      return;
    }
    log("claude exited id=", id, "code=", code, "stderr=", s.stderrBuf.trim().slice(0, 500));
    if (s.stderrBuf.trim()) send({ type: "error", id, message: s.stderrBuf.trim() });
    send({ type: "exit", id, code: code == null ? -1 : code });
  });
  proc.on("error", (err) => {
    if (sessions.get(id) === s) sessions.delete(id);
    if (proc._intentional) return;
    log("claude spawn error id=", id, err.message);
    send({ type: "error", id, message: `claude process error: ${err.message}` });
  });
}

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.child) {
    s.child._intentional = true;
    try {
      s.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  sessions.delete(id);
}

function killAll() {
  for (const id of [...sessions.keys()]) killSession(id);
}

// ---- slash-command discovery ------------------------------------------------
// claude only emits its `slash_commands` list (in the system/init event) once it
// receives the first user message — so a brand-new chat has no list to show. We
// harvest it up front with a throwaway claude that we kill the instant init
// arrives (before the model is ever queried, so it costs nothing). Cached per
// cwd, since the command set is determined by the working directory.
const commandCache = new Map(); // cwd -> string[]

function ensureCommands(id, cwd, model) {
  cwd = cwd || homedir();
  if (commandCache.has(cwd)) {
    send({ type: "commands", id, list: commandCache.get(cwd) });
    return;
  }
  harvestCommands(id, cwd, model);
}

function harvestCommands(id, cwd, model) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"];
  if (model) args.push("--model", model);
  let proc;
  try {
    proc = spawn(CLAUDE, args, { cwd, env: CHILD_ENV, stdio: ["pipe", "pipe", "ignore"] });
  } catch (err) {
    log("harvest spawn failed", err.message);
    return;
  }
  let buf = "";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };
  const timer = setTimeout(finish, 9000);
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === "system" && o.subtype === "init" && Array.isArray(o.slash_commands)) {
        commandCache.set(cwd, o.slash_commands);
        send({ type: "commands", id, list: o.slash_commands });
        log("harvested", o.slash_commands.length, "commands for", cwd);
        finish();
        return;
      }
    }
  });
  proc.on("error", (err) => {
    log("harvest error", err.message);
    finish();
  });
  proc.on("exit", () => clearTimeout(timer));
  // Send a trivial message to make claude emit init; we kill on init, above.
  try {
    proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }) + "\n");
  } catch {
    /* ignore */
  }
}

// Write one stream-json line to a session's claude stdin.
function writeToChild(id, obj) {
  const s = sessions.get(id);
  if (!s || !s.child || !s.child.stdin.writable) {
    send({ type: "error", id, message: "No active Claude session. Start one first." });
    return false;
  }
  s.child.stdin.write(JSON.stringify(obj) + "\n");
  return true;
}

function sendPrompt(id, text, images) {
  const content = [];
  // Images first (Anthropic's recommended ordering), then the text.
  if (Array.isArray(images)) {
    for (const im of images) {
      if (im && im.data) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: im.mediaType || "image/png", data: im.data },
        });
      }
    }
  }
  const t = String(text ?? "");
  if (t.trim() || !content.length) content.push({ type: "text", text: t });
  writeToChild(id, { type: "user", message: { role: "user", content } });
}

function interrupt(id) {
  // The stream-json control channel cancels the in-flight turn without losing
  // the session (matches the SDK's query.interrupt()).
  writeToChild(id, { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
}

// ---- native folder chooser --------------------------------------------------
// The response carries the requesting tab's id so the panel routes it correctly.
function pickFolder(id) {
  if (process.platform === "darwin") {
    const script =
      'POSIX path of (choose folder with prompt "Choose a project folder for Claude Code")';
    execFile("/usr/bin/osascript", ["-e", script], (err, stdout) => {
      if (err) {
        send({ type: "folder", id, path: null }); // user cancelled or no GUI
        return;
      }
      send({ type: "folder", id, path: stdout.trim().replace(/\/$/, "") });
    });
    return;
  }
  // Linux: try zenity, then kdialog. No GUI tool -> tell the panel to ask for a path.
  execFile("zenity", ["--file-selection", "--directory"], (err, stdout) => {
    if (!err) return send({ type: "folder", id, path: stdout.trim() });
    execFile("kdialog", ["--getexistingdirectory", homedir()], (err2, out2) => {
      if (!err2) return send({ type: "folder", id, path: out2.trim() });
      send({ type: "folder", id, path: null, manual: true });
    });
  });
}

// ---- git branch helpers -----------------------------------------------------
// List local branches + the current one for a working dir, so the panel can show
// a branch chip and let the user switch. Read-only.
function gitBranches(id, cwd, extra = {}) {
  const dir = cwd && existsSync(cwd) ? cwd : homedir();
  execFile("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { env: CHILD_ENV }, (err, cur) => {
    if (err) {
      send({ type: "gitBranches", id, cwd: dir, isRepo: false, current: null, branches: [] });
      return;
    }
    execFile(
      "git",
      ["-C", dir, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
      { env: CHILD_ENV },
      (e2, out) => {
        const branches = String(out || "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        send({ type: "gitBranches", id, cwd: dir, isRepo: true, current: cur.trim(), branches, ...extra });
      }
    );
  });
}

function checkoutBranch(id, cwd, branch) {
  const dir = cwd && existsSync(cwd) ? cwd : homedir();
  if (!branch) return;
  execFile("git", ["-C", dir, "checkout", branch], { env: CHILD_ENV }, (err, _out, stderr) => {
    if (err) {
      send({ type: "error", id, message: `git checkout failed: ${(stderr || err.message || "").trim()}` });
      gitBranches(id, dir); // resync the chip to whatever branch we're actually on
      return;
    }
    gitBranches(id, dir, { checkedOut: true });
  });
}

// ---- transcript replay ------------------------------------------------------
// The panel only keeps a conversation in the page DOM — reloading the side panel
// wipes it. But `claude` persists every session as a JSONL transcript under
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. Given a stored sessionId we
// find that file, parse the user/assistant turns, and stream them back so the
// panel can re-render the history exactly as it looked.
function findTranscript(sessionId, cwd) {
  if (!sessionId) return null;
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  // Fast path: claude encodes the project dir by replacing every non-alphanumeric
  // char in the absolute cwd with "-" (e.g. /Users/me/app -> -Users-me-app).
  if (cwd) {
    const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const direct = join(root, enc, sessionId + ".jsonl");
    if (existsSync(direct)) return direct;
  }
  // Fallback: sessionIds are unique UUIDs, so scan every project dir for the file.
  try {
    for (const dir of readdirSync(root)) {
      const p = join(root, dir, sessionId + ".jsonl");
      if (existsSync(p)) return p;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function loadTranscript(id, sessionId, cwd) {
  const file = findTranscript(sessionId, cwd);
  if (!file) {
    send({ type: "transcript", id, events: [], done: true, missing: true });
    return;
  }
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    log("transcript read failed", err.message);
    send({ type: "transcript", id, events: [], done: true });
    return;
  }
  // Batch events under Chrome's native-message size cap (send() truncates over it).
  let batch = [];
  let size = 0;
  const flush = (done) => {
    if (!batch.length && !done) return;
    send({ type: "transcript", id, events: batch, done });
    batch = [];
    size = 0;
  };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    // Keep only the visible conversation: real user/assistant turns. Skip
    // sub-agent sidechains and injected meta (system reminders, hooks).
    if (o.isSidechain || o.isMeta) continue;
    if ((o.type !== "user" && o.type !== "assistant") || !o.message) continue;
    const ev = { type: o.type, message: o.message };
    const s = JSON.stringify(ev).length;
    if (size + s > 700000) flush(false);
    batch.push(ev);
    size += s;
  }
  flush(true);
  log("transcript replayed", file, "→ id", id);
}

// ---- message dispatch -------------------------------------------------------
function handle(msg) {
  if (!msg) return;
  const id = msg.id || "default";
  switch (msg.type) {
    case "start":
      startClaude(msg);
      break;
    case "prompt":
      sendPrompt(id, msg.text, msg.images);
      break;
    case "interrupt":
      interrupt(id);
      break;
    case "stop":
    case "close":
      killSession(id);
      break;
    case "setMode": {
      const s = sessions.get(id);
      startClaude({ id, cwd: s && s.cwd, model: s && s.model, permissionMode: msg.permissionMode, resume: s && s.sessionId });
      break;
    }
    case "setModel": {
      const s = sessions.get(id);
      startClaude({ id, cwd: s && s.cwd, model: msg.model, permissionMode: s && s.mode, resume: s && s.sessionId });
      break;
    }
    case "loadTranscript":
      loadTranscript(id, msg.sessionId, msg.cwd);
      break;
    case "pickFolder":
      pickFolder(id);
      break;
    case "gitBranches":
      gitBranches(id, msg.cwd);
      break;
    case "checkoutBranch":
      checkoutBranch(id, msg.cwd, msg.branch);
      break;
    case "browserResult":
      resolveBrowser(msg);
      break;
    default:
      // Unknown type — most likely a newer panel talking to an older host. Log
      // it, but don't surface a scary warning in the chat: forward-compat
      // messages (e.g. a feature the host doesn't know yet) should fail quietly.
      log("ignoring unknown message type:", msg && msg.type);
  }
}

function shutdown(code) {
  killAll();
  process.exit(code);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

// Announce ourselves so the panel can leave its onboarding screen.
send({ type: "ready", home: homedir(), claudePath: CLAUDE, ok: existsSync(CLAUDE) || CLAUDE === "claude" });
