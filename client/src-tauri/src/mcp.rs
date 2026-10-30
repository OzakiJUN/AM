//! MCP client (docs/design.md §9, 操作电脑): tool servers the owner adds to
//! an AI (a command that speaks the Model Context Protocol over stdio, one
//! JSON-RPC message per line). Only what the agent needs: start, list
//! tools, call a tool. A server stays running until its command changes or
//! the app quits.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

pub type R<T> = Result<T, String>;

const PROTOCOL: &str = "2025-06-18";

struct Server {
    /// command + args it was started with (a change restarts it).
    spec: Vec<String>,
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next: u64,
}

impl Server {
    async fn start(spec: &[String]) -> R<Server> {
        let (cmd, args) = spec.split_first().ok_or("没有填命令")?;
        let mut c = tokio::process::Command::new(resolve(cmd));
        c.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        #[cfg(windows)]
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = c.spawn().map_err(|e| format!("启动不了 {cmd}：{e}"))?;
        let stdin = child.stdin.take().ok_or("拿不到输入")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("拿不到输出")?).lines();
        let mut s = Server { spec: spec.to_vec(), child, stdin, stdout, next: 1 };
        let init = json!({
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": { "name": "AM", "version": env!("CARGO_PKG_VERSION") },
        });
        s.request("initialize", init, Duration::from_secs(30)).await?;
        s.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await?;
        Ok(s)
    }

    async fn send(&mut self, v: Value) -> R<()> {
        let mut line = v.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.map_err(|e| format!("工具服务断开了：{e}"))?;
        self.stdin.flush().await.map_err(|e| e.to_string())
    }

    async fn request(&mut self, method: &str, params: Value, wait: Duration) -> R<Value> {
        let id = self.next;
        self.next += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        let read = async {
            loop {
                let line = self.stdout.next_line().await.map_err(|e| e.to_string())?.ok_or("工具服务退出了")?;
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue }; // logs on stdout
                if v["id"] != id {
                    // Requests from the server (sampling, roots…) are not supported.
                    if v.get("method").is_some() && v.get("id").is_some() {
                        let no = json!({ "jsonrpc": "2.0", "id": v["id"], "error": { "code": -32601, "message": "not supported" } });
                        self.send(no).await?;
                    }
                    continue;
                }
                if let Some(e) = v.get("error") {
                    return Err(format!("工具服务：{}", e["message"].as_str().unwrap_or("出错了")));
                }
                return Ok(v["result"].clone());
            }
        };
        tokio::time::timeout(wait, read).await.map_err(|_| "工具服务没反应".to_string())?
    }
}

/// Windows only finds `.exe` by itself; `npx`, `uvx` and friends are often
/// `.cmd` files, so look the name up in PATH with the usual extensions.
#[cfg(windows)]
fn resolve(cmd: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(cmd);
    if p.extension().is_some() || p.components().count() > 1 {
        return p.to_path_buf();
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for ext in ["exe", "cmd", "bat", "com"] {
            let f = dir.join(format!("{cmd}.{ext}"));
            if f.is_file() {
                return f;
            }
        }
    }
    p.to_path_buf()
}

#[cfg(not(windows))]
fn resolve(cmd: &str) -> std::path::PathBuf {
    cmd.into()
}

type Shared = Arc<Mutex<Server>>;

static SERVERS: std::sync::Mutex<Option<HashMap<String, Shared>>> = std::sync::Mutex::new(None);

/// The running server under `key`, started (or restarted) for `spec`.
async fn get(key: &str, spec: &[String]) -> R<Shared> {
    let existing = SERVERS.lock().map_err(|_| "状态出错")?.get_or_insert_with(HashMap::new).get(key).cloned();
    if let Some(s) = existing {
        let mut g = s.lock().await;
        if g.spec == spec && g.child.try_wait().map(|x| x.is_none()).unwrap_or(false) {
            drop(g);
            return Ok(s);
        }
        let _ = g.child.start_kill();
    }
    let s = Arc::new(Mutex::new(Server::start(spec).await?));
    SERVERS.lock().map_err(|_| "状态出错")?.get_or_insert_with(HashMap::new).insert(key.to_owned(), s.clone());
    Ok(s)
}

#[derive(Serialize)]
pub struct Tool {
    name: String,
    description: String,
    #[serde(rename = "inputSchema")]
    input_schema: Value,
}

