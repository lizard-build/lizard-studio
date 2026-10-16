//! The git badge opens the panel's sheet above the composer. Host diffs include
//! staged, unstaged and untracked files, and the same base as the panel's totals.

mod parse;

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Value, json};

use super::StudioApp;
use crate::store::Agent;
use crate::theme::*;
use crate::ui::{caret, ph};
use parse::{Kind, Row, context_end, parse_rows};

struct File {
    path: String,
    added: u64,
    removed: u64,
    binary: bool,
    rows: Vec<Row>,
}

struct Snapshot {
    is_repo: bool,
    added: u64,
    removed: u64,
    files: Vec<File>,
}

impl Snapshot {
    fn from_message(msg: &Value) -> Self {
        let files = msg.get("files").and_then(Value::as_array).into_iter().flatten().map(|f| File {
            path: f.get("path").and_then(Value::as_str).unwrap_or("").into(),
            added: f.get("insertions").and_then(Value::as_u64).unwrap_or(0),
            removed: f.get("deletions").and_then(Value::as_u64).unwrap_or(0),
            binary: f.get("binary").and_then(Value::as_bool).unwrap_or(false),
            rows: if f.get("binary").and_then(Value::as_bool) == Some(true) { Vec::new() }
                else { parse_rows(f.get("diff").and_then(Value::as_str).unwrap_or("")) },
        }).collect();
        Self {
            is_repo: msg.get("isRepo").and_then(Value::as_bool).unwrap_or(false),
            added: msg.get("insertions").and_then(Value::as_u64).unwrap_or(0),
            removed: msg.get("deletions").and_then(Value::as_u64).unwrap_or(0),
            files,
        }
    }

