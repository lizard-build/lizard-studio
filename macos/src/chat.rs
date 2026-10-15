//! One chat: what it shows and how host messages change it.
//!
//! The host speaks Claude Code's stream-json for both agents (the Codex host
//! translates), so one reader serves both. The rules follow the Chrome panel:
//! text streams in from `text_delta`, tool cards come from the final
//! `assistant` message and fold into groups ("Ran 3 commands"), `tool_result`
//! blocks fill the cards, anything a subagent says stays out of the main chat,
//! and a live `user` event never draws a bubble — the app draws it at send time.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::time::Instant;

use gpui_kit::component::text::TextViewState;
use gpui_kit::*;
use serde_json::{Value, json};

use crate::cloud::{self, CloudMsg};
use crate::host::HostLink;
use crate::store::{Agent, SavedChat, new_chat_id, now_ms};

pub const DEFAULT_TITLE: &str = "New chat";

/// Wraps context the user did not type, so a transcript replay can strip it
/// again. Same markers as the panel's CTX_MARK_START / CTX_MARK_END.
const CTX_START: &str = "\u{200B}\u{200B}\u{200B}";
const CTX_END: &str = "\u{200C}\u{200C}\u{200C}";

const APP_CONTEXT: &str = "[Lizard Studio for macOS: no browser is attached to this chat, so the browser_* tools will fail. Work with files and the shell instead.]";

/// The running indicator's call to action, one per silent phase (chat.js STATUS_WORDS).
const STATUS_WORDS: &[&str] = &[
    "Deploy on Lizard", "Ship it on Lizard", "Build on Lizard", "Launch on Lizard",
    "Run it on Lizard", "Host on Lizard", "Serve on Lizard", "Scale on Lizard",
    "Push to Lizard", "Release on Lizard", "Publish on Lizard", "Start on Lizard",
    "Spin up on Lizard", "Roll out on Lizard", "Boot it on Lizard", "Move to Lizard",
    "Grow on Lizard", "Provision on Lizard", "Wire up on Lizard", "Go live on Lizard",
    "Try Lizard", "Fire it up on Lizard", "Get live on Lizard",
];

fn random_word() -> &'static str {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as usize)
        .unwrap_or(0);
    STATUS_WORDS[(nanos / 1000) % STATUS_WORDS.len()]
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    Running,
    Done,
    Error,
}

pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub status: ToolStatus,
    pub output: Option<String>,
    pub expanded: bool,
}

pub struct ToolGroup {
    pub tools: Vec<ToolCall>,
    pub expanded: bool,
}

pub struct Footer {
    pub at: u64,
    pub copy: String,
}

pub enum Item {
    User { view: Entity<TextViewState> },
    Assistant { msg_id: Option<String>, text: String, view: Entity<TextViewState>, footer: Option<Footer> },
    Tools(ToolGroup),
    Notice { warn: bool, text: SharedString },
}

pub struct Question {
    pub header: Option<String>,
    pub question: String,
    pub options: Vec<(String, Option<String>)>,
    pub multi: bool,
}

pub struct Permission {
    pub request_id: String,
    pub tool_name: String,
    pub input: Value,
    pub suggestions: Option<Value>,
    pub description: Option<String>,
    pub questions: Vec<Question>,
    pub question_ix: usize,
    pub answers: BTreeMap<String, String>,
    pub picked: Vec<usize>,
    pub hovered: usize,
    pub other_open: bool,
}

#[derive(Default)]
struct History {
    requested: bool,
    loading: bool,
    request_id: Option<String>,
    parts: Vec<Option<String>>,
    next_cursor: Option<Value>,
}

pub enum ChatEvent {
    /// Title, session id or settings changed: save the chat.
    Changed,
    /// A turn ended (for the sidebar's "finished while away" dot).
    TurnEnded,
    /// The agent reported its working folder.
    CwdChanged,
}

impl EventEmitter<ChatEvent> for ChatSession {}

pub struct ChatSession {
    pub meta: SavedChat,
    pub items: Vec<Item>,
    pub list: ListState,
    pub started: bool,
    pub running: bool,
    pub unseen: bool,
    pub turn_started_at: Option<Instant>,
    pub turn_tokens: u64,
    pub msg_tokens: u64,
    pub ctx_tokens: u64,
    /// Codex reports its own context window per turn.
    pub ctx_window: Option<u64>,
    /// The folder the agent reports in `system/init`; it follows a `cd` into
    /// a worktree, and the git bar reads it.
    pub live_cwd: Option<String>,
    pub tasks: Vec<Task>,
    ctx_base: u64,
    pub status_word: &'static str,
    pub permissions: Vec<Permission>,
    pub queued: VecDeque<String>,
    pub restart_pending: bool,
    pub commands: Vec<String>,
    host: Rc<HostLink>,
    history: History,
    streamed_msg_ids: HashSet<String>,
    stream_blocks: HashMap<u64, usize>,
    tool_index: HashMap<String, (usize, usize)>,
    last_stream_id: Option<String>,
    tools_open: bool,
    tail_rows: usize,
    turn_first_item: usize,
    context_sent: bool,
}

impl ChatSession {
    pub fn new(meta: SavedChat, host: Rc<HostLink>, cx: &mut Context<Self>) -> Self {
        let live_cwd = meta.work_cwd.clone();
        let list = ListState::new(0, ListAlignment::Top, px(400.));
        list.set_follow_mode(FollowMode::Tail);
        // Reaching the top pages in older history, like the panel does.
        let weak = cx.weak_entity();
        list.set_scroll_handler(move |event, _, cx| {
            if event.is_scrolled && event.visible_range.start == 0 {
                let weak = weak.clone();
                cx.defer(move |cx| {
                    let _ = weak.update(cx, |chat, cx| chat.load_earlier(cx));
                });
            }
        });
        Self {
            meta,
            items: Vec::new(),
            list,
            started: false,
            running: false,
            unseen: false,
            turn_started_at: None,
            turn_tokens: 0,
            msg_tokens: 0,
            ctx_tokens: 0,
            ctx_base: 0,
            ctx_window: None,
            live_cwd,
            tasks: Vec::new(),
            status_word: "Deploy on Lizard",
            permissions: Vec::new(),
            queued: VecDeque::new(),
            restart_pending: false,
            commands: Vec::new(),
            host,
            history: History::default(),
            streamed_msg_ids: HashSet::new(),
            stream_blocks: HashMap::new(),
            tool_index: HashMap::new(),
            last_stream_id: None,
            tools_open: false,
            tail_rows: 0,
            turn_first_item: 0,
            context_sent: false,
        }
    }

    pub fn fresh(agent: Agent, cwd: Option<String>, host: Rc<HostLink>, cx: &mut Context<Self>) -> Self {
        let now = now_ms();
        let meta = SavedChat {
            id: new_chat_id(),
            title: DEFAULT_TITLE.into(),
            agent,
            cwd,
            session_id: None,
            model: None,
            effort: default_effort(agent).map(str::to_string),
            permission_mode: Some(default_mode(agent).into()),
            created_at: now,
            updated_at: now,
            bookmark: None,
            open: true,
            title_edited: false,
            work_cwd: None,
            cloud: false,
            sandbox_id: None,
            conversation_id: None,
        };
        Self::new(meta, host, cx)
    }

    pub fn id(&self) -> &str {
        &self.meta.id
    }

    pub fn is_blank(&self) -> bool {
        self.items.is_empty() && self.meta.session_id.is_none()
    }


    pub fn history_loading(&self) -> bool {
        self.history.loading
    }

    /// Rows the message list shows after the items: the permission card while
    /// one waits, else the running indicator while a turn runs.
    pub fn tail(&self) -> Tail {
        if !self.permissions.is_empty() {
            Tail::Permission
        } else if self.running {
            Tail::Running
        } else {
            Tail::None
        }
    }

    pub fn row_count(&self) -> usize {
        self.items.len() + self.tail_rows
    }

    fn send(&self, mut message: Value) {
        if let Some(obj) = message.as_object_mut() {
            obj.insert("id".into(), json!(self.meta.id));
            obj.insert("agent".into(), json!(self.meta.agent.wire()));
        }
        self.host.send(message);
    }

    fn touch(&mut self, cx: &mut Context<Self>) {
        self.meta.updated_at = now_ms();
        cx.emit(ChatEvent::Changed);
    }

