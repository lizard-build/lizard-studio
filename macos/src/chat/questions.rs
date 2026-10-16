//! Question receipts stay with their cards; elicitation replies carry typed content.

use std::collections::BTreeMap;
use std::time::Duration;

use gpui_kit::component::input::{InputState, InputEvent};
use gpui_kit::component::select::{SelectEvent, SelectItem, SelectState};
use gpui_kit::component::IndexPath;
use gpui_kit::*;
use serde_json::{Value, json};

use super::{ChatEvent, ChatSession, Item, Permission, Question, permission_from};
use crate::store::now_ms;

pub struct AsyncQuestion {
    pub status: Option<String>,
    pub sending: bool,
    pub error: Option<String>,
    pub request_id: Option<String>,
}

impl AsyncQuestion {
    fn finish(&mut self, msg: &Value) -> bool {
        if msg.get("requestId").and_then(Value::as_str) != self.request_id.as_deref() || self.request_id.is_none() || self.status.is_some() { return false; }
        self.sending = false;
        if msg.get("ok").and_then(Value::as_bool) == Some(true) {
            self.status = Some("Answer sent in chat".into());
            self.error = None;
            true
        } else {
            self.error = Some(msg.get("error").and_then(Value::as_str).unwrap_or("Couldn't send your answer. Try again.").into());
            false
        }
    }
}

impl Permission {
    pub fn answer_key<'a>(&self, question: &'a Question) -> &'a str {
        if self.async_question.is_some() { question.id.as_deref().unwrap_or(&question.question) } else { &question.question }
    }

    pub fn question_uses_input(&self) -> bool {
        !self.questions.is_empty() && (self.other_open || !self.question_editable() || self.questions.get(self.question_ix).map_or(true, |q| q.options.is_empty()))
    }

    pub fn question_editable(&self) -> bool {
        self.async_question.as_ref().map_or(true, |q| q.status.is_none() && !q.sending)
    }
}

pub(super) fn async_permission(event: &Value) -> Option<Permission> {
    let id = event.get("questionId")?.as_str()?.trim();
    if id.is_empty() { return None; }
    let questions: Vec<Value> = event.get("questions")?.as_array()?.iter()
        .filter(|q| q.get("question").and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty()))
        .take(3).cloned().collect();
    if questions.is_empty() { return None; }
    let mut perm = permission_from(&json!({"requestId": id, "toolName": "AskUserQuestion", "input": {"questions": questions}}));
    perm.async_question = Some(AsyncQuestion {
        status: (event.get("readOnly").and_then(Value::as_bool) == Some(true)).then(|| "No longer needed".into()),
        sending: false, error: None, request_id: None,
    });
    Some(perm)
}

fn answer_text(perm: &Permission) -> String {
    perm.questions.iter().map(|q| format!("{}\n{}", q.question, perm.answers.get(perm.answer_key(q)).map(String::as_str).unwrap_or("")))
        .collect::<Vec<_>>().join("\n\n")
}

fn parse_answer(perm: &Permission, text: &str) -> Option<BTreeMap<String, String>> {
    let mut rest = text;
    let mut answers = BTreeMap::new();
    for (i, q) in perm.questions.iter().enumerate() {
        rest = rest.strip_prefix(&format!("{}\n", q.question))?;
        let end = match perm.questions.get(i + 1) {
            Some(next) => rest.find(&format!("\n\n{}\n", next.question))?,
            None => rest.len(),
        };
        let answer = &rest[..end];
        if answer.trim().is_empty() { return None; }
        answers.insert(perm.answer_key(q).to_string(), answer.to_string());
        rest = if end == rest.len() { "" } else { &rest[end + 2..] };
    }
    (!answers.is_empty()).then_some(answers)
}

pub(super) fn merge_history_answer(items: &mut [Item], text: &str, id: Option<&str>) -> bool {
    for item in items.iter_mut().rev() {
        let Item::Question(perm) = item else { continue };
        if id.is_some_and(|id| id != perm.request_id) { continue; }
        if let Some(answers) = parse_answer(perm, text) {
            perm.answers = answers;
            if let Some(q) = &mut perm.async_question {
                q.status = Some("Answer sent".into());
                q.sending = false;
                q.error = None;
            }
            return true;
        }
    }
    false
}

