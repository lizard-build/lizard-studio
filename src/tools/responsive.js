// Tool: Responsive mode — renders the current page inside a device frame with a
// control bar (device presets, W/H, orientation, zoom). Loads the page in an
// iframe sized to the chosen viewport so real CSS media queries respond.
//
// Most sites block being framed (X-Frame-Options / CSP frame-ancestors). While
// this tool is active the service worker installs a session declarativeNetRequest
// rule that strips those headers from sub_frame requests only; it's removed the
// moment the tool turns off (see background.js, RK_RESPONSIVE_ON/OFF).
(function () {
  const RK = window.RK;
  const ID = "responsive";

  // Nested instance: the page is also injected inside our own iframe. Register
  // nothing there so we never get a device frame within a device frame.
  if (window.top !== window.self) return;

  const DEVICES = [
    { name: "Responsive", w: 0, h: 0 },
    { name: "iPhone SE", w: 375, h: 667 },
    { name: "iPhone 17", w: 390, h: 844 },
    { name: "iPhone 17 Pro Max", w: 440, h: 956 },
    { name: "Pixel 8", w: 412, h: 915 },
    { name: "Galaxy S24", w: 360, h: 780 },
    { name: "iPad mini", w: 768, h: 1024 },
    { name: "iPad Pro 11\"", w: 834, h: 1194 },
    { name: "iPad Pro 12.9\"", w: 1024, h: 1366 },
    { name: "Laptop", w: 1280, h: 800 },
    { name: "Desktop", w: 1440, h: 900 },
  ];
  const ZOOMS = ["fit", "100", "75", "50", "33", "25"];
  const DEF = { device: "iPhone 17", w: 390, h: 844, zoom: "fit" };

  function s() { return RK.getSettings(ID, DEF); }

  // Phosphor glyphs (fill weight). Reload = single arrow (arrow-clockwise);
  // rotate orientation = double arrow (arrows-clockwise) so the two read apart.
  const ICO_RELOAD = `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1-5.66-13.66l17-17-10.55-9.65-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60l10.93,10L226.34,50.3A8,8,0,0,1,240,56Z"/></svg>`;
  const ICO_ROTATE = `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M224,48V96a8,8,0,0,1-8,8H168a8,8,0,0,1-5.66-13.66L180.65,72a79.48,79.48,0,0,0-54.72-22.09h-.45A79.52,79.52,0,0,0,69.59,72.71,8,8,0,0,1,58.41,61.27,96,96,0,0,1,192,60.7l18.36-18.36A8,8,0,0,1,224,48ZM186.41,183.29A80,80,0,0,1,75.35,184l18.31-18.31A8,8,0,0,0,88,152H40a8,8,0,0,0-8,8v48a8,8,0,0,0,13.66,5.66L64,195.3a95.42,95.42,0,0,0,66,26.76h.53a95.36,95.36,0,0,0,67.07-27.33,8,8,0,0,0-11.18-11.44Z"/></svg>`;
  const ICO_CLOSE = `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>`;

  const CSS = `
    .rk-rf { position:fixed; inset:0; z-index:90; display:flex; flex-direction:column;
      background:var(--bg-primary); }
    .rk-rf-bar { position:relative; display:flex; align-items:center; justify-content:center;
      gap:8px; padding:8px 12px; flex:none;
      background:var(--bg-secondary); border-bottom:1px solid var(--border-primary);
      color:var(--text-secondary); }
    .rk-rf-bar select, .rk-rf-bar input {
      background:var(--bg-primary); color:var(--text-primary); border:1px solid var(--border-primary);
      border-radius:8px; padding:5px 8px; font:600 12px var(--rk-font); outline:none; }
    .rk-rf-bar select:focus, .rk-rf-bar input:focus { border-color:var(--rk-accent); }
    .rk-rf-bar input[type=number] { width:58px; -moz-appearance:textfield; text-align:left; }
    .rk-rf-bar input::-webkit-outer-spin-button, .rk-rf-bar input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
    .rk-rf-dims { display:flex; align-items:center; gap:6px; }
    .rk-rf-x { color:var(--text-tertiary); font-weight:600; }
    .rk-rf-ico { width:30px; height:30px; flex:none; display:flex; align-items:center; justify-content:center;
      border-radius:8px; cursor:pointer; color:var(--text-secondary); background:transparent; border:0;
      transition:background .15s, color .15s; }
    .rk-rf-ico:hover { background:var(--control-secondary); color:var(--text-primary); }
    .rk-rf-ico.danger:hover { color:var(--other-red); }
    .rk-rf-ico svg { width:16px; height:16px; display:block; }
    .rk-rf-close { position:absolute; right:12px; top:50%; transform:translateY(-50%); }
    .rk-rf-stage { flex:1; display:flex; align-items:flex-start; justify-content:center;
      overflow:auto; padding:24px 24px 104px;
      /* Aligned dot grid on the base bg. */
      background-color:var(--bg-primary);
      background-image:radial-gradient(var(--border-primary) 1.2px, transparent 1.2px);
      background-size:24px 24px; }
    .rk-rf-wrap { position:relative; flex:none; border:1px solid var(--border-primary);
      box-shadow:0 24px 70px rgba(0,0,0,.6); }
    .rk-rf-frame { border:0; background:#fff; display:block; transform-origin:top left; }
  `;

  let root = null, iframe = null, wrap = null;
  let elDevice = null, elW = null, elH = null, elZoom = null;
  let styleInjected = false;

  function injectStyle() {
    if (styleInjected) return;
    const st = RK.h("style", {}); st.textContent = CSS;
    RK.overlay.shadow.appendChild(st);
    styleInjected = true;
  }

  function ico(svg, title, cls, onclick) {
    const b = RK.h("button", { class: "rk-rf-ico" + (cls ? " " + cls : ""), "aria-label": title, title, onclick });
    b.innerHTML = svg;
    return b;
  }

  function select(value, options, onchange) {
    const sel = RK.h("select", { onchange });
    options.forEach((o) => {
      const opt = RK.h("option", { value: o.value }, o.label);
      if (String(o.value) === String(value)) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }

  // Scale the frame so the chosen viewport fits the stage (or a fixed percent).
  function relayout() {
    if (!root) return;
    const cfg = s();
    const w = Math.max(1, cfg.w), h = Math.max(1, cfg.h);
    iframe.style.width = w + "px";
    iframe.style.height = h + "px";
    let scale;
    if (cfg.zoom === "fit") {
      const availW = window.innerWidth - 48;
      const availH = window.innerHeight - 45 /*bar*/ - 24 /*top pad*/ - 104 /*bottom pad*/;
      scale = Math.min(1, availW / w, availH / h);
    } else {
      scale = Number(cfg.zoom) / 100;
    }
    iframe.style.transform = `scale(${scale})`;
    wrap.style.width = w * scale + "px";
    wrap.style.height = h * scale + "px";
  }

  function syncInputs() {
    const cfg = s();
    if (elW) elW.value = cfg.w;
    if (elH) elH.value = cfg.h;
    if (elDevice) elDevice.value = cfg.device;
    if (elZoom) elZoom.value = cfg.zoom;
  }

  function setDims(w, h, device) {
    const cfg = s();
    cfg.w = RK.clamp(Math.round(w), 80, 4000);
    cfg.h = RK.clamp(Math.round(h), 80, 4000);
    cfg.device = device;
    syncInputs(); relayout(); RK.save();
  }

  function build() {
    injectStyle();
    const cfg = s();

    iframe = RK.h("iframe", { class: "rk-rf-frame", src: location.href,
      allow: "clipboard-read; clipboard-write" });
    wrap = RK.h("div", { class: "rk-rf-wrap" }, [iframe]);
    const stage = RK.h("div", { class: "rk-rf-stage" }, [wrap]);

    elDevice = select(cfg.device, DEVICES.map((d) => ({ value: d.name, label: d.name })), (e) => {
      const d = DEVICES.find((x) => x.name === e.target.value);
      if (!d) return;
      if (d.w === 0) { setDims(cfg.w, cfg.h, "Responsive"); return; } // keep current size
      setDims(d.w, d.h, d.name);
    });

    elW = RK.h("input", { type: "number", value: cfg.w, min: 80, max: 4000,
      oninput: (e) => setDims(Number(e.target.value) || cfg.w, s().h, "Responsive") });
    elH = RK.h("input", { type: "number", value: cfg.h, min: 80, max: 4000,
      oninput: (e) => setDims(s().w, Number(e.target.value) || cfg.h, "Responsive") });

    elZoom = select(cfg.zoom, ZOOMS.map((z) => ({ value: z, label: z === "fit" ? "Fit" : z + "%" })), (e) => {
      s().zoom = e.target.value; relayout(); RK.save();
    });

    const bar = RK.h("div", { class: "rk-rf-bar" }, [
      ico(ICO_RELOAD, "Reload frame", "", () => { iframe.src = iframe.src; }),
      elDevice,
      RK.h("div", { class: "rk-rf-dims" }, [
        elW, RK.h("span", { class: "rk-rf-x" }, "×"), elH,
      ]),
      ico(ICO_ROTATE, "Rotate", "", () => setDims(s().h, s().w, s().device)),
      elZoom,
      ico(ICO_CLOSE, "Exit responsive mode", "danger rk-rf-close", () => RK.deactivate(ID)),
    ]);

    root = RK.h("div", { class: "rk-rf" }, [bar, stage]);
    RK.overlay.ui.appendChild(root);
    relayout();
  }

  function teardown() {
    if (root) root.remove();
    root = iframe = wrap = elDevice = elW = elH = elZoom = null;
  }

  RK.register({
    id: ID, name: "Responsive mode", group: "layout",
    icon: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M176,16H80A24,24,0,0,0,56,40V216a24,24,0,0,0,24,24h96a24,24,0,0,0,24-24V40A24,24,0,0,0,176,16Zm8,200a8,8,0,0,1-8,8H80a8,8,0,0,1-8-8V40a8,8,0,0,1,8-8h96a8,8,0,0,1,8,8ZM140,60a12,12,0,1,1-12-12A12,12,0,0,1,140,60Z"/></svg>`,
    enable() {
      // Ask the worker to strip framing headers while we're on, then build the UI.
      try { chrome.runtime.sendMessage({ type: "RK_RESPONSIVE_ON" }).catch(() => {}); } catch (e) {}
      build();
      RK.on("resize", relayout);
    },
    disable() {
      teardown();
      try { chrome.runtime.sendMessage({ type: "RK_RESPONSIVE_OFF" }).catch(() => {}); } catch (e) {}
    },
  });
})();
