//! The panel's question card doubles as Codex's durable answer receipt.

use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::select::Select;
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{StudioApp, perm_option, render_question};
use crate::chat::{ChatSession, FieldKind, Permission, PermissionChoice};
use crate::store::Agent;
use crate::theme::*;
use crate::ui::ph;

fn card() -> Div {
    div().w_full().flex().flex_col().px(px(14.)).pt(px(12.)).pb(px(10.)).rounded(px(12.)).bg(hex(BG_CARD))
}

pub(super) fn dismiss_button(entity: &Entity<ChatSession>, perm: &Permission) -> Option<AnyElement> {
    let question = perm.async_question.as_ref()?;
    if question.sending || question.status.is_some() { return None; }
    let chat = entity.clone();
    let id = perm.request_id.clone();
    Some(div().id("dismiss-question").ml_auto().px(px(8.)).py(px(3.)).rounded(px(6.))
        .border_1().border_color(white_a(0.12)).text_size(px(11.)).text_color(hex(TEXT_SECONDARY))
        .cursor_pointer().hover(|s| s.bg(hex(BG_PRIMARY)).text_color(hex(TEXT_PRIMARY)))
        .on_click(move |_, _, cx| chat.update(cx, |c, cx| c.answer_permission(&id, PermissionChoice::Deny, cx)))
        .child("Dismiss").into_any_element())
}

pub(super) fn render_async_question(entity: &Entity<ChatSession>, perm: &Permission, other_answer: &Entity<InputState>) -> AnyElement {
    let Some(q) = &perm.async_question else { return div().into_any_element() };
    if perm.question_editable() && perm.question_ix < perm.questions.len() {
        return render_question(entity, perm, Agent::Codex, other_answer, card()).into_any_element();
    }
    let chat = entity.clone();
    let id = perm.request_id.clone();
    let hint = q.status.clone().or_else(|| q.error.clone()).unwrap_or_else(|| "Sending answer…".into());
    card().child(div().flex().items_center().gap(px(7.))
        .child(ph("chat", 14., hex(TEXT_SECONDARY)))
        .child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).child(if q.status.is_some() { "ChatGPT asked" } else { "ChatGPT is asking" }))
        .children(dismiss_button(entity, perm)))
        .children(perm.questions.iter().map(|question| {
            div().child(div().mt(px(8.)).mb(px(10.)).text_size(px(13.)).font_weight(FontWeight::MEDIUM).line_height(relative(1.45)).child(question.question.clone()))
                .when_some(perm.answers.get(perm.answer_key(question)).cloned(), |d, answer| d.child(div().text_size(px(12.5)).child(answer)))
                .when(!perm.answers.contains_key(perm.answer_key(question)), |d| d.children(question.options.iter().map(|(label, _)| div().text_size(px(11.5)).text_color(hex(TEXT_TERTIARY)).child(label.clone()))))
        }))
        .child(div().mt(px(8.)).text_size(px(10.5)).text_color(hex(if q.error.is_some() { RED } else { TEXT_TERTIARY })).child(hint))
        .when(q.error.is_some() && q.status.is_none(), |d| d.child(
            perm_option(("retry-answer", 0), 1, "Retry answer".into(), None, false, false)
                .on_click(move |_, _, cx| chat.update(cx, |c, cx| c.send_question_answer(&id, cx)))
        ))
        .into_any_element()
}

