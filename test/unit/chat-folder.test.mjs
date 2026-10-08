import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/panel/chat.js", import.meta.url), "utf8");
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function setup(harness = "codex") {
  const sent = [], created = [], saved = [];
  const node = () => ({ remove() {}, classList: { toggle() {} } });
  const chat = { id: "current", harness, model: "old-model", cwd: "/old-project", empty: true,
    queue: [], diffCollapsedFiles: new Set(), messagesEl: node(), draft: "" };
  const old = { ...chat, id: "old", cwd: "/pro19-server-20261005", messagesEl: node() };
  const scope = {
    lastCwd: null, home: "/home/user", lastHarness: harness, DEFAULT_HARNESS: "claude", DEFAULT_EFFORT: "high",
    mounted: true, applyingSharedPrefs: false, activeId: chat.id, composerChatId: chat.id,
    chats: new Map([[chat.id, chat], [old.id, old]]), order: [chat.id, old.id], history: [],
    els: { input: { value: "" }, stack: { appendChild() {} } },
    lastBy: { claude: {}, codex: {} }, HARNESSES: [{ id: "claude" }, { id: "codex" }],
    modelsFor: () => [{ id: "new-model" }], codexRow: () => null,
    lastFor: id => scope.lastBy[id], defaultModelFor: () => "default-model", modesFor: () => [{ id: "auto" }],
    makeChat: opts => ({ ...opts, messagesEl: node() }),
    createChat: opts => { created.push(opts); return opts; },
    post: msg => { sent.push(msg); return true; },
    savePrefs: () => saved.push({ lastCwd: scope.lastCwd }),
    setActive: id => { scope.activeId = id; },
    setTimeout() {}, clearTimeout() {},
  };
  for (const name of ["resetChatSession", "requestBranches", "requestGitDiff", "syncComposer", "renderTabs",
    "clearSessionFailure", "clearPermCards", "resumeClaudeSteer", "clampEffort", "updateSetup", "autosize",
    "scheduleSessionRestart", "reportChatActivity"]) scope[name] = () => {};
  scope.chatHasEmptyView = c => c.empty;
  scope.resumableSessionId = c => c.sessionId;
  vm.createContext(scope);
  vm.runInContext([
    section("  function rememberCwd(", "  // ---- DOM helpers"),
    section("  function applyFolder(", "  function promptForFolder("),
    section("  function chooseHarness(", "  function syncHarness("),
    section("  function prewarmHarnesses(", "  function activeHarness("),
    section("  function applyModel(", "  function normalizeCodexModel("),
    section("  function onClaudeEvent(", "  function endTurn("),
    section("  function onHostMessage(", "  function post("),
    section("  function applySharedPrefs(", "  // Remember a folder"),
    section("  function closeChat(", "  // ---- tab switching"),
    section("  function loadPrefs(", "  let composerChatId"),
  ].join("\n"), scope);
  return { scope, chat, old, sent, created, saved };
}

for (const harness of ["claude", "codex"]) {
  test(`${harness} startup and restored history cannot replace the last folder choice`, () => {
    const p = setup(harness);
    p.scope.applyFolder(p.chat, "/lizard");
    p.scope.onHostMessage({ type: "started", id: p.old.id, cwd: p.old.cwd });
    p.scope.onClaudeEvent(p.old, { type: "system", subtype: "init", cwd: p.old.cwd });
    assert.equal(p.scope.defaultCwd(), "/lizard");
    assert.equal(p.saved.at(-1).lastCwd, "/lizard");
    assert.equal(p.old.cwd, "/pro19-server-20261005");
    p.scope.applyModel(p.chat, "new-model");
    p.scope.chooseHarness(p.chat, harness === "claude" ? "codex" : "claude");
    assert.equal(p.chat.cwd, "/lizard");
    assert.equal(p.scope.defaultCwd(), "/lizard");
  });

  test(`${harness} switching from an old conversation starts in the last chosen folder`, () => {
    const p = setup(harness); p.scope.applyFolder(p.chat, "/lizard");
    p.old.empty = false; p.scope.activeId = p.old.id;
    p.scope.chooseHarness(p.old, harness === "claude" ? "codex" : "claude");
    assert.equal(p.created[0].cwd, "/lizard");
    assert.equal(p.old.cwd, "/pro19-server-20261005");
  });
}

test("an explicit home-folder choice counts, but a startup fallback does not", () => {
  const p = setup(); p.scope.applyFolder(p.chat, "/lizard");
  p.scope.onHostMessage({ type: "started", id: p.old.id, cwd: p.scope.home });
  assert.equal(p.scope.defaultCwd(), "/lizard");
  p.scope.applyFolder(p.chat, p.scope.home);
  assert.equal(p.scope.defaultCwd(), p.scope.home);
  assert.equal(p.saved.at(-1).lastCwd, p.scope.home);
});

test("a folder picked in another window becomes the shared default without moving existing chats", () => {
  const p = setup(); p.scope.applyFolder(p.chat, "/lizard");
  p.scope.applySharedPrefs({ lastCwd: "/next-project", tabs: [p.chat, p.old], history: [] });
  assert.equal(p.scope.defaultCwd(), "/next-project");
  assert.equal(p.chat.cwd, "/lizard");
  assert.equal(p.old.cwd, "/pro19-server-20261005");
  p.scope.savePrefs();
  assert.equal(p.saved.at(-1).lastCwd, "/next-project");
});

test("closing the last old chat uses the chosen folder for its replacement", () => {
  const p = setup(); p.scope.applyFolder(p.chat, "/lizard");
  p.scope.closeChat(p.chat.id); p.scope.closeChat(p.old.id);
  assert.equal(p.created.at(-1).cwd, "/lizard");
});

test("prewarming uses the chosen folder instead of the first chat for a harness", () => {
  const p = setup(); p.scope.applyFolder(p.chat, "/lizard"); p.scope.activeId = p.old.id;
  p.scope.prewarmHarnesses();
  assert.equal(p.sent.at(-1).type, "prewarm");
  assert.equal(p.sent.at(-1).cwd, "/lizard");
});

test("reopening loads the saved folder independently of the active chat and harness", () => {
  const p = setup(); p.scope.applyFolder(p.chat, "/lizard");
  const saved = { ...p.saved.at(-1), lastHarness: "claude" };
  const reopened = setup("codex");
  Object.assign(reopened.scope, {
    chrome: { storage: { local: { get: (_, cb) => cb({ rkChatV2: saved }) } } },
    StudioPrefsSync: { createClient: () => ({}) }, chatPrefsSnapshot() {},
  });
  let loaded = false;
  reopened.scope.loadPrefs(() => { loaded = true; });
  assert.equal(loaded, true);
  assert.equal(reopened.scope.defaultCwd(), "/lizard");
  assert.equal(reopened.scope.lastHarness, "claude");
});
