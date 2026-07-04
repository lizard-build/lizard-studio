// Tool: Rulers + cursor coordinates.
// Draws px rulers along the top and left edges with tick labels, and live
// cursor markers + an (x, y) read-out that follows the pointer.
(function () {
  const RK = window.RK;
  const ID = "rulers";
  const SIZE = 18;        // ruler thickness in px
  const BG = "rgba(20,20,20,0.92)";   // --bg-secondary
  const TICK = "rgba(233,237,244,0.45)";
  const LABEL = "rgba(233,237,244,0.85)";

  let mmHandler = null, hx = null, vy = null, scaleG = null;

  // Redraws only the scale sub-group — the cursor crosshair lives in its own
  // sibling group, so a window resize doesn't wipe it mid-hover.
  function drawScale() {
    const g = scaleG;
    if (!g) return;
    g.replaceChildren();
    const w = window.innerWidth, h = window.innerHeight;

    // Backing bars.
    g.appendChild(RK.svg("rect", { x: 0, y: 0, width: w, height: SIZE, fill: BG }));
    g.appendChild(RK.svg("rect", { x: 0, y: 0, width: SIZE, height: h, fill: BG }));
    g.appendChild(RK.svg("rect", { x: 0, y: 0, width: SIZE, height: SIZE, fill: BG }));

    // Horizontal ticks (top ruler).
    for (let x = 0; x <= w; x += 10) {
      const major = x % 100 === 0, mid = x % 50 === 0;
      const len = major ? SIZE : mid ? SIZE * 0.6 : SIZE * 0.35;
      g.appendChild(RK.svg("line", {
        x1: x, y1: SIZE - len, x2: x, y2: SIZE, stroke: TICK, "stroke-width": 1,
      }));
      if (major && x !== 0) {
        const t = RK.svg("text", { x: x + 2, y: 9, fill: LABEL, "font-size": 8, "font-family": "ui-monospace, monospace" });
        t.textContent = x;
        g.appendChild(t);
      }
    }
    // Vertical ticks (left ruler).
    for (let y = 0; y <= h; y += 10) {
      const major = y % 100 === 0, mid = y % 50 === 0;
      const len = major ? SIZE : mid ? SIZE * 0.6 : SIZE * 0.35;
      g.appendChild(RK.svg("line", {
        x1: SIZE - len, y1: y, x2: SIZE, y2: y, stroke: TICK, "stroke-width": 1,
      }));
      if (major && y !== 0) {
        const t = RK.svg("text", {
          x: 9, y: y - 3, fill: LABEL, "font-size": 8, "font-family": "ui-monospace, monospace",
          transform: `rotate(-90 9 ${y - 3})`, "text-anchor": "end",
        });
        t.textContent = y;
        g.appendChild(t);
      }
    }
  }

  function makeCursor() {
    const a = RK.accent();
    const c = RK.svg("g", { "data-rk-cursor": "1" });
    c.appendChild(RK.svg("line", { class: "hx", stroke: a, "stroke-width": 1, "stroke-dasharray": "3 3" }));
    c.appendChild(RK.svg("line", { class: "vy", stroke: a, "stroke-width": 1, "stroke-dasharray": "3 3" }));
    return c;
  }

  function enable() {
    const g = RK.layer(ID);
    scaleG = RK.svg("g");
    g.appendChild(scaleG);
    drawScale();
    RK.on("resize", drawScale);

    const cursor = makeCursor();
    g.appendChild(cursor);
    hx = cursor.querySelector(".hx");
    vy = cursor.querySelector(".vy");
    RK.on("accent", (a) => { if (hx) hx.setAttribute("stroke", a); if (vy) vy.setAttribute("stroke", a); });
    const tag = RK.h("div", { class: "rk-tag", style: { display: "none" } });
    RK.htmlLayer(ID).appendChild(tag);

    mmHandler = RK.raf((e) => {
      if (!RK.isActive(ID)) return;
      const x = e.clientX, y = e.clientY, h = window.innerHeight, w = window.innerWidth;
      hx.setAttribute("x1", x); hx.setAttribute("y1", 0); hx.setAttribute("x2", x); hx.setAttribute("y2", h);
      vy.setAttribute("x1", 0); vy.setAttribute("y1", y); vy.setAttribute("x2", w); vy.setAttribute("y2", y);
      tag.textContent = `${x}, ${y}`;
      tag.style.display = "block";
      tag.style.left = RK.clamp(x + 12, 0, w - 60) + "px";
      tag.style.top = RK.clamp(y + 14, 0, h - 18) + "px";
    });
    window.addEventListener("mousemove", mmHandler, { passive: true });
  }

  function disable() {
    if (mmHandler) window.removeEventListener("mousemove", mmHandler);
    mmHandler = null;
    scaleG = hx = vy = null; // nodes go with RK.clearLayer on deactivate
  }

  RK.register({
    id: ID,
    name: "Rulers",
    group: "layout",
    icon: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M235.32,73.37,182.63,20.69a16,16,0,0,0-22.63,0L20.68,160a16,16,0,0,0,0,22.63l52.69,52.68a16,16,0,0,0,22.63,0L235.32,96A16,16,0,0,0,235.32,73.37ZM84.68,224,32,171.31l32-32,26.34,26.35a8,8,0,0,0,11.32-11.32L75.31,128,96,107.31l26.34,26.35a8,8,0,0,0,11.32-11.32L107.31,96,128,75.31l26.34,26.35a8,8,0,0,0,11.32-11.32L139.31,64l32-32L224,84.69Z"/></svg>`,
    enable, disable,
  });
})();
