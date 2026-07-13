// Lizard Studio bootstrap.
// Tool state is ephemeral and in-memory only (see core.js): each page starts
// clean and nothing carries over. The two exceptions, both user preferences, are
// restored here: the global accent color, and whether the toolbar shell was open.
(function () {
  const RK = window.RK;
  // Double injection (programmatic + manifest) must not bootstrap twice — a
  // second pass would stack another onMessage listener and re-run the restore.
  if (RK.__bootstrapped) return;
  RK.__bootstrapped = true;

  // Restore the one persisted preference — the global accent color — before the
  // user opens the toolbar, so the swatch and any tools show the remembered hue.
  RK.loadAccent().then((hex) => { if (hex) RK.setAccent(hex, { persist: false }); });

  // The toolbar shell survives a reload: whether it was open (and where it sat)
  // is remembered, so reloading the page doesn't make the bar vanish. Tools are
  // NOT re-activated — only the empty bar comes back, ready to use.
  RK.loadUI().then((ui) => {
    if (!ui) return;
    // Restore the collapsed state even when the bar isn't currently shown, so a
    // later open (e.g. the side panel connecting) brings it back the way the user
    // left it. Position and the minimized preference persist across pages and
    // across the extension closing and reopening.
    RK.state.minimized = !!ui.minimized;
    if (ui.pos) RK.state.toolbarPos = ui.pos;
    if (ui.visible) RK.toolbar.show();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !RK.alive()) return;
    if (msg.type === "RK_TOGGLE_TOOLBAR") RK.toolbar.toggle();
    // The side panel opened — bring the bar up alongside it. This is broadcast to
    // every tab, so only respond if this is the foreground tab the user is looking
    // at. Skip if the bar is already shown, so a minimized bar (still "visible") is
    // left untouched and service-worker reconnects don't re-open it.
    else if (msg.type === "RK_SHOW_TOOLBAR") {
      if (!RK.state.visible && document.visibilityState === "visible") RK.toolbar.show();
    }
    // The side panel closed — closing it also closes the toolbar. (Minimizing the
    // bar to its handle is a separate action and does not close the panel.)
    else if (msg.type === "RK_HIDE_TOOLBAR") { if (RK.state.visible) RK.toolbar.hide(); }
  });
})();
