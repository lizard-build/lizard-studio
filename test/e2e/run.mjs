// End-to-end tests for the two-agent side panel.
//
// These drive the real thing: the real router, the real hosts, the real
// `claude` and `codex` CLIs. Nothing below the native-messaging pipe is
// stubbed, because the whole point of the exercise is that the Claude path
// still behaves exactly as it did before a second agent existed.
//
//   node test/e2e/run.mjs            everything
//   node test/e2e/run.mjs --cheap    only what costs no model tokens
//   node test/e2e/run.mjs --filter codex
//
// A few tests spend real tokens (a handful of one-line turns on the cheapest
// model each vendor offers). --cheap skips those.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeChrome, test, group, summary, ok, equal, includes, sleep, setFilter, REPO,
} from "./harness.mjs";

const argv = process.argv.slice(2);
const CHEAP = argv.includes("--cheap");
const fi = argv.indexOf("--filter");
if (fi >= 0 && argv[fi + 1]) setFilter(argv[fi + 1]);

// A throwaway git repo, so the git tests have something real to look at and the
// agents have somewhere harmless to write.
const WORK = join(tmpdir(), "lizard-e2e-" + process.pid);
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, "README.md"), "lizard studio e2e fixture\n");
execSync("git init -q && git add -A && git -c user.email=e2e@test -c user.name=e2e commit -qm init", { cwd: WORK });

const CLAUDE_MODEL = "claude-haiku-4-5";
const live = (fn) => (CHEAP ? undefined : fn);

process.stdout.write(`Lizard Studio · end-to-end\n`);
process.stdout.write(`workdir: ${WORK}\n`);
process.stdout.write(CHEAP ? `mode: cheap (no model calls)\n` : `mode: full (spends tokens)\n`);

const openPanels = [];
function panel() {
  const p = new FakeChrome();
  openPanels.push(p);
  return p;
}

// ---------------------------------------------------------------------------
group("Router — the pipe itself");

await test("both hosts announce themselves on connect", async () => {
  const p = panel();
  const ready = await p.wait((m) => m.type === "ready", 20000, "claude ready");
  ok(ready.version >= 24, `claude host protocol version looks wrong: ${ready.version}`);
  equal(ready.ok, true, "claude reported as not installed");
  const codex = await p.wait((m) => m.type === "agentReady" && m.agent === "codex", 20000, "codex agentReady");
  equal(codex.ok, true, "codex reported as not installed");
  ok(codex.codexPath && codex.codexPath.length, "codex path missing");
  p.kill();
});

await test("claude's ready is byte-identical with and without the router", async () => {
  const viaRouter = panel();
  const r1 = await viaRouter.wait((m) => m.type === "ready", 20000, "ready via router");
  viaRouter.kill();

  const direct = new FakeChrome(join(REPO, "src", "host", "claude-host.mjs"));
  openPanels.push(direct);
  const r2 = await direct.wait((m) => m.type === "ready", 20000, "ready direct");
  direct.kill();

  const strip = (m) => {
    const { __at, __bytes, ...rest } = m;
    return JSON.stringify(rest);
  };
  equal(strip(r1), strip(r2), "the router changed claude's handshake");
});

await test("an unknown message type is ignored, not fatal", async () => {
  const p = panel();
  await p.wait((m) => m.type === "ready", 20000, "ready");
  p.send({ type: "definitely-not-a-real-op", id: "x1", nonsense: true });
  await sleep(600);
  equal(p.exited, null, "the router died on an unknown message");
  // And it still works afterwards.
  p.send({ type: "gitBranches", id: "x1", cwd: WORK });
  const reply = await p.wait((m) => m.type === "gitBranches", 15000, "gitBranches after junk");
  equal(reply.isRepo, true, "git went missing after an unknown message");
  p.kill();
});

await test("shared operations from a Codex chat reach the host that implements them", async () => {
  const p = panel();
  await p.wait((m) => m.type === "ready", 20000, "ready");
  // Note the agent: these must NOT go to the codex host, which has no git.
  p.send({ type: "gitDiff", id: "cx-shared", agent: "codex", cwd: WORK });
  p.send({ type: "gitBranches", id: "cx-shared", agent: "codex", cwd: WORK });
  p.send({ type: "bashExec", id: "cx-shared", agent: "codex", execId: "e1", command: "echo shared-op-ok", cwd: WORK });

  const diff = await p.wait((m) => m.type === "gitDiff", 15000, "gitDiff");
  equal(diff.isRepo, true, "git diff didn't recognise the repo");
  const branches = await p.wait((m) => m.type === "gitBranches", 15000, "gitBranches");
  ok(Array.isArray(branches.branches), "no branch list");
  const out = await p.wait((m) => m.type === "bashOut" && m.execId === "e1", 15000, "bash output");
  includes(out.chunk, "shared-op-ok", "the composer's shell mode broke for a Codex chat");
  const exit = await p.wait((m) => m.type === "bashExit" && m.execId === "e1", 15000, "bash exit");
  equal(exit.code, 0, "shell command failed");
  p.kill();
});

