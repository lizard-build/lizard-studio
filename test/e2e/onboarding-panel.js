"use strict";

// Run each scenario in a fresh panel.html?onboarding=<scenario> page.
window.runOnboardingPanelTests = async function () {
  const t = window.__test, checks = [];
  const scenario = new URLSearchParams(location.search).get("onboarding");
  const check = (name, ok) => { if (!ok) throw new Error(name); checks.push(name); };
  const node = (selector) => document.querySelector(selector);
  const claude = (ok) => t.emit({ type: "ready", version: 35, ok, home: "/test" });
  const codex = (ok) => t.emit({ type: "agentReady", agent: "codex", version: 6, ok });
  const hidden = () => node("#chat-onboarding").classList.contains("hidden");
  const selected = () => t.storage.rkChatV2.tabs.find((c) => c.id === t.storage.rkChatV2.activeId);
  check("CLI installation starts unchecked", !node("#ob-node-claude").classList.contains("done"));
  check("roulette contains Claude, ChatGPT, and the loop frame", node("#onboarding-logo-claude").querySelectorAll(".onboarding-reel-item").length === 3);

  if (scenario === "disconnected") {
    t.disconnect();
    check("a first failed connection waits before showing setup", hidden());
    await new Promise((resolve) => setTimeout(resolve, 3100));
    check("connection screen names both agents", !hidden() && node("#ob-card-link").textContent.includes("Claude Code or ChatGPT"));
    check("an absent helper cannot confirm CLI installation", !node("#ob-node-claude").classList.contains("done"));
    return { passed: checks.length, checks };
  }
  if (scenario === "initial-reconnect") {
    t.disconnect();
    check("a first short disconnect keeps setup hidden", hidden());
    await new Promise((resolve) => setTimeout(resolve, 1300));
    claude(false); codex(true);
    check("the first retry opens the chat without flashing setup", hidden());
    check("the first retry reports no runtime errors", t.errors.length === 0);
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
    check("waits for the second CLI without flashing setup", hidden());
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
  if (scenario === "transient" || scenario === "session-lost") {
    const id = selected().id;
    t.emit({ type: "event", id, data: { type: "stream_event", event: {
      type: "message_start", message: { id: "reply-1", role: "assistant", content: [], usage: {} },
    } } });
    t.disconnect();
    check("a brief disconnect keeps the conversation visible", hidden());
    check("a brief disconnect does not claim the running turn stopped", !node("#bed").textContent.includes("Host disconnected mid-turn"));
    await new Promise((resolve) => setTimeout(resolve, 1300));
    t.emit({ type: "backgroundRestoreStart", sessions: scenario === "transient" ? [{ id, agent: "codex",
      spec: { cwd: "/test/project" }, started: true, running: true, submitted: true }] : [] });
    claude(false); codex(true);
    t.emit({ type: "backgroundRestoreEnd" });
    if (scenario === "session-lost") {
      check("an absent session is reported only after restore finishes", node("#bed").textContent.includes("Host disconnected mid-turn"));
      check("the missing session can start again", t.posted("start").length >= 2);
    } else check("reconnect hides setup without restarting the turn", hidden() && !t.posted("prompt").length);
    check("reconnect reports no runtime errors", t.errors.length === 0);
    return { passed: checks.length, checks };
  }
  if (scenario === "saved" || scenario === "draft") {
    check("saved chats and drafts keep their agent", selected().harness === "claude");
    check("saved chat state is preserved", scenario === "saved"
      ? selected().sessionId === "saved-session"
      : selected().draft === "Keep this draft");
    check("an unavailable saved agent does not start", t.posted("start").length === 0);
  } else {
    const expected = scenario === "both" || scenario === "claude-only" ? "claude" : "codex";
    check("fresh chat selects an installed agent", node("#harness-btn .harness-label").textContent.trim() === (expected === "codex" ? "ChatGPT" : "Claude Code"));
    if (scenario !== "with-folder" && scenario !== "transient") {
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
  check("a brief disconnect does not reopen setup", hidden());
  check("panel reports no runtime errors", t.errors.length === 0);
  return { passed: checks.length, checks };
};
