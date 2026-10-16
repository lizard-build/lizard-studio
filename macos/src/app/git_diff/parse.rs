//! Diff rows and word ranges stay independent of GPUI so host output is testable.

use std::ops::Range;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Kind { Context, Add, Delete }

#[derive(Debug)]
pub(super) struct Row {
    pub kind: Kind,
    pub old: Option<u64>,
    pub new: Option<u64>,
    pub text: String,
    pub highlights: Vec<Range<usize>>,
    hunk: usize,
}

/// Accept both host hunk bodies and complete unified diffs; metadata has no gutter.
pub(super) fn parse_rows(diff: &str) -> Vec<Row> {
    let mut rows = Vec::new();
    let (mut old, mut new, mut hunk) = (0, 0, 0);
    let mut in_hunk = false;
    for line in diff.lines() {
        if line.starts_with("@@") {
            in_hunk = false;
            if let Some((a, b)) = hunk_start(line) {
                (old, new) = (a, b);
                hunk += 1;
                in_hunk = true;
            }
            continue;
        }
        if line.starts_with("diff --git ") { in_hunk = false; }
        if !in_hunk { continue; }
        let (kind, old_no, new_no) = match line.as_bytes().first() {
            Some(b'+') => { let n = new; new += 1; (Kind::Add, None, Some(n)) }
            Some(b'-') => { let n = old; old += 1; (Kind::Delete, Some(n), None) }
            Some(b' ') => { let (a, b) = (old, new); old += 1; new += 1; (Kind::Context, Some(a), Some(b)) }
            _ => continue,
        };
        rows.push(Row { kind, old: old_no, new: new_no, text: line[1..].into(), highlights: Vec::new(), hunk });
    }
    let mut i = 0;
    while i < rows.len() {
        if rows[i].kind != Kind::Delete { i += 1; continue; }
        let hunk = rows[i].hunk;
        let mut d = i;
        while d < rows.len() && rows[d].hunk == hunk && rows[d].kind == Kind::Delete { d += 1; }
        let mut a = d;
        while a < rows.len() && rows[a].hunk == hunk && rows[a].kind == Kind::Add { a += 1; }
        if d - i == a - d {
            for k in 0..d - i {
                let (deleted, added) = pair_words(&rows[i + k].text, &rows[d + k].text);
                rows[i + k].highlights = deleted;
                rows[d + k].highlights = added;
            }
        }
        i = a;
    }
    rows
}

fn hunk_start(line: &str) -> Option<(u64, u64)> {
    let mut parts = line.strip_prefix("@@ -")?.split_whitespace();
    let old = parts.next()?.split(',').next()?.parse().ok()?;
    let new = parts.next()?.strip_prefix('+')?.split(',').next()?.parse().ok()?;
    (parts.next()? == "@@").then_some((old, new))
}

/// The panel tokenizes ASCII words, whitespace runs and individual punctuation.
/// Byte ranges keep non-ASCII text safe for GPUI's styled text.
fn tokens(text: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut previous = 0;
    for (i, c) in text.char_indices() {
        let kind = if c.is_whitespace() { 1 } else if c.is_ascii_alphanumeric() || c == '_' { 2 } else { 3 };
        if i > start && (kind != previous || kind == 3) {
            result.push(&text[start..i]);
            start = i;
        }
        previous = kind;
    }
    if start < text.len() { result.push(&text[start..]); }
    result
}

fn push_range(ranges: &mut Vec<Range<usize>>, range: Range<usize>) {
    if let Some(last) = ranges.last_mut().filter(|r| r.end == range.start) {
        last.end = range.end;
    } else {
        ranges.push(range);
    }
}

/// Token LCS, capped like chat.js pairWordDiff; unrelated lines need only row tint.
pub(super) fn pair_words(old: &str, new: &str) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
    let (x, y) = (tokens(old), tokens(new));
    let (n, m) = (x.len(), y.len());
    if n == 0 || m == 0 || n > 300 || m > 300 { return (Vec::new(), Vec::new()); }
    let mut dp = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if x[i] == y[j] { dp[i + 1][j + 1] + 1 } else { dp[i + 1][j].max(dp[i][j + 1]) };
        }
    }
    if 4 * usize::from(dp[0][0]) < n + m { return (Vec::new(), Vec::new()); }
    let (mut deleted, mut added) = (Vec::new(), Vec::new());
    let (mut i, mut j, mut xo, mut yo) = (0, 0, 0, 0);
    while i < n || j < m {
        if i < n && j < m && x[i] == y[j] {
            xo += x[i].len(); yo += y[j].len(); i += 1; j += 1;
        } else if i < n && (j == m || dp[i + 1][j] >= dp[i][j + 1]) {
            push_range(&mut deleted, xo..xo + x[i].len());
            xo += x[i].len(); i += 1;
        } else {
            push_range(&mut added, yo..yo + y[j].len());
            yo += y[j].len(); j += 1;
        }
    }
    (deleted, added)
}

