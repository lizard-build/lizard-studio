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
  function connectBg() {
    let bg;
    try {
      bg = chrome.runtime.connect({ name: "rk-sidepanel" });
    } catch (_) {
      return;
    }
    bg.onMessage.addListener((m) => {
      if (!m) return;
      if (m.cmd === "close") window.close();
      else if (m.cmd === "pickElement" && window.RKChat && window.RKChat.addContext) {
        window.RKChat.addContext(m.element);
      }
    });
    bg.onDisconnect.addListener(() => setTimeout(connectBg, 500));
  }
  connectBg();
})();
