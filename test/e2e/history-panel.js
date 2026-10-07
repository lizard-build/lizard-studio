"use strict";
window.runHistoryPanelTests = async function () {
  const t = window.__test, passed = [];
  const check = (name, value) => { if (!value) throw new Error(name); passed.push(name); };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const last = () => t.posted("loadTranscript").at(-1);
  const events = (start, end) => Array.from({ length: end - start }, (_, i) => {
    const n = start + i;
    return { type: "assistant", historyItemId: "item-" + n,
      message: { id: "item-" + n, content: [{ type: "text", text: "Message " + n + "\n\n" + "History line.\n\n".repeat(8) }], usage: {} } };
  });
  const reply = (req, evs, cursor, extra = {}) => t.emit({ type: "transcript", id: req.id,
    sessionId: req.sessionId, requestId: req.requestId, paged: true, done: true, events: evs, nextCursor: cursor, ...extra });
  t.emit({ type: "ready", ok: true, version: 39, home: "/test" });
  t.emit({ type: "agentReady", agent: "codex", ok: true, version: 12 });
  const initial = last();
  check("opening a restored chat asks for the tail once", t.posted("loadTranscript").length === 1 && initial.paged && initial.cursor === null);
  const restoredQuestion = { type: "async_question", questionId: "history-q", historyItemId: "history-q", readOnly: false,
    questions: [{ id: "0", question: "Restored question?", options: [{ label: "Keep it" }] }] };
  reply(initial, [...events(20, 25), restoredQuestion], { kind: "turns", value: "older-20" });
  await frame();
  const box = document.querySelector(".chat-messages:not(.hidden)");
  check("the restored chat opens at its newest message", box.scrollHeight - box.scrollTop - box.clientHeight < 3 && box.textContent.includes("Message 24") && !box.textContent.includes("Message 19"));
  const question = box.querySelector(".ask-card");
  check("the newest page restores the question picker", question?.textContent.includes("Restored question?") && !!question.querySelector(".ask-opt"));
  question.querySelector(".ask-opt").click();
  const answer = t.posted("prompt").at(-1);
  check("a restored picker targets its owning chat", answer?.id === "history-a" && answer.text === "Restored question?\nKeep it");
  t.emit({ type: "promptResult", id: "history-a", requestId: answer.promptRequestId, ok: true, startedTurn: true });
  check("the owning chat receives the answer receipt", question.textContent.includes("Answer sent"));
  check("opening does not eagerly download older pages", t.posted("loadTranscript").length === 1);
  box.scrollTop = 20;
  box.dispatchEvent(new Event("scroll"));
  await frame();
  const older = last();
  check("scrolling up requests the preceding cursor", older.cursor.value === "older-20" && t.posted("loadTranscript").length === 2);
  box.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
  check("repeated scrolling cannot issue duplicate page requests", t.posted("loadTranscript").length === 2);
  reply(older, [], null, { error: "temporary failure" });
  check("a failed page keeps current messages and offers retry", box.textContent.includes("Message 24") && box.querySelector(".history-more").textContent.includes("Retry"));
  box.querySelector(".history-more").click();
  const retry = last();
  check("retry uses the same boundary and a fresh request id", retry.cursor.value === older.cursor.value && retry.requestId !== older.requestId);
  reply(older, events(10, 20), null);
  check("late responses from failed requests stay ignored", !box.textContent.includes("Message 10"));
  t.emit({ type: "event", id: "history-a", data: { type: "assistant", message: { id: "live-reply", content: [{ type: "text", text: "Live reply stays last." }], usage: {} } } });
  t.emit({ type: "contextUsage", id: "history-a", agent: "codex", window: 258400, usage: { input_tokens: 50000 } });
  const anchor = [...box.children].find((n) => n.classList.contains("msg"));
  const before = anchor.getBoundingClientRect().top;
  reply(retry, events(15, 21), { kind: "turns", value: "older-15" });
  await frame();
  check("prepending preserves the visible message position", Math.abs(anchor.getBoundingClientRect().top - before) < 2);
  check("overlapping pages do not duplicate messages", [...box.querySelectorAll("p")].filter((p) => p.textContent === "Message 20").length === 1);
  check("older pages preserve a live reply at the end", [...box.querySelectorAll(":scope > .msg")].at(-1).textContent.includes("Live reply stays last."));
  check("older content precedes newer content", box.textContent.indexOf("Message 15") < box.textContent.indexOf("Message 20"));
  box.querySelector(".history-more").click();
  const large = last();
  const text = "Beginning of long message.\n\n" + "Long history text. ".repeat(60000) + "\n\nEnd of long message.";
  const packet = JSON.stringify({ type: "transcript", id: large.id, requestId: large.requestId, sessionId: large.sessionId,
    paged: true, done: true, nextCursor: null, events: [{ type: "assistant", historyItemId: "large", message: { id: "large", content: [{ type: "text", text }] } }] });
  for (let offset = 0; offset < packet.length; offset += 100000) t.emit({ type: "transcriptPart", id: large.id,
    sessionId: large.sessionId, requestId: large.requestId, index: offset / 100000, total: Math.ceil(packet.length / 100000), text: packet.slice(offset, offset + 100000) });
  check("large messages reassemble with both ends intact", box.textContent.includes("Beginning of long message.") && box.textContent.includes("End of long message."));
  check("history completion removes the load control", box.querySelector(".history-more").hidden);
  // A chat reopened from the menu, not restored at startup, opens the same way:
  // at its newest message, screenshot included, and loads earlier pages on
  // scroll up.
  const canvas = document.createElement("canvas");
  canvas.width = 320; canvas.height = 240;
  canvas.getContext("2d").fillRect(0, 0, 320, 240);
  const screenshot = canvas.toDataURL("image/png").split(",")[1];
  document.querySelector("#menu-btn").click();
  await frame();
  const row =[...document.querySelectorAll(".chat-menu-item")].find((node) => node.textContent.includes("Old chat"));
  check("the menu lists the old chat", !!row);
  row.click();
  const reopened = last();
  check("reopening an old chat asks for its tail", reopened.sessionId === "session-old" && reopened.paged && reopened.cursor === null);
  reply(reopened, [...events(40, 45), { type: "user", historyItemId: "shot", historyTurnIndex: 6,
    message: { role: "user", content: [{ type: "text", text: "Newest question with a screenshot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot } }] } }], { kind: "turns", value: "older-40" });
  const oldBox = document.querySelector(".chat-messages:not(.hidden)");
  const thumb = oldBox.querySelector(".bubble-thumb");
  if (!thumb.complete) await new Promise((resolve) => thumb.addEventListener("load", resolve, { once: true }));
  await frame();
  check("a reopened chat opens at its newest message once its screenshot loads", oldBox.scrollHeight - oldBox.scrollTop - oldBox.clientHeight < 3 && oldBox.textContent.includes("Newest question") && !oldBox.textContent.includes("Message 39"));
  oldBox.scrollTop = 20;
  oldBox.dispatchEvent(new Event("scroll"));
  await frame();
  check("scrolling up in a reopened chat requests the page before", last().cursor?.value === "older-40");
  check("history causes no browser errors", t.errors.length === 0);
  return { passed: passed.length, checks: passed };
};