pub async fn tools(key: &str, spec: &[String]) -> R<Vec<Tool>> {
    let s = get(key, spec).await?;
    let mut g = s.lock().await;
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor { Some(c) => json!({ "cursor": c }), None => json!({}) };
        let r = g.request("tools/list", params, Duration::from_secs(30)).await?;
        for t in r["tools"].as_array().into_iter().flatten() {
            out.push(Tool {
                name: t["name"].as_str().unwrap_or_default().to_owned(),
                description: t["description"].as_str().unwrap_or_default().to_owned(),
                input_schema: if t["inputSchema"].is_object() { t["inputSchema"].clone() } else { json!({ "type": "object", "properties": {} }) },
            });
        }
        match r["nextCursor"].as_str() {
            Some(c) if out.len() < 500 => cursor = Some(c.to_owned()),
            _ => break,
        }
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct CallResult {
    text: String,
    /// base64 PNG / JPEG pictures in the result.
    images: Vec<String>,
    error: bool,
}

pub async fn call(key: &str, spec: &[String], tool: &str, args: Value, timeout: u64) -> R<CallResult> {
    let s = get(key, spec).await?;
    let mut g = s.lock().await;
    let r = g.request("tools/call", json!({ "name": tool, "arguments": args }), Duration::from_secs(timeout.clamp(1, 600))).await?;
    Ok(result_of(&r))
}

fn result_of(r: &Value) -> CallResult {
    let mut text = Vec::new();
    let mut images = Vec::new();
    for c in r["content"].as_array().into_iter().flatten() {
        match c["type"].as_str() {
            Some("text") => text.push(c["text"].as_str().unwrap_or_default().to_owned()),
            Some("image") => images.extend(c["data"].as_str().map(str::to_owned)),
            Some("resource") => text.push(c["resource"]["text"].as_str().unwrap_or_default().to_owned()),
            _ => {}
        }
    }
    if text.is_empty() && !r["structuredContent"].is_null() {
        text.push(r["structuredContent"].to_string());
    }
    CallResult { text: text.join("\n"), images, error: r["isError"] == true }
}

/// Stops the servers whose key starts with `prefix` (an AI stopped running here).
pub fn stop(prefix: &str) {
    if let Ok(mut g) = SERVERS.lock() {
        if let Some(m) = g.as_mut() {
            m.retain(|k, _| !k.starts_with(prefix)); // kill_on_drop
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_results() {
        let r = json!({ "content": [{ "type": "text", "text": "a" }, { "type": "image", "data": "QUJD", "mimeType": "image/png" }, { "type": "text", "text": "b" }], "isError": true });
        let c = result_of(&r);
        assert_eq!((c.text.as_str(), c.images.len(), c.error), ("a\nb", 1, true));
        let c = result_of(&json!({ "content": [], "structuredContent": { "x": 1 } }));
        assert_eq!(c.text, r#"{"x":1}"#);
    }

    /// A tiny MCP server written in sh: answers initialize, tools/list and tools/call.
    #[cfg(unix)]
    #[tokio::test]
    async fn talks_to_a_server() {
        let script = r#"while read -r line; do
  id=$(echo "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"initialize"'*) echo '{"jsonrpc":"2.0","id":'$id',"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"t","version":"1"}}}' ;;
    *'"tools/list"'*) echo 'log line'; echo '{"jsonrpc":"2.0","id":'$id',"result":{"tools":[{"name":"echo","description":"says it back","inputSchema":{"type":"object","properties":{"s":{"type":"string"}}}}]}}' ;;
    *'"tools/call"'*) echo '{"jsonrpc":"2.0","id":'$id',"result":{"content":[{"type":"text","text":"hi"}]}}' ;;
  esac
done"#;
        let spec = vec!["sh".to_owned(), "-c".to_owned(), script.to_owned()];
        let t = tools("test", &spec).await.unwrap();
        assert_eq!((t.len(), t[0].name.as_str(), t[0].description.as_str()), (1, "echo", "says it back"));
        let r = call("test", &spec, "echo", json!({ "s": "x" }), 10).await.unwrap();
        assert_eq!(r.text, "hi");
        let bad = vec!["/no/such/program".to_owned()];
        assert!(tools("bad", &bad).await.is_err());
        stop("");
    }
}
