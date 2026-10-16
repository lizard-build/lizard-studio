//! Stable host anchors survive history paging; row indices do not.

use gpui_kit::component::input::{InputEvent, Position, TextareaState};
use gpui_kit::*;
use serde_json::{Value, json};

use super::{APP_CONTEXT, CTX_END, CTX_START, ChatSession, History, Item, clean_user_text};
use crate::store::{Agent, now_ms};

#[derive(Clone, Debug, PartialEq)]
enum Anchor {
    Claude(u64),
    Codex { turn_id: String, item_id: Option<String> },
}

#[derive(Clone)]
pub struct UserPrompt {
    text: String,
    images: Vec<Value>,
    has_attachments: bool,
    message_id: Option<String>,
    anchor: Option<Anchor>,
}

impl UserPrompt {
    pub(super) fn from_event(event: &Value, agent: Agent) -> Option<Self> {
        let content = event.pointer("/message/content")?;
        let text = match content {
            Value::String(text) => text.clone(),
            Value::Array(blocks) => blocks.iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>().join("\n"),
            _ => return None,
        };
        let images = transcript_images(event);
        let anchor = match agent {
            Agent::Claude => event["historyTurnIndex"].as_u64().filter(|n| *n > 0).map(Anchor::Claude),
            Agent::Codex => event["historyTurnId"].as_str().map(|turn_id| Anchor::Codex {
                turn_id: turn_id.into(),
                item_id: event["historyItemId"].as_str().map(str::to_string),
            }),
        };
        Some(Self {
            text: clean_user_text(&text),
            has_attachments: !images.is_empty() || event["hasAttachments"].as_bool().unwrap_or(false),
            images,
            message_id: None,
            anchor,
        })
    }

    fn accept(&mut self, message_id: &str, turn_id: &str) -> bool {
        if self.message_id.as_deref() != Some(message_id) {
            return false;
        }
        self.anchor = Some(Anchor::Codex { turn_id: turn_id.into(), item_id: None });
        true
    }

    fn request(&self, request_id: &str, text: &str) -> Option<Value> {
        Some(match self.anchor.as_ref()? {
            Anchor::Claude(turn) => {
                // Rewinding the first prompt also removes the app's context.
                let wire = if *turn == 1 && !text.starts_with('/') {
                    format!("{CTX_START}{APP_CONTEXT}{CTX_END}\n\n{text}")
                } else {
                    text.to_string()
                };
                json!({ "type": "rewind", "turnIndex": turn, "text": wire, "images": self.images })
            }
            Anchor::Codex { turn_id, item_id } => json!({
                "type": "rewind", "requestId": request_id,
                "turnId": turn_id, "itemId": item_id, "text": text,
            }),
        })
    }
}

#[derive(Default)]
pub(super) struct RewindState {
    turns: u64,
    turns_known: bool,
    sequence: u64,
    opening: bool,
    pub(super) editor: Option<Editor>,
    pub(super) pending: Option<Pending>,
}

pub(super) struct Editor {
    view: Entity<gpui_kit::component::text::TextViewState>,
    input: Entity<TextareaState>,
    _subscription: Subscription,
}

pub(super) struct Pending {
    request_id: String,
    prompt: UserPrompt,
}

impl RewindState {
    fn next_claude_turn(&mut self, counts: bool, fresh: bool) -> Option<Anchor> {
        self.turns_known |= fresh;
        if !counts {
            return None;
        }
        self.turns += 1;
        self.turns_known.then_some(Anchor::Claude(self.turns))
    }

    fn note_history(&mut self, msg: &Value) {
        if let Some(turns) = msg["totalTurns"].as_u64() {
            self.turns = self.turns.max(turns);
            self.turns_known = true;
        } else if msg["missing"].as_bool() == Some(true) {
            self.turns_known = true;
        }
    }
}

