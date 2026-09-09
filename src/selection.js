// Live text selection in each page frame. No storage or model calls.
(() => {
  if (window.__rkLiveSelection) return;
  const LIMIT = 14000;
  let last = "";
  function read() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    let text = "";
    const input = active?.tagName === "INPUT";
    const editable = input || active?.tagName === "TEXTAREA";
    if (editable) {
      // Never capture masked fields, including a stale document selection behind one.
      if (!input || ["text", "search", "url", "tel", "email"].includes(active.type)) {
        const { selectionStart: start, selectionEnd: end } = active;
        if (Number.isInteger(start) && end > start) text = active.value.slice(start, end);
      }
    } else if (active?.id !== "lizard-studio-host") {
      text = String(window.getSelection() || "");
    }
    text = text.trim();
    return { text: text.slice(0, LIMIT), truncated: text.length > LIMIT,
      url: location.href, title: document.title || "", focused: document.hasFocus() && active?.tagName !== "IFRAME" };
  }
  function publish(clear = false) {
    const selection = clear ? { text: "", focused: document.hasFocus() } : read();
    const key = JSON.stringify(selection);
    if (key === last) return;
    last = key;
    try {
      chrome.runtime.sendMessage({ type: "RK_SELECTION_CHANGED", selection }).catch(() => {});
    } catch (_) { /* Extension reloaded; the replacement script owns updates. */ }
  }
  window.__rkLiveSelection = { read };
  document.addEventListener("selectionchange", () => publish());
  // Input selections and focus changes do not all emit a document selectionchange.
  for (const event of ["select", "input", "keyup", "pointerup", "focusin"])
    document.addEventListener(event, () => publish(), true);
  window.addEventListener("pagehide", () => publish(true));
  publish();
})();
