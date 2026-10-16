//! The panel's copyable tool source, contextual diffs and durable answers.

use gpui_kit::base::{SelectableText, TextView, TextViewStyle};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::chat::{Detail, ToolCall, ask_record};
use crate::theme::*;
use crate::ui::ph;

/// Keep the copy action outside the scroll area, as in `.code-wrap`.
fn copy_wrap(id: ElementId, text: String, content: impl IntoElement) -> Stateful<Div> {
    let group: SharedString = format!("tool-code-{id:?}").into();
    div()
        .id(id.clone())
        .group(group.clone())
        .relative()
        .w_full()
        .child(content)
        .child(
            div()
                .id((id, "copy"))
                .absolute()
                .top(px(6.))
                .right(px(6.))
                .size(px(22.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .bg(hex(BG_SECONDARY))
                .cursor_pointer()
                .invisible()
                .group_hover(group, |s| s.visible())
                .hover(|s| s.bg(white_a(0.1)).text_color(hex(TEXT_PRIMARY)))
                .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Copy").build(window, cx))
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
                })
                .child(ph("copy", 12., hex(TEXT_TERTIARY))),
        )
}

pub(super) fn code_block(id: impl Into<ElementId>, text: String, error: bool) -> Stateful<Div> {
    source_block(id.into(), text, "", error, false)
}

fn source_block(id: ElementId, text: String, lang: &'static str, error: bool, command: bool) -> Stateful<Div> {
    let source = fenced_code(&text, lang);
    let block_style = StyleRefinement::default()
        .p(px(0.))
        .border_0()
        .bg(hsla(0., 0., 0., 0.))
        .text_size(px(12.))
        .line_height(relative(1.5))
        .font_family("Lizard Mono");
    let content = div()
        .id((id.clone(), "scroll"))
        .relative()
        .w_full()
        .max_h(px(320.))
        .overflow_y_scroll()
        .px(px(12.))
        .py(px(10.))
        .when(command, |d| d.pl(px(24.)))
        .rounded(px(8.))
        .bg(if error { rgba_hex(RED, 0.1) } else { white_a(0.05) })
        .text_color(hex(TEXT_PRIMARY))
        .child(
            TextView::markdown((id.clone(), "source"), source)
                .style(TextViewStyle::default().with_foreground(hex(TEXT_PRIMARY)).with_code_block(block_style))
                // Suppress the language badge: the copy action holds that corner.
                .code_block_actions(|_, _, _| div())
                .code_block_highlighter(move |block| {
                    highlight_tokens(&block.code(), lang).into_iter().map(|(range, color)| {
                        (range, HighlightStyle { color: Some(hex(color)), ..Default::default() })
                    }).collect()
                }),
        )
        .when(command, |d| d.child(
            div().absolute().left(px(12.)).top(px(10.))
                .font_family("Lizard Mono").text_size(px(12.)).line_height(relative(1.5))
                .text_color(hex(TEXT_TERTIARY)).child("$"),
        ));
    copy_wrap(id, text, content)
}

fn diff_block(id: ElementId, lines: Vec<(char, String)>) -> Stateful<Div> {
    let patch = lines.iter().map(|(sign, line)| format!("{sign} {line}")).collect::<Vec<_>>().join("\n");
    let content = div()
        .id((id.clone(), "scroll"))
        .w_full()
        .max_h(px(320.))
        .overflow_y_scroll()
        .py(px(8.))
        .rounded(px(8.))
        .bg(white_a(0.05))
        .font_family("Lizard Mono")
        .text_size(px(12.))
        .line_height(relative(1.5))
        .children(lines.into_iter().enumerate().map(|(ix, (sign, line))| {
            let (bg, fg) = match sign {
                '+' => (rgba_hex(EMERALD, 0.12), hex(0xb9f6ca)),
                '-' => (rgba_hex(RED, 0.12), hex(0xffcdd2)),
                _ => (hsla(0., 0., 0., 0.), hex(TEXT_SECONDARY)),
            };
            div().px(px(10.)).bg(bg).text_color(fg)
                .child(SelectableText::new((id.clone(), ix.to_string()), format!("{sign} {line}")))
        }));
    copy_wrap(id, patch, content)
}

pub(super) fn render_detail(id: SharedString, detail: Detail) -> AnyElement {
    match detail {
        Detail::Command(command) => source_block(id.into(), command, "bash", false, true).into_any_element(),
        Detail::Code(code, lang) => source_block(id.into(), code, lang, false, false).into_any_element(),
        Detail::Diff(lines) => diff_block(id.into(), lines).into_any_element(),
        Detail::Edits(edits) => div().flex().flex_col().gap(px(8.))
            .children(edits.into_iter().enumerate().map(|(ix, detail)| render_detail(format!("{id}-{ix}").into(), detail)))
            .into_any_element(),
    }
}

