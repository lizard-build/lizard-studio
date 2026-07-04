#!/usr/bin/env node
// MCP stdio server that lets Claude Code inspect the user's *live* Chrome tab.
//
// Spawned by `claude` itself (registered via --mcp-config from claude-host.mjs).
// It speaks the MCP protocol to claude over stdin/stdout (newline-delimited
// JSON-RPC 2.0) and forwards each tool call to the native host over a localhost
// TCP socket. The host relays to the extension, which runs the request against
// a browser tab (the active one by default, or any tab via tabId) — DOM/text via
// a content script, or the DevTools Protocol (chrome.debugger) for console,
// network and JS evaluation.
//
// No dependencies — Node built-ins only, 100% local.

import net from "node:net";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const PORT = parseInt(process.env.RK_BRIDGE_PORT || "0", 10);
const TOKEN = process.env.RK_BRIDGE_TOKEN || "";
const SESSION = process.env.RK_BRIDGE_SESSION || "default";

// Exit when the parent claude process goes away (its death ends our stdin).
// Without this the open TCP socket to the host keeps the event loop alive and
// every interrupt/model-switch would leak an orphaned relay process.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

// Every tab-scoped tool accepts this: omit to use the user's active tab.
const TAB_ID = {
  type: "number",
  description:
    "Target tab id (from browser_tabs). Works on background tabs without switching to them. Omit to use this conversation's working tab: the first tab resolved (normally the active one) the first time a call omits tabId, reused automatically after that even if the user switches tabs — so pass tabId explicitly whenever you mean a *different* tab, and expect NOT to need it again for the same one.",
};

const TOOLS = [
  {
    name: "browser_tabs",
    description:
      "List ALL open browser tabs across every window: tabId, windowId, title, URL, and which one is active. Also returns workingTabId — the tab this conversation is currently pinned to (see the tabId note below). Pass a tabId to any other browser_* tool to work with that tab (no need to switch to it), or use browser_tab_activate to bring it to the front for the user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_tab_activate",
    description:
      "Switch the user's browser to the given tab: makes it the active tab and focuses its window. Only needed when the user should SEE the tab — other browser_* tools accept tabId and work on background tabs without switching.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number", description: "Tab id from browser_tabs" } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_tab_open",
    description: "Open a new browser tab with the given URL and return its tabId. Set active:false to open it in the background without stealing the user's focus.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL" },
        active: { type: "boolean", description: "Focus the new tab (default true)" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_tab_close",
    description: "Close a browser tab by tabId.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number", description: "Tab id from browser_tabs" } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_info",
    description:
      "Get a browser tab's URL, page title and any text the user has selected (the active tab unless tabId is given). Cheap — call this first to know what page you're looking at.",
    inputSchema: { type: "object", properties: { tabId: TAB_ID }, additionalProperties: false },
  },
  {
    name: "browser_dom",
    description:
      "Read the content of a tab (active tab unless tabId is given). format:'text' returns the rendered visible text (innerText); format:'html' returns outerHTML. Optionally pass a CSS `selector` to scope to one element. Use this to see what's actually on the page.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["text", "html"], description: "text (default) or html" },
        selector: { type: "string", description: "Optional CSS selector to scope to one element" },
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_eval",
    description:
      "Evaluate a JavaScript expression in the page context of a tab (active tab unless tabId is given) and return the result (JSON-serialized). Runs via the DevTools Protocol, so it can read anything the page can — window globals, app state, DOM, localStorage, fetch(), etc. The last expression's value is returned; use an async IIFE for awaits.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JS expression to evaluate in the page" },
        tabId: TAB_ID,
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_console",
    description:
      "Return recent console messages (log/info/warn/error) and uncaught exceptions from a tab (active tab unless tabId is given). NOTE: capture starts when these tools first attach to the tab, so if this is empty, call browser_reload (or re-trigger the code) and call this again.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries to return (default 100)" },
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_network",
    description:
      "Return recent network requests (URL, method, status, type, mime) from a tab (active tab unless tabId is given). NOTE: capture starts when these tools first attach, so if this is empty, call browser_reload (or re-trigger the request) and call this again.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max requests to return (default 80)" },
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of a tab and return it as an image (active tab unless tabId is given; background tabs are captured via the DevTools Protocol without switching to them).",
    inputSchema: { type: "object", properties: { tabId: TAB_ID }, additionalProperties: false },
  },
  {
    name: "browser_snapshot",
    description:
      "Get an accessibility-tree snapshot of a tab (active tab unless tabId is given) — a compact list of interactive/labelled elements, each with a stable ref like @e5. This is the BEST way to understand the page for interaction: pass a ref to browser_click / browser_type / browser_fill instead of guessing CSS selectors. Refs are per-tab; pass the same tabId when using them.",
    inputSchema: {
      type: "object",
      properties: {
        interactiveOnly: { type: "boolean", description: "Only buttons/links/inputs/etc (default true)" },
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description: "Click an element in a tab (active tab unless tabId is given). Target it by `ref` (from browser_snapshot), `selector` (CSS), or absolute `x`/`y` viewport coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from browser_snapshot, e.g. @e5" },
        selector: { type: "string", description: "CSS selector" },
        x: { type: "number" },
        y: { type: "number" },
        double: { type: "boolean", description: "Double-click" },
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: "Type text into an element (focuses it first) in a tab (active tab unless tabId is given). Target by `ref` or `selector` (else types into the focused element). Set submit:true to press Enter afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        ref: { type: "string" },
        selector: { type: "string" },
        submit: { type: "boolean", description: "Press Enter after typing" },
        tabId: TAB_ID,
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_fill",
    description: "Set the value of an input/textarea/select (clears it first, fires input+change) in a tab (active tab unless tabId is given). Target by `ref` or `selector`.",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
        ref: { type: "string" },
        selector: { type: "string" },
        tabId: TAB_ID,
      },
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_upload_file",
    description:
      "Attach a local file to a file input or drop zone on a page (active tab unless tabId is given) — the programmatic equivalent of the user picking it in the OS file dialog. Reads the file from disk, so `path` must be absolute. Target the file input by `selector` (CSS); omit it when the page has exactly one <input type=file> (it's auto-picked, including hidden ones behind styled buttons). If the selector matches a non-input element, the file is delivered as a synthetic drag-and-drop onto it instead. Fires the same input/change (or drop) events a real user would, so framework listeners see it. Max 25 MB.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file on disk" },
        selector: { type: "string", description: "CSS selector of the <input type=file> or drop zone. Omit to auto-pick the page's only file input." },
        mimeType: { type: "string", description: "Override the MIME type (default: guessed from the file extension)" },
        tabId: TAB_ID,
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_key",
    description: 'Press a key or chord in a tab (active tab unless tabId is given), e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+a", "Meta+c".',
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, tabId: TAB_ID },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate a tab to a URL and wait for it to load (active tab unless tabId is given). Returns the final URL and title.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, tabId: TAB_ID },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_reload",
    description:
      "Reload a tab and wait for it to finish loading (active tab unless tabId is given). Use this instead of asking the user to reload — e.g. to capture console/network activity from page load with browser_console / browser_network. Set hardReload:true to bypass cache.",
    inputSchema: {
      type: "object",
      properties: { hardReload: { type: "boolean", description: "Bypass cache (default false)" }, tabId: TAB_ID },
      additionalProperties: false,
    },
  },
];

