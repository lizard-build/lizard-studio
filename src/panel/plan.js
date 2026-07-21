"use strict";
// Standalone viewer for an ExitPlanMode plan. The side panel stashes the plan
// markdown in chrome.storage.session under a throwaway id, then opens this page
// in a browser tab with that id in the location hash. We read it back and hand
// it to the shared markdown renderer so the plan reads exactly like chat.

(function () {
  const R = window.RKRender;
  const body = document.getElementById("plan-body");
  const titleEl = document.getElementById("plan-title");
  const mark = document.getElementById("plan-mark");
  if (mark && window.RKIconHTML) mark.innerHTML = window.RKIconHTML("todo", 20);

  function fail(msg) {
    body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "plan-empty";
    p.textContent = msg;
    body.appendChild(p);
  }

  const id = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  if (!id) {
    fail("No plan to show.");
    return;
  }

  function render(payload) {
    if (!payload || typeof payload.plan !== "string") {
      fail("This plan is no longer available. Ask Claude to show it again.");
      return;
    }
    const title = (payload.title || "Implementation plan").trim() || "Implementation plan";
    document.title = title + " — Lizard Studio";
    if (titleEl) titleEl.textContent = title;
    body.innerHTML = "";
    body.appendChild(R.markdown(payload.plan));
  }

  try {
    chrome.storage.session.get(id, (obj) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        fail("Couldn't load the plan.");
        return;
      }
      render(obj && obj[id]);
    });
  } catch (_) {
    fail("Couldn't load the plan.");
  }
})();
