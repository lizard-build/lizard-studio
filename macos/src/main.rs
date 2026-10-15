//! Lizard Studio for macOS: Claude Code and ChatGPT chats in a native GPUI
//! window, driven by the same local host as the Chrome extension.

mod app;
mod chat;
mod cloud;
mod host;
mod store;
mod theme;
mod ui;

use gpui_kit::component::input::{Copy, Cut, Paste, Redo, SelectAll, Undo};
use gpui_kit::*;

use crate::app::StudioApp;

actions!(lizard_studio, [NewChat, StopTurn, Quit, Hide, HideOthers, ShowAll, Minimize, Zoom]);

fn main() {
    gpui_kit::application().with_assets(theme::Assets).run(|cx: &mut App| {
        gpui_kit::init(cx);
        theme::install_fonts(cx);
        theme::install(cx);

        cx.bind_keys([
            KeyBinding::new("cmd-n", NewChat, None),
            KeyBinding::new("cmd-.", StopTurn, None),
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-h", Hide, None),
            KeyBinding::new("alt-cmd-h", HideOthers, None),
            KeyBinding::new("cmd-m", Minimize, None),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.on_action(|_: &Hide, cx| cx.hide());
        cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
        cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
        cx.on_action(|_: &Minimize, cx| {
            if let Some(window) = cx.active_window() {
                let _ = window.update(cx, |_, window, _| window.minimize_window());
            }
        });
        cx.on_action(|_: &Zoom, cx| {
            if let Some(window) = cx.active_window() {
                let _ = window.update(cx, |_, window, _| window.zoom_window());
            }
        });
        cx.set_menus(vec![
            Menu {
                name: "Lizard Studio".into(),
                items: vec![
                    MenuItem::action("Hide Lizard Studio", Hide),
                    MenuItem::action("Hide others", HideOthers),
                    MenuItem::action("Show all", ShowAll),
                    MenuItem::separator(),
                    MenuItem::action("Quit Lizard Studio", Quit),
                ],
                disabled: false,
            },
            Menu {
                name: "File".into(),
                items: vec![MenuItem::action("New chat", NewChat), MenuItem::action("Stop", StopTurn)],
                disabled: false,
            },
            Menu {
                name: "Edit".into(),
                items: vec![
                    MenuItem::action("Undo", Undo),
                    MenuItem::action("Redo", Redo),
                    MenuItem::separator(),
                    MenuItem::action("Cut", Cut),
                    MenuItem::action("Copy", Copy),
                    MenuItem::action("Paste", Paste),
                    MenuItem::action("Select all", SelectAll),
                ],
                disabled: false,
            },
            Menu {
                name: "Window".into(),
                items: vec![MenuItem::action("Minimize", Minimize), MenuItem::action("Zoom", Zoom)],
                disabled: false,
            },
        ]);

        // LIZARD_STUDIO_SIZE=<w>x<h> sets the first window's size.
        let (width, height) = std::env::var("LIZARD_STUDIO_SIZE")
            .ok()
            .and_then(|v| {
                let (w, h) = v.split_once('x')?;
                Some((w.parse::<f32>().ok()?, h.parse::<f32>().ok()?))
            })
            .unwrap_or((1180., 820.));
        let bounds = Bounds::centered(None, size(px(width), px(height)), cx);
        let options = WindowOptions {
            titlebar: Some(TitlebarOptions {
                title: Some("Lizard Studio".into()),
                appears_transparent: true,
                traffic_light_position: Some(point(px(12.), px(8.))),
            }),
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(760.), px(520.))),
            app_owns_titlebar_drag: true,
            ..Default::default()
        };
        // A snapshot run must never take the user's focus or keystrokes.
        let headless = std::env::var_os("LIZARD_STUDIO_SHOT").is_some();
        let options = WindowOptions { focus: !headless, show: !headless, ..options };
        let (_window, _) =
            gpui_kit::open_window(options, cx, |window, cx| cx.new(|cx| StudioApp::new(window, cx)))
                .expect("open the Lizard Studio window");
        #[cfg(feature = "snapshot")]
        snapshot(_window, cx);
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        if !headless {
            cx.activate(true);
        }
    });
}

/// Save what the window draws to `LIZARD_STUDIO_SHOT` after a delay, then
/// quit if `LIZARD_STUDIO_SHOT_QUIT` is set. `LIZARD_STUDIO_SHOT_AT`
/// takes several delays (ms, comma-separated) and numbers the files.
#[cfg(feature = "snapshot")]
fn snapshot(window: AnyWindowHandle, cx: &mut App) {
    let Ok(path) = std::env::var("LIZARD_STUDIO_SHOT") else { return };
    let delays: Vec<u64> = std::env::var("LIZARD_STUDIO_SHOT_AT")
        .or_else(|_| std::env::var("LIZARD_STUDIO_SHOT_DELAY"))
        .unwrap_or_else(|_| "3000".into())
        .split(',')
        .filter_map(|v| v.trim().parse().ok())
        .collect();
    let numbered = delays.len() > 1;
    let quit = std::env::var_os("LIZARD_STUDIO_SHOT_QUIT").is_some();
    cx.spawn(async move |cx| {
        let mut waited = 0;
        for (n, at) in delays.into_iter().enumerate() {
            cx.background_executor().timer(std::time::Duration::from_millis(at.saturating_sub(waited))).await;
            waited = at;
            let file = if numbered { path.replace(".png", &format!("-{}.png", n + 1)) } else { path.clone() };
            // A hidden window gets no frames from the display link; draw one now.
            let result = cx.update_window(window, |_, window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
                window.render_to_image()
            });
            match result {
                Ok(Ok(image)) => match image.save(&file) {
                    Ok(()) => eprintln!("snapshot saved to {file}"),
                    Err(err) => eprintln!("snapshot save failed: {err}"),
                },
                Ok(Err(err)) => eprintln!("snapshot render failed: {err}"),
                Err(err) => eprintln!("snapshot window gone: {err}"),
            }
        }
        if quit {
            cx.update(|cx| cx.quit());
        }
    })
    .detach();
}
