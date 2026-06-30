// Tool: Image overlay — drop a mockup over the page for pixel-perfect comparison.
// Adjustable opacity, scale and position; lock to click through. Image stays in
// memory (not persisted); the transform is remembered.
(function () {
  const RK = window.RK;
  const ID = "imgoverlay";
  const DEF = { x: 0, y: 0, scale: 100, opacity: 50, locked: false };
  let img = null, url = null, dragging = null;

  function s() { return RK.getSettings(ID, DEF); }

  function apply() {
    if (!img) return;
    const cfg = s();
    img.style.left = cfg.x + "px";
    img.style.top = cfg.y + "px";
    img.style.opacity = RK.clamp(cfg.opacity, 0, 100) / 100;
    img.style.transform = `scale(${cfg.scale / 100})`;
    img.style.pointerEvents = cfg.locked ? "none" : "auto";
    img.style.outline = cfg.locked ? "none" : `1px dashed ${RK.accent()}`;
    img.style.cursor = cfg.locked ? "default" : "move";
    // Sit above other tools' full-viewport catchers (e.g. the Picker's hit
    // surface, zIndex:1) so the image stays grabbable, but below the toolbar.
    img.style.zIndex = cfg.locked ? "" : "20";
  }

  function setImage(file) {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(file);
    if (!img) {
      img = RK.h("img", {
        style: {
          position: "fixed", top: "0", left: "0", transformOrigin: "top left",
          maxWidth: "none", userSelect: "none",
        },
      });
      img.addEventListener("mousedown", (e) => {
        if (s().locked) return;
        dragging = { sx: e.clientX, sy: e.clientY, ox: s().x, oy: s().y };
        e.preventDefault();
      });
      RK.ensureOverlay().ui.appendChild(img);
    }
    img.src = url;
    apply();
  }

  function onMove(e) {
    if (!dragging) return;
    const cfg = s();
    cfg.x = dragging.ox + (e.clientX - dragging.sx);
    cfg.y = dragging.oy + (e.clientY - dragging.sy);
    apply();
  }
  function onUp() { if (dragging) { dragging = null; RK.save(); } }

  function panel(box) {
    const cfg = s();
    const file = RK.h("input", { type: "file", accept: "image/*",
      onchange: (e) => { if (e.target.files[0]) setImage(e.target.files[0]); } });
    const slider = (label, key, min, max) => RK.h("label", { class: "rk-field" }, [
      RK.h("span", {}, label),
      RK.h("input", { type: "range", min, max, value: cfg[key],
        oninput: (e) => { cfg[key] = Number(e.target.value); apply(); RK.save(); } }),
    ]);
    const lock = RK.h("label", { class: "rk-field" }, [
      RK.h("input", { type: "checkbox", ...(cfg.locked ? { checked: "" } : {}),
        onchange: (e) => { cfg.locked = e.target.checked; apply(); RK.save(); } }),
      RK.h("span", {}, "Lock (click-through)"),
    ]);
    const clear = RK.h("button", { class: "rk-btn-sm",
      onclick: () => { if (img) { img.remove(); img = null; } if (url) { URL.revokeObjectURL(url); url = null; } } }, "Remove image");
    box.appendChild(RK.h("div", { class: "rk-panel-col" }, [
      RK.h("label", { class: "rk-field" }, [RK.h("span", {}, "Image"), file]),
      slider("Opacity", "opacity", 0, 100),
      slider("Scale %", "scale", 10, 300),
      lock, clear,
      RK.h("div", { class: "rk-hint" }, "Drag the image to position. Lock to interact with the page underneath."),
    ]));
  }

  function enable() {
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    RK.on("accent", () => { if (RK.isActive(ID)) apply(); });
    if (img) img.style.display = "block";
  }
  function disable() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (img) img.style.display = "none";
  }

  RK.register({
    id: ID, name: "Image overlay", group: "layout",
    icon: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z"/></svg>`,
    enable, disable, panel,
  });
})();
