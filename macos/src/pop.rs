//! The composer's popovers (panel.css `.pop`): a panel that opens above its
//! button, with an arrow under it pointing at the button's centre, kept 8px
//! inside the window (chat.js anchorPopover).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::*;

use crate::theme::*;

/// Arrow square, px (`--pop-arrow`).
const ARROW: f32 = 9.;
/// Closest a popover may sit to the window edge.
pub const EDGE: f32 = 8.;

/// Where elements were laid out last frame, by name, in window coordinates.
pub type BoundsMap = Rc<RefCell<HashMap<&'static str, Bounds<Pixels>>>>;

/// Put inside a `relative()` element to record its bounds under `key`.
pub fn track(map: &BoundsMap, key: &'static str) -> impl IntoElement {
    let map = map.clone();
    canvas(
        move |bounds, _, _| {
            map.borrow_mut().insert(key, bounds);
        },
        |_, _, _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// A placed popover: its left and bottom edges in window coordinates and how
/// far along its bottom edge the arrow sits (`--pop-arrow-x`, from the
/// padding box).
#[derive(Clone, Copy)]
pub struct Spot {
    pub left: f32,
    pub bottom: f32,
    pub arrow: f32,
}

/// `want_left` is where CSS would put the panel; it is slid back inside the
/// window, and the arrow tracks the trigger's centre short of the corners.
pub fn spot(want_left: f32, bottom: f32, width: f32, radius: f32, trigger: Bounds<Pixels>, viewport_w: f32) -> Spot {
    let room = (viewport_w - EDGE - width).max(EDGE);
    let left = want_left.max(EDGE).min(room);
    let half = ARROW / 2.;
    let centre = f32::from(trigger.center().x) - left - 1.;
    let arrow = centre.min(width - radius - half).max(radius + half);
    Spot { left, bottom, arrow }
}

pub fn shadow() -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: hsla(0., 0., 0., 0.45),
        offset: point(px(0.), px(8.)),
        blur_radius: px(28.),
        spread_radius: px(0.),
        inset: false,
    }]
}

/// The arrow (`.pop::after`): a 10px square (9 + its 1px border) stood on its
/// corner with its centre half a pixel inside the panel's bottom border, the
/// two outward edges stroked. Place as the panel's last child.
pub fn arrow(x: f32) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            // The canvas sits at the padding box's bottom-left corner.
            let cx = f32::from(bounds.origin.x) + x + 0.5;
            let cy = f32::from(bounds.origin.y) - 0.5;
            let d = 5. * std::f32::consts::SQRT_2;
            let p = |x: f32, y: f32| point(px(x), px(y));
            let mut fill = PathBuilder::fill();
            fill.move_to(p(cx - d, cy));
            fill.line_to(p(cx, cy + d));
            fill.line_to(p(cx + d, cy));
            fill.line_to(p(cx, cy - d));
            fill.close();
            if let Ok(path) = fill.build() {
                window.paint_path(path, hex(BG_SECONDARY));
            }
            // The border band along the two lower edges, 1px thick.
            let i = std::f32::consts::SQRT_2;
            let mut band = PathBuilder::fill();
            band.move_to(p(cx - d, cy));
            band.line_to(p(cx, cy + d));
            band.line_to(p(cx + d, cy));
            band.line_to(p(cx + d - i, cy));
            band.line_to(p(cx, cy + d - i));
            band.line_to(p(cx - d + i, cy));
            band.close();
            if let Ok(path) = band.build() {
                window.paint_path(path, hex(BORDER));
            }
        },
    )
    .absolute()
    .left_0()
    .bottom_0()
    .size_0()
}

/// Float `content` with its bottom-left corner at the spot, growing in like
/// `@keyframes pop-in` (fade and a 6px rise).
pub fn place(id: impl Into<ElementId>, spot: Spot, content: impl IntoElement + Styled + 'static) -> impl IntoElement {
    deferred(
        anchored()
            .position(point(px(spot.left), px(spot.bottom)))
            .anchor(Anchor::BottomLeft)
            .child(content.with_animation(
                id,
                Animation::new(Duration::from_millis(220)).with_easing(|t| 1. - (1. - t).powi(5)),
                |el, t| el.opacity(t),
            )),
    )
    .with_priority(1)
}
