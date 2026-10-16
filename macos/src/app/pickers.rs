//! The composer's pickers as the panel draws them (chat.js renderPickerMenu,
//! renderModeMenu and the effort slider): model, permission mode, effort.

use std::time::{Duration, Instant};

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{Menu, ModelRow, Rung, StudioApp, TITLEBAR_H, efforts_for, is_ultra, model_groups, models_for, modes_for};
use crate::chat;
use crate::pop;
use crate::store::Agent;
use crate::theme::*;
use crate::ui::ph;

/// What the toolbar and its pickers show for the open chat.
pub(super) struct Pickers {
    pub agent: Agent,
    pub cloud: bool,
    pub models: Vec<ModelRow>,
    pub model: Option<String>,
    pub model_label: String,
    pub model_row: Option<ModelRow>,
    pub default_model: Option<String>,
    pub rungs: Vec<Rung>,
    /// Index into `rungs` of the chat's effort.
    pub rung: Option<usize>,
    pub mode: String,
}

impl Pickers {
    pub fn effort(&self) -> Option<&Rung> {
        self.rung.and_then(|i| self.rungs.get(i))
    }
}

/// The slider's live state: where the thumb is (in stops, fractional while
/// dragging or springing), and the ultra field's clock.
#[derive(Default)]
pub(super) struct EffortUi {
    pub value: f32,
    pub index: usize,
    pub dragging: bool,
    /// Pointer offset from the thumb's centre when it was grabbed.
    grab: f32,
    samples: Vec<(Instant, f32)>,
    /// Bumped to stop a running spring.
    spring: u64,
    pub ultra_since: Option<Instant>,
    pub tip: bool,
    /// When the level name last changed, and whether it moved up.
    pub swapped: Option<(Instant, bool)>,
}

/// Keyboard selection is separate from the setting until Enter commits it.
#[derive(Default)]
pub(super) struct PickerNavigation {
    menu: Option<Menu>,
    index: usize,
    model_scroll: ScrollHandle,
}

fn next_row(key: &str, index: usize, count: usize) -> Option<usize> {
    if count == 0 { return None; }
    let last = count - 1;
    Some(match key {
        "up" | "left" => index.saturating_sub(1),
        "down" | "right" => (index + 1).min(last),
        "home" => 0,
        "end" => last,
        _ => return None,
    }.min(last))
}

const THUMB_W: f32 = 22.;
const THUMB_H: f32 = 24.;
const TRACK_PAD: f32 = 1.;

impl StudioApp {
    pub(super) fn pickers(&self, cx: &App) -> Pickers {
        let c = self.chats[self.active].read(cx);
        let agent = c.meta.agent;
        let cloud = c.meta.cloud;
        let catalog = self.catalogs.get(&agent).cloned().unwrap_or_default();
        let custom = cx.try_global::<chat::CustomModels>().map(|m| m.0.clone()).unwrap_or_default();
        let models = models_for(agent, &catalog, &custom);
        let default_model = match agent {
            Agent::Claude => catalog.default_model.clone().or_else(|| Some("default".into())),
            Agent::Codex => catalog.default_model.clone().or_else(|| catalog.models.first().map(|m| m.id.clone())),
        };
        let model = c.meta.model.clone().or_else(|| default_model.clone());
        let model_row = model.as_ref().and_then(|id| models.iter().find(|m| &m.id == id)).cloned();
        let model_label = model_row
            .as_ref()
            .map(|m| m.label.clone())
            .or_else(|| c.meta.model.clone().filter(|m| !m.is_empty()))
            .unwrap_or_else(|| "Default".into());
        let rungs = efforts_for(agent, model_row.as_ref(), cloud);
        // chat.js: the chat's own rung, else the model's default, else the first.
        let has = |id: &str| rungs.iter().position(|r| r.id == id);
        let rung = c
            .meta
            .effort
            .as_deref()
            .and_then(has)
            .or_else(|| match agent {
                Agent::Claude => has("medium"),
                Agent::Codex => catalog
                    .default_effort
                    .as_deref()
                    .filter(|_| c.meta.effort.is_none())
                    .and_then(has)
                    .or_else(|| model_row.as_ref().and_then(|r| r.default_effort.as_deref()).and_then(has))
                    .or_else(|| has("medium"))
                    .or_else(|| rungs.len().checked_sub(1)),
            })
            .or_else(|| (!rungs.is_empty()).then_some(0));
        let mode = c.meta.permission_mode.clone().unwrap_or_else(|| chat::default_mode(agent).into());
        Pickers { agent, cloud, models, model, model_label, model_row, default_model, rungs, rung, mode }
    }

    fn trigger(&self, key: &'static str) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(key).copied()
    }

    /// Open (or close) a picker from its button, as chat.js toggle*Menu does.
    pub(super) fn toggle_picker(&mut self, which: Menu, cx: &mut Context<Self>) {
        if self.menu.as_ref() == Some(&which) {
            self.menu = None;
            cx.notify();
            return;
        }
        match which {
            Menu::Model => {
                let agent = self.chats[self.active].read(cx).meta.agent;
                let stale = self.catalogs.get(&agent).and_then(|c| c.at).map_or(true, |at| at.elapsed() > Duration::from_secs(300));
                if agent == Agent::Claude || stale {
                    self.refresh_models(agent, cx);
                }
            }
            Menu::Effort => {
                let p = self.pickers(cx);
                if p.rungs.is_empty() {
                    return;
                }
                let index = p.rung.unwrap_or(0);
                self.effort.spring += 1;
                self.effort.dragging = false;
                self.effort.tip = false;
                self.effort.swapped = None;
                self.effort.value = index as f32;
                self.effort.index = index;
                self.effort.ultra_since = p.rungs.get(index).filter(|r| is_ultra(&r.id)).map(|_| Instant::now());
            }
            _ => {}
        }
        let p = self.pickers(cx);
        let index = match which {
            Menu::Model => model_groups(p.models, p.agent).into_iter().flat_map(|(_, rows)| rows).position(|r| Some(r.id.as_str()) == p.model.as_deref()).unwrap_or(0),
            Menu::Mode => modes_for(p.agent).iter().position(|r| r.0 == p.mode).unwrap_or(0),
            Menu::Agent => usize::from(p.agent == Agent::Codex),
            _ => 0,
        };
        self.picker_nav.menu = Some(which.clone());
        self.picker_nav.index = index;
        self.menu = Some(which);
        cx.notify();
    }

