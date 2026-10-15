//! Saved chats: the list in the sidebar and what is needed to resume each one.
//! The conversation itself stays in the agent's own transcript on disk and is
//! read back through the host's `loadTranscript`.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::host::home_dir;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    #[default]
    Claude,
    Codex,
}

impl Agent {
    pub fn wire(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code",
            Agent::Codex => "ChatGPT",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedChat {
    pub id: String,
    pub title: String,
    pub agent: Agent,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    /// Bookmark colour as a hex string, like the panel's chat bookmarks.
    #[serde(default)]
    pub bookmark: Option<String>,
    /// Open chats are listed under "Active"; closed ones under "History".
    #[serde(default)]
    pub open: bool,
    #[serde(default)]
    pub title_edited: bool,
    /// Where the agent last said it works (`system/init`), which can be a
    /// worktree below `cwd`. Only the git bar and file links read it.
    #[serde(default)]
    pub work_cwd: Option<String>,
    /// The chat runs in a Lizard sandbox instead of on this Mac.
    #[serde(default)]
    pub cloud: bool,
    #[serde(default)]
    pub sandbox_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

/// An OpenAI-compatible endpoint for ChatGPT chats (Settings › Models). The
/// host declares it as the session's provider, so nothing lands in
/// ~/.codex/config.toml.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomModel {
    pub id: String,
    pub label: String,
    pub model: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "responses")]
    pub wire_api: String,
    #[serde(default)]
    pub context_window: Option<u64>,
}

fn responses() -> String {
    "responses".into()
}

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    chats: Vec<SavedChat>,
    #[serde(default)]
    last_cwd: Option<String>,
    #[serde(default)]
    last_agent: Option<Agent>,
    #[serde(default)]
    last_cloud: bool,
    #[serde(default)]
    custom_models: Vec<CustomModel>,
    #[serde(default)]
    sound_on_done: bool,
}

pub struct Store {
    path: PathBuf,
    file: StoreFile,
}

impl Store {
    pub fn load() -> Self {
        // LIZARD_STUDIO_STORE points a visual check at a fixture list.
        let path = std::env::var_os("LIZARD_STUDIO_STORE").map(PathBuf::from).unwrap_or_else(|| {
            home_dir().join("Library").join("Application Support").join("Lizard Studio").join("chats.json")
        });
        let file = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self { path, file }
    }

    pub fn chats(&self) -> &[SavedChat] {
        &self.file.chats
    }

    pub fn last_cwd(&self) -> Option<String> {
        self.file.last_cwd.clone()
    }

    pub fn last_agent(&self) -> Agent {
        self.file.last_agent.unwrap_or_default()
    }

    pub fn last_cloud(&self) -> bool {
        self.file.last_cloud
    }

    pub fn remember_cloud(&mut self, cloud: bool) {
        self.file.last_cloud = cloud;
        self.save();
    }

    pub fn remember_start(&mut self, cwd: &str, agent: Agent) {
        self.file.last_cwd = Some(cwd.to_string());
        self.file.last_agent = Some(agent);
        self.save();
    }

    pub fn custom_models(&self) -> &[CustomModel] {
        &self.file.custom_models
    }

    pub fn set_custom_models(&mut self, models: Vec<CustomModel>) {
        self.file.custom_models = models;
        self.save();
    }

    pub fn sound_on_done(&self) -> bool {
        self.file.sound_on_done
    }

    pub fn set_sound_on_done(&mut self, on: bool) {
        self.file.sound_on_done = on;
        self.save();
    }

    pub fn upsert(&mut self, chat: SavedChat) {
        match self.file.chats.iter_mut().find(|c| c.id == chat.id) {
            Some(existing) => *existing = chat,
            None => self.file.chats.push(chat),
        }
        self.save();
    }

    /// Order the saved chats like `ids`; any not named keep their place after.
    pub fn set_order(&mut self, ids: &[String]) {
        let rank = |id: &str| ids.iter().position(|x| x == id).unwrap_or(usize::MAX);
        let before: Vec<String> = self.file.chats.iter().map(|c| c.id.clone()).collect();
        self.file.chats.sort_by_key(|c| rank(&c.id));
        if self.file.chats.iter().map(|c| &c.id).ne(before.iter()) {
            self.save();
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.file.chats.retain(|c| c.id != id);
        self.save();
    }

    fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&self.file) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                // Custom models carry API keys.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt as _;
                    let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
                }
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn new_chat_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("mac-{:x}-{:x}", nanos, std::process::id())
}