impl ChatSession {
    pub(super) fn record_prompt(&mut self, text: &str, images: &[Value], cx: &mut Context<Self>) -> String {
        self.rewind.sequence += 1;
        let message_id = format!("edit-{}-{}", now_ms(), self.rewind.sequence);
        let counts = !usage_command(text) && (!text.is_empty() || !self.context_sent);
        let anchor = if self.meta.agent == Agent::Claude {
            self.rewind.next_claude_turn(counts, self.meta.session_id.is_none())
        } else {
            None
        };
        let prompt = UserPrompt {
            text: text.into(),
            images: images.to_vec(),
            has_attachments: !images.is_empty(),
            message_id: Some(message_id.clone()),
            anchor,
        };
        self.user_item(&prompt.text, super::images::sent_images(&prompt.images), cx);
        if let Some(Item::User { prompt: saved, .. }) = self.items.last_mut() {
            *saved = Some(prompt);
        }
        message_id
    }

    pub(super) fn note_history_turns(&mut self, msg: &Value) {
        self.rewind.note_history(msg);
    }

    /// Wait for Claude's absolute turn count before assigning a live anchor.
    pub(super) fn flush_history_queue(&mut self, cx: &mut Context<Self>) {
        self.flush_queued(cx);
    }

    /// Whether a prompt must wait: an edit is in flight, or Claude's turn
    /// count is still loading.
    pub(super) fn rewind_blocks_send(&self) -> bool {
        self.rewind.pending.is_some() || (self.history.loading && self.meta.agent == Agent::Claude)
    }

    pub(super) fn abort_rewind(&mut self, cx: &mut Context<Self>) {
        self.rewind.opening = false;
        if self.rewind.pending.take().is_some() {
            self.notice(true, "The helper stopped before confirming the edit.", cx);
        }
    }

    pub fn can_edit(&self, ix: usize) -> bool {
        !self.meta.cloud && !self.running && self.rewind.pending.is_none()
            && self.meta.session_id.is_some() && !self.history.loading && self.host.is_connected()
            && matches!(self.items.get(ix), Some(Item::User { prompt: Some(p), .. }) if p.anchor.is_some())
    }

    pub fn user_editor(&self, ix: usize) -> Option<(Entity<TextareaState>, bool)> {
        let editor = self.rewind.editor.as_ref()?;
        match self.items.get(ix) {
            Some(Item::User { view, .. }) if *view == editor.view => {
                Some((editor.input.clone(), self.rewind.pending.is_some()))
            }
            _ => None,
        }
    }

    pub fn begin_edit(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_edit(ix) {
            return;
        }
        let Some(Item::User { view, prompt: Some(prompt), .. }) = self.items.get(ix) else { return };
        if !view.read(cx).selected_text().is_empty() {
            return;
        }
        let view = view.clone();
        let text = prompt.text.clone();
        if !self.started {
            self.rewind.opening = true;
            self.ensure_started(cx);
        }
        let input = cx.new(|cx| {
            let mut input = TextareaState::new(window, cx).auto_grow(1, usize::MAX).submit_on_enter(true);
            input.set_value(text.clone(), window, cx);
            let line = text.split('\n').count().saturating_sub(1) as u32;
            let column = text.rsplit('\n').next().unwrap_or("").encode_utf16().count() as u32;
            input.set_cursor_position(Position::new(line, column), window, cx);
            input
        });
        let subscription = cx.subscribe_in(&input, window, |this, input, event: &InputEvent, _, cx| {
            // A stale blur from the previous editor must not close the new one.
            if !this.rewind.editor.as_ref().is_some_and(|e| e.input == *input) {
                return;
            }
            match event {
                InputEvent::PressEnter { shift: false, .. } => this.commit_edit(cx),
                InputEvent::Blur => { this.cancel_edit(cx); }
                InputEvent::Change => this.remeasure_editor(cx),
                _ => {}
            }
        });
        self.rewind.editor = Some(Editor { view, input, _subscription: subscription });
        self.list.remeasure_items(ix..ix + 1);
        cx.notify();
    }

    pub fn cancel_edit(&mut self, cx: &mut Context<Self>) -> bool {
        if self.rewind.editor.is_none() {
            return false;
        }
        if self.rewind.pending.is_none() {
            self.remeasure_editor(cx);
            self.rewind.editor = None;
            cx.notify();
        }
        true
    }

