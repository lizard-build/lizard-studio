//! Cloud chats: the agent runs in a Lizard sandbox made from its template, and
//! every turn goes through the user's own `lizard` CLI:
//!
//!   sandbox create -t <agent> --timeout 1h   (first message)
//!   sandbox timeout <id> 1h                   (each later message keeps it alive)
//!   sandbox prompt <id> --agent <agent> --json [-c <conversation>]
//!   sandbox interrupt <id> -c <conversation>  (Stop)
//!
//! `sandbox prompt --json` prints one event per line: `prompt`, `running`,
//! `response`, `tool_call`, `tool_result`, then `finished` or `failed`. A
//! request the server refuses prints one JSON object with `error` instead.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;

use futures::channel::mpsc::UnboundedSender;
use serde_json::Value;

use crate::host::{home_dir, host_dir};

/// How long a cloud chat's sandbox lives after the last message.
const LIFETIME_MS: &str = "3600000";

pub enum CloudMsg {
    /// A line for the chat, like "Started sandbox …".
    Note(String),
    SandboxReady(String),
    Event(Value),
    /// The turn's process ended; `error` when it failed without a `failed`
    /// event, `code` when the platform named the reason (connect.rs).
    Done { error: Option<String>, code: Option<String> },
}

pub struct PromptJob {
    pub sandbox: Option<String>,
    pub agent: &'static str,
    pub conversation: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub text: String,
    /// Files on this Mac to put in the sandbox and name in the prompt.
    pub files: Vec<PathBuf>,
    /// A snapshot to start a new sandbox from (Settings › General).
    pub snapshot: Option<String>,
}

/// PATH for the CLI: an app opened from Finder gets a bare one, and `lizard`
/// is usually a `#!/usr/bin/env node` script.
pub(crate) fn child_path() -> String {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs: Vec<String> = Vec::new();
        if let Some(node) = std::fs::read_to_string(host_dir().join("host-config.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|c| c.get("nodePath").and_then(Value::as_str).map(PathBuf::from))
        {
            if let Some(dir) = node.parent() {
                dirs.push(dir.to_string_lossy().to_string());
            }
        }
        let home = home_dir();
        for dir in [
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
            home.join(".lizard/bin").to_string_lossy().to_string(),
            home.join(".local/bin").to_string_lossy().to_string(),
            home.join(".bun/bin").to_string_lossy().to_string(),
        ] {
            dirs.push(dir);
        }
        if let Ok(path) = std::env::var("PATH") {
            dirs.extend(path.split(':').map(str::to_string));
        }
        dirs.extend(["/usr/bin", "/bin"].map(str::to_string));
        dirs.dedup();
        dirs.join(":")
    })
    .clone()
}

pub fn lizard_bin() -> Option<PathBuf> {
    find_bin("lizard")
}

pub(crate) fn find_bin(name: &str) -> Option<PathBuf> {
    child_path().split(':').map(|dir| PathBuf::from(dir).join(name)).find(|p| p.exists())
}

/// A refused CLI call: what to show, and the platform's code for it.
pub struct Refusal {
    pub message: String,
    pub code: Option<String>,
}

impl From<String> for Refusal {
    fn from(message: String) -> Self {
        Self { message, code: None }
    }
}

impl From<&str> for Refusal {
    fn from(message: &str) -> Self {
        Self { message: message.to_string(), code: None }
    }
}

fn lizard(bin: &PathBuf) -> Command {
    let mut command = Command::new(bin);
    command.env("PATH", child_path()).stdin(Stdio::null());
    command
}

/// Run a short `lizard … --json` call and return its JSON (or the error message).
fn run_json(bin: &PathBuf, args: &[&str]) -> Result<Value, Refusal> {
    let out = lizard(bin).args(args).arg("--json").output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    // An object, or a list (`workspace list`, `project list`).
    let json = text.find(['{', '[']).and_then(|at| serde_json::from_str::<Value>(&text[at..]).ok());
    match json {
        // The CLI exits 0 with `{error: …}` on stdout for a refused request.
        Some(json) if out.status.success() && json.get("error").is_none() => Ok(json),
        Some(json) => Err(error_message(Some(&json), out.status.code())),
        None if out.status.success() => Err("lizard printed no JSON".into()),
        None => Err(error_message(None, out.status.code())),
    }
}

