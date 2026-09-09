// Local browser plans. Only the listed operations and predicates can run here;
// model-authored JavaScript never runs in the host process.
const str = { type: "string", maxLength: 10000 };
const tab = { type: "integer", minimum: 1 };
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const condition = obj({
  selector: str, state: { type: "string", enum: ["visible", "hidden", "attached", "absent"] },
  textIncludes: str, valueEquals: str, urlIncludes: str, count: { type: "integer", minimum: 0 }, ready: { type: "boolean" },
});
const observation = obj({
  mode: { type: "string", enum: ["summary", "changes", "full"] }, selector: str,
  maxChars: { type: "integer", minimum: 100, maximum: 12000 },
});
const target = obj({ selector: str, ref: str });
const wait = obj({ condition, timeoutMs: { type: "integer", minimum: 100, maximum: 60000 } }, ["condition"]);
const step = obj({ op: { type: "string" }, args: { type: "object" } }, ["op"]);
const steps = { type: "array", items: step, minItems: 1, maxItems: 60 };
const options = { tabId: tab, timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 } };
const tool = (name, description, inputSchema) => ({ name, description, inputSchema });

export const WORKFLOW_TOOLS = [
  tool("browser_run", "Execute a browser plan locally without a model turn between steps. Prefer this for known sequences. Each step is {op,args}; ops: tab_open, tab_activate, navigate, reload, info, dom, snapshot, console, network, click, fill, type, key, wait_for, assert, observe, if. wait_for/assert args: {condition:{selector?,state?:visible|hidden|attached|absent,textIncludes?,valueEquals?,urlIncludes?,count?,ready?},timeoutMs?}. Predicates combine with AND. if args: {condition,then:[steps],otherwise?:[steps]}. Observe args: {mode?:summary|changes|full,selector?,maxChars?}. Use selectors across page changes; snapshot refs can expire. Stops at the first failure; never repeats actions. Long runs pause between steps (or during a read-only wait); use browser_resume with runId. Returns compact status/timings and the last observation; browser_run_result retrieves step results. Each run uses one tab; tab_open changes that run's tab. Actions require the same user authorization as their single-call forms.", obj({ ...options, steps }, ["steps"])),
  tool("browser_open_page", "Open a new tab, wait for the document (or waitFor condition), and return a compact observation in one call. Defaults to a background tab. Use active:true for a scenario that needs real clicks/keys.", obj({ url: str, active: { type: "boolean" }, waitFor: condition, observe: observation, timeoutMs: options.timeoutMs }, ["url"])),
  tool("browser_click_and_observe", "Click once, wait locally for the supplied postcondition, and return the changed page. A failed wait does not replay the click. Activate a background tab first when real mouse input needs focus.", obj({ ...options, target, waitFor: condition, observe: observation }, ["target", "waitFor"])),
  tool("browser_fill_form", "Fill multiple fields in one call; optionally click submit once, wait for confirmation, and observe. Supply waitFor when submitting. Never retries submission. Fields and targets use selectors or current snapshot refs.", obj({ ...options, fields: { type: "array", minItems: 1, maxItems: 30, items: obj({ selector: str, ref: str, value: str }, ["value"]) }, submit: target, waitFor: condition, observe: observation }, ["fields"])),
  tool("browser_wait_for", "Wait for a page condition locally, without repeated model calls. Conditions combine with AND. Returns matched or an explicit timeout; never changes the page.", obj({ ...wait.properties, tabId: tab }, ["condition"])),
  tool("browser_assert", "Check a page condition once and return pass/fail. Never changes the page.", obj({ tabId: tab, condition }, ["condition"])),
  tool("browser_observe", "Return scoped page text and metadata. Defaults to a compact summary; mode:changes returns a text diff against this session's previous observation of that tab, or a full baseline when none exists. Does not rebuild snapshot refs. Use browser_snapshot when you need interactive refs.", obj({ tabId: tab, ...observation.properties })),
  tool("browser_check_pages", "Check independent URLs in parallel (1–4 workers). Each URL gets a new background tab; waits for ready, evaluates optional conditions, and returns a short report. No clicks or form submissions. Closes only tabs created by this call, and preserves the conversation's working tab. Page loads share the user's browser profile, so this is not account/storage isolation. Up to 12 pages per call.", obj({ pages: { type: "array", minItems: 1, maxItems: 12, items: obj({ url: str, checks: { type: "array", items: condition, maxItems: 20 } }, ["url"]) }, concurrency: { type: "integer", minimum: 1, maximum: 4 }, timeoutMs: { type: "integer", minimum: 1000, maximum: 20000 } }, ["pages"])),
  tool("browser_resume", "Resume a paused plan at its next unfinished step. Completed actions are not replayed. Failed/cancelled plans cannot resume; inspect their result first.", obj({ runId: str }, ["runId"])),
  tool("browser_run_result", "Read a retained plan's status and a page of step results. Stored locally in this MCP session, for five minutes after completion (at most ten runs). fromStep is zero-based; a step's result may be capped with an explicit truncated marker.", obj({ runId: str, fromStep: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["runId"])),
  tool("browser_cancel", "Cancel this session's run by runId, or all its runs if omitted. Stops scheduling further steps. An in-flight browser action may already have run; inspect the page before repeating it.", obj({ runId: str })),
];

export function validate(value, schema, path = "arguments") {
  if (!schema) throw new Error("Unknown operation at " + path);
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(path + " must be an object");
    for (const k of schema.required || []) if (!(k in value)) throw new Error(path + "." + k + " is required");
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) validate(v, schema.properties[k], path + "." + k);
      else if (schema.additionalProperties === false) throw new Error("Unknown field " + path + "." + k);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) throw new Error(path + " must be an array");
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(path + " has too many or too few items");
    value.forEach((v, i) => validate(v, schema.items, path + "[" + i + "]"));
  } else if (type === "integer" || type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) throw new Error(path + " must be a " + type);
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(path + " is out of range");
  } else if (typeof value !== type) throw new Error(path + " must be a " + type);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(path + " has an unsupported value");
  if (type === "string" && value.length > (schema.maxLength ?? 100000)) throw new Error(path + " is too long");
}

