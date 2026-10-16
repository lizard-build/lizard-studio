//! Plan review stays in the window; synthetic replies share the chat's markdown.

use std::time::Duration;

use gpui_kit::component::text::TextViewState;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{StudioApp, TITLEBAR_H, icon_button, markdown_view};
use crate::chat::agent_events::{EventItem, plan_title};
use crate::chat::{ChatEvent, ChatSession, Permission};
use crate::theme::*;
use crate::ui::ph;

pub(super) struct PlanView {
    title: String,
    view: Entity<TextViewState>,
    focus: FocusHandle,
    focused: bool,
}

impl StudioApp {
    pub(super) fn open_plan(&mut self, plan: &str, cx: &mut Context<Self>) {
        self.menu = None;
        self.plan = Some(PlanView {
            title: plan_title(plan),
            view: cx.new(|cx| TextViewState::markdown(plan, cx).selectable(true)),
            focus: cx.focus_handle(),
            focused: false,
        });
        cx.notify();
    }

    pub(super) fn close_plan(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.plan = None;
        self.composer.update(cx, |state, cx| state.focus(window, cx));
        cx.notify();
    }

    pub(super) fn render_plan(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(plan) = &mut self.plan else { return div().into_any_element() };
        if !plan.focused {
            plan.focus.focus(window, cx);
            plan.focused = true;
        }
        let height = 720f32.min(f32::from(self.viewport.height) - TITLEBAR_H - 40.);
        div()
            .id("plan-overlay")
            .occlude()
            .absolute()
            .top(px(TITLEBAR_H))
            .left_0()
            .right_0()
            .bottom_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(20.))
            .bg(hsla(0., 0., 0., 0.55))
            .on_click(cx.listener(|this, _, window, cx| this.close_plan(window, cx)))
            .child(
                div()
                    .id("plan-modal")
                    .track_focus(&plan.focus)
                    .flex()
                    .flex_col()
                    .w_full()
                    .max_w(px(760.))
                    .h(px(height.max(120.)))
                    .bg(hex(BG_SECONDARY))
                    .border_1()
                    .border_color(hex(BORDER))
                    .rounded(px(14.))
                    .overflow_hidden()
                    .shadow(vec![BoxShadow {
                        color: hsla(0., 0., 0., 0.55),
                        offset: point(px(0.), px(20.)),
                        blur_radius: px(60.),
                        spread_radius: px(0.),
                        inset: false,
                    }])
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(
                        div().flex().flex_none().items_center().gap(px(10.)).px(px(18.)).py(px(12.))
                            .border_b_1().border_color(hex(BORDER))
                            .child(ph("todo", 20., hex(EMERALD)))
                            .child(div().flex_1().min_w_0().truncate().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).child(plan.title.clone()))
                            .child(icon_button("plan-close", "x", 15.).on_click(cx.listener(|this, _, window, cx| this.close_plan(window, cx)))),
                    )
                    .child(
                        div().id("plan-body").flex_1().min_h_0().overflow_y_scroll().p(px(24.))
                            .text_size(px(14.)).line_height(relative(1.55)).text_color(hex(TEXT_PRIMARY))
                            .child(markdown_view(&plan.view)),
                    ),
            )
            .into_any_element()
    }
}

pub(super) fn render_plan_hint(entity: &Entity<ChatSession>, perm: &Permission) -> Option<AnyElement> {
    let plan = (perm.tool_name == "ExitPlanMode").then(|| perm.input.get("plan").and_then(serde_json::Value::as_str)).flatten()?;
    if plan.trim().is_empty() { return None; }
    let title = plan_title(plan);
    let plan = plan.to_string();
    let entity = entity.clone();
    Some(
        div().mt(px(8.)).flex().flex_col().items_start()
            .child(
                div().w_full().flex().items_center().gap(px(7.)).text_size(px(12.5))
                    .child(ph("todo", 13., hex(TEXT_TERTIARY)))
                    .child(div().min_w_0().truncate().font_weight(FontWeight::MEDIUM).text_color(hex(TEXT_PRIMARY)).child(title)),
            )
            .child(
                div().id("view-plan").mt(px(8.)).flex().items_center().gap(px(6.)).px(px(11.)).py(px(6.))
                    .text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(hex(TEXT_PRIMARY))
                    .bg(white_a(0.05)).border_1().border_color(hex(BORDER)).rounded(px(7.)).cursor_pointer()
                    .hover(|s| s.bg(white_a(0.09)))
                    .on_click(move |_, _, cx| {
                        entity.update(cx, |_, cx| cx.emit(ChatEvent::ViewPlan(plan.clone())));
                        cx.stop_propagation();
                    })
                    .child(ph("todo", 13., hex(EMERALD))).child("View plan"),
            )
            .into_any_element(),
    )
}

