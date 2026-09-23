"use strict";
// Side-panel shell. The Claude Code chat is the only surface now (the terminal
// view is kept in the codebase but disabled in the UI). We mount the chat and
// keep a port open to the service worker so it can ask us to close.

(function () {
  let faviconCount = 0;
  let faviconUnread = 0;
  let faviconLogo = null;
  function setFavicon(href) {
    const previous = document.getElementById("studio-favicon");
    if (previous?.href === href) return;
    const icon = document.createElement("link");
    icon.id = "studio-favicon";
    icon.rel = "icon";
    icon.type = "image/png";
    icon.href = href;
    // Replace the candidate so Chrome refreshes the tab icon. Also support a
    // panel whose HTML loaded before the favicon link was added in an update.
    if (previous) previous.replaceWith(icon);
    else document.head.appendChild(icon);
  }
  function updateFavicon(count, unread = 0) {
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(unread) || unread < 0) return;
    faviconCount = count;
    faviconUnread = unread;
    const badgeCount = count || unread;
    const plainIcon = chrome.runtime.getURL("icons/icon48.png");
    if (!badgeCount) { setFavicon(plainIcon); return; }
    if (!faviconLogo) {
      faviconLogo = new Image();
      // Use the latest count if sessions change while the logo loads.
      faviconLogo.onload = () => updateFavicon(faviconCount, faviconUnread);
      faviconLogo.onerror = () => { faviconLogo = null; setFavicon(plainIcon); };
      faviconLogo.src = plainIcon;
      return;
    }
    if (!faviconLogo.complete || !faviconLogo.naturalWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(faviconLogo, 0, 0, 32, 32);
    const text = badgeCount > 999 ? "999+" : String(badgeCount);
    ctx.font = `bold ${text.length > 2 ? 10 : 16}px sans-serif`;
    const width = Math.min(32, Math.max(18, Math.ceil(ctx.measureText(text).width) + 6));
    ctx.fillStyle = count ? "#fbbf24" : "#10b981";
    ctx.beginPath();
    ctx.roundRect(32 - width, 15, width, 17, 5);
    ctx.fill();
    ctx.fillStyle = "#121212";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 32 - width / 2, 24, width - 4);
    setFavicon(canvas.toDataURL("image/png"));
  }

  let activityPort = null;
  let hasWorkerActivity = false;
  let unreadTokens = new Map();
  function acknowledgeResult() {
    if (!activityPort) return;
    const id = window.RKChat?.getVisibleChatId?.();
    const token = unreadTokens.get(id);
    if (token) {
      try { activityPort.postMessage({ type: "resultRead", id, token }); } catch (_) {}
    }
  }
  function sendActivity() {
    const count = window.RKChat?.getRunningChatCount?.() || 0;
    if (!hasWorkerActivity) updateFavicon(count);
    if (!activityPort) return;
    try { activityPort.postMessage({ type: "chatActivity", count }); } catch (_) {}
    acknowledgeResult();
  }
  window.addEventListener("rk-chat-activity", sendActivity);
  window.addEventListener("rk-chat-view", acknowledgeResult);
  document.addEventListener?.("visibilitychange", acknowledgeResult);
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
      else if (m.cmd === "sessionActivity") {
        hasWorkerActivity = true;
        unreadTokens = new Map((Array.isArray(m.unread) ? m.unread : [])
          .filter(entry => Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === "string")));
        updateFavicon(m.count, unreadTokens.size);
        acknowledgeResult();
      }
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
      unreadTokens.clear();
      hasWorkerActivity = false;
      sendActivity();
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
  sendActivity();
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
