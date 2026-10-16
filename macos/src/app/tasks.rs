//! The tasks chip opens the panel's Running / Finished drawer above the flap.

use std::collections::{HashMap, HashSet};

use gpui_kit::component::text::TextViewState;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{StudioApp, code_block, icon_button, markdown_view, render_detail};
use crate::chat::{ChatSession, Task, TaskKind, ToolCall, ToolStatus, tool_detail, tool_label};
use crate::store::now_ms;
use crate::theme::*;
use crate::ui::{caret, ph};

#[derive(Default)]
pub(super) struct TasksUi {
    chat: Option<String>,
    transcript: Option<String>,
    finished_collapsed: bool,
    expanded: HashSet<String>,
    text: HashMap<String, (String, Entity<TextViewState>)>,
    last_ports: u64,
    last_alive: u64,
}

fn elapsed(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 { format!("{s:02}s") }
    else if s < 3600 { format!("{}m {:02}s", s / 60, s % 60) }
    else { format!("{}h {:02}m {:02}s", s / 3600, s / 60 % 60, s % 60) }
}

fn tokens(n: u64) -> String {
    if n < 1000 { n.to_string() }
    else { format!("{}k", format!("{:.1}", n as f64 / 1000.).trim_end_matches(".0")) }
}

impl StudioApp {
    pub(super) fn tasks_open(&self, cx: &App) -> bool {
        self.tasks_ui.chat.as_deref() == Some(self.chats[self.active].read(cx).id())
    }

    pub(super) fn close_tasks(&mut self) {
        self.tasks_ui.chat = None;
        self.tasks_ui.transcript = None;
        self.tasks_ui.text.clear();
        self.tasks_ui.expanded.clear();
    }

    pub(super) fn toggle_tasks(&mut self, cx: &mut Context<Self>) {
        if self.tasks_open(cx) {
            self.close_tasks();
        } else {
            self.close_tasks();
            self.tasks_ui.chat = Some(self.chats[self.active].read(cx).id().to_string());
            self.menu = None;
        }
        cx.notify();
    }

    /// Reuse the window clock so background work keeps updating between turns.
    pub(super) fn tick_tasks(&mut self, cx: &mut Context<Self>) {
        let at = now_ms();
        for chat in self.chats.clone() {
            if chat.read(cx).tasks.iter().any(|t| t.stopping_at.is_some()) {
                chat.update(cx, |c, cx| c.expire_task_stops(at, cx));
            }
        }
        let Some(chat) = self.chats.get(self.active) else { return };
        if chat.read(cx).task_counts().0 == 0 { return; }
        cx.notify();
        if !self.host_state.connected || self.host_state.version.is_none_or(|v| v < 22) { return; }
        let ports = at.saturating_sub(self.tasks_ui.last_ports) >= 2500;
        let alive = at.saturating_sub(self.tasks_ui.last_alive) >= 5000;
        if ports { self.tasks_ui.last_ports = at; }
        if alive { self.tasks_ui.last_alive = at; }
        chat.read(cx).probe_tasks(ports, alive, at);
    }