    pub(super) fn picker_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(menu @ (Menu::Model | Menu::Mode | Menu::Agent)) = self.menu.clone() else { return false };
        let p = self.pickers(cx);
        let rows: Vec<ModelRow> = model_groups(p.models, p.agent).into_iter().flat_map(|(_, rows)| rows).collect();
        let count = match menu { Menu::Model => rows.len(), Menu::Mode => modes_for(p.agent).len(), _ => 2 };
        if count == 0 { return false; }
        if self.picker_nav.menu.as_ref() != Some(&menu) {
            self.picker_nav.menu = Some(menu.clone());
            self.picker_nav.index = 0;
        }
        if let Some(index) = next_row(key, self.picker_nav.index, count) {
            self.picker_nav.index = index;
            if menu == Menu::Model {
                let p = self.pickers(cx);
                let mut row = 0;
                let mut child = 0;
                for (label, rows) in model_groups(p.models, p.agent) {
                    if !label.is_empty() { child += 1; }
                    if index < row + rows.len() { child += index - row; break; }
                    row += rows.len();
                    child += rows.len();
                }
                self.picker_nav.model_scroll.scroll_to_item(child);
            }
            cx.notify();
            return true;
        }
        if key != "enter" { return false; }
        let index = self.picker_nav.index.min(count - 1);
        self.menu = None;
        match menu {
            Menu::Model => self.pick_model(rows[index].id.clone(), cx),
            Menu::Mode => { self.chats[self.active].update(cx, |c, cx| c.set_settings(None, None, Some(modes_for(p.agent)[index].0.into()), cx)); }
            Menu::Agent => {
                let agent = if index == 0 { Agent::Claude } else { Agent::Codex };
                if agent != p.agent { self.set_agent(agent, window, cx); }
            }
            _ => {}
        }
        cx.notify();
        true
    }

    fn picker_highlight(&self, menu: Menu, index: usize) -> bool {
        self.menu.as_ref() == Some(&menu) && self.picker_nav.menu.as_ref() == Some(&menu) && self.picker_nav.index == index
    }

    /// A mouse-down outside the open picker closes it, unless it lands on
    /// the picker's own button (whose click toggles it shut).
    pub(super) fn close_picker_listener(&self, trigger: &'static str, cx: &mut Context<Self>) -> impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static {
        let app = cx.weak_entity();
        let bounds = self.bounds.clone();
        move |event: &MouseDownEvent, _: &mut Window, cx: &mut App| {
            if bounds.borrow().get(trigger).is_some_and(|b| b.contains(&event.position)) {
                return;
            }
            let _ = app.update(cx, |this, cx| {
                this.menu = None;
                cx.notify();
            });
        }
    }

    // ---- model ---------------------------------------------------------------

    pub(super) fn render_model_menu(&mut self, p: &Pickers, viewport: Size<Pixels>, cx: &mut Context<Self>) -> Option<AnyElement> {
        let t = self.trigger("model")?;
        let vw = f32::from(viewport.width);
        let width = 326f32.min(vw - 24.);
        let spot = pop::spot(f32::from(t.right()) - width, f32::from(t.top()) - 6., width, 10., t, vw);
        let room = (f32::from(t.top()) - TITLEBAR_H - pop::EDGE - 8.).max(120.);
        let list_h = 448f32.min(room - 90.);
        let catalog = self.catalogs.get(&p.agent).cloned().unwrap_or_default();
        let agent = p.agent;

        let refresh = div()
            .id("model-refresh")
            .px(px(4.))
            .py(px(4.))
            .rounded(px(5.))
            .text_color(hex(if catalog.fetching { TEXT_TERTIARY } else { TEXT_SECONDARY }))
            .when(!catalog.fetching, |d| {
                d.cursor_pointer()
                    .hover(|s| s.bg(white_a(0.06)).text_color(hex(TEXT_PRIMARY)))
                    .on_click(cx.listener(move |this, _, _, cx| this.refresh_models(agent, cx)))
            })
            .child(if catalog.fetching { "Refreshing…" } else { "Refresh" });

        let mut list = div().id("model-list").flex().flex_col().max_h(px(list_h)).overflow_y_scroll().track_scroll(&self.picker_nav.model_scroll);
        let mut row_ix = 0usize;
        for (gi, (label, rows)) in model_groups(p.models.clone(), agent).into_iter().enumerate() {
            if !label.is_empty() {
                list = list.child(
                    div()
                        .px(px(9.))
                        .pt(px(if gi == 0 { 3. } else { 11. }))
                        .pb(px(6.))
                        .text_size(px(10.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(hex(TEXT_TERTIARY))
                        .child(label),
                );
            }
            for (i, row) in rows.into_iter().enumerate() {
                let current = p.model.as_deref() == Some(row.id.as_str());
                let highlighted = self.picker_highlight(Menu::Model, row_ix);
                let hover_ix = row_ix;
                let logo_color = if current { hex(EMERALD) } else { hex(TEXT_SECONDARY) };
                let logo = if row.custom {
                    ph("sparkle", 15., logo_color)
                } else if agent == Agent::Codex {
                    ph("codex", 15., logo_color)
                } else {
                    ph("claude", 15., hex(CLAUDE_CLAY))
                };
                let is_default = agent == Agent::Codex && !row.id.is_empty() && p.default_model.as_deref() == Some(row.id.as_str()) && !row.custom;
                let id = row.id.clone();
                let note = row.upgrade_note.clone();
                list = list.child(
                    div()
                        .id(("model-item", row_ix))
                        .flex()
                        .items_start()
                        .gap(px(10.))
                        .px(px(9.))
                        .py(px(10.))
                        .when(i > 0, |d| d.mt(px(3.)))
                        .rounded(px(8.))
                        .cursor_pointer()
                        .when(current, |d| d.bg(rgba_hex(EMERALD, 0.09)))
                        .when(highlighted, |d| d.bg(white_a(0.08)))
                        .on_mouse_move(cx.listener(move |this, _, _, cx| {
                            if this.picker_nav.index != hover_ix { this.picker_nav.index = hover_ix; cx.notify(); }
                        }))
                        .when(!current, |d| d.hover(|s| s.bg(white_a(0.06))))
                        .when_some(note, |d, note| {
                            d.tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(note.clone()).build(window, cx))
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.menu = None;
                            this.pick_model(id.clone(), cx);
                            cx.notify();
                        }))
                        .child(logo.mt(px(2.)))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .child(
                                    div()
                                        .flex()
                                        .flex_wrap()
                                        .items_center()
                                        .gap(px(7.))
                                        .child(div().text_size(px(12.5)).font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_PRIMARY)).child(row.label))
                                        .when(is_default, |d| {
                                            d.child(
                                                div()
                                                    .px(px(5.))
                                                    .py(px(2.))
                                                    .rounded(px(4.))
                                                    .bg(white_a(0.06))
                                                    .text_size(px(9.))
                                                    .line_height(relative(1.2))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(hex(TEXT_SECONDARY))
                                                    .child("Default"),
                                            )
                                        }),
                                )
                                .when(!row.description.is_empty(), |d| {
                                    d.child(div().text_size(px(11.)).line_height(relative(1.45)).text_color(hex(TEXT_SECONDARY)).child(row.description))
                                }),
                        )
                        .child(div().w(px(13.)).flex_none().mt(px(3.)).when(current, |d| d.child(ph("check", 13., hex(EMERALD))))),
                );
                row_ix += 1;
            }
        }

        let menu = div()
            .id("model-menu")
            .occlude()
            .relative()
            .w(px(width))
            .p(px(7.))
            .bg(hex(BG_SECONDARY))
            .border_1()
            .border_color(hex(BORDER))
            .rounded(px(10.))
            .shadow(pop::shadow())
            .on_mouse_down_out(self.close_picker_listener("model", cx))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .pt(px(4.))
                    .px(px(8.))
                    .pb(px(9.))
                    .text_size(px(11.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(hex(TEXT_SECONDARY))
                    .child(if agent == Agent::Codex { "ChatGPT models" } else { "Model" })
                    .child(refresh),
            )
            .child(list)
            .when_some(catalog.error.clone(), |d, error| {
                d.child(div().pt(px(9.)).px(px(8.)).pb(px(3.)).text_size(px(11.)).line_height(relative(1.4)).text_color(hex(TEXT_SECONDARY)).child(error))
            })
            .child(pop::arrow(spot.arrow));
        Some(pop::place("model-pop", spot, menu).into_any_element())
    }

    // ---- the setup chips' menus (`.branch-menu`) --------------------------------

    /// The agent (`.harness-menu`) and Local/Cloud menus: no arrow, 280px wide
    /// at the chip row's left, sitting 4px into the row (`bottom: calc(100% -
    /// 4px)`), rising in like `@keyframes menu-in`.
    pub(super) fn render_setup_menu(&mut self, which: Menu, p: &Pickers, cx: &mut Context<Self>) -> Option<AnyElement> {
        let row = self.trigger("setup")?;
        let width = 280f32.min(f32::from(row.size.width) - 4.);
        let spot = pop::Spot { left: f32::from(row.left()) + 2., bottom: f32::from(row.top()) + 4., arrow: 0. };
        let (title, trigger, items): (&str, &'static str, Vec<(&'static str, &'static str, bool, Option<&'static str>)>) = match which {
            Menu::Agent => (
                "Harness",
                "agent-chip",
                vec![
                    ("claude", Agent::Claude.label(), p.agent == Agent::Claude, (self.host_state.claude_ok == Some(false)).then_some("Install")),
                    ("codex", Agent::Codex.label(), p.agent == Agent::Codex, (self.host_state.codex_ok == Some(false)).then_some("Install")),
                ],
            ),
            Menu::Place => ("Where it runs", "place-chip", vec![("laptop", "Local", !p.cloud, None), ("cloud", "Cloud", p.cloud, None)]),
            _ => return None,
        };
        let close = self.close_picker_listener(trigger, cx);
        let rows = items.into_iter().enumerate().map(|(i, (icon, label, current, note))| {
            let highlighted = self.picker_highlight(which.clone(), i);
            let pick = which.clone();
            div()
                .id(("setup-item", i))
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(8.))
                .py(px(7.))
                .when(i > 0, |d| d.mt(px(3.)))
                .rounded(px(7.))
                .cursor_pointer()
                .when(current, |d| d.bg(white_a(0.08)))
                .when(highlighted, |d| d.bg(white_a(0.08)))
                .on_mouse_move(cx.listener(move |this, _, _, cx| {
                    if this.picker_nav.index != i { this.picker_nav.index = i; cx.notify(); }
                }))
                .hover(|s| s.bg(white_a(0.06)))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.menu = None;
                    match pick {
                        Menu::Agent if !current => this.set_agent(if i == 0 { Agent::Claude } else { Agent::Codex }, window, cx),
                        Menu::Place if !current => this.set_cloud(i == 1, window, cx),
                        _ => {}
                    }
                    cx.notify();
                }))
                .child(ph(icon, 13., hex(TEXT_TERTIARY)))
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(if current { hex(TEXT_PRIMARY) } else { hex(TEXT_TERTIARY) })
                        .child(label),
                )
                .when_some(note, |d, note| {
                    d.child(div().ml_auto().text_size(px(10.5)).font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_TERTIARY)).child(note))
                })
                .child(
                    div()
                        .w(px(13.))
                        .flex_none()
                        .when(note.is_some(), |d| d.ml(px(8.)))
                        .when(note.is_none(), |d| d.ml_auto())
                        .when(current, |d| d.child(ph("check", 13., hex(TEXT_PRIMARY)))),
                )
        });
        let menu = div()
            .id("setup-menu")
            .occlude()
            .w(px(width))
            .p(px(5.))
            .bg(hex(BG_SECONDARY))
            .border_1()
            .border_color(hex(BORDER))
            .rounded(px(10.))
            .shadow(pop::shadow())
            .on_mouse_down_out(close)
            .child(div().pt(px(6.)).px(px(8.)).pb(px(8.)).text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_TERTIARY)).child(title))
            .children(rows);
        Some(pop::place("setup-pop", spot, menu).into_any_element())
    }

    // ---- permission mode -----------------------------------------------------

    pub(super) fn render_mode_menu(&mut self, p: &Pickers, viewport: Size<Pixels>, cx: &mut Context<Self>) -> Option<AnyElement> {
        let t = self.trigger("mode")?;
        let composer = self.trigger("composer")?;
        let width = 250.;
        // `.mode-menu { left: 14px; bottom: 54px }` inside the composer.
        let spot = pop::spot(
            f32::from(composer.left()) + 14.,
            f32::from(composer.bottom()) - 54.,
            width,
            10.,
            t,
            f32::from(viewport.width),
        );
        let entity = self.chats[self.active].clone();
        let close = self.close_picker_listener("mode", cx);
        let items = modes_for(p.agent).iter().enumerate().map(|(i, (id, label, _, _))| {
            let current = *id == p.mode;
            let highlighted = self.picker_highlight(Menu::Mode, i);
            let tone = match *id {
                "bypassPermissions" | "full-access" => hex(RED),
                "auto" => hex(WARN_BRIGHT),
                _ => hex(TEXT_PRIMARY),
            };
            let entity = entity.clone();
            div()
                .id(("mode-item", i))
                .flex()
                .items_center()
                .gap(px(9.))
                .p(px(8.))
                .when(i > 0, |d| d.mt(px(3.)))
                .rounded(px(8.))
                .cursor_pointer()
                .when(current, |d| d.bg(white_a(0.04)))
                .when(highlighted, |d| d.bg(white_a(0.08)))
                .on_mouse_move(cx.listener(move |this, _, _, cx| {
                    if this.picker_nav.index != i { this.picker_nav.index = i; cx.notify(); }
                }))
                .hover(|s| s.bg(white_a(0.06)))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.menu = None;
                    entity.update(cx, |c, cx| c.set_settings(None, None, Some(id.to_string()), cx));
                    cx.notify();
                }))
                .child(div().size(px(8.)).flex_none().rounded_full().bg(tone))
                .child(div().min_w_0().text_size(px(12.5)).font_weight(FontWeight::SEMIBOLD).text_color(tone).child(*label))
                .child(div().ml_auto().w(px(13.)).flex_none().when(current, |d| d.child(ph("check", 13., hex(TEXT_PRIMARY)))))
        });
        let menu = div()
            .id("mode-menu")
            .occlude()
            .relative()
            .w(px(width))
            .p(px(5.))
            .bg(hex(BG_SECONDARY))
            .border_1()
            .border_color(hex(BORDER))
            .rounded(px(10.))
            .shadow(pop::shadow())
            .on_mouse_down_out(close)
            .child(
                div()
                    .pt(px(6.))
                    .px(px(8.))
                    .pb(px(8.))
                    .text_size(px(11.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(hex(TEXT_TERTIARY))
                    .child("Permission mode"),
            )
            .children(items)
            .child(pop::arrow(spot.arrow));
        Some(pop::place("mode-pop", spot, menu).into_any_element())
    }

    // ---- effort ----------------------------------------------------------------

    /// Thumb position in stops → the slider's state, the label and the green.
    fn set_effort_value(&mut self, value: f32, rungs: &[Rung]) {
        let max = rungs.len().saturating_sub(1) as f32;
        let value = value.clamp(0., max);
        let index = value.round() as usize;
        if index != self.effort.index {
            self.effort.swapped = Some((Instant::now(), index > self.effort.index));
        }
        self.effort.value = value;
        self.effort.index = index;
        let ultra = rungs.get(index).is_some_and(|r| is_ultra(&r.id));
        if ultra && self.effort.ultra_since.is_none() {
            self.effort.ultra_since = Some(Instant::now());
        } else if !ultra {
            self.effort.ultra_since = None;
        }
    }

    fn commit_effort(&mut self, index: usize, rungs: &[Rung], cx: &mut Context<Self>) {
        let Some(rung) = rungs.get(index) else { return };
        let chat = self.chats[self.active].clone();
        if chat.read(cx).meta.effort.as_deref() == Some(rung.id.as_str()) {
            return;
        }
        let id = rung.id.clone();
        chat.update(cx, |c, cx| c.set_settings(None, Some(Some(id)), None, cx));
    }

    /// Arrows, Page keys, Home and End move a whole stop and commit at once.
    pub(super) fn effort_key(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let rungs = self.pickers(cx).rungs;
        if rungs.len() < 2 {
            return false;
        }
        let i = self.effort.index as isize;
        let target = match key {
            "left" | "down" | "pagedown" => i - 1,
            "right" | "up" | "pageup" => i + 1,
            "home" => 0,
            "end" => rungs.len() as isize - 1,
            _ => return false,
        }
        .clamp(0, rungs.len() as isize - 1) as usize;
        self.effort.spring += 1;
        self.set_effort_value(target as f32, &rungs);
        self.commit_effort(target, &rungs, cx);
        cx.notify();
        true
    }

    /// The pointer's place on the track, in stops (a native range input with
    /// a 22px thumb, inset 1px).
    fn effort_at(&self, x: f32, stops: usize) -> Option<f32> {
        let shell = self.trigger("effort-shell")?;
        let usable = f32::from(shell.size.width) - TRACK_PAD * 2. - THUMB_W;
        let max = stops.saturating_sub(1) as f32;
        let start = f32::from(shell.left()) + TRACK_PAD + THUMB_W / 2.;
        Some(((x - start) / usable * max).clamp(0., max))
    }

    fn effort_thumb_x(&self, stops: usize) -> Option<f32> {
        let shell = self.trigger("effort-shell")?;
        let usable = f32::from(shell.size.width) - TRACK_PAD * 2. - THUMB_W;
        let max = stops.saturating_sub(1).max(1) as f32;
        Some(f32::from(shell.left()) + TRACK_PAD + THUMB_W / 2. + usable * self.effort.value / max)
    }

    fn effort_press(&mut self, x: f32, cx: &mut Context<Self>) {
        let rungs = self.pickers(cx).rungs;
        if rungs.len() < 2 {
            return;
        }
        self.effort.spring += 1;
        self.effort.dragging = true;
        // On the thumb it keeps its grip; elsewhere it jumps under the pointer.
        let centre = self.effort_thumb_x(rungs.len()).unwrap_or(x);
        self.effort.grab = if (x - centre).abs() <= THUMB_W / 2. { x - centre } else { 0. };
        if self.effort.grab == 0. {
            if let Some(v) = self.effort_at(x, rungs.len()) {
                self.set_effort_value(magnet(v), &rungs);
            }
        }
        self.effort.samples = vec![(Instant::now(), self.effort.value)];
        cx.notify();
    }

    fn effort_drag(&mut self, x: f32, cx: &mut Context<Self>) {
        if !self.effort.dragging {
            return;
        }
        let rungs = self.pickers(cx).rungs;
        let Some(v) = self.effort_at(x - self.effort.grab, rungs.len()) else { return };
        let v = magnet(v);
        self.set_effort_value(v, &rungs);
        let now = Instant::now();
        self.effort.samples.push((now, v));
        self.effort.samples.retain(|(t, _)| now.duration_since(*t) < Duration::from_millis(90));
        if self.effort.samples.len() > 5 {
            let cut = self.effort.samples.len() - 5;
            self.effort.samples.drain(..cut);
        }
        cx.notify();
    }

    /// Release: commit the nearest stop now, then spring the thumb onto it.
    fn effort_release(&mut self, cx: &mut Context<Self>) {
        if !self.effort.dragging {
            return;
        }
        self.effort.dragging = false;
        let rungs = self.pickers(cx).rungs;
        let target = self.effort.value.round();
        self.commit_effort(target as usize, &rungs, cx);
        if (target - self.effort.value).abs() < 0.001 {
            self.set_effort_value(target, &rungs);
            cx.notify();
            return;
        }
        let mut velocity = 0.;
        if let (Some(first), Some(last)) = (self.effort.samples.first(), self.effort.samples.last()) {
            let elapsed = last.0.duration_since(first.0).as_secs_f32().max(0.016);
            velocity = ((last.1 - first.1) / elapsed).clamp(-8., 8.);
        }
        self.effort.spring += 1;
        let generation = self.effort.spring;
        let start = self.effort.value;
        cx.spawn(async move |this, cx| {
            let (mut position, mut v) = (start, velocity);
            let mut prev = Instant::now();
            loop {
                cx.background_executor().timer(Duration::from_millis(16)).await;
                let now = Instant::now();
                let dt = now.duration_since(prev).as_secs_f32().min(0.032);
                prev = now;
                v += (-920. * (position - target) - 40. * v) * dt;
                position += v * dt;
                let settled = (position - target).abs() < 0.001 && v.abs() < 0.01;
                let alive = this.update(cx, |this, cx| {
                    if this.effort.spring != generation || this.menu != Some(Menu::Effort) {
                        return false;
                    }
                    let rungs = this.pickers(cx).rungs;
                    this.set_effort_value(if settled { target } else { position }, &rungs);
                    cx.notify();
                    true
                });
                if settled || !matches!(alive, Ok(true)) {
                    break;
                }
            }
        })
        .detach();
        cx.notify();
    }

    pub(super) fn render_effort_menu(&mut self, p: &Pickers, viewport: Size<Pixels>, cx: &mut Context<Self>) -> Option<AnyElement> {
        let t = self.trigger("effort")?;
        let vw = f32::from(viewport.width);
        let width = 300f32.min(vw - 28.);
        // `right: -64px`: past the ring and the send button, so the panel's
        // right edge lands on the toolbar's.
        let spot = pop::spot(f32::from(t.right()) + 64. - width, f32::from(t.top()) - 6., width, 12., t, vw);
        let rungs = p.rungs.clone();
        let stops = rungs.len();
        let max = stops.saturating_sub(1).max(1) as f32;
        let progress = (self.effort.value / max).clamp(0., 1.);
        let rung = rungs.get(self.effort.index).cloned();
        let ultra = rung.as_ref().is_some_and(|r| is_ultra(&r.id));
        let tip = super::effort_tip(p.agent, rung.as_ref());
        let label = rung.map(|r| r.label).unwrap_or_default();
        let shell_w = width - 2. - 28.;
        let usable = shell_w - TRACK_PAD * 2. - THUMB_W;
        let since = self.effort.ultra_since;
        let swapped = self.effort.swapped;

        let level = {
            let text = div()
                .text_color(if ultra { hex(EMERALD) } else { hex(TEXT_PRIMARY) })
                .child(label.clone());
            match swapped.filter(|(at, _)| at.elapsed() < Duration::from_millis(220)) {
                // The new name arrives from below (or above, stepping back).
                Some((at, forward)) => text
                    .relative()
                    .with_animation(
                        SharedString::from(format!("effort-level-{label}-{at:?}")),
                        Animation::new(Duration::from_millis(180)).with_easing(|t| 1. - (1. - t).powi(3)),
                        move |el, t| el.opacity(t).top(px((1. - t) * if forward { 3. } else { -3. })),
                    )
                    .into_any_element(),
                None => text.into_any_element(),
            }
        };

        let help = div()
            .id("effort-help")
            .size(px(22.))
            .m(px(-2.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor(CursorStyle::Arrow)
            .group("effort-help")
            .hover(|s| s.bg(white_a(0.06)))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                this.effort.tip = *hovered;
                cx.notify();
            }))
            .child(ph("question", 14., hex(TEXT_TERTIARY)).group_hover("effort-help", |s| s.text_color(hex(TEXT_SECONDARY))));

        let app = cx.weak_entity();
        let dragging = self.effort.dragging;
        // While the thumb is held, follow the pointer anywhere in the window.
        let drag_events = canvas(
            |_, _, _| (),
            move |_, _, window, _| {
                if !dragging {
                    return;
                }
                let app_move = app.clone();
                window.on_mouse_event(move |e: &MouseMoveEvent, phase, _, cx| {
                    if phase == DispatchPhase::Bubble {
                        let _ = app_move.update(cx, |this, cx| this.effort_drag(f32::from(e.position.x), cx));
                    }
                });
                let app_up = app.clone();
                window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
                    if phase == DispatchPhase::Bubble {
                        let _ = app_up.update(cx, |this, cx| this.effort_release(cx));
                    }
                });
            },
        )
        .absolute()
        .size_0();

        let ticks = (0..stops).map(|i| {
            div().size(px(3.)).rounded_full().bg(if i + 1 == stops { hex(EMERALD) } else { hex(0x4d4d4d) })
        });
        let fill_w = usable * progress + THUMB_W / 2.;
        let track = div()
            .absolute()
            .top(px(5.))
            .left_0()
            .w(px(shell_w))
            .h(px(24.))
            .rounded(px(9.))
            .bg(hex(0x171717))
            .child(div().absolute().top_0().left_0().size_full().rounded(px(9.)).border_1().border_color(white_a(0.05)))
            .when(!ultra, |d| {
                d.child(
                    div()
                        .absolute()
                        .top_0()
                        .left(px(TRACK_PAD))
                        .h_full()
                        .w(px(fill_w))
                        .rounded_l(px(8.))
                        .bg(white_a(0.07)),
                )
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left(px(TRACK_PAD + THUMB_W / 2.))
                        .w(px(shell_w - 2. * (TRACK_PAD + THUMB_W / 2.)))
                        .h_full()
                        .flex()
                        .items_center()
                        .justify_between()
                        .children(ticks),
                )
            })
            .when_some(since.filter(|_| ultra), |d, since| d.child(ultra_field(since)));
        let thumb = div()
            .absolute()
            .top(px(5.))
            .left(px(TRACK_PAD + usable * progress))
            .w(px(THUMB_W))
            .h(px(THUMB_H))
            .rounded(px(7.))
            .border_1()
            .border_color(white_a(0.16))
            .bg(linear_gradient(180., linear_color_stop(hex(0x464646), 0.), linear_color_stop(hex(0x333333), 1.)))
            .shadow(vec![
                BoxShadow { color: hsla(0., 0., 0., 0.5), offset: point(px(0.), px(1.)), blur_radius: px(2.), spread_radius: px(0.), inset: false },
                BoxShadow { color: hsla(0., 0., 0., 0.35), offset: point(px(0.), px(4.)), blur_radius: px(10.), spread_radius: px(0.), inset: false },
            ]);
        let shell = div()
            .id("effort-shell")
            .relative()
            .h(px(34.))
            .mt(px(6.))
            .cursor(CursorStyle::ResizeLeftRight)
            .child(pop::track(&self.bounds, "effort-shell"))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, e: &MouseDownEvent, _, cx| this.effort_press(f32::from(e.position.x), cx)))
            // A quick click can end before the drag listeners are in place.
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, _, cx| this.effort_release(cx)))
            .child(track)
            .child(thumb)
            .child(drag_events);

        let menu = div()
            .id("effort-menu")
            .occlude()
            .relative()
            .w(px(width))
            .pt(px(12.))
            .px(px(14.))
            .pb(px(10.))
            .bg(hex(BG_SECONDARY))
            .border_1()
            .border_color(hex(BORDER))
            .rounded(px(12.))
            .shadow(pop::shadow())
            .on_mouse_down_out(self.close_picker_listener("effort", cx))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .min_h(px(22.))
                    .child(
                        div()
                            .flex()
                            .items_baseline()
                            .min_w_0()
                            .text_size(px(13.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .line_height(relative(1.3))
                            .text_color(hex(TEXT_SECONDARY))
                            .child("Effort")
                            .child(div().ml(px(5.)).child(level)),
                    )
                    .child(div().size(px(18.)).flex_none().child(help)),
            )
            .child(
                div()
                    .mt(px(14.))
                    .flex()
                    .justify_between()
                    .text_size(px(11.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hex(TEXT_TERTIARY))
                    .child("Faster")
                    .child("Smarter"),
            )
            .child(shell)
            .when(self.effort.tip, |d| {
                d.child(
                    div()
                        .absolute()
                        .top(px(38.))
                        .right(px(14.))
                        .w(px(220.))
                        .px(px(9.))
                        .py(px(7.))
                        .border_1()
                        .border_color(hex(BORDER))
                        .rounded(px(8.))
                        .bg(hex(BG_PRIMARY))
                        .shadow(vec![BoxShadow {
                            color: hsla(0., 0., 0., 0.5),
                            offset: point(px(0.), px(6.)),
                            blur_radius: px(18.),
                            spread_radius: px(0.),
                            inset: false,
                        }])
                        .text_size(px(11.5))
                        .font_weight(FontWeight::MEDIUM)
                        .line_height(relative(1.45))
                        .text_color(hex(TEXT_SECONDARY))
                        .child(tip),
                )
            })
            .child(pop::arrow(spot.arrow));
        Some(pop::place("effort-pop", spot, menu).into_any_element())
    }
}

