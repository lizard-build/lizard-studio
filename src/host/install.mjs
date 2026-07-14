#!/usr/bin/env node
// Cross-platform installer for the native-messaging host that lets the Lizard
// Studio side panel drive the real `claude` CLI. Runs on macOS, Linux and
// Windows. Invoke via npm:
//
//   npx @lizard-build/lizard-studio-host install
//   npx @lizard-build/lizard-studio-host uninstall
//
// (Bare `install`/no-arg installs; `uninstall`/`--uninstall` removes it.)
//
// It resolves your node + claude binaries, copies the host into a stable runtime
// directory, writes a launcher and a host config there, and registers an
// origin-locked native-messaging manifest for every Chrome-family browser on
// this machine (a file per browser on macOS/Linux, a registry key per browser on
// Windows). Re-run it any time those paths change (it re-copies the host too).
//
// Why a separate runtime dir: on macOS, TCC protects ~/Desktop, ~/Documents and
// ~/Downloads. A browser is a GUI app and cannot launch a native-messaging host
// living under those folders without an explicit per-folder grant — the host
// just fails to start and the panel shows "Native host has exited", with nothing
// in the log (the process never runs). Running it from Terminal works, which
// makes this baffling. We sidestep it entirely by running the host from
// ~/.lizard-studio, which no browser is ever blocked from. (Bonus: the repo can
// move freely afterwards.)

