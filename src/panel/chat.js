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

  const MODELS = [
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    { id: "claude-fable-5", label: "Fable 5" },
  ];
  const DEFAULT_MODEL = "claude-opus-4-8";

  // Reasoning effort — mirrors the CLI's `--effort <level>` flag.
  const EFFORTS = [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Xhigh" },
    { id: "max", label: "Max" },
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
  };

  const DEFAULT_TITLE = "New chat";

  // Minimum native-host protocol version this panel needs (the host reports
  // its own in `ready`). Keep in sync with HOST_VERSION in host/claude-host.mjs.
  const EXPECTED_HOST_VERSION = 2;

  let els = {};
  let port = null;
  let connected = false;
  let hostReady = false;
  let reconnectTimer = null;
  let mounted = false;
  let home = null;

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
  const slash = { open: false, items: [], index: 0 };

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
            const chat = makeChat({ id: t.id, title: t.title, cwd: t.cwd, model: t.model, effort: t.effort, mode: t.mode, sessionId: t.sessionId });
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
        return { id: c.id, title: c.title, cwd: c.cwd, model: c.model, effort: c.effort, mode: c.mode, sessionId: c.sessionId };
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

  function atBottom(chat) {
    const m = chat.messagesEl;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  }
  function scrollToBottom(chat) {
    chat.messagesEl.scrollTop = chat.messagesEl.scrollHeight;
  }
  function append(chat, node) {
    const stick = atBottom(chat);
    // The running/summary status pill lives at the very bottom of the stream, so
    // new content is inserted *before* it to keep it last (see renderTurnStatus).
    if (chat.statusEl && chat.statusEl.parentNode === chat.messagesEl) {
      chat.messagesEl.insertBefore(node, chat.statusEl);
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
      started: false,
      turnRunning: false,
      turnStatusText: "",
      messagesEl,
      // Status pill node, appended to the end of messagesEl while a turn runs (or
      // a result summary is showing). Lives in the stream, not a pinned bar.
      statusEl: null,
      currentAssistantId: null,
      currentAssistantBody: null,
      toolCards: new Map(),
      emittedToolIds: new Set(),
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
      statusWord: "",
      statusWordAt: 0,
      // Page elements attached via the Selector tool, sent as context with the
      // next prompt, then cleared.
      contexts: [],
      // Images pasted/dropped into the composer, sent as image blocks with the
      // next prompt, then cleared. Each: { id, mediaType, base64, dataUrl }.
      attachments: [],
      empty: !opts.sessionId,
      // Whether this tab's on-disk transcript has been requested/replayed yet.
      // Restored tabs (and history re-opens) carry a sessionId but no messages.
      replayed: false,
      // Git state for the cwd (filled in from the host's gitBranches reply).
      isRepo: false,
      branch: null,
      branches: [],
      // Pending permission asks (can_use_tool): requestId -> { card, opts, … }.
      permCards: new Map(),
      // Set right before sending a bare "/usage" (or "/usage-credits" /
      // "/extra-usage") command; consumed by the next assistant text block to
      // render a progress-bar card instead of the raw CLI text.
      pendingUsageCard: false,
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
      const fresh = makeChat({ cwd: chat.cwd });
      chats.set(fresh.id, fresh);
      order.push(fresh.id);
      els.stack.appendChild(fresh.messagesEl);
      setActive(fresh.id);
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
      tip.appendChild(el("div", "chat-tab-tip-title", chat.title));
      const folderRow = el("div", "chat-tab-tip-row");
      folderRow.innerHTML = ICON("folder", 12);
      folderRow.appendChild(document.createTextNode(shortPath(chat.cwd) || "No folder selected"));
      tip.appendChild(folderRow);
      if (chat.isRepo && chat.branch) {
        const branchRow = el("div", "chat-tab-tip-row");
        branchRow.innerHTML = ICON("git-branch", 11);
        branchRow.appendChild(document.createTextNode(chat.branch));
        tip.appendChild(branchRow);
      }
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
              const node = els.tabs.querySelector(`[data-tab-id="${oid}"]`);
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
  function userBubble(chat, text, attachments) {
    const row = el("div", "msg msg-user");
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
    row.appendChild(bubble);
    append(chat, row);
  }

  // ---- page-element context (from the Selector tool) ------------------------
  // Called from panel.js when the in-page Selector clicks an element. Attaches
  // it to the active chat as a composer chip; sent with the next prompt.
  function addContext(element) {
    if (!element) return;
    const chat = chats.get(activeId);
    if (!chat) return;
    if (!Array.isArray(chat.contexts)) chat.contexts = [];
    // Skip exact duplicates (same selector clicked twice).
    if (!chat.contexts.some((c) => c.selector === element.selector && c.tag === element.tag)) {
      chat.contexts.push(element);
    }
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
      }
      const x = el("button", "ctx-chip-x");
      x.innerHTML = ICON("x", 12);
      x.title = "Remove";
      x.addEventListener("click", (e) => { e.stopPropagation(); removeContext(i); });
      // Icon + × share the leading slot — the × reveals on hover (Cursor-style).
      chip.appendChild(ic);
      chip.appendChild(x);
      chip.appendChild(el("span", "ctx-chip-label", label));
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
        const type = blob.type === "image/png" && scale === 1 ? "image/png" : "image/jpeg";
        const dataUrl = canvas.toDataURL(type, 0.92);
        resolve({ mediaType: type, base64: dataUrl.split(",")[1] || "", dataUrl });
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

  function systemNote(chat, text, kind) {
    const note = el("div", "sys-note" + (kind ? " " + kind : ""));
    if (kind === "warn") {
      const ic = el("span", "sys-ic");
      ic.innerHTML = ICON("warning", 13);
      note.appendChild(ic);
    }
    note.appendChild(el("span", null, text));
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
    append(chat, row);
    chat.currentAssistantBody = body;
    return body;
  }

  function addThinking(chat, body, text) {
    // Thinking/reasoning blocks are intentionally not rendered in the transcript.
    return;
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

  // Visible prose of an assistant message — markdown / live-stream text blocks,
  // minus tool cards and the footer itself. Read at click time so copy reflects
  // the finished message regardless of when the footer was attached.
  function assistantProse(body) {
    let out = "";
    for (const child of body.children) {
      if (!child.classList) continue;
      if (child.classList.contains("tool-card") || child.classList.contains("msg-footer")) continue;
      const t = child.innerText || child.textContent || "";
      if (t) out += (out ? "\n" : "") + t;
    }
    return out.trim();
  }

  function messageFooter(getText, ts) {
    const footer = el("div", "msg-footer");
    const copyBtn = el("button", "msg-action");
    copyBtn.type = "button";
    copyBtn.title = "Copy";
    copyBtn.setAttribute("aria-label", "Copy message");
    copyBtn.innerHTML = ICON("copy", 13);
    copyBtn.addEventListener("click", () => {
      const text = getText();
      if (!text || !navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.classList.add("copied");
        copyBtn.innerHTML = ICON("check", 13);
        setTimeout(() => {
          copyBtn.classList.remove("copied");
          copyBtn.innerHTML = ICON("copy", 13);
        }, 1200);
      }).catch(() => {});
    });
    const time = el("span", "msg-time");
    time.dataset.ts = String(ts);
    time.textContent = relTime(ts);
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

  // One shared timer keeps every relative timestamp fresh — no per-node interval.
  setInterval(() => {
    document.querySelectorAll(".msg-time").forEach((node) => {
      const ts = Number(node.dataset.ts);
      if (ts) node.textContent = relTime(ts);
    });
  }, 20000);

  // ---- live streaming (--include-partial-messages) --------------------------
  // Coalesce markdown re-renders to one per animation frame so a fast token
  // stream doesn't re-parse the whole buffer on every delta.
  function flushStreamBlock(chat, blk) {
    if (blk.raf) return;
    blk.raf = requestAnimationFrame(() => {
      blk.raf = 0;
      blk.el.replaceChildren(R.markdown(blk.buf));
      if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
    });
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
        break;
      }
      case "content_block_start": {
        const body = ensureAssistantBody(chat, chat.streamMsgId);
        const cb = ev.content_block || {};
        if (cb.type === "text") {
          const node = el("div", "assistant-stream streaming");
          body.appendChild(node);
          chat.streamBlocks.set(ev.index, { type: "text", el: node, buf: "", raf: 0 });
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
        flushStreamBlock(chat, blk);
        break;
      }
      case "content_block_stop": {
        const blk = chat.streamBlocks.get(ev.index);
        if (!blk) break;
        if (blk.raf) { cancelAnimationFrame(blk.raf); blk.raf = 0; }
        if (blk.type === "text") {
          blk.el.replaceChildren(R.markdown(blk.buf));
          blk.el.classList.remove("streaming");
          if (!blk.buf.trim()) blk.el.remove();
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

    body.appendChild(card);
    chat.toolCards.set(block.id, { card, resultEl, toggle, name: block.name });
    if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
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
      d.appendChild(R.codeBlock(input.command, "bash"));
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

  function langFromPath(p) {
    if (!p) return "";
    const ext = p.split(".").pop().toLowerCase();
    const map = { js: "js", mjs: "js", ts: "ts", tsx: "ts", jsx: "js", py: "py", rs: "rust", go: "go", json: "json", sh: "bash", css: "css", html: "html", md: "md" };
    return map[ext] || "";
  }

  function fillToolResult(chat, toolUseId, content, isError) {
    const entry = chat.toolCards.get(toolUseId);
    if (!entry) return;
    entry.toggle.classList.remove("running");
    entry.toggle.classList.add("done");
    entry.toggle.classList.toggle("err", !!isError);
    const text = normalizeResult(content);
    if (text.trim()) {
      entry.resultEl.classList.remove("hidden");
      entry.resultEl.classList.toggle("err", !!isError);
      const lines = text.split("\n");
      if (lines.length > 16 || text.length > 1400) {
        const det = el("details", "result-fold");
        const sum = el("summary", null, `Output · ${lines.length} lines`);
        det.appendChild(sum);
        det.appendChild(R.codeBlock(text, ""));
        entry.resultEl.appendChild(det);
      } else {
        entry.resultEl.appendChild(R.codeBlock(text, ""));
      }
    }
    if (chat.id === activeId && atBottom(chat)) scrollToBottom(chat);
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

  function removePermCard(chat, requestId) {
    const entry = chat.permCards.get(requestId);
    if (!entry) return;
    chat.permCards.delete(requestId);
    entry.card.remove();
  }

  // Drop every pending ask (turn ended, session restarted, or process exited —
  // the control requests they answer no longer exist).
  function clearPermCards(chat) {
    if (!chat || !chat.permCards) return;
    for (const entry of chat.permCards.values()) entry.card.remove();
    chat.permCards.clear();
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
          if (d.model) reflectModel(chat, d.model);
          if (d.permissionMode) chat.mode = d.permissionMode;
          if (chat.id === activeId) syncComposer();
          requestBranches(chat);
          savePrefs();
        }
        break;
      // Incremental tokens from --include-partial-messages: render assistant
      // text and thinking live, block by block.
      case "stream_event":
        handleStreamEvent(chat, d.event);
        break;
      case "assistant": {
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
            if (block.type === "thinking") addThinking(chat, body, block.thinking);
            else if (block.type === "text") addText(chat, body, block.text);
          }
        }
        if (!streamed) finalizeAssistant(chat, body, Date.now());
        break;
      }
      case "user": {
        const content = (d.message && d.message.content) || [];
        for (const block of content) {
          if (block.type === "tool_result") {
            fillToolResult(chat, block.tool_use_id, block.content, block.is_error);
          }
        }
        break;
      }
      case "result":
        endTurn(chat, d);
        break;
      case "rate_limit_event":
        if (d.rate_limit_info && d.rate_limit_info.status !== "allowed") {
          systemNote(chat, `Rate limit: ${d.rate_limit_info.status}`, "warn");
        }
        break;
    }
  }

  function endTurn(chat, result) {
    chat.turnRunning = false;
    finalizeAssistant(chat, chat.currentAssistantBody, Date.now());
    chat.currentAssistantId = null;
    chat.currentAssistantBody = null;
    // Finalize any dangling live blocks (e.g. an interrupted turn).
    for (const blk of chat.streamBlocks.values()) {
      if (blk.raf) { cancelAnimationFrame(blk.raf); blk.raf = 0; }
      if (blk.el) blk.el.classList && blk.el.classList.remove("streaming");
      if (blk.det) blk.det.classList.remove("streaming");
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
      if (entry.toggle.classList.contains("running")) {
        entry.toggle.classList.remove("running");
        entry.toggle.classList.add("done", "err");
      }
    }
    if (result) chat.turnStatusText = "";
    if (chat.id === activeId) {
      setRunningUI(chat.turnRunning);
      renderTurnStatus(chat);
    }
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
    if (!chat.turnRunning && !summary) {
      if (chat.statusEl && chat.statusEl.parentNode) chat.statusEl.remove();
      return;
    }
    const node = ensureStatusEl(chat);
    if (chat.turnRunning) {
      const secs = chat.turnStartedAt ? Math.max(0, Math.round((Date.now() - chat.turnStartedAt) / 1000)) : 0;
      const tokens = chat.turnTokens + chat.curMsgTokens;
      const meta = [`${secs}s`];
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
    if (chat && chat.turnRunning) {
      const now = Date.now();
      if (!chat.statusWord || now - chat.statusWordAt > 1800) {
        chat.statusWord = randStatusWord();
        chat.statusWordAt = now;
      }
    }
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
      }
      showOnboarding(lastErr && lastErr.message);
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
        hideOnboarding();
        if (!msg.ok) {
          const a = chats.get(activeId);
          if (a) systemNote(a, "Host is up but couldn't find the `claude` CLI. Install it: npm i -g @anthropic-ai/claude-code", "warn");
        }
        // The extension updates via git/store, but the native host runs from a
        // copy in ~/.lizard-studio that only install.sh refreshes — so a stale
        // host is easy to end up with and otherwise fails silently (missing
        // tools, unknown ops). Hosts older than the version check don't send
        // `version` at all, which reads as 0 and also triggers the warning.
        if ((msg.version || 0) < EXPECTED_HOST_VERSION) {
          const a = chats.get(activeId);
          if (a) systemNote(a, "The native host is outdated for this extension version — some features won't work. Update it, then reload the extension:  curl -fsSL https://raw.githubusercontent.com/lizard-build/lizard-studio/main/src/host/install.sh | bash", "warn");
        }
        // Start whichever tab is in front; others start when first shown.
        {
          const a = chats.get(activeId);
          if (a && !a.started) startChatSession(a);
          maybeReplay(a);
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
        }
        break;
      case "event":
        if (chat) onClaudeEvent(chat, msg.data);
        break;
      case "transcript":
        if (chat) replayTranscript(chat, msg.events);
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
          // If the user is mid-"/" in this tab, populate the menu now.
          if (chat.id === activeId && /^\/[^\s]*$/.test(els.input.value)) updateSlash();
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
          chat.cwd = msg.path;
          rememberCwd(msg.path);
          // Title is left as-is — it comes from the first user message, not the
          // folder name (see startTurn).
          // New folder → unknown git state until the host reports back.
          chat.isRepo = false;
          chat.branch = null;
          chat.branches = [];
          savePrefs();
          if (chat.id === activeId) syncComposer();
          resetChatSession(chat);
          requestBranches(chat);
          renderTabs();
        } else if (chat && msg.manual) {
          promptForFolder(chat);
        }
        break;
      case "gitBranches":
        if (chat) {
          chat.isRepo = !!msg.isRepo;
          chat.branch = msg.current || null;
          chat.branches = Array.isArray(msg.branches) ? msg.branches : [];
          if (chat.id === activeId) syncComposer();
          if (msg.checkedOut && chat.branch) systemNote(chat, `Switched to branch ${chat.branch}`);
        }
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
    chat.started = true;
    post({
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
    if (!chat || chat.replayed || !chat.sessionId) return;
    if (!connected || !hostReady) return;
    chat.replayed = true;
    post({ type: "loadTranscript", id: chat.id, sessionId: chat.sessionId, cwd: chat.cwd });
  }

  // Render a chunk of past messages (the host streams them in order across one or
  // more `transcript` events). Reuses the live renderers so history looks
  // identical to a fresh turn — user bubbles, assistant text/thinking, tool cards
  // and their results.
  function replayTranscript(chat, events) {
    if (!chat || !Array.isArray(events)) return;
    for (const ev of events) {
      if (!ev || !ev.message) continue;
      if (ev.type === "user") {
        const content = ev.message.content;
        if (typeof content === "string") {
          const stripped = content.replace(CTX_MARK_RE, "").trim();
          if (stripped) userBubble(chat, stripped, null);
        } else if (Array.isArray(content)) {
          const texts = [];
          for (const b of content) {
            if (!b) continue;
            if (b.type === "tool_result") fillToolResult(chat, b.tool_use_id, b.content, b.is_error);
            else if (b.type === "text" && b.text) texts.push(b.text);
          }
          const stripped = texts.join("\n\n").replace(CTX_MARK_RE, "").trim();
          if (stripped) userBubble(chat, stripped, null);
        }
      } else if (ev.type === "assistant") {
        const body = ensureAssistantBody(chat, ev.message.id);
        for (const block of ev.message.content || []) {
          if (!block) continue;
          if (block.type === "tool_use") {
            if (chat.emittedToolIds.has(block.id)) continue;
            chat.emittedToolIds.add(block.id);
            toolCard(chat, body, block);
          } else if (block.type === "thinking") {
            addThinking(chat, body, block.thinking);
          } else if (block.type === "text") {
            addText(chat, body, block.text);
          }
        }
        const ts = ev.timestamp ? (Date.parse(ev.timestamp) || Date.now()) : Date.now();
        finalizeAssistant(null, body, ts);
      }
    }
    // Leave currentAssistantId pointing at the last replayed turn so a turn that
    // straddles a chunk boundary stays in one body; the next live turn arrives
    // with a fresh message id and naturally opens its own body.
    if (chat.id === activeId) requestAnimationFrame(() => scrollToBottom(chat));
  }

  // Wipe a tab's transcript and start a fresh session (used on folder change).
  function resetChatSession(chat) {
    chat.messagesEl.innerHTML = "";
    chat.loginCard = null; // detached from the DOM above; drop the stale reference
    chat.statusEl = null; // wiped with the stream; recreated on next render
    chat.permCards.clear(); // card nodes went with the innerHTML wipe
    chat.toolCards.clear();
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
    if (chat.id === activeId) {
      renderTurnStatus(chat);
      updateSetup();
    }
    chat.started = false;
    startChatSession(chat);
  }

  async function sendPrompt() {
    const chat = chats.get(activeId);
    if (!chat) return;
    const text = els.input.value.trim();
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
    if ((!text && !hasContext && !hasAttach) || chat.turnRunning || !connected) return;
    // Can't run an agent without a working directory — prompt for one instead of
    // silently falling back to $HOME.
    if (!chat.cwd) {
      post({ type: "pickFolder", id: chat.id }) || promptForFolder(chat);
      return;
    }
    if (!chat.started) startChatSession(chat);
    // Silent, always-on context: what tabs are open right now, active one flagged.
    const tabsBlock = await buildTabsContextBlock(chat);
    // Prepend any attached page/element context as a block, then clear it.
    const ctx = formatContexts(chat);
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
    // Slash commands (built-ins like /usage, or skills) only get recognized by
    // the CLI when the message starts with "/name" — prepending the tabs/context
    // blocks before it turns it into plain text the model has to interpret
    // itself instead of a real command. So for a bare "/…" prompt, the command
    // goes first and any context follows after it, instead of leading.
    const extra = tabsBlock + ctx;
    // Wrap injected context in invisible sentinels so replayTranscript() can
    // strip it back out on reload — the live bubble above already shows just
    // the literal typed text, and replay should match that.
    const wrappedExtra = extra ? CTX_MARK_START + extra + CTX_MARK_END : "";
    const sentText = /^\//.test(text) ? text + (wrappedExtra ? "\n\n" + wrappedExtra : "") : wrappedExtra + (text || fallback);
    const images = attachments.map((a) => ({ mediaType: a.mediaType, data: a.base64 }));
    userBubble(chat, text || (hasContext ? bubbleHint : ""), attachments);
    post({ type: "prompt", id: chat.id, text: sentText, images });
    chat.contexts = [];
    chat.attachments = [];
    renderContextChips();
    renderAttachmentThumbs();
    els.input.value = "";
    autosize();
    chat.empty = false;
    chat.turnRunning = true;
    chat.turnStatusText = "";
    // Reset the running-status metrics for this turn.
    chat.turnStartedAt = Date.now();
    chat.turnTokens = 0;
    chat.curMsgTokens = 0;
    chat.statusWord = randStatusWord();
    chat.statusWordAt = Date.now();
    chat.streamedMsgIds.clear();
    chat.streamBlocks.clear();
    chat.streamMsgId = null;
    // First message becomes the tab title.
    if (chat.title === DEFAULT_TITLE) {
      chat.title = (text || "New chat").replace(/\s+/g, " ").slice(0, 40);
      renderTabs();
    }
    setRunningUI(true);
    renderTurnStatus(chat);
    startStatusTicker();
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
    post({ type: "interrupt", id: chat.id });
    systemNote(chat, "Interrupting…");
  }

  // ---- interactive login ----------------------------------------------------
  // Kicks off the host's `claude auth login` flow and shows a card that walks
  // the user through the browser OAuth + code paste. The host replies with
  // `authUrl` (the sign-in link) and finally `authDone`.
  function startLogin(chat) {
    if (chat.loginCard) { chat.loginCard.remove(); chat.loginCard = null; }
    const card = el("div", "login-card");
    card.appendChild(el("div", "login-title", "Sign in to Claude"));
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
    const openTab = () => {
      try { chrome.tabs.create({ url }); }
      catch (_) { window.open(url, "_blank"); }
    };
    openTab(); // open the sign-in page right away
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
      card._status.textContent = "";
      if (ok) {
        const ic = el("span", "login-check");
        ic.innerHTML = ICON("check", 13);
        card._status.appendChild(ic);
        card._status.appendChild(el("span", null, "Signed in. You're all set."));
      } else {
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
  function applyMode(chat, modeId) {
    const m = MODES.find((x) => x.id === modeId) || MODES[0];
    chat.mode = m.id;
    lastMode = m.id;
    savePrefs();
    syncComposer();
    if (chat.started) post({ type: "setMode", id: chat.id, permissionMode: chat.mode });
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
    if (chat.started) post({ type: "setModel", id: chat.id, model: chat.model });
    // The composer pill already reflects the active model — no transcript note.
  }

  function toggleModelMenu() {
    if (!els.modelMenu.classList.contains("hidden")) return hideModelMenu();
    renderModelMenu();
    els.modelMenu.classList.remove("hidden");
  }
  function renderModelMenu() {
    const chat = chats.get(activeId);
    els.modelMenu.innerHTML = "";
    els.modelMenu.appendChild(el("div", "model-head", "Model"));
    for (const m of MODELS) {
      const isCur = chat && chat.model === m.id;
      const row = el("div", "model-item" + (isCur ? " current" : ""));
      const logo = el("span", "model-item-logo");
      logo.innerHTML = window.RKClaudeHTML(15);
      row.appendChild(logo);
      row.appendChild(el("span", "model-item-label", m.label));
      const ic = el("span", "model-item-ic");
      if (isCur) ic.innerHTML = ICON("check", 13);
      row.appendChild(ic);
      row.addEventListener("click", () => {
        hideModelMenu();
        const c = chats.get(activeId);
        if (c) applyModel(c, m.id);
      });
      els.modelMenu.appendChild(row);
    }
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
    if (chat.started) post({ type: "setEffort", id: chat.id, effort: chat.effort });
  }

  function toggleEffortMenu() {
    if (!els.effortMenu.classList.contains("hidden")) return hideEffortMenu();
    renderEffortMenu();
    els.effortMenu.classList.remove("hidden");
  }
  function renderEffortMenu() {
    const chat = chats.get(activeId);
    els.effortMenu.innerHTML = "";
    els.effortMenu.appendChild(el("div", "model-head", "Effort"));
    for (const e of EFFORTS) {
      const isCur = chat && chat.effort === e.id;
      const row = el("div", "model-item" + (isCur ? " current" : ""));
      row.appendChild(el("span", "model-item-label", e.label));
      const ic = el("span", "model-item-ic");
      if (isCur) ic.innerHTML = ICON("check", 13);
      row.appendChild(ic);
      row.addEventListener("click", () => {
        hideEffortMenu();
        const c = chats.get(activeId);
        if (c) applyEffort(c, e.id);
      });
      els.effortMenu.appendChild(row);
    }
  }
  function hideEffortMenu() {
    els.effortMenu.classList.add("hidden");
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
    renderTurnStatus(chat);
    if (chat.turnRunning) startStatusTicker();
    syncBranch(chat);
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

  function promptForFolder(chat) {
    const cur = chat.cwd || home || "";
    const next = window.prompt("Project folder path:", cur);
    if (next && next.trim()) {
      chat.cwd = next.trim();
      rememberCwd(chat.cwd);
      // Title comes from the first user message, not the folder name.
      chat.isRepo = false;
      chat.branch = null;
      chat.branches = [];
      savePrefs();
      syncComposer();
      resetChatSession(chat);
      requestBranches(chat);
      renderTabs();
    }
  }

  function autosize() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 200) + "px";
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
    els.input.value = "/" + c + (run ? "" : " ");
    hideSlash();
    if (run) {
      // Clicking a command fires it right away.
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
    els.slashMenu = root.querySelector("#slash-menu");
    els.onboarding = root.querySelector("#chat-onboarding");
    els.onboardingStatus = root.querySelector("#chat-onboarding-status");
    els.copyInstall = root.querySelector("#chat-copy-install");
    els.attachFileBtn = root.querySelector("#attach-file-btn");
    els.fileInput = root.querySelector("#file-input");

    // Static icons.
    root.querySelector("#new-chat-btn").innerHTML = ICON("plus", 17);
    root.querySelector("#history-btn").innerHTML = ICON("history", 17);
    root.querySelector("#folder-ic").innerHTML = ICON("folder", 14);
    root.querySelector("#branch-ic").innerHTML = ICON("git-branch", 13);
    els.send.innerHTML = ICON("send", 16);
    els.stop.innerHTML = ICON("stop", 14);
    els.attachFileBtn.innerHTML = ICON("plus", 15);

    els.send.addEventListener("click", sendPrompt);
    els.stop.addEventListener("click", interrupt);
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
    document.addEventListener("click", (e) => {
      if (!els.historyMenu.contains(e.target) && e.target !== els.historyBtn) {
        els.historyMenu.classList.add("hidden");
      }
    });
    els.folder.addEventListener("click", () => {
      const chat = chats.get(activeId);
      if (chat) post({ type: "pickFolder", id: chat.id }) || promptForFolder(chat);
    });
    els.branch.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBranchMenu();
    });
    document.addEventListener("click", (e) => {
      if (els.branchMenu && !els.branchMenu.contains(e.target) && e.target !== els.branch && !els.branch.contains(e.target)) {
        els.branchMenu.classList.add("hidden");
      }
    });
    els.mode.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleModeMenu();
    });
    document.addEventListener("click", (e) => {
      if (els.modeMenu && !els.modeMenu.contains(e.target) && e.target !== els.mode && !els.mode.contains(e.target)) {
        els.modeMenu.classList.add("hidden");
      }
    });
    els.modelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleModelMenu();
    });
    document.addEventListener("click", (e) => {
      if (els.modelMenu && !els.modelMenu.contains(e.target) && !els.modelBtn.contains(e.target)) {
        els.modelMenu.classList.add("hidden");
      }
    });
    els.effortBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleEffortMenu();
    });
    document.addEventListener("click", (e) => {
      if (els.effortMenu && !els.effortMenu.contains(e.target) && !els.effortBtn.contains(e.target)) {
        els.effortMenu.classList.add("hidden");
      }
    });
    els.input.addEventListener("input", () => {
      autosize();
      updateSlash();
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
      </div>
    </div>
    <div id="chat-stack" class="chat-stack"></div>
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
      <div class="composer-box">
        <div id="context-chips" class="context-chips hidden"></div>
        <div id="attach-thumbs" class="attach-thumbs hidden"></div>
        <textarea id="composer-input" class="composer-input" rows="1"
          placeholder="Type / for commands"></textarea>
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

  async function handleBrowserOp(msg) {
    const op = msg.op;
    const args = msg.args || {};
    const done = (ok, data, error) => post({ type: "browserResult", bid: msg.bid, ok, data, error });
    try {
      if (!(chrome.tabs && chrome.tabs.query)) return done(false, null, "Browser tab access unavailable.");
      const session = msg.session || null;

      if (op === "tabs") {
        const [tabs, current] = await Promise.all([listTabs(), activeTab()]);
        return done(true, {
          activeTabId: current ? current.id : null,
          workingTabId: session ? pinnedTabBySession.get(session) ?? null : null,
          tabs: tabs.map((t) => ({ tabId: t.id, windowId: t.windowId, title: t.title, url: t.url, active: !!t.active, pinned: !!t.pinned, audible: !!t.audible })),
        });
      }

      if (op === "tab_open") {
        const url = String(args.url || "");
        if (!/^https?:\/\//i.test(url)) return done(false, null, "Provide an absolute http(s) URL.");
        const t = await new Promise((resolve) => {
          chrome.tabs.create({ url, active: args.active !== false }, (nt) => resolve(chrome.runtime.lastError ? null : nt));
        });
        if (!t) return done(false, null, "Couldn't open a new tab.");
        if (session) pinnedTabBySession.set(session, t.id);
        return done(true, { tabId: t.id, windowId: t.windowId, url });
      }

      // File-upload staging (no tab needed until commit).
      if (op === "upload_begin") {
        gcUploads();
        const uploadId = "u" + nextUploadId++;
        uploads.set(uploadId, { name: String(args.name || "file"), mime: String(args.mime || "application/octet-stream"), size: args.size || 0, parts: [], ts: Date.now() });
        return done(true, { uploadId });
      }
      if (op === "upload_chunk") {
        const u = uploads.get(args.uploadId);
        if (!u) return done(false, null, "Unknown or expired uploadId — start over with a new browser_upload_file call.");
        u.parts.push(String(args.data || ""));
        u.ts = Date.now();
        return done(true, { received: u.parts.length });
      }

      // Everything below targets one tab. An explicit tabId always wins and
      // (re-)pins this Claude session to it. Otherwise reuse the tab this
      // session already pinned; only fall back to (and pin) the live active
      // tab if nothing's pinned yet or the pinned tab is gone.
      let tab;
      if (args.tabId != null) {
        tab = await getTab(Number(args.tabId));
        if (!tab || tab.id == null) return done(false, null, "No tab with id " + args.tabId + " — call browser_tabs for the current list.");
        if (session) pinnedTabBySession.set(session, tab.id);
      } else {
        const pinnedId = session ? pinnedTabBySession.get(session) : null;
        tab = pinnedId != null ? await getTab(pinnedId) : null;
        if (!tab || tab.id == null) {
          tab = await activeTab();
          if (!tab || tab.id == null) return done(false, null, "No active browser tab.");
          if (session) pinnedTabBySession.set(session, tab.id);
        }
      }

      if (op === "tab_activate") {
        await new Promise((resolve) => chrome.tabs.update(tab.id, { active: true }, () => { void chrome.runtime.lastError; resolve(); }));
        await new Promise((resolve) => chrome.windows.update(tab.windowId, { focused: true }, () => { void chrome.runtime.lastError; resolve(); }));
        return done(true, { activated: true, tabId: tab.id, title: tab.title, url: tab.url });
      }

      if (op === "tab_close") {
        if (args.tabId == null) return done(false, null, "tabId is required to close a tab.");
        detachCdp(tab.id);
        const closed = await new Promise((resolve) => {
          chrome.tabs.remove(tab.id, () => resolve(!chrome.runtime.lastError));
        });
        if (!closed) return done(false, null, "Couldn't close tab " + tab.id + ".");
        if (session && pinnedTabBySession.get(session) === tab.id) pinnedTabBySession.delete(session);
        return done(true, { closed: true, tabId: tab.id });
      }

      if (op === "info" || op === "dom") {
        const format = op === "info" ? "info" : args.format === "html" ? "html" : "text";
        const resp = await sendToTab(tab.id, { type: "RK_PAGE_CONTEXT", format, selector: args.selector });
        if (!resp || !resp.ok) {
          return done(false, null, (resp && resp.error) || "Couldn't read this tab — open a normal web page (chrome:// and the Web Store are off-limits) and reload it so the helper is present.");
        }
        if (op === "info") return done(true, { url: resp.url, title: resp.title, selection: resp.selection || "" });
        return done(true, { url: resp.url, title: resp.title, format, content: format === "html" ? resp.html : resp.text, truncated: !!resp.truncated });
      }

      if (op === "upload_commit") {
        const u = uploads.get(args.uploadId);
        if (!u) return done(false, null, "Unknown or expired uploadId — start over with a new browser_upload_file call.");
        uploads.delete(args.uploadId);
        const resp = await sendToTab(tab.id, {
          type: "RK_UPLOAD_FILE",
          selector: args.selector || null,
          name: u.name,
          mime: u.mime,
          b64: u.parts.join(""),
        });
        if (!resp || !resp.ok) {
          return done(false, null, (resp && resp.error) || "Couldn't reach this tab — open a normal web page (chrome:// and the Web Store are off-limits) and reload it so the helper is present.");
        }
        return done(true, { attached: u.name, size: u.size, mime: u.mime, via: resp.via, target: resp.target });
      }

      if (op === "screenshot") {
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
        if (!dataUrl) return done(false, null, "Screenshot failed (tab not capturable).");
        return done(true, { dataUrl });
      }

      // console / network / eval need the DevTools Protocol.
      await ensureAttached(tab.id);
      bumpIdle(tab.id);
      const sess = cdpSessions.get(tab.id);

      if (op === "eval") {
        const r = await dbgSend(tab.id, "Runtime.evaluate", {
          expression: String(args.expression || ""),
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
          timeout: 5000,
        });
        if (r && r.exceptionDetails) {
          const d = r.exceptionDetails;
          return done(true, { error: (d.exception && (d.exception.description || d.exception.value)) || d.text || "evaluation error" });
        }
        const val = r && r.result ? (r.result.value !== undefined ? r.result.value : r.result.description) : null;
        return done(true, { result: val });
      }

      if (op === "console") {
        const limit = Math.max(1, Math.min(args.limit || 100, 500));
        return done(true, {
          note: sess.console.length ? undefined : "No console output captured yet — capture began when the tools attached. Call browser_reload (or re-run the code), then call again.",
          entries: sess.console.slice(-limit),
        });
      }

      if (op === "network") {
        const limit = Math.max(1, Math.min(args.limit || 80, 300));
        return done(true, {
          note: sess.network.length ? undefined : "No requests captured yet — capture began when the tools attached. Call browser_reload (or re-trigger the request), then call again.",
          requests: sess.network.slice(-limit).map((r) => ({ url: r.url, method: r.method, status: r.status, type: r.type, mimeType: r.mimeType, failed: r.failed || undefined })),
        });
      }

      if (op === "snapshot") {
        const snap = await axSnapshot(tab.id, args.interactiveOnly !== false);
        return done(true, snap);
      }

      if (op === "navigate") {
        const url = String(args.url || "");
        if (!/^https?:\/\//i.test(url)) return done(false, null, "Provide an absolute http(s) URL.");
        const loaded = waitForCdpEvent(tab.id, "Page.loadEventFired", 20000);
        await dbgSend(tab.id, "Page.navigate", { url });
        await loaded;
        const info = await dbgSend(tab.id, "Runtime.evaluate", { expression: "({url:location.href,title:document.title})", returnByValue: true });
        sess.refs.clear();
        return done(true, info && info.result ? info.result.value : { url });
      }

      if (op === "reload") {
        const loaded = waitForCdpEvent(tab.id, "Page.loadEventFired", 20000);
        await dbgSend(tab.id, "Page.reload", { ignoreCache: !!args.hardReload });
        await loaded;
        const info = await dbgSend(tab.id, "Runtime.evaluate", { expression: "({url:location.href,title:document.title})", returnByValue: true });
        sess.refs.clear();
        return done(true, info && info.result ? info.result.value : { reloaded: true });
      }

      if (op === "click") {
        const pt = await targetCenter(tab.id, args);
        if (!pt) return done(false, null, "Target not found (ref/selector didn't resolve or is off-screen).");
        await mouseClick(tab.id, pt.x, pt.y, !!args.double);
        return done(true, { clicked: true, x: Math.round(pt.x), y: Math.round(pt.y) });
      }

      if (op === "type") {
        if (args.ref || args.selector) {
          const ok = await focusTarget(tab.id, args);
          if (!ok) return done(false, null, "Target not found to type into.");
        }
        await dbgSend(tab.id, "Input.insertText", { text: String(args.text || "") });
        if (args.submit) await pressKey(tab.id, "Enter");
        return done(true, { typed: String(args.text || "").length });
      }

      if (op === "fill") {
        const r = await setValue(tab.id, args, String(args.value || ""));
        if (!r) return done(false, null, "Target not found to fill.");
        return done(true, { filled: true });
      }

      if (op === "key") {
        await pressKey(tab.id, String(args.key || ""));
        return done(true, { pressed: args.key });
      }

      return done(false, null, "Unknown browser op: " + op);
    } catch (e) {
      done(false, null, String((e && e.message) || e));
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
    const body =
      "this.focus(); var proto=Object.getPrototypeOf(this); var d=Object.getOwnPropertyDescriptor(proto,'value'); if(d&&d.set){d.set.call(this,V);}else{this.value=V;} this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return true;";
    const fn = "function(V){ " + body + " }";
    if (args.ref) {
      const objectId = await refToObject(tabId, args.ref);
      if (!objectId) return false;
      const r = await dbgSend(tabId, "Runtime.callFunctionOn", { objectId, functionDeclaration: fn, arguments: [{ value }], returnByValue: true });
      return !!(r && r.result && r.result.value);
    }
    if (args.selector) {
      const expr = "(function(V){var el=document.querySelector(" + JSON.stringify(args.selector) + "); if(!el) return false; " + body.replace(/this/g, "el") + "})(" + JSON.stringify(value) + ")";
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
