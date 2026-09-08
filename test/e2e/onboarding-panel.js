"use strict";

// Run each scenario in a fresh panel.html?onboarding=<scenario> page.
window.runOnboardingPanelTests = async function () {
  const t = window.__test, checks = [];
  const scenario = new URLSearchParams(location.search).get("onboarding");
  const check = (name, ok) => { if (!ok) throw new Error(name); checks.push(name); };
  const node = (selector) => document.querySelector(selector);
  const claude = (ok) => t.emit({ type: "ready", version: 30, ok, home: "/test" });
  const codex = (ok) => t.emit({ type: "agentReady", agent: "codex", version: 6, ok });
  const hidden = () => node("#chat-onboarding").classList.contains("hidden");
  const selected = () => t.storage.rkChatV2.tabs.find((c) => c.id === t.storage.rkChatV2.activeId);
  check("CLI installation starts unchecked", !node("#ob-node-claude").classList.contains("done"));
  check("roulette contains Claude, ChatGPT, and the loop frame", node("#onboarding-logo-claude").querySelectorAll(".onboarding-reel-item").length === 3);

  if (scenario === "disconnected") {
    t.disconnect();
    check("connection screen names both agents", !hidden() && node("#ob-card-link").textContent.includes("Claude Code or ChatGPT"));
    check("an absent helper cannot confirm CLI installation", !node("#ob-node-claude").classList.contains("done"));
    return { passed: checks.length, checks };
  }
  if (scenario === "codex-first") {
    codex(true);
    check("Codex alone cannot bypass the helper handshake", t.posted("start").length === 0);
    claude(false);
  } else if (scenario === "claude-only") {
    claude(true); codex(false);
  } else if (scenario === "both") {
    codex(true); claude(true);
  } else {
    claude(false);
    check("waits for the second CLI before asking to install", !hidden() && node("#ob-card-claude").classList.contains("hidden") && t.text("#ob-wait-label") === "Checking installed agents…");
    if (scenario === "agent-exit") {
      t.emit({ type: "agentExit", agent: "codex", code: -1 });
    } else {
      codex(scenario !== "neither");
    }
  }

  if (scenario === "neither" || scenario === "agent-exit") {
    check("installation stays open when neither CLI is available", !hidden() && !node("#ob-card-claude").classList.contains("hidden"));
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
  check("disconnect clears stale installation checks", !node("#ob-node-claude").classList.contains("done"));
  check("panel reports no runtime errors", t.errors.length === 0);
  return { passed: checks.length, checks };
};
