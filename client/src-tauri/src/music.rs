//! NetEase songs for the music widgets (docs/design.md §7 音乐): the player
//! loads `ammusic://localhost/<song id>`, and this fetches the song from
//! NetEase's public "outer" link with the headers NetEase expects (browser
//! user agent, music.163.com referer), following its redirect to the CDN.
//! Going through Rust avoids the page's CSP, the http CDN hosts and
//! hotlink checks. Songs are kept in memory (last few) so seeking (Range
//! requests) does not download again.

use std::sync::{Arc, Mutex, OnceLock};

use tauri::http::{Response, StatusCode};

use crate::net;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const MAX_SONG: usize = 60 << 20;
const KEEP: usize = 3;

struct Song {
    id: String,
    mime: String,
    data: Arc<Vec<u8>>,
}

fn cache() -> &'static Mutex<Vec<Song>> {
    static C: OnceLock<Mutex<Vec<Song>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Vec::new()))
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = net::public_client().map_err(|e| e.0)?;
    Ok(CLIENT.get_or_init(|| c))
}

/// Downloads a song (or takes it from the cache): (mime, bytes).
async fn song(id: &str) -> Result<(String, Arc<Vec<u8>>), String> {
    if !id.chars().all(|c| c.is_ascii_digit()) || id.is_empty() || id.len() > 20 {
        return Err("bad song id".into());
    }
    if let Some(s) = cache().lock().unwrap().iter().find(|s| s.id == id) {
        return Ok((s.mime.clone(), s.data.clone()));
    }
    let url = format!("https://music.163.com/song/media/outer/url?id={id}.mp3");
    let resp = client()?
        .get(&url)
        .header("User-Agent", UA)
        .header("Referer", "https://music.163.com/")
        .send()
        .await
        .map_err(|e| format!("连不上网易云：{e}"))?;
    let final_url = resp.url().clone();
    let mime = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/mpeg")
        .to_string();
    // Songs NetEase won't let out (paid, copyright) end on its 404 page.
    if !resp.status().is_success() || final_url.path().contains("404") || mime.starts_with("text/") {
        return Err("unavailable".into());
    }
    let data = resp.bytes().await.map_err(|e| format!("下载中断：{e}"))?;
    if data.len() > MAX_SONG || data.len() < 1024 {
        return Err("unavailable".into());
    }
    let data = Arc::new(data.to_vec());
    let mime = if mime.starts_with("audio/") { mime } else { "audio/mpeg".into() };
    let mut c = cache().lock().unwrap();
    c.retain(|s| s.id != id);
    c.push(Song { id: id.to_string(), mime: mime.clone(), data: data.clone() });
    while c.len() > KEEP {
        c.remove(0);
    }
    Ok((mime, data))
}

/// "bytes=10-" / "bytes=10-99" -> (start, end inclusive) within len.
pub(crate) fn range(header: Option<&str>, len: usize) -> Option<(usize, usize)> {
    let spec = header?.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        // Last n bytes.
        let n: usize = b.parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let s: usize = a.parse().ok()?;
        let e: usize = if b.is_empty() { len - 1 } else { b.parse::<usize>().ok()?.min(len - 1) };
        (s, e)
    };
    (start <= end && start < len).then_some((start, end))
}

/// Answers one `ammusic://` request: /<song id>, honouring Range.
pub async fn serve(path: &str, range_header: Option<String>) -> Response<Vec<u8>> {
    let id = path.trim_start_matches('/').trim_end_matches(".mp3");
    match song(id).await {
        Ok((mime, data)) => {
            let len = data.len();
            let b = Response::builder()
                .header("Content-Type", mime)
                .header("Accept-Ranges", "bytes")
                .header("Cache-Control", "no-store");
            let r = match range(range_header.as_deref(), len) {
                Some((s, e)) => b
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header("Content-Range", format!("bytes {s}-{e}/{len}"))
                    .body(data[s..=e].to_vec()),
                None => b.status(StatusCode::OK).body(data.to_vec()),
            };
            r.unwrap_or_else(|_| Response::new(Vec::new()))
        }
        Err(e) => Response::builder()
            .status(if e == "unavailable" { StatusCode::NOT_FOUND } else { StatusCode::BAD_GATEWAY })
            .header("Content-Type", "text/plain")
            .body(e.into_bytes())
            .unwrap_or_else(|_| Response::new(Vec::new())),
    }
}

#[cfg(test)]
mod tests {
    use super::range;

    #[test]
    fn ranges() {
        assert_eq!(range(Some("bytes=0-"), 100), Some((0, 99)));
        assert_eq!(range(Some("bytes=10-19"), 100), Some((10, 19)));
        assert_eq!(range(Some("bytes=90-200"), 100), Some((90, 99)));
        assert_eq!(range(Some("bytes=-10"), 100), Some((90, 99)));
        assert_eq!(range(Some("bytes=100-"), 100), None);
        assert_eq!(range(Some("items=0-1"), 100), None);
        assert_eq!(range(None, 100), None);
    }
}
