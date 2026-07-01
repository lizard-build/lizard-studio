// Tool: Annotate.
// Mirrors Claude Code's screenshot annotator. While active, a floating toolbar
// offers freehand / line / square / circle / text tools plus four colour
// swatches. Draw straight onto the page; "Add to chat" snaps a clean screenshot,
// composites the annotations onto it, and hands the result to the side-panel chat
// as an image attachment. "Cancel" (or the trash) discards everything.
(function () {
  const RK = window.RK;
  const ID = "annotate";

  // The four swatches from the reference toolbar: red, blue, green, grey.
  const COLORS = ["#EF4444", "#3B82F6", "#22C55E", "#6B7280"];
  const STROKE = 3;     // line weight in CSS px (scaled up when compositing)
  const FONT_PX = 18;   // text size in CSS px
  const FONT_STACK = "'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif";

  // Each shape stores raw CSS-px coordinates so it can be re-rendered to the SVG
  // overlay live and re-drawn onto the capture canvas at its native resolution.
  let shapes = [];     // committed: {type,color, x1,y1,x2,y2 | points | x,y,text}
  let draft = null;    // the shape currently being dragged out
  let tool = "pencil";
  let color = COLORS[0];
  let surface = null, bar = null, styleEl = null;

  // ---- icons (Phosphor, matching the rest of the bar) --------------------
  const I = {
    pencil: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M227.31,73.37,182.63,28.69a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.69,147.31,64l24-24L216,84.69Z"/></svg>`,
    line: `<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="22" stroke-linecap="round"><line x1="56" y1="200" x2="200" y2="56"/></svg>`,
    square: `<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="18"><rect x="46" y="46" width="164" height="164" rx="10"/></svg>`,
    circle: `<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="18"><circle cx="128" cy="128" r="86"/></svg>`,
    text: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M208,56V88a8,8,0,0,1-16,0V64H136V192h24a8,8,0,0,1,0,16H96a8,8,0,0,1,0-16h24V64H64V88a8,8,0,0,1-16,0V56a8,8,0,0,1,8-8H200A8,8,0,0,1,208,56Z"/></svg>`,
    trash: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg>`,
  };
  // Bar (main toolbar) glyph — a pencil over a line, reads as "markup".
  const TOOL_ICON = I.pencil;

  const TOOLS = [
    ["pencil", I.pencil, "Draw"],
    ["line", I.line, "Line"],
    ["square", I.square, "Rectangle"],
    ["circle", I.circle, "Ellipse"],
    ["text", I.text, "Text"],
  ];

  const CSS = `
    .rk-annot { position:fixed; left:50%; bottom:24px;
      transform:translateX(-50%) scale(var(--rk-z,1)); transform-origin:bottom center;
      display:flex; align-items:center; gap:4px; padding:7px 9px; max-width:calc(100vw - 24px);
      background:var(--bg-secondary); color:var(--text-primary);
      border:1px solid var(--border-primary); border-radius:18px;
      box-shadow:0 18px 50px rgba(0,0,0,.6); font:500 12px/1.5 var(--rk-font);
      user-select:none; z-index:140; }
    .rk-annot .rk-tools { display:flex; align-items:center; gap:2px; }
    .rk-annot-sw { width:20px; height:20px; flex:none; padding:0; border-radius:50%;
      cursor:pointer; border:2px solid transparent; transition:transform .1s; }
    .rk-annot-sw:hover { transform:scale(1.14); }
    .rk-annot-sw.on { border-color:#fff; }
    .rk-annot-txt { height:30px; padding:0 12px; flex:none; border:0; border-radius:9px;
      cursor:pointer; font:600 12px var(--rk-font); background:transparent;
      color:var(--text-secondary); transition:background .15s, color .15s; }
    .rk-annot-txt:hover { background:var(--control-secondary); color:var(--text-primary); }
    .rk-annot-txt.secondary { background:var(--control-secondary); color:var(--text-primary); }
    .rk-annot-txt.secondary:hover { background:var(--control-secondary-hover); }
    .rk-annot-surface { position:fixed; inset:0; cursor:crosshair; }
    .rk-annot-input { position:fixed; z-index:150; min-width:8px;
      background:transparent; border:0; outline:0; padding:0; margin:0;
      font:600 ${FONT_PX}px/1.2 ${FONT_STACK}; white-space:pre; caret-color:currentColor; }
  `;

  // ---- rendering ---------------------------------------------------------
  function rect(s) {
    return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2),
             w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
  }

  function drawSvg(g, s) {
    const common = { fill: "none", stroke: s.color, "stroke-width": STROKE,
      "stroke-linecap": "round", "stroke-linejoin": "round" };
    if (s.type === "pencil") {
      const n = RK.svg("polyline", { ...common, points: s.points.map((p) => p.join(",")).join(" ") });
      g.appendChild(n);
    } else if (s.type === "line") {
      g.appendChild(RK.svg("line", { ...common, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 }));
    } else if (s.type === "square") {
      const r = rect(s);
      g.appendChild(RK.svg("rect", { ...common, x: r.x, y: r.y, width: r.w, height: r.h, rx: 2 }));
    } else if (s.type === "circle") {
      const r = rect(s);
      g.appendChild(RK.svg("ellipse", { ...common,
        cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: r.w / 2, ry: r.h / 2 }));
    } else if (s.type === "text") {
      const t = RK.svg("text", { x: s.x, y: s.y, fill: s.color,
        "font-size": FONT_PX, "font-weight": 600, "font-family": FONT_STACK });
      t.textContent = s.text;
      g.appendChild(t);
    }
  }

  // Committed shapes and the in-progress draft live in separate SVG groups, so
  // dragging out a shape (which re-renders every animation frame) only ever
  // touches the single-shape draft group instead of re-serializing every
  // already-committed shape on each frame.
  function renderShapes() {
    const g = RK.layer(ID); g.replaceChildren();
    for (const s of shapes) drawSvg(g, s);
  }
  function renderDraft() {
    const g = RK.layer(ID + ":draft"); g.replaceChildren();
    if (draft) drawSvg(g, draft);
  }
  function render() { renderShapes(); renderDraft(); }

  // ---- pointer drawing ---------------------------------------------------
  function hasSize(s) {
    if (s.type === "pencil") return s.points.length > 1;
    return Math.abs(s.x2 - s.x1) > 2 || Math.abs(s.y2 - s.y1) > 2;
  }

  function onDown(e) {
    if (e.button !== 0) return;
    const x = e.clientX, y = e.clientY;
    if (tool === "text") { startText(x, y); return; }
    e.preventDefault();
    draft = tool === "pencil"
      ? { type: "pencil", color, points: [[x, y]] }
      : { type: tool, color, x1: x, y1: y, x2: x, y2: y };
  }
  const onMove = RK.raf((e) => {
    if (!draft) return;
    if (draft.type === "pencil") draft.points.push([e.clientX, e.clientY]);
    else { draft.x2 = e.clientX; draft.y2 = e.clientY; }
    renderDraft();
  });
  function onUp() {
    if (!draft) return;
    if (hasSize(draft)) shapes.push(draft);
    draft = null;
    render();
  }

  // A click with the text tool drops an inline input; Enter / blur commits.
  function startText(x, y) {
    const input = RK.h("input", { class: "rk-annot-input", type: "text", spellcheck: "false" });
    input.style.left = x + "px";
    input.style.top = (y - FONT_PX) + "px"; // align the input baseline with click point
    input.style.color = color;
    RK.overlay.ui.appendChild(input);
    requestAnimationFrame(() => input.focus());
    let done = false;
    const commit = (keep) => {
      if (done) return; done = true;
      const val = input.value.trim();
      input.remove();
      if (keep && val) { shapes.push({ type: "text", color, x, y, text: val }); render(); }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); commit(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", () => commit(true));
  }

  function onKey(e) {
    if (!RK.isActive(ID)) return;
    // Undo the last shape on ⌘/Ctrl+Z; ignore while typing into a text input.
    const typing = RK.overlay && RK.overlay.shadow.activeElement
      && RK.overlay.shadow.activeElement.classList.contains("rk-annot-input");
    if (typing) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault(); shapes.pop(); render();
    }
  }

  function clearAll() { shapes = []; draft = null; render(); }

  // ---- toolbar -----------------------------------------------------------
  function swatch(c) {
    const b = RK.h("button", { class: "rk-annot-sw" + (c === color ? " on" : ""),
      style: { background: c }, "aria-label": c, title: c });
    b.addEventListener("click", () => { color = c; paintBar(); });
    return b;
  }
  function toolBtn(id, icon, label) {
    const b = RK.h("button", { class: "rk-btn" + (id === tool ? " on" : ""),
      "aria-label": label, title: label });
    b.innerHTML = icon;
    b.addEventListener("click", () => { tool = id; paintBar(); });
    return b;
  }
  function txtBtn(label, cls, onclick) {
    const b = RK.h("button", { class: "rk-annot-txt" + (cls ? " " + cls : "") }, label);
    b.addEventListener("click", onclick);
    return b;
  }

  function paintBar() {
    if (!bar) return;
    bar.replaceChildren();
    const tools = RK.h("div", { class: "rk-tools" });
    TOOLS.forEach(([id, icon, label]) => tools.appendChild(toolBtn(id, icon, label)));
    bar.appendChild(tools);
    bar.appendChild(RK.h("div", { class: "rk-div" }));
    COLORS.forEach((c) => bar.appendChild(swatch(c)));
    bar.appendChild(RK.h("div", { class: "rk-div" }));
    const trash = RK.h("button", { class: "rk-btn danger", "aria-label": "Clear", title: "Clear all" });
    trash.innerHTML = I.trash;
    trash.addEventListener("click", clearAll);
    bar.appendChild(trash);
    bar.appendChild(RK.h("div", { class: "rk-div" }));
    bar.appendChild(txtBtn("Cancel", "", () => finish(false)));
    bar.appendChild(txtBtn("Add to chat", "secondary", () => addToChat()));
    if (surface) surface.style.cursor = tool === "text" ? "text" : "crosshair";
  }

  // Dock our bar over the main toolbar's old spot: same top edge, centered on its
  // center-x, clamped on-screen (our bar is wider than the icon-only main bar).
  function dockOver(el, r) {
    const w = el.offsetWidth;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    el.style.left = left + "px";
    el.style.top = r.top + "px";
    el.style.bottom = "auto";
    el.style.transform = "scale(var(--rk-z,1))";
    el.style.transformOrigin = "top left";
  }

  // ---- capture + composite ----------------------------------------------
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  function capture() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "RK_CAPTURE" }, (r) =>
          resolve(chrome.runtime.lastError || !r || !r.ok ? null : r.dataUrl));
      } catch (_) { resolve(null); }
    });
  }

  // Re-draw every shape onto the captured bitmap at its native resolution, so the
  // annotations land crisp regardless of the device pixel ratio of the snapshot.
  function composite(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const s = img.naturalWidth / window.innerWidth; // CSS-px → snapshot-px
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        for (const sh of shapes) {
          ctx.strokeStyle = sh.color; ctx.fillStyle = sh.color; ctx.lineWidth = STROKE * s;
          if (sh.type === "pencil") {
            ctx.beginPath();
            sh.points.forEach((p, i) => ctx[i ? "lineTo" : "moveTo"](p[0] * s, p[1] * s));
            ctx.stroke();
          } else if (sh.type === "line") {
            ctx.beginPath(); ctx.moveTo(sh.x1 * s, sh.y1 * s); ctx.lineTo(sh.x2 * s, sh.y2 * s); ctx.stroke();
          } else if (sh.type === "square") {
            const r = rect(sh); ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);
          } else if (sh.type === "circle") {
            const r = rect(sh);
            ctx.beginPath();
            ctx.ellipse((r.x + r.w / 2) * s, (r.y + r.h / 2) * s, (r.w / 2) * s, (r.h / 2) * s, 0, 0, Math.PI * 2);
            ctx.stroke();
          } else if (sh.type === "text") {
            ctx.font = `600 ${FONT_PX * s}px ${FONT_STACK}`;
            ctx.textBaseline = "alphabetic";
            ctx.fillText(sh.text, sh.x * s, sh.y * s);
          }
        }
        resolve(cv.toDataURL("image/png"));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  async function addToChat() {
    // Hide our overlay so the snapshot is clean — we paint the annotations back
    // on ourselves from the shape data, avoiding any double exposure.
    const host = RK.overlay.host;
    host.style.visibility = "hidden";
    await nextFrame(); await nextFrame();
    let shot = null;
    try { shot = await capture(); } finally { host.style.visibility = ""; }
    if (!shot) { RK.toast("Couldn't capture the page"); return; }
    const out = shapes.length ? await composite(shot) : shot;
    try {
      chrome.runtime.sendMessage({ type: "RK_ADD_TO_CHAT", dataUrl: out });
      RK.toast("Added to chat", { swatch: color });
    } catch (_) { RK.toast("Couldn't reach the chat panel"); return; }
    finish(true);
  }

  // Tear the tool down and reflect the off-state on the main bar.
  function finish() {
    RK.deactivate(ID);
    if (RK.toolbar && RK.toolbar.render) RK.toolbar.render();
  }

  // ---- lifecycle ---------------------------------------------------------
  function enable() {
    const ui = RK.ensureOverlay().ui;
    if (!styleEl) {
      styleEl = RK.h("style", {});
      styleEl.textContent = CSS;
      RK.overlay.shadow.appendChild(styleEl);
    }
    // The drawing surface sits BEHIND the main bar (prepended) so the toolbar
    // stays clickable; our own annotate bar is appended on top of everything.
    surface = RK.h("div", { class: "rk-annot-surface" });
    surface.addEventListener("mousedown", onDown);
    ui.prepend(surface);

    // Replace the main toolbar rather than stack a second bar on top of it: grab
    // its current spot, hide it, then dock our bar in the same place. Cancel /
    // Add to chat run disable(), which reveals the main bar again.
    const spot = RK.toolbar && RK.toolbar.barRect ? RK.toolbar.barRect() : null;
    if (RK.toolbar && RK.toolbar.conceal) RK.toolbar.conceal();

    bar = RK.h("div", { class: "rk-annot" });
    ui.appendChild(bar);
    paintBar();
    if (spot) dockOver(bar, spot);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey, true);
    render();
  }

  function disable() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey, true);
    // Bring the main toolbar back — it was concealed while we took its place.
    if (RK.toolbar && RK.toolbar.reveal) RK.toolbar.reveal();
    if (surface) surface.remove();
    if (bar) bar.remove();
    RK.overlay && RK.overlay.ui.querySelectorAll(".rk-annot-input").forEach((n) => n.remove());
    surface = bar = null;
    shapes = []; draft = null;
  }

  RK.register({
    id: ID, name: "Annotate", group: "measure",
    icon: TOOL_ICON,
    enable, disable,
  });
})();
