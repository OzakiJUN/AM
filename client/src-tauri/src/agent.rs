//! Tools for AI accounts that operate this computer (docs/design.md §9,
//! 操作电脑). The UI decides what the AI may do (per-AI permissions, asks
//! the owner); these functions do it. File tools stay inside the work
//! folders the owner chose (checked again here, after resolving `..` and
//! links). Commands run in PowerShell in the first work folder (a command
//! can still reach outside it: the settings say so). Mouse and keyboard wait
//! while the owner is using the computer themselves.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub type R<T> = Result<T, String>;

const MAX_LIST: usize = 500;
const MAX_OUTPUT: usize = 20_000;

/// The real path of `p`; for a path that does not exist yet, its real
/// parent plus the name.
fn real(p: &Path) -> R<PathBuf> {
    if let Ok(c) = std::fs::canonicalize(p) {
        return Ok(c);
    }
    let parent = p.parent().filter(|x| !x.as_os_str().is_empty()).ok_or("路径不完整")?;
    let name = p.file_name().ok_or("路径不完整")?;
    Ok(real(parent)?.join(name))
}

/// `path` resolved, if it is inside one of `roots`.
pub fn inside(path: &str, roots: &[String]) -> R<PathBuf> {
    if roots.is_empty() {
        return Err("还没有设置工作目录：主人要先在这个 AI 的设置里加一个".into());
    }
    let p = real(Path::new(path))?;
    for r in roots {
        if let Ok(root) = std::fs::canonicalize(r) {
            if p.starts_with(&root) {
                return Ok(p);
            }
        }
    }
    Err(format!("「{path}」不在工作目录里"))
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    dir: bool,
    size: u64,
    /// Last change, unix ms.
    modified: u64,
}

pub fn list_dir(path: &str, roots: &[String]) -> R<Vec<Entry>> {
    let p = inside(path, roots)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&p).map_err(|e| format!("读不了目录：{e}"))?.flatten().take(MAX_LIST) {
        let meta = e.metadata().ok();
        out.push(Entry {
            name: e.file_name().to_string_lossy().into_owned(),
            dir: meta.as_ref().is_some_and(|m| m.is_dir()),
            size: meta.as_ref().map_or(0, |m| m.len()),
            modified: meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64),
        });
    }
    Ok(out)
}

/// Text of a file, at most `max` bytes (invalid UTF-8 replaced).
pub fn read_file(path: &str, roots: &[String], max: usize) -> R<String> {
    use std::io::Read;
    let p = inside(path, roots)?;
    let mut f = std::fs::File::open(&p).map_err(|e| format!("打不开：{e}"))?;
    let mut buf = Vec::new();
    f.by_ref().take(max as u64 + 1).read_to_end(&mut buf).map_err(|e| format!("读不了：{e}"))?;
    let cut = buf.len() > max;
    buf.truncate(max);
    let mut s = String::from_utf8_lossy(&buf).into_owned();
    if cut {
        s.push_str("\n…（文件太长，后面没读）");
    }
    Ok(s)
}

pub fn write_file(path: &str, roots: &[String], content: &str, append: bool) -> R<()> {
    use std::io::Write;
    let p = inside(path, roots)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建不了目录：{e}"))?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&p)
        .map_err(|e| format!("写不了：{e}"))?;
    f.write_all(content.as_bytes()).map_err(|e| format!("写不了：{e}"))
}

/// Moves a file or folder to the recycle bin (can be restored from there).
pub fn trash(path: &str, roots: &[String]) -> R<()> {
    let p = inside(path, roots)?;
    if roots.iter().any(|r| std::fs::canonicalize(r).is_ok_and(|root| root == p)) {
        return Err("不能删除工作目录本身".into());
    }
    ::trash::delete(&p).map_err(|e| format!("删不了：{e}"))
}

#[derive(Serialize)]
pub struct Output {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn cap(b: &[u8]) -> String {
    let s = String::from_utf8_lossy(b);
    if s.chars().count() <= MAX_OUTPUT {
        return s.into_owned();
    }
    let mut t: String = s.chars().take(MAX_OUTPUT).collect();
    t.push_str("\n…（输出太长，后面省略了）");
    t
}

/// Runs a PowerShell command (sh elsewhere) with a time limit.
pub async fn run(command: &str, cwd: Option<&str>, timeout_secs: u64) -> R<Output> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell.exe");
        // UTF-8 output, so Chinese text survives.
        c.args(["-NoProfile", "-NonInteractive", "-Command", &format!("[Console]::OutputEncoding=[Text.Encoding]::UTF8; {command}")]);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", command]);
        c
    };
    if let Some(d) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(d);
    }
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true);
    let limit = Duration::from_secs(timeout_secs.clamp(1, 600));
    match tokio::time::timeout(limit, cmd.output()).await {
        Ok(Ok(o)) => Ok(Output { code: o.status.code(), stdout: cap(&o.stdout), stderr: cap(&o.stderr), timed_out: false }),
        Ok(Err(e)) => Err(format!("运行不了：{e}")),
        Err(_) => Ok(Output { code: None, stdout: String::new(), stderr: String::new(), timed_out: true }),
    }
}

