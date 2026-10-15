//! The window, laid out like the Chrome panel in window mode: chats on the
//! left (`.chat-menu`), the open chat on the right.

use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use futures::StreamExt as _;
use futures::channel::mpsc::{UnboundedSender, unbounded};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::text::TextView;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Value, json};

use crate::chat::{
    self, ChatEvent, ChatSession, Detail, Item, Permission, PermissionChoice, Tail, ToolStatus, group_sentence,
    permission_detail, permission_options, permission_subtitle, permission_title, tool_detail, tool_label,
};
use crate::host::{HostConnection, HostEvent, HostLink, home_dir, host_dir, host_installed};
use crate::store::{Agent, Store, now_ms};
use crate::theme::*;
use crate::ui::{self, MenuEntry, caret, lizard, ph, pulse};
use crate::{NewChat, StopTurn};

const MIN_HOST_VERSION: u64 = 40;
const TITLEBAR_H: f32 = 28.;
const BOOKMARKS: &[(&str, u32)] = &[("Violet", 0xb69aff), ("Pink", 0xf18ac5), ("Coral", 0xff927c), ("White", 0xe9edf4)];

#[derive(Clone)]
struct ModelRow {
    id: String,
    label: String,
    context_limit: Option<u64>,
    efforts: Vec<String>,
    default_effort: Option<String>,
}

#[derive(Default, Clone)]
struct Catalog {
    models: Vec<ModelRow>,
    default_model: Option<String>,
    default_effort: Option<String>,
}

#[derive(Default)]
struct HostState {
    connected: bool,
    claude_ok: Option<bool>,
    version: Option<u64>,
    error: Option<String>,
    restoring: bool,
}

#[derive(Clone, Default)]
struct GitInfo {
    is_repo: bool,
    branch: Option<String>,
    files: u64,
    added: u64,
    removed: u64,
}

#[derive(Clone, PartialEq)]
enum Menu {
    Mode,
    Model,
    Effort,
    Agent,
    Settings,
    Bookmark(String),
}

struct Attachment {
    name: String,
    media_type: String,
    data: String,
}

