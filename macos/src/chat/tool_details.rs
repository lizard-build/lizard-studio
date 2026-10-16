//! Tool details stay readable in live chats and in transcript replay.

use std::collections::BTreeMap;
use serde_json::Value;
use super::{Permission, ToolCall, ToolStatus, truncate};

pub enum Detail {
    Command(String),
    Diff(Vec<(char, String)>),
    Code(String, &'static str),
    Edits(Vec<Detail>),
}

/// Keep the complete source so copying a long command or file loses nothing.
pub fn tool_detail(tool: &ToolCall) -> Option<Detail> {
    let s = |key: &str| tool.input.get(key).and_then(Value::as_str).map(str::to_string);
    match tool.name.as_str() {
        "Bash" => s("command").map(Detail::Command),
        "Edit" => edit_detail(&tool.input),
        "MultiEdit" => edit_details(&tool.input),
        "Write" => s("content").map(|c| Detail::Code(c, lang_from_input(&tool.input))),
        _ => None,
    }
}

fn edit_detail(input: &Value) -> Option<Detail> {
    Some(Detail::Diff(line_diff(input.get("old_string")?.as_str()?, input.get("new_string")?.as_str()?)))
}

fn edit_details(input: &Value) -> Option<Detail> {
    let edits: Vec<_> = input.get("edits")?.as_array()?.iter().filter_map(edit_detail).collect();
    if edits.is_empty() { None } else { Some(Detail::Edits(edits)) }
}

fn lang_from_input(input: &Value) -> &'static str {
    lang_from_path(input.get("file_path").and_then(Value::as_str).unwrap_or(""))
}

pub fn lang_from_path(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "js" | "jsx" | "mjs" | "cjs" => "js",
        "ts" | "tsx" => "ts",
        "py" => "py",
        "rs" => "rust",
        "go" => "go",
        "swift" => "swift",
        "c" | "h" | "cpp" | "hpp" | "java" | "kt" => "c",
        "json" => "json",
        "sh" | "bash" | "zsh" => "bash",
        "rb" => "ruby",
        "yaml" | "yml" | "toml" => "yaml",
        "css" => "css",
        "html" => "html",
        "md" => "md",
        _ => "",
    }
}

/// Trim shared ends before LCS, then retain three context lines per change.
/// The cap bounds allocation for generated files and wholesale replacements.
pub fn line_diff(old: &str, new: &str) -> Vec<(char, String)> {
    fn split(s: &str) -> Vec<&str> {
        if s.is_empty() { Vec::new() } else { s.split('\n').collect() }
    }
    let a = split(old);
    let b = split(new);
    let mut prefix = 0;
    while prefix < a.len().min(b.len()) && a[prefix] == b[prefix] { prefix += 1; }
    let mut suffix = 0;
    while suffix < (a.len() - prefix).min(b.len() - prefix)
        && a[a.len() - suffix - 1] == b[b.len() - suffix - 1] { suffix += 1; }
    let ca = &a[prefix..a.len() - suffix];
    let cb = &b[prefix..b.len() - suffix];
    let mut rows = Vec::new();
    rows.extend(a[..prefix].iter().map(|s| (' ', (*s).to_string())));
    if ca.len() > 600 || cb.len() > 600 {
        rows.extend(ca.iter().map(|s| ('-', (*s).to_string())));
        rows.extend(cb.iter().map(|s| ('+', (*s).to_string())));
    } else {
        let width = cb.len() + 1;
        let mut dp = vec![0u16; (ca.len() + 1) * width];
        for x in (0..ca.len()).rev() {
            for y in (0..cb.len()).rev() {
                dp[x * width + y] = if ca[x] == cb[y] {
                    dp[(x + 1) * width + y + 1] + 1
                } else { dp[(x + 1) * width + y].max(dp[x * width + y + 1]) };
            }
        }
        let (mut x, mut y) = (0, 0);
        while x < ca.len() || y < cb.len() {
            if x < ca.len() && y < cb.len() && ca[x] == cb[y] {
                rows.push((' ', ca[x].to_string())); x += 1; y += 1;
            } else if x < ca.len() && (y == cb.len() || dp[(x + 1) * width + y] >= dp[x * width + y + 1]) {
                rows.push(('-', ca[x].to_string())); x += 1;
            } else {
                rows.push(('+', cb[y].to_string())); y += 1;
            }
        }
    }
    rows.extend(a[a.len() - suffix..].iter().map(|s| (' ', (*s).to_string())));
    let mut visible = vec![false; rows.len()];
    for (ix, (sign, _)) in rows.iter().enumerate() {
        if *sign != ' ' {
            let end = (ix + 4).min(rows.len());
            visible[ix.saturating_sub(3)..end].fill(true);
        }
    }
    // An unchanged edit still gives the user a small preview.
    if !visible.iter().any(|v| *v) {
        let end = rows.len().min(6);
        visible[..end].fill(true);
    }
    let mut out = Vec::new();
    let mut skipped = 0;
    for (row, show) in rows.into_iter().zip(visible) {
        if show {
            if skipped > 0 { out.push(('…', format!("{skipped} unchanged {}", if skipped == 1 { "line" } else { "lines" }))); skipped = 0; }
            out.push(row);
        } else { skipped += 1; }
    }
    if skipped > 0 { out.push(('…', format!("{skipped} unchanged {}", if skipped == 1 { "line" } else { "lines" }))); }
    out
}

