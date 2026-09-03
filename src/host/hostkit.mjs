// Shared plumbing for the Lizard Studio native-messaging hosts.
//
// `claude-host.mjs` predates this file and keeps its own copies of everything
// here — deliberately. It is the path that already works, and nothing in the
// Codex work is allowed to reach into it. This module exists so `router.mjs`
// and `codex-host.mjs` don't grow a third and fourth copy of the same framing,
// logging and environment code.
//
// Node built-ins only, no dependencies — same rule as the rest of the host.

import { execFile, execSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, userInfo } from "node:os";

export const HOST_DIR = dirname(fileURLToPath(import.meta.url));

// ---- logging ----------------------------------------------------------------
// One timeline for every process in the tree: the router, the claude host and
// the codex host all append to host.log. Each line is tagged so a reader can
// tell them apart. Appends are O_APPEND, so interleaving is safe.
const LOG_FILE = join(HOST_DIR, "host.log");
const LOG_REDACT = new Set();

/** Never let this string reach the log (tokens, secrets). */
export function redact(secret) {
  if (secret) LOG_REDACT.add(secret);
}

export function makeLog(tag) {
  return function log(...args) {
    try {
      let line = `${new Date().toISOString()} [${tag}] ${args.join(" ")}\n`;
      for (const secret of LOG_REDACT) if (secret) line = line.split(secret).join("***");
      appendFileSync(LOG_FILE, line);
    } catch {
      /* logging must never break a host */
    }
  };
}

// ---- native-messaging framing ----------------------------------------------
// Chrome's wire format both ways: a 4-byte little-endian length prefix followed
// by that many bytes of UTF-8 JSON. The children speak it on their own stdio,
// which is what lets the router sit between them and Chrome without either side
// noticing.

// A single message may not exceed this. Chrome's own host->extension cap is
// 1 MB (the hosts truncate to stay under it); this is only a sanity bound so a
// corrupt length prefix can't make us allocate forever.
const MAX_FRAME = 64 * 1024 * 1024;

/**
 * Incremental frame reader. Feed it Buffers; it calls
 * `onFrame(rawBody: Buffer, text: string)` once per complete message.
 * `onOverflow` fires when a length prefix exceeds MAX_FRAME — the stream is
 * unrecoverable at that point, so the caller should shut down.
 */
export function frameReader(onFrame, onOverflow) {
  let chunks = [];
  let size = 0;
  return function feed(chunk) {
    chunks.push(chunk);
    size += chunk.length;
    for (;;) {
      if (size < 4) return;
      const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      chunks = [buf];
      const len = buf.readUInt32LE(0);
      if (len > MAX_FRAME) {
        onOverflow && onOverflow(len);
        return;
      }
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      onFrame(body, body.toString("utf8"));
      const rest = buf.subarray(4 + len);
      chunks = rest.length ? [rest] : [];
      size = rest.length;
    }
  };
}

/** Wrap a JSON-serializable object in a native-messaging frame. */
export function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Wrap an already-serialized body (raw bytes) in a native-messaging frame. */
export function frameRaw(body) {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Write one framed message to a stream, swallowing a dead pipe. */
export function writeFrame(stream, obj) {
  try {
    stream.write(frame(obj));
    return true;
  } catch {
    return false;
  }
}

// ---- host config ------------------------------------------------------------
// install.mjs writes resolved binary paths here, since Chrome launches native
// hosts with a minimal PATH that usually misses /opt/homebrew, nvm and friends.
export function loadConfig() {
  const p = join(HOST_DIR, "host-config.json");
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* fall through to discovery */
    }
  }
  return {};
}

// ---- login-shell environment -------------------------------------------------
// Same cache file claude-host.mjs writes, same format, same 24h expiry. Reading
// it is instant; the expensive login-shell capture only happens when the cache
// is missing or stale, and we let it happen in the background rather than
// blocking a host's startup — a Codex session that starts a second later is
// better than a panel that waits on someone's .zshrc.
const ENV_DELIM = "__RK_ENV__";
const ENV_SCRIPT = `echo -n "${ENV_DELIM}"; env; echo -n "${ENV_DELIM}"; exit`;
const SHELL_ENV_CACHE = join(HOST_DIR, "shell-env.json");
const SHELL_ENV_TTL_MS = 24 * 60 * 60 * 1000;

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
    // The captured env can hold tokens — keep the cache owner-only.
    writeFileSync(tmp, JSON.stringify({ shell, ts: Date.now(), env }), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, SHELL_ENV_CACHE);
  } catch {
    /* best-effort */
  }
}

function readShellEnvCache(shell) {
  try {
    const cached = JSON.parse(readFileSync(SHELL_ENV_CACHE, "utf8"));
    if (cached.shell !== shell || !cached.env) return null;
    if (Date.now() - (cached.ts || 0) >= SHELL_ENV_TTL_MS) return null;
    if (!Object.keys(cached.env).length) return null;
    return cached.env;
  } catch {
    return null;
  }
}

/**
 * The environment to hand a spawned CLI. Returns immediately: a warm cache is
 * used as-is, a cold one falls back to our own env plus the usual install
 * locations while a background capture fills the cache for next time.
 *
 * `onWarm` (optional) is called with the fresh env once a background capture
 * lands, so a long-lived host can upgrade what it uses for later spawns.
 */
export function buildChildEnv(extra, onWarm) {
  const shell = process.env.SHELL || "/bin/zsh";
  const cached = process.platform === "win32" ? { ...process.env } : readShellEnvCache(shell);
  if (!cached && process.platform !== "win32") {
    try {
      execFile(shell, ["-ilc", ENV_SCRIPT], {
        encoding: "utf8",
        timeout: 15000,
        env: { HOME: homedir(), USER: userInfo().username, SHELL: shell, DISABLE_AUTO_UPDATE: "true" },
      }, (err, stdout) => {
        if (err) return;
        const env = parseShellEnv(stdout);
        if (!Object.keys(env).length) return;
        writeShellEnvCache(shell, env);
        if (onWarm) onWarm(mergeEnv(env, extra));
      });
    } catch {
      /* best-effort */
    }
  }
  return mergeEnv(cached || {}, extra);
}

function mergeEnv(shellEnv, extra) {
  const env = { ...process.env, ...shellEnv };
  if (shellEnv.PATH) env.PATH = shellEnv.PATH;
  env.PATH = [env.PATH || "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", join(homedir(), ".local/bin")]
    .filter(Boolean)
    .join(process.platform === "win32" ? ";" : ":");
  if (!env.HOME) env.HOME = homedir();
  if (!env.TERM) env.TERM = "xterm-256color";
  if (!env.SHELL) env.SHELL = process.env.SHELL || "/bin/zsh";
  return Object.assign(env, extra || {});
}

/** Look a binary up the way a shell would, using the environment we built. */
export function whichBin(name, env) {
  if (process.platform === "win32") {
    try {
      const found = execSync(`where ${name}`, { encoding: "utf8", env })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      if (found && existsSync(found)) return found;
    } catch {
      /* not on PATH */
    }
    return "";
  }
  try {
    const found = execSync(`command -v ${name}`, { encoding: "utf8", env, timeout: 4000 }).trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* not on PATH */
  }
  return "";
}

/** The OS user's display name, for the panel's greeting. */
export function osUserName() {
  try {
    if (process.platform === "darwin") {
      const full = execSync("id -F", { encoding: "utf8", timeout: 2000 }).trim();
      if (full) return full;
    }
  } catch {
    /* fall through */
  }
  try {
    return userInfo().username || null;
  } catch {
    return null;
  }
}
