//! Sent prompts keep their bubble dimensions when swapped for an editor.

use gpui_kit::component::input::Textarea;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::chat::{ChatSession, Item};
use crate::theme::{BG_SECONDARY, TEXT_PRIMARY, hex, white_a};

pub(super) fn render_user(entity: &Entity<ChatSession>, image_app: &WeakEntity<super::StudioApp>, ix: usize, cx: &mut App) -> AnyElement {
    let chat = entity.read(cx);
    let Item::User { view, images, .. } = &chat.items[ix] else { return div().into_any_element() };
    let thumbs = super::images::bubble_thumbs(images, image_app, ix);
    let editor = chat.user_editor(ix);
    let editable = editor.is_none() && chat.can_edit(ix);
    let entity = entity.clone();
    div()
        .id(("user-message", ix))
        .w_full()
        .px(px(12.))
        .py(px(8.))
        .rounded(px(10.))
        .bg(hex(BG_SECONDARY))
        .border_1()
        .border_color(white_a(0.08))
        .text_size(px(14.))
        .line_height(relative(1.55))
        .text_color(hex(TEXT_PRIMARY))
        .when(editable, |d| {
            d.cursor_pointer()
                .hover(|s| s.border_color(white_a(0.22)))
                .on_click(move |_, window, cx| entity.update(cx, |chat, cx| chat.begin_edit(ix, window, cx)))
        })
        .children(thumbs)
        .child(match editor {
            Some((input, pending)) => div()
                // XSmall's internal 4px inset must not shift the bubble text.
                .mx(px(-4.))
                .child(Textarea::new(&input)
                    .appearance(false)
                    .bordered(false)
                    .xsmall()
                    .disabled(pending)
                    .aria_label("Edit message")
                    .text_size(px(14.))
                    .line_height(relative(1.55)))
                .into_any_element(),
            None => super::markdown_view(view).into_any_element(),
        })
        .into_any_element()
}