pub struct AskQuestion {
    pub header: Option<String>,
    pub question: String,
    pub answer: Option<String>,
}

pub struct AskRecord {
    pub questions: Vec<AskQuestion>,
    pub extra_answers: Vec<String>,
    pub dismissed: bool,
}

/// Results use question text as the key, including multi-select and Other answers.
pub fn ask_record(tool: &ToolCall) -> Option<AskRecord> {
    if tool.name != "AskUserQuestion" { return None; }
    let answers = if tool.status == ToolStatus::Error { BTreeMap::new() }
        else { ask_answers(tool.output.as_deref().unwrap_or("")) };
    let questions: Vec<_> = tool.input.get("questions").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|q| {
            let question = q.get("question")?.as_str()?;
            if question.trim().is_empty() { return None; }
            Some(AskQuestion {
                header: q.get("header").and_then(Value::as_str).map(str::to_string),
                question: question.to_string(),
                answer: answers.get(question).cloned(),
            })
        }).take(4).collect();
    if questions.is_empty() { return None; }
    // Preserve the picks even if the CLI's result used different question text.
    let extra_answers = if questions.iter().all(|q| q.answer.is_none()) {
        answers.values().cloned().collect()
    } else { Vec::new() };
    Some(AskRecord {
        dismissed: tool.status != ToolStatus::Running && answers.is_empty(),
        questions,
        extra_answers,
    })
}

/// Match the CLI's `"Question"="Answer", … . You can now continue…` record.
fn ask_answers(text: &str) -> BTreeMap<String, String> {
    let mut answers = BTreeMap::new();
    let mut rest = text;
    while let Some(start) = rest.find('"') {
        rest = &rest[start + 1..];
        let Some(eq) = rest.find("\"=\"") else { break };
        let question = &rest[..eq];
        if question.contains(['\n', '"']) { continue; }
        let value = &rest[eq + 3..];
        let end = value.char_indices().find_map(|(ix, c)| {
            let tail = &value[ix + c.len_utf8()..];
            (c == '"' && (tail.starts_with(", \"") || tail.strip_prefix('.').is_some_and(|s| s.trim_start().starts_with("You can now")) || tail.trim().is_empty())).then_some(ix)
        });
        let Some(end) = end else { break };
        answers.insert(question.to_string(), value[..end].to_string());
        rest = &value[end + 1..];
    }
    answers
}

