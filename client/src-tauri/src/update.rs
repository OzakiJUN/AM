//! Client updates (docs/release.md): the UI has already verified release.json
//! with the built-in release key (lib/release.ts); this downloads the new
//! version from GitHub, a mirror or the server's copy (pinned connection),
//! keeps it only if its size and SHA-256 match the manifest, and puts it in
//! place. Two kinds of AM (`mode`):
//! - installed (NSIS put uninstall.exe beside it): run AM-setup.exe
//!   (/P = progress only, /UPDATE, /R = start AM again);
//! - portable (AM.exe run from any folder): swap the exe itself — the
//!   running one is renamed to AM.exe.old (Windows allows renaming a running
//!   exe, not deleting it), the new one takes its name and place, starts
//!   after this one has quit, and deletes the .old file.

use crate::net::Net;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tokio::io::AsyncWriteExt;

/// Where to download from: a URL (https) or a server's kept copy.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub url: Option<String>,
    pub server: Option<String>,
}

fn dir() -> PathBuf {
    std::env::temp_dir().join("AM-update")
}

/// "installed" when the NSIS installer put this AM there, else "portable".
pub fn mode() -> &'static str {
    let installed = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("uninstall.exe").is_file()))
        .unwrap_or(false);
    if installed {
        "installed"
    } else {
        "portable"
    }
}

const WAIT_PID: &str = "AM_UPDATE_WAIT_PID";

/// At start: after a portable update, wait for the old AM to quit (so the
/// single-instance check doesn't hand over to it) and delete AM.exe.old.
pub fn after_update() {
    #[cfg(windows)]
    if let Some(pid) = std::env::var(WAIT_PID).ok().and_then(|v| v.parse::<u32>().ok()) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        // SAFETY: plain Win32 calls on a handle we own and close.
        unsafe {
            let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if !h.is_null() {
                WaitForSingleObject(h, 15_000);
                CloseHandle(h);
            }
        }
        std::env::remove_var(WAIT_PID);
    }
    if let Ok(cur) = std::env::current_exe() {
        let _ = std::fs::remove_file(cur.with_extension("exe.old"));
    }
}

/// Downloads the installer; returns its path. Progress (bytes so far) goes
/// to `on`. A source that fails or sends the wrong bytes is skipped.
pub async fn download(net: &Net, sources: Vec<Source>, version: String, portable: bool, size: u64, sha256: String, on: Channel<u64>) -> Result<String, String> {
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err("bad version".into());
    }
    let dir = dir();
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let path = dir.join(if portable { format!("AM-{version}.exe") } else { format!("AM-setup-{version}.exe") });
    let mut errs = Vec::new();
    for src in sources {
        let resp = match (&src.url, &src.server) {
            (Some(url), _) => {
                if !url.starts_with("https://") {
                    errs.push(format!("{url}: 只能用 https"));
                    continue;
                }
                crate::ai_http::public_get(url).await
            }
            (None, Some(id)) if !portable => net.update_installer(id).await.map_err(|e| e.0),
            _ => continue,
        };
        let from = src.url.clone().unwrap_or_else(|| "服务器".into());
        match resp {
            Ok(r) if r.status().as_u16() == 200 => match save(r, &path, size, &sha256, &on).await {
                Ok(()) => return Ok(path.to_string_lossy().into_owned()),
                Err(e) => errs.push(format!("{from}: {e}")),
            },
            Ok(r) => errs.push(format!("{from}: HTTP {}", r.status().as_u16())),
            Err(e) => errs.push(format!("{from}: {e}")),
        }
        let _ = tokio::fs::remove_file(&path).await;
    }
    Err(format!("下载新版本失败：{}", errs.join("；")))
}