fn error_message(json: Option<&Value>, code: Option<i32>) -> Refusal {
    let named = json.and_then(|j| j.pointer("/error/code").or_else(|| j.pointer("/error/body/code"))).and_then(Value::as_str).map(str::to_string);
    if code == Some(2) || named.as_deref() == Some("NOT_AUTHENTICATED") {
        return Refusal { message: "Sign in to Lizard first: run lizard login in a terminal.".into(), code: named };
    }
    let message = json
        .and_then(|j| j.pointer("/error/message").or_else(|| j.get("error")))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("lizard exited with code {}", code.map_or("?".into(), |c| c.to_string())));
    Refusal { message, code: named }
}

fn is_gone(error: &str) -> bool {
    let e = error.to_lowercase();
    e.contains("not found") || e.contains("not running") || e.contains("expired") || e.contains("no such sandbox")
}

/// Every sandbox the app makes goes to one project, in the personal workspace
/// the user owns.
pub const PROJECT_NAME: &str = "Lizard Desktop";

fn rows(value: Value, key: &str) -> Vec<Value> {
    match value {
        Value::Array(rows) => rows,
        Value::Object(mut map) => map.remove(key).and_then(|v| v.as_array().cloned()).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The Lizard Desktop project: found, or created on first use. Kept for the
/// app's life once known.
pub fn desktop_project(bin: &PathBuf) -> Result<String, Refusal> {
    static PROJECT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    let mut cached = PROJECT.lock().map_err(|_| Refusal::from("project lookup failed"))?;
    if let Some(id) = cached.clone() {
        return Ok(id);
    }
    let workspaces = rows(run_json(bin, &["workspace", "list"])?, "workspaces");
    let personal = |owned: bool| {
        workspaces.iter().find(|w| {
            w.get("isPersonal").and_then(Value::as_bool) == Some(true)
                && (!owned || w.get("role").and_then(Value::as_str) == Some("owner"))
        })
    };
    let workspace = personal(true)
        .or_else(|| personal(false))
        .and_then(|w| w.get("id").and_then(Value::as_str))
        .ok_or("Lizard found no personal workspace on this account.")?
        .to_string();
    let projects = rows(run_json(bin, &["project", "list"])?, "projects");
    let found = projects.iter().find(|p| {
        p.get("workspaceId").and_then(Value::as_str) == Some(workspace.as_str())
            && p.get("name").and_then(Value::as_str).is_some_and(|n| n.eq_ignore_ascii_case(PROJECT_NAME))
    });
    let id = match found.and_then(|p| p.get("id").and_then(Value::as_str)) {
        Some(id) => id.to_string(),
        None => {
            let created = run_json(bin, &["project", "create", PROJECT_NAME, "-w", &workspace])?;
            created.get("id").and_then(Value::as_str).ok_or("lizard created no project id")?.to_string()
        }
    };
    *cached = Some(id.clone());
    Ok(id)
}

fn create(bin: &PathBuf, agent: &str, snapshot: Option<&str>, tx: &UnboundedSender<CloudMsg>) -> Result<String, Refusal> {
    let project = desktop_project(bin)?;
    let mut created = None;
    // The user's own template (a snapshot with both agents), else the agent's.
    if let Some(snapshot) = snapshot {
        match run_json(bin, &["sandbox", "create", "--snapshot", snapshot, "-p", &project, "--timeout", LIFETIME_MS]) {
            Ok(value) => created = Some(value),
            Err(e) => {
                let _ = tx.unbounded_send(CloudMsg::Note(format!("Template {snapshot} didn't start ({}); using the {agent} template.", e.message)));
            }
        }
    }
    let created = match created {
        Some(value) => value,
        None => run_json(bin, &["sandbox", "create", "-t", agent, "-p", &project, "--timeout", LIFETIME_MS])?,
    };
    let id = created
        .get("id")
        .or_else(|| created.get("sandboxId"))
        .and_then(Value::as_str)
        .ok_or("lizard created no sandbox id")?
        .to_string();
    let _ = tx.unbounded_send(CloudMsg::SandboxReady(id.clone()));
    let _ = tx.unbounded_send(CloudMsg::Note(format!("Started sandbox {id}")));
    Ok(id)
}

pub fn run_prompt(job: PromptJob, tx: UnboundedSender<CloudMsg>) {
    thread::spawn(move || {
        let done = |error: Option<Refusal>| {
            let (error, code) = error.map_or((None, None), |r| (Some(r.message), r.code));
            let _ = tx.unbounded_send(CloudMsg::Done { error, code });
        };
        let Some(bin) = lizard_bin() else {
            return done(Some("Install Lizard CLI first: curl -fsSL https://lizard.build/install.sh | bash".into()));
        };
        let mut conversation = job.conversation.clone();
        let mut sandbox = job.sandbox.clone();
        // An existing sandbox gets another hour; a gone one is replaced.
        if let Some(id) = sandbox.clone() {
            if let Err(error) = run_json(&bin, &["sandbox", "timeout", &id, LIFETIME_MS]) {
                if is_gone(&error.message) {
                    let _ = tx.unbounded_send(CloudMsg::Note(format!("Sandbox {id} has stopped; starting a new one.")));
                    sandbox = None;
                    conversation = None;
                }
            }
        }
        // A new sandbox costs money from the first second; don't start one
        // for an agent the account can't run yet.
        if sandbox.is_none() {
            let agent = if job.agent == "codex" { crate::store::Agent::Codex } else { crate::store::Agent::Claude };
            if let Some((code, message)) = crate::connect::missing_credential(agent) {
                return done(Some(Refusal { message, code: Some(code.to_string()) }));
            }
        }
        let id = match sandbox {
            Some(id) => id,
            None => match create(&bin, job.agent, job.snapshot.as_deref(), &tx) {
                Ok(id) => id,
                Err(error) => return done(Some(error)),
            },
        };
        let mut job = job;
        if !job.files.is_empty() {
            let note = upload(&bin, &id, &job.files, &tx);
            job.text = crate::chat::join_note(&job.text, &note);
        }
        match prompt(&bin, &id, &job, conversation.as_deref(), &tx) {
            Ok(()) => done(None),
            Err(error) => done(Some(error)),
        }
    });
}

/// Where attachments land in the sandbox.
const ATTACH_DIR: &str = "/workspace/attachments";

/// `lizard sandbox files put` each file; returns the prompt's note naming
/// them by their path in the sandbox. A file that fails is said in the chat
/// and left out.
fn upload(bin: &PathBuf, sandbox: &str, files: &[PathBuf], tx: &UnboundedSender<CloudMsg>) -> String {
    let mut remote = Vec::new();
    for file in files {
        let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        let mut target = format!("{ATTACH_DIR}/{name}");
        let mut n = 2;
        while remote.contains(&target) {
            target = format!("{ATTACH_DIR}/{n}-{name}");
            n += 1;
        }
        let local = file.to_string_lossy().to_string();
        match run_json(bin, &["sandbox", "files", "put", sandbox, &local, &target]) {
            Ok(_) => remote.push(target),
            Err(e) => {
                let _ = tx.unbounded_send(CloudMsg::Note(format!("Couldn't put {name} in the sandbox: {}", e.message)));
            }
        }
    }
    crate::chat::files_note(&remote)
}

fn prompt(bin: &PathBuf, sandbox: &str, job: &PromptJob, conversation: Option<&str>, tx: &UnboundedSender<CloudMsg>) -> Result<(), Refusal> {
    let mut command = lizard(bin);
    command.args(["sandbox", "prompt", sandbox, "--agent", job.agent, "--json"]);
    match conversation {
        Some(c) => command.args(["-c", c]),
        None => command.arg("--new"),
    };
    if let Some(model) = &job.model {
        command.args(["-m", model]);
    }
    if let Some(effort) = job.effort.as_deref().filter(|e| ["minimal", "low", "medium", "high", "xhigh"].contains(e)) {
        command.args(["--effort", effort]);
    }
    command.arg("--").arg(&job.text);
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or(Refusal::from("no output from lizard"))?;
    let mut ended = false;
    let mut rest = String::new();
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        match serde_json::from_str::<Value>(&line) {
            Ok(event) if event.get("type").is_some() => {
                if matches!(event.get("type").and_then(Value::as_str), Some("finished" | "failed")) {
                    ended = true;
                }
                if tx.unbounded_send(CloudMsg::Event(event)).is_err() {
                    let _ = child.kill();
                    return Ok(());
                }
            }
            _ => {
                rest.push_str(&line);
                rest.push('\n');
            }
        }
    }
    let mut stderr = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let json = rest.find('{').and_then(|at| serde_json::from_str::<Value>(&rest[at..]).ok());
    // A refused request prints its `{error: …}` and may still exit 0.
    let refused = json.as_ref().is_some_and(|j| j.get("error").is_some());
    if ended || (status.success() && !refused) {
        return Ok(());
    }
    let mut error = error_message(json.as_ref(), status.code());
    if json.is_none() && !stderr.trim().is_empty() {
        error.message = stderr.trim().lines().last().unwrap_or("").to_string();
    }
    Err(error)
}

pub fn interrupt(sandbox: String, conversation: Option<String>) {
    thread::spawn(move || {
        let Some(bin) = lizard_bin() else { return };
        let mut args = vec!["sandbox".to_string(), "interrupt".into(), sandbox];
        if let Some(c) = conversation {
            args.push("-c".into());
            args.push(c);
        }
        let _ = lizard(&bin).args(&args).arg("--json").output();
    });
}

/// Where a cloud chat keeps what it showed, since the CLI can't read a
/// finished conversation back.
pub fn log_path(chat_id: &str) -> PathBuf {
    home_dir()
        .join("Library")
        .join("Application Support")
        .join("Lizard Studio")
        .join("cloud")
        .join(format!("{chat_id}.jsonl"))
}

pub fn append_log(chat_id: &str, entry: &Value) {
    use std::io::Write as _;
    // Visual-check chats leave nothing behind.
    if chat_id.starts_with("preview-") {
        return;
    }
    let path = log_path(chat_id);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{entry}");
    }
}

