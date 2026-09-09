// Minimal service worker: relay toggle requests to the active tab's content script.
// Everything else lives in the content scripts — no network, no remote state.

// ---- content-script injection ----------------------------------------------
// Manifest content_scripts only reach pages loaded AFTER the extension is
// installed/updated; tabs that were already open get nothing until reloaded —
// the main reason the toolbar didn't come up right after installing. Inject
// programmatically into existing tabs on install, and on demand whenever a
// show/toggle message finds nobody listening in a tab the user can see.
const CONTENT_FILES = chrome.runtime.getManifest().content_scripts[0].js;

async function ensureContentScript(tabId) {
  try {
    // Probe first: is our script already there? While we're in the page, sweep
    // out an overlay left by a previous extension version — its isolated world
    // is orphaned but its DOM survives, and a fresh injection would otherwise
    // stack a second toolbar on top of the dead one.
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.RK) return true;
        const stale = document.getElementById("lizard-studio-host");
        if (stale) stale.remove();
        return false;
      },
    });
    if (probe && probe.result) return true;
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return true;
  } catch (_) {
    return false; // restricted page (chrome://, Web Store, ...) — nothing to inject into
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) if (t.id != null) ensureContentScript(t.id);
  });
});

// Send `type` to one tab; if nothing answers and injection is allowed, put the
// content scripts in (install/update case, or the page hasn't hit document_idle
// yet) and resend. Failures on restricted pages stay silent as before.
function sendToTab(tabId, type, injectIfMissing) {
  chrome.tabs.sendMessage(tabId, { type }).catch(() => {
    if (!injectIfMissing) return;
    ensureContentScript(tabId).then((ok) => {
      if (ok) chrome.tabs.sendMessage(tabId, { type }).catch(() => {});
    });
  });
}

function toggleToolbar(tab) {
  if (!tab || !tab.id) return;
  sendToTab(tab.id, "RK_TOGGLE_TOOLBAR", true);
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
// A side panel belongs to one browser window. Never route by last focus:
// another window may become active between selecting content and delivering it.
const panelPorts = new Map();
function panelsForWindow(windowId) {
  if (!Number.isInteger(windowId) || windowId < 0) return [];
  return [...panelPorts].filter(([, id]) => id === windowId).map(([port]) => port);
}
function sendToPanels(windowId, message) {
  const ports = panelsForWindow(windowId);
  for (const port of ports) {
    try { port.postMessage(message); } catch (_) {}
  }
  return ports.length;
}
// One live selection per browser window. Generations discard late reads after
// tab switches/navigation; revisions keep a snapshot from overwriting an event.
const liveSelections = new Map();
function emitSelection(windowId, state, selection, frameId = null) {
  state.selection = selection?.text ? {
    kind: "selection", text: String(selection.text).slice(0, 14000),
    url: String(selection.url || "").slice(0, 4000),
    title: String(selection.title || "").slice(0, 500),
    truncated: !!selection.truncated,
  } : null;
  state.frameId = state.selection ? frameId : null;
  sendToPanels(windowId, { cmd: "liveSelection", selection: state.selection });
}
function refreshSelection(windowId, tabId) {
  if (!panelsForWindow(windowId).length) return;
  const state = { tabId, revision: 0, selection: null, frameId: null };
  liveSelections.set(windowId, state);
  emitSelection(windowId, state, null);
  chrome.tabs.query({ active: true, windowId }, async ([tab]) => {
    if (!tab || liveSelections.get(windowId) !== state || (tabId != null && tab.id !== tabId)) return;
    state.tabId = tab.id;
    const revision = state.revision;
    try {
      // Also covers pages that were open before the extension was updated.
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["src/selection.js"] });
      const frames = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => window.__rkLiveSelection?.read() || null,
      });
      if (liveSelections.get(windowId) !== state || state.revision !== revision) return;
      const focused = frames.find((f) => f.result?.focused);
      const source = focused || frames.find((f) => f.result?.text);
      if (source) emitSelection(windowId, state, source.result, source.frameId);
    } catch (_) { /* Chrome pages and other restricted surfaces have no selection. */ }
  });
}
function selectionChanged(selection, sender) {
  const tab = sender.tab;
  if (!tab || !panelsForWindow(tab.windowId).length || !selection || typeof selection.text !== "string") return;
  const state = liveSelections.get(tab.windowId);
  if (!state || state.tabId !== tab.id) return;
  if (tab.active === false) return;
  // Chrome supplies the sender tab; the activation listener owns the current
  // tab identity. Avoid an async query here so rapid range changes stay ordered.
  if (!selection.text && !selection.focused && state.frameId !== sender.frameId) return;
  if (selection.text && !selection.focused && state.selection && state.frameId !== sender.frameId) return;
  ++state.revision;
  emitSelection(tab.windowId, state, selection, sender.frameId);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "rk-sidepanel") return;
  panelPorts.set(port, null);
  port.onMessage.addListener((msg) => {
    if (msg?.type !== "panelReady" || !Number.isInteger(msg.windowId) || msg.windowId < 0) return;
    if (!panelPorts.has(port) || panelPorts.get(port) !== null) return;
    panelPorts.set(port, msg.windowId);
    showToolbarOnActiveTab(msg.windowId);
    refreshSelection(msg.windowId);
  });
  port.onDisconnect.addListener(() => {
    const windowId = panelPorts.get(port);
    panelPorts.delete(port);
    if (windowId != null && !panelsForWindow(windowId).length) {
      liveSelections.delete(windowId);
      hideToolbarInWindow(windowId);
    }
  });
});

