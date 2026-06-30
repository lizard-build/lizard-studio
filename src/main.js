// Lizard Studio bootstrap.
// Tool state is ephemeral and in-memory only (see core.js): each page starts
// clean and nothing carries over. The two exceptions, both user preferences, are
// restored here: the global accent color, and whether the toolbar shell was open.
(function () {
  const RK = window.RK;

  // Restore the one persisted preference — the global accent color — before the
  // user opens the toolbar, so the swatch and any tools show the remembered hue.
  RK.loadAccent().then((hex) => { if (hex) RK.setAccent(hex, { persist: false }); });

  // The toolbar shell survives a reload: whether it was open (and where it sat)
  // is remembered, so reloading the page doesn't make the bar vanish. Tools are
  // NOT re-activated — only the empty bar comes back, ready to use.
  RK.loadUI().then((ui) => {
    if (!ui || !ui.visible) return;
    if (ui.pos) RK.state.toolbarPos = ui.pos;
    RK.toolbar.show();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !RK.alive()) return;
    if (msg.type === "RK_TOGGLE_TOOLBAR") RK.toolbar.toggle();
    // The side panel closed — closing it also closes the toolbar. (Minimizing the
    // bar to its handle is a separate action and does not close the panel.)
    else if (msg.type === "RK_HIDE_TOOLBAR") { if (RK.state.visible) RK.toolbar.hide(); }
  });
})();
