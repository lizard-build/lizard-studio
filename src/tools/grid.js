// Tool: Column grid overlay (N columns), with a settings panel.
// Centred container with max-width (or "auto" = full width minus margins),
// outer margins, N columns and gutters. Color follows the global accent.
(function () {
  const RK = window.RK;
  const ID = "grid";
  const DEF = { columns: 12, gutter: 24, maxWidth: "auto", margin: 24, opacity: 10, hidden: false };
  const COL_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24];

  function s() { return RK.getSettings(ID, DEF); }

  function render() {
    const g = RK.layer(ID); g.replaceChildren();
    if (!RK.isActive(ID)) return;
    const cfg = s();
    if (cfg.hidden) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const mw = (cfg.maxWidth === "auto" || cfg.maxWidth === "" || cfg.maxWidth == null)
      ? Infinity : Number(cfg.maxWidth);
    const contentW = Math.min(mw, vw - cfg.margin * 2);
    const left = (vw - contentW) / 2;
    const colW = (contentW - cfg.gutter * (cfg.columns - 1)) / cfg.columns;
    if (colW <= 0) return;
    const fill = RK.accent();
    const op = RK.clamp(cfg.opacity, 0, 100) / 100;
    for (let i = 0; i < cfg.columns; i++) {
      const x = left + i * (colW + cfg.gutter);
      g.appendChild(RK.svg("rect", { x, y: 0, width: colW, height: vh, fill, "fill-opacity": op }));
    }
    // container edges
    g.appendChild(RK.svg("line", { x1: left, y1: 0, x2: left, y2: vh, stroke: fill, "stroke-width": 1, "stroke-opacity": 0.6 }));
    g.appendChild(RK.svg("line", { x1: left + contentW, y1: 0, x2: left + contentW, y2: vh, stroke: fill, "stroke-width": 1, "stroke-opacity": 0.6 }));
  }

  function panel(box) {
    const cfg = s();

    const row = (label, ...ctrls) => RK.h("div", { class: "rk-prow" }, [
      RK.h("div", { class: "rk-plabel" }, label),
      RK.h("div", { class: "rk-pctl" }, ctrls),
    ]);
    const numInput = (key, min, max) => RK.h("input", {
      type: "number", value: cfg[key], min, max,
      oninput: (e) => { cfg[key] = Number(e.target.value); render(); RK.save(); },
    });

    // Columns — dropdown of common counts (current value kept if non-standard).
    const colSel = RK.h("select", {
      onchange: (e) => { cfg.columns = Number(e.target.value); render(); RK.save(); },
    });
    const choices = COL_CHOICES.includes(cfg.columns)
      ? COL_CHOICES : [...COL_CHOICES, cfg.columns].sort((a, b) => a - b);
    choices.forEach((v) => {
      const o = RK.h("option", { value: v }, String(v));
      if (v === cfg.columns) o.selected = true;
      colSel.appendChild(o);
    });

    // Max width — accepts a number or "auto".
    const mw = RK.h("input", {
      type: "text", value: cfg.maxWidth,
      onchange: (e) => {
        const v = e.target.value.trim().toLowerCase();
        cfg.maxWidth = (v === "" || v === "auto") ? "auto" : (Number(v) || "auto");
        e.target.value = cfg.maxWidth;
        render(); RK.save();
      },
    });

    // Color — drives the global accent (one color theme across all tools).
    const swatch = RK.h("input", { type: "color", class: "rk-swatch", value: RK.accent() });
    const hex = RK.h("input", { type: "text", class: "rk-hex", value: RK.accent().replace(/^#/, "").toUpperCase() });
    const sync = () => { swatch.value = RK.accent(); hex.value = RK.accent().replace(/^#/, "").toUpperCase(); };
    swatch.addEventListener("input", (e) => { RK.setAccent(e.target.value); sync(); });
    hex.addEventListener("change", (e) => {
      const v = e.target.value.trim().replace(/^#/, "");
      if (/^[0-9a-fA-F]{6}$/.test(v) || /^[0-9a-fA-F]{3}$/.test(v)) RK.setAccent("#" + v);
      sync();
    });

    // Opacity — slider.
    const op = RK.h("input", {
      type: "range", min: 0, max: 100, value: cfg.opacity,
      oninput: (e) => { cfg.opacity = Number(e.target.value); render(); RK.save(); },
    });

    box.appendChild(RK.h("div", { class: "rk-prows" }, [
      row("Columns", colSel),
      row("Max width", mw),
      row("Gutter", numInput("gutter", 0, 200)),
      row("Margin", numInput("margin", 0, 400)),
      row("Color", swatch, hex),
      row("Opacity", op),
    ]));
  }

  RK.register({
    id: ID, name: "Column grid", group: "layout",
    icon: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M104,32H64A16,16,0,0,0,48,48V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,104,32Zm0,176H64V48h40ZM192,32H152a16,16,0,0,0-16,16V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,192,32Zm0,176H152V48h40Z"/></svg>`,
    enable() { render(); RK.on("resize", render); RK.on("accent", render); },
    disable() {},
    panel,
    // Eye toggle in the panel header: hide/show the overlay without deactivating.
    isHidden() { return !!s().hidden; },
    toggleVisible() { s().hidden = !s().hidden; render(); RK.save(); },
  });
})();
