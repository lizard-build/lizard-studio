"use strict";

(function () {
  const params = new URLSearchParams(location.search);
  const detached = ["tab", "window"].includes(params.get("mode"));
  const id = (key) => /^\d+$/.test(params.get(key) || "") ? Number(params.get(key)) : null;
  const sourceId = id("sourceWindowId"), sourceTabId = id("sourceTabId");
  const panelURL = chrome.runtime.getURL("src/panel/panel.html");
  const trusted = (sender) => sender.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === panelURL;
  let opening = null, docking = null, receipt = params.get("handoff"), mounted = false, transferring = false;
  const call = (invoke) => new Promise((resolve, reject) => invoke((value) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(value);
  }));
  const message = (msg) => new Promise(resolve => chrome.runtime.sendMessage(msg, result => {
    void chrome.runtime.lastError; resolve(result);
  }));
  function sourceWindow(callback) {
    if (!detached) return chrome.windows.getCurrent(callback);
    if (!Number.isSafeInteger(sourceId)) return callback(null);
    chrome.windows.get(sourceId, win => callback(chrome.runtime.lastError || win?.type !== "normal" ? null : win));
  }
  async function activeTab() {
    const source = await new Promise(sourceWindow);
    if (!source) return null;
    const tabs = await call(done => chrome.tabs.query({ active: true, windowId: source.id }, done));
    const tab = tabs[0];
    if (tab?.url?.split(/[?#]/)[0] !== panelURL) return tab || null;
    if (sourceTabId == null) return null;
    const original = await call(done => chrome.tabs.get(sourceTabId, done)).catch(() => null);
    return original?.windowId === source.id ? original : null;
  }
  function waitReady(token, accepts) {
    let timer;
    const listener = (msg, sender) => {
      if (trusted(sender) && msg?.type === "studioWindowReady" && msg.handoff === token && accepts(msg, sender)) finish();
    };
    let finish;
    const promise = new Promise((resolve, reject) => {
      finish = resolve;
      chrome.runtime.onMessage.addListener(listener);
      timer = setTimeout(() => reject(new Error("The new view has not finished opening. Your current view is still open.")), 20000);
    });
    promise.catch(() => {});
    return { promise, dispose() { clearTimeout(timer); chrome.runtime.onMessage.removeListener(listener); } };
  }
  async function undock(save) {
    const source = await new Promise(sourceWindow);
    if (!source) throw new Error("The original browser window is closed.");
    const context = await activeTab();
    await save();
    const token = crypto.randomUUID();
    const url = panelURL + "?mode=tab&sourceWindowId=" + source.id + (context ? "&sourceTabId=" + context.id : "") + "&handoff=" + token;
    const ready = waitReady(token, (_, sender) => sender.url === url);
    try {
      const tabs = await call(done => chrome.tabs.query({ windowId: source.id }, done));
      const existing = tabs.find(tab => tab.url?.split(/[?#]/)[0] === panelURL && new URL(tab.url).searchParams.get("mode") === "tab" && new URL(tab.url).searchParams.get("sourceWindowId") === String(source.id));
      if (existing) await call(done => chrome.tabs.update(existing.id, { url, active: true }, done));
      else await call(done => chrome.tabs.create({ url, windowId: source.id, active: true }, done));
      await ready.promise;
      transferring = true;
      window.close();
    } finally { ready.dispose(); }
  }
  // Invoke sidePanel.open directly in the click handler's call stack. Waiting
  // for storage first can lose Chrome's user gesture. The receiving panel waits
  // for the save before it loads chats, then acknowledges its first render.
  function dock(save) {
    if (!Number.isSafeInteger(sourceId)) return Promise.reject(new Error("The original browser window is closed."));
    const token = crypto.randomUUID();
    const ready = waitReady(token, (msg, sender) => !sender.tab && msg.sourceWindowId === sourceId);
    let opened;
    try { opened = chrome.sidePanel.open({ windowId: sourceId }); }
    catch (error) { ready.dispose(); return Promise.reject(error); }
    const saved = Promise.resolve().then(save);
    docking = { token, saved };
    return (async () => {
      try {
        await Promise.all([opened, saved]);
        await message({ type: "studioDockReload", sourceWindowId: sourceId, handoff: token });
        await ready.promise;
        if (sourceTabId != null) await call(done => chrome.tabs.update(sourceTabId, { active: true }, done)).catch(() => {});
        const tab = await call(done => chrome.tabs.getCurrent(done));
        if (!tab) throw new Error("Could not find the Studio tab to close.");
        transferring = true;
        try { await call(done => chrome.tabs.remove(tab.id, done)); }
        catch (error) { transferring = false; throw error; }
      } finally { docking = null; ready.dispose(); }
    })();
  }
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!trusted(sender)) return;
    if (detached && docking && !sender.tab && msg?.type === "studioDockState" && msg.sourceWindowId === sourceId) {
      const state = docking;
      state.saved.then(() => respond({ handoff: state.token }), () => respond({ error: "Could not save chats." }));
      return true;
    }
    if (!detached && mounted && sender.tab && msg?.type === "studioDockReload") {
      sourceWindow(win => { if (win?.id === msg.sourceWindowId && receipt !== msg.handoff) { transferring = true; location.reload(); } });
    }
  });
  window.RKPanelWindow = {
    detached, sourceTabId, sourceWindow, activeTab,
    get transferring() { return transferring; },
    async prepare() {
      if (detached) return;
      const win = await new Promise(sourceWindow);
      const result = await message({ type: "studioDockState", sourceWindowId: win?.id });
      if (result?.error) throw new Error(result.error);
      receipt = result?.handoff || null;
    },
    open(save) {
      if (!opening) opening = (detached ? dock(save) : undock(save)).finally(() => { opening = null; });
      return opening;
    },
    ready() {
      mounted = true;
      if (receipt) sourceWindow(win => message({ type: "studioWindowReady", handoff: receipt, sourceWindowId: win?.id }));
    },
  };
})();
