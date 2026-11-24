import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/host/claude-host.mjs", import.meta.url), "utf8");
const cut = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const scopeCode = cut("// ---- browser tab scope", "// ---- browser bridge");

// workingTabId = the tab the chat is pinned to; activeTabId = the tab the user is viewing.
function host({ mode = "default", workingTabId = 1, activeTabId = 1 } = {}) {
  const requests = [];
  const session = { mode };
  const scope = {
    sessions: new Map([["chat", session]]), Number, Set, Map, Date,
    browserRequest: async (op, args, sessionId) => {
      requests.push({ op, sessionId });
      return { ok: true, data: { workingTabId, activeTabId, tabs: [] } };
    },
  };
  vm.createContext(scope);
  vm.runInContext(scopeCode + "\n;this.api = { gateBrowserOp, autoAllowBrowserRead, browserAllowedTools, browserScope };", scope);
  return { api: scope.api, session, requests };
}

test("modes that ask pre-allow nothing; browser_tabs is never pre-allowed", () => {
  const { api } = host();
  for (const mode of ["default", "acceptEdits", "plan", "manual"]) assert.equal(api.browserAllowedTools(mode), "");
  for (const mode of ["dontAsk", "auto", "bypassPermissions"]) {
    const list = api.browserAllowedTools(mode);
    assert.match(list, /mcp__browser__browser_dom/);
    assert.doesNotMatch(list, /browser_tabs|browser_eval/);
  }
});

test("reads of the attached tab are allowed without asking; other tabs ask", async () => {
  const { api, session } = host({ workingTabId: 1, activeTabId: 1 });
  assert.equal((await api.autoAllowBrowserRead(session, "chat", "mcp__browser__browser_dom", {})).behavior, "allow");
  assert.equal((await api.autoAllowBrowserRead(session, "chat", "mcp__browser__browser_dom", { tabId: 1 })).behavior, "allow");
  assert.equal(await api.autoAllowBrowserRead(session, "chat", "mcp__browser__browser_screenshot", { tabId: 7 }), null);
  assert.equal(await api.autoAllowBrowserRead(session, "chat", "mcp__browser__browser_tabs", {}), null);
  assert.equal(await api.autoAllowBrowserRead(session, "chat", "mcp__browser__browser_eval", { tabId: 1 }), null);
  assert.equal(await api.autoAllowBrowserRead(session, "chat", "Bash", { command: "ls" }), null);
});

test("the tab the user is viewing counts as attached, unless the agent activated it", async () => {
  const { api, session } = host({ mode: "dontAsk", workingTabId: 1, activeTabId: 5 });
  assert.equal(await api.gateBrowserOp("dom", { tabId: 5 }, "chat"), null);
  // The agent brings tab 5 to the front itself: that is not the user choosing it.
  const h = host({ mode: "dontAsk", workingTabId: 1, activeTabId: 1 });
  await h.api.gateBrowserOp("tab_activate", { tabId: 5 }, "chat");
  assert.ok(h.api.browserScope(h.session).activatedByAgent.has(5));
  const after = host({ mode: "dontAsk", workingTabId: 1, activeTabId: 5 });
  after.api.browserScope(after.session).activatedByAgent.add(5);
  assert.match(await after.api.gateBrowserOp("dom", { tabId: 5 }, "chat"), /not attached/);
});

test("modes that don't ask refuse eval on other tabs; dontAsk/auto refuse reads too", async () => {
  for (const mode of ["bypassPermissions", "dontAsk", "auto"]) {
    const { api } = host({ mode, workingTabId: 1, activeTabId: 1 });
    const args = { tabId: 9, expression: "document.cookie" };
    assert.match(await api.gateBrowserOp("eval", args, "chat"), /not attached/);
    assert.equal(args.preserveWorkingTab, true, "a refused tab never becomes the chat's pinned tab");
    assert.equal(await api.gateBrowserOp("eval", { tabId: 1 }, "chat"), null);
    assert.equal(await api.gateBrowserOp("eval", { expression: "1" }, "chat"), null);
    const read = await api.gateBrowserOp("dom", { tabId: 9 }, "chat");
    if (mode === "bypassPermissions") assert.equal(read, null);
    else assert.match(read, /not attached/);
  }
});

test("modes that ask leave the bridge alone (the user already approved)", async () => {
  const { api, requests } = host({ mode: "default", workingTabId: 1, activeTabId: 1 });
  assert.equal(await api.gateBrowserOp("eval", { tabId: 9 }, "chat"), null);
  assert.equal(requests.length, 0);
});

test("tabs the agent opened are attached", async () => {
  const { api, session } = host({ mode: "auto", workingTabId: 1, activeTabId: 1 });
  api.browserScope(session).opened.add(22);
  assert.equal(await api.gateBrowserOp("eval", { tabId: 22 }, "chat"), null);
});
