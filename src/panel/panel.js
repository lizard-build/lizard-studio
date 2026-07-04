"use strict";
// Side-panel shell. The Claude Code chat is the only surface now (the terminal
// view is kept in the codebase but disabled in the UI). We mount the chat and
// keep a port open to the service worker so it can ask us to close.

(function () {
  const chatEl = document.getElementById("view-chat");
  if (chatEl && window.RKChat) {
    window.RKChat.mount(chatEl);
    if (window.RKChat.activate) window.RKChat.activate();
  }

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
    try {
      bg = chrome.runtime.connect({ name: "rk-sidepanel" });
    } catch (_) {
      setTimeout(connectBg, 500);
      return;
    }
    bg.onMessage.addListener((m) => {
      if (!m) return;
      if (m.cmd === "close") window.close();
      else if (m.cmd === "pickElement" && window.RKChat && window.RKChat.addContext) {
        window.RKChat.addContext(m.element);
      }
      else if (m.cmd === "addImage" && window.RKChat && window.RKChat.addImage) {
        window.RKChat.addImage(m.dataUrl);
      }
    });
    bg.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // read it, or every SW recycle logs "Unchecked runtime.lastError"
      setTimeout(connectBg, 500);
    });
  }
  connectBg();
})();