pub(super) fn render_ask(tool: &ToolCall) -> AnyElement {
    let Some(record) = ask_record(tool) else { return div().into_any_element() };
    div()
        .w_full()
        .flex()
        .flex_col()
        .rounded(px(10.))
        .bg(hex(BG_CARD))
        .px(px(12.))
        .pt(px(10.))
        .pb(px(12.))
        .child(
            div().flex().items_center().gap(px(7.)).text_size(px(12.))
                .font_weight(FontWeight::MEDIUM).text_color(hex(TEXT_SECONDARY))
                .child(ph("chat", 14., hex(TEXT_TERTIARY))).child("Claude asked"),
        )
        .children(record.questions.into_iter().map(|q| {
            div().pl(px(21.))
                .when_some(q.header, |d, header| d.child(
                    div().flex().child(
                        div().mt(px(8.)).px(px(8.)).py(px(1.)).rounded_full().border_1()
                            .border_color(white_a(0.08)).text_size(px(10.5)).text_color(hex(TEXT_SECONDARY)).child(header),
                    ),
                ))
                .child(div().mt(px(6.)).text_size(px(14.)).line_height(px(20.)).text_color(hex(TEXT_PRIMARY)).child(q.question))
                .when_some(q.answer, |d, answer| d.child(answer_line(answer)))
        }))
        .children(record.extra_answers.into_iter().map(|answer| div().pl(px(21.)).child(answer_line(answer))))
        .when(record.dismissed, |d| d.child(
            div().ml(px(21.)).mt(px(6.)).text_size(px(12.)).font_weight(FontWeight::MEDIUM)
                .text_color(hex(TEXT_TERTIARY)).child("Dismissed"),
        ))
        .into_any_element()
}

fn answer_line(answer: String) -> Div {
    div().mt(px(4.)).flex().items_start().gap(px(6.)).text_size(px(12.)).line_height(px(16.))
        .font_weight(FontWeight::MEDIUM).text_color(hex(TEXT_PRIMARY))
        .child(div().mt(px(2.)).flex_none().child(ph("check", 12., hex(EMERALD))))
        .child(if answer.is_empty() { "—".to_string() } else { answer })
}

/// A longer fence prevents arbitrary tool output from becoming Markdown.
fn fenced_code(text: &str, lang: &str) -> String {
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat((longest + 1).max(3));
    format!("{fence}{lang}\n{text}\n{fence}")
}

/// A small lexer: strings and comments protect their contents from keywords.
fn highlight_tokens(text: &str, lang: &str) -> Vec<(std::ops::Range<usize>, u32)> {
    if lang.is_empty() || matches!(lang, "md" | "html") { return Vec::new(); }
    let hash = matches!(lang, "py" | "python" | "bash" | "sh" | "ruby" | "yaml" | "toml");
    let slash = matches!(lang, "js" | "ts" | "rust" | "go" | "swift" | "c" | "css");
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut ix = 0;
    while ix < bytes.len() {
        let start = ix;
        if (hash && bytes[ix] == b'#') || (slash && text[ix..].starts_with("//")) {
            ix = text[ix..].find('\n').map_or(bytes.len(), |end| ix + end);
            spans.push((start..ix, TEXT_TERTIARY));
        } else if slash && text[ix..].starts_with("/*") {
            ix = text[ix + 2..].find("*/").map_or(bytes.len(), |end| ix + end + 4);
            spans.push((start..ix, TEXT_TERTIARY));
        } else if matches!(bytes[ix], b'\'' | b'"' | b'`') {
            let quote = bytes[ix]; ix += 1;
            while ix < bytes.len() {
                if bytes[ix] == b'\\' { ix = (ix + 2).min(bytes.len()); }
                else if bytes[ix] == quote { ix += 1; break; }
                else { ix += 1; }
            }
            spans.push((start..ix, 0xc3e88d));
        } else if bytes[ix].is_ascii_alphabetic() || bytes[ix] == b'_' {
            ix += 1;
            while ix < bytes.len() && (bytes[ix].is_ascii_alphanumeric() || bytes[ix] == b'_') { ix += 1; }
            if matches!(&text[start..ix],
                "const" | "let" | "var" | "function" | "return" | "if" | "else" | "for" | "while" |
                "class" | "new" | "this" | "import" | "from" | "export" | "default" | "async" | "await" |
                "try" | "catch" | "throw" | "switch" | "case" | "break" | "continue" | "in" | "of" |
                "true" | "false" | "null" | "undefined" | "def" | "elif" | "lambda" | "pass" | "with" |
                "as" | "is" | "not" | "and" | "or" | "None" | "True" | "False" | "self" | "fn" |
                "mut" | "pub" | "struct" | "enum" | "impl" | "match" | "use" | "type" | "interface" |
                "public" | "private" | "static" | "package" | "func" | "go" | "defer" | "nil" |
                "end" | "then" | "echo" | "fi") {
                spans.push((start..ix, 0xc792ea));
            }
        } else {
            ix += text[ix..].chars().next().map_or(1, char::len_utf8);
        }
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::{fenced_code, highlight_tokens};
    use crate::theme::TEXT_TERTIARY;

    #[test]
    fn source_cannot_close_its_fence() {
        assert_eq!(fenced_code("```\nhello", "js"), "````js\n```\nhello\n````");
    }

    #[test]
    fn strings_and_comments_protect_keywords() {
        let text = "const x = 'return # text'; // let x";
        let spans = highlight_tokens(text, "js");
        assert_eq!(spans, vec![(0..5, 0xc792ea), (10..25, 0xc3e88d), (27..35, TEXT_TERTIARY)]);
        assert!(highlight_tokens("# return", "py").iter().all(|(_, c)| *c == TEXT_TERTIARY));
        assert_eq!(highlight_tokens("const café = \"é\\\"文\"", "js").len(), 2);
    }
}