pub struct StudioApp {
    host: Rc<HostLink>,
    events: UnboundedSender<HostEvent>,
    store: Store,
    chats: Vec<Entity<ChatSession>>,
    active: usize,
    composer: Entity<TextareaState>,
    search: Entity<InputState>,
    other_answer: Entity<InputState>,
    rename: Option<(String, Entity<InputState>)>,
    host_state: HostState,
    catalogs: HashMap<Agent, Catalog>,
    git: HashMap<String, GitInfo>,
    attachments: Vec<Attachment>,
    menu: Option<Menu>,
    sidebar_open: bool,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl StudioApp {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let host = Rc::new(HostLink::default());
        let (events, mut rx) = unbounded::<HostEvent>();
        cx.spawn(async move |this, cx| {
            while let Some(event) = rx.next().await {
                if this.update(cx, |this, cx| this.on_host_event(event, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();

        // The running indicator's clock (chat.js refreshes it every 250ms).
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(500)).await;
            let alive = this.update(cx, |this, cx| {
                if this.chats.iter().any(|c| c.read(cx).running) {
                    cx.notify();
                }
            });
            if alive.is_err() {
                break;
            }
        })
        .detach();

        let composer = cx.new(|cx| {
            TextareaState::new(window, cx).auto_grow(1, 9).submit_on_enter(true).placeholder("Type / for commands")
        });
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search chats"));
        let other_answer = cx.new(|cx| InputState::new(window, cx).placeholder("Type your answer…"));

        let mut subscriptions = Vec::new();
        subscriptions.push(cx.subscribe_in(&composer, window, |this, _, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { shift: false, .. } => this.submit(window, cx),
            InputEvent::Change => cx.notify(),
            _ => {}
        }));
        subscriptions.push(cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
            if let InputEvent::Change = event {
                cx.notify();
            }
        }));
        subscriptions.push(cx.subscribe_in(&other_answer, window, |this, input, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                let text = input.read(cx).value().to_string();
                if let Some((chat, request_id)) = this.open_question(cx) {
                    chat.update(cx, |chat, cx| chat.confirm_question(&request_id, Some(text), cx));
                    input.update(cx, |input, cx| input.set_value("", window, cx));
                }
            }
        }));

        let store = Store::load();
        let mut this = Self {
            host,
            events,
            store,
            chats: Vec::new(),
            active: 0,
            composer,
            search,
            other_answer,
            rename: None,
            host_state: HostState::default(),
            catalogs: HashMap::new(),
            git: HashMap::new(),
            attachments: Vec::new(),
            menu: None,
            sidebar_open: true,
            focus: cx.focus_handle(),
            _subscriptions: subscriptions,
        };

        for meta in this.store.chats().to_vec() {
            let host = this.host.clone();
            let chat = cx.new(|cx| ChatSession::new(meta, host, cx));
            this.watch_chat(&chat, cx);
            this.chats.push(chat);
        }
        let last_open = this
            .chats
            .iter()
            .enumerate()
            .filter(|(_, c)| c.read(cx).meta.open)
            .max_by_key(|(_, c)| c.read(cx).meta.updated_at)
            .map(|(i, _)| i);
        match last_open {
            Some(ix) => this.active = ix,
            None => this.new_chat_entity(cx),
        }
        #[cfg(feature = "snapshot")]
        this.open_preview(cx);
        #[cfg(feature = "snapshot")]
        this.send_test_prompt(cx);
        // LIZARD_STUDIO_RUNNING=<id,id> shows those chats as running.
        #[cfg(feature = "snapshot")]
        if let Ok(ids) = std::env::var("LIZARD_STUDIO_RUNNING") {
            for id in ids.split(',') {
                if let Some(chat) = this.chat_by_id(id, cx) {
                    chat.update(cx, |c, cx| c.restore_from_daemon(true, true, cx));
                }
            }
        }
        this.connect(cx);
        this.activated(cx);
        if std::env::var_os("LIZARD_STUDIO_SNAPSHOT").is_none() {
            this.composer.update(cx, |state, cx| state.focus(window, cx));
        }
        this
    }

    // ---- host ----------------------------------------------------------------

    fn connect(&mut self, cx: &mut Context<Self>) {
        if self.host.is_connected() || !host_installed() {
            cx.notify();
            return;
        }
        match HostConnection::spawn(self.events.clone()) {
            Ok(connection) => {
                self.host.attach(connection);
                self.host_state.connected = true;
                self.host_state.error = None;
            }
            Err(err) => self.host_state.error = Some(err.to_string()),
        }
        cx.notify();
    }

    fn on_host_event(&mut self, event: HostEvent, cx: &mut Context<Self>) {
        match event {
            HostEvent::Message(msg) => self.on_host_message(msg, cx),
            HostEvent::Disconnected(reason) => {
                self.host.detach();
                self.host_state.connected = false;
                eprintln!("host disconnected: {reason}");
                cx.notify();
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(800)).await;
                    let _ = this.update(cx, |this, cx| this.connect(cx));
                })
                .detach();
            }
        }
    }

    fn on_host_message(&mut self, msg: Value, cx: &mut Context<Self>) {
        let kind = msg.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        if std::env::var_os("LIZARD_STUDIO_DEBUG").is_some() {
            let id = msg.get("id").and_then(Value::as_str).unwrap_or("-");
            let rid = msg.get("requestId").and_then(Value::as_str).unwrap_or("-");
            eprintln!("host -> {kind} id={id} req={rid} len={}", msg.to_string().len());
        }
        match kind.as_str() {
            "ready" => {
                self.host_state.claude_ok = msg.get("ok").and_then(Value::as_bool);
                self.host_state.version = msg.get("version").and_then(Value::as_u64);
                let cwd = self.chats[self.active].read(cx).meta.cwd.clone();
                self.host.send(json!({ "type": "refreshModels", "agent": "claude", "cwd": cwd }));
                self.chats[self.active].read(cx).request_commands();
                cx.notify();
            }
            "agentReady" => {
                if msg.get("agent").and_then(Value::as_str) == Some("codex") {
                    self.host.send(json!({ "type": "refreshModels", "agent": "codex" }));
                }
            }
            "models" => {
                let agent = match msg.get("agent").and_then(Value::as_str) {
                    Some("codex") => Agent::Codex,
                    _ => Agent::Claude,
                };
                self.catalogs.insert(agent, catalog_from(&msg));
                cx.notify();
            }
            "daemonSnapshot" => {
                self.host_state.restoring = true;
                for session in msg.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default() {
                    let id = session.get("id").and_then(Value::as_str).unwrap_or("");
                    if let Some(chat) = self.chat_by_id(id, cx) {
                        let started = session.get("started").and_then(Value::as_bool).unwrap_or(false);
                        let running = session.get("running").and_then(Value::as_bool).unwrap_or(false);
                        chat.update(cx, |chat, cx| chat.restore_from_daemon(started, running, cx));
                    }
                }
            }
            "daemonRestoreDone" => {
                self.host_state.restoring = false;
                cx.notify();
            }
            "agentExit" => {
                let agent = match msg.get("agent").and_then(Value::as_str) {
                    Some("codex") => Agent::Codex,
                    _ => Agent::Claude,
                };
                for chat in self.chats.clone() {
                    if chat.read(cx).meta.agent == agent {
                        chat.update(cx, |chat, cx| chat.on_agent_exit(cx));
                    }
                }
            }
            "browser" => {
                // No browser is attached to this window. Answer at once so the
                // agent never waits out the tool's timeout.
                if let Some(bid) = msg.get("bid").cloned() {
                    self.host.send(json!({
                        "type": "browserResult", "bid": bid, "ok": false, "data": null,
                        "error": "No browser is attached: this chat runs in the Lizard Studio app for macOS. Use the Lizard Studio extension in Chrome for browser tools.",
                    }));
                }
            }
            _ => {
                let Some(id) = msg.get("id").and_then(Value::as_str) else {
                    if kind == "error" {
                        self.host_state.error = msg.get("message").and_then(Value::as_str).map(str::to_string);
                        cx.notify();
                    }
                    return;
                };
                // A replayed journal repeats output this window already drew.
                if self.host_state.restoring && kind == "event" {
                    return;
                }
                if let Some(chat) = self.chat_by_id(id, cx) {
                    chat.update(cx, |chat, cx| chat.on_host_message(&msg, cx));
                }
            }
        }
    }

    // ---- chats ---------------------------------------------------------------

    fn chat_by_id(&self, id: &str, cx: &App) -> Option<Entity<ChatSession>> {
        self.chats.iter().find(|c| c.read(cx).id() == id).cloned()
    }

    fn index_of(&self, id: &str, cx: &App) -> Option<usize> {
        self.chats.iter().position(|c| c.read(cx).id() == id)
    }

    fn watch_chat(&mut self, chat: &Entity<ChatSession>, cx: &mut Context<Self>) {
        let sub = cx.subscribe(chat, |this, chat, event: &ChatEvent, cx| {
            match event {
                ChatEvent::Changed => this.persist(&chat, cx),
                ChatEvent::TurnEnded => {
                    let active = this.chats.get(this.active) == Some(&chat);
                    if !active {
                        chat.update(cx, |c, _| c.unseen = true);
                    }
                    if let Some(cwd) = chat.read(cx).work_cwd() {
                        this.refresh_git(cwd, cx);
                    }
                }
                ChatEvent::CwdChanged => {
                    if let Some(cwd) = chat.read(cx).work_cwd() {
                        this.refresh_git(cwd, cx);
                    }
                }
            }
            cx.notify();
        });
        self._subscriptions.push(sub);
    }

    fn persist(&mut self, chat: &Entity<ChatSession>, cx: &mut Context<Self>) {
        let chat = chat.read(cx);
        if chat.id().starts_with("preview-") || chat.is_blank() {
            return;
        }
        self.store.upsert(chat.meta.clone());
    }

    /// Add a blank chat at the end of the open ones and show it.
    fn new_chat_entity(&mut self, cx: &mut Context<Self>) {
        let agent = self.store.last_agent();
        let cwd = self.store.last_cwd();
        let host = self.host.clone();
        let chat = cx.new(|cx| ChatSession::fresh(agent, cwd, host, cx));
        self.watch_chat(&chat, cx);
        self.chats.push(chat);
        self.active = self.chats.len() - 1;
    }

    fn new_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ix) = self.chats.iter().position(|c| {
            let c = c.read(cx);
            c.meta.open && c.is_blank()
        }) {
            self.active = ix;
        } else {
            self.new_chat_entity(cx);
        }
        self.after_switch(window, cx);
    }

    fn select_chat(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if ix >= self.chats.len() {
            return;
        }
        let chat = self.chats[ix].clone();
        if !chat.read(cx).meta.open {
            // Reopening a closed chat brings it back to the open list's end.
            self.chats.remove(ix);
            self.chats.push(chat.clone());
            chat.update(cx, |c, cx| {
                c.meta.open = true;
                c.meta.updated_at = now_ms();
                cx.emit(ChatEvent::Changed);
            });
        }
        self.active = self.chats.iter().position(|c| c == &chat).unwrap_or(0);
        self.after_switch(window, cx);
    }

    fn after_switch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        self.attachments.clear();
        self.prune_blank(cx);
        self.activated(cx);
        self.composer.update(cx, |state, cx| {
            state.set_value("", window, cx);
            state.focus(window, cx);
        });
        cx.notify();
    }

    /// A blank chat that is not on screen leaves no trace.
    fn prune_blank(&mut self, cx: &mut Context<Self>) {
        let active = self.chats[self.active].clone();
        self.chats.retain(|c| c == &active || !c.read(cx).is_blank());
        self.active = self.chats.iter().position(|c| c == &active).unwrap_or(0);
    }

    fn activated(&mut self, cx: &mut Context<Self>) {
        let chat = self.chats[self.active].clone();
        chat.update(cx, |c, cx| {
            c.unseen = false;
            c.load_history(cx);
        });
        let (cwd, agent) = {
            let c = chat.read(cx);
            (c.meta.cwd.clone(), c.meta.agent)
        };
        if let Some(work) = chat.read(cx).work_cwd() {
            self.refresh_git(work, cx);
        }
        if chat.read(cx).commands.is_empty() {
            chat.read(cx).request_commands();
        }
        if agent == Agent::Claude {
            self.host.send(json!({ "type": "refreshModels", "agent": "claude", "cwd": cwd }));
        }
    }

    /// Close an open chat into History (a blank one simply goes away).
    fn close_chat(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(chat) = self.chats.get(ix).cloned() else { return };
        let active = self.chats[self.active].clone();
        chat.update(cx, |c, cx| {
            c.close();
            c.meta.open = false;
            cx.emit(ChatEvent::Changed);
        });
        if chat.read(cx).is_blank() {
            self.chats.remove(ix);
        }
        if chat == active {
            match self.chats.iter().rposition(|c| c.read(cx).meta.open) {
                Some(next) => self.active = next,
                None => self.new_chat_entity(cx),
            }
            self.after_switch(window, cx);
        } else {
            self.active = self.chats.iter().position(|c| c == &active).unwrap_or(0);
        }
        cx.notify();
    }

    fn delete_chat(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(chat) = self.chats.get(ix).cloned() else { return };
        let id = chat.read(cx).id().to_string();
        chat.update(cx, |c, _| c.close());
        self.store.remove(&id);
        let active = self.chats[self.active].clone();
        self.chats.remove(ix);
        if chat == active {
            match self.chats.iter().rposition(|c| c.read(cx).meta.open) {
                Some(next) => self.active = next,
                None => self.new_chat_entity(cx),
            }
            self.activated(cx);
        } else {
            self.active = self.chats.iter().position(|c| c == &active).unwrap_or(0);
        }
        cx.notify();
    }

    fn start_rename(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(chat) = self.chat_by_id(&id, cx) else { return };
        let title = chat.read(cx).meta.title.clone();
        let input = cx.new(|cx| InputState::new(window, cx).default_value(title));
        let sub = cx.subscribe_in(&input, window, |this, input, event: &InputEvent, _, cx| match event {
            InputEvent::PressEnter { .. } | InputEvent::Blur => {
                let value = input.read(cx).value().to_string();
                if let Some((id, _)) = this.rename.take() {
                    if let Some(chat) = this.chat_by_id(&id, cx) {
                        chat.update(cx, |c, cx| c.set_title(value, cx));
                    }
                }
                cx.notify();
            }
            _ => {}
        });
        self._subscriptions.push(sub);
        input.update(cx, |state, cx| state.focus(window, cx));
        self.rename = Some((id, input));
        cx.notify();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().to_string();
        if text.trim().is_empty() && self.attachments.is_empty() {
            return;
        }
        let chat = self.chats[self.active].clone();
        if chat.read(cx).meta.cwd.is_none() {
            self.pick_folder(window, cx);
            return;
        }
        let (cwd, agent) = {
            let c = chat.read(cx);
            (c.meta.cwd.clone().unwrap_or_default(), c.meta.agent)
        };
        self.store.remember_start(&cwd, agent);
        let images: Vec<Value> = self
            .attachments
            .drain(..)
            .map(|a| json!({ "mediaType": a.media_type, "data": a.data }))
            .collect();
        chat.update(cx, |chat, cx| chat.submit(text, images, cx));
        self.composer.update(cx, |state, cx| state.set_value("", window, cx));
        self.menu = None;
        cx.notify();
    }

    fn stop(&mut self, _: &StopTurn, _window: &mut Window, cx: &mut Context<Self>) {
        let chat = self.chats[self.active].clone();
        chat.update(cx, |chat, cx| chat.interrupt(cx));
    }

    fn on_new_chat(&mut self, _: &NewChat, window: &mut Window, cx: &mut Context<Self>) {
        self.new_chat(window, cx);
    }

    fn pick_folder(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                if let Some(path) = paths.into_iter().next() {
                    let _ = this.update(cx, |this, cx| this.set_folder(path, cx));
                }
            }
        })
        .detach();
    }

    /// A chat keeps the folder it started in; a new folder means a new chat.
    fn set_folder(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let cwd = path.to_string_lossy().trim_end_matches('/').to_string();
        let chat = self.chats[self.active].clone();
        let blank = chat.read(cx).is_blank() && !chat.read(cx).started;
        if blank {
            chat.update(cx, |chat, cx| {
                chat.meta.cwd = Some(cwd.clone());
                chat.commands.clear();
                cx.notify();
            });
        } else {
            let agent = chat.read(cx).meta.agent;
            let host = self.host.clone();
            let chat = cx.new(|cx| ChatSession::fresh(agent, Some(cwd.clone()), host, cx));
            self.watch_chat(&chat, cx);
            self.chats.push(chat);
            self.active = self.chats.len() - 1;
        }
        self.store.remember_start(&cwd, self.chats[self.active].read(cx).meta.agent);
        self.activated(cx);
        cx.notify();
    }

    fn pick_files(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = paths.await {
                let _ = this.update(cx, |this, cx| this.attach_files(paths, cx));
            }
        })
        .detach();
    }

    /// Images ride along with the prompt; any other file is named by path.
    fn attach_files(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        let mut mentions = Vec::new();
        for path in paths {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let media_type = match ext.as_str() {
                "png" => Some("image/png"),
                "jpg" | "jpeg" => Some("image/jpeg"),
                "gif" => Some("image/gif"),
                "webp" => Some("image/webp"),
                _ => None,
            };
            match (media_type, std::fs::read(&path)) {
                (Some(media_type), Ok(bytes)) if bytes.len() < 5 * 1024 * 1024 => {
                    self.attachments.push(Attachment {
                        name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                        media_type: media_type.into(),
                        data: base64_encode(&bytes),
                    });
                }
                _ => mentions.push(path.to_string_lossy().to_string()),
            }
        }
        if !mentions.is_empty() {
            let addition = mentions.join(" ");
            let composer = self.composer.clone();
            let current = composer.read(cx).value().to_string();
            let next = if current.trim().is_empty() { addition } else { format!("{current} {addition}") };
            if let Some(window) = cx.active_window() {
                let _ = window.update(cx, |_, window, cx| composer.update(cx, |s, cx| s.set_value(next, window, cx)));
            }
        }
        cx.notify();
    }

    fn set_agent(&mut self, agent: Agent, window: &mut Window, cx: &mut Context<Self>) {
        let chat = self.chats[self.active].clone();
        if !chat.read(cx).is_blank() || chat.read(cx).started {
            let cwd = chat.read(cx).meta.cwd.clone();
            let host = self.host.clone();
            let fresh = cx.new(|cx| ChatSession::fresh(agent, cwd, host, cx));
            self.watch_chat(&fresh, cx);
            self.chats.push(fresh);
            self.active = self.chats.len() - 1;
        } else {
            chat.update(cx, |chat, cx| {
                chat.meta.agent = agent;
                chat.meta.model = None;
                chat.meta.effort = chat::default_effort(agent).map(str::to_string);
                chat.meta.permission_mode = Some(chat::default_mode(agent).into());
                chat.commands.clear();
                cx.notify();
            });
        }
        if let Some(cwd) = self.chats[self.active].read(cx).meta.cwd.clone() {
            self.store.remember_start(&cwd, agent);
        }
        self.after_switch(window, cx);
    }

    fn cycle_mode(&mut self, cx: &mut Context<Self>) {
        let chat = self.chats[self.active].clone();
        let (agent, mode) = {
            let c = chat.read(cx);
            (c.meta.agent, c.meta.permission_mode.clone().unwrap_or_else(|| chat::default_mode(c.meta.agent).into()))
        };
        let modes = modes_for(agent);
        let next = modes.iter().position(|m| m.0 == mode).map(|i| (i + 1) % modes.len()).unwrap_or(0);
        chat.update(cx, |c, cx| c.set_settings(None, None, Some(modes[next].0.to_string()), cx));
    }

    fn open_question(&self, cx: &App) -> Option<(Entity<ChatSession>, String)> {
        let chat = self.chats[self.active].clone();
        let request_id = chat
            .read(cx)
            .permissions
            .first()
            .filter(|p| !p.questions.is_empty())
            .map(|p| p.request_id.clone())?;
        Some((chat, request_id))
    }

    fn refresh_git(&mut self, cwd: String, cx: &mut Context<Self>) {
        let task = cx.background_executor().spawn({
            let cwd = cwd.clone();
            async move { git_info(&cwd) }
        });
        cx.spawn(async move |this, cx| {
            let info = task.await;
            let _ = this.update(cx, |this, cx| {
                this.git.insert(cwd, info);
                cx.notify();
            });
        })
        .detach();
    }

    /// Keys the panel handles on its own: 1-9 / ↑↓ / enter / esc on a
    /// permission card, esc to interrupt, shift+tab to cycle the mode.
    fn on_key(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let mods = &event.keystroke.modifiers;
        if key == "tab" && mods.shift {
            self.cycle_mode(cx);
            cx.stop_propagation();
            return;
        }
        if key == "escape" && self.menu.is_some() {
            self.menu = None;
            cx.notify();
            cx.stop_propagation();
            return;
        }
        let chat = self.chats[self.active].clone();
        let composer_empty = self.composer.read(cx).value().trim().is_empty();
        let perm = chat.read(cx).permissions.first().map(|p| {
            let count = if p.questions.is_empty() {
                3
            } else {
                p.questions.get(p.question_ix).map(|q| q.options.len() + 1).unwrap_or(1)
            };
            (p.request_id.clone(), p.questions.is_empty(), p.hovered, count, p.other_open)
        });
        if let Some((rid, plain, hovered, count, other_open)) = perm {
            if key == "escape" {
                chat.update(cx, |c, cx| c.answer_permission(&rid, PermissionChoice::Deny, cx));
                cx.stop_propagation();
                return;
            }
            if other_open || !composer_empty || mods.modified() {
                return;
            }
            let choose = |i: usize, cx: &mut Context<Self>| {
                chat.update(cx, |c, cx| {
                    if plain {
                        let choice = match i {
                            0 => PermissionChoice::Allow,
                            1 => PermissionChoice::AlwaysAllow,
                            _ => PermissionChoice::Deny,
                        };
                        c.answer_permission(&rid, choice, cx);
                    } else {
                        c.pick_option(&rid, i, cx);
                    }
                })
            };
            if let Ok(n) = key.parse::<usize>() {
                if n >= 1 && n <= count {
                    choose(n - 1, cx);
                    cx.stop_propagation();
                }
                return;
            }
            match key {
                "up" => {
                    chat.update(cx, |c, cx| c.hover_option(&rid, hovered.saturating_sub(1), cx));
                    cx.stop_propagation();
                }
                "down" => {
                    chat.update(cx, |c, cx| c.hover_option(&rid, (hovered + 1).min(count - 1), cx));
                    cx.stop_propagation();
                }
                "enter" => {
                    choose(hovered, cx);
                    cx.stop_propagation();
                }
                _ => {}
            }
            return;
        }
        if key == "escape" && chat.read(cx).running {
            chat.update(cx, |c, cx| c.interrupt(cx));
            cx.stop_propagation();
        }
    }

    /// `LIZARD_STUDIO_SEND=<folder>|<mode>|<prompt>` starts a chat there
    /// (Claude, or ChatGPT with `LIZARD_STUDIO_SEND_AGENT=codex`) and sends
    /// the prompt; `LIZARD_STUDIO_ALLOW_AFTER=<ms>` then
    /// answers "Yes" to permission asks after that long.
    #[cfg(feature = "snapshot")]
    fn send_test_prompt(&mut self, cx: &mut Context<Self>) {
        let Ok(spec) = std::env::var("LIZARD_STUDIO_SEND") else { return };
        let mut parts = spec.splitn(3, '|');
        let (Some(cwd), Some(mode), Some(prompt)) = (parts.next(), parts.next(), parts.next()) else { return };
        let host = self.host.clone();
        let agent = match std::env::var("LIZARD_STUDIO_SEND_AGENT").as_deref() {
            Ok("codex") => Agent::Codex,
            _ => Agent::Claude,
        };
        let chat = cx.new(|cx| ChatSession::fresh(agent, Some(cwd.to_string()), host, cx));
        chat.update(cx, |c, _| {
            c.meta.id = format!("preview-send-{}", now_ms());
            c.meta.permission_mode = Some(mode.to_string());
            if agent == Agent::Claude {
                c.meta.effort = Some("low".into());
            }
        });
        self.watch_chat(&chat, cx);
        self.chats.push(chat.clone());
        self.active = self.chats.len() - 1;
        let prompt = prompt.to_string();
        chat.update(cx, |c, cx| c.submit(prompt, Vec::new(), cx));
        if let Some(ms) = std::env::var("LIZARD_STUDIO_ALLOW_AFTER").ok().and_then(|v| v.parse::<u64>().ok()) {
            cx.spawn(async move |_, cx| loop {
                cx.background_executor().timer(Duration::from_millis(ms)).await;
                let done = chat.update(cx, |c, cx| {
                    if let Some(rid) = c.permissions.first().map(|p| p.request_id.clone()) {
                        c.answer_permission(&rid, PermissionChoice::Allow, cx);
                    }
                    !c.running
                });
                if done {
                    break;
                }
            })
            .detach();
        }
    }

    /// `LIZARD_STUDIO_OPEN=<session id>:<folder>` opens that saved Claude
    /// session read-only for a visual check. It is never written to the store.
    #[cfg(feature = "snapshot")]
    fn open_preview(&mut self, cx: &mut Context<Self>) {
        let Ok(spec) = std::env::var("LIZARD_STUDIO_OPEN") else { return };
        let Some((session, cwd)) = spec.split_once(':') else { return };
        let host = self.host.clone();
        let meta = crate::store::SavedChat {
            id: format!("preview-{session}"),
            title: std::env::var("LIZARD_STUDIO_OPEN_TITLE").unwrap_or_else(|_| "Preview".into()),
            agent: Agent::Claude,
            cwd: Some(cwd.to_string()),
            session_id: Some(session.to_string()),
            model: Some("opus".into()),
            effort: Some("xhigh".into()),
            permission_mode: Some("bypassPermissions".into()),
            created_at: now_ms(),
            updated_at: now_ms() - 20 * 60 * 1000,
            bookmark: None,
            open: true,
            title_edited: true,
            work_cwd: std::env::var("LIZARD_STUDIO_OPEN_WORKDIR").ok(),
        };
        let chat = cx.new(|cx| ChatSession::new(meta, host, cx));
        self.watch_chat(&chat, cx);
        let at = std::env::var("LIZARD_STUDIO_OPEN_AT").ok().and_then(|v| v.parse().ok()).unwrap_or(0).min(self.chats.len());
        self.chats.insert(at, chat);
        self.active = at;
        self.prune_blank(cx);
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// The host's gitDiff, summed: changes not yet on the remote's default branch
/// (unpushed commits and uncommitted edits) plus untracked files.
fn git_info(cwd: &str) -> GitInfo {
    let run = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("git").arg("-C").arg(cwd).args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
    };
    let Some(status) = run(&["status", "--porcelain=v1", "--untracked-files=all"]) else {
        return GitInfo::default();
    };
    let mut info = GitInfo { is_repo: true, ..Default::default() };
    info.branch = run(&["rev-parse", "--abbrev-ref", "HEAD"]).map(|b| b.trim().to_string()).filter(|b| !b.is_empty() && b != "HEAD");
    let default = run(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).map(|r| r.trim().to_string());
    let mut base = None;
    for candidate in [default.as_deref(), Some("origin/main"), Some("origin/master")].into_iter().flatten() {
        if let Some(mb) = run(&["merge-base", "HEAD", candidate]).map(|m| m.trim().to_string()).filter(|m| !m.is_empty()) {
            base = Some(mb);
            break;
        }
    }
    let has_tracked = status.lines().any(|l| !l.starts_with("??") && !l.starts_with("!!"));
    let numstat = match &base {
        Some(base) => run(&["diff", "--numstat", base.as_str()]),
        None if has_tracked => run(&["diff", "--numstat", "HEAD"]).filter(|o| !o.trim().is_empty()).or_else(|| run(&["diff", "--numstat"])),
        None => None,
    };
    for line in numstat.unwrap_or_default().lines() {
        let mut parts = line.split_whitespace();
        info.added += parts.next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
        info.removed += parts.next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
        info.files += 1;
    }
    for path in status.lines().filter_map(|l| l.strip_prefix("?? ")) {
        info.files += 1;
        if let Ok(text) = std::fs::read_to_string(std::path::Path::new(cwd).join(path)) {
            info.added += text.lines().count() as u64;
        }
    }
    info
}

