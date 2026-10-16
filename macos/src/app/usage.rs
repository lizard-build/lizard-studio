//! The usage popover on the context ring (chat.js renderUsageMenu): the
//! open chat's context window, then the plan's limits for its agent.
//!
//! Claude's limits come from the `rate_limit_event` every turn streams (its
//! five-hour and weekly windows); ChatGPT's from the host's `planUsage`, sent
//! after each turn and on request. A cloud chat runs on the credential
//! connected to the Lizard account, so it shows the context window only.

use std::time::{Duration, Instant};

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Value, json};

use super::{Menu, StudioApp};
use crate::pop;
use crate::store::{Agent, now_ms};
use crate::theme::*;

/// Re-ask ChatGPT for its limits when the popover opens on older numbers.
const STALE: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct PlanRow {
    label: String,
    pct: f32,
    resets_at: Option<u64>,
}

#[derive(Default)]
pub(super) struct PlanUsage {
    rows: Vec<PlanRow>,
    error: Option<String>,
    at: Option<Instant>,
    fetching: bool,
}

/// chat.js describeReset: "in 5 days", else the local date and hour
/// ("Oct 16, 5 PM", toLocaleString with month, day and hour).
fn describe_reset(unix: u64) -> String {
    let now = now_ms() / 1000;
    let days = ((unix as f64 - now as f64) / 86_400.).round();
    if days > 1. {
        return format!("in {days} days");
    }
    let local = unix as i64 + utc_offset();
    let (month, day) = civil_from_days(local.div_euclid(86_400));
    let hour = local.rem_euclid(86_400) / 3_600;
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (h12, ampm) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    format!("{} {day}, {h12} {ampm}", MONTHS[(month - 1) as usize])
}

/// This Mac's offset from UTC in seconds, read once (`date +%z`).
fn utc_offset() -> i64 {
    static OFFSET: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *OFFSET.get_or_init(|| {
        let out = std::process::Command::new("/bin/date").arg("+%z").output().ok();
        let text = out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        let (sign, digits) = match text.split_at_checked(1) {
            Some(("-", d)) => (-1, d),
            Some(("+", d)) => (1, d),
            _ => return 0,
        };
        let h: i64 = digits.get(..2).and_then(|d| d.parse().ok()).unwrap_or(0);
        let m: i64 = digits.get(2..4).and_then(|d| d.parse().ok()).unwrap_or(0);
        sign * (h * 3_600 + m * 60)
    })
}

/// Month and day of a day count since 1970-01-01 (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (month, day)
}

/// chat.js describeWindow.
fn describe_window(mins: u64) -> String {
    if mins >= 40_000 {
        "Monthly limit".into()
    } else if mins >= 8_000 {
        "Weekly limit".into()
    } else if mins >= 240 {
        format!("{}-hour limit", (mins as f64 / 60.).round())
    } else {
        format!("{mins}-minute limit")
    }
}

/// "113.6k" / "1.0M", as the panel writes token counts.
fn k_one_dec(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.)
    } else {
        format!("{:.1}k", n as f64 / 1_000.)
    }
}

impl StudioApp {
    /// A Claude turn's `rate_limit_event`: its unified five-hour and weekly
    /// windows, as the plan rows.
    pub(super) fn on_rate_limit(&mut self, info: &Value, cx: &mut Context<Self>) {
        let windows = info.get("unifiedWindows");
        let mut rows = Vec::new();
        for (key, label) in [("five_hour", "5-hour limit"), ("seven_day", "Weekly · all models"), ("seven_day_opus", "Weekly · Opus"), ("seven_day_sonnet", "Weekly · Sonnet")] {
            let Some(w) = windows.and_then(|w| w.get(key)) else { continue };
            let Some(util) = w.get("utilization").and_then(Value::as_f64) else { continue };
            rows.push(PlanRow { label: label.into(), pct: (util * 100.) as f32, resets_at: w.get("resetsAt").and_then(Value::as_u64) });
        }
        // An older CLI names only the window that triggered the event.
        if rows.is_empty() {
            if let Some(util) = info.get("utilization").and_then(Value::as_f64) {
                let label = match info.get("rateLimitType").and_then(Value::as_str) {
                    Some("five_hour") => "5-hour limit",
                    Some("seven_day") => "Weekly · all models",
                    _ => "Plan usage",
                };
                rows.push(PlanRow { label: label.into(), pct: (util * 100.) as f32, resets_at: info.get("resetsAt").and_then(Value::as_u64) });
            }
        }
        if !rows.is_empty() {
            self.claude_usage = PlanUsage { rows, error: None, at: Some(Instant::now()), fetching: false };
            cx.notify();
        }
    }

