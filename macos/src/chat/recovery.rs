//! Keep failed sessions and history reads retryable without discarding drafts.

use std::time::{Duration, Instant};

use gpui_kit::*;
use serde_json::{Value, json};

use super::{ChatSession, History, Item, restore_surrogates};
use crate::store::{Agent, now_ms};

pub struct SessionFailure {
    pub message: String,
    pub kind: FailureKind,
    pub details: bool,
    pub connecting: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    Reconnect,
    HistoryMissing,
    UpdateHelper,
    InvalidMode,
}

impl SessionFailure {
    pub fn title(&self, agent: Agent) -> String {
        match self.kind {
            FailureKind::HistoryMissing => "Chat history unavailable".into(),
            FailureKind::UpdateHelper => "Update the local helper".into(),
            _ => format!("{} couldn't connect", agent.label()),
        }
    }

    pub fn description(&self) -> &'static str {
        match self.kind {
            FailureKind::HistoryMissing => "The agent can't find this chat's saved history. Start a new chat with your draft. This chat will stay in the list.",
            FailureKind::UpdateHelper => "This helper sent ChatGPT to the wrong agent. Update it, then reconnect.",
            FailureKind::InvalidMode => "Choose a supported permission setting, then try again.",
            FailureKind::Reconnect => "The session stopped. You can reconnect and keep this chat.",
        }
    }

    pub fn action(&self) -> &'static str {
        if self.connecting { return "Connecting…"; }
        match self.kind {
            FailureKind::HistoryMissing => "Start new chat",
            FailureKind::UpdateHelper => "Update helper",
            _ => "Reconnect",
        }
    }
}

fn failure_kind(message: &str, code: Option<&str>) -> FailureKind {
    let lower = message.to_lowercase();
    match code {
        Some("CHAT_HISTORY_MISSING") => FailureKind::HistoryMissing,
        Some("AGENT_ROUTING_REQUIRED") => FailureKind::UpdateHelper,
        Some("INVALID_PERMISSION_MODE") => FailureKind::InvalidMode,
        _ if lower.contains("no rollout found for thread id") => FailureKind::HistoryMissing,
        _ if lower.contains("permission-mode") && lower.contains("workspace") && lower.contains("invalid") => FailureKind::UpdateHelper,
        _ if lower.contains("permission-mode") && lower.contains("invalid") => FailureKind::InvalidMode,
        _ => FailureKind::Reconnect,
    }
}

pub(super) fn session_error(message: &str, code: Option<&str>) -> bool {
    failure_kind(message, code) != FailureKind::Reconnect
        || message.contains("Couldn't start ChatGPT")
        || message.contains("Couldn't open a ChatGPT session")
        || message.contains("This ChatGPT chat has no session")
        || message.contains("This ChatGPT session isn't running")
}

fn restored_elapsed(start: Option<u64>, now: u64) -> Duration {
    Duration::from_millis(start.filter(|s| *s > 0).map_or(0, |s| now.saturating_sub(s)))
}

/// A disk page can include the very reply the daemon just replayed.
fn reply_boundary(events: &[Value], message_ids: &[&str], tool_ids: &[&str]) -> usize {
    events.iter().position(|event| {
        event.pointer("/message/id").and_then(Value::as_str).is_some_and(|id| message_ids.contains(&id))
            || event.pointer("/message/content").and_then(Value::as_array).is_some_and(|blocks| blocks.iter().any(|b| {
                b.get("type").and_then(Value::as_str) == Some("tool_use")
                    && b.get("id").and_then(Value::as_str).is_some_and(|id| tool_ids.contains(&id))
            }))
    }).unwrap_or(events.len())
}

impl History {
    /// A late timeout must leave a newer retry untouched, including its cursor.
    fn fail(&mut self, request: Option<&str>) -> bool {
        if !self.loading || request.is_some_and(|id| self.request_id.as_deref() != Some(id)) { return false; }
        self.loading = false;
        self.error = true;
        self.request_id = None;
        self.parts.clear();
        self.total = None;
        true
    }

