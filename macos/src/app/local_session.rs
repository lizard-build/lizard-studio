//! The panel's local sign-in and Remote Control cards, measured as one tail.

use gpui_kit::component::Sizable as _;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{StudioApp, render_running};
use crate::chat::{ChatSession, LocalCommand, LoginPhase, local_command};
use crate::store::Agent;
use crate::theme::*;
use crate::ui::ph;

impl StudioApp {
    /// Codex broadcasts completion to its sessions, or sends no id if none
    /// exist yet. A sign-in can also start before this chat has a project.
    pub(super) fn route_local_auth_done(&mut self, msg: &serde_json::Value, cx: &mut Context<Self>) -> bool {
        if msg.get("type").and_then(serde_json::Value::as_str) != Some("authDone") {
            return false;
        }
        let id = msg.get("id").and_then(serde_json::Value::as_str);
        let codex = id.is_none() || msg.get("agent").and_then(serde_json::Value::as_str) == Some("codex")
            || id.and_then(|id| self.chat_by_id(id, cx)).is_some_and(|chat| chat.read(cx).meta.agent == Agent::Codex);
        if !codex { return false; }
        for chat in self.chats.clone() {
            let c = chat.read(cx);
            if !c.meta.cloud && c.meta.agent == Agent::Codex && c.local.login.as_ref().is_some_and(|l| l.phase.active()) {
                chat.update(cx, |chat, cx| chat.on_host_message(msg, cx));
            }
        }
        true
    }

    /// Local commands leave attachments in the composer for the next prompt.
    pub(super) fn submit_local_command(&mut self, chat: &Entity<ChatSession>, text: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(command) = local_command(text) else { return false };
        chat.update(cx, |chat, cx| match command {
            LocalCommand::Login => chat.start_login(false, cx),
            LocalCommand::RemoteControl { enabled, name } => chat.start_remote_control(enabled, name, cx),
        });
        self.composer.update(cx, |input, cx| input.set_value("", window, cx));
        self.menu = None;
        cx.notify();
        true
    }
}

fn button(id: &'static str, label: &'static str, primary: bool) -> Stateful<Div> {
    div().id(id).h(px(32.)).px(px(12.)).flex().items_center().justify_center()
        .rounded(px(8.)).border_1().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).cursor_pointer()
        .when(primary, |d| d.bg(rgba_hex(EMERALD, 0.5)).border_color(hex(EMERALD)).text_color(white()).hover(|s| s.bg(hex(EMERALD))))
        .when(!primary, |d| d.border_color(hex(BORDER)).text_color(hex(TEXT_SECONDARY)).hover(|s| s.text_color(hex(TEXT_PRIMARY))))
        .child(label)
}

fn link(id: &'static str, label: &'static str) -> Stateful<Div> {
    div().id(id).mt(px(10.)).text_size(px(11.)).font_weight(FontWeight::MEDIUM)
        .text_color(hex(TEXT_TERTIARY)).cursor_pointer().hover(|s| s.text_color(hex(TEXT_SECONDARY))).child(label)
}

fn card(title: &'static str, status: String, busy: bool, error: bool, done: bool) -> Div {
    div().my(px(4.)).w(relative(0.9)).px(px(16.)).pt(px(14.)).pb(px(16.)).rounded(px(12.)).bg(hex(BG_SECONDARY))
        .flex().flex_col().items_start()
        .child(div().flex().items_center().gap(px(8.)).mb(px(4.))
            .when(busy, |d| d.child(spinner(title)))
            .when(done, |d| d.child(ph("check", 13., hex(EMERALD))))
            .child(div().text_size(px(14.)).line_height(px(20.)).font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_PRIMARY)).child(title)))
        .child(div().text_size(px(12.)).line_height(px(18.)).font_weight(FontWeight::MEDIUM)
            .text_color(hex(if error { RED_SOFT } else if done { TEXT_PRIMARY } else { TEXT_SECONDARY })).child(status))
}

fn spinner(id: &'static str) -> AnyElement {
    div().size(px(13.)).flex_none()
        .with_animation(id, Animation::new(std::time::Duration::from_millis(700)).repeat(), |d, t| {
            d.child(canvas(|_, _, _| (), move |bounds, _, window, _| {
                let point_at = |turn: f32| {
                    let angle = (turn + t) * std::f32::consts::TAU;
                    point(bounds.center().x + px(5.5) * angle.cos(), bounds.center().y + px(5.5) * angle.sin())
                };
                for (fraction, color) in [(1., rgba_hex(EMERALD, 0.3)), (0.25, hex(EMERALD))] {
                    let mut arc = PathBuilder::stroke(px(2.));
                    arc.move_to(point_at(0.));
                    for step in 1..=48 { arc.line_to(point_at(fraction * step as f32 / 48.)); }
                    if let Ok(path) = arc.build() { window.paint_path(path, color); }
                }
            }).size_full())
        }).into_any_element()
}

