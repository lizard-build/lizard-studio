//! The Lizard dark palette (DESIGN.md) as a GPUI Component theme, plus the
//! few colors the app paints by hand.

use std::borrow::Cow;

use anyhow::Result;
use gpui_kit::component::{Theme, ThemeMode, ThemeRegistry};
use gpui_kit::*;

pub const BG_PRIMARY: u32 = 0x070707;
pub const BG_SECONDARY: u32 = 0x141414;
pub const BORDER: u32 = 0x2e2e2e;
pub const TEXT_PRIMARY: u32 = 0xe9edf4;
pub const TEXT_SECONDARY: u32 = 0x858b94;
pub const TEXT_TERTIARY: u32 = 0x5f646d;
pub const EMERALD: u32 = 0x10b981;
pub const RED: u32 = 0xef4444;
pub const RED_SOFT: u32 = 0xf87171;
pub const YELLOW: u32 = 0xf59e0b;
pub const BG_CARD: u32 = 0x1c1c1c;
pub const BLUE: u32 = 0x3b82f6;
pub const WARN_BRIGHT: u32 = 0xffd014;
pub const WARN_SOFT: u32 = 0xfbbf24;
pub const EMPTY_MARK: u32 = 0x404040;
pub const CLAUDE_CLAY: u32 = 0xd97757;

/// White at an alpha, the panel's `rgba(255,255,255,a)`.
pub fn white_a(alpha: f32) -> Hsla {
    hsla(0., 0., 1., alpha)
}

pub fn hex(rgb: u32) -> Hsla {
    gpui_kit::rgb(rgb).into()
}

pub fn rgba_hex(rgb: u32, alpha: f32) -> Hsla {
    let mut c: Hsla = gpui_kit::rgb(rgb).into();
    c.a = alpha;
    c
}

const THEME_JSON: &str = r##"{
  "name": "Lizard",
  "author": "Dragon Labs",
  "themes": [
    {
      "name": "Lizard Dark",
      "mode": "dark",
      "font.size": 14,
      "font.family": "Lizard Inter",
      "mono_font.family": "Lizard Mono",
      "mono_font.size": 12,
      "radius": 8,
      "radius.lg": 12,
      "shadow": false,
      "colors": {
        "background": "#070707",
        "foreground": "#e9edf4",
        "border": "#2e2e2e",
        "input.border": "#2e2e2e",
        "ring": "#10b981",
        "caret": "#10b981",
        "selection.background": "#10b98155",
        "accent.background": "#1b1b1b",
        "accent.foreground": "#e9edf4",
        "muted.background": "#141414",
        "muted.foreground": "#858b94",
        "primary.background": "#10b981",
        "primary.hover.background": "#059669",
        "primary.active.background": "#047857",
        "primary.foreground": "#ffffff",
        "secondary.background": "#1c1c1c",
        "secondary.hover.background": "#2e2e2e",
        "secondary.active.background": "#3b3b3b",
        "secondary.foreground": "#e9edf4",
        "danger.background": "#ef4444",
        "danger.foreground": "#ffffff",
        "warning.background": "#f59e0b",
        "warning.foreground": "#ffffff",
        "success.background": "#10b981",
        "success.foreground": "#ffffff",
        "info.background": "#3b82f6",
        "info.foreground": "#ffffff",
        "link.foreground": "#34d399",
        "link.hover.foreground": "#6ee7b7",
        "link.active.foreground": "#10b981",
        "popover.background": "#141414",
        "popover.foreground": "#e9edf4",
        "list.background": "#070707",
        "list.hover.background": "#141414",
        "list.active.background": "#10b9811f",
        "list.active.border": "#10b981",
        "sidebar.background": "#0c0c0c",
        "sidebar.foreground": "#e9edf4",
        "sidebar.border": "#1c1c1c",
        "sidebar.accent.background": "#181818",
        "sidebar.accent.foreground": "#e9edf4",
        "sidebar.primary.background": "#10b981",
        "sidebar.primary.foreground": "#ffffff",
        "scrollbar.background": "#00000000",
        "scrollbar.thumb.background": "#3b3b3be6",
        "scrollbar.thumb.hover.background": "#4b4b4b",
        "title_bar.background": "#0c0c0c",
        "title_bar.border": "#1c1c1c",
        "tab_bar.background": "#141414",
        "table.background": "#0e0e0e",
        "skeleton.background": "#141414",
        "switch.background": "#2e2e2e",
        "overlay": "#00000066",
        "window.border": "#1c1c1c"
      }
    }
  ]
}"##;