fn catalog_from(msg: &Value) -> Catalog {
    let models = msg
        .get("models")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let id = row.get("id").and_then(Value::as_str)?.to_string();
                    let label = row.get("label").and_then(Value::as_str).unwrap_or(&id).to_string();
                    let efforts = row
                        .get("efforts")
                        .and_then(Value::as_array)
                        .map(|e| e.iter().filter_map(Value::as_str).map(str::to_string).collect())
                        .unwrap_or_default();
                    Some(ModelRow {
                        id,
                        label,
                        context_limit: row.get("contextLimit").and_then(Value::as_u64),
                        efforts,
                        default_effort: row.get("defaultEffort").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Catalog {
        models,
        default_model: msg.get("defaultModel").and_then(Value::as_str).map(str::to_string),
        default_effort: msg.get("defaultEffort").and_then(Value::as_str).map(str::to_string),
    }
}

/// chat.js contextLimit: the catalog's limit for the model id, then the
/// built-in table by exact id, else 200k.
fn context_limit(row: Option<&ModelRow>, model: Option<&str>) -> u64 {
    if let Some(limit) = row.and_then(|r| r.context_limit) {
        return limit;
    }
    match model.unwrap_or("") {
        "claude-opus-4-8" | "claude-opus-5" | "claude-sonnet-5" | "claude-fable-5" => 1_000_000,
        "claude-haiku-4-5" => 200_000,
        _ => 200_000,
    }
}

/// (id, full label, pill label, hint) — chat.js MODES / CODEX_MODES.
fn modes_for(agent: Agent) -> &'static [(&'static str, &'static str, &'static str, &'static str)] {
    match agent {
        Agent::Claude => &[
            ("default", "Ask permissions", "Ask", "Asks for your approval before tools that aren't pre-approved."),
            ("acceptEdits", "Accept edits", "Accept", "Auto-accepts file edits; still asks for risky commands."),
            ("plan", "Plan mode", "Plan", "Read-only planning — Claude won't run or edit anything."),
            ("auto", "Auto mode", "Auto", "A classifier auto-approves safe tool calls and denies risky ones. Availability depends on the model/provider."),
            ("bypassPermissions", "Bypass permissions", "Bypass", "Allows everything without asking. Use with care."),
        ],
        Agent::Codex => &[
            ("read-only", "Read only", "Read", "ChatGPT can read files but cannot edit them or run commands that write."),
            ("workspace", "Ask permissions", "Ask", "ChatGPT works inside the project folder and asks before anything riskier."),
            ("full-access", "Full access", "Full", "No sandbox, no questions. Use with care."),
        ],
    }
}

/// The mode pill's colours (panel.css `.mode-btn.mode-*`).
fn mode_colors(mode: &str) -> (Hsla, Hsla) {
    match mode {
        "auto" => (rgba_hex(WARN_BRIGHT, 0.18), hex(WARN_BRIGHT)),
        "bypassPermissions" | "full-access" => (rgba_hex(RED, 0.18), hex(RED)),
        _ => (white_a(0.08), hex(TEXT_PRIMARY)),
    }
}

fn effort_label(agent: Agent, effort: &str) -> String {
    match (agent, effort) {
        (Agent::Claude, "xhigh") => "Extra".into(),
        (Agent::Codex, "xhigh") => "Extra High".into(),
        (_, "ultracode") => "Ultracode".into(),
        (_, "ultra") => "Ultra".into(),
        (_, e) => {
            let mut chars = e.chars();
            chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
        }
    }
}

// ---- rendering ----------------------------------------------------------------

/// A 28×28 `.icon-btn`: #5f646d, #e9edf4 on hover.
fn icon_button(id: &'static str, icon: &'static str, size: f32) -> Stateful<Div> {
    let group: SharedString = format!("icon-btn-{id}").into();
    div()
        .id(id)
        .group(group.clone())
        .size(px(28.))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .cursor_pointer()
        .child(ph(icon, size, hex(TEXT_TERTIARY)).group_hover(group, |s| s.text_color(hex(TEXT_PRIMARY))))
}

#[derive(Clone, Copy)]
enum Dot {
    Idle,
    Wait,
    Run,
    Unseen,
}

struct SidebarRow {
    ix: usize,
    id: String,
    title: String,
    open: bool,
    active: bool,
    ts: u64,
    dot: Dot,
    bookmark: Option<String>,
}

impl StudioApp {
    fn render_sidebar_row(&mut self, row: SidebarRow, cx: &mut Context<Self>) -> AnyElement {
        let group: SharedString = format!("chat-row-{}", row.id).into();
        let ix = row.ix;
        let editing = self.rename.as_ref().filter(|(id, _)| *id == row.id).map(|(_, input)| input.clone());
        let title_color = if row.open { hex(TEXT_PRIMARY) } else { hex(TEXT_SECONDARY) };
        let dot = match row.dot {
            Dot::Idle => div().size(px(8.)).flex_none().rounded_full().border_1().border_color(hex(BORDER)).into_any_element(),
            Dot::Wait => pulse(("dot", ix), 1600, div().size(px(8.)).flex_none().rounded_full().bg(hex(BLUE))),
            Dot::Run => pulse(("dot", ix), 1600, div().size(px(8.)).flex_none().rounded_full().bg(hex(WARN_SOFT))),
            Dot::Unseen => div().size(px(8.)).flex_none().rounded_full().bg(hex(EMERALD)).into_any_element(),
        };
        let bookmark_open = self.menu == Some(Menu::Bookmark(row.id.clone()));
        let bookmark_color = row.bookmark.as_deref().and_then(|c| u32::from_str_radix(c.trim_start_matches('#'), 16).ok());
        let bookmark_id = row.id.clone();
        let bookmark_menu = bookmark_open.then(|| self.render_bookmark_menu(&row.id, cx));
        let bookmark = div()
            .relative()
            .flex_none()
            .child(
                div()
                    .id(("bookmark", ix))
                    .size(px(18.))
                    .mx(px(-4.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(5.))
                    .cursor_pointer()
                    .when(bookmark_open, |d| d.bg(white_a(0.08)))
                    .hover(|s| s.bg(white_a(0.08)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        let menu = Menu::Bookmark(bookmark_id.clone());
                        this.menu = if this.menu.as_ref() == Some(&menu) { None } else { Some(menu) };
                        cx.notify();
                    }))
                    .child(match bookmark_color {
                        Some(color) => svg().path("ph/bookmark-fill.svg").w(px(12.)).h(px(14.)).text_color(hex(color)),
                        None => svg()
                            .path("ph/bookmark.svg")
                            .w(px(12.))
                            .h(px(14.))
                            .text_color(if bookmark_open { hex(TEXT_SECONDARY) } else { hex(BORDER) }),
                    }),
            )
            .children(bookmark_menu);

        let close_id = row.id.clone();
        let rename_target = row.id.clone();
        let open = row.open;
        div()
            .id(("chat-row", ix))
            .group(group.clone())
            .relative()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(10.))
            .py(px(7.))
            .rounded(px(7.))
            .cursor_pointer()
            .when(row.active, |d| d.bg(white_a(0.07)))
            .when(!row.active, |d| d.hover(|s| s.bg(white_a(0.05))))
            .on_click(cx.listener(move |this, _, window, cx| this.select_chat(ix, window, cx)))
            .child(dot)
            .child(bookmark)
            .child(match editing {
                Some(input) => div()
                    .flex_1()
                    .min_w_0()
                    .child(Input::new(&input).appearance(false).xsmall().text_size(px(12.5)).h(px(18.)))
                    .into_any_element(),
                None => div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.5))
                    .line_height(px(18.))
                    .text_color(title_color)
                    .when(row.active, |d| d.font_weight(FontWeight::SEMIBOLD))
                    .child(row.title)
                    .into_any_element(),
            })
            .child(
                div()
                    .flex_none()
                    .text_size(px(10.5))
                    .text_color(hex(TEXT_TERTIARY))
                    .group_hover(group.clone(), |s| s.invisible())
                    .child(ui::rel_time(row.ts)),
            )
            .child(
                div()
                    .absolute()
                    .right(px(8.))
                    .flex()
                    .gap(px(2.))
                    .invisible()
                    .group_hover(group.clone(), |s| s.visible())
                    .child(
                        div()
                            .id(("rename", ix))
                            .size(px(18.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(5.))
                            .hover(|s| s.bg(white_a(0.08)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.start_rename(rename_target.clone(), window, cx);
                            }))
                            .child(ph("edit", 13., hex(TEXT_TERTIARY))),
                    )
                    .child(
                        div()
                            .id(("close", ix))
                            .size(px(18.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(5.))
                            .hover(|s| s.bg(rgba_hex(RED, 0.12)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                let Some(ix) = this.index_of(&close_id, cx) else { return };
                                if open {
                                    this.close_chat(ix, window, cx);
                                } else {
                                    this.delete_chat(ix, cx);
                                }
                            }))
                            .child(if open { ph("x", 13., hex(TEXT_TERTIARY)) } else { ph("trash", 14., hex(TEXT_TERTIARY)) }),
                    ),
            )
            .into_any_element()
    }

    fn render_sidebar(&mut self, width: Pixels, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self.search.read(cx).value().to_lowercase();
        let mut open_rows = Vec::new();
        let mut closed_rows = Vec::new();
        for (ix, chat) in self.chats.iter().enumerate() {
            let c = chat.read(cx);
            if !query.is_empty() && !c.meta.title.to_lowercase().contains(&query) {
                continue;
            }
            let dot = if !c.meta.open {
                Dot::Idle
            } else if !c.permissions.is_empty() {
                Dot::Wait
            } else if c.running || !c.queued.is_empty() {
                Dot::Run
            } else if c.unseen {
                Dot::Unseen
            } else {
                Dot::Idle
            };
            let row = SidebarRow {
                ix,
                id: c.id().to_string(),
                title: c.meta.title.clone(),
                open: c.meta.open,
                active: ix == self.active,
                ts: c.meta.updated_at,
                dot,
                bookmark: c.meta.bookmark.clone(),
            };
            if c.meta.open {
                open_rows.push(row)
            } else {
                closed_rows.push(row)
            }
        }
        closed_rows.sort_by(|a, b| b.ts.cmp(&a.ts));

        let group_label = |text: &'static str, first: bool| {
            div()
                .px(px(8.))
                .pt(px(if first { 2. } else { 10. }))
                .pb(px(4.))
                .text_size(px(11.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(hex(TEXT_TERTIARY))
                .child(text)
        };

        let empty = open_rows.is_empty() && closed_rows.is_empty();
        let has_open = !open_rows.is_empty();
        let has_closed = !closed_rows.is_empty();
        let open_elements: Vec<AnyElement> = open_rows.into_iter().map(|r| self.render_sidebar_row(r, cx)).collect();
        let closed_elements: Vec<AnyElement> = closed_rows.into_iter().map(|r| self.render_sidebar_row(r, cx)).collect();
        let settings_menu = (self.menu == Some(Menu::Settings)).then(|| self.render_settings_menu(cx));

        div()
            .w(width)
            .h_full()
            .flex()
            .flex_col()
            .flex_none()
            .bg(hex(BG_SECONDARY))
            // The chat's `box-shadow: -1px 0 0 #2e2e2e` lands on this pixel.
            .border_r_1()
            .border_color(hex(BORDER))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .pt(px(14.))
                    .pb(px(10.))
                    .px(px(16.))
                    .child(lizard(20., hex(EMERALD)).ml(px(-2.)))
                    .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).child("Chats"))
                    .child(div().flex_1())
                    .child(icon_button("new-chat", "plus", 17.).on_click(cx.listener(|this, _, window, cx| this.new_chat(window, cx))))
                    .child(icon_button("hide-sidebar", "side-panel", 18.).on_click(cx.listener(|this, _, _, cx| {
                        this.sidebar_open = false;
                        cx.notify();
                    }))),
            )
            .child(
                div()
                    .mx(px(10.))
                    .mb(px(6.))
                    .px(px(8.))
                    .py(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(hex(BORDER))
                    .bg(hex(BG_PRIMARY))
                    .child(ph("search", 13., hex(TEXT_TERTIARY)))
                    .child(div().flex_1().child(Input::new(&self.search).appearance(false).xsmall().text_size(px(12.5)).h(px(18.)))),
            )
            .child(
                div()
                    .id("chat-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(px(6.))
                    .pb(px(8.))
                    .flex()
                    .flex_col()
                    .when(empty, |d| {
                        d.child(
                            div()
                                .px(px(8.))
                                .pt(px(6.))
                                .pb(px(10.))
                                .text_size(px(12.))
                                .text_color(hex(TEXT_TERTIARY))
                                .child(if query.is_empty() { "No chats yet." } else { "No matches." }),
                        )
                    })
                    // Rows sit 2px apart; a group label sits right on its rows.
                    .when(has_open, |d| d.child(group_label("Active", true)))
                    .child(div().flex().flex_col().gap(px(2.)).children(open_elements))
                    .when(has_closed, |d| d.child(group_label("History", !has_open)))
                    .child(div().flex().flex_col().gap(px(2.)).children(closed_elements)),
            )
            .child(
                div()
                    .relative()
                    .p(px(6.))
                    .border_t_1()
                    .border_color(hex(BORDER))
                    .child(
                        div()
                            .id("settings")
                            .group("settings")
                            .w_full()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .px(px(10.))
                            .py(px(9.))
                            .rounded(px(8.))
                            .cursor_pointer()
                            .text_size(px(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(hex(TEXT_SECONDARY))
                            .hover(|s| s.bg(white_a(0.05)).text_color(hex(TEXT_PRIMARY)))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.menu = if this.menu == Some(Menu::Settings) { None } else { Some(Menu::Settings) };
                                cx.notify();
                            }))
                            .child(ph("gear", 16., hex(TEXT_TERTIARY)).group_hover("settings", |s| s.text_color(hex(TEXT_PRIMARY))))
                            .child("Settings"),
                    )
                    .children(settings_menu.map(|m| div().absolute().top_0().left(px(6.)).child(m))),
            )
    }

    fn render_bookmark_menu(&mut self, id: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let current = self.chat_by_id(id, cx).and_then(|c| c.read(cx).meta.bookmark.clone());
        let mut choices: Vec<(Option<String>, Hsla, bool)> = vec![(None, hex(TEXT_SECONDARY), current.is_none())];
        for (_, color) in BOOKMARKS {
            let value = format!("#{color:06x}");
            let picked = current.as_deref() == Some(value.as_str());
            choices.push((Some(value), hex(*color), picked));
        }
        let id = id.to_string();
        ui::popup(
            Anchor::TopLeft,
            point(px(-6.), px(22.)),
            div()
                .id("bookmark-menu")
                .occlude()
                .flex()
                .gap(px(2.))
                .p(px(4.))
                .bg(hex(BG_PRIMARY))
                .border_1()
                .border_color(hex(BORDER))
                .rounded(px(8.))
                .shadow(vec![BoxShadow {
                    color: hsla(0., 0., 0., 0.5),
                    offset: point(px(0.), px(8.)),
                    blur_radius: px(24.),
                    spread_radius: px(0.),
                    inset: false,
                }])
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.menu = None;
                    cx.notify();
                }))
                .children(choices.into_iter().enumerate().map(|(i, (value, color, picked))| {
                    let id = id.clone();
                    div()
                        .id(("bookmark-choice", i))
                        .size(px(28.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(5.))
                        .border_1()
                        .border_color(if picked { color } else { hsla(0., 0., 0., 0.) })
                        .when(picked, |d| d.bg(white_a(0.06)))
                        .hover(|s| s.bg(white_a(0.08)))
                        .cursor_pointer()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            if let Some(chat) = this.chat_by_id(&id, cx) {
                                let value = value.clone();
                                chat.update(cx, |c, cx| c.set_bookmark(value, cx));
                            }
                            this.menu = None;
                            cx.notify();
                        }))
                        .child(
                            svg()
                                .path(if i == 0 { "ph/bookmark.svg" } else { "ph/bookmark-fill.svg" })
                                .w(px(12.))
                                .h(px(14.))
                                .text_color(color),
                        )
                })),
        )
    }

    fn render_settings_menu(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let open = |path: PathBuf| -> Box<dyn Fn(&mut Window, &mut App)> {
            Box::new(move |_, cx: &mut App| {
                if !path.exists() {
                    if let Some(dir) = path.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::write(&path, "");
                }
                cx.open_with_system(&path);
            })
        };
        let app = cx.entity();
        let mk = |label: &str, hint: &str, action: Box<dyn Fn(&mut Window, &mut App)>| {
            let app = app.clone();
            MenuEntry {
                label: label.to_string().into(),
                hint: Some(hint.to_string().into()),
                current: false,
                accent: None,
                on_click: Box::new(move |window, cx| {
                    action(window, cx);
                    app.update(cx, |this, cx| {
                        this.menu = None;
                        cx.notify();
                    });
                }),
            }
        };
        let version = self.host_state.version.map(|v| format!("Helper v{v}")).unwrap_or_else(|| "Helper not connected".into());
        let entries = vec![
            mk("Claude Code settings", "~/.claude/settings.json", open(home_dir().join(".claude").join("settings.json"))),
            mk("ChatGPT settings", "~/.codex/config.toml", open(home_dir().join(".codex").join("config.toml"))),
            mk("Helper log", &format!("{version} · ~/.lizard-studio/host/host.log"), open(host_dir().join("host.log"))),
            mk(
                "Copy helper update command",
                "npx @lizard-build/lizard-studio-host install",
                Box::new(|_, cx: &mut App| {
                    cx.write_to_clipboard(ClipboardItem::new_string("npx @lizard-build/lizard-studio-host install".into()))
                }),
            ),
        ];
        ui::popup(
            Anchor::BottomLeft,
            point(px(0.), px(-6.)),
            ui::menu_box("settings-menu", 280., entries).on_mouse_down_out(cx.listener(|this, _, _, cx| {
                this.menu = None;
                cx.notify();
            })),
        )
    }

    fn render_onboarding(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let (title, body, command) = if !host_installed() {
            (
                "Connect your agent",
                "Lizard Studio talks to Claude Code and ChatGPT through the same local helper as the Chrome extension. Install it once:",
                "npx @lizard-build/lizard-studio-host install",
            )
        } else if self.host_state.claude_ok == Some(false) {
            (
                "Install Claude Code",
                "The helper is running, but it can't find the claude command. Install it, then check again:",
                "npm i -g @anthropic-ai/claude-code",
            )
        } else {
            (
                "Update the helper",
                "This app needs a newer local helper. Update it, then check again:",
                "npx @lizard-build/lizard-studio-host@latest install",
            )
        };
        let error = self.host_state.error.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(14.))
            .px(px(32.))
            .child(lizard(48., hex(EMERALD)))
            .child(div().text_size(px(24.)).line_height(px(32.)).font_weight(FontWeight::SEMIBOLD).child(title))
            .child(div().max_w(px(460.)).text_size(px(14.)).line_height(px(20.)).text_color(hex(TEXT_SECONDARY)).text_center().child(body))
            .child(
                div()
                    .id("copy-command")
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(12.))
                    .py(px(8.))
                    .rounded(px(8.))
                    .bg(hex(BG_SECONDARY))
                    .border_1()
                    .border_color(hex(BORDER))
                    .cursor_pointer()
                    .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(command.into())))
                    .child(div().font_family("Lizard Mono").text_size(px(12.)).child(command))
                    .child(ph("copy", 13., hex(TEXT_TERTIARY))),
            )
            .child(
                div()
                    .id("check-again")
                    .h(px(32.))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .rounded(px(8.))
                    .border_1()
                    .border_color(hex(EMERALD))
                    .bg(rgba_hex(EMERALD, 0.5))
                    .hover(|s| s.bg(hex(EMERALD)))
                    .cursor_pointer()
                    .text_size(px(12.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Check again")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.host.detach();
                        this.host_state = HostState::default();
                        this.connect(cx);
                    })),
            )
            .when_some(error, |d, e| d.child(div().text_size(px(12.)).text_color(hex(RED_SOFT)).child(e)))
            .into_any_element()
    }

    fn render_chat(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let entity = self.chats[self.active].clone();
        let (blank, loading, paging, list_state, list_id) = {
            let c = entity.read(cx);
            (
                c.is_blank(),
                c.history_loading() && c.items.is_empty(),
                c.history_loading() && !c.items.is_empty(),
                c.list.clone(),
                SharedString::from(format!("messages-{}", c.id())),
            )
        };
        let other_answer = self.other_answer.clone();
        let renderer_entity = entity.clone();
        let list = div().id(list_id).size_full().relative().child(
            list(list_state.clone(), move |ix, window, cx| {
                div()
                    .w_full()
                    .px(px(12.))
                    .when(ix == 0, |d| d.pt(px(14.)))
                    .when(ix + 1 == renderer_entity.read(cx).row_count(), |d| d.pb(px(14.)))
                    .child(render_row(&renderer_entity, &other_answer, ix, window, cx))
                    .into_any_element()
            })
            .size_full(),
        )
        .vertical_scrollbar(&list_state);

        let fade = |top: bool| {
            div()
                .absolute()
                .left_0()
                .right_0()
                .h(px(18.))
                .when(top, |d| d.top_0())
                .when(!top, |d| d.bottom_0())
                .bg(linear_gradient(
                    if top { 180. } else { 0. },
                    linear_color_stop(hex(BG_PRIMARY), 0.),
                    linear_color_stop(rgba_hex(BG_PRIMARY, 0.), 1.),
                ))
        };

        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .bg(hex(BG_PRIMARY))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .when(blank, |d| {
                        d.child(
                            div()
                                .absolute()
                                .inset_0()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(lizard(64., hex(EMPTY_MARK))),
                        )
                    })
                    .when(loading, |d| {
                        d.child(
                            div()
                                .absolute()
                                .inset_0()
                                .flex()
                                .items_center()
                                .justify_center()
                                .text_size(px(12.))
                                .text_color(hex(TEXT_TERTIARY))
                                .child("Loading messages…"),
                        )
                    })
                    .when(!blank && !loading, |d| d.child(list))
                    .child(fade(true))
                    .child(fade(false))
                    .when(paging, |d| {
                        d.child(
                            div().absolute().top(px(10.)).left_0().right_0().flex().justify_center().child(
                                div()
                                    .px(px(12.))
                                    .py(px(5.))
                                    .rounded(px(8.))
                                    .bg(hex(BG_CARD))
                                    .text_size(px(11.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(hex(TEXT_SECONDARY))
                                    .child("Loading earlier messages…"),
                            ),
                        )
                    })

            )
            .child(self.render_composer(cx))
            .into_any_element()
    }

    fn picker_entry(
        &self,
        label: String,
        hint: Option<String>,
        current: bool,
        accent: Option<Hsla>,
        cx: &mut Context<Self>,
        action: impl Fn(&mut Window, &mut App) + 'static,
    ) -> MenuEntry {
        let app = cx.entity();
        MenuEntry {
            label: label.into(),
            hint: hint.map(Into::into),
            current,
            accent,
            on_click: Box::new(move |window, cx| {
                action(window, cx);
                app.update(cx, |this, cx| {
                    this.menu = None;
                    cx.notify();
                });
            }),
        }
    }

    fn render_composer(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let entity = self.chats[self.active].clone();
        let (work_cwd, ctx_window, (tasks_running, tasks_total)) = {
            let c = entity.read(cx);
            (c.work_cwd(), c.ctx_window, c.task_counts())
        };
        let (agent, blank, running, cwd, mode, model, effort, ctx_tokens, commands) = {
            let c = entity.read(cx);
            (
                c.meta.agent,
                c.is_blank(),
                c.running,
                c.meta.cwd.clone(),
                c.meta.permission_mode.clone().unwrap_or_else(|| chat::default_mode(c.meta.agent).into()),
                c.meta.model.clone(),
                c.meta.effort.clone(),
                c.ctx_tokens,
                c.commands.clone(),
            )
        };
        let catalog = self.catalogs.get(&agent).cloned().unwrap_or_default();
        let git = work_cwd.as_ref().and_then(|cwd| self.git.get(cwd).cloned()).unwrap_or_default();
        let menu = self.menu.clone();
        let composer_text = self.composer.read(cx).value().to_string();

        let models: Vec<ModelRow> = if catalog.models.is_empty() && agent == Agent::Claude {
            [("default", "Default"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")]
                .iter()
                .map(|(id, label)| ModelRow {
                    id: id.to_string(),
                    label: label.to_string(),
                    context_limit: None,
                    efforts: vec![],
                    default_effort: None,
                })
                .collect()
        } else {
            catalog.models.clone()
        };
        let current_model = model.clone().or(catalog.default_model.clone()).or_else(|| models.first().map(|m| m.id.clone()));
        let model_row = current_model.as_ref().and_then(|id| models.iter().find(|m| &m.id == id)).cloned();
        let model_label = model_row.as_ref().map(|m| m.label.clone()).or(current_model.clone()).unwrap_or_else(|| "Default".into());
        let efforts: Vec<String> = match agent {
            Agent::Claude => ["low", "medium", "high", "xhigh", "max", "ultracode"].iter().map(|s| s.to_string()).collect(),
            Agent::Codex => model_row.as_ref().map(|m| m.efforts.clone()).unwrap_or_default(),
        };
        let effort_value = effort
            .clone()
            .or_else(|| model_row.as_ref().and_then(|m| m.default_effort.clone()))
            .or_else(|| catalog.default_effort.clone().filter(|e| efforts.contains(e)));
        // ChatGPT gets its window from the agent; without one there is no ring.
        let limit = match agent {
            Agent::Claude => context_limit(model_row.as_ref(), current_model.as_deref()),
            Agent::Codex => ctx_window.unwrap_or(0),
        };
        let fraction = if limit > 0 { ctx_tokens as f32 / limit as f32 } else { 0. };
        let modes = modes_for(agent);
        let (mode_bg, mode_fg) = mode_colors(&mode);
        let mode_short = modes.iter().find(|m| m.0 == mode).map(|m| m.2).unwrap_or("Ask");


        // Pickers.
        let mode_menu = (menu == Some(Menu::Mode)).then(|| {
            let entries = modes
                .iter()
                .map(|(id, label, _, hint)| {
                    let entity = entity.clone();
                    self.picker_entry(label.to_string(), Some(hint.to_string()), *id == mode, None, cx, move |_, cx| {
                        entity.update(cx, |c, cx| c.set_settings(None, None, Some(id.to_string()), cx))
                    })
                })
                .collect();
            ui::popup(Anchor::BottomLeft, point(px(0.), px(-8.)), ui::menu_box("mode-menu", 260., entries).on_mouse_down_out(close_menu_listener(cx)))
        });
        let model_menu = (menu == Some(Menu::Model)).then(|| {
            let entries = models
                .iter()
                .map(|row| {
                    let entity = entity.clone();
                    let id = row.id.clone();
                    self.picker_entry(row.label.clone(), None, current_model.as_deref() == Some(row.id.as_str()), None, cx, move |_, cx| {
                        let id = id.clone();
                        entity.update(cx, |c, cx| c.set_settings(Some(Some(id)), None, None, cx))
                    })
                })
                .collect();
            ui::popup(Anchor::BottomRight, point(px(0.), px(-8.)), ui::menu_box("model-menu", 220., entries).on_mouse_down_out(close_menu_listener(cx)))
        });
        let effort_menu = (menu == Some(Menu::Effort)).then(|| {
            let entries = efforts
                .iter()
                .map(|e| {
                    let entity = entity.clone();
                    let value = e.clone();
                    let accent = e.starts_with("ultra").then(|| hex(EMERALD));
                    self.picker_entry(effort_label(agent, e), None, effort_value.as_deref() == Some(e.as_str()), accent, cx, move |_, cx| {
                        let value = value.clone();
                        entity.update(cx, |c, cx| c.set_settings(None, Some(Some(value)), None, cx))
                    })
                })
                .collect();
            ui::popup(Anchor::BottomRight, point(px(0.), px(-8.)), ui::menu_box("effort-menu", 170., entries).on_mouse_down_out(close_menu_listener(cx)))
        });
        let agent_menu = (menu == Some(Menu::Agent)).then(|| {
            let entries = [Agent::Claude, Agent::Codex]
                .into_iter()
                .map(|a| {
                    let app = cx.entity();
                    self.picker_entry(a.label().to_string(), None, a == agent, None, cx, move |window, cx| {
                        app.update(cx, |this, cx| this.set_agent(a, window, cx))
                    })
                })
                .collect();
            ui::popup(Anchor::BottomLeft, point(px(0.), px(-8.)), ui::menu_box("agent-menu", 200., entries).on_mouse_down_out(close_menu_listener(cx)))
        });

        // Slash commands while the first word is being typed.
        let slash: Vec<String> = if composer_text.starts_with('/') && !composer_text.contains(char::is_whitespace) {
            let prefix = composer_text.trim_start_matches('/').to_lowercase();
            commands.iter().filter(|c| c.to_lowercase().starts_with(&prefix)).take(8).cloned().collect()
        } else {
            Vec::new()
        };
        let slash_menu = (!slash.is_empty()).then(|| {
            let entries = slash
                .into_iter()
                .map(|name| {
                    let composer = self.composer.clone();
                    MenuEntry {
                        label: format!("/{name}").into(),
                        hint: None,
                        current: false,
                        accent: None,
                        on_click: Box::new(move |window, cx| {
                            let value = format!("/{name} ");
                            composer.update(cx, |s, cx| {
                                s.set_value(value, window, cx);
                                s.focus(window, cx);
                            });
                        }),
                    }
                })
                .collect();
            ui::popup(Anchor::BottomLeft, point(px(0.), px(-8.)), ui::menu_box("slash-menu", 280., entries))
        });

        let chip = |id: &'static str| {
            div()
                .id(id)
                .flex()
                .items_center()
                .gap(px(7.))
                .px(px(11.))
                .py(px(6.))
                .rounded_full()
                .bg(white_a(0.05))
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(hex(TEXT_SECONDARY))
                .cursor_pointer()
                .hover(|s| s.bg(white_a(0.09)).text_color(hex(TEXT_PRIMARY)))
        };
        let needs_folder = cwd.is_none();
        let setup = blank.then(|| {
            div()
                .flex()
                .flex_wrap()
                .gap(px(6.))
                .px(px(2.))
                .pb(px(10.))
                .child(
                    chip("folder-chip")
                        .when(needs_folder, |d| {
                            d.bg(hsla(218. / 360., 1., 0.735, 0.14))
                                .text_color(hex(TEXT_PRIMARY))
                                .border_1()
                                .border_color(hsla(218. / 360., 1., 0.735, 0.35))
                        })
                        .on_click(cx.listener(|this, _, window, cx| this.pick_folder(window, cx)))
                        .child(ph("folder", 14., hex(TEXT_SECONDARY)))
                        .child(ui::folder_label(cwd.as_deref())),
                )
                .when_some(git.branch.clone(), |d, branch| {
                    d.child(chip("branch-chip").child(ph("git-branch", 13., hex(TEXT_SECONDARY))).child(branch))
                })
                .child(
                    div()
                        .relative()
                        .child(
                            chip("agent-chip")
                                .on_click(toggle_menu(Menu::Agent, cx))
                                .child(if agent == Agent::Claude {
                                    ph("claude", 13., hex(CLAUDE_CLAY))
                                } else {
                                    ph("codex", 13., hex(TEXT_PRIMARY))
                                })
                                .child(agent.label()),
                        )
                        .children(agent_menu.map(|m| div().absolute().top_0().left_0().child(m))),
                )
        });

        // The git bar above the box (panel.css .git-bar): shown once the folder
        // has changes not on the default branch, or a background task exists.
        let has_changes = git.is_repo && git.files > 0;
        let flap = (!blank && (has_changes || tasks_total > 0)).then(|| {
            let show_branch = git.is_repo && git.branch.is_some();
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .px(px(12.))
                .pt(px(7.))
                .pb(px(21.))
                .mb(px(-14.))
                .rounded_tl(px(14.))
                .rounded_tr(px(14.))
                .bg(hex(BG_SECONDARY))
                .child(if show_branch {
                    ph("git-branch", 12., hex(TEXT_TERTIARY))
                } else {
                    ph("folder", 12., hex(TEXT_TERTIARY))
                })
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.))
                        .text_color(hex(TEXT_SECONDARY))
                        .child(if show_branch {
                            git.branch.clone().unwrap_or_default()
                        } else {
                            ui::folder_label(work_cwd.as_deref())
                        }),
                )
                .when(has_changes, |d| {
                    d.child(
                        div()
                            .flex()
                            .gap(px(6.))
                            .px(px(10.))
                            .py(px(4.))
                            .rounded_full()
                            .bg(white_a(0.05))
                            .font_family("Lizard Mono")
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(div().text_color(hex(EMERALD)).child(format!("+{}", git.added)))
                            .child(div().text_color(hex(RED)).child(format!("-{}", git.removed))),
                    )
                })
                .when(tasks_total > 0, |d| {
                    let chip = div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .px(px(10.))
                        .py(px(4.))
                        .rounded_full()
                        .bg(white_a(0.05))
                        .text_color(hex(TEXT_PRIMARY))
                        .child(ph("stack", 14., hex(TEXT_PRIMARY)))
                        .when(tasks_running > 0, |d| {
                            d.child(
                                div()
                                    .font_family("Lizard Mono")
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(tasks_running.to_string()),
                            )
                        });
                    d.child(if tasks_running > 0 { pulse("tasks-chip", 2400, chip) } else { chip.into_any_element() })
                })
        });

        let attachments: Vec<(usize, String)> = self.attachments.iter().enumerate().map(|(i, a)| (i, a.name.clone())).collect();
        let model_open = menu == Some(Menu::Model);
        let effort_open = menu == Some(Menu::Effort);
        let ultra = effort_value.as_deref().map_or(false, |e| e.starts_with("ultra"));

        let quiet_button = |id: &'static str, label: String, open: bool, max_w: f32| {
            div()
                .id(id)
                .max_w(px(max_w))
                .truncate()
                .px(px(8.))
                .py(px(5.))
                .rounded(px(6.))
                .cursor_pointer()
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(if open { hex(TEXT_PRIMARY) } else { hex(TEXT_SECONDARY) })
                .when(open, |d| d.bg(white_a(0.05)))
                .hover(|s| s.bg(white_a(0.05)).text_color(hex(TEXT_PRIMARY)))
                .child(label)
        };
        let ring_tip = format!(
            "Context {}% · {} of {} tokens",
            (fraction * 100.).round() as u32,
            ui::thousands(ctx_tokens),
            ui::thousands(limit)
        );

        div()
            .flex_none()
            .px(px(12.))
            .pb(px(14.))
            .children(setup)
            .children(flap)
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .bg(hex(BG_SECONDARY))
                    .border_1()
                    .border_color(hex(BORDER))
                    .rounded(px(14.))
                    .pt(px(8.))
                    .px(px(8.))
                    .pb(px(6.))
                    .children(slash_menu.map(|m| div().absolute().top_0().left_0().child(m)))
                    .when(!attachments.is_empty(), |d| {
                        d.child(div().flex().flex_wrap().gap(px(4.)).px(px(6.)).pb(px(6.)).children(attachments.into_iter().map(
                            |(i, name)| {
                                div()
                                    .id(("attachment", i))
                                    .flex()
                                    .items_center()
                                    .gap(px(4.))
                                    .px(px(7.))
                                    .py(px(2.))
                                    .rounded(px(6.))
                                    .bg(white_a(0.07))
                                    .text_size(px(10.5))
                                    .text_color(hex(TEXT_SECONDARY))
                                    .cursor_pointer()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if i < this.attachments.len() {
                                            this.attachments.remove(i);
                                        }
                                        cx.notify();
                                    }))
                                    .child(ph("file", 11., hex(TEXT_SECONDARY)))
                                    .child(name)
                                    .child(ph("x", 10., hex(TEXT_TERTIARY)))
                            },
                        )))
                    })
                    .child(
                        div().px(px(2.)).pt(px(4.)).pb(px(2.)).child(
                            Textarea::new(&self.composer)
                                .appearance(false)
                                .bordered(false)
                                .xsmall()
                                .text_size(px(14.))
                                .line_height(relative(1.45)),
                        ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .pt(px(4.))
                            .child(
                                div()
                                    .id("attach")
                                    .size(px(26.))
                                    .mr(px(2.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(|s| s.bg(white_a(0.08)))
                                    .on_click(cx.listener(|this, _, window, cx| this.pick_files(window, cx)))
                                    .child(ph("plus", 15., hex(TEXT_TERTIARY))),
                            )
                            .child(
                                div()
                                    .relative()
                                    .child(
                                        div()
                                            .id("mode")
                                            .px(px(10.))
                                            .py(px(5.))
                                            .rounded(px(6.))
                                            .bg(mode_bg)
                                            .text_color(mode_fg)
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .cursor_pointer()
                                            .hover(|s| s.opacity(0.85))
                                            .on_click(toggle_menu(Menu::Mode, cx))
                                            .child(mode_short),
                                    )
                                    .children(mode_menu.map(|m| div().absolute().top_0().left_0().child(m))),
                            )
                            .child(div().flex_1())
                            .child(
                                div()
                                    .relative()
                                    .child(quiet_button("model", model_label, model_open, 150.).on_click(toggle_menu(Menu::Model, cx)))
                                    .children(model_menu.map(|m| div().absolute().top_0().right_0().child(m))),
                            )
                            .when(!efforts.is_empty(), |d| {
                                d.child(
                                    div()
                                        .relative()
                                        .child(
                                            quiet_button(
                                                "effort",
                                                effort_value.as_deref().map(|e| effort_label(agent, e)).unwrap_or_else(|| "Medium".into()),
                                                effort_open,
                                                90.,
                                            )
                                            .when(ultra, |d| d.text_color(hex(EMERALD)))
                                            .on_click(toggle_menu(Menu::Effort, cx)),
                                        )
                                        .children(effort_menu.map(|m| div().absolute().top_0().right_0().child(m))),
                                )
                            })
                            .child(
                                div()
                                    .id("context-ring")
                                    .p(px(4.))
                                    .rounded(px(6.))
                                    .hover(|s| s.bg(white_a(0.05)))
                                    .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(ring_tip.clone()).build(window, cx))
                                    .child(ui::ring(fraction)),
                            )
                            .child(
                                div()
                                    .id("send")
                                    .size(px(26.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .bg(hsla(0., 0., 1., 1.))
                                    .hover(|s| s.bg(hex(0xe6e6e6)))
                                    .cursor_pointer()
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        if running {
                                            this.stop(&StopTurn, window, cx);
                                        } else {
                                            this.submit(window, cx);
                                        }
                                    }))
                                    .child(if running { ph("stop", 14., hex(0x0a0a0a)) } else { ph("send", 16., hex(0x0a0a0a)) }),
                            ),
                    ),
            )
    }
}

