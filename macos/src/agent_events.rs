//! Synthetic CLI output uses the same rows live and after transcript replay.

use std::time::Duration;

use gpui_kit::component::text::TextViewState;
use gpui_kit::*;
use serde_json::Value;

use super::{ChatSession, Item, tag_value};

#[derive(Default)]
pub(super) struct AgentEvents {
    pub compacting: bool,
    last_usage: Option<String>,
    note_seq: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct UsageRow {
    pub label: String,
    pub pct: u8,
    pub resets: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct UsageReply {
    pub intro: String,
    pub rows: Vec<UsageRow>,
}

pub enum EventItem {
    Hidden,
    Output(Entity<TextViewState>),
    Usage(UsageReply),
    RateLimit { id: u64, warn: bool, fading: bool, hidden: bool },
}

impl EventItem {
    pub fn hidden(&self) -> bool {
        matches!(self, Self::Hidden | Self::RateLimit { hidden: true, .. })
    }
}

/// The permission card's hint is the plan's first nonempty markdown line.
pub fn plan_title(plan: &str) -> String {
    let first = plan.lines().find(|l| !l.trim().is_empty()).unwrap_or("Implementation plan").trim();
    let hashes = first.chars().take_while(|c| *c == '#').count();
    let first = if (1..=6).contains(&hashes) { first[hashes..].trim_start() } else { first };
    first.chars().filter(|c| !matches!(c, '*' | '_' | '`')).collect::<String>().trim().to_string()
}

/// CLI plan windows are lines of `label: NN% used · resets …`.
pub fn parse_usage(text: &str) -> Option<UsageReply> {
    let mut reply = UsageReply { intro: String::new(), rows: Vec::new() };
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let parsed = (|| {
            let (label, value) = line.split_once(':')?;
            let (pct, rest) = value.trim().split_once('%')?;
            if pct.is_empty() || pct.len() > 3 || !pct.bytes().all(|b| b.is_ascii_digit()) { return None; }
            let rest = rest.trim_start();
            let used = rest.get(..4)?;
            if !used.eq_ignore_ascii_case("used") { return None; }
            let rest = rest[4..].trim();
            let mut resets = if rest.is_empty() {
                ""
            } else {
                let rest = rest.strip_prefix('·')?.trim_start();
                if !rest.get(..6)?.eq_ignore_ascii_case("resets") { return None; }
                rest[6..].trim()
            };
            if resets.ends_with(')') {
                if let Some((before, _)) = resets.rsplit_once('(') { resets = before.trim_end(); }
            }
            Some(UsageRow { label: label.trim().to_string(), pct: pct.parse::<u16>().ok()?.min(100) as u8, resets: resets.to_string() })
        })();
        if let Some(row) = parsed {
            reply.rows.push(row);
        } else if reply.rows.is_empty() {
            if !reply.intro.is_empty() { reply.intro.push(' '); }
            reply.intro.push_str(line);
        }
    }
    (!reply.rows.is_empty()).then_some(reply)
}

pub enum CommandOutput {
    Warning(String),
    Compacted,
    Text(String),
}

/// Stdout and stderr can share a single synthetic event; retain both.
pub fn command_output(raw: &str, unwrapped: bool) -> Vec<CommandOutput> {
    let mut output = Vec::new();
    if let Some(err) = tag_value(raw, "local-command-stderr").filter(|s| !s.trim().is_empty()) {
        output.push(CommandOutput::Warning(err.trim().to_string()));
    }
    let text = tag_value(raw, "local-command-stdout").or_else(|| {
        (unwrapped && !raw.contains("<local-command-stderr>")).then(|| raw.to_string())
    });
    if let Some(text) = text.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        output.push(if text.eq_ignore_ascii_case("compacted") { CommandOutput::Compacted } else { CommandOutput::Text(text) });
    }
    output
}

impl ChatSession {
    pub(super) fn reset_agent_events(&mut self) {
        self.agent_events.last_usage = None;
    }

