//! Local credentials live in the CLI. Resume only after its fresh process
//! acknowledges its spawn, keeping a refused prompt's bubble and attachments intact.

use std::time::{Duration, Instant};

use gpui_kit::component::input::InputState;
use gpui_kit::{Context, Entity};
use serde_json::{Value, json};

use super::{APP_CONTEXT, CTX_END, CTX_START, ChatSession, DEFAULT_TITLE, Item, Message, files_note, join_note};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LoginPhase {
    Starting,
    Waiting,
    Submitting,
    Done,
    Failed,
}

impl LoginPhase {
    pub fn active(self) -> bool {
        matches!(self, Self::Starting | Self::Waiting | Self::Submitting)
    }
}

pub struct Login {
    pub phase: LoginPhase,
    pub expired: bool,
    pub status: String,
    pub url: Option<String>,
    pub code: Option<String>,
    pub input: Option<Entity<InputState>>,
}

pub struct RemoteControl {
    pub busy: bool,
    pub enabled: bool,
    pub error: bool,
    pub status: String,
    pub url: Option<String>,
    pub copied: bool,
}

#[derive(Default)]
pub struct LocalSession {
    pub login: Option<Login>,
    pub remote: Option<RemoteControl>,
    pub(super) last_prompt: Option<Message>,
    retry: Option<Message>,
    retry_ready: bool,
    last_event: Option<Instant>,
    waiting_start: bool,
    remote_request: Option<(bool, Option<String>)>,
    login_seq: u64,
    auth_restart: bool,
}

impl LocalSession {
    pub fn has_cards(&self) -> bool {
        self.login.is_some() || self.remote.is_some()
    }

    pub fn blocked(&self) -> bool {
        self.waiting_start || self.retry.is_some() || self.login.as_ref().is_some_and(|l| l.phase.active())
    }

    fn requeue_failed_prompt(&mut self) {
        if self.retry.is_none() {
            self.retry = self.last_prompt.take();
            self.retry_ready = false;
        }
    }