    fn editor_index(&self) -> Option<usize> {
        let editor = self.rewind.editor.as_ref()?;
        self.items.iter().position(|item| matches!(item, Item::User { view, .. } if *view == editor.view))
    }

    fn remeasure_editor(&self, cx: &mut Context<Self>) {
        if let Some(ix) = self.editor_index() {
            self.list.remeasure_items(ix..ix + 1);
            cx.notify();
        }
    }

    fn commit_edit(&mut self, cx: &mut Context<Self>) {
        let Some(ix) = self.editor_index() else { return };
        if !self.can_edit(ix) {
            return;
        }
        let Some(Item::User { prompt: Some(prompt), .. }) = self.items.get(ix) else { return };
        let text = self.rewind.editor.as_ref().unwrap().input.read(cx).value().to_string();
        if text.trim().is_empty() && !prompt.has_attachments {
            self.cancel_edit(cx);
            return;
        }
        let mut prompt = prompt.clone();
        self.rewind.sequence += 1;
        let request_id = format!("rewind-{}-{}", now_ms(), self.rewind.sequence);
        let Some(request) = prompt.request(&request_id, &text) else { return };
        prompt.text = text;
        prompt.message_id = Some(request_id.clone());
        if self.meta.agent == Agent::Claude {
            self.send(request);
            self.apply_rewind(ix, prompt, cx);
        } else {
            if !self.rewind.opening {
                self.send(request);
            }
            self.rewind.pending = Some(Pending { request_id, prompt });
            cx.notify();
        }
    }

    pub(super) fn on_rewind_message(&mut self, msg: &Value, cx: &mut Context<Self>) -> bool {
        match msg["type"].as_str() {
            Some("started") => {
                if self.rewind.opening {
                    self.rewind.opening = false;
                    if let Some(pending) = &self.rewind.pending {
                        if let Some(request) = pending.prompt.request(&pending.request_id, &pending.prompt.text) {
                            self.send(request);
                        }
                    }
                }
                false
            }
            Some("exit") => {
                self.abort_rewind(cx);
                false
            }
            Some("error") if self.rewind.opening => {
                self.rewind.opening = false;
                self.rewind.pending = None;
                false
            }
            Some("promptAccepted") => {
                let Some(message_id) = msg["messageId"].as_str() else { return true };
                let Some(turn_id) = msg["turnId"].as_str() else { return true };
                for item in &mut self.items {
                    if let Item::User { prompt: Some(prompt), .. } = item {
                        if prompt.accept(message_id, turn_id) {
                            break;
                        }
                    }
                }
                cx.notify();
                true
            }
            Some("rewindResult") => {
                if !self.rewind.pending.as_ref().is_some_and(|p| msg["requestId"].as_str() == Some(&p.request_id)) {
                    return true;
                }
                let pending = self.rewind.pending.take().unwrap();
                if msg["ok"].as_bool() != Some(true) {
                    self.notice(true, msg["error"].as_str().unwrap_or("Couldn't edit this message. Try again.").to_string(), cx);
                    cx.notify();
                    return true;
                }
                let Some(ix) = self.editor_index() else { return true };
                if self.history.next_cursor.is_some() {
                    self.history.next_cursor = retained_cursor(&self.items[..ix], msg);
                }
                let mut prompt = pending.prompt;
                // promptAccepted will supply the replacement turn's ID.
                prompt.anchor = None;
                self.apply_rewind(ix, prompt, cx);
                true
            }
            _ => false,
        }
    }