function validateCondition(c) {
  validate(c, condition);
  if (!Object.keys(c).length) throw new Error("A condition must contain at least one check");
  if ((c.state !== undefined || c.valueEquals !== undefined || c.count !== undefined) && !c.selector) throw new Error("state, valueEquals and count require a selector");
  if (Object.keys(c).length === 1 && c.selector !== undefined) throw new Error("Add a state, text or count check to the selector");
}
function validateTarget(t) {
  if (!!t.selector === !!t.ref) throw new Error("Supply exactly one selector or ref");
}
function validUrl(url) {
  let u; try { u = new URL(url); } catch { throw new Error("Provide an absolute http(s) URL"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Provide an absolute http(s) URL");
}
const ALLOWED = new Set("tab_open tab_activate navigate reload info dom snapshot console network click fill type key".split(" "));
const WRITES = new Set("tab_open tab_activate navigate reload click fill type key".split(" "));
const PAUSE = Symbol("pause");

// Both probes run in the page. They return only the fields needed by the host.
function conditionProbe(c) {
  const nodes = c.selector ? document.querySelectorAll(c.selector) : null;
  const el = nodes ? nodes[0] : document.body;
  let matched = true;
  if (c.ready !== undefined) matched &&= (document.readyState !== "loading" && !!document.body && location.href !== "about:blank") === c.ready;
  if (c.urlIncludes !== undefined) matched &&= location.href.includes(c.urlIncludes);
  if (c.count !== undefined) matched &&= nodes.length === c.count;
  if (c.state) {
    const style = el ? getComputedStyle(el) : null;
    const visible = !!el && el.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
    matched &&= c.state === "attached" ? !!el : c.state === "absent" ? !el : c.state === "visible" ? visible : !visible;
  }
  if (c.textIncludes !== undefined) matched &&= !!el && (el.innerText || el.textContent || "").includes(c.textIncludes);
  if (c.valueEquals !== undefined) matched &&= !!el && String(el.value ?? "") === c.valueEquals;
  return { matched, url: location.href, title: document.title };
}
function observationProbe(c) {
  const el = c.selector ? document.querySelector(c.selector) : document.body;
  if (c.selector && !el) return { error: "No element matched selector: " + c.selector };
  const text = (el?.innerText || "").trim();
  return { url: location.href, title: document.title, readyState: document.readyState,
    text: text.slice(0, c.maxChars), truncated: text.length > c.maxChars };
}

export function createWorkflowRunner(callHost, primitiveTools, config = {}) {
  const now = config.now || Date.now;
  const sleep = config.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const sliceMs = config.sliceMs || 15000;
  const runs = new Map(), observations = new Map(), locks = new Set();
  const schemas = new Map(primitiveTools.map((t) => [t.name.replace(/^browser_/, ""), t.inputSchema]));
  let serial = 0;

  function check(r) {
    if (r.cancelled) throw new Error("Run cancelled. An in-flight action may already have run.");
    if (now() >= r.deadline) throw new Error("Run deadline exceeded");
  }
  async function send(r, op, args = {}, cleanup = false) {
    if (!cleanup) check(r);
    const started = now();
    r.hostCalls++;
    const work = Promise.resolve().then(() => callHost(op, args));
    let unlisten;
    const stopped = new Promise((_, reject) => {
      if (cleanup) return;
      const fn = () => reject(new Error("Run cancelled. An in-flight action may already have run."));
      r.listeners.add(fn); unlisten = () => r.listeners.delete(fn);
    });
    try {
      const res = await (cleanup ? work : Promise.race([work, stopped]));
      if (!res || res.ok === false) throw new Error(res?.error || op + " failed");
      if (!cleanup) check(r);
      return res.data;
    } finally { unlisten?.(); r.hostMs += now() - started; }
  }
  async function evalRead(r, fn, args) {
    const data = await send(r, "eval", { tabId: r.tabId, preserveWorkingTab: !!r.detached,
      expression: "(" + fn.toString() + ")(" + JSON.stringify(args) + ")" });
    if (data?.error) throw new Error(data.error);
    if (!data?.result || typeof data.result !== "object") throw new Error("Page read returned no result");
    if (data.result.error) throw new Error(data.result.error);
    return data.result;
  }
  async function waitFor(r, args, key, sliceDeadline) {
    const started = r.waits.get(key) ?? now();
    r.waits.set(key, started);
    const deadline = Math.min(r.deadline, started + (args.timeoutMs || 10000));
    let lastError;
    while (true) {
      check(r);
      if (now() >= sliceDeadline) throw PAUSE;
      try {
        const result = await evalRead(r, conditionProbe, args.condition);
        if (result.matched) { r.waits.delete(key); return result; }
        lastError = null;
      } catch (error) {
        check(r);
        // Navigation can replace the execution context between two reads.
        if (!/context.*destroyed|Cannot find context|Inspected target navigated/i.test(error.message)) throw error;
        lastError = error.message;
      }
      if (now() >= deadline) throw new Error("Condition timed out after " + (now() - started) + " ms" + (lastError ? ": " + lastError : ""));
      await sleep(Math.min(200, deadline - now()));
    }
  }
  async function observe(r, args) {
    const mode = args.mode || "summary";
    const maxChars = args.maxChars || (mode === "full" ? 12000 : 2000);
    const current = await evalRead(r, observationProbe, { selector: args.selector, maxChars });
    const key = r.tabId + ":" + (args.selector || "") + ":" + maxChars;
    const previous = observations.get(key);
    if (observations.size >= 100 && !observations.has(key)) observations.delete(observations.keys().next().value);
    observations.set(key, current);
    let result = { ...current, mode, baseline: !previous || previous.url !== current.url };
    if (mode === "changes" && previous && previous.url === current.url) {
      const before = new Set(previous.text.split("\n")), after = new Set(current.text.split("\n"));
      const { text: _text, ...meta } = result;
      result = { ...meta, changed: previous.text !== current.text || previous.title !== current.title,
        added: [...after].filter((line) => !before.has(line)), removed: [...before].filter((line) => !after.has(line)) };
      // Sets do not show reordered or repeated lines; return the current text
      // for those changes so a compact result never hides what changed.
      if (previous.text !== current.text && !result.added.length && !result.removed.length) result.text = current.text;
    }
    r.observation = result;
    return result;
  }
  function validatePlan(plan, depth = 0, count = { n: 0 }) {
    validate(plan, steps);
    if (depth > 3) throw new Error("Conditions may nest at most three levels");
    for (const s of plan) {
      if (++count.n > 60) throw new Error("A plan may contain at most 60 steps including branches");
      const args = s.args || {};
      if (s.op === "if") {
        validate(args, obj({ condition, then: steps, otherwise: steps }, ["condition", "then"]));
        validateCondition(args.condition);
        validatePlan(args.then, depth + 1, count);
        if (args.otherwise) validatePlan(args.otherwise, depth + 1, count);
      } else if (s.op === "wait_for" || s.op === "assert") {
        validate(args, wait); validateCondition(args.condition);
      } else if (s.op === "observe") validate(args, observation);
      else {
        if (!ALLOWED.has(s.op)) throw new Error("Unsupported plan operation: " + s.op);
        const primitive = schemas.get(s.op);
        validate(args, primitive && { ...primitive, required: (primitive.required || []).filter((key) => key !== "tabId") });
        if (args.tabId !== undefined) throw new Error("Set tabId on the run, not individual steps");
        if (s.op === "tab_open" || s.op === "navigate") validUrl(args.url);
        if (s.op === "fill") validateTarget(args);
        if (s.op === "click" && !args.ref && !args.selector && !(typeof args.x === "number" && typeof args.y === "number")) throw new Error("click needs a target");
      }
    }
  }
  function summary(r) {
    return { runId: r.id, status: r.status, completedSteps: r.pc, totalSteps: r.pages?.length ?? r.plan.length, tabId: r.tabId,
      elapsedMs: (r.status === "running" ? now() : r.touched) - r.started, hostCalls: r.hostCalls, hostMs: r.hostMs,
      ...(r.error ? { error: r.error, failedStep: r.pc } : {}),
      ...(r.observation ? { observation: r.observation } : {}),
      ...(r.status === "paused" ? { next: "Call browser_resume with this runId. Completed actions will not repeat." } : {}) };
  }
  function retained(data) {
    const json = JSON.stringify(data ?? null);
    return json.length > 16000 ? { truncated: true, preview: json.slice(0, 16000) } : data;
  }
  function make(plan, args) {
    for (const [id, r] of runs) if (r.status !== "running" && now() - r.touched > 300000) runs.delete(id);
    if (runs.size >= 10) {
      const oldest = [...runs.values()].find((r) => !["running", "paused"].includes(r.status));
      if (oldest) runs.delete(oldest.id);
      else throw new Error("Too many retained runs. Cancel or finish a run first.");
    }
    const started = now();
    const r = { id: "run-" + started.toString(36) + "-" + (++serial), plan, pc: 0, status: "running", tabId: args.tabId,
      started, touched: started, deadline: started + (args.timeoutMs || 60000), hostCalls: 0, hostMs: 0,
      waits: new Map(), listeners: new Set(), log: [], cancelled: false };
    runs.set(r.id, r); return r;
  }
  async function resolveTab(r) {
    if (r.tabId != null) return;
    const data = await send(r, "tabs");
    r.tabId = data.workingTabId ?? data.activeTabId;
    if (r.tabId == null) throw new Error("No working tab. Start with tab_open or provide tabId.");
  }
  async function drive(r) {
    r.status = "running";
    const until = now() + sliceMs;
    let locked;
    try {
      // A paused plan keeps its exact tab id. It never follows the user's focus.
      if (r.plan[r.pc]?.op !== "tab_open") await resolveTab(r);
      if (r.tabId != null) {
        if (locks.has(r.tabId)) throw new Error("Another plan is using tab " + r.tabId);
        locks.add(r.tabId); locked = r.tabId;
      }
      while (r.pc < r.plan.length) {
        check(r);
        if (now() >= until) throw PAUSE;
        const s = r.plan[r.pc], args = s.args || {}, started = now();
        let result;
        if (s.op === "if") {
          result = await evalRead(r, conditionProbe, args.condition);
          r.plan.splice(r.pc + 1, 0, ...(result.matched ? args.then : args.otherwise || []));
        } else if (s.op === "wait_for") result = await waitFor(r, args, r.pc, until);
        else if (s.op === "assert") {
          result = await evalRead(r, conditionProbe, args.condition);
          if (!result.matched) throw new Error("Assertion failed at step " + r.pc);
        } else if (s.op === "observe") result = await observe(r, args);
        else {
          result = await send(r, s.op, s.op === "tab_open" ? { ...args, active: args.active ?? false } : { ...args, tabId: r.tabId });
          if (s.op === "tab_open") {
            if (!Number.isInteger(result?.tabId) || result.tabId < 1) throw new Error("tab_open returned no tab id");
            if (locked != null) locks.delete(locked);
            r.tabId = result.tabId; locks.add(r.tabId); locked = r.tabId;
          }
        }
        r.log.push({ step: r.pc, op: s.op, status: "completed", elapsedMs: now() - started, result: retained(result) });
        r.pc++;
      }
      r.status = "completed";
    } catch (error) {
      r.status = error === PAUSE ? "paused" : r.cancelled ? "cancelled" : "failed";
      if (error !== PAUSE) {
        r.error = error.message;
        r.log.push({ step: r.pc, op: r.plan[r.pc]?.op, status: r.status, error: r.error,
          actionMayHaveRun: WRITES.has(r.plan[r.pc]?.op) });
      }
    } finally { if (locked != null) locks.delete(locked); r.touched = now(); }
    return summary(r);
  }
  function cancel(runId) {
    const targets = runId ? [runs.get(runId)] : [...runs.values()];
    if (runId && !targets[0]) throw new Error("Unknown or expired runId");
    let cancelled = 0;
    for (const r of targets) if (["running", "paused"].includes(r.status)) {
      r.cancelled = true; cancelled++;
      for (const listener of r.listeners) listener();
      if (r.status === "paused") { r.status = "cancelled"; r.error = "Run cancelled"; }
    }
    return { cancelled };
  }
  async function drivePages(r) {
    r.status = "running";
    const args = r.batchArgs, results = r.pages, until = now() + sliceMs;
    async function worker() {
      while (r.nextPage < args.pages.length && !r.cancelled && now() < until && now() < r.deadline) {
        const index = r.nextPage++, page = args.pages[index];
        const child = { ...r, hostCalls: 0, hostMs: 0, detached: true, waits: new Map(), tabId: undefined, deadline: Math.min(r.deadline, now() + (args.timeoutMs || 10000)) };
        // Cancellation state is shared even while a worker is waiting.
        Object.defineProperty(child, "cancelled", { get: () => r.cancelled });
        let createdTabId;
        const result = { index, url: page.url, status: "failed" };
        try {
          // Await the open reply even on cancellation so we can close the exact
          // tab Chrome created. Never close a tab guessed from URL or focus.
          const opened = await send(child, "tab_open", { url: page.url, active: false, preserveWorkingTab: true }, true);
          if (!Number.isInteger(opened?.tabId) || opened.tabId < 1) throw new Error("tab_open returned no tab id");
          createdTabId = child.tabId = opened.tabId;
          check(child);
          await waitFor(child, { condition: { ready: true }, timeoutMs: args.timeoutMs || 10000 }, "ready", Infinity);
          for (let i = 0; i < (page.checks || []).length; i++) {
            result.checkIndex = i;
            await waitFor(child, { condition: page.checks[i], timeoutMs: args.timeoutMs || 10000 }, i, Infinity);
          }
          delete result.checkIndex;
          const observed = await observe(child, { maxChars: 500 });
          Object.assign(result, { status: "passed", title: observed.title, finalUrl: observed.url, checksPassed: (page.checks || []).length });
        } catch (error) { result.error = error.message; result.status = r.cancelled ? "cancelled" : "failed"; }
        finally {
          if (createdTabId != null) {
            try { await send(child, "tab_close", { tabId: createdTabId, preserveWorkingTab: true }, true); result.closed = true; }
            catch (error) { result.closed = false; result.cleanupError = error.message; if (result.status === "passed") result.status = "failed"; }
          }
          r.hostCalls += child.hostCalls;
          r.hostMs += child.hostMs;
          results[index] = result;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(args.concurrency || 3, args.pages.length) }, worker));
    const expired = now() >= r.deadline;
    if (r.cancelled || expired) for (let i = 0; i < results.length; i++) results[i] ||= { index: i, url: args.pages[i].url, status: "not_run" };
    r.status = r.cancelled ? "cancelled" : expired ? "failed" : r.nextPage < args.pages.length ? "paused" : results.every((p) => p.status === "passed") ? "completed" : "failed";
    if (expired) r.error = "Run deadline exceeded";
    r.log = results.filter(Boolean).map((result) => ({ step: result.index, op: "check_page", result })); r.pc = results.filter(Boolean).length; r.touched = now();
    return { ...summary(r), pages: results.filter(Boolean), passed: results.filter((p) => p?.status === "passed").length };
  }
  async function execute(name, args = {}, requestId) {
    const definition = WORKFLOW_TOOLS.find((t) => t.name === name);
    if (!definition) throw new Error("Unknown workflow tool");
    validate(args, definition.inputSchema);
    if (name === "browser_cancel") return cancel(args.runId);
    if (name === "browser_run_result" || name === "browser_resume") {
      const r = runs.get(args.runId);
      if (!r || now() - r.touched > 300000 && r.status !== "running") throw new Error("Unknown or expired runId");
      if (name === "browser_resume") {
        if (r.status !== "paused") throw new Error("Only paused runs can resume");
        r.requestId = requestId;
        return r.pages ? drivePages(r) : drive(r);
      }
      const from = args.fromStep || 0, limit = args.limit || 10;
      return { ...summary(r), steps: r.log.slice(from, from + limit), nextStep: from + limit < r.log.length ? from + limit : null };
    }
    if (name === "browser_check_pages") {
      args.pages.forEach((p) => { validUrl(p.url); (p.checks || []).forEach(validateCondition); });
      const r = make([], { timeoutMs: 120000 });
      r.requestId = requestId;
      r.batchArgs = args; r.pages = new Array(args.pages.length); r.nextPage = 0;
      return drivePages(r);
    }
    let plan;
    const observeStep = { op: "observe", args: args.observe || { mode: "changes" } };
    if (name === "browser_run") plan = args.steps;
    if (name === "browser_open_page") plan = [{ op: "tab_open", args: { url: args.url, active: args.active ?? false } },
      { op: "wait_for", args: { condition: args.waitFor || { ready: true } } }, observeStep];
    if (name === "browser_click_and_observe") {
      validateTarget(args.target);
      plan = [{ op: "click", args: args.target }, { op: "wait_for", args: { condition: args.waitFor } }, observeStep];
    }
    if (name === "browser_fill_form") {
      args.fields.forEach(validateTarget);
      plan = args.fields.map((field) => ({ op: "fill", args: field }));
      if (args.submit) {
        validateTarget(args.submit);
        if (!args.waitFor) throw new Error("Submitting a form requires waitFor");
        plan.push({ op: "click", args: args.submit });
      }
      if (args.waitFor) plan.push({ op: "wait_for", args: { condition: args.waitFor } });
      plan.push(observeStep);
    }
    if (name === "browser_wait_for" || name === "browser_assert") plan = [{ op: name.slice(8), args: { condition: args.condition, ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}) } }];
    if (name === "browser_observe") { const { tabId: _tabId, ...rest } = args; plan = [{ op: "observe", args: rest }]; }
    // Validate the entire tree before the first side effect, including branches.
    validatePlan(plan);
    const r = make(JSON.parse(JSON.stringify(plan)), args);
    r.requestId = requestId;
    return drive(r);
  }
  return { execute, cancelAll: () => cancel(),
    cancelRequest: (id) => { for (const r of runs.values()) if (r.requestId === id) cancel(r.id); },
    names: new Set(WORKFLOW_TOOLS.map((t) => t.name)) };
}