impl ChatSession {
    /// Permissions take priority; asynchronous questions can outlive a turn.
    pub fn active_permission(&self) -> Option<&Permission> {
        self.permissions.first().or_else(|| self.items.iter().find_map(|item| match item {
            Item::Question(p) if p.async_question.as_ref().is_some_and(|q| q.status.is_none()) => Some(p),
            _ => None,
        }))
    }

    pub fn waiting_for_answer(&self) -> bool {
        !self.permissions.is_empty() || !self.running && self.active_permission().is_some()
    }

    pub(super) fn has_async_question(&self, id: &str) -> bool {
        self.items.iter().any(|item| matches!(item, Item::Question(p) if p.request_id == id))
    }

    pub(super) fn question_mut(&mut self, id: &str) -> Option<&mut Permission> {
        self.permissions.iter_mut().find(|p| p.request_id == id).or_else(|| self.items.iter_mut().find_map(|item| match item {
            Item::Question(p) if p.request_id == id => Some(p),
            _ => None,
        }))
    }

    pub(super) fn show_async_question(&mut self, event: &Value, cx: &mut Context<Self>) {
        let Some(perm) = async_permission(event) else { return };
        if self.has_async_question(&perm.request_id) { return; }
        let waiting = self.waiting_for_answer();
        let editable = perm.question_editable();
        self.tools_open = false;
        if let Some(ix) = self.items.iter().position(|item| matches!(item, Item::Assistant { msg_id: Some(id), .. } if id == &perm.request_id)) {
            self.items[ix] = Item::Question(perm);
            self.list.remeasure_items(ix..ix + 1);
            cx.notify();
        } else {
            self.push(Item::Question(perm), cx);
        }
        if editable && !self.running && !waiting { cx.emit(ChatEvent::Asked); }
    }

    pub(super) fn close_async_questions(&mut self, status: &str, cx: &mut Context<Self>) {
        for item in &mut self.items {
            if let Item::Question(p) = item {
                if let Some(q) = &mut p.async_question {
                    if q.status.is_none() && !q.sending { q.status = Some(status.into()); q.error = None; }
                }
            }
        }
        cx.notify();
    }

    pub(super) fn dismiss_async_question(&mut self, id: &str, cx: &mut Context<Self>) -> bool {
        let Some(perm) = self.question_mut(id) else { return false };
        let Some(q) = &mut perm.async_question else { return false };
        if q.status.is_none() && !q.sending { q.status = Some("Dismissed".into()); q.error = None; }
        cx.notify();
        true
    }

    pub fn send_question_answer(&mut self, id: &str, cx: &mut Context<Self>) {
        let connected = self.host.is_connected();
        let Some(perm) = self.question_mut(id) else { return };
        if !perm.question_editable() || perm.questions.iter().any(|q| !perm.answers.get(perm.answer_key(q)).is_some_and(|a| !a.trim().is_empty())) { return; }
        let text = answer_text(perm);
        let Some(q) = &mut perm.async_question else { return };
        if !connected {
            q.error = Some("Host disconnected. Reconnect, then try again.".into());
            cx.notify();
            return;
        }
        let request_id = format!("question-{}-{}", now_ms(), id);
        q.request_id = Some(request_id.clone());
        q.error = None;
        q.sending = true;
        self.ensure_started(cx);
        self.send(question_reply(id, &request_id, &text));
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(30)).await;
            let _ = this.update(cx, |this, cx| this.question_send_error(&request_id, "Couldn't confirm your answer was sent. Check the chat before trying again.", cx));
        }).detach();
        cx.notify();
    }

    fn question_send_error(&mut self, request_id: &str, error: &str, cx: &mut Context<Self>) {
        for item in &mut self.items {
            if let Item::Question(p) = item {
                if let Some(q) = &mut p.async_question {
                    if q.request_id.as_deref() == Some(request_id) && q.sending && q.status.is_none() {
                        q.sending = false;
                        q.error = Some(error.into());
                    }
                }
            }
        }
        cx.notify();
    }

    pub fn fail_question_sends(&mut self, cx: &mut Context<Self>) {
        for item in &mut self.items {
            if let Item::Question(p) = item {
                if let Some(q) = &mut p.async_question {
                    if q.sending {
                        q.sending = false;
                        q.error = Some("Connection lost. Check the chat before sending again.".into());
                    }
                }
            }
        }
        cx.notify();
    }

    pub(super) fn finish_question_answer(&mut self, msg: &Value, cx: &mut Context<Self>) {
        let mut accepted = false;
        for item in &mut self.items {
            if let Item::Question(p) = item {
                if let Some(q) = &mut p.async_question { accepted |= q.finish(msg); }
            }
        }
        if accepted {
            if !self.running && msg.get("startedTurn").and_then(Value::as_bool) == Some(true) { self.begin_turn(); }
            self.touch(cx);
        }
        self.sync_rows(cx);
    }
}