    pub fn set_title(&mut self, title: String, cx: &mut Context<Self>) {
        let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
        if title.is_empty() {
            return;
        }
        self.meta.title = title.chars().take(200).collect();
        self.meta.title_edited = true;
        self.touch(cx);
        cx.notify();
    }

    pub fn set_bookmark(&mut self, color: Option<String>, cx: &mut Context<Self>) {
        self.meta.bookmark = color;
        cx.emit(ChatEvent::Changed);
        cx.notify();
    }

    // ---- rows ----------------------------------------------------------------

    /// Keep the virtual list's row count equal to items plus the tail row.
    fn sync_rows(&mut self, cx: &mut Context<Self>) {
        let tail = usize::from(self.tail() != Tail::None);
        if tail != self.tail_rows {
            let start = self.items.len();
            let old = self.tail_rows;
            self.tail_rows = tail;
            self.list.splice(start..start + old, tail);
        }
        cx.notify();
    }

    fn push(&mut self, item: Item, cx: &mut Context<Self>) -> usize {
        if matches!(item, Item::User { .. }) {
            self.tools_open = false;
        }
        let ix = self.items.len();
        self.items.push(item);
        self.list.splice(ix..ix, 1);
        cx.notify();
        ix
    }

    fn notice(&mut self, warn: bool, text: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.tools_open = false;
        self.push(Item::Notice { warn, text: text.into() }, cx);
    }

    /// The folder paths resolve against: the agent's live one, else the chat's.
    pub fn work_cwd(&self) -> Option<String> {
        if self.meta.cloud {
            return None;
        }
        self.live_cwd.clone().or_else(|| self.meta.cwd.clone())
    }

    fn assistant_item(&mut self, msg_id: Option<String>, text: &str, cx: &mut Context<Self>) -> usize {
        self.tools_open = false;
        let shown = link_paths(text, self.work_cwd().as_deref());
        let view = cx.new(|cx| TextViewState::markdown(&shown, cx).selectable(true));
        self.push(Item::Assistant { msg_id, text: text.to_string(), view, footer: None }, cx)
    }

    fn user_item(&mut self, text: &str, cx: &mut Context<Self>) {
        let shown = link_paths(text, self.work_cwd().as_deref());
        let view = cx.new(|cx| TextViewState::markdown(&shown, cx).selectable(true));
        self.push(Item::User { view }, cx);
    }

    /// A tool call joins the open group, or starts one.
    fn push_tool(&mut self, tool: ToolCall, cx: &mut Context<Self>) {
        let id = tool.id.clone();
        if self.tools_open {
            let ix = self.items.len().saturating_sub(1);
            if let Some(Item::Tools(group)) = self.items.last_mut() {
                group.tools.push(tool);
                self.tool_index.insert(id, (ix, group.tools.len() - 1));
                self.list.remeasure_items(ix..ix + 1);
                cx.notify();
                return;
            }
        }
        // LIZARD_STUDIO_EXPAND opens every group, for visual checks.
        let expanded = std::env::var_os("LIZARD_STUDIO_EXPAND").is_some();
        let ix = self.push(Item::Tools(ToolGroup { tools: vec![tool], expanded }), cx);
        self.tool_index.insert(id, (ix, 0));
        self.tools_open = true;
    }

    pub fn toggle_group(&mut self, ix: usize, cx: &mut Context<Self>) {
        if let Some(Item::Tools(group)) = self.items.get_mut(ix) {
            group.expanded = !group.expanded;
            cx.notify();
        }
    }

    pub fn toggle_tool(&mut self, ix: usize, tool: usize, cx: &mut Context<Self>) {
        if let Some(Item::Tools(group)) = self.items.get_mut(ix) {
            if let Some(t) = group.tools.get_mut(tool) {
                t.expanded = !t.expanded;
                cx.notify();
            }
        }
    }

    // ---- lifecycle -----------------------------------------------------------

    fn start_message(&self) -> Value {
        json!({
            "type": "start",
            "cwd": self.meta.cwd,
            "model": self.meta.model,
            "effort": self.meta.effort,
            "permissionMode": self.meta.permission_mode.clone().unwrap_or_else(|| default_mode(self.meta.agent).into()),
            "resume": self.meta.session_id,
        })
    }

    fn ensure_started(&mut self) {
        if self.started {
            return;
        }
        self.send(self.start_message());
        self.started = true;
        self.context_sent = false;
    }

    /// Ask the host which slash commands and skills this folder offers.
    pub fn request_commands(&self) {
        if !self.meta.cloud && self.meta.cwd.is_some() && self.meta.agent == Agent::Claude {
            self.send(json!({ "type": "listSkills", "cwd": self.meta.cwd }));
        }
    }

    /// Send what the user typed, or queue it behind the running turn.
    pub fn submit(&mut self, text: String, images: Vec<Value>, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        if text.is_empty() && images.is_empty() {
            return;
        }
        if self.meta.cwd.is_none() && !self.meta.cloud {
            self.notice(true, "Choose a project folder first.", cx);
            return;
        }
        if self.running {
            self.queued.push_back(text);
            cx.notify();
            return;
        }
        self.deliver(text, images, cx);
    }

    fn deliver(&mut self, text: String, images: Vec<Value>, cx: &mut Context<Self>) {
        if self.meta.cloud {
            return self.deliver_cloud(text, cx);
        }
        self.ensure_started();
        if self.meta.title == DEFAULT_TITLE && !self.meta.title_edited {
            let title: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if !title.is_empty() {
                self.meta.title = title.chars().take(40).collect();
            }
        }
        let shown = if images.is_empty() { text.clone() } else { format!("{text}\n\n_{} image(s) attached_", images.len()) };
        self.user_item(&shown, cx);
        let wire = if self.context_sent || text.starts_with('/') {
            text
        } else {
            self.context_sent = true;
            format!("{CTX_START}{APP_CONTEXT}{CTX_END}\n\n{text}")
        };
        self.send(json!({ "type": "prompt", "text": wire, "images": images }));
        self.begin_turn();
        self.touch(cx);
        self.sync_rows(cx);
    }

    fn begin_turn(&mut self) {
        self.running = true;
        self.turn_started_at = Some(Instant::now());
        self.turn_tokens = 0;
        self.msg_tokens = 0;
        self.status_word = random_word();
        self.turn_first_item = self.items.len();
    }

    pub fn interrupt(&mut self, cx: &mut Context<Self>) {
        if !self.running {
            return;
        }
        self.queued.clear();
        if self.meta.cloud {
            if let Some(sandbox) = self.meta.sandbox_id.clone() {
                cloud::interrupt(sandbox, self.meta.conversation_id.clone());
            }
            cx.notify();
            return;
        }
        self.send(json!({ "type": "interrupt" }));
        cx.notify();
    }

    pub fn close(&mut self) {
        if self.started {
            self.send(json!({ "type": "close" }));
            self.started = false;
        }
    }

    /// Apply a model, effort or mode change. A live process is restarted onto
    /// the same session; a running turn finishes first.
    pub fn set_settings(
        &mut self,
        model: Option<Option<String>>,
        effort: Option<Option<String>>,
        mode: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if let Some(model) = model {
            self.meta.model = model;
        }
        if let Some(effort) = effort {
            self.meta.effort = effort;
        }
        if let Some(mode) = mode {
            self.meta.permission_mode = Some(mode);
        }
        if self.started {
            if self.running {
                self.restart_pending = true;
            } else {
                self.restart();
            }
        }
        self.touch(cx);
        cx.notify();
    }

    fn restart(&mut self) {
        self.restart_pending = false;
        self.send(json!({
            "type": "restartSession",
            "model": self.meta.model,
            "effort": self.meta.effort,
            "permissionMode": self.meta.permission_mode,
        }));
    }

    fn end_turn(&mut self, cx: &mut Context<Self>) {
        self.running = false;
        self.turn_started_at = None;
        self.permissions.clear();
        self.stream_blocks.clear();
        self.tools_open = false;
        for item in &mut self.items {
            if let Item::Tools(group) = item {
                for tool in &mut group.tools {
                    if tool.status == ToolStatus::Running {
                        tool.status = ToolStatus::Error;
                    }
                }
            }
        }
        self.place_footer(self.turn_first_item, now_ms());
        if self.restart_pending {
            self.restart();
        }
        cx.emit(ChatEvent::TurnEnded);
        self.sync_rows(cx);
        if let Some(next) = self.queued.pop_front() {
            self.deliver(next, Vec::new(), cx);
        }
    }

