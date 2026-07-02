"use strict";
// Terminal view — the original xterm.js + `com.lizard.term` PTY terminal, kept as
// a secondary tab. Ported from the old sidepanel.js into a mountable module so the
// chat can be the primary surface. Exposes window.RKTerminal = { mount, activate, deactivate }.

(function () {
  const HOST_NAME = "com.lizard.term";
  const RECONNECT_MS = 1000;

  let term = null;
  let fitAddon = null;
  let port = null;
  let connected = false;
  let reconnectTimer = null;
  let mounted = false;
  let resizeObserver = null;
  let els = {};

  // ---- base64 <-> bytes (PTY traffic is raw bytes) ----
  function bytesToB64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  function b64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function showTerminal() {
    els.onboarding.classList.add("hidden");
    els.screen.classList.remove("hidden");
    requestAnimationFrame(() => {
      doFit();
      term.focus();
    });
  }
  function showOnboarding(message) {
    els.screen.classList.add("hidden");
    els.onboarding.classList.remove("hidden");
    els.dot.classList.remove("ok");
    if (message) els.statusText.textContent = message;
  }

  function doFit() {
    try {
      fitAddon.fit();
    } catch (_) {
      return;
    }
    if (connected && port) {
      port.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
    }
  }

  function connect() {
    clearTimeout(reconnectTimer);
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      scheduleReconnect();
      return;
    }
    port.onMessage.addListener((msg) => {
      if (!connected) {
        connected = true;
        els.dot.classList.add("ok");
        els.statusText.textContent = "Connected.";
        showTerminal();
        port.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
      }
      if (msg.type === "stdout") {
        term.write(b64ToBytes(msg.data));
      } else if (msg.type === "exit") {
        term.write(`\r\n\x1b[90m[process exited: ${msg.code}]\x1b[0m\r\n`);
      }
    });
    port.onDisconnect.addListener(() => {
      // Read lastError so Chrome doesn't log "Unchecked runtime.lastError"
      // (e.g. "Specified native messaging host not found" when the host isn't installed).
      const lastErr = chrome.runtime.lastError;
      port = null;
      if (connected) {
        connected = false;
        term.write("\r\n\x1b[90m[disconnected — reconnecting…]\x1b[0m\r\n");
        showOnboarding("Helper disconnected. Reconnecting…");
      } else {
        showOnboarding(lastErr && lastErr.message);
      }
      scheduleReconnect();
    });
  }
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  }

  function mount(root) {
    els.root = root;
    root.innerHTML = TEMPLATE;
    els.onboarding = root.querySelector("#term-onboarding");
    els.screen = root.querySelector("#term-screen");
    els.dot = root.querySelector("#term-status-dot");
    els.statusText = root.querySelector("#term-status-text");
    els.copyBtn = root.querySelector("#term-copy-btn");
    els.installCmd = root.querySelector("#term-install-cmd");
    els.termHost = root.querySelector("#terminal");

    term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: "#070707",
        foreground: "#e9edf4",
        cursor: "#10b981",
        cursorAccent: "#070707",
        selectionBackground: "rgba(16, 185, 129, 0.3)",
        black: "#141414",
        brightBlack: "#5f646d",
        green: "#10b981",
        brightGreen: "#34d399",
        red: "#ef4444",
        brightRed: "#f87171",
        yellow: "#f59e0b",
        brightYellow: "#fbbf24",
        blue: "#3b82f6",
        brightBlue: "#60a5fa",
        white: "#858b94",
        brightWhite: "#e9edf4",
      },
      scrollback: 5000,
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(els.termHost);

    term.onData((data) => {
      if (connected && port) {
        const bytes = new TextEncoder().encode(data);
        port.postMessage({ type: "stdin", data: bytesToB64(bytes) });
      }
    });

    resizeObserver = new ResizeObserver(() => doFit());
    resizeObserver.observe(els.termHost);

    els.copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(els.installCmd.textContent.trim());
        els.copyBtn.textContent = "Copied!";
        setTimeout(() => (els.copyBtn.textContent = "Copy"), 1500);
      } catch (_) {}
    });

    mounted = true;
  }

  let started = false;
  function activate() {
    if (!started) {
      started = true;
      connect();
    }
    requestAnimationFrame(() => {
      if (mounted) {
        doFit();
        if (connected) term.focus();
      }
    });
  }
  function deactivate() {
    // keep PTY alive in the background
  }

  const TEMPLATE = `
    <section id="term-onboarding" class="screen">
      <div class="onboarding-inner">
        <h1>Lizard Terminal</h1>
        <p class="lead">Install the local helper that runs your shell.</p>
        <div class="cmd-row">
          <code id="term-install-cmd">curl -fsSL https://lizard.build/term/install.sh | sh</code>
          <button id="term-copy-btn">Copy</button>
        </div>
        <p class="hint">Paste it into your terminal and run it. This panel switches to your shell automatically.</p>
        <div class="status"><span class="dot" id="term-status-dot"></span><span id="term-status-text">Waiting for the helper…</span></div>
      </div>
    </section>
    <section id="term-screen" class="screen hidden"><div id="terminal"></div></section>
  `;

  window.RKTerminal = { mount, activate, deactivate };
})();
