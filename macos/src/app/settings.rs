//! Settings, as the panel's modal (chat.js renderSettings): General, one tab
//! per agent for the files the host reads and writes for it, and Models for
//! the user's own OpenAI-compatible endpoints.

use std::collections::HashMap;
use std::time::Duration;

use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Map, Value, json};

use super::{MIN_HOST_VERSION, StudioApp, TITLEBAR_H, icon_button};
use crate::chat::CustomModels;
use crate::store::{Agent, CustomModel, now_ms};
use crate::theme::*;
use crate::ui::ph;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Tab {
    General,
    Claude,
    Codex,
    Models,
}

impl Tab {
    fn agent(self) -> Option<Agent> {
        match self {
            Tab::Claude => Some(Agent::Claude),
            Tab::Codex => Some(Agent::Codex),
            _ => None,
        }
    }
}

const TABS: [(Tab, &str); 4] = [(Tab::General, "General"), (Tab::Claude, "Claude"), (Tab::Codex, "ChatGPT"), (Tab::Models, "Models")];

/// One file (or view) an agent tab can show — chat.js CONFIG_META.
struct FileMeta {
    label: &'static str,
    json: bool,
    toggles: bool,
    readonly: bool,
    user_only: bool,
    blurb: &'static str,
    project: &'static str,
    user: &'static str,
    placeholder: &'static str,
}

fn files(agent: Agent) -> &'static [&'static str] {
    match agent {
        Agent::Claude => &["claudemd", "hooks", "mcp", "plugins", "skills"],
        Agent::Codex => &["agents", "hooks", "config", "skills"],
    }
}

fn meta(agent: Agent, key: &str) -> FileMeta {
    let none = FileMeta { label: "", json: false, toggles: false, readonly: false, user_only: false, blurb: "", project: "", user: "", placeholder: "" };
    match (agent, key) {
        (Agent::Claude, "claudemd") => FileMeta {
            label: "CLAUDE.md",
            blurb: "Project memory prepended to every session.",
            project: "<project>/CLAUDE.md",
            user: "~/.claude/CLAUDE.md",
            placeholder: "# Notes\n\nGuidance Claude should always follow in this project…",
            ..none
        },
        (Agent::Claude, "hooks") => FileMeta {
            label: "Hooks",
            json: true,
            blurb: "Shell commands run on events (PreToolUse, PostToolUse, SessionStart…). A JSON object keyed by event.",
            project: "<project>/.claude/settings.json → \"hooks\"",
            user: "~/.claude/settings.json → \"hooks\"",
            placeholder: "{\n  \"PostToolUse\": [\n    {\n      \"matcher\": \"Edit|Write\",\n      \"hooks\": [{ \"type\": \"command\", \"command\": \"echo edited\" }]\n    }\n  ]\n}",
            ..none
        },
        (Agent::Claude, "mcp") => FileMeta {
            label: "MCP",
            json: true,
            blurb: "Model Context Protocol servers, keyed by name. Servers needing OAuth login can't be authorized from here yet.",
            project: "<project>/.mcp.json → \"mcpServers\"",
            user: "~/.claude.json → \"mcpServers\"",
            placeholder: "{\n  \"playwright\": {\n    \"command\": \"npx\",\n    \"args\": [\"-y\", \"@playwright/mcp@latest\"]\n  }\n}",
            ..none
        },
        (Agent::Claude, "plugins") => FileMeta {
            label: "Plugins",
            json: true,
            toggles: true,
            blurb: "Enable or disable installed plugins.",
            project: "<project>/.claude/settings.json → \"enabledPlugins\"",
            user: "~/.claude/settings.json → \"enabledPlugins\"",
            ..none
        },
        (Agent::Claude, "skills") => FileMeta {
            label: "Skills",
            readonly: true,
            blurb: "Skills available to Claude in this project, discovered from ~/.claude/skills, the project's .claude/skills, and installed plugins. Edit them at their source files.",
            ..none
        },
        (Agent::Codex, "skills") => FileMeta {
            label: "Skills",
            readonly: true,
            blurb: "Skills available to ChatGPT in this project. Edit them at their source files.",
            ..none
        },
        (Agent::Codex, "agents") => FileMeta {
            label: "AGENTS.md",
            blurb: "Project memory ChatGPT reads at the start of every session.",
            project: "<project>/AGENTS.md",
            user: "~/.codex/AGENTS.md",
            placeholder: "# Notes\n\nGuidance ChatGPT should always follow in this project…",
            ..none
        },
        (Agent::Codex, "hooks") => FileMeta {
            label: "Hooks",
            json: true,
            blurb: "Shell commands ChatGPT runs on events. Unlike Claude's, this is the whole file rather than a section of one.",
            project: "<project>/.codex/hooks.json",
            user: "~/.codex/hooks.json",
            placeholder: "{\n  \"hooks\": []\n}",
            ..none
        },
        (Agent::Codex, "config") => FileMeta {
            label: "Config",
            user_only: true,
            blurb: "Everything else ChatGPT reads — default model, sandbox, and the MCP servers it starts.",
            user: "~/.codex/config.toml",
            placeholder: "model = \"gpt-5.6-terra\"\n\n[mcp_servers.playwright]\ncommand = \"npx\"\nargs = [\"-y\", \"@playwright/mcp@latest\"]\n",
            ..none
        },
        _ => none,
    }
}

/// (agent, file, scope, project folder) — a user-scope file has no folder.
type EditorKey = (Agent, &'static str, &'static str, Option<String>);

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Ok,
    Dim,
}

/// One file's editor (chat.js cfgEdit). Kept after the modal closes, so an
/// unsaved draft survives switching files, tabs and scopes.
#[derive(Clone)]
struct Editor {
    chat_id: String,
    loading: bool,
    saving: bool,
    read_failed: bool,
    content: String,
    original: String,
    exists: bool,
    error: Option<String>,
    status: Option<(String, Kind)>,
}

impl Editor {
    fn dirty(&self) -> bool {
        self.content != self.original
    }
}

struct Request {
    key: EditorKey,
    write: bool,
    content: String,
}

/// Skills (and Claude's plugins) the host reported for a folder.
#[derive(Clone, Default)]
pub(super) struct SkillList {
    loading: bool,
    skills: Vec<String>,
    /// (name, source) of each installed plugin.
    plugins: Vec<(String, String)>,
    error: Option<String>,
}

/// The add/edit form on the Models tab.
#[derive(Clone)]
struct Draft {
    editing: Option<String>,
    wire_api: String,
    error: Option<String>,
}

