"use strict";

// Runs inside panel.html?regressions=codex. The panel and renderer are real;
// the existing test bed records native messages instead of opening files.
window.runCodexPanelTests = async function () {
  const t = window.__test;
  const passed = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); passed.push(name); };
  const emit = (msg) => t.emit(msg);
  const event = (data) => emit({ type: "event", id: "audit-a", data });
  emit({ type: "ready", ok: true, version: 24, home: "/test", user: "Test" });
  check("an older host enters the update flow", t.posted("selfUpdate").length === 1);
  check("an older host cannot start a chat", t.posted("start").length === 0);
  emit({ type: "ready", ok: true, version: 25, home: "/test", user: "Test" });
  emit({ type: "agentReady", agent: "codex", ok: true, version: 2 });
  emit({ type: "models", agent: "codex", defaultModel: "test-model", models: [{ id: "test-model", label: "Test model", contextWindow: 258400, efforts: ["high"], defaultEffort: "high" }] });
  for (const id of ["audit-a", "audit-b"]) emit({ type: "event", id, data: { type: "system", subtype: "init", agent: "codex", session_id: id, model: "test-model", cwd: "/test/project" } });
  t.click("#usage-btn");
  check("missing context usage is shown as unknown", t.text("#usage-menu").includes("Awaiting usage"));
  check("opening Codex usage requests its account limits", t.posted("planUsage").some((m) => m.agent === "codex"));
  check("Codex usage never sends a Claude usage prompt", !t.posted("prompt").some((m) => m.text === "/usage"));

  emit({ type: "contextUsage", id: "audit-a", agent: "codex", window: 258400, usage: { input_tokens: 10000, cache_read_input_tokens: 40000, output_tokens: 1000 } });
  check("cache hits count once in the visible context meter", t.text("#usage-menu").includes("51.0k / 258.4k (20%)"));
  emit({ type: "contextUsage", id: "audit-b", agent: "codex", window: 1000000, usage: { input_tokens: 90000, output_tokens: 10000 } });
  emit({ type: "contextWindow", id: "audit-b", agent: "codex", model: "test-model", window: 1000000 });
  check("another chat cannot change this chat's context window", t.text("#usage-menu").includes("51.0k / 258.4k (20%)"));

  emit({ type: "planUsage", agent: "codex", limits: [
    { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 7200 }, secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 604800 } },
    { limitId: "other", limitName: "Other models", primary: { usedPercent: 8, windowDurationMins: 10080 } },
  ] });
  const usage = t.text("#usage-menu");
  check("all reported quota windows appear", ["5-hour limit", "12%", "Weekly limit", "42%", "Weekly limit · Other models", "8%"].every((s) => usage.includes(s)));
  check("Codex quota scope is not rewritten as all models", !usage.includes("all models"));
  emit({ type: "planUsage", agent: "codex", error: "Couldn't refresh usage." });
  check("refresh failures are visible beside the last reading", t.text("#usage-menu").includes("Couldn't refresh usage.") && t.text("#usage-menu").includes("42%"));

  event({ type: "assistant", message: { id: "files", role: "assistant", content: [{ type: "text", text: "Собрал [план на 8 недель](/Users/me/lizard/AEO-PLAN.md) и [26 задач](</Users/me/My Project/_tasks_(1).csv:12>)." }], usage: {} } });
  const links = [...document.querySelectorAll("a.path[data-path]")];
  check("Markdown file labels render as links", links.length === 2 && links[0].textContent === "план на 8 недель" && links[1].textContent === "26 задач");
  links[0].click();
  check("clicking a file sends the path to its chat", t.posted("openPath").at(-1)?.path === "/Users/me/lizard/AEO-PLAN.md" && t.posted("openPath").at(-1)?.id === "audit-a");
  links[1].focus();
  links[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  check("keyboard activation opens a path with spaces and strips the line suffix", t.posted("openPath").at(-1)?.path === "/Users/me/My Project/_tasks_(1).csv");

  event({ type: "stream_event", event: { type: "message_start", message: { id: "streamed", role: "assistant", content: [], usage: {} } } });
  event({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  event({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Проверка потока." } } });
  event({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  event({ type: "stream_event", event: { type: "message_stop" } });
  event({ type: "assistant", message: { id: "streamed", content: [{ type: "text", text: "Проверка потока." }], usage: {} } });
  event({ type: "result", subtype: "success", is_error: false, result: "", usage: {} });
  await new Promise((resolve) => setTimeout(resolve, 500));
  check("streaming and canonical copies produce one reply", (document.querySelector("#bed").textContent.match(/Проверка потока\./g) || []).length === 1);
  check("panel reports no runtime errors", t.errors.length === 0);

  // Leave the full quota view visible for the screenshot.
  emit({ type: "planUsage", agent: "codex", usedPercent: 42, windowMins: 10080 });
  check("older hosts still supply a usable quota row", t.text("#usage-menu").includes("42%"));
  if (!t.visible("#usage-menu")) t.click("#usage-btn");
  return { passed: passed.length, checks: passed };
};