    pub(super) fn render_tasks_drawer(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let entity = self.chats[self.active].clone();
        let chat = entity.read(cx);
        let agent = self.tasks_ui.transcript.as_deref().and_then(|id| chat.tasks.iter().find(|t| t.tool_id == id)).cloned();
        let chat_id = chat.id().to_string();
        let cwd = chat.work_cwd();
        let title = agent.as_ref().map(|t| t.label.clone()).unwrap_or_else(|| "Background tasks".into());
        let mut body = div().flex().flex_col().px(px(12.)).pt(px(6.)).pb(px(16.));
        if let Some(agent) = &agent {
            body = body.children(self.render_agent_transcript(agent, cwd.as_deref(), cx));
        } else {
            let mut running: Vec<_> = chat.tasks.iter().filter(|t| t.running).collect();
            let mut finished: Vec<_> = chat.tasks.iter().filter(|t| !t.running).collect();
            running.sort_by_key(|t| t.started_at);
            finished.sort_by_key(|t| std::cmp::Reverse(t.ended_at));
            if chat.tasks.is_empty() {
                body = body.child(empty("No tasks yet."));
            }
            if !running.is_empty() {
                body = body.child(section().pt(px(4.)).child("Running"));
                for task in running { body = body.child(self.render_task_card(task, &entity, cx)); }
            }
            if !finished.is_empty() {
                let clear = entity.clone();
                body = body.child(
                    section().flex().items_center().justify_between()
                        .child(div().id("tasks-finished-toggle").flex().items_center().gap(px(6.))
                            .cursor_pointer().text_color(hex(TEXT_SECONDARY))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.tasks_ui.finished_collapsed = !this.tasks_ui.finished_collapsed;
                                cx.notify();
                            }))
                            .child("Finished").child(div().text_color(hex(TEXT_TERTIARY)).child(finished.len().to_string()))
                            .child(caret(!self.tasks_ui.finished_collapsed, hex(TEXT_TERTIARY))))
                        .child(div().id("tasks-clear").cursor_pointer().text_color(hex(TEXT_SECONDARY))
                            .hover(|s| s.text_color(hex(TEXT_PRIMARY)))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                clear.update(cx, |c, cx| { c.tasks.retain(|t| t.running); cx.notify(); });
                                if clear.read(cx).tasks.is_empty() { this.close_tasks(); }
                                cx.notify();
                            })).child("Clear finished")),
                );
                if !self.tasks_ui.finished_collapsed {
                    for task in finished { body = body.child(self.render_task_card(task, &entity, cx)); }
                }
            }
        }
        div().id("tasks-drawer").absolute().left(px(12.)).right(px(12.)).top(px(8.)).bottom_0()
            .flex().flex_col().rounded_tl(px(14.)).rounded_tr(px(14.)).bg(hex(BG_SECONDARY))
            .occlude()
            .child(div().id("tasks-drawer-head").flex_none().flex().items_center().gap(px(4.))
                .pl(px(16.)).pr(px(6.)).pt(px(4.)).pb(px(2.))
                .rounded_tl(px(14.)).rounded_tr(px(14.)).cursor_pointer()
                .hover(|s| s.bg(white_a(0.05)))
                .on_click(cx.listener(|this, _, _, cx| { this.close_tasks(); cx.notify(); }))
                .when(agent.is_some(), |d| d.child(icon_button("tasks-back", "caret-left", 14.)
                    .on_click(cx.listener(|this, _, _, cx| {
                        cx.stop_propagation();
                        this.tasks_ui.transcript = None;
                        cx.notify();
                    }))))
                .child(div().flex_1().min_w_0().truncate().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD)
                    .text_color(hex(TEXT_SECONDARY)).child(title))
                .child(icon_button("tasks-close", "caret-down", 14.)))
            .child(div().id(SharedString::from(format!("tasks-body-{}-{}", chat_id, agent.as_ref().map(|a| a.tool_id.as_str()).unwrap_or("list"))))
                .flex_1().min_h_0().overflow_y_scroll().child(body))
            .into_any_element()
    }

    fn render_task_card(&self, task: &Task, entity: &Entity<ChatSession>, cx: &Context<Self>) -> AnyElement {
        let color = if task.failed || task.stopping_at.is_some() { RED } else if task.running { EMERALD } else { TEXT_SECONDARY };
        let status = if task.stopping_at.is_some() { "Stopping…" } else if task.running { "Running" } else if task.failed { "Failed" } else { "Completed" };
        let kind = if task.kind == TaskKind::Agent { "Agent" } else if task.is_server { "Preview" } else { "Bash" };
        let time = elapsed(task.ended_at.unwrap_or_else(now_ms).saturating_sub(task.started_at));
        let id = task.tool_id.clone();
        let stop = entity.clone();
        let mut card = div().relative().w_full().mb(px(8.)).px(px(14.)).py(px(12.)).rounded(px(12.))
            .bg(white_a(0.035)).text_size(px(12.)).font_weight(FontWeight::MEDIUM).line_height(relative(1.2))
            .when(!task.running, |d| d.opacity(0.82))
            .child(div().min_w_0().when(task.running, |d| d.pr(px(30.)))
                .font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_PRIMARY)).child(task.label.clone()))
            .when(task.running, |d| d.child(
                div().id(SharedString::from(format!("task-stop-{id}"))).absolute().top(px(12.)).right(px(14.))
                    .size(px(24.)).flex().items_center().justify_center().rounded(px(6.))
                    .border_1().border_color(hex(BORDER)).text_color(hex(TEXT_SECONDARY))
                    .when(task.stopping_at.is_some(), |d| d.opacity(0.45))
                    .when(task.stopping_at.is_none(), |d| d.cursor_pointer()
                        .hover(|s| s.bg(rgba_hex(RED, 0.14)).border_color(hex(RED)).text_color(hex(RED)))
                        .on_click(move |_, _, cx| stop.update(cx, |c, cx| c.stop_task(&id, cx))))
                    .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Stop").build(window, cx))
                    .child(ph("stop", 12., hex(TEXT_SECONDARY))),
            ))
            .child(div().flex().items_center().flex_wrap().gap(px(10.)).mt(px(6.))
                .child(div().text_color(hex(TEXT_SECONDARY)).child(kind))
                .child(div().flex().items_center().gap(px(5.)).text_color(hex(color))
                    .child(div().size(px(5.)).rounded_full().bg(hex(color))).child(status))
                .child(div().text_color(hex(TEXT_TERTIARY)).child(time)));
        if task.kind == TaskKind::Agent {
            let mut bits = Vec::new();
            let total = task.in_tokens + task.out_tokens;
            if total > 0 { bits.push(format!("{} tokens", tokens(total))); }
            if task.tool_uses > 0 { bits.push(format!("{} tool use{}", task.tool_uses, if task.tool_uses == 1 { "" } else { "s" })); }
            if task.running && !task.last_tool.is_empty() { bits.push(task.last_tool.clone()); }
            if !task.description.is_empty() { bits.insert(0, task.description.clone()); }
            let transcript_id = task.tool_id.clone();
            if !bits.is_empty() || !task.messages.is_empty() {
                card = card.child(div().flex().flex_wrap().gap_x(px(12.)).gap_y(px(3.)).mt(px(6.))
                    .text_color(hex(TEXT_TERTIARY))
                    .when(!bits.is_empty(), |d| d.child(bits.join("  ·  ")))
                    .when(!task.messages.is_empty(), |d| d.child(
                        div().id(SharedString::from(format!("task-transcript-{transcript_id}")))
                            .text_color(hex(EMERALD)).cursor_pointer().hover(|s| s.underline())
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.tasks_ui.transcript = Some(transcript_id.clone());
                                this.tasks_ui.text.clear();
                                this.tasks_ui.expanded.clear();
                                cx.notify();
                            })).child("View transcript"),
                    )));
            }
        } else if let Some(url) = &task.url {
            let target = if url.contains("://") { url.clone() } else { format!("http://{url}") };
            card = card.child(div().id(SharedString::from(format!("task-url-{}", task.tool_id)))
                .mt(px(6.)).text_color(hex(TEXT_TERTIARY)).cursor_pointer()
                .hover(|s| s.text_color(hex(EMERALD)).underline())
                .on_click(move |_, _, cx| cx.open_url(&target)).child(url.clone()));
        }
        card.into_any_element()
    }

    fn render_agent_transcript(&mut self, task: &Task, cwd: Option<&str>, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut rows = Vec::new();
        for (m, message) in task.messages.iter().enumerate() {
            for (b, block) in message["content"].as_array().into_iter().flatten().enumerate() {
                let key = format!("agent-{}-{m}-{b}", task.tool_id);
                match block["type"].as_str() {
                    Some("text") => {
                        let text = block["text"].as_str().unwrap_or("");
                        if text.trim().is_empty() { continue; }
                        let shown = crate::chat::link_paths(text, cwd);
                        let (old, view) = self.tasks_ui.text.entry(key).or_insert_with(|| {
                            (shown.clone(), cx.new(|cx| TextViewState::markdown(&shown, cx).selectable(true)))
                        });
                        if *old != shown { view.update(cx, |v, cx| v.set_text(&shown, cx)); *old = shown; }
                        rows.push(div().mx(px(2.)).mt(px(2.)).mb(px(12.)).child(markdown_view(view)).into_any_element());
                    }
                    Some("tool_use") => {
                        let result = block["id"].as_str().and_then(|id| task.results.get(id));
                        let expanded = self.tasks_ui.expanded.contains(&key);
                        let tool = ToolCall {
                            id: block["id"].as_str().unwrap_or("").into(),
                            name: block["name"].as_str().unwrap_or("Tool").into(), input: block["input"].clone(),
                            status: match result { Some((_, true)) => ToolStatus::Error, Some(_) => ToolStatus::Done, None => ToolStatus::Running },
                            output: result.map(|(text, _)| text.clone()), expanded,
                        };
                        let label = tool_label(&tool.name, &tool.input, cwd);
                        let toggle = key.clone();
                        let color = match tool.status { ToolStatus::Error => RED, ToolStatus::Done => EMERALD, ToolStatus::Running => TEXT_TERTIARY };
                        let detail = expanded.then(|| tool_detail(&tool)).flatten();
                        rows.push(div().mb(px(6.)).w_full()
                            .child(div().id(SharedString::from(key.clone())).flex().items_center().gap(px(8.)).py(px(3.)).cursor_pointer()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if !this.tasks_ui.expanded.remove(&toggle) { this.tasks_ui.expanded.insert(toggle.clone()); }
                                    cx.notify();
                                }))
                                .child(ph(label.icon, 14., hex(TEXT_SECONDARY)))
                                .child(div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).child(label.name))
                                .child(div().flex_1().min_w_0().truncate().font_family("Lizard Mono").text_size(px(11.5)).text_color(hex(TEXT_SECONDARY)).child(label.summary))
                                .child(caret(expanded, hex(color))))
                            .when_some(detail, |d, detail| d.child(div().pl(px(22.)).py(px(2.)).child(render_detail(SharedString::from(format!("{key}-detail")), detail))))
                            .when(expanded, |d| d.when_some(result, |d, (text, error)| {
                                d.child(div().pl(px(22.)).pb(px(4.)).child(code_block(SharedString::from(format!("{key}-output")), text.clone(), *error)))
                            })).into_any_element());
                    }
                    _ => {}
                }
            }
        }
        if rows.is_empty() { rows.push(empty(if task.running { "Working…" } else { "No activity captured." }).into_any_element()); }
        rows
    }
}

fn section() -> Div {
    div().px(px(4.)).pt(px(12.)).pb(px(8.)).text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(hex(TEXT_TERTIARY))
}

fn empty(text: &'static str) -> Div {
    div().px(px(8.)).py(px(24.)).text_size(px(12.)).text_color(hex(TEXT_TERTIARY)).text_center().child(text)
}

#[cfg(test)]
mod tests {
    use super::{elapsed, tokens};

    #[test]
    fn panel_elapsed_format() {
        assert_eq!(elapsed(7000), "07s");
        assert_eq!(elapsed(65_999), "1m 05s");
        assert_eq!(elapsed(5_974_000), "1h 39m 34s");
    }

    #[test]
    fn panel_token_format() {
        assert_eq!(tokens(999), "999");
        assert_eq!(tokens(1000), "1k");
        assert_eq!(tokens(10_000), "10k");
        assert_eq!(tokens(12_345), "12.3k");
    }
}
