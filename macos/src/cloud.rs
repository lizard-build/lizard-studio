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
    /// The turn's process ended; `error` when it failed without a `failed` event.
    Done { error: Option<String> },
}

pub struct PromptJob {
    pub sandbox: Option<String>,
    pub agent: &'static str,
    pub conversation: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub text: String,
}

/// PATH for the CLI: an app opened from Finder gets a bare one, and `lizard`
/// is usually a `#!/usr/bin/env node` script.
fn child_path() -> String {
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
    child_path().split(':').map(|dir| PathBuf::from(dir).join("lizard")).find(|p| p.exists())
}

fn lizard(bin: &PathBuf) -> Command {
    let mut command = Command::new(bin);
    command.env("PATH", child_path()).stdin(Stdio::null());
    command
}

/// Run a short `lizard … --json` call and return its JSON (or the error message).
fn run_json(bin: &PathBuf, args: &[&str]) -> Result<Value, String> {
    let out = lizard(bin).args(args).arg("--json").output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let json = text.find('{').and_then(|at| serde_json::from_str::<Value>(&text[at..]).ok());
    if out.status.success() {
        return json.ok_or_else(|| "lizard printed no JSON".to_string());
    }
    Err(error_message(json.as_ref(), out.status.code()))
}

fn error_message(json: Option<&Value>, code: Option<i32>) -> String {
    if code == Some(2) || json.and_then(|j| j.pointer("/error/code")).and_then(Value::as_str) == Some("NOT_AUTHENTICATED") {
        return "Sign in to Lizard first: run lizard login in a terminal.".into();
    }
    json.and_then(|j| j.pointer("/error/message").or_else(|| j.get("error")))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("lizard exited with code {}", code.map_or("?".into(), |c| c.to_string())))
}

fn is_gone(error: &str) -> bool {
    let e = error.to_lowercase();
    e.contains("not found") || e.contains("not running") || e.contains("expired") || e.contains("no such sandbox")
}

fn create(bin: &PathBuf, agent: &str, tx: &UnboundedSender<CloudMsg>) -> Result<String, String> {
    let created = run_json(bin, &["sandbox", "create", "-t", agent, "--timeout", LIFETIME_MS])?;
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
        let done = |error: Option<String>| {
            let _ = tx.unbounded_send(CloudMsg::Done { error });
        };
        let Some(bin) = lizard_bin() else {
            return done(Some("Install Lizard CLI first: curl -fsSL https://lizard.build/install.sh | bash".into()));
        };
        let mut conversation = job.conversation.clone();
        let mut sandbox = job.sandbox.clone();
        // An existing sandbox gets another hour; a gone one is replaced.
        if let Some(id) = sandbox.clone() {
            if let Err(error) = run_json(&bin, &["sandbox", "timeout", &id, LIFETIME_MS]) {
                if is_gone(&error) {
                    let _ = tx.unbounded_send(CloudMsg::Note(format!("Sandbox {id} has stopped; starting a new one.")));
                    sandbox = None;
                    conversation = None;
                }
            }
        }
        let id = match sandbox {
            Some(id) => id,
            None => match create(&bin, job.agent, &tx) {
                Ok(id) => id,
                Err(error) => return done(Some(error)),
            },
        };
        match prompt(&bin, &id, &job, conversation.as_deref(), &tx) {
            Ok(()) => done(None),
            Err(error) => done(Some(error)),
        }
    });
}

fn prompt(bin: &PathBuf, sandbox: &str, job: &PromptJob, conversation: Option<&str>, tx: &UnboundedSender<CloudMsg>) -> Result<(), String> {
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
    let stdout = child.stdout.take().ok_or("no output from lizard")?;
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
    if ended || status.success() {
        return Ok(());
    }
    let json = rest.find('{').and_then(|at| serde_json::from_str::<Value>(&rest[at..]).ok());
    let mut error = error_message(json.as_ref(), status.code());
    if json.is_none() && !stderr.trim().is_empty() {
        error = stderr.trim().lines().last().unwrap_or("").to_string();
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