    fn apply_rewind(&mut self, ix: usize, prompt: UserPrompt, cx: &mut Context<Self>) {
        let old_rows = self.row_count();
        self.items.truncate(ix);
        self.permissions.clear();
        self.stream_blocks.clear();
        self.streamed_msg_ids.clear();
        self.last_stream_id = None;
        self.tools_open = false;
        self.reindex_tools();
        self.tasks.retain(|task| self.tool_index.contains_key(&task.tool_id));
        self.ctx_base = 0;
        self.ctx_tokens = 0;
        self.unseen = false;
        self.need_connect = None;
        self.rewind.editor = None;
        self.history = History { requested: true, next_cursor: self.history.next_cursor.take(), ..History::default() };
        if let Some(Anchor::Claude(turn)) = prompt.anchor {
            self.rewind.turns = turn;
        }
        self.tail_rows = 0;
        self.list.splice(ix..old_rows, 0);
        self.user_item(&prompt.text, super::images::sent_images(&prompt.images), cx);
        if let Some(Item::User { prompt: saved, .. }) = self.items.last_mut() {
            *saved = Some(prompt);
        }
        self.begin_turn();
        self.touch(cx);
        self.sync_rows(cx);
        self.list.scroll_to_reveal_item(self.items.len());
    }
}

fn usage_command(text: &str) -> bool {
    let command = text.split_whitespace().next().unwrap_or("");
    matches!(command, "/usage" | "/usage-credits" | "/extra-usage")
}

fn transcript_images(event: &Value) -> Vec<Value> {
    let mut images = Vec::new();
    if let Some(blocks) = event.pointer("/message/content").and_then(Value::as_array) {
        for block in blocks {
            if block["type"] == "image" && block["source"]["type"] == "base64" {
                if let (Some(media), Some(data)) = (block["source"]["media_type"].as_str(), block["source"]["data"].as_str()) {
                    images.push(json!({ "mediaType": media, "data": data }));
                }
            }
        }
    }
    if let Some(attachments) = event["attachments"].as_array() {
        for attachment in attachments {
            if let Some((header, data)) = attachment["dataUrl"].as_str().and_then(|url| url.split_once(',')) {
                if let Some(media) = header.strip_prefix("data:").and_then(|h| h.strip_suffix(";base64")) {
                    images.push(json!({ "mediaType": media, "data": data }));
                }
            }
        }
    }
    images
}

