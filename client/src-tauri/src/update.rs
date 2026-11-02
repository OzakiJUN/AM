//! Client updates (docs/release.md): the UI has already verified release.json
//! with the built-in release key (lib/release.ts); this downloads the
//! installer from GitHub, a mirror or the server's copy (pinned
//! connection), keeps it only if its size and SHA-256 match the manifest,
//! and runs it (NSIS: /P = progress only, /UPDATE, /R = start AM again).

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

/// Downloads the installer; returns its path. Progress (bytes so far) goes
/// to `on`. A source that fails or sends the wrong bytes is skipped.
pub async fn download(net: &Net, sources: Vec<Source>, version: String, size: u64, sha256: String, on: Channel<u64>) -> Result<String, String> {
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err("bad version".into());
    }
    let dir = dir();
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let path = dir.join(format!("AM-setup-{version}.exe"));
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
            (None, Some(id)) => net.update_installer(id).await.map_err(|e| e.0),
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

/// Runs a downloaded installer and quits AM (the installer starts it again).
pub fn install(app: &tauri::AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.parent() != Some(dir().as_path()) || !path.ends_with(".exe") {
        return Err("不是下载好的安装包".into());
    }
    if !cfg!(windows) {
        return Err("只有 Windows 版能自动安装".into());
    }
    std::process::Command::new(&p).args(["/P", "/UPDATE", "/R"]).spawn().map_err(|e| format!("启动安装程序失败：{e}"))?;
    app.exit(0);
    Ok(())
}