pub(super) struct SettingsUi {
    pub open: bool,
    tab: Tab,
    file_claude: &'static str,
    file_codex: &'static str,
    editor: Option<EditorKey>,
    editors: HashMap<EditorKey, Editor>,
    requests: HashMap<String, Request>,
    /// The open editor's text box, and the text to load into it next frame
    /// (setting a value needs the window).
    text: Entity<TextareaState>,
    text_key: Option<EditorKey>,
    pending: Option<(String, &'static str)>,
    filter: Entity<InputState>,
    skills: HashMap<(Agent, String), SkillList>,
    draft: Option<Draft>,
    pending_fields: Option<[String; 5]>,
    remove_armed: Option<String>,
    /// Name, base URL, model id, API key, context window.
    fields: [Entity<InputState>; 5],
    focus: FocusHandle,
}

impl SettingsUi {
    pub fn new(window: &mut Window, cx: &mut Context<StudioApp>) -> Self {
        let text = cx.new(|cx| TextareaState::new(window, cx).rows(9));
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter skills"));
        let field = |placeholder: &'static str, masked: bool, window: &mut Window, cx: &mut Context<StudioApp>| {
            cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).masked(masked))
        };
        let fields = [
            field("GPU box", false, window, cx),
            field("http://1.2.3.4:8080/v1", false, window, cx),
            field("local", false, window, cx),
            field("sent as a bearer token", true, window, cx),
            field("262144", false, window, cx),
        ];
        Self {
            open: false,
            tab: Tab::General,
            file_claude: "claudemd",
            file_codex: "agents",
            editor: None,
            editors: HashMap::new(),
            requests: HashMap::new(),
            text,
            text_key: None,
            pending: None,
            filter,
            skills: HashMap::new(),
            draft: None,
            pending_fields: None,
            remove_armed: None,
            fields,
            focus: cx.focus_handle(),
        }
    }

    pub fn subscribe(&self, window: &mut Window, cx: &mut Context<StudioApp>) -> Vec<Subscription> {
        use gpui_kit::component::input::InputEvent;
        let mut subs = vec![cx.subscribe_in(&self.text, window, |this, text, event: &InputEvent, _, cx| {
            if let InputEvent::Change = event {
                let value = text.read(cx).value().to_string();
                let s = &mut this.settings;
                if let Some(editor) = s.text_key.as_ref().filter(|k| s.editor.as_ref() == Some(*k)).and_then(|k| s.editors.get_mut(k)) {
                    if editor.content != value && !editor.loading {
                        editor.content = value;
                        editor.status = None;
                        editor.error = None;
                        cx.notify();
                    }
                }
            }
        })];
        subs.push(cx.subscribe(&self.filter, |_, _, event: &InputEvent, cx| {
            if let InputEvent::Change = event {
                cx.notify();
            }
        }));
        subs
    }
}

fn provider_id(label: &str) -> String {
    let mut slug = String::new();
    for ch in label.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(32).collect();
    format!("custom-{}", if slug.is_empty() { "model" } else { &slug })
}

impl StudioApp {
    // ---- open / close ----------------------------------------------------------