#[derive(Clone)]
pub enum FieldKind {
    Text,
    Number { integer: bool },
    Choice { options: Vec<(Value, String)>, multiple: bool },
}

#[derive(Clone)]
pub struct FormOption {
    value: usize,
    label: String,
}

impl SelectItem for FormOption {
    type Value = usize;

    fn title(&self) -> SharedString { self.label.clone().into() }
    fn value(&self) -> &usize { &self.value }
}

pub struct FormField {
    pub name: String,
    pub title: String,
    pub description: Option<String>,
    pub required: bool,
    pub kind: FieldKind,
    spec: Value,
    pub value: Value,
    pub input: Option<Entity<InputState>>,
    pub select: Option<Entity<SelectState<Vec<FormOption>>>>,
}

pub struct Elicitation {
    pub fields: Vec<FormField>,
    pub url: Option<String>,
    pub supported: bool,
    pub error: Option<String>,
}

fn display_value(value: &Value) -> String {
    value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())
}

fn http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && url.split_once("://").is_some_and(|(_, rest)| !rest.is_empty() && !rest.starts_with('/') && !rest.chars().any(char::is_whitespace))
}

impl Elicitation {
    pub fn from_input(input: &Value) -> Self {
        let mut form = Self { fields: Vec::new(), url: None, supported: true, error: None };
        if input.get("mode").and_then(Value::as_str) == Some("url") {
            form.url = input.get("url").and_then(Value::as_str).filter(|url| http_url(url)).map(str::to_string);
            form.supported = form.url.is_some();
            return form;
        }
        let schema = &input["requestedSchema"];
        if input["mode"] != "form" || schema["type"] != "object" {
            form.supported = false;
            return form;
        }
        let required: Vec<&str> = schema["required"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        if let Some(properties) = schema["properties"].as_object() {
            for (name, spec) in properties {
                let multiple = spec["type"] == "array";
                let choices = if multiple { &spec["items"] } else { spec };
                let options = choices["enum"].as_array().map(|values| values.iter().enumerate().map(|(i, value)| {
                    (value.clone(), spec["enumNames"][i].as_str().map(str::to_string).unwrap_or_else(|| display_value(value)))
                }).collect::<Vec<_>>()).or_else(|| choices.get("oneOf").or_else(|| choices.get("anyOf")).and_then(Value::as_array).map(|variants| {
                    variants.iter().filter_map(|v| v.get("const").map(|value| (value.clone(), v["title"].as_str().map(str::to_string).unwrap_or_else(|| display_value(value))))).collect()
                }));
                let kind = if let Some(options) = options {
                    if options.is_empty() || options.iter().any(|(v, _)| !v.is_string() && !v.is_number() && !v.is_boolean()) {
                        form.supported = false;
                        continue;
                    }
                    FieldKind::Choice { options, multiple }
                } else {
                    match spec["type"].as_str() {
                        Some("boolean") => FieldKind::Choice { options: vec![(json!(true), "Yes".into()), (json!(false), "No".into())], multiple: false },
                        Some("string") => FieldKind::Text,
                        Some("number" | "integer") => FieldKind::Number { integer: spec["type"] == "integer" },
                        _ => { form.supported = false; continue; }
                    }
                };
                form.fields.push(FormField {
                    name: name.clone(), title: spec["title"].as_str().unwrap_or(name).into(),
                    description: spec["description"].as_str().map(str::to_string), required: required.contains(&name.as_str()),
                    kind, spec: spec.clone(), value: spec.get("default").cloned().unwrap_or(Value::Null), input: None, select: None,
                });
            }
        }
        if required.iter().any(|name| !form.fields.iter().any(|f| f.name == *name)) { form.supported = false; }
        form
    }

    /// Inputs need a window, which host message parsing deliberately doesn't own.
    fn prepare_inputs(&mut self, id: &str, window: &mut Window, cx: &mut Context<ChatSession>) {
        for (field_ix, field) in self.fields.iter_mut().enumerate() {
            if let FieldKind::Choice { options, multiple: false } = &field.kind {
                if field.select.is_none() {
                    let selected = options.iter().position(|(value, _)| *value == field.value).map(|i| IndexPath::default().row(i));
                    let options: Vec<FormOption> = options.iter().enumerate().map(|(i, (_, label))| FormOption { value: i, label: label.clone() }).collect();
                    let select = cx.new(|cx| SelectState::new(options, selected, window, cx));
                    let id = id.to_string();
                    cx.subscribe(&select, move |chat, _, event: &SelectEvent<Vec<FormOption>>, cx| {
                        let SelectEvent::Confirm(option) = event;
                        chat.pick_elicitation(&id, field_ix, *option, cx);
                    }).detach();
                    field.select = Some(select);
                }
            }
            if field.input.is_none() && !matches!(field.kind, FieldKind::Choice { .. }) {
                let text = if field.value.is_null() { String::new() } else { display_value(&field.value) };
                let input = cx.new(|cx| InputState::new(window, cx).default_value(text));
                cx.subscribe(&input, |_, _, event: &InputEvent, cx| {
                    if matches!(event, InputEvent::Change) { cx.notify(); }
                }).detach();
                field.input = Some(input);
            }
        }
    }

    fn content(&self, values: &BTreeMap<String, Value>) -> Result<Value, String> {
        if !self.supported { return Err("This request uses a form this version cannot display. You can decline or cancel it.".into()); }
        if self.url.is_some() { return Ok(Value::Null); }
        let mut content = serde_json::Map::new();
        for field in &self.fields {
            let raw = values.get(&field.name).unwrap_or(&Value::Null);
            let empty = raw.is_null() || raw.as_str() == Some("") || raw.as_array().is_some_and(Vec::is_empty);
            let invalid = |hint: &str| format!("{}: {hint}", field.title);
            if empty {
                if field.required { return Err(invalid("Please answer this field.")); }
                continue;
            }
            let value = match &field.kind {
                FieldKind::Text => {
                    let text = raw.as_str().ok_or_else(|| invalid("Enter text."))?;
                    let len = text.chars().count() as u64;
                    if field.spec["minLength"].as_u64().is_some_and(|min| len < min) || field.spec["maxLength"].as_u64().is_some_and(|max| len > max) {
                        return Err(invalid("Check the length of this answer."));
                    }
                    match field.spec["format"].as_str() {
                        Some("uri") if !http_url(text) => return Err(invalid("Enter a valid URL.")),
                        Some("email") if !text.split_once('@').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && !text.chars().any(char::is_whitespace)) => return Err(invalid("Enter a valid email address.")),
                        _ => {}
                    }
                    json!(text)
                }
                FieldKind::Number { integer } => {
                    let text = raw.as_str().unwrap_or("").trim();
                    let number = text.parse::<f64>().ok().filter(|n| n.is_finite()).ok_or_else(|| invalid("Enter a number."))?;
                    if *integer && number.fract() != 0. { return Err(invalid("Enter a whole number.")); }
                    if field.spec["minimum"].as_f64().is_some_and(|min| number < min) || field.spec["maximum"].as_f64().is_some_and(|max| number > max) {
                        return Err(invalid("Enter a number within the requested range."));
                    }
                    if *integer { serde_json::from_str::<Value>(text).ok().filter(|v| v.is_i64() || v.is_u64()).unwrap_or_else(|| json!(number)) } else { json!(number) }
                }
                FieldKind::Choice { options, multiple } => {
                    let valid = |value: &Value| options.iter().any(|(v, _)| v == value);
                    if *multiple {
                        let values = raw.as_array().ok_or_else(|| invalid("Choose an option."))?;
                        let len = values.len() as u64;
                        if !values.iter().all(valid) || field.spec["minItems"].as_u64().is_some_and(|min| len < min) || field.spec["maxItems"].as_u64().is_some_and(|max| len > max) {
                            return Err(invalid("Choose the requested number of options."));
                        }
                    } else if !valid(raw) { return Err(invalid("Choose an option.")); }
                    raw.clone()
                }
            };
            content.insert(field.name.clone(), value);
        }
        Ok(Value::Object(content))
    }
}

