//! Local shell runs stay outside agent turns; only finished output rides the next prompt.

use gpui_kit::Context;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{ChatSession, Item, parse_iso_ms};
use crate::store::{new_chat_id, now_ms};

const LIVE_CAP: usize = 500_000;
const STORE_CAP: usize = 20_000;
const CONTEXT_CAP: usize = 40_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BashEntry {
    pub id: String,
    pub command: String,
    pub output: String,
    pub code: Option<i64>,
    pub signal: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub ts: u64,
}

pub struct BashRun {
    pub entry: BashEntry,
    pub running: bool,
    /// Byte ranges keep stderr red without changing the shell's line breaks.
    pub stderr: Vec<std::ops::Range<usize>>,
}

impl BashRun {
    fn saved(entry: BashEntry) -> Self {
        Self { entry, running: false, stderr: Vec::new() }
    }

    fn append(&mut self, chunk: &str, stderr: bool) {
        let start = self.entry.output.len();
        self.entry.output.push_str(chunk);
        if stderr && !chunk.is_empty() {
            if let Some(last) = self.stderr.last_mut().filter(|r| r.end == start) {
                last.end += chunk.len();
            } else {
                self.stderr.push(start..start + chunk.len());
            }
        }
        let removed = trim_tail(&mut self.entry.output, LIVE_CAP);
        if removed > 0 {
            self.stderr.retain_mut(|range| {
                range.start = range.start.saturating_sub(removed);
                range.end = range.end.saturating_sub(removed);
                range.start < range.end
            });
        }
    }

    pub fn footer(&self) -> Option<String> {
        if self.running { return None; }
        if let Some(error) = &self.entry.error { return Some(error.clone()); }
        if self.entry.signal.is_some() { return Some("Stopped".into()); }
        self.entry.code.filter(|code| *code != 0).map(|code| format!("Exit {code}"))
    }
}

/// Keep a UTF-8 tail even when a host chunk crosses the limit mid-character.
fn trim_tail(text: &mut String, cap: usize) -> usize {
    let mut start = text.len().saturating_sub(cap);
    while !text.is_char_boundary(start) { start += 1; }
    text.drain(..start);
    start
}

fn format_context(runs: &[BashEntry], cwd: Option<&str>) -> String {
    if runs.is_empty() { return String::new(); }
    let mut parts = Vec::new();
    let mut used = 0;
    for run in runs {
        let status = if run.signal.is_some() { "(stopped)".into() } else {
            format!("(exit {})", run.code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))
        };
        let output = run.output.trim();
        let mut block = format!("$ {}\n{}{}{}", run.command, output, if output.is_empty() { "" } else { "\n" }, status);
        if used + block.len() > CONTEXT_CAP {
            let mut end = CONTEXT_CAP.saturating_sub(used);
            while !block.is_char_boundary(end) { end -= 1; }
            block.truncate(end);
            block.push_str("\n…[truncated]");
            parts.push(block);
            break;
        }
        used += block.len();
        parts.push(block);
    }
    let folder = cwd.map(|cwd| format!(" in {cwd}")).unwrap_or_default();
    format!("[Shell commands the user ran locally via the composer's bash mode{folder}, with their output. The user ran these themselves — treat as context, not as a message they typed.]\n\n{}\n\n", parts.join("\n\n"))
}

impl ChatSession {
    pub fn run_bash(&mut self, command: &str, cx: &mut Context<Self>) {
        if self.meta.cloud || command.trim().is_empty() { return; }
        let Some(cwd) = self.work_cwd() else {
            self.notice(true, "Choose a project folder first.", cx);
            return;
        };
        let entry = BashEntry {
            id: new_chat_id(), command: command.trim().into(), output: String::new(),
            code: None, signal: None, error: None, ts: now_ms(),
        };
        let message = json!({ "type": "bashExec", "execId": entry.id, "command": entry.command, "cwd": cwd });
        let id = entry.id.clone();
        self.tools_open = false;
        self.push(Item::Bash(BashRun { entry, running: true, stderr: Vec::new() }), cx);
        self.touch(cx);
        if self.host.is_connected() {
            self.send(message);
        } else {
            self.on_bash_message(&json!({ "type": "bashExit", "execId": id, "code": 1, "error": "Host disconnected — command not run." }), cx);
        }
    }

    pub fn stop_bash(&self, exec_id: &str) {
        self.send(json!({ "type": "bashKill", "execId": exec_id }));
    }

    /// Shells use the Claude helper even when the chat's agent is ChatGPT.
    pub fn bash_host_exit(&mut self, cx: &mut Context<Self>) {
        let ids: Vec<_> = self.items.iter().filter_map(|item| match item {
            Item::Bash(run) if run.running => Some(run.entry.id.clone()),
            _ => None,
        }).collect();
        for id in ids {
            self.on_bash_message(&json!({ "type": "bashExit", "execId": id, "code": 1, "error": "The shell helper stopped." }), cx);
        }
    }

    pub(super) fn on_bash_message(&mut self, msg: &Value, cx: &mut Context<Self>) {
        let Some(id) = msg.get("execId").and_then(Value::as_str) else { return };
        let Some(ix) = self.items.iter().position(|item| matches!(item, Item::Bash(run) if run.entry.id == id && run.running)) else { return };
        let Item::Bash(run) = &mut self.items[ix] else { return };
        match msg.get("type").and_then(Value::as_str) {
            Some("bashOut") => run.append(msg.get("chunk").and_then(Value::as_str).unwrap_or(""), msg.get("stream").and_then(Value::as_str) == Some("stderr")),
            Some("bashExit") => {
                run.running = false;
                run.entry.code = msg.get("code").and_then(Value::as_i64);
                run.entry.signal = msg.get("signal").and_then(Value::as_str).map(str::to_string);
                run.entry.error = msg.get("error").and_then(Value::as_str).map(str::to_string);
                trim_tail(&mut run.entry.output, STORE_CAP);
                run.stderr.clear();
                self.meta.bash_history.push(run.entry.clone());
                self.meta.bash_pending.push(run.entry.clone());
                let history_len = self.meta.bash_history.len();
                self.meta.bash_history.drain(..history_len.saturating_sub(100));
                let pending_len = self.meta.bash_pending.len();
                self.meta.bash_pending.drain(..pending_len.saturating_sub(20));
                self.touch(cx);
            }
            _ => return,
        }
        self.list.remeasure_items(ix..ix + 1);
        cx.notify();
    }