fn close_menu_listener(cx: &mut Context<StudioApp>) -> impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static + use<> {
    let app = cx.weak_entity();
    move |_: &MouseDownEvent, _: &mut Window, cx: &mut App| {
        let _ = app.update(cx, |this, cx| {
            this.menu = None;
            cx.notify();
        });
    }
}

fn toggle_menu(which: Menu, cx: &mut Context<StudioApp>) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static + use<> {
    let app = cx.weak_entity();
    move |_: &ClickEvent, _: &mut Window, cx: &mut App| {
        let _ = app.update(cx, |this, cx| {
            this.menu = if this.menu.as_ref() == Some(&which) { None } else { Some(which.clone()) };
            cx.notify();
        });
    }
}

/// A reply or prompt as the panel renders it: file chips open the file,
/// fenced code gets a copy button.
fn markdown_view(view: &Entity<gpui_kit::component::text::TextViewState>) -> TextView {
    TextView::new(view)
        .on_link_click(|url, _, _, cx| match url.strip_prefix(chat::OPEN_SCHEME) {
            Some(path) => cx.open_with_system(std::path::Path::new(path)),
            None => cx.open_url(url),
        })
        .code_block_actions(|block, _, _| {
            let code = block.code();
            let id = SharedString::from(format!("copy-code-{}", block.span.map(|s| s.start).unwrap_or(0)));
            div()
                .id(id)
                .size(px(22.))
                .mt(px(-1.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .bg(hex(BG_SECONDARY))
                .cursor_pointer()
                .hover(|s| s.bg(white_a(0.1)))
                .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(code.to_string())))
                .child(ph("copy", 12., hex(TEXT_TERTIARY)))
        })
}

