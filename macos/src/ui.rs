//! Small pieces drawn the way the Chrome panel draws them.

use std::f32::consts::PI;
use std::time::Duration;

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::store::now_ms;
use crate::theme::*;

/// A panel icon (src/panel/icons.js), tinted by `color`.
pub fn ph(name: &str, size: f32, color: impl Into<Hsla>) -> Svg {
    svg().path(format!("ph/{name}.svg")).size(px(size)).flex_none().text_color(color.into())
}

/// The lizard mark, square at `size`.
pub fn lizard(size: f32, color: impl Into<Hsla>) -> Svg {
    ph("lizard", size, color)
}

/// The panel's caret-down, turned to read as › while collapsed.
pub fn caret(open: bool, color: impl Into<Hsla>) -> Svg {
    ph("caret-down", 14., color).when(!open, |s| s.with_transformation(Transformation::rotate(radians(-PI / 2.))))
}

/// `@keyframes pulse { 0%,100% {opacity:.3} 50% {opacity:1} }`.
pub fn pulse<E: IntoElement + Styled + 'static>(id: impl Into<ElementId>, period_ms: u64, element: E) -> AnyElement {
    element
        .with_animation(
            id,
            Animation::new(Duration::from_millis(period_ms)).repeat(),
            |el, t| {
                let phase = 1. - (2. * t - 1.).abs();
                el.opacity(0.3 + 0.7 * phase)
            },
        )
        .into_any_element()
}

/// The context ring: an 18px circle, track plus a green (or yellow ≥ 90%) arc
/// from twelve o'clock.
pub fn ring(fraction: f32) -> impl IntoElement {
    let fraction = fraction.clamp(0., 1.);
    let high = fraction >= 0.9;
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let center = bounds.center();
            let radius = px(7.);
            let stroke = px(2.5);
            let point_at = |turn: f32| {
                let angle = -PI / 2. + turn * 2. * PI;
                point(center.x + radius * angle.cos(), center.y + radius * angle.sin())
            };
            let mut track = PathBuilder::stroke(stroke);
            track.move_to(point_at(0.));
            for i in 1..=64 {
                track.line_to(point_at(i as f32 / 64.));
            }
            if let Ok(path) = track.build() {
                window.paint_path(path, white_a(0.14));
            }
            if fraction > 0.005 {
                let steps = ((64. * fraction).ceil() as usize).max(2);
                let mut arc = PathBuilder::stroke(stroke);
                arc.move_to(point_at(0.));
                for i in 1..=steps {
                    arc.line_to(point_at(fraction * i as f32 / steps as f32));
                }
                if let Ok(path) = arc.build() {
                    window.paint_path(path, if high { hex(WARN_BRIGHT) } else { hex(EMERALD) });
                }
            }
        },
    )
    .size(px(18.))
}

/// chat.js relTime: "now", "5m ago", "3h ago", "2d ago".
pub fn rel_time(ms: u64) -> String {
    if ms == 0 {
        return String::new();
    }
    let s = now_ms().saturating_sub(ms) / 1000;
    if s < 60 {
        return "now".into();
    }
    let m = s / 60;
    if m < 60 {
        return format!("{m}m ago");
    }
    let h = m / 60;
    if h < 24 {
        return format!("{h}h ago");
    }
    format!("{}d ago", h / 24)
}

/// chat.js formatElapsed: "42s", "3m 7s", "1h 39m 34s".
pub fn elapsed(secs: u64) -> String {
    if secs < 60 {
        return format!("{secs}s");
    }
    let m = secs / 60;
    if m < 60 {
        return format!("{m}m {}s", secs % 60);
    }
    format!("{}h {}m {}s", m / 60, m % 60, secs % 60)
}

/// `toLocaleString` for a token count: 101934 -> "101,934".
pub fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

pub fn folder_label(cwd: Option<&str>) -> String {
    match cwd {
        None => "Select folder".into(),
        Some(cwd) => {
            let home = crate::host::home_dir();
            if cwd.trim_end_matches('/') == home.to_string_lossy().trim_end_matches('/') {
                "~".into()
            } else {
                cwd.rsplit('/').find(|s| !s.is_empty()).unwrap_or(cwd).to_string()
            }
        }
    }
}

/// One row of a picker (`.mode-menu`, model and effort menus).
pub struct MenuEntry {
    pub label: SharedString,
    pub hint: Option<SharedString>,
    pub current: bool,
    pub accent: Option<Hsla>,
    pub on_click: Box<dyn Fn(&mut Window, &mut App) + 'static>,
}

/// The picker box: #141414, 1px #2e2e2e, radius 10, padding 5, items 3px apart.
pub fn menu_box(id: impl Into<ElementId>, width: f32, entries: Vec<MenuEntry>) -> Stateful<Div> {
    let id = id.into();
    div()
        .id(id.clone())
        .occlude()
        .w(px(width))
        .p(px(5.))
        .flex()
        .flex_col()
        .gap(px(3.))
        .bg(hex(BG_SECONDARY))
        .border_1()
        .border_color(hex(BORDER))
        .rounded(px(10.))
        .shadow(vec![BoxShadow {
            color: hsla(0., 0., 0., 0.45),
            offset: point(px(0.), px(8.)),
            blur_radius: px(28.),
            spread_radius: px(0.),
            inset: false,
        }])
        .children(entries.into_iter().enumerate().map(|(i, entry)| {
            let on_click = entry.on_click;
            div()
                .id(("menu-item", i))
                .flex()
                .flex_col()
                .gap(px(2.))
                .p(px(8.))
                .rounded(px(8.))
                .cursor_pointer()
                .when(entry.current, |d| d.bg(white_a(0.08)))
                .when(!entry.current, |d| d.hover(|s| s.bg(white_a(0.06))))
                .on_click(move |_, window, cx| on_click(window, cx))
                .child(
                    div()
                        .text_size(px(12.5))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(entry.accent.unwrap_or(hex(TEXT_PRIMARY)))
                        .child(entry.label),
                )
                .when_some(entry.hint, |d, hint| {
                    d.child(div().text_size(px(11.5)).line_height(px(15.)).text_color(hex(TEXT_TERTIARY)).child(hint))
                })
        }))
}

/// Float `content` above (or below) the element it is placed next to.
pub fn popup(anchor: Anchor, offset: Point<Pixels>, content: impl IntoElement) -> impl IntoElement {
    deferred(anchored().anchor(anchor).offset(offset).snap_to_window_with_margin(px(8.)).child(content))
        .with_priority(1)
}
