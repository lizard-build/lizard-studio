//! Waiting prompts own their attachments and hold their place during an edit.

use std::collections::VecDeque;

use gpui_kit::component::input::{InputEvent, TextareaState};
use gpui_kit::component::text::TextViewState;
use gpui_kit::*;
use serde_json::Value;

use super::{ChatSession, Message, files_note, join_note, new_chat_id};

#[derive(Clone)]
pub struct QueuedPrompt {
    /// Stable across removals and steering, including callbacks already drawn.
    pub id: String,
    pub message: Message,
    view: Option<Entity<TextViewState>>,
    attachment_view: Option<Entity<TextViewState>>,
}

impl QueuedPrompt {
    pub fn new(message: Message) -> Self {
        Self { id: new_chat_id(), message, view: None, attachment_view: None }
    }

    /// An empty edit removes only a prompt with no attachments.
    fn save_text(&mut self, text: String) -> bool {
        self.message.text = text.trim().to_string();
        self.view = None;
        !self.message.text.is_empty() || !self.message.images.is_empty() || !self.message.files.is_empty()
    }
}

pub struct QueuedEdit {
    pub id: String,
    pub input: Entity<TextareaState>,
    return_focus: FocusHandle,
    _subscription: Subscription,
}

fn promote(queue: &mut VecDeque<QueuedPrompt>, id: &str) -> bool {
    let Some(ix) = queue.iter().position(|q| q.id == id) else { return false };
    let prompt = queue.remove(ix).unwrap();
    queue.push_front(prompt);
    true
}

fn take_next(queue: &mut VecDeque<QueuedPrompt>, editing: Option<&str>) -> Option<QueuedPrompt> {
    if queue.front().is_some_and(|q| Some(q.id.as_str()) == editing) {
        return None;
    }
    queue.pop_front()
}

pub(super) fn interruption_ends_turn(message: &Value) -> bool {
    message.get("respawn").and_then(Value::as_bool) != Some(false)
}

fn display_text(message: &Message, attachments_only: bool) -> String {
    let paths: Vec<String> = message.files.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let mut note = files_note(&paths);
    if !message.images.is_empty() {
        note = join_note(&note, &format!("_{} image(s) attached_", message.images.len()));
    }
    if attachments_only { note } else { join_note(&message.text, &note) }
}

impl ChatSession {
    /// Markdown parses asynchronously; keep its entity across list renders.
    pub fn queued_view(&mut self, ix: usize, cx: &mut Context<Self>) -> Option<Entity<TextViewState>> {
        let prompt = self.queued.get_mut(ix)?;
        let editing = self.queued_edit.as_ref().is_some_and(|e| e.id == prompt.id);
        let shown = display_text(&prompt.message, editing);
        let view = if editing { &mut prompt.attachment_view } else { &mut prompt.view };
        Some(view.get_or_insert_with(|| cx.new(|cx| TextViewState::markdown(&shown, cx))).clone())
    }

    pub fn begin_queued_edit(&mut self, id: &str, return_focus: &FocusHandle, window: &mut Window, cx: &mut Context<Self>) {
        if self.queued_edit.as_ref().is_some_and(|e| e.id == id) {
            return;
        }
        let Some(prompt) = self.queued.iter().find(|q| q.id == id) else { return };
        let text = prompt.message.text.clone();
        // Replacing another editor reverts it without briefly releasing the queue.
        self.queued_edit = None;
        let input = cx.new(|cx| {
            TextareaState::new(window, cx).auto_grow(1, 30).submit_on_enter(true).default_value(text)
        });
        let subscription = cx.subscribe_in(&input, window, |this, input, event: &InputEvent, window, cx| {
            if !this.queued_edit.as_ref().is_some_and(|e| &e.input == input) {
                return;
            }
            match event {
                InputEvent::PressEnter { shift: false, .. } => this.finish_queued_edit(true, window, cx),
                InputEvent::Blur => this.finish_queued_edit(false, window, cx),
                InputEvent::Change => {
                    this.remeasure_tail();
                    cx.notify();
                }
                _ => {}
            }
        });
        self.queued_edit = Some(QueuedEdit { id: id.to_string(), input: input.clone(), return_focus: return_focus.clone(), _subscription: subscription });
        input.update(cx, |s, cx| s.focus(window, cx));
        self.remeasure_tail();
        cx.notify();
    }

    fn close_queued_edit(&mut self, save: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(edit) = self.queued_edit.take() else { return };
        if save {
            let text = edit.input.read(cx).value().to_string();
            if let Some(prompt) = self.queued.iter_mut().find(|q| q.id == edit.id) {
                if !prompt.save_text(text) {
                    self.queued.retain(|q| q.id != edit.id);
                }
            }
        }
        if edit.input.read(cx).focus_handle(cx).is_focused(window) {
            window.focus(&edit.return_focus, cx);
        }
    }

