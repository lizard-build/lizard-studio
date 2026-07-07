// Tool: Column grid overlay (N columns), with a settings panel.
// Centred container with max-width (or "auto" = full width minus margins),
// outer margins, N columns and gutters. Color follows the global accent.
(function () {
  const RK = window.RK;
  const ID = "grid";
  const DEF = { columns: 4, gutter: 24, maxWidth: "auto", margin: 24, opacity: 10, color: "#10B981" };

  function s() { return RK.getSettings(ID, DEF); }

  function render() {
    const g = RK.layer(ID); g.replaceChildren();
    if (!RK.isActive(ID)) return;
    const cfg = s();
    // Lay the grid out in the active viewport — the device's own px in responsive
    // mode — then map each column to screen space. Columns/margins stay authored
    // in device px; sc scales the drawing to sit over the (shrunken) frame.
    const v = RK.viewport();
    const vw = v.w, vh = v.h, sc = v.scale;
    const X = (dx) => v.ox + dx * sc, Y = (dy) => v.oy + dy * sc;
    const mw = (cfg.maxWidth === "auto" || cfg.maxWidth === "" || cfg.maxWidth == null)
      ? Infinity : Number(cfg.maxWidth);
    const contentW = Math.min(mw, vw - cfg.margin * 2);
    const left = (vw - contentW) / 2;
    const colW = (contentW - cfg.gutter * (cfg.columns - 1)) / cfg.columns;
    if (colW <= 0) return;
    const fill = cfg.color || RK.accent();
    const op = RK.clamp(cfg.opacity, 0, 100) / 100;
    for (let i = 0; i < cfg.columns; i++) {
      const x = left + i * (colW + cfg.gutter);
      g.appendChild(RK.svg("rect", { x: X(x), y: Y(0), width: colW * sc, height: vh * sc, fill, "fill-opacity": op }));
    }
    // container edges
    g.appendChild(RK.svg("line", { x1: X(left), y1: Y(0), x2: X(left), y2: Y(vh), stroke: fill, "stroke-width": 1, "stroke-opacity": 0.6 }));
    g.appendChild(RK.svg("line", { x1: X(left + contentW), y1: Y(0), x2: X(left + contentW), y2: Y(vh), stroke: fill, "stroke-width": 1, "stroke-opacity": 0.6 }));
  }

  function panel(box) {
    const cfg = s();

    const row = (label, ...ctrls) => RK.h("div", { class: "rk-prow" }, [
      RK.h("div", { class: "rk-plabel" }, label),
      RK.h("div", { class: "rk-pctl" }, ctrls),
    ]);
    const numInput = (key, min, max) => RK.h("input", {
      type: "number", value: cfg[key], min, max,
      oninput: (e) => { cfg[key] = Number(e.target.value); render(); },
    });

    // Max width — a pixel cap on the grid container. Empty = "auto": the grid
    // spans the full viewport minus the margins. A number input (empty shows the
    // "auto" placeholder) keeps it consistent with the other rows and updates
    // live, instead of the old text field that silently swallowed bad input.
    const mwVal = (cfg.maxWidth === "auto" || cfg.maxWidth === "" || cfg.maxWidth == null)
      ? "" : cfg.maxWidth;
    const mw = RK.h("input", {
      type: "number", min: 0, placeholder: "auto", value: mwVal,
      oninput: (e) => {
        const v = e.target.value.trim();
        cfg.maxWidth = v === "" ? "auto" : Math.max(0, Number(v));
        render();
      },
    });

    // Color — local to the grid overlay only (does not touch the global accent).
    const swatch = RK.h("input", { type: "color", class: "rk-swatch", value: cfg.color });
    const hex = RK.h("input", { type: "text", class: "rk-hex", value: cfg.color.replace(/^#/, "").toUpperCase() });
    const sync = () => { swatch.value = cfg.color; hex.value = cfg.color.replace(/^#/, "").toUpperCase(); };
    swatch.addEventListener("input", (e) => { cfg.color = e.target.value; sync(); render(); });
    hex.addEventListener("change", (e) => {
      const v = e.target.value.trim().replace(/^#/, "");
      if (/^[0-9a-fA-F]{6}$/.test(v) || /^[0-9a-fA-F]{3}$/.test(v)) cfg.color = "#" + v;
      sync();
      render();
    });

    // Opacity — slider. --rk-range drives the white filled portion (0..100 maps
    // directly to a percentage since min/max are 0/100).
    const op = RK.h("input", {
      type: "range", min: 0, max: 100, value: cfg.opacity,
      oninput: (e) => {
        cfg.opacity = Number(e.target.value);
        e.target.style.setProperty("--rk-range", cfg.opacity + "%");
        render();
      },
    });
    op.style.setProperty("--rk-range", cfg.opacity + "%");

    box.appendChild(RK.h("div", { class: "rk-prows" }, [
      row("Columns", numInput("columns", 1, 48)),
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
    enable() { render(); RK.on("resize", render); },
    disable() {},
    panel,
    // Left-clicking the toolbar button opens this panel; it never draws on its
    // own. The eye toggle in the header is what draws the grid — it activates
    // the tool (render + subscribe) and deactivates it (clear the overlay).
    panelOnClick: true,
    isHidden() { return !RK.isActive(ID); },
    toggleVisible() { RK.toggle(ID); },
  });
})();