/// The top-level gap: 14px between rows, 8px between blocks of one reply.
fn row_gap(items: &[Item], ix: usize) -> f32 {
    if ix == 0 {
        return 0.;
    }
    let body = |item: &Item| matches!(item, Item::Assistant { .. } | Item::Tools(_));
    match (items.get(ix - 1), items.get(ix)) {
        (Some(prev), Some(cur)) if body(prev) && body(cur) => 8.,
        (Some(prev), None) if body(prev) => 8.,
        _ => 14.,
    }
}

fn render_row(
    entity: &Entity<ChatSession>,
    other_answer: &Entity<InputState>,
    ix: usize,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let chat = entity.read(cx);
    if ix >= chat.items.len() {
        return match chat.tail() {
            Tail::Permission => {
                let gap = if chat.items.is_empty() { 0. } else { 14. };
                div().pt(px(gap)).child(render_permission(entity, other_answer, window, cx)).into_any_element()
            }
            Tail::Running => {
                let gap = if chat.items.is_empty() { 0. } else { row_gap(&chat.items, ix) };
                div().pt(px(gap)).child(render_running(chat)).into_any_element()
            }
            Tail::None => div().into_any_element(),
        };
    }
    let gap = row_gap(&chat.items, ix);
    let cwd = chat.meta.cwd.clone();
    let body: AnyElement = match &chat.items[ix] {
        Item::User { view } => div()
            .w_full()
            .px(px(12.))
            .py(px(8.))
            .rounded(px(10.))
            .bg(hex(BG_SECONDARY))
            .border_1()
            .border_color(white_a(0.08))
            .text_size(px(14.))
            .line_height(relative(1.55))
            .text_color(hex(TEXT_PRIMARY))
            .child(markdown_view(view))
            .into_any_element(),
        Item::Assistant { view, footer, .. } => {
            let group: SharedString = format!("reply-{ix}").into();
            let footer = footer.as_ref().map(|f| (f.at, f.copy.clone()));
            div()
                .group(group.clone())
                .w_full()
                .flex()
                .flex_col()
                .text_size(px(14.))
                .line_height(relative(1.55))
                .text_color(hex(TEXT_PRIMARY))
                .child(markdown_view(view).stream_fade(true))
                .when_some(footer, |d, (at, copy)| {
                    d.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(2.))
                            .pt(px(4.))
                            .invisible()
                            .group_hover(group.clone(), |s| s.visible())
                            .child(
                                div()
                                    .id(("copy-reply", ix))
                                    .size(px(24.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(|s| s.bg(hex(BG_SECONDARY)))
                                    .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(copy.clone())))
                                    .child(ph("copy", 13., hex(TEXT_TERTIARY))),
                            )
                            .child(div().ml(px(2.)).text_size(px(11.)).text_color(hex(TEXT_TERTIARY)).child(ui::rel_time(at))),
                    )
                })
                .into_any_element()
        }
        Item::Notice { warn, text } => div()
            .w_full()
            .flex()
            .justify_center()
            .child(
                div()
                    .max_w(relative(0.9))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(12.))
                    .py(px(5.))
                    .rounded(px(8.))
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .when(*warn, |d| d.bg(rgba_hex(YELLOW, 0.12)).text_color(hex(WARN_SOFT)).child(ph("warning", 13., hex(WARN_SOFT))))
                    .when(!*warn, |d| d.bg(hex(BG_CARD)).text_color(hex(TEXT_SECONDARY)))
                    .child(text.clone()),
            )
            .into_any_element(),
        Item::Tools(group) => {
            let sentence = group_sentence(&group.tools);
            let expanded = group.expanded;
            let failed = group.tools.iter().any(|t| t.status == ToolStatus::Error);
            let head_group: SharedString = format!("tools-{ix}").into();
            let toggle = entity.clone();
            let cards: Vec<AnyElement> = if expanded {
                group.tools.iter().enumerate().map(|(t, tool)| render_tool(entity, ix, t, tool, cwd.as_deref())).collect()
            } else {
                Vec::new()
            };
            let caret_color = if failed { hex(RED) } else { hex(TEXT_TERTIARY) };
            let caret_hover = if failed { hex(RED) } else { hex(TEXT_PRIMARY) };
            div()
                .w_full()
                .flex()
                .flex_col()
                .child(
                    div()
                        .id(("tool-group", ix))
                        .group(head_group.clone())
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .py(px(3.))
                        .cursor_pointer()
                        .on_click(move |_, _, cx| toggle.update(cx, |c, cx| c.toggle_group(ix, cx)))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.))
                                .text_color(hex(TEXT_SECONDARY))
                                .group_hover(head_group.clone(), |s| s.text_color(hex(TEXT_PRIMARY)))
                                .child(sentence),
                        )
                        .child(caret(expanded, caret_color).group_hover(head_group.clone(), move |s| s.text_color(caret_hover))),
                )
                .children(cards)
                .into_any_element()
        }
    };
    div().w_full().pt(px(gap)).child(body).into_any_element()
}

