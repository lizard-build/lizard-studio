"use strict";

// Native ports belong to the worker, never to a disposable panel page.
// Each window keeps its own host and browser-tool state.
globalThis.createStudioSessions = function ({ chrome, createBrowser, activity, prefsStore, resultStatus = () => {} }) {
  const runtimes = new Map();
  const panels = () => [...runtimes.values()].flatMap((r) => [...r.panels]);
  const ownerOf = (id) => [...runtimes.values()].find((r) => r.sessions.has(id));
  const stateFor = (s, panel) => ({ id: s.id, agent: s.agent, spec: s.spec, sessionId: s.sessionId,
    observer: s.controller !== panel, started: s.started, running: s.running, turnStartedAt: s.turnStartedAt, failed: s.failed,
    submitted: s.submitted, queue: s.queue.map((entry) => entry.ui), turnIds: [...s.turnIds] });
  function startTurn(s, startedAt = Date.now()) {
    if (!s.running) s.turnStartedAt = startedAt;
    s.running = true;
  }
  function roles(s) {
    for (const panel of panels()) send(panel, { type: "sessionRole", id: s.id, observer: s.controller !== panel });
  }

  const send = (port, message) => { try { port.postMessage(message); } catch (_) {} };
  const busy = (s) => s.running || s.permissions.size > 0 || s.queue.length > 0 || s.pendingPrompts.size > 0;
  const count = (r) => [...r.sessions.values()].filter((s) => (s.running || s.pendingPrompts.size > 0 || s.queue.length > 0 && !s.queue[0]?.held) && !s.permissions.size && !s.failed).length;
  function update() { activity([...runtimes.values()].reduce((n, r) => n + count(r), 0)); }
  function remember(r) {
    // Hosts save transcripts. Persist the thread id as soon as it arrives, even
    // when the panel closed before the first reply. Do not rewrite UI drafts.
    if (prefsStore) return prefsStore.update((prefs) => {
      const tabs = [...(prefs.tabs || [])];
      for (const s of r.sessions.values()) {
        if (!s.sessionId || !s.submitted) continue;
        const index = tabs.findIndex((t) => t.id === s.id);
        if (index >= 0) tabs[index] = { ...tabs[index], sessionId: s.sessionId, queue: s.queue.map((entry) => entry.ui) };
      }
      return { ...prefs, tabs };
    }).catch((error) => console.error("[Studio] Save session", error));
    r.saving = r.saving.then(() => new Promise((resolve) => {
      chrome.storage.local.get(["rkChatV2"], (data) => {
        const prefs = data?.rkChatV2 || {};
        const tabs = [...(prefs.tabs || [])];
        for (const s of r.sessions.values()) {
          if (!s.sessionId || !s.submitted) continue;
          const index = tabs.findIndex((t) => t.id === s.id);
          const patch = { sessionId: s.sessionId, queue: s.queue.map((entry) => entry.ui) };
          if (index >= 0) tabs[index] = { ...tabs[index], ...patch };
          else tabs.push({ id: s.id, harness: s.agent, cwd: s.spec.cwd, model: s.spec.model, mode: s.spec.permissionMode, ...patch });
        }
        chrome.storage.local.set({ rkChatV2: { ...prefs, tabs } }, () => { void chrome.runtime.lastError; resolve(); });
      });
    })).catch((error) => console.error("[Studio] Save session", error));
    return r.saving;
  }
  function releaseIfIdle(r) {
    clearTimeout(r.idleTimer);
    if (panels().length || [...r.sessions.values()].some(busy) || r.browserCalls) return;
    // Let trailing usage/error messages and an immediate reopen settle first.
    r.idleTimer = setTimeout(async () => {
      await remember(r);
      if (panels().length || [...r.sessions.values()].some(busy) || r.browserCalls) return;
      if (runtimes.get(r.windowId) !== r) return;
      runtimes.delete(r.windowId);
      r.browser.detachAllCdp();
      r.native.disconnect();
      update();
    }, 1000);
  }
  function getSession(r, msg) {
    if (!msg.id) return null;
    let s = r.sessions.get(msg.id);
    if (!s) {
      if (!["start", "restartSession", "prompt"].includes(msg.type) &&
          !(msg.type === "backgroundQueue" && msg.entries?.length)) return null;
      s = { id: msg.id, agent: msg.agent || "claude", spec: {}, running: false, turnStartedAt: 0, started: false,
        submitted: false, failed: false, queue: [], sessionId: null, journal: [], pendingPrompts: new Map(), historyRequests: [], turnIds: new Set(), permissions: new Map() };
      r.sessions.set(msg.id, s);
    }
    return s;
  }
  function drain(r, s) {
    if (s.controller || s.running || s.pendingPrompts.size || s.permissions.size || s.failed || !s.queue.length || s.queue[0].held) return;
    const entry = s.queue.shift();
    forward(r, entry.message);
  }
  function receive(r, msg) {
    if (!msg || typeof msg !== "object") return;
    if (runtimes.get(r.windowId) !== r) return;
    if (msg.type === "browser") {
      ++r.browserCalls;
      r.browser.handleBrowserOp(msg, (reply) => send(r.native, reply)).finally(() => {
        --r.browserCalls; releaseIfIdle(r);
      });
      return;
    }
    if (["ready", "agentReady", "models", "planUsage"].includes(msg.type)) r.ready.set(msg.type + (msg.agent || ""), msg);
    const s = getSession(r, msg);
    if (s) {
      if (msg.type === "started") { s.started = true; s.spec = { ...s.spec, cwd: msg.cwd || s.spec.cwd }; }
      if (msg.type === "event" && msg.data?.subtype === "init") {
        s.sessionId = msg.data.session_id || s.sessionId;
        s.started = true;
        if (!r.panels.size) remember(r);
      }
      if (msg.turnId) s.turnIds.add(msg.turnId);
      if (msg.turnId || msg.type === "event" && msg.data?.type === "result") {
        for (const request of s.historyRequests.splice(0)) send(r.native, {
          ...request, excludeTurnIds: [...new Set([...(request.excludeTurnIds || []), ...s.turnIds])],
        });
      }
      if (msg.type === "turnStarted") {
        startTurn(s, [...s.pendingPrompts.values()][0]?.startedAt);
        msg = { ...msg, turnStartedAt: s.turnStartedAt };
      }
      if (msg.type === "promptResult") {
        const pending = s.pendingPrompts.get(msg.requestId);
        if (pending) {
          s.pendingPrompts.delete(msg.requestId);
          pending.entry.accepted = !!msg.ok;
          if (msg.ok) {
            if (msg.startedTurn) startTurn(s, pending.startedAt);
            for (const panel of panels()) if (panel !== pending.origin) send(panel, { type: "sharedPrompt", message: pending.entry });
            s.queue = s.queue.filter((q) => q.ui.backgroundId !== pending.queueId || !pending.queueId);
            for (const panel of panels()) if (panel !== pending.origin) send(panel, { type: "sharedQueue", id: s.id, entries: s.queue.map((entry) => entry.ui) });
          } else {
            const queued = s.queue.find((q) => pending.queueId && q.ui.backgroundId === pending.queueId);
            if (queued) { queued.held = true; queued.ui.steerFailed = true; }
          }
        }
      }
      if (msg.type === "permission") s.permissions.set(msg.requestId, msg);
      if (msg.type === "permissionCancel") s.permissions.delete(msg.requestId);
      // Only Codex uses turn ids to separate replay from older history. Keep
      // all event bytes within this turn; never truncate a completed answer.
      if (s.agent === "codex" && ["event", "error", "promptResult"].includes(msg.type)
          && !(msg.type === "event" && msg.data?.subtype === "init")) s.journal.push(msg);
      if (msg.type === "event" && msg.data?.type === "result" || msg.type === "interrupted" || msg.type === "exit") {
        if (msg.type === "event") resultStatus(s.id, true);
        s.running = false;
        s.failed = !!msg.data?.is_error || msg.type === "exit" || msg.type === "interrupted";
        s.permissions.clear();
        if (msg.type === "exit") { s.started = false; s.pendingPrompts.clear(); }
        if (!r.panels.size) remember(r);
      }
    }
    if (msg.type === "agentExit") {
      r.ready.set("agentReady" + msg.agent, { type: "agentReady", agent: msg.agent, ok: false });
      for (const item of r.sessions.values()) if (item.agent === msg.agent) {
        item.running = false; item.started = false; item.failed = true; item.permissions.clear(); item.pendingPrompts.clear();
      }
    }
    for (const panel of s ? panels() : r.panels) {
      send(panel, s && panel !== s.controller ? { type: "sharedEvent", message: msg } : msg);
    }
    if (s) drain(r, s);
    update(); releaseIfIdle(r);
  }
  function create(windowId) {
    const r = { windowId, panels: new Set(), sessions: new Map(), ready: new Map(),
      saving: Promise.resolve(), idleTimer: null, browserCalls: 0 };
    r.browser = createBrowser({ windowId });
    r.native = chrome.runtime.connectNative("com.lizard.code");
    runtimes.set(windowId, r);
    r.native.onMessage.addListener((msg) => receive(r, msg));
    r.native.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (runtimes.get(windowId) !== r) return;
      for (const session of r.sessions.values()) for (const panel of panels()) {
        if (!r.panels.has(panel)) send(panel, { type: "sharedEvent", message: { type: "exit", id: session.id, code: 1 } });
      }
      runtimes.delete(windowId); clearTimeout(r.idleTimer);
      r.browser.detachAllCdp();
      remember(r);
      for (const panel of r.panels) { try { panel.disconnect(); } catch (_) {} }
      update();
    });
    return r;
  }
  function attach(port, windowId) {
    let r;
    try { r = runtimes.get(windowId) || create(windowId); }
    catch (_) { port.disconnect(); return null; }
    clearTimeout(r.idleTimer);
    r.panels.add(port);
    // An ordered snapshot precedes new live messages on the same port. Replays
    // only paint the UI; no permission, prompt or browser action is repeated.
    const allSessions = [...runtimes.values()].flatMap((item) => [...item.sessions.values()]);
    for (const s of allSessions) if (!s.controller) s.controller = port;
    send(port, { type: "backgroundRestoreStart", sessions: allSessions.map((s) => stateFor(s, port)) });
    for (const msg of r.ready.values()) send(port, msg);
    for (const s of allSessions) {
      for (const msg of s.agent === "codex" ? s.journal : []) {
        if (msg.type === "backgroundPrompt" && msg.accepted === false) continue;
        send(port, { type: "backgroundReplay", message: msg });
      }
      for (const msg of s.permissions.values()) send(port, { type: "backgroundReplay", message: msg });
    }
    send(port, { type: "backgroundRestoreEnd" });
    return r;
  }
  function forward(r, msg, origin = null) {
    r = ownerOf(msg.id) || r;
    const existing = r.sessions.get(msg.id);
    if (msg.type === "start" && existing?.started && origin && existing.controller !== origin) {
      send(origin, { type: "sharedSession", session: stateFor(existing, origin) });
      return;
    }
    if (msg.type === "sessionClaim") {
      if (existing && origin) { existing.controller = origin; roles(existing); }
      return;
    }
    if (msg.type === "permissionResult" && existing && !existing.permissions.has(msg.requestId)) return;
    if (msg.type === "backgroundQueue" && existing?.controller && existing.controller !== origin) return;
    if (["prompt", "restartSession", "close", "stop"].includes(msg.type) || msg.type === "start" && !msg.resume) resultStatus(msg.id, false);
    const s = getSession(r, msg);
    if (s && origin && (!s.controller || ["prompt", "restartSession"].includes(msg.type))) {
      s.controller = origin;
      roles(s);
    }
    if (msg.type === "backgroundQueue" && !s) return;
    if (s) {
      if (msg.type === "backgroundQueue") {
        s.agent = msg.agent || s.agent;
        s.queue = Array.isArray(msg.entries) ? msg.entries : [];
        for (const panel of panels()) if (panel !== origin) send(panel, { type: "sharedQueue", id: s.id, entries: s.queue.map((entry) => entry.ui) });
        update(); return;
      }
      if (msg.type === "start" || msg.type === "restartSession") {
        s.spec = { ...msg }; s.agent = msg.agent || s.agent;
        s.started = true; s.running = false; s.turnStartedAt = 0; s.failed = false; s.permissions.clear();
        s.sessionId = msg.resume || null;
        // A resumed thread already has history, even before another prompt.
        s.submitted = !!msg.resume;
        s.journal = []; s.turnIds.clear();
        for (const panel of panels()) if (panel !== origin) send(panel, { type: "sharedSession", session: stateFor(s, panel) });
      }
      if (msg.type === "prompt") {
        if (!s.running) { s.journal = []; s.turnIds.clear(); }
        s.submitted = true; s.failed = false;
        const entry = { type: "backgroundPrompt", id: s.id, text: msg.text, images: msg.images, questionReplyId: msg.questionReplyId, accepted: !msg.promptRequestId };
        if (msg.promptRequestId) s.pendingPrompts.set(msg.promptRequestId, { entry, queueId: msg.backgroundQueueId, origin, startedAt: Date.now() });
        else startTurn(s);
        if (s.agent === "codex") s.journal.push(entry);
        if (!msg.promptRequestId) for (const panel of panels()) if (panel !== origin) send(panel, { type: "sharedPrompt", message: entry });
      }
      if (msg.type === "permissionResult") {
        s.permissions.delete(msg.requestId);
        for (const panel of panels()) if (panel !== origin) send(panel, { type: "sharedEvent", message: { type: "permissionCancel", id: s.id, requestId: msg.requestId } });
      }
      if (msg.type === "loadTranscript" && s.agent === "codex") {
        // The panel owns the exclusions for its current rendering, not a newer
        // turn that might have started since it restored the snapshot.
        if (msg.backgroundRestore && s.running && !s.turnIds.size) {
          s.historyRequests.push(msg);
          return;
        }
        msg = { ...msg, excludeTurnIds: msg.excludeTurnIds || [] };
      }
      if (msg.type === "close" || msg.type === "stop") r.sessions.delete(msg.id);
    }
    send(r.native, msg);
    update(); releaseIfIdle(r);
  }
  function connect(port) {
    if (port.name !== "studio-session") return false;
    // Content scripts can also open runtime ports. Only the extension's panel
    // may read chats or send commands to a native host.
    if (port.sender?.id !== chrome.runtime.id ||
        port.sender?.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("src/panel/panel.html")) {
      port.disconnect(); return true;
    }
    let r = null;
    port.onMessage.addListener((msg) => {
      if (!r) {
        if (msg?.type === "attach" && Number.isInteger(msg.windowId) && msg.windowId >= 0) {
          r = attach(port, msg.windowId);
          if (Number.isInteger(msg.contextTabId)) r?.browser.setContextTab?.(msg.contextTabId);
        }
        return;
      }
      if (runtimes.get(r.windowId) === r && r.panels.has(port)) forward(r, msg, port);
    });
    port.onDisconnect.addListener(() => {
      if (!r) return;
      r.panels.delete(port);
      for (const runtime of runtimes.values()) {
        for (const s of runtime.sessions.values()) {
          if (s.controller === port) { s.controller = panels()[0] || null; roles(s); }
          drain(runtime, s);
        }
        releaseIfIdle(runtime);
      }
    });
    return true;
  }
  return { connect };
};
