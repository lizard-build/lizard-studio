//! The panel's slash picker, including commands handled without a CLI turn.

use gpui_kit::component::Size as InputSize;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::StudioApp;
use crate::chat::SlashCommand;
use crate::store::Agent;
use crate::theme::*;

#[derive(Default)]
pub(super) struct SlashUi {
    query: Option<(String, String)>,
    items: Vec<SlashCommand>,
    index: usize,
    dismissed: bool,
    argument: Option<(String, String)>,
    scroll: ScrollHandle,
}

fn matching_commands(text: &str, commands: &[SlashCommand], agent: Agent) -> Vec<SlashCommand> {
    let Some(query) = text.strip_prefix('/').filter(|s| !s.contains(char::is_whitespace)) else { return Vec::new() };
    let query = query.to_lowercase();
    let mut commands = commands.to_vec();
    let local: &[&str] = if agent == Agent::Codex { &["clear", "login"] } else { &["clear", "login", "remote-control"] };
    if agent == Agent::Codex {
        commands.retain(|c| c.name != "remote-control" && c.name != "rc");
    }
    for name in local {
        if !commands.iter().any(|c| c.name == *name) {
            commands.push(SlashCommand::named(name));
        }
    }
    commands.retain(|c| c.name.to_lowercase().contains(&query));
    commands.sort_by_key(|c| (!c.name.to_lowercase().starts_with(&query), c.name.to_lowercase()));
    commands.truncate(60);
    commands
}

impl StudioApp {
    pub(super) fn slash_blur(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.slash.dismissed = true;
        self.slash.items.clear();
        cx.notify();
    }

    fn sync_slash(&mut self, cx: &App) {
        let chat = self.chats[self.active].read(cx);
        let text = self.composer.read(cx).value().to_string();
        let query = (chat.id().to_string(), text.clone());
        if self.slash.query.as_ref() != Some(&query) {
            self.slash.query = Some(query);
            self.slash.index = 0;
            self.slash.dismissed = false;
            self.slash.scroll.set_offset(point(px(0.), px(0.)));
        }
        if self.slash.argument.as_ref().is_some_and(|(prefix, _)| prefix != &text) {
            self.slash.argument = None;
        }
        // Bash mode runs shell commands; there are no slash commands there.
        self.slash.items = if self.slash.dismissed || chat.bash_mode { Vec::new() } else {
            matching_commands(&text, &chat.commands, chat.meta.agent)
        };
        self.slash.index = self.slash.index.min(self.slash.items.len().saturating_sub(1));
    }

