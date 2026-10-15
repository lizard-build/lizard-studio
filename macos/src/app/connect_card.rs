//! The card a cloud chat shows when its agent has no credential on the
//! user's Lizard account: sign in (Claude or ChatGPT), or paste a key, then the
//! refused message goes out again (connect.rs does the work).

use futures::StreamExt as _;
use futures::channel::mpsc::unbounded;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::Sizable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::chat::{ChatSession, NeedConnect};
use crate::connect::{self, ConnectMsg};
use crate::store::Agent;
use crate::theme::*;
use crate::ui::ph;

#[derive(Clone, Copy, PartialEq)]
enum Busy {
    SignIn,
    Key,
}

/// One connect flow at a time: credentials belong to the account, not a chat.
pub struct ConnectUi {
    agent: Option<Agent>,
    busy: Option<Busy>,
    /// The sign-in page, to open again.
    url: Option<String>,
    /// ChatGPT's device code.
    code: Option<String>,
    error: Option<String>,
    connected: bool,
    key_open: bool,
    copied: bool,
    pub key: Entity<InputState>,
    flow: Option<connect::Flow>,
    has_claude: bool,
}

/// An agent can now run in the cloud.
pub struct Connected(pub Agent);

impl EventEmitter<Connected> for ConnectUi {}

