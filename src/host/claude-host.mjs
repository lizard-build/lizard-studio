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
//   { type:"start",   id, cwd, model?, effort?, permissionMode?, resume? }  spawn (or respawn) claude
//   { type:"prompt",  id, text, images? }                          send one user turn (images: [{mediaType,data}])
//   { type:"interrupt", id }                                       hard-stop: kill + resume the session
//   { type:"stop",    id }                                         kill the claude process
//   { type:"close",   id }                                         kill + forget the session
//   { type:"restartSession", id, model, effort, permissionMode }   restart with the given trio, resuming
//                                                                 the session (mode/model/effort switches —
//                                                                 the panel defers sending this until any
//                                                                 in-flight turn finishes, so it never
//                                                                 hard-kills a reply that's still streaming)
//   { type:"loadTranscript", id, sessionId, cwd }                  replay a past session's messages
//   { type:"rewind", id, turnIndex }                                truncate the transcript back to
//                                                                 just before the turnIndex-th human
//                                                                 turn, then kill + resume the session
//   { type:"pickFolder", id }                                      native folder chooser
//   { type:"gitBranches", id, cwd }                                list local branches + current
//   { type:"checkoutBranch", id, cwd, branch }                     git checkout <branch>
//   { type:"browserResult", bid, ok, data?, error? }              reply to a `browser` request
//   { type:"permissionResult", id, requestId, behavior,           answer a `permission` ask:
//     message?, updatedPermissions?, interrupt?,                  behavior "allow" | "deny"
//     updatedInput? }                                             merged over the original input
//                                                                 (AskUserQuestion answers)
//
// Protocol — host -> panel:
//   { type:"ready",   version, home, claudePath, ok }          sent once on connect (no id)
//   { type:"started", id, pid, cwd, model, effort, permissionMode }
//   { type:"interrupted", id }                                 the turn was hard-stopped; a respawn follows
//   { type:"event",   id, data }                               one claude stream-json object
//   { type:"exit",    id, code }
//   { type:"folder",  id, path }                               null path == cancelled
//   { type:"gitBranches", id, cwd, isRepo, current, branches, checkedOut? }
//   { type:"transcript", id, events, done }                    a chunk of replayed past messages
//   { type:"browser", bid, op, args }                          ask the panel to inspect the live tab
//   { type:"permission", id, requestId, toolName, input,       claude wants to use a tool — ask the user
//     suggestions }                                            (answered with `permissionResult`)
//   { type:"permissionCancel", id, requestId }                 claude no longer needs that answer
//   { type:"error",   id, message }

import { spawn, execFile, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, statSync, createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, userInfo } from "node:os";
import net from "node:net";
import https from "node:https";
import readline from "node:readline";

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
// panel as "Native host has exited". Log it and keep running. (But don't try to
// report over a dead stdout — that's how an EPIPE would loop back here.)
process.on("uncaughtException", (err) => {
  log("UNCAUGHT", err && (err.stack || err.message));
  if (process.stdout.destroyed) return;
  try {
    send({ type: "error", message: "Host error: " + (err && err.message) });
  } catch {
    /* ignore */
  }
});
process.on("unhandledRejection", (reason) => {
  log("UNHANDLED_REJECTION", String(reason));
});

// EPIPE arrives as an async 'error' event on the stream — the try/catch around
// stdout.write in send() never sees it. Chrome closing the pipe means the panel
// is gone: shut down instead of letting spawned children stream into a dead fd.
process.stdout.on("error", () => {
  log("stdout error — panel gone, shutting down");
  shutdown(0);
});

// Incremental NDJSON reader shared by the bridge socket, claude stdout and the
// command harvest: feed(chunk) buffers, splits on newlines, JSON.parses every
// non-empty line and hands it to onMsg (unparsable lines are skipped). maxBuf
// caps a single pathological line so it can't grow without bound.
function lineJsonReader(onMsg, maxBuf = 32 * 1024 * 1024) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    if (buf.length > maxBuf) {
      log("lineJsonReader: dropping oversized line buffer (" + buf.length + " chars)");
      buf = "";
      return;
    }
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      onMsg(obj);
    }
  };
}