// ---- TCP bridge to the native host -----------------------------------------
let sock = null;
let connected = false;
let nextReq = 1;
const pending = new Map();
let rbuf = "";

function connect() {
  if (sock) return;
  sock = net.connect(PORT, "127.0.0.1");
  sock.setEncoding("utf8");
  sock.on("connect", () => {
    connected = true;
  });
  sock.on("data", (chunk) => {
    rbuf += chunk;
    let nl;
    while ((nl = rbuf.indexOf("\n")) >= 0) {
      const line = rbuf.slice(0, nl);
      rbuf = rbuf.slice(nl + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const r = pending.get(m.reqId);
      if (r) {
        pending.delete(m.reqId);
        r(m);
      }
    }
  });
  sock.on("error", () => {
    connected = false;
  });
  sock.on("close", () => {
    connected = false;
    sock = null;
    // Fail everything in flight immediately — the host is gone, and letting
    // each request sit until its own timeout would stall claude for up to 30s
    // per tool call against a definitively dead connection.
    for (const resolve of pending.values()) {
      resolve({ ok: false, error: "browser bridge disconnected (is the Lizard side panel open?)" });
    }
    pending.clear();
  });
}

// Slow page loads can legitimately exceed the default — give navigation-ish
// ops more headroom instead of reporting a spurious timeout while the page
// actually finishes loading.
const OP_TIMEOUT_MS = { navigate: 45000, reload: 45000, screenshot: 45000 };

function callHost(op, args) {
  return new Promise((resolve) => {
    connect();
    const reqId = nextReq++;
    pending.set(reqId, resolve);
    const payload = JSON.stringify({ reqId, op, args, session: SESSION, token: TOKEN }) + "\n";
    let tries = 0;
    const trySend = () => {
      if (!pending.has(reqId)) return; // already failed via close/timeout
      if (connected && sock) {
        try {
          sock.write(payload);
        } catch {
          /* ignore */
        }
      } else if (tries++ < 25) {
        // Exponential backoff (50ms → 1s) — a dead host shouldn't be hammered
        // with a fresh socket + error + close cycle every 50ms per request.
        connect();
        setTimeout(trySend, Math.min(1000, 50 * Math.pow(1.5, tries)));
      }
    };
    trySend();
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        resolve({ ok: false, error: "browser bridge timed out (is the Lizard side panel open?)" });
      }
    }, OP_TIMEOUT_MS[op] || 30000);
  });
}