    fn part(&mut self, msg: &Value) -> Result<Option<Value>, ()> {
        let index = msg.get("index").and_then(Value::as_u64).ok_or(())?;
        let total = msg.get("total").and_then(Value::as_u64).ok_or(())?;
        let text = msg.get("text").and_then(Value::as_str).ok_or(())?;
        if total == 0 || total > 100_000 || index >= total || index != self.parts.len() as u64 || self.total.is_some_and(|n| n != total) {
            return Err(());
        }
        self.total = Some(total);
        self.parts.push(Some(text.into()));
        if self.parts.len() as u64 != total { return Ok(None); }
        let joined: String = self.parts.drain(..).flatten().collect();
        let full: Value = serde_json::from_str(&restore_surrogates(&joined)).map_err(|_| ())?;
        if full.get("requestId") != msg.get("requestId") || full.get("sessionId") != msg.get("sessionId") { return Err(()); }
        Ok(Some(full))
    }
}

impl ChatSession {
    pub fn session_failed(&mut self, message: String, code: Option<&str>, cx: &mut Context<Self>) {
        self.failure = Some(SessionFailure { kind: failure_kind(&message, code), message, details: false, connecting: false });
        self.started = false;
        self.start_pending = false;
        self.restart_pending = false;
        self.permissions.clear();
        self.fail_history(cx);
        if self.running { self.end_turn(cx); }
        self.sync_rows(cx);
    }

    pub fn reconnect_session(&mut self, cx: &mut Context<Self>) {
        if self.failure.as_ref().is_some_and(|f| f.connecting) { return; }
        if let Some(failure) = &mut self.failure { failure.connecting = true; }
        self.started = false;
        self.ensure_started(cx);
        cx.notify();
    }

    pub fn on_agent_exit(&mut self, cx: &mut Context<Self>) {
        if self.meta.cloud { return; }
        self.abort_rewind(cx);
        self.start_pending = false;
        let had_session = self.started || self.running;
        self.started = false;
        self.fail_history(cx);
        self.fail_question_sends(cx);
        if let Some(failure) = &mut self.failure { failure.connecting = false; }
        if had_session && self.failure.is_none() {
            self.session_failed(format!("The {} helper stopped.", self.meta.agent.label()), None, cx);
        } else if self.running {
            self.end_turn(cx);
        }
        cx.notify();
    }

    pub(super) fn dispatch_queued(&mut self, cx: &mut Context<Self>) {
        self.flush_queued(cx);
    }