    /// The Codex host's `planUsage` (chat.js case "planUsage").
    pub(super) fn on_plan_usage(&mut self, msg: &Value, cx: &mut Context<Self>) {
        let usage = &mut self.codex_usage;
        usage.fetching = false;
        usage.at = Some(Instant::now());
        usage.error = msg.get("error").and_then(Value::as_str).map(str::to_string);
        if usage.error.is_none() {
            let limits: Vec<Value> = match msg.get("limits").and_then(Value::as_array) {
                Some(limits) => limits.clone(),
                None => vec![json!({ "primary": {
                    "usedPercent": msg.get("usedPercent"), "windowDurationMins": msg.get("windowMins"), "resetsAt": msg.get("resetsAt"),
                } })],
            };
            usage.rows = limits
                .iter()
                .flat_map(|limit| {
                    let name = limit
                        .get("limitName")
                        .and_then(Value::as_str)
                        .or_else(|| limit.get("limitId").and_then(Value::as_str).filter(|id| *id != "codex"))
                        .map(|n| n.replace("codex", "ChatGPT"));
                    ["primary", "secondary"].into_iter().filter_map(move |key| {
                        let w = limit.get(key)?;
                        let pct = w.get("usedPercent").and_then(Value::as_f64)?;
                        let mut label = w.get("windowDurationMins").and_then(Value::as_u64).map(describe_window).unwrap_or_else(|| "Plan usage".into());
                        if let Some(name) = &name {
                            label = format!("{label} · {name}");
                        }
                        Some(PlanRow { label, pct: pct.clamp(0., 100.) as f32, resets_at: w.get("resetsAt").and_then(Value::as_u64) })
                    })
                })
                .collect();
        }
        cx.notify();
    }

    /// Open the popover; ChatGPT's numbers are asked for again when stale.
    pub(super) fn open_usage(&mut self, cx: &mut Context<Self>) {
        let chat = self.chats[self.active].read(cx);
        let (agent, cloud, id) = (chat.meta.agent, chat.meta.cloud, chat.id().to_string());
        if agent == Agent::Codex && !cloud && !self.codex_usage.fetching && self.codex_usage.at.map_or(true, |at| at.elapsed() > STALE) && self.host.is_connected() {
            self.codex_usage.fetching = true;
            self.host.send(json!({ "type": "planUsage", "agent": "codex", "id": id }));
        }
    }