await test("killing the Codex host leaves Claude untouched", async () => {
  const p = panel();
  await p.wait((m) => m.type === "ready", 20000, "ready");
  await p.wait((m) => m.type === "agentReady" && m.agent === "codex", 20000, "codex ready");

  execSync("pkill -f 'codex-host.mjs' || true");
  const gone = await p.wait((m) => m.type === "agentExit" && m.agent === "codex", 15000, "agentExit");
  ok(gone, "no agentExit after the codex host died");
  equal(p.exited, null, "the router died with its secondary host");

  // Claude still answers.
  p.send({ type: "gitBranches", id: "alive", cwd: WORK });
  const reply = await p.wait((m) => m.type === "gitBranches" && m.id === "alive", 15000, "claude still alive");
  equal(reply.isRepo, true, "claude stopped working after the codex host died");
  p.kill();
});

await test("a chat that changes agent stops talking to the old one", async () => {
  // The router remembers which agent a chat id was started on. When the panel
  // moves a chat to the other agent, that memory has to be replaced — not
  // consulted. Getting this wrong sent prompts to Codex from a chat whose
  // composer said Opus, which is exactly as confusing as it sounds.
  const p = panel();
  await p.wait((m) => m.type === "agentReady" && m.agent === "codex", 20000, "codex ready");

  p.send({ type: "start", id: "swap", agent: "codex", cwd: WORK, permissionMode: "default" });
  const first = await p.wait((m) => m.type === "started" && m.id === "swap", 90000, "codex started");
  ok(String(first.model || "").startsWith("gpt"), `expected a Codex model, got ${first.model}`);

  // What the panel does on a switch: let the old agent go, then start again.
  p.send({ type: "close", id: "swap", agent: "codex" });
  p.send({ type: "start", id: "swap", agent: "claude", cwd: WORK, model: CLAUDE_MODEL, permissionMode: "plan" });
  const second = await p.wait(
    (m) => m.type === "started" && m.id === "swap" && m.model === CLAUDE_MODEL,
    60000, "claude started"
  );
  equal(second.model, CLAUDE_MODEL, "the second start didn't reach Claude");

  // And a later message with no agent named must follow the chat, not the memory.
  p.send({ type: "gitBranches", id: "swap", cwd: WORK });
  const reply = await p.wait((m) => m.type === "gitBranches" && m.id === "swap", 15000, "gitBranches");
  equal(reply.isRepo, true, "the rebound chat lost its shared operations");
  p.kill();
});

await test("a message far over Chrome's 1 MB cap is shrunk, not dropped", async () => {
  const p = panel();
  await p.wait((m) => m.type === "ready", 20000, "ready");
  // A 3 MB file read back through the shell: the raw output cannot legally
  // cross the pipe, so the host has to shorten it rather than go silent.
  const big = join(WORK, "big.txt");
  writeFileSync(big, "x".repeat(3 * 1024 * 1024));
  p.send({ type: "bashExec", id: "big", execId: "b1", command: `cat ${big}`, cwd: WORK });
  const exit = await p.wait((m) => m.type === "bashExit" && m.execId === "b1", 60000, "big command exit");
  equal(exit.code, 0, "the big read failed");
  const chunks = p.all((m) => m.type === "bashOut" && m.execId === "b1");
  ok(chunks.length > 0, "no output came back at all — the cap test proved nothing");
  const oversized = p.all((m) => m.__bytes > 1024 * 1024);
  equal(oversized.length, 0, `${oversized.length} message(s) crossed the 1 MB cap`);
  rmSync(big, { force: true });
  p.kill();
});

// ---------------------------------------------------------------------------
group("Codex — session, translation, controls");

// Lift a top-level function straight out of the host source, so the checks below
// run against the shipped text rather than a copy of it that can drift.
function grabFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  ok(i >= 0, `${name} is gone from the host`);
  let depth = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error("unbalanced " + name);
}

