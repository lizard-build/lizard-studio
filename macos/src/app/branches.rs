//! Branch checkout shares the panel's host operation and setup menu styling.

use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Value, json};

use super::{Menu, StudioApp};
use crate::pop;
use crate::theme::*;
use crate::ui::ph;

#[derive(Default)]
pub(super) struct Branches {
    current: Option<String>,
    names: Vec<String>,
}

fn branches_from(msg: &Value) -> Branches {
    Branches {
        current: msg.get("current").and_then(Value::as_str).filter(|s| !s.is_empty() && *s != "HEAD").map(str::to_string),
        names: msg.get("branches").and_then(Value::as_array).map(|names| names.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
    }
}

impl StudioApp {
    pub(super) fn toggle_branches(&mut self, cx: &mut Context<Self>) {
        if self.menu == Some(Menu::Branch) {
            self.menu = None;
        } else {
            let chat = self.chats[self.active].read(cx);
            let Some(cwd) = chat.work_cwd() else { return };
            self.host.send(json!({ "type": "gitBranches", "id": chat.id(), "agent": chat.meta.agent.wire(), "cwd": cwd }));
            self.menu = Some(Menu::Branch);
        }
        cx.notify();
    }

    pub(super) fn on_branches(&mut self, msg: &Value, cx: &mut Context<Self>) {
        let Some(cwd) = msg.get("cwd").and_then(Value::as_str) else { return };
        let branches = branches_from(msg);
        let git = self.git.entry(cwd.to_string()).or_default();
        git.is_repo = msg.get("isRepo").and_then(Value::as_bool).unwrap_or(false);
        git.branch = branches.current.clone();
        self.branches.insert(cwd.to_string(), branches);
        if msg.get("checkedOut").and_then(Value::as_bool) == Some(true) {
            if let Some(chat) = msg.get("id").and_then(Value::as_str).and_then(|id| self.chat_by_id(id, cx)) {
                chat.update(cx, |c, cx| c.on_host_message(msg, cx));
            }
            self.refresh_git(cwd.to_string(), cx);
        }
        cx.notify();
    }

    pub(super) fn render_branch_menu(&mut self, blank: bool, cx: &mut Context<Self>) -> Option<AnyElement> {
        let trigger = if blank { "branch-chip" } else { "git-flap" };
        let row = self.bounds.borrow().get(if blank { "setup" } else { "git-flap" }).copied()?;
        let cwd = self.chats[self.active].read(cx).work_cwd()?;
        let branches = self.branches.get(&cwd);
        let names = branches.map(|b| b.names.clone()).unwrap_or_default();
        let current = branches.and_then(|b| b.current.clone());
        let width = 280f32.min(f32::from(row.size.width) - 4.).max(200.);
        let spot = pop::spot(f32::from(row.left()) + 2., f32::from(row.top()) + 4., width, 10., row, f32::from(self.viewport.width));
        let close = self.close_picker_listener(trigger, cx);
        let rows = names.iter().enumerate().map(|(i, branch)| {
            let branch = branch.clone();
            let cwd = cwd.clone();
            let current = current.as_deref() == Some(branch.as_str());
            div()
                .id(("branch-item", i))
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(8.))
                .py(px(7.))
                .when(i > 0, |d| d.mt(px(3.)))
                .rounded(px(7.))
                .cursor_pointer()
                .when(current, |d| d.bg(white_a(0.08)))
                .hover(|s| s.bg(white_a(0.06)))
                .on_click(cx.listener({
                    let branch = branch.clone();
                    move |this, _, _, cx| {
                        this.menu = None;
                        if !current {
                            let chat = this.chats[this.active].read(cx);
                            this.host.send(json!({ "type": "checkoutBranch", "id": chat.id(), "agent": chat.meta.agent.wire(), "cwd": cwd, "branch": branch }));
                        }
                        cx.notify();
                    }
                }))
                .child(ph("git-branch", 13., hex(TEXT_TERTIARY)))
                .child(div().min_w_0().truncate().text_size(px(12.5)).font_weight(FontWeight::SEMIBOLD).text_color(if current { hex(TEXT_PRIMARY) } else { hex(TEXT_TERTIARY) }).child(branch))
                .child(div().w(px(13.)).flex_none().ml_auto().when(current, |d| d.child(ph("check", 13., hex(TEXT_PRIMARY)))))
        });
        let menu = div()
            .id("branch-menu")
            .occlude()
            .w(px(width))
            .max_h(px(280.).min((row.top() - px(pop::EDGE)).max(px(40.))))
            .overflow_y_scrollbar()
            .p(px(5.))
            .bg(hex(BG_SECONDARY))
            .border_1()
            .border_color(hex(BORDER))
            .rounded(px(10.))
            .shadow(pop::shadow())
            .on_mouse_down_out(close)
            .child(div().pt(px(6.)).px(px(8.)).pb(px(8.)).text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_TERTIARY)).child("Switch branch"))
            .when(names.is_empty(), |d| d.child(div().pt(px(4.)).px(px(8.)).pb(px(8.)).text_size(px(12.)).text_color(hex(TEXT_TERTIARY)).child(if branches.is_some() { "No other branches." } else { "Loading branches…" })))
            .children(rows);
        Some(pop::place("branch-pop", spot, menu).into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::branches_from;
    use serde_json::json;

    #[test]
    fn preserves_host_order_and_skips_non_string_branch_names() {
        let branches = branches_from(&json!({"current": "feature", "branches": ["feature", "main", null]}));
        assert_eq!(branches.current.as_deref(), Some("feature"));
        assert_eq!(branches.names, vec!["feature", "main"]);
    }

    #[test]
    fn detached_head_and_missing_lists_have_no_current_branch() {
        assert!(branches_from(&json!({"current": "HEAD"})).current.is_none());
        assert!(branches_from(&json!({})).names.is_empty());
    }
}
