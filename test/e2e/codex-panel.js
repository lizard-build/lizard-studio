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
  emit({ type: "ready", ok: true, version: 33, home: "/test", user: "Test" });
  emit({ type: "agentReady", agent: "codex", ok: true, version: 6 });
  check("reasoning stays on Default before the catalog arrives", document.querySelector("#effort-btn").disabled && t.text("#effort-btn") === "Default");
  check("starting without metadata sends no guessed effort", t.posted("start").some((m) => m.agent === "codex") && t.posted("start").filter((m) => m.agent === "codex").every((m) => m.effort == null));
  emit({ type: "models", agent: "codex", defaultModel: "test-model", models: [{ id: "test-model", label: "Test model", contextWindow: 258400, efforts: ["high"], defaultEffort: "high" }] });
  for (const id of ["audit-a", "audit-b"]) emit({ type: "event", id, data: { type: "system", subtype: "init", agent: "codex", session_id: id, model: "test-model", cwd: "/test/project" } });
  const range = document.querySelector(".effort-range");
  const catalog = (efforts) => emit({ type: "models", agent: "codex", defaultModel: "test-model", models: [{ id: "test-model", label: "Test model", efforts, defaultEffort: "medium" }] });
  const key = (name) => range.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  t.click("#effort-btn");
  check("a single reasoning level has a fixed, finite slider", range.disabled && range.max === "0" && document.querySelector("#effort-menu").style.getPropertyValue("--effort-progress") === "0");
  catalog(["low", "medium", "high", "xhigh", "max", "ultra"]);
  check("a catalog refresh updates an open slider", !range.disabled && range.max === "5");
  key("Home"); key("ArrowRight"); key("ArrowRight"); key("ArrowRight");
  check("Extra High sends the exact xhigh value", t.text("#effort-btn") === "Extra High" && t.posted("restartSession").at(-1)?.effort === "xhigh");
  key("End");
  check("Ultra explanation stays in its tooltip", !document.querySelector(".effort-note") && t.text(".effort-tip").includes("automatic task delegation") && t.posted("restartSession").at(-1)?.effort === "ultra");
  catalog(["low", "medium", "high", "xhigh"]);
  check("a shorter catalog removes unsupported levels", range.max === "3" && t.text("#effort-btn") === "Medium");
  key("End");
  check("the last ordinary level stays Extra High", t.text("#effort-btn") === "Extra High" && !document.querySelector(".effort-picker").classList.contains("is-ultra"));
  catalog([]);
  check("missing model levels disable the picker", document.querySelector("#effort-btn").disabled && t.text("#effort-btn") === "Default");
  catalog(["low", "medium", "high", "xhigh"]);
  check("returning metadata restores the saved effort", t.text("#effort-btn") === "Extra High" && !document.querySelector("#effort-btn").disabled);
  emit({ type: "models", agent: "codex", models: [] });
  check("an empty catalog clears stale reasoning choices", document.querySelector("#effort-btn").disabled);
  catalog(["low", "medium", "high", "xhigh"]);
  t.click("#usage-btn");
  check("missing context usage is shown as unknown", t.text("#usage-menu").includes("Awaiting usage"));
  check("opening ChatGPT usage requests its account limits", t.posted("planUsage").some((m) => m.agent === "codex"));
  check("ChatGPT usage never sends a Claude usage prompt", !t.posted("prompt").some((m) => m.text === "/usage"));

  emit({ type: "contextUsage", id: "audit-a", agent: "codex", window: 258400, usage: { input_tokens: 10000, cache_read_input_tokens: 40000, output_tokens: 1000 } });
  check("cache hits count once in the visible context meter", t.text("#usage-menu").includes("51.0k / 258.4k (20%)"));
  emit({ type: "contextUsage", id: "audit-b", agent: "codex", window: 1000000, usage: { input_tokens: 90000, output_tokens: 10000 } });
  emit({ type: "contextWindow", id: "audit-b", agent: "codex", model: "test-model", window: 1000000 });
  check("another chat cannot change this chat's context window", t.text("#usage-menu").includes("51.0k / 258.4k (20%)"));

  emit({ type: "planUsage", agent: "codex", limits: [
    { limitId: "codex", limitName: "Codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 7200 }, secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 604800 } },
    { limitId: "other", limitName: "Other models", primary: { usedPercent: 8, windowDurationMins: 10080 } },
  ] });
  const usage = t.text("#usage-menu");
  check("all reported quota windows appear", ["5-hour limit · ChatGPT", "12%", "Weekly limit · ChatGPT", "42%", "Weekly limit · Other models", "8%"].every((s) => usage.includes(s)));
  check("ChatGPT quota scope is not rewritten as all models", !usage.includes("all models"));
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
  const deadline = Date.now() + 5000;
  while (!document.querySelector("#bed").textContent.includes("Проверка потока.") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check("streaming and canonical copies produce one reply", (document.querySelector("#bed").textContent.match(/Проверка потока\./g) || []).length === 1);
  check("panel reports no runtime errors", t.errors.length === 0);

  // Async questions use the same picker as approval-based questions, but
  // answers travel as prompts and remain visible until the host accepts them.
  if (t.visible("#usage-menu")) t.click("#usage-btn");
  const ask = (id, questions = [{ id: "0", question: "Что показывать в Resources?", options: [{ label: "Текущее потребление CPU/RAM" }, { label: "Выделенные ресурсы" }] }]) => event({ type: "async_question", questionId: id, questions });
  const card = () => [...document.querySelectorAll(".ask-card")].at(-1);
  const keyOn = (node, key) => node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const ack = (ok, extra = {}) => emit({ type: "promptResult", id: "audit-a", requestId: t.posted("prompt").at(-1).promptRequestId, ok, ...extra });
  ask("async-choice");
  check("async questions use the existing picker", card().querySelectorAll(".ask-opt").length === 3 && card().textContent.includes("ChatGPT is asking"));
  const count = document.querySelectorAll(".ask-card").length;
  ask("async-choice");
  check("duplicate events do not repeat a question", document.querySelectorAll(".ask-card").length === count);
  const before = t.posted("prompt").length;
  card().querySelector(".ask-opt").click();
  check("an answer posts immediately and waits for acceptance", t.posted("prompt").length === before + 1 && card().textContent.includes("Sending answer") && card().querySelector("button").disabled);
  card().querySelector(".ask-opt").click();
  check("double clicks cannot post an answer twice", t.posted("prompt").length === before + 1);
  check("a choice is a prompt, not an approval reply", t.posted("prompt").at(-1).text === "Что показывать в Resources?\nТекущее потребление CPU/RAM" && !!t.posted("prompt").at(-1).promptRequestId);
  ack(false, { error: "Try again" });
  check("rejected answers stay in the picker", card().textContent.includes("Try again") && !card().querySelector("button").disabled);
  card().querySelector(".ask-opt").click(); ack(true);
  check("accepted answers leave a question record", card().textContent.includes("Answer sent") && !card().querySelector("button"));

  ask("async-free", [{ id: "0", question: "Details?", options: [] }]);
  event({ type: "result", subtype: "success", usage: {} });
  check("an async question survives turn completion", card().textContent.includes("Details?") && !!card().querySelector("button"));
  card().querySelector(".ask-opt").click();
  const free = card().querySelector("input"); free.value = "Yes, keep both"; keyOn(free, "Enter");
  check("free text preserves punctuation", t.posted("prompt").at(-1).text === "Details?\nYes, keep both");
  ack(true, { startedTurn: true });

  ask("async-many", [{ id: "0", question: "Same?", options: [{ label: "First" }] }, { id: "1", question: "Same?", options: [{ label: "Second" }] }]);
  const manyBefore = t.posted("prompt").length;
  keyOn(card(), "1");
  check("multiple questions collect answers before sending", t.posted("prompt").length === manyBefore && card().textContent.includes("2 of 2"));
  keyOn(card(), "1");
  check("identical question titles keep separate answers", t.posted("prompt").at(-1).text === "Same?\nFirst\n\nSame?\nSecond");
  ack(true);

  ask("async-composer");
  const composer = document.querySelector("#composer-input");
  composer.value = "текущее"; keyOn(composer, "Enter");
  check("a composer reply bypasses the queue for a pending question", t.posted("prompt").at(-1).text === "текущее" && !document.querySelector(".msg-user.queued"));
  ack(true);

  emit({ type: "transcript", id: "audit-a", events: [{ type: "async_question", questionId: "old-question", readOnly: true, questions: [{ id: "0", question: "Earlier?", options: [{ label: "A" }] }] }] });
  check("answered history questions have no active controls", card().textContent.includes("Earlier?") && !card().querySelector("button"));
  emit({ type: "transcript", id: "audit-a", events: [{ type: "async_question", questionId: "restored-question", readOnly: false, questions: [{ id: "0", question: "Still open?", options: [{ label: "B" }] }] }] });
  card().querySelector("button").click();
  check("restored unanswered questions reply to the real chat", t.posted("prompt").at(-1).id === "audit-a" && t.posted("prompt").at(-1).text === "Still open?\nB");
  ack(true);

  ask("async-background");
  const bgBefore = t.posted("prompt").length;
  emit({ type: "promptResult", id: "audit-b", requestId: "wrong", ok: true });
  check("another chat cannot resolve this question", !!card().querySelector("button") && t.posted("prompt").length === bgBefore);
  keyOn(card(), "Escape");
  check("dismissing an async question does not interrupt Codex", card().textContent.includes("Dismissed") && t.posted("interrupt").length === 0);
  ask("async-disconnect");
  card().querySelector("button").click();
  t.disconnect();
  check("lost connections preserve an answer and unlock retry", card().textContent.includes("Check the chat") && card().textContent.includes("Retry answer") && !card().querySelector("button").disabled);
  const offlineCount = t.posted("prompt").length;
  card().querySelector("button").click();
  check("offline answers are not reported as sent", t.posted("prompt").length === offlineCount && card().textContent.includes("Host disconnected"));
  check("question interactions report no runtime errors", t.errors.length === 0);

  // Leave the full quota view visible for the screenshot.
  emit({ type: "planUsage", agent: "codex", usedPercent: 42, windowMins: 10080 });
  check("older hosts still supply a usable quota row", t.text("#usage-menu").includes("42%"));
  if (!t.visible("#usage-menu")) t.click("#usage-btn");
  return { passed: passed.length, checks: passed };
};
