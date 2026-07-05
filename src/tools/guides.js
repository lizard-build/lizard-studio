// Tool: Guides.
// Drag from the top or bottom edge to pull a horizontal guide, from the left or
// right edge for a vertical one. Backspace/Delete removes the focused guide.
(function () {
  const RK = window.RK;
  const ID = "guides";
  const STRIP = 18;
  let guides = [];          // { axis:'h'|'v', pos }
  let ui = null, drag = null, hovered = null;

  function settings() { return RK.getSettings(ID, { items: [] }); }

  function render() {
    const g = RK.layer(ID); g.replaceChildren();
    const hg = RK.htmlLayer(ID); hg.replaceChildren();
    const w = window.innerWidth, h = window.innerHeight;
    const hintIdx = drag ? drag.index : hovered;
    const a = RK.accent();
    guides.forEach((gd, i) => {
      const active = drag && drag.index === i;
      const focus = i === hintIdx;
      const stroke = focus ? a : RK.rgba(a, 0.65);
      if (gd.axis === "h")
        g.appendChild(RK.svg("line", { x1: 0, y1: gd.pos, x2: w, y2: gd.pos, stroke, "stroke-width": focus ? 1.5 : 1 }));
      else
        g.appendChild(RK.svg("line", { x1: gd.pos, y1: 0, x2: gd.pos, y2: h, stroke, "stroke-width": focus ? 1.5 : 1 }));
      if (active) {
        const badge = RK.h("div", { class: "rk-badge" }, String(Math.round(gd.pos)));
        hg.appendChild(badge);
        badge.style.left = (gd.axis === "h" ? 40 : gd.pos) + "px";
        badge.style.top = (gd.axis === "h" ? gd.pos : 40) + "px";
      }
    });
    // Delete hint on the focused (hovered / dragged) guide.
    if (hintIdx != null && guides[hintIdx]) {
      const gd = guides[hintIdx];
      const hint = RK.h("div", { class: "rk-badge" }, `${RK.mod.del} delete`);
      hg.appendChild(hint);
      hint.style.left = (gd.axis === "h" ? 130 : gd.pos) + "px";
      hint.style.top = (gd.axis === "h" ? gd.pos : 16) + "px";
    }
    renderHandles();
  }

  function renderHandles() {
    // Reuse hit-strips across renders. Recreating them on every render would
    // destroy the strip the pointer is hovering (mouseenter triggers a render),
    // and the browser wouldn't re-target the fresh node until the mouse moves —
    // so the next mousedown would miss it and the guide couldn't be grabbed.
    const existing = [...ui.querySelectorAll(".rk-guide")];
    for (let i = guides.length; i < existing.length; i++) existing[i].remove();
    guides.forEach((gd, i) => {
      let hit = existing[i];
      if (!hit) {
        hit = RK.h("div", { class: "rk-guide" });
        const idx = () => Number(hit.dataset.idx);
        hit.addEventListener("mousedown", (e) => startDrag(idx(), hit.dataset.axis, e));
        hit.addEventListener("mouseenter", () => { if (!drag) { hovered = idx(); render(); } });
        hit.addEventListener("mouseleave", () => { if (!drag && hovered === idx()) { hovered = null; render(); } });
        ui.appendChild(hit);
      }
      hit.dataset.idx = i;
      hit.dataset.axis = gd.axis;
      Object.assign(hit.style, gd.axis === "h"
        ? { position: "fixed", left: "0", width: "100%", height: "9px", top: (gd.pos - 4) + "px", bottom: "", right: "", cursor: "row-resize" }
        : { position: "fixed", top: "0", height: "100%", width: "9px", left: (gd.pos - 4) + "px", bottom: "", right: "", cursor: "col-resize" });
    });
  }

  function remove(i) {
    if (i == null || !guides[i]) return;
    guides.splice(i, 1);
    if (drag && drag.index === i) drag = null;
    hovered = null;
    persist();
    render();
  }

  function startDrag(index, axis, e) {
    drag = { index, axis };
    e.preventDefault();
  }

  // rAF-throttled like every other tool's move handler — render() rebuilds all
  // guide lines/badges/strips, too much work to run on every raw mousemove.
  const onMove = RK.raf((e) => {
    // If we somehow missed the mouseup (released off-window, alt-tab, etc.) the
    // button is already up — finalise the drag instead of letting it stick.
    if (drag && e.buttons === 0) { onUp(); return; }
    if (!drag) return;
    guides[drag.index].pos = drag.axis === "h" ? e.clientY : e.clientX;
    render();
  });
  function onUp() { if (drag) { drag = null; persist(); render(); } }
  // Losing window focus mid-drag (alt-tab, devtools, etc.) would otherwise leave
  // drag/hovered set, freezing the guide and pinning the delete hint open.
  function onBlur() { if (drag) persist(); drag = null; hovered = null; render(); }

  function onKey(e) {
    if (e.key !== "Backspace" && e.key !== "Delete") return;
    const idx = drag ? drag.index : hovered;
    if (idx == null) return;
    e.preventDefault();
    remove(idx);
  }

  function spawn(axis, e) {
    const pos = axis === "h" ? e.clientY : e.clientX;
    guides.push({ axis, pos });
    startDrag(guides.length - 1, axis, e);
    render();
  }

  function persist() { settings().items = guides.map((g) => ({ ...g })); }

  function enable() {
    guides = (settings().items || []).map((g) => ({ ...g }));
    ui = RK.h("div", {});
    RK.ensureOverlay().ui.appendChild(ui);

    // A hit-strip on every edge: top/bottom pull horizontal guides, left/right
    // pull vertical ones. Corner guards keep overlapping strips from double-spawning.
    const top = RK.h("div", { style: { position: "fixed", top: "0", left: "0", width: "100%", height: STRIP + "px", cursor: "row-resize" } });
    const bottom = RK.h("div", { style: { position: "fixed", bottom: "0", left: "0", width: "100%", height: STRIP + "px", cursor: "row-resize" } });
    const left = RK.h("div", { style: { position: "fixed", top: "0", left: "0", width: STRIP + "px", height: "100%", cursor: "col-resize" } });
    const right = RK.h("div", { style: { position: "fixed", top: "0", right: "0", width: STRIP + "px", height: "100%", cursor: "col-resize" } });
    top.addEventListener("mousedown", (e) => { if (e.clientX > STRIP) spawn("h", e); });
    bottom.addEventListener("mousedown", (e) => { if (e.clientX > STRIP) spawn("h", e); });
    left.addEventListener("mousedown", (e) => { if (e.clientY > STRIP) spawn("v", e); });
    right.addEventListener("mousedown", (e) => { if (e.clientY > STRIP) spawn("v", e); });
    ui.appendChild(left); ui.appendChild(right); ui.appendChild(top); ui.appendChild(bottom);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    RK.on("accent", () => { if (RK.isActive(ID)) render(); });
    render();
  }

  function disable() {
    if (ui) ui.remove(); ui = null; drag = null; hovered = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("blur", onBlur);
  }

  RK.register({
    id: ID, name: "Guides (drag from edges)", group: "layout",
    // Two guide lines crossing off-center, broken at the intersection — the
    // way guides look on a canvas (vs. the old crosshair, which read as a
    // second "selector" target).
    icon: `<svg viewBox="0 0 256 256" fill="currentColor"><rect x="88" y="24" width="16" height="120" rx="8"/><rect x="88" y="176" width="16" height="56" rx="8"/><rect x="24" y="152" width="56" height="16" rx="8"/><rect x="112" y="152" width="120" height="16" rx="8"/></svg>`,
    enable, disable,
  });
})();