impl ChatSession {
    pub fn prepare_elicitation(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(form) = self.permissions.iter_mut().find(|p| p.request_id == id).and_then(|p| p.elicitation.as_mut()) {
            form.prepare_inputs(id, window, cx);
        }
    }

    pub fn pick_elicitation(&mut self, id: &str, field_ix: usize, option_ix: Option<usize>, cx: &mut Context<Self>) {
        let Some(form) = self.permissions.iter_mut().find(|p| p.request_id == id).and_then(|p| p.elicitation.as_mut()) else { return };
        let Some(field) = form.fields.get_mut(field_ix) else { return };
        let FieldKind::Choice { options, multiple } = &field.kind else { return };
        if let Some(value) = option_ix.and_then(|i| options.get(i)).map(|(v, _)| v.clone()) {
            if *multiple {
                let mut values = field.value.as_array().cloned().unwrap_or_default();
                if let Some(i) = values.iter().position(|v| v == &value) { values.remove(i); } else { values.push(value); }
                field.value = json!(values);
            } else { field.value = value; }
        } else { field.value = Value::Null; }
        form.error = None;
        cx.notify();
    }

    /// Option indices include Allow only when every field can be represented.
    pub fn answer_elicitation(&mut self, id: &str, option: usize, cx: &mut Context<Self>) {
        let Some(pos) = self.permissions.iter().position(|p| p.request_id == id) else { return };
        let Some(form) = self.permissions[pos].elicitation.as_mut() else { return };
        let option = option + usize::from(!form.supported);
        let content = if option == 0 {
            let values = form.fields.iter().map(|f| (f.name.clone(), f.input.as_ref().map(|input| json!(input.read(cx).value().to_string())).unwrap_or_else(|| f.value.clone()))).collect();
            match form.content(&values) {
                Ok(content) => content,
                Err(error) => { form.error = Some(error); cx.notify(); return; }
            }
        } else { Value::Null };
        let reply = elicitation_reply(id, option, content);
        self.permissions.remove(pos);
        self.send(reply);
        self.sync_rows(cx);
    }
}