/// chat.js effortMagnet: pull the thumb toward the nearest stop while dragging.
fn magnet(value: f32) -> f32 {
    let nearest = value.round();
    let delta = value - nearest;
    let distance = delta.abs();
    if distance < 0.001 || distance > 0.5 {
        return value;
    }
    let t = 1. - distance / 0.5;
    value - delta * (0.68 + 0.42 * t) * t * t
}

fn step(edge0: f32, edge1: f32, v: f32) -> f32 {
    let x = ((v - edge0) / (edge1 - edge0)).clamp(0., 1.);
    x * x * (3. - 2. * x)
}

fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn hash(a: f32, b: f32) -> f32 {
    ((a.sin() * b).abs()) % 1.
}

const TONES: [[f32; 3]; 11] = [
    [16., 185., 129.],
    [16., 185., 129.],
    [26., 191., 138.],
    [26., 191., 138.],
    [52., 211., 153.],
    [52., 211., 153.],
    [52., 211., 153.],
    [74., 222., 168.],
    [74., 222., 168.],
    [110., 231., 183.],
    [134., 239., 199.],
];
const DARK: [f32; 3] = [34., 38., 36.];
const HILITE: [f32; 3] = [167., 243., 208.];
const PEAK: [f32; 3] = [214., 250., 233.];
/// `.effort-track::before`, the green ramp under the cells.
const RAMP: [(f32, u32); 7] = [(0., 0x191919), (0.18, 0x1a1f1d), (0.32, 0x14352b), (0.48, 0x0f4f3b), (0.68, 0x0a6d50), (0.82, 0x099263), (1., 0x10b981)];

