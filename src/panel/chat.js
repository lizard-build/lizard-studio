"use strict";
// Claude Code chat view — now multi-tab. Each tab is an independent `claude`
// session (its own cwd / model / mode / transcript), keyed by an `id` the host
// uses to run one process per tab. A shared native-host port multiplexes every
// tab; incoming events are routed back to the right tab by id.
//
// Exposes window.RKChat = { mount, activate, deactivate, addContext, addImage }.

(function () {
  const HOST_NAME = "com.lizard.code";
  const RECONNECT_MS = 1200;
  const R = window.RKRender;
  const ICON = window.RKIconHTML;
  const LIZARD = window.RKLizardHTML;

  // Playful "working" verbs cycled in the running-status pill (à la Claude Code).
  const STATUS_WORDS = [
    "Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking", "Beaming", "Beboppin'",
    "Befuddling", "Billowing", "Blanching", "Bloviating", "Boogieing", "Boondoggling", "Booping",
    "Bootstrapping", "Brewing", "Burrowing", "Calculating", "Canoodling", "Caramelizing", "Cascading",
    "Catapulting", "Cerebrating", "Channeling", "Channelling", "Choreographing", "Churning", "Clauding",
    "Coalescing", "Cogitating", "Combobulating", "Composing", "Computing", "Concocting", "Considering",
    "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Crystallizing", "Cultivating",
    "Deciphering", "Deliberating", "Determining", "Dilly-dallying", "Discombobulating", "Doing",
    "Doodling", "Drizzling", "Ebbing", "Effecting", "Elucidating", "Embellishing", "Enchanting",
    "Envisioning", "Evaporating", "Fermenting", "Fiddle-faddling", "Finagling", "Flambeing",
    "Flibbertigibbeting", "Flowing", "Flummoxing", "Fluttering", "Forging", "Forming", "Frolicking",
    "Frosting", "Gallivanting", "Galloping", "Garnishing", "Generating", "Germinating", "Gitifying",
    "Grooving", "Gusting", "Harmonizing", "Hashing", "Hatching", "Herding", "Honking", "Hullaballooing",
    "Hyperspacing", "Ideating", "Imagining", "Improvising", "Incubating", "Inferring", "Infusing",
    "Ionizing", "Jitterbugging", "Julienning", "Kneading", "Leavening", "Levitating", "Lollygagging",
    "Manifesting", "Marinating", "Meandering", "Metamorphosing", "Misting", "Moonwalking", "Moseying",
    "Mulling", "Mustering", "Musing", "Nebulizing", "Nesting", "Newspapering", "Noodling", "Nucleating",
    "Orbiting", "Orchestrating", "Osmosing", "Perambulating", "Percolating", "Perusing", "Philosophising",
    "Photosynthesizing", "Pollinating", "Pondering", "Pontificating", "Pouncing", "Precipitating",
    "Prestidigitating", "Processing", "Proofing", "Propagating", "Puttering", "Puzzling", "Quantumizing",
    "Razzle-dazzling", "Razzmatazzing", "Recombobulating", "Reticulating", "Roosting", "Ruminating",
    "Sauteing", "Scampering", "Schlepping", "Scurrying", "Seasoning", "Shenaniganing", "Shimmying",
    "Simmering", "Skedaddling", "Sketching", "Slithering", "Smooshing", "Sock-hopping", "Spelunking",
    "Spinning", "Sprouting", "Stewing", "Sublimating", "Swirling", "Swooping", "Symbioting",
    "Synthesizing", "Tempering", "Thinking", "Thundering", "Tinkering", "Tomfoolering", "Topsy-turvying",
    "Transfiguring", "Transmuting", "Twisting", "Undulating", "Unfurling", "Unravelling", "Vibing",
    "Waddling", "Wandering", "Warping", "Whatchamacalliting", "Whirlpooling", "Whirring", "Whisking",
    "Wibbling", "Working", "Wrangling", "Zesting", "Zigzagging",
  ];
  function randStatusWord() {
    return STATUS_WORDS[Math.floor(Math.random() * STATUS_WORDS.length)];
  }

  // Real Claude Code picks one verb per "silent" phase (thinking before the
  // first token, waiting on a tool round-trip) and holds it — a long stretch
  // of visible streaming text is its own progress signal, so the verb never
  // needs to churn on a clock. Call this at phase boundaries only.
  function refreshStatusWord(chat) {
    if (chat.compacting) return;
    chat.statusWord = randStatusWord();
    chat.statusWordAt = Date.now();
  }

  // mm:ss once a turn runs past a minute, matching Claude Code's own timer;
  // rolls over to "1h 39m 34s" once it passes an hour.
  function formatElapsed(secs) {
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    if (m < 60) return `${m}m ${secs % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m ${secs % 60}s`;
  }
  let statusTimer = null;

  // Permission modes mirror Claude Code's Shift+Tab cycle and `--permission-mode`
  // ids: default, acceptEdits, plan, auto, bypassPermissions. Keep this list and
  // its order in sync with the CLI so the panel pill matches the terminal.
  const MODES = [
    { id: "default", label: "Ask permissions", short: "Ask", hint: "Asks for your approval before tools that aren't pre-approved.", cls: "mode-default" },
    { id: "acceptEdits", label: "Accept edits", short: "Accept", hint: "Auto-accepts file edits; still asks for risky commands.", cls: "mode-accept" },
    { id: "plan", label: "Plan mode", short: "Plan", hint: "Read-only planning — Claude won't run or edit anything.", cls: "mode-plan" },
    { id: "auto", label: "Auto mode", short: "Auto", hint: "A classifier auto-approves safe tool calls and denies risky ones. Availability depends on the model/provider.", cls: "mode-auto" },
    { id: "bypassPermissions", label: "Bypass permissions", short: "Bypass", hint: "Allows everything without asking. Use with care.", cls: "mode-bypass" },
  ];

  // Listed least- to most-capable — Haiku is fastest/smallest, then Sonnet,
  // Opus, and Fable 5 as the top tier (above Opus).
  const MODELS = [
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-fable-5", label: "Fable 5" },
  ];
  const DEFAULT_MODEL = "claude-opus-4-8";

  // Reasoning effort — mirrors the CLI's `--effort <level>` flag. "ultracode"
  // isn't a real effort level: it's xhigh reasoning plus dynamic workflow
  // orchestration (the same slot the desktop app's effort slider adds as its
  // 6th, purple entry) — see claude-host.mjs's startClaude for how it's split
  // back into `--effort xhigh --settings '{"ultracode":true}'`.
  const EFFORTS = [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra" },
    { id: "max", label: "Max" },
    { id: "ultracode", label: "Ultracode" },
  ];
  const DEFAULT_EFFORT = "medium";

  // Friendly tool labels + Phosphor icon names.
  const TOOL_META = {
    Bash: { icon: "terminal", label: "Bash" },
    Read: { icon: "file", label: "Read" },
    Edit: { icon: "edit", label: "Edit" },
    Write: { icon: "file-plus", label: "Write" },
    Glob: { icon: "asterisk", label: "Glob" },
    Grep: { icon: "search", label: "Grep" },
    Task: { icon: "robot", label: "Agent" },
    WebFetch: { icon: "globe", label: "Fetch" },
    WebSearch: { icon: "search", label: "Search" },
    TodoWrite: { icon: "todo", label: "Plan" },
    ToolSearch: { icon: "search", label: "Search tools" },
    AskUserQuestion: { icon: "chat", label: "Question" },
  };

  const DEFAULT_TITLE = "New chat";

  // Minimum native-host protocol version this panel needs (the host reports
  // its own in `ready`). Keep in sync with HOST_VERSION in host/claude-host.mjs.
  // A stale host is first asked to update itself (`selfUpdate`, host v4+);
  // the manual install.sh banner only shows when that goes unanswered.
  const EXPECTED_HOST_VERSION = 16;

  let els = {};
  let port = null;
  let connected = false;
  let hostReady = false;
  let reconnectTimer = null;
  let mounted = false;
  let home = null;
  // Host protocol version last reported in `ready` (0 until the host connects).
  // Surfaced read-only in the Settings → Connection tab.
  let hostVersion = 0;
  // Grace timer for host self-update: set when a stale host is asked to update
  // itself; if it fires the host never answered (too old) — show the manual
  // install command instead.
  let hostUpdateTimer = null;
  // Set once a stale host confirms it's about to restart itself (selfUpdate
  // `updated:true`). The disconnect that follows is expected — suppress the
  // "host not installed" onboarding flash for that one disconnect instead of
  // showing it for the ~1s it takes to reconnect.
  let expectHostRestart = false;

  // Tab model: id -> chat. `order` is the visible tab order; `history` holds
  // closed conversations you can reopen.
  const chats = new Map();
  let order = [];
  let activeId = null;
  let history = [];
  let historyFilter = "";
  let lastModel = DEFAULT_MODEL;
  let lastEffort = DEFAULT_EFFORT;
  let lastMode = "auto";
  // Last folder the user actually picked (never home — see rememberCwd). New
  // chats default to this so reopening the panel resumes where you left off.
  let lastCwd = null;

  // Slash-command autocomplete (populated from each session's init event).
  // `argCmd`/`argHint` track a just-accepted command that expects an argument,
  // so the ghost placeholder in the composer can echo what to type.
  const slash = { open: false, items: [], index: 0, argCmd: null, argHint: "" };

  // Commands that take an argument after the name. The value is the hint shown
  // both in the menu row and as a ghost placeholder once the command is picked
  // (mirroring Claude Code's own argument-hint). Presence here also changes the
  // accept behavior: selecting the command inserts "/cmd " and waits for input
  // instead of firing immediately (which would run the command bare). The
  // headless CLI's init event ships only command *names* — no hints — so this
  // list is curated to the built-ins and skills that clearly expect an arg.
  const SLASH_ARG_HINTS = {
    goal: "<condition>",
    compact: "[extra instructions]",
    batch: "<change to make>",
    loop: "<interval> <command>",
    schedule: "<when> <task>",
    "deep-research": "<research question>",
    review: "[PR number or URL]",
    "code-review": "[low|medium|high|max] [--fix]",
    debug: "<what's broken>",
    "update-config": "<setting change>",
  };
  function slashHint(cmd) {
    return SLASH_ARG_HINTS[cmd] || SLASH_ARG_HINTS[String(cmd).split(":").pop()] || "";
  }

  function newId() {
    try {
      return crypto.randomUUID();
    } catch (_) {
      return "c" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }

  // ---- persistence ----------------------------------------------------------
  function loadPrefs(done) {
    try {
      chrome.storage.local.get(["rkChatV2"], (r) => {
        const p = (r && r.rkChatV2) || {};
        if (p.lastModel) lastModel = p.lastModel;
        if (p.lastEffort) lastEffort = p.lastEffort;
        if (p.lastMode) lastMode = p.lastMode;
        if (p.lastCwd) lastCwd = p.lastCwd;
        if (Array.isArray(p.history)) history = p.history;
        if (Array.isArray(p.tabs) && p.tabs.length) {
          for (const t of p.tabs) {
            const chat = makeChat({ id: t.id, title: t.title, cwd: t.cwd, model: t.model, effort: t.effort, mode: t.mode, sessionId: t.sessionId, bashHistory: t.bashHistory });
            chats.set(chat.id, chat);
            order.push(chat.id);
          }
          activeId = chats.has(p.activeId) ? p.activeId : order[0];
        }
        done && done();
      });
    } catch (_) {
      done && done();
    }
  }
  function savePrefs() {
    try {
      const tabs = order.map((id) => {
        const c = chats.get(id);
        return { id: c.id, title: c.title, cwd: c.cwd, model: c.model, effort: c.effort, mode: c.mode, sessionId: c.sessionId, bashHistory: (c.bashHistory || []).slice(-40) };
      });
      chrome.storage.local.set({ rkChatV2: { tabs, activeId, history: history.slice(0, 40), lastModel, lastEffort, lastMode, lastCwd } });
    } catch (_) {}
  }

  // Remember a folder the user deliberately selected so new chats can default to
  // it. Home doesn't count as a "chosen project" — it's the unselected fallback,
  // so we never persist it (keeps `defaultCwd` from silently locking onto ~).
  function rememberCwd(p) {
    if (!p) return;
    if (home && p.replace(/\/$/, "") === home.replace(/\/$/, "")) return;
    lastCwd = p;
  }

  // The folder a brand-new chat should start in: last picked → active tab's
  // folder → nothing (forces an explicit choice rather than spawning in $HOME).
  function defaultCwd() {
    const active = chats.get(activeId);
    return lastCwd || (active && active.cwd) || null;
  }

  // ---- DOM helpers ----------------------------------------------------------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function shortPath(p) {
    if (!p) return "~";
    if (home && p.startsWith(home)) return "~" + p.slice(home.length);
    return p;
  }
  function basename(p) {
    if (!p) return DEFAULT_TITLE;
    const parts = p.replace(/\/$/, "").split("/");
    return parts[parts.length - 1] || p;
  }
  // Short label for the folder chip: the final folder name, "~" for home, or a
  // call-to-action when nothing's been chosen yet (a session can't start without
  // a folder, so "~" would be misleading here).
  function folderLabel(p) {
    if (!p) return "Select folder";
    if (home && p.replace(/\/$/, "") === home.replace(/\/$/, "")) return "~";
    return basename(p);
  }
  // "842", "12.4k", "128k" — token counts for the tab tooltip's context row.
  function fmtTokens(n) {
    if (n < 1000) return String(n);
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")) + "k";
  }

  function atBottom(chat) {
    const m = chat.messagesEl;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  }
  function scrollToBottom(chat) {
    chat.messagesEl.scrollTop = chat.messagesEl.scrollHeight;
  }
  // opts.raw skips the queued-bubble anchor below — the one caller that
  // wants it is renderQueuedBubble itself (a newly queued message should
  // stack after ones already waiting, not jump above them).
  function append(chat, node, opts) {
    const stick = atBottom(chat);
    // The running/summary status pill lives at the very bottom of the stream,
    // so new content is inserted *before* it to keep it last (see
    // renderTurnStatus). Bubbles waiting in the queue must stay pinned at the
    // very bottom too — below anything the still-running turn produces after
    // they were queued (more tool calls, another assistant message, a
    // permission ask) — so live content anchors above the OLDEST pending
    // queued bubble when one exists, not just above the pill.
    let anchor = null;
    if (!(opts && opts.raw) && Array.isArray(chat.queue)) {
      const pending = chat.queue.find((e) => e.el && e.el.parentNode === chat.messagesEl);
      if (pending) anchor = pending.el;
    }
    if (!anchor && chat.statusEl && chat.statusEl.parentNode === chat.messagesEl) anchor = chat.statusEl;
    if (anchor) {
      chat.messagesEl.insertBefore(node, anchor);
    } else {
      chat.messagesEl.appendChild(node);
    }
    if (stick && chat.id === activeId) scrollToBottom(chat);
  }

  // ---- chat objects ---------------------------------------------------------
  function makeChat(opts) {
    opts = opts || {};
    const messagesEl = el("div", "chat-messages");
    return {
      id: opts.id || newId(),
      title: opts.title || DEFAULT_TITLE,
      cwd: opts.cwd || null,
      model: opts.model || lastModel || DEFAULT_MODEL,
      effort: opts.effort || lastEffort || DEFAULT_EFFORT,
      mode: opts.mode || lastMode,
      sessionId: opts.sessionId || null,
      slashCommands: [],
      skills: [],
      plugins: [],
      started: false,
      turnRunning: false,
      // A model/mode/effort switch made while a turn was running — applied
      // (via restartSessionNow) once endTurn() sees the reply is done.
      restartPending: false,
      turnStatusText: "",
      // Prompts submitted while a turn is running. Each entry is
      // { text, contexts, attachments, el } — drained one at a time from
      // endTurn() once the in-flight turn finishes.
      queue: [],
      messagesEl,
      // Status pill node, appended to the end of messagesEl while a turn runs (or
      // a result summary is showing). Lives in the stream, not a pinned bar.
      statusEl: null,
      currentAssistantId: null,
      currentAssistantBody: null,
      toolCards: new Map(),
      emittedToolIds: new Set(),
      // Current run of consecutive tool cards, folded into one summary line
      // ("Ran 5 commands, read 2 files"). Closed by text blocks and turn end.
      toolGroup: null,
      // Live-streaming state (--include-partial-messages). streamBlocks maps a
      // content-block index to its in-progress DOM node; streamedMsgIds records
      // which assistant messages were rendered live so the final `assistant`
      // copy doesn't re-render them.
      streamMsgId: null,
      streamBlocks: new Map(),
      streamedMsgIds: new Set(),
      // Running-status pill metrics.
      turnStartedAt: 0,
      turnTokens: 0,
      curMsgTokens: 0,
      // Live context size — see noteCtxUsage. ctxBase is the input side of the
      // latest main-chain API call; ctxTokens adds its output streamed so far.
      ctxBase: 0,
      ctxTokens: 0,
      statusWord: "",
      statusWordAt: 0,
      // Composer "!" bash mode — a local shell escape hatch (see runBash). When
      // `bashMode` is on the composer runs its next submit as a one-off shell
      // command in `cwd` instead of sending a prompt to the model. `bashHistory`
      // persists finished runs ({ id, command, output, code, ts }) so they
      // survive a panel reload (they live only in the panel, never in the CLI
      // transcript); `bashRuns` tracks in-flight ones (execId -> render nodes).
      bashMode: false,
      bashHistory: Array.isArray(opts.bashHistory) ? opts.bashHistory : [],
      bashRuns: new Map(),
      // Finished bash-mode runs not yet seen by the model. Each real prompt
      // silently folds these (command + output) into its context and clears the
      // buffer — the model learns what you ran without a visible bubble or an
      // extra turn, mirroring Claude Code's REPL bash mode. In-memory only (a
      // panel reload drops it), so stale output from a past session never rides
      // a fresh message; the runs themselves persist via bashHistory.
      bashPending: [],
      // Page elements attached via the Selector tool, sent as context with the
      // next prompt, then cleared.
      contexts: [],
      // Images pasted/dropped into the composer, sent as image blocks with the
      // next prompt, then cleared. Each: { id, mediaType, dataUrl }.
      attachments: [],
      empty: !opts.sessionId,
      // Whether this tab's on-disk transcript has been requested/replayed yet.
      // Restored tabs (and history re-opens) carry a sessionId but no messages.
      replayed: false,
      // Git state for the cwd (filled in from the host's gitBranches reply).
      isRepo: false,
      branch: null,
      branchRequested: false, // in-flight guard for syncGitBar's self-heal request
      branches: [],
      // Working-tree diff vs HEAD (filled in from the host's gitDiff reply).
      // Refreshed on session start and after every turn ends.
      diffFiles: [],
      diffInsertions: 0,
      diffDeletions: 0,
      diffDrawerOpen: false,
      diffCollapsedFiles: new Set(), // paths collapsed in the drawer
      // Background work spawned by this session — mirrors Claude Code's "tasks
      // pane", which lists subagents and background shell commands together.
      // `agents` keys on the Task tool_use id; `bgTasks` on the launching Bash
      // tool_use id. `bgShell` maps a shell id (parsed from the launch result)
      // back to its bgTasks key so later BashOutput/KillShell calls and the
      // CLI's synthetic completion notices can resolve which task finished.
      // Each entry: { id, label, status: 'running'|'done'|'error', startedAt }.
      // Shown only once something actually spawns (see syncGitBar).
      agents: new Map(),
      bgTasks: new Map(),
      bgShell: new Map(),
      // Async/background subagents return an immediate launch ack, then finish
      // later via a task-notification. Maps that notification's task id back to
      // the agent key so completion (and its real elapsed time) lands correctly.
      agentTask: new Map(),
      // Preview servers (dev servers started via the preview MCP) — a third kind
      // of background work. `previews` keys on the preview_start tool_use id;
      // `previewServer` maps a serverId back to its key so a later preview_stop
      // can resolve which one shut down.
      previews: new Map(),
      previewServer: new Map(),
      tasksDrawerOpen: false,
      tasksFinishedCollapsed: false,
      // Drawer view: "list" (Running/Finished) or "transcript" (one subagent's
      // captured messages). transcriptAgentId names which agent is shown.
      tasksView: "list",
      transcriptAgentId: null,
      // Pending permission asks (can_use_tool): requestId -> { card, opts, … }.
      permCards: new Map(),
      // Set right before sending a bare "/usage" (or "/usage-credits" /
      // "/extra-usage") command; consumed by the next assistant text block to
      // render a progress-bar card instead of the raw CLI text.
      pendingUsageCard: false,
      // Counts real human turns rendered so far (live sends + replayed
      // history), 1-based. Stamped onto each rewindable user row so its
      // rewind button can tell the host which turn to truncate back to —
      // this has to match the host's own count of "real" user lines in the
      // on-disk transcript (see rewindSession in claude-host.mjs).
      turnIndexCounter: 0,
    };
  }

  function createChat(opts, { activate = true } = {}) {
    const chat = makeChat(opts);
    chats.set(chat.id, chat);
    order.push(chat.id);
    els.stack.appendChild(chat.messagesEl);
    renderTabs();
    if (activate) setActive(chat.id);
    savePrefs();
    return chat;
  }

  function setActive(id) {
    if (!chats.has(id)) return;
    activeId = id;
    for (const [cid, c] of chats) {
      c.messagesEl.classList.toggle("hidden", cid !== id);
    }
    renderTabs();
    syncComposer();
    const chat = chats.get(id);
    // Lazily spin up the session the first time a tab is shown.
    if (connected && hostReady && !chat.started) startChatSession(chat);
    // Re-render a restored/re-opened conversation from its on-disk transcript.
    maybeReplay(chat);
    requestAnimationFrame(() => {
      scrollToBottom(chat);
      if (els.input) els.input.focus();
    });
    savePrefs();
  }

  function closeChat(id) {
    const chat = chats.get(id);
    if (!chat) return;
    // Remember non-empty conversations so they can be reopened from history.
    if (!chat.empty || chat.sessionId) {
      history.unshift({ id: chat.id, title: chat.title, cwd: chat.cwd, model: chat.model, effort: chat.effort, mode: chat.mode, sessionId: chat.sessionId, ts: Date.now() });
      history = history.slice(0, 40);
    }
    if (chat.started) post({ type: "close", id });
    chat.messagesEl.remove();
    chats.delete(id);
    pinnedTabBySession.delete(id);
    order = order.filter((x) => x !== id);

    if (!order.length) {
      createChat({ cwd: chat.cwd });
    } else if (activeId === id) {
      setActive(order[order.length - 1]);
    } else {
      renderTabs();
    }
    savePrefs();
  }

  // ---- tab hover tooltip ------------------------------------------------
  // A single shared tooltip node, positioned under whichever tab is hovered.
  // Native `title` only shows the (often truncated) label after a long delay,
  // so this surfaces the full title + folder + branch right below the tab.
  let tabTip = null, tabTipTimer = null;
  function ensureTabTip() {
    if (tabTip) return tabTip;
    tabTip = el("div", "chat-tab-tip");
    document.body.appendChild(tabTip);
    return tabTip;
  }
  function showTabTip(tabEl, chat) {
    clearTimeout(tabTipTimer);
    tabTipTimer = setTimeout(() => {
      const tip = ensureTabTip();
      tip.innerHTML = "";
      // Each icon row is a flex box: a fixed 12px icon slot + gap + text. The
      // title has no icon slot, so it sits flush at the left edge — aligned
      // with the icons below, not with their text.
      const tipLine = (cls, iconName, text) => {
        const row = el("div", cls);
        if (iconName) {
          const ico = el("span", "chat-tab-tip-ico");
          ico.innerHTML = ICON(iconName, 12);
          row.appendChild(ico);
        }
        row.appendChild(el("span", "chat-tab-tip-text", text));
        tip.appendChild(row);
        return row;
      };
      tipLine("chat-tab-tip-title", null, chat.title);
      tipLine("chat-tab-tip-row", "folder", shortPath(chat.cwd) || "No folder selected");
      if (chat.isRepo && chat.branch) tipLine("chat-tab-tip-row", "git-branch", chat.branch);
      // Built fresh on every hover, so it always shows the latest reading.
      // Always present (0 before the first reply, and briefly after /compact
      // until the next reply reports the new size) so the user always knows
      // where to find it.
      tipLine("chat-tab-tip-row", "gauge", "Context: " + fmtTokens(chat.ctxTokens || 0) + " tokens");
      tip.classList.add("show");
      const r = tabEl.getBoundingClientRect();
      tip.style.top = r.bottom + 6 + "px";
      let left = r.left;
      const maxLeft = window.innerWidth - tip.offsetWidth - 8;
      tip.style.left = Math.max(8, Math.min(left, maxLeft)) + "px";
    }, 350);
  }
  function hideTabTip() {
    clearTimeout(tabTipTimer);
    if (tabTip) tabTip.classList.remove("show");
  }

  // ---- tab bar --------------------------------------------------------------
  function renderTabs() {
    hideTabTip();
    els.tabs.innerHTML = "";
    for (const id of order) {
      const chat = chats.get(id);
      const tab = el("button", "chat-tab" + (id === activeId ? " active" : ""));
      tab.dataset.tabId = id;
      tab.addEventListener("mouseenter", () => showTabTip(tab, chat));
      tab.addEventListener("mouseleave", hideTabTip);
      tab.appendChild(el("span", "tab-label", chat.title));
      const close = el("span", "tab-close");
      close.innerHTML = ICON("x", 12);
      close.title = "Close chat";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeChat(id);
      });
      tab.appendChild(close);
      // Custom pointer drag instead of native HTML5 DnD — the browser's drag
      // image otherwise tracks the cursor on both axes. Here the tab is only
      // ever translated on X, so vertical mouse movement has no effect at all.
      // `order` itself is reordered live, the moment the dragged tab's center
      // crosses a neighbor's — siblings slide out of the way immediately,
      // mirroring native browser tab bars, rather than only committing on drop.
      let wasDragging = false;
      tab.addEventListener("click", () => {
        if (wasDragging) { wasDragging = false; return; }
        setActive(id);
      });
      tab.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || e.target.closest(".tab-close")) return;
        hideTabTip();
        const startX = e.clientX;
        let dragging = false;

        // Snapshot every tab's layout once, up front. Live reordering below
        // simulates each new arrangement from these fixed widths instead of
        // re-measuring the DOM mid-drag — siblings only ever move visually
        // (via transform), never actually reflow, until the drag ends.
        const nodes = Array.from(els.tabs.children);
        const gap = parseFloat(getComputedStyle(els.tabs).columnGap) || 0;
        const rects = new Map(nodes.map((n) => [n.dataset.tabId, { left: n.offsetLeft, width: n.offsetWidth }]));
        const nodeById = new Map(nodes.map((n) => [n.dataset.tabId, n]));
        const anchorLeft = nodes[0].offsetLeft;
        const originalOrder = order.slice();
        const startLeft = rects.get(id).left;

        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          if (!dragging) {
            if (Math.abs(dx) < 4) return;
            dragging = true;
            tab.classList.add("dragging");
            for (const n of nodes) if (n !== tab) n.style.transition = "transform 0.15s ease";
          }
          tab.style.transform = `translateX(${dx}px)`;

          // Target slot = how many (originally-positioned) siblings the
          // dragged tab's current center has moved past.
          const draggedCenter = startLeft + rects.get(id).width / 2 + dx;
          let newIndex = 0;
          for (const oid of originalOrder) {
            if (oid === id) continue;
            const r = rects.get(oid);
            if (r.left + r.width / 2 < draggedCenter) newIndex++;
          }
          const curIndex = order.indexOf(id);
          if (newIndex !== curIndex) {
            order.splice(curIndex, 1);
            order.splice(newIndex, 0, id);
          }

          // Slide every other tab to where it'd sit if the dragged tab were
          // already parked in its new slot.
          let cursor = anchorLeft;
          for (const oid of order) {
            const r = rects.get(oid);
            if (oid !== id) {
              const node = nodeById.get(oid);
              if (node) node.style.transform = `translateX(${cursor - r.left}px)`;
            }
            cursor += r.width + gap;
          }
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          if (dragging) {
            wasDragging = true;
            renderTabs();
            savePrefs();
          }
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
      els.tabs.appendChild(tab);
    }
  }

  // ---- history dropdown -----------------------------------------------------
  function toggleHistory() {
    const open = !els.historyMenu.classList.contains("hidden");
    if (open) {
      els.historyMenu.classList.add("hidden");
      return;
    }
    historyFilter = "";
    renderHistory();
    els.historyMenu.classList.remove("hidden");
    const input = els.historyMenu.querySelector(".history-search-input");
    if (input) input.focus();
  }
  function renderHistory() {
    els.historyMenu.innerHTML = "";

    const searchWrap = el("div", "history-search");
    const searchIc = el("span", "history-search-ic");
    searchIc.innerHTML = ICON("search", 13);
    searchWrap.appendChild(searchIc);
    const input = el("input", "history-search-input");
    input.type = "text";
    input.placeholder = "Search chats";
    input.value = historyFilter;
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("input", () => {
      historyFilter = input.value;
      renderHistoryList();
    });
    searchWrap.appendChild(input);
    els.historyMenu.appendChild(searchWrap);

    const list = el("div", "history-list");
    els.historyMenu.appendChild(list);
    renderHistoryList();
  }
  function renderHistoryList() {
    const list = els.historyMenu.querySelector(".history-list");
    if (!list) return;
    list.innerHTML = "";
    const q = historyFilter.trim().toLowerCase();
    const items = q ? history.filter((h) => (h.title || DEFAULT_TITLE).toLowerCase().includes(q)) : history;
    if (!history.length) {
      list.appendChild(el("div", "history-empty", "No past chats yet."));
      return;
    }
    if (!items.length) {
      list.appendChild(el("div", "history-empty", "No matches."));
      return;
    }
    for (const item of items) {
      const row = el("div", "history-item");
      const ic = el("span", "history-ic");
      ic.innerHTML = ICON("chat", 14);
      row.appendChild(ic);
      const meta = el("div", "history-meta");
      meta.appendChild(el("div", "history-title", item.title || DEFAULT_TITLE));
      row.appendChild(meta);
      const del = el("button", "history-del");
      del.innerHTML = ICON("trash", 14);
      del.title = "Remove from history";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        history = history.filter((h) => h !== item);
        savePrefs();
        renderHistoryList();
      });
      row.appendChild(del);
      row.addEventListener("click", () => {
        els.historyMenu.classList.add("hidden");
        reopenFromHistory(item);
      });
      list.appendChild(row);
    }
  }
  function reopenFromHistory(item) {
    history = history.filter((h) => h !== item);
    createChat({ title: item.title, cwd: item.cwd, model: item.model, effort: item.effort, mode: item.mode, sessionId: item.sessionId });
    savePrefs();
  }

  // ---- message rendering (per chat) -----------------------------------------
  // Thumbnail strip + markdown body, shared by live user bubbles and queued
  // ones (renderQueuedBubble adds the queued tag/cancel on top).
  function buildBubble(text, attachments) {
    const bubble = el("div", "bubble");
    if (attachments && attachments.length) {
      const thumbs = el("div", "bubble-thumbs");
      for (const a of attachments) {
        const img = el("img", "bubble-thumb");
        img.src = a.dataUrl;
        thumbs.appendChild(img);
      }
      bubble.appendChild(thumbs);
    }
    if (text) bubble.appendChild(R.markdown(text));
    return bubble;
  }

  // opts.real: this bubble stands for an actual human turn sent to (or replayed
  // from) the claude session — its text becomes click-to-edit, and committing
  // an edit rewinds the conversation to it. Local-only bubbles (e.g. the
  // synthetic "/login" one) pass no opts and stay plain.
  function userBubble(chat, text, attachments, opts) {
    const row = el("div", "msg msg-user");
    const bubble = buildBubble(text, attachments);
    row.appendChild(bubble);
    if (opts && opts.real) {
      const turnIndex = ++chat.turnIndexCounter;
      row.dataset.turnIndex = String(turnIndex);
      wireEditableBubble(chat, bubble, turnIndex, text, attachments);
    }
    append(chat, row);
    return row;
  }

  // Click the message text to edit it in place. Committing (Enter) rewinds
  // the conversation back to just before this message — both the rendered
  // transcript and the real session — and resends the edited text as the
  // next turn. Escape/blur reverts without sending anything.
  function wireEditableBubble(chat, bubble, turnIndex, text, attachments) {
    bubble.classList.add("editable");
    bubble.addEventListener("click", (e) => {
      if (bubble.classList.contains("editing")) return;
      if (e.target.closest("a")) return; // don't hijack link clicks
      const sel = window.getSelection();
      if (sel && String(sel).length) return; // don't hijack a text selection
      beginEdit(chat, bubble, turnIndex, text, attachments);
    });
  }

  function beginEdit(chat, bubble, turnIndex, text, attachments) {
    const mdNode = bubble.querySelector(".md");
    bubble.classList.add("editing");
    const ta = el("textarea", "msg-edit");
    ta.value = text;
    if (mdNode) mdNode.replaceWith(ta);
    else bubble.appendChild(ta);
    const resize = () => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    };
    resize();
    ta.addEventListener("input", resize);
    let committed = false;
    const revert = () => {
      bubble.classList.remove("editing");
      ta.replaceWith(R.markdown(text));
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const newText = ta.value;
        if (!newText.trim() && !(attachments && attachments.length)) return revert();
        committed = true;
        bubble.classList.remove("editing");
        resendEdited(chat, turnIndex, newText, attachments);
      } else if (e.key === "Escape") {
        e.preventDefault();
        revert();
      }
    });
    ta.addEventListener("blur", () => {
      if (!committed && bubble.classList.contains("editing")) revert();
    });
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  // Truncates the rendered transcript (and all local per-turn state) back to
  // just before the given human turn, then resends the edited text as a
  // fresh turn — so the model genuinely doesn't remember what got rewound,
  // not just the UI. Only ever called from a row in the currently active
  // chat (the edit lives in its DOM), so no tab-switch handling is needed.
  //
  // Rewind + resend travel in one host message (not a "rewind" followed by a
  // separate "prompt"): the host has to kill the live process, wait for it to
  // actually exit, truncate the on-disk transcript, and only then spawn the
  // resumed one — the old session is gone the instant the rewind lands, but
  // the new one isn't ready until that respawn finishes. A second message
  // sent right after would race that gap. So the host does the whole thing —
  // truncate, resume, write the edited prompt to the new process — as one
  // atomic step (see rewindSession in claude-host.mjs).
  function resendEdited(chat, turnIndex, newText, attachments) {
    const rows = Array.from(chat.messagesEl.children);
    const startIdx = rows.findIndex((r) => r.dataset && r.dataset.turnIndex === String(turnIndex));
    if (startIdx === -1) return;
    const images = (attachments || []).map((a) => ({ mediaType: a.mediaType, data: (a.dataUrl.split(",")[1] || "") }));
    if (!post({ type: "rewind", id: chat.id, turnIndex, text: newText, images })) {
      systemNote(chat, "Host disconnected — couldn't rewind. Nothing was changed.", "warn");
      return;
    }
    for (let i = rows.length - 1; i >= startIdx; i--) rows[i].remove();
    chat.turnIndexCounter = turnIndex - 1;
    chat.currentAssistantId = null;
    chat.currentAssistantBody = null;
    // Kill any typewriter loops first — a live one would re-append the row
    // this rewind just removed (attachAssistantRow resurrects orphaned rows).
    for (const blk of chat.streamBlocks.values()) {
      if (blk.raf) { cancelAnimationFrame(blk.raf); blk.raf = 0; }
    }
    chat.streamBlocks.clear();
    chat.streamedMsgIds.clear();
    chat.streamMsgId = null;
    chat.toolGroup = null;
    chat.statusEl = null; // went with the removed rows (or is about to be stale)
    clearPermCards(chat);
    // Tool cards that lived in the truncated region are dead weight — anything
    // still tracked whose node just got removed from the DOM.
    for (const [toolUseId, entry] of chat.toolCards) {
      if (!entry.card || !entry.card.isConnected) {
        chat.toolCards.delete(toolUseId);
        chat.emittedToolIds.delete(toolUseId);
      }
    }
    userBubble(chat, newText, attachments, { real: true });
    chat.turnRunning = true;
    chat.turnStatusText = "";
    chat.compacting = false;
    chat.turnStartedAt = Date.now();
    chat.turnTokens = 0;
    chat.curMsgTokens = 0;
    refreshStatusWord(chat);
    if (chat.id === activeId) {
      setRunningUI(true);
      startStatusTicker();
    }
    renderTurnStatus(chat);
  }

  // ---- page-element context (from the Selector tool) ------------------------
  // Called from panel.js when the in-page Selector clicks an element. Attaches
  // it to the active chat as a composer chip; sent with the next prompt.
  function addContext(element) {
    if (!element) return;
    const chat = chats.get(activeId);
    if (!chat) return;
    if (!Array.isArray(chat.contexts)) chat.contexts = [];
    // Skip exact duplicates (same DOM node clicked twice). Keyed by DOM path,
    // not the tag/id/class selector alone — two different elements (e.g.
    // sibling cards with identical classes and no id) share a selector but
    // have distinct paths, so they must both be kept.
    const isDup = element.path
      ? chat.contexts.some((c) => c.path === element.path)
      : chat.contexts.some((c) => c.selector === element.selector && c.tag === element.tag);
    if (!isDup) chat.contexts.push(element);
    renderContextChips();
    if (els.input) els.input.focus();
  }

  function removeContext(idx) {
    const chat = chats.get(activeId);
    if (!chat || !Array.isArray(chat.contexts)) return;
    chat.contexts.splice(idx, 1);
    renderContextChips();
  }

  function renderContextChips() {
    if (!els.contextChips) return;
    const chat = chats.get(activeId);
    els.contextChips.replaceChildren();
    if (!chat || !chat.contexts || !chat.contexts.length) {
      els.contextChips.classList.add("hidden");
      return;
    }
    els.contextChips.classList.remove("hidden");
    chat.contexts.forEach((c, i) => {
      const chip = el("div", "ctx-chip");
      const ic = el("span", "ctx-chip-ic");
      let label;
      // Only the element-selector label is actual code (`<div>`, `<button>`)
      // — it gets the mono font. File names and page titles are plain text.
      let code = false;
      if (c.kind === "page") {
        ic.innerHTML = ICON("globe", 12);
        label = c.title ? c.title.slice(0, 44) : c.url || "Page";
        chip.title = c.url || c.title || "Current tab";
      } else if (c.kind === "file") {
        ic.innerHTML = ICON("file", 13);
        label = c.name;
        chip.title = c.name;
      } else {
        ic.innerHTML = ICON("selection", 13);
        label = `<${c.tag}>`;
        chip.title = c.selector || c.tag;
        code = true;
      }
      const x = el("button", "ctx-chip-x");
      x.innerHTML = ICON("x", 12);
      x.title = "Remove";
      x.addEventListener("click", (e) => { e.stopPropagation(); removeContext(i); });
      // Icon + × share the leading slot — the × reveals on hover (Cursor-style).
      chip.appendChild(ic);
      chip.appendChild(x);
      chip.appendChild(el("span", "ctx-chip-label" + (code ? " code" : ""), label));
      els.contextChips.appendChild(chip);
    });
  }

  // Serialize attached context into a block prepended to the prompt.
  function formatContexts(chat) {
    if (!chat.contexts || !chat.contexts.length) return "";
    const blocks = [];

    // Whole-page contexts (the current tab). Not fenced — page text may contain
    // backticks that would break a ``` block.
    for (const c of chat.contexts.filter((c) => c.kind === "page")) {
      const lines = ["[Attached browser tab — the page the user is currently viewing]"];
      lines.push(`URL: ${c.url || ""}`);
      if (c.title) lines.push(`Title: ${c.title}`);
      if (c.selection) lines.push(`\nText the user has selected on the page:\n${c.selection}`);
      lines.push(`\nVisible page content:\n${c.text || "(empty)"}${c.truncated ? "\n…[page text truncated]" : ""}`);
      blocks.push(lines.join("\n"));
    }

    // Attached files (from the "+" filesystem picker). Fenced with the file
    // name so Claude can tell them apart from pasted/selected page text.
    for (const c of chat.contexts.filter((c) => c.kind === "file")) {
      const fence = c.text.includes("```") ? "````" : "```";
      blocks.push(
        `[Attached file: ${c.name}]\n${fence}\n${c.text}${c.truncated ? "\n…[file truncated]" : ""}\n${fence}`
      );
    }

    // Picked-element contexts (from the Selector tool).
    const elems = chat.contexts.filter((c) => c.kind !== "page" && c.kind !== "file");
    if (elems.length) {
      const elBlocks = elems.map((c) => {
        const lines = [c.openTag || `<${c.tag}>`, `selector: ${c.selector}`];
        if (c.width || c.height) lines.push(`size: ${c.width}×${c.height}`);
        const s = c.styles || {};
        const bits = [];
        if (s.display) bits.push(`display:${s.display}`);
        if (s.color) bits.push(`color:${s.color}`);
        if (s.backgroundColor) bits.push(`background:${s.backgroundColor}`);
        if (s.fontFamily || s.fontSize) bits.push(`font:${[s.fontFamily, s.fontSize && s.lineHeight ? `${s.fontSize}/${s.lineHeight}` : s.fontSize, s.fontWeight].filter(Boolean).join(" ")}`);
        if (s.textAlign) bits.push(`text-align:${s.textAlign}`);
        if (s.padding && s.padding !== "0px") bits.push(`padding:${s.padding}`);
        if (s.margin && s.margin !== "0px") bits.push(`margin:${s.margin}`);
        if (s.borderRadius && s.borderRadius !== "0px") bits.push(`border-radius:${s.borderRadius}`);
        if (s.border && s.border !== "none") bits.push(`border:${s.border}`);
        if (bits.length) lines.push(`styles: ${bits.join("; ")}`);
        if (c.text) lines.push(`text: "${c.text}"`);
        return lines.join("\n");
      });
      const url = elems[0] && elems[0].url;
      const head = elems.length === 1 ? "Selected page element" : `${elems.length} selected page elements`;
      blocks.push("```\n[" + head + (url ? " · " + url : "") + "]\n" + elBlocks.join("\n\n") + "\n```");
    }

    return blocks.join("\n\n") + "\n\n";
  }

  // Invisible-char sentinels wrapping auto-injected context (tabs/page/file/element
  // blocks) inside the text actually sent to the CLI. Never rendered live — the
  // composer's own bubble is shown as-is — but they let replayTranscript() strip
  // that same context back out when it reconstructs bubbles from the on-disk
  // transcript, which otherwise stores (and would redisplay) the raw wire text.
  const CTX_MARK_START = "​​​";
  const CTX_MARK_END = "‌‌‌";
  const CTX_MARK_RE = new RegExp(`${CTX_MARK_START}[\\s\\S]*?${CTX_MARK_END}\\n*`, "g");

  // The CLI itself injects synthetic "user" turns to tell the model about
  // out-of-band events (e.g. a background task finishing/being killed) — these
  // are wire-format noise for the model, not something the human typed, and
  // the live event path already ignores them (only tool_result is handled for
  // "user" events there). Strip them here too so replaying an on-disk
  // transcript doesn't redisplay them as a fake user message.
  const SYNTHETIC_USER_TAG_RE = /<(task-notification|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>\n*/g;

  // Slash commands are persisted to the transcript as an XML wrapper:
  //   <command-name>/usage</command-name>
  //   <command-message>usage</command-message>
  //   <command-args>foo bar</command-args>
  // Live, the bubble shows the literal typed text ("/usage foo bar") — collapse
  // the wrapper back to that on replay instead of redisplaying raw tags.
  const COMMAND_TAG_RE =
    /<command-name>\s*([^<]*?)\s*<\/command-name>\s*(?:<command-message>[\s\S]*?<\/command-message>\s*)?(?:<command-args>([\s\S]*?)<\/command-args>)?/;
  function commandBubbleText(text) {
    const m = COMMAND_TAG_RE.exec(text);
    if (!m || !m[1]) return null;
    // Old transcripts have the auto-injected tabs/context block riding in the
    // args (it used to be appended after the command) — strip it like any
    // other injected context so the bubble shows only what was typed.
    const args = (m[2] || "").replace(SYNTHETIC_USER_TAG_RE, "").replace(CTX_MARK_RE, "").trim();
    return args ? m[1] + " " + args : m[1];
  }

  // ---- auto tab context -------------------------------------------------
  // Lightweight, always-on context: title + URL for every open tab, with the
  // active one flagged, so the model knows what the user has open without an
  // explicit "attach tab" action. No page content (cheap), and only resent
  // when the open tabs or the active tab actually changed since the last
  // turn, so it doesn't balloon on long conversations.
  async function buildTabsContextBlock(chat) {
    if (!(chrome.tabs && chrome.tabs.query)) return "";
    const [tabs, current] = await Promise.all([listTabs(), activeTab()]);
    const real = tabs.filter((t) => t.id != null && t.url && !/^chrome(-extension)?:\/\//i.test(t.url));
    if (!real.length) return "";
    const activeTabId = current ? current.id : null;
    const snapshot = real.map((t) => `${t.id}:${t.url}`).sort().join("|") + `|active:${activeTabId}`;
    if (chat.lastTabsSnapshot === snapshot) return "";
    chat.lastTabsSnapshot = snapshot;
    const MAX = 30;
    const shown = real.slice(0, MAX);
    const lines = ["[Open browser tabs — for context on what the user has open; not something they typed]"];
    for (const t of shown) {
      const mark = t.id === activeTabId ? "→ " : "  ";
      const title = (t.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
      lines.push(`${mark}${title || "(untitled)"} — ${t.url}`);
    }
    if (real.length > shown.length) lines.push(`  …and ${real.length - shown.length} more tabs`);
    lines.push("(→ marks the tab the user is currently viewing)");
    return lines.join("\n") + "\n\n";
  }

  // ---- image attachments (paste / drop) ------------------------------------
  // Anthropic recommends a longest edge ≤ 1568px; downscaling also keeps the
  // base64 payload well under Chrome's native-messaging limits.
  const MAX_IMG_EDGE = 1568;
  function processImageBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_IMG_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        // Keep small PNGs lossless; otherwise re-encode as JPEG to shrink.
        // Only the dataUrl is kept — the base64 payload is derived at send
        // time, instead of holding the same bytes twice per attachment.
        const type = blob.type === "image/png" && scale === 1 ? "image/png" : "image/jpeg";
        resolve({ mediaType: type, dataUrl: canvas.toDataURL(type, 0.92) });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("could not decode image"));
      };
      img.src = url;
    });
  }

  async function addAttachment(blob) {
    const chat = chats.get(activeId);
    if (!chat || !blob) return;
    try {
      const img = await processImageBlob(blob);
      chat.attachments.push({ id: newId(), ...img });
      renderAttachmentThumbs();
      if (els.input) els.input.focus();
    } catch (_) {
      systemNote(chat, "Couldn't read that image.", "warn");
    }
  }

  // Attach an image from a data URL (e.g. an annotated screenshot relayed from
  // the in-page Annotate tool). Routed through the same pipeline as a paste.
  async function addImage(dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") return;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await addAttachment(blob);
    } catch (_) {
      const chat = chats.get(activeId);
      if (chat) systemNote(chat, "Couldn't attach the screenshot.", "warn");
    }
  }

  function removeAttachment(id) {
    const chat = chats.get(activeId);
    if (!chat) return;
    chat.attachments = chat.attachments.filter((a) => a.id !== id);
    renderAttachmentThumbs();
  }

  // ---- generic file attachments (from the "+" filesystem picker) ------------
  // Images ride the existing screenshot/paste pipeline. Everything else is read
  // as text (browsers don't expose a real filesystem path from <input type=file>)
  // and carried as a removable context chip, embedded as a fenced block on send.
  const MAX_FILE_TEXT = 100_000;
  async function addFile(file) {
    if (!file) return;
    const chat = chats.get(activeId);
    if (!chat) return;
    if (file.type && file.type.startsWith("image/")) {
      await addAttachment(file);
      return;
    }
    try {
      const text = await file.text();
      if (!Array.isArray(chat.contexts)) chat.contexts = [];
      const truncated = text.length > MAX_FILE_TEXT;
      chat.contexts.push({
        kind: "file",
        id: newId(),
        name: file.name,
        text: truncated ? text.slice(0, MAX_FILE_TEXT) : text,
        truncated,
      });
      renderContextChips();
      if (els.input) els.input.focus();
    } catch (_) {
      systemNote(chat, `Couldn't read "${file.name}".`, "warn");
    }
  }

  function renderAttachmentThumbs() {
    if (!els.attachThumbs) return;
    const chat = chats.get(activeId);
    els.attachThumbs.replaceChildren();
    if (!chat || !chat.attachments.length) {
      els.attachThumbs.classList.add("hidden");
      return;
    }
    els.attachThumbs.classList.remove("hidden");
    for (const a of chat.attachments) {
      const thumb = el("div", "attach-thumb");
      const img = el("img", "attach-thumb-img");
      img.src = a.dataUrl;
      thumb.appendChild(img);
      const x = el("button", "attach-thumb-x");
      x.innerHTML = ICON("x", 11);
      x.title = "Remove image";
      x.addEventListener("click", () => removeAttachment(a.id));
      thumb.appendChild(x);
      els.attachThumbs.appendChild(thumb);
    }
  }

  function systemNote(chat, text, kind, opts) {
    opts = opts || {};
    const note = el("div", "sys-note" + (kind ? " " + kind : ""));
    if (kind === "warn") {
      const ic = el("span", "sys-ic");
      ic.innerHTML = ICON("warning", 13);
      note.appendChild(ic);
    }
    note.appendChild(el("span", null, text));
    // Transient notes (rate-limit warnings, etc.) carry a close affordance and
    // can fade themselves out — they aren't history worth keeping around like a
    // "Switched to branch…" record is.
    const remove = () => {
      if (!note.parentNode) return;
      note.classList.add("leaving");
      setTimeout(() => note.remove(), 180);
    };
    if (opts.dismissible) {
      note.classList.add("dismissible");
      const close = el("button", "sys-close");
      close.type = "button";
      close.setAttribute("aria-label", "Dismiss");
      close.innerHTML = ICON("x", 12);
      close.addEventListener("click", remove);
      note.appendChild(close);
    }
    if (opts.ttl) setTimeout(remove, opts.ttl);
    append(chat, note);
    return note;
  }

  // True when `row` is still the last *content* in the transcript. Transient UI
  // riding at the bottom — the running-status pill and pending permission asks —
  // doesn't count: both are removed (or re-anchored below new content) as the
  // stream grows, so they mustn't break assistant-message merging.
  function isTranscriptTail(chat, row) {
    let n = chat.messagesEl.lastElementChild;
    while (n && (n === chat.statusEl || (n.classList && n.classList.contains("perm-card")))) {
      n = n.previousElementSibling;
    }
    return n === row;
  }

  function ensureAssistantBody(chat, messageId) {
    if (chat.currentAssistantId === messageId && chat.currentAssistantBody) return chat.currentAssistantBody;
    // The CLI opens a new message id after every tool result, but visually a
    // turn is one reply: keep appending into the previous body while its row is
    // still the last content in the transcript (endTurn / user bubbles / notes
    // break the chain), so spacing stays even instead of jumping at message
    // boundaries. The copy footer moves back to the bottom as content grows.
    const prev = chat.currentAssistantBody;
    if (prev && prev.parentElement && isTranscriptTail(chat, prev.parentElement)) {
      chat.currentAssistantId = messageId;
      if (prev.dataset.footered) {
        const f = prev.querySelector(":scope > .msg-footer");
        if (f) f.remove();
        delete prev.dataset.footered;
      }
      return prev;
    }
    chat.currentAssistantId = messageId;
    const row = el("div", "msg msg-assistant");
    const body = el("div", "assistant-body");
    row.appendChild(body);
    // NOT attached to chat.messagesEl yet — see attachAssistantRow. A brand
    // new assistant turn often starts with nothing visible (still "thinking",
    // or waiting on a tool call's arguments to finish streaming); .chat-messages
    // is a flex column with its own gap, so an empty row would already open
    // one purely by existing, same as the inner stream-block issue this
    // mirrors. row.parentNode stays null until real content actually lands.
    chat.currentAssistantBody = body;
    return body;
  }

  // Attaches the assistant row to the transcript — called the first time
  // real (visible) content lands in its body: a tool card, non-empty text, or
  // a streamed block whose buffer just stopped being empty/whitespace-only.
  // A no-op once already attached.
  function attachAssistantRow(chat, body) {
    const row = body.parentElement;
    if (row && !row.parentNode) append(chat, row);
  }

  // ---- /usage card ------------------------------------------------------
  // `/usage` (and its siblings) come back from the CLI as a synthetic,
  // zero-turn plain-text reply shaped like:
  //   "Current session: 52% used · resets Jul 3 at 2:20am (Asia/Dubai)
  //    Current week (all models): 16% used · resets Jul 7 at 8pm (Asia/Dubai)"
  // Parsed generically (label / percent / reset clause) so it also covers
  // usage-credits, extra-usage, and any other plan-line shape the CLI adds.
  const USAGE_LINE_RE = /^(.+?):\s*(\d{1,3})%\s*used(?:\s*·\s*resets\s*(.+))?$/i;
  function parseUsageText(text) {
    if (!text) return null;
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const rows = [];
    let intro = "";
    for (const line of lines) {
      const m = USAGE_LINE_RE.exec(line);
      if (m) {
        // Drop the trailing "(Asia/Dubai)"-style zone — it's implicitly the
        // user's own timezone and just adds noise repeated on every row.
        const resets = (m[3] || "").trim().replace(/\s*\([^)]*\)\s*$/, "");
        rows.push({ label: m[1].trim(), pct: Math.max(0, Math.min(100, parseInt(m[2], 10))), resets });
      } else if (!rows.length) {
        intro = intro ? intro + " " + line : line;
      }
    }
    return rows.length ? { intro, rows } : null;
  }
  function buildUsageCard(parsed) {
    const card = el("div", "usage-card");
    card.appendChild(el("div", "usage-card-head", "Plan usage"));
    for (const row of parsed.rows) {
      const r = el("div", "usage-row");
      const top = el("div", "usage-row-top");
      top.appendChild(el("span", "usage-row-label", row.label));
      top.appendChild(el("span", "usage-row-pct", row.pct + "%"));
      r.appendChild(top);
      const bar = el("div", "usage-bar");
      const fill = el("div", "usage-bar-fill");
      fill.style.width = row.pct + "%";
      bar.appendChild(fill);
      r.appendChild(bar);
      if (row.resets) r.appendChild(el("div", "usage-row-resets", "Resets " + row.resets));
      card.appendChild(r);
    }
    if (parsed.intro) card.appendChild(el("div", "usage-card-caption", parsed.intro));
    return card;
  }

  function addText(chat, body, text) {
    attachAssistantRow(chat, body);
    closeToolGroup(chat);
    if (chat.pendingUsageCard) {
      chat.pendingUsageCard = false;
      const parsed = parseUsageText(text);
      if (parsed) {
        body.appendChild(buildUsageCard(parsed));
        if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
        return;
      }
    }
    body.appendChild(R.markdown(text));
    if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
  }

  // ---- per-message footer (copy + relative time) ----------------------------
  function relTime(ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  // Full absolute timestamp ("Jul 5, 2026, 1:40 PM GMT+4") — set as the
  // `.msg-time` span's title so hovering the relative time ("3m ago") shows
  // exactly when that was, via the browser's native tooltip.
  function fullTime(ts) {
    return new Date(ts).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }

  // Visible prose of an assistant message — markdown / live-stream text blocks,
  // minus tool cards and the footer itself. Read at click time so copy reflects
  // the finished message regardless of when the footer was attached.
  function assistantProse(body) {
    let out = "";
    for (const child of body.children) {
      if (!child.classList) continue;
      if (child.classList.contains("tool-card") || child.classList.contains("tool-group") || child.classList.contains("msg-footer")) continue;
      const t = child.innerText || child.textContent || "";
      if (t) out += (out ? "\n" : "") + t;
    }
    return out.trim();
  }

  // Shared copy-button behavior lives in render.js next to codeBlock, which
  // wires its own copy overlay — same flash-to-check feedback everywhere.
  const wireCopyButton = R.wireCopyButton;

  function messageFooter(getText, ts) {
    const footer = el("div", "msg-footer");
    const copyBtn = el("button", "msg-action");
    copyBtn.type = "button";
    copyBtn.title = "Copy";
    copyBtn.setAttribute("aria-label", "Copy message");
    copyBtn.innerHTML = ICON("copy", 13);
    wireCopyButton(copyBtn, getText, 13);
    const time = el("span", "msg-time");
    time.dataset.ts = String(ts);
    time.textContent = relTime(ts);
    time.title = fullTime(ts);
    footer.appendChild(copyBtn);
    footer.appendChild(time);
    return footer;
  }

  // Attach the copy + time footer once an assistant message is complete. No-op
  // for tool-only messages (no prose to copy), if a footer is already present,
  // or if the turn is still running — a turn can span several assistant
  // messages (interleaved with tool calls), and the footer should only land
  // once the whole reply is done, not after each intermediate message.
  function finalizeAssistant(chat, body, ts) {
    if (chat && chat.turnRunning) return;
    if (!body || body.dataset.footered) return;
    if (!assistantProse(body)) return;
    body.dataset.footered = "1";
    const footer = messageFooter(() => assistantProse(body), ts || Date.now());
    body.appendChild(footer);
    // The footer is hidden until the message is hovered — recompute the relative
    // time on mouseenter so it's never stale the moment it appears.
    const row = body.parentElement;
    const timeNode = footer.querySelector(".msg-time");
    if (row && timeNode) {
      row.addEventListener("mouseenter", () => {
        const t = Number(timeNode.dataset.ts);
        if (t) timeNode.textContent = relTime(t);
      });
    }
  }

  // Timestamps are only visible on hover and refresh on mouseenter (see
  // finalizeAssistant) — no global timer scanning every transcript needed.

  // ---- live streaming (--include-partial-messages) --------------------------
  // Deltas arrive as bursty multi-word chunks; dumping each chunk into the DOM
  // at once makes the text visibly jump. Instead the buffer is revealed word
  // by word — a typewriter whose speed grows with the backlog, so it never
  // crawls behind the wire but never leaps either. Same "smooth streaming"
  // trick ChatGPT and Claude.ai use. The pace budget is counted in characters
  // (words vary in length) but reveals snap to word boundaries: characters
  // flickering in one by one mid-word are unreadable, and a word the model
  // hasn't finished emitting is never shown half-typed.
  //
  // Rendering per frame stays cheap the same way it did before: markdown is
  // re-parsed only for the *unfinished tail* of the revealed text — completed
  // top-level blocks are parsed once and frozen into the DOM (re-rendering the
  // whole buffer every frame made a long reply cost O(length²) overall).

  // End offset of the next word after `from`: the leading whitespace run plus
  // the non-whitespace run that follows it.
  function nextWordEnd(buf, from) {
    let i = from;
    while (i < buf.length && /\s/.test(buf[i])) i++;
    while (i < buf.length && !/\s/.test(buf[i])) i++;
    return i;
  }

  function paceStreamBlock(chat, blk) {
    if (blk.raf) return;
    blk.lastT = 0;
    const step = (now) => {
      blk.raf = 0;
      const backlog = blk.buf.length - blk.shown;
      if (backlog > 0) {
        const dt = Math.min(64, now - (blk.lastT || now));
        blk.lastT = now;
        // Base speed plus a catch-up term: equilibrium lag is a fraction of a
        // second regardless of how fast the model streams.
        const rate = 90 + backlog * 3; // chars per second
        const budget = (rate * dt) / 1000;
        // `carry` banks unspent budget between frames so short words don't
        // come out faster than long ones — but it's capped, so a stall while
        // waiting for a word to complete can't dump a paragraph afterwards.
        const cap = Math.max(budget * 2, 60);
        blk.carry = Math.min(blk.carry + budget, cap);
        let advanced = false;
        for (;;) {
          const end = nextWordEnd(blk.buf, blk.shown);
          // Nothing left to reveal (shown has caught up to buf.length) —
          // without this, once done a fully-revealed block would spin here
          // forever: end===shown forever, cost 0 is never > carry, so the
          // loop never breaks.
          if (end === blk.shown) break;
          // A word is revealed only once its end is known — trailing
          // whitespace in the buffer, or the block being complete.
          if (end === blk.buf.length && !blk.done) break;
          const cost = end - blk.shown;
          if (cost > blk.carry) {
            // A saturated carry means the next token is longer than the cap
            // itself (a URL, a hash) — let it through instead of stalling.
            if (advanced || blk.carry < cap) break;
            blk.carry = 0;
          } else {
            blk.carry -= cost;
          }
          blk.shown = end;
          advanced = true;
        }
        if (advanced) renderStreamSlice(chat, blk);
      }
      if (blk.shown < blk.buf.length) blk.raf = requestAnimationFrame(step);
      else if (blk.done) finalizeStreamBlock(chat, blk);
    };
    blk.raf = requestAnimationFrame(step);
  }

  function renderStreamSlice(chat, blk) {
    // A text content block can open (content_block_start) well before it
    // has any real characters — some turns emit a block that stays
    // whitespace-only for a while, or turns out empty altogether. body is a
    // flex column with a `gap`, so merely being IN the DOM opens an empty
    // gap before any visible text exists. Stay out of the DOM until there's
    // something to show; once real content lands it never goes away again
    // (the revealed prefix only grows), so this is a one-way transition.
    if (!blk.buf.slice(0, blk.shown).trim()) return;
    if (!blk.appended) {
      blk.appended = true;
      attachAssistantRow(chat, blk.body); // same lazy-attach, one level up
      blk.body.appendChild(blk.el);
    }
    if (!blk.md) {
      // One shared .md container so CSS (first/last-child margins, the
      // streaming caret) sees the same shape a one-shot render produces.
      blk.md = el("div", "md");
      blk.live = el("div"); // classless wrapper holding the re-rendered tail
      blk.md.appendChild(blk.live);
      blk.el.replaceChildren(blk.md);
    }
    advanceStreamScan(blk, blk.shown);
    if (blk.safe > blk.stable) {
      const done = R.markdown(blk.buf.slice(blk.stable, blk.safe));
      while (done.firstChild) blk.md.insertBefore(done.firstChild, blk.live);
      blk.stable = blk.safe;
    }
    blk.live.replaceChildren(...R.markdown(blk.buf.slice(blk.stable, blk.shown)).childNodes);
    if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
  }

  // The block's wire buffer is complete — swap in the canonical one-shot
  // markdown render (drops the caret, fixes any tail-parse artifacts).
  function finalizeStreamBlock(chat, blk) {
    if (blk.raf) {
      cancelAnimationFrame(blk.raf);
      blk.raf = 0;
    }
    if (blk.buf.trim()) {
      if (!blk.appended) {
        blk.appended = true;
        attachAssistantRow(chat, blk.body);
        blk.body.appendChild(blk.el);
      }
      blk.el.replaceChildren(R.markdown(blk.buf));
      blk.el.classList.remove("streaming");
    }
    // else: ended up empty/whitespace-only — it was never put in the DOM,
    // so there's nothing to remove or finalize.
  }

  // Incremental scan for the last "safe" freeze offset in a stream block's
  // buffer: a blank-line boundary outside any ``` fence that doesn't split a
  // list continuing across blank lines (render.js keeps such a list open — a
  // frozen half would restart an <ol>'s numbering). A boundary is committed
  // only once the first complete line after the blank run is known. Every line
  // is scanned once per stream, so scanning is O(length) total.
  const STREAM_LIST_RE = /^(\s*)([-*]|\d+\.)\s+/;
  // `limit` caps the scan at the typewriter's revealed prefix — only fully
  // revealed lines may be frozen, and the rest is rescanned as it appears.
  function advanceStreamScan(blk, limit) {
    const buf = blk.buf;
    let i = blk.scan;
    for (;;) {
      const nl = buf.indexOf("\n", i);
      if (nl === -1 || nl >= limit) break;
      const line = buf.slice(i, nl);
      const t = line.trim();
      if (blk.fenceOpen) {
        if (/^```/.test(t)) { blk.fenceOpen = false; blk.prevList = false; }
      } else if (!t) {
        if (blk.cand === -1) blk.cand = i; // boundary at the blank run's start
      } else {
        const isFence = /^```/.test(t);
        const isList = !isFence && STREAM_LIST_RE.test(line);
        if (blk.cand !== -1) {
          if (!(blk.prevList && isList)) blk.safe = blk.cand;
          blk.cand = -1;
        }
        if (isFence) blk.fenceOpen = true;
        blk.prevList = isList;
      }
      i = nl + 1;
    }
    blk.scan = i;
  }

  function handleStreamEvent(chat, ev) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case "message_start": {
        const id = ev.message && ev.message.id;
        chat.streamMsgId = id || null;
        // Mark this message as streamed up front. Current Claude Code emits a
        // per-block `assistant` event the instant each content block finishes —
        // and those arrive *before* `message_stop`. If we only recorded the id at
        // message_stop, the final text/thinking blocks would re-render on top of
        // the live stream nodes (duplicate reply). Recording here keeps the live
        // render canonical and makes the later `assistant` copy a no-op.
        if (id) chat.streamedMsgIds.add(id);
        chat.streamBlocks.clear();
        chat.curMsgTokens = 0;
        ensureAssistantBody(chat, id);
        // A new message is a new "silent" phase (e.g. the round after a tool
        // result) — give it its own verb rather than carrying the old one.
        refreshStatusWord(chat);
        break;
      }
      case "content_block_start": {
        const body = ensureAssistantBody(chat, chat.streamMsgId);
        const cb = ev.content_block || {};
        if (cb.type === "text") {
          closeToolGroup(chat);
          // Not appended to `body` yet — renderStreamSlice does that lazily on
          // the first non-whitespace content, so an empty/whitespace-only
          // block never opens a flex-gap gap for content nobody can see.
          const node = el("div", "assistant-stream streaming");
          chat.streamBlocks.set(ev.index, {
            type: "text", el: node, body, buf: "", raf: 0, appended: false,
            // typewriter state (see paceStreamBlock)
            shown: 0, done: false, lastT: 0, carry: 0,
            // incremental-render state (see renderStreamSlice/advanceStreamScan)
            md: null, live: null, stable: 0, scan: 0, safe: 0, cand: -1, fenceOpen: false, prevList: false,
          });
        } else if (cb.type === "thinking") {
          // Reasoning is not shown in the transcript. No DOM is created.
          chat.streamBlocks.set(ev.index, { type: "thinking", el: null, buf: "", raf: 0 });
        }
        // tool_use blocks are left to the final `assistant` message (it carries
        // the complete tool input; the stream only has partial JSON fragments).
        if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
        break;
      }
      case "content_block_delta": {
        const blk = chat.streamBlocks.get(ev.index);
        if (!blk) break;
        const delta = ev.delta || {};
        if (delta.type === "text_delta" && blk.type === "text") blk.buf += delta.text || "";
        else break;
        paceStreamBlock(chat, blk);
        break;
      }
      case "content_block_stop": {
        const blk = chat.streamBlocks.get(ev.index);
        if (!blk) break;
        if (blk.type === "text" && blk.shown < blk.buf.length && !document.hidden && blk.buf.length - blk.shown <= 600) {
          // Let the typewriter run out the short remaining tail (its catch-up
          // term makes that take well under half a second), then finalize.
          blk.done = true;
          paceStreamBlock(chat, blk);
        } else if (blk.type === "text") {
          // Huge backlog or a hidden tab (rAF is throttled there) — cut
          // straight to the final render rather than type for seconds.
          finalizeStreamBlock(chat, blk);
        } else if (blk.raf) {
          cancelAnimationFrame(blk.raf);
          blk.raf = 0;
        }
        chat.streamBlocks.delete(ev.index);
        break;
      }
      case "message_delta": {
        const u = ev.usage || {};
        if (typeof u.output_tokens === "number") chat.curMsgTokens = u.output_tokens;
        break;
      }
      case "message_stop": {
        if (chat.streamMsgId) chat.streamedMsgIds.add(chat.streamMsgId);
        chat.turnTokens += chat.curMsgTokens;
        chat.curMsgTokens = 0;
        chat.streamMsgId = null;
        finalizeAssistant(chat, chat.currentAssistantBody, Date.now());
        break;
      }
    }
  }

  function toolCard(chat, body, block) {
    // A question to the user is conversation, not tool noise — it gets its own
    // Q&A block outside the tool-group fold (see askBlock).
    if (block.name === "AskUserQuestion" && askBlock(chat, body, block)) return;
    attachAssistantRow(chat, body);
    // Known tools get a dedicated icon; MCP tool calls (mcp__server__tool) get the
    // server mark; anything else falls back to the generic code mark — never the
    // meaningless dots-vertical.
    const meta =
      TOOL_META[block.name] ||
      (block.name && block.name.startsWith("mcp__")
        ? { icon: "server", label: block.name }
        : { icon: "code", label: block.name });
    // Collapsed by default — the head line (icon · name · summary) is enough at a
    // glance; the request detail + result stay folded until the head is clicked.
    const card = el("div", "tool-card collapsed");
    const head = el("button", "tool-head");
    head.type = "button";
    const ic = el("span", "tool-icon");
    ic.innerHTML = ICON(meta.icon, 14);
    head.appendChild(ic);
    head.appendChild(el("span", "tool-name", meta.label));
    head.appendChild(el("span", "tool-summary", toolSummary(chat, block.name, block.input)));
    // Collapse/expand toggle. It doubles as the status indicator: it pulses
    // while the tool runs, turns green on success and red on error. Clicking
    // the head folds away the request detail + result.
    const toggle = el("span", "tool-toggle running");
    toggle.innerHTML = ICON("caret-down", 14);
    head.appendChild(toggle);
    head.addEventListener("click", () => card.classList.toggle("collapsed"));
    card.appendChild(head);

    const detail = toolDetail(block.name, block.input);
    if (detail) card.appendChild(detail);

    const resultEl = el("div", "tool-result hidden");
    card.appendChild(resultEl);

    // A poll/kill/stop carries the id it targets in its input — stash it so the
    // result can resolve which background task / preview it belongs to.
    const inp = block.input || {};
    const shellId =
      (block.name === "KillShell" || block.name === "BashOutput")
        ? (inp.shell_id || inp.bash_id) || null
        : null;
    const stopServerId = isPreviewStop(block.name) ? (inp.serverId || inp.server_id) || null : null;
    appendToolCard(chat, body, card, block.name);
    chat.toolCards.set(block.id, { card, resultEl, toggle, name: block.name, shellId, stopServerId });
    noteToolStart(chat, block, card);
    if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
  }

  // ---- AskUserQuestion transcript block --------------------------------------
  // The interactive picker (showQuestionAsk) disappears once answered; this is
  // the durable record the exchange leaves in the transcript. The question
  // prints in full — header chip and all — and the user's pick fills in under
  // it when the tool result lands (fillToolResult → fillAskAnswers). Returns
  // false on malformed input so toolCard can fall back to a plain card.
  function askBlock(chat, body, block) {
    const input = block.input || {};
    const questions = (Array.isArray(input.questions) ? input.questions : [])
      .filter((q) => q && q.question)
      .slice(0, 4);
    if (!questions.length) return false;
    attachAssistantRow(chat, body);
    // Asking the user ends the tool run — the block sits between group folds.
    closeToolGroup(chat);
    const card = el("div", "ask-block");
    const head = el("div", "ask-block-head");
    const ic = el("span", "ask-block-ic");
    ic.innerHTML = ICON("chat", 14);
    head.appendChild(ic);
    head.appendChild(el("span", null, "Claude asked"));
    card.appendChild(head);
    // Answer lines attach to their question's item — keyed by question text,
    // which is also how the result encodes them.
    const slots = new Map();
    for (const q of questions) {
      const item = el("div", "ask-block-item");
      if (q.header) item.appendChild(el("div", "ask-tag", q.header));
      item.appendChild(el("div", "ask-block-q", q.question));
      card.appendChild(item);
      slots.set(q.question, item);
    }
    body.appendChild(card);
    chat.toolCards.set(block.id, { ask: true, card, slots, name: block.name });
    if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
    return true;
  }

  // The result reads `Your questions have been answered: "Q"="A", … . You can
  // now continue…` — parse the pairs back out and print each answer under its
  // question. An error result (deny / interrupt) or nothing parsable marks the
  // ask dismissed instead. Idempotent: endTurn sweeps unanswered asks through
  // here too, and a late result must not double-render.
  function fillAskAnswers(entry, text, isError) {
    if (entry.card.dataset.askDone) return;
    entry.card.dataset.askDone = "1";
    const answers = new Map();
    if (!isError && text) {
      for (const m of text.matchAll(/"([^"\n]+)"="([\s\S]*?)"(?=, "|\.\s*You can now|\s*$)/g)) {
        answers.set(m[1], m[2]);
      }
    }
    let matched = false;
    for (const [q, item] of entry.slots) {
      if (!answers.has(q)) continue;
      matched = true;
      item.appendChild(askAnswerLine(answers.get(q) || "—"));
    }
    if (!matched) {
      // Pairs parsed but question text didn't line up — still show the picks
      // rather than silently dropping them.
      if (answers.size) for (const a of answers.values()) entry.card.appendChild(askAnswerLine(a || "—"));
      else entry.card.appendChild(el("div", "ask-dismissed", "Dismissed"));
    }
  }

  function askAnswerLine(answer) {
    const line = el("div", "ask-answer");
    const ic = el("span", "ask-answer-ic");
    ic.innerHTML = ICON("check", 12);
    line.appendChild(ic);
    line.appendChild(el("span", null, answer));
    return line;
  }

  // ---- consecutive tool-call grouping (Claude Code-style) --------------------
  // Every tool call — even a lone one — folds into a collapsed summary line
  // ("Ran a command ›", "Used browser 3 times ›"); raw tool cards (command
  // text, JSON input) never show until the user clicks to expand. A run of
  // back-to-back calls shares one group; prose (or the turn ending) closes it.
  function appendToolCard(chat, body, card, name) {
    card.dataset.tool = name || "";
    let g = chat.toolGroup;
    if (!g || g.closed || g.host !== body) {
      g = makeToolGroup(chat, body);
      body.appendChild(g.el);
      chat.toolGroup = g;
    }
    g.listEl.appendChild(card);
    g.names.push(name || "");
    updateToolGroupSummary(g);
  }

  function makeToolGroup(chat, body) {
    const wrap = el("div", "tool-group collapsed running");
    const head = el("button", "tool-group-head");
    head.type = "button";
    const summaryEl = el("span", "tool-group-summary");
    head.appendChild(summaryEl);
    const toggle = el("span", "tool-group-toggle");
    toggle.innerHTML = ICON("caret-down", 14);
    head.appendChild(toggle);
    head.addEventListener("click", () => wrap.classList.toggle("collapsed"));
    wrap.appendChild(head);
    const listEl = el("div", "tool-group-list");
    wrap.appendChild(listEl);
    return { el: wrap, listEl, summaryEl, host: body, names: [], closed: false };
  }

  function updateToolGroupSummary(g) {
    // Count calls per category, keeping first-appearance order.
    const counts = new Map();
    for (const n of g.names) {
      const k = toolGroupKey(n);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const parts = [];
    for (const [k, c] of counts) parts.push(toolGroupPhrase(k, c));
    const s = parts.join(", ");
    g.summaryEl.textContent = s.charAt(0).toUpperCase() + s.slice(1);
  }

  function toolGroupKey(name) {
    switch (name) {
      case "Bash": return "cmd";
      case "Read": return "read";
      case "Edit":
      case "NotebookEdit": return "edit";
      case "Write": return "write";
      case "Glob":
      case "Grep":
      case "ToolSearch": return "search";
      case "WebSearch": return "websearch";
      case "WebFetch": return "fetch";
      case "Task":
      case "Agent": return "agent";
      case "TodoWrite": return "plan";
      case "Skill": return "skill";
    }
    const m = /^mcp__(.+?)__/.exec(name || "");
    if (m) return "mcp:" + m[1];
    return "tool";
  }

  function toolGroupPhrase(key, n) {
    const one = n === 1;
    switch (key) {
      case "cmd": return one ? "ran a command" : `ran ${n} commands`;
      case "read": return one ? "read a file" : `read ${n} files`;
      case "edit": return one ? "made an edit" : `made ${n} edits`;
      case "write": return one ? "wrote a file" : `wrote ${n} files`;
      case "search": return one ? "ran a search" : `ran ${n} searches`;
      case "websearch": return one ? "searched the web" : `searched the web ${n} times`;
      case "fetch": return one ? "fetched a page" : `fetched ${n} pages`;
      case "agent": return one ? "ran an agent" : `ran ${n} agents`;
      case "plan": return one ? "updated the plan" : `updated the plan ${n} times`;
      case "skill": return one ? "used a skill" : `used ${n} skills`;
    }
    if (key.startsWith("mcp:")) {
      const server = key.slice(4).replace(/[_-]+/g, " ");
      return one ? `used ${server}` : `used ${server} ${n} times`;
    }
    return one ? "used a tool" : `used ${n} tools`;
  }

  // End the current run: the live card folds away and only the summary line
  // stays. Called when prose starts, the turn ends, or the session resets.
  function closeToolGroup(chat) {
    const g = chat && chat.toolGroup;
    if (!g) return;
    g.closed = true;
    g.el.classList.remove("running");
    chat.toolGroup = null;
  }

  function toolSummary(chat, name, input) {
    input = input || {};
    switch (name) {
      case "Bash":
        return input.command ? input.command.split("\n")[0].slice(0, 120) : "";
      case "Read":
      case "Edit":
      case "Write":
        return shortPathFor(chat, input.file_path || "");
      case "Glob":
        return input.pattern || "";
      case "Grep":
        return input.pattern || "";
      case "WebFetch":
      case "WebSearch":
        return input.url || input.query || "";
      case "Task":
        return input.description || "";
      case "AskUserQuestion": {
        const q = Array.isArray(input.questions) && input.questions[0];
        return (q && q.question) || "";
      }
      default: {
        const s = JSON.stringify(input);
        return s.length > 100 ? s.slice(0, 100) + "…" : s;
      }
    }
  }
  function shortPathFor(chat, p) {
    if (!p) return "—";
    if (chat.cwd && p.startsWith(chat.cwd)) return "." + p.slice(chat.cwd.length);
    return shortPath(p);
  }

  function toolDetail(name, input) {
    input = input || {};
    if (name === "Bash" && input.command) {
      // Wrap in .tool-detail so it collapses with the card — without the wrapper
      // the bare .code-block isn't matched by the collapsed-hide rule and the
      // command would stay visible under the head.
      const d = el("div", "tool-detail");
      d.appendChild(bashCommandBlock(input.command));
      return d;
    }
    if (name === "Write" && input.content != null) {
      const d = el("div", "tool-detail");
      d.appendChild(R.codeBlock(input.content, langFromPath(input.file_path)));
      return d;
    }
    if (name === "Edit" && input.old_string != null) {
      const d = el("div", "tool-detail");
      d.appendChild(R.lineDiff(input.old_string, input.new_string));
      return d;
    }
    return null;
  }

  // Terminal-style rendering for a Bash tool call's command: a leading `$`
  // prompt glyph, matching how Claude Code's own CLI renders shell commands.
  // The copy button comes with codeBlock itself.
  function bashCommandBlock(command) {
    const wrap = el("div", "bash-block");
    wrap.appendChild(el("span", "bash-prompt", "$"));
    wrap.appendChild(R.codeBlock(command, "bash"));
    return wrap;
  }

  function langFromPath(p) {
    if (!p) return "";
    const ext = p.split(".").pop().toLowerCase();
    const map = { js: "js", mjs: "js", ts: "ts", tsx: "ts", jsx: "js", py: "py", rs: "rust", go: "go", json: "json", sh: "bash", css: "css", html: "html", md: "md" };
    return map[ext] || "";
  }

  function fillToolResult(chat, toolUseId, content, isError) {
    const entry = chat.toolCards.get(toolUseId);
    if (!entry) return;
    if (entry.ask) {
      fillAskAnswers(entry, normalizeResult(content), !!isError);
      chat.toolCards.delete(toolUseId);
      if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
      return;
    }
    entry.toggle.classList.remove("running");
    entry.toggle.classList.add("done");
    entry.toggle.classList.toggle("err", !!isError);
    // A failure inside a folded run tints the group chevron so it isn't lost.
    if (isError) {
      const group = entry.card.closest(".tool-group");
      if (group) group.classList.add("err");
    }
    const text = normalizeResult(content);
    if (text.trim()) {
      entry.resultEl.classList.remove("hidden");
      entry.resultEl.classList.toggle("err", !!isError);
      const lines = text.split("\n");
      // Expanding the card is the one fold the user needs — a long result
      // just gets a (non-interactive) line-count label above it, always
      // shown in full, instead of a second nested collapse to click through.
      if (lines.length > 16 || text.length > 1400) {
        entry.resultEl.appendChild(el("div", "result-label", `Output · ${lines.length} lines`));
      }
      entry.resultEl.appendChild(R.codeBlock(text, ""));
    }
    if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
    // Resolve this result against any subagent / background task it belongs to
    // before the entry is dropped (it carries the poll/kill target shell id).
    noteToolResult(chat, toolUseId, entry.name, text, isError, entry.shellId, entry.stopServerId);
    // A tool id gets exactly one result — drop the entry so a long agent
    // session doesn't pin every resolved card's DOM in the map forever.
    // (endTurn's sweep only needs the still-running entries.)
    chat.toolCards.delete(toolUseId);
  }

  function normalizeResult(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (typeof c === "string" ? c : c && c.type === "text" ? c.text : c && c.text ? c.text : ""))
        .join("\n");
    }
    if (content && content.text) return content.text;
    return content == null ? "" : String(content);
  }

  // ---- background-work tracking (Claude Code "tasks pane") -------------------
  // Subagents (the Task tool) and background shell commands (Bash with
  // run_in_background) are the two kinds of work that keep running alongside the
  // main turn — Claude Code lists both together in its "tasks pane". We register
  // each on launch and resolve it on completion so the composer's tasks chip can
  // mirror them. Nothing shows until something actually spawns.

  // While replaying a transcript this holds the current event's timestamp so
  // task start/finish are stamped in historical time, not "now" (0 = live).
  let replayStamp = 0;
  function taskNow() { return replayStamp || Date.now(); }

  // A preview MCP tool call, regardless of which server exposes it
  // (mcp__…__preview_start / mcp__…__preview_stop).
  function isPreviewStart(name) { return /(?:^|_)preview_start$/.test(name || ""); }
  function isPreviewStop(name) { return /(?:^|_)preview_stop$/.test(name || ""); }

  // A background command that's really a dev/preview server — recognised by the
  // usual invocations. Such tasks are shown as "Preview" (with their URL once we
  // can read it) instead of "Bash".
  function isDevServerCmd(cmd) {
    if (!cmd) return false;
    return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b/i.test(cmd) ||
      /\b(?:vite|next|nuxt|astro|remix|ng\s+serve|webpack(?:\s+serve|-dev-server)?|rollup\s+-\w*w|parcel|serve|http-server|live-server|browser-sync|storybook|remotion\s+(?:studio|preview)|php\s+-S|rails\s+s|flask\s+run|uvicorn|gunicorn|python3?\s+-m\s+http\.server)\b/i.test(cmd);
  }

  // Pull a localhost URL out of server output; returns a display form like
  // "localhost:5173" (scheme + trailing slash stripped).
  function parsePreviewUrl(text) {
    if (!text) return null;
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'<>]*)?/i.exec(text);
    if (m) return m[0].replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const p = /\blocalhost:(\d+)/i.exec(text);
    return p ? "localhost:" + p[1] : null;
  }

  // An explicit port in the launch command (`--port 3000`, `-p 3000`, `PORT=3000`,
  // or `http.server 8000`), so a dev server can show its address before any
  // output is read.
  function parseCmdPort(cmd) {
    const m = /(?:--port[ =]|\s-p[ =]|\bPORT[ =])(\d{2,5})\b/i.exec(cmd || "") ||
      /\bhttp\.server\s+(\d{2,5})\b/i.exec(cmd || "");
    return m ? m[1] : null;
  }

  // Well-known default port per dev server, so a directly-named tool shows its
  // URL immediately. A bare `npm run dev` is intentionally absent — the framework
  // (and its port) isn't knowable from the command, so it waits for output.
  const DEV_PORTS = [
    [/\bvite\b/i, 5173], [/\bnext\b/i, 3000], [/\bnuxt\b/i, 3000], [/\bastro\b/i, 4321],
    [/\bremix\b/i, 3000], [/\bng\s+serve\b/i, 4200], [/\bwebpack(?:\s+serve|-dev-server)?\b/i, 8080],
    [/\bparcel\b/i, 1234], [/\bstorybook\b/i, 6006], [/\bgatsby\b/i, 8000],
    [/\bhttp-server\b/i, 8080], [/\blive-server\b/i, 8080], [/\bbrowser-sync\b/i, 3000],
    [/\bremotion\s+studio\b/i, 3000], [/\brails\s+s\b/i, 3000], [/\bflask\s+run\b/i, 5000],
    [/\buvicorn\b/i, 8000], [/\bgunicorn\b/i, 8000],
  ];
  function defaultDevPort(cmd) {
    for (const [re, port] of DEV_PORTS) if (re.test(cmd || "")) return port;
    return null;
  }

  // If `text` reveals a localhost URL, attach it to a background task and mark it
  // a server (so it renders as "Preview"). Returns true if anything changed.
  function applyPreviewUrl(entry, text) {
    if (!entry || entry.url) return false;
    const u = parsePreviewUrl(text);
    if (!u) return false;
    entry.url = u;
    entry.isServer = true;
    return true;
  }

  // Register a just-launched tool if it's a subagent, a background command, or a
  // preview server. `card` is the tool card the launch rendered, so "View
  // transcript" can jump back to where the subagent's work streams inline.
  function noteToolStart(chat, block, card) {
    const name = block.name;
    const input = block.input || {};
    if (name === "Task" || name === "Agent") {
      chat.agents.set(block.id, {
        id: block.id, kind: "agent",
        label: input.description || input.subagent_type || "Agent",
        sub: input.subagent_type || "", status: "running", startedAt: taskNow(),
        completedAt: 0, inTokens: 0, outTokens: 0, toolUses: 0, lastTool: "", card,
        // Captured sidechain transcript: msgs keyed by message id (each event
        // carries the message's cumulative content, so replacing dedups it);
        // results maps a tool_use id to its output.
        msgs: new Map(), results: new Map(),
      });
      syncTasks(chat);
    } else if (name === "Bash" && input.run_in_background) {
      const server = isDevServerCmd(input.command);
      // Best-known port up front: explicit flag → well-known default → (else)
      // wait for the server to print its address.
      const port = server ? (parseCmdPort(input.command) || defaultDevPort(input.command)) : null;
      chat.bgTasks.set(block.id, {
        id: block.id, kind: "bg", shellId: null,
        label: (input.command || "").split("\n")[0].slice(0, 120) || "Background command",
        command: input.command || "", // full command — used to find the shell process to kill
        status: "running", startedAt: taskNow(), completedAt: 0, card,
        // Dev servers render as "Preview"; url comes from the command's port, a
        // known default, else the first localhost address its output prints.
        isServer: server, url: port ? "localhost:" + port : "",
      });
      syncTasks(chat);
    } else if (isPreviewStart(name)) {
      chat.previews.set(block.id, {
        id: block.id, kind: "preview",
        label: input.name || "Preview", url: "", serverId: null,
        status: "running", startedAt: taskNow(), completedAt: 0, card,
      });
      syncTasks(chat);
    }
  }

  // A subagent runs on its own sidechain: its assistant messages arrive tagged
  // with parent_tool_use_id = the Task tool's id. Roll their usage / tool calls
  // up onto the agent entry so the drawer can show live tokens, tool-use count,
  // and what it's doing right now.
  function noteAgentActivity(chat, parentId, message) {
    const agent = chat.agents.get(parentId);
    if (!agent || !message || !message.id) return;
    // Each per-block assistant event carries the message's cumulative content, so
    // storing by id (replace) keeps exactly one copy per message — no double
    // counting of tokens or steps.
    agent.msgs.set(message.id, message);
    recomputeAgentStats(agent);
    if (agent.status === "running" || transcriptOpenFor(chat, agent)) syncTasks(chat);
  }

  // Roll the stored messages up into the numbers the card shows.
  function recomputeAgentStats(agent) {
    let out = 0, inMax = 0, tools = 0, last = "";
    for (const m of agent.msgs.values()) {
      const u = m.usage || {};
      out += u.output_tokens || 0;
      inMax = Math.max(inMax, u.input_tokens || 0);
      for (const b of m.content || []) {
        if (b && b.type === "tool_use") {
          tools++;
          last = (TOOL_META[b.name] && TOOL_META[b.name].label) || b.name || last;
        }
      }
    }
    agent.outTokens = out; agent.inTokens = inMax; agent.toolUses = tools; agent.lastTool = last;
  }

  // Record a subagent's tool result so its transcript can show the output.
  function noteAgentResult(chat, parentId, content) {
    const agent = chat.agents.get(parentId);
    if (!agent || !Array.isArray(content)) return;
    for (const b of content) {
      if (b && b.type === "tool_result") {
        agent.results.set(b.tool_use_id, { text: normalizeResult(b.content), isError: !!b.is_error });
      }
    }
    if (transcriptOpenFor(chat, agent)) syncTasks(chat);
  }

  function transcriptOpenFor(chat, agent) {
    return chat.tasksView === "transcript" && chat.transcriptAgentId === agent.id;
  }

  // Pull a shell id ("bash_1") out of a launch/poll payload. The CLI reports it
  // as "…background with ID: bash_1" on launch and references it inline later.
  function parseShellId(text) {
    if (!text) return null;
    const m = /\bID:\s*([A-Za-z0-9_-]+)/.exec(text) || /\b(bash_[A-Za-z0-9]+)\b/.exec(text);
    return m ? m[1] : null;
  }

  // Flip a task to a terminal state, stamping when it finished so the drawer can
  // freeze its elapsed time. A no-op if it already finished.
  function finishTask(entry, status) {
    if (!entry || entry.status !== "running") return false;
    entry.status = status;
    entry.completedAt = taskNow();
    return true;
  }

  // Resolve a tool result against the tracked work. `shellId` is the shell a
  // BashOutput poll / KillShell targets (stashed on the tool card at launch).
  function noteToolResult(chat, toolUseId, name, text, isError, shellId, stopServerId) {
    const agent = chat.agents.get(toolUseId);
    if (agent) {
      // A background/async subagent's result is just a launch ack ("Async agent
      // launched … agentId: X … notified when it completes") — keep it running
      // and finish later on its task-notification, so the elapsed time is real
      // instead of collapsing to ~0s. A foreground agent's result IS completion.
      const asyncId = !isError && /agentId:\s*([A-Za-z0-9_-]+)/i.exec(text || "");
      if (asyncId) {
        agent.taskId = asyncId[1];
        chat.agentTask.set(asyncId[1], toolUseId);
        syncTasks(chat);
        return;
      }
      if (finishTask(agent, isError ? "error" : "done")) syncTasks(chat);
      return;
    }
    const bg = chat.bgTasks.get(toolUseId);
    if (bg) {
      // Launching a background command returns immediately with a shell id; the
      // command itself keeps running, so the task stays 'running' — completion
      // arrives later via a poll, a kill, or the CLI's synthetic notice.
      const sid = parseShellId(text);
      if (sid) { bg.shellId = sid; chat.bgShell.set(sid, toolUseId); }
      if (applyPreviewUrl(bg, text)) syncTasks(chat);
      if (isError && finishTask(bg, "error")) syncTasks(chat);
      return;
    }
    const preview = chat.previews.get(toolUseId);
    if (preview) {
      // preview_start returns the running server's id + port; the server keeps
      // running until an explicit preview_stop.
      if (isError) { finishTask(preview, "error"); syncTasks(chat); return; }
      const m = /"serverId"\s*:\s*"([^"]+)"/.exec(text);
      const port = /"port"\s*:\s*(\d+)/.exec(text);
      if (m) { preview.serverId = m[1]; chat.previewServer.set(m[1], toolUseId); }
      if (port) preview.url = "localhost:" + port[1];
      syncTasks(chat);
      return;
    }
    if ((name === "KillShell" || name === "BashOutput") && shellId) {
      const key = chat.bgShell.get(shellId);
      const entry = key && chat.bgTasks.get(key);
      if (entry) {
        // A poll can be the first place a dev server's URL shows up.
        if (name === "BashOutput" && applyPreviewUrl(entry, text)) syncTasks(chat);
        // A kill always ends it; a poll only when its output says the process is
        // no longer running.
        if (entry.status === "running" &&
            (name === "KillShell" || /\b(completed|exit code|process (?:exited|finished|completed))\b/i.test(text))) {
          if (finishTask(entry, name === "BashOutput" && isError ? "error" : "done")) syncTasks(chat);
        }
      }
    }
    if (stopServerId) {
      const key = chat.previewServer.get(stopServerId);
      if (key && finishTask(chat.previews.get(key), "done")) syncTasks(chat);
    }
  }

  // The CLI injects a synthetic user turn when a background task finishes or is
  // killed; if it names a tracked shell, stop showing that task as running.
  // The shell id ALSO appears in "still running" reminders, so a bare mention
  // must not end the task — require an actual completion/kill keyword, otherwise
  // a task gets marked done the instant it launches (elapsed collapses to ~0s).
  const BG_DONE_RE = /\b(completed|complete|exited|exit code|finished|has (?:finished|completed|exited)|killed|terminated|stopped|no longer running)\b/i;
  function scanBgNotice(chat, text) {
    if (!text || !chat.bgShell.size || !BG_DONE_RE.test(text)) return;
    let changed = false;
    for (const [sid, key] of chat.bgShell) {
      if (text.includes(sid) && finishTask(chat.bgTasks.get(key), "done")) changed = true;
    }
    if (changed) syncTasks(chat);
  }

  // A background subagent finishes via a task-notification naming its id. Match
  // it back to the deferred agent so it moves to Finished with a real duration.
  function scanAgentNotice(chat, text) {
    if (!text || !chat.agentTask.size || !BG_DONE_RE.test(text)) return;
    const failed = /\b(failed|error)\b/i.test(text);
    let changed = false;
    for (const [id, key] of chat.agentTask) {
      if (text.includes(id) && finishTask(chat.agents.get(key), failed ? "error" : "done")) changed = true;
    }
    if (changed) syncTasks(chat);
  }

  // Running-first, then by launch order — live work surfaces at the top.
  function sortedTasks(map) {
    const rank = (t) => (t.status === "running" ? 0 : t.status === "error" ? 1 : 2);
    return [...map.values()].sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt);
  }
  function taskTotals(chat) {
    let runningAgents = 0, runningBg = 0, runningPreview = 0;
    for (const a of chat.agents.values()) if (a.status === "running") runningAgents++;
    for (const b of chat.bgTasks.values()) if (b.status === "running") runningBg++;
    for (const p of chat.previews.values()) if (p.status === "running") runningPreview++;
    return {
      agents: chat.agents.size, bg: chat.bgTasks.size, previews: chat.previews.size,
      total: chat.agents.size + chat.bgTasks.size + chat.previews.size,
      runningAgents, runningBg, runningPreview,
      running: runningAgents + runningBg + runningPreview,
    };
  }

  // Light refresh on a task lifecycle tick: only the active tab has visible bar
  // state, and we skip the diff-drawer work (a task tick never changes the diff).
  function syncTasks(chat) {
    if (chat.id !== activeId) return;
    syncGitBar(chat, true);
    if (chat.tasksDrawerOpen) renderTasksDrawer(chat);
    ensurePortProbe(chat);
  }

  // ---- permission asks (Claude Code-style) ----------------------------------
  // When claude wants to run a tool the mode doesn't pre-approve, the CLI blocks
  // on a can_use_tool control request; the host relays it here as a `permission`
  // message. We render the same dialog Claude Code shows in the terminal: the
  // tool + its input, "Do you want to proceed?", and numbered options — Yes /
  // Yes-and-don't-ask-again / No-and-tell-Claude. Keyboard: 1-3, ↑↓ + Enter,
  // Esc. The answer goes back as `permissionResult`; a denial becomes the
  // tool_result error on that tool's own card (never an aggregated banner).
  const PERM_DENY_MESSAGE =
    "The user doesn't want to proceed with this tool use. The tool use was rejected " +
    "(eg. if it was a file edit, the new_string was NOT written to the file). " +
    "STOP what you are doing and wait for the user to tell you how to proceed.";

  const PERM_TITLES = {
    Bash: "Bash command",
    Edit: "Edit file",
    Write: "Create file",
    NotebookEdit: "Edit notebook",
    Read: "Read file",
    WebFetch: "Fetch",
    WebSearch: "Web search",
    Task: "Launch agent",
    KillShell: "Kill shell",
  };

  function permTitle(toolName) {
    if (PERM_TITLES[toolName]) return PERM_TITLES[toolName];
    if (toolName && toolName.startsWith("mcp__")) return "Tool use";
    return toolName || "Tool use";
  }

  // Context line under the title: the file path, URL, or `server · tool (MCP)`.
  function permSubtitle(chat, toolName, input) {
    input = input || {};
    if (toolName === "Edit" || toolName === "Write" || toolName === "Read" || toolName === "NotebookEdit") {
      return el("div", "perm-sub", shortPathFor(chat, input.file_path || input.notebook_path || ""));
    }
    if (toolName === "WebFetch" || toolName === "WebSearch") {
      return el("div", "perm-sub", input.url || input.query || "");
    }
    const m = /^mcp__(.+?)__(.+)$/.exec(toolName || "");
    if (m) return el("div", "perm-sub", `${m[1]} · ${m[2]} (MCP)`);
    return null;
  }

  function permDetail(toolName, input) {
    input = input || {};
    if (toolName === "Bash") {
      const wrap = el("div", "perm-detail");
      wrap.appendChild(R.codeBlock(input.command || "", "bash"));
      if (input.description) wrap.appendChild(el("div", "perm-desc", input.description));
      return wrap;
    }
    // Edit diffs and Write contents reuse the tool-card renderers.
    const d = toolDetail(toolName, input);
    if (d) {
      d.classList.add("perm-detail");
      return d;
    }
    // MCP browser_eval and friends: show the code being run, not JSON.
    if (typeof input.expression === "string") {
      const wrap = el("div", "perm-detail");
      wrap.appendChild(R.codeBlock(input.expression, "js"));
      return wrap;
    }
    const keys = Object.keys(input);
    if (!keys.length) return null;
    const s = JSON.stringify(input, null, 2);
    const wrap = el("div", "perm-detail");
    wrap.appendChild(R.codeBlock(s.length > 2000 ? s.slice(0, 2000) + "\n…" : s, "json"));
    return wrap;
  }

  function permOptions(toolName, suggestions) {
    const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
    const opts = [{ label: "Yes", allow: true }];
    if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
      // Mirrors Claude Code: the "always" option for edits flips the session
      // into acceptEdits rather than allow-listing one file.
      opts.push({
        label: "Yes, allow all edits during this session (shift+tab)",
        allow: true,
        updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      });
    } else {
      // Prefer the CLI's own permission_suggestions (e.g. a Bash prefix rule);
      // fall back to a session-wide allow rule for the tool.
      const updated = hasSuggestions
        ? suggestions
        : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
      const bare = toolName && toolName.startsWith("mcp__") ? toolName.split("__").slice(2).join("__") || toolName : toolName;
      const what = toolName === "Bash" ? (hasSuggestions ? "similar commands" : "Bash commands") : bare;
      opts.push({ label: `Yes, and don't ask again for ${what} this session`, allow: true, updatedPermissions: updated });
    }
    opts.push({ label: "No, and tell Claude what to do differently (esc)", allow: false });
    return opts;
  }

  function paintPerm(entry) {
    entry.rows.forEach((row, i) => row.classList.toggle("selected", i === entry.selected));
  }

  function showPermission(chat, msg) {
    const requestId = msg.requestId;
    if (!requestId || chat.permCards.has(requestId)) return;
    const toolName = msg.toolName || "";
    const input = msg.input || {};

    // AskUserQuestion isn't a permission — the dialog IS the tool. Render the
    // question with its options instead of "Do you want to proceed?".
    if (toolName === "AskUserQuestion" && Array.isArray(input.questions) && input.questions.some((q) => q && q.question)) {
      showQuestionAsk(chat, msg);
      return;
    }

    const card = el("div", "perm-card");
    card.tabIndex = 0;

    const meta = TOOL_META[toolName] || (toolName.startsWith("mcp__") ? { icon: "server" } : { icon: "code" });
    const title = el("div", "perm-title");
    const ic = el("span", "perm-title-ic");
    ic.innerHTML = ICON(meta.icon || "code", 14);
    title.appendChild(ic);
    title.appendChild(el("span", null, permTitle(toolName)));
    card.appendChild(title);

    const sub = permSubtitle(chat, toolName, input) || (msg.description ? el("div", "perm-sub", msg.description) : null);
    if (sub) card.appendChild(sub);
    const detail = permDetail(toolName, input);
    if (detail) card.appendChild(detail);

    card.appendChild(el("div", "perm-question", "Do you want to proceed?"));

    const opts = permOptions(toolName, msg.suggestions);
    const entry = { card, opts, selected: 0, rows: [] };
    const list = el("div", "perm-opts");
    opts.forEach((opt, i) => {
      const row = el("button", "perm-opt");
      row.type = "button";
      row.appendChild(el("span", "perm-caret", "❯"));
      row.appendChild(el("span", "perm-num", i + 1 + "."));
      row.appendChild(el("span", "perm-opt-label", opt.label));
      row.addEventListener("mouseenter", () => {
        entry.selected = i;
        paintPerm(entry);
      });
      row.addEventListener("click", () => answerPermission(chat, requestId, opt));
      list.appendChild(row);
      entry.rows.push(row);
    });
    card.appendChild(list);

    card.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : opts.length - 1;
        entry.selected = (entry.selected + d) % opts.length;
        paintPerm(entry);
      } else if (e.key === "Enter") {
        e.preventDefault();
        answerPermission(chat, requestId, opts[entry.selected]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        answerPermission(chat, requestId, opts[opts.length - 1]);
      } else if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (opts[i]) {
          e.preventDefault();
          answerPermission(chat, requestId, opts[i]);
        }
      }
    });

    chat.permCards.set(requestId, entry);
    paintPerm(entry);
    append(chat, card);
    renderTurnStatus(chat);
    if (chat.id === activeId) {
      scrollToBottom(chat);
      // Take focus like Claude Code's prompt does — but never steal a draft.
      if (!els.input || !els.input.value.trim()) card.focus();
    }
  }

  function answerPermission(chat, requestId, opt) {
    const entry = chat.permCards.get(requestId);
    if (!entry) return;
    chat.permCards.delete(requestId);
    entry.card.remove();
    renderTurnStatus(chat);
    const out = { type: "permissionResult", id: chat.id, requestId, behavior: opt.allow ? "allow" : "deny" };
    if (opt.allow && opt.updatedPermissions) out.updatedPermissions = opt.updatedPermissions;
    if (!opt.allow) {
      out.message = PERM_DENY_MESSAGE;
      // Matches Claude Code: "No" also stops the turn so the user can redirect.
      out.interrupt = true;
    }
    post(out);
    const next = chat.permCards.values().next().value;
    if (next && chat.id === activeId) next.card.focus();
    else if (!opt.allow && els.input) els.input.focus();
  }

  // ---- AskUserQuestion ------------------------------------------------------
  // The CLI routes AskUserQuestion through the same can_use_tool channel, but
  // the expected answer is the user's choice, not a yes/no: allow with
  // updatedInput.answers = { "<question text>": "<chosen label>" } — the shape
  // Claude Code's own picker returns (multi-select labels joined with ", ",
  // "Other" free text passed through verbatim). Questions (up to 4) are shown
  // one at a time; Esc dismisses the whole ask like the "No" option.
  function showQuestionAsk(chat, msg) {
    const requestId = msg.requestId;
    const questions = msg.input.questions.filter((q) => q && q.question).slice(0, 4);
    const answers = {};
    let qi = 0;

    const card = el("div", "perm-card ask-card");
    card.tabIndex = 0;
    const entry = { card, selected: 0, rows: [] };

    const title = el("div", "perm-title");
    const ic = el("span", "perm-title-ic");
    ic.innerHTML = ICON("chat", 14);
    title.appendChild(ic);
    title.appendChild(el("span", null, "Claude is asking"));
    const step = el("span", "ask-step");
    title.appendChild(step);
    card.appendChild(title);

    const body = el("div", "ask-body");
    card.appendChild(body);
    const hint = el("div", "ask-hint");
    card.appendChild(hint);

    function finish(out) {
      chat.permCards.delete(requestId);
      card.remove();
      renderTurnStatus(chat);
      post(out);
      const next = chat.permCards.values().next().value;
      if (next && chat.id === activeId) next.card.focus();
      else if (els.input) els.input.focus();
    }

    function dismiss() {
      finish({ type: "permissionResult", id: chat.id, requestId, behavior: "deny", message: PERM_DENY_MESSAGE, interrupt: true });
    }

    function record(q, value) {
      answers[q.question] = value;
      if (qi + 1 < questions.length) {
        qi++;
        renderQuestion();
        card.focus();
      } else {
        // The host merges updatedInput over the original input it stashed, so
        // only the answers travel — never a truncated copy of the questions.
        finish({ type: "permissionResult", id: chat.id, requestId, behavior: "allow", updatedInput: { answers } });
      }
    }

    function renderQuestion() {
      const q = questions[qi];
      const multi = !!q.multiSelect;
      const options = Array.isArray(q.options) ? q.options.filter((o) => o && o.label) : [];
      const chosen = new Set();
      body.textContent = "";
      entry.rows = [];
      entry.selected = 0;
      step.textContent = questions.length > 1 ? `${qi + 1} of ${questions.length}` : "";
      if (q.header) body.appendChild(el("div", "ask-tag", q.header));
      body.appendChild(el("div", "ask-question", q.question));

      const list = el("div", "perm-opts");
      const rows = [];

      const otherWrap = el("div", "ask-other hidden");
      const otherInput = el("input", "ask-other-input");
      otherInput.type = "text";
      otherInput.placeholder = multi ? "Add your own answer…" : "Type your answer…";
      otherWrap.appendChild(otherInput);

      function confirmMulti() {
        const picked = options.filter((_, i) => chosen.has(i)).map((o) => o.label);
        const extra = otherInput.value.trim();
        if (extra) picked.push(extra);
        if (picked.length) record(q, picked.join(", "));
      }

      function activate(i) {
        if (i < options.length) {
          if (multi) {
            if (chosen.has(i)) chosen.delete(i);
            else chosen.add(i);
            rows[i].classList.toggle("checked", chosen.has(i));
          } else {
            record(q, options[i].label);
          }
        } else {
          otherWrap.classList.remove("hidden");
          otherInput.focus();
        }
      }
      entry.activate = activate;
      entry.confirm = multi ? confirmMulti : null;

      options.forEach((opt, i) => {
        const row = el("button", "perm-opt ask-opt");
        row.type = "button";
        row.appendChild(el("span", "perm-caret", "❯"));
        row.appendChild(el("span", "perm-num", i + 1 + "."));
        const txt = el("span", "perm-opt-label");
        txt.appendChild(el("span", "ask-opt-title", opt.label));
        if (opt.description) txt.appendChild(el("span", "ask-opt-desc", opt.description));
        row.appendChild(txt);
        if (multi) {
          const check = el("span", "ask-check");
          check.innerHTML = ICON("check", 12);
          row.appendChild(check);
        }
        row.addEventListener("mouseenter", () => {
          entry.selected = i;
          paintPerm(entry);
        });
        row.addEventListener("click", () => activate(i));
        list.appendChild(row);
        rows.push(row);
        entry.rows.push(row);
      });

      // Trailing free-text row — AskUserQuestion always offers "Other".
      const otherRow = el("button", "perm-opt ask-opt");
      otherRow.type = "button";
      otherRow.appendChild(el("span", "perm-caret", "❯"));
      otherRow.appendChild(el("span", "perm-num", options.length + 1 + "."));
      otherRow.appendChild(el("span", "perm-opt-label", "Other…"));
      otherRow.addEventListener("mouseenter", () => {
        entry.selected = options.length;
        paintPerm(entry);
      });
      otherRow.addEventListener("click", () => activate(options.length));
      list.appendChild(otherRow);
      entry.rows.push(otherRow);

      body.appendChild(list);
      body.appendChild(otherWrap);

      otherInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          if (multi) confirmMulti();
          else {
            const v = otherInput.value.trim();
            if (v) record(q, v);
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          otherWrap.classList.add("hidden");
          otherInput.value = "";
          card.focus();
        }
      });

      entry.hasChosen = () => chosen.size > 0 || !!otherInput.value.trim();
      hint.textContent = multi
        ? "click or 1-9 toggles · enter confirms · esc dismisses"
        : "1-9 / ↑↓ + enter selects · esc dismisses";
      paintPerm(entry);
    }

    card.addEventListener("keydown", (e) => {
      const n = entry.rows.length;
      if (!n) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        entry.selected = (entry.selected + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        paintPerm(entry);
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Multi-select: Enter confirms once something is picked; before that
        // (or on the "Other" row) it acts on the highlighted row.
        if (entry.confirm && entry.selected < n - 1 && entry.hasChosen()) entry.confirm();
        else entry.activate(entry.selected);
      } else if (e.key === " " && entry.confirm) {
        e.preventDefault();
        if (entry.selected < n - 1) entry.activate(entry.selected);
      } else if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      } else if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < n) {
          e.preventDefault();
          entry.activate(i);
        }
      }
    });

    chat.permCards.set(requestId, entry);
    renderQuestion();
    append(chat, card);
    renderTurnStatus(chat);
    if (chat.id === activeId) {
      scrollToBottom(chat);
      if (!els.input || !els.input.value.trim()) card.focus();
    }
  }

  function removePermCard(chat, requestId) {
    const entry = chat.permCards.get(requestId);
    if (!entry) return;
    chat.permCards.delete(requestId);
    entry.card.remove();
    renderTurnStatus(chat);
  }

  // Drop every pending ask (turn ended, session restarted, or process exited —
  // the control requests they answer no longer exist).
  function clearPermCards(chat) {
    if (!chat || !chat.permCards) return;
    for (const entry of chat.permCards.values()) entry.card.remove();
    chat.permCards.clear();
  }

  // ---- context-size tracking -------------------------------------------------
  // chat.ctxTokens tracks what the model currently holds in context: the input
  // side (prompt + cache reads/writes) billed by the latest main-chain API call,
  // plus the output it has streamed since. Refreshed from message_start (input
  // side), message_delta (output grows), the final `assistant` event, and
  // replayed transcripts (last assistant message wins) — so it's current
  // whenever the tab tooltip reads it. Compaction invalidates it: the compact
  // call itself bills the whole pre-compact context, so updates are skipped
  // while compacting and the value resets to unknown until the first
  // post-compact reply (see endTurn).
  function noteCtxUsage(chat, usage) {
    if (!usage || chat.compacting) return;
    const base = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    // Synthetic messages (local slash-command answers, API-error stubs) carry
    // no real input usage — never let them zero out or corrupt the reading.
    if (base <= 0) return;
    chat.ctxBase = base;
    chat.ctxTokens = base + (usage.output_tokens || 0);
  }
  function trackCtxStream(chat, ev) {
    if (!ev) return;
    if (ev.type === "message_start") {
      noteCtxUsage(chat, ev.message && ev.message.usage);
    } else if (ev.type === "message_delta" && chat.ctxBase && !chat.compacting) {
      const u = ev.usage || {};
      if (typeof u.output_tokens === "number") chat.ctxTokens = chat.ctxBase + u.output_tokens;
    }
  }

  // ---- event handling (routed per chat) -------------------------------------
  function onClaudeEvent(chat, d) {
    if (!d || !d.type) return;
    switch (d.type) {
      case "system":
        if (d.subtype === "init") {
          chat.started = true;
          // This session is now live in the panel — its DOM is the source of
          // truth, so never auto-replay the on-disk transcript over it. (For a
          // restored tab, maybeReplay already set this before init arrived.)
          chat.replayed = true;
          if (d.cwd) { chat.cwd = d.cwd; rememberCwd(d.cwd); }
          if (d.session_id) chat.sessionId = d.session_id;
          // `/login` is handled by the panel (the headless CLI doesn't list it),
          // so make sure it's offered in the autocomplete menu.
          if (Array.isArray(d.slash_commands)) {
            chat.slashCommands = d.slash_commands.includes("login") ? d.slash_commands : ["login", ...d.slash_commands];
          }
          if (Array.isArray(d.skills)) chat.skills = d.skills;
          if (Array.isArray(d.plugins)) chat.plugins = d.plugins.map((p) => ({ name: p.name, source: p.source }));
          if (d.model) reflectModel(chat, d.model);
          if (d.permissionMode) chat.mode = d.permissionMode;
          if (chat.id === activeId) syncComposer();
          requestBranches(chat);
          requestGitDiff(chat);
          savePrefs();
        } else if (d.subtype === "status" && d.status === "compacting") {
          // /compact runs a real summarization call with no assistant text or
          // tool card of its own — pin the spinner word so a long compact
          // doesn't just read as a random-word stall (see tickStatus).
          chat.compacting = true;
          chat.statusWord = "Compacting";
          chat.statusWordAt = Date.now();
        }
        break;
      // Incremental tokens from --include-partial-messages: render assistant
      // text and thinking live, block by block.
      case "stream_event":
        // A subagent (sidechain) runs in its own context and must NOT stream into
        // the main transcript — it's surfaced in the tasks drawer instead.
        if (d.parent_tool_use_id) break;
        trackCtxStream(chat, d.event);
        handleStreamEvent(chat, d.event);
        break;
      case "assistant": {
        // Subagent turn — track its usage / tool calls for the drawer, but don't
        // render its messages into the shared chat.
        if (d.parent_tool_use_id) { noteAgentActivity(chat, d.parent_tool_use_id, d.message); break; }
        noteCtxUsage(chat, d.message && d.message.usage);
        const msgId = d.message && d.message.id;
        const body = ensureAssistantBody(chat, msgId);
        const streamed = msgId && chat.streamedMsgIds.has(msgId);
        const content = (d.message && d.message.content) || [];
        for (const block of content) {
          if (block.type === "tool_use") {
            if (chat.emittedToolIds.has(block.id)) continue;
            chat.emittedToolIds.add(block.id);
            toolCard(chat, body, block);
          } else if (!streamed) {
            // No live stream for this message (older claude / flag off) — render
            // the finished block directly. When it was streamed, the live nodes
            // already are the canonical render, so we skip to avoid duplicates.
            // (thinking blocks are intentionally not rendered.)
            if (block.type === "text") addText(chat, body, block.text);
          }
        }
        if (!streamed) finalizeAssistant(chat, body, Date.now());
        break;
      }
      case "user": {
        // A subagent's own tool results belong to its sidechain — keep them out
        // of the shared chat, but capture them for its transcript view.
        if (d.parent_tool_use_id) {
          noteAgentResult(chat, d.parent_tool_use_id, d.message && d.message.content);
          break;
        }
        // /compact (and other synthetic turns) emit a `user` event whose
        // content is a plain string, not a block array — iterating it with
        // for..of would walk individual characters instead of blocks.
        const content = (d.message && d.message.content) || [];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              fillToolResult(chat, block.tool_use_id, block.content, block.is_error);
            }
          }
        } else if (typeof content === "string") {
          // A background task / async subagent finishing arrives as a synthetic
          // user turn naming its shell / task id — mark that work done.
          scanBgNotice(chat, content);
          scanAgentNotice(chat, content);
          if (/<local-command-std(out|err)>/.test(content)) {
            // Local-command output that arrives as a plain-string user event —
            // e.g. /compact's "Compacted", which is the only visible completion
            // signal the command has. (/usage's card is drawn from its synthetic
            // assistant reply instead — skip while that's pending so a stdout
            // copy of the same text can't double-render it.)
            if (!chat.pendingUsageCard) renderLocalCommandOutput(chat, content, Date.now());
          }
        }
        break;
      }
      case "result":
        endTurn(chat, d);
        break;
      case "rate_limit_event":
        if (d.rate_limit_info && d.rate_limit_info.status !== "allowed") {
          const status = d.rate_limit_info.status;
          // Soft "allowed_warning" still lets requests through — show it plainly
          // and let it fade. Only a hard rejection earns the amber warn styling.
          const soft = status === "allowed_warning";
          const label = soft
            ? "Approaching your usage limit"
            : status === "rejected"
            ? "Usage limit reached — requests are paused"
            // Humanize any other enum the SDK might send (e.g. "queued").
            : status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
          systemNote(chat, label, soft ? null : "warn", {
            dismissible: true,
            ttl: soft ? 8000 : 0,
          });
        }
        break;
    }
  }

  function endTurn(chat, result) {
    chat.turnRunning = false;
    // A compacted conversation just shrank to a summary; the real size is
    // unknown until the first post-compact reply reports fresh usage.
    if (chat.compacting) { chat.ctxBase = 0; chat.ctxTokens = 0; }
    chat.compacting = false;
    closeToolGroup(chat);
    finalizeAssistant(chat, chat.currentAssistantBody, Date.now());
    chat.currentAssistantId = null;
    chat.currentAssistantBody = null;
    // Finalize any dangling live blocks (e.g. an interrupted turn) — renders
    // whatever the typewriter hadn't revealed yet, then drops the caret.
    for (const blk of chat.streamBlocks.values()) {
      if (blk.type === "text") finalizeStreamBlock(chat, blk);
      else if (blk.raf) { cancelAnimationFrame(blk.raf); blk.raf = 0; }
    }
    chat.streamBlocks.clear();
    chat.streamMsgId = null;
    // Any ask still open is moot once the turn is over. Denials are NOT
    // summarized into a banner here — each rejected tool call already carries
    // its own inline error on its card (the synthesized tool_result), which is
    // how Claude Code presents them.
    clearPermCards(chat);
    // Tool calls that never got a result (denied-with-interrupt, or the turn
    // was cancelled mid-run) would pulse forever — close them out as errored.
    for (const entry of chat.toolCards.values()) {
      // An ask the turn ended without answering (Esc, interrupt) is dismissed —
      // it has no toggle to close out.
      if (entry.ask) {
        fillAskAnswers(entry, "", true);
        continue;
      }
      if (entry.toggle.classList.contains("running")) {
        entry.toggle.classList.remove("running");
        entry.toggle.classList.add("done", "err");
        const group = entry.card.closest(".tool-group");
        if (group) group.classList.add("err");
      }
    }
    if (result) chat.turnStatusText = "";
    if (chat.id === activeId) {
      setRunningUI(chat.turnRunning);
      renderTurnStatus(chat);
    }
    // A model/mode/effort switch made mid-turn was deferred so it wouldn't
    // hard-kill the reply that was still streaming — apply it now that the
    // turn is actually done, before anything queued goes out under it.
    if (chat.restartPending) restartSessionNow(chat);
    // The turn may have edited files — refresh the uncommitted-changes badge.
    // It may also have switched or created a branch, so re-ask for that too:
    // the git bar always names the current branch on its left.
    requestGitDiff(chat);
    requestBranches(chat);
    // Send the next queued prompt, if any — keeps working even if the user
    // has since switched to a different tab.
    dispatchNextQueued(chat);
  }

  // ---- running-status pill --------------------------------------------------
  // While a turn runs, show a spinning Lizard mark, a cycling verb, and live
  // metrics (elapsed · output tokens). When idle, fall back to
  // the final summary (cost · duration · steps) from the result event. The pill
  // lives at the bottom of the message stream (not a pinned bar), so it scrolls
  // with the conversation and sits just under the latest text.
  function ensureStatusEl(chat) {
    if (!chat.statusEl) chat.statusEl = el("div", "turn-status");
    // Keep it as the last child of the stream.
    if (chat.messagesEl.lastChild !== chat.statusEl) chat.messagesEl.appendChild(chat.statusEl);
    return chat.statusEl;
  }

  function renderTurnStatus(chat) {
    if (!chat) return;
    const summary = chat.turnStatusText || "";
    // Nothing to show — drop the node so it leaves no empty gap in the stream.
    // Same while a permission/question dialog is pending: the dialog is the
    // live UI, and a ticking timer under it reads as noise.
    if ((!chat.turnRunning && !summary) || chat.permCards.size > 0) {
      if (chat.statusEl && chat.statusEl.parentNode) chat.statusEl.remove();
      return;
    }
    const node = ensureStatusEl(chat);
    if (chat.turnRunning) {
      const secs = chat.turnStartedAt ? Math.max(0, Math.round((Date.now() - chat.turnStartedAt) / 1000)) : 0;
      const tokens = chat.turnTokens + chat.curMsgTokens;
      const meta = [formatElapsed(secs)];
      if (tokens > 0) meta.push(`↓ ${tokens.toLocaleString()} tokens`);
      node.classList.add("running");
      // Build the spark once and only update the text parts on later ticks —
      // rewriting innerHTML every tick would recreate the lizard element and
      // restart its CSS pulse from 0%, making it look jittery and too fast.
      let word = node.querySelector(".ts-word");
      let metaEl = node.querySelector(".ts-meta");
      if (!word || !metaEl) {
        node.innerHTML =
          `<span class="ts-spark">${LIZARD ? LIZARD(15) : ""}</span>` +
          `<span class="ts-word"></span>` +
          `<span class="ts-meta"></span>`;
        word = node.querySelector(".ts-word");
        metaEl = node.querySelector(".ts-meta");
      }
      word.textContent = `${chat.statusWord || "Working"}…`;
      metaEl.textContent = `(${meta.join(" · ")})`;
    } else {
      node.classList.remove("running");
      node.textContent = summary;
    }
    if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
  }

  function tickStatus() {
    const chat = chats.get(activeId);
    // Only a safety net for the word itself (e.g. state restored mid-turn) —
    // real phase changes are what pick a new one, see refreshStatusWord.
    if (chat && chat.turnRunning && !chat.compacting && !chat.statusWord) refreshStatusWord(chat);
    if (chat) renderTurnStatus(chat);
    let anyRunning = false;
    for (const c of chats.values()) if (c.turnRunning) { anyRunning = true; break; }
    if (!anyRunning) stopStatusTicker();
  }
  function startStatusTicker() {
    if (statusTimer) return;
    statusTimer = setInterval(tickStatus, 250);
  }
  function stopStatusTicker() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  }

  // ---- host-outdated banner ---------------------------------------------
  // "updating": a stale host was asked to refresh itself — just say so while
  // it restarts. "manual": the self-update went unanswered or failed (host
  // too old, offline) — show the install command. "hidden": version is fine.
  function setHostBanner(state) {
    if (!els.hostBanner) return;
    els.hostBanner.classList.toggle("hidden", state === "hidden");
    els.hostBanner.classList.toggle("updating", state === "updating");
    if (els.hostBannerText) {
      els.hostBannerText.textContent =
        state === "updating"
          ? "Host is outdated — updating it automatically…"
          : "Host is outdated — run this, then reload the extension:";
    }
    if (els.hostBannerIc) {
      els.hostBannerIc.innerHTML = state === "updating" ? '<span class="host-outdated-spinner"></span>' : ICON("warning", 15);
    }
  }

  // ---- host transport -------------------------------------------------------
  function connect() {
    clearTimeout(reconnectTimer);
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      showOnboarding();
      scheduleReconnect();
      return;
    }
    port.onMessage.addListener(onHostMessage);
    port.onDisconnect.addListener(() => {
      const lastErr = chrome.runtime.lastError;
      port = null;
      connected = false;
      hostReady = false;
      for (const c of chats.values()) {
        c.started = false;
        if (c.turnRunning) {
          systemNote(c, "Host disconnected mid-turn.", "warn");
          endTurn(c, null);
        }
        // Any bash-mode command in flight can't report its exit now — finalize
        // its card so it doesn't spin forever.
        for (const execId of [...c.bashRuns.keys()]) finishBashRun(c, execId, null, null, "Host disconnected — command stopped.");
      }
      if (expectHostRestart) {
        expectHostRestart = false;
      } else {
        showOnboarding(lastErr && lastErr.message);
      }
      scheduleReconnect();
    });
  }
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  }

  function onHostMessage(msg) {
    if (!msg) return;
    connected = true;
    // Route id-tagged messages to their chat.
    const chat = msg.id ? chats.get(msg.id) : null;
    switch (msg.type) {
      case "ready":
        hostReady = true;
        home = msg.home || home;
        hostVersion = msg.version || 0;
        hideOnboarding();
        refreshSettingsIfOpen();
        if (!msg.ok) {
          const a = chats.get(activeId);
          if (a) systemNote(a, "Host is up but couldn't find the `claude` CLI. Install it: npm i -g @anthropic-ai/claude-code", "warn");
        }
        // The extension updates via git/store, but the native host runs from a
        // copy in ~/.lizard-studio that install.sh seeds — so a stale host is
        // easy to end up with and otherwise fails silently (missing tools,
        // unknown ops). Ask a stale host to update itself: v4+ hosts refetch
        // their files from GitHub and restart (the reconnect lands back here
        // with a good version). Hosts too old to know the op ignore it, and
        // the grace timer swaps the banner to the manual install command.
        // Hosts older than the version check don't send `version` at all,
        // which reads as 0 and takes the same path.
        clearTimeout(hostUpdateTimer);
        if ((msg.version || 0) >= EXPECTED_HOST_VERSION) {
          setHostBanner("hidden");
        } else {
          setHostBanner("updating");
          post({ type: "selfUpdate" });
          hostUpdateTimer = setTimeout(() => setHostBanner("manual"), 8000);
        }
        // Start whichever tab is in front; others start when first shown.
        {
          const a = chats.get(activeId);
          if (a && !a.started) startChatSession(a);
          maybeReplay(a);
          // Deliver anything queued while the host was down or restarting.
          if (a && a.started && !a.turnRunning) dispatchNextQueued(a);
        }
        break;
      case "interrupted":
        // Stop hard-kills the process and resumes in a fresh one — end the
        // turn right away instead of waiting on a `result` that isn't coming.
        // The `started` event for the respawned process follows separately.
        if (chat && chat.turnRunning) {
          endTurn(chat, null);
        }
        break;
      case "started":
        if (chat) {
          // A (re)spawned process can't answer asks from the previous one.
          clearPermCards(chat);
          if (msg.cwd) { chat.cwd = msg.cwd; rememberCwd(msg.cwd); }
          if (msg.permissionMode) chat.mode = msg.permissionMode;
          if (chat.id === activeId) syncComposer();
          requestBranches(chat);
          requestGitDiff(chat);
        }
        break;
      case "event":
        if (chat) onClaudeEvent(chat, msg.data);
        break;
      case "transcript":
        if (chat) {
          replayTranscript(chat, msg.events);
          // Flush any local bash runs that come after the last transcript event.
          if (msg.done) drainBashUntil(chat, Infinity);
        }
        break;
      case "selfUpdate":
        // updated:true → the host is about to restart; keep "updating…" up
        // until the reconnect's `ready` re-evaluates the version. Anything
        // else (already current yet still stale, fetch failed) → manual.
        if (msg.updated) {
          expectHostRestart = true;
        } else {
          clearTimeout(hostUpdateTimer);
          setHostBanner("manual");
        }
        break;
      case "browser":
        // Not chat-scoped — claude is inspecting the live browser tab.
        handleBrowserOp(msg);
        break;
      case "permission":
        if (chat) showPermission(chat, msg);
        break;
      case "permissionCancel":
        if (chat) removePermCard(chat, msg.requestId);
        break;
      case "commands":
        if (chat && Array.isArray(msg.list)) {
          // `/login` is handled by the panel (the headless CLI doesn't list it),
          // so make sure it's offered in the autocomplete menu.
          chat.slashCommands = msg.list.includes("login") ? msg.list : ["login", ...msg.list];
          if (Array.isArray(msg.skills)) chat.skills = msg.skills;
          if (Array.isArray(msg.plugins)) chat.plugins = msg.plugins;
          // If the user is mid-"/" in this tab, populate the menu now.
          if (chat.id === activeId && /^\/[^\s]*$/.test(els.input.value)) updateSlash();
          // Refresh the Skills list if it's the open settings view.
          if (chat.id === activeId && settingsOpen() && settingsTab === "config" && cfgKey === "skills") renderSettings();
        }
        break;
      case "exit":
        if (chat) {
          chat.started = false;
          clearPermCards(chat);
          if (chat.turnRunning) endTurn(chat, null);
          systemNote(chat, `Claude session ended (code ${msg.code}).`, "warn");
        }
        break;
      case "folder":
        if (chat && msg.path) {
          applyFolder(chat, msg.path);
        } else if (chat && msg.manual) {
          promptForFolder(chat);
        }
        break;
      case "gitBranches":
        if (chat) {
          // Re-arm the self-heal guard (see syncGitBar) only when the answer
          // was usable — a detached-HEAD repo (isRepo, no current branch)
          // would otherwise re-request on every bar sync forever.
          chat.branchRequested = !!msg.isRepo && !msg.current;
          chat.isRepo = !!msg.isRepo;
          chat.branch = msg.current || null;
          chat.branches = Array.isArray(msg.branches) ? msg.branches : [];
          if (chat.id === activeId) syncComposer();
          if (msg.checkedOut && chat.branch) {
            systemNote(chat, `Switched to branch ${chat.branch}`);
            requestGitDiff(chat); // checkout can change the working-tree diff
          }
        }
        break;
      case "gitDiff":
        if (chat) {
          chat.isRepo = !!msg.isRepo;
          chat.diffFiles = Array.isArray(msg.files) ? msg.files : [];
          chat.diffInsertions = msg.insertions || 0;
          chat.diffDeletions = msg.deletions || 0;
          // Drop collapsed-state entries for files that no longer have changes.
          const paths = new Set(chat.diffFiles.map((f) => f.path));
          for (const p of chat.diffCollapsedFiles) if (!paths.has(p)) chat.diffCollapsedFiles.delete(p);
          if (!chat.diffFiles.length) chat.diffDrawerOpen = false;
          if (chat.id === activeId) syncGitBar(chat);
        }
        break;
      case "configRead":
        // Ignore replies for a (key, scope) we've since navigated away from.
        if (settingsOpen() && cfgEdit && cfgEdit.key === msg.key && cfgEdit.scope === msg.scope) {
          cfgEdit.loading = false;
          if (msg.ok) {
            cfgEdit.content = msg.content || "";
            cfgEdit.original = msg.content || "";
            cfgEdit.path = msg.path || "";
            cfgEdit.exists = !!msg.exists;
            cfgEdit.error = "";
          } else {
            cfgEdit.error = msg.error || "Couldn't read the file.";
            cfgEdit.content = "";
            cfgEdit.original = "";
          }
          renderSettings();
        }
        break;
      case "configWrite":
        if (settingsOpen() && cfgEdit && cfgEdit.key === msg.key && cfgEdit.scope === msg.scope) {
          cfgEdit.saving = false;
          if (msg.ok) {
            cfgEdit.original = cfgEdit.content;
            cfgEdit.exists = true;
            cfgEdit.status = "Saved";
            cfgEdit.statusKind = "ok";
            cfgEdit.error = "";
          } else {
            cfgEdit.error = msg.error || "Save failed.";
            cfgEdit.status = "";
          }
          renderSettings();
        }
        break;
      case "shellKilled":
        onShellKilled(msg);
        break;
      case "shellPort":
        onShellPort(msg);
        break;
      case "bashStart":
        break; // the card already shows a spinner; nothing more to do
      case "bashOut":
        if (chat) onBashOut(chat, msg.execId, msg.stream, msg.chunk);
        break;
      case "bashExit":
        if (chat) finishBashRun(chat, msg.execId, msg.code, msg.signal, msg.error);
        break;
      case "needsFolder":
        // Host refused to start without a valid directory (none given, or the
        // saved one is gone). Drop the stale path, surface the empty state, and
        // open the picker so the user can choose.
        if (chat) {
          chat.cwd = null;
          chat.started = false;
          if (msg.id === activeId) syncComposer();
          post({ type: "pickFolder", id: chat.id }) || promptForFolder(chat);
        }
        break;
      case "authUrl":
        if (chat) loginShowUrl(chat, msg.url);
        break;
      case "authDone":
        if (chat) loginDone(chat, msg.ok, msg.message);
        break;
      case "error":
        if (chat) systemNote(chat, msg.message || "Host error", "warn");
        break;
    }
  }

  function post(obj) {
    if (port) {
      try {
        port.postMessage(obj);
        return true;
      } catch (_) {}
    }
    return false;
  }

  // ---- session control ------------------------------------------------------
  function startChatSession(chat, resume) {
    // Never spawn a session in an unspecified directory — wait for an explicit
    // folder pick. The empty-state setup chips stay visible so the user knows.
    if (!chat.cwd) {
      if (chat.id === activeId) updateSetup();
      return;
    }
    // post() fails if the port died since the last connected check — leave
    // `started` false in that case so the reconnect's `ready` handler retries.
    chat.started = post({
      type: "start",
      id: chat.id,
      cwd: chat.cwd,
      model: chat.model,
      effort: chat.effort,
      permissionMode: chat.mode,
      resume: resume || chat.sessionId || undefined,
    });
  }

  // ---- transcript replay ----------------------------------------------------
  // A restored or re-opened tab knows its sessionId but lost its rendered
  // messages (they only ever lived in the DOM). Ask the host to read the session's
  // on-disk JSONL and replay it, once, the first time we have a live host.
  function maybeReplay(chat) {
    if (!chat || chat.replayed) return;
    if (chat.sessionId) {
      if (!connected || !hostReady) return;
      chat.replayed = true;
      chat._bashIdx = 0;
      if (Array.isArray(chat.bashHistory)) chat.bashHistory.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      post({ type: "loadTranscript", id: chat.id, sessionId: chat.sessionId, cwd: chat.cwd });
      return;
    }
    // No CLI session to replay — but a bash-only tab may still have local shell
    // history to restore. Only when its DOM is empty (a genuinely restored tab,
    // not a live one that already rendered its runs) so runs never double up.
    if (Array.isArray(chat.bashHistory) && chat.bashHistory.length && chat.messagesEl.childElementCount === 0) {
      chat.replayed = true;
      chat._bashIdx = 0;
      chat.bashHistory.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      drainBashUntil(chat, Infinity);
    }
  }

  // Render a chunk of past messages (the host streams them in order across one or
  // more `transcript` events). Reuses the live renderers so history looks
  // identical to a fresh turn — user bubbles, assistant text/thinking, tool cards
  // and their results.
  function replayTranscript(chat, events) {
    if (!chat || !Array.isArray(events)) return;
    for (const ev of events) {
      if (!ev) continue;
      // Stamp task start/finish from the transcript's own timestamps during
      // replay, so a replayed subagent's elapsed reflects its real historical
      // duration instead of collapsing to ~0s (everything replayed "now").
      replayStamp = ev.timestamp ? Date.parse(ev.timestamp) || 0 : 0;
      // Interleave local bash-mode runs at their chronological spot among the
      // CLI transcript events (both carry timestamps; events arrive in order).
      if (replayStamp) drainBashUntil(chat, replayStamp);
      if (ev.type === "local_command") {
        const ts = ev.timestamp ? Date.parse(ev.timestamp) || Date.now() : Date.now();
        renderLocalCommandOutput(chat, String(ev.content || ""), ts);
        continue;
      }
      if (!ev.message) continue;
      if (ev.type === "user") {
        const content = ev.message.content;
        const ts = ev.timestamp ? Date.parse(ev.timestamp) || Date.now() : Date.now();
        if (typeof content === "string") {
          // A background task / async subagent completion notice is a synthetic
          // string turn — resolve it so replayed history isn't left "running".
          scanBgNotice(chat, content);
          scanAgentNotice(chat, content);
          // Some local-command output (/compact's "Compacted") is stored as a
          // plain-string user turn rather than a system line — render it as
          // command output, not a user bubble.
          if (/<local-command-std(out|err)>/.test(content)) {
            renderLocalCommandOutput(chat, content, ts);
            continue;
          }
          const stripped =
            commandBubbleText(content) || content.replace(SYNTHETIC_USER_TAG_RE, "").replace(CTX_MARK_RE, "").trim();
          if (stripped) userBubble(chat, stripped, null, { real: true, ts });
        } else if (Array.isArray(content)) {
          const texts = [];
          for (const b of content) {
            if (!b) continue;
            if (b.type === "tool_result") fillToolResult(chat, b.tool_use_id, b.content, b.is_error);
            else if (b.type === "text" && b.text) texts.push(b.text);
          }
          const joined = texts.join("\n\n");
          const stripped =
            commandBubbleText(joined) || joined.replace(SYNTHETIC_USER_TAG_RE, "").replace(CTX_MARK_RE, "").trim();
          if (stripped) userBubble(chat, stripped, null, { real: true, ts });
        }
      } else if (ev.type === "assistant") {
        // Each replayed assistant message refreshes the context reading; the
        // last one in the transcript is the conversation's current size.
        noteCtxUsage(chat, ev.message.usage);
        const body = ensureAssistantBody(chat, ev.message.id);
        for (const block of ev.message.content || []) {
          if (!block) continue;
          if (block.type === "tool_use") {
            if (chat.emittedToolIds.has(block.id)) continue;
            chat.emittedToolIds.add(block.id);
            toolCard(chat, body, block);
          } else if (block.type === "text") {
            // (thinking blocks are intentionally not rendered.)
            addText(chat, body, block.text);
          }
        }
        const ts = ev.timestamp ? (Date.parse(ev.timestamp) || Date.now()) : Date.now();
        finalizeAssistant(null, body, ts);
      }
    }
    replayStamp = 0; // back to live time
    // Leave currentAssistantId pointing at the last replayed turn so a turn that
    // straddles a chunk boundary stays in one body; the next live turn arrives
    // with a fresh message id and naturally opens its own body.
    if (chat.id === activeId) requestAnimationFrame(() => scrollToBottom(chat));
  }

  // Render the output of a local slash command. The CLI persists it wrapped in
  // <local-command-stdout>/-stderr> — as a `system` line for some commands
  // (/usage) and as a plain-string `user` turn for others (/compact), and the
  // latter also arrives live as a `user` event, so this is shared by both the
  // live path and transcript replay. Stdout renders the way the live /usage
  // path would — the usage card when the text parses as plan-usage lines,
  // plain markdown otherwise — and stderr as a warning note.
  function renderLocalCommandOutput(chat, raw, ts) {
    const err = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/.exec(raw);
    if (err && err[1].trim()) systemNote(chat, err[1].trim(), "warn");
    const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(raw);
    const text = (out ? out[1] : err ? "" : raw).trim();
    if (!text) return;
    // /compact's whole stdout is the word "Compacted" — a note concludes the
    // "Compacting…" status better than an assistant bubble would, and doubles
    // as the live completion feedback the command otherwise lacks.
    if (/^compacted$/i.test(text)) {
      systemNote(chat, "Context compacted");
      return;
    }
    const body = ensureAssistantBody(chat, "local-command-" + ts);
    attachAssistantRow(chat, body);
    const parsed = parseUsageText(text);
    if (parsed) body.appendChild(buildUsageCard(parsed));
    else body.appendChild(R.markdown(text));
    finalizeAssistant(null, body, ts);
  }

  // ---- composer bash mode: local shell runs ---------------------------------
  // Runs go through the host's bashExec (a detached `zsh -c` in the tab's cwd)
  // and never touch the claude process or the model. Output streams into a
  // terminal-style card; finished runs persist to chat.bashHistory so they
  // survive a reload (see maybeReplay / drainBashUntil).
  const BASH_LIVE_CAP = 500000; // max chars kept in a live output <pre>
  const BASH_STORE_CAP = 20000; // max chars persisted per run (tail — errors sit there)

  // Build the card DOM. `live` cards get a stop button + spinner; replayed ones
  // are static. Returns the nodes the streaming/finish code writes into.
  function buildBashCard(command, opts) {
    opts = opts || {};
    const row = el("div", "msg bash-run");
    const card = el("div", "bash-run-card");
    const head = el("div", "bash-run-head");
    head.appendChild(el("span", "bash-run-prompt", "$"));
    head.appendChild(el("span", "bash-run-cmd", command));
    let stopBtn = null, spin = null;
    if (opts.live) {
      spin = el("span", "bash-run-spin");
      head.appendChild(spin);
      stopBtn = el("button", "bash-run-stop");
      stopBtn.type = "button";
      stopBtn.title = "Stop";
      stopBtn.innerHTML = ICON("stop", 12);
      head.appendChild(stopBtn);
    }
    card.appendChild(head);
    // Output lives in its own container: a plain <pre> streams into it live,
    // then finishBashRun swaps that for a highlighted codeBlock (copy button +
    // line-count label) — the same treatment a model Bash result gets.
    const body = el("div", "bash-run-body hidden");
    const out = el("pre", "bash-run-out");
    body.appendChild(out);
    card.appendChild(body);
    const foot = el("div", "bash-run-foot hidden");
    card.appendChild(foot);
    row.appendChild(card);
    return { row, bodyEl: body, outEl: out, footEl: foot, stopBtn, spin };
  }

  // Render a finished run's output the way a model Bash result renders: a
  // line-count label above long output, then a copyable, highlighted codeBlock.
  // Empty output leaves the body hidden (the command bubble stands alone).
  function renderBashOutput(bodyEl, text) {
    bodyEl.innerHTML = "";
    const t = text || "";
    if (!t.trim()) { bodyEl.classList.add("hidden"); return; }
    bodyEl.classList.remove("hidden");
    const lines = t.split("\n");
    if (lines.length > 16 || t.length > 1400) {
      bodyEl.appendChild(el("div", "result-label", "Output · " + lines.length + " lines"));
    }
    bodyEl.appendChild(R.codeBlock(t, ""));
  }

  function bashFoot(footEl, code, signal, error) {
    footEl.className = "bash-run-foot";
    if (error) { footEl.classList.add("err"); footEl.textContent = error; return; }
    if (signal) { footEl.classList.add("err"); footEl.textContent = "Stopped"; return; }
    // A clean exit needs no footer — the output already speaks for itself.
    if (code === 0 || code == null) { footEl.className = "bash-run-foot hidden"; footEl.textContent = ""; return; }
    footEl.classList.add("err"); footEl.textContent = "Exit " + code;
  }

  function runBash(chat, command) {
    const execId = newId();
    const ts = Date.now();
    const { row, bodyEl, outEl, footEl, stopBtn, spin } = buildBashCard(command, { live: true });
    const run = { row, bodyEl, outEl, footEl, stopBtn, spin, command, ts, outText: "", running: true };
    chat.bashRuns.set(execId, run);
    append(chat, row);
    if (stopBtn) stopBtn.addEventListener("click", () => post({ type: "bashKill", id: chat.id, execId }));
    if (!post({ type: "bashExec", id: chat.id, execId, command, cwd: chat.cwd })) {
      finishBashRun(chat, execId, 1, null, "Host disconnected — command not run.");
    }
  }

  function onBashOut(chat, execId, stream, chunk) {
    const run = chat && chat.bashRuns.get(execId);
    if (!run || !chunk) return;
    const stick = chat.id === activeId && atBottom(chat);
    run.bodyEl.classList.remove("hidden");
    const node = stream === "stderr" ? el("span", "bash-run-err") : document.createTextNode(chunk);
    if (stream === "stderr") node.textContent = chunk;
    run.outEl.appendChild(node);
    // Bound the live DOM: drop oldest nodes once it grows past the cap.
    run.outLen = (run.outLen || 0) + chunk.length;
    while (run.outLen > BASH_LIVE_CAP && run.outEl.firstChild && run.outEl.childNodes.length > 1) {
      run.outLen -= (run.outEl.firstChild.textContent || "").length;
      run.outEl.removeChild(run.outEl.firstChild);
    }
    run.outText = (run.outText + chunk).slice(-BASH_STORE_CAP);
    if (stick) scrollToBottom(chat);
  }

  function finishBashRun(chat, execId, code, signal, error) {
    const run = chat && chat.bashRuns.get(execId);
    if (!run) return;
    chat.bashRuns.delete(execId);
    run.running = false;
    if (run.stopBtn) run.stopBtn.remove();
    if (run.spin) run.spin.remove();
    // Swap the live stream for the polished, copyable codeBlock now it's done.
    renderBashOutput(run.bodyEl, run.outText);
    run.footEl.classList.remove("hidden");
    bashFoot(run.footEl, code, signal, error);
    chat.bashHistory.push({ id: execId, command: run.command, output: run.outText, code: code == null ? null : code, signal: signal || null, ts: run.ts });
    if (chat.bashHistory.length > 100) chat.bashHistory = chat.bashHistory.slice(-100);
    // Queue it to ride the next prompt into the model's context (see
    // formatBashContext / deliverPrompt). Keep the buffer bounded.
    chat.bashPending.push({ command: run.command, output: run.outText, code: code == null ? null : code, signal: signal || null });
    if (chat.bashPending.length > 20) chat.bashPending = chat.bashPending.slice(-20);
    savePrefs();
  }

  // Serialize the not-yet-seen bash runs into a context block prepended to the
  // next prompt (pure read — deliverPrompt clears the buffer once the prompt is
  // actually sent). Rides inside the same invisible sentinels as the tabs/page
  // context, so it never shows in the bubble and is stripped on replay.
  function formatBashContext(chat) {
    const runs = Array.isArray(chat.bashPending) ? chat.bashPending : [];
    if (!runs.length) return "";
    const TOTAL_CAP = 40000;
    const parts = [];
    let used = 0;
    for (const r of runs) {
      const status = r.signal ? "(stopped)" : `(exit ${r.code == null ? "?" : r.code})`;
      const out = (r.output || "").trim();
      let block = `$ ${r.command}\n${out ? out + "\n" : ""}${status}`;
      if (used + block.length > TOTAL_CAP) {
        parts.push(block.slice(0, Math.max(0, TOTAL_CAP - used)) + "\n…[truncated]");
        break;
      }
      parts.push(block);
      used += block.length;
    }
    const head =
      "[Shell commands the user ran locally via the composer's bash mode" +
      (chat.cwd ? " in " + shortPath(chat.cwd) : "") +
      ", with their output. The user ran these themselves — treat as context, not as a message they typed.]";
    return head + "\n\n" + parts.join("\n\n") + "\n\n";
  }

  // Static (non-streaming) render of a persisted run, used on transcript replay.
  function renderBashEntry(chat, entry) {
    const { row, bodyEl, footEl } = buildBashCard(entry.command || "", { live: false });
    renderBashOutput(bodyEl, entry.output || "");
    footEl.classList.remove("hidden");
    bashFoot(footEl, entry.code, entry.signal, null);
    append(chat, row);
  }

  // Render persisted bash runs up to `tsLimit`, advancing the replay cursor.
  // Interleaves local shell history with the CLI transcript in timestamp order.
  function drainBashUntil(chat, tsLimit) {
    const h = chat && chat.bashHistory;
    if (!Array.isArray(h)) return;
    let i = chat._bashIdx || 0;
    while (i < h.length && (h[i].ts || 0) <= tsLimit) {
      renderBashEntry(chat, h[i]);
      i++;
    }
    chat._bashIdx = i;
  }

  // Wipe a tab's transcript and start a fresh session (used on folder change).
  function resetChatSession(chat) {
    chat.messagesEl.innerHTML = "";
    chat.loginCard = null; // detached from the DOM above; drop the stale reference
    chat.statusEl = null; // wiped with the stream; recreated on next render
    chat.permCards.clear(); // card nodes went with the innerHTML wipe
    chat.toolCards.clear();
    chat.toolGroup = null; // its nodes went with the innerHTML wipe too
    chat.emittedToolIds.clear();
    chat.currentAssistantId = null;
    chat.currentAssistantBody = null;
    chat.sessionId = null;
    chat.lastTabsSnapshot = null;
    pinnedTabBySession.delete(chat.id);
    chat.empty = true;
    chat.turnStatusText = "";
    chat.streamBlocks.clear();
    chat.streamedMsgIds.clear();
    chat.streamMsgId = null;
    chat.agents.clear();
    chat.bgTasks.clear();
    chat.bgShell.clear();
    chat.agentTask.clear();
    chat.previews.clear();
    chat.previewServer.clear();
    chat.tasksDrawerOpen = false;
    chat.tasksFinishedCollapsed = false;
    chat.tasksView = "list";
    chat.transcriptAgentId = null;
    chat.ctxBase = 0;
    chat.ctxTokens = 0;
    // Local shell runs go with the wiped conversation — stop any in-flight ones
    // and drop the persisted history (their cards were just removed above).
    for (const execId of chat.bashRuns.keys()) post({ type: "bashKill", id: chat.id, execId });
    chat.bashRuns.clear();
    chat.bashHistory = [];
    chat.bashPending = [];
    chat._bashIdx = 0;
    chat.bashMode = false;
    chat.queue = []; // stale prompts from the wiped conversation shouldn't replay
    if (chat.id === activeId) {
      renderTurnStatus(chat);
      syncBashMode(chat);
      updateSetup();
    }
    chat.started = false;
    startChatSession(chat);
  }

  async function sendPrompt() {
    const chat = chats.get(activeId);
    if (!chat) return;
    const text = els.input.value.trim();
    // Bash mode ("!"): run the line as a local shell command in the tab's cwd
    // instead of sending it to the model. Runs independently of any in-flight
    // turn (it never touches the claude process), and returns to normal mode
    // after each command — retype "!" to run another.
    if (chat.bashMode) {
      if (!text) return;
      if (!chat.cwd) {
        post({ type: "pickFolder", id: chat.id }) || promptForFolder(chat);
        return;
      }
      els.input.value = "";
      exitBashMode(chat);
      autosize();
      runBash(chat, text);
      return;
    }
    // `/clear` wipes the conversation and starts a fresh session. It's handled
    // here rather than passed to the headless CLI, which treats it as plain text.
    if (/^\/clear\s*$/.test(text)) {
      els.input.value = "";
      chat.contexts = [];
      chat.attachments = [];
      renderContextChips();
      renderAttachmentThumbs();
      autosize();
      chat.turnRunning = false;
      // resetChatSession restarts the session, which kills any in-flight turn.
      resetChatSession(chat);
      return;
    }
    // `/login` can't run in the headless CLI, so drive its OAuth flow from here.
    if (/^\/login\s*$/.test(text)) {
      els.input.value = "";
      autosize();
      userBubble(chat, "/login", null);
      chat.empty = false;
      updateSetup();
      startLogin(chat);
      return;
    }
    const hasContext = Array.isArray(chat.contexts) && chat.contexts.length > 0;
    const attachments = Array.isArray(chat.attachments) ? chat.attachments : [];
    const hasAttach = attachments.length > 0;
    if (!text && !hasContext && !hasAttach) return;
    // Can't run an agent without a working directory — prompt for one instead of
    // silently falling back to $HOME.
    if (!chat.cwd) {
      post({ type: "pickFolder", id: chat.id }) || promptForFolder(chat);
      return;
    }
    // A turn is already streaming — queue this one instead of dropping it.
    // Same when the host is down or still restarting (mid self-update): the
    // prompt shows as a queued bubble and delivers when the session is back,
    // instead of the Enter press being silently swallowed. The queue drains
    // from endTurn() and from the reconnect's `ready` handler.
    if (chat.turnRunning || !connected || !hostReady) {
      queuePrompt(chat, text);
      return;
    }
    els.input.value = "";
    autosize();
    await deliverPrompt(chat, text);
  }

  // Stashes a prompt (plus its context/attachments) on the chat and shows a
  // dimmed bubble with a cancel affordance. Composer is cleared immediately so
  // the user can keep typing further queued messages.
  function queuePrompt(chat, text) {
    if (!Array.isArray(chat.queue)) chat.queue = [];
    const entry = {
      text,
      contexts: Array.isArray(chat.contexts) ? chat.contexts.slice() : [],
      attachments: Array.isArray(chat.attachments) ? chat.attachments.slice() : [],
    };
    chat.queue.push(entry);
    chat.contexts = [];
    chat.attachments = [];
    renderContextChips();
    renderAttachmentThumbs();
    els.input.value = "";
    autosize();
    entry.el = renderQueuedBubble(chat, entry);
  }

  // opts.atFront: this entry was unshifted back to the head of the queue (the
  // failed-post requeue path in deliverPrompt) — anchor it before whichever
  // bubble was previously frontmost instead of stacking it after everything.
  function renderQueuedBubble(chat, entry, opts) {
    const row = el("div", "msg msg-user queued");
    row.appendChild(buildBubble(entry.text, entry.attachments));
    const tag = el("div", "queued-tag");
    const cancel = el("button", "queued-cancel");
    cancel.type = "button";
    cancel.innerHTML = ICON("x", 11);
    cancel.title = "Remove from queue";
    cancel.addEventListener("click", () => {
      const idx = chat.queue.indexOf(entry);
      if (idx !== -1) chat.queue.splice(idx, 1);
      row.remove();
    });
    tag.appendChild(cancel);
    row.appendChild(tag);
    append(chat, row, { raw: !(opts && opts.atFront) });
    return row;
  }

  // Drains the next queued prompt (if any) once a turn finishes. Runs even if
  // `chat` isn't the active tab — background chats keep working while queued.
  function dispatchNextQueued(chat) {
    if (!Array.isArray(chat.queue) || !chat.queue.length) return;
    const entry = chat.queue.shift();
    if (entry.el && entry.el.parentNode) entry.el.remove();
    chat.contexts = entry.contexts;
    chat.attachments = entry.attachments;
    if (chat.id === activeId) {
      renderContextChips();
      renderAttachmentThumbs();
    }
    deliverPrompt(chat, entry.text);
  }

  async function deliverPrompt(chat, text) {
    const hasContext = Array.isArray(chat.contexts) && chat.contexts.length > 0;
    const attachments = Array.isArray(chat.attachments) ? chat.attachments : [];
    if (!chat.started) startChatSession(chat);
    // Slash commands go to the CLI's command parser, not the model — anything
    // after the name is swallowed into <command-args> (/compact would treat an
    // appended tabs block as custom summarization instructions). Send commands
    // bare: skip the tabs block (not calling the builder leaves its snapshot
    // untouched, so the next real prompt still sends it) and leave any attached
    // context chips in place for the next real prompt instead of consuming them.
    const isCommand = /^\//.test(text);
    // Silent, always-on context: what tabs are open right now, active one flagged.
    const tabsBlock = isCommand ? "" : await buildTabsContextBlock(chat);
    // Prepend any attached page/element context as a block, then clear it.
    const ctx = isCommand ? "" : formatContexts(chat);
    // Silently fold in any local bash-mode runs the model hasn't seen yet.
    const bashBlock = isCommand ? "" : formatBashContext(chat);
    const hasPage = hasContext && chat.contexts.some((c) => c.kind === "page");
    const hasFile = hasContext && chat.contexts.some((c) => c.kind === "file");
    const fallback = hasContext
      ? hasPage
        ? "What's on this page?"
        : hasFile
          ? "What can you tell me about the attached file(s)?"
          : "What can you tell me about this element?"
      : "";
    const bubbleHint = hasPage ? "_(attached current tab)_" : hasFile ? "_(attached file)_" : "_(selected page element)_";
    // The CLI answers a bare /usage (or /usage-credits, /extra-usage) with a
    // synthetic, zero-turn plain-text reply — swap it for a progress-bar card.
    chat.pendingUsageCard = /^\/(usage|usage-credits|extra-usage)\s*$/.test(text);
    const extra = tabsBlock + ctx + bashBlock;
    // Wrap injected context in invisible sentinels so replayTranscript() can
    // strip it back out on reload — the live bubble above already shows just
    // the literal typed text, and replay should match that.
    const wrappedExtra = extra ? CTX_MARK_START + extra + CTX_MARK_END : "";
    const sentText = isCommand ? text : wrappedExtra + (text || fallback);
    const images = attachments.map((a) => ({ mediaType: a.mediaType, data: (a.dataUrl.split(",")[1] || "") }));
    // If the port died since the connected check, post() reports it and nothing
    // reached the host. Requeue the prompt (visible, cancellable) instead of
    // entering a running state whose spinner would never stop — endTurn() or
    // the reconnect's `ready` handler re-delivers it.
    if (!post({ type: "prompt", id: chat.id, text: sentText, images })) {
      const entry = {
        text,
        contexts: Array.isArray(chat.contexts) ? chat.contexts.slice() : [],
        attachments: attachments.slice(),
      };
      if (!Array.isArray(chat.queue)) chat.queue = [];
      chat.queue.unshift(entry); // it was next in line — keep it ahead of later queued prompts
      entry.el = renderQueuedBubble(chat, entry, { atFront: true });
      chat.contexts = [];
      chat.attachments = [];
      if (chat.id === activeId) {
        renderContextChips();
        renderAttachmentThumbs();
      }
      systemNote(chat, "Host disconnected — message queued until it reconnects.", "warn");
      return;
    }
    userBubble(chat, text || (hasContext ? bubbleHint : ""), attachments, { real: true });
    if (!isCommand) {
      chat.contexts = []; // command turns don't consume context chips
      chat.bashPending = []; // the model has now seen these local runs
    }
    chat.attachments = [];
    if (chat.id === activeId) {
      renderContextChips();
      renderAttachmentThumbs();
    }
    chat.empty = false;
    chat.turnRunning = true;
    chat.turnStatusText = "";
    chat.compacting = false;
    // Reset the running-status metrics for this turn.
    chat.turnStartedAt = Date.now();
    chat.turnTokens = 0;
    chat.curMsgTokens = 0;
    refreshStatusWord(chat);
    chat.streamedMsgIds.clear();
    chat.streamBlocks.clear();
    chat.streamMsgId = null;
    // First message becomes the tab title.
    if (chat.title === DEFAULT_TITLE) {
      chat.title = (text || "New chat").replace(/\s+/g, " ").slice(0, 40);
      renderTabs();
    }
    if (chat.id === activeId) {
      setRunningUI(true);
      startStatusTicker();
    }
    renderTurnStatus(chat);
    updateSetup();
    savePrefs();
  }

  function setRunningUI(on) {
    els.send.classList.toggle("hidden", on);
    els.stop.classList.toggle("hidden", !on);
    els.root.classList.toggle("running", on);
  }

  function interrupt() {
    const chat = chats.get(activeId);
    if (!chat) return;
    // The host hard-kills and resumes the session (see `interrupted` below) —
    // no need for an "Interrupting…" note, the turn just stops.
    post({ type: "interrupt", id: chat.id });
  }

  // ---- interactive login ----------------------------------------------------
  // Kicks off the host's `claude auth login` flow and shows a card that walks
  // the user through the browser OAuth + code paste. The host replies with
  // `authUrl` (the sign-in link) and finally `authDone`.
  function startLogin(chat) {
    if (chat.loginCard) { chat.loginCard.remove(); chat.loginCard = null; }
    const card = el("div", "login-card");
    const titleRow = el("div", "login-title-row");
    const icon = el("span", "login-icon");
    icon.innerHTML = '<span class="login-spinner"></span>';
    titleRow.appendChild(icon);
    titleRow.appendChild(el("span", "login-title", "Sign in to Claude"));
    card.appendChild(titleRow);
    card._icon = icon;
    const status = el("div", "login-status", "Starting sign-in…");
    card.appendChild(status);
    card._status = status;
    chat.loginCard = card;
    append(chat, card);
    if (!post({ type: "authLogin", id: chat.id })) {
      status.textContent = "Can't reach the host — is the native helper running?";
      card.classList.add("error");
    }
  }

  function loginShowUrl(chat, url) {
    const card = chat.loginCard;
    if (!card) return;
    card.classList.add("waiting");
    card._status.textContent = "Click Authorize in the tab that just opened — you'll be signed in automatically.";
    // The CLI opens the URL itself (`open`/`xdg-open`) as soon as it prints it —
    // don't also open it here, that's what caused two sign-in tabs. This button
    // is a fallback for when the CLI's own open fails (e.g. no GUI, remote host).
    const openTab = () => {
      try { chrome.tabs.create({ url }); }
      catch (_) { window.open(url, "_blank"); }
    };
    const open = el("button", "login-open", "Open sign-in page");
    open.type = "button";
    open.addEventListener("click", openTab);
    // The browser callback completes sign-in on its own in almost every case;
    // pasting the authorization code is a fallback for when it can't reach the
    // CLI (remote host, blocked localhost callback), so keep it tucked away.
    const fallback = el("button", "login-fallback", "Having trouble? Paste the code manually");
    fallback.type = "button";
    const row = el("div", "login-row hidden");
    const input = el("input", "login-input");
    input.type = "text";
    input.placeholder = "Authorization code";
    input.spellcheck = false;
    input.autocapitalize = "off";
    const submit = el("button", "login-submit", "Sign in");
    submit.type = "button";
    const doSubmit = () => {
      const code = input.value.trim();
      if (!code) { input.focus(); return; }
      post({ type: "authCode", id: chat.id, code });
      card._status.textContent = "Signing in…";
      input.disabled = true;
      submit.disabled = true;
    };
    submit.addEventListener("click", doSubmit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doSubmit(); }
    });
    fallback.addEventListener("click", () => {
      fallback.classList.add("hidden");
      row.classList.remove("hidden");
      input.focus();
    });
    row.appendChild(input);
    row.appendChild(submit);
    card.appendChild(open);
    card.appendChild(fallback);
    card.appendChild(row);
    card._controls = [open, fallback, row];
  }

  function loginDone(chat, ok, message) {
    const card = chat.loginCard;
    chat.loginCard = null;
    const failText = "Sign-in failed: " + (message || "unknown error") + ". Type /login to try again.";
    if (card) {
      // Keep the card in the transcript; collapse it into its final state.
      card.classList.remove("waiting");
      if (card._controls) { for (const c of card._controls) c.remove(); card._controls = null; }
      card.classList.add(ok ? "done" : "error");
      if (ok) {
        card._icon.innerHTML = ICON("check", 13);
        card._status.textContent = "Signed in. You're all set.";
      } else {
        card._icon.remove();
        card._status.textContent = failText;
      }
    } else {
      // Card is gone (tab reset while signing in) — fall back to a note.
      systemNote(chat, ok ? "Signed in. You're all set." : failText, ok ? undefined : "warn");
    }
    // Restart the backend session so the CLI picks up the fresh credentials.
    // Resuming the same session id keeps the transcript and context intact —
    // no need to wipe the conversation.
    if (ok && chat.started) {
      chat.started = false;
      startChatSession(chat);
    }
  }

  // ---- composer / header controls -------------------------------------------
  // Model/mode/effort changes restart the underlying claude process — it
  // can't hot-swap those for a live conversation. Restarting right away would
  // hard-kill an in-flight turn (the same mechanism Stop uses), silently
  // cutting off a reply that was still streaming even though the user only
  // meant the change to apply going forward. So: restart immediately while
  // idle (matches switching folders, same as before); while a turn is
  // running, defer and let endTurn() flush it once the reply is actually done.
  function scheduleSessionRestart(chat) {
    if (!chat.started) return; // no live process yet — the next start already reads chat.model/effort/mode
    if (chat.turnRunning) {
      chat.restartPending = true;
      return;
    }
    restartSessionNow(chat);
  }

  // Sends the full current trio (not just whatever just changed) — this may
  // be flushing several deferred switches made in any order while the turn
  // that just finished was running.
  function restartSessionNow(chat) {
    chat.restartPending = false;
    // A failed post means the host never saw the change — mark the session
    // not-started so the next (re)start spawns with the values shown in the UI.
    if (!post({ type: "restartSession", id: chat.id, model: chat.model, effort: chat.effort, permissionMode: chat.mode })) {
      chat.started = false;
    }
  }

  function applyMode(chat, modeId) {
    const m = MODES.find((x) => x.id === modeId) || MODES[0];
    chat.mode = m.id;
    lastMode = m.id;
    savePrefs();
    syncComposer();
    scheduleSessionRestart(chat);
    // The composer pill already reflects the active mode — no transcript note.
  }

  // Shift+Tab still cycles, mirroring the CLI.
  function cycleMode() {
    const chat = chats.get(activeId);
    if (!chat) return;
    const idx = MODES.findIndex((m) => m.id === chat.mode);
    applyMode(chat, MODES[(idx + 1) % MODES.length].id);
  }

  // Click opens a dropdown (upward) to pick a mode directly.
  function toggleModeMenu() {
    if (!els.modeMenu.classList.contains("hidden")) return hideModeMenu();
    renderModeMenu();
    els.modeMenu.classList.remove("hidden");
  }
  function renderModeMenu() {
    const chat = chats.get(activeId);
    els.modeMenu.innerHTML = "";
    els.modeMenu.appendChild(el("div", "mode-head", "Permission mode"));
    for (const m of MODES) {
      const isCur = !!(chat && chat.mode === m.id);
      const row = el("div", "mode-item " + m.cls + (isCur ? " current" : ""));
      row.appendChild(el("span", "mode-dot"));
      const meta = el("div", "mode-meta");
      meta.appendChild(el("div", "mode-item-label", m.label));
      row.appendChild(meta);
      const ic = el("span", "mode-item-ic");
      if (isCur) ic.innerHTML = ICON("check", 13);
      row.appendChild(ic);
      row.addEventListener("click", () => {
        hideModeMenu();
        const c = chats.get(activeId);
        if (c) applyMode(c, m.id);
      });
      els.modeMenu.appendChild(row);
    }
  }
  function hideModeMenu() {
    els.modeMenu.classList.add("hidden");
  }

  // ---- model picker (custom dropdown, opens upward) -------------------------
  function applyModel(chat, modelId) {
    const m = MODELS.find((x) => x.id === modelId) || MODELS[0];
    chat.model = m.id;
    lastModel = m.id;
    savePrefs();
    syncComposer();
    scheduleSessionRestart(chat);
    // The composer pill already reflects the active model — no transcript note.
  }

  // Shared row builder for the model/effort pickers — identical structure,
  // the model rows just carry the Claude logo.
  function renderPickerMenu(menu, title, items, currentId, onPick, withLogo) {
    menu.innerHTML = "";
    menu.appendChild(el("div", "model-head", title));
    for (const it of items) {
      const isCur = it.id === currentId;
      const row = el("div", "model-item" + (isCur ? " current" : ""));
      if (withLogo) {
        const logo = el("span", "model-item-logo");
        logo.innerHTML = window.RKClaudeHTML(15);
        row.appendChild(logo);
      }
      row.appendChild(el("span", "model-item-label", it.label));
      const ic = el("span", "model-item-ic");
      if (isCur) ic.innerHTML = ICON("check", 13);
      row.appendChild(ic);
      row.addEventListener("click", () => {
        menu.classList.add("hidden");
        const c = chats.get(activeId);
        if (c) onPick(c, it.id);
      });
      menu.appendChild(row);
    }
  }

  function toggleModelMenu() {
    if (!els.modelMenu.classList.contains("hidden")) return hideModelMenu();
    renderModelMenu();
    els.modelMenu.classList.remove("hidden");
  }
  function renderModelMenu() {
    const chat = chats.get(activeId);
    renderPickerMenu(els.modelMenu, "Model", MODELS, chat && chat.model, applyModel, true);
  }
  function hideModelMenu() {
    els.modelMenu.classList.add("hidden");
  }

  function reflectModel(chat, modelId) {
    const known = MODELS.find((m) => m.id === modelId);
    if (known) chat.model = known.id;
  }

  // ---- effort picker (mirrors the model picker) ------------------------------
  function applyEffort(chat, effortId) {
    const e = EFFORTS.find((x) => x.id === effortId) || EFFORTS.find((x) => x.id === DEFAULT_EFFORT);
    chat.effort = e.id;
    lastEffort = e.id;
    savePrefs();
    syncComposer();
    scheduleSessionRestart(chat);
  }

  function toggleEffortMenu() {
    if (!els.effortMenu.classList.contains("hidden")) return hideEffortMenu();
    renderEffortMenu();
    els.effortMenu.classList.remove("hidden");
  }
  function renderEffortMenu() {
    const chat = chats.get(activeId);
    renderPickerMenu(els.effortMenu, "Effort", EFFORTS, chat && chat.effort, applyEffort, false);
  }
  function hideEffortMenu() {
    els.effortMenu.classList.add("hidden");
  }

  // ---- settings modal -------------------------------------------------------
  // A modal overlaying the whole panel, opened by the gear in the subbar, with
  // a tab strip up top. Connection is read-only status; the single Config tab
  // edits on-disk config through the host (the browser sandbox can't touch the
  // filesystem) — CLAUDE.md / Hooks / MCP / Plugins editors plus a read-only
  // Skills list — picked by an in-tab segmented control.
  const SETTINGS_TABS = [
    { id: "connection", label: "Connection" },
    { id: "config", label: "Config" },
  ];
  // The files the Config tab can edit, in segmented-control order. `format`
  // picks the editor (raw text vs JSON); `label` is the segment caption;
  // `project`/`user` are the human-readable target paths. Keyed by the same id
  // the host's configResolve() understands.
  const CONFIG_FILES = ["claudemd", "hooks", "mcp", "plugins", "skills"];
  const CONFIG_META = {
    claudemd: {
      title: "CLAUDE.md",
      label: "CLAUDE.md",
      format: "text",
      blurb: "Project memory prepended to every session.",
      project: "<project>/CLAUDE.md",
      user: "~/.claude/CLAUDE.md",
      placeholder: "# Notes\n\nGuidance Claude should always follow in this project…",
    },
    hooks: {
      title: "Hooks",
      label: "Hooks",
      format: "json",
      blurb: "Shell commands run on events (PreToolUse, PostToolUse, SessionStart…). A JSON object keyed by event.",
      project: "<project>/.claude/settings.json → \"hooks\"",
      user: "~/.claude/settings.json → \"hooks\"",
      placeholder:
        '{\n  "PostToolUse": [\n    {\n      "matcher": "Edit|Write",\n      "hooks": [{ "type": "command", "command": "echo edited" }]\n    }\n  ]\n}',
    },
    mcp: {
      title: "MCP servers",
      label: "MCP",
      format: "json",
      blurb: "Model Context Protocol servers, keyed by name. Servers needing OAuth login can't be authorized from here yet.",
      project: "<project>/.mcp.json → \"mcpServers\"",
      user: "~/.claude.json → \"mcpServers\"",
      placeholder:
        '{\n  "playwright": {\n    "command": "npx",\n    "args": ["-y", "@playwright/mcp@latest"]\n  }\n}',
    },
    plugins: {
      title: "Plugins",
      label: "Plugins",
      format: "json",
      toggles: true, // rendered as an on/off list instead of a raw JSON editor
      blurb: "Enable or disable installed plugins.",
      project: "<project>/.claude/settings.json → \"enabledPlugins\"",
      user: "~/.claude/settings.json → \"enabledPlugins\"",
    },
    skills: {
      title: "Skills",
      label: "Skills",
      readonly: true,
      blurb: "Skills available to Claude in this project, discovered from ~/.claude/skills, the project's .claude/skills, and installed plugins. Edit them at their source files.",
    },
  };
  let settingsTab = "connection";
  // Which file the Config tab is editing (its segmented control's selection).
  let cfgKey = "claudemd";
  // Search box text for the read-only Skills list.
  let skillsFilter = "";
  // Live state of the open config editor (null when on a status tab). Survives
  // the modal's re-renders so unsaved text isn't lost; keyed by (key, scope) so
  // late host replies for a scope we've since switched away from are ignored.
  let cfgEdit = null;

  function settingsOpen() {
    return mounted && els.settingsOverlay && !els.settingsOverlay.classList.contains("hidden");
  }

  function openSettings() {
    settingsTab = "connection";
    cfgKey = "claudemd";
    skillsFilter = "";
    cfgEdit = null;
    renderSettings();
    els.settingsOverlay.classList.remove("hidden");
  }
  function closeSettings() {
    els.settingsOverlay.classList.add("hidden");
    cfgEdit = null;
  }
  // Live-refresh the modal (e.g. host (re)connected while it's open) without
  // resetting the active tab. Skips the Config tab — rebuilding its textarea
  // would drop the caret and any unsaved edit.
  function refreshSettingsIfOpen() {
    if (!settingsOpen()) return;
    if (settingsTab === "config") return;
    renderSettings();
  }

  function renderSettings() {
    els.settingsTabs.innerHTML = "";
    for (const t of SETTINGS_TABS) {
      const btn = el("button", "settings-tab" + (t.id === settingsTab ? " active" : ""), t.label);
      btn.addEventListener("click", () => {
        if (settingsTab === t.id) return;
        settingsTab = t.id;
        if (t.id !== "config") cfgEdit = null;
        renderSettings();
      });
      els.settingsTabs.appendChild(btn);
    }
    els.settingsBody.innerHTML = "";
    if (settingsTab === "config") renderSettingsConfig();
    else renderSettingsConnection();
  }

  // ---- config editors (CLAUDE.md / Hooks / MCP) -----------------------------
  function activeCwd() {
    const c = chats.get(activeId);
    return (c && c.cwd) || null;
  }

  // Request a config file from the host; the reply lands in onHostMessage's
  // `configRead` case, which repaints. Starts in a loading state.
  function loadConfig(key, scope) {
    cfgEdit = { key, scope, loading: true, content: "", original: "", path: "", exists: false, error: "", status: "", statusKind: "", saving: false };
    if (!post({ type: "configRead", id: activeId, key, scope, cwd: activeCwd() })) {
      cfgEdit.loading = false;
      cfgEdit.error = "Host disconnected — can't read the file.";
    }
    renderSettings();
  }

  function saveConfig() {
    if (!cfgEdit || cfgEdit.saving) return;
    cfgEdit.saving = true;
    cfgEdit.error = "";
    cfgEdit.status = "Saving…";
    cfgEdit.statusKind = "dim";
    const { key, scope, content } = cfgEdit;
    if (!post({ type: "configWrite", id: activeId, key, scope, cwd: activeCwd(), content })) {
      cfgEdit.saving = false;
      cfgEdit.status = "";
      cfgEdit.error = "Host disconnected — not saved.";
    }
    renderSettings();
  }

  function renderSettingsConfig() {
    const meta = CONFIG_META[cfgKey];
    const sec = el("div", "settings-section");

    // Segmented control choosing which file/view to show. Switching discards
    // the current file's unsaved edits (same as leaving the tab).
    const files = el("div", "settings-filepick");
    for (const k of CONFIG_FILES) {
      const b = el("button", "settings-filepick-btn" + (k === cfgKey ? " active" : ""), CONFIG_META[k].label);
      b.addEventListener("click", () => {
        if (k === cfgKey) return;
        cfgKey = k;
        if (CONFIG_META[k].readonly) {
          cfgEdit = null;
          renderSettings();
        } else {
          loadConfig(k, (cfgEdit && cfgEdit.scope) || "project");
        }
      });
      files.appendChild(b);
    }
    sec.appendChild(files);

    // Read-only view (Skills): no file, scope, or editor — just a list.
    if (meta.readonly) {
      sec.appendChild(el("div", "settings-blurb", meta.blurb));
      renderSkillsList(sec);
      els.settingsBody.appendChild(sec);
      return;
    }

    // First open (or a stale editor from another file): kick off a load;
    // loadConfig() re-renders (repainting this whole section) once the request
    // is in flight, so there's nothing to append here yet.
    if (!cfgEdit || cfgEdit.key !== cfgKey) {
      loadConfig(cfgKey, "project");
      return;
    }

    sec.appendChild(el("div", "settings-blurb", meta.blurb));

    // Project / User scope toggle.
    const toggle = el("div", "settings-scope");
    for (const sc of ["project", "user"]) {
      const b = el("button", "settings-scope-btn" + (cfgEdit.scope === sc ? " active" : ""), sc === "project" ? "Project" : "User");
      b.addEventListener("click", () => {
        if (cfgEdit.scope !== sc) loadConfig(cfgKey, sc);
      });
      toggle.appendChild(b);
    }
    sec.appendChild(toggle);
    sec.appendChild(el("div", "settings-path", cfgEdit.scope === "project" ? meta.project : meta.user));
    // These files are read by claude at session start, not mid-turn.
    sec.appendChild(el("div", "settings-note", "Applies to new or restarted chats."));

    if (cfgEdit.loading) {
      sec.appendChild(el("div", "settings-loading", "Loading…"));
      els.settingsBody.appendChild(sec);
      return;
    }

    // Plugins: an on/off list of installed plugins instead of a raw editor.
    if (meta.toggles) {
      renderPluginToggles(sec);
      els.settingsBody.appendChild(sec);
      return;
    }

    const ta = el("textarea", "settings-editor" + (meta.format === "json" ? " mono" : ""));
    ta.value = cfgEdit.content;
    ta.placeholder = meta.placeholder;
    ta.spellcheck = false;
    sec.appendChild(ta);

    const actions = el("div", "settings-actions");
    const save = el("button", "settings-save-btn", "Save");
    const dirty = () => cfgEdit.content !== cfgEdit.original;
    save.disabled = !dirty() || cfgEdit.saving;
    save.addEventListener("click", saveConfig);
    actions.appendChild(save);

    const revert = el("button", "settings-revert-btn", "Revert");
    revert.addEventListener("click", () => {
      cfgEdit.content = cfgEdit.original;
      cfgEdit.status = "";
      cfgEdit.error = "";
      renderSettings();
    });
    actions.appendChild(revert);

    const msg = el("span", "settings-msg");
    actions.appendChild(msg);
    const paintMsg = () => {
      msg.className = "settings-msg";
      if (cfgEdit.error) {
        msg.classList.add("bad");
        msg.textContent = cfgEdit.error;
      } else if (cfgEdit.status) {
        if (cfgEdit.statusKind) msg.classList.add(cfgEdit.statusKind);
        msg.textContent = cfgEdit.status;
      } else if (!cfgEdit.exists) {
        msg.classList.add("dim");
        msg.textContent = "Doesn't exist yet — saving creates it.";
      } else {
        msg.textContent = "";
      }
    };
    paintMsg();

    // Live edits: update state + toggle Save/Revert inline (no full re-render,
    // so the caret and scroll position stay put while typing).
    ta.addEventListener("input", () => {
      cfgEdit.content = ta.value;
      cfgEdit.status = "";
      cfgEdit.error = "";
      save.disabled = !dirty();
      revert.classList.toggle("hidden", !dirty());
      paintMsg();
    });
    revert.classList.toggle("hidden", !dirty());

    sec.appendChild(actions);
    els.settingsBody.appendChild(sec);
  }

  // Read-only, filterable list of the skills available in the active chat
  // (populated by the host's command harvest / the session init event).
  function renderSkillsList(sec) {
    const chat = chats.get(activeId);
    const skills = (chat && Array.isArray(chat.skills) ? chat.skills.slice() : []).sort((a, b) => a.localeCompare(b));
    if (!skills.length) {
      sec.appendChild(el("div", "settings-note", "No skills loaded yet — open or start a chat in this folder first."));
      return;
    }
    const search = el("input", "settings-search-input");
    search.type = "text";
    search.placeholder = "Filter skills";
    search.value = skillsFilter;
    search.spellcheck = false;
    sec.appendChild(search);

    const count = el("div", "settings-note");
    sec.appendChild(count);
    const list = el("div", "settings-list");
    const rows = skills.map((s) => {
      const r = el("div", "settings-list-row", s);
      list.appendChild(r);
      return { s, r };
    });
    sec.appendChild(list);

    // Filter in place (toggling row visibility) so the input keeps focus while
    // typing instead of the whole section rebuilding.
    const applyFilter = () => {
      const q = skillsFilter.trim().toLowerCase();
      let n = 0;
      for (const { s, r } of rows) {
        const show = !q || s.toLowerCase().includes(q);
        r.classList.toggle("hidden", !show);
        if (show) n++;
      }
      count.textContent = n + (n === 1 ? " skill" : " skills");
    };
    search.addEventListener("input", () => {
      skillsFilter = search.value;
      applyFilter();
    });
    applyFilter();
  }

  // Plugins as an on/off list. Each installed plugin (plus any entry already in
  // enabledPlugins) gets a switch; flipping it writes the whole enabledPlugins
  // object back through the normal save path. `cfgEdit.content` holds that JSON.
  function renderPluginToggles(sec) {
    let map;
    try {
      map = cfgEdit.content.trim() ? JSON.parse(cfgEdit.content) : {};
      if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("not an object");
    } catch {
      sec.appendChild(el("div", "settings-msg bad", "enabledPlugins isn't a JSON object — fix the file by hand first."));
      return;
    }
    const chat = chats.get(activeId);
    const installed = (chat && Array.isArray(chat.plugins) ? chat.plugins : []).filter((p) => p && p.source);
    const bySource = new Map(installed.map((p) => [p.source, p]));
    const keys = Array.from(new Set([...installed.map((p) => p.source), ...Object.keys(map)])).sort();
    if (!keys.length) {
      sec.appendChild(el("div", "settings-note", "No plugins installed."));
      return;
    }

    const msg = el("div", "settings-msg " + (cfgEdit.statusKind || ""));
    msg.textContent = cfgEdit.error || cfgEdit.status || "";

    const list = el("div", "settings-toggle-list");
    for (const key of keys) {
      const p = bySource.get(key);
      const on = map[key] !== false; // absent or true → on; only explicit false is off
      const row = el("div", "settings-toggle-row");
      const info = el("div", "settings-toggle-info");
      info.appendChild(el("div", "settings-toggle-name", p ? p.name : key.split("@")[0]));
      info.appendChild(el("div", "settings-toggle-sub", p ? key : key + " · not installed"));
      row.appendChild(info);
      const sw = el("button", "settings-switch" + (on ? " on" : ""));
      sw.type = "button";
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", String(on));
      sw.disabled = cfgEdit.saving;
      sw.appendChild(el("span", "settings-switch-knob"));
      sw.addEventListener("click", () => togglePlugin(key, !on));
      row.appendChild(sw);
      list.appendChild(row);
    }
    sec.appendChild(list);
    sec.appendChild(msg);
  }

  // Flip one plugin's enabled state and persist enabledPlugins immediately.
  function togglePlugin(key, on) {
    if (!cfgEdit || cfgEdit.saving) return;
    let map;
    try {
      map = cfgEdit.content.trim() ? JSON.parse(cfgEdit.content) : {};
    } catch {
      return;
    }
    map[key] = on;
    cfgEdit.content = JSON.stringify(map, null, 2);
    cfgEdit.original = cfgEdit.content;
    saveConfig(); // writes + re-renders with a "Saved" flash
  }

  // A read-only key → value line for the Connection tab.
  function settingsKV(key, value) {
    const row = el("div", "settings-kv");
    row.appendChild(el("span", "settings-kv-key", key));
    row.appendChild(el("span", "settings-kv-val", value));
    return row;
  }

  function renderSettingsConnection() {
    const sec = el("div", "settings-section");
    sec.appendChild(el("div", "settings-section-title", "Host connection"));

    // Status as a key → value row (same format as the version rows), with a
    // small colored dot in the value carrying the connected/disconnected cue.
    const ok = connected && hostReady;
    const statusRow = el("div", "settings-kv");
    statusRow.appendChild(el("span", "settings-kv-key", "Native host"));
    const val = el("span", "settings-kv-val settings-kv-status");
    val.appendChild(el("span", "settings-kv-dot " + (ok ? "ok" : "bad")));
    val.appendChild(document.createTextNode(ok ? "Connected" : connected ? "Connecting…" : "Not connected"));
    statusRow.appendChild(val);
    sec.appendChild(statusRow);

    sec.appendChild(settingsKV("Host version", hostVersion ? String(hostVersion) : "—"));
    sec.appendChild(settingsKV("Required version", String(EXPECTED_HOST_VERSION)));
    els.settingsBody.appendChild(sec);
  }

  function syncComposer() {
    if (!mounted) return;
    const chat = chats.get(activeId);
    if (!chat) return;
    const mode = MODES.find((m) => m.id === chat.mode) || MODES[0];
    els.mode.textContent = mode.short || mode.label;
    els.mode.className = "mode-btn " + mode.cls;
    els.mode.title = mode.hint;
    els.folder.querySelector(".folder-label").textContent = folderLabel(chat.cwd);
    els.folder.title = chat.cwd || "Choose a project folder to start";
    // Highlight the chip until a folder is picked — it's required to start.
    els.folder.classList.toggle("needs-folder", !chat.cwd);
    const model = MODELS.find((m) => m.id === chat.model) || MODELS[0];
    els.modelBtn.querySelector(".model-label").textContent = model.label;
    const effort = EFFORTS.find((e) => e.id === chat.effort) || EFFORTS.find((e) => e.id === DEFAULT_EFFORT);
    if (els.effortBtn) els.effortBtn.querySelector(".effort-label").textContent = effort.label;
    setRunningUI(chat.turnRunning);
    syncBashMode(chat);
    renderTurnStatus(chat);
    if (chat.turnRunning) startStatusTicker();
    syncBranch(chat);
    syncGitBar(chat);
    syncTasksDrawer(chat);
    ensurePortProbe(chat);
    renderContextChips();
    renderAttachmentThumbs();
    updateSetup();
  }

  // Reflect the active chat's git branch into the branch chip (hidden when the
  // cwd isn't a git repo).
  function syncBranch(chat) {
    if (!els.branch) return;
    if (chat.isRepo && chat.branch) {
      els.branch.classList.remove("hidden");
      els.branch.querySelector(".branch-label").textContent = chat.branch;
      els.branch.title = `On branch ${chat.branch} — click to switch`;
    } else {
      els.branch.classList.add("hidden");
      if (els.branchMenu) els.branchMenu.classList.add("hidden");
    }
  }

  // ---- git status bar + diff drawer ------------------------------------------
  // Persistent bar (unlike the setup chips, it stays visible once a conversation
  // starts — that's exactly when Claude's edits pile up) showing the branch and
  // a +insertions/-deletions badge whenever the cwd has changes that aren't yet
  // on the remote's default branch (unpushed commits + uncommitted edits).
  // Clicking the badge opens a drawer with the full per-file diff.
  // `skipDrawer` is passed on a task lifecycle tick — the diff hasn't changed,
  // so we refresh the branch/badge/tasks chip but leave the drawer untouched.
  function syncGitBar(chat, skipDrawer) {
    if (!els.gitBar) return;
    const hasChanges = chat.isRepo && chat.diffFiles.length > 0;
    const totals = taskTotals(chat);
    // The bar now doubles as the tasks strip, so it shows whenever there are
    // uncommitted changes OR any subagent / background task has spawned.
    els.gitBar.classList.toggle("hidden", !hasChanges && totals.total === 0);
    // Left label: the branch name in a repo, otherwise the folder name with a
    // folder icon — the bar never shows as an anonymous strip.
    const showBranch = chat.isRepo && !!chat.branch;
    // The bar must always name the branch when the cwd is a repo. If it's
    // visible but the branch is still unknown (restored tab, reply race),
    // ask the host once — the gitBranches reply re-syncs and clears the flag.
    if ((hasChanges || totals.total > 0) && chat.isRepo && !chat.branch && !chat.branchRequested) {
      chat.branchRequested = true;
      requestBranches(chat);
    }
    // Swap the icon only when the mode flips — this runs on every task tick.
    const icName = showBranch ? "git-branch" : "folder";
    if (els.gitBarIc.dataset.ic !== icName) {
      els.gitBarIc.dataset.ic = icName;
      els.gitBarIc.innerHTML = ICON(icName, 12);
    }
    els.gitBarIc.classList.remove("hidden");
    els.gitBarBranch.classList.remove("hidden");
    els.gitBarBranch.textContent = showBranch ? chat.branch : folderLabel(chat.cwd);
    // Diff badge only when there are actual changes.
    els.gitStatusBadge.classList.toggle("hidden", !hasChanges);
    if (hasChanges) {
      els.gitStatAdd.textContent = `+${chat.diffInsertions}`;
      els.gitStatDel.textContent = `-${chat.diffDeletions}`;
    }
    renderTasksChip(chat);
    if (skipDrawer) return;
    if (!hasChanges) {
      chat.diffDrawerOpen = false;
      hideDrawer(false); // no changes → nothing to animate out of
      return;
    }
    // A close animation in flight owns the drawer until it finishes — don't
    // yank it hidden (or re-show it) from under the sink animation.
    if (els.gitDrawer.classList.contains("closing")) return;
    if (chat.diffDrawerOpen) showDrawer(chat, false);
    else hideDrawer(false);
  }

  // ---- tasks chip (right of the diff badge) ---------------------------------
  // Compact counts of live subagents / background commands, mirroring Claude
  // Code's tasks pane. Clicking opens the tasks drawer (below).
  function renderTasksChip(chat) {
    if (!els.tasksWrap) return;
    const t = taskTotals(chat);
    els.tasksWrap.classList.toggle("hidden", t.total === 0);
    if (!t.total) return;
    els.tasksChip.classList.toggle("running", t.running > 0);
    els.tasksChip.innerHTML = "";
    // One fixed icon for every kind of background work; the number counts only
    // what's *running* and is omitted entirely at zero.
    const seg = el("span", "task-seg");
    seg.innerHTML = ICON("stack", 14);
    if (t.running > 0) seg.appendChild(el("span", "task-seg-n", String(t.running)));
    els.tasksChip.appendChild(seg);
    els.tasksChip.title = t.running
      ? `${t.running} running · ${t.total} task${t.total > 1 ? "s" : ""} this session`
      : `${t.total} task${t.total > 1 ? "s" : ""} this session`;
  }

  // ---- tasks drawer (opens like the diff drawer) ----------------------------
  // "Background Tasks & Subagents": Running then Finished, each an activity card
  // matching Claude Code's Background-tasks panel — title, kind + elapsed, and
  // for subagents a live tokens / tool-uses / current-tool line + a link back to
  // where the run streams inline in the transcript.

  // "07s", "58s", "1m 05s", "1h 39m 34s" — zero-padded like the reference panel.
  function taskElapsed(secs) {
    const s = Math.max(0, Math.floor(secs));
    if (s < 60) return String(s).padStart(2, "0") + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
  }
  function taskTokens(n) {
    if (n < 1000) return String(n);
    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  }

  // Open a URL in a real browser tab (extension side panels can't navigate).
  function openExternal(url) {
    try { chrome.tabs.create({ url }); }
    catch (_) { window.open(url, "_blank"); }
  }

  function buildTaskCard(chat, item) {
    const card = el("div", "task-card " + item.status);
    const top = el("div", "task-card-top");
    top.appendChild(el("div", "task-card-title", item.label));
    // Stop affordance while running.
    if (item.status === "running") {
      const stop = el("button", "task-card-stop");
      stop.innerHTML = ICON("stop", 12);
      stop.title = "Stop";
      stop.disabled = !!item.stopping;
      stop.addEventListener("click", (e) => { e.stopPropagation(); stopTask(chat, item); });
      top.appendChild(stop);
    }
    card.appendChild(top);

    const now = Date.now();
    const secs = ((item.status === "running" ? now : item.completedAt || now) - item.startedAt) / 1000;
    // Bottom line: kind · status · how long it took. A background command that's
    // a dev server reads as "Preview" (like the preview MCP), not "Bash".
    const isPreview = item.kind === "preview" || item.isServer;
    const kindLabel = item.kind === "agent" ? "Agent" : isPreview ? "Preview" : "Bash";
    const stopping = item.status === "running" && item.stopping;
    const statusText = item.status === "running"
      ? (stopping ? "Stopping…" : "Running")
      : item.status === "error" ? "Failed" : "Completed";
    const meta = el("div", "task-card-meta");
    meta.appendChild(el("span", "task-card-kind", kindLabel));
    meta.appendChild(el("span", "task-card-status " + (stopping ? "stopping" : item.status), statusText));
    meta.appendChild(el("span", "task-card-time", taskElapsed(secs)));
    card.appendChild(meta);

    if (item.kind === "agent") {
      const bits = [];
      const tokens = (item.inTokens || 0) + (item.outTokens || 0);
      if (tokens) bits.push(taskTokens(tokens) + " tokens");
      if (item.toolUses) bits.push(item.toolUses + " tool use" + (item.toolUses > 1 ? "s" : ""));
      if (item.status === "running" && item.lastTool) bits.push(item.lastTool);
      const stats = el("div", "task-card-stats");
      if (bits.length) stats.appendChild(el("span", "task-card-stat", bits.join("  ·  ")));
      // Open this subagent's captured transcript in the drawer's transcript view.
      if (item.msgs && item.msgs.size) {
        const link = el("button", "task-card-link", "View transcript");
        link.addEventListener("click", (e) => {
          e.stopPropagation();
          chat.tasksView = "transcript";
          chat.transcriptAgentId = item.id;
          els.tasksDrawerBody.scrollTop = 0;
          renderTasksDrawer(chat);
        });
        stats.appendChild(link);
      }
      if (stats.childNodes.length) card.appendChild(stats);
    } else if (isPreview && item.url) {
      // The served address — click to open it in a browser tab.
      const stats = el("div", "task-card-stats");
      const link = el("button", "task-card-url", item.url);
      link.type = "button";
      link.title = "Open http://" + item.url;
      link.addEventListener("click", (e) => { e.stopPropagation(); openExternal("http://" + item.url); });
      stats.appendChild(link);
      card.appendChild(stats);
    }
    return card;
  }

  function renderTasksDrawer(chat) {
    const body = els.tasksDrawerBody;
    if (!body) return;
    // Transcript view: one subagent's captured messages, with a back button.
    const agent = chat.tasksView === "transcript" && chat.agents.get(chat.transcriptAgentId);
    if (chat.tasksView === "transcript" && !agent) { chat.tasksView = "list"; chat.transcriptAgentId = null; }
    els.tasksDrawerBack.classList.toggle("hidden", chat.tasksView !== "transcript");
    els.tasksDrawer.classList.toggle("in-transcript", chat.tasksView === "transcript");
    els.tasksDrawerTitle.textContent = agent ? (agent.label || "Subagent") : "Background tasks";
    if (agent) { renderAgentTranscript(chat, agent, body); return; }

    body.innerHTML = "";
    const all = [...sortedTasks(chat.agents), ...sortedTasks(chat.bgTasks), ...sortedTasks(chat.previews)];
    const running = all.filter((t) => t.status === "running").sort((a, b) => a.startedAt - b.startedAt);
    const finished = all.filter((t) => t.status !== "running").sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    if (!all.length) {
      body.appendChild(el("div", "task-empty", "No tasks yet."));
      return;
    }
    if (running.length) {
      body.appendChild(el("div", "task-section", "Running"));
      for (const item of running) body.appendChild(buildTaskCard(chat, item));
    }
    if (finished.length) {
      // Finished is collapsible (it only grows over a session) with a Clear
      // action, mirroring the reference panel's "Finished N ⌄ … Clear" row.
      const collapsed = chat.tasksFinishedCollapsed;
      const head = el("div", "task-section finished-head" + (collapsed ? " collapsed" : ""));
      const toggle = el("button", "finished-toggle");
      toggle.appendChild(el("span", "finished-label", "Finished"));
      toggle.appendChild(el("span", "finished-count", String(finished.length)));
      const caret = el("span", "task-section-caret");
      caret.innerHTML = ICON("caret-down", 12);
      toggle.appendChild(caret);
      toggle.addEventListener("click", () => {
        chat.tasksFinishedCollapsed = !chat.tasksFinishedCollapsed;
        renderTasksDrawer(chat);
      });
      head.appendChild(toggle);
      const clear = el("button", "finished-clear", "Clear");
      clear.addEventListener("click", (e) => { e.stopPropagation(); clearFinishedTasks(chat); });
      head.appendChild(clear);
      body.appendChild(head);
      if (!collapsed) for (const item of finished) body.appendChild(buildTaskCard(chat, item));
    }
  }

  // Stop a running task. Background commands / dev servers run as descendants of
  // this session's claude, so the host kills that shell's process subtree
  // directly (see killShell there) — surgical, no chat message.
  //
  // But if the model is mid-turn it's likely watching this very process; killing
  // it out from under the model makes it notice the "unexpected" death and try to
  // restart / investigate it. So when a turn is running we also interrupt it —
  // silently (no chat message), which stops the model AND tears down the shell.
  // Idle sessions get the surgical kill only.
  function stopTask(chat, item) {
    if (item.stopping) return;
    if (item.kind === "agent") { interrupt(); return; }
    item.stopping = true;
    syncTasks(chat); // reflect "Stopping…" immediately

    if (chat.turnRunning) {
      // Interrupt kills + resumes the claude process, which tears down its child
      // shells (this task included) and stops the model from reacting to the kill.
      interrupt();
      clearTimeout(item._stopTimer);
      item._stopTimer = setTimeout(() => { finishTask(item, "done"); syncTasks(chat); }, 400);
      return;
    }

    const port = item.url && /:(\d+)\b/.exec(item.url);
    const ok = post({
      type: "killShell",
      id: chat.id,
      taskId: item.id,
      shellId: item.shellId || null,
      command: item.command || "", // empty for preview MCP tasks → host matches by port only
      port: port ? port[1] : null,
    });
    if (!ok) { item.stopping = false; syncTasks(chat); return; } // host unreachable
    // Safety net: a host that doesn't know killShell (not updated yet) never
    // replies — don't hang in "Stopping…" forever.
    clearTimeout(item._stopTimer);
    item._stopTimer = setTimeout(() => {
      if (item.status === "running" && item.stopping) {
        item.stopping = false;
        syncTasks(chat);
        systemNote(chat, "Couldn't stop the task — the host may be outdated. Reload to update it.", "warn");
      }
    }, 6000);
  }

  // Host reply to killShell: the shell's process tree was (or wasn't) killed.
  function onShellKilled(msg) {
    const chat = msg.id && chats.get(msg.id);
    if (!chat) return;
    const item = (msg.taskId && chat.bgTasks.get(msg.taskId)) || (msg.taskId && chat.previews.get(msg.taskId));
    if (!item) return;
    clearTimeout(item._stopTimer);
    if (msg.ok) finishTask(item, "done");
    else item.stopping = false; // couldn't find it — let the user try again
    syncTasks(chat);
  }

  // Proactively learn a dev server's port: while a server task runs without a URL,
  // poll the host (which reads the real listening port from the OS via lsof) every
  // few seconds until it answers — so `npm run dev` still shows its link even when
  // the port isn't in the command and the model never read the server's output.
  let portProbeTimer = null;
  function needsPortProbe(chat) {
    return !!chat && [...chat.bgTasks.values()].some((t) => t.status === "running" && t.isServer && !t.url);
  }
  function ensurePortProbe(chat) {
    if (portProbeTimer || chat.id !== activeId || !needsPortProbe(chat)) return;
    portProbeTick();
    portProbeTimer = setInterval(portProbeTick, 2500);
  }
  function portProbeTick() {
    const chat = chats.get(activeId);
    if (!needsPortProbe(chat)) { clearInterval(portProbeTimer); portProbeTimer = null; return; }
    for (const t of chat.bgTasks.values()) {
      if (t.status === "running" && t.isServer && !t.url) {
        post({ type: "probeShellPort", id: chat.id, taskId: t.id, command: t.command || t.label || "" });
      }
    }
  }
  function onShellPort(msg) {
    const chat = msg.id && chats.get(msg.id);
    if (!chat || !msg.port) return;
    const item = chat.bgTasks.get(msg.taskId);
    if (item && !item.url) { item.url = "localhost:" + msg.port; item.isServer = true; syncTasks(chat); }
  }

  // Drop every finished task (running ones stay), forgetting their shell/server
  // mappings too. If nothing's left, the drawer closes.
  function clearFinishedTasks(chat) {
    const purge = (map) => { for (const [k, v] of map) if (v.status !== "running") map.delete(k); };
    purge(chat.agents); purge(chat.bgTasks); purge(chat.previews);
    for (const [sid, key] of chat.bgShell) if (!chat.bgTasks.has(key)) chat.bgShell.delete(sid);
    for (const [sid, key] of chat.previewServer) if (!chat.previews.has(key)) chat.previewServer.delete(sid);
    if (taskTotals(chat).total === 0) closeTasksDrawer();
    else syncTasks(chat);
  }

  // ---- subagent transcript view --------------------------------------------
  // Renders a subagent's captured messages (text + tool calls with their
  // results) into the drawer body, reusing the main chat's tool-card styling.
  function renderAgentTranscript(chat, agent, body) {
    const atBot = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    body.innerHTML = "";
    let any = false;
    for (const msg of agent.msgs.values()) {
      for (const block of msg.content || []) {
        if (!block) continue;
        if (block.type === "text" && block.text && block.text.trim()) {
          const t = el("div", "agent-tx-text");
          t.appendChild(R.markdown(block.text));
          body.appendChild(t);
          any = true;
        } else if (block.type === "tool_use") {
          body.appendChild(buildAgentToolCard(chat, block, agent.results.get(block.id)));
          any = true;
        }
      }
    }
    if (!any) body.appendChild(el("div", "task-empty", agent.status === "running" ? "Working…" : "No activity captured."));
    if (atBot) body.scrollTop = body.scrollHeight;
  }

  // A single collapsed tool card for the transcript — head (icon · name ·
  // summary) with the result folded underneath, matching the main chat's cards.
  function buildAgentToolCard(chat, block, result) {
    const meta = TOOL_META[block.name] ||
      (block.name && block.name.startsWith("mcp__") ? { icon: "server", label: block.name } : { icon: "code", label: block.name });
    const card = el("div", "tool-card collapsed");
    const head = el("button", "tool-head");
    head.type = "button";
    const ic = el("span", "tool-icon");
    ic.innerHTML = ICON(meta.icon, 14);
    head.appendChild(ic);
    head.appendChild(el("span", "tool-name", meta.label));
    head.appendChild(el("span", "tool-summary", toolSummary(chat, block.name, block.input)));
    const toggle = el("span", "tool-toggle " + (result ? (result.isError ? "err" : "done") : "running"));
    toggle.innerHTML = ICON("caret-down", 14);
    head.appendChild(toggle);
    head.addEventListener("click", () => card.classList.toggle("collapsed"));
    card.appendChild(head);
    const detail = toolDetail(block.name, block.input);
    if (detail) card.appendChild(detail);
    if (result && result.text && result.text.trim()) {
      const resultEl = el("div", "tool-result" + (result.isError ? " err" : ""));
      const lines = result.text.split("\n");
      if (lines.length > 16 || result.text.length > 1400) resultEl.appendChild(el("div", "result-label", `Output · ${lines.length} lines`));
      resultEl.appendChild(R.codeBlock(result.text, ""));
      card.appendChild(resultEl);
    }
    return card;
  }

  // A 1s ticker keeps running tasks' elapsed times live while the drawer is open.
  let tasksTimer = null;
  function startTasksTicker() {
    if (tasksTimer) return;
    tasksTimer = setInterval(() => {
      const chat = chats.get(activeId);
      if (!chat || !chat.tasksDrawerOpen) return stopTasksTicker();
      // Only the list view shows live elapsed times; skip in the transcript view
      // so its scroll / expanded cards aren't reset every second.
      if (chat.tasksView === "list" && taskTotals(chat).running > 0) renderTasksDrawer(chat);
    }, 1000);
  }
  function stopTasksTicker() {
    if (tasksTimer) { clearInterval(tasksTimer); tasksTimer = null; }
  }

  function toggleTasksDrawer() {
    const chat = chats.get(activeId);
    if (!chat) return;
    if (chat.tasksDrawerOpen) closeTasksDrawer();
    else openTasksDrawer(chat);
  }
  function openTasksDrawer(chat) {
    // Both overlays live over the chat stack — only one at a time.
    if (chat.diffDrawerOpen) closeDiffDrawer();
    chat.tasksDrawerOpen = true;
    chat.tasksView = "list"; // always open on the list, not a stale transcript
    chat.transcriptAgentId = null;
    const d = els.tasksDrawer;
    clearTimeout(tasksCloseFallback);
    const wasHidden = d.classList.contains("hidden");
    d.classList.remove("closing", "hidden");
    renderTasksDrawer(chat);
    if (wasHidden) {
      d.classList.remove("opening");
      void d.offsetWidth;
      d.classList.add("opening");
    }
    startTasksTicker();
  }
  let tasksCloseFallback = 0;
  function closeTasksDrawer() {
    const chat = chats.get(activeId);
    if (chat) chat.tasksDrawerOpen = false;
    stopTasksTicker();
    const d = els.tasksDrawer;
    clearTimeout(tasksCloseFallback);
    if (d.classList.contains("hidden")) return;
    d.classList.remove("opening");
    void d.offsetWidth;
    d.classList.add("closing");
    tasksCloseFallback = setTimeout(() => {
      if (d.classList.contains("closing")) {
        d.classList.remove("closing");
        d.classList.add("hidden");
      }
    }, 260);
  }

  function toggleDiffDrawer() {
    const chat = chats.get(activeId);
    if (!chat) return;
    if (chat.diffDrawerOpen) closeDiffDrawer();
    else {
      if (chat.tasksDrawerOpen) closeTasksDrawer(); // one overlay at a time
      chat.diffDrawerOpen = true;
      showDrawer(chat, true);
    }
  }

  // Instantly reflect the active chat's tasks-drawer state (no animation) —
  // called on tab switch so the shared drawer node follows the active chat.
  function syncTasksDrawer(chat) {
    const d = els.tasksDrawer;
    if (!d) return;
    if (chat.tasksDrawerOpen && taskTotals(chat).total > 0) {
      clearTimeout(tasksCloseFallback);
      d.classList.remove("closing", "hidden", "opening");
      renderTasksDrawer(chat);
      startTasksTicker();
    } else {
      chat.tasksDrawerOpen = false;
      stopTasksTicker();
      d.classList.remove("opening", "closing");
      d.classList.add("hidden");
    }
  }

  function closeDiffDrawer() {
    const chat = chats.get(activeId);
    if (!chat) return;
    chat.diffDrawerOpen = false;
    hideDrawer(true);
  }

  // Show/hide the drawer, optionally animated. Open rises out of the flap;
  // close sinks back down into it (drawer-rise / drawer-sink in panel.css).
  // The sink's end is finished by the animationend handler wired in mount().
  function showDrawer(chat, animated) {
    const d = els.gitDrawer;
    clearTimeout(diffCloseFallback);
    const wasHidden = d.classList.contains("hidden");
    d.classList.remove("closing", "hidden");
    renderDiffDrawer(chat);
    if (animated && wasHidden) {
      d.classList.remove("opening");
      void d.offsetWidth; // restart the keyframes if reopened quickly
      d.classList.add("opening");
    }
  }

  let diffCloseFallback = 0;
  function hideDrawer(animated) {
    const d = els.gitDrawer;
    clearTimeout(diffCloseFallback);
    if (d.classList.contains("hidden")) return;
    if (animated) {
      d.classList.remove("opening");
      void d.offsetWidth;
      d.classList.add("closing");
      // Safety net: if animationend never lands (interrupted, no compositor,
      // reduced motion), still hide so the transparent overlay can't linger
      // over the chat and eat clicks.
      diffCloseFallback = setTimeout(() => {
        if (d.classList.contains("closing")) {
          d.classList.remove("closing");
          d.classList.add("hidden");
        }
      }, 260);
    } else {
      d.classList.remove("opening", "closing");
      d.classList.add("hidden");
    }
  }

  // Renders file headers synchronously (cheap), then fills in the heavy diff
  // bodies after the first paint, in time-budgeted chunks across animation
  // frames. Building thousands of line rows up front would block that first
  // frame and stall the drawer's rise animation — the delay the user saw.
  // A generation counter cancels an in-flight fill when the drawer re-renders.
  let diffFillGen = 0;
  function renderDiffDrawer(chat) {
    diffFillGen++;
    els.gitDrawerBody.innerHTML = "";
    const holders = [];
    for (const file of chat.diffFiles) holders.push(buildFileSection(chat, file));
    scheduleBodyFill(holders, diffFillGen);
  }

  function scheduleBodyFill(holders, gen) {
    let i = 0;
    const step = () => {
      if (gen !== diffFillGen) return; // a newer render superseded this fill
      const budgetEnd = performance.now() + 8; // ~half a 60fps frame
      while (i < holders.length && performance.now() < budgetEnd) holders[i++]._buildBody();
      if (i < holders.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Appends a file's section (header now, body on demand) to the drawer and
  // returns the body holder — its ._buildBody() fills the diff lines lazily.
  function buildFileSection(chat, file) {
    const collapsed = chat.diffCollapsedFiles.has(file.path);
    const section = el("div", "diff-file" + (collapsed ? " collapsed" : ""));

    const head = el("div", "diff-file-head");
    const toggle = el("span", "diff-file-toggle");
    toggle.innerHTML = ICON("caret-down", 12);
    head.appendChild(toggle);
    head.appendChild(el("span", "diff-file-path", file.path));
    head.appendChild(el("span", "diff-file-add", `+${file.insertions}`));
    head.appendChild(el("span", "diff-file-del", `-${file.deletions}`));
    section.appendChild(head);

    const holder = el("div", "diff-file-bodyholder");
    section.appendChild(holder);
    holder._buildBody = () => {
      if (holder._built) return;
      holder._built = true;
      if (file.binary) holder.appendChild(el("div", "diff-file-binary", "Binary file not shown"));
      else if (!file.diff) holder.appendChild(el("div", "diff-file-binary", "No content changes"));
      else holder.appendChild(buildDiffBody(file.diff));
    };

    head.addEventListener("click", () => {
      const nowCollapsed = section.classList.toggle("collapsed");
      if (nowCollapsed) chat.diffCollapsedFiles.add(file.path);
      else {
        chat.diffCollapsedFiles.delete(file.path);
        holder._buildBody(); // in case the async fill hasn't reached it yet
      }
    });

    els.gitDrawerBody.appendChild(section);
    return holder;
  }

  // Parses a `git diff --unified=100000` hunk body into per-line rows with the
  // old/new line numbers git reports, so the drawer can show real gutters.
  function parseDiffRows(diffText) {
    const rows = [];
    let oldNo = 0;
    let newNo = 0;
    for (const l of String(diffText || "").split("\n")) {
      if (l.startsWith("@@")) {
        const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) {
          oldNo = parseInt(m[1], 10);
          newNo = parseInt(m[2], 10);
        }
        continue;
      }
      if (l.startsWith("+")) rows.push({ type: "add", oldNo: null, newNo: newNo++, text: l.slice(1) });
      else if (l.startsWith("-")) rows.push({ type: "del", oldNo: oldNo++, newNo: null, text: l.slice(1) });
      else rows.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: l.slice(1) });
    }
    return rows;
  }

  // When a run of deletions is immediately followed by an equally long run of
  // additions, pair them line-by-line and mark the changed middle of each pair
  // (common prefix/suffix trim), so the drawer can tint just the edited words —
  // but only when the pair is mostly identical; on dissimilar lines the row
  // tint already says everything and a whole-line highlight would be noise.
  function markWordDiffs(rows) {
    let i = 0;
    while (i < rows.length) {
      if (rows[i].type !== "del") { i++; continue; }
      let dEnd = i;
      while (dEnd < rows.length && rows[dEnd].type === "del") dEnd++;
      let aEnd = dEnd;
      while (aEnd < rows.length && rows[aEnd].type === "add") aEnd++;
      if (aEnd - dEnd === dEnd - i) {
        for (let k = 0; k < dEnd - i; k++) pairWordDiff(rows[i + k], rows[dEnd + k]);
      }
      i = aEnd;
    }
  }

  // Token-level LCS between the two lines, so each changed word gets its own
  // highlight range (`lizard-code` → `lizard-studio` tints just `code` and
  // `studio`, twice if it appears twice) instead of one prefix-to-suffix blob.
  function pairWordDiff(d, a) {
    const xt = (d.text || "").match(/\s+|\w+|[^\s\w]/g) || [];
    const yt = (a.text || "").match(/\s+|\w+|[^\s\w]/g) || [];
    const n = xt.length;
    const m = yt.length;
    if (!n || !m || n > 300 || m > 300) return;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = xt[i] === yt[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    if ((2 * dp[0][0]) / (n + m) < 0.5) return; // mostly different — the row tint is enough
    const dr = [];
    const ar = [];
    const push = (list, s, e) => {
      if (list.length && list[list.length - 1][1] === s) list[list.length - 1][1] = e;
      else list.push([s, e]);
    };
    let i = 0;
    let j = 0;
    let xo = 0;
    let yo = 0;
    while (i < n && j < m) {
      if (xt[i] === yt[j]) {
        xo += xt[i++].length;
        yo += yt[j++].length;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        push(dr, xo, xo + xt[i].length);
        xo += xt[i++].length;
      } else {
        push(ar, yo, yo + yt[j].length);
        yo += yt[j++].length;
      }
    }
    while (i < n) { push(dr, xo, xo + xt[i].length); xo += xt[i++].length; }
    while (j < m) { push(ar, yo, yo + yt[j].length); yo += yt[j++].length; }
    if (dr.length) d.hl = dr;
    if (ar.length) a.hl = ar;
  }

  // Long runs of unchanged context lines collapse into a "N unmodified lines"
  // bar (click to unfold in place) — short runs (the usual 1-2 line gap between
  // two nearby edits) just render inline, matching how the screenshot reads.
  const DIFF_COLLAPSE_THRESHOLD = 3;
  function buildDiffBody(diffText) {
    const rows = parseDiffRows(diffText);
    markWordDiffs(rows);
    const body = el("div", "diff-file-body");
    let i = 0;
    while (i < rows.length) {
      if (rows[i].type === "ctx") {
        let j = i;
        while (j < rows.length && rows[j].type === "ctx") j++;
        const run = rows.slice(i, j);
        if (run.length >= DIFF_COLLAPSE_THRESHOLD) {
          const wrap = el("div", "diff-ctx-run collapsed");
          const bar = el("div", "diff-collapsed-bar");
          const ic = el("span", "diff-collapsed-ic");
          ic.innerHTML = ICON("caret-down", 12);
          bar.appendChild(ic);
          bar.appendChild(document.createTextNode(`${run.length} unmodified line${run.length === 1 ? "" : "s"}`));
          bar.addEventListener("click", () => wrap.classList.toggle("collapsed"));
          wrap.appendChild(bar);
          const lines = el("div", "diff-ctx-lines");
          for (const r of run) lines.appendChild(diffLineRow(r));
          wrap.appendChild(lines);
          body.appendChild(wrap);
        } else {
          for (const r of run) body.appendChild(diffLineRow(r));
        }
        i = j;
      } else {
        body.appendChild(diffLineRow(rows[i]));
        i++;
      }
    }
    return body;
  }

  // One gutter number per row (like the reference): the old line number for
  // deletions, the new one for everything else. Color carries the +/- meaning
  // — no sign column.
  function diffLineRow(r) {
    const row = el("div", "diff-line diff-line-" + r.type);
    const no = r.type === "del" ? r.oldNo : r.newNo;
    row.appendChild(el("span", "diff-lineno", no != null ? String(no) : ""));
    const code = el("span", "diff-code");
    if (r.hl) {
      const cls = r.type === "add" ? "diff-word-add" : "diff-word-del";
      let pos = 0;
      for (const [s, e] of r.hl) {
        if (s > pos) code.appendChild(document.createTextNode(r.text.slice(pos, s)));
        code.appendChild(el("span", cls, r.text.slice(s, e)));
        pos = e;
      }
      if (pos < r.text.length) code.appendChild(document.createTextNode(r.text.slice(pos)));
    } else {
      code.textContent = r.text;
    }
    row.appendChild(code);
    return row;
  }

  // The setup chips (folder/branch) only make sense before a conversation
  // begins — once the active chat has any messages, fold them away.
  function updateSetup() {
    if (!els.setup) return;
    const chat = chats.get(activeId);
    els.setup.classList.toggle("hidden", !(chat && chat.empty));
  }

  // ---- git branch chip ------------------------------------------------------
  // Ask the host for the branch list + current branch of a chat's working dir.
  function requestBranches(chat) {
    if (chat && chat.cwd) post({ type: "gitBranches", id: chat.id, cwd: chat.cwd });
  }

  // ---- git status bar + diff drawer ------------------------------------------
  // Ask the host for the working-tree diff vs HEAD (+ untracked files), so the
  // status bar can show a +insertions/-deletions badge and the drawer can render
  // the actual per-file diff. Refreshed on session start/folder change and after
  // every turn ends (see endTurn) — that's when Claude's edits actually land.
  function requestGitDiff(chat) {
    if (chat && chat.cwd) post({ type: "gitDiff", id: chat.id, cwd: chat.cwd });
  }

  function toggleBranchMenu() {
    if (!els.branchMenu) return;
    if (!els.branchMenu.classList.contains("hidden")) {
      els.branchMenu.classList.add("hidden");
      return;
    }
    renderBranchMenu();
    els.branchMenu.classList.remove("hidden");
  }

  function renderBranchMenu() {
    const chat = chats.get(activeId);
    els.branchMenu.innerHTML = "";
    els.branchMenu.appendChild(el("div", "branch-head", "Switch branch"));
    if (!chat || !chat.branches.length) {
      els.branchMenu.appendChild(el("div", "branch-empty", "No other branches."));
      return;
    }
    for (const b of chat.branches) {
      const isCur = b === chat.branch;
      const row = el("div", "branch-item" + (isCur ? " current" : ""));
      const ic = el("span", "branch-item-ic");
      ic.innerHTML = ICON("git-branch", 13);
      row.appendChild(ic);
      row.appendChild(el("span", "branch-item-name", b));
      const chk = el("span", "branch-item-check");
      if (isCur) chk.innerHTML = ICON("check", 13);
      row.appendChild(chk);
      row.addEventListener("click", () => {
        els.branchMenu.classList.add("hidden");
        if (!isCur) chooseBranch(chat, b);
      });
      els.branchMenu.appendChild(row);
    }
  }

  function chooseBranch(chat, branch) {
    if (!chat.cwd) return;
    post({ type: "checkoutBranch", id: chat.id, cwd: chat.cwd, branch });
  }

  // Shared folder-change sequence (native picker reply and the manual prompt
  // fallback): remember the new cwd, reset git state until the host reports
  // back, and restart the session in the new directory. The tab title is left
  // as-is — it comes from the first user message, not the folder name.
  function applyFolder(chat, path) {
    chat.cwd = path;
    rememberCwd(path);
    chat.isRepo = false;
    chat.branch = null;
    chat.branchRequested = false;
    chat.branches = [];
    chat.diffFiles = [];
    chat.diffInsertions = 0;
    chat.diffDeletions = 0;
    chat.diffDrawerOpen = false;
    chat.diffCollapsedFiles.clear();
    savePrefs();
    if (chat.id === activeId) syncComposer();
    resetChatSession(chat);
    requestBranches(chat);
    requestGitDiff(chat);
    renderTabs();
  }

  function promptForFolder(chat) {
    const cur = chat.cwd || home || "";
    const next = window.prompt("Project folder path:", cur);
    if (next && next.trim()) applyFolder(chat, next.trim());
  }

  function autosize() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 200) + "px";
    updateSlashGhost();
  }

  // Ghost placeholder shown after an argument-taking command is picked: the
  // ghost sits behind the transparent textarea (inset:0, matching typography),
  // mirroring the typed "/cmd " in a transparent span so the grey hint lines up
  // right where the caret sits. It's only shown while the input is still the
  // bare "/cmd " — the moment the user types the argument (or clears/sends), it
  // hides. Driven from autosize(), which every value change already funnels
  // through, so there's a single place to keep it in sync.
  function updateSlashGhost() {
    const g = els.slashGhost;
    if (!g) return;
    const want = slash.argCmd && els.input.value === "/" + slash.argCmd + " ";
    if (!want) {
      slash.argCmd = null;
      slash.argHint = "";
      g.classList.add("hidden");
      g.textContent = "";
      return;
    }
    g.textContent = "";
    g.appendChild(el("span", "slash-ghost-pad", els.input.value));
    g.appendChild(el("span", "slash-ghost-hint", slash.argHint));
    g.classList.remove("hidden");
  }

  // ---- slash-command menu ---------------------------------------------------
  // Shown while the input is a single "/token" with no space yet. The command
  // list comes from the active session's init event (slash_commands).
  function updateSlash() {
    const chat = chats.get(activeId);
    const m = /^\/([^\s]*)$/.exec(els.input.value);
    if (!chat || !m) return hideSlash();
    const q = m[1].toLowerCase();
    const items = (chat.slashCommands || []).filter((c) => c.toLowerCase().includes(q));
    if (!items.length) return hideSlash();
    // Prefix matches first, then substring matches.
    items.sort((a, b) => {
      const ap = a.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.localeCompare(b);
    });
    slash.items = items.slice(0, 60);
    slash.index = 0;
    slash.open = true;
    renderSlash();
    els.slashMenu.classList.remove("hidden");
  }

  function renderSlash() {
    els.slashMenu.innerHTML = "";
    slash.items.forEach((c, i) => {
      const row = el("div", "slash-item" + (i === slash.index ? " active" : ""));
      row.appendChild(el("span", "slash-cmd", "/" + c));
      const hint = slashHint(c);
      if (hint) row.appendChild(el("span", "slash-hint", hint));
      row.addEventListener("mouseenter", () => {
        slash.index = i;
        highlightSlash();
      });
      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus in the textarea
        acceptSlash(i, true); // a click runs the command immediately
      });
      els.slashMenu.appendChild(row);
    });
  }

  function highlightSlash() {
    const rows = els.slashMenu.children;
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle("active", i === slash.index);
    const active = rows[slash.index];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function moveSlash(delta) {
    if (!slash.items.length) return;
    slash.index = (slash.index + delta + slash.items.length) % slash.items.length;
    highlightSlash();
  }

  function acceptSlash(i, run) {
    const c = slash.items[i];
    if (c == null) return;
    const hint = slashHint(c);
    if (hint) {
      // The command expects an argument — insert "/cmd " and wait, surfacing
      // the hint as a ghost placeholder, instead of running it bare (a click
      // would otherwise fire it with no argument).
      els.input.value = "/" + c + " ";
      hideSlash();
      slash.argCmd = c;
      slash.argHint = hint;
      els.input.focus();
      autosize();
      return;
    }
    els.input.value = "/" + c + (run ? "" : " ");
    hideSlash();
    if (run) {
      // Clicking an argument-free command fires it right away.
      sendPrompt();
      return;
    }
    els.input.focus();
    autosize();
  }

  function hideSlash() {
    slash.open = false;
    slash.items = [];
    els.slashMenu.classList.add("hidden");
  }

  // ---- composer bash mode ---------------------------------------------------
  // Typing "!" as the first character flips the composer into a local shell
  // prompt (à la Claude Code's REPL): a "bash" pill, a shell placeholder, and
  // the next submit runs the line as a one-off command in the tab's cwd instead
  // of prompting the model (see runBash). Backspace on an empty command leaves.
  const PLACEHOLDER_NORMAL = "Type / for commands";
  const PLACEHOLDER_BASH = "Enter a shell command";

  function enterBashMode(chat) {
    if (!chat || chat.bashMode) return;
    chat.bashMode = true;
    hideSlash();
    syncBashMode(chat);
    els.input.focus();
  }
  function exitBashMode(chat) {
    if (!chat || !chat.bashMode) return;
    chat.bashMode = false;
    syncBashMode(chat);
  }
  // Reflect the active chat's bash-mode flag into the composer chrome. Called on
  // enter/exit and on every tab switch (bashMode is per-chat).
  function syncBashMode(chat) {
    const on = !!(chat && chat.bashMode);
    if (els.composerBox) els.composerBox.classList.toggle("bash-active", on);
    if (els.bashPill) els.bashPill.classList.toggle("hidden", !on);
    if (els.input) els.input.placeholder = on ? PLACEHOLDER_BASH : PLACEHOLDER_NORMAL;
  }

  // ---- onboarding overlay ---------------------------------------------------
  function showOnboarding(detail) {
    if (!mounted) return;
    els.onboarding.classList.remove("hidden");
    if (detail) els.onboardingStatus.textContent = detail;
  }
  function hideOnboarding() {
    if (!mounted) return;
    els.onboarding.classList.add("hidden");
  }

  // ---- mount / lifecycle ----------------------------------------------------
  function mount(root) {
    els.root = root;
    root.innerHTML = TEMPLATE;
    els.tabs = root.querySelector("#chat-tabs");
    els.setup = root.querySelector("#chat-setup");
    els.stack = root.querySelector("#chat-stack");
    els.input = root.querySelector("#composer-input");
    els.contextChips = root.querySelector("#context-chips");
    els.attachThumbs = root.querySelector("#attach-thumbs");
    els.composerBox = root.querySelector(".composer-box");
    els.send = root.querySelector("#send-btn");
    els.stop = root.querySelector("#stop-btn");
    els.folder = root.querySelector("#folder-btn");
    els.branch = root.querySelector("#branch-btn");
    els.branchMenu = root.querySelector("#branch-menu");
    els.modelBtn = root.querySelector("#model-btn");
    els.modelMenu = root.querySelector("#model-menu");
    els.effortBtn = root.querySelector("#effort-btn");
    els.effortMenu = root.querySelector("#effort-menu");
    els.mode = root.querySelector("#mode-btn");
    els.modeMenu = root.querySelector("#mode-menu");
    els.newChat = root.querySelector("#new-chat-btn");
    els.historyBtn = root.querySelector("#history-btn");
    els.historyMenu = root.querySelector("#history-menu");
    els.settingsBtn = root.querySelector("#settings-btn");
    els.settingsOverlay = root.querySelector("#settings-overlay");
    els.settingsClose = root.querySelector("#settings-close");
    els.settingsTabs = root.querySelector("#settings-tabs");
    els.settingsBody = root.querySelector("#settings-body");
    els.slashMenu = root.querySelector("#slash-menu");
    els.slashGhost = root.querySelector("#slash-ghost");
    els.bashPill = root.querySelector("#bash-pill");
    els.onboarding = root.querySelector("#chat-onboarding");
    els.onboardingStatus = root.querySelector("#chat-onboarding-status");
    els.copyInstall = root.querySelector("#chat-copy-install");
    els.attachFileBtn = root.querySelector("#attach-file-btn");
    els.fileInput = root.querySelector("#file-input");
    els.hostBanner = root.querySelector("#host-outdated-banner");
    els.hostBannerText = root.querySelector("#host-outdated-text");
    els.hostBannerCopy = root.querySelector("#host-outdated-copy");
    els.hostBannerIc = root.querySelector("#host-outdated-ic");
    els.gitBar = root.querySelector("#git-status-bar");
    els.gitBarIc = root.querySelector("#git-bar-ic");
    els.gitBarBranch = root.querySelector("#git-bar-branch");
    els.gitStatusBadge = root.querySelector("#git-status-badge");
    els.gitStatAdd = root.querySelector("#git-stat-add");
    els.gitStatDel = root.querySelector("#git-stat-del");
    els.tasksWrap = root.querySelector("#git-tasks");
    els.tasksChip = root.querySelector("#git-tasks-chip");
    els.gitDrawer = root.querySelector("#git-diff-drawer");
    els.gitDrawerBody = root.querySelector("#git-diff-drawer-body");
    els.gitDrawerHead = root.querySelector("#git-diff-drawer-head");
    els.gitDrawerClose = root.querySelector("#git-diff-drawer-close");
    els.tasksDrawer = root.querySelector("#tasks-drawer");
    els.tasksDrawerBody = root.querySelector("#tasks-drawer-body");
    els.tasksDrawerHead = root.querySelector("#tasks-drawer-head");
    els.tasksDrawerClose = root.querySelector("#tasks-drawer-close");
    els.tasksDrawerBack = root.querySelector("#tasks-drawer-back");
    els.tasksDrawerTitle = root.querySelector("#tasks-drawer-title");

    // Static icons.
    root.querySelector("#new-chat-btn").innerHTML = ICON("plus", 17);
    root.querySelector("#history-btn").innerHTML = ICON("history", 17);
    els.settingsBtn.innerHTML = ICON("gear", 17);
    els.settingsClose.innerHTML = ICON("x", 15);
    root.querySelector("#folder-ic").innerHTML = ICON("folder", 14);
    root.querySelector("#branch-ic").innerHTML = ICON("git-branch", 13);
    root.querySelector("#git-bar-ic").innerHTML = ICON("git-branch", 12);
    els.gitDrawerClose.innerHTML = ICON("caret-down", 15);
    els.tasksDrawerClose.innerHTML = ICON("caret-down", 15);
    els.tasksDrawerBack.innerHTML = ICON("caret-left", 16);
    els.hostBannerCopy.innerHTML = ICON("copy", 13);
    wireCopyButton(els.hostBannerCopy, () => els.hostBannerCopy.dataset.cmd, 13);
    els.send.innerHTML = ICON("send", 16);
    els.stop.innerHTML = ICON("stop", 14);
    els.attachFileBtn.innerHTML = ICON("plus", 15);

    els.gitStatusBadge.addEventListener("click", toggleDiffDrawer);
    els.tasksChip.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTasksDrawer();
    });
    // The whole header is the collapse control (title + caret). The back
    // button lives inside it, so stop its clicks from bubbling up to close.
    els.gitDrawerHead.addEventListener("click", closeDiffDrawer);
    els.tasksDrawerHead.addEventListener("click", closeTasksDrawer);
    els.tasksDrawerBack.addEventListener("click", (e) => {
      e.stopPropagation();
      const chat = chats.get(activeId);
      if (!chat) return;
      chat.tasksView = "list";
      chat.transcriptAgentId = null;
      renderTasksDrawer(chat);
    });
    // End of the sink animation → actually hide the drawer (and clean up the
    // one-shot classes). Ignore bubbling animationend from any child element.
    els.gitDrawer.addEventListener("animationend", (e) => {
      if (e.target !== els.gitDrawer) return;
      clearTimeout(diffCloseFallback);
      if (els.gitDrawer.classList.contains("closing")) {
        els.gitDrawer.classList.remove("closing");
        els.gitDrawer.classList.add("hidden");
      }
      els.gitDrawer.classList.remove("opening");
    });
    els.tasksDrawer.addEventListener("animationend", (e) => {
      if (e.target !== els.tasksDrawer) return;
      clearTimeout(tasksCloseFallback);
      if (els.tasksDrawer.classList.contains("closing")) {
        els.tasksDrawer.classList.remove("closing");
        els.tasksDrawer.classList.add("hidden");
      }
      els.tasksDrawer.classList.remove("opening");
    });

    els.send.addEventListener("click", sendPrompt);
    els.stop.addEventListener("click", interrupt);
    els.bashPill.addEventListener("click", () => {
      const chat = chats.get(activeId);
      if (chat) exitBashMode(chat);
      els.input.focus();
    });
    els.attachFileBtn.addEventListener("click", () => els.fileInput.click());
    els.fileInput.addEventListener("change", () => {
      const files = Array.from(els.fileInput.files || []);
      els.fileInput.value = "";
      for (const f of files) addFile(f);
    });
    els.newChat.addEventListener("click", () => createChat({ cwd: defaultCwd() }));
    els.historyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleHistory();
    });
    els.settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSettings();
    });
    els.settingsClose.addEventListener("click", closeSettings);
    // Click the dimmed backdrop (outside the modal) to dismiss.
    els.settingsOverlay.addEventListener("click", (e) => {
      if (e.target === els.settingsOverlay) closeSettings();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.settingsOverlay.classList.contains("hidden")) closeSettings();
    });
    els.folder.addEventListener("click", () => {
      const chat = chats.get(activeId);
      if (chat) post({ type: "pickFolder", id: chat.id }) || promptForFolder(chat);
    });
    els.branch.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBranchMenu();
    });
    els.mode.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleModeMenu();
    });
    els.modelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleModelMenu();
    });
    els.effortBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleEffortMenu();
    });
    // One delegated close-on-outside-click for every dropdown, instead of one
    // permanent document listener per menu. Toggle buttons stopPropagation, so
    // any click that reaches here and is outside a menu closes it.
    const dropdownPairs = [
      [els.historyMenu, els.historyBtn],
      [els.branchMenu, els.branch],
      [els.modeMenu, els.mode],
      [els.modelMenu, els.modelBtn],
      [els.effortMenu, els.effortBtn],
    ];
    document.addEventListener("click", (e) => {
      for (const [menu, btn] of dropdownPairs) {
        if (!menu || menu.classList.contains("hidden")) continue;
        if (menu.contains(e.target) || (btn && btn.contains(e.target))) continue;
        menu.classList.add("hidden");
      }
    });
    els.input.addEventListener("input", () => {
      const chat = chats.get(activeId);
      // "!" as the first character flips into bash mode — consume it so the
      // pill stands in for it (matching Claude Code's REPL) and the command
      // itself is just what follows.
      if (chat && !chat.bashMode && els.input.value[0] === "!") {
        els.input.value = els.input.value.slice(1);
        enterBashMode(chat);
      }
      autosize();
      // The slash menu is a normal-mode affordance; a shell command that happens
      // to start with "/" (e.g. /usr/bin/env) must not trigger it.
      if (chat && chat.bashMode) hideSlash();
      else updateSlash();
    });
    // Paste an image from the clipboard → attach as a thumbnail.
    els.input.addEventListener("paste", (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      let took = false;
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const blob = it.getAsFile();
          if (blob) {
            addAttachment(blob);
            took = true;
          }
        }
      }
      if (took) e.preventDefault(); // don't also paste the image's text/url
    });
    // Drag & drop image files onto the composer.
    if (els.composerBox) {
      els.composerBox.addEventListener("dragover", (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some((i) => i.type.startsWith("image/"))) {
          e.preventDefault();
          els.composerBox.classList.add("drag-over");
        }
      });
      els.composerBox.addEventListener("dragleave", (e) => {
        if (e.target === els.composerBox) els.composerBox.classList.remove("drag-over");
      });
      els.composerBox.addEventListener("drop", (e) => {
        els.composerBox.classList.remove("drag-over");
        const files = (e.dataTransfer && e.dataTransfer.files) || [];
        const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
        if (imgs.length) {
          e.preventDefault();
          imgs.forEach(addAttachment);
        }
      });
    }
    els.input.addEventListener("blur", () => setTimeout(hideSlash, 120));
    els.input.addEventListener("keydown", (e) => {
      // Slash menu captures navigation keys while open.
      if (slash.open) {
        if (e.key === "ArrowDown") { e.preventDefault(); moveSlash(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); moveSlash(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptSlash(slash.index); return; }
        if (e.key === "Escape") { e.preventDefault(); hideSlash(); return; }
      }
      // Backspace on an empty bash-mode command leaves bash mode — the reverse
      // of the "!" that entered it (like deleting past the "!" in Claude Code).
      if (e.key === "Backspace" && els.input.value === "") {
        const chat = chats.get(activeId);
        if (chat && chat.bashMode) {
          e.preventDefault();
          exitBashMode(chat);
          return;
        }
      }
      // Backspace at the very start of an empty-to-the-left caret erases the
      // last attached context chip — like deleting an inline token in Cursor.
      if (e.key === "Backspace" && els.input.selectionStart === 0 && els.input.selectionEnd === 0) {
        const chat = chats.get(activeId);
        if (chat && Array.isArray(chat.contexts) && chat.contexts.length) {
          e.preventDefault();
          removeContext(chat.contexts.length - 1);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        cycleMode();
      }
    });
    if (els.copyInstall) {
      els.copyInstall.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(els.copyInstall.dataset.cmd);
          els.copyInstall.textContent = "Copied!";
          setTimeout(() => (els.copyInstall.textContent = "Copy"), 1500);
        } catch (_) {}
      });
    }

    mounted = true;

    // Restore tabs (or open a first one), then render.
    loadPrefs(() => {
      if (!order.length) {
        const first = makeChat({ cwd: lastCwd });
        chats.set(first.id, first);
        order.push(first.id);
        activeId = first.id;
      }
      for (const id of order) els.stack.appendChild(chats.get(id).messagesEl);
      renderTabs();
      setActive(activeId);
    });
  }

  let started = false;
  function activate() {
    if (!started) {
      started = true;
      connect();
    }
    if (els.input) setTimeout(() => els.input.focus(), 50);
  }
  function deactivate() {
    // Keep the host connection + sessions alive in the background.
  }

  const TEMPLATE = `
    <div class="chat-subbar">
      <div id="chat-tabs" class="chat-tabs"></div>
      <div class="subbar-actions">
        <button id="new-chat-btn" class="icon-btn" title="New chat"></button>
        <button id="history-btn" class="icon-btn" title="Chat history"></button>
        <button id="settings-btn" class="icon-btn" title="Settings"></button>
      </div>
    </div>
    <div id="host-outdated-banner" class="host-outdated-banner hidden">
      <span id="host-outdated-ic" class="host-outdated-ic"></span>
      <div class="host-outdated-body">
        <div id="host-outdated-text" class="host-outdated-text">Host is outdated — run this, then reload the extension:</div>
        <div class="host-outdated-cmd">
          <code id="host-outdated-code">curl -fsSL https://raw.githubusercontent.com/lizard-build/lizard-studio/main/src/host/install.sh | bash</code>
          <button id="host-outdated-copy" class="host-outdated-copy-btn" title="Copy install command" data-cmd="curl -fsSL https://raw.githubusercontent.com/lizard-build/lizard-studio/main/src/host/install.sh | bash"></button>
        </div>
      </div>
    </div>
    <div id="chat-stack" class="chat-stack">
      <!-- Diff drawer: absolutely positioned over the whole chat stack, so
           opening it reads as the flap below expanding up to the top of the
           chat. Hidden entirely when the cwd has no uncommitted changes. -->
      <div id="git-diff-drawer" class="git-diff-drawer hidden">
        <div id="git-diff-drawer-head" class="git-diff-drawer-head" role="button" tabindex="0" title="Collapse">
          <span class="git-diff-drawer-title">Diffs</span>
          <span id="git-diff-drawer-close" class="git-drawer-caret"></span>
        </div>
        <div id="git-diff-drawer-body" class="git-diff-drawer-body"></div>
      </div>
      <!-- Background tasks & subagents drawer: same overlay treatment as the
           diff drawer, opened from the tasks chip. -->
      <div id="tasks-drawer" class="git-diff-drawer tasks-drawer hidden">
        <div id="tasks-drawer-head" class="git-diff-drawer-head" role="button" tabindex="0" title="Collapse">
          <button id="tasks-drawer-back" class="icon-btn tasks-back hidden" title="Back"></button>
          <span id="tasks-drawer-title" class="git-diff-drawer-title">Background tasks</span>
          <span id="tasks-drawer-close" class="git-drawer-caret"></span>
        </div>
        <div id="tasks-drawer-body" class="git-diff-drawer-body tasks-drawer-body"></div>
      </div>
    </div>
    <div class="composer">
      <div id="slash-menu" class="slash-menu hidden"></div>
      <div id="mode-menu" class="mode-menu hidden"></div>
      <!-- Pre-chat setup chips: folder + git branch. Shown only while the
           active chat is empty; hidden once the conversation starts. -->
      <div id="chat-setup" class="chat-setup">
        <button id="folder-btn" class="folder-btn" title="Choose project folder">
          <span id="folder-ic" class="folder-ic"></span>
          <span class="folder-label">~</span>
        </button>
        <button id="branch-btn" class="branch-btn hidden" title="Switch git branch">
          <span id="branch-ic" class="branch-ic"></span>
          <span class="branch-label">main</span>
        </button>
        <div id="branch-menu" class="branch-menu hidden"></div>
      </div>
      <!-- Uncommitted-changes tab: a strokeless flap the same width as the
           composer box, rounded to match its top corners, tucked flush against
           it — reads as sticking out from under the input rather than a
           separate bar (see #git-status-bar + .composer-box in panel.css). -->
      <div id="git-status-bar" class="git-status-bar hidden">
        <span id="git-bar-ic" class="git-bar-ic"></span>
        <span id="git-bar-branch" class="git-bar-branch">main</span>
        <span class="git-bar-spacer"></span>
        <button id="git-status-badge" class="git-status-badge" title="View uncommitted changes">
          <span id="git-stat-add" class="git-stat-add">+0</span><span id="git-stat-del" class="git-stat-del">-0</span>
        </button>
        <!-- Subagents + background commands, mirroring Claude Code's tasks pane.
             Sits to the right of the diff badge; only shown once work spawns.
             Opens the tasks drawer (in #chat-stack). -->
        <div id="git-tasks" class="git-tasks hidden">
          <button id="git-tasks-chip" class="git-tasks-chip" title="Background tasks &amp; subagents"></button>
        </div>
      </div>
      <div class="composer-box">
        <div id="context-chips" class="context-chips hidden"></div>
        <div id="attach-thumbs" class="attach-thumbs hidden"></div>
        <div class="composer-input-wrap">
          <div id="slash-ghost" class="slash-ghost hidden" aria-hidden="true"></div>
          <button id="bash-pill" class="bash-pill hidden" type="button" title="Exit bash mode (Backspace)">bash</button>
          <textarea id="composer-input" class="composer-input" rows="1"
            placeholder="Type / for commands"></textarea>
        </div>
        <div class="composer-toolbar">
          <button id="attach-file-btn" class="icon-btn attach-file-btn" title="Attach a file"></button>
          <input id="file-input" type="file" multiple class="hidden-file-input" />
          <button id="mode-btn" class="mode-btn mode-default" title="Permission mode (Shift+Tab)">Ask</button>
          <span class="composer-spacer"></span>
          <div class="model-picker">
            <button id="model-btn" class="model-btn" title="Model">
              <span class="model-label">Opus 4.8</span>
            </button>
            <div id="model-menu" class="model-menu hidden"></div>
          </div>
          <div class="model-picker">
            <button id="effort-btn" class="model-btn effort-btn" title="Effort">
              <span class="effort-label">Medium</span>
            </button>
            <div id="effort-menu" class="model-menu hidden"></div>
          </div>
          <button id="send-btn" class="send-btn" title="Send"></button>
          <button id="stop-btn" class="stop-btn hidden" title="Interrupt"></button>
        </div>
      </div>
    </div>

    <div id="history-menu" class="history-menu hidden"></div>

    <!-- Settings: a modal overlaying the whole panel, with a tab strip up top.
         Hidden until the gear button (subbar, far left) opens it. -->
    <div id="settings-overlay" class="settings-overlay hidden">
      <div class="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="settings-head">
          <span class="settings-title">Settings</span>
          <button id="settings-close" class="icon-btn" title="Close"></button>
        </div>
        <div id="settings-tabs" class="settings-tabs"></div>
        <div id="settings-body" class="settings-body"></div>
      </div>
    </div>

    <div id="chat-onboarding" class="chat-onboarding hidden">
      <div class="onboarding-card">
        <h2>Connect the Claude Code host</h2>
        <p>The chat drives the real <code>claude</code> CLI through a tiny local helper. Install it once:</p>
        <div class="cmd-row">
          <code>curl -fsSL https://raw.githubusercontent.com/lizard-build/lizard-studio/main/src/host/install.sh | bash</code>
          <button id="chat-copy-install" data-cmd="curl -fsSL https://raw.githubusercontent.com/lizard-build/lizard-studio/main/src/host/install.sh | bash">Copy</button>
        </div>
        <p class="hint">Run it in a terminal, then reload the extension. This panel connects automatically.</p>
        <div class="status"><span class="dot"></span><span id="chat-onboarding-status">Waiting for the helper…</span></div>
      </div>
    </div>
  `;

  // ===========================================================================
  // Live-tab inspection — driven by Claude through the host's browser_* MCP tools.
  // Ops target the active tab by default, or any tab via args.tabId. DOM/text
  // comes from the content script (silent). Console / network / eval use the
  // DevTools Protocol via chrome.debugger — one session per tab (so several tabs
  // can be inspected in parallel), attached on demand and auto-detached when idle
  // (so the "being debugged" banner only shows while in use).
  // ===========================================================================
  const CDP_VERSION = "1.3";
  const CDP_IDLE_MS = 3 * 60 * 1000;
  const cdpSessions = new Map(); // tabId -> { console, network, netMap, refs, waiters, idleTimer }
  // Per-Claude-session (msg.session, the chat id) pinned tab. Resolved once —
  // the first time a browser_* call omits tabId — then reused, so switching the
  // browser's active tab mid-task doesn't retarget calls that still omit tabId.
  // Passing an explicit tabId always re-pins to that tab.
  const pinnedTabBySession = new Map(); // session -> tabId
  let cdpListening = false;
  // In-flight file uploads (browser_upload_file): the MCP relay streams the
  // base64 payload in ~600 KB ops (native messaging caps one message at ~1 MB),
  // reassembled here and handed to the content script on commit.
  const uploads = new Map(); // uploadId -> { name, mime, size, parts, ts }
  let nextUploadId = 1;
  const UPLOAD_TTL_MS = 2 * 60 * 1000;
  function gcUploads() {
    const now = Date.now();
    for (const [id, u] of uploads) if (now - u.ts > UPLOAD_TTL_MS) uploads.delete(id);
  }

  function activeTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const t = tabs && tabs[0];
        if (t && t.id != null) return resolve(t);
        chrome.tabs.query({ active: true, currentWindow: true }, (t2) => resolve((t2 && t2[0]) || null));
      });
    });
  }
  function getTab(tabId) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(tab || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }
  function listTabs() {
    return new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => resolve(tabs || []));
    });
  }
  function sendToTab(tabId, payload) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, payload, (resp) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(resp || { ok: false, error: "no response" });
      });
    });
  }
  function captureTab(windowId) {
    return new Promise((resolve) => {
      chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
        resolve(chrome.runtime.lastError || !dataUrl ? null : dataUrl);
      });
    });
  }
  function dbgSend(tabId, method, params) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
        const e = chrome.runtime.lastError;
        if (e) reject(new Error(e.message));
        else resolve(res);
      });
    });
  }
  function cdpArgToStr(a) {
    if (a == null) return String(a);
    if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
    if (a.unserializableValue) return String(a.unserializableValue);
    if (a.description) return a.description;
    return a.type || "";
  }
  function capBuf(arr, n) {
    if (arr.length > (n || 600)) arr.splice(0, arr.length - (n || 600));
  }
  function resetCdp(tabId) {
    const s = cdpSessions.get(tabId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    cdpSessions.delete(tabId);
  }
  function bumpIdle(tabId) {
    const s = cdpSessions.get(tabId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => detachCdp(tabId), CDP_IDLE_MS);
  }
  function detachCdp(tabId) {
    if (!cdpSessions.has(tabId)) return;
    try {
      chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
    } catch (_) {}
    resetCdp(tabId);
  }
  function detachAllCdp() {
    for (const tabId of Array.from(cdpSessions.keys())) detachCdp(tabId);
  }
  function ensureCdpListeners() {
    if (cdpListening) return;
    cdpListening = true;
    chrome.debugger.onEvent.addListener((source, method, params) => {
      const s = cdpSessions.get(source.tabId);
      if (!s) return;
      if (method === "Runtime.consoleAPICalled") {
        s.console.push({ level: params.type, text: (params.args || []).map(cdpArgToStr).join(" ") });
        capBuf(s.console);
      } else if (method === "Log.entryAdded") {
        const e = params.entry || {};
        s.console.push({ level: e.level, text: e.text, url: e.url });
        capBuf(s.console);
      } else if (method === "Runtime.exceptionThrown") {
        const d = params.exceptionDetails || {};
        s.console.push({ level: "error", text: (d.exception && (d.exception.description || d.exception.value)) || d.text || "uncaught exception" });
        capBuf(s.console);
      } else if (method === "Network.requestWillBeSent") {
        const r = { id: params.requestId, url: params.request.url, method: params.request.method, type: params.type, status: null, mimeType: null, failed: null };
        s.netMap.set(params.requestId, r);
        s.network.push(r);
        capBuf(s.network);
      } else if (method === "Network.responseReceived") {
        const r = s.netMap.get(params.requestId);
        if (r) {
          r.status = params.response.status;
          r.mimeType = params.response.mimeType;
        }
      } else if (method === "Network.loadingFailed") {
        const r = s.netMap.get(params.requestId);
        if (r) r.failed = params.errorText;
      }
      // Wake anyone waiting on this CDP event (e.g. navigation load).
      if (s.waiters.length) {
        const still = [];
        for (const w of s.waiters) {
          if (w.method === method) w.resolve(params);
          else still.push(w);
        }
        s.waiters = still;
      }
    });
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId != null) resetCdp(source.tabId);
    });
  }
  function waitForCdpEvent(tabId, method, timeoutMs) {
    return new Promise((resolve) => {
      const s = cdpSessions.get(tabId);
      if (!s) return resolve(null);
      const w = { method, resolve: (p) => { clearTimeout(t); resolve(p); } };
      const t = setTimeout(() => {
        s.waiters = s.waiters.filter((x) => x !== w);
        resolve(null);
      }, timeoutMs || 15000);
      s.waiters.push(w);
    });
  }
  function ensureAttached(tabId) {
    return new Promise((resolve, reject) => {
      ensureCdpListeners();
      if (cdpSessions.has(tabId)) {
        bumpIdle(tabId);
        return resolve();
      }
      chrome.debugger.attach({ tabId }, CDP_VERSION, async () => {
        const e = chrome.runtime.lastError;
        if (e) return reject(new Error(e.message));
        cdpSessions.set(tabId, { console: [], network: [], netMap: new Map(), refs: new Map(), waiters: [], idleTimer: null });
        try {
          await dbgSend(tabId, "Runtime.enable");
          await dbgSend(tabId, "Log.enable");
          await dbgSend(tabId, "Network.enable");
          await dbgSend(tabId, "Page.enable");
          await dbgSend(tabId, "DOM.enable");
        } catch (_) {}
        bumpIdle(tabId);
        resolve();
      });
    });
  }

  // ---- browser op dispatch ---------------------------------------------------
  // One handler per op, split into three tiers by what they need resolved
  // before running: nothing (GLOBAL_OPS), a target tab (TAB_OPS), or a tab
  // plus an attached DevTools session (CDP_OPS). handleBrowserOp resolves the
  // tier's prerequisites, then dispatches. Handlers return opOk()/opErr().
  const opOk = (data) => ({ ok: true, data });
  const opErr = (error) => ({ ok: false, data: null, error });

  // An explicit tabId always wins and (re-)pins the Claude session to it.
  // Otherwise reuse the tab this session already pinned; only fall back to
  // (and pin) the live active tab if nothing's pinned yet or the pinned tab
  // is gone.
  async function resolveBrowserTab(args, session) {
    if (args.tabId != null) {
      const tab = await getTab(Number(args.tabId));
      if (!tab || tab.id == null) return { error: "No tab with id " + args.tabId + " — call browser_tabs for the current list." };
      if (session) pinnedTabBySession.set(session, tab.id);
      return { tab };
    }
    const pinnedId = session ? pinnedTabBySession.get(session) : null;
    let tab = pinnedId != null ? await getTab(pinnedId) : null;
    if (!tab || tab.id == null) {
      tab = await activeTab();
      if (!tab || tab.id == null) return { error: "No active browser tab." };
      if (session) pinnedTabBySession.set(session, tab.id);
    }
    return { tab };
  }

  const GLOBAL_OPS = {
    async tabs({ session }) {
      const [tabs, current] = await Promise.all([listTabs(), activeTab()]);
      return opOk({
        activeTabId: current ? current.id : null,
        workingTabId: session ? pinnedTabBySession.get(session) ?? null : null,
        tabs: tabs.map((t) => ({ tabId: t.id, windowId: t.windowId, title: t.title, url: t.url, active: !!t.active, pinned: !!t.pinned, audible: !!t.audible })),
      });
    },
    async tab_open({ args, session }) {
      const url = String(args.url || "");
      if (!/^https?:\/\//i.test(url)) return opErr("Provide an absolute http(s) URL.");
      const t = await new Promise((resolve) => {
        chrome.tabs.create({ url, active: args.active !== false }, (nt) => resolve(chrome.runtime.lastError ? null : nt));
      });
      if (!t) return opErr("Couldn't open a new tab.");
      if (session) pinnedTabBySession.set(session, t.id);
      return opOk({ tabId: t.id, windowId: t.windowId, url });
    },
    // File-upload staging (no tab needed until commit).
    async upload_begin({ args }) {
      gcUploads();
      const uploadId = "u" + nextUploadId++;
      uploads.set(uploadId, { name: String(args.name || "file"), mime: String(args.mime || "application/octet-stream"), size: args.size || 0, parts: [], ts: Date.now() });
      return opOk({ uploadId });
    },
    async upload_chunk({ args }) {
      gcUploads(); // expire stale uploads even when no new one ever begins
      const u = uploads.get(args.uploadId);
      if (!u) return opErr("Unknown or expired uploadId — start over with a new browser_upload_file call.");
      u.parts.push(String(args.data || ""));
      u.ts = Date.now();
      return opOk({ received: u.parts.length });
    },
    // Best-effort cleanup from the relay when a chunk/commit failed midway —
    // frees the staged buffer instead of waiting for the gc sweep.
    async upload_abort({ args }) {
      uploads.delete(args.uploadId);
      return opOk({ aborted: true });
    },
  };

  // "Could not establish connection. Receiving end does not exist." (and its
  // siblings) mean the content script isn't in the target tab — the tab was
  // opened before the extension loaded/reloaded, was discarded, or is a page we
  // don't inject into. That's a recoverable condition, not something to surface
  // raw to Claude, so detect it and either fall back to CDP or say it plainly.
  function isNoReceiver(msg) {
    return typeof msg === "string" && /receiving end does not exist|could not establish connection|message port closed/i.test(msg);
  }
  function friendlyTabError(msg) {
    if (!msg || isNoReceiver(msg)) {
      return "Couldn't reach this tab's page helper. Open a normal web page (chrome:// pages and the Chrome Web Store are off-limits) and reload it, then try again.";
    }
    return msg;
  }
  // Runs IN the page via CDP — mirrors core.js's RK_PAGE_CONTEXT reader so
  // browser_dom/info keep working when the content script isn't present. Only
  // references page globals + its two args, so .toString() is safe to inject.
  function pageContextProbe(sel, fmt) {
    var selection = String(window.getSelection ? window.getSelection().toString() : "").trim();
    var root = sel ? document.querySelector(sel) : null;
    if (sel && !root) return { ok: false, error: "No element matched selector: " + sel };
    var base = root || document.body || document.documentElement;
    var out = { ok: true, url: location.href, title: document.title || "", selection: selection.slice(0, 4000) };
    if (fmt === "html") {
      var html = ((root || document.documentElement).outerHTML) || "";
      out.html = html.slice(0, 60000);
      out.truncated = html.length > 60000;
    } else {
      var raw = (base && base.innerText) || "";
      out.text = raw.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 14000);
      out.truncated = raw.length > 14000;
    }
    return out;
  }
  async function pageContextViaCdp(tab, fmt, selector) {
    try {
      await ensureAttached(tab.id);
    } catch (_) {
      return null; // restricted / discarded tab — nothing we can attach to
    }
    const expr = "(" + pageContextProbe.toString() + ")(" + JSON.stringify(selector || null) + "," + JSON.stringify(fmt) + ")";
    try {
      const r = await dbgSend(tab.id, "Runtime.evaluate", { expression: expr, returnByValue: true, timeout: 5000 });
      if (!r || r.exceptionDetails) return null;
      return r.result ? r.result.value : null;
    } catch (_) {
      return null;
    }
  }

  // info and dom share one reader (format decides the payload).
  async function pageContextOp({ op, args, tab }) {
    const format = op === "info" ? "info" : args.format === "html" ? "html" : "text";
    let resp = await sendToTab(tab.id, { type: "RK_PAGE_CONTEXT", format, selector: args.selector });
    // Content script absent → read the page over CDP instead of hard-failing.
    if ((!resp || !resp.ok) && isNoReceiver(resp && resp.error)) {
      const viaCdp = await pageContextViaCdp(tab, format === "html" ? "html" : "text", args.selector);
      if (viaCdp) resp = viaCdp;
    }
    if (!resp || !resp.ok) {
      // A selector that genuinely didn't match is a real answer — keep it;
      // only the connection failure gets the friendly rewrite.
      return opErr(resp && resp.error && !isNoReceiver(resp.error) ? resp.error : friendlyTabError(resp && resp.error));
    }
    if (op === "info") return opOk({ url: resp.url, title: resp.title, selection: resp.selection || "" });
    return opOk({ url: resp.url, title: resp.title, format, content: format === "html" ? resp.html : resp.text, truncated: !!resp.truncated });
  }

  const TAB_OPS = {
    info: pageContextOp,
    dom: pageContextOp,
    async tab_activate({ tab }) {
      await new Promise((resolve) => chrome.tabs.update(tab.id, { active: true }, () => { void chrome.runtime.lastError; resolve(); }));
      await new Promise((resolve) => chrome.windows.update(tab.windowId, { focused: true }, () => { void chrome.runtime.lastError; resolve(); }));
      return opOk({ activated: true, tabId: tab.id, title: tab.title, url: tab.url });
    },
    async tab_close({ args, session, tab }) {
      if (args.tabId == null) return opErr("tabId is required to close a tab.");
      detachCdp(tab.id);
      const closed = await new Promise((resolve) => {
        chrome.tabs.remove(tab.id, () => resolve(!chrome.runtime.lastError));
      });
      if (!closed) return opErr("Couldn't close tab " + tab.id + ".");
      if (session && pinnedTabBySession.get(session) === tab.id) pinnedTabBySession.delete(session);
      return opOk({ closed: true, tabId: tab.id });
    },
    async upload_commit({ args, tab }) {
      const u = uploads.get(args.uploadId);
      if (!u) return opErr("Unknown or expired uploadId — start over with a new browser_upload_file call.");
      uploads.delete(args.uploadId);
      const resp = await sendToTab(tab.id, {
        type: "RK_UPLOAD_FILE",
        selector: args.selector || null,
        name: u.name,
        mime: u.mime,
        b64: u.parts.join(""),
      });
      if (!resp || !resp.ok) {
        // Upload needs the content script (it drives a real file input), so no
        // CDP fallback here — just rewrite the raw connection error.
        return opErr(resp && resp.error && !isNoReceiver(resp.error) ? resp.error : friendlyTabError(resp && resp.error));
      }
      return opOk({ attached: u.name, size: u.size, mime: u.mime, via: resp.via, target: resp.target });
    },
    async screenshot({ tab }) {
      // captureVisibleTab only sees the tab shown in the window — for background
      // tabs (or when that fails) capture via CDP without activating the tab.
      let dataUrl = tab.active ? await captureTab(tab.windowId) : null;
      if (!dataUrl) {
        try {
          await ensureAttached(tab.id);
          const r = await dbgSend(tab.id, "Page.captureScreenshot", { format: "png" });
          if (r && r.data) dataUrl = "data:image/png;base64," + r.data;
        } catch (_) {}
      }
      if (!dataUrl) return opErr("Screenshot failed (tab not capturable).");
      return opOk({ dataUrl });
    },
  };

  const CDP_OPS = {
    async eval({ args, tab }) {
      const r = await dbgSend(tab.id, "Runtime.evaluate", {
        expression: String(args.expression || ""),
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        timeout: 5000,
      });
      if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        return opOk({ error: (d.exception && (d.exception.description || d.exception.value)) || d.text || "evaluation error" });
      }
      const val = r && r.result ? (r.result.value !== undefined ? r.result.value : r.result.description) : null;
      return opOk({ result: val });
    },
    async console({ args, sess }) {
      const limit = Math.max(1, Math.min(args.limit || 100, 500));
      return opOk({
        note: sess.console.length ? undefined : "No console output captured yet — capture began when the tools attached. Call browser_reload (or re-run the code), then call again.",
        entries: sess.console.slice(-limit),
      });
    },
    async network({ args, sess }) {
      const limit = Math.max(1, Math.min(args.limit || 80, 300));
      return opOk({
        note: sess.network.length ? undefined : "No requests captured yet — capture began when the tools attached. Call browser_reload (or re-trigger the request), then call again.",
        requests: sess.network.slice(-limit).map((r) => ({ url: r.url, method: r.method, status: r.status, type: r.type, mimeType: r.mimeType, failed: r.failed || undefined })),
      });
    },
    async snapshot({ args, tab }) {
      const snap = await axSnapshot(tab.id, args.interactiveOnly !== false);
      return opOk(snap);
    },
    async navigate({ args, tab, sess }) {
      const url = String(args.url || "");
      if (!/^https?:\/\//i.test(url)) return opErr("Provide an absolute http(s) URL.");
      const loaded = waitForCdpEvent(tab.id, "Page.loadEventFired", 20000);
      await dbgSend(tab.id, "Page.navigate", { url });
      await loaded;
      const info = await dbgSend(tab.id, "Runtime.evaluate", { expression: "({url:location.href,title:document.title})", returnByValue: true });
      sess.refs.clear();
      return opOk(info && info.result ? info.result.value : { url });
    },
    async reload({ args, tab, sess }) {
      const loaded = waitForCdpEvent(tab.id, "Page.loadEventFired", 20000);
      await dbgSend(tab.id, "Page.reload", { ignoreCache: !!args.hardReload });
      await loaded;
      const info = await dbgSend(tab.id, "Runtime.evaluate", { expression: "({url:location.href,title:document.title})", returnByValue: true });
      sess.refs.clear();
      return opOk(info && info.result ? info.result.value : { reloaded: true });
    },
    async click({ args, tab }) {
      const pt = await targetCenter(tab.id, args);
      if (!pt) return opErr("Target not found (ref/selector didn't resolve or is off-screen).");
      await mouseClick(tab.id, pt.x, pt.y, !!args.double);
      return opOk({ clicked: true, x: Math.round(pt.x), y: Math.round(pt.y) });
    },
    async type({ args, tab }) {
      if (args.ref || args.selector) {
        const ok = await focusTarget(tab.id, args);
        if (!ok) return opErr("Target not found to type into.");
      }
      await dbgSend(tab.id, "Input.insertText", { text: String(args.text || "") });
      if (args.submit) await pressKey(tab.id, "Enter");
      return opOk({ typed: String(args.text || "").length });
    },
    async fill({ args, tab }) {
      const r = await setValue(tab.id, args, String(args.value || ""));
      if (!r) return opErr("Target not found to fill.");
      return opOk({ filled: true });
    },
    async key({ args, tab }) {
      await pressKey(tab.id, String(args.key || ""));
      return opOk({ pressed: args.key });
    },
  };

  async function handleBrowserOp(msg) {
    const op = msg.op;
    const args = msg.args || {};
    const done = (r) => post({ type: "browserResult", bid: msg.bid, ok: r.ok, data: r.data, error: r.error });
    try {
      if (!(chrome.tabs && chrome.tabs.query)) return done(opErr("Browser tab access unavailable."));
      const session = msg.session || null;
      const handler = GLOBAL_OPS[op] || TAB_OPS[op] || CDP_OPS[op];
      if (!handler) return done(opErr("Unknown browser op: " + op));
      const ctx = { op, args, session, tab: null, sess: null };
      if (!GLOBAL_OPS[op]) {
        const r = await resolveBrowserTab(args, session);
        if (r.error) return done(opErr(r.error));
        ctx.tab = r.tab;
        if (CDP_OPS[op]) {
          await ensureAttached(ctx.tab.id);
          bumpIdle(ctx.tab.id);
          ctx.sess = cdpSessions.get(ctx.tab.id);
        }
      }
      done(await handler(ctx));
    } catch (e) {
      done(opErr(String((e && e.message) || e)));
    }
  }

  // ---- CDP action helpers ----------------------------------------------------
  // Resolve a {ref|selector|x,y} target to viewport-center coordinates, scrolling
  // it into view first. Returns {x,y} or null.
  async function targetCenter(tabId, args) {
    if (typeof args.x === "number" && typeof args.y === "number") return { x: args.x, y: args.y };
    const fn =
      "function(){ this.scrollIntoView({block:'center',inline:'center'}); const b=this.getBoundingClientRect(); if(!b.width&&!b.height) return null; return {x:b.left+b.width/2, y:b.top+b.height/2}; }";
    if (args.ref) {
      const objectId = await refToObject(tabId, args.ref);
      if (!objectId) return null;
      const r = await dbgSend(tabId, "Runtime.callFunctionOn", { objectId, functionDeclaration: fn, returnByValue: true });
      return r && r.result ? r.result.value : null;
    }
    if (args.selector) {
      const expr = "(function(){var el=document.querySelector(" + JSON.stringify(args.selector) + "); if(!el) return null; el.scrollIntoView({block:'center',inline:'center'}); var b=el.getBoundingClientRect(); if(!b.width&&!b.height) return null; return {x:b.left+b.width/2,y:b.top+b.height/2};})()";
      const r = await dbgSend(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
      return r && r.result ? r.result.value : null;
    }
    return null;
  }
  async function focusTarget(tabId, args) {
    if (args.ref) {
      const objectId = await refToObject(tabId, args.ref);
      if (!objectId) return false;
      await dbgSend(tabId, "Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){ this.focus(); }" });
      return true;
    }
    if (args.selector) {
      const expr = "(function(){var el=document.querySelector(" + JSON.stringify(args.selector) + "); if(!el) return false; el.focus(); return true;})()";
      const r = await dbgSend(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
      return !!(r && r.result && r.result.value);
    }
    return false;
  }
  async function setValue(tabId, args, value) {
    // One template written against an explicit `el` variable — the ref path
    // binds `el = this` up front, instead of regex-rewriting the source (a
    // .replace(/this/g, "el") would corrupt the code the moment any identifier
    // contained "this" as a substring).
    const body =
      "el.focus(); var proto=Object.getPrototypeOf(el); var d=Object.getOwnPropertyDescriptor(proto,'value'); if(d&&d.set){d.set.call(el,V);}else{el.value=V;} el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true;";
    if (args.ref) {
      const objectId = await refToObject(tabId, args.ref);
      if (!objectId) return false;
      const fn = "function(V){ var el = this; " + body + " }";
      const r = await dbgSend(tabId, "Runtime.callFunctionOn", { objectId, functionDeclaration: fn, arguments: [{ value }], returnByValue: true });
      return !!(r && r.result && r.result.value);
    }
    if (args.selector) {
      const expr = "(function(V){var el=document.querySelector(" + JSON.stringify(args.selector) + "); if(!el) return false; " + body + "})(" + JSON.stringify(value) + ")";
      const r = await dbgSend(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
      return !!(r && r.result && r.result.value);
    }
    return false;
  }
  async function mouseClick(tabId, x, y, dbl) {
    await dbgSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    const press = { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: dbl ? 2 : 1 };
    const release = { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: dbl ? 2 : 1 };
    await dbgSend(tabId, "Input.dispatchMouseEvent", press);
    await dbgSend(tabId, "Input.dispatchMouseEvent", release);
  }
  // Map a ref (@eN) from the tab's last snapshot to a live Runtime object.
  async function refToObject(tabId, ref) {
    const s = cdpSessions.get(tabId);
    const backendNodeId = s && s.refs.get(ref);
    if (!backendNodeId) return null;
    try {
      const r = await dbgSend(tabId, "DOM.resolveNode", { backendNodeId });
      return r && r.object ? r.object.objectId : null;
    } catch (_) {
      return null;
    }
  }
  const KEY_INFO = {
    Enter: { keyCode: 13, code: "Enter", text: "\r" },
    Tab: { keyCode: 9, code: "Tab" },
    Escape: { keyCode: 27, code: "Escape" },
    Backspace: { keyCode: 8, code: "Backspace" },
    Delete: { keyCode: 46, code: "Delete" },
    ArrowUp: { keyCode: 38, code: "ArrowUp" },
    ArrowDown: { keyCode: 40, code: "ArrowDown" },
    ArrowLeft: { keyCode: 37, code: "ArrowLeft" },
    ArrowRight: { keyCode: 39, code: "ArrowRight" },
    Home: { keyCode: 36, code: "Home" },
    End: { keyCode: 35, code: "End" },
    PageUp: { keyCode: 33, code: "PageUp" },
    PageDown: { keyCode: 34, code: "PageDown" },
  };
  const MOD_BITS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 8, Cmd: 8, Command: 8, Shift: 4 };
  async function pressKey(tabId, combo) {
    const parts = String(combo).split("+");
    const main = parts.pop();
    let modifiers = 0;
    for (const p of parts) modifiers |= MOD_BITS[p] || 0;
    const info = KEY_INFO[main] || { keyCode: main.length === 1 ? main.toUpperCase().charCodeAt(0) : 0, code: main.length === 1 ? "Key" + main.toUpperCase() : main };
    const base = { modifiers, key: main, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode };
    await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...base, text: info.text || (main.length === 1 && !modifiers ? main : undefined) });
    await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  // Compact accessibility-tree snapshot with stable @refs (rebuilds the tab's refs).
  async function axSnapshot(tabId, interactiveOnly) {
    try {
      await dbgSend(tabId, "Accessibility.enable");
    } catch (_) {}
    const res = await dbgSend(tabId, "Accessibility.getFullAXTree", {});
    const refs = (cdpSessions.get(tabId) || { refs: new Map() }).refs;
    refs.clear();
    const nodes = (res && res.nodes) || [];
    const lines = [];
    let n = 0;
    const SKIP = new Set(["none", "presentation", "generic", "InlineTextBox", "StaticText", "LineBreak", "paragraph", ""]);
    const INTERESTING = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "menuitem", "tab", "switch", "slider", "option", "listbox", "textarea", "spinbutton"]);
    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role && node.role.value;
      const name = node.name && node.name.value ? String(node.name.value).trim() : "";
      if (!role || SKIP.has(role)) continue;
      if (interactiveOnly && !INTERESTING.has(role)) continue;
      if (!name && interactiveOnly) continue;
      if (node.backendDOMNodeId == null) continue;
      n++;
      const ref = "@e" + n;
      refs.set(ref, node.backendDOMNodeId);
      let line = ref + " " + role;
      if (name) line += ' "' + name.slice(0, 120) + '"';
      const val = node.value && node.value.value;
      if (val != null && String(val).trim()) line += " = " + JSON.stringify(String(val).slice(0, 80));
      lines.push(line);
      if (n >= 400) break;
    }
    return {
      note: lines.length ? "Use these @refs with browser_click / browser_type / browser_fill." : "No labelled interactive elements found; try interactiveOnly:false or browser_dom.",
      elements: lines.join("\n"),
    };
  }

  // Drop all debugger sessions when the panel goes away so the banner never lingers.
  window.addEventListener("beforeunload", detachAllCdp);

  window.RKChat = { mount, activate, deactivate, addContext, addImage };
})();
