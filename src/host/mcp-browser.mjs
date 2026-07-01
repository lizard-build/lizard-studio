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

const PORT = parseInt(process.env.RK_BRIDGE_PORT || "0", 10);
const SESSION = process.env.RK_BRIDGE_SESSION || "default";

// Every tab-scoped tool accepts this: omit to use the user's active tab.
const TAB_ID = { type: "number", description: "Target tab id (from browser_tabs). Omit to use the user's active tab. Works on background tabs without switching to them." };

const TOOLS = [
  {
    name: "browser_tabs",
    description:
      "List ALL open browser tabs across every window: tabId, windowId, title, URL, and which one is active. Pass a tabId to any other browser_* tool to work with that tab (no need to switch to it), or use browser_tab_activate to bring it to the front for the user.",
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
      "Return recent console messages (log/info/warn/error) and uncaught exceptions from a tab (active tab unless tabId is given). NOTE: capture starts when these tools first attach to the tab, so reload the page or re-trigger the code to capture earlier logs.",
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
      "Return recent network requests (URL, method, status, type, mime) from a tab (active tab unless tabId is given). NOTE: capture starts when these tools first attach, so reload the page or re-trigger the request to capture it.",
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
  });
}

function callHost(op, args) {
  return new Promise((resolve) => {
    connect();
    const reqId = nextReq++;
    pending.set(reqId, resolve);
    const payload = JSON.stringify({ reqId, op, args, session: SESSION }) + "\n";
    let tries = 0;
    const trySend = () => {
      if (connected && sock) {
        try {
          sock.write(payload);
        } catch {
          /* ignore */
        }
      } else if (tries++ < 120) {
        connect();
        setTimeout(trySend, 50);
      }
    };
    trySend();
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        resolve({ ok: false, error: "browser bridge timed out (is the Lizard side panel open?)" });
      }
    }, 30000);
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

function toolResult(name, data) {
  if (name === "browser_screenshot" && data && data.dataUrl) {
    return { content: [{ type: "image", data: String(data.dataUrl).replace(/^data:image\/png;base64,/, ""), mimeType: "image/png" }] };
  }
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: (text || "").slice(0, 100000) }] };
}

connect();
