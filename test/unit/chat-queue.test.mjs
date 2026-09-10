import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(process.env.CHAT_QUEUE_SOURCE || new URL("../../src/panel/chat.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const image = (id) => ({ id, mediaType: "image/png", dataUrl: `data:image/png;base64,${id}` });
const page = (id) => ({ kind: "page", url: `https://example.com/${id}`, text: id });
const plain = (value) => JSON.parse(JSON.stringify(value));

function panel({ background = false } = {}) {
  const sent = [], bubbles = [], waiting = [];
  let accepts = true, stale = false, restarts = 0;
  const chat = {
    id: "a", title: "Existing chat", started: true, contexts: [], attachments: [], queue: [],
    streamedMsgIds: new Set(), streamedText: new Map(), streamBlocks: new Map(), turnIndexCounter: 0,
  };
  const input = { value: "" };
  const scope = {
    activeId: background ? "other" : "a", els: { input },
    DEFAULT_TITLE: "New chat", USAGE_CMD_RE: /^\/usage$/, CTX_MARK_START: "<context>", CTX_MARK_END: "</context>",
    sessionLooksStale: () => stale,
    restartSessionNow: () => { restarts++; stale = false; },
    buildTabsContextBlock: () => new Promise((resolve) => waiting.push(resolve)),
    formatBashContext: () => "", dedupeContexts: (contexts) => contexts,
    post: (message) => { sent.push(plain(message)); return accepts; },
    userBubble: (chat, text, attachments, opts) => bubbles.push(plain({ text, attachments, opts })),
    renderQueuedBubble: () => ({ parentNode: true, remove() {} }),
  };
  for (const name of ["renderContextChips", "renderAttachmentThumbs", "autosize", "updateTabDots", "updateEmptyMark", "touchChat", "finishUsageProbe", "startChatSession", "systemNote", "refreshStatusWord", "renderTabs", "setRunningUI", "startStatusTicker", "renderTurnStatus", "updateSetup", "savePrefs"]) scope[name] = () => {};
  vm.createContext(scope);
  vm.runInContext([
    section("  function formatContexts(chat)", "  // Invisible-char sentinels"),
    section("  // Stashes a prompt (plus its context/attachments)", "  // opts.atFront:"),
    section("  function dispatchNextQueued(chat)", "  function setRunningUI(on)"),
  ].join("\n"), scope);
  return {
    chat, input, sent, bubbles,
    queue(text, attachments = [], contexts = []) {
      chat.attachments = attachments; chat.contexts = contexts; input.value = text;
      scope.queuePrompt(chat, text);
    },
    dispatch: () => scope.dispatchNextQueued(chat),
    send: (text) => scope.deliverPrompt(chat, text),
    async finish() { assert.equal(waiting.length, 1); waiting.shift()(""); await new Promise(setImmediate); },
    disconnect: () => { accepts = false; }, reconnect: () => { accepts = true; },
    expire: () => { stale = true; }, restarts: () => restarts,
  };
}

for (const background of [false, true]) {
  test(`queued messages keep their own images and context (${background ? "background" : "active"} chat)`, async () => {
    const p = panel({ background });
    p.queue("first", [image("first")], [page("first-context")]);
    p.queue("second");
    p.chat.attachments = [image("draft")]; p.chat.contexts = [page("draft-context")]; p.input.value = "unfinished draft";
    p.dispatch();
    p.chat.attachments.push(image("still-uploading")); p.chat.contexts.push(page("later-context"));
    await p.finish();
    assert.deepEqual(p.sent[0].images.map((x) => x.data), ["first"]);
    assert.match(p.sent[0].text, /first-context/);
    assert.doesNotMatch(p.sent[0].text, /draft-context|later-context/);
    p.chat.turnRunning = false; p.dispatch(); await p.finish();
    assert.deepEqual(p.sent[1].images, []);
    assert.equal(p.sent[1].text, "second");
    assert.deepEqual(p.chat.attachments.map((x) => x.id), ["draft", "still-uploading"]);
    assert.deepEqual(p.chat.contexts.map((x) => x.text), ["draft-context", "later-context"]);
    assert.equal(p.input.value, "unfinished draft");
    assert.deepEqual(p.bubbles[0].opts.contexts.map((x) => x.text), ["first-context"]);
  });
}

test("direct sends freeze files and context before waiting for tab details", async () => {
  const p = panel();
  p.chat.attachments = [image("sent")]; p.chat.contexts = [page("sent-context")];
  const delivered = p.send("first");
  assert.equal(p.chat.turnRunning, true);
  p.chat.attachments.push(image("new")); p.chat.contexts.push(page("new-context"));
  await p.finish(); await delivered;
  assert.deepEqual(p.sent[0].images.map((x) => x.data), ["sent"]);
  assert.match(p.sent[0].text, /sent-context/); assert.doesNotMatch(p.sent[0].text, /new-context/);
  assert.deepEqual(plain(p.chat.attachments), [image("new")]);
  assert.deepEqual(plain(p.chat.contexts), [page("new-context")]);
});

test("a second send during tab lookup keeps its files in its queue entry", async () => {
  const p = panel();
  p.chat.attachments = [image("first")]; p.chat.contexts = [page("first-context")];
  const delivered = p.send("first");
  p.queue("second", [image("second")], [page("second-context")]);
  await p.finish(); await delivered;
  assert.match(p.sent[0].text, /first-context/);
  p.chat.turnRunning = false; p.dispatch(); await p.finish();
  assert.deepEqual(p.sent.map((x) => x.images.map((i) => i.data)), [["first"], ["second"]]);
  assert.match(p.sent[1].text, /second-context/);
});

test("failed delivery retries its snapshot ahead of later entries without clearing the draft", async () => {
  const p = panel();
  p.queue("first", [image("first")], [page("first-context")]); p.queue("second");
  p.chat.attachments = [image("draft")]; p.chat.contexts = [page("draft-context")];
  p.disconnect(); p.dispatch(); await p.finish();
  assert.equal(p.chat.turnRunning, false);
  assert.deepEqual(plain(p.chat.queue.map((x) => x.text)), ["first", "second"]);
  assert.deepEqual(plain(p.chat.queue[0].attachments), [image("first")]);
  assert.deepEqual(plain(p.chat.attachments), [image("draft")]);
  p.reconnect(); p.dispatch(); await p.finish();
  assert.deepEqual(p.sent[1], p.sent[0]);
  assert.deepEqual(plain(p.chat.contexts), [page("draft-context")]);
});

test("session restart preserves queue order, silent retries, and the current draft", async () => {
  const p = panel();
  p.queue("retry", [image("retry")]); p.chat.queue[0].silent = true; p.queue("later");
  p.chat.attachments = [image("draft")]; p.chat.contexts = [page("draft-context")]; p.input.value = "draft text";
  p.expire(); await p.dispatch();
  assert.equal(p.restarts(), 1);
  assert.deepEqual(plain(p.chat.queue.map((x) => x.text)), ["retry", "later"]);
  assert.equal(p.chat.queue[0].silent, true);
  assert.deepEqual(plain(p.chat.attachments), [image("draft")]);
  assert.equal(p.input.value, "draft text");
  p.chat.restartFlush = false; p.dispatch(); await p.finish();
  assert.deepEqual(p.sent[0].images.map((x) => x.data), ["retry"]);
  assert.equal(p.bubbles.length, 0); assert.equal(p.chat.turnIndexCounter, 1);
});

test("queued slash commands leave context for the next draft", async () => {
  const p = panel();
  p.queue("/compact", [], [page("draft-context")]);
  p.chat.attachments.push(image("draft"));
  await p.dispatch();
  assert.equal(p.sent[0].text, "/compact"); assert.deepEqual(p.sent[0].images, []);
  assert.deepEqual(plain(p.chat.contexts), [page("draft-context")]);
  assert.deepEqual(plain(p.chat.attachments), [image("draft")]);
});