fn retained_cursor(items: &[Item], msg: &Value) -> Option<Value> {
    items.iter().find_map(|item| match item {
        Item::User { prompt: Some(p), .. } => match &p.anchor {
            Some(Anchor::Codex { turn_id, .. }) => Some(json!({ "kind": "legacy", "before": turn_id })),
            _ => None,
        },
        _ => None,
    }).or_else(|| msg.get("historyCursor").filter(|c| !c.is_null()).cloned())
        .or_else(|| msg["previousTurnId"].as_str().map(|id| json!({ "kind": "legacy", "through": id })))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Anchor, RewindState, UserPrompt, retained_cursor, transcript_images, usage_command};
    use crate::store::Agent;

    #[test]
    fn live_claude_turns_continue_from_history_and_skip_usage() {
        let mut state = RewindState::default();
        state.note_history(&json!({ "totalTurns": 90 }));
        assert_eq!(state.next_claude_turn(true, false), Some(Anchor::Claude(91)));
        assert_eq!(state.next_claude_turn(false, false), None);
        state.note_history(&json!({ "events": [{ "historyTurnIndex": 30 }] }));
        assert_eq!(state.next_claude_turn(true, false), Some(Anchor::Claude(92)));
        state.turns = 40;
        assert_eq!(state.next_claude_turn(true, false), Some(Anchor::Claude(41)));
    }

    #[test]
    fn unknown_history_cannot_produce_a_destructive_turn_index() {
        let mut state = RewindState::default();
        assert_eq!(state.next_claude_turn(true, false), None);
        let mut fresh = RewindState::default();
        assert_eq!(fresh.next_claude_turn(true, true), Some(Anchor::Claude(1)));
    }

    #[test]
    fn claude_history_uses_absolute_turn_numbers() {
        let event = json!({
            "historyTurnIndex": 72,
            "message": { "content": [
                { "type": "text", "text": "\u{200b}\u{200b}\u{200b}Hidden context\u{200c}\u{200c}\u{200c}\n\nOriginal" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "aW1hZ2U=" } }
            ] }
        });
        let prompt = UserPrompt::from_event(&event, Agent::Claude).unwrap();
        assert_eq!(prompt.anchor, Some(Anchor::Claude(72)));
        assert_eq!(prompt.text, "Original");
        assert_eq!(prompt.images.len(), 1);
        assert_eq!(prompt.request("edit", "Edited").unwrap(), json!({
            "type": "rewind", "turnIndex": 72, "text": "Edited",
            "images": [{ "mediaType": "image/png", "data": "aW1hZ2U=" }]
        }));
    }

    #[test]
    fn first_claude_turn_restores_app_context() {
        let prompt = UserPrompt::from_event(&json!({
            "historyTurnIndex": 1, "message": { "content": "Original" }
        }), Agent::Claude).unwrap();
        let request = prompt.request("edit", "Edited").unwrap();
        let text = request["text"].as_str().unwrap();
        assert!(text.contains("Lizard Studio for macOS"));
        assert!(text.ends_with("\n\nEdited"));
        assert_eq!(prompt.request("edit", "/help").unwrap()["text"], "/help");
    }

    #[test]
    fn codex_history_keeps_turn_and_item_ids() {
        let prompt = UserPrompt::from_event(&json!({
            "historyTurnId": "turn-90", "historyItemId": "item-2", "hasAttachments": true,
            "message": { "content": [{ "type": "text", "text": "Original" }] }
        }), Agent::Codex).unwrap();
        assert!(prompt.has_attachments);
        assert_eq!(prompt.request("request-1", "Edited").unwrap(), json!({
            "type": "rewind", "requestId": "request-1", "turnId": "turn-90",
            "itemId": "item-2", "text": "Edited"
        }));
    }

    #[test]
    fn accepted_prompt_only_binds_the_matching_message() {
        let mut prompt = UserPrompt {
            text: "Hello".into(), images: Vec::new(), has_attachments: false,
            message_id: Some("message-3".into()), anchor: None,
        };
        assert!(prompt.request("edit", "Hello").is_none());
        assert!(!prompt.accept("message-2", "wrong-turn"));
        assert!(prompt.anchor.is_none());
        assert!(prompt.accept("message-3", "turn-3"));
        assert_eq!(prompt.anchor, Some(Anchor::Codex { turn_id: "turn-3".into(), item_id: None }));
    }

    #[test]
    fn synthetic_claude_messages_have_no_rewind_anchor() {
        let prompt = UserPrompt::from_event(&json!({
            "message": { "content": "<system-reminder>Note</system-reminder>" }
        }), Agent::Claude).unwrap();
        assert!(prompt.anchor.is_none());
        assert!(prompt.request("edit", "Replacement").is_none());
        assert!(UserPrompt::from_event(&json!({ "message": {} }), Agent::Claude).is_none());
    }

    #[test]
    fn replayed_image_data_survives_editing_without_becoming_text() {
        let event = json!({
            "attachments": [{ "dataUrl": "data:image/webp;base64,YWJj" }],
            "message": { "content": [{ "type": "text", "text": "Caption" }] }
        });
        assert_eq!(transcript_images(&event), vec![json!({ "mediaType": "image/webp", "data": "YWJj" })]);
        let prompt = UserPrompt::from_event(&event, Agent::Codex).unwrap();
        assert_eq!(prompt.text, "Caption");
        assert!(prompt.has_attachments);
    }

    #[test]
    fn codex_cursor_falls_back_to_retained_host_history() {
        assert_eq!(retained_cursor(&[], &json!({
            "historyCursor": { "kind": "turns", "value": "cursor" }, "previousTurnId": "previous"
        })), Some(json!({ "kind": "turns", "value": "cursor" })));
        assert_eq!(retained_cursor(&[], &json!({ "historyCursor": null, "previousTurnId": "previous" })),
            Some(json!({ "kind": "legacy", "through": "previous" })));
        assert_eq!(retained_cursor(&[], &json!({})), None);
    }

    #[test]
    fn usage_queries_do_not_consume_claude_turns() {
        for text in ["/usage", "/usage-credits", "/extra-usage", "/usage today"] {
            assert!(usage_command(text));
        }
        for text in ["Explain /usage", "/usage-example", "/help", ""] {
            assert!(!usage_command(text));
        }
    }
}
