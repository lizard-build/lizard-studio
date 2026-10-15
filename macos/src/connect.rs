//! Connecting an agent to the user's Lizard account, so cloud chats can run
//! it (`lizard agents`). Credentials belong to the account: connect once and
//! every sandbox uses them.
//!
//! - Claude subscription: the genuine `claude setup-token` runs here, in a
//!   pseudo-terminal (`script`) with an empty HOME, so nothing of the user's own
//!   Claude Code login changes. It opens the browser itself and takes the answer
//!   on a localhost callback; the one-year token it prints goes straight to
//!   `lizard agents add claude`.
//! - ChatGPT subscription: `lizard agents login chatgpt --json`, a device code
//!   the user enters on the page we open.
//! - API keys: `lizard agents add <kind>`, the key on stdin (never in argv).

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use futures::channel::mpsc::UnboundedSender;
use serde_json::Value;

use crate::cloud::{child_path, find_bin, lizard_bin};
use crate::store::Agent;

/// The platform's codes for a missing or expired credential.
pub const NOT_CONNECTED: &str = "AGENT_NOT_CONNECTED";
pub const REAUTH: &str = "AGENT_REAUTH_REQUIRED";

pub fn is_credential_error(code: Option<&str>) -> bool {
    matches!(code, Some(NOT_CONNECTED | REAUTH))
}

/// Where the Agents tab lives on the dashboard.
pub const AGENTS_PAGE: &str = "https://lizard.build/agents";

pub enum ConnectMsg {
    /// The sign-in page is open; `url` reopens it.
    Waiting { url: String },
    /// ChatGPT's device code, to enter on `url`.
    Code { url: String, code: String },
    /// Connected (the account or key hint), or why not.
    Done(Result<String, String>),
}

/// A running sign-in; dropping or cancelling it kills the process.
pub struct Flow {
    child: Arc<Mutex<Option<Child>>>,
    cancelled: Arc<AtomicBool>,
}

impl Flow {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().ok().and_then(|mut c| c.take()) {
            kill_group(&mut child);
        }
    }
}