await test("every rung the slider offers is one the model accepts", async () => {
  // Codex publishes a different ladder per model — terra runs to ultra, luna
  // stops at max, gpt-5.5 at xhigh — and the host has to send the rung the user
  // picked, not a nearby one. This used to fold Max into xhigh, so the slider
  // said Max while the turn ran a rung lower.
  //
  // The two mapping functions are pulled out of the host source and run here,
  // so the check is against the shipped text rather than a copy of it.
  const src = readFileSync(join(REPO, "src", "host", "codex-host.mjs"), "utf8");
  const grab = (name) => grabFn(src, name);
  const MODELS = [
    { id: "gpt-5.6-terra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { id: "gpt-5.6-luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] },
  ];
  const map = new Function("MODELS", `${grab("effortFor")}\n${grab("effortForModel")}\nreturn effortForModel;`)(MODELS);

  for (const [model, picked, want] of [
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "medium", "medium"],
    ["gpt-5.6-terra", "ultracode", "ultra"], // Claude's word for the top rung
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],        // luna has no ultra — nearest below
    ["gpt-5.5", "xhigh", "xhigh"],
    ["gpt-5.5", "max", "xhigh"],
  ]) {
    equal(map(model, picked), want, `${model} on ${picked}`);
  }
  // And every rung a model advertises must survive the trip unchanged.
  for (const m of MODELS) {
    for (const e of m.efforts) equal(map(m.id, e), e, `${m.id} lost its own rung ${e}`);
  }
});