function showToolbarOnActiveTab(windowId) {
  chrome.tabs.query({ windowId }, (tabs) => {
    for (const t of tabs) if (t.id != null) sendToTab(t.id, "RK_SHOW_TOOLBAR", t.active);
  });
}
function catchUpActiveTab(tabId, windowId) {
  if (panelsForWindow(windowId).length) sendToTab(tabId, "RK_SHOW_TOOLBAR", true);
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  catchUpActiveTab(tabId, windowId);
  refreshSelection(windowId, tabId);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    const tab = tabs && tabs[0];
    if (tab && tab.id != null) catchUpActiveTab(tab.id, windowId);
  });
});
function hideToolbarInWindow(windowId) {
  chrome.tabs.query({ windowId }, (tabs) => {
    for (const t of tabs) if (t.id != null) sendToTab(t.id, "RK_HIDE_TOOLBAR", false);
  });
}

function openPanel(tab) {
  const tabId = tab && tab.id;
  const opts = tabId != null ? { tabId } : { windowId: chrome.windows.WINDOW_ID_CURRENT };
  chrome.sidePanel.open(opts).catch((err) => console.error("[RK] sidePanel.open", err));
}

// Open the panel if nothing is showing; otherwise tell the live panel to close
// itself (there's no chrome.sidePanel.close()).
//
// The port set is in-memory, so right after a service-worker cold start it can
// be empty even though a panel IS open (its port hasn't reattached yet) — a
// naive check would then call open() on an open panel and the toggle inverts.
// getContexts() sees the panel regardless, so consult it before opening; the
// user gesture survives extension-API promise boundaries, so open() still works.
async function toggleSidePanel(tab) {
  const windowId = tab && tab.windowId;
  if (!Number.isInteger(windowId)) return;
  if (sendToPanels(windowId, { cmd: "close" })) {
    return;
  }
  let hasPanel = false;
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
    hasPanel = ctxs.some((ctx) => ctx.windowId === windowId);
  } catch (_) { /* very old Chrome — fall through to open */ }
  if (!hasPanel) {
    openPanel(tab);
    return;
  }
  // Panel open but not yet reconnected — close it once the port reattaches
  // (the panel retries every ~500ms) instead of inverting the toggle.
  const deadline = Date.now() + 2000;
  const tryClose = () => {
    if (!sendToPanels(windowId, { cmd: "close" }) && Date.now() < deadline) setTimeout(tryClose, 150);
  };
  tryClose();
}

// declarativeNetRequest session rule that strips framing headers from sub-frame
// requests, so Responsive mode's iframe can load sites that set X-Frame-Options
// or CSP frame-ancestors. Scoped to the requesting tab only — the rule must not
// weaken CSP anywhere else in the browser. One rule per tab (id = base + tabId)
// so several tabs can run the tool independently.
const RF_RULE_BASE = 1000;
function setResponsiveRule(on, tabId) {
  if (tabId == null) return Promise.resolve();
  const ruleId = RF_RULE_BASE + tabId;
  const addRules = on ? [{
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" },
      ],
    },
    condition: { resourceTypes: ["sub_frame"], tabIds: [tabId] },
  }] : [];
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId], addRules })
    .catch((err) => console.error("[RK] DNR updateSessionRules", err));
}

// The content script asks for removal when the tool turns off, but if the tab
// closes, crashes, or navigates away while Responsive mode is on, that message
// never arrives — clean up here so the CSP-stripping rule can't outlive its tab.
// Both listeners wake the service worker, so this holds across SW recycles.
chrome.tabs.onRemoved.addListener((tabId) => {
  setResponsiveRule(false, tabId);
  for (const [windowId, state] of liveSelections) {
    if (state.tabId === tabId) refreshSelection(windowId);
  }
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A top-level navigation resets the content script (tool state is gone).
  if (info.status === "loading") setResponsiveRule(false, tabId);
  for (const [windowId, state] of liveSelections) {
    if (state.tabId !== tabId) continue;
    if (info.status === "loading") {
      const next = { tabId, revision: 0, selection: null, frameId: null };
      liveSelections.set(windowId, next);
      emitSelection(windowId, next, null);
    } else if (info.status === "complete") refreshSelection(windowId, tabId);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  switch (msg.type) {
    case "RK_SELECTION_CHANGED":
      selectionChanged(msg.selection, sender);
      break;
    case "RK_CLOSE_SIDEPANEL":
      // Unconditional close — used when the toolbar itself is dismissed.
      sendToPanels(sender.tab && sender.tab.windowId, { cmd: "close" });
      break;
    case "RK_RESPONSIVE_ON":
      // Ack only after the DNR rule is actually live so the content script can
      // load the iframe knowing the CSP/X-Frame-Options strip is in effect.
      setResponsiveRule(true, sender.tab && sender.tab.id).finally(() => {
        try { sendResponse({ ok: true }); } catch (e) {}
      });
      return true; // async response — keep the message channel open
    case "RK_RESPONSIVE_OFF":
      setResponsiveRule(false, sender.tab && sender.tab.id);
      break;
    case "RK_PICK_ELEMENT":
      // Selector tool clicked an element — hand it to the side-panel chat as
      // context. Content scripts can't reach the panel directly, so relay it
      // over the open panel port(s).
      sendResponse({ ok: !!sendToPanels(sender.tab && sender.tab.windowId, { cmd: "pickElement", element: msg.element }) });
      break;
    case "RK_ADD_TO_CHAT":
      // Annotate tool produced an annotated screenshot — relay it to the
      // side-panel chat, which attaches it like a pasted image.
      sendResponse({ ok: !!sendToPanels(sender.tab && sender.tab.windowId, { cmd: "addImage", dataUrl: msg.dataUrl }) });
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
