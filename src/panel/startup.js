"use strict";

(function () {
  const screen = document.getElementById("panel-startup");
  const message = document.getElementById("panel-startup-message");
  const retry = document.getElementById("panel-startup-retry");
  let finished = false, failed = false, observer = null;
  let stage = "document";
  const timings = { document: Math.round(performance.now()) };
  const mark = (name) => {
    stage = name;
    timings[name] = Math.round(performance.now());
  };
  const report = (error) => console.warn("[Lizard Studio] Panel startup", { stage, timings, error });
  retry.addEventListener("click", () => location.reload());

  // A slow read must not become a new, empty session or trigger a reload while
  // a session is running. Keep waiting; let the user choose whether to retry.
  const slowTimer = setTimeout(() => {
    if (finished || failed) return;
    message.textContent = "Opening chats is taking longer than expected.";
    retry.hidden = false;
    screen.hidden = false;
    report("Still waiting");
  }, 10000);

  function fail(error) {
    if (finished || failed) return;
    failed = true;
    screen.hidden = false;
    clearTimeout(slowTimer);
    observer?.disconnect();
    message.textContent = "Couldn't open chats. Try again.";
    retry.hidden = false;
    report(error);
  }
  const onError = (event) => fail(event.error || event.message || "A panel resource failed to load");
  const onRejection = (event) => fail(event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  window.RKPanelStartup = {
    mark,
    fail,
    // Read from a same-extension diagnostic page without attaching DevTools
    // (which changes worker lifetime). Contains no chat text or settings.
    snapshot() {
      return { timeOrigin: performance.timeOrigin, stage, finished, failed, timings: { ...timings } };
    },
    shellReady() {
      if (finished || failed) return;
      const viewport = document.getElementById("chat-menu-viewport");
      if (!viewport) return;
      const reveal = () => {
        if (!viewport.classList.contains("ready")) return;
        screen.hidden = true;
        mark("shell-visible");
        observer?.disconnect();
      };
      observer?.disconnect();
      observer = new MutationObserver(reveal);
      observer.observe(viewport, { attributes: true, attributeFilter: ["class"] });
      reveal();
    },
    ready() {
      if (finished || failed) return;
      const viewport = document.getElementById("chat-menu-viewport");
      const reveal = () => {
        // A side panel can start at zero width. Keep the loading screen until
        // the menu has its closed position, rather than exposing a blank view.
        if (!viewport?.classList.contains("ready")) return;
        finished = true;
        mark("ready");
        clearTimeout(slowTimer);
        observer?.disconnect();
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
        screen.hidden = true;
        window.RKPanelWindow?.ready();
      };
      if (!viewport) { fail(new Error("Chat viewport missing")); return; }
      observer?.disconnect();
      observer = new MutationObserver(reveal);
      observer.observe(viewport, { attributes: true, attributeFilter: ["class"] });
      reveal();
    },
  };

  function load(tag, path) {
    return new Promise((resolve, reject) => {
      const node = document.createElement(tag);
      if (tag === "link") { node.rel = "stylesheet"; node.href = path; }
      else { node.src = path; }
      node.onload = () => {
        timings[path + ":loaded"] = Math.round(performance.now());
        resolve();
      };
      node.onerror = () => reject(new Error("Could not load " + path));
      document.head.appendChild(node);
    });
  }
  async function start() {
    try {
      mark("styles");
      await load("link", "panel.css");
      for (const path of ["window-mode.js", "icons.js", "render.js", "activity.js", "../prefs-sync.js", "chat.js", "panel.js"]) {
        if (failed) return;
        mark(path);
        await load("script", path);
        if (path === "window-mode.js") await window.RKPanelWindow?.prepare();
      }
    } catch (error) { fail(error); }
  }
  // Do not use requestAnimationFrame here: Chrome can withhold frames from its
  // hidden side-panel WebContents until the first load completes.
  const afterLoad = () => { mark("load"); setTimeout(start, 0); };
  if (document.readyState === "complete") afterLoad();
  else window.addEventListener("load", afterLoad, { once: true });
})();
