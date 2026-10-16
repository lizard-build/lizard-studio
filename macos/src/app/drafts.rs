//! Keep unsent text and attachments with their chat when the composer moves.

use std::collections::HashMap;

use gpui_kit::*;

use super::{StudioApp, attach::Attachment};

struct Draft<T> {
    text: String,
    attachments: Vec<T>,
}

#[derive(Default)]
pub(super) struct Drafts {
    pub chat: Option<String>,
    saved: HashMap<String, Draft<Attachment>>,
}

fn exchange<T>(saved: &mut HashMap<String, Draft<T>>, old: Option<String>, next: &str, text: String, attachments: Vec<T>) -> Draft<T> {
    if let Some(old) = old {
        if text.is_empty() && attachments.is_empty() {
            saved.remove(&old);
        } else {
            saved.insert(old, Draft { text, attachments });
        }
    }
    saved.remove(next).unwrap_or_else(|| Draft { text: String::new(), attachments: Vec::new() })
}

impl StudioApp {
    pub(super) fn has_draft(&self, id: &str, cx: &App) -> bool {
        if self.drafts.chat.as_deref() == Some(id) {
            !self.composer.read(cx).value().is_empty() || !self.attachments.is_empty()
        } else {
            self.drafts.saved.contains_key(id)
        }
    }

    pub(super) fn switch_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let next = self.chats[self.active].read(cx).id().to_string();
        if self.drafts.chat.as_deref() == Some(next.as_str()) {
            return;
        }
        let text = self.composer.read(cx).value().to_string();
        let draft = exchange(&mut self.drafts.saved, self.drafts.chat.replace(next.clone()), &next, text, std::mem::take(&mut self.attachments));
        self.attachments = draft.attachments;
        self.composer.update(cx, |state, cx| state.set_value(draft.text, window, cx));
        // Deleted chats must not leave attachments alive in the draft map.
        self.drafts.saved.retain(|id, _| self.chats.iter().any(|c| c.read(cx).id() == id));
    }
}

#[cfg(test)]
mod tests {
    use super::{Draft, exchange};
    use std::collections::HashMap;

    #[test]
    fn switching_restores_text_and_attachments_and_consumes_the_saved_draft() {
        let mut saved = HashMap::new();
        let fresh = exchange(&mut saved, Some("a".into()), "b", "unfinished".into(), vec![42]);
        assert!(fresh.text.is_empty());
        let restored = exchange(&mut saved, Some("b".into()), "a", "second".into(), vec![7]);
        assert_eq!(restored.text, "unfinished");
        assert_eq!(restored.attachments, vec![42]);
        assert!(!saved.contains_key("a"));
        assert_eq!(saved["b"].text, "second");
    }

    #[test]
    fn an_empty_composer_drops_the_old_draft_but_attachment_only_drafts_survive() {
        let mut saved: HashMap<String, Draft<u8>> = HashMap::new();
        exchange(&mut saved, Some("a".into()), "b", String::new(), vec![1]);
        exchange(&mut saved, Some("b".into()), "c", String::new(), vec![]);
        assert!(saved.contains_key("a"));
        assert!(!saved.contains_key("b"));
    }
}