/// Opens a web address, file or folder with its usual program.
pub fn open(target: &str) -> R<()> {
    let t = target.trim();
    if t.is_empty() {
        return Err("要打开什么？".into());
    }
    #[cfg(windows)]
    let r = std::process::Command::new("explorer.exe").arg(t).spawn();
    #[cfg(not(windows))]
    let r = std::process::Command::new("xdg-open").arg(t).spawn();
    r.map(|_| ()).map_err(|e| format!("打不开：{e}"))
}

// ---------- screen, mouse and keyboard (Windows) ----------

#[derive(Serialize)]
pub struct Shot {
    /// PNG, base64.
    png: String,
    width: u32,
    height: u32,
    /// Size of the real screen (coordinates in the picture are scaled to it).
    screen_width: u32,
    screen_height: u32,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
#[cfg_attr(not(windows), allow(dead_code))] // only used by the Windows desktop
pub enum Input {
    Move { x: i32, y: i32 },
    Click { x: i32, y: i32, #[serde(default)] button: String, #[serde(default)] double: bool },
    Scroll { amount: i32 },
    Type { text: String },
    Keys { keys: String },
}

#[cfg(windows)]
mod desktop {
    use super::*;
    use base64::Engine;
    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
    use std::sync::atomic::{AtomicU32, Ordering};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    /// Tick of the last input we made ourselves.
    static OURS: AtomicU32 = AtomicU32::new(0);

    fn last_input() -> u32 {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        unsafe { GetLastInputInfo(&mut info) };
        info.dwTime
    }

    /// The owner moved the mouse or typed since our last input, within `quiet_ms`.
    fn owner_busy(quiet_ms: u32) -> bool {
        let now = unsafe { GetTickCount() };
        let last = last_input();
        let ours = OURS.load(Ordering::Relaxed);
        last.wrapping_sub(ours) > 300 && last.wrapping_sub(ours) < u32::MAX / 2 && now.wrapping_sub(last) < quiet_ms
    }