    /// The copy-and-time footer sits under the last prose of a turn.
    fn place_footer(&mut self, from: usize, at: u64) {
        let mut copy = Vec::new();
        let mut last = None;
        for (ix, item) in self.items.iter().enumerate().skip(from) {
            if let Item::Assistant { text, .. } = item {
                copy.push(text.clone());
                last = Some(ix);
            }
        }
        if let Some(ix) = last {
            if let Some(Item::Assistant { footer, .. }) = self.items.get_mut(ix) {
                *footer = Some(Footer { at, copy: copy.join("\n\n") });
            }
        }
    }

    // ---- host messages -------------------------------------------------------

    pub fn on_host_message(&mut self, msg: &Value, cx: &mut Context<Self>) {
        let kind = msg.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "event" => {
                if let Some(data) = msg.get("data") {
                    self.on_event(data, cx);
                }
            }
            "started" => {
                self.started = true;
                if let Some(mode) = msg.get("permissionMode").and_then(Value::as_str) {
                    if self.meta.permission_mode.as_deref() != Some(mode) {
                        self.meta.permission_mode = Some(mode.to_string());
                        self.touch(cx);
                    }
                }
                cx.notify();
            }
            "commands" => {
                let mut list: Vec<String> = Vec::new();
                for key in ["list", "skills"] {
                    if let Some(items) = msg.get(key).and_then(Value::as_array) {
                        for item in items {
                            let name = item
                                .as_str()
                                .map(str::to_string)
                                .or_else(|| item.get("name").and_then(Value::as_str).map(str::to_string));
                            if let Some(name) = name {
                                let name = name.trim_start_matches('/').to_string();
                                if !list.contains(&name) {
                                    list.push(name);
                                }
                            }
                        }
                    }
                }
                self.commands = list;
                cx.notify();
            }
            "permission" => {
                self.permissions.push(permission_from(msg));
                self.sync_rows(cx);
            }
            "permissionCancel" => {
                let rid = msg.get("requestId").and_then(Value::as_str).unwrap_or("");
                self.permissions.retain(|p| p.request_id != rid);
                self.sync_rows(cx);
            }
            "interrupted" => {
                if self.running {
                    self.end_turn(cx);
                }
            }
            "exit" => {
                self.started = false;
                if self.running {
                    let code = msg.get("code").and_then(Value::as_i64).unwrap_or(-1);
                    self.notice(true, format!("{} exited (code {code}).", self.meta.agent.label()), cx);
                    self.end_turn(cx);
                }
                cx.notify();
            }
            "error" => {
                let text = msg.get("message").and_then(Value::as_str).unwrap_or("Something went wrong.");
                self.notice(true, text.to_string(), cx);
                if self.running && !self.started {
                    self.end_turn(cx);
                }
            }
            "needsFolder" => {
                self.started = false;
                self.notice(true, "Choose a project folder to start a session.", cx);
                if self.running {
                    self.end_turn(cx);
                }
            }
            "contextUsage" => {
                self.ctx_window = msg.get("window").and_then(Value::as_u64).or(self.ctx_window);
                if let Some(usage) = msg.get("usage").filter(|u| !u.is_null()) {
                    self.note_ctx_usage(Some(usage));
                }
                cx.notify();
            }
            "transcript" => self.on_transcript(msg, cx),
            "transcriptPart" => self.on_transcript_part(msg, cx),
            _ => {}
        }
    }

    /// The agent's process went away (helper crash or update).
    pub fn on_agent_exit(&mut self, cx: &mut Context<Self>) {
        self.started = false;
        if self.running {
            self.notice(true, format!("The {} helper stopped.", self.meta.agent.label()), cx);
            self.end_turn(cx);
        }
        cx.notify();
    }

    /// The daemon still runs this chat from an earlier connection.
    pub fn restore_from_daemon(&mut self, started: bool, running: bool, cx: &mut Context<Self>) {
        self.started = started;
        if running && !self.running {
            self.begin_turn();
        }
        self.running = running;
        self.sync_rows(cx);
    }

    fn note_ctx_usage(&mut self, usage: Option<&Value>) {
        let Some(usage) = usage else { return };
        let n = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        let base = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        if base == 0 {
            return;
        }
        self.ctx_base = base;
        self.ctx_tokens = base + n("output_tokens");
    }

    fn on_event(&mut self, data: &Value, cx: &mut Context<Self>) {
        if data.get("parent_tool_use_id").map_or(false, |v| !v.is_null()) {
            return;
        }
        match data.get("type").and_then(Value::as_str).unwrap_or("") {
            "system" => {
                if data.get("subtype").and_then(Value::as_str) == Some("init") {
                    self.started = true;
                    if let Some(sid) = data.get("session_id").and_then(Value::as_str) {
                        if self.meta.session_id.as_deref() != Some(sid) {
                            self.meta.session_id = Some(sid.to_string());
                            // Live output already covers this session.
                            self.history.requested = true;
                            self.touch(cx);
                        }
                    }
                    if let Some(list) = data.get("slash_commands").and_then(Value::as_array) {
                        self.commands = list.iter().filter_map(Value::as_str).map(str::to_string).collect();
                    }
                    if let Some(cwd) = data.get("cwd").and_then(Value::as_str) {
                        let cwd = cwd.trim_end_matches('/').to_string();
                        if self.live_cwd.as_deref() != Some(cwd.as_str()) {
                            self.live_cwd = Some(cwd.clone());
                            self.meta.work_cwd = Some(cwd);
                            self.touch(cx);
                            cx.emit(ChatEvent::CwdChanged);
                        }
                    }
                }
            }
            "stream_event" => {
                if !self.running {
                    self.begin_turn();
                    self.sync_rows(cx);
                }
                if let Some(event) = data.get("event") {
                    self.on_stream_event(event, cx);
                }
            }
            "assistant" => {
                if let Some(message) = data.get("message") {
                    self.note_ctx_usage(message.get("usage"));
                    self.on_assistant(message, cx);
                }
            }
            "user" => {
                match data.pointer("/message/content") {
                    Some(Value::Array(content)) => {
                        for block in content {
                            match block.get("type").and_then(Value::as_str) {
                                Some("tool_result") => self.fill_tool_result(block, cx),
                                Some("text") => {
                                    scan_task_notice(&mut self.tasks, block.get("text").and_then(Value::as_str).unwrap_or(""))
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Value::String(text)) => scan_task_notice(&mut self.tasks, text),
                    _ => {}
                }
                cx.notify();
            }
            "result" => {
                let is_error = data.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                if is_error {
                    let text = data
                        .get("result")
                        .and_then(Value::as_str)
                        .filter(|t| !t.trim().is_empty() && *t != "Stopped.")
                        .map(str::to_string);
                    if let Some(text) = text {
                        self.notice(true, text, cx);
                    }
                }
                self.end_turn(cx);
            }
            _ => {}
        }
    }

    fn on_stream_event(&mut self, event: &Value, cx: &mut Context<Self>) {
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "message_start" => {
                self.last_stream_id = event.pointer("/message/id").and_then(Value::as_str).map(str::to_string);
                if let Some(id) = &self.last_stream_id {
                    self.streamed_msg_ids.insert(id.clone());
                }
                self.note_ctx_usage(event.pointer("/message/usage"));
                self.stream_blocks.clear();
                self.msg_tokens = 0;
                self.status_word = random_word();
                cx.notify();
            }
            "content_block_start" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                if event.pointer("/content_block/type").and_then(Value::as_str) == Some("text") {
                    let ix = self.assistant_item(self.last_stream_id.clone(), "", cx);
                    self.stream_blocks.insert(index, ix);
                }
            }
            "content_block_delta" => {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                let Some(delta) = event.get("delta") else { return };
                if delta.get("type").and_then(Value::as_str) != Some("text_delta") {
                    return;
                }
                let Some(chunk) = delta.get("text").and_then(Value::as_str) else { return };
                let ix = match self.stream_blocks.get(&index) {
                    Some(ix) => *ix,
                    None => {
                        let ix = self.assistant_item(self.last_stream_id.clone(), "", cx);
                        self.stream_blocks.insert(index, ix);
                        ix
                    }
                };
                if let Some(Item::Assistant { text, view, .. }) = self.items.get_mut(ix) {
                    text.push_str(chunk);
                    let chunk = chunk.to_string();
                    view.update(cx, |v, cx| v.push_str(&chunk, cx));
                }
                cx.notify();
            }
            "message_delta" => {
                if let Some(out) = event.pointer("/usage/output_tokens").and_then(Value::as_u64) {
                    self.msg_tokens = out;
                    if self.ctx_base > 0 {
                        self.ctx_tokens = self.ctx_base + out;
                    }
                    cx.notify();
                }
            }
            "message_stop" => {
                self.turn_tokens += self.msg_tokens;
                self.msg_tokens = 0;
                cx.notify();
            }
            _ => {}
        }
    }

    fn on_assistant(&mut self, message: &Value, cx: &mut Context<Self>) {
        let id = message.get("id").and_then(Value::as_str).map(str::to_string);
        let streamed = id.as_ref().map_or(false, |id| self.streamed_msg_ids.contains(id));
        let Some(content) = message.get("content").and_then(Value::as_array) else { return };
        for block in content {
            match block.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                    if text.trim().is_empty() || text == "No response requested." {
                        continue;
                    }
                    if streamed {
                        self.repaint_streamed(id.as_deref(), text, cx);
                    } else {
                        self.assistant_item(id.clone(), text, cx);
                    }
                }
                "tool_use" => {
                    let tool_id = block.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    if self.tool_index.contains_key(&tool_id) {
                        continue;
                    }
                    note_task_start(&mut self.tasks, block);
                    self.push_tool(
                        ToolCall {
                            id: tool_id,
                            name: block.get("name").and_then(Value::as_str).unwrap_or("Tool").to_string(),
                            input: block.get("input").cloned().unwrap_or(Value::Null),
                            status: ToolStatus::Running,
                            output: None,
                            expanded: false,
                        },
                        cx,
                    );
                }
                _ => {}
            }
        }
    }

    /// Codex can stream less than the final text; the canonical copy wins.
    fn repaint_streamed(&mut self, msg_id: Option<&str>, canonical: &str, cx: &mut Context<Self>) {
        let Some(msg_id) = msg_id else { return };
        let cwd = self.work_cwd();
        let found = self.items.iter_mut().rev().find_map(|item| match item {
            Item::Assistant { msg_id: Some(id), text, view, .. } if id == msg_id => Some((text, view)),
            _ => None,
        });
        match found {
            Some((text, view)) => {
                if canonical.len() >= text.len() && canonical.starts_with(text.trim_end()) {
                    *text = canonical.to_string();
                }
                let shown = link_paths(text, cwd.as_deref());
                if shown != *text || canonical.len() >= text.len() {
                    view.update(cx, |v, cx| v.set_text(&shown, cx));
                }
            }
            None => {
                self.assistant_item(Some(msg_id.to_string()), canonical, cx);
            }
        }
    }

    fn fill_tool_result(&mut self, block: &Value, cx: &mut Context<Self>) {
        let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else { return };
        let Some(&(ix, t)) = self.tool_index.get(id) else { return };
        if let Some(Item::Tools(group)) = self.items.get_mut(ix) {
            if let Some(tool) = group.tools.get_mut(t) {
                let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                tool.status = if is_error { ToolStatus::Error } else { ToolStatus::Done };
                tool.output = Some(result_text(block.get("content")));
                note_task_result(&mut self.tasks, &tool.id, tool.output.as_deref().unwrap_or(""), is_error);
            }
        }
        cx.notify();
    }

    // ---- cloud chats ---------------------------------------------------------
    // The agent runs in a Lizard sandbox (cloud.rs). What the chat shows is kept
    // in a local log, since the CLI can't read a finished conversation back.

    fn deliver_cloud(&mut self, text: String, cx: &mut Context<Self>) {
        if self.meta.title == DEFAULT_TITLE && !self.meta.title_edited {
            let title: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if !title.is_empty() {
                self.meta.title = title.chars().take(40).collect();
            }
        }
        self.history.requested = true;
        self.user_item(&text, cx);
        cloud::append_log(&self.meta.id, &json!({ "kind": "user", "text": text, "at": now_ms() }));
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<CloudMsg>();
        cloud::run_prompt(
            cloud::PromptJob {
                sandbox: self.meta.sandbox_id.clone(),
                agent: self.meta.agent.wire(),
                conversation: self.meta.conversation_id.clone(),
                model: self.meta.model.clone(),
                effort: self.meta.effort.clone(),
                text,
            },
            tx,
        );
        cx.spawn(async move |this, cx| {
            use futures::StreamExt as _;
            while let Some(msg) = rx.next().await {
                if this.update(cx, |chat, cx| chat.on_cloud_msg(msg, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        self.begin_turn();
        self.touch(cx);
        self.sync_rows(cx);
    }

    fn on_cloud_msg(&mut self, msg: CloudMsg, cx: &mut Context<Self>) {
        match msg {
            CloudMsg::SandboxReady(id) => {
                if self.meta.sandbox_id.as_deref() != Some(id.as_str()) {
                    self.meta.sandbox_id = Some(id);
                    self.meta.conversation_id = None;
                    self.touch(cx);
                }
            }
            CloudMsg::Note(text) => {
                cloud::append_log(&self.meta.id, &json!({ "kind": "note", "text": text }));
                self.notice(false, text, cx);
            }
            CloudMsg::Event(event) => {
                cloud::append_log(&self.meta.id, &json!({ "kind": "event", "event": event }));
                self.on_cloud_event(&event, true, cx);
            }
            CloudMsg::Done { error } => {
                if let Some(error) = error {
                    cloud::append_log(&self.meta.id, &json!({ "kind": "error", "text": error }));
                    self.notice(true, error, cx);
                }
                if self.running {
                    self.end_turn(cx);
                }
            }
        }
    }

    fn on_cloud_event(&mut self, event: &Value, live: bool, cx: &mut Context<Self>) {
        let s = |key: &str| event.get(key).and_then(Value::as_str).map(str::to_string);
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "prompt" => {
                if let Some(conversation) = s("conversationId") {
                    if live && self.meta.conversation_id.as_deref() != Some(conversation.as_str()) {
                        self.meta.conversation_id = Some(conversation);
                        self.touch(cx);
                    }
                }
            }
            "running" => {
                self.status_word = random_word();
                cx.notify();
            }
            "response" => {
                if let Some(text) = s("text").filter(|t| !t.trim().is_empty()) {
                    self.assistant_item(None, text.trim_end(), cx);
                }
            }
            "tool_call" => {
                let (name, input) = cloud::tool_from_event(event);
                let id = s("itemId").unwrap_or_else(|| format!("cloud-{}", self.items.len()));
                if !self.tool_index.contains_key(&id) {
                    self.push_tool(
                        ToolCall { id, name, input, status: if live { ToolStatus::Running } else { ToolStatus::Done }, output: None, expanded: false },
                        cx,
                    );
                }
            }
            "tool_result" => {
                let Some(id) = s("itemId") else { return };
                let Some(&(ix, t)) = self.tool_index.get(&id) else { return };
                let failed = event.get("exitCode").and_then(Value::as_i64).map_or(false, |c| c != 0)
                    || matches!(s("status").as_deref(), Some("failed" | "error"));
                if let Some(Item::Tools(group)) = self.items.get_mut(ix) {
                    if let Some(tool) = group.tools.get_mut(t) {
                        tool.status = if failed { ToolStatus::Error } else { ToolStatus::Done };
                        tool.output = event.get("output").map(|o| o.as_str().map(str::to_string).unwrap_or_else(|| o.to_string()));
                    }
                }
                cx.notify();
            }
            "finished" => {
                if let Some(usage) = event.get("usage") {
                    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
                    self.turn_tokens = n("output_tokens");
                    self.ctx_tokens = n("input_tokens") + n("output_tokens");
                }
                if live {
                    self.end_turn(cx);
                }
            }
            "failed" => {
                let text = s("error").or_else(|| s("text")).or_else(|| s("message")).unwrap_or_else(|| "The agent stopped with an error.".into());
                self.notice(true, text, cx);
                if live {
                    self.end_turn(cx);
                }
            }
            _ => {}
        }
    }

    /// Rebuild a cloud chat from its local log.
    fn replay_cloud(&mut self, cx: &mut Context<Self>) {
        let entries = cloud::read_log(&self.meta.id);
        let mut turn_start = self.items.len();
        let mut last_at = 0;
        for entry in entries {
            match entry.get("kind").and_then(Value::as_str).unwrap_or("") {
                "user" => {
                    self.place_footer(turn_start, last_at);
                    let text = entry.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                    self.user_item(&text, cx);
                    turn_start = self.items.len();
                    last_at = entry.get("at").and_then(Value::as_u64).unwrap_or(last_at);
                }
                "note" => {
                    let text = entry.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                    self.notice(false, text, cx);
                }
                "error" => {
                    let text = entry.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                    self.notice(true, text, cx);
                }
                "event" => {
                    if let Some(event) = entry.get("event") {
                        if let Some(at) = event.get("ts").and_then(Value::as_str).and_then(parse_iso_ms) {
                            last_at = at;
                        }
                        self.on_cloud_event(event, false, cx);
                    }
                }
                _ => {}
            }
        }
        self.place_footer(turn_start, last_at);
        self.tools_open = false;
        cx.notify();
    }

    // ---- permissions ---------------------------------------------------------

    pub fn answer_permission(&mut self, request_id: &str, choice: PermissionChoice, cx: &mut Context<Self>) {
        let Some(pos) = self.permissions.iter().position(|p| p.request_id == request_id) else { return };
        let perm = self.permissions.remove(pos);
        let mut reply = json!({ "type": "permissionResult", "requestId": perm.request_id });
        let obj = reply.as_object_mut().unwrap();
        match choice {
            PermissionChoice::Allow => {
                obj.insert("behavior".into(), json!("allow"));
            }
            PermissionChoice::AlwaysAllow => {
                obj.insert("behavior".into(), json!("allow"));
                let updated = if matches!(perm.tool_name.as_str(), "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
                    json!([{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }])
                } else {
                    match perm.suggestions.as_ref().and_then(Value::as_array) {
                        Some(list) if !list.is_empty() => Value::Array(list.clone()),
                        _ => json!([{ "type": "addRules", "rules": [{ "toolName": perm.tool_name }],
                                      "behavior": "allow", "destination": "session" }]),
                    }
                };
                obj.insert("updatedPermissions".into(), updated);
            }
            PermissionChoice::Deny => {
                obj.insert("behavior".into(), json!("deny"));
                obj.insert("message".into(), json!(DENY_MESSAGE));
                obj.insert("interrupt".into(), json!(true));
            }
            PermissionChoice::Answers(answers) => {
                obj.insert("behavior".into(), json!("allow"));
                obj.insert("updatedInput".into(), json!({ "answers": answers }));
            }
        }
        self.send(reply);
        self.sync_rows(cx);
    }

    pub fn hover_option(&mut self, request_id: &str, option: usize, cx: &mut Context<Self>) {
        if let Some(perm) = self.permissions.iter_mut().find(|p| p.request_id == request_id) {
            if perm.hovered != option {
                perm.hovered = option;
                cx.notify();
            }
        }
    }

    /// Pick an option of the current question; a single-choice question moves
    /// on at once, the last one sends every answer.
    pub fn pick_option(&mut self, request_id: &str, option: usize, cx: &mut Context<Self>) {
        let Some(perm) = self.permissions.iter_mut().find(|p| p.request_id == request_id) else { return };
        let Some(question) = perm.questions.get(perm.question_ix) else { return };
        if option >= question.options.len() {
            perm.other_open = true;
            cx.notify();
            return;
        }
        if question.multi {
            if let Some(pos) = perm.picked.iter().position(|&i| i == option) {
                perm.picked.remove(pos);
            } else {
                perm.picked.push(option);
            }
            cx.notify();
            return;
        }
        let label = question.options[option].0.clone();
        self.record_answer(request_id, label, cx);
    }

    /// Confirm a multi-choice question, or answer with free text.
    pub fn confirm_question(&mut self, request_id: &str, free_text: Option<String>, cx: &mut Context<Self>) {
        let Some(perm) = self.permissions.iter_mut().find(|p| p.request_id == request_id) else { return };
        let Some(question) = perm.questions.get(perm.question_ix) else { return };
        let mut parts: Vec<String> = perm
            .picked
            .iter()
            .filter_map(|&i| question.options.get(i).map(|o| o.0.clone()))
            .collect();
        if let Some(text) = free_text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
            parts.push(text);
        }
        if parts.is_empty() {
            return;
        }
        self.record_answer(request_id, parts.join(", "), cx);
    }

    fn record_answer(&mut self, request_id: &str, answer: String, cx: &mut Context<Self>) {
        let Some(perm) = self.permissions.iter_mut().find(|p| p.request_id == request_id) else { return };
        if let Some(question) = perm.questions.get(perm.question_ix) {
            perm.answers.insert(question.question.clone(), answer);
        }
        perm.picked.clear();
        perm.other_open = false;
        perm.hovered = 0;
        perm.question_ix += 1;
        if perm.question_ix >= perm.questions.len() {
            let answers = perm.answers.clone();
            self.answer_permission(request_id, PermissionChoice::Answers(answers), cx);
        } else {
            cx.notify();
        }
    }

    // ---- history -------------------------------------------------------------

    /// Ask the host for the saved conversation, newest page first.
    pub fn load_history(&mut self, cx: &mut Context<Self>) {
        if self.history.requested {
            return;
        }
        self.history.requested = true;
        if self.meta.cloud {
            return self.replay_cloud(cx);
        }
        self.request_history_page(None, cx);
    }

    pub fn load_earlier(&mut self, cx: &mut Context<Self>) {
        if self.history.loading {
            return;
        }
        if let Some(cursor) = self.history.next_cursor.take() {
            self.request_history_page(Some(cursor), cx);
        }
    }

    fn request_history_page(&mut self, cursor: Option<Value>, cx: &mut Context<Self>) {
        let Some(session_id) = self.meta.session_id.clone() else { return };
        let request_id = format!("h-{}", now_ms());
        self.history.loading = true;
        self.history.request_id = Some(request_id.clone());
        self.history.parts.clear();
        let mut message = json!({
            "type": "loadTranscript",
            "sessionId": session_id,
            "cwd": self.meta.cwd,
            "requestId": request_id,
            "paged": true,
        });
        if let Some(cursor) = cursor {
            message["cursor"] = cursor;
        }
        if self.meta.agent == Agent::Codex {
            message["excludeTurnIds"] = json!([]);
        }
        self.send(message);
        cx.notify();
    }

    fn on_transcript_part(&mut self, msg: &Value, cx: &mut Context<Self>) {
        if msg.get("requestId").and_then(Value::as_str) != self.history.request_id.as_deref() {
            return;
        }
        let index = msg.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let total = msg.get("total").and_then(Value::as_u64).unwrap_or(1) as usize;
        if self.history.parts.len() != total {
            self.history.parts = vec![None; total];
        }
        if let Some(slot) = self.history.parts.get_mut(index) {
            *slot = msg.get("text").and_then(Value::as_str).map(str::to_string);
        }
        if self.history.parts.iter().all(Option::is_some) {
            let joined: String = self.history.parts.drain(..).map(Option::unwrap).collect();
            let joined = restore_surrogates(&joined);
            match serde_json::from_str::<Value>(&joined) {
                Ok(full) => self.on_transcript(&full, cx),
                Err(err) => {
                    if std::env::var_os("LIZARD_STUDIO_DEBUG").is_some() {
                        let col = err.column();
                        eprintln!("transcript parse failed: {err} near {:?}", joined.lines().nth(err.line().saturating_sub(1)).map(|l| l.chars().skip(col.saturating_sub(60)).take(120).collect::<String>()));
                    }
                    self.history.loading = false;
                    cx.notify();
                }
            }
        }
    }

    fn on_transcript(&mut self, msg: &Value, cx: &mut Context<Self>) {
        if msg.get("requestId").and_then(Value::as_str) != self.history.request_id.as_deref() {
            return;
        }
        self.history.loading = false;
        self.history.request_id = None;
        self.history.next_cursor = msg.get("nextCursor").filter(|c| !c.is_null()).cloned();
        if msg.get("missing").and_then(Value::as_bool).unwrap_or(false) {
            cx.notify();
            return;
        }
        let events = msg.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
        let items = self.items_from_transcript(&events, cx);
        let count = items.len();
        if count == 0 {
            cx.notify();
            return;
        }
        // Prepend: shift every index the live path remembers.
        let mut merged = items;
        merged.append(&mut self.items);
        self.items = merged;
        self.reindex_tools();
        for ix in self.stream_blocks.values_mut() {
            *ix += count;
        }
        self.turn_first_item += count;
        self.list.splice(0..0, count);
        cx.notify();
    }

    fn reindex_tools(&mut self) {
        self.tool_index.clear();
        for (ix, item) in self.items.iter().enumerate() {
            if let Item::Tools(group) = item {
                for (t, tool) in group.tools.iter().enumerate() {
                    self.tool_index.insert(tool.id.clone(), (ix, t));
                }
            }
        }
    }

    fn items_from_transcript(&mut self, events: &[Value], cx: &mut Context<Self>) -> Vec<Item> {
        let mut items: Vec<Item> = Vec::new();
        let mut tools: HashMap<String, (usize, usize)> = HashMap::new();
        let mut open_group = false;
        let mut turn_start = 0usize;
        let mut last_at = 0u64;
        let cwd = self.work_cwd();

        fn footer(items: &mut [Item], from: usize, at: u64) {
            let mut copy = Vec::new();
            let mut last = None;
            for (ix, item) in items.iter().enumerate().skip(from) {
                if let Item::Assistant { text, .. } = item {
                    copy.push(text.clone());
                    last = Some(ix);
                }
            }
            if let Some(ix) = last {
                if let Item::Assistant { footer, .. } = &mut items[ix] {
                    *footer = Some(Footer { at, copy: copy.join("\n\n") });
                }
            }
        }

        for event in events {
            let message = event.get("message");
            let at = event.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or(last_at);
            match event.get("type").and_then(Value::as_str).unwrap_or("") {
                "user" => {
                    let content = message.and_then(|m| m.get("content"));
                    let mut texts = Vec::new();
                    match content {
                        Some(Value::String(s)) => texts.push(s.clone()),
                        Some(Value::Array(blocks)) => {
                            for block in blocks {
                                match block.get("type").and_then(Value::as_str).unwrap_or("") {
                                    "text" => texts.push(block.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
                                    "image" => texts.push("_image attached_".into()),
                                    "tool_result" => {
                                        let id = block.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                                        if let Some(&(ix, t)) = tools.get(id) {
                                            if let Some(Item::Tools(group)) = items.get_mut(ix) {
                                                if let Some(tool) = group.tools.get_mut(t) {
                                                    let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                                                    tool.status = if is_error { ToolStatus::Error } else { ToolStatus::Done };
                                                    tool.output = Some(result_text(block.get("content")));
                                                    let output = tool.output.clone().unwrap_or_default();
                                                    note_task_result(&mut self.tasks, id, &output, is_error);
                                                }
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        _ => {}
                    }
                    let raw = texts.join("\n");
                    scan_task_notice(&mut self.tasks, &raw);
                    let text = clean_user_text(&raw);
                    if !text.is_empty() && !text.starts_with("/usage") {
                        footer(&mut items, turn_start, last_at);
                        let shown = link_paths(&text, cwd.as_deref());
                        let view = cx.new(|cx| TextViewState::markdown(&shown, cx).selectable(true));
                        items.push(Item::User { view });
                        open_group = false;
                        turn_start = items.len();
                    }
                }
                "assistant" => {
                    let msg_id = message.and_then(|m| m.get("id")).and_then(Value::as_str).map(str::to_string);
                    if let Some(usage) = message.and_then(|m| m.get("usage")) {
                        self.note_ctx_usage(Some(usage));
                    }
                    let Some(blocks) = message.and_then(|m| m.get("content")).and_then(Value::as_array) else { continue };
                    for block in blocks {
                        match block.get("type").and_then(Value::as_str).unwrap_or("") {
                            "text" => {
                                let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                                if text.trim().is_empty() || text == "No response requested." {
                                    continue;
                                }
                                let shown = link_paths(text, cwd.as_deref());
                                let view = cx.new(|cx| TextViewState::markdown(&shown, cx).selectable(true));
                                items.push(Item::Assistant { msg_id: msg_id.clone(), text: text.to_string(), view, footer: None });
                                open_group = false;
                            }
                            "tool_use" => {
                                let id = block.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                                if tools.contains_key(&id) {
                                    continue;
                                }
                                note_task_start(&mut self.tasks, block);
                                let tool = ToolCall {
                                    id: id.clone(),
                                    name: block.get("name").and_then(Value::as_str).unwrap_or("Tool").to_string(),
                                    input: block.get("input").cloned().unwrap_or(Value::Null),
                                    status: ToolStatus::Done,
                                    output: None,
                                    expanded: false,
                                };
                                if open_group {
                                    let last = items.len().saturating_sub(1);
                                    if let Some(Item::Tools(group)) = items.last_mut() {
                                        group.tools.push(tool);
                                        tools.insert(id, (last, group.tools.len() - 1));
                                        continue;
                                    }
                                }
                                items.push(Item::Tools(ToolGroup { tools: vec![tool], expanded: false }));
                                tools.insert(id, (items.len() - 1, 0));
                                open_group = true;
                            }
                            _ => {}
                        }
                    }
                    last_at = at;
                }
                "local_command" => {
                    let text = event.get("content").and_then(Value::as_str).unwrap_or("");
                    let text = strip_tags(text);
                    if !text.trim().is_empty() {
                        items.push(Item::Notice { warn: false, text: text.trim().to_string().into() });
                        open_group = false;
                    }
                }
                _ => {}
            }
        }
        // The newest turn may still be running; only a reply that ended in
        // prose gets its footer.
        if matches!(items.last(), Some(Item::Assistant { .. })) {
            footer(&mut items, turn_start, last_at);
        }
        items
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tail {
    None,
    Running,
    Permission,
}

pub enum PermissionChoice {
    Allow,
    AlwaysAllow,
    Deny,
    Answers(BTreeMap<String, String>),
}

const DENY_MESSAGE: &str = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

pub fn default_mode(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => "auto",
        Agent::Codex => "workspace",
    }
}

pub fn default_effort(agent: Agent) -> Option<&'static str> {
    match agent {
        Agent::Claude => Some("medium"),
        Agent::Codex => None,
    }
}

fn permission_from(msg: &Value) -> Permission {
    let tool_name = msg.get("toolName").and_then(Value::as_str).unwrap_or("Tool").to_string();
    let input = msg.get("input").cloned().unwrap_or(Value::Null);
    let questions = if tool_name == "AskUserQuestion" {
        input
            .get("questions")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|q| Question {
                        header: q.get("header").and_then(Value::as_str).map(str::to_string),
                        question: q.get("question").and_then(Value::as_str).unwrap_or("").to_string(),
                        options: q
                            .get("options")
                            .and_then(Value::as_array)
                            .map(|opts| {
                                opts.iter()
                                    .map(|o| {
                                        (
                                            o.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
                                            o.get("description").and_then(Value::as_str).map(str::to_string),
                                        )
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                        multi: q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Permission {
        request_id: msg.get("requestId").and_then(Value::as_str).unwrap_or("").to_string(),
        tool_name,
        input,
        suggestions: msg.get("suggestions").cloned().filter(|s| !s.is_null()),
        description: msg.get("description").and_then(Value::as_str).map(str::to_string),
        questions,
        question_ix: 0,
        answers: BTreeMap::new(),
        picked: Vec::new(),
        hovered: 0,
        other_open: false,
    }
}

/// Milliseconds since the epoch for an ISO-8601 UTC timestamp like
/// `2026-10-14T19:02:11.123Z`.
fn parse_iso_ms(text: &str) -> Option<u64> {
    let (date, time) = text.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.trim_end_matches('Z');
    let mut t = time.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let min: i64 = t.next()?.parse().ok()?;
    let sec: f64 = t.next()?.parse().ok()?;
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + min * 60;
    Some((secs as f64 * 1000.0 + sec * 1000.0) as u64)
}

/// Join the surrogate halves `host::parse_frame` marked back into characters.
fn restore_surrogates(text: &str) -> String {
    use crate::host::SURROGATE_MARK;
    if !text.contains(SURROGATE_MARK) {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let unit_at = |i: usize| -> Option<u16> {
        if chars.get(i) != Some(&SURROGATE_MARK) || i + 5 > chars.len() {
            return None;
        }
        u16::from_str_radix(&chars[i + 1..i + 5].iter().collect::<String>(), 16).ok()
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if let Some(high) = unit_at(i) {
            if let Some(low) = unit_at(i + 5) {
                if let Some(Ok(ch)) = char::decode_utf16([high, low]).next() {
                    out.push(ch);
                    i += 10;
                    continue;
                }
            }
            out.push(char::REPLACEMENT_CHARACTER);
            i += 5;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

pub fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                Some("text") => b.get("text").and_then(Value::as_str).map(str::to_string),
                Some("image") => Some("[image]".into()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// What the user typed, without the context the panel or this app added and
/// without the synthetic turns the CLI writes into the transcript.
pub fn clean_user_text(text: &str) -> String {
    let mut out = text.to_string();
    while let Some(start) = out.find(CTX_START) {
        match out[start..].find(CTX_END) {
            Some(end) => {
                let stop = start + end + CTX_END.len();
                let rest = out[stop..].trim_start_matches('\n').to_string();
                out = format!("{}{}", &out[..start], rest);
            }
            None => break,
        }
    }
    for tag in ["task-notification", "system-reminder", "local-command-stdout", "local-command-stderr", "local-command-caveat"] {
        out = strip_tag_blocks(&out, tag);
    }
    if let Some(name) = tag_value(&out, "command-name") {
        let args = tag_value(&out, "command-args").unwrap_or_default();
        let name = if name.starts_with('/') { name } else { format!("/{name}") };
        out = if args.trim().is_empty() { name } else { format!("{name} {}", args.trim()) };
    }
    out.trim().to_string()
}

fn strip_tag_blocks(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = text.to_string();
    while let Some(start) = out.find(&open) {
        match out[start..].find(&close) {
            Some(end) => {
                let stop = start + end + close.len();
                out = format!("{}{}", &out[..start], out[stop..].trim_start_matches('\n'));
            }
            None => break,
        }
    }
    out
}

fn tag_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(text[start..end].to_string())
}

fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

// ---- tool presentation (chat.js TOOL_META, toolSummary, group sentence) -------

pub struct ToolLabel {
    pub name: String,
    pub icon: &'static str,
    pub summary: String,
}

pub fn tool_label(name: &str, input: &Value, cwd: Option<&str>) -> ToolLabel {
    let s = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let path = |key: &str| short_path(&s(key), cwd);
    let (label, icon, summary): (String, &'static str, String) = match name {
        "Bash" => ("Bash".into(), "terminal", first_line(&s("command"), 120)),
        "Read" => ("Read".into(), "file", path("file_path")),
        "Edit" | "MultiEdit" => ("Edit".into(), "edit", path("file_path")),
        "Write" => ("Write".into(), "file-plus", path("file_path")),
        "NotebookEdit" => ("Edit".into(), "edit", path("notebook_path")),
        "Glob" => ("Glob".into(), "asterisk", s("pattern")),
        "Grep" => ("Grep".into(), "search", s("pattern")),
        "WebFetch" => ("Fetch".into(), "globe", if s("url").is_empty() { s("query") } else { s("url") }),
        "WebSearch" => ("Search".into(), "search", if s("url").is_empty() { s("query") } else { s("url") }),
        "Task" | "Agent" => ("Agent".into(), "robot", s("description")),
        "TodoWrite" => ("Plan".into(), "todo", compact_json(input, 100)),
        "ToolSearch" => ("Search tools".into(), "search", compact_json(input, 100)),
        other if other.starts_with("mcp__") => (other.to_string(), "server", compact_json(input, 100)),
        other => (other.to_string(), "server", compact_json(input, 100)),
    };
    ToolLabel { name: label, icon, summary }
}

/// "Ran 2 commands, read a file": one phrase per kind, in first-seen order.
pub fn group_sentence(tools: &[ToolCall]) -> String {
    let mut order: Vec<String> = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for tool in tools {
        let key = match tool.name.as_str() {
            "Bash" => "cmd".to_string(),
            "Read" => "read".into(),
            "Edit" | "MultiEdit" | "NotebookEdit" => "edit".into(),
            "Write" => "write".into(),
            "Glob" | "Grep" | "ToolSearch" => "search".into(),
            "WebSearch" => "websearch".into(),
            "WebFetch" => "fetch".into(),
            "Task" | "Agent" => "agent".into(),
            "TodoWrite" => "plan".into(),
            "Skill" => "skill".into(),
            n if n.starts_with("mcp__") => format!("mcp:{}", n.split("__").nth(1).unwrap_or("")),
            _ => "tool".into(),
        };
        if !counts.contains_key(&key) {
            order.push(key.clone());
        }
        *counts.entry(key).or_default() += 1;
    }
    let phrases: Vec<String> = order
        .iter()
        .map(|key| {
            let n = counts[key];
            let one = n == 1;
            match key.as_str() {
                "cmd" => if one { "ran a command".into() } else { format!("ran {n} commands") },
                "read" => if one { "read a file".into() } else { format!("read {n} files") },
                "edit" => if one { "made an edit".into() } else { format!("made {n} edits") },
                "write" => if one { "wrote a file".into() } else { format!("wrote {n} files") },
                "search" => if one { "ran a search".into() } else { format!("ran {n} searches") },
                "websearch" => if one { "searched the web".into() } else { format!("searched the web {n} times") },
                "fetch" => if one { "fetched a page".into() } else { format!("fetched {n} pages") },
                "agent" => if one { "ran an agent".into() } else { format!("ran {n} agents") },
                "plan" => if one { "updated the plan".into() } else { format!("updated the plan {n} times") },
                "skill" => if one { "used a skill".into() } else { format!("used {n} skills") },
                k if k.starts_with("mcp:") => {
                    let server = k[4..].replace(['_', '-'], " ");
                    if one { format!("used {server}") } else { format!("used {server} {n} times") }
                }
                _ => if one { "used a tool".into() } else { format!("used {n} tools") },
            }
        })
        .collect();
    let mut sentence = phrases.join(", ");
    if let Some(first) = sentence.get(0..1) {
        sentence = first.to_uppercase() + &sentence[1..];
    }
    sentence
}

pub fn short_path(path: &str, cwd: Option<&str>) -> String {
    if path.is_empty() {
        return "—".into();
    }
    if let Some(cwd) = cwd {
        if let Some(rest) = path.strip_prefix(cwd) {
            return format!(".{rest}");
        }
    }
    let home = crate::host::home_dir();
    if let Some(rest) = path.strip_prefix(home.to_string_lossy().as_ref()) {
        return format!("~{rest}");
    }
    path.to_string()
}

fn first_line(text: &str, max: usize) -> String {
    truncate(text.lines().next().unwrap_or(""), max)
}

pub fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}

fn compact_json(value: &Value, max: usize) -> String {
    if value.is_null() {
        return String::new();
    }
    truncate(&value.to_string(), max)
}

pub enum Detail {
    Command(String),
    Diff(Vec<(char, String)>),
    Code(String),
}

/// What an open tool card shows above its result.
pub fn tool_detail(tool: &ToolCall) -> Option<Detail> {
    let s = |key: &str| tool.input.get(key).and_then(Value::as_str).map(str::to_string);
    match tool.name.as_str() {
        "Bash" => s("command").map(|c| Detail::Command(truncate(&c, 6000))),
        "Edit" => match (s("old_string"), s("new_string")) {
            (Some(old), Some(new)) => Some(Detail::Diff(line_diff(&old, &new))),
            _ => None,
        },
        "Write" => s("content").map(|c| Detail::Code(truncate(&c, 6000))),
        _ => None,
    }
}

pub fn line_diff(old: &str, new: &str) -> Vec<(char, String)> {
    let mut out: Vec<(char, String)> = Vec::new();
    for line in old.lines().take(200) {
        out.push(('-', line.to_string()));
    }
    for line in new.lines().take(200) {
        out.push(('+', line.to_string()));
    }
    out
}

pub fn permission_title(tool: &str) -> String {
    match tool {
        "Bash" => "Bash command".into(),
        "Edit" | "MultiEdit" => "Edit file".into(),
        "Write" => "Create file".into(),
        "Read" => "Read file".into(),
        "WebFetch" => "Fetch".into(),
        "WebSearch" => "Web search".into(),
        "Task" | "Agent" => "Launch agent".into(),
        "ExitPlanMode" => "Plan ready".into(),
        t if t.starts_with("mcp__") => "Tool use".into(),
        t => t.to_string(),
    }
}

pub fn permission_subtitle(perm: &Permission, cwd: Option<&str>) -> Option<String> {
    let s = |key: &str| perm.input.get(key).and_then(Value::as_str).map(str::to_string);
    match perm.tool_name.as_str() {
        "Edit" | "MultiEdit" | "Write" | "Read" => s("file_path").map(|p| short_path(&p, cwd)),
        "NotebookEdit" => s("notebook_path").map(|p| short_path(&p, cwd)),
        "WebFetch" | "WebSearch" => s("url").or_else(|| s("query")),
        t if t.starts_with("mcp__") => {
            let mut parts = t.splitn(3, "__").skip(1);
            Some(format!("{} · {} (MCP)", parts.next().unwrap_or(""), parts.next().unwrap_or("")))
        }
        _ => perm.description.clone(),
    }
}

pub fn permission_detail(perm: &Permission) -> Option<Detail> {
    let s = |key: &str| perm.input.get(key).and_then(Value::as_str).map(str::to_string);
    match perm.tool_name.as_str() {
        "Bash" => s("command").map(Detail::Command),
        "ExitPlanMode" => s("plan").map(|p| Detail::Code(truncate(&p, 2000))),
        "Edit" => match (s("old_string"), s("new_string")) {
            (Some(old), Some(new)) => Some(Detail::Diff(line_diff(&old, &new))),
            _ => None,
        },
        "Write" => s("content").map(|c| Detail::Code(truncate(&c, 2000))),
        _ => s("expression")
            .or_else(|| serde_json::to_string_pretty(&perm.input).ok())
            .map(|t| Detail::Code(truncate(&t, 2000))),
    }
}

pub fn permission_options(perm: &Permission, agent: Agent) -> Vec<String> {
    let always = match perm.tool_name.as_str() {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "Yes, allow all edits during this session (shift+tab)".to_string(),
        "Bash" => {
            if perm.suggestions.as_ref().and_then(Value::as_array).map_or(false, |l| !l.is_empty()) {
                "Yes, and don't ask again for similar commands this session".into()
            } else {
                "Yes, and don't ask again for Bash commands this session".into()
            }
        }
        t if t.starts_with("mcp__") => {
            format!("Yes, and don't ask again for {} this session", t.rsplit("__").next().unwrap_or(t))
        }
        t => format!("Yes, and don't ask again for {t} this session"),
    };
    let who = if agent == Agent::Codex { "ChatGPT" } else { "Claude" };
    vec!["Yes".into(), always, format!("No, and tell {who} what to do differently (esc)")]
}

// ---- background tasks (chat.js noteToolStart / scanBgNotice) ----------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    Agent,
    Shell,
    Preview,
}

pub struct Task {
    pub tool_id: String,
    pub kind: TaskKind,
    /// The shell or agent id a completion notice names.
    pub handle: Option<String>,
    pub running: bool,
}

/// A subagent, a background command or a preview server is a task.
fn note_task_start(tasks: &mut Vec<Task>, block: &Value) {
    let id = block.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
    let input = block.get("input");
    let kind = match name {
        "Task" | "Agent" => TaskKind::Agent,
        "Bash" if input.and_then(|i| i.get("run_in_background")).and_then(Value::as_bool) == Some(true) => TaskKind::Shell,
        n if n.ends_with("preview_start") => TaskKind::Preview,
        _ => return,
    };
    if tasks.iter().any(|t| t.tool_id == id) {
        return;
    }
    tasks.push(Task { tool_id: id, kind, handle: None, running: true });
}

fn note_task_result(tasks: &mut [Task], tool_id: &str, output: &str, is_error: bool) {
    let Some(task) = tasks.iter_mut().find(|t| t.tool_id == tool_id) else { return };
    match task.kind {
        // A background agent answers at once with its id and finishes later.
        TaskKind::Agent => {
            let handle = after_label(output, "agentId:");
            if !is_error && handle.is_some() && output.to_lowercase().contains("launched") {
                task.handle = handle;
            } else {
                task.running = false;
            }
        }
        TaskKind::Shell => {
            task.handle = after_label(output, "ID:").or_else(|| output.split_whitespace().find(|w| w.starts_with("bash_")).map(str::to_string));
            if is_error {
                task.running = false;
            }
        }
        TaskKind::Preview => {
            if is_error {
                task.running = false;
            }
        }
    }
}

/// The CLI's synthetic "task finished" turns end the task they name.
fn scan_task_notice(tasks: &mut [Task], text: &str) {
    if text.is_empty() || !tasks.iter().any(|t| t.running && t.handle.is_some()) {
        return;
    }
    let lower = text.to_lowercase();
    const DONE: &[&str] = &[
        "completed", "complete", "exited", "exit code", "finished", "killed", "terminated", "stopped", "no longer running",
    ];
    if !DONE.iter().any(|w| lower.contains(w)) {
        return;
    }
    for task in tasks.iter_mut().filter(|t| t.running) {
        if let Some(handle) = &task.handle {
            if mentions_id(text, handle) {
                task.running = false;
            }
        }
    }
}

fn after_label(text: &str, label: &str) -> Option<String> {
    let start = text.find(label)? + label.len();
    let id: String = text[start..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    (!id.is_empty()).then_some(id)
}

/// `id` as a whole token: "bash_1" must not match inside "bash_10".
fn mentions_id(text: &str, id: &str) -> bool {
    let is_id = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    text.match_indices(id).any(|(at, _)| {
        let before = text[..at].chars().next_back().map_or(true, |c| !is_id(c));
        let after = text[at + id.len()..].chars().next().map_or(true, |c| !is_id(c));
        before && after
    })
}

impl ChatSession {
    pub fn task_counts(&self) -> (usize, usize) {
        (self.tasks.iter().filter(|t| t.running).count(), self.tasks.len())
    }
}

// ---- file paths in inline code (render.js filePath) -------------------------

/// The link scheme a path chip carries; the click opens the file.
pub const OPEN_SCHEME: &str = "lizard-open:";

/// Turn inline code that names a file into a link, as the panel does, so it
/// shows blue and opens on click. Fenced code is left alone.
pub fn link_paths(text: &str, cwd: Option<&str>) -> String {
    if !text.contains('`') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 32);
    let mut fenced = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            out.push_str(line);
        } else if fenced || !line.contains('`') {
            out.push_str(line);
        } else {
            out.push_str(&link_line(line, cwd));
        }
    }
    out
}

fn link_line(line: &str, cwd: Option<&str>) -> String {
    let mut out = String::with_capacity(line.len() + 32);
    let mut i = 0;
    while let Some(rel) = line[i..].find('`') {
        let start = i + rel;
        let run = line[start..].chars().take_while(|c| *c == '`').count();
        if run != 1 {
            out.push_str(&line[i..start + run]);
            i = start + run;
            continue;
        }
        let Some(end_rel) = line[start + 1..].find('`') else { break };
        let end = start + 1 + end_rel;
        let code = &line[start + 1..end];
        let in_link = line[..start].ends_with('[') || line[end + 1..].starts_with(']');
        out.push_str(&line[i..start]);
        match file_path(code).filter(|_| !in_link) {
            Some(path) => {
                let target = resolve_path(&path, cwd);
                out.push_str(&format!("[`{code}`](<{OPEN_SCHEME}{target}>)"));
            }
            None => out.push_str(&line[start..=end]),
        }
        i = end + 1;
    }
    out.push_str(&line[i..]);
    out
}

/// render.js filePath: a path with a folder in it, never a command or a URL.
fn file_path(code: &str) -> Option<String> {
    let mut s = code.trim();
    // "file.ts:42:7" — the position is for an editor, not part of the name.
    if let Some((head, tail)) = s.rsplit_once(':') {
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
            s = head;
            if let Some((head, tail)) = s.rsplit_once(':') {
                if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
                    s = head;
                }
            }
        }
    }
    if s.is_empty() || s.len() > 400 {
        return None;
    }
    if s.chars().any(|c| "&<>|*?`$;()\n".contains(c)) || s.contains(" -") || s.contains("\t-") {
        return None;
    }
    if let Some(colon) = s.find("://") {
        if s[..colon].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)) && !s[..colon].is_empty() {
            return None;
        }
    }
    let rooted = s.starts_with("~/")
        || s.starts_with("./")
        || s.starts_with("../")
        || s.starts_with('/')
        || (s.len() > 2 && s.as_bytes()[1] == b':' && (s.as_bytes()[2] == b'/' || s.as_bytes()[2] == b'\\'));
    if rooted {
        return s.chars().any(|c| !"~./\\".contains(c)).then(|| s.to_string());
    }
    if s.chars().any(char::is_whitespace) {
        return None;
    }
    s.contains('/').then(|| s.to_string())
}

fn resolve_path(path: &str, cwd: Option<&str>) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        return crate::host::home_dir().join(rest).to_string_lossy().to_string();
    }
    if path.starts_with('/') {
        return path.to_string();
    }
    match cwd {
        Some(cwd) => std::path::Path::new(cwd).join(path).to_string_lossy().to_string(),
        None => path.to_string(),
    }
}
