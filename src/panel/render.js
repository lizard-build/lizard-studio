"use strict";
// Safe rendering helpers for the chat. Everything that comes from the model is
// escaped before it ever touches innerHTML — we only interpolate strings we built
// ourselves out of escaped pieces. No external markdown/highlighter deps.
//
// Exposes a single global: window.RKRender.

(function () {
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---- lightweight syntax highlighting -------------------------------------
  // Operates on already-escaped source and wraps tokens in <span class="tok-*">.
  // Deliberately approximate — enough to read code, not a full parser.
  const KEYWORDS = new RegExp(
    "\\b(" +
      [
        "const", "let", "var", "function", "return", "if", "else", "for", "while",
        "do", "switch", "case", "break", "continue", "new", "class", "extends",
        "import", "from", "export", "default", "async", "await", "yield", "try",
        "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "this",
        "super", "void", "delete", "null", "true", "false", "undefined", "def",
        "elif", "lambda", "pass", "with", "as", "is", "not", "and", "or", "None",
        "True", "False", "self", "fn", "mut", "pub", "struct", "enum",
        "impl", "match", "use", "type", "interface", "public", "private", "static",
        "package", "func", "go", "defer", "nil", "end", "then", "echo", "fi",
      ].join("|") +
      ")\\b",
    "g"
  );

  // Comment syntax by language, so `#` doesn't turn half a JS line into a
  // "comment" and `//` doesn't eat Python strings. Unknown languages keep the
  // permissive combined pattern.
  const HASH_LANGS = /^(py|python|sh|bash|zsh|shell|rb|ruby|yaml|yml|toml|make|makefile|dockerfile)$/i;
  const SLASH_LANGS = /^(js|jsx|mjs|ts|tsx|javascript|typescript|c|h|cpp|cc|hpp|cs|java|kt|kotlin|swift|go|rust|rs|php|scala|dart)$/i;
  function commentRe(lang) {
    if (HASH_LANGS.test(lang || "")) return /(#[^\n]*)/g;
    if (SLASH_LANGS.test(lang || "")) return /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g;
    return /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g;
  }

  function highlight(escaped, lang) {
    // Tokenize over escaped text. Order matters: comments & strings first so we
    // don't highlight keywords inside them.
    const patterns = [
      { cls: "tok-comment", re: commentRe(lang) },
      { cls: "tok-string", re: /(&#39;(?:[^&\\]|\\.)*?&#39;|&quot;(?:[^&\\]|\\.)*?&quot;|`(?:[^`\\]|\\.)*?`)/g },
      { cls: "tok-number", re: /\b(0x[0-9a-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?)\b/g },
    ];
    // Collect protected ranges (comments/strings) so keyword/number passes skip them.
    const marks = [];
    for (const { cls, re } of patterns) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(escaped)) !== null) {
        marks.push({ start: m.index, end: m.index + m[0].length, cls, text: m[0] });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    marks.sort((a, b) => a.start - b.start);
    // Drop overlaps (keep earliest).
    const clean = [];
    let cursor = -1;
    for (const mk of marks) {
      if (mk.start >= cursor) {
        clean.push(mk);
        cursor = mk.end;
      }
    }
    // Build output: protected spans verbatim, plain gaps get keyword/number passes.
    let out = "";
    let i = 0;
    for (const mk of clean) {
      out += highlightPlain(escaped.slice(i, mk.start));
      out += `<span class="${mk.cls}">${mk.text}</span>`;
      i = mk.end;
    }
    out += highlightPlain(escaped.slice(i));
    return out;
  }

  function highlightPlain(s) {
    return s
      .replace(KEYWORDS, '<span class="tok-kw">$1</span>')
      .replace(/\b([A-Za-z_$][\w$]*)(?=\s*\()/g, '<span class="tok-fn">$1</span>');
  }

  // Shared copy-button behavior: write getText() to the clipboard and flash
  // the icon to a check. Used by code blocks, message footers and the
  // host-outdated banner — keep the feedback identical everywhere.
  function wireCopyButton(btn, getText, size) {
    const ICON = window.RKIconHTML;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const text = getText();
      if (!text || !navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add("copied");
        btn.innerHTML = ICON("check", size);
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = ICON("copy", size);
        }, 1200);
      }).catch(() => {});
    });
  }

  function codeBlock(code, lang) {
    // The <pre> is the horizontal scroll container, so the copy button lives
    // on a relative wrapper — pinned inside the pre it would scroll away.
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    const pre = document.createElement("pre");
    pre.className = "code-block";
    const codeEl = document.createElement("code");
    codeEl.innerHTML = highlight(escapeHtml(code), lang);
    pre.appendChild(codeEl);
    wrap.appendChild(pre);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.title = "Copy";
    btn.setAttribute("aria-label", "Copy code");
    btn.innerHTML = window.RKIconHTML("copy", 12);
    wireCopyButton(btn, () => code, 12);
    wrap.appendChild(btn);
    return wrap;
  }

  // ---- inline markdown ------------------------------------------------------
  // `code`, **bold**, *italic*, [text](url). Input is raw; output is escaped+safe.
  function inlineMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, (_, c) => `<code class="inline">${c}</code>`);
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    html = html.replace(/\b_([^_\n]+)_\b/g, "<em>$1</em>");
    // Links: only absolute http(s) URLs are linkified — relative and any other
    // scheme (javascript:, data:, …) are left as inert escaped text.
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => {
      return `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
    // Bare URLs the model didn't wrap in [text](url) syntax. Walk the string
    // matching either a full tag or a bare URL; tags (including hrefs already
    // built above) pass through untouched so we never double-wrap.
    html = html.replace(/(<[^>]+>)|(https?:\/\/[^\s<]+)/g, (m, tag, url) => {
      if (tag) return tag;
      // Trailing sentence punctuation isn't part of the URL — peel it off.
      const trail = url.match(/[).,!?;:]+$/);
      const clean = trail ? url.slice(0, -trail[0].length) : url;
      const rest = trail ? trail[0] : "";
      return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${rest}`;
    });
    return html;
  }

  // ---- block markdown -> element -------------------------------------------
  function markdown(text) {
    const root = document.createElement("div");
    root.className = "md";
    const lines = String(text == null ? "" : text).split("\n");
    let i = 0;
    let list = null; // current <ul>/<ol>

    const flushList = () => {
      if (list) {
        root.appendChild(list);
        list = null;
      }
    };

    // Split a GFM table row into trimmed cells, tolerating optional leading and
    // trailing pipes.
    const splitRow = (s) => {
      const t = s.trim().replace(/^\|/, "").replace(/\|$/, "");
      return t.split("|").map((c) => c.trim());
    };
    // A delimiter row is all-dashes cells (e.g. |---|:--:|---:|) — what marks the
    // line after the header as the start of a table.
    const isDelimRow = (s) =>
      s.indexOf("-") !== -1 &&
      (() => {
        const cells = splitRow(s);
        return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
      })();

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(/^```(\w+)?\s*$/);
      if (fence) {
        flushList();
        const lang = fence[1] || "";
        const body = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        root.appendChild(codeBlock(body.join("\n"), lang));
        continue;
      }

      // heading
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushList();
        const el = document.createElement("h" + h[1].length);
        el.className = "md-h";
        el.innerHTML = inlineMarkdown(h[2]);
        root.appendChild(el);
        i++;
        continue;
      }

      // list item (- * or 1.)
      const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (li) {
        const ordered = /\d+\./.test(li[2]);
        if (!list || list.dataset.ordered !== String(ordered)) {
          flushList();
          list = document.createElement(ordered ? "ol" : "ul");
          list.className = "md-list";
          list.dataset.ordered = String(ordered);
          // Honor an explicit starting number ("3." resumes at 3).
          if (ordered) {
            const n = parseInt(li[2], 10);
            if (n > 1) list.start = n;
          }
        }
        const item = document.createElement("li");
        item.innerHTML = inlineMarkdown(li[3]);
        list.appendChild(item);
        i++;
        continue;
      }

      // indented continuation of the previous list item's text
      // (insertAdjacentHTML appends without re-serializing the whole <li>)
      if (list && /^\s{2,}\S/.test(line) && list.lastElementChild) {
        list.lastElementChild.insertAdjacentHTML("beforeend", "<br>" + inlineMarkdown(line.trim()));
        i++;
        continue;
      }

      // GFM table: a header row immediately followed by a delimiter row.
      if (line.indexOf("|") !== -1 && i + 1 < lines.length && isDelimRow(lines[i + 1])) {
        flushList();
        const headers = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const l = c.startsWith(":");
          const r = c.endsWith(":");
          return l && r ? "center" : r ? "right" : l ? "left" : "";
        });
        i += 2;
        const table = document.createElement("table");
        table.className = "md-table";
        const thead = document.createElement("thead");
        const htr = document.createElement("tr");
        headers.forEach((cell, idx) => {
          const th = document.createElement("th");
          th.innerHTML = inlineMarkdown(cell);
          if (aligns[idx]) th.style.textAlign = aligns[idx];
          htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);
        const tbody = document.createElement("tbody");
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") !== -1) {
          const cells = splitRow(lines[i]);
          const tr = document.createElement("tr");
          for (let c = 0; c < headers.length; c++) {
            const td = document.createElement("td");
            td.innerHTML = inlineMarkdown(cells[c] != null ? cells[c] : "");
            if (aligns[c]) td.style.textAlign = aligns[c];
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i++;
        }
        table.appendChild(tbody);
        root.appendChild(table);
        continue;
      }

      // blank line — a list survives blank lines between its items (a "loose"
      // list in markdown terms), otherwise every item would open a fresh <ol>
      // and the numbering would restart at 1. Only flush when whatever follows
      // is not another list item.
      if (!line.trim()) {
        if (list) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (!(j < lines.length && /^(\s*)([-*]|\d+\.)\s+/.test(lines[j]))) flushList();
        }
        i++;
        continue;
      }

      // paragraph (gather consecutive non-special lines; also stop at a table
      // header+delimiter pair, so a table not preceded by a blank line isn't
      // absorbed and rendered as raw pipes)
      flushList();
      const para = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^```/.test(lines[i]) &&
        !/^#{1,4}\s/.test(lines[i]) &&
        !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i]) &&
        !(lines[i].indexOf("|") !== -1 && i + 1 < lines.length && isDelimRow(lines[i + 1]))
      ) {
        para.push(lines[i]);
        i++;
      }
      const p = document.createElement("p");
      p.innerHTML = inlineMarkdown(para.join("\n")).replace(/\n/g, "<br>");
      root.appendChild(p);
    }
    flushList();
    return root;
  }

  // ---- line diff (for Edit tool) -------------------------------------------
  // Minimal LCS so additions/removals line up sensibly. The DP matrix is
  // O(n·m) cells, so strip the common prefix/suffix first (a real edit usually
  // collapses to a small window) and above a hard cap skip the alignment — a
  // multi-thousand-line replacement would otherwise allocate tens of millions
  // of cells synchronously mid-render and freeze the panel.
  const DIFF_MAX_LINES = 600; // per side, after prefix/suffix trimming
  function lineDiff(oldStr, newStr) {
    const a = String(oldStr || "").split("\n");
    const b = String(newStr || "").split("\n");
    let pfx = 0;
    while (pfx < a.length && pfx < b.length && a[pfx] === b[pfx]) pfx++;
    let sfx = 0;
    while (sfx < a.length - pfx && sfx < b.length - pfx && a[a.length - 1 - sfx] === b[b.length - 1 - sfx]) sfx++;
    const ca = a.slice(pfx, a.length - sfx);
    const cb = b.slice(pfx, b.length - sfx);

    const rows = [];
    for (let k = 0; k < pfx; k++) rows.push({ t: " ", text: a[k] });
    if (ca.length > DIFF_MAX_LINES || cb.length > DIFF_MAX_LINES) {
      // Too big to align line-by-line — show one removed block, one added block.
      for (const text of ca) rows.push({ t: "-", text });
      for (const text of cb) rows.push({ t: "+", text });
    } else {
      const n = ca.length;
      const m = cb.length;
      const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
      for (let x = n - 1; x >= 0; x--) {
        for (let y = m - 1; y >= 0; y--) {
          dp[x][y] = ca[x] === cb[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
        }
      }
      let x = 0;
      let y = 0;
      while (x < n && y < m) {
        if (ca[x] === cb[y]) {
          rows.push({ t: " ", text: ca[x] });
          x++;
          y++;
        } else if (dp[x + 1][y] >= dp[x][y + 1]) {
          rows.push({ t: "-", text: ca[x] });
          x++;
        } else {
          rows.push({ t: "+", text: cb[y] });
          y++;
        }
      }
      while (x < n) rows.push({ t: "-", text: ca[x++] });
      while (y < m) rows.push({ t: "+", text: cb[y++] });
    }
    for (let k = sfx; k > 0; k--) rows.push({ t: " ", text: a[a.length - k] });

    const pre = document.createElement("pre");
    pre.className = "diff";
    let html = "";
    for (const r of rows) {
      const cls = r.t === "+" ? "diff-add" : r.t === "-" ? "diff-del" : "diff-ctx";
      const sign = r.t === " " ? " " : r.t;
      html += `<span class="${cls}"><span class="diff-gutter">${sign}</span>${escapeHtml(r.text)}</span>`;
    }
    pre.innerHTML = html;
    return pre;
  }

  window.RKRender = { escapeHtml, markdown, codeBlock, lineDiff, inlineMarkdown, wireCopyButton };
})();