    pub(super) fn watch_session_start(&mut self, cx: &mut Context<Self>) {
        self.start_pending = true;
        self.start_sequence += 1;
        let request = self.start_sequence;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(150)).await;
            let _ = this.update(cx, |this, cx| {
                if this.start_pending && this.start_sequence == request {
                    this.session_failed("The agent did not finish connecting. Reconnect to try again.".into(), None, cx);
                }
            });
        }).detach();
    }

    /// Replace a stale partial reply with the daemon's complete journal.
    pub fn prepare_restore(&mut self, cx: &mut Context<Self>) -> bool {
        let replay = self.items.is_empty() || self.running;
        self.restoring = true;
        if self.running {
            let old_len = self.items.len();
            self.items.truncate(self.turn_first_item);
            self.list.splice(self.items.len()..old_len, 0);
            self.stream_blocks.clear();
            self.streamed_msg_ids.clear();
            self.last_stream_id = None;
            self.permissions.clear();
            self.tools_open = false;
            self.reindex_tools();
            self.sync_rows(cx);
            self.remeasure_tail();
        }
        replay
    }

    pub fn finish_restore(&mut self, snapshot: &Value, cx: &mut Context<Self>) {
        let started = snapshot.get("started").and_then(Value::as_bool).unwrap_or(false);
        let running = snapshot.get("running").and_then(Value::as_bool).unwrap_or(false);
        let failed = snapshot.get("failed").and_then(Value::as_bool).unwrap_or(false);
        self.submitted |= snapshot.get("submitted").and_then(Value::as_bool) == Some(true) || running;
        if let Some(id) = snapshot.get("sessionId").and_then(Value::as_str) {
            self.meta.session_id = Some(id.into());
            self.touch(cx);
        }
        self.started = started;
        self.start_pending = false;
        if running {
            self.failure = None;
            self.turn_started_at = Instant::now().checked_sub(restored_elapsed(snapshot.get("turnStartedAt").and_then(Value::as_u64), now_ms()));
        } else {
            self.turn_started_at = None;
        }
        self.running = running;
        self.restoring = false;
        if failed && !started && !running && self.failure.is_none() {
            self.session_failed("The previous session stopped. Reconnect to continue this chat.".into(), None, cx);
        }
        if !failed { self.dispatch_queued(cx); }
        self.sync_rows(cx);
    }

    #[cfg(feature = "snapshot")]
    pub fn restore_from_daemon(&mut self, started: bool, running: bool, cx: &mut Context<Self>) {
        self.finish_restore(&json!({ "started": started, "running": running }), cx);
    }

    /// The session's permission mode wins. Its model is a full id the picker
    /// may not list, so the chat keeps its own (chat.js reflectModel).
    pub(super) fn apply_init_settings(&mut self, data: &Value, cx: &mut Context<Self>) {
        if let Some(mode) = data.get("permissionMode").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            if self.meta.permission_mode.as_deref() != Some(mode) {
                self.meta.permission_mode = Some(mode.into());
                self.touch(cx);
            }
        }
        cx.notify();
    }

    pub fn history_error(&self) -> bool { self.history.error }

    pub fn fail_history(&mut self, cx: &mut Context<Self>) {
        if self.history.fail(None) {
            // Prompts held for Claude's turn count go out without it.
            self.flush_queued(cx);
            cx.notify();
        }
    }

    pub fn retry_history(&mut self, cx: &mut Context<Self>) {
        if !self.history.loading {
            self.request_history_page(self.history.cursor.clone(), cx);
        }
    }

    pub fn load_history(&mut self, cx: &mut Context<Self>) {
        if self.history.requested { return; }
        if self.meta.cloud {
            self.history.requested = true;
            return self.replay_cloud(cx);
        }
        if self.submitted && self.meta.session_id.is_some() {
            self.history.requested = true;
            self.request_history_page(None, cx);
        } else if !self.items.iter().any(|item| matches!(item, Item::Bash(_))) {
            self.restore_bash(cx);
        }
    }

    pub fn load_earlier(&mut self, cx: &mut Context<Self>) {
        if self.history.loading || self.history.error || self.rewind.pending.is_some() { return; }
        if let Some(cursor) = self.history.next_cursor.clone() {
            self.request_history_page(Some(cursor), cx);
        }
    }

    fn request_history_page(&mut self, cursor: Option<Value>, cx: &mut Context<Self>) {
        let Some(session_id) = self.meta.session_id.clone() else { return };
        self.history.sequence += 1;
        let request_id = format!("h-{}-{}", now_ms(), self.history.sequence);
        self.history.loading = true;
        self.history.error = false;
        self.history.cursor = cursor.clone();
        self.history.request_id = Some(request_id.clone());
        self.history.parts.clear();
        self.history.total = None;
        let mut message = json!({ "type": "loadTranscript", "sessionId": session_id, "cwd": self.meta.cwd,
            "requestId": request_id, "paged": true, "cursor": cursor });
        if self.meta.agent == crate::store::Agent::Codex {
            message["excludeTurnIds"] = json!([]);
        }
        self.send(message);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(150)).await;
            let _ = this.update(cx, |this, cx| {
                if this.history.fail(Some(&request_id)) { cx.notify(); }
            });
        }).detach();
        cx.notify();
    }

    pub(super) fn on_transcript_part(&mut self, msg: &Value, cx: &mut Context<Self>) {
        if !self.history.loading || msg.get("requestId").and_then(Value::as_str) != self.history.request_id.as_deref() { return; }
        if msg.get("sessionId").and_then(Value::as_str) != self.meta.session_id.as_deref() {
            self.fail_history(cx);
            return;
        }
        match self.history.part(msg) {
            Ok(Some(full)) => self.on_transcript(&full, cx),
            Ok(None) => {}
            Err(()) => self.fail_history(cx),
        }
    }

    pub(super) fn history_before_reply(&mut self, mut events: Vec<Value>, cx: &mut Context<Self>) -> Vec<Value> {
        // Tool results from disk can finish cards already restored by the journal.
        for event in &events {
            if let Some(blocks) = event.pointer("/message/content").and_then(Value::as_array) {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                        self.fill_tool_result(block, cx);
                    }
                }
            }
        }
        let messages: Vec<&str> = self.items.iter().filter_map(|item| match item {
            Item::Assistant { msg_id, .. } => msg_id.as_deref(), _ => None,
        }).collect();
        let tools: Vec<&str> = self.tool_index.keys().map(String::as_str).collect();
        events.truncate(reply_boundary(&events, &messages, &tools));
        events
    }
}