import {
  existsSync, mkdirSync, copyFileSync, writeFileSync, chmodSync,
  renameSync, rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const HOST_NAME = "com.lizard.code";
// IDs the host trusts. The store build has no manifest "key", so Web Store
// installs get the store-assigned ID; unpacked dev builds keep the key-derived
// dev ID. Both must be allowed or one of the two install paths breaks.
const DEFAULT_EXT_IDS = [
  "kgbaeoalmkabpoglpjcdmppdmcipfdeh", // Chrome Web Store install
  "nhcgkijjijdinhldjohkmbbgjokobecd", // unpacked dev build (manifest "key")
];
const EXT_IDS = process.env.RK_EXT_ID ? [process.env.RK_EXT_ID] : DEFAULT_EXT_IDS;

const IS_WIN = process.platform === "win32";

// The dir this script lives in — the payload source. When installed from npm the
// host files ship alongside it in the package (no GitHub fetch needed); in a repo
// checkout they're the working-tree copies. Same-dir either way.
const HERE = dirname(fileURLToPath(import.meta.url));

// Stable, non-TCC-protected home for the running host. Never put this under
// Desktop/Documents/Downloads — that's the whole bug this avoids.
const RUNTIME_DIR = join(homedir(), ".lizard-studio", "host");

// Path within HERE / RUNTIME_DIR from a "/"-separated relative string (so the
// same literals work on Windows, where the path separator is "\").
const here = (rel) => join(HERE, ...rel.split("/"));
const runtime = (rel) => join(RUNTIME_DIR, ...rel.split("/"));

// ---- browser locations ------------------------------------------------------

// macOS + Linux native-messaging host directories, one JSON manifest per browser.
function hostDirs() {
  const home = homedir();
  if (process.platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    return [
      join(base, "Google/Chrome/NativeMessagingHosts"),
      join(base, "Google/Chrome Beta/NativeMessagingHosts"),
      join(base, "Google/Chrome Canary/NativeMessagingHosts"),
      join(base, "Chromium/NativeMessagingHosts"),
      join(base, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
      join(base, "Microsoft Edge/NativeMessagingHosts"),
      join(base, "Arc/User Data/NativeMessagingHosts"),
      join(base, "DiaBrowser/NativeMessagingHosts"),
      join(base, "Vivaldi/NativeMessagingHosts"),
      join(base, "com.operasoftware.Opera/NativeMessagingHosts"),
    ];
  }
  const cfg = join(home, ".config");
  return [
    join(cfg, "google-chrome/NativeMessagingHosts"),
    join(cfg, "chromium/NativeMessagingHosts"),
    join(cfg, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
    join(cfg, "microsoft-edge/NativeMessagingHosts"),
    join(cfg, "vivaldi/NativeMessagingHosts"),
    join(cfg, "opera/NativeMessagingHosts"),
  ];
}

// Windows registers native-messaging hosts by a registry value under each
// browser's vendor key, whose (default) points at the manifest JSON on disk.
// HKCU keys are per-user and inert when the browser isn't installed, so writing
// all of them is harmless.
const WIN_REG_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Google\\Chrome Beta\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\${HOST_NAME}`,
];

// ---- helpers ----------------------------------------------------------------

// Resolve a binary off PATH ourselves — no dependency on `which`/`where` being
// present, and honours PATHEXT on Windows (claude ships as claude.cmd there).
function whichBin(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(IS_WIN ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// ---- uninstall --------------------------------------------------------------

function uninstall() {
  if (IS_WIN) {
    for (const key of WIN_REG_KEYS) {
      // /f = no confirmation; ignore "key not found" and the rest.
      spawnSync("reg", ["delete", key, "/f"], { stdio: "ignore" });
    }
  } else {
    for (const dir of hostDirs()) {
      try { rmSync(join(dir, `${HOST_NAME}.json`), { force: true }); } catch {}
    }
    // Old in-repo artifacts (pre-relocation), if this is a repo checkout.
    for (const f of ["host-config.json", "launch.sh", "host.log"]) {
      try { rmSync(here(f), { force: true }); } catch {}
    }
  }
  try { rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch {}
  console.log(`Removed ${HOST_NAME} from all Chrome-family browsers.`);
}

// ---- install ----------------------------------------------------------------

function install() {
  // process.execPath is the node running THIS installer — an absolute path to a
  // real node binary, which is exactly what the launcher needs at browser-launch
  // time (Chrome starts the host with a minimal PATH).
  const NODE_BIN = process.execPath;
  const CLAUDE_BIN = whichBin("claude");

  if (parseInt(process.versions.node, 10) < 18) {
    fail(`Node 18+ required (found ${process.version}). Upgrade node and re-run.`);
  }
  if (!CLAUDE_BIN) {
    console.warn("warning: 'claude' not found on PATH. Install it with:  npm i -g @anthropic-ai/claude-code");
    console.warn("         The host will still install and look in common locations at runtime.");
  }

  // The launcher embeds these paths inside double quotes, which covers spaces —
  // but not quotes/backslashes (backslashes are legitimate on Windows, where the
  // launcher is a .bat and Windows paths use them, so only guard on POSIX).
  if (!IS_WIN && /["\\]/.test(NODE_BIN + RUNTIME_DIR)) {
    fail("node or runtime path contains a quote/backslash — unsupported.");
  }
  if (IS_WIN && /"/.test(NODE_BIN + RUNTIME_DIR)) {
    fail("node or runtime path contains a quote — unsupported.");
  }

  // 0) copy the (self-contained, dependency-free) host into the runtime dir so
  //    the manifest can point outside any TCC-protected folder. Re-copied every
  //    run so re-running the installer picks up host changes. Staged as ".tmp"
  //    first and swapped in only once ALL files are in hand — an interrupted
  //    install must not leave a mismatched claude-host/mcp-browser pair behind.
  //    Files: the host, the browser MCP relay it hands to claude, and a bundled
  //    fallback copy of the lizard-build/skill bootstrap skill (the host
  //    refreshes it from upstream itself afterwards — see claude-host.mjs).
  const HOST_FILES = [
    "claude-host.mjs",
    "mcp-browser.mjs",
    "skills/lizard/SKILL.md",
    "skills/lizard/README.md",
    "skills/lizard/skills.sh.json",
  ];
  mkdirSync(RUNTIME_DIR, { recursive: true });
  for (const f of HOST_FILES) {
    const dst = runtime(f);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(here(f), `${dst}.tmp`);
  }
  for (const f of HOST_FILES) renameSync(`${runtime(f)}.tmp`, runtime(f));

  // 1) host config the runtime reads (the browser launches us with a minimal
  //    PATH). JSON.stringify keeps a path with odd characters from producing
  //    invalid JSON (which would silently degrade the host to discovery).
  writeFileSync(
    runtime("host-config.json"),
    JSON.stringify({ nodePath: NODE_BIN, claudePath: CLAUDE_BIN || "claude", home: homedir() }, null, 2) + "\n",
  );

  // 2) launcher: a tiny wrapper so the manifest points at a stable executable
  //    that runs our .mjs with the resolved node, regardless of the browser's
  //    PATH. Native messaging on Windows can only exec a real program, so the
  //    launcher there must be a .bat (Chromium runs it via cmd.exe).
  let launcherPath;
  if (IS_WIN) {
    launcherPath = runtime("launch.bat");
    writeFileSync(launcherPath, `@echo off\r\n"${NODE_BIN}" "${runtime("claude-host.mjs")}" %*\r\n`);
  } else {
    launcherPath = runtime("launch.sh");
    writeFileSync(launcherPath, `#!/bin/sh\nexec "${NODE_BIN}" "${runtime("claude-host.mjs")}" "$@"\n`);
    chmodSync(launcherPath, 0o755);
  }

  // 3) native-messaging manifest, origin-locked to our extension. One master
  //    copy is written to the runtime dir; on POSIX it's copied into each
  //    browser's host dir, on Windows each browser's registry key points at it.
  const manifestMaster = runtime(`${HOST_NAME}.json`);
  writeFileSync(
    manifestMaster,
    JSON.stringify({
      name: HOST_NAME,
      description: "Lizard Claude Code chat host",
      path: launcherPath,
      type: "stdio",
      allowed_origins: EXT_IDS.map((id) => `chrome-extension://${id}/`),
    }, null, 2) + "\n",
  );

  let count = 0;
  const locations = [];
  if (IS_WIN) {
    for (const key of WIN_REG_KEYS) {
      const r = spawnSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestMaster, "/f"], { stdio: "ignore" });
      if (r.status === 0) { count++; locations.push(key); }
    }
  } else {
    for (const dir of hostDirs()) {
      // Only install where the browser itself is present (its profile dir
      // exists) — don't force-create Chrome's dir on machines without Chrome.
      if (!existsSync(dirname(dir))) continue;
      mkdirSync(dir, { recursive: true });
      copyFileSync(manifestMaster, join(dir, `${HOST_NAME}.json`));
      count++;
      locations.push(join(dir, `${HOST_NAME}.json`));
    }
  }

  console.log();
  console.log(`Done. Registered '${HOST_NAME}' in ${count} location(s).`);
  for (const loc of locations) console.log(`  installed -> ${loc}`);
  console.log();
  console.log(`  node    : ${NODE_BIN}`);
  console.log(`  claude  : ${CLAUDE_BIN || "(not found — install @anthropic-ai/claude-code)"}`);
  console.log(`  ext ids : ${EXT_IDS.join(", ")}`);
  console.log(`  runtime : ${RUNTIME_DIR}  (log: ${join(RUNTIME_DIR, "host.log")})`);
  console.log();
  console.log("Reload the extension and open the side panel.");
}

// ---- entry ------------------------------------------------------------------

const cmd = process.argv[2];
if (cmd === "uninstall" || cmd === "--uninstall") {
  uninstall();
} else {
  install();
}