/// The panel's own fonts: Inter for text, JetBrains Mono for code.
pub fn install_fonts(cx: &mut App) {
    let fonts: Vec<Cow<'static, [u8]>> = vec![
        Cow::Borrowed(include_bytes!("../assets/fonts/Inter-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Inter-Medium.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Inter-SemiBold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Inter-Bold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-Regular.ttf")),
    ];
    if let Err(err) = cx.text_system().add_fonts(fonts) {
        eprintln!("fonts failed to load: {err}");
    }
}

/// Markdown as the panel draws it (panel.css `.md`, render.js).
pub fn install_text_style(cx: &mut App) {
    use gpui_kit::base::{TextViewDefaults, TextViewStyle};
    let code_block = StyleRefinement::default()
        .bg(white_a(0.05))
        .rounded(px(8.))
        .px(px(12.))
        .py(px(10.))
        .text_size(px(12.))
        .font_family("Lizard Mono");
    let style = TextViewStyle::default()
        .with_foreground(hex(TEXT_PRIMARY))
        // List markers use this colour; the panel draws them in the text colour.
        .with_muted_foreground(hex(TEXT_PRIMARY))
        .with_link(hex(BLUE))
        .with_selection(rgba_hex(BLUE, 0.35))
        .with_code_background(white_a(0.06))
        .with_border(hex(BORDER))
        .with_paragraph_gap(rems(0.5))
        .with_heading(|_| StyleRefinement::default().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD))
        .with_code_block(code_block)
        .with_inline_code(HighlightStyle { background_color: Some(white_a(0.06)), ..Default::default() })
        .with_dark(true);
    TextViewDefaults::new().with_style(style).with_inherit_text_color(true).install(cx);
}

pub fn install(cx: &mut App) {
    if let Err(err) = ThemeRegistry::global_mut(cx).load_themes_from_str(THEME_JSON) {
        eprintln!("lizard theme failed to load: {err}");
    }
    if let Some(config) = ThemeRegistry::global(cx).themes().get("Lizard Dark").cloned() {
        Theme::global_mut(cx).dark_theme = config;
    }
    Theme::change(ThemeMode::Dark, None, cx);
    install_text_style(cx);
}

/// The component icon set, plus the panel's own icons.
pub struct Assets;

macro_rules! panel_icons {
    ($($name:literal),* $(,)?) => {
        fn panel_icon(path: &str) -> Option<&'static [u8]> {
            match path {
                $(concat!("ph/", $name, ".svg") => Some(include_bytes!(concat!("../assets/ph/", $name, ".svg"))),)*
                _ => None,
            }
        }
        const PANEL_ICONS: &[&str] = &[$(concat!("ph/", $name, ".svg")),*];
    };
}

// The panel's own icons (src/panel/icons.js), exported as files.
panel_icons!("asterisk", "bookmark", "bookmark-fill", "brain", "caret-down", "caret-left", "chat", "chats", "check", "claude", "codex", "copy", "cursor", "edit", "file", "file-plus", "folder", "gauge", "gear", "git-branch", "globe", "history", "list", "lizard", "plus", "robot", "search", "selection", "send", "server", "side-panel", "sparkle", "stack", "stop", "terminal", "todo", "trash", "warning", "window-open", "x");

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some(bytes) = panel_icon(path) {
            return Ok(Some(Cow::Borrowed(bytes)));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut list = gpui_kit::assets::Assets.list(path)?;
        list.extend(PANEL_ICONS.iter().filter(|p| p.starts_with(path)).map(|p| SharedString::from(*p)));
        Ok(list)
    }
}
