"use strict";
// Side-panel shell. The Claude Code chat is the only surface now (the terminal
// view is kept in the codebase but disabled in the UI). We mount the chat and
// keep a port open to the service worker so it can ask us to close.

(function () {
  let activityPort = null;
  function sendActivity() {
    if (!activityPort) return;
    const count = window.RKChat?.getRunningChatCount?.() || 0;
    try { activityPort.postMessage({ type: "chatActivity", count }); } catch (_) {}
  }
  window.addEventListener("rk-chat-activity", sendActivity);
  // Re-send state and keep the worker connected while a panel owns live chats.
  setInterval(sendActivity, 20000);

  // ---- service-worker bridge ------------------------------------------------
  // Keep a port open so the worker knows this panel is alive and can ask us to
  // close (there's no chrome.sidePanel.close()). Reconnect across SW recycles.
  // Both failure paths retry on the same schedule: a connect() that *throws*
  // (transient during an extension update) must not silently kill the bridge
  // for the panel's whole lifetime. Only a truly invalidated extension context
  // stops the loop.
  function connectBg() {
    if (!(chrome.runtime && chrome.runtime.id)) return; // context invalidated — a reload gets a fresh panel
    let bg;
    let disconnected = false;
    try {
      bg = chrome.runtime.connect({ name: "rk-sidepanel" });
    } catch (_) {
      setTimeout(connectBg, 500);
      return;
    }
    chrome.windows.getCurrent((win) => {
      if (disconnected || chrome.runtime.lastError || !win || !Number.isInteger(win.id)) return;
      try {
        bg.postMessage({ type: "panelReady", windowId: win.id });
        activityPort = bg;
        sendActivity();
      } catch (_) {}
    });
    bg.onMessage.addListener((m) => {
      if (!m) return;
      if (m.cmd === "close") window.close();
      else if (m.cmd === "liveSelection") window.RKChat?.setLiveSelection(m.selection);
      else if (m.cmd === "pickElement" && window.RKChat && window.RKChat.addContext) {
        window.RKChat.addContext(m.element);
      }
      else if (m.cmd === "addImage" && window.RKChat && window.RKChat.addImage) {
        window.RKChat.addImage(m.dataUrl);
      }
    });
    bg.onDisconnect.addListener(() => {
      disconnected = true;
      if (activityPort === bg) activityPort = null;
      window.RKChat?.setLiveSelection(null);
      void chrome.runtime.lastError; // read it, or every SW recycle logs "Unchecked runtime.lastError"
      setTimeout(connectBg, 500);
    });
  }
  connectBg();
  // Keep closing/reconnecting available even if restoring the UI fails.
  try {
    const chatEl = document.getElementById("view-chat");
    if (!chatEl || !window.RKChat) throw new Error("Chat interface missing");
    window.RKPanelStartup?.mark("restore");
    window.RKChat.mount(chatEl, () => {
      try {
        if (window.RKChat.activate) window.RKChat.activate();
        window.RKPanelStartup?.ready();
      } catch (error) {
        window.RKPanelStartup?.fail(error);
      }
    });
  } catch (error) {
    window.RKPanelStartup?.fail(error);
  }
})();