fn code_block(id: impl Into<ElementId>, text: String, error: bool) -> Stateful<Div> {
    div()
        .id(id)
        .w_full()
        .max_h(px(320.))
        .overflow_y_scroll()
        .px(px(12.))
        .py(px(10.))
        .rounded(px(8.))
        .bg(if error { rgba_hex(RED, 0.1) } else { white_a(0.05) })
        .font_family("Lizard Mono")
        .text_size(px(12.))
        .line_height(relative(1.5))
        .text_color(hex(TEXT_PRIMARY))
        .child(text)
}

fn diff_block(id: impl Into<ElementId>, lines: Vec<(char, String)>) -> Stateful<Div> {
    div()
        .id(id)
        .w_full()
        .max_h(px(320.))
        .overflow_y_scroll()
        .py(px(8.))
        .rounded(px(8.))
        .bg(white_a(0.05))
        .font_family("Lizard Mono")
        .text_size(px(12.))
        .line_height(relative(1.5))
        .children(lines.into_iter().map(|(sign, line)| {
            let (bg, fg) = match sign {
                '+' => (rgba_hex(EMERALD, 0.12), hex(0xb9f6ca)),
                '-' => (rgba_hex(RED, 0.12), hex(0xffcdd2)),
                _ => (hsla(0., 0., 0., 0.), hex(TEXT_SECONDARY)),
            };
            div().px(px(10.)).bg(bg).text_color(fg).child(format!("{sign} {line}"))
        }))
}

