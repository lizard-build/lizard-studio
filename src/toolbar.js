// Floating, draggable toolbar rendered in the overlay's UI layer (Shadow DOM).
// Horizontal icon pill, docked bottom-center. Tool settings open as popovers
// above the bar; the accent picker opens upward as well.
(function () {
  const RK = window.RK;
  const GROUPS = [
    ["measure", "Measure"],
    ["inspect", "Inspect"],
    ["layout", "Layout"],
  ];

  const CSS = `
    .rk-bar, .rk-bar * { box-sizing: border-box; }
    .rk-bar {
      position: fixed; left: 50%; bottom: 24px;
      transform: translateX(-50%) scale(var(--rk-z, 1)); transform-origin: bottom center;
      display: flex; align-items: center; gap: 4px;
      padding: 7px 9px; max-width: calc(100vw - 24px);
      background: var(--bg-secondary); color: var(--text-primary);
      border: 1px solid var(--border-primary);
      border-radius: 18px; box-shadow: 0 18px 50px rgba(0,0,0,.6);
      font: 500 12px/1.5 var(--rk-font);
      user-select: none; z-index: 100; cursor: grab;
    }
    .rk-bar.dragging { cursor: grabbing; }
    /* A draggable surface, but the controls inside stay clickable. */
    .rk-bar > * { cursor: default; }

    .rk-btn { width:34px; height:34px; flex:none; display:flex; align-items:center;
      justify-content:center; border-radius:11px; cursor:pointer; padding:0;
      color:var(--text-secondary); background:transparent; border:0;
      transition:background .15s, color .15s, transform .1s; }
    .rk-btn:hover { background:var(--control-secondary); color:var(--text-primary); }
    .rk-btn:active { transform:scale(.92); }
    .rk-btn.on { background:rgba(255,255,255,.14); color:var(--text-primary); }
    .rk-btn svg { width:18px; height:18px; display:block; }
    .rk-btn.danger:hover { color:var(--other-red); }
    /* A tool whose settings popover is currently open (opened via right-click). */
    .rk-btn.settings-open { box-shadow:inset 0 0 0 1px var(--border-primary); }

    .rk-div { width:1px; height:24px; flex:none; margin:0 3px;
      background:var(--border-primary); }

    .rk-tools { display:flex; align-items:center; gap:2px; }

    /* Minimized handle — a tab poking up from the very bottom edge of the screen
       (flush bottom, rounded top corners) that restores the bar when clicked. */
    .rk-handle { position:fixed; left:50%; bottom:0;
      transform:translateX(-50%) scale(var(--rk-z, 1)); transform-origin:bottom center;
      display:flex; align-items:center; justify-content:center;
      width:62px; height:20px; cursor:pointer; z-index:100;
      background:var(--bg-secondary); color:var(--text-secondary);
      border:1px solid var(--border-primary); border-bottom:0;
      border-radius:16px 16px 0 0;
      box-shadow:0 -6px 24px rgba(0,0,0,.5); transition:color .15s, background .15s; }
    .rk-handle:hover { color:var(--text-primary); background:var(--control-secondary); }
    .rk-handle svg { width:16px; height:16px; display:block; }

    /* ---- floating popover (settings panels + accent picker) -------------- */
    .rk-pop { position:fixed; z-index:200; min-width:210px; max-width:280px;
      background:var(--bg-primary); color:var(--text-primary);
      border:1px solid var(--border-primary); border-radius:12px;
      box-shadow:0 18px 50px rgba(0,0,0,.6); padding:12px; }
    .rk-pop-backdrop { position:fixed; inset:0; z-index:150; }
    .rk-pop-title { display:flex; align-items:center; gap:4px; margin:0 0 14px; }
    .rk-pop-name { margin-right:auto; font-size:14px; font-weight:600; color:var(--text-primary); }
    .rk-pop-act { width:28px; height:28px; flex:none; display:flex; align-items:center;
      justify-content:center; border:0; background:transparent; color:var(--text-secondary);
      border-radius:8px; cursor:pointer; transition:background .15s, color .15s; }
    .rk-pop-act:hover { background:var(--control-secondary); color:var(--text-primary); }
    .rk-pop-act svg { width:17px; height:17px; display:block; }

    /* ---- labeled settings rows (label left, control right) --------------- */
    .rk-prows { display:flex; flex-direction:column; gap:13px; }
    .rk-prow { display:flex; align-items:center; gap:12px; }
    .rk-prow > .rk-plabel { flex:none; width:84px; font-size:13px; color:var(--text-secondary); }
    .rk-prow > .rk-pctl { flex:1; min-width:0; display:flex; align-items:center; gap:8px; }
    .rk-prow .rk-pctl > input[type=number], .rk-prow .rk-pctl > input[type=text]:not(.rk-hex),
    .rk-prow .rk-pctl > select {
      flex:1; width:100%; min-width:0; font:inherit; background:var(--bg-secondary);
      color:var(--text-primary); border:1px solid var(--border-primary);
      border-radius:8px; padding:7px 10px; outline:none; }
    .rk-prow .rk-pctl input:focus, .rk-prow .rk-pctl select:focus { border-color:var(--rk-accent); }
    .rk-prow .rk-pctl input[type=number] { -moz-appearance:textfield; }
    .rk-prow .rk-pctl input[type=number]::-webkit-outer-spin-button,
    .rk-prow .rk-pctl input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
    .rk-prow select { cursor:pointer; appearance:none; -webkit-appearance:none; padding-right:30px;
      background-repeat:no-repeat; background-position:right 10px center; background-size:12px;
      background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path fill="%235F646D" d="M215.39,92.94A8,8,0,0,0,208,88H48a8,8,0,0,0-5.66,13.66l80,80a8,8,0,0,0,11.32,0l80-80A8,8,0,0,0,215.39,92.94Z"/></svg>'); }
    .rk-swatch { flex:none; width:36px; height:32px; padding:3px; cursor:pointer;
      background:var(--bg-secondary); border:1px solid var(--border-primary); border-radius:8px; }
    .rk-swatch::-webkit-color-swatch-wrapper { padding:0; }
    .rk-swatch::-webkit-color-swatch { border:0; border-radius:4px; }
    .rk-hex { flex:1; min-width:0; font:inherit; text-transform:uppercase; letter-spacing:.3px;
      background:var(--bg-secondary); color:var(--text-primary);
      border:1px solid var(--border-primary); border-radius:8px; padding:7px 10px; outline:none; }
    .rk-hex:focus { border-color:var(--rk-accent); }
    .rk-prow input[type=range] { flex:1; width:100%; min-width:0; cursor:pointer;
      accent-color:var(--control-primary); }

    /* ---- shared settings-panel field styles (unchanged) ------------------ */
    .rk-panel-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px 10px; align-items:start; }
    .rk-panel-col { display:flex; flex-direction:column; gap:10px; }
    .rk-field { display:flex; flex-direction:column; align-items:stretch; gap:5px;
      min-width:0; color:var(--text-secondary); }
    .rk-field > span { font-size:11px; color:var(--text-tertiary);
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .rk-field input { font:inherit; }
    .rk-layers { display:flex; flex-direction:column; gap:9px; }
    .rk-layer { display:flex; align-items:center; gap:10px; }
    .rk-layer > .rk-lead { flex:1; min-width:0; display:flex; align-items:center; gap:8px;
      font-size:12px; color:var(--text-secondary); }
    .rk-layer > label.rk-lead { cursor:pointer; }
    .rk-layer > .rk-lead > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .rk-num { display:flex; align-items:center; gap:7px; flex:none;
      font-size:11px; color:var(--text-tertiary); }
    .rk-num > span { min-width:12px; }
    .rk-field input[type=number], .rk-num input[type=number], .rk-layer .rk-select, .rk-field input[type=color], .rk-field select {
      width:100%; max-width:100%; font:inherit;
      background:var(--bg-secondary); color:var(--text-primary);
      border:1px solid var(--border-primary); border-radius:6px; padding:5px 8px; }
    .rk-num input[type=number] { width:62px; }
    .rk-layer .rk-select { flex:none; width:81px; cursor:pointer; }
    .rk-field input[type=color] { padding:2px; height:30px; cursor:pointer; }
    .rk-field select { cursor:pointer; }
    .rk-field input[type=range] { width:100%; min-width:0; accent-color:var(--control-primary); }
    .rk-field input[type=file] { min-width:0; max-width:100%; font-size:11px; color:var(--text-secondary); }
    .rk-field:has(input[type=checkbox]) { flex-direction:row; align-items:center; gap:8px; }
    .rk-field:has(input[type=checkbox]) > span { font-size:12px; color:var(--text-secondary); }
    .rk-field input[type=checkbox], .rk-layer input[type=checkbox] { flex:none; width:15px; height:15px;
      accent-color:var(--control-primary); }
    .rk-btn-sm { background:var(--control-secondary); color:var(--text-primary); border:0;
      border-radius:8px; padding:6px 10px; font:600 12px var(--rk-font); cursor:pointer;
      transition:background .15s; }
    .rk-btn-sm:hover { background:var(--control-secondary-hover); }
    .rk-btn-sm:active { transform:scale(.97); }
    .rk-hint { font-size:11px; line-height:1.45; color:var(--text-tertiary); }

    /* ---- instant hover tooltip (with hotkey badge) ----------------------- */
    .rk-tip { position:fixed; z-index:300; pointer-events:none;
      display:flex; align-items:center; gap:7px; white-space:nowrap;
      background:var(--bg-primary); color:var(--text-primary);
      border:1px solid var(--border-primary); border-radius:8px;
      padding:5px 8px; font:600 11px var(--rk-font);
      box-shadow:0 8px 24px rgba(0,0,0,.5);
      opacity:0; transform:translateY(3px);
      transition:opacity .12s ease, transform .12s ease; }
    .rk-tip.show { opacity:1; transform:translateY(0); }
    .rk-kbd { flex:none; min-width:16px; height:16px; padding:0 4px;
      display:inline-flex; align-items:center; justify-content:center;
      font:600 10px/1 var(--rk-font);
      color:var(--text-secondary); background:var(--control-secondary);
      border:1px solid var(--border-primary); border-radius:5px; }
    .rk-tip-sub { color:var(--text-tertiary); font-weight:500; }
  `;

  let root = null, toolsEl = null;
  let pop = null; // single open popover: { kind, id?, el, backdrop, inner? }
  let tip = null; // shared hover tooltip element
  let handleEl = null, minimized = false; // minimized-to-bottom handle

  // Phosphor (regular) — matches the Lizard client icon set.
  // Restore glyph for the minimized handle: a bar with a caret pointing up.
  const ICON_RESTORE = `<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"><line x1="76" y1="74" x2="180" y2="74"/><polyline points="80,170 128,122 176,170"/></svg>`;
  const ICON_X = `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>`;
  // Caret down — minimizes the whole bar to a small handle docked at the bottom.
  const ICON_CARET_DOWN = `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>`;
  // Eye / eye-slash — a panel's optional show/hide toggle for its overlay.
  const ICON_EYE = `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,168a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z"/></svg>`;
  const ICON_EYE_SLASH = `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M96.68,57.87a4,4,0,0,1,2.08-6.6A130.13,130.13,0,0,1,128,48c34.88,0,66.57,13.26,91.66,38.35,18.83,18.83,27.3,37.62,27.65,38.41a8,8,0,0,1,0,6.5c-.35.79-8.82,19.57-27.65,38.4q-4.28,4.26-8.79,8.07a4,4,0,0,1-5.55-.36ZM213.92,210.62a8,8,0,1,1-11.84,10.76L180,197.13A127.21,127.21,0,0,1,128,208c-34.88,0-66.57-13.26-91.66-38.34C17.51,150.83,9,132.05,8.69,131.26a8,8,0,0,1,0-6.5C9,124,17.51,105.18,36.34,86.35a135,135,0,0,1,25-19.78L42.08,45.38A8,8,0,1,1,53.92,34.62Zm-65.49-48.25-52.69-58a40,40,0,0,0,52.69,58Z"/></svg>`;

  function build() {
    RK.ensureOverlay();
    const style = RK.h("style", {});
    style.textContent = CSS;
    RK.overlay.shadow.appendChild(style);

    root = RK.h("div", { class: "rk-bar" });
    applyPos();

    toolsEl = RK.h("div", { class: "rk-tools" });

    root.appendChild(toolsEl);
    root.appendChild(RK.h("div", { class: "rk-div" }));
    root.appendChild(minimizeBtn());
    root.appendChild(xBtn());
    RK.overlay.ui.appendChild(root);

    enableDrag();
    enableEscClear();
    enableTips();
    enableHotkeys();
    render();
  }

  function applyPos() {
    const p = RK.state.toolbarPos;
    if (p) {
      root.style.left = p.x + "px"; root.style.top = p.y + "px"; root.style.bottom = "auto";
      root.style.transformOrigin = "top left"; root.style.transform = "scale(var(--rk-z, 1))";
    }
  }

  function iconBtn(svg, title, cls, onclick) {
    // `data-tip` (not `title`) so our instant custom tooltip is the only one
    // that shows — the native title popup has a ~1s delay and would double up.
    const b = RK.h("button", { class: "rk-btn" + (cls ? " " + cls : ""),
      "data-tip": title, "aria-label": title, onclick });
    b.innerHTML = svg;
    return b;
  }

  // Closing the toolbar also closes the side panel, so nothing Lizard Studio opened is
  // left hanging around once the user dismisses the bar.
  function xBtn() {
    return iconBtn(ICON_X, "Close toolbar & side panel", "danger", (e) => {
      e.stopPropagation();
      // Accessing chrome.runtime throws synchronously on an invalidated context,
      // so the .catch() alone wouldn't help — wrap the whole call.
      try { chrome.runtime.sendMessage({ type: "RK_CLOSE_SIDEPANEL" }).catch(() => {}); } catch (_) {}
      RK.toolbar.hide();
    });
  }

  function minimizeBtn() {
    return iconBtn(ICON_CARET_DOWN, "Minimize toolbar", "", (e) => { e.stopPropagation(); minimize(); });
  }

  // ---- minimize to a bottom handle --------------------------------------
  // Tucks the whole bar away into a small pill docked bottom-center; tools keep
  // running. Click the pill (or press the toggle shortcut) to bring it back.
  function ensureHandle() {
    if (handleEl) return handleEl;
    handleEl = RK.h("div", { class: "rk-handle", title: "Show Lizard Studio toolbar",
      onclick: (e) => { e.stopPropagation(); restore(); } });
    handleEl.innerHTML = ICON_RESTORE; // bar + caret up = bring the bar back up
    RK.overlay.ui.appendChild(handleEl);
    return handleEl;
  }
  function minimize() {
    minimized = true;
    closePop();
    hideTip();
    root.style.display = "none";
    ensureHandle().style.display = "flex";
  }
  function restore() {
    minimized = false;
    if (handleEl) handleEl.style.display = "none";
    root.style.display = "flex";
  }

  // ---- popover plumbing (settings panels + accent picker) ----------------
  function closePop() {
    if (!pop) return;
    pop.backdrop.remove();
    pop.el.remove();
    if (pop.kind === "panel") {
      const b = toolsEl.querySelector(`.rk-tool[data-tid="${pop.id}"]`);
      if (b) b.classList.remove("settings-open");
    }
    pop = null;
  }

  // Open `el` as a popover floating above `anchor`, with a click-away backdrop.
  function openPop(el, anchor) {
    const backdrop = RK.h("div", { class: "rk-pop-backdrop",
      onmousedown: (e) => { e.stopPropagation(); closePop(); } });
    RK.overlay.ui.appendChild(backdrop);
    RK.overlay.ui.appendChild(el);
    const r = anchor.getBoundingClientRect();
    // Anchor the popover above the bar, centered over the trigger, clamped on-screen.
    el.style.bottom = (window.innerHeight - r.top + 8) + "px";
    const w = el.offsetWidth;
    let left = r.left + r.width / 2 - w / 2;
    left = RK.clamp(left, 8, window.innerWidth - w - 8);
    el.style.left = left + "px";
    return backdrop;
  }

  // ---- tool rendering ----------------------------------------------------
  function render() {
    if (!root) return;
    hideTip(); // the hovered button may be about to be replaced
    toolsEl.replaceChildren();
    let first = true;
    GROUPS.forEach(([gid]) => {
      const ids = RK.order.filter((id) => RK.tools[id].group === gid);
      if (!ids.length) return;
      if (!first) toolsEl.appendChild(RK.h("div", { class: "rk-div" }));
      first = false;
      ids.forEach((id) => toolButtons(id).forEach((n) => toolsEl.appendChild(n)));
    });

    // Keep a still-open settings popover live (e.g. eyedropper's "last picked").
    if (pop && pop.kind === "panel") {
      const t = RK.tools[pop.id];
      pop.inner.replaceChildren();
      try { t.panel(pop.inner); } catch (e) { console.error("[RK panel]", pop.id, e); }
      const b = toolsEl.querySelector(`.rk-tool[data-tid="${pop.id}"]`);
      if (b) b.classList.add("settings-open");
    }
  }

  function toolButtons(id) {
    const t = RK.tools[id];
    const on = RK.isActive(id);
    const btn = iconBtn(t.icon, t.name, "rk-tool" + (on ? " on" : ""),
      () => { RK.toggle(id); render(); });
    btn.dataset.tid = id; // lets the tooltip surface this tool's hotkey
    if (on) btn.classList.add("on");
    // Tools with a settings panel open it on right-click (no separate gear).
    if (t.panel) {
      btn.dataset.hasPanel = "1";
      if (pop && pop.kind === "panel" && pop.id === id) btn.classList.add("settings-open");
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePanel(id, btn);
      });
    }
    return [btn];
  }

  // Panel header: tool name, an optional eye toggle (for tools that expose a
  // show/hide overlay via toggleVisible/isHidden), and a close button.
  function panelHeader(t) {
    const kids = [RK.h("span", { class: "rk-pop-name" }, t.name)];
    if (typeof t.toggleVisible === "function") {
      const eye = RK.h("button", { class: "rk-pop-act", "aria-label": "Toggle visibility" });
      const paint = () => { eye.innerHTML = (t.isHidden && t.isHidden()) ? ICON_EYE_SLASH : ICON_EYE; };
      eye.addEventListener("click", (e) => { e.stopPropagation(); t.toggleVisible(); paint(); });
      paint();
      kids.push(eye);
    }
    const x = RK.h("button", { class: "rk-pop-act", "aria-label": "Close",
      onclick: (e) => { e.stopPropagation(); closePop(); } });
    x.innerHTML = ICON_X;
    kids.push(x);
    return RK.h("div", { class: "rk-pop-title" }, kids);
  }

  function togglePanel(id, anchor) {
    if (pop && pop.kind === "panel" && pop.id === id) return closePop();
    closePop();
    const t = RK.tools[id];
    const inner = RK.h("div", { class: "rk-panel-inner" });
    try { t.panel(inner); } catch (e) { console.error("[RK panel]", id, e); }
    const el = RK.h("div", { class: "rk-pop" }, [
      panelHeader(t), inner,
    ]);
    const backdrop = openPop(el, anchor);
    anchor.classList.add("settings-open");
    pop = { kind: "panel", id, el, backdrop, inner };
  }

  function activeCount() { return Object.values(RK.state.active).filter(Boolean).length; }
  function clearAll() { RK.order.forEach((id) => RK.isActive(id) && RK.deactivate(id)); render(); }

  // ---- hotkeys (1..9, 0) -------------------------------------------------
  // Keys map to tools in the exact order they appear on the bar (grouped by
  // GROUPS), so the number shown in a tooltip is the key that toggles it.
  const HOTKEYS = "1234567890";
  function orderedToolIds() {
    const out = [];
    GROUPS.forEach(([gid]) => RK.order.forEach((id) => {
      if (RK.tools[id].group === gid) out.push(id);
    }));
    return out;
  }
  function hotkeyForId(id) {
    const i = orderedToolIds().indexOf(id);
    return i >= 0 && i < HOTKEYS.length ? HOTKEYS[i] : null;
  }
  function toolForHotkey(k) {
    const i = HOTKEYS.indexOf(k);
    return i < 0 ? null : (orderedToolIds()[i] || null);
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function enableHotkeys() {
    window.addEventListener("keydown", (e) => {
      if (!RK.state.visible) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1 || e.key < "0" || e.key > "9") return;
      // Don't steal digits while the user is typing — in a page field or in
      // one of our own settings panels (focus lives inside the shadow root).
      if (isTypingTarget(e.target)) return;
      if (RK.overlay && isTypingTarget(RK.overlay.shadow.activeElement)) return;
      const id = toolForHotkey(e.key);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      RK.toggle(id);
      render();
    }, true);
  }

  // ---- instant hover tooltip --------------------------------------------
  function ensureTip() {
    if (tip) return tip;
    tip = RK.h("div", { class: "rk-tip" });
    RK.overlay.ui.appendChild(tip);
    return tip;
  }
  function showTip(target) {
    const text = target.getAttribute("data-tip");
    if (!text) return;
    const t = ensureTip();
    t.replaceChildren(RK.h("span", {}, text));
    const key = target.dataset.tid ? hotkeyForId(target.dataset.tid) : null;
    if (key) t.appendChild(RK.h("span", { class: "rk-kbd" }, key));
    if (target.dataset.hasPanel) t.appendChild(RK.h("span", { class: "rk-tip-sub" }, "right-click: settings"));
    // Measure, then place centered above the anchor and clamp on-screen.
    t.style.left = "0px"; t.style.top = "0px";
    t.classList.add("show");
    const r = target.getBoundingClientRect();
    const w = t.offsetWidth, h = t.offsetHeight;
    const left = RK.clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8);
    let top = r.top - h - 8;
    if (top < 8) top = r.bottom + 8; // flip below if there's no room above
    t.style.left = left + "px";
    t.style.top = top + "px";
  }
  function hideTip() { if (tip) tip.classList.remove("show"); }

  function enableTips() {
    root.addEventListener("mouseover", (e) => {
      const el = e.target.closest(".rk-btn");
      if (el && root.contains(el)) showTip(el);
    });
    root.addEventListener("mouseout", (e) => {
      const el = e.target.closest(".rk-btn");
      if (!el) return;
      if (e.relatedTarget && el.contains(e.relatedTarget)) return; // still inside
      hideTip();
    });
  }

  // Esc clears every active tool. When at least one tool is on we run in the
  // capture phase and swallow the keystroke (stopImmediatePropagation) so the
  // page's own Esc handler doesn't also fire. With nothing active we leave the
  // event untouched and let Esc reach the page as usual.
  function enableEscClear() {
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (pop) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); closePop(); return; }
      if (activeCount() === 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      clearAll();
    }, true);
  }

  // The whole bar is a drag handle; interactive controls opt out so clicks work.
  function enableDrag() {
    let d = null;
    root.addEventListener("mousedown", (e) => {
      if (e.target.closest(".rk-btn, .rk-pop")) return;
      const r = root.getBoundingClientRect();
      d = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!d) return;
      if (!d.moved && Math.abs(e.clientX - d.sx) < 4 && Math.abs(e.clientY - d.sy) < 4) return;
      if (!d.moved) { root.classList.add("dragging"); closePop(); hideTip(); }
      d.moved = true;
      const x = RK.clamp(d.ox + (e.clientX - d.sx), 0, window.innerWidth - root.offsetWidth);
      const y = RK.clamp(d.oy + (e.clientY - d.sy), 0, window.innerHeight - root.offsetHeight);
      root.style.left = x + "px"; root.style.top = y + "px";
      root.style.bottom = "auto";
      root.style.transformOrigin = "top left"; root.style.transform = "scale(var(--rk-z, 1))";
    });
    window.addEventListener("mouseup", () => {
      if (!d) return;
      root.classList.remove("dragging");
      if (d.moved) {
        const r = root.getBoundingClientRect();
        RK.state.toolbarPos = { x: r.left, y: r.top };
        RK.persistUI();
      }
      d = null;
    });
  }

  RK.toolbar = {
    show() {
      // Orphaned content script (extension was reloaded) — do nothing rather than
      // build a bar wired to a dead context. A page reload injects a fresh script.
      if (!RK.alive()) return;
      RK.ensureOverlay(); if (!root) build(); restore(); RK.state.visible = true; RK.persistUI();
    },
    // Closing the toolbar also turns off every tool — nothing lingers on the page.
    hide() {
      clearAll(); closePop();
      minimized = false;
      if (handleEl) handleEl.style.display = "none";
      if (root) root.style.display = "none";
      RK.state.visible = false;
      RK.persistUI();
    },
    toggle() { (RK.state.visible ? RK.toolbar.hide : RK.toolbar.show)(); },
    render,
  };
})();
