//! Background work outlives its launch tool result; only completion notices
//! or the host's process probes can finish a background shell.

use std::collections::HashMap;

use gpui_kit::Context;
use serde_json::{Value, json};

use super::{ChatSession, result_text};
use crate::store::{Agent, now_ms};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    Agent,
    Shell,
    Preview,
}

#[derive(Clone)]
pub struct Task {
    pub tool_id: String,
    pub kind: TaskKind,
    pub handle: Option<String>,
    pub label: String,
    pub description: String,
    pub command: String,
    pub output_file: Option<String>,
    pub running: bool,
    pub failed: bool,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub stopping_at: Option<u64>,
    pub is_server: bool,
    pub url: Option<String>,
    pub in_tokens: u64,
    pub out_tokens: u64,
    pub tool_uses: usize,
    pub last_tool: String,
    /// Cumulative assistant messages replace their earlier copy, preserving order.
    pub messages: Vec<Value>,
    pub results: HashMap<String, (String, bool)>,
    dead_strikes: u8,
}

impl Task {
    fn finish(&mut self, failed: bool, at: u64) {
        if self.running {
            self.running = false;
            self.failed = failed;
            self.ended_at = Some(at);
            self.stopping_at = None;
        }
    }

    pub fn port(&self) -> Option<u16> {
        let url = self.url.as_deref()?.trim_start_matches("http://").trim_start_matches("https://");
        url.split('/').next()?.split_once(':')?.1.parse().ok()
    }

    fn apply_url(&mut self, text: &str) {
        if self.url.is_none() {
            self.url = preview_url(text);
            self.is_server |= self.url.is_some();
        }
    }

    fn note_message(&mut self, message: &Value) {
        let Some(id) = message.get("id").and_then(Value::as_str) else { return };
        if let Some(old) = self.messages.iter_mut().find(|m| m.get("id").and_then(Value::as_str) == Some(id)) {
            *old = message.clone();
        } else {
            self.messages.push(message.clone());
        }
        self.in_tokens = 0;
        self.out_tokens = 0;
        self.tool_uses = 0;
        self.last_tool.clear();
        for message in &self.messages {
            self.in_tokens = self.in_tokens.max(message.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0));
            self.out_tokens += message.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0);
            for block in message.get("content").and_then(Value::as_array).into_iter().flatten() {
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    self.tool_uses += 1;
                    self.last_tool = block.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                }
            }
        }
    }

    fn note_alive(&mut self, alive: bool, at: u64) {
        if !self.running { return; }
        self.dead_strikes = if alive { 0 } else { self.dead_strikes.saturating_add(1) };
        if self.dead_strikes >= 2 { self.finish(false, at); }
    }
}

pub(super) fn note_task_start(tasks: &mut Vec<Task>, block: &Value, at: u64) {
    let id = block.get("id").and_then(Value::as_str).unwrap_or("");
    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
    let input = &block["input"];
    let kind = match name {
        "Task" | "Agent" => TaskKind::Agent,
        "Bash" if input["run_in_background"].as_bool() == Some(true) => TaskKind::Shell,
        n if n.ends_with("preview_start") => TaskKind::Preview,
        _ => return,
    };
    if id.is_empty() || tasks.iter().any(|t| t.tool_id == id) { return; }
    let command = input["command"].as_str().unwrap_or("").to_string();
    let is_server = kind == TaskKind::Preview || (kind == TaskKind::Shell && is_dev_server(&command));
    let label = match kind {
        TaskKind::Agent => input["description"].as_str().or(input["subagent_type"].as_str()).unwrap_or("Agent").to_string(),
        TaskKind::Shell => command.lines().next().filter(|s| !s.is_empty()).unwrap_or("Background command").chars().take(120).collect(),
        TaskKind::Preview => input["name"].as_str().unwrap_or("Preview").to_string(),
    };
    tasks.push(Task {
        tool_id: id.into(), kind, handle: None, label,
        description: input["subagent_type"].as_str().unwrap_or("").into(),
        url: is_server.then(|| command_port(&command).map(|p| format!("localhost:{p}"))).flatten(),
        command, is_server, output_file: None, running: true, failed: false,
        started_at: at, ended_at: None, stopping_at: None, in_tokens: 0, out_tokens: 0,
        tool_uses: 0, last_tool: String::new(), messages: Vec::new(), results: HashMap::new(), dead_strikes: 0,
    });
}