impl Drop for Flow {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// `script` runs the CLI as its child; kill the whole group so no `claude`
/// is left holding the callback port.
fn kill_group(child: &mut Child) {
    let _ = Command::new("/bin/kill").arg("-9").arg(format!("-{}", child.id())).status();
    let _ = child.kill();
    let _ = child.wait();
}

pub fn claude_cli() -> Option<std::path::PathBuf> {
    find_bin("claude")
}

/// Which `lizard agents add` credential a pasted key is.
pub fn key_kind(agent: Agent, key: &str) -> Result<&'static str, &'static str> {
    let key = key.trim();
    match agent {
        Agent::Claude if key.starts_with("sk-ant-oat") => Ok("claude"),
        Agent::Claude if key.starts_with("sk-ant-") => Ok("anthropic"),
        Agent::Claude if key.starts_with("sk-or-") => Ok("openrouter"),
        Agent::Claude => Err("That isn't a Claude token, an Anthropic key or an OpenRouter key."),
        Agent::Codex if key.starts_with("sk-or-") => Ok("openrouter"),
        Agent::Codex if key.starts_with("sk-") => Ok("openai"),
        Agent::Codex => Err("That isn't an OpenAI key or an OpenRouter key."),
    }
}

fn error_text(json: Option<&Value>, fallback: &str) -> String {
    if json.and_then(|j| j.pointer("/error/code")).and_then(Value::as_str) == Some("NOT_AUTHENTICATED") {
        return "Sign in to Lizard first: run lizard login in a terminal.".into();
    }
    json.and_then(|j| j.pointer("/error/message").or_else(|| j.get("error")))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

/// `lizard agents add <kind>` with the key on stdin.
pub fn add_key(kind: &str, key: &str) -> Result<String, String> {
    let bin = lizard_bin().ok_or("Install Lizard CLI first: curl -fsSL https://lizard.build/install.sh | bash")?;
    let mut child = Command::new(bin)
        .args(["agents", "add", kind, "--json"])
        .env("PATH", child_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(key.trim().as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let json = text.find('{').and_then(|at| serde_json::from_str::<Value>(&text[at..]).ok());
    match json.as_ref().and_then(|j| j.get("account")).and_then(Value::as_str) {
        Some(account) if json.as_ref().and_then(|j| j.get("error")).is_none() => Ok(account.to_string()),
        _ => Err(error_text(json.as_ref(), "Lizard didn't take the key.")),
    }
}

/// Before a first cloud message: can this agent run on the account? `None`
/// when it can (or when the check itself failed — the prompt will say).
pub fn missing_credential(agent: Agent) -> Option<(&'static str, String)> {
    let bin = lizard_bin()?;
    let out = Command::new(bin).args(["agents", "status", "--json"]).env("PATH", child_path()).stdin(Stdio::null()).output().ok()?;
    let status: Value = serde_json::from_slice(&out.stdout).ok()?;
    let harness = status.get("harnesses")?.as_array()?.iter().find(|h| h.get("harness").and_then(Value::as_str) == Some(agent.wire()))?;
    if harness.get("ready").and_then(Value::as_bool) != Some(false) {
        return None;
    }
    let accepts: Vec<&str> = harness.get("accepts").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let reauth = status.get("credentials").and_then(Value::as_array).is_some_and(|creds| {
        creds.iter().any(|c| {
            accepts.contains(&c.get("kind").and_then(Value::as_str).unwrap_or(""))
                && c.get("status").and_then(Value::as_str) == Some("reauth_required")
        })
    });
    let label = harness.get("label").and_then(Value::as_str).unwrap_or(agent.label());
    Some(if reauth {
        (REAUTH, format!("{label} needs you to sign in again."))
    } else {
        (NOT_CONNECTED, format!("{label} isn't connected to your Lizard account yet."))
    })
}

/// Drop terminal escapes from the CLI's screen output.
fn plain(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameters, then one final byte in @..~
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: up to BEL or ESC \
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            Some('(' | ')') => {
                chars.next();
            }
            _ => {}
        }
    }
    out
}

fn token_in(text: &str) -> Option<String> {
    let at = text.find("sk-ant-oat01-")?;
    let token: String = text[at..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    // A token cut by the terminal's width would be stored and then refused.
    (token.len() >= 90).then_some(token)
}

fn sign_in_url(text: &str) -> Option<String> {
    let at = text.find("https://claude.")?;
    let url: String = text[at..].chars().take_while(|c| !c.is_whitespace() && *c != '\x07' && *c != '\x1b' && *c != '"' && *c != '\'').collect();
    (url.contains("oauth/authorize?") && url.contains("state=")).then_some(url)
}

/// Run `claude setup-token` and connect the token it prints.
pub fn claude_sign_in(tx: UnboundedSender<ConnectMsg>) -> Flow {
    let slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let cancelled = Arc::new(AtomicBool::new(false));
    let flow = Flow { child: slot.clone(), cancelled: cancelled.clone() };
    thread::spawn(move || {
        let done = |r: Result<String, String>| {
            if !cancelled.load(Ordering::SeqCst) {
                let _ = tx.unbounded_send(ConnectMsg::Done(r));
            }
        };
        if claude_cli().is_none() {
            return done(Err("Claude Code isn't installed on this Mac.".into()));
        }
        let home = std::env::temp_dir().join(format!("lizard-studio-claude-{}-{}", std::process::id(), crate::store::now_ms()));
        if let Err(e) = std::fs::create_dir_all(&home) {
            return done(Err(e.to_string()));
        }
        let cleanup = |home: &std::path::Path| {
            let _ = std::fs::remove_dir_all(home);
        };
        let mut command = Command::new("/usr/bin/script");
        // A wide terminal: the CLI wraps the ~108-character token at its width.
        command
            .args(["-q", "/dev/null", "/bin/sh", "-c", "stty cols 500 rows 50; exec claude setup-token"])
            .env_clear()
            .env("PATH", child_path())
            .env("HOME", &home)
            .env("TERM", "xterm-256color")
            .env("LANG", "en_US.UTF-8")
            .env("DISABLE_AUTOUPDATER", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Ok(tmp) = std::env::var("TMPDIR") {
            command.env("TMPDIR", tmp);
        }
        {
            use std::os::unix::process::CommandExt as _;
            command.process_group(0);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => {
                cleanup(&home);
                return done(Err(e.to_string()));
            }
        };
        let mut stdout = child.stdout.take();
        // Held open: an EOF here would reach the CLI as Ctrl-D.
        let _stdin = child.stdin.take();
        if let Ok(mut s) = slot.lock() {
            *s = Some(child);
        }
        // Ten minutes, as long as Anthropic's sign-in stays usable.
        {
            let slot = slot.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(600));
                if let Some(mut child) = slot.lock().ok().and_then(|mut c| c.take()) {
                    kill_group(&mut child);
                }
            });
        }
        let mut seen = String::new();
        let mut buf = [0u8; 8192];
        let mut told = false;
        let mut token = None;
        if let Some(out) = stdout.as_mut() {
            loop {
                let n = match out.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                seen.push_str(&String::from_utf8_lossy(&buf[..n]));
                if seen.len() > 400_000 {
                    seen.drain(..200_000);
                }
                if !told {
                    if let Some(url) = sign_in_url(&seen) {
                        told = true;
                        let _ = tx.unbounded_send(ConnectMsg::Waiting { url });
                    }
                }
                let text = plain(&seen);
                if let Some(t) = token_in(&text) {
                    token = Some(t);
                    break;
                }
                if text.contains("OAuth error") || text.contains("Press Enter to retry") {
                    break;
                }
            }
        }
        if let Some(mut child) = slot.lock().ok().and_then(|mut c| c.take()) {
            kill_group(&mut child);
        }
        cleanup(&home);
        if cancelled.load(Ordering::SeqCst) {
            return;
        }
        match token {
            Some(token) => done(add_key("claude", &token).map_err(|e| format!("Signed in, but Lizard didn't take the token: {e}"))),
            None => {
                let text = plain(&seen);
                let said = text.split_whitespace().collect::<Vec<_>>().join(" ");
                let tail: String = said.chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
                done(Err(if text.contains("OAuth error") {
                    "Claude didn't finish the sign-in. Try again.".into()
                } else if tail.is_empty() {
                    "Claude Code stopped before the sign-in finished.".into()
                } else {
                    format!("Claude Code stopped before the sign-in finished: {tail}")
                }))
            }
        }
    });
    flow
}

/// `lizard agents login chatgpt --json`: a device code, then a wait for approval.
pub fn chatgpt_sign_in(tx: UnboundedSender<ConnectMsg>) -> Flow {
    let slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let cancelled = Arc::new(AtomicBool::new(false));
    let flow = Flow { child: slot.clone(), cancelled: cancelled.clone() };
    thread::spawn(move || {
        let done = |r: Result<String, String>| {
            if !cancelled.load(Ordering::SeqCst) {
                let _ = tx.unbounded_send(ConnectMsg::Done(r));
            }
        };
        let Some(bin) = lizard_bin() else {
            return done(Err("Install Lizard CLI first: curl -fsSL https://lizard.build/install.sh | bash".into()));
        };
        let mut command = Command::new(bin);
        command.args(["agents", "login", "chatgpt", "--json"]).env("PATH", child_path()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        {
            use std::os::unix::process::CommandExt as _;
            command.process_group(0);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => return done(Err(e.to_string())),
        };
        let stdout = child.stdout.take();
        if let Ok(mut s) = slot.lock() {
            *s = Some(child);
        }
        let started = Instant::now();
        let mut result: Result<String, String> = Err("The sign-in ended before it was approved.".into());
        if let Some(stdout) = stdout {
            // The CLI prints whole JSON objects, one after another.
            for value in serde_json::Deserializer::from_reader(stdout).into_iter::<Value>() {
                let Ok(value) = value else { break };
                if value.get("error").is_some() {
                    result = Err(error_text(Some(&value), "The sign-in failed."));
                    break;
                }
                if let (Some(url), Some(code)) = (
                    value.get("verificationUrl").and_then(Value::as_str),
                    value.get("userCode").and_then(Value::as_str),
                ) {
                    let _ = tx.unbounded_send(ConnectMsg::Code { url: url.to_string(), code: code.to_string() });
                    continue;
                }
                if value.get("status").and_then(Value::as_str) == Some("connected") {
                    let who = value.get("email").and_then(Value::as_str).unwrap_or("ChatGPT");
                    result = Ok(who.to_string());
                    break;
                }
            }
        }
        if let Some(mut child) = slot.lock().ok().and_then(|mut c| c.take()) {
            kill_group(&mut child);
        }
        if result.is_err() && started.elapsed() > Duration::from_secs(14 * 60) {
            result = Err("The code expired before it was approved. Sign in again.".into());
        }
        done(result);
    });
    flow
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_escapes_and_finds_a_whole_token() {
        let tail = "a".repeat(95);
        let screen = format!("\x1b[2G\x1b[38;5;246mYour OAuth token:\x1b[39m\r\n\x1b]8;;x\x07sk-ant-oat01-{tail}\x1b[0m\r\n");
        assert_eq!(token_in(&plain(&screen)), Some(format!("sk-ant-oat01-{tail}")));
        assert_eq!(token_in("sk-ant-oat01-short"), None);
    }

    #[test]
    fn tells_keys_apart() {
        assert_eq!(key_kind(Agent::Claude, "sk-ant-oat01-x"), Ok("claude"));
        assert_eq!(key_kind(Agent::Claude, "sk-ant-api03-x"), Ok("anthropic"));
        assert_eq!(key_kind(Agent::Claude, "sk-or-v1-x"), Ok("openrouter"));
        assert_eq!(key_kind(Agent::Codex, "sk-proj-x"), Ok("openai"));
        assert!(key_kind(Agent::Codex, "hello").is_err());
    }
}
