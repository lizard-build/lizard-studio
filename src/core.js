// Lizard Studio core — shared namespace, Shadow DOM overlay, state and utilities.
// All tools attach to window.RK. Everything runs in the content-script isolated world.
(function () {
  if (window.RK) return; // already injected

  const SVG_NS = "http://www.w3.org/2000/svg";
  const Z = 2147483640; // sit above almost everything

  const RK = {
    SVG_NS,
    Z,
    tools: {},          // id -> tool definition
    order: [],          // tool ids in toolbar order
    state: {
      visible: false,   // toolbar shown
      minimized: false, // toolbar collapsed to its bottom handle (persisted)
      active: {},       // id -> bool
      settings: {},     // id -> arbitrary settings object
      toolbarPos: null, // {x,y}
    },
    overlay: null,      // { host, shadow, vec, html, ui }
    _vp: null,          // active "viewport" — the responsive device frame, or null (top page)
    _listeners: {},
  };

  // ---- tiny event bus ----------------------------------------------------
  // on() returns an unsubscribe function. Subscriptions made while a tool's
  // enable() runs are tied to that activation and removed automatically on
  // deactivate — tools subscribe in enable() with no removal of their own, so
  // without this every toggle cycle stacked another permanent closure (and a
  // handler without an isActive guard kept drawing after its tool was off).
  let activationBag = null; // set by RK.activate around enable()
  const toolSubs = {};      // id -> unsubscribe functions from that activation
  RK.on = (evt, fn) => {
    const list = (RK._listeners[evt] ||= []);
    list.push(fn);
    const off = () => {
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    };
    if (activationBag) activationBag.push(off);
    return off;
  };
  // Iterate a copy so an unsubscribe during dispatch can't skip a listener.
  RK.emit = (evt, payload) => { (RK._listeners[evt] || []).slice().forEach((fn) => fn(payload)); };

  // ---- page-context provider --------------------------------------------
  // The side-panel chat asks for the live page so the user can attach "the
  // current tab" as context. We return the URL, title, any selection, and the
  // visible (rendered) text — innerText, so hidden/script content is skipped.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "RK_PAGE_CONTEXT") return;
    try {
      const sel = String(window.getSelection ? window.getSelection().toString() : "").trim();
      const root = msg.selector ? document.querySelector(msg.selector) : null;
      if (msg.selector && !root) {
        sendResponse({ ok: false, error: "No element matched selector: " + msg.selector });
        return; // sendResponse was called synchronously — no need to hold the channel open
      }
      const base = root || document.body || document.documentElement;
      const out = {
        ok: true,
        url: location.href,
        title: document.title || "",
        selection: sel.slice(0, 4000),
      };
      if (msg.format === "html") {
        const html = ((root || document.documentElement).outerHTML) || "";
        out.html = html.slice(0, 60000);
        out.truncated = html.length > 60000;
      } else {
        const raw = (base && base.innerText) || "";
        out.text = raw.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 14000);
        out.truncated = raw.length > 14000;
      }
      sendResponse(out);
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return; // sendResponse was called synchronously — no need to hold the channel open
  });

  // ---- programmatic file upload -------------------------------------------
  // browser_upload_file: the panel hands us the file (name/mime/base64) and a
  // target. Setting `.value` on a file input is forbidden, but assigning a
  // FileList built from a DataTransfer is allowed — the page sees exactly what
  // it would after a real OS file-picker choice. Non-input targets get the
  // file as a synthetic drag-and-drop instead (covers styled drop zones).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "RK_UPLOAD_FILE") return;
    try {
      const bin = atob(msg.b64 || "");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], msg.name || "file", { type: msg.mime || "application/octet-stream" });
      const dt = new DataTransfer();
      dt.items.add(file);

      let target;
      if (msg.selector) {
        target = document.querySelector(msg.selector);
        if (!target) {
          sendResponse({ ok: false, error: "No element matched selector: " + msg.selector });
          return; // sendResponse was called synchronously — no need to hold the channel open
        }
      } else {
        const inputs = document.querySelectorAll('input[type="file"]');
        if (inputs.length !== 1) {
          sendResponse({
            ok: false,
            error: inputs.length
              ? inputs.length + " file inputs on the page — pass a selector to pick one."
              : "No <input type=file> found — pass a selector for the input or drop zone.",
          });
          return; // sendResponse was called synchronously — no need to hold the channel open
        }
        target = inputs[0];
      }

      const desc = target.tagName.toLowerCase() + (target.id ? "#" + target.id : "");
      if (target instanceof HTMLInputElement && target.type === "file") {
        if (target.disabled) {
          sendResponse({ ok: false, error: "The file input is disabled." });
          return; // sendResponse was called synchronously — no need to hold the channel open
        }
        target.files = dt.files;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        sendResponse({ ok: true, via: "input", target: desc });
      } else {
        const rect = target.getBoundingClientRect();
        const opts = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          dataTransfer: dt,
        };
        target.dispatchEvent(new DragEvent("dragenter", opts));
        target.dispatchEvent(new DragEvent("dragover", opts));
        target.dispatchEvent(new DragEvent("drop", opts));
        sendResponse({ ok: true, via: "drop", target: desc });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return; // sendResponse was called synchronously — no need to hold the channel open
  });

  // ---- persistence -------------------------------------------------------
  // Tool *state* (which tools are active, their settings, guides) stays
  // in-memory only and page-scoped: every page load starts clean. Only real
  // user preferences persist — the accent color and the toolbar shell state
  // below, via chrome.storage.local.

  const ACCENT_KEY = "rk.accent";
  let accentWrite = null;
  function persistAccent(hex) {
    // Debounced: the native color picker fires oninput continuously while the
    // user drags, so only the settled value is committed to storage.
    clearTimeout(accentWrite);
    accentWrite = setTimeout(() => {
      try { chrome.storage && chrome.storage.local.set({ [ACCENT_KEY]: hex }); } catch (e) {}
    }, 250);
  }
  RK.loadAccent = () => new Promise((resolve) => {
    try {
      if (!chrome.storage) return resolve(null);
      chrome.storage.local.get(ACCENT_KEY, (r) => resolve((r && r[ACCENT_KEY]) || null));
    } catch (e) { resolve(null); }
  });

  // Toolbar shell visibility + position + collapsed state survive a reload (the
  // page itself starts clean otherwise — tools are not re-activated). The
  // minimized state is a user preference too, so it's remembered across pages and
  // across the extension being closed and reopened. main.js restores this on load.
  const UI_KEY = "rk.ui";
  let uiWrite = null;
  RK.persistUI = () => {
    clearTimeout(uiWrite);
    uiWrite = setTimeout(() => {
      try {
        chrome.storage && chrome.storage.local.set({
          [UI_KEY]: {
            visible: !!RK.state.visible,
            minimized: !!RK.state.minimized,
            pos: RK.state.toolbarPos || null,
          },
        });
      } catch (e) {}
    }, 200);
  };
  RK.loadUI = () => new Promise((resolve) => {
    try {
      if (!chrome.storage) return resolve(null);
      chrome.storage.local.get(UI_KEY, (r) => resolve((r && r[UI_KEY]) || null));
    } catch (e) { resolve(null); }
  });

  // Shell state is also synced LIVE across tabs: minimizing or moving the bar
  // in one tab updates every other open tab through storage.onChanged, not just
  // the next page load. The originating tab hears its own write too — syncUI
  // no-ops when the incoming state matches, so nothing loops.
  try {
    chrome.storage && chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[UI_KEY]) return;
      if (RK.toolbar && RK.toolbar.syncUI) RK.toolbar.syncUI(changes[UI_KEY].newValue || null);
    });
  } catch (e) {}

  // Return a STABLE settings object per tool. Defaults are filled in once and
  // missing keys are back-filled in place — the object reference never changes,
  // so a panel's captured `cfg` and a tool's render() always read/write the
  // same object and live edits actually take effect.
  RK.getSettings = (id, defaults) => {
    const cur = RK.state.settings[id] || (RK.state.settings[id] = {});
    for (const k in defaults) if (!(k in cur)) cur[k] = defaults[k];
    return cur;
  };

  // ---- DOM / SVG helpers -------------------------------------------------
  RK.h = (tag, attrs = {}, children = []) => {
    const el = document.createElement(tag);
    for (const k in attrs) {
      if (k === "style" && typeof attrs[k] === "object") Object.assign(el.style, attrs[k]);
      else if (k === "class") el.className = attrs[k];
      else if (k.startsWith("on") && typeof attrs[k] === "function")
        el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    (Array.isArray(children) ? children : [children]).forEach((c) =>
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
    );
    return el;
  };

  RK.svg = (tag, attrs = {}) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  };

  RK.clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  RK.round = (v) => Math.round(v * 10) / 10;

  // True only while this content script's link to the extension is live. After
  // the extension is reloaded/updated, already-injected scripts on open tabs are
  // orphaned: any chrome.* access then throws "Extension context invalidated".
  // Entry points check this and no-op so an orphaned instance fails silently
  // (reloading the page injects a fresh script).
  RK.alive = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };

  // ---- global accent color ----------------------------------------------
  // One color drives every tool's drawing and the whole Lizard Studio UI. Tools read
  // RK.accent() at draw time and re-draw on the "accent" event; the UI reads it
  // through CSS custom properties set on the shadow host.
  RK.state.accent = "#10B981";
  RK.accent = () => RK.state.accent || "#10B981";

  RK.parseColor = (hex) => {
    let h = String(hex || "").trim().replace(/^#/, "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    if (h.length !== 6 || Number.isNaN(n)) return { r: 16, g: 185, b: 129 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  RK.rgba = (hex, a) => { const c = RK.parseColor(hex); return `rgba(${c.r},${c.g},${c.b},${a})`; };
  // Mix toward a target channel value (0 = black, 255 = white) by amount t (0..1).
  RK.mix = (hex, target, t) => {
    const c = RK.parseColor(hex), m = (v) => Math.round(v + (target - v) * t);
    return `rgb(${m(c.r)},${m(c.g)},${m(c.b)})`;
  };
  RK.darken = (hex, t) => RK.mix(hex, 0, t);
  RK.lighten = (hex, t) => RK.mix(hex, 255, t);

  function applyAccentVars() {
    const host = RK.overlay && RK.overlay.host;
    if (!host) return;
    const a = RK.accent();
    host.style.setProperty("--rk-accent", a);
    host.style.setProperty("--rk-accent-hover", RK.darken(a, 0.18));
    host.style.setProperty("--rk-accent-weak", RK.rgba(a, 0.14));
    host.style.setProperty("--rk-accent-text", RK.lighten(a, 0.22));
  }
  RK.applyAccentVars = applyAccentVars;

  RK.setAccent = (hex, opts) => {
    if (!hex) return;
    RK.state.accent = hex;
    applyAccentVars();
    RK.emit("accent", hex);   // active tools re-draw with the new color
    if (!opts || opts.persist !== false) persistAccent(hex);
  };

  // Platform-aware modifier labels (⌥/⇧ on macOS, Alt/Shift elsewhere).
  RK.isMac = /mac/i.test(navigator.platform || "") || /Mac/.test(navigator.userAgent || "");
  RK.mod = {
    alt: RK.isMac ? "⌥" : "Alt",
    shift: RK.isMac ? "⇧" : "Shift",
    del: RK.isMac ? "⌫" : "Backspace",
  };

  // rAF throttle so mousemove handlers stay cheap
  RK.raf = (fn) => {
    let pending = false, lastArgs = null;
    return (...args) => {
      lastArgs = args;
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; fn(...lastArgs); });
    };
  };

  // The element under the cursor on the *page*, skipping our own overlay host.
  // The host is created with pointer-events:none and nothing changes it, so
  // elementFromPoint already passes through it — no per-call style toggling
  // (this runs on every hover frame; the write forced a style recalc).
  //
  // (x, y) are always SCREEN coordinates. In responsive mode the page lives in a
  // scaled iframe (see RK.setViewport): we clip to the frame's screen rect, map
  // the point into the device's own coordinate space, and hit-test the iframe's
  // document instead of the top one.
  RK.elementAt = (x, y) => {
    const vp = RK._vp;
    if (vp) {
      const r = vp.rect();
      if (x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) return null;
      return vp.doc.elementFromPoint((x - r.x) / vp.scale, (y - r.y) / vp.scale) || null;
    }
    const host = RK.overlay && RK.overlay.host;
    let el = document.elementFromPoint(x, y);
    if (host && (el === host || host.contains(el))) el = null;
    return el;
  };

  // ---- viewport (top page, or the responsive device frame) --------------
  // Most tools work in screen coordinates against the top document. Responsive
  // mode swaps in a "viewport": the page is rendered inside a scaled, same-origin
  // iframe. Registering one here re-points elementAt/boxRects at the iframe's
  // document and bridges the frame's pointer events up to the top window, so the
  // measurement tools operate on the device instead of the empty chrome around it.
  //
  // vp = { win, doc, rect() -> {x,y,w,h} (screen px), scale, vec, html }
  //   vec/html: full-viewport draw layers sitting ABOVE the iframe, so tool
  //   overlays are visible over the device (the top vec/html paint behind it).
  let vpBridgeOff = null;

  // Relay the frame's own pointer/scroll events to the top window as synthetic
  // events in screen coordinates. Tools listen on the top window as usual; when
  // the cursor is over the iframe (which otherwise swallows the events), these
  // keep hover/drag/click alive. A tool that floats its own pointer surface above
  // the frame gets real bubbled events instead and the iframe never fires — so
  // there's no double dispatch.
  function installVpBridge(vp) {
    const win = vp.win;
    const relay = (type) => (e) => {
      const r = vp.rect();
      window.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: r.x + e.clientX * vp.scale, clientY: r.y + e.clientY * vp.scale,
        button: e.button, buttons: e.buttons,
        altKey: e.altKey, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
      }));
    };
    const onScroll = () => window.dispatchEvent(new Event("scroll"));
    const h = {
      mousemove: relay("mousemove"), mousedown: relay("mousedown"),
      mouseup: relay("mouseup"), click: relay("click"), contextmenu: relay("contextmenu"),
    };
    try {
      for (const t in h) win.addEventListener(t, h[t], true);
      win.addEventListener("scroll", onScroll, true);
    } catch (e) { /* cross-origin frame — bridge unavailable */ }
    return () => {
      try {
        for (const t in h) win.removeEventListener(t, h[t], true);
        win.removeEventListener("scroll", onScroll, true);
      } catch (e) {}
    };
  }

  RK.setViewport = (vp) => {
    if (vpBridgeOff) { vpBridgeOff(); vpBridgeOff = null; }
    RK._vp = vp || null;
    if (vp) { try { vpBridgeOff = installVpBridge(vp); } catch (e) {} }
    RK.emit("viewport", vp || null);
    // Screen-space tools (grid, rulers) redraw on resize; reuse that so they
    // re-render for the new frame geometry the moment the viewport changes.
    RK.emit("resize", { w: window.innerWidth, h: window.innerHeight });
  };

  // Resolved viewport for the current frame — identity when on the top page.
  //   framed  — true only inside the responsive frame
  //   ox, oy  — screen offset of the device origin; scale — device→screen factor
  //   w, h    — device viewport size in device px
  RK.viewport = () => {
    const vp = RK._vp;
    if (!vp) return { framed: false, doc: document, win: window, ox: 0, oy: 0, scale: 1,
                      w: window.innerWidth, h: window.innerHeight };
    const r = vp.rect();
    return { framed: true, doc: vp.doc, win: vp.win, ox: r.x, oy: r.y, scale: vp.scale,
             w: r.w / vp.scale, h: r.h / vp.scale, frame: r };
  };

  // Map a device-space point to screen coordinates (identity on the top page).
  RK.toScreen = (dx, dy) => {
    const v = RK.viewport();
    return { x: v.ox + dx * v.scale, y: v.oy + dy * v.scale };
  };

  // getComputedStyle bound to the element's OWN document — the top window's
  // getComputedStyle can't read an element that lives inside the iframe.
  RK.computedStyle = (el) =>
    ((el.ownerDocument && el.ownerDocument.defaultView) || window).getComputedStyle(el);

  // z-index for a tool's own pointer surface so it floats just above the device
  // frame (which sits at z 90 in the ui layer) yet stays below the toolbar (100).
  RK.FRAME_Z = 95;

  // ---- overlay (Shadow DOM) ---------------------------------------------
  RK.ensureOverlay = () => {
    if (RK.overlay) return RK.overlay;

    const host = document.createElement("div");
    host.id = "lizard-studio-host";
    Object.assign(host.style, {
      position: "fixed", inset: "0", zIndex: String(Z),
      pointerEvents: "none", margin: "0", padding: "0", border: "0",
    });
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = BASE_CSS;
    shadow.appendChild(style);

    // Vector layer (rulers, guides, measure, box model) — full viewport SVG.
    const vec = document.createElementNS(SVG_NS, "svg");
    vec.setAttribute("class", "rk-vec");
    shadow.appendChild(vec);

    // HTML layer for labels / badges that are easier as DOM.
    const htmlLayer = RK.h("div", { class: "rk-html" });
    shadow.appendChild(htmlLayer);

    // UI layer for the interactive toolbar / panels.
    const ui = RK.h("div", { class: "rk-ui" });
    shadow.appendChild(ui);

    (document.documentElement || document.body).appendChild(host);

    RK.overlay = { host, shadow, vec, html: htmlLayer, ui };
    applyAccentVars();
    sizeVec();
    RK._baseDPR = window.devicePixelRatio || 1;
    updateZoom();
    window.addEventListener("resize", RK.raf(() => { sizeVec(); updateZoom(); }), { passive: true });
    return RK.overlay;
  };

  // Browser (Ctrl +/-) zoom scales every CSS px, so the toolbar chrome would grow
  // or shrink with the page. We counter-scale just that chrome by the inverse zoom
  // (relative to load time) via --rk-z; measurement layers are left alone so they
  // keep tracking the page. Zoom changes fire a resize, which is where we recompute.
  function updateZoom() {
    const host = RK.overlay && RK.overlay.host;
    if (!host) return;
    const z = (RK._baseDPR || 1) / (window.devicePixelRatio || 1);
    host.style.setProperty("--rk-z", String(z));
  }
  RK.updateZoom = updateZoom;

  function sizeVec() {
    const v = RK.overlay && RK.overlay.vec;
    if (!v) return;
    const w = window.innerWidth, h = window.innerHeight;
    v.setAttribute("width", w);
    v.setAttribute("height", h);
    v.setAttribute("viewBox", `0 0 ${w} ${h}`);
    RK.emit("resize", { w, h });
  }
  RK.sizeVec = sizeVec;

  // Where tool drawings go: the frame's own layers while responsive is active
  // (they paint above the iframe), otherwise the top overlay's layers.
  function drawRoots() {
    RK.ensureOverlay();
    const vp = RK._vp;
    if (vp && vp.vec && vp.html) return { vec: vp.vec, html: vp.html };
    return { vec: RK.overlay.vec, html: RK.overlay.html };
  }

  // Per-tool drawing groups in the vector layer, so a tool can clear only its own.
  RK.layer = (id) => {
    const { vec } = drawRoots();
    let g = vec.querySelector(`g[data-rk="${id}"]`);
    if (!g) {
      g = RK.svg("g", { "data-rk": id });
      vec.appendChild(g);
    }
    return g;
  };
  RK.htmlLayer = (id) => {
    const { html } = drawRoots();
    let g = html.querySelector(`div[data-rk="${id}"]`);
    if (!g) {
      g = RK.h("div", { "data-rk": id, class: "rk-hgroup" });
      html.appendChild(g);
    }
    return g;
  };
  // Clear from both the top overlay AND any frame overlay — a tool may have drawn
  // in either since the last viewport switch.
  RK.clearLayer = (id) => {
    if (!RK.overlay) return;
    const roots = [RK.overlay.vec, RK.overlay.html];
    if (RK._vp && RK._vp.vec) roots.push(RK._vp.vec, RK._vp.html);
    roots.forEach((root) => {
      const g = root.querySelector(`[data-rk="${id}"]`);
      if (g) g.replaceChildren();
    });
  };

  // ---- clipboard + toast (shared by tools) ------------------------------
  // Write text to the clipboard, falling back to a hidden textarea + execCommand
  // when the async Clipboard API is unavailable or blocked. Resolves to a bool.
  RK.copy = async (text) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to legacy path */ }
    try {
      const ta = RK.h("textarea", { style: { position: "fixed", top: "0", left: "0", opacity: "0" } });
      ta.value = text;
      (document.body || document.documentElement).appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) { return false; }
  };

  // Transient confirmation toast, top-centered in the overlay. opts.swatch draws
  // a small color square; opts.duration overrides the auto-dismiss (ms).
  let toastTimer = null;
  RK.toast = (message, opts = {}) => {
    RK.ensureOverlay();
    RK.overlay.html.querySelectorAll(".rk-toast").forEach((n) => n.remove());
    const kids = [];
    if (opts.swatch) kids.push(RK.h("span", { class: "rk-toast-sw", style: { background: opts.swatch } }));
    kids.push(RK.h("span", {}, message));
    const el = RK.h("div", { class: "rk-toast" }, kids);
    RK.overlay.html.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), opts.duration || 1600);
    return el;
  };

  // ---- tool registry -----------------------------------------------------
  // tool = { id, name, icon(svg string), group, enable(), disable(), panel?() }
  RK.register = (tool) => {
    RK.tools[tool.id] = tool;
    RK.order.push(tool.id);
    RK.state.active[tool.id] ??= false;
  };

  RK.isActive = (id) => !!RK.state.active[id];

  RK.toggle = (id) => (RK.isActive(id) ? RK.deactivate(id) : RK.activate(id));

  RK.activate = (id) => {
    const t = RK.tools[id];
    if (!t || RK.isActive(id)) return;
    RK.ensureOverlay();
    RK.state.active[id] = true;
    // Everything the tool subscribes via RK.on inside enable() lands in this
    // bag and is unsubscribed in deactivate below.
    activationBag = toolSubs[id] = [];
    try { t.enable && t.enable(); } catch (e) { console.error("[RK]", id, e); }
    finally { activationBag = null; }
    RK.emit("toolchange", { id, active: true });
  };

  RK.deactivate = (id) => {
    const t = RK.tools[id];
    if (!t || !RK.isActive(id)) return;
    RK.state.active[id] = false;
    try { t.disable && t.disable(); } catch (e) { console.error("[RK]", id, e); }
    (toolSubs[id] || []).forEach((off) => off());
    delete toolSubs[id];
    RK.clearLayer(id);
    RK.emit("toolchange", { id, active: false });
  };

  const BASE_CSS = `
    :host {
      all: initial;
      /* Lizard — Brand Design System tokens (see lizard-client/DESIGN.md) */
      --rk-font: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
      --bg-primary: #070707;
      --bg-secondary: #141414;
      --border-primary: #2E2E2E;
      --border-secondary: rgba(255, 255, 255, 0.08);
      --text-primary: #E9EDF4;
      --text-secondary: #858B94;
      --text-tertiary: #5F646D;
      /* Global accent — overridden live on the host element by RK.setAccent. */
      --rk-accent: #10B981;
      --rk-accent-hover: #059669;
      --rk-accent-weak: rgba(16, 185, 129, 0.14);
      --rk-accent-text: #34D399;
      --control-primary: var(--rk-accent);
      --control-primary-hover: var(--rk-accent-hover);
      --control-secondary: #2E2E2E;
      --control-secondary-hover: #3B3B3B;
      --gradient-primary: linear-gradient(135deg, #10B981, #D4A574);
      --other-red: #EF4444;
      --other-yellow: #F59E0B;
      --other-blue: #3B82F6;
      --other-bronze: #B08D57;
    }
    .rk-vec, .rk-html {
      position: fixed; inset: 0; width: 100%; height: 100%;
      pointer-events: none; overflow: visible;
    }
    .rk-html { font: 500 11px/1.4 var(--rk-font); font-variant-numeric: tabular-nums; }
    .rk-ui { position: fixed; inset: 0; pointer-events: none;
      font: 500 12px/1.5 var(--rk-font); }
    .rk-ui > * { pointer-events: auto; }
    .rk-badge {
      position: fixed; background: var(--bg-secondary); color: var(--text-primary);
      border: 1px solid var(--border-primary); padding: 2px 6px;
      border-radius: 6px; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.5);
      font-weight: 600; transform: translate(-50%, -50%); z-index: 2;
    }
    .rk-badge.accent { background: var(--control-primary); border-color: transparent; color: #fff; }
    .rk-badge.warn { background: var(--other-red); border-color: transparent; color: #fff; }
    .rk-tag {
      position: fixed; background: var(--bg-secondary); color: var(--text-primary);
      border: 1px solid var(--border-primary); padding:1px 5px;
      border-radius:4px; white-space:nowrap; font-weight:600;
    }
    .rk-toast {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 8px; z-index: 300;
      background: var(--bg-secondary); color: var(--text-primary);
      border: 1px solid var(--border-primary); border-radius: 8px;
      padding: 8px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.5);
      font: 600 12px var(--rk-font); white-space: nowrap; pointer-events: none;
      max-width: calc(100vw - 32px); overflow: hidden; text-overflow: ellipsis;
    }
    .rk-toast-sw { width: 16px; height: 16px; flex: none; border-radius: 4px;
      border: 1px solid rgba(255,255,255,.25); }
  `;

  window.RK = RK;
})();