pub fn read_log(chat_id: &str) -> Vec<Value> {
    std::fs::read_to_string(log_path(chat_id))
        .map(|text| text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
        .unwrap_or_default()
}

/// A cloud tool call as the chat's tool cards know it.
pub fn tool_from_event(event: &Value) -> (String, Value) {
    let tool = event.get("tool").and_then(Value::as_str).unwrap_or("tool");
    let input = event.get("input").cloned().unwrap_or(Value::Null);
    match tool {
        "command_execution" => {
            let command = input.as_str().map(unwrap_shell).unwrap_or_default();
            ("Bash".into(), serde_json::json!({ "command": command }))
        }
        "web_search" => ("WebSearch".into(), match input {
            Value::String(q) => serde_json::json!({ "query": q }),
            other => other,
        }),
        "file_change" => ("Edit".into(), match input {
            Value::String(p) => serde_json::json!({ "file_path": p }),
            other => other,
        }),
        "todo_list" => ("TodoWrite".into(), input),
        // Claude Code's own tools arrive under their own names.
        name => (name.to_string(), match input {
            Value::String(s) => serde_json::json!({ "input": s }),
            other => other,
        }),
    }
}

/// `/bin/bash -lc 'printf hi > hello.txt'` → `printf hi > hello.txt`.
fn unwrap_shell(command: &str) -> String {
    for prefix in ["/bin/bash -lc ", "bash -lc ", "/bin/sh -c ", "sh -c "] {
        if let Some(rest) = command.strip_prefix(prefix) {
            let rest = rest.trim();
            if rest.len() >= 2 && rest.starts_with('\'') && rest.ends_with('\'') {
                return rest[1..rest.len() - 1].replace("'\\''", "'");
            }
            if rest.len() >= 2 && rest.starts_with('"') && rest.ends_with('"') {
                return rest[1..rest.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\").replace("\\$", "$");
            }
            return rest.to_string();
        }
    }
    command.to_string()
}
