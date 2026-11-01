//! The AI's own browser window (docs/design.md §9, 操作电脑): Edge or
//! Chrome started with a separate profile (not the owner's logins) and a
//! local debugging port. Pages are read as text with numbered elements and
//! driven through the DevTools protocol, so it never needs the mouse.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

pub type R<T> = Result<T, String>;

struct Running {
    child: std::process::Child,
    /// ws://127.0.0.1:<port>/devtools/browser/<id>
    ws: String,
}

static BROWSER: Mutex<Option<Running>> = Mutex::new(None);

/// Edge (always on Windows 10/11), else Chrome; AM_BROWSER overrides (tests).
fn find_exe() -> R<PathBuf> {
    if let Ok(p) = std::env::var("AM_BROWSER") {
        return Ok(PathBuf::from(p));
    }
    let mut list: Vec<PathBuf> = Vec::new();
    for base in ["ProgramFiles(x86)", "ProgramFiles", "LocalAppData"] {
        if let Ok(b) = std::env::var(base) {
            list.push(Path::new(&b).join("Microsoft/Edge/Application/msedge.exe"));
            list.push(Path::new(&b).join("Google/Chrome/Application/chrome.exe"));
        }
    }
    for p in ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"] {
        list.push(PathBuf::from(p));
    }
    list.into_iter().find(|p| p.exists()).ok_or_else(|| "找不到 Edge 或 Chrome 浏览器".into())
}

/// The DevTools address of the running browser, starting it when needed.
async fn ensure(profile: &Path) -> R<String> {
    {
        let mut g = BROWSER.lock().map_err(|_| "浏览器状态出错")?;
        if let Some(r) = g.as_mut() {
            if r.child.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Ok(r.ws.clone());
            }
            *g = None; // closed by the owner
        }
    }
    std::fs::create_dir_all(profile).map_err(|e| format!("建不了浏览器资料夹：{e}"))?;
    let port_file = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&port_file);
    let mut cmd = std::process::Command::new(find_exe()?);
    cmd.arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.display()))
        .args(["--no-first-run", "--no-default-browser-check", "about:blank"]);
    if std::env::var("AM_BROWSER_HEADLESS").is_ok() {
        cmd.args(["--headless=new", "--no-sandbox"]);
    }
    let child = cmd.spawn().map_err(|e| format!("打不开浏览器：{e}"))?;
    // The file holds the port and the browser's DevTools path, one per line.
    let mut ws = None;
    for _ in 0..100 {
        if let Ok(t) = std::fs::read_to_string(&port_file) {
            let mut l = t.lines();
            if let (Some(port), Some(path)) = (l.next().and_then(|p| p.trim().parse::<u16>().ok()), l.next()) {
                ws = Some(format!("ws://127.0.0.1:{port}{}", path.trim()));
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let Some(ws) = ws else {
        return Err("浏览器开了，但连不上它".into());
    };
    *BROWSER.lock().map_err(|_| "浏览器状态出错")? = Some(Running { child, ws: ws.clone() });
    Ok(ws)
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Sends one command (to a tab when `session` is set) and waits for its answer.
async fn call(ws: &mut Ws, id: u64, method: &str, params: Value, session: Option<&str>) -> R<Value> {
    let mut msg = json!({ "id": id, "method": method, "params": params });
    if let Some(s) = session {
        msg["sessionId"] = json!(s);
    }
    ws.send(Message::text(msg.to_string())).await.map_err(|e| e.to_string())?;
    while let Some(m) = ws.next().await {
        if let Message::Text(t) = m.map_err(|e| e.to_string())? {
            let v: Value = serde_json::from_str(&t).map_err(|e| e.to_string())?;
            if v["id"] == id {
                if let Some(e) = v.get("error") {
                    return Err(format!("浏览器：{}", e["message"].as_str().unwrap_or("出错了")));
                }
                return Ok(v["result"].clone());
            }
        }
    }
    Err("浏览器断开了".into())
}

/// One DevTools command on the AI's tab (the first page; a new one when
/// the owner closed them all).
async fn cdp(profile: &Path, method: &str, params: Value) -> R<Value> {
    let url = ensure(profile).await?;
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| format!("连不上浏览器：{e}"))?;
    let run = async {
        let targets = call(&mut ws, 1, "Target.getTargets", json!({}), None).await?;
        let page = targets["targetInfos"].as_array().and_then(|a| a.iter().find(|t| t["type"] == "page")).and_then(|t| t["targetId"].as_str()).map(str::to_owned);
        let target = match page {
            Some(t) => t,
            None => call(&mut ws, 2, "Target.createTarget", json!({ "url": "about:blank" }), None).await?["targetId"].as_str().unwrap_or_default().to_owned(),
        };
        let att = call(&mut ws, 3, "Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await?;
        let session = att["sessionId"].as_str().ok_or("浏览器页面连不上")?.to_owned();
        call(&mut ws, 4, method, params, Some(&session)).await
    };
    let r = tokio::time::timeout(Duration::from_secs(30), run).await.map_err(|_| "浏览器没反应".to_string())?;
    let _ = ws.close(None).await;
    r
}

/// Runs JavaScript in the page and returns its value.
async fn eval(profile: &Path, js: &str) -> R<Value> {
    let r = cdp(profile, "Runtime.evaluate", json!({ "expression": js, "returnByValue": true, "awaitPromise": true })).await?;
    if let Some(ex) = r.get("exceptionDetails") {
        return Err(format!("页面脚本出错：{}", ex["exception"]["description"].as_str().unwrap_or("?")));
    }
    Ok(r["result"]["value"].clone())
}

async fn settle(profile: &Path) {
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if eval(profile, "document.readyState").await.ok().and_then(|v| v.as_str().map(|s| s == "complete")).unwrap_or(false) {
            return;
        }
    }
}

/// Reads the page: title, address, numbered links / buttons / fields, visible text.
const SNAPSHOT: &str = r#"(() => {
  const sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=true],summary';
  document.querySelectorAll('[data-am-n]').forEach((e) => e.removeAttribute('data-am-n'));
  const lines = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || st.visibility === 'hidden' || st.display === 'none') continue;
    n++;
    el.setAttribute('data-am-n', String(n));
    const tag = el.tagName.toLowerCase();
    const kind = el.getAttribute('role') || (tag === 'input' ? 'input:' + (el.type || 'text') : tag);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const val = (tag === 'input' || tag === 'textarea') && el.type !== 'password' && el.value ? ' = ' + String(el.value).slice(0, 60) : '';
    lines.push('[' + n + '] ' + kind + ' ' + label + val);
    if (n >= 300) break;
  }
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 4000);
  return '标题：' + document.title + '\n地址：' + location.href + '\n\n可以操作的元素：\n' + lines.join('\n') + '\n\n页面文字（开头）：\n' + text;
})()"#;