// ---- MCP stdio (newline-delimited JSON-RPC 2.0) ----------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, result });
}
function replyErr(id, code, message) {
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code, message } });
}

let inbuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inbuf += chunk;
  let nl;
  while ((nl = inbuf.indexOf("\n")) >= 0) {
    const line = inbuf.slice(0, nl);
    inbuf = inbuf.slice(nl + 1);
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    handle(m);
  }
});

async function handle(m) {
  const { id, method, params } = m || {};
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "rk-browser", version: "0.1.0" },
      });
      break;
    case "notifications/initialized":
    case "initialized":
      break; // notification, no reply
    case "ping":
      reply(id, {});
      break;
    case "tools/list":
      reply(id, { tools: TOOLS });
      break;
    case "tools/call": {
      const name = (params && params.name) || "";
      const args = (params && params.arguments) || {};
      if (name === "browser_upload_file") {
        const res = await uploadFile(args);
        if (!res || res.ok === false) {
          reply(id, { content: [{ type: "text", text: "Error: " + ((res && res.error) || "upload failed") }], isError: true });
        } else {
          reply(id, toolResult(name, res.data));
        }
        break;
      }
      const op = name.replace(/^browser_/, "");
      const res = await callHost(op, args);
      if (!res || res.ok === false) {
        reply(id, { content: [{ type: "text", text: "Error: " + ((res && res.error) || "browser bridge failed") }], isError: true });
      } else {
        reply(id, toolResult(name, res.data));
      }
      break;
    }
    default:
      if (id !== undefined && id !== null) replyErr(id, -32601, "Method not found: " + method);
  }
}

// ---- file upload ------------------------------------------------------------
// The native-messaging hop caps a single message at ~900 KB, so the file is
// read here (this relay runs on the user's machine with normal fs access),
// base64'd and streamed to the extension in chunks: upload_begin reserves a
// buffer, upload_chunk appends, upload_commit injects it into the page.
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const UPLOAD_CHUNK_CHARS = 600 * 1024; // base64 chars per native message

const MIME_BY_EXT = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", txt: "text/plain",
  md: "text/markdown", csv: "text/csv", json: "application/json", xml: "application/xml",
  html: "text/html", zip: "application/zip", mp4: "video/mp4", mp3: "audio/mpeg",
  wav: "audio/wav", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
function guessMime(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

async function uploadFile(args) {
  const path = String(args.path || "");
  let buf;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, error: "Not a file: " + path };
    if (st.size > UPLOAD_MAX_BYTES) return { ok: false, error: `File is ${st.size} bytes — over the 25 MB upload limit.` };
    buf = readFileSync(path);
  } catch (e) {
    return { ok: false, error: "Can't read " + path + ": " + ((e && e.message) || e) };
  }
  const name = basename(path);
  const mime = String(args.mimeType || "") || guessMime(name);
  const b64 = buf.toString("base64");

  const begin = await callHost("upload_begin", { name, mime, size: buf.length });
  if (!begin || begin.ok === false) return begin || { ok: false, error: "upload_begin failed" };
  const uploadId = begin.data && begin.data.uploadId;
  if (!uploadId) return { ok: false, error: "upload_begin returned no uploadId" };

  for (let off = 0; off < b64.length; off += UPLOAD_CHUNK_CHARS) {
    const chunk = await callHost("upload_chunk", { uploadId, data: b64.slice(off, off + UPLOAD_CHUNK_CHARS) });
    if (!chunk || chunk.ok === false) {
      // Best-effort: free the staged buffer on the extension side right away
      // instead of leaving a partial multi-MB upload for the gc sweep.
      callHost("upload_abort", { uploadId });
      return chunk || { ok: false, error: "upload_chunk failed" };
    }
  }

  return callHost("upload_commit", { uploadId, selector: args.selector, tabId: args.tabId });
}

function toolResult(name, data) {
  if (name === "browser_screenshot" && data && data.dataUrl) {
    return { content: [{ type: "image", data: String(data.dataUrl).replace(/^data:image\/png;base64,/, ""), mimeType: "image/png" }] };
  }
  const full = (typeof data === "string" ? data : JSON.stringify(data, null, 2)) || "";
  // Mark truncation explicitly — a silently cut DOM/JSON reads as complete and
  // the model never knows to ask for a scoped selector or a smaller limit.
  const text =
    full.length > 100000
      ? full.slice(0, 100000) + "\n…[truncated " + (full.length - 100000) + " chars — narrow with a selector or a smaller limit]"
      : full;
  return { content: [{ type: "text", text }] };
}

connect();