    fn visible_rows(&self, collapsed: &HashSet<String>, expanded: &HashSet<(String, usize)>) -> Vec<VisibleRow> {
        let mut visible = Vec::new();
        for (f, file) in self.files.iter().enumerate() {
            visible.push(VisibleRow::File(f));
            if collapsed.contains(&file.path) { continue; }
            if file.binary || file.rows.is_empty() { visible.push(VisibleRow::Note(f)); continue; }
            let mut i = 0;
            while i < file.rows.len() {
                if file.rows[i].kind == Kind::Context {
                    let end = context_end(&file.rows, i);
                    if end - i >= 3 {
                        visible.push(VisibleRow::Context(f, i, end - i));
                        if !expanded.contains(&(file.path.clone(), i)) { i = end; continue; }
                    }
                    visible.extend((i..end).map(|r| VisibleRow::Line(f, r)));
                    i = end;
                } else {
                    visible.push(VisibleRow::Line(f, i));
                    i += 1;
                }
            }
        }
        visible
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum VisibleRow {
    File(usize),
    Note(usize),
    Line(usize, usize),
    Context(usize, usize, usize),
}

impl VisibleRow {
    fn file(self) -> usize {
        match self { Self::File(f) | Self::Note(f) | Self::Line(f, _) | Self::Context(f, _, _) => f }
    }
}

pub(super) struct Drawer {
    cwd: String,
    open: bool,
    closing: bool,
    motion: u64,
    request: u64,
    fetching: bool,
    refresh_again: bool,
    error: Option<String>,
    snapshot: Option<Arc<Snapshot>>,
    collapsed: HashSet<String>,
    expanded: HashSet<(String, usize)>,
    rows: Rc<Vec<VisibleRow>>,
    list: ListState,
}

impl Drawer {
    fn new(cwd: String) -> Self {
        Self {
            cwd, open: false, closing: false, motion: 0, request: 0,
            fetching: false, refresh_again: false, error: None, snapshot: None,
            collapsed: HashSet::new(), expanded: HashSet::new(), rows: Rc::new(Vec::new()),
            list: ListState::new(0, ListAlignment::Top, px(400.)),
        }
    }

    fn rebuild(&mut self) {
        let visible = self.snapshot.as_ref().map(|s| s.visible_rows(&self.collapsed, &self.expanded)).unwrap_or_default();
        // Keep the same first visible control when a fold changes rows below it.
        let top = self.list.logical_scroll_top();
        let anchor = self.rows.get(top.item_ix).copied();
        self.list.reset(visible.len());
        if let Some(anchor) = anchor {
            let ix = visible.iter().position(|r| match (*r, anchor) {
                (VisibleRow::File(a), VisibleRow::File(b)) => a == b,
                (VisibleRow::Line(a, b), VisibleRow::Line(c, d)) => a == c && b == d,
                (VisibleRow::Context(a, b, _), VisibleRow::Context(c, d, _)) => a == c && b == d,
                _ => false,
            });
            if let Some(item_ix) = ix {
                self.list.scroll_to(ListOffset { item_ix, ..top });
            } else if let Some(item_ix) = visible.iter().position(|r| *r == VisibleRow::File(anchor.file())) {
                self.list.scroll_to(ListOffset { item_ix, offset_in_item: px(0.) });
            }
        }
        self.rows = Rc::new(visible);
    }
}

pub(super) type Drawers = HashMap<String, Drawer>;

impl StudioApp {
    pub(super) fn diff_open(&self, cx: &App) -> bool {
        self.diffs.get(self.chats[self.active].read(cx).id()).is_some_and(|d| d.open)
    }

    pub(super) fn diff_visible(&self, cx: &App) -> bool {
        self.diffs.get(self.chats[self.active].read(cx).id()).is_some_and(|d| d.open || d.closing)
    }

    pub(super) fn toggle_diff(&mut self, cx: &mut Context<Self>) {
        if self.diff_open(cx) { self.close_diff(cx); return; }
        if self.tasks_open(cx) { self.close_tasks(); }
        let chat = self.chats[self.active].read(cx);
        let Some(cwd) = chat.work_cwd() else { return };
        let (id, agent) = (chat.id().to_string(), chat.meta.agent);
        self.menu = None;
        let drawer = self.diffs.entry(id.clone()).or_insert_with(|| Drawer::new(cwd.clone()));
        drawer.open = true;
        drawer.closing = false;
        drawer.motion += 1;
        let app = cx.entity().downgrade();
        drawer.list.set_scroll_handler(move |_, _, cx| {
            let _ = app.update(cx, |_, cx| cx.notify());
        });
        self.request_diff(id, cwd, agent, cx);
        cx.notify();
    }

    pub(super) fn close_diff(&mut self, cx: &mut Context<Self>) {
        let id = self.chats[self.active].read(cx).id().to_string();
        let Some(drawer) = self.diffs.get_mut(&id) else { return };
        if !drawer.open { return; }
        drawer.open = false;
        drawer.closing = true;
        drawer.motion += 1;
        let motion = drawer.motion;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(160)).await;
            let _ = this.update(cx, |this, cx| {
                if let Some(d) = this.diffs.get_mut(&id).filter(|d| d.motion == motion) {
                    d.closing = false;
                    cx.notify();
                }
            });
        }).detach();
        cx.notify();
    }

    /// Called beside the existing local git refresh, including after TurnEnded.
    pub(super) fn refresh_diff_drawers(&mut self, cwd: &str, cx: &mut Context<Self>) {
        let live: HashSet<_> = self.chats.iter().map(|chat| chat.read(cx).id().to_string()).collect();
        self.diffs.retain(|id, _| live.contains(id));
        let chats: Vec<_> = self.chats.iter().filter_map(|chat| {
            let c = chat.read(cx);
            (c.work_cwd().as_deref() == Some(cwd) && self.diffs.contains_key(c.id()))
                .then(|| (c.id().to_string(), c.meta.agent))
        }).collect();
        for (id, agent) in chats { self.request_diff(id, cwd.into(), agent, cx); }
    }

    fn request_diff(&mut self, id: String, cwd: String, agent: Agent, cx: &mut Context<Self>) {
        let Some(d) = self.diffs.get_mut(&id) else { return };
        if d.cwd != cwd {
            d.cwd = cwd.clone();
            d.snapshot = None;
            d.collapsed.clear();
            d.expanded.clear();
            d.fetching = false;
            d.rebuild();
        }
        if d.fetching { d.refresh_again = true; return; }
        d.error = None;
        if !self.host.is_connected() {
            d.error = Some("Local helper is disconnected".into());
            return;
        }
        d.fetching = true;
        d.refresh_again = false;
        d.request += 1;
        let request = d.request;
        self.host.send(json!({ "type": "gitDiff", "id": id, "agent": agent.wire(), "cwd": cwd }));
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(30)).await;
            let _ = this.update(cx, |this, cx| {
                if let Some(d) = this.diffs.get_mut(&id).filter(|d| d.request == request && d.fetching) {
                    d.fetching = false;
                    d.error = Some("Couldn’t load changes. Close and reopen to try again.".into());
                    cx.notify();
                }
            });
        }).detach();
    }

    pub(super) fn on_git_diff(&mut self, msg: &Value, cx: &mut Context<Self>) {
        let Some(id) = msg.get("id").and_then(Value::as_str).map(str::to_string) else { return };
        let Some(d) = self.diffs.get(&id).filter(|d| d.fetching) else { return };
        let cwd = d.cwd.clone();
        if msg.get("cwd").and_then(Value::as_str) != Some(cwd.as_str()) { return; }
        let Some(chat) = self.chat_by_id(&id, cx) else { return };
        if chat.read(cx).work_cwd().as_deref() != Some(cwd.as_str()) { return; }
        let request = d.request;
        let msg = msg.clone();
        // Parsing and the bounded LCS must not stall the drawer's first paint.
        let task = cx.background_executor().spawn(async move { Snapshot::from_message(&msg) });
        cx.spawn(async move |this, cx| {
            let snapshot = task.await;
            let _ = this.update(cx, |this, cx| {
                let Some(d) = this.diffs.get_mut(&id).filter(|d| d.request == request && d.cwd == cwd && d.fetching) else { return };
                d.fetching = false;
                d.error = None;
                d.snapshot = Some(Arc::new(snapshot));
                d.expanded.clear();
                d.rebuild();
                let again = d.refresh_again;
                if again {
                    if let Some(chat) = this.chat_by_id(&id, cx) {
                        let agent = chat.read(cx).meta.agent;
                        this.request_diff(id, cwd, agent, cx);
                    }
                }
                cx.notify();
            });
        }).detach();
    }

    fn fold_diff(&mut self, id: &str, path: &str, context: Option<usize>, cx: &mut Context<Self>) {
        let Some(d) = self.diffs.get_mut(id) else { return };
        if let Some(start) = context {
            let key = (path.to_string(), start);
            if !d.expanded.remove(&key) { d.expanded.insert(key); }
        } else if !d.collapsed.remove(path) {
            d.collapsed.insert(path.to_string());
        }
        d.rebuild();
        cx.notify();
    }

    pub(super) fn render_diff_drawer(&self, cx: &Context<Self>) -> Option<AnyElement> {
        let id = self.chats[self.active].read(cx).id().to_string();
        let d = self.diffs.get(&id).filter(|d| d.open || d.closing)?;
        let (added, removed) = d.snapshot.as_ref().map(|s| (s.added, s.removed)).unwrap_or_default();
        let note = if let Some(error) = &d.error { Some(error.clone()) }
            else if d.fetching && d.snapshot.is_none() { Some("Loading changes…".into()) }
            else if d.snapshot.as_ref().is_some_and(|s| !s.is_repo) { Some("Not a git repository".into()) }
            else if d.rows.is_empty() { Some("No uncommitted changes".into()) }
            else { None };
        let app = cx.entity().downgrade();
        let files = d.snapshot.clone();
        let rows = d.rows.clone();
        let collapsed = d.collapsed.clone();
        let expanded = d.expanded.clone();
        let list_id: SharedString = format!("diff-list-{id}").into();
        // Like .diff-file-head's sticky positioning, keep the current path in
        // view until the next file pushes it out of the way.
        let sticky = d.snapshot.as_ref().and_then(|snapshot| {
            let top = d.list.logical_scroll_top();
            let f = d.rows.get(top.item_ix)?.file();
            let file = snapshot.files.get(f)?;
            let next = d.rows.partition_point(|row| row.file() <= f);
            let push = d.list.bounds_for_item(next).map(|b| {
                (b.top() - d.list.viewport_bounds().top() - px(40.8)).min(px(0.))
            }).unwrap_or(px(0.));
            let (app, id, path) = (app.clone(), id.clone(), file.path.clone());
            let scroll = d.list.clone();
            Some(div().id("diff-sticky-head").absolute().top(push).left_0().right_0()
                .on_scroll_wheel(cx.listener(move |_, event: &ScrollWheelEvent, _, cx| {
                    scroll.scroll_by(-event.delta.pixel_delta(px(20.)).y);
                    cx.notify();
                    cx.stop_propagation();
                })).child(file_head(
                ("diff-sticky-file", f), file, d.collapsed.contains(&file.path),
                move |_, _, cx| { let _ = app.update(cx, |this, cx| this.fold_diff(&id, &path, None, cx)); },
            )))
        });
        let body = div().id(list_id).flex_1().min_h_0().relative().overflow_hidden()
            .child(list(d.list.clone(), move |ix, _, _| {
                let Some(snapshot) = &files else { return div().into_any_element() };
                let Some(row) = rows.get(ix).copied() else { return div().into_any_element() };
                let app = app.clone();
                let id = id.clone();
                let f = row.file();
                let file = &snapshot.files[f];
                let path = file.path.clone();
                match row {
                    VisibleRow::File(_) => file_head(("diff-file", f), file, collapsed.contains(&file.path),
                        move |_, _, cx| { let _ = app.update(cx, |this, cx| this.fold_diff(&id, &path, None, cx)); }),
                    VisibleRow::Note(_) => div().pl(px(56.)).pr(px(16.)).pt(px(10.)).pb(px(12.))
                        .text_size(px(12.)).text_color(hex(TEXT_TERTIARY))
                        .child(if file.binary { "Binary file not shown" } else { "No content changes" }).into_any_element(),
                    VisibleRow::Line(_, r) => div()
                        .when(r == 0, |d| d.pt(px(2.)))
                        .when(r + 1 == file.rows.len(), |d| d.pb(px(10.)))
                        .child(render_line(&file.rows[r])).into_any_element(),
                    VisibleRow::Context(_, start, count) => {
                        let open = expanded.contains(&(file.path.clone(), start));
                        div().id(("diff-context", ix)).flex().items_center().gap(px(9.)).px(px(16.)).py(px(9.))
                            .when(start == 0, |d| d.mt(px(2.)))
                            .when(start + count == file.rows.len() && !open, |d| d.mb(px(10.)))
                            .text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(hex(TEXT_SECONDARY))
                            .cursor_pointer().hover(|s| s.text_color(hex(TEXT_PRIMARY)))
                            .on_click(move |_, _, cx| { let _ = app.update(cx, |this, cx| this.fold_diff(&id, &path, Some(start), cx)); })
                            .child(ph("caret-down", 12., hex(TEXT_TERTIARY)).when(!open, |s| s.with_transformation(Transformation::rotate(radians(std::f32::consts::PI)))))
                            .child(format!("{count} unchanged lines")).into_any_element()
                    }
                }
            }).size_full())
            .children(sticky)
            .vertical_scrollbar(&d.list)
            .when_some(note, |el, note| el.child(div().absolute().top_0().left_0().right_0().px(px(16.)).py(px(12.))
                .bg(hex(BG_SECONDARY)).text_size(px(12.)).text_color(hex(TEXT_TERTIARY)).child(note)));
        let sheet = div().id("git-diff-sheet").occlude().relative().size_full().flex().flex_col().rounded_tl(px(14.)).rounded_tr(px(14.))
            .overflow_hidden().bg(hex(BG_SECONDARY))
            .child(div().id("diff-drawer-head").flex_none().flex().items_center().gap(px(12.))
                .pl(px(16.)).pr(px(6.)).pt(px(4.)).pb(px(2.)).cursor_pointer()
                .hover(|s| s.bg(white_a(0.05)))
                .on_click(cx.listener(|this, _, _, cx| this.close_diff(cx)))
                .child(div().flex_1().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).text_color(hex(TEXT_SECONDARY)).child("Diffs"))
                .child(totals(added, removed))
                .child(div().size(px(28.)).flex().items_center().justify_center().child(ph("caret-down", 14., hex(TEXT_TERTIARY)))))
            .child(body);
        let closing = d.closing;
        Some(div().absolute().left(px(12.)).right(px(12.)).top(px(8.)).bottom_0().overflow_hidden()
            .child(sheet.with_animation(
                SharedString::from(format!("diff-motion-{}-{}", self.chats[self.active].read(cx).id(), d.motion)),
                Animation::new(Duration::from_millis(if closing { 160 } else { 200 }))
                    .with_easing(move |t| if closing { t * t } else { 1. - (1. - t).powi(3) }),
                move |el, t| { let progress = if closing { 1. - t } else { t }; el.opacity(progress).top(px(14. * (1. - progress))) },
            )).into_any_element())
    }
}

