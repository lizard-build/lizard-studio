//! Recovery stays beside the conversation so a failed helper never hides work.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Value, json};

use super::{MIN_HOST_VERSION, StudioApp};
use crate::chat::{self, ChatSession, FailureKind};
use crate::host::host_installed;
use crate::store::Agent;
use crate::theme::*;
use crate::ui::{lizard, ph};

const HOST_INSTALL: &str = "npx @lizard-build/lizard-studio-host@latest install";
const CLAUDE_INSTALL: &str = "curl -fsSL https://claude.ai/install.sh | bash";
const CODEX_INSTALL: &str = "npm i -g @openai/codex";

#[derive(Default)]
pub(super) struct RecoveryUi {
    pub focused: bool,
    pub replay: HashSet<String>,
    snapshots: HashMap<String, Value>,
    updating: bool,
    update_request: u64,
    update_note: Option<String>,
    update_attempted: bool,
}

impl RecoveryUi {
    pub fn new(window: &Window) -> Self { Self { focused: window.is_window_active(), ..Self::default() } }
}

fn agents_available(claude: Option<bool>, codex: Option<bool>) -> bool {
    claude == Some(true) || codex == Some(true)
}

pub(super) fn open_file_link(path: &str, reveal: bool, cx: &App) {
    let path = std::path::Path::new(path);
    if reveal { cx.reveal_path(path); } else { cx.open_with_system(path); }
}

fn action(id: &'static str, label: impl Into<SharedString>) -> Stateful<Div> {
    div().id(id).min_h(px(32.)).px(px(12.)).py(px(6.)).rounded(px(8.))
        .border_1().border_color(hex(EMERALD)).bg(rgba_hex(EMERALD, 0.5))
        .text_size(px(12.)).line_height(px(16.)).font_weight(FontWeight::SEMIBOLD)
        .cursor_pointer().hover(|s| s.bg(hex(EMERALD))).child(label.into())
}

fn installer(id: &'static str, command: &'static str) -> impl IntoElement {
    div().id(id).flex().items_center().gap(px(10.)).px(px(12.)).py(px(8.)).rounded(px(8.))
        .bg(hex(BG_SECONDARY)).border_1().border_color(hex(BORDER)).cursor_pointer()
        .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(command.into())))
        .child(div().min_w_0().font_family("Lizard Mono").text_size(px(12.)).child(command))
        .child(ph("copy", 13., hex(TEXT_TERTIARY)))
}

impl StudioApp {
    pub(super) fn onboarding_blocked(&self) -> bool {
        !host_installed()
            || (self.host_state.claude_ok == Some(false) && self.host_state.codex_ok == Some(false))
            || self.host_state.version.is_some_and(|v| v < MIN_HOST_VERSION)
    }

