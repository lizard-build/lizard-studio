import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, createReadStream, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/host/claude-host.mjs", import.meta.url), "utf8");
const cut = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function load(file) {
  const sent = [];
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const scope = { createReadStream, statSync, readline, Buffer, MAX_MSG: 900 * 1024, log() {},
    send: (m) => sent.push(plain(m)), findTranscript: () => file };
  vm.createContext(scope);
  vm.runInContext(cut("const CMD_NAME_RE", "function rewindSession") + cut("// ---- paged transcript", "function loadTranscript(id"), scope);
  return { sent, page: (msg) => scope.loadTranscriptPage(msg) };
}

const line = (o) => JSON.stringify(o);
const turn = (n) => [
  line({ type: "user", message: { content: [{ type: "text", text: "q" + n }] }, timestamp: "t" + n }),
  line({ type: "assistant", message: { id: "a" + n, content: [{ type: "tool_use", id: "tu" + n, name: "Bash", input: {} }] } }),
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu" + n, content: "ok" }] } }),
  line({ type: "assistant", message: { id: "b" + n, content: [{ type: "text", text: "a" + n }] } }),
];

test("newest turns come first and the cursor walks back to the start with the host's turn numbers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "page-"));
  const file = join(dir, "s.jsonl");
  const lines = [line({ type: "summary" }), line({ type: "user", isMeta: true, message: { content: "meta" } })];
  for (let n = 1; n <= 70; n++) lines.push(...turn(n));
  writeFileSync(file, lines.join("\n") + "\n");
  const { sent, page } = load(file);
  const msg = { id: "c", sessionId: "s", cwd: "/x", requestId: "r", paged: true };

  await page(msg);
  const first = sent.at(-1);
  assert.equal(first.paged, true);
  assert.equal(first.totalTurns, 70);
  const nums = first.events.filter((e) => e.historyTurnIndex).map((e) => e.historyTurnIndex);
  assert.deepEqual([nums[0], nums.at(-1), nums.length], [41, 70, 30]);
  assert.equal(first.events[0].type, "user"); // opens on a user turn, never mid tool pair
  assert.ok(first.nextCursor);

  await page({ ...msg, cursor: first.nextCursor });
  const second = sent.at(-1);
  assert.equal(second.totalTurns, undefined);
  assert.deepEqual(second.events.filter((e) => e.historyTurnIndex).map((e) => e.historyTurnIndex).slice(0, 1), [11]);

  await page({ ...msg, cursor: second.nextCursor });
  const third = sent.at(-1);
  assert.equal(third.nextCursor, null);
  assert.equal(third.events.filter((e) => e.historyTurnIndex)[0].historyTurnIndex, 1);
  assert.equal(first.events.length + second.events.length + third.events.length, 280);
});

test("a missing transcript answers with no events and no cursor", async () => {
  const { sent, page } = load(null);
  await page({ id: "c", sessionId: "s", cwd: "/x", requestId: "r", paged: true });
  assert.deepEqual([sent[0].events, sent[0].missing, sent[0].nextCursor], [[], true, undefined]);
});