fn question_reply(id: &str, request_id: &str, text: &str) -> Value {
    json!({"type": "prompt", "text": text, "questionReplyId": id, "promptRequestId": request_id})
}

fn elicitation_reply(id: &str, option: usize, content: Value) -> Value {
    let mut reply = json!({"type": "permissionResult", "requestId": id, "behavior": if option == 0 { "allow" } else { "deny" }});
    if option == 0 { reply["updatedInput"] = json!({"content": content}); }
    else { reply["message"] = json!(super::DENY_MESSAGE); reply["interrupt"] = json!(option >= 2); }
    reply
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use serde_json::{Value, json};
    use super::{Elicitation, answer_text, async_permission, elicitation_reply, http_url, parse_answer, question_reply};

    #[test]
    fn async_questions_filter_and_format_answers() {
        let mut perm = async_permission(&json!({"questionId":"q", "questions":[{}, {"question":"Which?", "options":[{"label":"A"}]}, {"question":"Why?"}], "readOnly":true})).unwrap();
        assert!(!perm.question_editable());
        perm.answers.insert("Which?".into(), "A".into());
        perm.answers.insert("Why?".into(), "Two\nlines".into());
        let text = answer_text(&perm);
        assert_eq!(text, "Which?\nA\n\nWhy?\nTwo\nlines");
        assert_eq!(parse_answer(&perm, &text), Some(perm.answers.clone()));
        assert!(parse_answer(&perm, "Which?\n\n\nWhy?\n").is_none());
        assert!(async_permission(&json!({"questionId":"q", "questions":[]})).is_none());
    }

    #[test]
    fn asynchronous_answers_use_question_ids_even_for_repeated_text() {
        let mut perm = async_permission(&json!({"questionId":"q", "questions":[{"id":"0", "question":"Which?"}, {"id":"1", "question":"Which?"}]})).unwrap();
        perm.answers = [("0".into(), "A".into()), ("1".into(), "B".into())].into();
        assert_eq!(answer_text(&perm), "Which?\nA\n\nWhich?\nB");
        assert_eq!(parse_answer(&perm, &answer_text(&perm)), Some(perm.answers.clone()));
        assert_eq!(question_reply("q", "receipt", &answer_text(&perm)), json!({"type":"prompt", "questionReplyId":"q", "promptRequestId":"receipt", "text":"Which?\nA\n\nWhich?\nB"}));
    }

    #[test]
    fn receipts_handle_failures_retries_and_late_success() {
        let mut perm = async_permission(&json!({"questionId":"q", "questions":[{"question":"Which?"}]})).unwrap();
        let q = perm.async_question.as_mut().unwrap();
        q.request_id = Some("first".into());
        q.sending = true;
        assert!(!q.finish(&json!({"requestId":"other", "ok":true})));
        assert!(q.sending);
        assert!(!q.finish(&json!({"requestId":"first", "ok":false, "error":"Try again"})));
        assert!(!q.sending);
        assert_eq!(q.error.as_deref(), Some("Try again"));
        q.request_id = Some("retry".into());
        q.sending = true;
        assert!(!q.finish(&json!({"requestId":"first", "ok":true})));
        assert!(q.sending);
        // A receipt may arrive after the local send timeout released the card.
        q.sending = false;
        assert!(q.finish(&json!({"requestId":"retry", "ok":true})));
        assert_eq!(q.status.as_deref(), Some("Answer sent in chat"));
        assert!(q.error.is_none());
        assert!(!q.finish(&json!({"requestId":"retry", "ok":true})));
    }

    #[test]
    fn elicitation_replies_distinguish_accept_decline_and_cancel() {
        assert_eq!(elicitation_reply("r", 0, json!({"ok":false})), json!({"type":"permissionResult", "requestId":"r", "behavior":"allow", "updatedInput":{"content":{"ok":false}}}));
        assert_eq!(elicitation_reply("r", 0, Value::Null)["updatedInput"], json!({"content":null}));
        let decline = elicitation_reply("r", 1, Value::Null);
        let cancel = elicitation_reply("r", 2, Value::Null);
        assert_eq!(decline["behavior"], "deny");
        assert_eq!(decline["interrupt"], false);
        assert_eq!(cancel["interrupt"], true);
        assert!(decline.get("updatedInput").is_none());
        assert!(cancel.get("updatedInput").is_none());
    }

    #[test]
    fn elicitation_preserves_types_and_validates_constraints() {
        let form = Elicitation::from_input(&json!({"mode":"form", "requestedSchema":{"type":"object", "required":["name", "count", "ok"], "properties": {
            "name":{"type":"string", "minLength":2}, "count":{"type":"integer", "minimum":1, "maximum":5},
            "ok":{"type":"boolean"}, "choice":{"type":"number", "enum":[1,2]}, "optional":{"type":"string"}
        }}}));
        let mut values: BTreeMap<String, Value> = [("name".into(), json!("Jo")), ("count".into(), json!("3")), ("ok".into(), json!(false)), ("choice".into(), json!(2))].into();
        assert_eq!(form.content(&values).unwrap(), json!({"name":"Jo", "count":3, "ok":false, "choice":2}));
        values.insert("count".into(), json!("1.5"));
        assert!(form.content(&values).is_err());
        values.insert("count".into(), json!("6"));
        assert!(form.content(&values).is_err());
        values.insert("count".into(), json!("NaN"));
        assert!(form.content(&values).is_err());
        values.insert("count".into(), json!("2"));
        values.remove("ok");
        assert!(form.content(&values).is_err());
    }

    #[test]
    fn elicitation_supports_arrays_defaults_and_variant_labels() {
        let form = Elicitation::from_input(&json!({"mode":"form", "requestedSchema":{"type":"object", "properties": {
            "items":{"type":"array", "minItems":1, "maxItems":2, "items":{"type":"string", "oneOf":[{"const":"a", "title":"Alpha"}, {"const":"b"}]}},
            "enabled":{"type":"boolean", "default":false}
        }}}));
        assert!(form.supported);
        let values = [("items".into(), json!(["a"])), ("enabled".into(), json!(false))].into();
        assert_eq!(form.content(&values).unwrap(), json!({"items":["a"], "enabled":false}));
        assert!(form.content(&[("items".into(), json!(["unknown"]))].into()).is_err());
    }

    #[test]
    fn unsupported_forms_and_unsafe_links_cannot_be_allowed() {
        for schema in [json!({"type":"object", "required":["missing"]}), json!({"type":"object", "properties":{"nested":{"type":"object"}}})] {
            let form = Elicitation::from_input(&json!({"mode":"form", "requestedSchema":schema}));
            assert!(!form.supported);
            assert!(form.content(&BTreeMap::new()).is_err());
        }
        assert!(!http_url("javascript:alert(1)"));
        assert!(!http_url("https://"));
        let form = Elicitation::from_input(&json!({"mode":"url", "url":"https://example.com/auth"}));
        assert!(form.supported);
        assert_eq!(form.content(&BTreeMap::new()).unwrap(), Value::Null);
    }
}