    pub(super) fn render_usage_menu(&mut self, p: &super::pickers::Pickers, used: u64, limit: u64, viewport: Size<Pixels>, cx: &mut Context<Self>) -> Option<AnyElement> {
        let t = self.bounds.borrow().get("usage").copied()?;
        let chat = self.chats[self.active].read(cx);
        let cloud = chat.meta.cloud;
        let custom = p.model_row.as_ref().is_some_and(|r| r.custom);
        let known = limit > 0;
        let ctx_pct = if known { (used as f64 / limit as f64 * 100.).round() as u32 } else { 0 };
        let ctx_value = if known { format!("{} / {} ({}%)", k_one_dec(used), k_one_dec(limit), ctx_pct.min(100)) } else { "Awaiting usage".into() };

        // Plan rows: none for a cloud chat or a custom endpoint.
        let plan = (!cloud && !custom).then(|| match p.agent {
            Agent::Claude => &self.claude_usage,
            Agent::Codex => &self.codex_usage,
        });
        let plan_rows = plan.map(|u| u.rows.clone()).unwrap_or_default();
        let plan_note = plan.and_then(|u| {
            if !u.rows.is_empty() {
                u.error.clone()
            } else if let Some(e) = &u.error {
                Some(e.clone())
            } else if p.agent == Agent::Codex && u.fetching {
                None
            } else {
                Some("Usage unavailable".to_string())
            }
        });
        let loading = plan.is_some_and(|u| u.rows.is_empty() && u.fetching);

        let vw = f32::from(viewport.width);
        let width = if plan_rows.is_empty() { 264f32 } else { 360f32 }.min(vw - 20.);
        // `right: -32px`: past the send button, onto the toolbar's edge.
        let spot = pop::spot(f32::from(t.right()) + 32. - width, f32::from(t.top()) - 6., width, 10., t, vw);

        let row = |label: String, pct: f32, value: String, resets: Option<String>, pct_col: bool| {
            div()
                .flex()
                .flex_col()
                .gap(px(7.))
                .child(
                    div()
                        .flex()
                        .items_baseline()
                        .justify_between()
                        .gap(px(16.))
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(div().flex_none().max_w(relative(0.45)).text_color(hex(TEXT_PRIMARY)).child(label))
                        .child(
                            div()
                                .flex()
                                .items_baseline()
                                .gap(px(8.))
                                .min_w_0()
                                .text_color(hex(TEXT_SECONDARY))
                                .when_some(resets, |d, r| d.child(div().w(px(150.)).text_right().child(format!("Resets {r}"))))
                                .child(div().when(pct_col, |d| d.w(px(34.)).text_right()).whitespace_nowrap().child(value)),
                        ),
                )
                .child(
                    div()
                        .h(px(5.))
                        .w_full()
                        .rounded_full()
                        .bg(white_a(0.08))
                        .overflow_hidden()
                        .child(div().h_full().w(relative(pct.clamp(0., 100.) / 100.)).rounded_full().bg(hex(EMERALD))),
                )
        };

        let mut menu = div()
            .id("usage-menu")
            .occlude()
            .relative()
            .w(px(width))
            .flex()
            .flex_col()
            .gap(px(16.))
            .py(px(14.))
            .px(px(16.))
            .bg(hex(BG_SECONDARY))
            .border_1()
            .border_color(hex(BORDER))
            .rounded(px(10.))
            .shadow(pop::shadow())
            .on_mouse_down_out(self.close_picker_listener("usage", cx))
            .child(div().flex().flex_col().gap(px(12.)).child(row("Context window".into(), ctx_pct as f32, ctx_value, None, false)));
        if plan.is_some() {
            let mut sec = div()
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(hex(TEXT_SECONDARY)).child("Plan usage"));
            for r in plan_rows {
                let resets = r.resets_at.map(describe_reset);
                sec = sec.child(row(r.label, r.pct, format!("{}%", r.pct.round() as u32), resets, true));
            }
            if loading {
                // Codex reports one window; a placeholder holds its place.
                sec = sec.child(row("Plan usage".into(), 0., "…".into(), None, true));
            }
            if let Some(note) = plan_note {
                sec = sec.child(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(hex(TEXT_SECONDARY)).child(note));
            }
            menu = menu.child(sec);
        }
        let menu = menu.child(pop::arrow(spot.arrow));
        Some(pop::place("usage-pop", spot, menu).into_any_element())
    }

    pub(super) fn toggle_usage(&mut self, cx: &mut Context<Self>) {
        if self.menu == Some(Menu::Usage) {
            self.menu = None;
        } else {
            self.open_usage(cx);
            self.menu = Some(Menu::Usage);
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{civil_from_days, describe_window, k_one_dec};

    #[test]
    fn dates_and_windows() {
        assert_eq!(civil_from_days(20_377), (10, 16)); // 2025-10-16
        assert_eq!(describe_window(300), "5-hour limit");
        assert_eq!(describe_window(10_080), "Weekly limit");
        assert_eq!(k_one_dec(113_600), "113.6k");
        assert_eq!(k_one_dec(1_000_000), "1.0M");
    }
}