    pub(super) fn slash_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if event.keystroke.modifiers.modified() || !self.composer.read(cx).focus_handle(cx).is_focused(window) {
            return false;
        }
        self.sync_slash(cx);
        if self.slash.items.is_empty() { return false; }
        match event.keystroke.key.as_str() {
            "up" | "down" => {
                let count = self.slash.items.len();
                self.slash.index = if event.keystroke.key == "up" {
                    (self.slash.index + count - 1) % count
                } else { (self.slash.index + 1) % count };
                self.slash.scroll.scroll_to_item(self.slash.index);
                cx.notify();
            }
            "enter" | "tab" => self.accept_slash(self.slash.index, false, window, cx),
            "escape" => {
                self.slash.dismissed = true;
                self.slash.items.clear();
                cx.notify();
            }
            _ => return false,
        }
        true
    }

    fn accept_slash(&mut self, index: usize, run: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(command) = self.slash.items.get(index).cloned() else { return };
        let args = !command.arg_hint.is_empty();
        let text = format!("/{}{}", command.name, if args || !run { " " } else { "" });
        self.slash.dismissed = true;
        self.slash.items.clear();
        self.composer.update(cx, |state, cx| {
            state.set_value(text.clone(), window, cx);
            state.focus(window, cx);
        });
        self.slash.argument = args.then_some((text, command.arg_hint));
        if run && !args { self.submit(window, cx); }
        cx.notify();
    }

    pub(super) fn clear_command(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if text.trim() != "/clear" { return false; }
        let chat = self.chats[self.active].clone();
        chat.update(cx, |chat, cx| chat.clear_session(cx));
        // A blank transcript skips ordinary persistence; replace the old resume id now.
        self.store.upsert(chat.read(cx).meta.clone());
        self.attachments.clear();
        self.slash = SlashUi::default();
        self.composer.update(cx, |state, cx| state.set_value("", window, cx));
        self.menu = None;
        cx.notify();
        true
    }

    pub(super) fn render_slash_menu(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.sync_slash(cx);
        if self.slash.items.is_empty() { return None; }
        let rows = self.slash.items.iter().enumerate().map(|(index, command)| {
            div().id(("slash-item", index)).flex().flex_none().items_center()
                .px(px(9.)).py(px(7.)).rounded(px(7.)).cursor_pointer()
                .when(index == self.slash.index, |d| d.bg(white_a(0.06)))
                .on_hover(cx.listener(move |this, hovered, _, cx| {
                    if *hovered { this.slash.index = index; cx.notify(); }
                }))
                .on_mouse_down(MouseButton::Left, cx.listener(move |this, _, window, cx| {
                    window.prevent_default();
                    cx.stop_propagation();
                    this.accept_slash(index, true, window, cx);
                }))
                .child(div().flex_none().text_size(px(12.5)).text_color(hex(TEXT_PRIMARY)).child(format!("/{}", command.name)))
                .when(!command.arg_hint.is_empty(), |d| d.child(
                    div().ml(px(8.)).text_size(px(11.5)).text_color(hex(TEXT_TERTIARY)).truncate().child(command.arg_hint.clone())
                ))
                .when(!command.description.is_empty(), |d| d.child(
                    div().ml(px(8.)).min_w_0().text_size(px(11.5)).text_color(hex(TEXT_TERTIARY)).truncate().child(command.description.clone())
                ))
        }).collect::<Vec<_>>();
        Some(div().absolute().bottom_full().mb(px(4.)).left(px(-1.)).right(px(-1.))
            .child(deferred(crate::ui::menu_box("slash-menu", 0., Vec::new())
                .w_full().gap_0().max_h(px(260.)).overflow_y_scroll().track_scroll(&self.slash.scroll)
                .children(rows)).with_priority(1)).into_any_element())
    }

    pub(super) fn render_slash_ghost(&self) -> Option<AnyElement> {
        let (prefix, hint) = self.slash.argument.as_ref()?;
        let text = StyledText::new(format!("{prefix}{hint}")).with_highlights([
            (0..prefix.len(), HighlightStyle { color: Some(white_a(0.)), ..Default::default() }),
        ]);
        Some(div().absolute().inset_0().overflow_hidden().px(InputSize::XSmall.input_px())
            .py(InputSize::XSmall.input_py()).text_size(px(14.)).line_height(relative(1.45))
            .text_color(hex(TEXT_TERTIARY)).child(text).into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::matching_commands;
    use crate::chat::SlashCommand;
    use crate::store::Agent;

    #[test]
    fn matches_anywhere_prefixes_first_case_insensitive() {
        let commands = ["zreview", "Review", "areview", "review-pr"].map(SlashCommand::named);
        let matches = matching_commands("/REVIEW", &commands, Agent::Claude);
        assert_eq!(matches.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Review", "review-pr", "areview", "zreview"]);
        assert!(matching_commands("/review ", &commands, Agent::Claude).is_empty());
        assert!(matching_commands("hello /review", &commands, Agent::Claude).is_empty());
    }

    #[test]
    fn limits_results_and_adds_local_commands_once() {
        let commands = (0..80).map(|i| SlashCommand::named(&format!("skill-{i}"))).collect::<Vec<_>>();
        assert_eq!(matching_commands("/skill", &commands, Agent::Claude).len(), 60);
        let locals = matching_commands("/", &[SlashCommand::named("login")], Agent::Claude);
        assert_eq!(locals.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["clear", "login", "remote-control"]);
        assert!(!matching_commands("/", &locals, Agent::Codex).iter().any(|c| c.name == "remote-control"));
    }
}
