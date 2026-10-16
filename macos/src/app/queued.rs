//! Waiting user bubbles, matching panel.css `.msg-user.queued`.

use gpui_kit::component::input::Textarea;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{StudioApp, markdown_view};
use crate::chat::ChatSession;
use crate::theme::*;
use crate::ui::ph;

impl StudioApp {
    /// Let the inline editor own keys that otherwise stop a turn or answer a permission.
    pub(super) fn queued_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let chat = self.chats[self.active].clone();
        let focused = chat.read(cx).queued_edit.as_ref().is_some_and(|e| e.input.read(cx).focus_handle(cx).is_focused(window));
        if !focused {
            return false;
        }
        if event.keystroke.key == "escape" {
            chat.update(cx, |c, cx| c.finish_queued_edit(false, window, cx));
            cx.stop_propagation();
            window.prevent_default();
        }
        true
    }
}

pub(super) fn render_queued(entity: &Entity<ChatSession>, ix: usize, composer_focus: &FocusHandle, cx: &mut App) -> AnyElement {
    let Some(view) = entity.update(cx, |c, cx| c.queued_view(ix, cx)) else { return div().into_any_element() };
    let chat = entity.read(cx);
    let Some(prompt) = chat.queued.get(ix) else { return div().into_any_element() };
    let id = prompt.id.clone();
    let group: SharedString = format!("queued-{id}").into();
    let editor = chat.queued_edit.as_ref().filter(|e| e.id == id).map(|e| e.input.clone());
    let editing = editor.is_some();
    let gap = if chat.items.is_empty() && chat.tail() == crate::chat::Tail::None && ix == 0 { 0. } else { 14. };
    let show_view = !editing || !prompt.message.images.is_empty() || !prompt.message.files.is_empty();
    let edit_chat = entity.clone();
    let edit_id = id.clone();
    let return_focus = composer_focus.clone();
    let steer_chat = entity.clone();
    let steer_id = id.clone();
    let remove_chat = entity.clone();

    div()
        .pt(px(gap))
        .child(
            div()
                .group(group.clone())
                .relative()
                .w_full()
                .child(
                    div()
                        .id(SharedString::from(format!("queued-bubble-{id}")))
                        .w_full()
                        .px(px(12.))
                        .py(px(8.))
                        .pr(px(124.))
                        .rounded(px(10.))
                        .bg(hex(BG_SECONDARY))
                        .border_1()
                        .border_color(white_a(0.08))
                        .text_size(px(14.))
                        .line_height(relative(1.55))
                        .text_color(hex(TEXT_PRIMARY))
                        .when(!editing, |d| d.opacity(0.55).cursor_text())
                        .on_click(move |_, window, cx| edit_chat.update(cx, |c, cx| c.begin_queued_edit(&edit_id, &return_focus, window, cx)))
                        .when_some(editor, |d, input| {
                            d.child(Textarea::new(&input).appearance(false).bordered(false).xsmall().text_size(px(14.)).line_height(relative(1.55)))
                        })
                        .when(show_view, |d| d.child(markdown_view(&view))),
                )
                .child(
                    div()
                        .absolute()
                        .top(relative(0.5))
                        .mt(px(-11.))
                        .right(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .when(!editing, |d| d.invisible().group_hover(group, |s| s.visible()))
                        .child(
                            div()
                                .id(SharedString::from(format!("queued-steer-{id}")))
                                .h(px(22.))
                                .px(px(5.))
                                .flex()
                                .items_center()
                                .gap(px(4.))
                                .rounded(px(5.))
                                .text_size(px(11.))
                                .text_color(hex(TEXT_TERTIARY))
                                .cursor_pointer()
                                .hover(|s| s.bg(white_a(0.08)).text_color(hex(TEXT_PRIMARY)))
                                .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Stop the current reply and send this message").build(window, cx))
                                // Keep an editor locked until the action has saved or removed it.
                                .on_mouse_down(MouseButton::Left, |_, window, cx| { window.prevent_default(); cx.stop_propagation(); })
                                .on_click(move |_, window, cx| steer_chat.update(cx, |c, cx| c.steer_queued(&steer_id, window, cx)))
                                .child(ph("send", 13., hex(TEXT_TERTIARY)))
                                .child("Steer"),
                        )
                        .child(
                            div()
                                .id(SharedString::from(format!("queued-remove-{id}")))
                                .size(px(22.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(5.))
                                .cursor_pointer()
                                .hover(|s| s.bg(rgba_hex(RED, 0.12)))
                                .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Remove from queue").build(window, cx))
                                .on_mouse_down(MouseButton::Left, |_, window, cx| { window.prevent_default(); cx.stop_propagation(); })
                                .on_click(move |_, window, cx| remove_chat.update(cx, |c, cx| c.remove_queued(&id, window, cx)))
                                .child(ph("x", 13., hex(TEXT_TERTIARY))),
                        ),
                ),
        )
        .into_any_element()
}
