//! The composer's shell prompt and the panel's terminal-style run card.

use super::*;
use crate::chat::bash::BashRun;

impl StudioApp {
    pub(super) fn bash_mode(&self, cx: &App) -> bool {
        let chat = self.chats[self.active].read(cx);
        !chat.meta.cloud && chat.bash_mode
    }

    pub(super) fn composer_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().to_string();
        if !self.bash_mode(cx) && !self.chats[self.active].read(cx).meta.cloud {
            if let Some(command) = text.strip_prefix('!') {
                self.chats[self.active].update(cx, |chat, _| chat.bash_mode = true);
                self.composer.update(cx, |state, cx| {
                    state.set_value(command, window, cx);
                    state.set_selected_range(command.len()..command.len(), cx);
                });
                self.sync_bash_mode(window, cx);
            }
        }
        cx.notify();
    }

    pub(super) fn sync_bash_mode(&self, window: &mut Window, cx: &mut Context<Self>) {
        let placeholder = if self.bash_mode(cx) { "Enter a shell command" } else { "Type / for commands" };
        self.composer.update(cx, |state, cx| state.set_placeholder(placeholder, window, cx));
    }

    fn exit_bash_mode(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.chats[self.active].update(cx, |chat, _| chat.bash_mode = false);
        self.sync_bash_mode(window, cx);
        self.composer.update(cx, |state, cx| state.focus(window, cx));
        cx.notify();
    }

    pub(super) fn bash_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if key == "backspace" && self.bash_mode(cx) && self.composer.read(cx).value().is_empty()
            && self.composer.read(cx).focus_handle(cx).is_focused(window) {
            self.exit_bash_mode(window, cx);
            return true;
        }
        false
    }

    pub(super) fn submit_bash(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.bash_mode(cx) { return false; }
        let command = self.composer.read(cx).value().to_string();
        if command.trim().is_empty() { return true; }
        let chat = self.chats[self.active].clone();
        if chat.read(cx).work_cwd().is_none() {
            self.pick_folder(window, cx);
            return true;
        }
        chat.update(cx, |chat, cx| chat.run_bash(&command, cx));
        self.composer.update(cx, |state, cx| state.set_value("", window, cx));
        self.exit_bash_mode(window, cx);
        true
    }

    pub(super) fn bash_pill(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.bash_mode(cx).then(|| div()
            .id("bash-pill")
            .absolute().left(px(6.)).top(px(4.))
            .h(px(20.)).px(px(8.))
            .flex().items_center().rounded(px(6.))
            .bg(hex(EMERALD)).text_color(hex(0xffffff))
            .font_family("Lizard Mono").text_size(px(11.5)).font_weight(FontWeight::SEMIBOLD)
            .cursor_pointer().hover(|s| s.bg(hex(0x059669)))
            .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Exit bash mode").build(window, cx))
            .on_click(cx.listener(|this, _, window, cx| this.exit_bash_mode(window, cx)))
            .child("bash").into_any_element())
    }
}

pub(super) fn render_bash(entity: &Entity<ChatSession>, run: &BashRun, ix: usize) -> AnyElement {
    let stop_chat = entity.clone();
    let exec_id = run.entry.id.clone();
    let output = run.entry.output.clone();
    let copy = output.clone();
    let lines = output.split('\n').count();
    let highlights = run.stderr.iter().map(|range| (range.clone(), HighlightStyle { color: Some(hex(RED)), ..Default::default() })).collect::<Vec<_>>();
    div().w_full().min_w_0().flex().flex_col()
        .font_family("Lizard Mono").text_size(px(12.))
        .child(div().w_full().flex().items_center().gap(px(8.))
            .px(px(12.)).py(px(8.)).rounded(px(10.))
            .bg(hex(BG_SECONDARY)).border_1().border_color(white_a(0.08))
            .child(div().flex_none().font_weight(FontWeight::SEMIBOLD).text_color(hex(EMERALD)).child("$"))
            .child(div().flex_1().min_w_0().text_color(hex(TEXT_PRIMARY)).child(run.entry.command.clone()))
            .when(run.running, |d| d
                .child(gpui_kit::component::spinner::Spinner::new().with_size(px(11.)).color(hex(EMERALD)))
                .child(div().id(("bash-stop", ix)).size(px(20.)).flex_none()
                    .flex().items_center().justify_center().rounded(px(5.))
                    .bg(white_a(0.06)).text_color(hex(TEXT_SECONDARY))
                    .cursor_pointer().hover(|s| s.bg(hex(RED)).text_color(hex(0xffffff)))
                    .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Stop").build(window, cx))
                    .on_click(move |_, _, cx| stop_chat.read(cx).stop_bash(&exec_id))
                    .child(ph("stop", 12., hex(TEXT_SECONDARY))))))
        .when(!output.is_empty(), |d| d.child(div().mt(px(6.)).relative()
            .when(!run.running && (lines > 16 || output.len() > 1400), |d| d.child(div().mb(px(4.)).font_family("Lizard Inter").text_size(px(11.)).text_color(hex(TEXT_TERTIARY)).child(format!("Output · {lines} lines"))))
            .child(div().id(("bash-output", ix)).w_full().max_h(px(320.)).overflow_y_scroll()
                .px(px(12.)).py(px(10.)).rounded(px(8.)).bg(white_a(0.05))
                .line_height(relative(1.5)).text_color(hex(TEXT_SECONDARY))
                .child(StyledText::new(output).with_highlights(highlights)))
            .child(div().id(("bash-copy", ix)).absolute().top(px(4.)).right(px(4.)).size(px(22.))
                .flex().items_center().justify_center().rounded(px(5.))
                .bg(hex(BG_SECONDARY)).cursor_pointer().hover(|s| s.bg(hex(BORDER)))
                .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new("Copy output").build(window, cx))
                .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(copy.clone())))
                .child(ph("copy", 12., hex(TEXT_SECONDARY))))))
        .when_some(run.footer(), |d, footer| d.child(div().pt(px(6.)).px(px(2.)).text_size(px(11.)).text_color(hex(RED)).child(footer)))
        .into_any_element()
}