pub(super) fn render_event(entity: &Entity<ChatSession>, event: &EventItem) -> AnyElement {
    match event {
        EventItem::Hidden => div().into_any_element(),
        EventItem::Output(view) => div().w_full().text_size(px(14.)).line_height(relative(1.55)).text_color(hex(TEXT_PRIMARY))
            .child(markdown_view(view)).into_any_element(),
        EventItem::Usage(reply) => {
            let mut card = div().w_full().flex().flex_col().gap(px(14.)).bg(hex(BG_SECONDARY)).rounded(px(10.)).py(px(12.)).px(px(14.))
                .child(div().text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_TERTIARY)).child("Plan usage"));
            for row in &reply.rows {
                card = card.child(
                    div().flex().flex_col().gap(px(6.))
                        .child(
                            div().flex().items_baseline().justify_between().gap(px(10.))
                                .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(hex(TEXT_PRIMARY)).child(row.label.clone()))
                                .child(div().flex_none().text_size(px(12.5)).font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_SECONDARY)).child(format!("{}%", row.pct))),
                        )
                        .child(div().w_full().h(px(5.)).rounded_full().bg(white_a(0.08)).overflow_hidden()
                            .child(div().h_full().w(relative(row.pct as f32 / 100.)).rounded_full().bg(hex(EMERALD))))
                        .when(!row.resets.is_empty(), |d| d.child(div().text_size(px(11.5)).text_color(hex(TEXT_TERTIARY)).child(format!("Resets {}", row.resets)))),
                );
            }
            card.when(!reply.intro.is_empty(), |d| d.child(div().text_size(px(11.5)).line_height(relative(1.4)).text_color(hex(TEXT_TERTIARY)).child(reply.intro.clone()))).into_any_element()
        }
        EventItem::RateLimit { id, warn, fading, hidden } => {
            if *hidden { return div().into_any_element(); }
            let entity = entity.clone();
            let id = *id;
            let color = if *warn { hex(WARN_SOFT) } else { hex(TEXT_SECONDARY) };
            let note = div().w_full().flex().justify_center()
                .child(
                    div().max_w(relative(0.9)).flex().items_center().gap(px(6.)).pl(px(12.)).pr(px(6.)).py(px(5.))
                        .rounded(px(8.)).text_size(px(11.)).font_weight(FontWeight::MEDIUM).text_color(color)
                        .bg(if *warn { rgba_hex(YELLOW, 0.12) } else { hex(BG_CARD) })
                        .when(*warn, |d| d.child(ph("warning", 13., color)))
                        .child(if *warn { "Usage limit reached — requests are paused" } else { "Approaching your usage limit" })
                        .child(
                            div().id(("dismiss-rate-note", id)).flex_none().size(px(18.)).flex().items_center().justify_center()
                                .rounded(px(5.)).cursor_pointer().opacity(0.55).hover(|s| s.opacity(1.).bg(white_a(0.08)))
                                .on_click(move |_, _, cx| entity.update(cx, |c, cx| c.change_rate_note(id, true, cx)))
                                .child(ph("x", 12., color)),
                        ),
                );
            if *fading {
                note.with_animation(("rate-note-fade", id), Animation::new(Duration::from_millis(180)), |d, t| d.opacity(1. - t)).into_any_element()
            } else {
                note.into_any_element()
            }
        }
    }
}
