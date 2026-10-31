//! Requests to AI model providers (OpenAI-compatible, Claude, Gemini) for the
//! AI accounts this device runs (docs/design.md §9). Ordinary HTTPS with CA
//! checks (not the pinned connection to AM servers); plain HTTP only to this
//! computer (local models). The response streams back to the UI in chunks.

use std::sync::OnceLock;

use serde::Serialize;
use tauri::ipc::Channel;

use crate::net;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum StreamEvent {
    /// Next piece of the response body (UTF-8 text).
    Chunk { text: String },
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = net::public_client().map_err(|e| e.0)?;
    Ok(CLIENT.get_or_init(|| c))
}

fn allowed(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return false };
    match u.scheme() {
        "https" => true,
        "http" => matches!(u.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]")),
        _ => false,
    }
}

/// POSTs `body` to `url` and streams the reply to `on`; returns the HTTP status.
pub async fn post(url: String, headers: Vec<(String, String)>, body: String, on: Channel<StreamEvent>) -> Result<u16, String> {
    if !allowed(&url) {
        return Err("只能用 https 地址（本机的模型可以用 http://localhost）".into());
    }
    let mut req = client()?.post(&url).body(body);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let mut resp = req.send().await.map_err(|e| format!("连不上模型服务：{e}"))?;
    let status = resp.status().as_u16();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("回复中断：{e}"))? {
        buf.extend_from_slice(&chunk);
        // Hand over whole characters only; the rest waits for the next chunk.
        let valid = match std::str::from_utf8(&buf) {
            Ok(s) => s.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid > 0 {
            let text = String::from_utf8(buf.drain(..valid).collect()).unwrap_or_default();
            let _ = on.send(StreamEvent::Chunk { text });
        }
    }
    Ok(status)
}