impl ConnectUi {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let key = cx.new(|cx| InputState::new(window, cx).masked(true).placeholder("Paste a key or token"));
        cx.subscribe_in(&key, window, |this, _, event: &gpui_kit::component::input::InputEvent, _, cx| {
            if let gpui_kit::component::input::InputEvent::PressEnter { .. } = event {
                if let Some(agent) = this.agent {
                    this.submit_key(agent, cx);
                }
            }
        })
        .detach();
        Self {
            agent: None,
            busy: None,
            url: None,
            code: None,
            error: None,
            connected: false,
            key_open: false,
            copied: false,
            key,
            flow: None,
            has_claude: connect::claude_cli().is_some(),
        }
    }

    /// Point the card at the chat that needs it, clearing another agent's state.
    fn focus(&mut self, agent: Agent) {
        if self.agent != Some(agent) && self.busy.is_none() {
            self.agent = Some(agent);
            self.error = None;
            self.connected = false;
            self.url = None;
            self.code = None;
        }
    }

    pub fn sign_in(&mut self, agent: Agent, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        self.agent = Some(agent);
        self.busy = Some(Busy::SignIn);
        self.error = None;
        self.url = None;
        self.code = None;
        self.copied = false;
        let (tx, mut rx) = unbounded();
        self.flow = Some(match agent {
            Agent::Claude => connect::claude_sign_in(tx),
            Agent::Codex => connect::chatgpt_sign_in(tx),
        });
        cx.spawn(async move |this, cx| {
            while let Some(msg) = rx.next().await {
                if this.update(cx, |ui, cx| ui.on_msg(agent, msg, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        cx.notify();
    }

    fn on_msg(&mut self, agent: Agent, msg: ConnectMsg, cx: &mut Context<Self>) {
        match msg {
            ConnectMsg::Waiting { url } => self.url = Some(url),
            ConnectMsg::Code { url, code } => {
                // Visual checks never open a browser.
                if std::env::var_os("LIZARD_STUDIO_SHOT").is_none() {
                    cx.open_url(&url);
                }
                self.url = Some(url);
                self.code = Some(code);
            }
            ConnectMsg::Done(result) => self.finish(agent, result, cx),
        }
        cx.notify();
    }

    fn finish(&mut self, agent: Agent, result: Result<String, String>, cx: &mut Context<Self>) {
        self.busy = None;
        self.flow = None;
        self.code = None;
        match result {
            Ok(_) => {
                self.connected = true;
                self.error = None;
                self.key_open = false;
                cx.emit(Connected(agent));
            }
            Err(error) => self.error = Some(error),
        }
        cx.notify();
    }

    fn submit_key(&mut self, agent: Agent, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        let key = self.key.read(cx).value().trim().to_string();
        if key.is_empty() {
            return;
        }
        let kind = match connect::key_kind(agent, &key) {
            Ok(kind) => kind,
            Err(why) => {
                self.error = Some(why.into());
                cx.notify();
                return;
            }
        };
        self.agent = Some(agent);
        self.busy = Some(Busy::Key);
        self.error = None;
        let task = cx.background_executor().spawn(async move { connect::add_key(kind, &key) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |ui, cx| ui.finish(agent, result, cx));
        })
        .detach();
        cx.notify();
    }

    fn cancel(&mut self, cx: &mut Context<Self>) {
        if let Some(flow) = self.flow.take() {
            flow.cancel();
        }
        self.busy = None;
        self.url = None;
        self.code = None;
        cx.notify();
    }
}

fn button(id: &'static str, label: &'static str, primary: bool) -> Stateful<Div> {
    div()
        .id(id)
        .px(px(12.))
        .py(px(6.))
        .rounded(px(8.))
        .text_size(px(12.5))
        .font_weight(FontWeight::SEMIBOLD)
        .cursor_pointer()
        .when(primary, |d| d.bg(hex(TEXT_PRIMARY)).text_color(hex(0x0a0a0a)).hover(|s| s.bg(hsla(0., 0., 1., 1.))))
        .when(!primary, |d| d.bg(white_a(0.06)).text_color(hex(TEXT_PRIMARY)).hover(|s| s.bg(white_a(0.1))))
        .child(label)
}

fn quiet_link(id: &'static str, label: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .text_size(px(12.))
        .text_color(hex(TEXT_SECONDARY))
        .cursor_pointer()
        .hover(|s| s.text_color(hex(TEXT_PRIMARY)))
        .child(label)
}

/// The card under the refused message.
pub fn render_connect(chat: &Entity<ChatSession>, need: &NeedConnect, ui: &Entity<ConnectUi>, cx: &mut App) -> AnyElement {
    let agent = need.agent;
    ui.update(cx, |ui, _| ui.focus(agent));
    let state = ui.read(cx);
    let busy = state.busy.filter(|_| state.agent == Some(agent));
    let mine = state.agent == Some(agent);
    let error = state.error.clone().filter(|_| mine);
    let connected = mine && state.connected;
    let url = state.url.clone().filter(|_| mine);
    let code = state.code.clone().filter(|_| mine);
    let copied = state.copied;
    let can_sign_in = agent == Agent::Codex || state.has_claude;
    let key_open = state.key_open || !can_sign_in;
    let key = state.key.clone();

    let (name, icon, icon_color) = match agent {
        Agent::Claude => ("Claude", "claude", hex(CLAUDE_CLAY)),
        Agent::Codex => ("ChatGPT", "codex", hex(TEXT_PRIMARY)),
    };
    let title = match (need.reauth, agent) {
        (true, _) => format!("Sign in to {name} again"),
        (false, Agent::Claude) => "Connect Claude Code to Lizard".to_string(),
        (false, Agent::Codex) => "Connect ChatGPT to Lizard".to_string(),
    };
    let body = if need.reauth {
        format!("Lizard can't use your {name} sign-in any more. Sign in again and your message goes out.")
    } else {
        format!("Cloud chats run on your own {name} account. Connect it once and every sandbox can use it; your message goes out right after.")
    };
    let key_hint = match agent {
        Agent::Claude => "A token from claude setup-token (sk-ant-oat…), an Anthropic API key (sk-ant-…) or an OpenRouter key (sk-or-…).",
        Agent::Codex => "An OpenAI API key (sk-…) or an OpenRouter key (sk-or-…).",
    };
    let sign_in_label = match agent {
        Agent::Claude => "Sign in with Claude",
        Agent::Codex => "Sign in with ChatGPT",
    };

    let mut card = div()
        .w_full()
        .flex()
        .flex_col()
        .px(px(14.))
        .pt(px(12.))
        .pb(px(12.))
        .rounded(px(12.))
        .bg(hex(BG_CARD))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(7.))
                .child(ph(icon, 14., icon_color))
                .child(div().flex_1().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).child(title))
                .when(busy.is_none(), |d| {
                    let chat = chat.clone();
                    d.child(
                        div()
                            .id("connect-dismiss")
                            .size(px(22.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(|s| s.bg(white_a(0.06)))
                            .on_click(move |_, _, cx| chat.update(cx, |c, cx| c.dismiss_connect(cx)))
                            .child(ph("x", 12., hex(TEXT_TERTIARY))),
                    )
                }),
        )
        .child(div().mt(px(4.)).pl(px(21.)).text_size(px(12.5)).line_height(relative(1.45)).text_color(hex(TEXT_SECONDARY)).child(body));

    let mut action = div().mt(px(12.)).pl(px(21.)).flex().flex_col().gap(px(10.));
    if connected {
        action = action.child(
            div()
                .flex()
                .items_center()
                .gap(px(7.))
                .text_size(px(12.5))
                .text_color(hex(EMERALD))
                .child(ph("check", 13., hex(EMERALD)))
                .child("Connected. Sending your message again…"),
        );
    } else if busy == Some(Busy::SignIn) {
        let status = match (agent, &code) {
            (Agent::Codex, Some(_)) => "Enter this code on the page that opened:",
            (Agent::Codex, None) => "Starting the sign-in…",
            (Agent::Claude, _) if url.is_some() => "Finish signing in to Claude in your browser…",
            (Agent::Claude, _) => "Opening the sign-in page…",
        };
        action = action
            .child(div().text_size(px(12.5)).text_color(hex(TEXT_PRIMARY)).child(status))
            .when_some(code.clone(), |d, code| {
                let ui = ui.clone();
                let copy = code.clone();
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(
                            div()
                                .px(px(10.))
                                .py(px(6.))
                                .rounded(px(8.))
                                .bg(white_a(0.06))
                                .font_family("Lizard Mono")
                                .text_size(px(15.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(code),
                        )
                        .child(quiet_link("connect-copy", if copied { "Copied" } else { "Copy" }).on_click(move |_, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()));
                            ui.update(cx, |ui, cx| {
                                ui.copied = true;
                                cx.notify();
                            });
                        })),
                )
            })
            .child({
                let ui_cancel = ui.clone();
                div()
                    .flex()
                    .items_center()
                    .gap(px(14.))
                    .when_some(url.clone(), |d, url| {
                        d.child(quiet_link("connect-reopen", "Open the page again").on_click(move |_, _, cx| cx.open_url(&url)))
                    })
                    .child(quiet_link("connect-cancel", "Cancel").on_click(move |_, _, cx| ui_cancel.update(cx, |ui, cx| ui.cancel(cx))))
            });
    } else {
        let buttons = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .when(can_sign_in, |d| {
                let ui = ui.clone();
                d.child(button("connect-sign-in", sign_in_label, true).on_click(move |_, _, cx| ui.update(cx, |ui, cx| ui.sign_in(agent, cx))))
            })
            .when(can_sign_in && !key_open, |d| {
                let ui = ui.clone();
                d.child(button("connect-paste", "Paste a key", false).on_click(move |_, window, cx| {
                    let key = ui.read(cx).key.clone();
                    ui.update(cx, |ui, cx| {
                        ui.key_open = true;
                        cx.notify();
                    });
                    key.update(cx, |k, cx| k.focus(window, cx));
                }))
            });
        action = action.child(buttons);
        if !can_sign_in {
            action = action.child(
                div()
                    .text_size(px(12.))
                    .line_height(relative(1.45))
                    .text_color(hex(TEXT_TERTIARY))
                    .child("Claude Code isn't installed on this Mac, so sign in on the Agents page or paste a key."),
            );
        }
        if key_open {
            let ui_submit = ui.clone();
            let saving = busy == Some(Busy::Key);
            action = action.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .h(px(32.))
                                    .px(px(6.))
                                    .flex()
                                    .items_center()
                                    .bg(hex(BG_PRIMARY))
                                    .border_1()
                                    .border_color(hex(BORDER))
                                    .rounded(px(8.))
                                    .child(Input::new(&key).appearance(false).xsmall().text_size(px(12.)).h(px(16.))),
                            )
                            .child(
                                button("connect-key", if saving { "Connecting…" } else { "Connect" }, !can_sign_in)
                                    .when(saving, |d| d.opacity(0.6))
                                    .on_click(move |_, _, cx| ui_submit.update(cx, |ui, cx| ui.submit_key(agent, cx))),
                            ),
                    )
                    .child(div().text_size(px(11.5)).text_color(hex(TEXT_TERTIARY)).child(key_hint)),
            );
        }
    }
    card = card.child(action).when_some(error, |d, error| {
        d.child(div().mt(px(10.)).pl(px(21.)).text_size(px(12.)).line_height(relative(1.45)).text_color(hex(RED_SOFT)).child(error))
    });
    card.child(
        div()
            .mt(px(12.))
            .pl(px(21.))
            .child(quiet_link("connect-agents-page", "Manage credentials on the Agents page").text_color(hex(TEXT_TERTIARY)).on_click(|_, _, cx| cx.open_url(connect::AGENTS_PAGE))),
    )
    .into_any_element()
}
