//! Attachments, as the panel takes them (chat.js addAttachment / addFile):
//! images become 56px thumbnails above the text and travel with the prompt,
//! anything else becomes a chip naming the file. They come from the + button,
//! a paste (an image, or files copied in Finder) or a drop on the composer.
//!
//! A local chat sends images inline and names other files by path, which
//! the agent reads itself. A cloud chat has no inline images: every
//! attachment is uploaded into its sandbox (cloud.rs) and named by path there.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::*;
use serde_json::{Value, json};

use super::{StudioApp, base64_encode};
use crate::theme::*;
use crate::ui::ph;

/// Anthropic's advice: a longest edge of 1568px (chat.js MAX_IMG_EDGE).
const MAX_EDGE: u32 = 1568;
/// Larger files go in by path rather than inline.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

pub(super) enum AttachKind {
    Image {
        media_type: &'static str,
        data: Vec<u8>,
        preview: Arc<Image>,
    },
    File {
        path: PathBuf,
    },
}

pub(super) struct Attachment {
    id: u64,
    pub name: String,
    pub kind: AttachKind,
}

/// What a message carries once sent.
pub(super) struct Outgoing {
    /// `{mediaType, data}` for the host's `prompt`.
    pub images: Vec<Value>,
    /// Files on this Mac: named by path (local) or uploaded (cloud). Pasted
    /// images are written out first so a cloud chat can upload them too.
    pub files: Vec<PathBuf>,
}

/// Decode, scale to the 1568px edge, and re-encode: a small PNG stays
/// lossless, anything else becomes a JPEG (chat.js processImageBlob).
fn prepare_image(bytes: &[u8]) -> Option<(&'static str, Vec<u8>)> {
    let format = image::guess_format(bytes).ok()?;
    let decoded = image::load_from_memory(bytes).ok()?;
    let (w, h) = (decoded.width(), decoded.height());
    let scaled = w.max(h) > MAX_EDGE;
    let img = if scaled { decoded.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Lanczos3) } else { decoded };
    let mut out = Vec::new();
    if format == image::ImageFormat::Png && !scaled {
        img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png).ok()?;
        return Some(("image/png", out));
    }
    let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92);
    encoder.encode_image(&rgb).ok()?;
    Some(("image/jpeg", out))
}

fn is_image_path(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | "tif")
    )
}

impl StudioApp {
    fn next_attachment_id(&mut self) -> u64 {
        self.attachment_seq += 1;
        self.attachment_seq
    }

    fn push_image(&mut self, name: String, bytes: &[u8]) -> bool {
        let Some((media_type, data)) = prepare_image(bytes) else { return false };
        let format = if media_type == "image/png" { ImageFormat::Png } else { ImageFormat::Jpeg };
        let preview = Arc::new(Image::from_bytes(format, data.clone()));
        let id = self.next_attachment_id();
        self.attachments.push(Attachment { id, name, kind: AttachKind::Image { media_type, data, preview } });
        true
    }