#[cfg(test)]
mod tests {
    use super::{FailureKind, History, failure_kind, reply_boundary, restored_elapsed, session_error};
    use serde_json::json;
    use std::time::Duration;

    #[test]
    fn history_parts_reject_gaps_changed_totals_and_invalid_json() {
        let mut history = History::default();
        assert!(history.part(&json!({"index":1,"total":2,"text":"x"})).is_err());
        assert!(history.part(&json!({"index":0,"total":2,"text":"{"})).unwrap().is_none());
        assert!(history.part(&json!({"index":1,"total":3,"text":"}"})).is_err());
        assert!(History::default().part(&json!({"index":0,"total":1,"text":"not json"})).is_err());
        let full = json!({"requestId":"r", "sessionId":"s", "events":[]});
        assert_eq!(History::default().part(&json!({"index":0,"total":1,"requestId":"r","sessionId":"s","text":full.to_string()})).unwrap(), Some(full));
    }

    #[test]
    fn history_timeout_keeps_newer_retry_and_failed_page_cursor() {
        let mut history = History { loading: true, request_id: Some("retry".into()), cursor: Some(json!({"before":"older"})), ..History::default() };
        assert!(!history.fail(Some("original")));
        assert!(history.loading);
        assert!(history.fail(Some("retry")));
        assert!(history.error);
        assert!(!history.loading);
        assert!(history.request_id.is_none());
        assert_eq!(history.cursor, Some(json!({"before":"older"})));
        assert!(!history.fail(Some("retry")));
    }

    #[test]
    fn failures_choose_recoverable_actions() {
        assert_eq!(failure_kind("missing", Some("CHAT_HISTORY_MISSING")), FailureKind::HistoryMissing);
        assert_eq!(failure_kind("no rollout found for thread id x", None), FailureKind::HistoryMissing);
        assert_eq!(failure_kind("routing", Some("AGENT_ROUTING_REQUIRED")), FailureKind::UpdateHelper);
        assert_eq!(failure_kind("permission-mode workspace is invalid", None), FailureKind::UpdateHelper);
        assert_eq!(failure_kind("invalid mode", Some("INVALID_PERMISSION_MODE")), FailureKind::InvalidMode);
        assert!(session_error("Couldn't open a ChatGPT session", None));
        assert!(!session_error("A tool failed", None));
    }

    #[test]
    fn restore_clock_keeps_elapsed_time_and_handles_clock_skew() {
        assert_eq!(restored_elapsed(Some(10_000), 25_500), Duration::from_millis(15_500));
        assert_eq!(restored_elapsed(Some(30_000), 25_500), Duration::ZERO);
        assert_eq!(restored_elapsed(Some(0), 25_500), Duration::ZERO);
        assert_eq!(restored_elapsed(None, 25_500), Duration::ZERO);
    }

    #[test]
    fn history_keeps_prompt_but_does_not_duplicate_partial_reply() {
        let events = vec![json!({"type":"user"}), json!({"type":"assistant", "message":{"id":"reply"}}), json!({"type":"user"})];
        assert_eq!(reply_boundary(&events, &["reply"], &[]), 1);
        assert_eq!(reply_boundary(&events, &[], &[]), 3);
        let tools = vec![json!({"message":{"content":[{"type":"tool_use", "id":"tool"}]}})];
        assert_eq!(reply_boundary(&tools, &[], &["tool"]), 0);
    }
}