    pub(super) fn finish_compaction(&mut self) {
        if self.agent_events.compacting {
            self.ctx_base = 0;
            self.ctx_tokens = 0;
            self.agent_events.compacting = false;
        }
    }

    /// Handle only synthetic events here; init and normal turns stay in chat.rs.
    pub(super) fn on_agent_event(&mut self, data: &Value, cx: &mut Context<Self>) {
        match data.get("type").and_then(Value::as_str) {
            Some("system") => {
                if data.get("status").and_then(Value::as_str) == Some("compacting") {
                    if !self.running { self.begin_turn(); }
                    self.agent_events.compacting = true;
                    self.status_word = "Compacting…";
                    self.sync_rows(cx);
                }
                if let Some(text) = data.get("content").and_then(Value::as_str) {
                    let unwrapped = data.get("subtype").and_then(Value::as_str) == Some("local_command");
                    self.local_command_output(text, unwrapped, cx);
                }
            }
            Some("rate_limit_event") => {
                let Some(status) = data.pointer("/rate_limit_info/status").and_then(Value::as_str) else { return };
                if !matches!(status, "allowed_warning" | "rejected") { return; }
                self.agent_events.note_seq += 1;
                let id = self.agent_events.note_seq;
                let warn = status == "rejected";
                self.tools_open = false;
                self.push(Item::AgentEvent(EventItem::RateLimit { id, warn, fading: false, hidden: false }), cx);
                if !warn {
                    cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(Duration::from_secs(8)).await;
                        let _ = this.update(cx, |this, cx| this.change_rate_note(id, false, cx));
                        cx.background_executor().timer(Duration::from_millis(180)).await;
                        let _ = this.update(cx, |this, cx| this.change_rate_note(id, true, cx));
                    }).detach();
                }
            }
            _ => {}
        }
    }

    pub fn change_rate_note(&mut self, id: u64, dismiss: bool, cx: &mut Context<Self>) {
        // History paging can move the row while the fade timer is waiting.
        for (ix, item) in self.items.iter_mut().enumerate() {
            if let Item::AgentEvent(EventItem::RateLimit { id: note_id, fading, hidden, .. }) = item {
                if *note_id == id {
                    *fading = true;
                    *hidden |= dismiss;
                    self.list.remeasure_items(ix..ix + 1);
                    cx.notify();
                    break;
                }
            }
        }
    }

    pub(super) fn take_usage_reply(&mut self, text: &str, msg_id: Option<&str>, cx: &mut Context<Self>) -> bool {
        let Some(reply) = parse_usage(text) else { return false };
        let key = text.trim().to_string();
        // A final synthetic reply may also have streamed its raw text.
        let streamed = msg_id.and_then(|id| self.items.iter().position(|i| matches!(i, Item::Assistant { msg_id: Some(mid), .. } if mid == id)));
        if self.agent_events.last_usage.as_ref() == Some(&key) {
            if let Some(ix) = streamed {
                self.items[ix] = Item::AgentEvent(EventItem::Hidden);
                self.list.remeasure_items(ix..ix + 1);
                cx.notify();
            }
            return true;
        }
        self.agent_events.last_usage = Some(key);
        self.tools_open = false;
        if let Some(ix) = streamed {
            self.items[ix] = Item::AgentEvent(EventItem::Usage(reply));
            self.list.remeasure_items(ix..ix + 1);
            cx.notify();
        } else {
            self.push(Item::AgentEvent(EventItem::Usage(reply)), cx);
        }
        true
    }

    pub(super) fn local_command_output(&mut self, raw: &str, unwrapped: bool, cx: &mut Context<Self>) {
        for output in command_output(raw, unwrapped) {
            match output {
                CommandOutput::Warning(text) => self.notice(true, text, cx),
                CommandOutput::Compacted => {
                    self.ctx_base = 0;
                    self.ctx_tokens = 0;
                    self.agent_events.compacting = self.running;
                    self.notice(false, "Context compacted", cx);
                }
                CommandOutput::Text(text) => {
                    if !self.take_usage_reply(&text, None, cx) {
                        self.tools_open = false;
                        let view = cx.new(|cx| TextViewState::markdown(&text, cx).selectable(true));
                        self.push(Item::AgentEvent(EventItem::Output(view)), cx);
                    }
                }
            }
        }
    }

    pub(super) fn replay_usage_items(text: &str, last: &mut Option<UsageReply>) -> Option<Vec<Item>> {
        let reply = parse_usage(text)?;
        if last.as_ref() == Some(&reply) { return Some(Vec::new()); }
        *last = Some(reply.clone());
        Some(vec![Item::AgentEvent(EventItem::Usage(reply))])
    }

    pub(super) fn command_items(raw: &str, unwrapped: bool, last: &mut Option<UsageReply>, cx: &mut Context<Self>) -> Vec<Item> {
        command_output(raw, unwrapped).into_iter().flat_map(|output| match output {
            CommandOutput::Warning(text) => vec![Item::Notice { warn: true, text: text.into() }],
            CommandOutput::Compacted => vec![Item::Notice { warn: false, text: "Context compacted".into() }],
            CommandOutput::Text(text) => {
                Self::replay_usage_items(&text, last).unwrap_or_else(|| {
                    let view = cx.new(|cx| TextViewState::markdown(&text, cx).selectable(true));
                    vec![Item::AgentEvent(EventItem::Output(view))]
                })
            }
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{CommandOutput, command_output, parse_usage, plan_title};
    use crate::chat::ChatSession;

    #[test]
    fn plan_hint_keeps_first_nonempty_line() {
        assert_eq!(plan_title("\n  ## **A `plan`**\nrest"), "A plan");
        assert_eq!(plan_title("\n\n"), "Implementation plan");
        assert_eq!(plan_title("### План 🦎"), "План 🦎");
    }

    #[test]
    fn usage_windows_and_reset_zones() {
        let usage = parse_usage("Your plan\nCurrent session: 52% used · resets Jul 3 at 2:20am (Asia/Dubai)\nCurrent week (Opus): 116% used").unwrap();
        assert_eq!(usage.intro, "Your plan");
        assert_eq!(usage.rows.len(), 2);
        assert_eq!(usage.rows[0].label, "Current session");
        assert_eq!(usage.rows[0].pct, 52);
        assert_eq!(usage.rows[0].resets, "Jul 3 at 2:20am");
        assert_eq!(usage.rows[1].pct, 100);
        assert!(parse_usage("Cost: $0.52\nText: 5% useful").is_none());
        assert!(parse_usage("Current session: 5% used extra").is_none());
    }

    #[test]
    fn replay_usage_echoes_collapse_until_the_next_command() {
        let mut last = None;
        let text = "Current session: 52% used";
        assert_eq!(ChatSession::replay_usage_items(text, &mut last).unwrap().len(), 1);
        assert!(ChatSession::replay_usage_items(text, &mut last).unwrap().is_empty());
        assert!(ChatSession::replay_usage_items("ordinary prose", &mut last).is_none());
        last = None;
        assert_eq!(ChatSession::replay_usage_items(text, &mut last).unwrap().len(), 1);
    }

    #[test]
    fn command_wrappers_preserve_errors_and_compaction() {
        let output = command_output("<local-command-stderr> uh oh </local-command-stderr>\n<local-command-stdout> cOmPaCtEd </local-command-stdout>", false);
        assert!(matches!(&output[0], CommandOutput::Warning(s) if s == "uh oh"));
        assert!(matches!(&output[1], CommandOutput::Compacted));
        assert!(command_output("normal user text", false).is_empty());
        assert!(matches!(&command_output("# Context\n```\ntokens\n```", true)[0], CommandOutput::Text(s) if s.contains("tokens")));
        assert!(command_output("<local-command-stdout> </local-command-stdout>", false).is_empty());
    }
}