    fn take_retry(&mut self) -> Option<Message> {
        if self.waiting_start || !self.retry_ready {
            return None;
        }
        let retry = self.retry.take();
        self.retry_ready = false;
        retry
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum LocalCommand {
    Login,
    RemoteControl { enabled: bool, name: Option<String> },
}

pub fn local_command(text: &str) -> Option<LocalCommand> {
    let text = text.trim();
    let (command, args) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    match command {
        "/login" => Some(LocalCommand::Login),
        "/remote-control" => {
            let args = args.trim();
            Some(LocalCommand::RemoteControl {
                enabled: !args.eq_ignore_ascii_case("off"),
                name: (!args.is_empty() && !args.eq_ignore_ascii_case("off")).then(|| args.to_string()),
            })
        }
        _ => None,
    }
}

fn auth_revoked(text: &str) -> bool {
    let text = text.to_lowercase();
    // A status code by itself also describes ordinary tool failures.
    let unauthorized = text.split(|c: char| !c.is_alphanumeric() && c != '_').any(|w| w == "401");
    if unauthorized && ["oauth", "authenticat", "revoked", "credentials"].iter().any(|w| text.contains(w)) {
        return true;
    }
    if ["failed to authenticate", "could not be refreshed", "run /login", "type /login"].iter().any(|w| text.contains(w)) {
        return true;
    }
    ["oauth", "session", "token"].iter().any(|word| {
        text.match_indices(word).any(|(at, word)| {
            let rest = &text[at + word.len()..];
            ["expired", "revoked"].iter().any(|end| {
                rest.find(end).is_some_and(|n| {
                    let gap = &rest[..n];
                    gap.chars().count() <= 20 && !gap.contains(['.', '\n'])
                })
            })
        })
    })
}

fn stale(started: bool, idle: Option<Duration>, background: bool) -> bool {
    started && !background && idle.is_some_and(|idle| idle >= Duration::from_secs(2 * 60 * 60))
}

fn dead_reply(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty() && text.chars().count() <= 300 && auth_revoked(text)
}

impl ChatSession {
    pub fn start_login(&mut self, expired: bool, cx: &mut Context<Self>) {
        if self.meta.cloud {
            self.notice(true, "Use the connect card to sign in for a cloud chat.", cx);
            return;
        }
        if self.local.login.as_ref().is_some_and(|l| l.phase.active()) {
            return;
        }
        self.local.login_seq += 1;
        self.local.retry_ready = false;
        self.local.login = Some(Login {
            phase: LoginPhase::Starting,
            expired,
            status: if expired { "Your session expired — signing you back in…" } else { "Starting sign-in…" }.into(),
            url: None,
            code: None,
            input: None,
        });
        if self.host.is_connected() {
            self.send(json!({ "type": "authLogin" }));
        } else if let Some(login) = &mut self.local.login {
            login.phase = LoginPhase::Failed;
            login.status = "Can't reach the host — is the native helper running?".into();
        }
        self.sync_rows(cx);
        self.remeasure_tail();
    }

    pub fn submit_auth_code(&mut self, code: String, cx: &mut Context<Self>) {
        let code = code.trim();
        if code.is_empty() || !self.local.login.as_ref().is_some_and(|l| l.phase == LoginPhase::Waiting) {
            return;
        }
        self.send(json!({ "type": "authCode", "code": code }));
        if let Some(login) = &mut self.local.login {
            login.phase = LoginPhase::Submitting;
            login.status = "Signing in…".into();
        }
        self.remeasure_tail();
        cx.notify();
    }

    pub fn cancel_login(&mut self, cx: &mut Context<Self>) {
        self.send(json!({ "type": "authCancel" }));
        // Claude's authCancel kills the process without an authDone reply.
        self.login_done(false, "Sign-in cancelled.", cx);
    }

    pub fn start_remote_control(&mut self, enabled: bool, name: Option<String>, cx: &mut Context<Self>) {
        if self.meta.cloud {
            self.notice(true, "Remote Control is only available in local Claude Code chats.", cx);
            return;
        }
        if self.meta.agent == crate::store::Agent::Codex {
            self.notice(true, "Remote Control is only available in Claude Code chats.", cx);
            return;
        }
        self.local.remote = Some(RemoteControl {
            busy: true, enabled: false, error: false, url: None, copied: false,
            status: if enabled { "Connecting this session to your Claude account…" } else { "Turning Remote Control off…" }.into(),
        });
        if !self.host.is_connected() || self.meta.cwd.is_none() {
            if let Some(remote) = &mut self.local.remote {
                remote.busy = false;
                remote.error = true;
                remote.status = if self.meta.cwd.is_none() { "Choose a project folder first." } else { "Can't reach the host — is the native helper running?" }.into();
            }
        } else if !self.started || self.local.waiting_start {
            self.local.remote_request = Some((enabled, name));
            self.ensure_started(cx);
            self.local.waiting_start = true;
        } else {
            self.send(json!({ "type": "remoteControl", "enabled": enabled, "name": name }));
        }
        self.sync_rows(cx);
        self.remeasure_tail();
    }

    pub(super) fn deliver_local(&mut self, message: Message, silent: bool, cx: &mut Context<Self>) {
        let idle = self.local.last_event.map(|at| at.elapsed());
        if stale(self.started, idle, self.tasks.iter().any(|t| t.running)) {
            self.queued.push_front(message);
            self.local.waiting_start = true;
            self.restart(cx);
            cx.notify();
            return;
        }
        if !silent && self.local.login.as_ref().is_some_and(|l| !l.phase.active()) {
            self.local.login = None;
        }
        self.local.last_prompt = Some(message.clone());
        self.close_async_questions("No longer needed", cx);
        let Message { text, images, files } = message;
        // The agent reads attached files itself, by path.
        let paths: Vec<String> = files.iter().map(|p| p.to_string_lossy().to_string()).collect();
        let text = join_note(&text, &files_note(&paths));
        self.ensure_started(cx);
        if self.meta.title == DEFAULT_TITLE && !self.meta.title_edited {
            let title: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if !title.is_empty() {
                self.meta.title = title.chars().take(40).collect();
            }
        }
        if !silent {
            self.user_item(&text, super::images::sent_images(&images), cx);
        }
        let bash_context = if text.starts_with('/') { String::new() } else { self.take_bash_context() };
        let wire = if (self.context_sent && bash_context.is_empty()) || text.starts_with('/') {
            text
        } else {
            let app_context = if self.context_sent { "" } else { APP_CONTEXT };
            self.context_sent = true;
            format!("{CTX_START}{app_context}\n\n{bash_context}{CTX_END}\n\n{text}")
        };
        self.send(json!({ "type": "prompt", "text": wire, "images": images }));
        self.begin_turn();
        self.touch(cx);
        self.sync_rows(cx);
    }

    fn recover_auth(&mut self, cx: &mut Context<Self>) {
        if self.local.login.as_ref().is_some_and(|l| l.phase == LoginPhase::Failed)
            && (self.local.retry.is_some() || self.local.auth_restart) {
            return;
        }
        self.local.auth_restart = true;
        self.local.waiting_start = false;
        self.local.requeue_failed_prompt();
        // Remove only the dead turn's short complaint; tool output and real
        // prose remain. Removing from the end leaves tool indices intact.
        if !self.items[self.turn_first_item..].iter().any(|i| matches!(i, Item::Tools(_))) {
            while matches!(self.items.last(), Some(Item::Assistant { text, .. }) if dead_reply(text)) && self.items.len() > self.turn_first_item {
                let ix = self.items.len() - 1;
                self.items.pop();
                self.list.splice(ix..ix + 1, 0);
            }
        }
        if let Some(login) = &mut self.local.login {
            if login.phase.active() {
                login.expired = true;
            }
        }
        self.start_login(true, cx);
        if self.running {
            self.end_turn(cx);
        }
    }

    fn login_done(&mut self, ok: bool, message: &str, cx: &mut Context<Self>) {
        let Some(login) = &mut self.local.login else { return };
        login.phase = if ok { LoginPhase::Done } else { LoginPhase::Failed };
        login.url = None;
        login.code = None;
        login.input = None;
        login.status = if ok {
            if login.expired { "Signed back in — picking up where you left off." } else { "Signed in. You're all set." }.into()
        } else {
            format!("Sign-in failed: {} Type /login to try again.", if message.is_empty() { "Unknown error." } else { message })
        };
        let auto = login.expired;
        self.local.retry_ready = ok;
        if ok && (self.started || self.local.auth_restart || self.local.retry.is_some()) {
            self.local.auth_restart = false;
            self.local.waiting_start = true;
            if self.running {
                self.end_turn(cx);
            }
            // `start` can also resume a session whose failed process exited.
            self.started = false;
            self.restart_pending = false;
            self.ensure_started(cx);
        } else if ok {
            self.local_started(cx);
        }
        if ok && auto {
            let seq = self.local.login_seq;
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(2200)).await;
                let _ = this.update(cx, |chat, cx| {
                    if chat.local.login_seq == seq && chat.local.login.as_ref().is_some_and(|l| l.phase == LoginPhase::Done) {
                        chat.local.login = None;
                        chat.sync_rows(cx);
                        chat.remeasure_tail();
                    }
                });
            }).detach();
        }
        self.sync_rows(cx);
        self.remeasure_tail();
    }

    pub(super) fn local_started(&mut self, cx: &mut Context<Self>) {
        if self.meta.cloud { return; }
        self.local.last_event = Some(Instant::now());
        self.local.waiting_start = false;
        if let Some((enabled, name)) = self.local.remote_request.take() {
            self.send(json!({ "type": "remoteControl", "enabled": enabled, "name": name }));
        }
        if self.running || self.local.login.as_ref().is_some_and(|l| l.phase.active()) {
            return;
        }
        if let Some(message) = self.local.take_retry() {
            self.deliver_local(message, true, cx);
        } else if !self.local.blocked() {
            if let Some(message) = self.queued.pop_front() {
                self.deliver(message, cx);
            }
        }
    }

    pub(super) fn on_local_event(&mut self, data: &Value, cx: &mut Context<Self>) -> bool {
        if self.meta.cloud { return false; }
        self.local.last_event = Some(Instant::now());
        if self.local.waiting_start {
            return true;
        }
        if data.get("type").and_then(Value::as_str) == Some("result")
            && data.get("is_error").and_then(Value::as_bool) == Some(true)
            && auth_revoked(data.get("result").and_then(Value::as_str).unwrap_or("")) {
            self.recover_auth(cx);
            return true;
        }
        // The dead process may finish streaming after its stderr auth error.
        self.local.login.as_ref().is_some_and(|l| l.expired && l.phase != LoginPhase::Done)
    }

    pub(super) fn on_local_message(&mut self, msg: &Value, cx: &mut Context<Self>) -> bool {
        if self.meta.cloud { return false; }
        match msg.get("type").and_then(Value::as_str).unwrap_or("") {
            "authUrl" => {
                if let Some(login) = &mut self.local.login {
                    if !login.phase.active() { return true; }
                    login.phase = LoginPhase::Waiting;
                    login.url = msg.get("url").and_then(Value::as_str).map(str::to_string);
                    login.code = msg.get("code").and_then(Value::as_str).map(str::to_string);
                    login.status = match self.meta.agent {
                        crate::store::Agent::Codex if login.code.is_some() => "Open the sign-in page and enter this code:",
                        crate::store::Agent::Codex => "Open the sign-in page to continue.",
                        _ if login.expired => "Your session expired — click Authorize in the tab that just opened and you're back in.",
                        _ => "Click Authorize in the tab that just opened — you'll be signed in automatically.",
                    }.into();
                }
            }
            "authDone" => {
                if self.local.login.as_ref().is_some_and(|l| l.phase.active()) {
                    self.login_done(msg.get("ok").and_then(Value::as_bool) == Some(true), msg.get("message").and_then(Value::as_str).unwrap_or(""), cx);
                }
            }
            "remoteControl" => {
                let ok = msg.get("ok").and_then(Value::as_bool) == Some(true);
                if let Some(remote) = &mut self.local.remote {
                    remote.busy = false;
                    remote.error = !ok;
                    remote.enabled = ok && msg.get("enabled").and_then(Value::as_bool) == Some(true);
                    remote.url = msg.get("connectUrl").and_then(Value::as_str).filter(|s| !s.is_empty())
                        .or_else(|| msg.get("sessionUrl").and_then(Value::as_str)).map(str::to_string);
                    remote.status = if !ok {
                        format!("Remote Control failed: {}", msg.get("error").and_then(Value::as_str).unwrap_or("Unknown error"))
                    } else if !remote.enabled {
                        "Remote Control is off. This session is local again.".into()
                    } else if remote.url.is_some() {
                        "This session is live in the Claude app. Open the link on your phone to carry on there.".into()
                    } else { "This session is live in the Claude app.".into() };
                } else if !ok {
                    self.notice(true, format!("Remote Control stopped: {}", msg.get("error").and_then(Value::as_str).unwrap_or("Unknown error")), cx);
                }
            }
            "error" if auth_revoked(msg.get("message").and_then(Value::as_str).unwrap_or("")) => self.recover_auth(cx),
            _ => return false,
        }
        self.sync_rows(cx);
        self.remeasure_tail();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{LocalCommand, LocalSession, Login, LoginPhase, auth_revoked, dead_reply, local_command, stale};
    use crate::chat::Message;
    use serde_json::json;
    use std::path::PathBuf;
    use std::time::Duration;

    #[test]
    fn local_commands_do_not_capture_other_prompts() {
        assert_eq!(local_command("  /login \n"), Some(LocalCommand::Login));
        assert_eq!(local_command("/remote-control off"), Some(LocalCommand::RemoteControl { enabled: false, name: None }));
        assert_eq!(local_command("/remote-control My session"), Some(LocalCommand::RemoteControl { enabled: true, name: Some("My session".into()) }));
        assert_eq!(local_command("/remote-control"), Some(LocalCommand::RemoteControl { enabled: true, name: None }));
        assert_eq!(local_command("/login-help"), None);
        assert_eq!(local_command("explain /login"), None);
    }

    #[test]
    fn recognizes_both_auth_failure_shapes() {
        for text in ["HTTP 401: OAuth token revoked", "Failed to authenticate: OAuth session expired and could not be refreshed", "Token has expired", "Please run /login", "ChatGPT sign-in expired. Type /login to sign in again.", "OAuth token revoked"] {
            assert!(auth_revoked(text), "{text}");
        }
        for text in ["HTTP 401", "File has expired", "1401 authentication", "session. expired later", "Token is valid"] {
            assert!(!auth_revoked(text), "{text}");
        }
        assert!(dead_reply("  Failed to authenticate  "));
        assert!(!dead_reply(&format!("{} Token expired", "A useful answer. ".repeat(30))));
    }

    #[test]
    fn idle_restart_preserves_background_work() {
        let threshold = Duration::from_secs(7200);
        assert!(stale(true, Some(threshold), false));
        assert!(!stale(true, Some(threshold - Duration::from_secs(1)), false));
        assert!(!stale(true, Some(threshold), true));
        assert!(!stale(false, Some(threshold), false));
        assert!(!stale(true, None, false));
    }

    #[test]
    fn retry_keeps_attachments_and_waits_for_sign_in_and_spawn() {
        let mut state = LocalSession::default();
        state.last_prompt = Some(Message {
            text: "Describe these".into(), images: vec![json!({ "data": "image bytes" })], files: vec![PathBuf::from("/tmp/notes.md")],
        });
        state.requeue_failed_prompt();
        state.requeue_failed_prompt();
        assert!(state.last_prompt.is_none());
        assert!(state.blocked());
        assert!(state.take_retry().is_none());
        state.login = Some(Login { phase: LoginPhase::Failed, expired: true, status: String::new(), url: None, code: None, input: None });
        assert!(state.take_retry().is_none());
        state.login.as_mut().unwrap().phase = LoginPhase::Done;
        state.retry_ready = true;
        state.waiting_start = true;
        assert!(state.take_retry().is_none());
        // The transient success card can disappear before a slow spawn.
        state.login = None;
        state.waiting_start = false;
        let retry = state.take_retry().unwrap();
        assert_eq!(retry.text, "Describe these");
        assert_eq!(retry.images, vec![json!({ "data": "image bytes" })]);
        assert_eq!(retry.files, vec![PathBuf::from("/tmp/notes.md")]);
        assert!(!state.blocked());
        assert!(state.take_retry().is_none());
    }
}
