import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/panel/chat.js", import.meta.url), "utf8");
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const plain = (value) => JSON.parse(JSON.stringify(value));

function replay(events) {
  const bubbles = [];
  const chat = { id: "chat", harness: "claude" };
  const scope = { activeId: "other", replayStamp: 0, CTX_MARK_RE: /<context>[\s\S]*?<\/context>/g,
    SYNTHETIC_USER_TAG_RE: /<system-reminder>[\s\S]*?<\/system-reminder>/g, USAGE_CMD_RE: /^\/usage$/,
    commandBubbleText: () => null, scanBgNotice() {}, scanAgentNotice() {}, fillToolResult() {},
    userBubble: (_chat, text, attachments, opts) => bubbles.push({ text, attachments, real: !!opts?.real }) };
  vm.createContext(scope);
  vm.runInContext(section("  function replayImage(source)", "  // Render the output of a local slash command."), scope);
  scope.replayTranscript(chat, events);
  return plain(bubbles);
}

const image = (data, media_type = "image/jpeg") => ({ type: "image", source: { type: "base64", media_type, data } });
const user = (...content) => ({ type: "user", message: { content } });

test("reopened history shows the images the user sent", () => {
  const [bubble] = replay([user(image("AAA"), image("BBB", "image/png"), { type: "text", text: "<context>tabs</context>Match picture 2" })]);
  assert.equal(bubble.text, "Match picture 2");
  assert.deepEqual(bubble.attachments.map((a) => a.dataUrl), ["data:image/jpeg;base64,AAA", "data:image/png;base64,BBB"]);
  assert.equal(bubble.real, true);
});

test("an image cut by the host's size cap is left out instead of shown broken", () => {
  const [bubble] = replay([user(image("AAA\n…[truncated 120000 chars]"), { type: "text", text: "Look" })]);
  assert.deepEqual(bubble.attachments, []);
});

test("an image sent without text shows but takes no rewind turn, like the host counts it", () => {
  const bubbles = replay([user(image("AAA")), user(image("BBB"), { type: "text", text: "<context>tabs</context>" })]);
  assert.deepEqual(bubbles.map((b) => [b.text, b.attachments.length, b.real]), [["", 1, false], ["", 1, true]]);
});

class Node {
  constructor(className) { this.className = className; this.children = []; this.parentElement = null; this.dataset = {}; }
  get classList() { return { contains: (name) => this.className.split(" ").includes(name) }; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get previousElementSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) - 1] || null;
  }
  querySelector(selector) { return selector === ":scope > .assistant-body" ? this.children.find((c) => c.classList.contains("assistant-body")) || null : null; }
}

test("a queued message does not split a running reply into one row per tool call", () => {
  const scope = { el: (_tag, className) => new Node(className) };
  vm.createContext(scope);
  vm.runInContext(section("  function transcriptTail(chat)", "  // Attaches the assistant row"), scope);
  const messagesEl = new Node("chat-messages");
  const row = messagesEl.appendChild(new Node("msg msg-assistant"));
  const body = row.appendChild(new Node("assistant-body"));
  messagesEl.appendChild(new Node("msg msg-user queued"));
  const statusEl = messagesEl.appendChild(new Node("turn-status running"));
  const chat = { messagesEl, statusEl, currentAssistantId: "first", currentAssistantBody: body };
  assert.equal(scope.ensureAssistantBody(chat, "second"), body);
  chat.currentAssistantBody = null;
  assert.equal(scope.ensureAssistantBody(chat, "third"), body, "a resumed reply also finds the row above the queue");
});

test("a Claude chat shares its queue with the worker so other views show it", () => {
  const sent = [];
  const chat = { id: "chat", harness: "claude", queue: [{ text: "Same for this section", contexts: [],
    attachments: [{ mediaType: "image/png", dataUrl: "data:image/png;base64,AAA" }] }] };
  const scope = { connected: true, backgroundRestoring: false, sharedRendering: false, applyingSharedPrefs: false,
    DEFAULT_HARNESS: "claude", CTX_MARK_START: "<context>", CTX_MARK_END: "</context>", chats: new Map([["chat", chat]]),
    newId: () => "q1", formatContexts: () => "", post: (msg) => { sent.push(plain(msg)); return true; } };
  vm.createContext(scope);
  vm.runInContext(section("  function syncBackgroundQueues()", "  // Retargets the dot classes"), scope);
  scope.syncBackgroundQueues();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].agent, "claude");
  assert.equal(sent[0].entries[0].ui.text, "Same for this section");
  assert.deepEqual(sent[0].entries[0].message, { type: "prompt", agent: "claude", id: "chat", text: "Same for this section",
    images: [{ mediaType: "image/png", data: "AAA" }] });
});