pub(super) fn note_task_result(tasks: &mut [Task], tool_id: &str, name: &str, input: &Value, output: &str, is_error: bool, at: u64) {
    if let Some(task) = tasks.iter_mut().find(|t| t.tool_id == tool_id) {
        match task.kind {
            TaskKind::Agent => {
                if let Some(handle) = after_label(output, "agentId:").filter(|_| !is_error) {
                    task.handle = Some(handle);
                } else {
                    task.finish(is_error, at);
                }
            }
            TaskKind::Shell => {
                task.handle = after_label(output, "ID:").or_else(|| output.split_whitespace().find(|w| w.starts_with("bash_")).map(|s| s.trim_matches(|c: char| !is_id(c)).to_string()));
                task.output_file = output.split_once("Output is being written to:").and_then(|(_, rest)| {
                    let rest = rest.trim_start();
                    Some(rest.get(..rest.find(".output")? + 7)?.to_string())
                });
                task.apply_url(output);
                if is_error { task.finish(true, at); }
            }
            TaskKind::Preview => {
                if let Ok(value) = serde_json::from_str::<Value>(output) {
                    task.handle = value["serverId"].as_str().map(str::to_string);
                    if let Some(port) = value["port"].as_u64().filter(|p| *p > 0 && *p <= 65535) {
                        task.url = Some(format!("localhost:{port}"));
                    }
                }
                task.apply_url(output);
                if is_error { task.finish(true, at); }
            }
        }
        return;
    }
    let shell = input["bash_id"].as_str().or(input["shell_id"].as_str());
    let server = input["serverId"].as_str().or(input["server_id"].as_str());
    for task in tasks.iter_mut().filter(|t| t.running) {
        if shell.is_some() && task.handle.as_deref() == shell && matches!(name, "KillShell" | "BashOutput") {
            task.apply_url(output);
            if name == "KillShell" || completed(output) { task.finish(name == "BashOutput" && is_error, at); }
        }
        if name.ends_with("preview_stop") && server.is_some() && task.handle.as_deref() == server && !is_error {
            task.finish(false, at);
        }
    }
}

pub(super) fn scan_task_notice(tasks: &mut [Task], text: &str, at: u64) {
    if !completed(text) { return; }
    let failed = text.to_ascii_lowercase().contains("failed");
    for task in tasks.iter_mut().filter(|t| t.running) {
        if task.handle.as_deref().is_some_and(|id| mentions_id(text, id)) {
            task.finish(failed, at);
        }
    }
}

fn is_id(c: char) -> bool { c.is_ascii_alphanumeric() || c == '_' || c == '-' }

fn after_label(text: &str, label: &str) -> Option<String> {
    let at = text.to_ascii_lowercase().find(&label.to_ascii_lowercase())? + label.len();
    let id: String = text[at..].trim_start().chars().take_while(|c| is_id(*c)).collect();
    (!id.is_empty()).then_some(id)
}

fn mentions_id(text: &str, id: &str) -> bool {
    !id.is_empty() && text.match_indices(id).any(|(at, _)| {
        text[..at].chars().next_back().is_none_or(|c| !is_id(c))
            && text[at + id.len()..].chars().next().is_none_or(|c| !is_id(c))
    })
}

fn completed(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["completed", "complete", "exited", "finished", "killed", "terminated", "stopped", "failed"].iter()
        .any(|w| mentions_id(&lower, w)) || lower.contains("exit code") || lower.contains("no longer running")
}