    pub fn finish_queued_edit(&mut self, save: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.close_queued_edit(save, window, cx);
        self.sync_rows(cx);
        self.remeasure_tail();
        self.flush_queued(cx);
    }

    pub fn remove_queued(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.queued_edit.as_ref().is_some_and(|e| e.id == id) {
            self.close_queued_edit(false, window, cx);
        }
        self.queued.retain(|q| q.id != id);
        self.sync_rows(cx);
        self.remeasure_tail();
        self.flush_queued(cx);
    }

    /// Interrupt first, then let turn completion deliver the chosen prompt.
    pub fn steer_queued(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.queued_edit.as_ref().is_some_and(|e| e.id == id) {
            self.close_queued_edit(true, window, cx);
        }
        if promote(&mut self.queued, id) {
            self.interrupt(cx);
        }
        self.sync_rows(cx);
        self.remeasure_tail();
        self.flush_queued(cx);
    }

    pub(super) fn flush_queued(&mut self, cx: &mut Context<Self>) {
        // Nothing leaves the queue while a session starts, fails, restores,
        // waits for sign-in or holds for an edit.
        if self.running || self.start_pending || self.failure.is_some() || self.restoring || self.local.blocked() || self.rewind_blocks_send() {
            return;
        }
        let editing = self.queued_edit.as_ref().map(|e| e.id.as_str());
        if let Some(next) = take_next(&mut self.queued, editing) {
            // Remove its tail row before inserting the delivered user item.
            self.sync_rows(cx);
            self.deliver(next.message, cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::path::PathBuf;

    use serde_json::json;

    use super::{QueuedPrompt, display_text, interruption_ends_turn, promote, take_next};
    use crate::chat::Message;

    fn prompt(id: &str) -> QueuedPrompt {
        let mut prompt = QueuedPrompt::new(Message { text: id.into(), ..Message::default() });
        prompt.id = id.into();
        prompt
    }

    #[test]
    fn steering_preserves_other_prompts_and_attachments() {
        let mut queue = VecDeque::from([prompt("first"), prompt("second"), prompt("third")]);
        let images = vec![json!({ "mediaType": "image/png", "data": "aW1hZ2U=" })];
        let files = vec![PathBuf::from("/tmp/spec.md")];
        queue[1].message.images = images.clone();
        queue[1].message.files = files.clone();
        assert!(promote(&mut queue, "second"));
        let next = take_next(&mut queue, None).unwrap();
        assert_eq!(next.message.text, "second");
        assert_eq!(next.message.images, images);
        assert_eq!(next.message.files, files);
        assert_eq!(queue.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), ["first", "third"]);
        assert!(!promote(&mut queue, "removed"));
        assert_eq!(queue.len(), 2);
    }

    #[test]
    fn editing_holds_the_head_until_released() {
        let mut queue = VecDeque::from([prompt("first"), prompt("second")]);
        assert!(take_next(&mut queue, Some("first")).is_none());
        assert_eq!(queue.len(), 2);
        assert_eq!(take_next(&mut queue, Some("second")).unwrap().id, "first");
        assert!(take_next(&mut queue, Some("second")).is_none());
        assert_eq!(take_next(&mut queue, None).unwrap().id, "second");
        assert!(take_next(&mut queue, None).is_none());
    }

    #[test]
    fn saving_text_keeps_image_and_file_only_prompts() {
        let mut bare = prompt("bare");
        assert!(bare.save_text("  Edited\ntext  ".into()));
        assert_eq!(bare.message.text, "Edited\ntext");
        assert!(!bare.save_text(" \n ".into()));
        let mut image = prompt("image");
        image.message.images.push(json!({ "mediaType": "image/png", "data": "aW1hZ2U=" }));
        let images = image.message.images.clone();
        assert!(image.save_text(String::new()));
        assert_eq!(image.message.images, images);
        let mut file = prompt("file");
        file.message.files.push(PathBuf::from("/tmp/spec.md"));
        assert!(file.save_text(String::new()));
        assert_eq!(file.message.files, [PathBuf::from("/tmp/spec.md")]);
    }

    #[test]
    fn codex_interrupt_waits_for_its_result_before_draining() {
        assert!(!interruption_ends_turn(&json!({ "type": "interrupted", "respawn": false })));
        assert!(interruption_ends_turn(&json!({ "type": "interrupted" })));
        assert!(interruption_ends_turn(&json!({ "type": "interrupted", "respawn": true })));
    }

    #[test]
    fn attachment_notes_stay_visible_while_editing() {
        let message = Message {
            text: "Read this".into(),
            files: vec![PathBuf::from("/tmp/spec.md")],
            images: vec![json!({ "mediaType": "image/png", "data": "aW1hZ2U=" })],
        };
        let note = "Attached files:\n- /tmp/spec.md\n\n_1 image(s) attached_";
        assert_eq!(display_text(&message, true), note);
        assert_eq!(display_text(&message, false), format!("Read this\n\n{note}"));
        assert_eq!(display_text(&Message::default(), false), "");
    }
}