// Host protocol version, reported to the panel in the `ready` message. The
// panel compares it against the version it expects; when the runtime copy in
// ~/.lizard-studio is stale it first asks us to update ourselves (see
// selfUpdate below) and only falls back to the manual install.sh command if
// that op isn't answered (hosts older than v4).
// Bump this on EVERY host change the extension needs to know about.
const HOST_VERSION = 10;

log("=== host starting ===", "node", process.version, "argv", JSON.stringify(process.argv.slice(2)));

// ---- bundled "lizard" skill ---------------------------------------------------
// Ships the lizard-build/skill bootstrap skill to every spawned claude via
// --plugin-dir — ephemeral, per-process, never touches the user's own
// ~/.claude/skills. install.sh seeds this dir with a copy at install time (so it
// works offline / on first run); in the background we refresh it straight from
// GitHub so users get upstream updates without reinstalling the host. Fetches
// are throttled and never block a claude spawn — spawning always uses whatever
// is on disk right now.
const SKILL_DIR = join(HERE, "skills", "lizard");
const SKILL_MARKER = join(SKILL_DIR, "SKILL.md");
const SKILL_FILES = ["SKILL.md", "README.md", "skills.sh.json"];
const SKILL_RAW_BASE = "https://raw.githubusercontent.com/lizard-build/skill/main";
const SKILL_REFRESH_TTL_MS = 12 * 60 * 60 * 1000; // 12h — upstream is a thin, rarely-changing bootstrap

function fetchText(url, redirects = 1) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "lizard-studio-host" }, timeout: 10000 }, (res) => {
      // Follow a single redirect — raw.githubusercontent can 301 and a silent
      // failure here would break self-update with no signal to the panel.
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode + " for " + url));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    // Without this a network blackhole leaves the promise pending forever —
    // and with it the panel's whole stale-host recovery flow.
    req.on("timeout", () => req.destroy(new Error("timeout fetching " + url)));
    req.on("error", reject);
  });
}

async function refreshBundledSkill() {
  try {
    if (existsSync(SKILL_MARKER) && Date.now() - statSync(SKILL_MARKER).mtimeMs < SKILL_REFRESH_TTL_MS) {
      return; // refreshed recently enough — skip the network round-trip
    }
    mkdirSync(SKILL_DIR, { recursive: true });
    for (const name of SKILL_FILES) {
      const text = await fetchText(`${SKILL_RAW_BASE}/${name}`);
      const tmp = join(SKILL_DIR, name + ".tmp");
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, join(SKILL_DIR, name)); // atomic swap — never leaves a half-written file
    }
    log("skill: refreshed lizard-build/skill from upstream");
  } catch (err) {
    // Offline, GitHub unreachable, rate-limited, etc. — keep whatever's already
    // on disk (the bundled fallback from install.sh, or the last good fetch).
    log("skill: refresh skipped —", err && err.message);
  }
}
// Fire-and-forget at startup; every claude spawn below just reads SKILL_DIR
// synchronously off disk, so this never adds latency to a chat turn.
refreshBundledSkill();

// ---- host self-update -------------------------------------------------------
// The extension updates via git/store, but this runtime copy only via
// install.sh — so when the panel sees a stale HOST_VERSION it sends
// `selfUpdate` and we refresh ourselves the same way the bundled skill does:
// fetch from GitHub raw, atomic-swap on disk, then exit so Chrome relaunches
// the new copy when the panel reconnects. host-config.json / launch.sh /
// the browser manifests are machine-specific and never touched.
const HOST_RAW_BASE = "https://raw.githubusercontent.com/lizard-build/lizard-studio/main/src/host";
const HOST_FILES = ["claude-host.mjs", "mcp-browser.mjs"];