/// Match command words, so a filename containing "vite" isn't a preview server.
fn command_words(command: &str) -> Vec<String> {
    command.split(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')'))
        .filter(|s| !s.is_empty()).map(|s| s.trim_matches(['\'', '"']).to_ascii_lowercase()).collect()
}

fn is_dev_server(command: &str) -> bool {
    let words = command_words(command);
    words.iter().enumerate().any(|(i, w)| {
        let next = words.get(i + 1).map(String::as_str).unwrap_or("");
        if matches!(w.as_str(), "npm" | "pnpm" | "yarn" | "bun") {
            let script = if next == "run" { words.get(i + 2).map(String::as_str).unwrap_or("") } else { next };
            return matches!(script, "dev" | "start" | "serve" | "preview");
        }
        matches!(w.as_str(), "vite" | "next" | "nuxt" | "astro" | "remix" | "webpack" | "webpack-dev-server" | "parcel" | "serve" | "http-server" | "live-server" | "browser-sync" | "storybook" | "uvicorn" | "gunicorn")
            || matches!((w.as_str(), next), ("ng", "serve") | ("remotion", "studio" | "preview") | ("php", "-s") | ("rails", "s") | ("flask", "run"))
            || (matches!(w.as_str(), "python" | "python3") && next == "-m" && words.get(i + 2).is_some_and(|w| w == "http.server"))
            || (w == "rollup" && next.starts_with('-') && next.contains('w'))
    })
}

fn command_port(command: &str) -> Option<u16> {
    let words = command_words(command);
    for (i, word) in words.iter().enumerate() {
        let explicit = word.strip_prefix("--port=").or_else(|| word.strip_prefix("port=")).or_else(|| word.strip_prefix("-p="))
            .or_else(|| matches!(word.as_str(), "--port" | "-p" | "port" | "http.server").then(|| words.get(i + 1).map(String::as_str)).flatten());
        if let Some(port) = explicit.and_then(|p| p.trim_matches(['\'', '"']).parse::<u16>().ok()).filter(|p| *p > 0) { return Some(port); }
    }
    for (word, port) in [("vite", 5173), ("next", 3000), ("nuxt", 3000), ("astro", 4321), ("remix", 3000), ("ng", 4200), ("webpack", 8080), ("webpack-dev-server", 8080), ("parcel", 1234), ("storybook", 6006), ("gatsby", 8000), ("http-server", 8080), ("live-server", 8080), ("browser-sync", 3000), ("remotion", 3000), ("rails", 3000), ("flask", 5000), ("uvicorn", 8000), ("gunicorn", 8000)] {
        if words.iter().any(|w| w == word) { return Some(port); }
    }
    None
}

fn preview_url(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for (at, _) in lower.match_indices("http") {
        let tail = &text[at..];
        let host = if lower[at..].starts_with("https://") { &tail[8..] } else if lower[at..].starts_with("http://") { &tail[7..] } else { continue };
        let url = host.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '\u{1b}')).next().unwrap_or("").trim_end_matches('/');
        let hostname = url.split([':', '/']).next().unwrap_or("");
        if matches!(hostname.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "0.0.0.0") {
            return Some(url.to_string());
        }
    }
    let at = lower.find("localhost:")?;
    let port: String = text[at + 10..].chars().take_while(char::is_ascii_digit).collect();
    port.parse::<u16>().ok().filter(|p| *p > 0).map(|p| format!("localhost:{p}"))
}

impl ChatSession {
    pub fn task_counts(&self) -> (usize, usize) {
        (self.tasks.iter().filter(|t| t.running).count(), self.tasks.len())
    }