/// Separate hunks never share a context fold, even when adjacent in the payload.
pub(super) fn context_end(rows: &[Row], start: usize) -> usize {
    let mut end = start;
    while end < rows.len() && rows[end].kind == Kind::Context && rows[end].hunk == rows[start].hunk { end += 1; }
    end
}

#[cfg(test)]
mod tests {
    use super::{Kind, context_end, pair_words, parse_rows};

    #[test]
    fn parses_hunks_and_skips_metadata() {
        let rows = parse_rows("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -4,2 +8,2 @@ title\n same\n-old\n+new\n\\ No newline at end of file\n@@ -20 +30 @@\n-last\n+next\n");
        assert_eq!(rows.len(), 5);
        assert_eq!((rows[0].old, rows[0].new, rows[0].text.as_str()), (Some(4), Some(8), "same"));
        assert_eq!((rows[1].kind, rows[1].old, rows[1].new), (Kind::Delete, Some(5), None));
        assert_eq!((rows[2].kind, rows[2].old, rows[2].new), (Kind::Add, None, Some(9)));
        assert_eq!((rows[3].old, rows[4].new), (Some(20), Some(30)));
    }

    #[test]
    fn parses_new_deleted_and_blank_lines() {
        let rows = parse_rows("@@ -0,0 +1,2 @@\n+\n+++content\n");
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].new, rows[0].text.as_str()), (Some(1), ""));
        assert_eq!(rows[1].text, "++content");
        let rows = parse_rows("@@ -1,1 +0,0 @@\n-deleted");
        assert_eq!((rows[0].old, rows[0].new), (Some(1), None));
        assert!(parse_rows("metadata\n@@ broken\n+ignored").is_empty());
    }

    #[test]
    fn highlights_each_changed_word() {
        let old = "lizard-code and lizard-code";
        let new = "lizard-studio and lizard-studio";
        let (d, a) = pair_words(old, new);
        assert_eq!(d.iter().map(|r| &old[r.clone()]).collect::<Vec<_>>(), ["code", "code"]);
        assert_eq!(a.iter().map(|r| &new[r.clone()]).collect::<Vec<_>>(), ["studio", "studio"]);
    }

    #[test]
    fn highlights_insertions_and_unicode_on_byte_boundaries() {
        let (d, a) = pair_words("let café = 1;", "let café = 2;");
        assert_eq!((d, a), (vec![12..13], vec![12..13]));
        let (d, a) = pair_words("call(value)", "call(new_value, value)");
        assert!(d.is_empty());
        assert_eq!(a, vec![5..16]);
    }

    #[test]
    fn skips_unrelated_empty_and_oversized_pairs() {
        for (old, new) in [("foo", "bar"), ("", "x"), ("same", "same")] {
            assert_eq!(pair_words(old, new), (vec![], vec![]));
        }
        assert_eq!(pair_words(&"x ".repeat(151), &"y ".repeat(151)), (vec![], vec![]));
    }

    #[test]
    fn only_pairs_equal_runs_in_the_same_hunk() {
        let rows = parse_rows("@@ -1,2 +1,1 @@\n-let x = 1;\n-let y = 1;\n+let x = 2;");
        assert!(rows.iter().all(|r| r.highlights.is_empty()));
        let rows = parse_rows("@@ -1 +1,0 @@\n-let x = 1;\n@@ -8,0 +8 @@\n+let x = 2;");
        assert!(rows.iter().all(|r| r.highlights.is_empty()));
        let rows = parse_rows("@@ -1 +1 @@\n-let x = 1;\n+let x = 2;");
        assert_eq!(rows[0].highlights, vec![8..9]);
        assert_eq!(rows[1].highlights, vec![8..9]);
    }

    #[test]
    fn separates_context_runs_at_hunk_boundaries() {
        let rows = parse_rows("@@ -1,3 +1,3 @@\n a\n b\n c\n@@ -20 +20 @@\n d");
        assert_eq!(context_end(&rows, 0), 3);
        assert_eq!(context_end(&rows, 3), 4);
    }
}
