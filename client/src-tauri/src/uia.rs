//! Windows UI Automation for AIs that operate this computer (docs/design.md
//! §9, 操作电脑): read a window's controls by name instead of looking at
//! pixels, and press / fill them without moving the mouse. Controls are
//! numbered in tree order; acting walks the window again and checks the
//! name still matches, so a changed window never gets the wrong click.

use serde::Serialize;

pub type R<T> = Result<T, String>;

#[derive(Serialize)]
pub struct Window {
    handle: i64,
    title: String,
    class: String,
    pid: u32,
}

#[derive(Serialize, Clone)]
pub struct Node {
    id: usize,
    depth: usize,
    role: String,
    name: String,
    value: String,
    enabled: bool,
    /// Screen rectangle (for the mouse when a control can't be pressed directly).
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use uiautomation::patterns::{UIExpandCollapsePattern, UIInvokePattern, UISelectionItemPattern, UITogglePattern, UIValuePattern};
    use uiautomation::types::{ControlType, Handle};
    use uiautomation::{UIAutomation, UIElement, UITreeWalker};

    const MAX_NODES: usize = 400;
    const MAX_DEPTH: usize = 18;

    fn err(e: uiautomation::Error) -> String {
        format!("界面自动化出错：{e}")
    }

    fn ua() -> R<UIAutomation> {
        UIAutomation::new().map_err(err)
    }

    fn children(w: &UITreeWalker, el: &UIElement) -> Vec<UIElement> {
        let mut out = Vec::new();
        let mut next = w.get_first_child(el).ok();
        while let Some(c) = next {
            next = w.get_next_sibling(&c).ok();
            out.push(c);
            if out.len() > 2000 {
                break;
            }
        }
        out
    }

    pub fn windows() -> R<Vec<Window>> {
        let a = ua()?;
        let w = a.get_control_view_walker().map_err(err)?;
        let root = a.get_root_element().map_err(err)?;
        Ok(children(&w, &root)
            .into_iter()
            .filter_map(|el| {
                let title = el.get_name().unwrap_or_default();
                if title.trim().is_empty() {
                    return None;
                }
                let h: isize = el.get_native_window_handle().ok()?.into();
                Some(Window { handle: h as i64, title, class: el.get_classname().unwrap_or_default(), pid: el.get_process_id().unwrap_or(0) })
            })
            .collect())
    }

    fn interesting(role: ControlType) -> bool {
        use ControlType::*;
        matches!(role, Button | Edit | CheckBox | ComboBox | ListItem | MenuItem | TabItem | Hyperlink | RadioButton | TreeItem | Document | Slider | SplitButton | MenuBar | Text | DataItem)
    }

    /// Visits the window's controls in tree order; `f` gets each one with its number.
    fn walk(handle: i64, mut f: impl FnMut(usize, usize, &UIElement) -> bool) -> R<()> {
        let a = ua()?;
        let w = a.get_control_view_walker().map_err(err)?;
        let top = a.element_from_handle(Handle::from(handle as isize)).map_err(|_| "找不到这个窗口（可能已经关了），先重新列一下窗口".to_string())?;
        let mut stack = vec![(top, 0usize)];
        let mut n = 0usize;
        while let Some((el, depth)) = stack.pop() {
            if n >= MAX_NODES * 4 {
                break;
            }
            if !f(n, depth, &el) {
                return Ok(());
            }
            n += 1;
            if depth < MAX_DEPTH {
                let mut kids = children(&w, &el);
                kids.reverse();
                stack.extend(kids.into_iter().map(|k| (k, depth + 1)));
            }
        }
        Ok(())
    }

    fn node(id: usize, depth: usize, el: &UIElement) -> Option<Node> {
        let role = el.get_control_type().ok()?;
        let name = el.get_name().unwrap_or_default();
        let value = el.get_pattern::<UIValuePattern>().and_then(|p| p.get_value()).unwrap_or_default();
        if el.is_offscreen().unwrap_or(false) || (name.trim().is_empty() && value.is_empty() && !interesting(role)) {
            return None;
        }
        let r = el.get_bounding_rectangle().ok()?;
        Some(Node {
            id, depth, role: format!("{role:?}"), name, value: value.chars().take(200).collect(),
            enabled: el.is_enabled().unwrap_or(true),
            x: r.get_left(), y: r.get_top(), w: r.get_width(), h: r.get_height(),
        })
    }

    pub fn tree(handle: i64) -> R<Vec<Node>> {
        let mut out = Vec::new();
        walk(handle, |id, depth, el| {
            if let Some(n) = node(id, depth, el) {
                out.push(n);
            }
            out.len() < MAX_NODES
        })?;
        Ok(out)
    }

    pub fn act(handle: i64, id: usize, expect: &str, action: &str, text: Option<&str>) -> R<String> {
        let mut found: Option<UIElement> = None;
        walk(handle, |n, _, el| {
            if n == id {
                found = Some(el.clone());
                return false;
            }
            true
        })?;
        let el = found.ok_or("没有这个编号的控件，界面可能变了，先重新看一下")?;
        let name = el.get_name().unwrap_or_default();
        if !expect.is_empty() && name != expect {
            return Err(format!("{id} 号控件现在叫「{name}」不是「{expect}」，界面变了，先重新看一下"));
        }
        match action {
            "press" => {
                if let Ok(p) = el.get_pattern::<UIInvokePattern>() {
                    p.invoke().map_err(err)?;
                    return Ok("按下了".into());
                }
                if let Ok(p) = el.get_pattern::<UITogglePattern>() {
                    p.toggle().map_err(err)?;
                    return Ok("切换了".into());
                }
                if let Ok(p) = el.get_pattern::<UISelectionItemPattern>() {
                    p.select().map_err(err)?;
                    return Ok("选中了".into());
                }
                if let Ok(p) = el.get_pattern::<UIExpandCollapsePattern>() {
                    p.expand().map_err(err)?;
                    return Ok("展开了".into());
                }
                Err("这个控件不能直接按：可以先 focus 再按空格或回车，或者截图后用鼠标点".into())
            }
            "set_text" => {
                let t = text.unwrap_or_default();
                let p = el.get_pattern::<UIValuePattern>().map_err(|_| "这个控件不能直接填字，先 focus 再用键盘打字".to_string())?;
                p.set_value(t).map_err(err)?;
                Ok("填好了".into())
            }
            "focus" => {
                el.set_focus().map_err(err)?;
                Ok("已切到这个控件".into())
            }
            other => Err(format!("不认识的动作：{other}")),
        }
    }

    /// Brings a window to the front.
    pub fn activate(handle: i64) -> R<()> {
        let a = ua()?;
        a.element_from_handle(Handle::from(handle as isize)).map_err(err)?.set_focus().map_err(err)
    }
}

#[cfg(windows)]
pub use imp::{act, activate, tree, windows};

#[cfg(not(windows))]
mod stub {
    use super::*;
    const NO: &str = "界面自动化只在 Windows 版可用";
    pub fn windows() -> R<Vec<Window>> {
        Err(NO.into())
    }
    pub fn tree(_h: i64) -> R<Vec<Node>> {
        Err(NO.into())
    }
    pub fn act(_h: i64, _id: usize, _expect: &str, _action: &str, _text: Option<&str>) -> R<String> {
        Err(NO.into())
    }
    pub fn activate(_h: i64) -> R<()> {
        Err(NO.into())
    }
}

#[cfg(not(windows))]
pub use stub::{act, activate, tree, windows};
