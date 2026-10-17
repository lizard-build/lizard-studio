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
  //
  // Both marks are put in the button up front, stacked in one cell, because
  // the swap is a cross-fade and needs both on screen at once — swapping
  // innerHTML can only cut. So wiring owns the button's contents: callers set
  // the class, title and label, not the icon. The box and colours are
  // untouched; panel.css drives the swap off the .copied class.
  // Every message footer carries one of these; parse the two marks once per
  // size and clone them after that.
  const copySwaps = new Map();
  function wireCopyButton(btn, getText, size) {
    let proto = copySwaps.get(size);
    if (!proto) {
      const ICON = window.RKIconHTML;
      proto = document.createElement("span");
      proto.className = "copy-swap";
      proto.style.setProperty("--copy-mark", size + "px");
      proto.innerHTML =
        '<span class="copy-mark copy-mark-idle">' + ICON("copy", size) + "</span>" +
        '<span class="copy-mark copy-mark-done">' + ICON("check", size) + "</span>";
      copySwaps.set(size, proto);
    }
    btn.replaceChildren(proto.cloneNode(true));
    let revert = 0;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const text = getText();
      if (!text || !navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add("copied");
        clearTimeout(revert);
        revert = setTimeout(() => btn.classList.remove("copied"), 1200);
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
    wireCopyButton(btn, () => code, 12);
    wrap.appendChild(btn);
    return wrap;
  }

  // ---- file paths in inline code -------------------------------------------
  // Claude writes paths as inline code (`~/Desktop/notes.md`, `src/panel/render.js:42`),
  // and those are worth a click. Turning one into a link is opt-in per page:
  // only the side panel can act on the click — it owns the native-messaging port —
  // so the standalone plan viewer keeps rendering plain inline code.
  let pathLinks = false;
  function enablePathLinks() {
    pathLinks = true;
  }

  // A link is only offered where the text names one file and no other. A bare
  // name doesn't: a project can hold four "favicon-32.png", and a click would
  // have to guess which — so it stays plain code. What's left is a path with a
  // folder in it, which resolves against the chat's folder and can mean one
  // file only. It also keeps `chat.cwd` out of the links.
  function filePath(code) {
    // "file.ts:42" — the line (and column) is how an editor is told where to
    // jump, not part of the name on disk.
    const s = code.trim().replace(/:\d+(?::\d+)?$/, "");
    if (!s || s.length > 400) return "";
    // Entities mean the source had a quote or an ampersand; the rest is shell
    // punctuation. Either way it's a command, not a path.
    if (/[&<>|*?`$;()\n]/.test(s) || /\s-/.test(s)) return "";
    // A URL is a link already — the pass below turns it into one.
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(s)) return "";
    // Rooted paths are unmistakable, so they may carry spaces (~/Desktop/My notes.md).
    // A bare root ("/", "~/", "./") names nothing worth opening.
    if (/^(~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])/.test(s)) return /[^~./\\]/.test(s) ? s : "";
    if (/\s/.test(s)) return "";
    return s.indexOf("/") !== -1 ? s : "";
  }

  // ---- inline markdown ------------------------------------------------------
  // `code`, **bold**, *italic*, ~~strike~~, [text](url). Input is raw; output is escaped+safe.
  // A mark opens only before a non-space and closes only after one, as in
  // CommonMark, so "*.md or *.txt" and "2 * 3 * 4" stay plain text.
  function emphasis(html) {
    return html
      .replace(/\*\*\*(?=\S)([^*]*?\S)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, "<del>$1</del>")
      .replace(/(^|[^*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, "<em>$1</em>");
  }

  function markdownPath(destination) {
    let path = destination.trim().replace(/^<([\s\S]*)>$/, "$1");
    try { path = decodeURI(path); } catch { return ""; }
    path = path.replace(/(?:#L\d+(?:C\d+)?(?:-L?\d+)?|:\d+(?::\d+)?)$/, "");
    // Explicit file links may contain spaces and parentheses. Schemes and
    // network paths stay inert; the native host receives only a local path.
    if (!path || /[\x00-\x1f\x7f]/.test(path) || /^(?:\/\/|\\\\)/.test(path)) return "";
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return "";
    return /[\\/]/.test(path) || /^[^\s]+\.[a-z\d]+$/i.test(path) ? path : "";
  }

  // A bare URL ends before trailing punctuation and emphasis marks
  // ("**https://x.com**,") and before a ")" it never opened.
  function trimUrl(url) {
    let clean = url;
    for (let prev = ""; prev !== clean; ) {
      prev = clean;
      clean = clean.replace(/[.,!?;:*_~]+$/, "");
      if (clean.endsWith(")") && (clean.match(/\)/g) || []).length > (clean.match(/\(/g) || []).length) clean = clean.slice(0, -1);
    }
    return clean;
  }

  function inlineMarkdown(text, links = true) {
    // Private-use characters mark the placeholders below; drop any in the input.
    const source = String(text == null ? "" : text).replace(/[]/g, "");
    // Escapes, code, links and URLs render first and wait behind placeholders,
    // so emphasis can wrap them (**see `x`**) but never rewrite what's inside:
    // code contents, file paths, href attributes, an existing link label.
    const parked = [];
    const park = (html) => "" + (parked.push(html) - 1) + "";
    const tokens = /\\([\\`*_~[\]()#|<>])|(?<!`)(`+)(?!`)([\s\S]*?[^`])\2(?!`)|\[([^\]\n]+)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))*)\)|<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>`]+)/g;
    const anchor = (href) =>
      `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>`;
    let html = "";
    let cursor = 0;
    for (const match of source.matchAll(tokens)) {
      html += escapeHtml(source.slice(cursor, match.index));
      const [raw, escaped, , codeSpan, label, destination, autolink, url] = match;
      if (escaped !== undefined) {
        html += park(escapeHtml(escaped));
      } else if (codeSpan !== undefined) {
        // As in CommonMark: line breaks read as spaces, and one space of
        // padding on both sides is dropped (`` `x` `` shows `x`).
        let code = codeSpan.replace(/\n/g, " ");
        if (/^ [\s\S]* $/.test(code) && /\S/.test(code)) code = code.slice(1, -1);
        const path = links && pathLinks ? filePath(code) : "";
        html += park(path
          ? `<code class="inline path" data-path="${escapeHtml(path)}" role="link" tabindex="0" title="Open ${escapeHtml(path)}">${escapeHtml(code)}</code>`
          : `<code class="inline">${escapeHtml(code)}</code>`);
      } else if (label !== undefined) {
        if (!links) {
          html += escapeHtml(raw);
        } else {
          const target = destination.trim().replace(/^<([\s\S]*)>$/, "$1");
          const title = inlineMarkdown(label, false);
          if (/^https?:\/\/[^\s]+$/i.test(target)) {
            html += park(`<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">${title}</a>`);
          } else {
            const path = pathLinks ? markdownPath(target) : "";
            html += park(path
              ? `<a class="path" data-path="${escapeHtml(path)}" role="link" tabindex="0" title="Open ${escapeHtml(path)}">${title}</a>`
              : escapeHtml(raw));
          }
        }
      } else if (autolink !== undefined) {
        html += park(links ? anchor(autolink) : escapeHtml(autolink));
      } else {
        const clean = trimUrl(url);
        html += park(links ? anchor(clean) : escapeHtml(clean)) + escapeHtml(url.slice(clean.length));
      }
      cursor = match.index + raw.length;
    }
    html += escapeHtml(source.slice(cursor));
    return emphasis(html).replace(/(\d+)/g, (_, n) => parked[n]);
  }

  // ---- block markdown -> element -------------------------------------------
  const FENCE_RE = /^( {0,3})(`{3,})[ \t]*([^\s`]*)[^`]*$/;
  const HEADING_RE = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const QUOTE_RE = /^ {0,3}>/;
  const LIST_RE = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
  // Nested blocks recurse; past this depth the rest renders as plain text.
  const MAX_DEPTH = 16;

  // Indentation width, a tab counting as four columns.
  function indentOf(s) {
    let width = 0;
    for (const c of s) {
      if (c === " ") width++;
      else if (c === "\t") width += 4;
      else break;
    }
    return width;
  }

  function dedent(s, cols) {
    let width = 0;
    let k = 0;
    while (k < s.length && width < cols && (s[k] === " " || s[k] === "\t")) width += s[k++] === "\t" ? 4 : 1;
    return s.slice(k);
  }

  function markdown(text, depth = 0) {
    const root = document.createElement("div");
    root.className = "md";
    const source = String(text == null ? "" : text);
    if (depth > MAX_DEPTH) {
      const p = document.createElement("p");
      p.innerHTML = inlineMarkdown(source).replace(/\n/g, "<br>");
      root.appendChild(p);
      return root;
    }
    const lines = source.split("\n");
    let i = 0;
    let list = null; // current <ul>/<ol>

    const flushList = () => {
      if (list) {
        root.appendChild(list);
        list = null;
      }
    };

    // Split a GFM table row into trimmed cells, tolerating optional leading and
    // trailing pipes. "\|" is a pipe inside a cell, code spans included.
    const splitRow = (s) => {
      const t = s.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
      return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
    };
    // A delimiter row is all-dashes cells (e.g. |---|:--:|---:|) — what marks the
    // line after the header as the start of a table.
    const isDelimRow = (s) =>
      s.indexOf("-") !== -1 &&
      (() => {
        const cells = splitRow(s);
        return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
      })();
    const isTableStart = (k) => lines[k].indexOf("|") !== -1 && k + 1 < lines.length && isDelimRow(lines[k + 1]);

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block — may be indented, as inside a list item
      const fence = line.match(FENCE_RE);
      if (fence) {
        flushList();
        const pad = fence[1].length;
        const body = [];
        i++;
        while (i < lines.length) {
          const close = lines[i].match(/^ {0,3}(`{3,})\s*$/);
          if (close && close[1].length >= fence[2].length) break;
          body.push(lines[i].slice(Math.min(pad, lines[i].match(/^ */)[0].length)));
          i++;
        }
        i++; // skip closing fence
        root.appendChild(codeBlock(body.join("\n"), fence[3]));
        continue;
      }

      // heading
      const h = line.match(HEADING_RE);
      if (h) {
        flushList();
        const el = document.createElement("h" + h[1].length);
        el.className = "md-h";
        el.innerHTML = inlineMarkdown(h[2]);
        root.appendChild(el);
        i++;
        continue;
      }

      // thematic break — checked before lists, since "* * *" also reads as one
      if (HR_RE.test(line)) {
        flushList();
        const hr = document.createElement("hr");
        hr.className = "md-hr";
        root.appendChild(hr);
        i++;
        continue;
      }

      // blockquote: strip one ">" level and render the rest as markdown
      if (QUOTE_RE.test(line)) {
        flushList();
        const body = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) body.push(lines[i++].replace(/^ {0,3}> ?/, ""));
        const quote = document.createElement("blockquote");
        quote.className = "md-quote";
        quote.append(...markdown(body.join("\n"), depth + 1).childNodes);
        root.appendChild(quote);
        continue;
      }

      // list item (- * 1. or 1))
      const li = line.match(LIST_RE);
      if (li) {
        const ordered = /\d/.test(li[2]);
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
        // The item owns the lines indented under its marker — wrapped text,
        // nested lists, code fences — and the blank lines between them, and
        // renders them as markdown of its own.
        const indent = indentOf(li[1]);
        const col = indent + line.length - li[1].length - li[3].length;
        const body = [li[3]];
        i++;
        while (i < lines.length) {
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j === lines.length) break;
          const lead = indentOf(lines[j]);
          // Text wrapped right under the item stays in it even when it is
          // indented less than the item's own text.
          const wrapped = j === i && lead >= 2 && !LIST_RE.test(lines[j]);
          if (lead < indent + 2 && !wrapped) break;
          for (; i <= j; i++) body.push(dedent(lines[i], col));
        }
        const item = document.createElement("li");
        const content = markdown(body.join("\n"), depth + 1);
        // The first paragraph is the item's own text, not a block inside it.
        const first = content.firstElementChild;
        if (first && first.tagName === "P") first.replaceWith(...first.childNodes);
        item.append(...content.childNodes);
        list.appendChild(item);
        continue;
      }

      // GFM table: a header row immediately followed by a delimiter row.
      if (isTableStart(i)) {
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
          if (!(j < lines.length && LIST_RE.test(lines[j]))) flushList();
        }
        i++;
        continue;
      }

      // paragraph (gather consecutive lines until one starts another block;
      // a table header+delimiter pair counts, so a table not preceded by a
      // blank line isn't absorbed and rendered as raw pipes)
      flushList();
      const para = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !FENCE_RE.test(lines[i]) &&
        !HEADING_RE.test(lines[i]) &&
        !HR_RE.test(lines[i]) &&
        !QUOTE_RE.test(lines[i]) &&
        !LIST_RE.test(lines[i]) &&
        !isTableStart(i)
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

  window.RKRender = { escapeHtml, markdown, codeBlock, lineDiff, inlineMarkdown, wireCopyButton, enablePathLinks };
})();
