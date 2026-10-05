"use strict";
window.runClaudeQuestionPanelTests = async function () {
  const t = window.__test, passed = [], id = "question-a";
  const check = (name, ok) => { if (!ok) throw new Error(name); passed.push(name); };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const input = { questions: [
    { header: "$19", question: "Что входит в $19 в месяц?", options: [{ label: "Usage included" }, { label: "Fee + usage" }] },
    { header: "Enterprise", question: "Enterprise на странице оставляем?", options: [{ label: "Keep Enterprise" }, { label: "Pro only" }] },
  ] };
  t.emit({ type: "backgroundRestoreStart", sessions: [{ id, agent: "claude", spec: { cwd: "/test/project", model: "opus" },
    sessionId: "question-session", started: true, running: true, submitted: true }] });
  t.emit({ type: "ready", ok: true, version: 38 });
  const permission = { type: "permission", id, requestId: "question-request", toolUseId: "question-tool", toolName: "AskUserQuestion", input };
  t.emit({ type: "backgroundReplay", message: permission });
  t.emit({ type: "backgroundRestoreEnd" });
  const card = document.querySelector(".ask-card");
  check("restoring a pending Claude question shows answer controls", !!card?.querySelector(".ask-opt"));
  card.querySelector(".ask-opt").click();
  check("the first answer advances without sending a partial reply", card.textContent.includes("2 of 2") && !t.posted("permissionResult").length);
  const transcript = (events, done = false) => t.emit({ type: "transcript", id, events, done });
  transcript([{ type: "user", message: { content: "Earlier prompt" } },
    { type: "assistant", message: { id: "earlier", content: [{ type: "text", text: "Earlier response. ".repeat(200) }] } }]);
  transcript([{ type: "assistant", message: { id: "asking", content: [{ type: "tool_use", id: "question-tool", name: "AskUserQuestion", input }] } }], true);
  await frame();
  const staticAsk = document.querySelector(".ask-block");
  check("history stays above the pending answer controls", !!staticAsk && !!(staticAsk.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING));
  check("history does not reset the answer already chosen", card.textContent.includes("2 of 2"));
  const bounds = card.getBoundingClientRect(), box = card.parentElement.getBoundingClientRect();
  check("the restored controls remain visible at the bottom", bounds.top >= box.top && bounds.bottom <= box.bottom + 1);
  t.emit(permission);
  check("a repeated permission message does not duplicate the card", document.querySelectorAll(".ask-card").length === 1);
  t.emit({ type: "sessionRole", id, observer: true });
  t.emit({ type: "sharedQueue", id, entries: [{ backgroundId: "queued", text: "Next task", attachments: [] }] });
  t.emit({ type: "sessionRole", id, observer: false });
  t.emit({ type: "event", id, data: { type: "assistant", message: { id: "late", content: [{ type: "text", text: "Late message" }] } } });
  const queued = document.querySelector(".msg-user.queued"), late = [...document.querySelectorAll(".msg-assistant")].find((row) => row.textContent.includes("Late message"));
  check("live messages stay above the question", !!late && !!(late.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING));
  check("queued prompts stay below the question", !!queued && !!(card.compareDocumentPosition(queued) & Node.DOCUMENT_POSITION_FOLLOWING));
  card.querySelector(".ask-opt").click();
  const replies = t.posted("permissionResult"), reply = replies[0];
  check("both answers return in one Claude permission response", replies.length === 1 && reply.requestId === permission.requestId && reply.behavior === "allow"
    && reply.updatedInput.answers[input.questions[0].question] === "Usage included" && reply.updatedInput.answers[input.questions[1].question] === "Keep Enterprise");
  check("answered controls leave the panel", !document.querySelector(".ask-card"));
  t.emit({ ...permission, requestId: "cancelled-question" });
  t.emit({ type: "permissionCancel", id, requestId: "cancelled-question" });
  check("cancelled questions leave no active controls", !document.querySelector(".ask-card") && t.posted("permissionResult").length === 1);
  const composer = document.querySelector("#composer-input");
  composer.value = "Send this correction now";
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const correction = [...document.querySelectorAll(".msg-user.queued")].at(-1);
  check("Claude queued messages show Steer beside remove", correction.querySelector(".queued-tag").firstElementChild.classList.contains("queued-steer"));
  correction.querySelector(".bubble").click();
  correction.querySelector("textarea").value = "Edited correction now";
  composer.value = "Unsent draft";
  const before = t.posted("prompt").length;
  correction.querySelector(".queued-steer").click();
  correction.querySelector(".queued-steer").click();
  check("Claude Steer sends Stop once before any prompt", t.posted("interrupt").length === 1 && t.posted("prompt").length === before);
  t.emit({ type: "interrupted", id });
  await frame();
  check("Stop does not send another queued message first", t.posted("prompt").length === before && document.querySelectorAll(".msg-user.queued").length === 2);
  t.emit({ type: "started", id, cwd: "/test/project" });
  await frame();
  check("restart sends the selected edited message in the same chat", t.posted("prompt").length === before + 1 && t.posted("prompt").at(-1).text.includes("Edited correction now") && t.posted("prompt").at(-1).id === id);
  check("Steer keeps the older queue entry and composer draft", document.querySelectorAll(".msg-user.queued").length === 1 && document.querySelector(".msg-user.queued").textContent.includes("Next task") && composer.value === "Unsent draft");
  t.emit({ type: "started", id, cwd: "/test/project" });
  await frame();
  check("a repeated start event cannot resend the correction", t.posted("prompt").length === before + 1);
  check("Claude question flow has no runtime errors", t.errors.length === 0);
  return { passed: passed.length, checks: passed };
};
