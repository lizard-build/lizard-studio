// Tool: Selector — DevTools-style hover inspection (tool id "inspect").
// Hovering any element paints its box model (margin / padding / content bands
// with size labels), tags it with a selector chip, and floats a card listing
// the computed Box Model, Appearance and Text properties.
// Reuses the shared hover engine from distance.js (RK._hoverSubscribe), which
// the manifest loads before this file.
(function () {
  const RK = window.RK;
  const ID = "inspect";

  // Box-model band fills — green for margin/padding, blue for the content box.
  const C_MARGIN = "rgba(124, 191, 117, 0.34)";
  const C_PADDING = "rgba(124, 191, 117, 0.22)";
  const C_CONTENT = "rgba(91, 141, 222, 0.34)";

  // Syntax colors for the computed-style card.
  const COL = { prop: "#C9CDD4", num: "#E2A15B", kw: "#C58AF0", font: "#9BD17C", raw: "#7E848D" };

  let unsub = null, last = null, mouse = { x: 0, y: 0 };

  // ---- box-model overlay -------------------------------------------------
  // A filled frame between an outer and inner rect (evenodd punches the hole).
  function frame(g, outer, inner, fill) {
    if (outer.w <= 0 || outer.h <= 0) return;
    const o = `M${outer.x} ${outer.y}H${outer.x + outer.w}V${outer.y + outer.h}H${outer.x}Z`;
    const i = `M${inner.x} ${inner.y}H${inner.x + inner.w}V${inner.y + inner.h}H${inner.x}Z`;
    g.appendChild(RK.svg("path", { d: o + i, fill, "fill-rule": "evenodd" }));
  }

  function sizeTag(hg, x, y, value, kind) {
    if (value <= 0.5) return;
    const t = RK.h("div", { class: "rk-tag" }, String(RK.round(value)));
    t.style.transform = "translate(-50%,-50%)";
    t.style.left = x + "px";
    t.style.top = y + "px";
    if (kind === "margin") { t.style.borderColor = "rgba(124,191,117,.5)"; t.style.color = "#A6DD9C"; }
    hg.appendChild(t);
  }

  // ---- selector chip -----------------------------------------------------
  function selectorOf(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.classList && el.classList.length) s += "." + [...el.classList].join(".");
    return s.length > 84 ? s.slice(0, 83) + "…" : s;
  }

  // ---- computed-style card ----------------------------------------------
  function rgbToHex(str) {
    const m = String(str).match(/rgba?\(([^)]+)\)/);
    if (!m) return { swatch: str, text: str };
    const parts = m[1].split(",").map((v) => parseFloat(v));
    const [r, g, b] = parts;
    const a = parts.length > 3 ? parts[3] : 1;
    const hex = "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
    return { swatch: str, text: a < 1 ? `${hex} ${Math.round(a * 100)}%` : hex };
  }

  function shorthand(t, r, b, l) {
    if (t === r && r === b && b === l) return t + "px";
    if (t === b && l === r) return `${t}px ${r}px`;
    return `${t}px ${r}px ${b}px ${l}px`;
  }

  function valueSpan(type, value) {
    if (type === "color") {
      const c = rgbToHex(value);
      return RK.h("span", { style: { display: "inline-flex", alignItems: "center", gap: "7px" } }, [
        RK.h("span", { style: {
          width: "12px", height: "12px", flex: "none", borderRadius: "3px",
          background: c.swatch, border: "1px solid rgba(255,255,255,.25)",
        } }),
        RK.h("span", { style: { color: "#D4D7DD" } }, c.text),
      ]);
    }
    return RK.h("span", { style: { color: COL[type] || COL.raw } }, value);
  }

  function row(label, type, value) {
    return RK.h("div", { style: { display: "flex", gap: "8px", alignItems: "center", whiteSpace: "nowrap" } }, [
      RK.h("span", { style: { color: COL.prop } }, label + ":"),
      valueSpan(type, value),
    ]);
  }

  function section(title, rows) {
    const kids = [RK.h("div", { style: {
      color: "#E9EDF4", fontWeight: "600", fontSize: "11px", letterSpacing: ".3px",
      fontFamily: "'Inter', system-ui, sans-serif", margin: "0 0 7px",
    } }, title)];
    rows.forEach((r) => r && kids.push(r));
    return RK.h("div", { style: {
      padding: "12px 0", borderTop: "1px solid rgba(255,255,255,.08)",
    } }, kids);
  }

  function buildCard(el) {
    let cs; try { cs = getComputedStyle(el); } catch (e) { return null; }
    const r = el.getBoundingClientRect();
    const n = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
    const flexy = /flex|grid/.test(cs.display);

    // -- Box Model
    const box = [
      row("width", "num", RK.round(r.width) + "px"),
      row("height", "num", RK.round(r.height) + "px"),
      row("display", "kw", cs.display),
    ];
    if (flexy && cs.gap && cs.gap !== "normal" && parseFloat(cs.gap) > 0) {
      const g = cs.gap.split(" ");
      box.push(row("gap", "num", g[0] === g[1] || g.length === 1 ? g[0] : cs.gap));
    }
    box.push(row("padding", "num", shorthand(n("padding-top"), n("padding-right"), n("padding-bottom"), n("padding-left"))));
    if (n("margin-top") || n("margin-right") || n("margin-bottom") || n("margin-left"))
      box.push(row("margin", "num", shorthand(n("margin-top"), n("margin-right"), n("margin-bottom"), n("margin-left"))));
    box.push(row("box-sizing", "kw", cs.boxSizing));

    // -- Appearance
    const app = [];
    if (n("border-top-left-radius")) app.push(row("border-radius", "num", cs.borderRadius));
    app.push(row("background-color", "color", cs.backgroundColor));
    app.push(row("color", "color", cs.color));
    if (n("border-top-width") > 0)
      app.push(row("border", "kw", `${RK.round(n("border-top-width"))}px ${cs.borderTopStyle}`));
    if (cs.boxShadow && cs.boxShadow !== "none")
      app.push(row("box-shadow", "raw", cs.boxShadow.length > 22 ? cs.boxShadow.slice(0, 21) + "…" : cs.boxShadow));
    if (cs.opacity && cs.opacity !== "1") app.push(row("opacity", "num", cs.opacity));

    // -- Text
    const fam = (cs.fontFamily || "").split(",")[0].replace(/['"]/g, "").trim();
    const text = [
      row("font-family", "font", fam || "—"),
      row("font-size", "num", cs.fontSize),
      row("font-weight", "num", cs.fontWeight),
      row("line-height", "num", cs.lineHeight === "normal" ? "normal" : cs.lineHeight),
      row("text-align", "kw", cs.textAlign),
    ];

    const card = RK.h("div", { style: {
      position: "fixed", boxSizing: "border-box", width: "292px", maxWidth: "calc(100vw - 16px)",
      background: "#0B0B0C", border: "1px solid #2E2E2E", borderRadius: "14px",
      boxShadow: "0 18px 50px rgba(0,0,0,.6)", padding: "2px 16px 4px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "12.5px", lineHeight: "1.75", color: "#E9EDF4",
    } }, [section("Box Model", box), section("Appearance", app), section("Text", text)]);
    // First section shouldn't carry a top divider.
    card.firstChild.style.borderTop = "0";
    return card;
  }

  // ---- render ------------------------------------------------------------
  // The selector chip and computed-style card are rebuilt (and measured — a
  // forced layout) only when the hovered element or its size changes; a plain
  // mouse move just repositions them from cached measurements. The box-model
  // bands and size labels are cheap and re-drawn every frame, since they must
  // track the rects through scroll reflows.
  let cache = null;   // { el, w, h, chip, chipW, card, cardW, cardH }
  let tagsBox = null; // per-frame container for the size labels

  function dropCache() {
    if (!cache) return;
    cache.chip.remove();
    if (cache.card) cache.card.remove();
    cache = null;
  }

  function positionChip(border) {
    // Chip sits top-left of the border box, above it when there's room.
    cache.chip.style.left = RK.clamp(border.x, 4, window.innerWidth - cache.chipW - 4) + "px";
    cache.chip.style.top = (border.y > 26 ? border.y - 24 : border.y + 4) + "px";
  }

  function positionCard() {
    // Card follows the cursor, flipping to whichever side fits.
    const { cardW, cardH } = cache;
    const vw = window.innerWidth, vh = window.innerHeight;
    const off = 16;
    let x = mouse.x + off;
    if (x + cardW > vw - 8) x = mouse.x - cardW - off;
    let y = mouse.y + off;
    if (y + cardH > vh - 8) y = mouse.y - cardH - off;
    cache.card.style.left = RK.clamp(x, 8, Math.max(8, vw - cardW - 8)) + "px";
    cache.card.style.top = RK.clamp(y, 8, Math.max(8, vh - cardH - 8)) + "px";
  }

  function render(hit, e) {
    last = hit;
    if (e) mouse = { x: e.clientX, y: e.clientY };
    const g = RK.layer(ID); g.replaceChildren();
    const hg = RK.htmlLayer(ID);
    if (!tagsBox || tagsBox.parentNode !== hg) {
      // (Re)claim the layer: deactivation wipes it, dropping our nodes.
      hg.replaceChildren();
      tagsBox = RK.h("div");
      hg.appendChild(tagsBox);
      cache = null;
    }
    tagsBox.replaceChildren();
    if (!hit) {
      dropCache();
      return;
    }

    const { margin, border, padding, content, m, p } = hit.rects;

    // Bands: margin (outer green), padding (inner green), content (blue).
    frame(g, margin, border, C_MARGIN);
    frame(g, padding, content, C_PADDING);
    g.appendChild(RK.svg("rect", { x: content.x, y: content.y, width: Math.max(0, content.w), height: Math.max(0, content.h), fill: C_CONTENT }));
    // Crisp outline on the element border box.
    g.appendChild(RK.svg("rect", { x: border.x, y: border.y, width: border.w, height: border.h,
      fill: "none", stroke: "rgba(91,141,222,.9)", "stroke-width": 1 }));

    // Margin size labels (outer edges).
    const bcx = border.x + border.w / 2, bcy = border.y + border.h / 2;
    sizeTag(tagsBox, bcx, margin.y + m.t / 2, m.t, "margin");
    sizeTag(tagsBox, bcx, border.y + border.h + m.b / 2, m.b, "margin");
    sizeTag(tagsBox, margin.x + m.l / 2, bcy, m.l, "margin");
    sizeTag(tagsBox, border.x + border.w + m.r / 2, bcy, m.r, "margin");

    // Padding size labels (inner edges).
    const ccx = content.x + content.w / 2, ccy = content.y + content.h / 2;
    sizeTag(tagsBox, ccx, padding.y + p.t / 2, p.t, "padding");
    sizeTag(tagsBox, ccx, content.y + content.h + p.b / 2, p.b, "padding");
    sizeTag(tagsBox, padding.x + p.l / 2, ccy, p.l, "padding");
    sizeTag(tagsBox, content.x + content.w + p.r / 2, ccy, p.r, "padding");

    if (!cache || cache.el !== hit.el || cache.w !== border.w || cache.h !== border.h) {
      dropCache();
      const chip = RK.h("div", { style: {
        position: "fixed", background: "#2D62F6", color: "#fff",
        font: "600 11px/1.4 'Inter', system-ui, sans-serif", padding: "3px 8px",
        borderRadius: "6px", whiteSpace: "nowrap", maxWidth: "min(420px, calc(100vw - 16px))",
        overflow: "hidden", textOverflow: "ellipsis", boxShadow: "0 4px 14px rgba(0,0,0,.4)",
      } }, selectorOf(hit.el));
      hg.appendChild(chip);
      const card = buildCard(hit.el);
      if (card) hg.appendChild(card);
      cache = {
        el: hit.el, w: border.w, h: border.h,
        chip, chipW: chip.offsetWidth,
        card, cardW: card ? card.offsetWidth : 0, cardH: card ? card.offsetHeight : 0,
      };
    }
    positionChip(border);
    if (cache.card) positionCard();
  }

  // ---- click → send element as chat context ------------------------------
  // The element's opening tag, e.g. <img class="avatar" src="…">, truncated.
  function openingTag(el) {
    const tag = el.tagName.toLowerCase();
    const attrs = [];
    for (const a of el.attributes || []) {
      let v = a.value;
      if (v && v.length > 60) v = v.slice(0, 57) + "…";
      attrs.push(v ? `${a.name}="${v}"` : a.name);
    }
    let s = `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;
    return s.length > 240 ? s.slice(0, 239) + "…>" : s;
  }

  // A compact, self-contained snapshot of the element to hand to the chat.
  function captureElement(el) {
    let cs = null;
    try { cs = getComputedStyle(el); } catch (e) { /* detached */ }
    const r = el.getBoundingClientRect();
    const px = (v) => RK.round(parseFloat(v) || 0);
    const styles = cs
      ? {
          display: cs.display,
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          fontFamily: (cs.fontFamily || "").split(",")[0].replace(/['"]/g, "").trim(),
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          textAlign: cs.textAlign,
          padding: cs.padding,
          margin: cs.margin,
          borderRadius: cs.borderRadius,
          border: cs.borderTopWidth && parseFloat(cs.borderTopWidth) > 0
            ? `${px(cs.borderTopWidth)}px ${cs.borderTopStyle} ${cs.borderTopColor}`
            : "none",
        }
      : {};
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300);
    return {
      tag: el.tagName.toLowerCase(),
      selector: selectorOf(el),
      openTag: openingTag(el),
      width: RK.round(r.width),
      height: RK.round(r.height),
      styles,
      text,
      url: location.href,
    };
  }

  function sendToChat(el) {
    const element = captureElement(el);
    let sent = false;
    try {
      if (RK.alive()) {
        chrome.runtime.sendMessage({ type: "RK_PICK_ELEMENT", element }, () => void chrome.runtime.lastError);
        sent = true;
      }
    } catch (e) { /* extension context gone */ }
    RK.toast(sent ? `Added ‹${element.tag}› to chat` : "Open the Lizard Studio panel first");
  }

  // While the Selector is active, a left-click captures the hovered element and
  // pushes it into the chat composer instead of activating the page. We swallow
  // the whole press (pointerdown/mousedown/click/auxiliary) so links and buttons
  // underneath don't fire.
  // Clicks inside Lizard Studio's own shadow overlay (the toolbar) retarget to the
  // host at the window level — leave those alone so the toolbar stays usable.
  function isOnOverlay(e) {
    const host = RK.overlay && RK.overlay.host;
    if (!host) return false;
    if (e.target === host) return true;
    const path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(host) !== -1;
  }
  function swallow(e) {
    if (e.button !== 0 && e.type !== "click") return;
    if (isOnOverlay(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }
  function onClick(e) {
    if (e.button !== 0 || isOnOverlay(e)) return;
    const el = (last && last.el) || RK.elementAt(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    if (el) sendToChat(el);
  }
  function bindClicks(on) {
    const m = on ? "addEventListener" : "removeEventListener";
    window[m]("pointerdown", swallow, true);
    window[m]("mousedown", swallow, true);
    window[m]("mouseup", swallow, true);
    window[m]("click", onClick, true);
  }

  RK.register({
    id: ID, name: "Selector", group: "measure",
    icon: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M128,40a88,88,0,1,0,88,88A88.1,88.1,0,0,0,128,40Zm8,159.6V184a8,8,0,0,0-16,0v15.6A72.15,72.15,0,0,1,56.4,136H72a8,8,0,0,0,0-16H56.4A72.15,72.15,0,0,1,120,56.4V72a8,8,0,0,0,16,0V56.4A72.15,72.15,0,0,1,199.6,120H184a8,8,0,0,0,0,16h15.6A72.15,72.15,0,0,1,136,199.6ZM128,112a16,16,0,1,0,16,16A16,16,0,0,0,128,112Z"/></svg>`,
    enable() {
      RK.ensureOverlay();
      unsub = RK._hoverSubscribe((hit, e) => render(hit, e));
      bindClicks(true);
    },
    disable() {
      if (unsub) unsub();
      unsub = null;
      last = null;
      cache = null;   // nodes themselves go with RK.clearLayer on deactivate
      tagsBox = null;
      bindClicks(false);
    },
  });
})();