pub fn permission_detail(perm: &Permission) -> Option<Detail> {
    let s = |key: &str| perm.input.get(key).and_then(Value::as_str).map(str::to_string);
    match perm.tool_name.as_str() {
        "Bash" => s("command").map(Detail::Command),
        // The plan opens in its own review view (agent_events.rs).
        "ExitPlanMode" => None,
        "Edit" => match (s("old_string"), s("new_string")) {
            (Some(old), Some(new)) => Some(Detail::Diff(line_diff(&old, &new))),
            _ => None,
        },
        "MultiEdit" => edit_details(&perm.input),
        "Write" => s("content").map(|c| Detail::Code(c, lang_from_input(&perm.input))),
        _ => s("expression")
            .or_else(|| serde_json::to_string_pretty(&perm.input).ok())
            .map(|t| Detail::Code(truncate(&t, 2000), "json")),
    }
}

#[cfg(test)]
mod tests {
    use super::{Detail, ask_answers, ask_record, lang_from_path, line_diff, tool_detail};
    use crate::chat::{ToolCall, ToolStatus};
    use serde_json::{Value, json};

    fn tool(name: &str, input: Value, output: Option<&str>) -> ToolCall {
        ToolCall { id: "test".into(), name: name.into(), input, status: ToolStatus::Done,
            output: output.map(str::to_string), expanded: false }
    }

    fn rows(lines: &[(char, &str)]) -> Vec<(char, String)> {
        lines.iter().map(|(s, t)| (*s, t.to_string())).collect()
    }

    #[test]
    fn aligns_insertions_deletions_and_repeated_lines() {
        assert_eq!(line_diff("a\nb\nc", "a\nx\nb\nc"), rows(&[(' ', "a"), ('+', "x"), (' ', "b"), (' ', "c")]));
        assert_eq!(line_diff("a\nb\na", "a\na"), rows(&[(' ', "a"), ('-', "b"), (' ', "a")]));
        assert_eq!(line_diff("a\nb\nc\nd", "a\nx\nc\ny"), rows(&[
            (' ', "a"), ('-', "b"), ('+', "x"), (' ', "c"), ('-', "d"), ('+', "y"),
        ]));
    }

    #[test]
    fn handles_empty_unicode_and_trailing_newlines() {
        assert_eq!(line_diff("", ""), Vec::new());
        assert_eq!(line_diff("", "hello\n"), rows(&[('+', "hello"), ('+', "")]));
        assert_eq!(line_diff("old", ""), rows(&[('-', "old")]));
        assert_eq!(line_diff("é\n文", "é\n字"), rows(&[(' ', "é"), ('-', "文"), ('+', "字")]));
        assert_eq!(line_diff("same", "same"), rows(&[(' ', "same")]));
        assert_eq!(line_diff("a", "a\n"), rows(&[(' ', "a"), ('+', "")]));
    }

    #[test]
    fn keeps_three_context_lines_around_separate_hunks() {
        let old = (0..30).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let new = old.replace("\n8\n", "\neight\n").replace("\n22\n", "\ntwenty two\n");
        let diff = line_diff(&old, &new);
        assert_eq!(&diff[..5], &rows(&[('…', "5 unchanged lines"), (' ', "5"), (' ', "6"), (' ', "7"), ('-', "8")]));
        assert!(diff.contains(&('…', "7 unchanged lines".into())));
        assert_eq!(diff.last(), Some(&('…', "4 unchanged lines".into())));
        assert_eq!(diff.iter().filter(|(s, _)| *s == '+' || *s == '-').count(), 4);
    }

    #[test]
    fn trims_large_shared_ends_and_bounds_large_replacements() {
        let prefix = "context\n".repeat(1000);
        let old = format!("{prefix}old\n{prefix}");
        let new = format!("{prefix}new\n{prefix}");
        assert_eq!(line_diff(&old, &new).len(), 10);
        let removed = (0..601).map(|i| format!("old {i}")).collect::<Vec<_>>().join("\n");
        let added = (0..602).map(|i| format!("new {i}")).collect::<Vec<_>>().join("\n");
        let diff = line_diff(&removed, &added);
        assert_eq!(diff.iter().filter(|(s, _)| *s == '-').count(), 601);
        assert_eq!(diff.iter().filter(|(s, _)| *s == '+').count(), 602);
    }