    /// Files from the + button, a drop or a Finder copy.
    pub(super) fn attach_paths(&mut self, paths: impl IntoIterator<Item = PathBuf>, cx: &mut Context<Self>) {
        for path in paths {
            if path.is_dir() {
                continue;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if is_image_path(&path) {
                if let Ok(bytes) = std::fs::read(&path) {
                    if bytes.len() <= MAX_IMAGE_BYTES && self.push_image(name.clone(), &bytes) {
                        continue;
                    }
                }
            }
            if self.attachments.iter().any(|a| matches!(&a.kind, AttachKind::File { path: p } if *p == path)) {
                continue;
            }
            let id = self.next_attachment_id();
            self.attachments.push(Attachment { id, name, kind: AttachKind::File { path } });
        }
        cx.notify();
    }

    /// The composer's paste hook: take images and copied files, leave text
    /// to the text box. Returns whether the paste was taken.
    pub(super) fn attach_clipboard(&mut self, item: &ClipboardItem, cx: &mut Context<Self>) -> bool {
        let mut took = false;
        for entry in item.entries() {
            match entry {
                ClipboardEntry::ExternalPaths(paths) => {
                    self.attach_paths(paths.paths().iter().cloned(), cx);
                    took = true;
                }
                ClipboardEntry::Image(image) if !took => {
                    let n = self.attachments.iter().filter(|a| matches!(a.kind, AttachKind::Image { .. })).count() + 1;
                    took = self.push_image(format!("Pasted image {n}"), &image.bytes);
                }
                _ => {}
            }
        }
        if took {
            cx.notify();
        }
        took
    }

    pub(super) fn remove_attachment(&mut self, id: u64, cx: &mut Context<Self>) {
        self.attachments.retain(|a| a.id != id);
        cx.notify();
    }

    /// Empty the tray into what the message sends.
    pub(super) fn take_attachments(&mut self, cloud: bool) -> Outgoing {
        let mut out = Outgoing { images: Vec::new(), files: Vec::new() };
        for a in self.attachments.drain(..) {
            match a.kind {
                AttachKind::Image { media_type, data, .. } if !cloud => {
                    out.images.push(json!({ "mediaType": media_type, "data": base64_encode(&data) }));
                }
                AttachKind::Image { media_type, data, .. } => {
                    // A cloud chat uploads files, so the image goes to disk first.
                    let ext = if media_type == "image/png" { "png" } else { "jpg" };
                    let stem = Path::new(&a.name).file_stem().map(|s| s.to_string_lossy().replace(' ', "-")).unwrap_or_else(|| "image".into());
                    let dir = std::env::temp_dir().join("lizard-studio-attachments");
                    let _ = std::fs::create_dir_all(&dir);
                    let path = dir.join(format!("{stem}-{}.{ext}", crate::store::now_ms()));
                    if std::fs::write(&path, &data).is_ok() {
                        out.files.push(path);
                    }
                }
                AttachKind::File { path } => out.files.push(path),
            }
        }
        out
    }

    /// `.attach-thumbs` and the file chips, above the text.
    pub(super) fn render_attachments(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.attachments.is_empty() {
            return None;
        }
        let thumbs: Vec<(u64, Arc<Image>)> = self
            .attachments
            .iter()
            .filter_map(|a| match &a.kind {
                AttachKind::Image { preview, .. } => Some((a.id, preview.clone())),
                _ => None,
            })
            .collect();
        let files: Vec<(u64, String, String)> = self
            .attachments
            .iter()
            .filter_map(|a| match &a.kind {
                AttachKind::File { path } => Some((a.id, a.name.clone(), path.to_string_lossy().to_string())),
                _ => None,
            })
            .collect();
        let thumb_row = (!thumbs.is_empty()).then(|| {
            div().flex().flex_wrap().gap(px(6.)).pt(px(4.)).px(px(4.)).pb(px(6.)).children(thumbs.into_iter().map(|(id, preview)| {
                let group: SharedString = format!("thumb-{id}").into();
                div()
                    .id(("thumb", id as usize))
                    .group(group.clone())
                    .relative()
                    .size(px(56.))
                    .rounded(px(9.))
                    .overflow_hidden()
                    .border_1()
                    .border_color(hex(BORDER))
                    .bg(hex(BG_PRIMARY))
                    .child(img(preview).size_full().rounded(px(8.)).object_fit(ObjectFit::Cover))
                    .child(
                        div()
                            .id(("thumb-x", id as usize))
                            .absolute()
                            .top(px(2.))
                            .right(px(2.))
                            .size(px(17.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(5.))
                            .bg(hsla(0., 0., 0., 0.6))
                            .cursor_pointer()
                            .invisible()
                            .group_hover(group, |s| s.visible())
                            .hover(|s| s.bg(hsla(0., 0., 0., 0.85)))
                            .on_click(cx.listener(move |this, _, _, cx| this.remove_attachment(id, cx)))
                            .child(ph("x", 10., hsla(0., 0., 1., 1.))),
                    )
            }))
        });
        // `.ctx-chip`: a file icon that turns into × on hover.
        let chip_row = (!files.is_empty()).then(|| {
            div().flex().flex_wrap().gap(px(5.)).pt(px(2.)).px(px(4.)).pb(px(6.)).children(files.into_iter().map(|(id, name, path)| {
                let group: SharedString = format!("chip-{id}").into();
                div()
                    .id(("file-chip", id as usize))
                    .group(group.clone())
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .max_w_full()
                    .min_w_0()
                    .px(px(9.))
                    .py(px(4.))
                    .rounded(px(7.))
                    .bg(white_a(0.06))
                    .text_size(px(11.5))
                    .line_height(relative(1.2))
                    .text_color(hex(TEXT_SECONDARY))
                    .hover(|s| s.bg(white_a(0.1)).text_color(hex(TEXT_PRIMARY)))
                    .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(path.clone()).build(window, cx))
                    // The icon and its × share one slot; × shows on hover.
                    .child(
                        div()
                            .relative()
                            .size(px(13.))
                            .flex_none()
                            .child(ph("file", 13., hex(TEXT_SECONDARY)).group_hover(group.clone(), |s| s.invisible()))
                            .child(
                                div()
                                    .id(("file-chip-x", id as usize))
                                    .absolute()
                                    .top_0()
                                    .left_0()
                                    .size_full()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .cursor_pointer()
                                    .invisible()
                                    .group_hover(group, |s| s.visible())
                                    .on_click(cx.listener(move |this, _, _, cx| this.remove_attachment(id, cx)))
                                    .child(ph("x", 11., hex(TEXT_PRIMARY))),
                            ),
                    )
                    .child(div().truncate().child(name))
            }))
        });
        Some(div().flex().flex_col().children(thumb_row).children(chip_row).into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_EDGE, prepare_image};
    use std::io::Cursor;

    #[test]
    fn big_images_shrink_to_the_edge() {
        let img = image::RgbImage::from_pixel(3000, 1000, image::Rgb([200, 10, 10]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(img).write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        let (media, out) = prepare_image(&png).unwrap();
        assert_eq!(media, "image/jpeg");
        let back = image::load_from_memory(&out).unwrap();
        assert_eq!(back.width(), MAX_EDGE);
    }

    #[test]
    fn small_png_stays_png() {
        let img = image::RgbaImage::from_pixel(40, 30, image::Rgba([1, 2, 3, 255]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img).write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        assert_eq!(prepare_image(&png).unwrap().0, "image/png");
    }
}