    /// Waits until the owner has left the mouse and keyboard alone for `quiet_ms`.
    pub async fn wait_for_owner(quiet_ms: u32) -> R<()> {
        for _ in 0..400 {
            if !owner_busy(quiet_ms) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        Err("你一直在用电脑，AI 先不动鼠标键盘了".into())
    }

    pub fn screenshot(max_width: u32) -> R<Shot> {
        let monitors = xcap::Monitor::all().map_err(|e| format!("截不了屏：{e}"))?;
        let m = monitors
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .or(monitors.first())
            .ok_or("没有找到屏幕")?;
        let img = m.capture_image().map_err(|e| format!("截不了屏：{e}"))?;
        let (sw, sh) = (img.width(), img.height());
        let img = if sw > max_width {
            let h = (sh as u64 * max_width as u64 / sw as u64) as u32;
            xcap::image::imageops::resize(&img, max_width, h, xcap::image::imageops::FilterType::Triangle)
        } else {
            img
        };
        let mut png = Vec::new();
        xcap::image::DynamicImage::ImageRgba8(img.clone())
            .write_to(&mut std::io::Cursor::new(&mut png), xcap::image::ImageFormat::Png)
            .map_err(|e| format!("截图编码失败：{e}"))?;
        Ok(Shot {
            png: base64::engine::general_purpose::STANDARD.encode(png),
            width: img.width(),
            height: img.height(),
            screen_width: sw,
            screen_height: sh,
        })
    }

    fn key_of(name: &str) -> R<Key> {
        let k = match name.trim().to_lowercase().as_str() {
            "ctrl" | "control" => Key::Control,
            "shift" => Key::Shift,
            "alt" => Key::Alt,
            "win" | "meta" | "super" => Key::Meta,
            "enter" | "return" => Key::Return,
            "tab" => Key::Tab,
            "esc" | "escape" => Key::Escape,
            "backspace" => Key::Backspace,
            "delete" | "del" => Key::Delete,
            "space" => Key::Space,
            "up" => Key::UpArrow,
            "down" => Key::DownArrow,
            "left" => Key::LeftArrow,
            "right" => Key::RightArrow,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" => Key::PageUp,
            "pagedown" => Key::PageDown,
            "f1" => Key::F1, "f2" => Key::F2, "f3" => Key::F3, "f4" => Key::F4, "f5" => Key::F5, "f6" => Key::F6,
            "f7" => Key::F7, "f8" => Key::F8, "f9" => Key::F9, "f10" => Key::F10, "f11" => Key::F11, "f12" => Key::F12,
            s if s.chars().count() == 1 => Key::Unicode(s.chars().next().unwrap_or(' ')),
            other => return Err(format!("不认识的按键：{other}")),
        };
        Ok(k)
    }

    /// One mouse / keyboard action. (x, y) are in the screenshot's pixels,
    /// scaled to the screen with `scale` (screen width / picture width).
    pub async fn input(action: Input, scale: f64, quiet_ms: u32) -> R<()> {
        wait_for_owner(quiet_ms).await?;
        let mut e = Enigo::new(&Settings::default()).map_err(|e| format!("用不了键鼠：{e}"))?;
        let at = |v: i32| (v as f64 * scale).round() as i32;
        let err = |e: enigo::InputError| format!("键鼠操作失败：{e}");
        match action {
            Input::Move { x, y } => e.move_mouse(at(x), at(y), Coordinate::Abs).map_err(err)?,
            Input::Click { x, y, button, double } => {
                e.move_mouse(at(x), at(y), Coordinate::Abs).map_err(err)?;
                let b = match button.as_str() {
                    "right" => Button::Right,
                    "middle" => Button::Middle,
                    _ => Button::Left,
                };
                e.button(b, Direction::Click).map_err(err)?;
                if double {
                    e.button(b, Direction::Click).map_err(err)?;
                }
            }
            Input::Scroll { amount } => e.scroll(amount, Axis::Vertical).map_err(err)?,
            Input::Type { text } => e.text(&text).map_err(err)?,
            Input::Keys { keys } => {
                let list = keys.split('+').map(key_of).collect::<R<Vec<_>>>()?;
                for k in &list {
                    e.key(*k, Direction::Press).map_err(err)?;
                }
                for k in list.iter().rev() {
                    e.key(*k, Direction::Release).map_err(err)?;
                }
            }
        }
        OURS.store(unsafe { GetTickCount() }, Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(windows)]
pub use desktop::{input, screenshot};

#[cfg(not(windows))]
pub fn screenshot(_max_width: u32) -> R<Shot> {
    Err("看屏幕只在 Windows 版可用".into())
}

#[cfg(not(windows))]
pub async fn input(_action: Input, _scale: f64, _quiet_ms: u32) -> R<()> {
    Err("鼠标键盘只在 Windows 版可用".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_roots() {
        let dir = std::env::temp_dir().join(format!("am-agent-{}", std::process::id()));
        let inner = dir.join("work");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(dir.join("secret.txt"), "x").unwrap();
        let roots = vec![inner.to_string_lossy().into_owned()];
        // Inside, also a file that does not exist yet.
        assert!(inside(&inner.join("a.txt").to_string_lossy(), &roots).is_ok());
        write_file(&inner.join("sub/b.txt").to_string_lossy(), &roots, "你好", false).unwrap();
        assert_eq!(read_file(&inner.join("sub/b.txt").to_string_lossy(), &roots, 100).unwrap(), "你好");
        assert!(read_file(&inner.join("sub/b.txt").to_string_lossy(), &roots, 3).unwrap().contains("太长"));
        // Outside, also through "..".
        assert!(inside(&dir.join("secret.txt").to_string_lossy(), &roots).is_err());
        assert!(inside(&inner.join("../secret.txt").to_string_lossy(), &roots).is_err());
        assert!(inside("relative.txt", &[]).is_err());
        assert_eq!(list_dir(&inner.to_string_lossy(), &roots).unwrap().len(), 1);
        assert!(trash(&inner.to_string_lossy(), &roots).is_err()); // not the work folder itself
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn commands_run_with_a_time_limit() {
        let o = run("echo hi", None, 5).await.unwrap();
        assert_eq!(o.stdout.trim(), "hi");
        assert!(run("sleep 3", None, 1).await.unwrap().timed_out);
    }
}