    pub(super) fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let s = &mut self.settings;
        s.open = true;
        s.tab = Tab::General;
        s.file_claude = "claudemd";
        s.file_codex = "agents";
        s.editor = None;
        s.draft = None;
        s.remove_armed = None;
        s.pending = None;
        self.menu = None;
        let filter = s.filter.clone();
        filter.update(cx, |f, cx| f.set_value("", window, cx));
        window.focus(&self.settings.focus, cx);
        cx.notify();
    }

    pub(super) fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings.open = false;
        self.settings.editor = None;
        self.composer.update(cx, |state, cx| state.focus(window, cx));
        cx.notify();
    }

    fn set_tab(&mut self, tab: Tab, cx: &mut Context<Self>) {
        if self.settings.tab == tab {
            return;
        }
        self.settings.tab = tab;
        self.settings.editor = None;
        self.settings.remove_armed = None;
        if let Some(agent) = tab.agent() {
            self.show_file(agent, self.file_of(agent), cx);
        }
        cx.notify();
    }

    #[cfg(feature = "snapshot")]
    pub(super) fn preview_settings(&mut self, tab: Option<&str>, file: Option<&str>, cx: &mut Context<Self>) {
        let tab = match tab {
            Some("claude") => Tab::Claude,
            Some("codex") => Tab::Codex,
            Some("models") => Tab::Models,
            _ => return,
        };
        self.set_tab(tab, cx);
        if let (Some(agent), Some(file)) = (tab.agent(), file) {
            if let Some(key) = files(agent).iter().find(|k| **k == file) {
                self.show_file(agent, key, cx);
            }
        }
        if tab == Tab::Models && file == Some("new") {
            self.start_draft(None, cx);
        }
    }

    fn file_of(&self, agent: Agent) -> &'static str {
        match agent {
            Agent::Claude => self.settings.file_claude,
            Agent::Codex => self.settings.file_codex,
        }
    }

    fn show_file(&mut self, agent: Agent, key: &'static str, cx: &mut Context<Self>) {
        match agent {
            Agent::Claude => self.settings.file_claude = key,
            Agent::Codex => self.settings.file_codex = key,
        }
        let m = meta(agent, key);
        if m.readonly {
            self.settings.editor = None;
            self.ensure_skills(agent, cx);
        } else {
            let scope = if m.user_only { "user" } else { self.settings.editor.as_ref().map(|k| k.2).unwrap_or("project") };
            self.load_config(agent, key, scope, cx);
        }
        cx.notify();
    }

    fn active_cwd(&self, cx: &App) -> Option<String> {
        self.chats[self.active].read(cx).meta.cwd.clone()
    }

    // ---- config files ------------------------------------------------------------

    /// chat.js loadConfig: reuse a draft in progress, else read the file.
    fn load_config(&mut self, agent: Agent, key: &'static str, scope: &'static str, cx: &mut Context<Self>) {
        let cwd = if scope == "user" { None } else { self.active_cwd(cx) };
        if cwd.is_some() {
            let chat = self.chats[self.active].clone();
            if chat.read(cx).meta.agent == agent {
                chat.update(cx, |c, cx| c.warm_up(cx));
            }
        }
        let ek: EditorKey = (agent, key, scope, cwd);
        let keep = self.settings.editors.get(&ek).is_some_and(|e| e.loading || e.saving || e.dirty());
        if !keep {
            let chat_id = self.chats[self.active].read(cx).id().to_string();
            self.settings.editors.insert(
                ek.clone(),
                Editor {
                    chat_id,
                    loading: true,
                    saving: false,
                    read_failed: false,
                    content: String::new(),
                    original: String::new(),
                    exists: false,
                    error: None,
                    status: None,
                },
            );
            self.config_request(ek.clone(), false, cx);
        }
        self.settings.editor = Some(ek.clone());
        self.sync_editor_text(cx);
        cx.notify();
    }

    /// Queue the open editor's text (and placeholder) for the text box.
    fn sync_editor_text(&mut self, _cx: &mut Context<Self>) {
        let s = &mut self.settings;
        let Some(key) = s.editor.clone() else { return };
        let Some(editor) = s.editors.get(&key) else { return };
        s.text_key = Some(key.clone());
        s.pending = Some((editor.content.clone(), meta(key.0, key.1).placeholder));
    }

    /// Apply queued text to the inputs; called at the top of render.
    pub(super) fn apply_settings_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((content, placeholder)) = self.settings.pending.take() {
            self.settings.text.update(cx, |t, cx| {
                t.set_placeholder(placeholder, window, cx);
                t.set_value(content, window, cx);
            });
        }
        if let Some(values) = self.settings.pending_fields.take() {
            for (field, value) in self.settings.fields.clone().iter().zip(values) {
                field.update(cx, |f, cx| f.set_value(value, window, cx));
            }
        }
    }

    fn config_request(&mut self, key: EditorKey, write: bool, cx: &mut Context<Self>) {
        let Some(editor) = self.settings.editors.get(&key) else { return };
        let request_id = format!("cfg-{}-{}", now_ms(), self.settings.requests.len());
        let content = editor.content.clone();
        let message = json!({
            "type": if write { "configWrite" } else { "configRead" },
            "requestId": request_id,
            "id": editor.chat_id,
            "agent": key.0.wire(),
            "key": key.1,
            "scope": key.2,
            "cwd": key.3,
            "content": if write { json!(content) } else { Value::Null },
        });
        self.settings.requests.insert(request_id.clone(), Request { key, write, content });
        if !self.host.is_connected() {
            let error = if write { "Host disconnected — not saved." } else { "Host disconnected — can't read the file." };
            self.finish_config(&json!({ "requestId": request_id, "ok": false, "error": error }), write, cx);
            return;
        }
        self.host.send(message);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(30)).await;
            let _ = this.update(cx, |this, cx| {
                if this.settings.requests.contains_key(&request_id) {
                    let msg = json!({ "requestId": request_id, "ok": false, "error": "The host didn't reply. Try again." });
                    this.finish_config(&msg, write, cx);
                }
            });
        })
        .detach();
    }

    pub(super) fn on_config_reply(&mut self, msg: &Value, cx: &mut Context<Self>) {
        let write = msg.get("type").and_then(Value::as_str) == Some("configWrite");
        self.finish_config(msg, write, cx);
    }

    /// chat.js finishConfigRequest.
    fn finish_config(&mut self, msg: &Value, write: bool, cx: &mut Context<Self>) {
        let Some(rid) = msg.get("requestId").and_then(Value::as_str) else { return };
        let Some(request) = self.settings.requests.remove(rid) else { return };
        if request.write != write {
            return;
        }
        let ok = msg.get("ok").and_then(Value::as_bool) == Some(true);
        let Some(editor) = self.settings.editors.get_mut(&request.key) else { return };
        editor.error = (!ok).then(|| msg.get("error").and_then(Value::as_str).unwrap_or("The request failed.").to_string());
        editor.status = None;
        if !write {
            editor.loading = false;
            editor.read_failed = !ok;
            if ok {
                let content = msg.get("content").and_then(Value::as_str).unwrap_or("").to_string();
                editor.content = content.clone();
                editor.original = content;
                editor.exists = msg.get("exists").and_then(Value::as_bool) == Some(true);
            }
        } else {
            editor.saving = false;
            if ok {
                editor.original = request.content.clone();
                editor.exists = true;
                editor.status = Some(if editor.content == request.content {
                    ("Saved".into(), Kind::Ok)
                } else {
                    ("Earlier changes saved. New edits aren't saved.".into(), Kind::Dim)
                });
            }
        }
        if !write && self.settings.editor.as_ref() == Some(&request.key) {
            self.sync_editor_text(cx);
        }
        cx.notify();
    }

    fn save_config(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.settings.editor.clone() else { return };
        let Some(editor) = self.settings.editors.get_mut(&key) else { return };
        if editor.saving || editor.loading {
            return;
        }
        editor.saving = true;
        editor.error = None;
        editor.status = Some(("Saving…".into(), Kind::Dim));
        self.config_request(key, true, cx);
        cx.notify();
    }

    fn revert_config(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.settings.editor.clone() else { return };
        if let Some(editor) = self.settings.editors.get_mut(&key) {
            editor.content = editor.original.clone();
            editor.status = None;
            editor.error = None;
        }
        self.sync_editor_text(cx);
        cx.notify();
    }

    /// Flip one plugin and write enabledPlugins back at once.
    fn toggle_plugin(&mut self, plugin: String, on: bool, cx: &mut Context<Self>) {
        let Some(key) = self.settings.editor.clone() else { return };
        let Some(editor) = self.settings.editors.get_mut(&key) else { return };
        if editor.saving {
            return;
        }
        let mut map: Map<String, Value> = if editor.content.trim().is_empty() {
            Map::new()
        } else {
            match serde_json::from_str::<Value>(&editor.content) {
                Ok(Value::Object(map)) => map,
                _ => return,
            }
        };
        map.insert(plugin, Value::Bool(on));
        editor.content = serde_json::to_string_pretty(&Value::Object(map)).unwrap_or_default();
        self.save_config(cx);
    }

    // ---- skills ----------------------------------------------------------------------

    fn ensure_skills(&mut self, agent: Agent, cx: &mut Context<Self>) {
        let Some(cwd) = self.active_cwd(cx) else { return };
        let key = (agent, cwd.clone());
        if self.settings.skills.contains_key(&key) {
            return;
        }
        self.settings.skills.insert(key.clone(), SkillList { loading: true, ..Default::default() });
        let id = self.chats[self.active].read(cx).id().to_string();
        if !self.host.is_connected() {
            self.expire_skills(key, cx);
            return;
        }
        self.host.send(json!({ "type": "listSkills", "id": id, "agent": agent.wire(), "cwd": cwd }));
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(20)).await;
            let _ = this.update(cx, |this, cx| this.expire_skills(key, cx));
        })
        .detach();
    }

    fn expire_skills(&mut self, key: (Agent, String), cx: &mut Context<Self>) {
        if let Some(list) = self.settings.skills.get_mut(&key).filter(|l| l.loading) {
            list.loading = false;
            list.error = Some("Couldn't load skills. Reopen this view to try again.".into());
            cx.notify();
        }
    }

    /// Every `commands` reply refreshes the folder's skills and plugins.
    pub(super) fn on_commands(&mut self, msg: &Value, cx: &mut Context<Self>) {
        let chat = msg.get("id").and_then(Value::as_str).and_then(|id| self.chat_by_id(id, cx));
        let agent = match msg.get("agent").and_then(Value::as_str) {
            Some("codex") => Agent::Codex,
            Some(_) => Agent::Claude,
            None => chat.as_ref().map(|c| c.read(cx).meta.agent).unwrap_or_default(),
        };
        let Some(cwd) = msg.get("cwd").and_then(Value::as_str).map(str::to_string).or_else(|| chat.and_then(|c| c.read(cx).meta.cwd.clone())) else {
            return;
        };
        let names = |key: &str| -> Vec<String> {
            msg.get(key)
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string).or_else(|| v.get("name").and_then(Value::as_str).map(str::to_string)))
                        .collect()
                })
                .unwrap_or_default()
        };
        let plugins = msg
            .get("plugins")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|p| Some((p.get("name").and_then(Value::as_str)?.to_string(), p.get("source").and_then(Value::as_str)?.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        self.settings.skills.insert(
            (agent, cwd),
            SkillList { loading: false, skills: names("skills"), plugins, error: msg.get("error").and_then(Value::as_str).map(str::to_string) },
        );
        cx.notify();
    }

    // ---- custom models ------------------------------------------------------------------

    fn custom_models(&self) -> Vec<CustomModel> {
        self.store.custom_models().to_vec()
    }

    fn set_custom_models(&mut self, models: Vec<CustomModel>, cx: &mut Context<Self>) {
        self.store.set_custom_models(models.clone());
        cx.set_global(CustomModels(models));
        cx.notify();
    }

    fn start_draft(&mut self, model: Option<CustomModel>, cx: &mut Context<Self>) {
        let m = model.clone();
        self.settings.pending_fields = Some([
            m.as_ref().map(|m| m.label.clone()).unwrap_or_default(),
            m.as_ref().map(|m| m.base_url.clone()).unwrap_or_default(),
            m.as_ref().map(|m| m.model.clone()).unwrap_or_default(),
            m.as_ref().map(|m| m.api_key.clone()).unwrap_or_default(),
            m.as_ref().and_then(|m| m.context_window).map(|n| n.to_string()).unwrap_or_default(),
        ]);
        self.settings.draft = Some(Draft {
            editing: model.as_ref().map(|m| m.id.clone()),
            wire_api: model.map(|m| m.wire_api).unwrap_or_else(|| "responses".into()),
            error: None,
        });
        self.settings.remove_armed = None;
        cx.notify();
    }

    fn save_draft(&mut self, cx: &mut Context<Self>) {
        let Some(draft) = self.settings.draft.clone() else { return };
        let value = |i: usize, cx: &App| self.settings.fields[i].read(cx).value().to_string();
        let label = value(0, cx).trim().to_string();
        let base_url = value(1, cx).trim().to_string();
        let model = value(2, cx).trim().to_string();
        let api_key = value(3, cx);
        let context = value(4, cx);
        let error = if label.is_empty() || model.is_empty() || base_url.is_empty() {
            Some("Name, model id and base URL are all required.")
        } else if !(base_url.to_lowercase().starts_with("http://") || base_url.to_lowercase().starts_with("https://")) {
            Some("Base URL has to start with http:// or https://.")
        } else {
            None
        };
        let id = draft.editing.clone().unwrap_or_else(|| provider_id(&label));
        let mut models = self.custom_models();
        let error = error.or_else(|| (draft.editing.is_none() && models.iter().any(|m| m.id == id)).then_some("A model with that name already exists."));
        if let Some(error) = error {
            if let Some(d) = self.settings.draft.as_mut() {
                d.error = Some(error.into());
            }
            cx.notify();
            return;
        }
        let row = CustomModel {
            id: id.clone(),
            label,
            model,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
            wire_api: draft.wire_api.clone(),
            context_window: context.trim().parse::<u64>().ok().filter(|n| *n > 0),
        };
        match models.iter_mut().find(|m| m.id == id) {
            Some(existing) => *existing = row,
            None => models.push(row),
        }
        self.settings.draft = None;
        self.set_custom_models(models, cx);
    }

    fn remove_model(&mut self, id: String, cx: &mut Context<Self>) {
        if self.settings.remove_armed.as_deref() != Some(id.as_str()) {
            self.settings.remove_armed = Some(id);
            cx.notify();
            return;
        }
        self.settings.remove_armed = None;
        let models: Vec<CustomModel> = self.custom_models().into_iter().filter(|m| m.id != id).collect();
        self.set_custom_models(models, cx);
        // A chat parked on the model that went away would send a provider
        // the host can't resolve.
        for chat in self.chats.clone() {
            if chat.read(cx).meta.model.as_deref() == Some(id.as_str()) {
                chat.update(cx, |c, cx| c.set_settings(Some(None), None, None, cx));
            }
        }
    }

    // ---- rendering ---------------------------------------------------------------------

    pub(super) fn render_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let tab = self.settings.tab;
        let body: AnyElement = match tab {
            Tab::General => self.render_general(cx).into_any_element(),
            Tab::Claude | Tab::Codex => self.render_config(tab.agent().unwrap_or_default(), window, cx),
            Tab::Models => self.render_models(cx),
        };
        let tabs = TABS.iter().map(|(t, label)| {
            let active = *t == tab;
            let t = *t;
            div()
                .id(SharedString::from(format!("settings-tab-{label}")))
                .relative()
                .flex_none()
                .pt(px(8.))
                .px(px(12.))
                .pb(px(10.))
                .text_size(px(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(if active { hex(TEXT_PRIMARY) } else { hex(TEXT_TERTIARY) })
                .cursor_pointer()
                .when(!active, |d| d.hover(|s| s.text_color(hex(TEXT_SECONDARY))))
                .on_click(cx.listener(move |this, _, _, cx| this.set_tab(t, cx)))
                .child(*label)
                .when(active, |d| {
                    d.child(div().absolute().left(px(8.)).right(px(8.)).bottom(px(-1.)).h(px(2.)).rounded(px(2.)).bg(hex(EMERALD)))
                })
        });
        let viewport = window.viewport_size();
        let height = 560f32.min(f32::from(viewport.height) - TITLEBAR_H - 40.);
        div()
            .id("settings-overlay")
            .occlude()
            .absolute()
            // Over the page, under the window's title strip.
            .top(px(TITLEBAR_H))
            .left_0()
            .right_0()
            .bottom_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(20.))
            .bg(hsla(0., 0., 0., 0.55))
            .on_click(cx.listener(|this, _, window, cx| this.close_settings(window, cx)))
            .child(
                div()
                    .id("settings-modal")
                    .track_focus(&self.settings.focus)
                    .flex()
                    .flex_col()
                    .w_full()
                    .max_w(px(440.))
                    .h(px(height))
                    .bg(hex(BG_SECONDARY))
                    .border_1()
                    .border_color(hex(BORDER))
                    .rounded(px(14.))
                    .shadow(vec![BoxShadow {
                        color: hsla(0., 0., 0., 0.55),
                        offset: point(px(0.), px(20.)),
                        blur_radius: px(60.),
                        spread_radius: px(0.),
                        inset: false,
                    }])
                    .overflow_hidden()
                    // Clicks inside stay inside.
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_between()
                            .pt(px(14.))
                            .pr(px(12.))
                            .pb(px(12.))
                            .pl(px(18.))
                            .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).child("Settings"))
                            .child(
                                icon_button("settings-close", "x", 15.)
                                    .hover(|s| s.bg(hex(BG_SECONDARY)))
                                    .on_click(cx.listener(|this, _, window, cx| this.close_settings(window, cx))),
                            ),
                    )
                    // `box-shadow: inset 0 -1px 0`: the hairline sits inside the strip,
                    // under the tabs, and the active bar overhangs it by a pixel.
                    .child(
                        div()
                            .relative()
                            .flex()
                            .flex_none()
                            .gap(px(2.))
                            .px(px(12.))
                            .child(div().absolute().left_0().right_0().bottom_0().h(px(1.)).bg(hex(BORDER)))
                            .children(tabs),
                    )
                    .child(div().id("settings-body").flex_1().min_h_0().overflow_y_scroll().p(px(18.)).child(body)),
            )
            .with_animation(
                "settings-in",
                Animation::new(Duration::from_millis(200)).with_easing(ease_out_quint()),
                |el, t| el.opacity(t),
            )
            .into_any_element()
    }

    fn render_general(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let sound = self.store.sound_on_done();
        let connected = self.host.is_connected();
        let ready = connected && self.host_state.version.is_some();
        let status = if ready { "Connected" } else if connected { "Connecting…" } else { "Not connected" };
        let link = |id: &'static str, icon: &'static str, size: f32, label: &'static str, url: &'static str| {
            div()
                .id(id)
                .group(id)
                .flex()
                .items_center()
                .gap(px(7.))
                .px(px(13.))
                .py(px(7.))
                .border_1()
                .border_color(hex(BORDER))
                .rounded_full()
                .text_size(px(12.))
                .line_height(px(12.))
                .text_color(hex(TEXT_SECONDARY))
                .cursor_pointer()
                .hover(|s| s.text_color(hex(TEXT_PRIMARY)).border_color(hex(0x3b3b3b)).bg(hex(BG_SECONDARY)))
                .on_click(move |_, _, cx| cx.open_url(url))
                .child(ph(icon, size, hex(TEXT_SECONDARY)).group_hover(id, |s| s.text_color(hex(TEXT_PRIMARY))))
                .child(label)
        };
        div()
            .flex()
            .flex_col()
            .child(
                section("Notifications").child(toggle_list().child(toggle_row(
                    "sound",
                    "Completion sound",
                    "Play a soft chime when a session finishes working or needs your input.",
                    sound,
                    false,
                    cx.listener(move |this, _, _, cx| {
                        let on = !this.store.sound_on_done();
                        this.store.set_sound_on_done(on);
                        if on {
                            crate::sound::play_chime();
                        }
                        cx.notify();
                    }),
                ))),
            )
            .child(
                section("Host connection")
                    .child(kv_row(
                        "Native host",
                        div()
                            .flex()
                            .items_center()
                            .gap(px(7.))
                            .child(div().size(px(7.)).rounded_full().bg(if ready { hex(EMERALD) } else { hex(RED) }))
                            .child(status),
                    ))
                    .child(kv_row("Host version", self.host_state.version.map(|v| v.to_string()).unwrap_or_else(|| "—".into())))
                    .child(kv_row("Required version", MIN_HOST_VERSION.to_string())),
            )
            .child(
                section("Community").mb_0().child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(8.))
                        .child(link("link-site", "globe", 15., "lizard.build", "https://lizard.build"))
                        .child(link("link-github", "github", 15., "GitHub", "https://github.com/lizard-build"))
                        .child(link("link-discord", "discord", 15., "Discord", "https://discord.gg/VM52J59VxU"))
                        .child(link("link-x", "x-brand", 13., "X", "https://x.com/LizardBuild")),
                ),
            )
    }

    fn render_config(&mut self, agent: Agent, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let current = self.file_of(agent);
        let m = meta(agent, current);
        let picker = div()
            .flex()
            .gap(px(3.))
            .p(px(3.))
            .mb(px(14.))
            .bg(hex(BG_PRIMARY))
            .border_1()
            .border_color(hex(BORDER))
            .rounded(px(10.))
            .children(files(agent).iter().map(|key| {
                let active = *key == current;
                let key = *key;
                div()
                    .id(SharedString::from(format!("file-{key}")))
                    .flex_none()
                    .px(px(12.))
                    .py(px(7.))
                    .rounded(px(7.))
                    .text_size(px(12.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .cursor_pointer()
                    .when(active, |d| d.bg(hex(BORDER)).text_color(hex(TEXT_PRIMARY)))
                    .when(!active, |d| d.text_color(hex(TEXT_SECONDARY)).hover(|s| s.text_color(hex(TEXT_PRIMARY))))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if this.file_of(agent) != key {
                            this.show_file(agent, key, cx);
                        }
                    }))
                    .child(meta(agent, key).label)
            }));
        let mut sec = div().flex().flex_col().child(picker);

        if m.readonly {
            sec = sec.child(blurb(m.blurb)).child(self.render_skills(agent, cx));
            return sec.into_any_element();
        }
        let Some(key) = self.settings.editor.clone().filter(|k| k.0 == agent && k.1 == current) else {
            return sec.into_any_element();
        };
        let Some(editor) = self.settings.editors.get(&key).cloned() else { return sec.into_any_element() };
        sec = sec.child(blurb(m.blurb));
        if !m.user_only {
            sec = sec.child(
                div().flex().child(segmented(
                    ["project", "user"].iter().map(|sc| {
                        let sc: &'static str = sc;
                        let label = if sc == "project" { "Project" } else { "User" };
                        (
                            SharedString::from(format!("scope-{sc}")),
                            label,
                            key.2 == sc,
                            Box::new(cx.listener(move |this, _, _, cx| {
                                if this.settings.editor.as_ref().map(|k| k.2) != Some(sc) {
                                    this.load_config(agent, current, sc, cx);
                                }
                            })) as Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>,
                        )
                    }),
                )
                .mb(px(8.))),
            );
        }
        sec = sec
            .child(div().mb(px(10.)).text_size(px(11.)).text_color(hex(TEXT_TERTIARY)).child(if key.2 == "project" { m.project } else { m.user }))
            .child(note("Applies to new or restarted chats."));
        if editor.loading {
            return sec.child(div().py(px(8.)).text_size(px(12.5)).text_color(hex(TEXT_TERTIARY)).child("Loading…")).into_any_element();
        }
        if editor.read_failed {
            return sec
                .child(div().mb(px(8.)).text_size(px(12.)).text_color(hex(RED)).child(editor.error.clone().unwrap_or_default()))
                .child(div().flex().child(save_button("cfg-retry", "Retry", false).on_click(cx.listener(move |this, _, _, cx| {
                    this.load_config(agent, current, key.2, cx)
                }))))
                .into_any_element();
        }
        if m.toggles {
            return sec.child(self.render_plugins(&editor, &key, cx)).into_any_element();
        }
        let dirty = editor.dirty();
        let (msg, color) = match (&editor.error, &editor.status) {
            (Some(e), _) => (e.clone(), hex(RED)),
            (None, Some((s, Kind::Ok))) => (s.clone(), hex(EMERALD)),
            (None, Some((s, Kind::Dim))) => (s.clone(), hex(TEXT_TERTIARY)),
            (None, None) if !editor.exists => ("Doesn't exist yet — saving creates it.".into(), hex(TEXT_TERTIARY)),
            _ => (String::new(), hex(TEXT_PRIMARY)),
        };
        let editor_box = div()
            .h(px(220.))
            .py(px(10.))
            // The text box keeps 4px of its own on each side.
            .px(px(8.))
            .bg(hex(BG_PRIMARY))
            .border_1()
            .border_color(hex(BORDER))
            .rounded(px(10.))
            .child(
                Textarea::new(&self.settings.text)
                    .appearance(false)
                    .bordered(false)
                    .xsmall()
                    .h(px(198.))
                    .when(m.json, |t| t.font_family("Lizard Mono").text_size(px(12.)))
                    .when(!m.json, |t| t.text_size(px(13.)))
                    .line_height(relative(1.5)),
            );
        sec.child(editor_box)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .mt(px(10.))
                    .child(save_button("cfg-save", "Save", !dirty || editor.saving).when(dirty && !editor.saving, |d| {
                        d.on_click(cx.listener(|this, _, _, cx| this.save_config(cx)))
                    }))
                    .when(dirty, |d| {
                        d.child(
                            div()
                                .id("cfg-revert")
                                .px(px(14.))
                                .py(px(7.))
                                .rounded(px(8.))
                                .bg(hex(BG_SECONDARY))
                                .border_1()
                                .border_color(hex(BORDER))
                                .shadow(vec![BoxShadow {
                                    color: hsla(0., 0., 0., 0.4),
                                    offset: point(px(0.), px(1.)),
                                    blur_radius: px(2.),
                                    spread_radius: px(0.),
                                    inset: false,
                                }])
                                .text_size(px(12.5))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(hex(TEXT_SECONDARY))
                                .cursor_pointer()
                                .hover(|s| s.text_color(hex(TEXT_PRIMARY)).border_color(hex(0x3b3b3b)))
                                .on_click(cx.listener(|this, _, _, cx| this.revert_config(cx)))
                                .child("Revert"),
                        )
                    })
                    .child(div().text_size(px(12.)).text_color(color).child(msg)),
            )
            .into_any_element()
    }

    fn render_plugins(&mut self, editor: &Editor, key: &EditorKey, cx: &mut Context<Self>) -> AnyElement {
        let map: Map<String, Value> = if editor.content.trim().is_empty() {
            Map::new()
        } else {
            match serde_json::from_str::<Value>(&editor.content) {
                Ok(Value::Object(map)) => map,
                _ => {
                    return div()
                        .text_size(px(12.))
                        .text_color(hex(RED))
                        .child("enabledPlugins isn't a JSON object — fix the file by hand first.")
                        .into_any_element();
                }
            }
        };
        let cwd = self.active_cwd(cx).unwrap_or_default();
        let installed = self.settings.skills.get(&(Agent::Claude, cwd)).map(|l| l.plugins.clone()).unwrap_or_default();
        let mut keys: Vec<String> = installed.iter().map(|(_, source)| source.clone()).chain(map.keys().cloned()).collect();
        keys.sort();
        keys.dedup();
        if keys.is_empty() {
            return note("No plugins installed.").into_any_element();
        }
        let saving = editor.saving;
        let rows = keys.into_iter().enumerate().map(|(i, k)| {
            let plugin = installed.iter().find(|(_, source)| *source == k);
            let name = plugin.map(|(n, _)| n.clone()).unwrap_or_else(|| k.split('@').next().unwrap_or(&k).to_string());
            let sub = if plugin.is_some() { k.clone() } else { format!("{k} · not installed") };
            let on = map.get(&k) != Some(&Value::Bool(false));
            let k2 = k.clone();
            toggle_row(
                SharedString::from(format!("plugin-{i}")),
                name,
                sub,
                on,
                saving,
                cx.listener(move |this, _, _, cx| this.toggle_plugin(k2.clone(), !on, cx)),
            )
            .when(i > 0, |d| d.border_t_1().border_color(white_a(0.08)))
        });
        let (msg, color) = match (&editor.error, &editor.status) {
            (Some(e), _) => (e.clone(), hex(RED)),
            (None, Some((s, Kind::Ok))) => (s.clone(), hex(EMERALD)),
            (None, Some((s, Kind::Dim))) => (s.clone(), hex(TEXT_TERTIARY)),
            _ => (String::new(), hex(TEXT_PRIMARY)),
        };
        let _ = key;
        div()
            .flex()
            .flex_col()
            .child(toggle_list().children(rows))
            .when(!msg.is_empty(), |d| d.child(div().mt(px(8.)).text_size(px(12.)).text_color(color).child(msg)))
            .into_any_element()
    }

    fn render_skills(&mut self, agent: Agent, cx: &mut Context<Self>) -> AnyElement {
        let cwd = self.active_cwd(cx);
        let list = cwd.as_ref().and_then(|cwd| self.settings.skills.get(&(agent, cwd.clone())).cloned());
        let mut skills = list.as_ref().map(|l| l.skills.clone()).unwrap_or_default();
        skills.sort_by_key(|s| s.to_lowercase());
        if skills.is_empty() {
            let text = match (&cwd, &list) {
                (None, _) => "Choose a project folder first.".to_string(),
                (_, Some(l)) if l.loading => "Loading skills…".into(),
                (_, Some(SkillList { error: Some(e), .. })) => e.clone(),
                _ => "No skills available in this project.".into(),
            };
            let failed = list.as_ref().is_some_and(|l| l.error.is_some());
            return div()
                .flex()
                .flex_col()
                .child(note(text))
                .when(failed, |d| {
                    d.child(div().flex().child(save_button("skills-retry", "Retry", false).on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(cwd) = this.active_cwd(cx) {
                            this.settings.skills.remove(&(agent, cwd));
                        }
                        this.ensure_skills(agent, cx);
                        cx.notify();
                    }))))
                })
                .into_any_element();
        }
        let query = self.settings.filter.read(cx).value().trim().to_lowercase();
        let shown: Vec<String> = skills.into_iter().filter(|s| query.is_empty() || s.to_lowercase().contains(&query)).collect();
        let count = format!("{} {}", shown.len(), if shown.len() == 1 { "skill" } else { "skills" });
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .mb(px(10.))
                    // The input keeps 4px of its own on each side.
                    .px(px(7.))
                    .py(px(6.))
                    .bg(hex(BG_PRIMARY))
                    .border_1()
                    .border_color(hex(BORDER))
                    .rounded(px(8.))
                    .child(Input::new(&self.settings.filter).appearance(false).xsmall().text_size(px(12.5)).h(px(15.))),
            )
            .child(note(count))
            .when(!shown.is_empty(), |d| {
                d.child(
                    div()
                        .mb(px(8.))
                        .border_1()
                        .border_color(hex(BORDER))
                        .rounded(px(10.))
                        .overflow_hidden()
                        .children(shown.into_iter().enumerate().map(|(i, s)| {
                            div()
                                .px(px(12.))
                                .py(px(8.))
                                .text_size(px(12.))
                                .text_color(hex(TEXT_PRIMARY))
                                .when(i > 0, |d| d.border_t_1().border_color(white_a(0.08)))
                                .child(s)
                        })),
                )
            })
            .into_any_element()
    }

    fn render_models(&mut self, cx: &mut Context<Self>) -> AnyElement {
        // One paragraph with the path set in mono on a faint chip (`.set-code`).
        let lead = "Any OpenAI-compatible endpoint — a llama.cpp box, OpenRouter, your own gateway. They show up in the ChatGPT model picker. The provider is declared per session, so nothing here touches";
        let mut words: Vec<AnyElement> = lead.split(' ').map(|w| div().child(w.to_string()).into_any_element()).collect();
        words.push(
            div()
                .flex()
                .items_center()
                .child(
                    div()
                        .px(px(5.))
                        .rounded(px(4.))
                        .bg(white_a(0.05))
                        .font_family("Lizard Mono")
                        .text_color(hex(TEXT_PRIMARY))
                        .line_height(px(16.))
                        .child("~/.codex/config.toml"),
                )
                .child(".")
                .into_any_element(),
        );
        let blurb = div().mb(px(14.)).text_size(px(12.)).line_height(relative(1.5)).text_color(hex(TEXT_SECONDARY)).child(flow(words, 12.));
        let models = self.custom_models();
        let draft = self.settings.draft.clone();
        let mut body = div().flex().flex_col().child(blurb);
        if let Some(draft) = draft.clone().filter(|d| d.editing.is_some()) {
            return body.child(self.model_form("Edit model", &draft, false, cx)).into_any_element();
        }
        if !models.is_empty() {
            let armed = self.settings.remove_armed.clone();
            body = body.child(div().border_1().border_color(hex(BORDER)).rounded(px(10.)).overflow_hidden().children(models.into_iter().enumerate().map(
                |(i, m)| {
                    let edit_model = m.clone();
                    let id = m.id.clone();
                    let is_armed = armed.as_deref() == Some(m.id.as_str());
                    div()
                        .id(("custom-model", i))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .px(px(12.))
                        .py(px(10.))
                        .when(i > 0, |d| d.border_t_1().border_color(white_a(0.08)))
                        .hover(|s| s.bg(white_a(0.03)))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(div().truncate().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child(m.label.clone()))
                                .child(
                                    div()
                                        .mt(px(2.))
                                        .truncate()
                                        .font_family("Lizard Mono")
                                        .text_size(px(12.))
                                        .text_color(hex(TEXT_TERTIARY))
                                        .child(format!("{} · {}", m.model, m.base_url)),
                                ),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .gap(px(2.))
                                .child(row_action(("model-edit", i), "Edit", false, false).on_click(cx.listener(move |this, _, _, cx| {
                                    this.start_draft(Some(edit_model.clone()), cx)
                                })))
                                .child(
                                    row_action(("model-remove", i), if is_armed { "Confirm" } else { "Remove" }, true, is_armed)
                                        .on_click(cx.listener(move |this, _, _, cx| this.remove_model(id.clone(), cx))),
                                ),
                        )
                },
            )));
        }
        if let Some(draft) = draft {
            return body.child(self.model_form("New model", &draft, !self.store.custom_models().is_empty(), cx)).into_any_element();
        }
        let solo = self.store.custom_models().is_empty();
        body.child(
            div()
                .id("model-add")
                .group("model-add")
                .flex()
                .items_center()
                .justify_center()
                .gap(px(7.))
                .w_full()
                .when(!solo, |d| d.mt(px(10.)).py(px(9.)))
                .when(solo, |d| d.py(px(20.)))
                .px(px(12.))
                .border_1()
                .border_dashed()
                .border_color(hex(BORDER))
                .rounded(px(10.))
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(hex(TEXT_SECONDARY))
                .cursor_pointer()
                .hover(|s| s.bg(white_a(0.03)).border_color(hex(0x3b3b3b)).text_color(hex(TEXT_PRIMARY)))
                .on_click(cx.listener(|this, _, _, cx| this.start_draft(None, cx)))
                .child(ph("plus", 14., hex(TEXT_SECONDARY)).group_hover("model-add", |s| s.text_color(hex(TEXT_PRIMARY))))
                .child("Add a model"),
        )
        .into_any_element()
    }

    /// `margin-top: 10px`, which collapses into the blurb's 14px when the form
    /// follows it directly.
    fn model_form(&mut self, title: &'static str, draft: &Draft, after_list: bool, cx: &mut Context<Self>) -> impl IntoElement {
        // `.set-field-input`; placeholders stay in the regular face.
        let field = |label: &'static str, state: &Entity<InputState>, mono: bool, cx: &App| {
            let mono = mono && !state.read(cx).value().is_empty();
            div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .min_w_0()
                .child(div().text_size(px(12.)).text_color(hex(TEXT_SECONDARY)).child(label))
                .child(
                    div()
                        .h(px(32.))
                        // The input keeps 4px of its own on each side.
                        .px(px(6.))
                        .flex()
                        .items_center()
                        .bg(hex(BG_PRIMARY))
                        .border_1()
                        .border_color(hex(BORDER))
                        .rounded(px(8.))
                        .child(
                            Input::new(state)
                                .appearance(false)
                                .xsmall()
                                .text_size(px(12.))
                                .h(px(16.))
                                .when(mono, |i| i.font_family("Lizard Mono")),
                        ),
                )
        };
        let [name, base_url, model, api_key, context] = self.settings.fields.clone();
        let wire = draft.wire_api.clone();
        let wire_seg = segmented(["responses", "chat"].iter().map(|v| {
            let v: &'static str = v;
            (
                SharedString::from(format!("wire-{v}")),
                v,
                wire == v,
                Box::new(cx.listener(move |this, _, _, cx| {
                    if let Some(d) = this.settings.draft.as_mut() {
                        d.wire_api = v.to_string();
                    }
                    cx.notify();
                })) as Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>,
            )
        }))
        .h(px(32.))
        .items_center();
        div()
            .when(after_list, |d| d.mt(px(10.)))
            .p(px(14.))
            .flex()
            .flex_col()
            .gap(px(12.))
            .border_1()
            .border_color(hex(BORDER))
            .rounded(px(10.))
            .bg(white_a(0.02))
            .child(div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).child(title))
            .child(field("Name", &name, false, cx))
            .child(field("Base URL", &base_url, true, cx))
            .child(field("Model id", &model, true, cx))
            .child(field("API key", &api_key, true, cx))
            .child(
                div()
                    .flex()
                    .gap(px(12.))
                    .child(div().flex_1().min_w_0().child(field("Context window", &context, true, cx)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(5.))
                            .child(div().text_size(px(12.)).text_color(hex(TEXT_SECONDARY)).child("Wire API"))
                            .child(div().flex().child(wire_seg)),
                    ),
            )
            .when_some(draft.error.clone(), |d, error| d.child(div().text_size(px(12.)).text_color(hex(RED)).child(error)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(save_button("model-save", "Save", false).on_click(cx.listener(|this, _, _, cx| this.save_draft(cx))))
                    .child(
                        div()
                            .id("model-cancel")
                            .px(px(12.))
                            .py(px(7.))
                            .rounded(px(8.))
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(hex(TEXT_SECONDARY))
                            .cursor_pointer()
                            .hover(|s| s.bg(hex(BORDER)).text_color(hex(TEXT_PRIMARY)))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.settings.draft = None;
                                cx.notify();
                            }))
                            .child("Cancel"),
                    ),
            )
    }
}