await test("a reply whose item starts twice is still one message", async () => {
  // Codex announces an agentMessage item when it opens and, on a custom
  // provider, a second time when it closes — same id, now carrying the whole
  // text, because `output_item.added` only reaches the responses wire together
  // with `.done`. Taking that for a second message closed the block the panel
  // was typing into and opened an empty one, which `item/completed` then filled
  // with the entire reply: the answer printed twice, once typed and once whole.
  //
  // The three functions that decide this are pulled out of the host source and
  // driven here with the notification order a real turn produced.
  const src = readFileSync(join(REPO, "src", "host", "codex-host.mjs"), "utf8");
  const out = [];
  const emit = (_s, data) => out.push(data);
  const nothing = () => {};
  const host = new Function(
    "emit", "nextMsgId", "usageBlock", "toolUse", "toolResult", "commandTool", "fileChangeTool", "DEFAULT_MODEL",
    [
      grabFn(src, "closeStream"),
      grabFn(src, "onItemStarted"),
      grabFn(src, "onItemCompleted"),
      "return { onItemStarted, onItemCompleted };",
    ].join("\n"),
  )(emit, () => "generated", () => ({}), nothing, nothing, nothing, nothing, "codex");

  const TEXT = "Привет! Чем помочь?";
  const s = { id: "t1", streamMsgId: null, streamText: "", seq: 0, model: "custom", execOut: new Map() };
  const item = { type: "agentMessage", id: "msg_1" };

  host.onItemStarted(s, { item });
  for (const piece of ["Привет!", " Чем", " помочь?"]) {
    // What handleNotification does on item/agentMessage/delta.
    s.streamText += piece;
    emit(s, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
  }
  host.onItemStarted(s, { item: { ...item, text: TEXT } }); // the duplicate start
  host.onItemCompleted(s, { item: { ...item, text: TEXT } });

  const starts = out.filter((d) => d.type === "stream_event" && d.event.type === "message_start");
  equal(starts.length, 1, `one reply opened ${starts.length} messages`);
  const streamed = out
    .filter((d) => d.type === "stream_event" && d.event.type === "content_block_delta")
    .map((d) => d.event.delta.text)
    .join("");
  equal(streamed, TEXT, "the streamed text is not the reply exactly once");
  const canonical = out.filter((d) => d.type === "assistant");
  equal(canonical.length, 1, `${canonical.length} canonical copies`);
  equal(canonical[0].message.id, item.id, "the canonical copy changed id — the panel dedupes on it");
});

await test("the model catalog arrives once anything asks for Codex", async () => {
  const p = panel();
  await p.wait((m) => m.type === "agentReady" && m.agent === "codex", 20000, "codex ready");
  // The catalog lives in the app-server, which only starts on demand. This is
  // the message the panel sends the moment its harness chip lands on Codex.
  p.send({ type: "prewarm", agent: "codex", cwd: WORK });
  const cat = await p.wait((m) => m.type === "models" && m.agent === "codex", 60000, "model catalog");
  ok(Array.isArray(cat.models) && cat.models.length, "empty catalog");
  ok(cat.defaultModel, "no default model");
  ok(cat.models.every((m) => m.id && m.label), "a catalog row is missing id or label");
  p.kill();
});

await test("someone else's MCP servers stay out of the conversation", async () => {
  // Codex boots whatever the user has configured in their own config.toml, and
  // some of those fail every session — not logged in, expired token, a server
  // that moved. None of it is this chat's business, and none of it is
  // actionable from here. The only server worth a word is our own browser
  // relay, whose loss actually costs the user something.
  const p = panel();
  p.send({ type: "start", id: "noise", agent: "codex", cwd: WORK, permissionMode: "default" });
  await p.wait((m) => m.type === "started" && m.id === "noise", 90000, "started");
  // Long enough for every configured server to have finished trying.
  await sleep(20000);
  const leaked = p.all((m) => m.type === "mcpStatus" && m.server !== "browser");
  equal(leaked.length, 0, `${leaked.length} MCP notice(s) reached the panel: ${leaked.map((m) => m.server).join(", ")}`);
  const errors = p.all((m) => m.type === "error" && m.id === "noise");
  equal(errors.length, 0, `the session reported an error nobody asked about: ${errors.map((e) => e.message).join("; ")}`);
  p.kill();
});

await test("prewarming makes the next session open immediately", async () => {
  const p = panel();
  await p.wait((m) => m.type === "agentReady" && m.agent === "codex", 20000, "codex ready");
  p.send({ type: "prewarm", agent: "codex", cwd: WORK });
  // Give the host time to open a spare thread (it deliberately waits a beat).
  await sleep(22000);
  const t0 = Date.now();
  p.send({ type: "start", id: "warm", agent: "codex", cwd: WORK, permissionMode: "default" });
  await p.wait((m) => m.type === "started" && m.id === "warm", 40000, "warm start");
  const ms = Date.now() - t0;
  ok(ms < 1500, `a prewarmed session still took ${ms}ms to open`);
  p.kill();
});

await test("a session reports its folder, model and thread", async () => {
  const p = panel();
  p.send({ type: "start", id: "s1", agent: "codex", cwd: WORK, permissionMode: "default", effort: "low" });
  const started = await p.wait((m) => m.type === "started" && m.id === "s1", 60000, "started");
  equal(started.cwd, WORK, "wrong working folder");
  ok(started.model, "no model reported");
  const init = await p.wait(
    (m) => m.type === "event" && m.id === "s1" && m.data.type === "system" && m.data.subtype === "init",
    20000, "system init"
  );
  equal(init.data.cwd, WORK, "init reported the wrong folder");
  ok(init.data.session_id, "init carried no session id");
  equal(init.data.agent, "codex", "init didn't name the agent");
  p.kill();
});

await test(
  "a turn streams text and closes with a result",
  live(async () => {
    const p = panel();
    p.send({ type: "start", id: "t1", agent: "codex", cwd: WORK, permissionMode: "default", effort: "low" });
    await p.wait((m) => m.type === "started" && m.id === "t1", 60000, "started");
    p.send({ type: "prompt", id: "t1", text: "Reply with exactly: codex-stream-ok" });
    await p.wait((m) => m.type === "event" && m.id === "t1" && m.data.type === "result", 120000, "result");

    includes(p.streamedText("t1"), "codex-stream-ok", "the live stream never carried the reply");
    includes(p.text("t1"), "codex-stream-ok", "the final message never carried the reply");

    // The panel needs both halves of the stream envelope or it never finishes
    // the assistant block.
    const kinds = p.events("t1").filter((d) => d.type === "stream_event").map((d) => d.event.type);
    ok(kinds.includes("message_start"), "no message_start");
    ok(kinds.includes("content_block_start"), "no content_block_start");
    ok(kinds.includes("content_block_stop"), "no content_block_stop");
    ok(kinds.includes("message_stop"), "no message_stop");
    p.kill();
  })
);

await test(
  "typing straight after opening a chat doesn't lose the message",
  live(async () => {
    // Opening a Codex thread takes seconds; the panel doesn't wait for it. A
    // fast typist's first message therefore lands before the session exists,
    // and it must queue rather than come back as "this session isn't running".
    const p = panel();
    p.send({ type: "start", id: "race", agent: "codex", cwd: WORK, permissionMode: "default", effort: "low" });
    p.send({ type: "prompt", id: "race", text: "Reply with exactly: raced-ok" });

    await p.wait((m) => m.type === "event" && m.id === "race" && m.data.type === "result", 150000, "result");
    includes(p.text("race"), "raced-ok", "the first message was dropped");
    const errs = p.all((m) => m.type === "error" && m.id === "race");
    equal(errs.length, 0, `the panel was told the session wasn't running: ${errs.map((e) => e.message).join("; ")}`);
    p.kill();
  })
);

await test(
  "a shell command becomes a Bash card with the command a person would type",
  live(async () => {
    const p = panel();
    p.send({ type: "start", id: "t2", agent: "codex", cwd: WORK, permissionMode: "default", effort: "low" });
    await p.wait((m) => m.type === "started" && m.id === "t2", 60000, "started");
    p.send({ type: "prompt", id: "t2", text: "Run exactly this shell command and nothing else: echo card-ok" });
    await p.wait((m) => m.type === "event" && m.id === "t2" && m.data.type === "result", 120000, "result");

    const calls = p.toolCalls("t2");
    ok(calls.length, "no tool card was drawn for a shell command");
    const bash = calls.find((c) => c.name === "Bash");
    ok(bash, `expected a Bash card, got: ${calls.map((c) => c.name).join(", ")}`);
    ok(!/(^|\/)(ba|z)sh\s+-[a-z]*c/.test(bash.input.command), `the shell wrapper leaked into the card: ${bash.input.command}`);
    includes(bash.input.command, "echo card-ok", "the card shows the wrong command");

    const results = p.toolResults("t2");
    const res = results.find((r) => r.id === bash.id);
    ok(res, "the Bash card never got a result");
    includes(res.text, "card-ok", "the result didn't carry the output");
    p.kill();
  })
);

await test(
  "reading a file becomes a Read card, not a wall of shell",
  live(async () => {
    const p = panel();
    p.send({ type: "start", id: "t3", agent: "codex", cwd: WORK, permissionMode: "default", effort: "low" });
    await p.wait((m) => m.type === "started" && m.id === "t3", 60000, "started");
    p.send({ type: "prompt", id: "t3", text: "Read the file README.md and tell me its first line. Do nothing else." });
    await p.wait((m) => m.type === "event" && m.id === "t3" && m.data.type === "result", 120000, "result");

    const calls = p.toolCalls("t3");
    ok(calls.length, "no tool card at all");
    const read = calls.find((c) => c.name === "Read");
    // Codex may legitimately reach for a compound command; that is a Bash card
    // by design. Only a lone read has to classify as Read.
    if (read) {
      includes(read.input.file_path, "README.md", "the Read card points at the wrong file");
    } else {
      const bash = calls.find((c) => c.name === "Bash");
      ok(bash, `expected Read or Bash, got: ${calls.map((c) => c.name).join(", ")}`);
      includes(bash.input.command, "README", "the command doesn't mention the file it read");
    }
    p.kill();
  })
);

await test(
  "editing a file becomes an Edit card carrying both sides of the change",
  live(async () => {
    const p = panel();
    // Codex asks before it applies a patch. Answer like a person would, or the
    // turn sits on a dialog nobody is looking at.
    const asks = p.autoApprove();
    p.send({ type: "start", id: "t4", agent: "codex", cwd: WORK, permissionMode: "default", effort: "low" });
    await p.wait((m) => m.type === "started" && m.id === "t4", 60000, "started");
    p.send({
      type: "prompt",
      id: "t4",
      text: "Create a new file called note.txt containing exactly the single line: hello-from-codex. Then stop.",
    });
    await p.wait((m) => m.type === "event" && m.id === "t4" && m.data.type === "result", 180000, "result");

    ok(existsSync(join(WORK, "note.txt")), "the file was never written");
    includes(readFileSync(join(WORK, "note.txt"), "utf8"), "hello-from-codex", "the file has the wrong contents");

    const calls = p.toolCalls("t4");
    const write = calls.find((c) => c.name === "Write" || c.name === "Edit");
    if (write) {
      // A fileChange item: the panel renders these from file_path plus either
      // content (Write) or the two strings (Edit).
      includes(write.input.file_path, "note.txt", "the card names the wrong file");
      const body = write.input.content != null ? write.input.content : write.input.new_string;
      includes(body || "", "hello-from-codex", "the card doesn't show what was written");
    } else {
      // Codex often writes through the shell instead, which is a Bash card and
      // equally honest — but then something has to have been drawn.
      ok(calls.some((c) => c.name === "Bash"), `no card for the write: ${calls.map((c) => c.name).join(", ")}`);
    }
    rmSync(join(WORK, "note.txt"), { force: true });
    p.kill();
  })
);

await test(
  "read-only mode cannot write without a yes",
  live(async () => {
    const p = panel();
    // Refuse everything. Whether the model asks or gives up on its own is its
    // business; the invariant under test is that a read-only session cannot put
    // anything on disk without a yes.
    const asks = p.autoDeny();
    p.send({ type: "start", id: "t5", agent: "codex", cwd: WORK, permissionMode: "plan", effort: "low" });
    await p.wait((m) => m.type === "started" && m.id === "t5", 60000, "started");
    p.send({ type: "prompt", id: "t5", text: "Create a file called forbidden.txt containing the word nope." });
    await p.wait((m) => m.type === "event" && m.id === "t5" && m.data.type === "result", 180000, "the turn to finish");
    ok(!existsSync(join(WORK, "forbidden.txt")), `a read-only session wrote to disk (asks seen: ${asks.length})`);
    p.kill();
  })
);

await test(
  "stop ends the turn without gating the next one",
  live(async () => {
    const p = panel();
    p.send({ type: "start", id: "t6", agent: "codex", cwd: WORK, permissionMode: "default", effort: "low" });
    await p.wait((m) => m.type === "started" && m.id === "t6", 60000, "started");
    p.send({ type: "prompt", id: "t6", text: "Count from 1 to 200, one number per line, slowly." });
    // Let it get going, then pull the plug.
    await p.wait(
      (m) => m.type === "event" && m.id === "t6" && m.data.type === "stream_event",
      120000, "the turn to start streaming"
    );
    p.send({ type: "interrupt", id: "t6" });
    const stopped = await p.wait((m) => m.type === "interrupted" && m.id === "t6", 30000, "interrupted");
    equal(stopped.respawn, false, "the panel would gate events waiting for a respawn that never comes");
    await p.wait((m) => m.type === "event" && m.id === "t6" && m.data.type === "result", 30000, "result after stop");

    // And the session is still usable — this is what the gate would have broken.
    const before = p.events("t6").length;
    p.send({ type: "prompt", id: "t6", text: "Reply with exactly: after-stop-ok" });
    await p.wait(
      (m) => m.type === "event" && m.id === "t6" && m.data.type === "result" && p.events("t6").length > before + 2,
      120000, "a second result after the stop"
    );
    includes(p.text("t6"), "after-stop-ok", "the session was dead after a stop");
    p.kill();
  })
);

await test("a tab carrying another agent's session id still opens", async () => {
  // Switching a chat's harness leaves it holding the old agent's session id,
  // and a deleted thread looks the same from here. Neither may strand the tab.
  const p = panel();
  p.send({
    type: "start", id: "t9", agent: "codex", cwd: WORK, permissionMode: "default",
    resume: "b639ef04-995a-4016-9d08-097de8b67501", // a Claude session id
  });
  const started = await p.wait((m) => m.type === "started" && m.id === "t9", 90000, "started");
  equal(started.cwd, WORK, "the session didn't open in the right folder");
  const init = await p.wait(
    (m) => m.type === "event" && m.id === "t9" && m.data.type === "system" && m.data.subtype === "init",
    20000, "init"
  );
  ok(init.data.session_id, "no thread was opened");
  ok(init.data.session_id !== "b639ef04-995a-4016-9d08-097de8b67501", "it claimed to resume a foreign session");
  const errs = p.all((m) => m.type === "error" && m.id === "t9");
  equal(errs.length, 0, `the tab was stranded: ${errs.map((e) => e.message).join("; ")}`);
  p.kill();
});

await test(
  "a past session replays into the transcript",
  live(async () => {
    const p = panel();
    p.send({ type: "start", id: "t7", agent: "codex", cwd: WORK, permissionMode: "default", effort: "low" });
    const started = await p.wait((m) => m.type === "started" && m.id === "t7", 60000, "started");
    const init = await p.wait(
      (m) => m.type === "event" && m.id === "t7" && m.data.type === "system" && m.data.subtype === "init",
      20000, "init"
    );
    const threadId = init.data.session_id;
    p.send({ type: "prompt", id: "t7", text: "Reply with exactly: replay-me" });
    await p.wait((m) => m.type === "event" && m.id === "t7" && m.data.type === "result", 120000, "result");
    p.send({ type: "close", id: "t7" });
    await sleep(500);

    // A reopened tab knows only its thread id and asks for the rest.
    p.send({ type: "loadTranscript", id: "t7b", agent: "codex", sessionId: threadId, cwd: WORK });
    const replay = await p.wait((m) => m.type === "transcript" && m.id === "t7b", 90000, "transcript");
    ok(!replay.error, `replay failed: ${replay.error}`);
    ok(Array.isArray(replay.events) && replay.events.length, "the replay came back empty");
    const text = replay.events
      .filter((e) => e.type === "assistant")
      .flatMap((e) => e.message.content)
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    includes(text, "replay-me", "the replay lost the reply");
    const asked = replay.events
      .filter((e) => e.type === "user")
      .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    includes(asked, "replay-me", "the replay lost the question");
    p.kill();
  })
);

await test(
  "token usage and the real context window reach the panel",
  live(async () => {
    const p = panel();
    p.send({ type: "start", id: "t8", agent: "codex", cwd: WORK, permissionMode: "default", effort: "low" });
    await p.wait((m) => m.type === "started" && m.id === "t8", 60000, "started");
    p.send({ type: "prompt", id: "t8", text: "Reply with exactly: usage-ok" });
    await p.wait((m) => m.type === "event" && m.id === "t8" && m.data.type === "result", 120000, "result");

    const win = p.find((m) => m.type === "contextWindow" && m.agent === "codex");
    ok(win && win.window > 100000, `no usable context window reported: ${win && win.window}`);
    const plan = p.find((m) => m.type === "planUsage" && m.agent === "codex");
    ok(plan && typeof plan.usedPercent === "number", "no plan usage reported");
    const result = p.events("t8").find((d) => d.type === "result");
    ok(result.usage && result.usage.input_tokens > 0, "the result carried no token count");
    p.kill();
  })
);

// ---------------------------------------------------------------------------
group("Claude — nothing may have changed");

await test(
  "a session starts, streams and finishes as before",
  live(async () => {
    const p = panel();
    p.send({ type: "start", id: "c1", cwd: WORK, model: CLAUDE_MODEL, permissionMode: "plan" });
    const started = await p.wait((m) => m.type === "started" && m.id === "c1", 60000, "started");
    equal(started.model, CLAUDE_MODEL, "the model didn't survive the router");
    // Claude's `system init` rides the first turn, not the spawn — asking for it
    // before sending anything waits forever.
    p.send({ type: "prompt", id: "c1", text: "Reply with exactly: claude-e2e-ok" });
    await p.wait(
      (m) => m.type === "event" && m.id === "c1" && m.data.type === "system" && m.data.subtype === "init",
      60000, "init"
    );
    await p.wait((m) => m.type === "event" && m.id === "c1" && m.data.type === "result", 120000, "result");
    includes(p.text("c1"), "claude-e2e-ok", "the reply never arrived");
    includes(p.streamedText("c1"), "claude-e2e-ok", "the live stream is broken through the router");
    p.kill();
  })
);

await test(
  "the permission round trip still works",
  live(async () => {
    // Not a shell command: a machine whose settings pre-allow Bash (this one
    // does) never asks about one, so a test built on that proves nothing.
    const p = panel();
    p.send({ type: "start", id: "c2", cwd: WORK, model: CLAUDE_MODEL, permissionMode: "plan" });
    await p.wait((m) => m.type === "started" && m.id === "c2", 60000, "started");
    // Naming the tool outright, rather than describing a situation and hoping
    // the model reaches for it. AskUserQuestion always travels the permission
    // channel, so this exercises the round trip without depending on manners.
    p.send({
      type: "prompt",
      id: "c2",
      text: "Call the AskUserQuestion tool right now with one question: \"Proceed with the change?\" and the options \"Yes\" and \"No\". Do not reply in prose first.",
    });

    const req = await p.wait((m) => m.type === "permission" && m.id === "c2", 150000, "permission ask");
    ok(req.requestId != null, "the ask carried no request id");
    ok(req.toolName, "the ask named no tool");

    // Answer in whatever shape the tool expects — a question wants a choice, a
    // tool call wants a yes.
    if (req.toolName === "AskUserQuestion") {
      const answers = {};
      for (const q of (req.input && req.input.questions) || []) {
        const first = (q.options && q.options[0] && q.options[0].label) || "Yes";
        answers[q.question] = first;
      }
      p.send({ type: "permissionResult", id: "c2", requestId: req.requestId, behavior: "allow", updatedInput: { answers } });
    } else {
      p.send({ type: "permissionResult", id: "c2", requestId: req.requestId, behavior: "allow" });
    }

    // A turn can ask more than once; the first answer is the one under test, so
    // let anything after it through automatically.
    p.autoApprove();

    // The turn has to carry on past the answer — that is the half of the round
    // trip a broken router would silently drop.
    await p.wait((m) => m.type === "event" && m.id === "c2" && m.data.type === "result", 150000, "result after answering");
    const errs = p.all((m) => m.type === "error" && m.id === "c2");
    equal(errs.length, 0, `the host reported an error: ${errs.map((e) => e.message).join("; ")}`);
    p.kill();
  })
);

await test(
  "editing the first message answers instead of dying on a lost session",
  live(async () => {
    // Stop a first turn early, then edit that message and send it again. The
    // rewind cuts the transcript back past every message, so there is nothing
    // left for --resume to open: the host has to start a fresh session rather
    // than spawn a claude that exits 1 with "No conversation found".
    const p = panel();
    p.send({ type: "start", id: "c4", cwd: WORK, model: CLAUDE_MODEL, permissionMode: "plan" });
    await p.wait((m) => m.type === "started" && m.id === "c4", 60000, "started");
    p.send({ type: "prompt", id: "c4", text: "Count slowly from one to fifty, one number per line." });
    await p.wait(
      (m) => m.type === "event" && m.id === "c4" && m.data.type === "system" && m.data.subtype === "init",
      60000, "init"
    );
    p.send({ type: "interrupt", id: "c4" });
    await p.wait((m) => m.type === "interrupted" && m.id === "c4", 30000, "interrupted");
    await sleep(1500); // let the respawn settle, as the panel would

    const mark = Date.now() - p.t0;
    p.send({ type: "rewind", id: "c4", turnIndex: 1, text: "Reply with exactly: rewind-e2e-ok", images: [] });
    await p.wait(
      (m) => m.type === "event" && m.id === "c4" && m.data.type === "result" && m.__at > mark,
      150000, "result after the edit"
    );
    includes(p.text("c4"), "rewind-e2e-ok", "the edited message never got answered");
    const dead = p.all((m) => m.type === "exit" && m.id === "c4");
    equal(dead.length, 0, "the session ended instead of carrying on");
    const errs = p.all((m) => m.type === "error" && m.id === "c4");
    equal(errs.length, 0, `the host reported an error: ${errs.map((e) => e.message).join("; ")}`);
    p.kill();
  })
);

await test(
  "the slash-command list still arrives",
  live(async () => {
    const p = panel();
    p.send({ type: "start", id: "c3", cwd: WORK, model: CLAUDE_MODEL, permissionMode: "plan" });
    const cmds = await p.wait((m) => m.type === "commands" && m.id === "c3", 60000, "commands");
    ok(Array.isArray(cmds.list) && cmds.list.length, "the command list came back empty");
    p.kill();
  })
);

// ---------------------------------------------------------------------------
group("Both at once");

await test(
  "two agents run side by side without crossing wires",
  live(async () => {
    const p = panel();
    p.send({ type: "start", id: "x-cl", cwd: WORK, model: CLAUDE_MODEL, permissionMode: "plan" });
    p.send({ type: "start", id: "x-cx", agent: "codex", cwd: WORK, permissionMode: "default", effort: "low" });
    await p.wait((m) => m.type === "started" && m.id === "x-cl", 60000, "claude started");
    await p.wait((m) => m.type === "started" && m.id === "x-cx", 90000, "codex started");

    p.send({ type: "prompt", id: "x-cl", text: "Reply with exactly: from-claude" });
    p.send({ type: "prompt", id: "x-cx", text: "Reply with exactly: from-codex" });
    await p.wait((m) => m.type === "event" && m.id === "x-cl" && m.data.type === "result", 150000, "claude result");
    await p.wait((m) => m.type === "event" && m.id === "x-cx" && m.data.type === "result", 150000, "codex result");

    const claudeText = p.text("x-cl");
    const codexText = p.text("x-cx");
    includes(claudeText, "from-claude", "claude's reply went missing");
    includes(codexText, "from-codex", "codex's reply went missing");
    ok(!claudeText.includes("from-codex"), "codex's reply leaked into the claude tab");
    ok(!codexText.includes("from-claude"), "claude's reply leaked into the codex tab");

    // Every event carried the id of the chat it belongs to, and only that one.
    const strays = p.all((m) => m.type === "event" && m.id !== "x-cl" && m.id !== "x-cx");
    equal(strays.length, 0, `${strays.length} event(s) arrived with an unexpected chat id`);
    p.kill();
  })
);

// ---------------------------------------------------------------------------
for (const p of openPanels) p.kill();
await sleep(400);
try { rmSync(WORK, { recursive: true, force: true }); } catch { /* leave it */ }

process.exit(summary() ? 0 : 1);
