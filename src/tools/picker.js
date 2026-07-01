// Tool: Eyedropper (пипетка).
// A custom loupe magnifier: we snapshot the visible tab (chrome.tabs.captureVisibleTab,
// under the activeTab grant) and draw our own zoomed circle centered on the cursor.
// Because it's our own canvas — not the browser's native EyeDropper chrome — we can
// paint a live readout *under the loupe* showing the color in the chosen format, and
// it updates as the cursor moves. Click to copy; Esc to cancel. If capture isn't
// available (e.g. restricted page) we fall back to the native one-shot EyeDropper.
(function () {
  const RK = window.RK;
  const ID = "picker";
  // last — the most recently picked color as "#rrggbb" (null until first pick).
  const DEF = { format: "hex", upper: true, last: null };

  const NATIVE = typeof window.EyeDropper === "function";

  function s() { return RK.getSettings(ID, DEF); }

  // ---- color formatting --------------------------------------------------
  function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, sat = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: Math.round(h * 360), s: Math.round(sat * 100), l: Math.round(l * 100) };
  }

  function format(hex, cfg) {
    const c = RK.parseColor(hex);
    if (cfg.format === "rgb") return `rgb(${c.r}, ${c.g}, ${c.b})`;
    if (cfg.format === "hsl") { const { h, s, l } = rgbToHsl(c); return `hsl(${h}, ${s}%, ${l}%)`; }
    const out = "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
    return cfg.upper ? out.toUpperCase() : out;
  }

  function hexAt(data) {
    return "#" + [data[0], data[1], data[2]]
      .map((v) => v.toString(16).padStart(2, "0")).join("");
  }

  function copied(hex, label, ok) {
    RK.toast(ok ? `Copied ${label}` : `${label} — copy failed`, { swatch: hex });
  }

  // ---- screen snapshot ---------------------------------------------------
  // Captured once when the tool activates (and re-captured on scroll/resize, since
  // a snapshot goes stale when the page moves). scaleX/Y map CSS coords -> image
  // pixels, derived from the actual capture so it's correct at any devicePixelRatio.
  let shot = null;          // { img, scaleX, scaleY }
  let captureBusy = false;

  function loadShot(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  async function capture() {
    if (captureBusy) return shot;
    captureBusy = true;
    try {
      const res = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "RK_CAPTURE" }, (r) => {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(r);
          });
        } catch (e) { resolve(null); }
      });
      if (!res || !res.ok) return shot; // keep any prior snapshot on a rate-limited miss
      const img = await loadShot(res.dataUrl);
      if (!img) return shot;
      shot = {
        img,
        scaleX: img.naturalWidth / window.innerWidth,
        scaleY: img.naturalHeight / window.innerHeight,
      };
      return shot;
    } finally {
      captureBusy = false;
    }
  }

  // ---- custom loupe ------------------------------------------------------
  const DIAM = 132;   // loupe diameter (css px)
  const CELLS = 13;   // sampled pixels across the loupe (odd → a true center cell)
  const CELL = DIAM / CELLS;

  let catcher = null, wrap = null, canvas = null, ctx = null, pill = null,
      sw = null, valEl = null, readCv = null, readCtx = null,
      curHex = "#000000", onMove = null, onKey = null, onScroll = null;

  function buildLoupe() {
    RK.ensureOverlay();

    canvas = RK.h("canvas", { width: DIAM, height: DIAM, style: {
      width: DIAM + "px", height: DIAM + "px", display: "block",
      borderRadius: "50%", imageRendering: "pixelated",
      boxShadow: "0 0 0 3px rgba(20,20,22,.92), 0 0 0 4px rgba(255,255,255,.5), 0 6px 18px rgba(0,0,0,.5)",
    } });
    ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    sw = RK.h("span", { style: {
      width: "12px", height: "12px", flex: "none", borderRadius: "3px",
      background: curHex, boxShadow: "inset 0 0 0 1px rgba(255,255,255,.4)",
    } });
    valEl = RK.h("span", {});
    // The live readout, sitting directly *under* the loupe.
    pill = RK.h("div", { style: {
      marginTop: "8px", display: "flex", alignItems: "center", gap: "7px",
      padding: "5px 9px", borderRadius: "8px", whiteSpace: "nowrap",
      background: "rgba(20,20,22,.92)", color: "#fff",
      font: "600 12px var(--rk-font)", letterSpacing: ".3px",
      fontVariantNumeric: "tabular-nums",
      border: "1px solid rgba(255,255,255,.14)", boxShadow: "0 4px 14px rgba(0,0,0,.45)",
    } }, [sw, valEl]);

    wrap = RK.h("div", { style: {
      position: "fixed", left: "0", top: "0", zIndex: "5",
      pointerEvents: "none", display: "flex", flexDirection: "column",
      alignItems: "center", opacity: "0", visibility: "hidden",
    } }, [canvas, pill]);
    RK.overlay.ui.appendChild(wrap);

    // Fullscreen pointer trap so a pick-click never reaches the page. It lives in
    // the html layer, which paints *below* the ui toolbar — so the toolbar stays
    // clickable (e.g. to toggle the tool back off).
    catcher = RK.h("div", { style: {
      position: "fixed", inset: "0", zIndex: "1",
      pointerEvents: "auto", cursor: "crosshair", background: "transparent",
    } });
    RK.overlay.html.appendChild(catcher);

    // 1×1 scratch canvas for exact center-pixel readback.
    readCv = RK.h("canvas", { width: 1, height: 1 });
    readCtx = readCv.getContext("2d", { willReadFrequently: true });
  }

  function place(x, y) {
    // Center the loupe circle exactly on the cursor (the picked pixel is the
    // loupe's center cell); the readout pill hangs directly below it. The wrap is
    // a centered flex column, so offset left by half its width and top by half the
    // canvas so the *circle* — not the whole column — is centered on the cursor.
    const w = wrap.offsetWidth || DIAM;
    wrap.style.left = (x - w / 2) + "px";
    wrap.style.top = (y - DIAM / 2) + "px";
  }

  function sample(x, y) {
    if (!shot) return;
    const sx = x * shot.scaleX, sy = y * shot.scaleY;
    const srcW = CELLS * shot.scaleX, srcH = CELLS * shot.scaleY;

    // Magnified view: pin the source rect to image bounds visually via clamping the
    // crop origin so the loupe near edges still shows real pixels.
    ctx.clearRect(0, 0, DIAM, DIAM);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(shot.img, sx - srcW / 2, sy - srcH / 2, srcW, srcH, 0, 0, DIAM, DIAM);

    // Center-cell crosshair (the pixel that will be picked).
    const o = Math.floor(CELLS / 2) * CELL;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,.7)";
    ctx.strokeRect(o + 0.5, o + 0.5, CELL - 1, CELL - 1);
    ctx.strokeStyle = "rgba(255,255,255,.95)";
    ctx.strokeRect(o + 1.5, o + 1.5, CELL - 3, CELL - 3);

    // Exact center pixel → live color readout in the chosen format.
    readCtx.clearRect(0, 0, 1, 1);
    readCtx.drawImage(shot.img, Math.floor(sx), Math.floor(sy), 1, 1, 0, 0, 1, 1);
    let data;
    try { data = readCtx.getImageData(0, 0, 1, 1).data; } catch (e) { return; }
    curHex = hexAt(data);
    sw.style.background = curHex;
    valEl.textContent = format(curHex, s());
  }

  function teardown() {
    if (onMove && catcher) catcher.removeEventListener("mousemove", onMove, true);
    if (onScroll) {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll, true);
    }
    if (onKey) window.removeEventListener("keydown", onKey, true);
    if (catcher) catcher.remove();
    if (wrap) wrap.remove();
    catcher = wrap = canvas = ctx = pill = sw = valEl = readCv = readCtx = null;
    onMove = onKey = onScroll = null;
  }

  function finish(picked) {
    if (RK.isActive(ID)) RK.deactivate(ID); // disable() runs teardown()
    if (picked) {
      const hex = curHex;
      const cfg = s();
      cfg.last = hex;
      const text = format(hex, cfg);
      RK.copy(text).then((ok) => copied(hex, text, ok));
      RK.toolbar.render(); // refresh the panel's "last picked" preview
    }
  }

  // ---- native fallback (one-shot, no live loupe) -------------------------
  async function nativePick() {
    if (!NATIVE) { RK.toast("Eyedropper unavailable on this page"); return; }
    let result;
    try { result = await new window.EyeDropper().open(); }
    catch (e) { return; } // user pressed Esc / aborted
    const hex = result.sRGBHex;
    const cfg = s();
    cfg.last = hex;
    const text = format(hex, cfg);
    const ok = await RK.copy(text);
    copied(hex, text, ok);
    RK.toolbar.render();
  }

  // ---- settings panel ----------------------------------------------------
  function panel(box) {
    const cfg = s();
    const col = RK.h("div", { class: "rk-panel-col" });

    // Format selector.
    col.appendChild(RK.h("label", { class: "rk-field" }, [
      RK.h("span", {}, "Format"),
      RK.h("select", { onchange: (e) => { cfg.format = e.target.value; render(); } },
        [["hex", "Hex"], ["rgb", "RGB"], ["hsl", "HSL"]].map(([v, l]) =>
          RK.h("option", { value: v, ...(cfg.format === v ? { selected: "" } : {}) }, l))),
    ]));

    // Uppercase toggle — only meaningful for hex.
    if (cfg.format === "hex") {
      col.appendChild(RK.h("label", { class: "rk-field" }, [
        RK.h("input", { type: "checkbox", ...(cfg.upper ? { checked: "" } : {}),
          onchange: (e) => { cfg.upper = e.target.checked; render(); } }),
        RK.h("span", {}, "Uppercase"),
      ]));
    }

    // Last picked color — swatch + value + copy-again.
    if (cfg.last) {
      const text = format(cfg.last, cfg);
      col.appendChild(RK.h("div", { class: "rk-layer", style: { marginTop: "2px" } }, [
        RK.h("span", { class: "rk-lead", style: { gap: "8px" } }, [
          RK.h("span", { style: {
            width: "18px", height: "18px", flex: "none", borderRadius: "4px",
            background: cfg.last, border: "1px solid var(--border-primary)",
          } }),
          RK.h("span", { style: { fontVariantNumeric: "tabular-nums" } }, text),
        ]),
        RK.h("button", { class: "rk-btn-sm",
          onclick: async () => { const ok = await RK.copy(text); copied(cfg.last, text, ok); } }, "Copy"),
      ]));
    }

    // Primary action.
    col.appendChild(RK.h("button", { class: "rk-btn-sm",
      style: { background: "var(--control-primary)", color: "#fff", width: "100%" },
      onclick: () => { if (!RK.isActive(ID)) RK.activate(ID); } }, "Pick color"));

    col.appendChild(RK.h("div", { class: "rk-hint" },
      "Opens a magnifier loupe — the color in the chosen format shows live beneath it. Click to copy, Esc to cancel."));

    box.appendChild(col);
  }

  function render() { RK.toolbar.render(); }

  async function enable() {
    const snap = await capture();
    if (!snap) {
      // No snapshot (restricted page / capture blocked) — degrade to the native
      // one-shot picker, then drop the tool back to inactive.
      if (RK.isActive(ID)) RK.deactivate(ID);
      nativePick();
      return;
    }

    buildLoupe();
    wrap.style.visibility = "visible";
    wrap.style.opacity = "1";

    onMove = RK.raf((e) => {
      if (!wrap) return;
      place(e.clientX, e.clientY);
      sample(e.clientX, e.clientY);
    });
    catcher.addEventListener("mousemove", onMove, true);
    // A snapshot drifts out of date once the page scrolls/resizes — refresh it
    // (capture() self-throttles via captureBusy and keeps the old shot on a miss).
    onScroll = RK.raf(() => { capture(); });
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll, true);

    catcher.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      finish(true);
    }, true);
    catcher.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      finish(false);
    }, true);
    onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    window.addEventListener("keydown", onKey, true);
  }

  function disable() { teardown(); }

  RK.register({
    id: ID, name: "Eyedropper", group: "measure",
    icon: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M221.66,34.34a32,32,0,0,0-45.32,0L139.6,71.08l-3.95-4A20,20,0,0,0,107.32,95.4l1.18,1.18L34.34,170.75A19.86,19.86,0,0,0,28.5,184.9V210L17.07,221.4a8,8,0,0,0,11.32,11.32L39.81,221.3H64.9a19.86,19.86,0,0,0,14.15-5.86l74.16-74.16,1.18,1.18a20,20,0,0,0,28.29-28.29l-3.95-3.95,36.73-36.74A32,32,0,0,0,221.66,34.34ZM67.74,204.13a4,4,0,0,1-2.84,1.17H44.5V184.9a4,4,0,0,1,1.17-2.83l74.16-74.16,28.07,28.07Z"/></svg>`,
    enable, disable, panel,
  });
})();