/// Ultracode's track (chat.js drawEffortPixels): a green ramp, then a grid
/// of cells that sweeps in from the left, each flickering on its own clock.
fn ultra_field(since: Instant) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let elapsed = since.elapsed().as_secs_f32() * 1000.;
            let width = f32::from(bounds.size.width);
            let height = f32::from(bounds.size.height);
            let ox = f32::from(bounds.origin.x);
            let oy = f32::from(bounds.origin.y);
            let radius = 9.;

            // The ramp fades in over 0.34s, ease-in.
            let ramp_alpha = {
                let t = (elapsed / 340.).clamp(0., 1.);
                t * t
            };
            for pair in RAMP.windows(2) {
                let (a, ca) = pair[0];
                let (b, cb) = pair[1];
                let x0 = ox + a * width;
                let x1 = ox + b * width;
                let mut path = PathBuilder::fill();
                let pts = rounded_strip(x0, x1, ox, oy, width, height, radius);
                path.move_to(pts[0]);
                for p in &pts[1..] {
                    path.line_to(*p);
                }
                path.close();
                if let Ok(path) = path.build() {
                    let fade = |c: u32| {
                        let mut h: Hsla = hex(c);
                        h.a *= ramp_alpha;
                        h
                    };
                    window.paint_path(path, linear_gradient(90., linear_color_stop(fade(ca), 0.), linear_color_stop(fade(cb), 1.)));
                }
            }

            let reveal = step(0., 1., elapsed / 1000.);
            let frontier = 1. - reveal;
            let cell = if width < 280. { 5. } else { 6. };
            let gap = 1.1;
            let columns = (width / cell).ceil() as i32;
            let rows = (height / cell).ceil() as i32;
            let raw_flow = elapsed / 4000.;
            let flow_cycle = raw_flow.floor();
            let flow = flow_cycle + step(0., 1., raw_flow - flow_cycle);
            for row in 0..rows {
                for column in 0..columns {
                    let (c, r) = (column as f32, row as f32);
                    let x = c * cell;
                    let y = r * cell;
                    // Inside the track's rounded corners only.
                    let (mx, my) = (x + cell * 0.5, y + cell * 0.5);
                    let dx = (radius - mx).max(mx - (width - radius)).max(0.);
                    let dy = (radius - my).max(my - (height - radius)).max(0.);
                    if dx * dx + dy * dy > radius * radius {
                        continue;
                    }
                    let nx = (x + cell * 0.5) / width;
                    let reveal_alpha = step(frontier - 0.1, frontier + 0.07, nx);
                    if reveal_alpha <= 0.002 {
                        continue;
                    }
                    let green_amount = step(0.1, 0.88, nx);
                    let field = step(0.04, 0.38, nx);
                    let depth = step(0.35, 0.95, nx);
                    let base_hash = hash(c * 12.9898 + r * 78.233, 43758.5453);
                    let tempo_hash = hash(c * 7.13 + r * 19.41, 19341.731);
                    let phase_hash = hash(c * 31.17 + r * 11.93, 28437.123);
                    let chroma_hash = hash(c * 9.47 + r * 67.13, 15823.917);
                    let period = 500. + tempo_hash * 1500.;
                    let local = elapsed + phase_hash * period;
                    let cycle = (local / period).floor();
                    let progress = (local % period) / period;
                    let cycle_hash = hash(c * 17.17 + r * 41.73 + cycle * 13.11, 24634.6345);
                    let width_hash = hash(c * 5.37 + r * 29.11 + cycle * 7.43, 17391.443);
                    let pulse_centre = 0.2 + cycle_hash * 0.55;
                    let pulse_width = 0.09 + width_hash * 0.08;
                    let pd = (progress - pulse_centre) / pulse_width;
                    let pulse = (-pd * pd * 1.45).exp() * if cycle_hash > 0.12 { 1. } else { 0.26 };
                    let fc = (nx + flow) * 9.;
                    let fi = fc.floor();
                    let fp = step(0., 1., fc - fi);
                    let flow_a = hash(fi * 18.31 + r * 37.17, 19283.173);
                    let flow_b = hash((fi + 1.) * 18.31 + r * 37.17, 19283.173);
                    let cluster = step(0.46, 0.84, mix(flow_a, flow_b, fp));
                    let wave_phase = (nx + flow + r * 0.06 + base_hash * 0.02) * std::f32::consts::TAU;
                    let wave = (0.5 + 0.5 * wave_phase.cos()).powi(5);
                    let directional = cluster.max(wave * 0.62);
                    let flicker = (pulse * (0.48 + directional * 0.58)).max(directional * (0.38 + base_hash * 0.28));
                    let glow = if reveal < 0.995 {
                        (-((nx - frontier).powi(2)) / 0.012).exp() * (1. - step(0.7, 1., reveal))
                    } else {
                        0.
                    };
                    let light = flicker.max(glow * (0.4 + base_hash * 0.4));
                    let peak = light > 0.4 && pulse > 0.16 && cycle_hash > 0.26 && cluster > 0.04;
                    let hottest = light > 0.68 && pulse > 0.3 && cycle_hash > 0.48 && cluster > 0.12;
                    let highlight = if peak { 0.97 } else { (light * (0.44 + cycle_hash * 0.3)).clamp(0., 0.64) };
                    let drift = base_hash * 0.28
                        + depth * 0.28
                        + progress * 0.38
                        + flow * 0.18
                        + cycle_hash * 0.2
                        + (elapsed * 0.00135 + phase_hash * std::f32::consts::TAU).sin() * 0.14;
                    let tone_pos = ((drift % 1.) + 1.) % 1. * TONES.len() as f32;
                    let ti = (tone_pos.floor() as usize).min(TONES.len() - 1);
                    let tm = tone_pos - tone_pos.floor();
                    let (ta, tb) = (TONES[ti], TONES[(ti + 1) % TONES.len()]);
                    let nudge = (chroma_hash - 0.5) * 10. + depth * 12.;
                    let green = [
                        (mix(ta[0], tb[0], tm) - depth * 8. + (base_hash - 0.5) * 6.).clamp(10., 120.),
                        (mix(ta[1], tb[1], tm) + nudge * 0.35 - depth * 10.).clamp(168., 240.),
                        (mix(ta[2], tb[2], tm) + depth * 6. + (cycle_hash - 0.5) * 6.).clamp(120., 205.),
                    ];
                    let target = if hottest { PEAK } else { HILITE };
                    let amount = if hottest { 0.95 } else { highlight };
                    let ch = |i: usize| mix(mix(DARK[i], green[i], green_amount), target[i], amount).round() / 255.;
                    let alpha = if peak || hottest {
                        reveal_alpha * field
                    } else {
                        reveal_alpha * field * (0.7 + base_hash * 0.2 + flicker * 0.12).clamp(0., 1.)
                    };
                    let color: Hsla = Rgba { r: ch(0), g: ch(1), b: ch(2), a: alpha }.into();
                    window.paint_quad(fill(
                        Bounds::new(point(px(ox + x + gap * 0.5), px(oy + y + gap * 0.5)), size(px(cell - gap), px(cell - gap))),
                        color,
                    ));
                }
            }
            window.request_animation_frame();
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// The part of a rounded rectangle between x0 and x1, as a polygon.
fn rounded_strip(x0: f32, x1: f32, ox: f32, oy: f32, width: f32, height: f32, radius: f32) -> Vec<Point<Pixels>> {
    let p = |x: f32, y: f32| point(px(x), px(y));
    let (left, right) = (ox, ox + width);
    let edge = |x: f32, top: bool| -> f32 {
        // How far the rounded corner pushes the edge in at this x.
        let d = if x < left + radius {
            radius - (radius * radius - (left + radius - x).powi(2)).max(0.).sqrt()
        } else if x > right - radius {
            radius - (radius * radius - (x - (right - radius)).powi(2)).max(0.).sqrt()
        } else {
            0.
        };
        if top { oy + d } else { oy + height - d }
    };
    let steps = 12;
    let mut pts = Vec::new();
    for i in 0..=steps {
        let x = x0 + (x1 - x0) * i as f32 / steps as f32;
        pts.push(p(x, edge(x, true)));
    }
    for i in (0..=steps).rev() {
        let x = x0 + (x1 - x0) * i as f32 / steps as f32;
        pts.push(p(x, edge(x, false)));
    }
    pts
}

#[cfg(test)]
mod navigation_tests {
    use super::next_row;

    #[test]
    fn menu_keys_stay_in_bounds() {
        assert_eq!(next_row("up", 0, 3), Some(0));
        assert_eq!(next_row("down", 2, 3), Some(2));
        assert_eq!(next_row("home", 2, 3), Some(0));
        assert_eq!(next_row("end", 0, 3), Some(2));
        assert_eq!(next_row("right", 0, 3), Some(1));
        assert_eq!(next_row("down", 0, 0), None);
        assert_eq!(next_row("enter", 0, 3), None);
    }
}
