// Minimal service worker: relay toggle requests to the active tab's content script.
// Everything else lives in the content scripts — no network, no remote state.

function toggleToolbar(tab) {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "RK_TOGGLE_TOOLBAR" }).catch(() => {
    // Content script may not be injected on this page (e.g. chrome:// URLs). Ignore.
  });
}

// Clicking the extension icon (or its keyboard shortcut) toggles BOTH the
// in-page toolbar and the side panel together, so one action brings Lizard Studio up
// or tears it down. Both run inside the click's user gesture, which sidePanel.open
// requires. (toggleSidePanel is hoisted from below.)
function toggleStudio(tab) {
  toggleToolbar(tab);
  toggleSidePanel(tab);
}

// Open the side panel via Chrome's native action-click behavior. This makes the
// panel document load INSTANTLY on icon click, with no dependency on the service
// worker — critical because an idle MV3 worker cold-starts on the first click,
// and routing sidePanel.open() through that cold start left the panel frame blank
// for seconds ("sometimes a big delay"). With this set, Chrome also toggles the
// panel closed on the next click for free. The toolbar is brought up separately
// when the panel connects its port (see onConnect below), keeping the two tied.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[RK] setPanelBehavior", err));

// Fallback for the rare case setPanelBehavior isn't honored: onClicked only fires
// when Chrome ISN'T handling the click itself, so this never double-fires with the
// native behavior above. It still carries the user gesture sidePanel.open() needs.
chrome.action.onClicked.addListener((tab) => toggleStudio(tab));

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-toolbar") return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => toggleStudio(tab));
});

// ---- side panel (terminal) --------------------------------------------------
// Content scripts can't call chrome.sidePanel directly, so the toolbar relays
// clicks here. sidePanel.open() must run inside the user-gesture-carrying message
// handler — the gesture from the toolbar click is propagated with the message.
//
// There's no chrome.sidePanel.close(), so the panel page keeps a port open while
// it's alive (see sidepanel.js). That lets us (a) know whether a panel is open
// and (b) ask it to window.close() itself for the toggle button.
const panelPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "rk-sidepanel") return;
  panelPorts.add(port);
  // The panel just came up (natively, via openPanelOnActionClick — so onClicked
  // didn't run). Bring the in-page toolbar up alongside it, on the tab the user is
  // looking at, so opening Studio still surfaces both. The content script no-ops
  // if the bar is already shown, so SW-recycle reconnects don't re-toggle it.
  showToolbarOnActiveTab();
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
    // Side panel went away (user closed it, or it closed itself) — closing the
    // panel and closing the toolbar are tied together, so hide the bar too. The
    // panel reconnects across service-worker restarts (see sidepanel.js), so an
    // empty set here means a genuine close, not a transient SW recycle.
    if (panelPorts.size === 0) hideToolbarEverywhere();
  });
});

// Show the Lizard Studio toolbar on the tab the user is currently looking at.
// Used when the side panel opens (its port connects).
//
// We broadcast to every tab rather than resolving the active tab in the worker:
// opening the side panel steals focus, so a lastFocusedWindow query right after
// the panel connects is unreliable. Each content script decides for itself — it
// only raises the bar if its tab is the visible (foreground) one and the bar
// isn't already up, so exactly the tab the user is looking at responds. Safe to
// call on every connect, including transient service-worker reconnects.
function showToolbarOnActiveTab() {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { type: "RK_SHOW_TOOLBAR" }).catch(() => {});
    }
  });
}

// Tell every tab's content script to hide the Lizard Studio toolbar. Used when the
// side panel closes. hide() is idempotent and a no-op where the bar isn't shown.
function hideToolbarEverywhere() {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { type: "RK_HIDE_TOOLBAR" }).catch(() => {});
    }
  });
}

function openPanel(tab) {
  const tabId = tab && tab.id;
  const opts = tabId != null ? { tabId } : { windowId: chrome.windows.WINDOW_ID_CURRENT };
  chrome.sidePanel.open(opts).catch((err) => console.error("[RK] sidePanel.open", err));
}

// Open the panel if nothing is showing; otherwise tell the live panel to close
// itself (there's no chrome.sidePanel.close()).
function toggleSidePanel(tab) {
  if (panelPorts.size === 0) openPanel(tab);
  else panelPorts.forEach((p) => p.postMessage({ cmd: "close" }));
}

// declarativeNetRequest session rule that strips framing headers from sub-frame
// requests, so Responsive mode's iframe can load sites that set X-Frame-Options
// or CSP frame-ancestors. Installed only while the tool is active.
const RF_RULE_ID = 1;
function setResponsiveRule(on) {
  const removeRuleIds = [RF_RULE_ID];
  const addRules = on ? [{
    id: RF_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" },
      ],
    },
    condition: { resourceTypes: ["sub_frame"] },
  }] : [];
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules })
    .catch((err) => console.error("[RK] DNR updateSessionRules", err));
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  switch (msg.type) {
    case "RK_CLOSE_SIDEPANEL":
      // Unconditional close — used when the toolbar itself is dismissed.
      panelPorts.forEach((p) => p.postMessage({ cmd: "close" }));
      break;
    case "RK_RESPONSIVE_ON":
      setResponsiveRule(true);
      break;
    case "RK_RESPONSIVE_OFF":
      setResponsiveRule(false);
      break;
    case "RK_PICK_ELEMENT":
      // Selector tool clicked an element — hand it to the side-panel chat as
      // context. Content scripts can't reach the panel directly, so relay it
      // over the open panel port(s).
      panelPorts.forEach((p) => p.postMessage({ cmd: "pickElement", element: msg.element }));
      break;
    case "RK_ADD_TO_CHAT":
      // Annotate tool produced an annotated screenshot — relay it to the
      // side-panel chat, which attaches it like a pasted image.
      panelPorts.forEach((p) => p.postMessage({ cmd: "addImage", dataUrl: msg.dataUrl }));
      break;
  }
});

// Snapshot the visible tab for the eyedropper's custom loupe. Returns a PNG data
// URL the content script magnifies and samples. Works under the activeTab grant
// the user already gave by opening the toolbar — no extra host permission needed.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "RK_CAPTURE") return;
  const winId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
  chrome.tabs.captureVisibleTab(winId, { format: "png" }, (dataUrl) => {
    if (chrome.runtime.lastError || !dataUrl) {
      sendResponse({ ok: false, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
    } else {
      sendResponse({ ok: true, dataUrl });
    }
  });
  return true; // keep the channel open for the async captureVisibleTab callback
});