    /// Probe the live hosts, since reconnecting a daemon only repeats its cache.
    pub(super) fn start_recovery_poll(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_secs(4)).await;
            if this.update(cx, |this, cx| {
                if this.recovery.updating || this.host_state.restoring { return; }
                if !this.host.is_connected() { this.connect(cx); }
                if !this.host.is_connected() { return; }
                if !agents_available(this.host_state.claude_ok, this.host_state.codex_ok) {
                    this.host.send(json!({ "type": "checkAgent", "agent": "claude" }));
                    this.host.send(json!({ "type": "checkAgent", "agent": "codex" }));
                }
            }).is_err() { break; }
        }).detach();
    }

    pub(super) fn finish_agent_check(&mut self, cx: &mut Context<Self>) {
        if self.host_state.restoring { return; }
        let chat = self.chats[self.active].clone();
        let current = chat.read(cx).meta.agent;
        let available = match (self.host_state.claude_ok, self.host_state.codex_ok) {
            (Some(true), _) => Some(Agent::Claude),
            (_, Some(true)) => Some(Agent::Codex),
            _ => None,
        };
        let missing = match current { Agent::Claude => self.host_state.claude_ok, Agent::Codex => self.host_state.codex_ok } == Some(false);
        // Saved chats and typed drafts keep their agent.
        if let Some(agent) = available.filter(|_| missing) {
            let c = chat.read(cx);
            if c.is_blank() && !c.started && c.failure.is_none() && c.queued.is_empty() && self.composer.read(cx).value().is_empty() {
                chat.update(cx, |c, cx| {
                    c.meta.agent = agent;
                    c.meta.model = None;
                    c.meta.permission_mode = Some(chat::default_mode(agent).into());
                    c.meta.effort = chat::default_effort(agent).map(str::to_string);
                    c.commands.clear();
                    cx.notify();
                });
            }
        }
        self.activated(cx);
    }

    pub(super) fn warm_active_chat(&mut self, cx: &mut Context<Self>) {
        if self.host_state.restoring || self.recovery.updating || self.host_state.version.is_none_or(|v| v < MIN_HOST_VERSION) { return; }
        let chat = self.chats[self.active].clone();
        let c = chat.read(cx);
        let ready = match c.meta.agent { Agent::Claude => self.host_state.claude_ok, Agent::Codex => self.host_state.codex_ok };
        if ready != Some(true) || c.meta.cloud || c.failure.is_some() { return; }
        if c.meta.agent == Agent::Codex {
            self.host.send(json!({ "type": "prewarm", "agent": "codex", "cwd": c.meta.cwd }));
        }
        chat.update(cx, |c, cx| c.warm_up(cx));
    }

    pub(super) fn begin_daemon_restore(&mut self, msg: &Value, cx: &mut Context<Self>) {
        self.host_state.restoring = true;
        self.recovery.replay.clear();
        self.recovery.snapshots.clear();
        for snapshot in msg.get("sessions").and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = snapshot.get("id").and_then(Value::as_str) else { continue };
            // Snapshot runs' chats are never saved, so there is nothing to recover.
            if self.chat_by_id(id, cx).is_none() && id.starts_with("preview-") {
                self.host.send(json!({ "type": "close", "id": id, "agent": snapshot.get("agent") }));
                continue;
            }
            if self.chat_by_id(id, cx).is_none()
                && snapshot.get("submitted").and_then(Value::as_bool) != Some(true)
                && snapshot.get("running").and_then(Value::as_bool) != Some(true)
                && snapshot.get("failed").and_then(Value::as_bool) != Some(true)
            {
                self.host.send(json!({ "type": "close", "id": id, "agent": snapshot.get("agent") }));
                continue;
            }
            // A crash may happen before the new chat's first metadata save.
            let chat = self.chat_by_id(id, cx).unwrap_or_else(|| {
                let agent = if snapshot.get("agent").and_then(Value::as_str) == Some("codex") { Agent::Codex } else { Agent::Claude };
                let cwd = snapshot.pointer("/spec/cwd").and_then(Value::as_str).map(str::to_string);
                let host = self.host.clone();
                let chat = cx.new(|cx| {
                    let mut chat = ChatSession::fresh(agent, cwd, host, cx);
                    chat.meta.id = id.into();
                    chat.meta.model = snapshot.pointer("/spec/model").and_then(Value::as_str).map(str::to_string);
                    chat.meta.effort = snapshot.pointer("/spec/effort").and_then(Value::as_str).map(str::to_string);
                    chat.meta.permission_mode = snapshot.pointer("/spec/permissionMode").and_then(Value::as_str).map(str::to_string);
                    chat
                });
                self.watch_chat(&chat, cx);
                self.chats.push(chat.clone());
                chat
            });
            if chat.update(cx, |c, cx| c.prepare_restore(cx)) { self.recovery.replay.insert(id.into()); }
            self.recovery.snapshots.insert(id.into(), snapshot.clone());
        }
    }

    pub(super) fn finish_daemon_restore(&mut self, cx: &mut Context<Self>) {
        for chat in self.chats.clone() {
            let id = chat.read(cx).id().to_string();
            if let Some(snapshot) = self.recovery.snapshots.remove(&id) {
                chat.update(cx, |c, cx| c.finish_restore(&snapshot, cx));
            } else if chat.read(cx).started || chat.read(cx).running {
                chat.update(cx, |c, cx| c.on_agent_exit(cx));
            }
        }
        self.recovery.replay.clear();
        self.host_state.restoring = false;
        self.finish_agent_check(cx);
        cx.notify();
    }

    pub(super) fn check_helper_version(&mut self, cx: &mut Context<Self>) {
        if self.host_state.version.is_some_and(|v| v >= MIN_HOST_VERSION) {
            if self.recovery.updating {
                for chat in self.chats.clone() {
                    let c = chat.read(cx);
                    if c.failure.as_ref().is_some_and(|f| f.kind == FailureKind::UpdateHelper || f.message.contains("helper stopped")) {
                        chat.update(cx, |c, cx| { c.failure = None; cx.notify(); });
                    }
                }
                self.recovery.updating = false;
                self.recovery.update_request += 1;
                self.recovery.update_note = None;
            }
        } else if !self.recovery.update_attempted { self.update_helper(cx); }
    }

    fn update_timeout(&mut self, seconds: u64, cx: &mut Context<Self>) {
        self.recovery.update_request += 1;
        let request = self.recovery.update_request;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(seconds)).await;
            let _ = this.update(cx, |this, cx| {
                if this.recovery.updating && this.recovery.update_request == request {
                    this.recovery.updating = false;
                    this.recovery.update_note = Some("Couldn't update automatically. Run the installer below, then check again.".into());
                    cx.notify();
                }
            });
        }).detach();
    }

    fn update_helper(&mut self, cx: &mut Context<Self>) {
        if self.recovery.updating { return; }
        self.recovery.updating = true;
        self.recovery.update_attempted = true;
        self.recovery.update_note = Some("Updating the local helper…".into());
        self.host.send(json!({ "type": "selfUpdate" }));
        self.update_timeout(8, cx);
        cx.notify();
    }

    pub(super) fn on_helper_update(&mut self, msg: &Value, cx: &mut Context<Self>) {
        if msg.get("deferred").and_then(Value::as_bool) == Some(true) {
            self.recovery.updating = true;
            self.recovery.update_request += 1;
            self.recovery.update_note = Some("The helper will update when running turns finish.".into());
        } else if msg.get("updated").and_then(Value::as_bool) == Some(true) {
            self.recovery.updating = true;
            let version = msg.get("version").and_then(Value::as_str).unwrap_or("");
            self.recovery.update_note = Some(format!("Helper {version} installed. Waiting for it to restart…"));
            self.update_timeout(15, cx);
        } else {
            self.recovery.updating = false;
            self.recovery.update_request += 1;
            self.recovery.update_note = Some(msg.get("error").and_then(Value::as_str).unwrap_or("Run the installer below to update the helper.").into());
        }
        cx.notify();
    }

    /// A missing transcript opens a fresh session with the same unsent work.
    fn new_chat_from_failure(&mut self, cx: &mut Context<Self>) {
        let old_chat = self.chats[self.active].clone();
        let queued = old_chat.update(cx, |c, _| std::mem::take(&mut c.queued));
        let old = old_chat.read(cx);
        let host = self.host.clone();
        let meta = old.meta.clone();
        let fresh = cx.new(|cx| {
            let mut chat = ChatSession::fresh(meta.agent, meta.cwd, host, cx);
            chat.queued = queued;
            chat.meta.model = meta.model;
            chat.meta.effort = meta.effort;
            chat.meta.permission_mode = meta.permission_mode;
            chat
        });
        self.watch_chat(&fresh, cx);
        self.add_on_top(fresh);
        // The composer and attachments already hold the draft; keep them intact.
        self.activated(cx);
        cx.notify();
    }

    pub(super) fn render_recovery(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let chat = self.chats[self.active].clone();
        let c = chat.read(cx);
        let failure = c.failure.as_ref()?;
        let title = failure.title(c.meta.agent);
        let description = failure.description();
        let label = failure.action();
        let kind = failure.kind;
        let connecting = failure.connecting;
        let details = failure.details;
        let message = failure.message.clone();
        let updating = self.recovery.updating;
        Some(div().mx(px(12.)).my(px(12.)).p(px(16.)).rounded(px(12.)).border_1().border_color(hex(BORDER))
            .bg(hex(BG_SECONDARY)).text_color(hex(TEXT_PRIMARY)).flex_none()
            .child(div().text_size(px(14.)).line_height(px(20.)).font_weight(FontWeight::SEMIBOLD).child(title))
            .child(div().mt(px(6.)).mb(px(14.)).text_size(px(14.)).line_height(px(20.)).text_color(hex(TEXT_SECONDARY)).child(description))
            .child(div().flex().gap(px(8.)).child(action("session-retry", if kind == FailureKind::UpdateHelper && updating { "Updating…" } else { label })
                .when(connecting || (kind == FailureKind::UpdateHelper && updating), |d| d.opacity(0.5))
                .on_click(cx.listener(move |this, _, _, cx| match kind {
                    FailureKind::HistoryMissing => this.new_chat_from_failure(cx),
                    FailureKind::UpdateHelper => this.update_helper(cx),
                    _ => { this.chats[this.active].update(cx, |c, cx| c.reconnect_session(cx)); }
                }))))
            .child(div().id("session-details").mt(px(14.)).text_size(px(12.)).line_height(px(18.)).text_color(hex(TEXT_SECONDARY)).cursor_pointer()
                .child(if details { "▾ Details" } else { "▸ Details" })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.chats[this.active].update(cx, |c, cx| { if let Some(f) = &mut c.failure { f.details = !f.details; } cx.notify(); });
                })))
            .when(details, |d| d.child(div().id("failure-text").max_h(px(140.)).overflow_y_scroll().font_family("Lizard Mono").text_size(px(12.)).line_height(px(18.)).child(message))
                .when(kind == FailureKind::UpdateHelper, |d| d.child(installer("failure-install", HOST_INSTALL))))
            .when(kind == FailureKind::UpdateHelper, |d| d.when_some(self.recovery.update_note.clone(), |d, note| d.child(div().mt(px(8.)).text_size(px(12.)).child(note))))
            .into_any_element())
    }

    pub(super) fn render_history_retry(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let chat = self.chats[self.active].clone();
        if !chat.read(cx).history_error() { return None; }
        Some(div().id("history-retry").my(px(8.)).mx(px(12.)).py(px(6.)).text_center().text_size(px(12.))
            .text_color(hex(TEXT_SECONDARY)).rounded(px(6.)).cursor_pointer().hover(|s| s.bg(white_a(0.05)))
            .child("Couldn't load messages. Retry")
            .on_click(cx.listener(move |_, _, _, cx| chat.update(cx, |c, cx| c.retry_history(cx))))
            .into_any_element())
    }

    pub(super) fn render_onboarding(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let missing = !host_installed();
        let stale = self.host_state.version.is_some_and(|v| v < MIN_HOST_VERSION);
        let title = if missing { "Connect your agent" } else if stale { "Update the helper" } else { "Install an agent" };
        let body = if missing { "Install the local helper to connect Lizard Studio to your agents." }
            else if stale { "This app needs a newer local helper." }
            else { "Install Claude Code or Codex. Either agent is enough to start chatting. Checking automatically every 4 seconds." };
        div().size_full().flex().flex_col().items_center().justify_center().gap(px(14.)).px(px(22.))
            .child(lizard(48., hex(EMERALD)))
            .child(div().text_size(px(18.)).font_weight(FontWeight::SEMIBOLD).child(title))
            .child(div().max_w(px(460.)).text_size(px(13.)).line_height(relative(1.5)).text_color(hex(TEXT_SECONDARY)).text_center().child(body))
            .when(missing || stale, |d| d.child(installer("helper-install", HOST_INSTALL)))
            .when(!stale, |d| d
                .child(div().text_size(px(13.)).child("Claude Code"))
                .child(installer("claude-install", CLAUDE_INSTALL))
                .child(div().text_size(px(13.)).child("Codex"))
                .child(installer("codex-install", CODEX_INSTALL)))
            .when_some(self.recovery.update_note.clone(), |d, note| d.child(div().max_w(px(460.)).text_size(px(12.)).text_color(hex(TEXT_SECONDARY)).child(note)))
            .child(action("check-again", if self.recovery.updating { "Updating…" } else if stale { "Update helper" } else { "Check again" })
                .on_click(cx.listener(move |this, _, _, cx| {
                    if this.recovery.updating { return; }
                    if stale { this.update_helper(cx); }
                    else if !this.host.is_connected() { this.connect(cx); }
                    else {
                        this.host.send(json!({ "type": "checkAgent", "agent": "claude" }));
                        this.host.send(json!({ "type": "checkAgent", "agent": "codex" }));
                    }
                })))
            .when_some(self.host_state.error.clone(), |d, error| d.child(div().text_size(px(12.)).text_color(hex(RED_SOFT)).child(error)))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::agents_available;

    #[test]
    fn either_agent_can_finish_onboarding() {
        assert!(agents_available(Some(true), Some(false)));
        assert!(agents_available(Some(false), Some(true)));
        assert!(agents_available(None, Some(true)));
        assert!(!agents_available(Some(false), Some(false)));
        assert!(!agents_available(None, None));
    }
}
