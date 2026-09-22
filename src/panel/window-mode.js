"use strict";

// A detached view still belongs to the browser window it came from. Both the
// native session and page context must use that window, never the popup itself.
(function () {
  const params = new URLSearchParams(location.search);
  const detached = params.get("mode") === "window";
  const rawSource = params.get("sourceWindowId");
  const sourceId = rawSource !== null && /^\d+$/.test(rawSource) ? Number(rawSource) : null;
  const panelURL = chrome.runtime.getURL("src/panel/panel.html");
  let opening = null;

  function sourceWindow(callback) {
    if (!detached) return chrome.windows.getCurrent(callback);
    if (!Number.isSafeInteger(sourceId)) return callback(null);
    chrome.windows.get(sourceId, (win) => {
      if (chrome.runtime.lastError || win?.type !== "normal") return callback(null);
      callback(win);
    });
  }
  const call = (invoke) => new Promise((resolve, reject) => invoke((value) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(value);
  }));

  async function move(save) {
    const source = await new Promise(sourceWindow);
    if (!source) throw new Error("The original browser window is closed. Open Lizard Studio from another browser window.");
    await save();
    const token = crypto.randomUUID();
    const url = panelURL + "?mode=window&sourceWindowId=" + source.id + "&handoff=" + token;
    // Listen before opening: a warm extension page may mount very quickly.
    let timer, listener;
    const ready = new Promise((resolve, reject) => {
      listener = (msg, sender) => {
        if (sender.id === chrome.runtime.id && sender.url === url &&
            msg?.type === "studioWindowReady" && msg.handoff === token) resolve();
      };
      chrome.runtime.onMessage.addListener(listener);
      timer = setTimeout(() => reject(new Error("The new window has not finished opening. Your side panel is still open.")), 20000);
    });
    // The window API can fail before ready is awaited.
    ready.catch(() => {});
    try {
      const tabs = await call((done) => chrome.tabs.query({}, done));
      const existing = tabs.find((tab) => {
        if (tab.url?.split(/[?#]/)[0] !== panelURL) return false;
        const query = new URL(tab.url).searchParams;
        return query.get("mode") === "window" && query.get("sourceWindowId") === String(source.id);
      });
      if (existing) {
        await call((done) => chrome.tabs.update(existing.id, { url }, done));
        await call((done) => chrome.windows.update(existing.windowId, { focused: true }, done));
      } else {
        await call((done) => chrome.windows.create({ url, type: "popup", width: 1100, height: 800, focused: true }, done));
      }
      await ready;
      window.close();
    } finally {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
    }
  }

  window.RKPanelWindow = {
    detached,
    sourceWindow,
    open(save) {
      if (detached) return Promise.resolve();
      if (!opening) opening = move(save).finally(() => { opening = null; });
      return opening;
    },
    ready() {
      const handoff = params.get("handoff");
      if (detached && handoff) chrome.runtime.sendMessage({ type: "studioWindowReady", handoff }, () => void chrome.runtime.lastError);
    },
  };
})();
