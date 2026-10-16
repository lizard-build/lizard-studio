//! Slash metadata survives both discovery replies and name-only init events.

use gpui_kit::Context;
use serde_json::{Value, json};

use crate::cloud;

use super::ChatSession;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub arg_hint: String,
}

impl SlashCommand {
    pub fn named(name: &str) -> Self {
        Self { name: name.into(), description: String::new(), arg_hint: slash_hint(name).into() }
    }
}

fn slash_hint(name: &str) -> &'static str {
    match name.rsplit(':').next().unwrap_or(name) {
        "goal" => "<condition>",
        "compact" => "[extra instructions]",
        "batch" => "<change to make>",
        "loop" => "<interval> <command>",
        "schedule" => "<when> <task>",
        "deep-research" => "<research question>",
        "review" => "[PR number or URL]",
        "code-review" => "[low|medium|high|max] [--fix]",
        "debug" => "<what's broken>",
        "update-config" => "<setting change>",
        "remote-control" => "[session name | off]",
        _ => "",
    }
}

pub fn parse_commands<'a>(items: impl IntoIterator<Item = &'a Value>, previous: &[SlashCommand]) -> Vec<SlashCommand> {
    let mut commands: Vec<SlashCommand> = Vec::new();
    for item in items {
        let Some(name) = item.as_str().or_else(|| item.get("name").and_then(Value::as_str)) else { continue };
        let name = name.trim().trim_start_matches('/');
        if name.is_empty() { continue; }
        let mut command = commands.iter().chain(previous).find(|c| c.name == name).cloned()
            .unwrap_or_else(|| SlashCommand::named(name));
        if let Some(description) = item.get("description").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            command.description = description.into();
        }
        for key in ["argumentHint", "argument_hint", "argument-hint", "argHint", "arg_hint"] {
            if let Some(hint) = item.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                command.arg_hint = hint.into();
                break;
            }
        }
        if let Some(existing) = commands.iter_mut().find(|c| c.name == name) {
            *existing = command;
        } else {
            commands.push(command);
        }
    }
    commands
}

/// Keep a cleared cloud transcript cleared when it is opened again.
pub(super) fn cloud_log_since_clear(mut entries: Vec<Value>) -> Vec<Value> {
    if let Some(index) = entries.iter().rposition(|e| e.get("kind").and_then(Value::as_str) == Some("clear")) {
        entries.drain(..=index);
    }
    entries
}

impl ChatSession {
    /// Drop every piece of turn state so the next prompt cannot resume it.
    pub fn clear_session(&mut self, cx: &mut Context<Self>) {
        if self.meta.cloud {
            self.interrupt(cx);
            cloud::append_log(&self.meta.id, &json!({ "kind": "clear" }));
        }
        let generation = self.session_generation.wrapping_add(1);
        self.close();
        let mut meta = self.meta.clone();
        meta.session_id = None;
        meta.conversation_id = None;
        let commands = self.commands.clone();
        *self = Self::new(meta, self.host.clone(), cx);
        self.commands = commands;
        self.session_generation = generation;
        self.touch(cx);
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{SlashCommand, cloud_log_since_clear, parse_commands, slash_hint};
    use serde_json::json;

    #[test]
    fn parses_names_objects_and_duplicate_metadata() {
        let values = json!(["/compact", {"name":"skill", "description":"Do a thing", "argument-hint":"<target>"}, "skill", {}, ""]);
        let commands = parse_commands(values.as_array().unwrap(), &[]);
        assert_eq!(commands, vec![SlashCommand::named("compact"), SlashCommand {
            name: "skill".into(), description: "Do a thing".into(), arg_hint: "<target>".into(),
        }]);
        let names = json!(["skill"]);
        assert_eq!(parse_commands(names.as_array().unwrap(), &commands), vec![commands[1].clone()]);
    }

    #[test]
    fn cloud_history_starts_after_the_latest_clear() {
        let entries = vec![json!({"kind":"user"}), json!({"kind":"clear"}), json!({"kind":"event"}),
            json!({"kind":"clear"}), json!({"kind":"user", "text":"new session"})];
        assert_eq!(cloud_log_since_clear(entries.clone()), entries[4..]);
        assert_eq!(cloud_log_since_clear(entries[..4].to_vec()), Vec::<serde_json::Value>::new());
        assert_eq!(cloud_log_since_clear(entries[..1].to_vec()), entries[..1]);
    }

    #[test]
    fn hints_cover_namespaced_skills_and_host_overrides() {
        assert_eq!(slash_hint("plugin:review"), "[PR number or URL]");
        assert_eq!(slash_hint("unknown"), "");
        let values = json!([{"name":"review", "argumentHint":"<branch>"}]);
        assert_eq!(parse_commands(values.as_array().unwrap(), &[])[0].arg_hint, "<branch>");
    }
}
