// Tool: Distance-on-hover (tool id "distance").
// Also home of the shared ref-counted hover engine (RK._hoverSubscribe /
// RK.boxRects) that resolves the page element under the cursor and its
// box-model rects — selector.js depends on it, so this file loads first.
(function () {
  const RK = window.RK;

  // ---- shared hover engine ----------------------------------------------
  const subs = new Set();
  let installed = false;
  let last = null; // { el, rects }

  const onMove = RK.raf((e) => {
    const el = RK.elementAt(e.clientX, e.clientY);
    if (!el) { last = null; subs.forEach((fn) => fn(null, e)); return; }
    last = { el, rects: boxRects(el) };
    subs.forEach((fn) => fn(last, e));
  });

  function subscribe(fn) {
    subs.add(fn);
    if (!installed) {
      window.addEventListener("mousemove", onMove, { passive: true });
      // capture: true — without it only document scrolls fire, and scrolling an
      // inner overflow container leaves the overlay frozen at stale coordinates.
      window.addEventListener("scroll", reflow, { capture: true, passive: true });
      installed = true;
    }
    return () => {
      subs.delete(fn);
      if (subs.size === 0 && installed) {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("scroll", reflow, { capture: true });
        installed = false;
      }
    };
  }
  function reflow() { if (last) { last.rects = boxRects(last.el); subs.forEach((fn) => fn(last, null)); } }

  function boxRects(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
    const m = { t: n("margin-top"), r: n("margin-right"), b: n("margin-bottom"), l: n("margin-left") };
    const bd = { t: n("border-top-width"), r: n("border-right-width"), b: n("border-bottom-width"), l: n("border-left-width") };
    const p = { t: n("padding-top"), r: n("padding-right"), b: n("padding-bottom"), l: n("padding-left") };
    const border = { x: r.left, y: r.top, w: r.width, h: r.height };
    const margin = { x: r.left - m.l, y: r.top - m.t, w: r.width + m.l + m.r, h: r.height + m.t + m.b };
    const padding = { x: r.left + bd.l, y: r.top + bd.t, w: r.width - bd.l - bd.r, h: r.height - bd.t - bd.b };
    const content = { x: padding.x + p.l, y: padding.y + p.t, w: padding.w - p.l - p.r, h: padding.h - p.t - p.b };
    return { border, margin, padding, content, m, p, bd, tag: tagLabel(el) };
  }

  function tagLabel(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.classList && el.classList.length) s += "." + [...el.classList].slice(0, 2).join(".");
    return s;
  }

  function rect(attrs) { return RK.svg("rect", attrs); }

  // ---- Tool: distance-on-hover ------------------------------------------
  (function distanceTool() {
    const ID = "distance";
    let unsub = null, anchor = null, altDown = false;

    function onKey(e) {
      if (e.key === "Alt") {
        if (e.type === "keydown" && !altDown) { altDown = true; anchor = last; }
        if (e.type === "keyup") { altDown = false; anchor = null; render(last); }
      }
    }

    function gapLine(g, hg, x1, y1, x2, y2, value, axis) {
      if (value <= 0.5) return;
      g.appendChild(RK.svg("line", { x1, y1, x2, y2, stroke: "#EF4444", "stroke-width": 1 }));
      // end caps
      if (axis === "h") {
        g.appendChild(RK.svg("line", { x1, y1: y1 - 4, x2: x1, y2: y1 + 4, stroke: "#EF4444", "stroke-width": 1 }));
        g.appendChild(RK.svg("line", { x1: x2, y1: y2 - 4, x2, y2: y2 + 4, stroke: "#EF4444", "stroke-width": 1 }));
      } else {
        g.appendChild(RK.svg("line", { x1: x1 - 4, y1, x2: x1 + 4, y2: y1, stroke: "#EF4444", "stroke-width": 1 }));
        g.appendChild(RK.svg("line", { x1: x2 - 4, y1: y2, x2: x2 + 4, y2, stroke: "#EF4444", "stroke-width": 1 }));
      }
      const badge = RK.h("div", { class: "rk-badge warn" }, String(RK.round(value)));
      hg.appendChild(badge);
      badge.style.left = (x1 + x2) / 2 + "px";
      badge.style.top = (y1 + y2) / 2 + "px";
    }

    function render(hit) {
      const g = RK.layer(ID); g.replaceChildren();
      const hg = RK.htmlLayer(ID); hg.replaceChildren();

      if (altDown && anchor && hit && anchor.el !== hit.el) {
        const a = anchor.rects.border, b = hit.rects.border;
        // outline both boxes — anchor stays neutral grey, target uses the accent
        [["#5F646D", a], [RK.accent(), b]].forEach(([c, r]) =>
          g.appendChild(rect({ x: r.x, y: r.y, width: r.w, height: r.h, fill: "none", stroke: c, "stroke-width": 1, "stroke-dasharray": c === "#5F646D" ? "4 3" : "0" })));

        // vertical gap
        const cx = b.x + b.w / 2;
        if (b.y >= a.y + a.h) gapLine(g, hg, cx, a.y + a.h, cx, b.y, b.y - (a.y + a.h), "v");
        else if (b.y + b.h <= a.y) gapLine(g, hg, cx, b.y + b.h, cx, a.y, a.y - (b.y + b.h), "v");
        // horizontal gap
        const cy = b.y + b.h / 2;
        if (b.x >= a.x + a.w) gapLine(g, hg, a.x + a.w, cy, b.x, cy, b.x - (a.x + a.w), "h");
        else if (b.x + b.w <= a.x) gapLine(g, hg, b.x + b.w, cy, a.x, cy, a.x - (b.x + b.w), "h");
        return;
      }

      // idle: highlight hovered element + hint to hold Alt
      if (hit) {
        const r = hit.rects.border, a = RK.accent();
        g.appendChild(rect({ x: r.x, y: r.y, width: r.w, height: r.h, fill: RK.rgba(a, 0.1), stroke: a, "stroke-width": 1 }));
        const tip = RK.h("div", { class: "rk-badge" }, `hold ${RK.mod.alt} → measure to next element`);
        hg.appendChild(tip);
        tip.style.left = RK.clamp(r.x + r.w / 2, 60, window.innerWidth - 60) + "px";
        tip.style.top = (r.y > 22 ? r.y - 10 : r.y + r.h + 12) + "px";
      }
    }

    RK.register({
      id: ID, name: `Distance (hold ${RK.mod.alt})`, group: "measure",
      icon: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M237.66,133.66l-32,32a8,8,0,0,1-11.32-11.32L212.69,136H43.31l18.35,18.34a8,8,0,0,1-11.32,11.32l-32-32a8,8,0,0,1,0-11.32l32-32a8,8,0,0,1,11.32,11.32L43.31,120H212.69l-18.35-18.34a8,8,0,0,1,11.32-11.32l32,32A8,8,0,0,1,237.66,133.66Z"/></svg>`,
      enable() {
        unsub = subscribe((hit) => render(hit));
        RK.on("accent", () => { if (RK.isActive(ID)) render(last); });
        window.addEventListener("keydown", onKey);
        window.addEventListener("keyup", onKey);
      },
      disable() {
        if (unsub) unsub(); unsub = null; anchor = null; altDown = false;
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKey);
      },
    });
  })();

  // expose for other tools that may want box rects
  RK.boxRects = boxRects;
  RK._hoverSubscribe = subscribe;
})();
