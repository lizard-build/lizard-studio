"use strict";
// Side-panel shell. The Claude Code chat is the only surface now (the terminal
// view is kept in the codebase but disabled in the UI). We mount the chat and
// keep a port open to the service worker so it can ask us to close.

(function () {
  let faviconCount = 0;
  let faviconLogo = null;
  function updateFavicon(count) {
    if (!Number.isSafeInteger(count) || count < 0) return;
    faviconCount = count;
    const icon = document.getElementById("studio-favicon");
    if (!icon) return;
    const plainIcon = chrome.runtime.getURL("icons/icon48.png");
    if (!count) { icon.href = plainIcon; return; }
    if (!faviconLogo) {
      faviconLogo = new Image();
      // Use the latest count if sessions change while the logo loads.
      faviconLogo.onload = () => updateFavicon(faviconCount);
      faviconLogo.onerror = () => { faviconLogo = null; icon.href = plainIcon; };
      faviconLogo.src = plainIcon;
      return;
    }
    if (!faviconLogo.complete || !faviconLogo.naturalWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(faviconLogo, 0, 0, 32, 32);
    const text = count > 999 ? "999+" : String(count);
    ctx.font = `bold ${text.length > 2 ? 10 : 16}px sans-serif`;
    const width = Math.min(32, Math.max(18, Math.ceil(ctx.measureText(text).width) + 6));
    ctx.fillStyle = "#fbbf24";
    ctx.beginPath();
    ctx.roundRect(32 - width, 15, width, 17, 5);
    ctx.fill();
    ctx.fillStyle = "#121212";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 32 - width / 2, 24, width - 4);
    icon.href = canvas.toDataURL("image/png");
  }

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
    bg.onMessage.addListener((m) => {
      if (!m) return;
      if (m.cmd === "close") window.close();
      else if (m.cmd === "sessionActivity") updateFavicon(m.count);
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
      updateFavicon(0);
      window.RKChat?.setLiveSelection(null);
      void chrome.runtime.lastError; // read it, or every SW recycle logs "Unchecked runtime.lastError"
      setTimeout(connectBg, 500);
    });
    (window.RKPanelWindow?.sourceWindow || chrome.windows.getCurrent)((win) => {
      if (disconnected || chrome.runtime.lastError || !win || !Number.isInteger(win.id)) return;
      try {
        bg.postMessage({ type: "panelReady", windowId: win.id });
        activityPort = bg;
        sendActivity();
      } catch (_) {}
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
        window.RKPanelStartup?.mark("restored");
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
