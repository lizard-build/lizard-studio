// Tool: Square grid (graph-paper overlay).
// Uniform square cells via an SVG pattern, with optional bolder major lines.
// Lines are drawn in a neutral tone — dark (black) for light pages, light
// (white) for dark pages — chosen via the "Lines" control.
(function () {
  const RK = window.RK;
  const ID = "sqgrid";
  // Two independent layers: small squares (minor) and big squares (major),
  // each toggleable with its own size in px. `tone` is "auto" | "dark" | "light".
  const DEF = { minor: false, minorSize: 8, major: true, majorSize: 64, opacity: 10, tone: "auto" };

  function s() { return RK.getSettings(ID, DEF); }

  // Resolve "auto" by sampling the page's effective background luminance:
  // dark background -> light lines, light background -> dark lines.
  function resolveTone(tone) {
    if (tone === "dark" || tone === "light") return tone;
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const m = getComputedStyle(el).backgroundColor
        .match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (!m) continue;
      const a = m[4] === undefined ? 1 : Number(m[4]);
      if (a === 0) continue; // transparent — keep looking up
      const [r, g, b] = [m[1], m[2], m[3]].map(Number);
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return lum < 0.5 ? "light" : "dark";
    }
    return "dark"; // no opaque bg found -> assume a light page
  }

  // ---- render ------------------------------------------------------------
  function render() {
    const g = RK.layer(ID); g.replaceChildren();
    if (!RK.isActive(ID)) return;
    const cfg = s();
    const w = window.innerWidth, h = window.innerHeight;
    const rgb = resolveTone(cfg.tone) === "light" ? "255,255,255" : "0,0,0";
    const op = RK.clamp(cfg.opacity, 0, 100) / 100;

    const tile = (id, size, opacity) => {
      size = Math.max(2, size);
      const pat = RK.svg("pattern", { id, width: size, height: size, patternUnits: "userSpaceOnUse" });
      pat.appendChild(RK.svg("path", {
        d: `M ${size} 0 L 0 0 L 0 ${size}`, fill: "none",
        stroke: `rgba(${rgb},${opacity})`, "stroke-width": 1, "shape-rendering": "crispEdges",
      }));
      g.appendChild(pat);
      g.appendChild(RK.svg("rect", { x: 0, y: 0, width: w, height: h, fill: `url(#${id})` }));
    };

    if (cfg.minor) tile("rk-sqgrid-minor", cfg.minorSize, op);
    if (cfg.major) tile("rk-sqgrid-major", cfg.majorSize, Math.min(1, op * 2.4));
  }

  // ---- settings panel ----------------------------------------------------
  function panel(box) {
    const cfg = s();
    const number = (key, min, max, step, suffix) => RK.h("span", { class: "rk-num" }, [
      RK.h("input", { type: "number", min, max, step, value: cfg[key],
        oninput: (e) => { cfg[key] = Number(e.target.value); render(); } }),
      RK.h("span", {}, suffix),
    ]);
    // A toggleable square layer: checkbox + label on the left, its size on the right.
    const layer = (label, onKey, sizeKey, min, max) => RK.h("div", { class: "rk-layer" }, [
      RK.h("label", { class: "rk-lead" }, [
        RK.h("input", { type: "checkbox", ...(cfg[onKey] ? { checked: "" } : {}),
          onchange: (e) => { cfg[onKey] = e.target.checked; render(); } }),
        RK.h("span", {}, label),
      ]),
      number(sizeKey, min, max, 1, "px"),
    ]);
    box.appendChild(RK.h("div", { class: "rk-layers" }, [
      layer("Small", "minor", "minorSize", 2, 2000),
      layer("Big", "major", "majorSize", 2, 4000),
      RK.h("div", { class: "rk-layer" }, [
        RK.h("span", { class: "rk-lead" }, [RK.h("span", {}, "Opacity")]),
        number("opacity", 0, 100, 5, "%"),
      ]),
      RK.h("div", { class: "rk-layer" }, [
        RK.h("span", { class: "rk-lead" }, [RK.h("span", {}, "Lines")]),
        RK.h("select", { class: "rk-select",
          onchange: (e) => { cfg.tone = e.target.value; render(); } },
          [["auto", "Auto"], ["dark", "Dark"], ["light", "Light"]].map(([v, l]) =>
            RK.h("option", { value: v, ...((cfg.tone || "auto") === v ? { selected: "" } : {}) }, l))),
      ]),
    ]));
  }

  function enable() {
    render();
    RK.on("resize", render);
    RK.on("accent", render);
  }
  function disable() {}

  RK.register({
    id: ID, name: "Square grid", group: "layout",
    icon: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M200,40H56A16,16,0,0,0,40,56V200a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,80H136V56h64ZM120,56v64H56V56ZM56,136h64v64H56Zm144,64H136V136h64v64Z"/></svg>`,
    enable, disable, panel,
  });
})();
