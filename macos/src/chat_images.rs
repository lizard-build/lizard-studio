//! User images keep their bytes so thumbnails and the viewer share one asset.

use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use gpui_kit::{Image, ImageFormat};
use serde_json::{Value, json};

/// Ignore cut transcript strings instead of drawing a broken thumbnail.
fn image_bytes(source: &Value) -> Option<(ImageFormat, Vec<u8>)> {
    if source.get("type").and_then(Value::as_str).is_some_and(|kind| kind != "base64") {
        return None;
    }
    let data = source.get("data")?.as_str()?;
    if data.is_empty() {
        return None;
    }
    let bytes = STANDARD.decode(data).ok()?;
    let format = match image::guess_format(&bytes).ok()? {
        image::ImageFormat::Png => ImageFormat::Png,
        image::ImageFormat::Jpeg => ImageFormat::Jpeg,
        image::ImageFormat::Gif => ImageFormat::Gif,
        image::ImageFormat::WebP => ImageFormat::Webp,
        image::ImageFormat::Bmp => ImageFormat::Bmp,
        image::ImageFormat::Tiff => ImageFormat::Tiff,
        _ => return None,
    };
    Some((format, bytes))
}

pub fn user_image(source: &Value) -> Option<Arc<Image>> {
    let (format, bytes) = image_bytes(source)?;
    Some(Arc::new(Image::from_bytes(format, bytes)))
}

/// Codex history carries data URLs alongside the message's content blocks.
pub fn replay_attachments(event: &Value) -> Vec<Arc<Image>> {
    event.get("attachments").and_then(Value::as_array).into_iter().flatten().filter_map(|attachment| {
        let data = data_url_payload(attachment.get("dataUrl")?.as_str()?)?;
        user_image(&json!({ "data": data }))
    }).collect()
}

fn data_url_payload(url: &str) -> Option<&str> {
    let (media, data) = url.strip_prefix("data:image/")?.split_once(";base64,")?;
    (!media.is_empty()).then_some(data)
}

pub fn sent_images(images: &[Value]) -> Vec<Arc<Image>> {
    images.iter().filter_map(user_image).collect()
}

#[cfg(test)]
mod tests {
    use super::{data_url_payload, image_bytes, replay_attachments};
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use gpui_kit::ImageFormat;
    use serde_json::json;

    #[test]
    fn reads_sent_and_replayed_images_by_their_bytes() {
        let data = STANDARD.encode(b"\x89PNG\r\n\x1a\n");
        for source in [json!({"mediaType": "image/png", "data": data}), json!({"type": "base64", "media_type": "image/png", "data": data})] {
            let (format, bytes) = image_bytes(&source).unwrap();
            assert_eq!(format, ImageFormat::Png);
            assert_eq!(bytes, b"\x89PNG\r\n\x1a\n");
        }
    }

    #[test]
    fn codex_data_urls_are_read_without_fetching_external_images() {
        assert_eq!(data_url_payload("data:image/png;base64,aGVsbG8="), Some("aGVsbG8="));
        assert!(data_url_payload("https://example.com/image.png").is_none());
        assert!(data_url_payload("data:text/plain;base64,aGVsbG8=").is_none());
        assert!(data_url_payload("data:image/png,raw").is_none());
        let images = replay_attachments(&json!({"attachments": [{"dataUrl": "data:image/png;base64,iVBORw0KGgo="}]}));
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].bytes, b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn skips_missing_truncated_and_unsupported_sources() {
        for source in [json!({}), json!({"data": ""}), json!({"data": "aGVsbG8="}), json!({"type": "url", "data": "aGVsbG8="}), json!({"data": "iVBORw0KGgo=[truncated 20 chars]"})] {
            assert!(image_bytes(&source).is_none());
        }
    }
}
