"use strict";
// Live activity pod — ongoing work, worn as a small object at the top of the
// panel. It floats over the chat instead of pushing it down: the work it
// reports (the helper updating itself) isn't the reason the panel is open, so
// it shouldn't take the panel apart to say so.
//
// Two faces. Compact is a pill — a glyph and either the running percentage or
// the title. Expanded is the full card: glyph, title, detail, progress, an
// optional action, and a close button. It opens on hover or focus, peeks open
// for a beat when it first appears so the message is read at least once, and
// stays open on an error, which is the one state that wants an answer.
//
// Exposes window.RKLiveActivity = { create }.
//
//   const pod = RKLiveActivity.create({ label: "Host update" });
//   pod.start({ title: "Updating", detail: "Fetching…", progress: "indeterminate" });
//   pod.update({ detail: "Installed — restarting" });
//   pod.succeed({ title: "Updated", detail: "Now on 1.0.24" });   // self-dismisses
//   pod.fail({ title: "Update failed", detail: err }, { label: "Retry", onClick });

(function () {
  const ICON = window.RKIconHTML;

  // How long a freshly-started pod holds itself open before folding down to
  // the pill, and how long a finished one stays on screen.
  const PEEK_MS = 2600;
  const LINGER_MS = 2000;
  // Matches the exit transition in panel.css — the layer only leaves the
  // layout once the pod has finished going away.
  const OUT_MS = 260;

  const TEMPLATE = `
    <section class="la-pod" role="region" tabindex="-1">
      <span class="la-say" aria-live="polite"></span>
      <div class="la-face la-face-compact">
        <span class="la-glyph la-glyph-sm"></span>
        <span class="la-compact-text"></span>
      </div>
      <div class="la-face la-face-full">
        <span class="la-glyph la-glyph-lg"></span>
        <div class="la-body">
          <div class="la-title"></div>
          <div class="la-detail"></div>
          <div class="la-track hidden"><span class="la-fill"></span></div>
          <button type="button" class="la-action hidden"></button>
        </div>
        <button type="button" class="la-close"></button>
      </div>
    </section>`;

  // The three phases, drawn rather than iconified: the spinner needs its own
  // arc to sweep, and the check needs a path to draw itself along.
  function glyphHTML(phase, size) {
    const base = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"`;
    if (phase === "success") {
      return `<svg class="la-check" ${base}><path d="M4.8 12.6 9.7 17.5 19.2 7.2"/></svg>`;
    }
    if (phase === "error") {
      return `<svg ${base}><path d="M12 7.4v5.6"/><path d="M12 16.8h.01"/><circle cx="12" cy="12" r="9.2" stroke-width="2"/></svg>`;
    }
    return `<svg class="la-spin" ${base}><circle cx="12" cy="12" r="9" opacity="0.22"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>`;
  }

  function create(opts) {
    opts = opts || {};
    const width = opts.width || 300;
    const linger = opts.linger == null ? LINGER_MS : opts.linger;
    const onDismiss = typeof opts.onDismiss === "function" ? opts.onDismiss : null;

    const layer = document.createElement("div");
    layer.className = "la-layer hidden";
    layer.innerHTML = TEMPLATE;
    const pod = layer.querySelector(".la-pod");
    const say = layer.querySelector(".la-say");
    const faceCompact = layer.querySelector(".la-face-compact");
    const faceFull = layer.querySelector(".la-face-full");
    const glyphSm = layer.querySelector(".la-glyph-sm");
    const glyphLg = layer.querySelector(".la-glyph-lg");
    const compactText = layer.querySelector(".la-compact-text");
    const titleEl = layer.querySelector(".la-title");
    const detailEl = layer.querySelector(".la-detail");
    const track = layer.querySelector(".la-track");
    const fill = layer.querySelector(".la-fill");
    const actionBtn = layer.querySelector(".la-action");
    const closeBtn = layer.querySelector(".la-close");

    pod.setAttribute("aria-label", opts.label || "Activity");
    pod.style.setProperty("--la-w", `min(${width}px, calc(100vw - 24px))`);
    closeBtn.setAttribute("aria-label", opts.dismissLabel || "Dismiss activity");
    closeBtn.title = opts.dismissLabel || "Dismiss activity";
    closeBtn.innerHTML = ICON ? ICON("x", 12) : "&times;";
    (opts.mount || document.body).appendChild(layer);

    let activity = null; // { phase, title, detail, progress, action }
    let visible = false;
    let open = false; // expanded, as last laid out
    let hovered = false;
    let focused = false;
    let peeking = false;
    let peekTimer = 0;
    let lingerTimer = 0;
    let outTimer = 0;
    let said = ""; // last announced phase+text, so a re-render doesn't repeat it

    // ---- size -------------------------------------------------------------
    // The two faces are stacked on top of each other and sized by their own
    // content; the pod takes the size of whichever is showing, which is what
    // gives the morph between them something to animate. offsetWidth (not the
    // bounding rect) — the face that's on its way out is scaled down, and a
    // scaled rect would feed that back into the size.
    function wantsOpen() {
      return !!activity && (hovered || focused || peeking || activity.phase === "error");
    }
    function relayout(animate) {
      const face = open ? faceFull : faceCompact;
      if (!animate) pod.classList.add("la-nomove");
      pod.style.width = face.offsetWidth + "px";
      pod.style.height = face.offsetHeight + "px";
      if (!animate) {
        void pod.offsetWidth; // land the size before transitions come back
        pod.classList.remove("la-nomove");
      }
    }
    function sync(animate) {
      const next = wantsOpen();
      if (next !== open) {
        open = next;
        pod.classList.toggle("la-open", open);
      }
      if (visible) relayout(animate !== false);
    }
    // Text reflows when the panel is resized and when a face's content
    // changes — either way the pod has to follow it.
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => { if (visible) relayout(true); });
      ro.observe(faceCompact);
      ro.observe(faceFull);
    }

    function peek() {
      clearTimeout(peekTimer);
      peeking = true;
      sync(true);
      peekTimer = setTimeout(() => {
        peeking = false;
        sync(true);
      }, PEEK_MS);
    }

    // ---- render -----------------------------------------------------------
    function render() {
      if (!activity) return;
      const phase = activity.phase || "running";
      const title = activity.title || "";
      const detail = activity.detail || "";
      const p = activity.progress;
      const pct = typeof p === "number" ? Math.max(0, Math.min(1, p)) : null;

      pod.dataset.phase = phase;
      // Rebuilding the glyph restarts its animation, so only touch it when the
      // phase actually turns over.
      if (glyphLg.dataset.phase !== phase) {
        glyphLg.dataset.phase = phase;
        glyphSm.dataset.phase = phase;
        glyphLg.innerHTML = glyphHTML(phase, 16);
        glyphSm.innerHTML = glyphHTML(phase, 11);
      }

      titleEl.textContent = title;
      detailEl.textContent = detail;
      detailEl.classList.toggle("hidden", !detail);
      detailEl.classList.toggle("la-mono", !!activity.mono);
      compactText.textContent = phase === "running" && pct !== null ? Math.round(pct * 100) + "%" : title;

      // A bar only means anything while the work is running: on success it
      // would be a full bar nobody reads, on error a bar that lies.
      const showTrack = phase === "running" && (pct !== null || p === "indeterminate");
      track.classList.toggle("hidden", !showTrack);
      track.classList.toggle("la-indet", p === "indeterminate");
      if (pct !== null) fill.style.width = pct * 100 + "%";

      const act = activity.action;
      actionBtn.classList.toggle("hidden", !act);
      if (act) actionBtn.textContent = act.label || "Retry";

      // Nothing to close while it's still working — the pod owns its own exit
      // once it's done.
      closeBtn.classList.toggle("hidden", phase === "running");

      const line = phase === "error" ? `${title}. ${detail}` : title;
      if (line !== said) {
        said = line;
        say.textContent = line;
      }
      sync(true);
    }

    // ---- visibility -------------------------------------------------------
    function show() {
      clearTimeout(outTimer);
      if (visible) return;
      visible = true;
      layer.classList.remove("hidden");
      pod.classList.remove("la-out");
      pod.classList.add("la-enter");
      open = wantsOpen();
      pod.classList.toggle("la-open", open);
      relayout(false);
      void pod.offsetWidth; // so the browser has a "from" state to move off
      pod.classList.remove("la-enter");
    }
    function dismiss() {
      clearTimeout(peekTimer);
      clearTimeout(lingerTimer);
      peeking = false;
      if (!visible) { activity = null; return; }
      visible = false;
      pod.classList.add("la-out");
      outTimer = setTimeout(() => {
        layer.classList.add("hidden");
        activity = null;
        said = "";
      }, OUT_MS);
      if (onDismiss) onDismiss();
    }

    // ---- lifecycle --------------------------------------------------------
    function start(input) {
      clearTimeout(lingerTimer);
      clearTimeout(outTimer);
      activity = Object.assign({ phase: "running", title: "", detail: "", progress: null, action: null }, input || {});
      peek(); // decided before it arrives, so it comes in already open
      show();
      render();
    }
    // A patch to nothing is nothing: once the pod is gone (dismissed, or timed
    // out), only start() or fail() brings it back.
    function update(patch) {
      if (!activity) return;
      activity = Object.assign({}, activity, patch || {});
      render();
    }
    function succeed(patch) {
      if (!activity) return;
      activity = Object.assign({}, activity, { phase: "success", progress: null, action: null }, patch || {});
      peek(); // hold it open long enough to be read, then it leaves on its own
      render();
      clearTimeout(lingerTimer);
      lingerTimer = setTimeout(dismiss, linger);
    }
    function fail(patch, action) {
      clearTimeout(lingerTimer);
      activity = Object.assign(
        { title: "", detail: "" },
        activity,
        { phase: "error", progress: null },
        patch || {},
        { action: action || null }
      );
      show();
      render();
    }

    // ---- input ------------------------------------------------------------
    pod.addEventListener("mouseenter", () => { hovered = true; sync(true); });
    pod.addEventListener("mouseleave", () => { hovered = false; sync(true); });
    pod.addEventListener("focusin", () => { focused = true; sync(true); });
    pod.addEventListener("focusout", () => { focused = false; sync(true); });
    closeBtn.addEventListener("click", dismiss);
    actionBtn.addEventListener("click", () => {
      const act = activity && activity.action;
      if (act && typeof act.onClick === "function") act.onClick();
    });
    // Escape folds a running pod away; once it's done (or failed) the same key
    // gets rid of it, since by then there's nothing left to watch.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !visible || !activity) return;
      if (activity.phase === "running") {
        clearTimeout(peekTimer);
        peeking = false;
        hovered = false;
        sync(true);
      } else {
        dismiss();
      }
    });

    return {
      start,
      update,
      succeed,
      fail,
      dismiss,
      get phase() { return activity ? activity.phase : null; },
      get visible() { return visible; },
    };
  }

  window.RKLiveActivity = { create };
})();