fn render_detail(id: SharedString, detail: Detail) -> AnyElement {
    match detail {
        Detail::Command(command) => div()
            .relative()
            .child(code_block(id, command, false).pl(px(24.)))
            .child(
                div()
                    .absolute()
                    .left(px(12.))
                    .top(px(10.))
                    .font_family("Lizard Mono")
                    .text_size(px(12.))
                    .line_height(relative(1.5))
                    .text_color(hex(TEXT_TERTIARY))
                    .child("$"),
            )
            .into_any_element(),
        Detail::Code(code) => code_block(id, code, false).into_any_element(),
        Detail::Diff(lines) => diff_block(id, lines).into_any_element(),
    }
}

fn render_tool(entity: &Entity<ChatSession>, ix: usize, t: usize, tool: &chat::ToolCall, cwd: Option<&str>) -> AnyElement {
    let label = tool_label(&tool.name, &tool.input, cwd);
    let toggle_color = match tool.status {
        ToolStatus::Running => hex(TEXT_TERTIARY),
        ToolStatus::Done => hex(EMERALD),
        ToolStatus::Error => hex(RED),
    };
    let expanded = tool.expanded;
    let detail = if expanded { tool_detail(tool) } else { None };
    let output = if expanded { tool.output.clone().filter(|o| !o.trim().is_empty()) } else { None };
    let error = tool.status == ToolStatus::Error;
    let toggle = entity.clone();
    let key = ix * 1000 + t;
    let caret_el = caret(expanded, toggle_color);
    let caret_el = if tool.status == ToolStatus::Running {
        pulse(("tool-pulse", key), 1000, caret_el)
    } else {
        caret_el.into_any_element()
    };
    div()
        .w_full()
        .flex()
        .flex_col()
        .child(
            div()
                .id(("tool", key))
                .w_full()
                .flex()
                .items_center()
                .gap(px(8.))
                .py(px(3.))
                .cursor_pointer()
                .on_click(move |_, _, cx| toggle.update(cx, |c, cx| c.toggle_tool(ix, t, cx)))
                .child(ph(label.icon, 14., hex(TEXT_SECONDARY)))
                .child(div().flex_none().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).child(label.name))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_family("Lizard Mono")
                        .text_size(px(11.5))
                        .text_color(hex(TEXT_SECONDARY))
                        .child(label.summary),
                )
                .child(caret_el),
        )
        .when_some(detail, |d, detail| {
            d.child(div().pl(px(22.)).py(px(2.)).child(render_detail(format!("tool-detail-{key}").into(), detail)))
        })
        .when_some(output, |d, output| {
            let lines = output.lines().count();
            let long = lines > 16 || output.len() > 1400;
            d.child(
                div()
                    .pl(px(22.))
                    .pb(px(4.))
                    .when(long, |d| {
                        d.child(div().py(px(4.)).text_size(px(11.)).text_color(hex(TEXT_TERTIARY)).child(format!("Output · {lines} lines")))
                    })
                    .child(code_block(("tool-out", key), output, error)),
            )
        })
        .into_any_element()
}