fn ease_out_quint() -> impl Fn(f32) -> f32 {
    |t| 1. - (1. - t).powi(5)
}

fn section(title: &'static str) -> Div {
    div()
        .flex()
        .flex_col()
        .mb(px(22.))
        .child(div().mb(px(10.)).text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_PRIMARY)).child(title))
}

fn blurb(text: &'static str) -> impl IntoElement {
    div().mb(px(12.)).text_size(px(12.)).line_height(relative(1.5)).text_color(hex(TEXT_SECONDARY)).child(prose(text, 12.))
}

/// A paragraph that wraps only at spaces, as the browser does: GPUI also
/// breaks before a "/", which splits paths like ~/.claude/skills.
fn prose(text: &str, size: f32) -> Div {
    flow(text.split(' ').filter(|w| !w.is_empty()).map(|w| div().child(w.to_string()).into_any_element()), size)
}

/// Words laid out in rows a space apart (measured against Chrome's Inter).
fn flow(words: impl IntoIterator<Item = AnyElement>, size: f32) -> Div {
    div().flex().flex_wrap().gap_x(px(size * 0.25)).children(words)
}

fn note(text: impl Into<SharedString>) -> Div {
    div().mb(px(10.)).text_size(px(11.)).text_color(hex(TEXT_TERTIARY)).child(text.into())
}

