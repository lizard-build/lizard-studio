"use strict";

// Run each scenario in a fresh panel.html?onboarding=<scenario> page.
window.runOnboardingPanelTests = async function () {
  const t = window.__test, checks = [];
  const scenario = new URLSearchParams(location.search).get("onboarding");
  const check = (name, ok) => { if (!ok) throw new Error(name); checks.push(name); };
  const node = (selector) => document.querySelector(selector);
  const claude = (ok) => t.emit({ type: "ready", version: 33, ok, home: "/test" });
  const codex = (ok) => t.emit({ type: "agentReady", agent: "codex", version: 6, ok });
  const hidden = () => node("#chat-onboarding").classList.contains("hidden");
  const selected = () => t.storage.rkChatV2.tabs.find((c) => c.id === t.storage.rkChatV2.activeId);
  check("CLI installation starts unchecked", !node("#ob-node-claude").classList.contains("done"));
  check("roulette contains Claude, ChatGPT, and the loop frame", node("#onboarding-logo-claude").querySelectorAll(".onboarding-reel-item").length === 3);

  if (scenario === "disconnected") {
    t.disconnect();
    check("connection screen names both agents", !hidden() && node("#ob-card-link").textContent.includes("Claude Code or ChatGPT"));
    check("an absent helper cannot confirm CLI installation", !node("#ob-node-claude").classList.contains("done"));
    check("unchecked installation explains why the helper is needed", t.text("#ob-agent-status").includes("Connect the helper to check"));
    check("both installers are offered before the helper connects", !node("#ob-install-options").classList.contains("hidden"));
    node("#ob-install-options").open = true;
    t.click('[data-agent="codex"]');
    check("Codex can be selected before connecting", t.text("#ob-claude-cmd") === "npm i -g @openai/codex");
    return { passed: checks.length, checks };
  }
  if (scenario === "old-helper") {
    t.emit({ type: "ready", version: 32, ok: true, home: "/test" });
    check("an older helper still confirms CLI installation", node("#ob-node-claude").classList.contains("done"));
    check("an older helper does not start sessions", t.posted("start").length === 0);
    check("an older helper gets an update request", t.posted("selfUpdate").length === 1);
    check("known installed agents do not get installation prompts", node("#ob-install-options").classList.contains("hidden"));
    return { passed: checks.length, checks };
  }
  if (scenario === "codex-first") {
    codex(true);
    check("Codex alone cannot bypass the helper handshake", t.posted("start").length === 0);
    check("Codex confirmation marks installation before the primary handshake", node("#ob-node-claude").classList.contains("done"));
    claude(false);
  } else if (scenario === "claude-only") {
    claude(true); codex(false);
  } else if (scenario === "both") {
    codex(true); claude(true);
  } else {
    claude(false);
    check("waits for the second CLI before asking to install", !hidden() && !node("#ob-install-options").open && t.text("#ob-wait-label") === "Checking installed agents…");
    if (scenario === "agent-exit") {
      t.emit({ type: "agentExit", agent: "codex", code: -1 });
    } else {
      codex(scenario !== "neither");
    }
  }

  if (scenario === "agent-exit") {
    check("a failed helper is not proof that its CLI is missing", !node("#ob-install-options").open && t.text("#ob-wait-label") === "Checking installed agents…");
    codex(true);
  }
  if (scenario === "neither") {
    check("installation stays open when neither CLI is available", !hidden() && node("#ob-install-options").open);
    check("missing CLI never receives a start request", t.posted("start").length === 0);
    t.click('[data-agent="codex"]');
    check("Codex has its own install command", t.text("#ob-claude-cmd") === "npm i -g @openai/codex" && node("#chat-copy-claude").dataset.cmd === "npm i -g @openai/codex");
    check("Codex hides the Claude shell picker", node("#ob-os-toggle").classList.contains("hidden"));
    t.click('[data-agent="claude"]');
    check("Claude restores its shell commands", !node("#ob-os-toggle").classList.contains("hidden") && t.text("#ob-claude-cmd").includes("claude.ai"));
    codex(true);
    check("installing either CLI completes onboarding", hidden());
  } else {
    check("either installed CLI completes onboarding", hidden());
  }
  check("installation is marked done only after confirmation", node("#ob-node-claude").classList.contains("done"));
  if (scenario === "saved" || scenario === "draft") {
    check("saved chats and drafts keep their agent", selected().harness === "claude");
    check("saved chat state is preserved", scenario === "saved"
      ? selected().sessionId === "saved-session"
      : selected().draft === "Keep this draft");
    check("an unavailable saved agent does not start", t.posted("start").length === 0);
  } else {
    const expected = scenario === "both" || scenario === "claude-only" ? "claude" : "codex";
    check("fresh chat selects an installed agent", selected().harness === expected);
    if (scenario !== "with-folder") {
      check("a new chat waits for a folder before starting", !selected().cwd && t.posted("start").length === 0);
      t.click('#folder-btn');
      const request = t.posted("pickFolder").at(-1);
      check("folder picker targets the active chat", request?.id === selected().id);
      t.emit({ type: "folder", id: request.id, path: "/test/project" });
    }
    const starts = t.posted("start");
    check("only the installed agent starts in the selected folder", starts.length === 1
      && starts[0].agent === expected && starts[0].cwd === "/test/project");
    codex(expected === "codex");
    check("another readiness reply does not start a second session", t.posted("start").length === 1);
  }
  t.disconnect();
  check("disconnect preserves confirmed CLI installation", node("#ob-node-claude").classList.contains("done"));
  check("disconnect only asks to restore the connection", !hidden() && node("#ob-node-link").classList.contains("current") && node("#ob-install-options").classList.contains("hidden"));
  claude(false); codex(false);
  check("a fresh negative check replaces the earlier installation result", !node("#ob-node-claude").classList.contains("done") && node("#ob-install-options").open);
  check("panel reports no runtime errors", t.errors.length === 0);
  return { passed: checks.length, checks };
};