fn render_running(chat: &ChatSession) -> AnyElement {
    let secs = chat.turn_started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0);
    let tokens = chat.turn_tokens + chat.msg_tokens;
    let mut parts = vec![ui::elapsed(secs)];
    if tokens > 0 {
        parts.push(format!("↓ {} tokens", ui::thousands(tokens)));
    }
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .text_size(px(12.))
        .child(pulse("running-spark", 1400, lizard(15., hex(EMERALD))))
        .child(
            div()
                .id("running-word")
                .text_color(hex(EMERALD))
                .font_weight(FontWeight::MEDIUM)
                .cursor_pointer()
                .on_click(|_, _, cx| cx.open_url("https://lizard.build"))
                .child(chat.status_word),
        )
        .child(div().text_color(hex(TEXT_TERTIARY)).child(format!("({})", parts.join(" · "))))
        .into_any_element()
}

fn perm_option(id: (&'static str, usize), number: usize, label: String, desc: Option<String>, selected: bool, picked: bool) -> Stateful<Div> {
    div()
        .id(id)
        .flex()
        .items_start()
        .gap(px(7.))
        .px(px(8.))
        .py(px(6.))
        .rounded(px(7.))
        .cursor_pointer()
        .text_size(px(12.5))
        .line_height(relative(1.4))
        .text_color(if selected { hex(TEXT_PRIMARY) } else { hex(TEXT_SECONDARY) })
        .when(selected, |d| d.bg(white_a(0.06)))
        .child(div().w(px(10.)).flex_none().child(if selected { "❯" } else { "" }))
        .child(
            div()
                .flex_none()
                .text_color(if selected { hex(TEXT_SECONDARY) } else { hex(TEXT_TERTIARY) })
                .child(format!("{number}.")),
        )
        .child(div().flex_1().flex().flex_col().child(label).when_some(desc, |d, desc| {
            d.child(
                div()
                    .text_size(px(11.5))
                    .text_color(if selected { hex(TEXT_SECONDARY) } else { hex(TEXT_TERTIARY) })
                    .child(desc),
            )
        }))
        .when(picked, |d| d.child(ph("check", 12., hex(EMERALD))))
}

fn render_permission(entity: &Entity<ChatSession>, other_answer: &Entity<InputState>, _window: &mut Window, cx: &mut App) -> AnyElement {
    let chat = entity.read(cx);
    let Some(perm) = chat.permissions.first() else { return div().into_any_element() };
    let agent = chat.meta.agent;
    let cwd = chat.meta.cwd.clone();
    let rid = perm.request_id.clone();

    let card = div().w_full().flex().flex_col().px(px(14.)).pt(px(12.)).pb(px(10.)).rounded(px(12.)).bg(hex(BG_CARD));

    if !perm.questions.is_empty() {
        return render_question(entity, perm, agent, other_answer, card).into_any_element();
    }

    let icon = tool_label(&perm.tool_name, &perm.input, cwd.as_deref()).icon;
    let title = permission_title(&perm.tool_name);
    let subtitle = permission_subtitle(perm, cwd.as_deref());
    let detail = permission_detail(perm);
    let options = permission_options(perm, agent);
    let hovered = perm.hovered;
    card.child(
        div()
            .flex()
            .items_center()
            .gap(px(7.))
            .child(ph(icon, 14., hex(TEXT_SECONDARY)))
            .child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).child(title)),
    )
    .when_some(subtitle, |d, s| d.child(div().mt(px(3.)).pl(px(21.)).truncate().text_size(px(11.5)).text_color(hex(TEXT_SECONDARY)).child(s)))
    .when_some(detail, |d, detail| d.child(div().mt(px(8.)).child(render_detail("perm-detail".into(), detail))))
    .child(div().mt(px(12.)).mb(px(6.)).text_size(px(13.)).font_weight(FontWeight::MEDIUM).child("Do you want to proceed?"))
    .child(div().flex().flex_col().gap(px(1.)).mx(px(-6.)).children(options.into_iter().enumerate().map(|(i, label)| {
        let entity = entity.clone();
        let hover_entity = entity.clone();
        let rid = rid.clone();
        let hover_rid = rid.clone();
        perm_option(("perm-option", i), i + 1, label, None, hovered == i, false)
            .on_hover(move |over, _, cx| {
                if *over {
                    hover_entity.update(cx, |c, cx| c.hover_option(&hover_rid, i, cx));
                }
            })
            .on_click(move |_, _, cx| {
                let choice = match i {
                    0 => PermissionChoice::Allow,
                    1 => PermissionChoice::AlwaysAllow,
                    _ => PermissionChoice::Deny,
                };
                entity.update(cx, |c, cx| c.answer_permission(&rid, choice, cx));
            })
    })))
    .into_any_element()
}

fn render_question(
    entity: &Entity<ChatSession>,
    perm: &Permission,
    agent: Agent,
    other_answer: &Entity<InputState>,
    card: Div,
) -> impl IntoElement {
    let total = perm.questions.len();
    let q = &perm.questions[perm.question_ix.min(total - 1)];
    let rid = perm.request_id.clone();
    let hovered = perm.hovered;
    let who = if agent == Agent::Codex { "ChatGPT" } else { "Claude" };
    let multi = q.multi;
    let mut options: Vec<(String, Option<String>)> = q.options.clone();
    options.push(("Other…".into(), None));
    let picked = perm.picked.clone();
    let other_open = perm.other_open || q.options.is_empty();
    let hint = if q.options.is_empty() {
        "enter confirms · esc dismisses"
    } else if multi {
        "click or 1-9 toggles · enter confirms · esc dismisses"
    } else {
        "1-9 / ↑↓ + enter selects · esc dismisses"
    };
    card.child(
        div()
            .flex()
            .items_center()
            .gap(px(7.))
            .child(ph("chat", 14., hex(TEXT_SECONDARY)))
            .child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).child(format!("{who} is asking")))
            .when(total > 1, |d| {
                d.child(div().ml_auto().text_size(px(11.)).text_color(hex(TEXT_TERTIARY)).child(format!("{} of {total}", perm.question_ix + 1)))
            }),
    )
    .when_some(q.header.clone(), |d, header| {
        d.child(
            div().flex().child(
                div()
                    .mt(px(10.))
                    .px(px(8.))
                    .py(px(1.))
                    .rounded_full()
                    .border_1()
                    .border_color(white_a(0.08))
                    .text_size(px(10.5))
                    .text_color(hex(TEXT_SECONDARY))
                    .child(header),
            ),
        )
    })
    .child(div().mt(px(8.)).mb(px(10.)).text_size(px(13.)).font_weight(FontWeight::MEDIUM).line_height(relative(1.45)).child(q.question.clone()))
    .when(!q.options.is_empty(), |d| {
        d.child(div().flex().flex_col().gap(px(1.)).mx(px(-6.)).children(options.into_iter().enumerate().map(|(i, (label, desc))| {
            let entity = entity.clone();
            let hover_entity = entity.clone();
            let rid = rid.clone();
            let hover_rid = rid.clone();
            perm_option(("ask-option", i), i + 1, label, desc, hovered == i, picked.contains(&i))
                .on_hover(move |over, _, cx| {
                    if *over {
                        hover_entity.update(cx, |c, cx| c.hover_option(&hover_rid, i, cx));
                    }
                })
                .on_click(move |_, _, cx| entity.update(cx, |c, cx| c.pick_option(&rid, i, cx)))
        })))
    })
    .when(other_open, |d| {
        d.child(
            div()
                .mt(px(6.))
                .px(px(9.))
                .py(px(6.))
                .rounded(px(7.))
                .bg(hex(BG_PRIMARY))
                .border_1()
                .border_color(hex(BORDER))
                .child(Input::new(other_answer).appearance(false).xsmall().text_size(px(12.5)).h(px(18.))),
        )
    })
    .child(div().mt(px(8.)).text_size(px(10.5)).text_color(hex(TEXT_TERTIARY)).child(hint))
}

impl Render for StudioApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let blocked = !host_installed()
            || self.host_state.claude_ok == Some(false)
            || self.host_state.version.map_or(false, |v| v < MIN_HOST_VERSION);
        let viewport = window.viewport_size();
        let sidebar_w = (viewport.width * 0.35).min(px(400.));
        let sidebar_open = self.sidebar_open;
        let main: AnyElement = if blocked { self.render_onboarding(cx) } else { self.render_chat(cx) };
        let sidebar = sidebar_open.then(|| self.render_sidebar(sidebar_w, cx));

        let title = self.chats[self.active].read(cx).meta.title.clone();
        let titlebar = div()
            .id("titlebar")
            .h(px(TITLEBAR_H))
            .w_full()
            .flex_none()
            .relative()
            .flex()
            .items_center()
            .justify_center()
            .bg(hex(BG_SECONDARY))
            .on_mouse_down(MouseButton::Left, |event, window, _| {
                if event.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            .child(
                div()
                    .max_w(relative(0.5))
                    .truncate()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hex(TEXT_TERTIARY))
                    .child(title),
            )
            .when(!sidebar_open, |d| {
                d.child(
                    div().absolute().top_0().left(px(76.)).child(
                        icon_button("show-sidebar", "side-panel", 16.)
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.sidebar_open = true;
                                cx.notify();
                            })),
                    ),
                )
            });

        div()
            .id("studio")
            .key_context("Studio")
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::on_new_chat))
            .on_action(cx.listener(Self::stop))
            .capture_key_down(cx.listener(Self::on_key))
            .size_full()
            .flex()
            .flex_col()
            .bg(hex(BG_PRIMARY))
            .text_color(hex(TEXT_PRIMARY))
            .font_family("Lizard Inter")
            .text_size(px(14.))
            // CSS `line-height: normal` for Inter (ascender + descender).
            .line_height(relative(1.21))
            .child(titlebar)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .children(sidebar)
                    .child(div().flex_1().min_w_0().h_full().flex().child(main)),
            )
    }
}