async function selfUpdate(id) {
  try {
    // Fetch everything before swapping anything, so the pair can't end up
    // mismatched when the second request fails.
    const fetched = [];
    for (const name of HOST_FILES) {
      fetched.push([name, await fetchText(`${HOST_RAW_BASE}/${name}`)]);
    }
    let changed = false;
    for (const [name, text] of fetched) {
      const dest = join(HERE, name);
      if (existsSync(dest) && readFileSync(dest, "utf8") === text) continue;
      const tmp = dest + ".tmp";
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, dest);
      changed = true;
    }
    send({ type: "selfUpdate", id, updated: changed, restarting: changed });
    log("selfUpdate:", changed ? "updated — restarting" : "already up to date");
    if (changed) {
      // Give the reply a beat to flush through stdout, then exit; the panel's
      // reconnect relaunches the freshly written host.
      setTimeout(() => shutdown(0), 150);
    }
  } catch (err) {
    log("selfUpdate failed:", err && err.message);
    send({ type: "selfUpdate", id, updated: false, error: String((err && err.message) || err) });
  }
}

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
//
// That shell can take seconds with a heavy .zshrc (nvm, compinit), and it used
// to run synchronously on EVERY host start, delaying the panel's `ready`. The
// result is now cached on disk: startup reads the cache instantly and, when
// it's aging, refreshes it in the background for the next launch — only the
// very first run still pays for the blocking capture.
const ENV_DELIM = "__RK_ENV__";
const ENV_SCRIPT = `echo -n "${ENV_DELIM}"; env; echo -n "${ENV_DELIM}"; exit`;
const SHELL_ENV_CACHE = join(HERE, "shell-env.json");
const SHELL_ENV_TTL_MS = 24 * 60 * 60 * 1000; // hard expiry — recapture synchronously
const SHELL_ENV_REFRESH_MS = 60 * 60 * 1000;  // soft expiry — refresh in background

function shellEnvOpts(shell, timeout) {
  return {
    encoding: "utf8",
    timeout,
    env: { HOME: homedir(), USER: userInfo().username, SHELL: shell, DISABLE_AUTO_UPDATE: "true" },
  };
}

