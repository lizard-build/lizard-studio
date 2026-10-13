"use strict";

(function () {
  const params = new URLSearchParams(location.search);
  const detached = ["tab", "window"].includes(params.get("mode"));
  const id = (key) => /^\d+$/.test(params.get(key) || "") ? Number(params.get(key)) : null;
  const sourceId = id("sourceWindowId"), sourceTabId = id("sourceTabId");
  const panelURL = chrome.runtime.getURL("src/panel/panel.html");
  const trusted = (sender) => sender.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === panelURL;
  let opening = null, receipt = params.get("handoff"), mounted = false, transferring = false, reloadOnMount = false;
  // A Studio tab moving into the side panel leaves a note in session storage:
  // its handoff token, and whether its chats are saved yet. The side panel
  // reads the note at startup instead of messaging every extension page and
  // waiting for all of them, which stalled startup while the background worker
  // was waking or another view was busy.
  const DOCK_KEY = "studioDock:", HANDOFF_MS = 20000, SAVE_WAIT_MS = 3000;
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
      timer = setTimeout(() => reject(new Error("The new view has not finished opening. Your current view is still open.")), HANDOFF_MS);
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
  // for storage first can lose Chrome's user gesture. The note goes out in the
  // same turn, so it is there before the panel starts; the panel waits for the
  // note to say "saved" before it loads chats, then acknowledges its render.
  function dock(save) {
    if (!Number.isSafeInteger(sourceId)) return Promise.reject(new Error("The original browser window is closed."));
    const token = crypto.randomUUID();
    const ready = waitReady(token, (msg, sender) => !sender.tab && msg.sourceWindowId === sourceId);
    let opened;
    try { opened = chrome.sidePanel.open({ windowId: sourceId }); }
    catch (error) { ready.dispose(); return Promise.reject(error); }
    const key = DOCK_KEY + sourceId;
    const note = (saved) => call(done => chrome.storage.session.set({ [key]: { handoff: token, saved, at: Date.now() } }, done));
    const noted = note(false);
    const saved = Promise.resolve().then(save).then(() => noted).then(() => note(true));
    return (async () => {
      try {
        await Promise.all([opened, saved]);
        // A side panel that was already open loaded the chats before this
        // save, so it reloads. Nobody answers this message: don't wait on it.
        chrome.runtime.sendMessage({ type: "studioDockReload", sourceWindowId: sourceId, handoff: token }, () => void chrome.runtime.lastError);
        await ready.promise;
        if (sourceTabId != null) await call(done => chrome.tabs.update(sourceTabId, { active: true }, done)).catch(() => {});
        const tab = await call(done => chrome.tabs.getCurrent(done));
        if (!tab) throw new Error("Could not find the Studio tab to close.");
        transferring = true;
        try { await call(done => chrome.tabs.remove(tab.id, done)); }
        catch (error) { transferring = false; throw error; }
      } finally {
        ready.dispose();
        chrome.storage.session.remove(key, () => void chrome.runtime.lastError);
      }
    })();
  }
  // The handoff token, once the moving tab's note says its chats are saved.
  // No fresh note means no move: start at once. A note that stays unsaved
  // past SAVE_WAIT_MS lets the panel start anyway; the tab's reload message
  // then restarts it on the saved chats.
  function dockReceipt(key) {
    return new Promise((resolve) => {
      let timer = null, done = false;
      const fresh = (note) => note && typeof note.handoff === "string" && Date.now() - note.at < HANDOFF_MS;
      const finish = (note) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.storage.onChanged.removeListener(changed);
        resolve(fresh(note) && note.saved ? note.handoff : null);
      };
      const changed = (changes, area) => {
        if (area !== "session" || !(key in changes)) return;
        const note = changes[key].newValue;
        if (!fresh(note) || note.saved) finish(note);
      };
      chrome.storage.onChanged.addListener(changed);
      chrome.storage.session.get(key, (data) => {
        const note = chrome.runtime.lastError ? null : data?.[key];
        if (!fresh(note) || note.saved) finish(note);
        else if (!done) timer = setTimeout(() => finish(null), SAVE_WAIT_MS);
      });
    });
  }
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!trusted(sender)) return;
    if (!detached && sender.tab && msg?.type === "studioDockReload") {
      sourceWindow(win => {
        if (win?.id !== msg.sourceWindowId || receipt === msg.handoff) return;
        // Still starting without this move's receipt: its chats may predate
        // the save, so restart as soon as it can be done safely.
        if (!mounted) { reloadOnMount = true; return; }
        transferring = true;
        location.reload();
      });
    }
  });
  window.RKPanelWindow = {
    detached, sourceTabId, sourceWindow, activeTab,
    get transferring() { return transferring; },
    async prepare() {
      if (detached) return;
      const win = await new Promise(sourceWindow);
      receipt = Number.isInteger(win?.id) ? await dockReceipt(DOCK_KEY + win.id) : null;
    },
    open(save) {
      if (!opening) opening = (detached ? dock(save) : undock(save)).finally(() => { opening = null; });
      return opening;
    },
    ready() {
      mounted = true;
      if (reloadOnMount) { transferring = true; location.reload(); return; }
      if (receipt) sourceWindow(win => message({ type: "studioWindowReady", handoff: receipt, sourceWindowId: win?.id }));
    },
  };
})();
