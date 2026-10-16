//! One viewer for images in the composer and in sent bubbles.

use std::sync::Arc;

use gpui_kit::*;

use super::StudioApp;
use crate::theme::*;

impl StudioApp {
    pub(super) fn open_image(&mut self, image: Arc<Image>, cx: &mut Context<Self>) {
        self.menu = None;
        self.image_viewer = Some(image);
        cx.notify();
    }

    pub(super) fn render_image_viewer(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let image = self.image_viewer.clone()?;
        Some(
            div()
                .id("image-viewer")
                .occlude()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .p(px(24.))
                .bg(hsla(0., 0., 0., 0.75))
                .cursor_pointer()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(|this, _, _, cx| {
                    this.image_viewer = None;
                    cx.notify();
                }))
                .child(img(image).max_w(self.viewport.width - px(48.)).max_h(self.viewport.height - px(48.)).rounded(px(8.)).object_fit(ObjectFit::Contain).shadow(vec![BoxShadow {
                    color: hsla(0., 0., 0., 0.6),
                    offset: point(px(0.), px(20.)),
                    blur_radius: px(60.),
                    spread_radius: px(0.),
                    inset: false,
                }]))
                .into_any_element(),
        )
    }
}

/// The panel's `.bubble-thumbs`, sized like the composer's 56px thumbnails.
pub(super) fn bubble_thumbs(images: &[Arc<Image>], app: &WeakEntity<StudioApp>, row: usize) -> Option<AnyElement> {
    if images.is_empty() {
        return None;
    }
    Some(div().flex().flex_wrap().gap(px(6.)).mb(px(6.)).children(images.iter().enumerate().map(|(i, image)| {
        let image = image.clone();
        let app = app.clone();
        div()
            .id((SharedString::from(format!("bubble-image-{row}")), i))
            .size(px(56.))
            .rounded(px(8.))
            .overflow_hidden()
            .border_1()
            .border_color(white_a(0.08))
            .cursor_pointer()
            .child(img(image.clone()).size_full().object_fit(ObjectFit::Cover))
            .on_click(move |_, _, cx| {
                let _ = app.update(cx, |this, cx| this.open_image(image.clone(), cx));
            })
    })).into_any_element())
}