function parseShellEnv(out) {
  const section = String(out || "").split(ENV_DELIM)[1] || "";
  const env = {};
  for (const line of section.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

function writeShellEnvCache(shell, env) {
  try {
    const tmp = SHELL_ENV_CACHE + ".tmp";
    writeFileSync(tmp, JSON.stringify({ shell, ts: Date.now(), env }), "utf8");
    renameSync(tmp, SHELL_ENV_CACHE);
  } catch {
    /* cache is best-effort */
  }
}

function refreshShellEnvCache(shell) {
  try {
    execFile(shell, ["-ilc", ENV_SCRIPT], shellEnvOpts(shell, 15000), (err, stdout) => {
      if (err) return;
      const env = parseShellEnv(stdout);
      if (Object.keys(env).length) writeShellEnvCache(shell, env);
    });
  } catch {
    /* best-effort */
  }
}

function getShellEnv() {
  if (process.platform === "win32") return { ...process.env };
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const cached = JSON.parse(readFileSync(SHELL_ENV_CACHE, "utf8"));
    const age = Date.now() - (cached.ts || 0);
    if (cached.shell === shell && cached.env && Object.keys(cached.env).length && age < SHELL_ENV_TTL_MS) {
      if (age > SHELL_ENV_REFRESH_MS) refreshShellEnvCache(shell);
      return { ...cached.env };
    }
  } catch {
    /* no or invalid cache — capture synchronously below */
  }
  try {
    const out = execSync(`${shell} -ilc '${ENV_SCRIPT}'`, shellEnvOpts(shell, 5000));
    const env = parseShellEnv(out);
    if (Object.keys(env).length) {
      writeShellEnvCache(shell, env);
      return env;
    }
    return { ...process.env };
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

// Shared secret for the bridge. The server binds to 127.0.0.1, but that alone
// doesn't authenticate the client — any local process could connect and drive
// the user's tabs (including browser_eval). Only our own MCP relays receive the
// token (via env at spawn), and every request must carry it.
const BRIDGE_TOKEN = randomBytes(32).toString("hex");

const bridgeServer = net.createServer((sock) => {
  sock.setEncoding("utf8");
  const feed = lineJsonReader((m) => {
    if (m.token !== BRIDGE_TOKEN) {
      log("bridge: dropping connection with bad/missing token");
      sock.destroy();
      return;
    }
    const reqId = m.reqId;
    browserRequest(m.op, m.args, m.session).then((r) => {
      try {
        sock.write(JSON.stringify({ reqId, ...r }) + "\n");
      } catch {
        /* relay went away */
      }
    });
  });
  sock.on("data", feed);
  sock.on("error", () => {});
});
bridgeServer.on("error", (err) => log("bridge server error", err && err.message));
bridgeServer.listen(0, "127.0.0.1", () => {
  bridgePort = bridgeServer.address().port;
  log("browser bridge listening on 127.0.0.1:" + bridgePort);
});

function browserRequest(op, args, session) {
  return new Promise((resolve) => {
    const bid = nextBid++;
    const timer = setTimeout(() => {
      if (browserPending.has(bid)) {
        browserPending.delete(bid);
        resolve({ ok: false, error: "extension did not respond (is the Lizard side panel open?)" });
      }
    }, 30000);
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

// Appended to claude's system prompt so it knows the live-tab tools exist.
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
  "Every user message may be preceded by a short '[Open browser tabs]' block auto-listing currently open tabs (title + URL), with a leading → marking the one the user is actively viewing — that's environment context the extension injected, not something the user typed. " +
  "It only has title/URL, so when the user refers to \"this page\", \"the open tab\", what they're \"looking at\", or asks you to debug or drive a live site, still call browser_info / browser_dom / browser_snapshot (targeting that tabId if it's not the active one) instead of guessing from the title alone. " +
  "Console and network capture begin when browser_console / browser_network first attach to a tab, so if they come back empty, call browser_reload (or re-trigger the action yourself, e.g. browser_click) rather than asking the user to reload — then call browser_console / browser_network again.";

// ---- Chrome native-messaging framing ---------------------------------------
// Read loop: a 4-byte uint32 LE length, then that many bytes of UTF-8 JSON.
// Chunks accumulate in a list and are joined once per complete frame — the old
// Buffer.concat on every data event re-copied the whole accumulated buffer per
// chunk (O(n²) for a large frame). The length field is sanity-capped: this
// framing has no resync point, so a corrupt/desynced header would otherwise
// make the host buffer forever, silently swallowing every later message.
const MAX_FRAME = 64 * 1024 * 1024;
let inChunks = [];
let inBuffered = 0;
process.stdin.on("data", (chunk) => {
  inChunks.push(chunk);
  inBuffered += chunk.length;
  for (;;) {
    if (inBuffered < 4) return;
    if (inChunks[0].length < 4) inChunks = [Buffer.concat(inChunks)];
    const len = inChunks[0].readUInt32LE(0);
    if (len > MAX_FRAME) {
      log("framing desync: header claims " + len + " bytes — unrecoverable, shutting down");
      shutdown(1);
      return;
    }
    if (inBuffered < 4 + len) return;
    if (inChunks.length > 1) inChunks = [Buffer.concat(inChunks)];
    const frame = inChunks[0];
    let msg = null;
    try {
      msg = JSON.parse(frame.subarray(4, 4 + len).toString("utf8"));
    } catch {
      /* skip unparsable frame */
    }
    inChunks = [frame.subarray(4 + len)];
    inBuffered -= 4 + len;
    if (msg) {
      log("recv", msg && msg.type);
      handle(msg);
    }
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
const sessions = new Map(); // id -> { id, child, cwd, model, effort, mode, sessionId, stderrBuf, permPending }

function startClaude({ id, cwd, model, effort, permissionMode, resume }) {
  id = id || "default";
  killSession(id);

  // No silent fallback to $HOME: a session must run in a real, chosen project
  // directory. If the panel didn't supply one (or it's gone), tell it to ask.
  if (!cwd || !existsSync(cwd)) {
    send({ type: "needsFolder", id, message: "Choose a project folder to start a session." });
    return;
  }

  const s = {
    id,
    child: null,
    cwd,
    model: model || null,
    effort: effort || null,
    mode: permissionMode || "default",
    sessionId: resume || null,
    stderrBuf: "",
    // Pending can_use_tool asks: request_id -> the tool's ORIGINAL input. Kept
    // here (not round-tripped through the panel) because host->panel messages
    // may be truncated for Chrome's 1 MB cap — echoing a truncated input back
    // on "allow" would corrupt the tool call (e.g. a big Write).
    permPending: new Map(),
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
    // Route permission checks to us over stdio (the Agent SDK's canUseTool
    // mechanism): instead of silently denying, claude emits a `control_request`
    // {subtype:"can_use_tool"} line and waits for our control_response. The
    // panel renders it as a Claude Code-style ask dialog.
    "--permission-prompt-tool", "stdio",
  ];
  if (s.model) args.push("--model", s.model);
  if (s.effort) args.push("--effort", s.effort);
  if (resume) args.push("--resume", resume);

  // Ship the lizard-build/skill bootstrap skill to this session (see the
  // refreshBundledSkill block above) — ephemeral, doesn't touch user config.
  if (existsSync(SKILL_MARKER)) args.push("--plugin-dir", SKILL_DIR);

  // Register the browser MCP server so claude can inspect the live tab. The
  // read-only tools are pre-allowed; browser_eval still goes through the normal
  // permission flow since it can run arbitrary JS.
  if (bridgePort && existsSync(MCP_RELAY)) {
    const mcp = JSON.stringify({
      mcpServers: {
        browser: { command: NODE, args: [MCP_RELAY], env: { RK_BRIDGE_PORT: String(bridgePort), RK_BRIDGE_TOKEN: BRIDGE_TOKEN, RK_BRIDGE_SESSION: id } },
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

  send({ type: "started", id, pid: proc.pid, cwd: s.cwd, model: s.model, effort: s.effort, permissionMode: s.mode });
  ensureCommands(id, s.cwd, s.model);

  const feedStdout = lineJsonReader((obj) => {
      // Control-protocol traffic (the SDK channel) is handled here, not
      // forwarded as a transcript event.
      if (obj.type === "control_request" && obj.request) {
        if (obj.request.subtype === "can_use_tool") {
          s.permPending.set(obj.request_id, obj.request.input || {});
          send({
            type: "permission",
            id,
            requestId: obj.request_id,
            toolName: obj.request.tool_name,
            input: obj.request.input || {},
            suggestions: obj.request.permission_suggestions || null,
            description: obj.request.description || null,
            toolUseId: obj.request.tool_use_id || null,
          });
        } else {
          // A control request we don't implement (hooks, SDK MCP…) — refuse it
          // right away so claude never hangs waiting on us.
          try {
            s.child.stdin.write(
              JSON.stringify({
                type: "control_response",
                response: { subtype: "error", request_id: obj.request_id, error: "unsupported control request: " + obj.request.subtype },
              }) + "\n"
            );
          } catch {
            /* child went away */
          }
        }
        return;
      }
      if (obj.type === "control_cancel_request") {
        // The turn was interrupted (or claude moved on) — the ask is moot.
        s.permPending.delete(obj.request_id);
        send({ type: "permissionCancel", id, requestId: obj.request_id });
        return;
      }
      if (obj.type === "system" && obj.subtype === "init" && obj.session_id) {
        s.sessionId = obj.session_id;
      }
      send({ type: "event", id, data: obj });
  });
  proc.stdout.on("data", (chunk) => feedStdout(chunk.toString("utf8")));

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
  // Any ask still waiting on the user is moot once the process dies — tell the
  // panel, or its dialog would hang for a process that can't hear the answer.
  for (const requestId of s.permPending.keys()) send({ type: "permissionCancel", id, requestId });
  s.permPending.clear();
  if (s.child) {
    const child = s.child;
    child._intentional = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    // A claude wedged in a tool call can ignore SIGTERM and linger as an
    // orphan burning CPU/tokens — escalate if it hasn't exited shortly.
    const hard = setTimeout(() => {
      // exitCode/signalCode stay null until the process actually terminates
      // (`killed` only says a signal was *sent* — our own SIGTERM sets it).
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 2500);
    hard.unref?.();
    child.once("exit", () => clearTimeout(hard));
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
const commandCache = new Map();   // cwd -> string[]
const harvestWaiters = new Map(); // cwd -> Set of tab ids awaiting an in-flight harvest

function ensureCommands(id, cwd, model) {
  cwd = cwd || homedir();
  if (commandCache.has(cwd)) {
    send({ type: "commands", id, list: commandCache.get(cwd) });
    return;
  }
  // A harvest for this cwd is already running — two tabs opening in the same
  // folder shouldn't each spawn a throwaway claude. Queue this tab for the
  // in-flight harvest's result instead.
  const waiting = harvestWaiters.get(cwd);
  if (waiting) {
    waiting.add(id);
    return;
  }
  harvestWaiters.set(cwd, new Set([id]));
  harvestCommands(cwd, model);
}

function harvestCommands(cwd, model) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"];
  if (model) args.push("--model", model);
  if (existsSync(SKILL_MARKER)) args.push("--plugin-dir", SKILL_DIR);
  let proc;
  try {
    proc = spawn(CLAUDE, args, { cwd, env: CHILD_ENV, stdio: ["pipe", "pipe", "ignore"] });
  } catch (err) {
    log("harvest spawn failed", err.message);
    harvestWaiters.delete(cwd);
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    harvestWaiters.delete(cwd); // timed-out/failed waiters are dropped, a later tab retries
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };
  const timer = setTimeout(finish, 9000);
  const feed = lineJsonReader((o) => {
    if (done) return;
    if (o.type === "system" && o.subtype === "init" && Array.isArray(o.slash_commands)) {
      commandCache.set(cwd, o.slash_commands);
      for (const wid of harvestWaiters.get(cwd) || []) {
        send({ type: "commands", id: wid, list: o.slash_commands });
      }
      log("harvested", o.slash_commands.length, "commands for", cwd);
      finish();
    }
  });
  proc.stdout.on("data", (chunk) => feed(chunk.toString("utf8")));
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
  // The stream-json control channel's cooperative interrupt only takes effect
  // at the model's next checkpoint — it can be delayed behind an in-flight
  // tool call, or even second-guessed by the model itself (it may decide the
  // interruption was stale and keep going). "Stop" needs to actually stop, so
  // kill the child outright and resume the same session in a fresh process —
  // same mechanism already used for model/mode switches mid-conversation.
  const s = sessions.get(id);
  if (!s) return;
  send({ type: "interrupted", id });
  startClaude({ id, cwd: s.cwd, model: s.model, effort: s.effort, permissionMode: s.mode, resume: s.sessionId });
}

// ---- interactive login ------------------------------------------------------
// The headless `-p` sessions can't run `/login`, so the panel drives the CLI's
// own OAuth flow instead: `claude auth login` prints a sign-in URL, then blocks
// reading the authorization code from stdin. We forward the URL to the panel,
// the user pastes the code back, and we write it to the child's stdin. Fresh
// credentials land in the OS keychain, shared by every session. Only one login
// runs at a time (auth is account-wide, not per-tab).
let authProc = null;
let authProcId = null;
function authLogin(id) {
  // A different tab's sign-in is in progress — tell it before taking over, so
  // its card doesn't hang forever on "Starting sign-in…".
  if (authProc && authProcId != null && authProcId !== id) {
    send({ type: "authDone", id: authProcId, ok: false, message: "Sign-in was started in another tab." });
  }
  authCancel();
  authProcId = id;
  let proc;
  try {
    proc = spawn(CLAUDE, ["auth", "login", "--claudeai"], {
      cwd: homedir(),
      env: CHILD_ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    send({ type: "authDone", id, ok: false, message: `Failed to start login: ${err.message}` });
    return;
  }
  authProc = proc;
  let buf = "";
  let urlSent = false;
  const scan = (chunk) => {
    buf += chunk.toString("utf8");
    if (!urlSent) {
      const m = /(https?:\/\/[^\s]*oauth[^\s]*)/i.exec(buf);
      if (m) {
        urlSent = true;
        send({ type: "authUrl", id, url: m[1] });
      }
    }
  };
  proc.stdout.on("data", scan);
  proc.stderr.on("data", scan);
  proc.on("exit", (code) => {
    if (authProc === proc) { authProc = null; authProcId = null; }
    const ok = code === 0;
    send({ type: "authDone", id, ok, message: ok ? "" : buf.trim().slice(-300) || `login exited with code ${code}` });
  });
  proc.on("error", (err) => {
    if (authProc === proc) { authProc = null; authProcId = null; }
    send({ type: "authDone", id, ok: false, message: err.message });
  });
}
function authCode(id, code) {
  if (!authProc || !authProc.stdin.writable) {
    send({ type: "authDone", id, ok: false, message: "No sign-in is in progress." });
    return;
  }
  authProc.stdin.write(String(code == null ? "" : code).trim() + "\n");
}
function authCancel() {
  if (authProc) {
    try { authProc.kill("SIGKILL"); } catch {}
    authProc = null;
  }
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
  // Streamed line-by-line — transcripts can reach tens of MB, and a
  // readFileSync here would stall every active claude stream and pending
  // permission answer while the whole file is read and split.
  let batch = [];
  let size = 0;
  let failed = false;
  const flush = (done) => {
    if (!batch.length && !done) return;
    send({ type: "transcript", id, events: batch, done });
    batch = [];
    size = 0;
  };
  const stream = createReadStream(file, "utf8");
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  stream.on("error", (err) => {
    log("transcript read failed", err.message);
    failed = true;
    send({ type: "transcript", id, events: [], done: true });
    rl.close();
  });
  rl.on("line", (line) => {
    if (failed || !line.trim()) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    // Keep only the visible conversation: real user/assistant turns. Skip
    // sub-agent sidechains and injected meta (system reminders, hooks).
    if (o.isSidechain || o.isMeta) return;
    if ((o.type !== "user" && o.type !== "assistant") || !o.message) return;
    // Carry the JSONL line's `timestamp` so the panel can show a real "Xm ago"
    // on replay instead of resetting every message to "now" on each panel open.
    const ev = { type: o.type, message: o.message, timestamp: o.timestamp };
    const s = JSON.stringify(ev).length;
    // Batch events under Chrome's native-message size cap (send() truncates over it).
    if (size + s > 700000) flush(false);
    batch.push(ev);
    size += s;
  });
  rl.on("close", () => {
    if (failed) return;
    flush(true);
    log("transcript replayed", file, "→ id", id);
  });
}

// ---- rewind ------------------------------------------------------------------
// The panel lets you edit a past message; pressing Enter on the edit both
// truncates that message (and everything after it) in the UI and asks us to
// cut the on-disk JSONL transcript back to just before it — then resend the
// edited text as the new next turn — so the model actually forgets what got
// rewound, not just hidden client-side. Counts turns the same way
// loadTranscript filters them for replay (real user text, not
// sidechains/meta/tool-result-only turns), so turnIndex lines up with the
// panel's own count of rendered user bubbles.
//
// The live claude process for this session may still be mid-turn — actively
// writing later lines to that same transcript file — when the rewind lands.
// Truncate first and it could win the race and re-append past our cut, so we
// kill it and wait for the actual `exit` event (not just send the signal)
// before touching the file, then spawn the resumed process on the now-frozen
// file. The resend (`text`/`images`) rides along in this same call rather
// than arriving as a separate `prompt` message: the old session is gone the
// instant this lands, and the new one isn't ready until the respawn above
// finishes, so a second message sent by the panel right after would race
// that gap. Writing the prompt ourselves, right after startClaude returns,
// closes it.
function rewindSession(id, turnIndex, text, images) {
  const s = sessions.get(id);
  if (!s || !s.sessionId) return;
  const { cwd, model, effort, mode, sessionId } = s;
  const child = s.child;

  const truncateAndResume = () => {
    const file = findTranscript(sessionId, cwd);
    if (file) {
      try {
        const lines = readFileSync(file, "utf8").split("\n");
        let count = 0;
        let cut = -1;
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          let o;
          try {
            o = JSON.parse(lines[i]);
          } catch {
            continue;
          }
          if (o.isSidechain || o.isMeta || o.type !== "user" || !o.message) continue;
          const content = o.message.content;
          const hasText =
            typeof content === "string" ? content.trim().length > 0 : Array.isArray(content) && content.some((b) => b && b.type === "text" && b.text);
          if (!hasText) continue;
          count++;
          if (count === turnIndex) {
            cut = i;
            break;
          }
        }
        if (cut !== -1) writeFileSync(file, lines.slice(0, cut).join("\n") + (cut > 0 ? "\n" : ""));
      } catch (err) {
        log("rewind transcript truncate failed", err.message);
      }
    }
    // No `interrupted` here, unlike interrupt()/restartSession: the panel
    // already reset its transcript state and started the spinner for the
    // resent turn — `interrupted` would endTurn() that brand-new turn.
    startClaude({ id, cwd, model, effort, permissionMode: mode, resume: sessionId });
    sendPrompt(id, text, images);
  };

  if (child && child.exitCode == null && child.signalCode == null) {
    child.once("exit", truncateAndResume);
    killSession(id);
  } else {
    killSession(id);
    truncateAndResume();
  }
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
    case "restartSession": {
      // The panel sends the full desired trio (not just whatever changed) —
      // it may be flushing several deferred switches (model + mode, say) made
      // in whatever order while a turn was running, all at once.
      const s = sessions.get(id);
      send({ type: "interrupted", id });
      startClaude({ id, cwd: s && s.cwd, model: msg.model, effort: msg.effort, permissionMode: msg.permissionMode, resume: s && s.sessionId });
      break;
    }
    case "loadTranscript":
      loadTranscript(id, msg.sessionId, msg.cwd);
      break;
    case "rewind":
      rewindSession(id, msg.turnIndex, msg.text, msg.images);
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
    case "permissionResult": {
      // The user answered a `permission` ask — relay it to claude as the
      // control_response it's blocked on. On allow, updatedInput must be the
      // ORIGINAL input we stashed (the panel's copy may have been truncated
      // for the native-messaging size cap); anything the panel adds on top
      // (AskUserQuestion's `answers`) is merged over it.
      const s = sessions.get(id);
      if (!s || !s.child || !s.child.stdin.writable) break;
      const input = s.permPending.get(msg.requestId) || {};
      s.permPending.delete(msg.requestId);
      const response =
        msg.behavior === "allow"
          ? {
              behavior: "allow",
              updatedInput: msg.updatedInput && typeof msg.updatedInput === "object" ? { ...input, ...msg.updatedInput } : input,
              ...(Array.isArray(msg.updatedPermissions) && msg.updatedPermissions.length
                ? { updatedPermissions: msg.updatedPermissions }
                : {}),
            }
          : {
              behavior: "deny",
              message: msg.message || "The user denied this tool use.",
              ...(msg.interrupt ? { interrupt: true } : {}),
            };
      try {
        s.child.stdin.write(
          JSON.stringify({
            type: "control_response",
            response: { subtype: "success", request_id: msg.requestId, response },
          }) + "\n"
        );
      } catch {
        /* child went away */
      }
      break;
    }
    case "authLogin":
      authLogin(id);
      break;
    case "authCode":
      authCode(id, msg.code);
      break;
    case "authCancel":
      authCancel();
      break;
    case "selfUpdate":
      selfUpdate(id);
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
send({ type: "ready", version: HOST_VERSION, home: homedir(), claudePath: CLAUDE, ok: existsSync(CLAUDE) || CLAUDE === "claude" });