pub(super) fn render_elicitation(entity: &Entity<ChatSession>, window: &mut Window, cx: &mut App) -> AnyElement {
    let Some(id) = entity.read(cx).permissions.first().map(|p| p.request_id.clone()) else { return div().into_any_element() };
    entity.update(cx, |c, cx| c.prepare_elicitation(&id, window, cx));
    let chat = entity.read(cx);
    let Some(perm) = chat.permissions.first() else { return div().into_any_element() };
    let Some(form) = &perm.elicitation else { return div().into_any_element() };
    let title = perm.input["serverName"].as_str().unwrap_or("MCP server").to_string();
    let message = perm.input["message"].as_str().map(str::to_string).or_else(|| perm.description.clone());
    let mut fields = div().id("elicitation-fields").mt(px(8.)).max_h(px(260.)).overflow_y_scroll().flex().flex_col();
    if let Some(url) = &form.url {
        let link = url.clone();
        fields = fields.child(div().mt(px(6.)).text_size(px(12.)).text_color(hex(TEXT_SECONDARY)).child(url.clone()))
            .child(perm_option(("elicitation-url", 0), 0, "Open link".into(), None, false, false)
                .on_click(move |_, _, cx| cx.open_url(&link)));
    }
    for (field_ix, field) in form.fields.iter().enumerate() {
        let title = format!("{}{}", field.title, if field.required { " *" } else { "" });
        let mut row = div().mt(px(8.)).mb(px(10.)).flex().flex_col()
            .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).line_height(relative(1.45)).child(title))
            .when_some(field.description.clone(), |d, description| d.child(div().mt(px(6.)).text_size(px(12.)).text_color(hex(TEXT_SECONDARY)).child(description)));
        match &field.kind {
            FieldKind::Choice { multiple: false, .. } => {
                if let Some(select) = &field.select {
                    row = row.child(div().mt(px(6.)).px(px(9.)).py(px(6.)).rounded(px(7.)).bg(hex(BG_PRIMARY)).border_1().border_color(hex(BORDER))
                        .child(Select::new(select).placeholder("Choose…").cleanable(true).appearance(false).xsmall().w_full()));
                }
            }
            FieldKind::Choice { options, multiple: true } => {
                let mut choices = div().mt(px(6.)).flex().flex_col().gap(px(1.));
                for (option_ix, (value, label)) in options.iter().enumerate() {
                    let selected = field.value.as_array().is_some_and(|values| values.contains(value));
                    let chat = entity.clone();
                    let rid = id.clone();
                    choices = choices.child(div().id(SharedString::from(format!("field-{field_ix}-{option_ix}"))).px(px(9.)).py(px(6.))
                        .rounded(px(7.)).flex().items_center().gap(px(7.)).text_size(px(12.5)).cursor_pointer()
                        .text_color(hex(if selected { TEXT_PRIMARY } else { TEXT_SECONDARY }))
                        .when(selected, |d| d.bg(white_a(0.06))).hover(|s| s.bg(white_a(0.06)))
                        .on_click(move |_, _, cx| chat.update(cx, |c, cx| c.pick_elicitation(&rid, field_ix, Some(option_ix), cx)))
                        .child(div().flex_1().child(label.clone()))
                        .when(selected, |d| d.child(ph("check", 13., hex(TEXT_PRIMARY)))));
                }
                row = row.child(choices);
            }
            _ => {
                if let Some(input) = &field.input {
                    row = row.child(div().mt(px(6.)).px(px(9.)).py(px(6.)).rounded(px(7.)).bg(hex(BG_PRIMARY)).border_1().border_color(hex(BORDER))
                        .child(Input::new(input).appearance(false).xsmall().text_size(px(12.5)).h(px(18.))));
                }
            }
        }
        fields = fields.child(row);
    }
    if !form.supported {
        fields = fields.child(div().mt(px(6.)).text_size(px(12.)).text_color(hex(TEXT_SECONDARY))
            .child("This request uses a form this version cannot display. You can decline or cancel it."));
    }
    let options = elicitation_options(perm);
    card().child(div().flex().items_center().gap(px(7.)).child(ph("server", 14., hex(TEXT_SECONDARY)))
        .child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).child(title)))
        .when_some(message, |d, text| d.child(div().mt(px(3.)).pl(px(21.)).text_size(px(11.5)).text_color(hex(TEXT_SECONDARY)).child(text)))
        .child(fields)
        .when_some(form.error.clone(), |d, error| d.child(div().mt(px(6.)).text_size(px(12.)).text_color(hex(RED)).child(error)))
        .child(div().mt(px(12.)).mb(px(6.)).text_size(px(13.)).font_weight(FontWeight::MEDIUM).child("Do you want to proceed?"))
        .child(div().flex().flex_col().gap(px(1.)).mx(px(-6.)).children(options.into_iter().enumerate().map(|(i, label)| {
            let chat = entity.clone();
            let hover_chat = entity.clone();
            let rid = id.clone();
            let hover_id = id.clone();
            perm_option(("elicitation-option", i), i + 1, label.into(), None, perm.hovered == i, false)
                .on_hover(move |over, _, cx| { if *over { hover_chat.update(cx, |c, cx| c.hover_option(&hover_id, i, cx)); } })
                .on_click(move |_, _, cx| chat.update(cx, |c, cx| c.answer_elicitation(&rid, i, cx)))
        })))
        .into_any_element()
}

fn elicitation_options(perm: &Permission) -> Vec<&'static str> {
    let Some(form) = &perm.elicitation else { return Vec::new() };
    let mut options = Vec::new();
    if form.supported { options.push(if form.url.is_some() { "I've completed this step" } else { "Allow" }); }
    options.extend(["Decline", "Cancel"]);
    options
}

impl StudioApp {
    /// Form inputs own their keys; Escape still cancels the server request.
    pub(super) fn elicitation_key(&mut self, key: &str, modified: bool, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let entity = self.chats[self.active].clone();
        let chat = entity.read(cx);
        let Some(perm) = chat.permissions.first().filter(|p| p.elicitation.is_some()) else { return false };
        let id = perm.request_id.clone();
        let count = elicitation_options(perm).len();
        let hovered = perm.hovered;
        let focused = perm.elicitation.as_ref().is_some_and(|form| form.fields.iter().any(|field| field.input.as_ref().is_some_and(|input| input.focus_handle(cx).is_focused(window)) || field.select.as_ref().is_some_and(|select| select.focus_handle(cx).contains_focused(window, cx))));
        if key == "escape" {
            entity.update(cx, |c, cx| c.answer_elicitation(&id, count - 1, cx));
            cx.stop_propagation();
        } else if focused || modified || !self.composer.read(cx).value().trim().is_empty() {
            return true;
        } else {
            let option = if key == "enter" { Some(hovered) } else { key.parse::<usize>().ok().filter(|n| *n >= 1 && *n <= count).map(|n| n - 1) };
            if let Some(option) = option {
                entity.update(cx, |c, cx| c.answer_elicitation(&id, option, cx));
                cx.stop_propagation();
            } else if key == "up" || key == "down" {
                let next = if key == "up" { (hovered + count - 1) % count } else { (hovered + 1) % count };
                entity.update(cx, |c, cx| c.hover_option(&id, next, cx));
                cx.stop_propagation();
            }
        }
        true
    }
}