fn file_head(
    id: impl Into<ElementId>, file: &File, collapsed: bool,
    click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    div().id(id).occlude().flex().items_center().gap(px(8.)).px(px(16.)).py(px(10.))
        .line_height(px(20.8)).bg(hex(BG_SECONDARY)).cursor_pointer()
        .hover(|s| s.bg(hex(0x1e1e1e))).on_click(click)
        .child(caret(!collapsed, hex(TEXT_TERTIARY)).size(px(12.)))
        .child(div().min_w_0().truncate().text_size(px(13.)).text_color(hex(TEXT_PRIMARY)).child(file.path.clone()))
        .child(totals(file.added, file.removed)).into_any_element()
}

fn totals(added: u64, removed: u64) -> impl IntoElement {
    div().flex_none().flex().gap(px(8.)).font_family("Lizard Mono").text_size(px(12.)).font_weight(FontWeight::MEDIUM)
        .child(div().text_color(hex(EMERALD)).child(format!("+{added}")))
        .child(div().text_color(hex(RED)).child(format!("−{removed}")))
}

fn render_line(row: &Row) -> AnyElement {
    let color = match row.kind { Kind::Add => EMERALD, Kind::Delete => RED, Kind::Context => TEXT_TERTIARY };
    let changed = row.kind != Kind::Context;
    let added = row.kind == Kind::Add;
    let no = if row.kind == Kind::Delete { row.old } else { row.new };
    let text = if row.text.is_empty() { " ".into() } else { row.text.clone() };
    let highlights = row.highlights.iter().cloned().map(|range| (range, HighlightStyle {
        background_color: Some(rgba_hex(color, if row.kind == Kind::Add { 0.3 } else { 0.32 })),
        ..Default::default()
    }));
    div().relative().flex().items_start().w_full().pr(px(12.))
        .font_family("Lizard Mono").text_size(px(12.)).line_height(px(19.2))
        .when(changed, |d| d.bg(rgba_hex(color, 0.09)).child(
            canvas(move |_, _, _| {}, move |bounds, _, window, _| {
                if added {
                    window.paint_quad(fill(bounds, hex(color)));
                } else {
                    let mut y = bounds.top();
                    while y < bounds.bottom() {
                        window.paint_quad(fill(Bounds::new(point(bounds.left(), y), size(bounds.size.width, px(4.).min(bounds.bottom() - y))), hex(color)));
                        y += px(7.);
                    }
                }
            }).absolute().left_0().top_0().bottom_0().w(px(3.)),
        ))
        .child(div().flex_none().w(px(44.)).pr(px(12.)).text_right().text_color(hex(color)).child(no.map(|n| n.to_string()).unwrap_or_default()))
        .child(div().flex_1().min_w_0().text_color(hex(TEXT_PRIMARY)).child(StyledText::new(text).with_highlights(highlights)))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use serde_json::json;
    use super::{Snapshot, VisibleRow};

    #[test]
    fn uses_host_totals_and_handles_binary_and_metadata_only_files() {
        let snapshot = Snapshot::from_message(&json!({
            "isRepo": true, "insertions": 42, "deletions": 9,
            "files": [
                { "path": "new.rs", "insertions": 7, "deletions": 2, "diff": "@@ -0,0 +1 @@\n+new" },
                { "path": "image.png", "binary": true, "diff": "@@ -0,0 +1 @@\n+ignored" },
                { "path": "renamed.rs", "diff": "" }
            ]
        }));
        assert!(snapshot.is_repo);
        assert_eq!((snapshot.added, snapshot.removed), (42, 9));
        assert_eq!((snapshot.files[0].added, snapshot.files[0].removed), (7, 2));
        assert!(snapshot.files[1].rows.is_empty());
        assert_eq!(snapshot.visible_rows(&HashSet::new(), &HashSet::new()), vec![
            VisibleRow::File(0), VisibleRow::Line(0, 0),
            VisibleRow::File(1), VisibleRow::Note(1), VisibleRow::File(2), VisibleRow::Note(2),
        ]);
        let empty = Snapshot::from_message(&json!({ "isRepo": false }));
        assert!(!empty.is_repo);
        assert!(empty.files.is_empty());
    }

    #[test]
    fn folds_long_context_and_files_but_keeps_short_context_visible() {
        let snapshot = Snapshot::from_message(&json!({ "isRepo": true, "files": [{
            "path": "a.rs", "diff": "@@ -1,6 +1,6 @@\n a\n b\n c\n-old\n+new\n d\n e"
        }] }));
        let empty = HashSet::new();
        let rows = snapshot.visible_rows(&empty, &HashSet::new());
        assert_eq!(rows, vec![VisibleRow::File(0), VisibleRow::Context(0, 0, 3),
            VisibleRow::Line(0, 3), VisibleRow::Line(0, 4), VisibleRow::Line(0, 5), VisibleRow::Line(0, 6)]);
        let expanded = snapshot.visible_rows(&empty, &HashSet::from([("a.rs".into(), 0)]));
        assert_eq!(&expanded[2..5], &[VisibleRow::Line(0, 0), VisibleRow::Line(0, 1), VisibleRow::Line(0, 2)]);
        assert_eq!(snapshot.visible_rows(&HashSet::from(["a.rs".into()]), &HashSet::new()), vec![VisibleRow::File(0)]);
    }
}