    pub(super) fn note_agent_activity(&mut self, parent: &str, event: &Value) {
        let Some(task) = self.tasks.iter_mut().find(|t| t.tool_id == parent && t.kind == TaskKind::Agent) else { return };
        match event["type"].as_str() {
            Some("assistant") => task.note_message(&event["message"]),
            Some("user") => {
                for block in event.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                    if block["type"].as_str() == Some("tool_result") {
                        if let Some(id) = block["tool_use_id"].as_str() {
                            task.results.insert(id.into(), (result_text(block.get("content")), block["is_error"].as_bool().unwrap_or(false)));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    pub(super) fn finish_agents(&mut self, at: u64) {
        for task in self.tasks.iter_mut().filter(|t| t.kind == TaskKind::Agent) { task.finish(false, at); }
    }

    pub fn stop_task(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(task) = self.tasks.iter_mut().find(|t| t.tool_id == id && t.running && t.stopping_at.is_none()) else { return };
        if task.kind == TaskKind::Agent {
            // Like the panel, agent Stop interrupts the session, even between turns.
            if self.meta.cloud { self.interrupt(cx); } else { self.send(json!({ "type": "interrupt" })); }
            return;
        }
        task.stopping_at = Some(now_ms());
        let message = json!({ "type": "killShell", "taskId": task.tool_id, "shellId": task.handle,
            "command": task.command, "outputFile": task.output_file, "port": task.port() });
        self.interrupt(cx);
        self.send(message);
        cx.notify();
    }

    /// A launch gets ten seconds to appear; two absent snapshots finish it.
    pub fn probe_tasks(&self, ports: bool, alive: bool, at: u64) {
        if self.meta.cloud || self.meta.agent != Agent::Claude { return; }
        let shells: Vec<_> = self.tasks.iter().filter(|t| t.running && t.kind == TaskKind::Shell).collect();
        if ports {
            for task in shells.iter().filter(|t| t.is_server && t.url.is_none()) {
                self.send(json!({ "type": "probeShellPort", "taskId": task.tool_id, "command": task.command }));
            }
        }
        if alive {
            let tasks: Vec<_> = shells.iter().filter(|t| at.saturating_sub(t.started_at) >= 10_000).map(|t| {
                json!({ "taskId": t.tool_id, "command": t.command, "outputFile": t.output_file, "port": t.port() })
            }).collect();
            // The host bounds each request to 32 tasks.
            for chunk in tasks.chunks(32) { self.send(json!({ "type": "probeShells", "tasks": chunk })); }
        }
    }

    pub fn expire_task_stops(&mut self, at: u64, cx: &mut Context<Self>) {
        let mut expired = false;
        for task in &mut self.tasks {
            if task.stopping_at.is_some_and(|t| at.saturating_sub(t) >= 6000) {
                task.stopping_at = None;
                expired = true;
            }
        }
        if expired { self.notice(true, "Couldn't stop the task — the host may be outdated. Reload to update it.", cx); }
    }

    pub(super) fn on_task_message(&mut self, message: &Value, cx: &mut Context<Self>) {
        let at = now_ms();
        if message["type"].as_str() == Some("shellsAlive") {
            if let Some(alive) = message["alive"].as_object() {
                for task in &mut self.tasks {
                    if let Some(alive) = alive.get(&task.tool_id).and_then(Value::as_bool) { task.note_alive(alive, at); }
                }
            }
        } else if let Some(task) = self.tasks.iter_mut().find(|t| Some(t.tool_id.as_str()) == message["taskId"].as_str()) {
            match message["type"].as_str() {
                Some("shellKilled") => {
                    if message["ok"].as_bool() == Some(true) || message["error"].as_str().is_some_and(|e| e.to_ascii_lowercase().contains("not found")) {
                        task.finish(false, at);
                    } else {
                        task.stopping_at = None;
                        self.notice(true, message["error"].as_str().unwrap_or("Couldn't stop the task."), cx);
                    }
                }
                Some("shellPort") if task.url.is_none() => {
                    if let Some(port) = message["port"].as_u64().filter(|p| *p > 0 && *p <= 65535) {
                        task.url = Some(format!("localhost:{port}"));
                        task.is_server = true;
                    }
                }
                _ => {}
            }
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use super::{command_port, is_dev_server, mentions_id, note_task_result, note_task_start, preview_url, scan_task_notice};

    #[test]
    fn detects_servers_and_explicit_or_known_ports() {
        for command in ["npm run dev", "pnpm start", "bun run preview", "npx vite", "python3 -m http.server 8000", "flask run", "php -S localhost:8080"] {
            assert!(is_dev_server(command), "{command}");
        }
        for command in ["npm run build", "cat invite.txt", "echo nextjs"] {
            assert!(!is_dev_server(command), "{command}");
        }
        assert_eq!(command_port("npm run dev"), None);
        assert_eq!(command_port("next dev --port 3210"), Some(3210));
        assert_eq!(command_port("vite --port=4000"), Some(4000));
        assert_eq!(command_port("PORT=4567 npm start"), Some(4567));
        assert_eq!(command_port("next dev -p 5555"), Some(5555));
        assert_eq!(command_port("python3 -m http.server 9000"), Some(9000));
        assert_eq!(command_port("npx astro dev"), Some(4321));
        assert_eq!(command_port("npm run dev --port 99999"), None);
    }

    #[test]
    fn extracts_only_local_preview_links() {
        assert_eq!(preview_url("Local: http://localhost:5173/\n"), Some("localhost:5173".into()));
        assert_eq!(preview_url("https://127.0.0.1:3000/app/"), Some("127.0.0.1:3000/app".into()));
        assert_eq!(preview_url("http://0.0.0.0:8080"), Some("0.0.0.0:8080".into()));
        assert_eq!(preview_url("Ready on localhost:9000"), Some("localhost:9000".into()));
        assert_eq!(preview_url("https://localhost.example.com:1234"), None);
        assert_eq!(preview_url("https://example.com"), None);
    }

    #[test]
    fn launch_ack_keeps_shell_running_and_retains_exact_handles() {
        let mut tasks = Vec::new();
        let block = json!({"id":"launch", "name":"Bash", "input":{"command":"npm run dev", "run_in_background":true}});
        note_task_start(&mut tasks, &block, 1000);
        note_task_start(&mut tasks, &block, 2000);
        assert_eq!(tasks.len(), 1);
        note_task_result(&mut tasks, "launch", "Bash", &block["input"], "Running in background with ID: bash_1\nOutput is being written to: /tmp/task output.output\nhttp://localhost:3210/", false, 2000);
        let task = &tasks[0];
        assert!(task.running);
        assert_eq!(task.started_at, 1000);
        assert_eq!(task.handle.as_deref(), Some("bash_1"));
        assert_eq!(task.output_file.as_deref(), Some("/tmp/task output.output"));
        assert_eq!(task.url.as_deref(), Some("localhost:3210"));
        assert_eq!(task.port(), Some(3210));
        scan_task_notice(&mut tasks, "bash_1 is still running", 2500);
        scan_task_notice(&mut tasks, "bash_10 completed", 3000);
        assert!(tasks[0].running);
        scan_task_notice(&mut tasks, "bash_1 completed", 5000);
        assert!(!tasks[0].running);
        assert_eq!(tasks[0].ended_at, Some(5000));
        scan_task_notice(&mut tasks, "bash_1 completed", 7000);
        assert_eq!(tasks[0].ended_at, Some(5000));
    }

    #[test]
    fn async_agent_finishes_on_its_notification() {
        let mut tasks = Vec::new();
        note_task_start(&mut tasks, &json!({"id":"a", "name":"Agent", "input":{"description":"Review code", "subagent_type":"Explore"}}), 1000);
        assert_eq!(tasks[0].label, "Review code");
        note_task_result(&mut tasks, "a", "Agent", &json!({}), "Async agent launched. agentId: agent_1", false, 2000);
        assert!(tasks[0].running);
        scan_task_notice(&mut tasks, "<task-id>agent_1</task-id><status>failed</status>", 6000);
        assert!(!tasks[0].running);
        assert!(tasks[0].failed);
        assert_eq!(tasks[0].ended_at, Some(6000));
    }

    #[test]
    fn foreground_agent_and_launch_errors_finish_immediately() {
        let mut tasks = Vec::new();
        note_task_start(&mut tasks, &json!({"id":"a", "name":"Task", "input":{}}), 1000);
        note_task_result(&mut tasks, "a", "Task", &json!({}), "Review complete", false, 8000);
        assert!(!tasks[0].running);
        assert!(!tasks[0].failed);
        assert_eq!(tasks[0].ended_at, Some(8000));
        note_task_start(&mut tasks, &json!({"id":"s", "name":"Bash", "input":{"run_in_background":true}}), 1000);
        note_task_result(&mut tasks, "s", "Bash", &json!({}), "Permission denied", true, 2000);
        assert!(tasks[1].failed);
        assert!(!tasks[1].running);
    }

    #[test]
    fn cumulative_agent_messages_do_not_double_count() {
        let mut tasks = Vec::new();
        note_task_start(&mut tasks, &json!({"id":"a", "name":"Agent", "input":{}}), 1000);
        let task = &mut tasks[0];
        task.note_message(&json!({"id":"m1", "usage":{"input_tokens":100,"output_tokens":5}, "content":[{"type":"text","text":"Reviewing"}]}));
        let cumulative = json!({"id":"m1", "usage":{"input_tokens":100,"output_tokens":15}, "content":[{"type":"text","text":"Reviewing"},{"type":"tool_use","id":"t1","name":"Read"}]});
        task.note_message(&cumulative);
        task.note_message(&cumulative);
        task.note_message(&json!({"id":"m2", "usage":{"input_tokens":200,"output_tokens":20}, "content":[{"type":"tool_use","id":"t2","name":"Bash"}]}));
        assert_eq!(task.messages.len(), 2);
        assert_eq!(task.in_tokens, 200);
        assert_eq!(task.out_tokens, 35);
        assert_eq!(task.tool_uses, 2);
        assert_eq!(task.last_tool, "Bash");
    }

    #[test]
    fn liveness_requires_two_consecutive_misses() {
        let mut tasks = Vec::new();
        note_task_start(&mut tasks, &json!({"id":"s", "name":"Bash", "input":{"run_in_background":true}}), 1000);
        let task = &mut tasks[0];
        task.note_alive(false, 12000);
        assert!(task.running);
        task.note_alive(true, 17000);
        task.note_alive(false, 22000);
        assert!(task.running);
        task.note_alive(false, 27000);
        assert!(!task.running);
        assert_eq!(task.ended_at, Some(27000));
        task.note_alive(true, 32000);
        assert!(!task.running);
    }

    #[test]
    fn poll_and_kill_results_resolve_the_original_shell() {
        let mut tasks = Vec::new();
        note_task_start(&mut tasks, &json!({"id":"s", "name":"Bash", "input":{"run_in_background":true}}), 1000);
        note_task_result(&mut tasks, "s", "Bash", &json!({}), "ID: bash_1", false, 2000);
        note_task_result(&mut tasks, "poll", "BashOutput", &json!({"bash_id":"bash_1"}), "http://localhost:8080/", false, 3000);
        assert!(tasks[0].running);
        assert_eq!(tasks[0].port(), Some(8080));
        note_task_result(&mut tasks, "poll", "BashOutput", &json!({"bash_id":"bash_1"}), "Process exited with exit code 1", true, 4000);
        assert!(!tasks[0].running);
        assert!(tasks[0].failed);
    }

    #[test]
    fn identifiers_match_whole_tokens() {
        assert!(mentions_id("<task-id>bash_1</task-id>", "bash_1"));
        assert!(!mentions_id("bash_10 completed", "bash_1"));
        assert!(!mentions_id("bash_1-extra", "bash_1"));
        assert!(!mentions_id("", ""));
    }
}