pub async fn open(profile: &Path, url: &str) -> R<String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://") || u == "about:blank") {
        return Err("只能打开 http:// 或 https:// 网址".into());
    }
    cdp(profile, "Page.navigate", json!({ "url": u })).await?;
    settle(profile).await;
    snapshot(profile).await
}

pub async fn snapshot(profile: &Path) -> R<String> {
    Ok(eval(profile, SNAPSHOT).await?.as_str().unwrap_or("").to_owned())
}

fn target(n: u32) -> String {
    format!("document.querySelector('[data-am-n=\"{n}\"]')")
}

pub async fn click(profile: &Path, n: u32) -> R<String> {
    let js = format!("(() => {{ const el = {}; if (!el) return false; el.scrollIntoView({{block: 'center'}}); el.click(); return true; }})()", target(n));
    if eval(profile, &js).await? != Value::Bool(true) {
        return Err(format!("没有 [{n}] 号元素，页面可能变了，先重新看一下页面"));
    }
    settle(profile).await;
    snapshot(profile).await
}

pub async fn type_text(profile: &Path, n: u32, text: &str, submit: bool) -> R<String> {
    let js = format!(
        r#"(() => {{
  const el = {t};
  if (!el) return false;
  el.focus();
  if (el.isContentEditable) {{ el.innerText = {v}; }} else {{
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, {v});
  }}
  el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  if ({s}) {{
    el.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }}));
    if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
  }}
  return true;
}})()"#,
        t = target(n),
        v = serde_json::to_string(text).unwrap_or_default(),
        s = submit,
    );
    if eval(profile, &js).await? != Value::Bool(true) {
        return Err(format!("没有 [{n}] 号元素，页面可能变了，先重新看一下页面"));
    }
    settle(profile).await;
    snapshot(profile).await
}

pub async fn scroll(profile: &Path, pages: f64) -> R<String> {
    eval(profile, &format!("window.scrollBy(0, innerHeight * {pages})")).await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    snapshot(profile).await
}

pub async fn back(profile: &Path) -> R<String> {
    eval(profile, "history.back()").await?;
    settle(profile).await;
    snapshot(profile).await
}

pub fn close() {
    if let Ok(mut g) = BROWSER.lock() {
        if let Some(mut r) = g.take() {
            let _ = r.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs a Chromium: AM_BROWSER=/path/to/chrome AM_BROWSER_HEADLESS=1 cargo test -- browser
    #[tokio::test]
    async fn browser_reads_and_fills_a_page() {
        if std::env::var("AM_BROWSER").is_err() {
            return;
        }
        let profile = std::env::temp_dir().join(format!("am-browser-{}", std::process::id()));
        let page = "data:text/html;charset=utf-8,<title>T</title><input id=q placeholder=搜索><button onclick=\"document.title='clicked '+q.value\">去</button>";
        // data: URLs are refused for the AI; tests navigate there directly.
        assert!(open(&profile, page).await.is_err());
        cdp(&profile, "Page.navigate", json!({ "url": page })).await.unwrap();
        settle(&profile).await;
        let snap = snapshot(&profile).await.unwrap();
        assert!(snap.contains("[1] input:text 搜索") && snap.contains("[2] button 去"), "{snap}");
        type_text(&profile, 1, "你好", false).await.unwrap();
        click(&profile, 2).await.unwrap();
        assert_eq!(eval(&profile, "document.title").await.unwrap(), Value::String("clicked 你好".into()));
        assert!(click(&profile, 99).await.is_err());
        close();
        let _ = std::fs::remove_dir_all(&profile);
    }
}
