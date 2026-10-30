"use strict";
// The work tray: a finished turn's notes and tool calls fold into one line
// above its answer, from history at once and from a live turn with motion.
window.runTrayPanelTests = async function () {
  const t = window.__test, passed = [], id = "tray-a";
  const check = (name, ok) => { if (!ok) throw new Error(name); passed.push(name); };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const at = (s) => new Date(Date.UTC(2026, 9, 30, 12, 0, s)).toISOString();
  const tool = (toolId, name, input) => ({ type: "tool_use", id: toolId, name, input });
  const toolResult = (toolId, content) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content }] } });
  const live = (data) => t.emit({ type: "event", id, data });
  const settled = (tray) => !tray.classList.contains("folding") && !tray.classList.contains("closing") && !tray.style.height && !tray.dataset.moving;
  // One turn with `calls` tool calls, a note before every other one, and an answer.
  const bigTurn = (prefix, calls, answer, ms) => {
    for (let i = 0; i < calls; i++) {
      const content = i % 2 ? [] : [{ type: "text", text: `Step ${i}: reading the next part of the panel code to see where the chat menu gets rebuilt.` }];
      content.push(tool(`${prefix}-${i}`, "Bash", { command: `grep -n "step ${i}" src/panel/chat.js` }));
      live({ type: "assistant", message: { id: `${prefix}-m${i}`, content } });
      live(toolResult(`${prefix}-${i}`, `${i}: match`));
    }
    live({ type: "assistant", message: { id: `${prefix}-end`, content: [{ type: "text", text: answer }] } });
    live({ type: "result", subtype: "success", duration_ms: ms, result: answer });
  };
  const send = async (text) => {
    const composer = document.querySelector("#composer-input");
    composer.value = text;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await frame();
  };

  t.emit({ type: "ready", ok: true, version: 41, home: "/test" });
  t.emit({ type: "agentReady", agent: "claude", ok: true, version: 2 });
  await frame();
  const request = t.posted("loadTranscript").at(-1);
  check("a restored Claude chat asks for its history", !!request && request.paged);
  t.emit({ type: "transcript", id: request.id, sessionId: request.sessionId, requestId: request.requestId, paged: true, done: true, nextCursor: null, events: [
    { type: "user", timestamp: at(0), message: { content: "Why does the chat menu flicker?" } },
    { type: "assistant", timestamp: at(5), message: { id: "h1", content: [{ type: "text", text: "Looking for the menu code." }, tool("h-t1", "Bash", { command: "ls src/panel" })] } },
    { ...toolResult("h-t1", "chat.js"), timestamp: at(20) },
    { type: "assistant", timestamp: at(40), message: { id: "h2", content: [tool("h-t2", "Read", { file_path: "/test/project/src/panel/chat.js" })] } },
    { ...toolResult("h-t2", "function renderChatMenuList() {}"), timestamp: at(60) },
    { type: "assistant", timestamp: at(90), message: { id: "h3", content: [{ type: "text", text: "Fixed: the menu no longer rebuilds." }] } },
    { type: "user", timestamp: at(100), message: { content: "And what is 2 + 2?" } },
    { type: "assistant", timestamp: at(102), message: { id: "h4", content: [{ type: "text", text: "Four." }] } },
    { type: "user", timestamp: at(110), message: { content: "Run the tests" } },
    { type: "assistant", timestamp: at(112), message: { id: "h5", content: [tool("h-t3", "Bash", { command: "npm test" })] } },
    { ...toolResult("h-t3", "pass 421"), timestamp: at(130) },
  ] });
  await frame();
  const box = document.querySelector(".chat-messages:not(.hidden)");
  const rows = () => [...box.querySelectorAll(":scope > .msg-assistant")];
  const fixed = rows().find((row) => row.textContent.includes("Fixed: the menu"));
  const tray = fixed && fixed.querySelector(".work-tray");
  check("a finished turn from history folds its work", !!tray && tray.classList.contains("collapsed"));
  const head = tray.querySelector(".work-tray-head");
  check("the tray names the time and the tool calls", head.textContent.includes("Worked for 1m 30s") && head.textContent.includes("· 2 tool calls"));
  const answer = [...fixed.querySelector(".assistant-body").children].find((n) => n.textContent.includes("Fixed: the menu"));
  check("the answer stays outside the tray and on screen", !!answer && !tray.contains(answer) && answer.getBoundingClientRect().height > 0);
  check("notes and tool groups go inside the tray, hidden", tray.textContent.includes("Looking for the menu code.") && !!tray.querySelector(".tool-group")
    && tray.querySelector(".work-tray-list").getBoundingClientRect().height === 0);
  check("a turn without tool calls has no tray", !rows().find((row) => row.textContent.includes("Four.")).querySelector(".work-tray"));
  check("a turn that ends on a tool call has no tray", !rows().at(-1).querySelector(".work-tray"));

  head.click();
  await sleep(700);
  check("clicking the line opens the history", tray.classList.contains("open") && head.getAttribute("aria-expanded") === "true"
    && tray.querySelector(".work-tray-list").getBoundingClientRect().height > 0 && settled(tray));
  const group = tray.querySelector(".tool-group");
  group.querySelector(".tool-group-head").click();
  check("a tool group inside opens on its own", !group.classList.contains("collapsed"));
  const card = group.querySelector(".tool-card");
  card.querySelector(".tool-head").click();
  check("a call inside opens to its detail", !card.classList.contains("collapsed"));
  head.click();
  await sleep(700);
  check("clicking again folds it", tray.classList.contains("collapsed") && head.getAttribute("aria-expanded") === "false" && settled(tray));
  head.click();
  await sleep(700);
  check("what was open inside stays open", !group.classList.contains("collapsed") && !card.classList.contains("collapsed"));
  head.click();
  await sleep(700);

  // The history ended on a tool call; the model picks that turn up live.
  box.scrollTop = box.scrollHeight;
  live({ type: "assistant", message: { id: "l1", content: [{ type: "text", text: "Checking the build." }, tool("l-t1", "Bash", { command: "npm run build" })] } });
  live(toolResult("l-t1", "built"));
  live({ type: "assistant", message: { id: "l2", content: [{ type: "text", text: "The build passes." }] } });
  live({ type: "result", subtype: "success", duration_ms: 125000, result: "The build passes." });
  const resumed = rows().at(-1);
  check("the fold waits a moment after the answer", !resumed.querySelector(".work-tray"));
  await sleep(1400);
  const liveTray = resumed.querySelector(".work-tray");
  check("a live turn folds once its answer lands", !!liveTray && liveTray.classList.contains("collapsed") && settled(liveTray));
  check("a live tray takes its time from the result", liveTray.textContent.includes("Worked for 2m 5s") && liveTray.textContent.includes("· 2 tool calls"));
  check("the live answer stays outside", [...resumed.querySelector(".assistant-body").children].some((n) => !n.classList.contains("work-tray") && n.textContent.includes("The build passes.")));

  // The same turn wakes up again after it folded: one tray holds all of it.
  live({ type: "assistant", message: { id: "l3", content: [tool("l-t2", "Bash", { command: "npm run lint" })] } });
  live(toolResult("l-t2", "clean"));
  live({ type: "assistant", message: { id: "l4", content: [{ type: "text", text: "Lint is clean too." }] } });
  live({ type: "result", subtype: "success", duration_ms: 5000, result: "Lint is clean too." });
  await sleep(900);
  const merged = resumed.querySelectorAll(".work-tray");
  check("a turn that went on folds into the same tray", merged.length === 1 && merged[0].textContent.includes("· 3 tool calls") && merged[0].textContent.includes("Worked for 2m 10s"));
  check("the earlier answer moves into the tray", merged[0].textContent.includes("The build passes.")
    && [...resumed.querySelector(".assistant-body").children].some((n) => !n.classList.contains("work-tray") && n.textContent.includes("Lint is clean too.")));

  // A long turn, watched from the bottom: only what is on screen moves.
  t.emit({ type: "started", id, cwd: "/test/project" });
  await send("Read the whole panel");
  check("the next prompt goes out", t.posted("prompt").some((m) => m.text.includes("Read the whole panel")));
  box.scrollTop = box.scrollHeight;
  bigTurn("big", 40, "Read all of it. The menu code is in chat.js.", 760000);
  const bigRow = rows().at(-1);
  check("a long turn is taller than the panel", bigRow.getBoundingClientRect().height > box.clientHeight * 2);
  box.scrollTop = box.scrollHeight;
  await sleep(720);
  const bigTray = bigRow.querySelector(".work-tray");
  check("a long turn starts folding", !!bigTray && (bigTray.classList.contains("folding") || bigTray.classList.contains("collapsed")));
  check("the fold moves no more than one panel of history", bigTray.getBoundingClientRect().height <= box.clientHeight + 1);
  await sleep(800);
  const bigAnswer = [...bigRow.querySelector(".assistant-body").children].find((n) => n.textContent.includes("Read all of it."));
  const view = box.getBoundingClientRect(), place = bigAnswer.getBoundingClientRect();
  check("a long turn ends folded with its answer in view", bigTray.classList.contains("collapsed") && settled(bigTray) && place.top >= view.top - 1 && place.bottom <= view.bottom + 1);
  check("the long tray counts every call", bigTray.textContent.includes("Worked for 12m 40s") && bigTray.textContent.includes("· 40 tool calls"));

  // A long turn the reader scrolled up into: it opens in place instead.
  await send("Read it again");
  bigTurn("again", 40, "Read it again. Nothing changed.", 30000);
  const againRow = rows().at(-1);
  const step = [...againRow.querySelectorAll(".md")].find((n) => n.textContent.includes("Step 12:"));
  box.scrollTop += step.getBoundingClientRect().top - box.getBoundingClientRect().top - 40;
  const before = step.getBoundingClientRect().top;
  await sleep(900);
  const againTray = againRow.querySelector(".work-tray");
  check("a turn the reader is inside opens in place", !!againTray && againTray.classList.contains("open") && settled(againTray));
  check("the reader keeps their place", Math.abs(step.getBoundingClientRect().top - before) < 2);
  const stuck = againTray.querySelector(".work-tray-head").getBoundingClientRect();
  check("the open line sticks to the top of the panel", stuck.top >= box.getBoundingClientRect().top - 1 && stuck.top <= box.getBoundingClientRect().top + 16);
  againTray.querySelector(".work-tray-head").click();
  await sleep(800);
  const againAnswer = [...againRow.querySelector(".assistant-body").children].find((n) => n.textContent.includes("Nothing changed."));
  check("folding from the middle leaves the line and answer in view", againTray.classList.contains("collapsed") && settled(againTray)
    && againTray.getBoundingClientRect().top >= box.getBoundingClientRect().top - 1 && againAnswer.getBoundingClientRect().top < box.getBoundingClientRect().bottom);

  check("the tray flow has no runtime errors", t.errors.length === 0);
  return { passed: passed.length, checks: passed };
};
