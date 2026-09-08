"use strict";

// Run after the Codex regressions, using the real panel and mocked native host.
window.runAuditPanelTests = async function () {
  const t = window.__test, checks = [];
  const pause = () => new Promise((resolve) => setTimeout(resolve, 180));
  const check = (name, ok) => { if (!ok) throw new Error(name); checks.push(name); };
  const node = (selector) => { const n = document.querySelector(selector); if (!n) throw new Error("Missing " + selector); return n; };
  const click = (selector) => { node(selector).focus(); node(selector).click(); };
  const type = (selector, value) => { const n = node(selector); n.value = value; n.dispatchEvent(new Event("input", { bubbles: true })); };
  const key = (selector, key, extra = {}) => node(selector).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  const enter = () => { key("#composer-input", "Escape"); key("#composer-input", "Enter"); };
  const chat = (title) => [...document.querySelectorAll(".chat-tab")].find((n) => n.textContent.includes(title)).click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  const bed = node("#bed"), input = node("#composer-input");
  const originalWidth = bed.style.width;
  type("#composer-input", "");
  const emptyHeight = input.offsetHeight;
  bed.style.width = "60px";
  type("#composer-input", "");
  check("empty composer ignores wrapped placeholder height", input.offsetHeight === emptyHeight);
  bed.style.width = "360px"; await pause();
  check("empty composer stays compact after the panel opens", input.offsetHeight === emptyHeight);
  type("#composer-input", "A draft that wraps when the panel is narrow. ".repeat(8));
  const narrowHeight = input.offsetHeight;
  bed.style.width = "720px"; await pause();
  check("draft height shrinks when the panel widens", input.offsetHeight < narrowHeight);
  bed.style.width = "360px"; await pause();
  check("draft height grows when the panel narrows", input.offsetHeight === narrowHeight);
  type("#composer-input", "Line\n".repeat(50));
  check("long drafts stay capped and scroll", input.offsetHeight <= 200 && input.scrollHeight > input.clientHeight);
  type("#composer-input", "");
  check("clearing a long draft restores one row", input.offsetHeight === emptyHeight);
  bed.style.width = originalWidth; await pause();

  type("#composer-input", "Only for A");
  chat("Second chat"); await pause();
  check("A02: switching chats does not move the draft", node("#composer-input").value === "");
  type("#composer-input", "Only for B");
  chat("ChatGPT audit"); await pause();
  check("A02: each chat restores its own draft", node("#composer-input").value === "Only for A");
  check("A02: both drafts are persisted for reload", t.storage.rkChatV2.tabs.find((c) => c.id === "audit-a").draft === "Only for A" && t.storage.rkChatV2.tabs.find((c) => c.id === "audit-b").draft === "Only for B");

  t.emit({ type: "commands", id: "audit-a", agent: "codex", cwd: "/test/project", list: ["codex-only-skill", "remote-control"], skills: ["codex-only-skill"] });
  type("#composer-input", "/remote-control");
  check("A03: Codex autocomplete excludes Remote Control", !node("#slash-menu").textContent.includes("remote-control"));
  enter(); await pause();
  check("A03: manual Remote Control reports unsupported without a request", t.posted("remoteControl").length === 0 && document.body.textContent.includes("Remote Control is only available"));

  type("#composer-input", "/login"); enter(); await pause();
  t.emit({ type: "authUrl", id: "audit-a", url: "https://example.com/sign-in-test", code: "DEMO-1234" });
  check("A07: ChatGPT login shows the correct service and device code", node(".login-title").textContent === "Sign in to ChatGPT" && node(".login-device-code").textContent === "DEMO-1234");
  check("A07: ChatGPT has no unsupported manual code submission", !document.querySelector(".login-input") && !document.querySelector(".login-submit"));
  click(".login-fallback");
  check("A07: sign-in can be cancelled", t.posted("authCancel").at(-1)?.agent === "codex");
  t.emit({ type: "authDone", id: "audit-a", ok: false, message: "Cancelled" });

  chat("Second chat"); await pause();
  for (const [trigger, menu, row] of [["#model-btn", "#model-menu", ".model-item"], ["#mode-btn", "#mode-menu", ".mode-item"], ["#harness-btn", "#harness-menu", ".branch-item"]]) {
    click(trigger); await pause();
    const rows = [...node(menu).querySelectorAll(row)];
    check("A08: " + menu + " rows are native keyboard controls", rows.length > 0 && rows.every((n) => n.tagName === "BUTTON" && n.tabIndex === 0));
    check("A08: " + menu + " takes focus on opening", rows.includes(document.activeElement));
    key(menu, "End"); check("A08: " + menu + " supports arrow navigation", document.activeElement === rows.at(-1));
    key(menu, "Escape"); await pause();
  }

  chat("ChatGPT audit"); await pause();
  click("#menu-btn"); await pause(); click("#settings-btn");
  check("A08: settings take focus", node(".settings-modal").contains(document.activeElement));
  check("A08: the composer is inert behind settings", !!node("#composer-input").closest("[inert]"));
  click(".settings-tab:nth-child(3)");
  let read = t.posted("configRead").at(-1);
  t.emit({ ...read, ok: true, exists: true, content: "Original" });
  type(".settings-editor", "Saved A"); click(".settings-save-btn");
  const save = t.posted("configWrite").at(-1);
  type(".settings-editor", "Saved A + unsaved B");
  check("A04: a second Save stays disabled while the first is pending", node(".settings-save-btn").disabled);
  t.emit({ ...save, requestId: "unrelated", ok: true });
  check("A04: an unrelated reply cannot complete the save", node(".settings-save-btn").disabled);
  node(".settings-editor").focus(); node(".settings-editor").setSelectionRange(4, 8);
  t.emit({ ...save, ok: true });
  check("A04: a delayed save preserves the caret", document.activeElement === node(".settings-editor") && node(".settings-editor").selectionStart === 4 && node(".settings-editor").selectionEnd === 8);
  check("A04: an acknowledgement does not mark later text saved", node(".settings-editor").value === "Saved A + unsaved B" && !node(".settings-save-btn").disabled && node(".settings-msg").textContent.includes("New edits aren't saved"));

  click(".settings-scope-btn:not(.active)");
  read = t.posted("configRead").at(-1);
  t.emit({ ...read, ok: true, exists: true, content: "User original" });
  type(".settings-editor", "User draft");
  click(".settings-scope-btn:not(.active)");
  check("A05: project draft survives a scope switch", node(".settings-editor").value === "Saved A + unsaved B");
  click(".settings-save-btn");
  const backgroundSave = t.posted("configWrite").at(-1);
  click(".settings-scope-btn:not(.active)");
  t.emit({ ...backgroundSave, ok: true });
  check("A04: a background save cannot overwrite the visible scope", node(".settings-editor").value === "User draft" && !node(".settings-save-btn").disabled);
  click("#settings-close");
  check("A08: closing settings restores focus to the drawer", document.activeElement === node("#settings-btn") && !node("#settings-btn").closest("[inert]"));
  click("#settings-btn"); click(".settings-tab:nth-child(3)"); click(".settings-scope-btn:not(.active)");
  check("A05: closing and reopening settings keeps unsaved text", node(".settings-editor").value === "User draft");

  click(".settings-tab:nth-child(2)"); click(".settings-filepick-btn:last-child");
  const request = t.posted("listSkills").at(-1);
  check("A06: Claude settings request Claude skills explicitly", request.agent === "claude" && request.cwd === "/test/project");
  check("A06: Claude settings never show the Codex list", !node(".settings-modal").textContent.includes("codex-only-skill"));
  t.emit({ type: "commands", id: request.id, agent: "claude", cwd: request.cwd, list: ["claude-only-skill"], skills: ["claude-only-skill"] });
  check("A06: the requested agent's list appears", node(".settings-modal").textContent.includes("claude-only-skill"));
  click(".settings-tab:nth-child(3)"); click(".settings-filepick-btn:last-child");
  check("A06: ChatGPT has its own skills view", node(".settings-modal").textContent.includes("codex-only-skill") && !node(".settings-modal").textContent.includes("claude-only-skill"));
  click("#settings-close"); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await pause();
  type("#composer-input", "/codex");
  check("A06: viewing Claude settings does not replace Codex autocomplete", node("#slash-menu").textContent.includes("codex-only-skill"));

  type("#composer-input", "Original request"); enter(); await pause();
  t.emit({ type: "event", id: "audit-a", data: { type: "assistant", message: { id: "audit-proof", content: [{ type: "text", text: "Original answer stays here" }], usage: {} } } });
  t.emit({ type: "event", id: "audit-a", data: { type: "result", subtype: "success", result: "", num_turns: 1 } });
  const bubble = [...document.querySelectorAll(".bubble")].find((n) => n.textContent.includes("Original request"));
  bubble.click();
  check("A01: Codex past messages do not offer unsupported editing", !bubble.classList.contains("editable") && !document.querySelector(".msg-edit") && t.posted("rewind").length === 0);
  type("#composer-input", "Keep this draft");
  const count = t.storage.rkChatV2.tabs.length;
  click("#harness-btn");
  [...document.querySelectorAll("#harness-menu .branch-item")].find((n) => n.textContent.includes("Claude Code")).click(); await pause();
  const newChatId = t.storage.rkChatV2.activeId;
  check("A09: switching agent opens a separate chat", t.storage.rkChatV2.tabs.length === count + 1 && t.storage.rkChatV2.tabs.find((c) => c.id === "audit-a").harness === "codex");
  check("A09: the old session was not closed", !t.posted("close").some((m) => m.id === "audit-a"));
  chat("ChatGPT audit"); await pause();
  check("A09: returning restores the conversation and draft", document.body.textContent.includes("Original answer stays here") && node("#composer-input").value === "Keep this draft");
  chat(t.storage.rkChatV2.tabs.find((c) => c.id === newChatId).title); await pause();
  t.emit({ type: "event", id: newChatId, data: { type: "system", subtype: "init", session_id: "claude-test", cwd: "/test/project", slash_commands: ["help"], skills: ["claude-skill"] } });
  type("#composer-input", "Claude request"); enter(); await pause();
  t.emit({ type: "event", id: newChatId, data: { type: "result", subtype: "success", result: "Done", num_turns: 1 } });
  check("Claude keeps supported message editing", [...document.querySelectorAll(".bubble.editable")].some((n) => n.textContent.includes("Claude request")));
  type("#composer-input", "/remote");
  check("Claude keeps Remote Control in autocomplete", node("#slash-menu").textContent.includes("remote-control"));
  type("#composer-input", "/login"); enter();
  t.emit({ type: "authUrl", id: newChatId, url: "https://example.com/claude-sign-in-test" });
  check("Claude keeps its manual sign-in fallback", node(".chat-messages:not(.hidden) .login-title").textContent === "Sign in to Claude Code" && !!document.querySelector(".login-input"));
  check("panel has no runtime errors", t.errors.length === 0);
  return { passed: checks.length, checks };
};