    #[test]
    fn small_diffs_reconstruct_both_inputs() {
        for old_mask in 0..8 {
            for new_mask in 0..8 {
                let text = |mask: usize| (0..3).filter(|i| mask & (1 << i) != 0)
                    .map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
                let old = text(old_mask);
                let new = text(new_mask);
                let diff = line_diff(&old, &new);
                let project = |skip| diff.iter().filter(|(s, _)| *s != skip)
                    .map(|(_, t)| t.as_str()).collect::<Vec<_>>().join("\n");
                assert_eq!(project('+'), old);
                assert_eq!(project('-'), new);
            }
        }
    }

    #[test]
    fn multiedit_keeps_each_edit_and_write_preserves_full_source() {
        let call = tool("MultiEdit", json!({"edits": [
            {"old_string": "a", "new_string": "b"}, {"old_string": "c", "new_string": "d"}
        ]}), None);
        let Some(Detail::Edits(edits)) = tool_detail(&call) else { panic!("missing edits") };
        assert_eq!(edits.len(), 2);
        let content = "é".repeat(7000);
        let write = tool("Write", json!({"file_path": "src/app.TSX", "content": content}), None);
        let Some(Detail::Code(source, lang)) = tool_detail(&write) else { panic!("missing source") };
        assert_eq!(source, content);
        assert_eq!(lang, "ts");
        assert_eq!(lang_from_path("/tmp/file.unknown"), "");
    }

    #[test]
    fn parses_chosen_other_multiline_and_empty_answers() {
        let text = "Your questions have been answered: \"Which?\"=\"A, B\", \"Other?\"=\"My \"custom\" answer\nnext line\", \"Empty?\"=\"\". You can now continue with the user's answers in mind.";
        let answers = ask_answers(text);
        assert_eq!(answers.get("Which?").map(String::as_str), Some("A, B"));
        assert_eq!(answers.get("Other?").map(String::as_str), Some("My \"custom\" answer\nnext line"));
        assert_eq!(answers.get("Empty?").map(String::as_str), Some(""));
        assert!(ask_answers("Denied").is_empty());
        assert!(ask_answers("\"incomplete\"=\"answer").is_empty());
        assert_eq!(ask_answers("\"Q\"=\"A\"").get("Q").map(String::as_str), Some("A"));
    }

    #[test]
    fn question_record_matches_answers_and_ignores_error_results() {
        let mut call = tool("AskUserQuestion", json!({"questions": [
            {"header": "Style", "question": "Which?", "options": [{"label": "A"}]},
            {"question": "Other?"}, {"bad": true}
        ]}), Some("\"Which?\"=\"A\", \"Other?\"=\"Custom\""));
        let record = ask_record(&call).expect("valid record");
        let questions = record.questions;
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].header.as_deref(), Some("Style"));
        assert_eq!(questions[0].answer.as_deref(), Some("A"));
        assert_eq!(questions[1].answer.as_deref(), Some("Custom"));
        assert!(!record.dismissed);
        call.output = Some("\"Different question\"=\"Keep this answer\"".into());
        let fallback = ask_record(&call).unwrap();
        assert_eq!(fallback.extra_answers, ["Keep this answer"]);
        assert!(!fallback.dismissed);
        call.output = None;
        call.status = ToolStatus::Running;
        assert!(!ask_record(&call).unwrap().dismissed);
        call.status = ToolStatus::Error;
        assert!(ask_record(&call).unwrap().questions.iter().all(|q| q.answer.is_none()));
        assert!(ask_record(&call).unwrap().dismissed);
        assert!(ask_record(&tool("AskUserQuestion", json!({"questions": [null, {}]}), None)).is_none());
    }
}
