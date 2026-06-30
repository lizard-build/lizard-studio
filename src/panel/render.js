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
        "True", "False", "self", "fn", "let", "mut", "pub", "struct", "enum",
        "impl", "match", "use", "type", "interface", "public", "private", "static",
        "package", "func", "go", "defer", "nil", "end", "then", "echo", "fi",
      ].join("|") +
      ")\\b",
    "g"
  );

  function highlight(escaped, lang) {
    // Tokenize over escaped text. Order matters: comments & strings first so we
    // don't highlight keywords inside them.
    const patterns = [
      { cls: "tok-comment", re: /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g },
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

  function codeBlock(code, lang) {
    const pre = document.createElement("pre");
    pre.className = "code-block";
    if (lang) pre.dataset.lang = lang;
    const codeEl = document.createElement("code");
    codeEl.innerHTML = highlight(escapeHtml(code), lang);
    pre.appendChild(codeEl);
    return pre;
  }

  // ---- inline markdown ------------------------------------------------------
  // `code`, **bold**, *italic*, [text](url). Input is raw; output is escaped+safe.
  function inlineMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, (_, c) => `<code class="inline">${c}</code>`);
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    html = html.replace(/\b_([^_\n]+)_\b/g, "<em>$1</em>");
    // Links: only http(s) and relative — never javascript:
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => {
      return `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`;
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
        }
        const item = document.createElement("li");
        item.innerHTML = inlineMarkdown(li[3]);
        list.appendChild(item);
        i++;
        continue;
      }

      // blank line
      if (!line.trim()) {
        flushList();
        i++;
        continue;
      }

      // paragraph (gather consecutive non-special lines)
      flushList();
      const para = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^```/.test(lines[i]) &&
        !/^#{1,4}\s/.test(lines[i]) &&
        !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i])
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
  // Minimal LCS so additions/removals line up sensibly.
  function lineDiff(oldStr, newStr) {
    const a = String(oldStr || "").split("\n");
    const b = String(newStr || "").split("\n");
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let x = n - 1; x >= 0; x--) {
      for (let y = m - 1; y >= 0; y--) {
        dp[x][y] = a[x] === b[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
      }
    }
    const rows = [];
    let x = 0;
    let y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) {
        rows.push({ t: " ", text: a[x] });
        x++;
        y++;
      } else if (dp[x + 1][y] >= dp[x][y + 1]) {
        rows.push({ t: "-", text: a[x] });
        x++;
      } else {
        rows.push({ t: "+", text: b[y] });
        y++;
      }
    }
    while (x < n) rows.push({ t: "-", text: a[x++] });
    while (y < m) rows.push({ t: "+", text: b[y++] });

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

  window.RKRender = { escapeHtml, markdown, codeBlock, lineDiff, inlineMarkdown };
})();