    pub(super) fn take_bash_context(&mut self) -> String {
        let context = format_context(&self.meta.bash_pending, self.work_cwd().as_deref());
        self.meta.bash_pending.clear();
        context
    }

    /// Newest-first transcript pages only claim runs from their own time range.
    pub(super) fn bash_replay(&self, events: &[Value]) -> Vec<BashEntry> {
        let lower = if self.history.next_cursor.is_some() {
            events.iter().filter_map(|e| e.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms)).min().unwrap_or(u64::MAX)
        } else { 0 };
        let mut runs: Vec<_> = self.meta.bash_history.iter().filter(|entry| {
            entry.ts >= lower && !self.items.iter().any(|item| matches!(item, Item::Bash(run) if run.entry.id == entry.id))
        }).cloned().collect();
        runs.sort_by_key(|entry| entry.ts);
        runs
    }

    pub(super) fn restore_bash(&mut self, cx: &mut Context<Self>) {
        for entry in self.bash_replay(&[]) {
            self.push(Item::Bash(BashRun::saved(entry)), cx);
        }
    }
}

pub(super) fn drain_until(runs: &mut std::iter::Peekable<std::vec::IntoIter<BashEntry>>, at: u64, items: &mut Vec<Item>) -> bool {
    let start = items.len();
    while runs.peek().is_some_and(|entry| entry.ts <= at) {
        items.push(Item::Bash(BashRun::saved(runs.next().unwrap())));
    }
    items.len() != start
}

#[cfg(test)]
mod tests {
    use super::{BashEntry, BashRun, CONTEXT_CAP, LIVE_CAP, drain_until, format_context, trim_tail};
    use crate::chat::{Item, clean_user_text};

    fn entry() -> BashEntry {
        BashEntry { id: "one".into(), command: "pwd".into(), output: " /tmp\n".into(), code: Some(0), signal: None, error: None, ts: 1 }
    }

    #[test]
    fn context_matches_panel_and_bounds_output() {
        assert!(format_context(&[], None).is_empty());
        let mut run = entry();
        let context = format_context(&[run.clone()], Some("/tmp"));
        assert!(context.contains("bash mode in /tmp"));
        assert!(context.ends_with("$ pwd\n/tmp\n(exit 0)\n\n"));
        run.signal = Some("SIGTERM".into());
        assert!(format_context(&[run.clone()], None).contains("(stopped)"));
        run.output = "🦎".repeat(CONTEXT_CAP);
        let context = format_context(&[run], None);
        assert!(context.ends_with("…[truncated]\n\n"));
        assert!(context.len() < CONTEXT_CAP + 400);
    }

    #[test]
    fn stream_tail_preserves_unicode_and_stderr_ranges() {
        let mut text = "abc🦎z".to_string();
        assert_eq!(trim_tail(&mut text, 4), 7);
        assert_eq!(text, "z");
        let mut run = BashRun::saved(entry());
        run.entry.output.clear();
        run.append("bad", true);
        run.append(" error", true);
        assert_eq!(run.stderr, vec![0..9]);
        run.append(&"🦎".repeat(LIVE_CAP / 4), false);
        assert_eq!(run.entry.output.len(), LIVE_CAP);
        assert!(run.stderr.is_empty());
    }

    #[test]
    fn footer_reports_failures_and_stops() {
        let mut run = BashRun::saved(entry());
        assert_eq!(run.footer(), None);
        run.entry.code = Some(2);
        assert_eq!(run.footer().as_deref(), Some("Exit 2"));
        run.entry.signal = Some("SIGTERM".into());
        assert_eq!(run.footer().as_deref(), Some("Stopped"));
        run.entry.error = Some("folder not found".into());
        assert_eq!(run.footer().as_deref(), Some("folder not found"));
    }

    #[test]
    fn replay_interleaves_runs_at_their_timestamp() {
        let first = entry();
        let mut second = entry();
        second.id = "two".into();
        second.ts = 5;
        let mut runs = vec![first, second].into_iter().peekable();
        let mut items = Vec::new();
        assert!(!drain_until(&mut runs, 0, &mut items));
        assert!(drain_until(&mut runs, 1, &mut items));
        assert_eq!(items.len(), 1);
        assert!(matches!(&items[0], Item::Bash(run) if run.entry.id == "one" && !run.running));
        assert!(!drain_until(&mut runs, 4, &mut items));
        assert!(drain_until(&mut runs, u64::MAX, &mut items));
        assert!(matches!(&items[1], Item::Bash(run) if run.entry.id == "two"));
    }

    #[test]
    fn prompt_replay_hides_shell_context() {
        let context = format_context(&[entry()], Some("/tmp"));
        let wire = format!("{}{}{}\n\nExplain this output", crate::chat::CTX_START, context, crate::chat::CTX_END);
        assert_eq!(clean_user_text(&wire), "Explain this output");
        let saved = serde_json::to_string(&entry()).unwrap();
        let loaded: BashEntry = serde_json::from_str(&saved).unwrap();
        assert_eq!(loaded.output, entry().output);
        assert_eq!(loaded.ts, 1);
    }
}