fn open_fallback(entity: &Entity<ChatSession>, window: &mut Window, cx: &mut App) {
    entity.update(cx, |chat, cx| {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Authorization code"));
        cx.subscribe_in(&input, window, |chat, input, event: &InputEvent, _, cx| {
            if let InputEvent::PressEnter { .. } = event {
                chat.submit_auth_code(input.read(cx).value().to_string(), cx);
            }
        }).detach();
        input.update(cx, |input, cx| input.focus(window, cx));
        if let Some(login) = &mut chat.local.login {
            login.input = Some(input);
        }
        chat.remeasure_tail();
        cx.notify();
    });
}

pub(super) fn render_local_session(entity: &Entity<ChatSession>, cx: &mut App) -> AnyElement {
    let chat = entity.read(cx);
    let mut tail = div().flex().flex_col().gap(px(8.)).pt(px(if chat.items.is_empty() { 0. } else { 14. }));
    if let Some(login) = &chat.local.login {
        let codex = chat.meta.agent == Agent::Codex;
        let phase = login.phase;
        let mut body = card(if codex { "Sign in to ChatGPT" } else { "Sign in to Claude Code" }, login.status.clone(), phase.active(), phase == LoginPhase::Failed, phase == LoginPhase::Done);
        if let Some(url) = login.url.clone().filter(|_| phase == LoginPhase::Waiting) {
            body = body.child(button("local-login-open", "Open sign-in page", true).mt(px(12.)).on_click(move |_, _, cx| cx.open_url(&url)));
            if let Some(code) = login.code.clone() {
                let copy = code.clone();
                body = body.child(div().id("local-device-code").my(px(12.)).text_size(px(20.)).font_family("Lizard Mono")
                    .font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_PRIMARY)).cursor_pointer()
                    .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(copy.clone())))
                    .child(code));
            }
            if !codex {
                if let Some(input) = login.input.clone() {
                    let chat = entity.clone();
                    let code = input.clone();
                    body = body.child(div().mt(px(10.)).w_full().flex().gap(px(8.)).items_center()
                        .child(div().flex_1().min_w_0().h(px(32.)).px(px(10.)).flex().items_center().bg(hex(BG_PRIMARY)).border_1().border_color(hex(BORDER)).rounded(px(8.))
                            .child(Input::new(&input).appearance(false).xsmall().text_size(px(12.)).font_family("Lizard Mono")))
                        .child(button("local-login-submit", "Sign in", true).on_click(move |_, _, cx| {
                            let value = code.read(cx).value().to_string();
                            chat.update(cx, |chat, cx| chat.submit_auth_code(value, cx));
                        })));
                } else {
                    let chat = entity.clone();
                    body = body.child(link("local-login-fallback", "Having trouble? Paste the code manually").on_click(move |_, window, cx| open_fallback(&chat, window, cx)));
                }
            }
        }
        if phase.active() {
            let chat = entity.clone();
            body = body.child(link("local-login-cancel", "Cancel sign-in").on_click(move |_, _, cx| chat.update(cx, |chat, cx| chat.cancel_login(cx))));
        } else if phase == LoginPhase::Failed {
            let chat = entity.clone();
            body = body.child(button("local-login-retry", "Try again", true).mt(px(12.)).on_click(move |_, _, cx| chat.update(cx, |chat, cx| chat.start_login(false, cx))));
        }
        tail = tail.child(body);
    }
    if let Some(remote) = &chat.local.remote {
        let mut body = card("Remote Control", remote.status.clone(), remote.busy, remote.error, !remote.busy && !remote.error);
        if remote.enabled && !remote.busy {
            let mut actions = div().mt(px(12.)).flex().flex_wrap().items_center().gap(px(8.));
            if let Some(url) = remote.url.clone() {
                let open = url.clone();
                let chat = entity.clone();
                actions = actions.child(button("remote-open", "Open in Claude", true).on_click(move |_, _, cx| cx.open_url(&open)))
                    .child(button("remote-copy", if remote.copied { "Copied" } else { "Copy link" }, false).on_click(move |_, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                        chat.update(cx, |chat, cx| {
                            if let Some(remote) = &mut chat.local.remote { remote.copied = true; }
                            cx.notify();
                        });
                    }));
            }
            let chat = entity.clone();
            body = body.child(actions.child(button("remote-off", "Turn off", false).on_click(move |_, _, cx| chat.update(cx, |chat, cx| chat.start_remote_control(false, None, cx)))));
        }
        tail = tail.child(body);
    }
    if chat.running {
        tail = tail.child(render_running(chat));
    }
    tail.into_any_element()
}
