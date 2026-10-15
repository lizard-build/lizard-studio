//! The link to the Lizard Studio host.
//!
//! The Chrome panel reaches its agents through `router.mjs`, which Chrome
//! launches as a native-messaging host. This app launches the very same file
//! and speaks the very same wire format on its stdio: a 4-byte little-endian
//! length, then that many bytes of UTF-8 JSON. On macOS the router runs as a
//! thin bridge to a per-window session daemon, picked by the `windowId` in the
//! first message. The app claims its own id, so its chats live in their own
//! daemon and never mix with a browser window's.

use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context as _, Result, anyhow};
use futures::channel::mpsc::UnboundedSender;
use serde_json::{Value, json};

/// The session daemon this app attaches to. Chrome window ids are small
/// counters; this one is far outside their range.
pub const APP_WINDOW_ID: u64 = 4_242_424_242;

/// Same bound as hostkit.mjs: a corrupt prefix must not allocate forever.
const MAX_FRAME: usize = 64 * 1024 * 1024;

pub enum HostEvent {
    Message(Value),
    /// The router exited or closed its pipe. Live turns keep running in the
    /// daemon; reconnecting replays them.
    Disconnected(String),
}

/// Where the installed host lives. `LIZARD_STUDIO_HOST_DIR` points the app
/// at another copy (a branch build), which then runs its own daemon there.
pub fn host_dir() -> PathBuf {
    match std::env::var_os("LIZARD_STUDIO_HOST_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => home_dir().join(".lizard-studio").join("host"),
    }
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Whether the host has been installed (`npx @lizard-build/lizard-studio-host install`).
pub fn host_installed() -> bool {
    host_dir().join("router.mjs").exists()
}

/// The Node binary the installer resolved, since an app launched from Finder
/// gets a bare PATH that misses Homebrew and nvm.
fn node_path(dir: &Path) -> Option<PathBuf> {
    let config = std::fs::read_to_string(dir.join("host-config.json")).ok()?;
    let config: Value = serde_json::from_str(&config).ok()?;
    let node = PathBuf::from(config.get("nodePath")?.as_str()?);
    node.exists().then_some(node)
}

pub struct HostConnection {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

impl HostConnection {
    pub fn spawn(events: UnboundedSender<HostEvent>) -> Result<Self> {
        let dir = host_dir();
        let router = dir.join("router.mjs");
        if !router.exists() {
            return Err(anyhow!("The Lizard Studio host is not installed."));
        }
        let mut command = match node_path(&dir) {
            Some(node) => {
                let mut c = Command::new(node);
                c.arg(&router);
                c
            }
            None => {
                let mut c = Command::new("/bin/sh");
                c.arg(dir.join("launch.sh"));
                c
            }
        };
        let mut child = command
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("start the Lizard Studio host")?;

        let stdin = Arc::new(Mutex::new(child.stdin.take().context("host stdin")?));
        let stdout = child.stdout.take().context("host stdout")?;

        thread::Builder::new()
            .name("host-reader".into())
            .spawn(move || {
                let reason = read_frames(stdout, &events);
                let _ = events.unbounded_send(HostEvent::Disconnected(reason));
            })?;

        let connection = Self { child, stdin };
        connection.send(&json!({ "type": "runtimeAttach", "windowId": APP_WINDOW_ID }))?;
        Ok(connection)
    }

    pub fn send(&self, message: &Value) -> Result<()> {
        let body = serde_json::to_vec(message)?;
        let mut frame = Vec::with_capacity(body.len() + 4);
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        let mut stdin = self.stdin.lock().map_err(|_| anyhow!("host pipe poisoned"))?;
        stdin.write_all(&frame)?;
        stdin.flush()?;
        Ok(())
    }
}

impl Drop for HostConnection {
    fn drop(&mut self) {
        // Only the bridge dies here. The daemon behind it keeps running turns
        // and quits on its own once it is idle.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_frames(stdout: impl Read, events: &UnboundedSender<HostEvent>) -> String {
    let mut reader = BufReader::with_capacity(1 << 16, stdout);
    let mut header = [0u8; 4];
    loop {
        if let Err(err) = reader.read_exact(&mut header) {
            return format!("host closed: {err}");
        }
        let len = u32::from_le_bytes(header) as usize;
        if len > MAX_FRAME {
            return format!("host sent an impossible frame length {len}");
        }
        let mut body = vec![0u8; len];
        if let Err(err) = reader.read_exact(&mut body) {
            return format!("host closed mid-frame: {err}");
        }
        let Some(value) = parse_frame(&body) else { continue };
        if events.unbounded_send(HostEvent::Message(value)).is_err() {
            return "app closed".into();
        }
    }
}

/// Stand-in for half of a UTF-16 surrogate pair, followed by its four hex digits.
pub const SURROGATE_MARK: char = '\u{FFF9}';

/// The host splits a long transcript into parts by UTF-16 offset, so an emoji
/// can be cut in two and each half arrives as a lone `\uD83D`-style escape,
/// which strict JSON parsers refuse. Such halves are kept as marks here and
/// joined again once every part is in (`chat::restore_surrogates`).
fn parse_frame(body: &[u8]) -> Option<Value> {
    if let Ok(value) = serde_json::from_slice(body) {
        return Some(value);
    }
    let text = std::str::from_utf8(body).ok()?;
    serde_json::from_str(&mark_lone_surrogates(text)).ok()
}

fn mark_lone_surrogates(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < bytes.len() && bytes[j] == b'\\' {
            j += 1;
        }
        // An odd run of backslashes ends in a real escape.
        if (j - i) % 2 == 1 && j + 5 <= bytes.len() && bytes[j] == b'u' {
            if let Ok(unit) = u16::from_str_radix(&text[j + 1..j + 5], 16) {
                if (0xD800..=0xDFFF).contains(&unit) {
                    out.push_str(&text[last..j - 1]);
                    out.push_str("\\ufff9");
                    out.push_str(&text[j + 1..j + 5]);
                    last = j + 5;
                    i = j + 5;
                    continue;
                }
            }
        }
        i = j;
    }
    out.push_str(&text[last..]);
    out
}

/// The app's handle on the host. Messages sent while the router is down wait
/// here and go out, in order, once it is back.
#[derive(Default)]
pub struct HostLink {
    connection: std::cell::RefCell<Option<HostConnection>>,
    outbox: std::cell::RefCell<Vec<Value>>,
}

impl HostLink {
    pub fn send(&self, message: Value) {
        if let Some(connection) = self.connection.borrow().as_ref() {
            if connection.send(&message).is_ok() {
                return;
            }
        }
        self.outbox.borrow_mut().push(message);
    }

    pub fn is_connected(&self) -> bool {
        self.connection.borrow().is_some()
    }

    pub fn attach(&self, connection: HostConnection) {
        for message in self.outbox.borrow_mut().drain(..) {
            let _ = connection.send(&message);
        }
        *self.connection.borrow_mut() = Some(connection);
    }

    pub fn detach(&self) {
        self.connection.borrow_mut().take();
    }
}