/// Android: the APK of a verified release into `dir` (the app's cache
/// folder); returns its path. Same checks as `download`.
pub async fn download_apk(dir: PathBuf, urls: Vec<String>, version: String, size: u64, sha256: String, on: Channel<u64>) -> Result<String, String> {
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err("bad version".into());
    }
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    // Older downloads are not needed any more.
    if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let _ = tokio::fs::remove_file(e.path()).await;
        }
    }
    let path = dir.join(format!("AM-{version}.apk"));
    let mut errs = Vec::new();
    for url in urls {
        if !url.starts_with("https://") {
            errs.push(format!("{url}: 只能用 https"));
            continue;
        }
        match crate::ai_http::public_get(&url).await {
            Ok(r) if r.status().as_u16() == 200 => match save(r, &path, size, &sha256, &on).await {
                Ok(()) => return Ok(path.to_string_lossy().into_owned()),
                Err(e) => errs.push(format!("{url}: {e}")),
            },
            Ok(r) => errs.push(format!("{url}: HTTP {}", r.status().as_u16())),
            Err(e) => errs.push(format!("{url}: {e}")),
        }
        let _ = tokio::fs::remove_file(&path).await;
    }
    Err(format!("下载新版本失败：{}", errs.join("；")))
}

async fn save(mut resp: reqwest::Response, path: &PathBuf, size: u64, sha256: &str, on: &Channel<u64>) -> Result<(), String> {
    let mut f = tokio::fs::File::create(path).await.map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut n: u64 = 0;
    let mut last = 0u64;
    loop {
        let chunk = tokio::time::timeout(std::time::Duration::from_secs(60), resp.chunk())
            .await
            .map_err(|_| "太久没有数据".to_string())?
            .map_err(|e| format!("下载中断：{e}"))?;
        let Some(chunk) = chunk else { break };
        n += chunk.len() as u64;
        if n > size {
            return Err("文件比清单里的大".into());
        }
        h.update(&chunk);
        f.write_all(&chunk).await.map_err(|e| e.to_string())?;
        if n - last >= 256 << 10 || n == size {
            last = n;
            let _ = on.send(n);
        }
    }
    f.flush().await.map_err(|e| e.to_string())?;
    let sum: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if n != size || sum != sha256 {
        return Err("大小或校验和和清单对不上".into());
    }
    Ok(())
}

/// Puts the downloaded version in place and quits AM; the installer (or
/// the new AM.exe) starts it again.
pub fn install(app: &tauri::AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.parent() != Some(dir().as_path()) || !path.ends_with(".exe") {
        return Err("不是下载好的新版本".into());
    }
    if !cfg!(windows) {
        return Err("只有 Windows 版能自动更新".into());
    }
    if mode() == "installed" {
        std::process::Command::new(&p).args(["/P", "/UPDATE", "/R"]).spawn().map_err(|e| format!("启动安装程序失败：{e}"))?;
    } else {
        let cur = std::env::current_exe().map_err(|e| e.to_string())?;
        swap(&cur, &p)?;
        std::process::Command::new(&cur)
            .env(WAIT_PID, std::process::id().to_string())
            .spawn()
            .map_err(|e| format!("启动新版本失败：{e}"))?;
    }
    app.exit(0);
    Ok(())
}

/// Swaps the running exe for `new`: cur -> cur.old, copy new -> cur (a copy:
/// the download folder may be on another drive). Puts the old one back if
/// that fails.
fn swap(cur: &std::path::Path, new: &std::path::Path) -> Result<(), String> {
    let old = cur.with_extension("exe.old");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(cur, &old).map_err(|e| format!("换不了 {}（这个文件夹不能写？请手动换成新版）：{e}", cur.display()))?;
    if let Err(e) = std::fs::copy(new, cur) {
        let _ = std::fs::remove_file(cur);
        let _ = std::fs::rename(&old, cur);
        return Err(format!("放不进新版本：{e}"));
    }
    let _ = std::fs::remove_file(new);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::swap;

    #[test]
    fn swap_keeps_the_name_and_the_old_copy() {
        let d = std::env::temp_dir().join(format!("am-swap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let cur = d.join("AM.exe");
        let new = d.join("AM-0.2.0.exe");
        std::fs::write(&cur, b"old").unwrap();
        std::fs::write(&new, b"new").unwrap();
        swap(&cur, &new).unwrap();
        assert_eq!(std::fs::read(&cur).unwrap(), b"new");
        assert_eq!(std::fs::read(d.join("AM.exe.old")).unwrap(), b"old");
        assert!(!new.exists());
        // A missing download: the old one comes back.
        assert!(swap(&cur, &d.join("nope.exe")).is_err());
        assert_eq!(std::fs::read(&cur).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&d);
    }
}