/// `.settings-kv`: every row carries the hairline, the first one too
/// (`:first-of-type` never matches past the section title).
fn kv_row(key: &'static str, value: impl IntoElement) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.))
        .py(px(7.))
        .border_t_1()
        .border_color(white_a(0.08))
        .text_size(px(12.))
        .child(div().flex_none().text_color(hex(TEXT_SECONDARY)).child(key))
        .child(div().text_color(hex(TEXT_PRIMARY)).child(value))
}

/// `.settings-toggle-list`. Its 8px bottom margin collapses into the
/// section's 22px in CSS, so it only shows when something follows.
fn toggle_list() -> Div {
    div().border_1().border_color(hex(BORDER)).rounded(px(10.)).overflow_hidden()
}

fn toggle_row(
    id: impl Into<SharedString>,
    name: impl Into<SharedString>,
    sub: impl Into<SharedString>,
    on: bool,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Div {
    let id: SharedString = id.into();
    div()
        .flex()
        .items_center()
        .gap(px(12.))
        .px(px(12.))
        .py(px(9.))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(div().text_size(px(12.5)).font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_PRIMARY)).child(name.into()))
                .child(div().mt(px(1.)).truncate().text_size(px(11.)).text_color(hex(TEXT_TERTIARY)).child(sub.into())),
        )
        .child(
            div()
                .id(id)
                .relative()
                .flex_none()
                .w(px(34.))
                .h(px(20.))
                .rounded_full()
                .bg(if on { hex(EMERALD) } else { hex(BORDER) })
                .when(disabled, |d| d.opacity(0.5))
                .when(!disabled, |d| d.cursor_pointer().on_click(on_click))
                .child(div().absolute().top(px(2.)).left(px(if on { 16. } else { 2. })).size(px(16.)).rounded_full().bg(hsla(0., 0., 1., 1.))),
        )
}

/// `.settings-scope`: a small segmented control.
fn segmented(
    items: impl Iterator<Item = (SharedString, &'static str, bool, Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>)>,
) -> Div {
    div()
        .flex()
        .p(px(2.))
        .gap(px(2.))
        .bg(white_a(0.04))
        .border_1()
        .border_color(hex(BORDER))
        .rounded(px(8.))
        .children(items.map(|(id, label, active, on_click)| {
            div()
                .id(id)
                .px(px(14.))
                .py(px(4.))
                .rounded(px(6.))
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD)
                .cursor_pointer()
                .when(active, |d| d.bg(hex(BORDER)).text_color(hex(TEXT_PRIMARY)))
                .when(!active, |d| d.text_color(hex(TEXT_SECONDARY)).hover(|s| s.text_color(hex(TEXT_PRIMARY))))
                .on_click(move |e, w, cx| on_click(e, w, cx))
                .child(label)
        }))
}

/// `.settings-save-btn`.
fn save_button(id: &'static str, label: &'static str, disabled: bool) -> Stateful<Div> {
    div()
        .id(id)
        .px(px(16.))
        .py(px(7.))
        .rounded(px(8.))
        .bg(hex(BORDER))
        .text_size(px(12.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(hex(TEXT_PRIMARY))
        .when(disabled, |d| d.opacity(0.4))
        .when(!disabled, |d| d.cursor_pointer().hover(|s| s.bg(hex(0x3b3b3b))))
        .child(label)
}

/// `.custom-model-act`: quiet until hovered; Remove arms red.
fn row_action(id: impl Into<ElementId>, label: &'static str, danger: bool, armed: bool) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(24.))
        .px(px(8.))
        .flex()
        .items_center()
        .rounded(px(6.))
        .text_size(px(12.))
        .font_weight(FontWeight::SEMIBOLD)
        .cursor_pointer()
        .when(armed, |d| d.bg(rgba_hex(RED, 0.14)).text_color(hex(RED_SOFT)))
        .when(!armed, |d| d.text_color(hex(TEXT_TERTIARY)))
        .when(danger, |d| d.hover(|s| s.bg(rgba_hex(RED, 0.14)).text_color(hex(RED_SOFT))))
        .when(!danger, |d| d.hover(|s| s.bg(hex(BORDER)).text_color(hex(TEXT_PRIMARY))))
        .child(label)
}
