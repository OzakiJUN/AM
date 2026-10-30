//! AM desktop client: the window (Tauri) plus the networking the UI cannot
//! do itself (certificate pinning). The UI is the React app in ../src.

mod agent;
mod ai_http;
mod net;
mod secrets;

use net::{Endpoint, Net, Reply, WsEvent};
use tauri::http::{Response, StatusCode};
use tauri::ipc::{Channel, InvokeBody, Request};
use tauri::{Manager, State};

type Res<T> = Result<T, String>;

fn e(err: net::NetError) -> String {
    err.0
}

#[tauri::command]
async fn server_info(join: Endpoint) -> Res<Reply> {
    Net::server_info(&join).await.map_err(e)
}

#[tauri::command]
fn register_server(net: State<'_, Net>, id: String, endpoint: Endpoint, token: Option<String>) -> Res<()> {
    net.register(&id, endpoint, token).map_err(e)
}

#[tauri::command]
fn set_token(net: State<'_, Net>, id: String, token: Option<String>) -> Res<()> {
    net.set_token(&id, token).map_err(e)
}

#[tauri::command]
async fn api(net: State<'_, Net>, id: String, method: String, path: String, body: Option<String>) -> Res<Reply> {
    net.api(&id, &method, &path, body).await.map_err(e)
}

/// Upload: the file bytes are the raw request body; server id and file
/// name come in the headers (x-server, x-filename, URI-encoded).
#[tauri::command]
async fn upload(net: State<'_, Net>, request: Request<'_>) -> Res<Reply> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("upload expects raw bytes".into());
    };
    let header = |k: &str| {
        request
            .headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(|s| percent_decode(s))
            .ok_or_else(|| format!("missing header {k}"))
    };
    let id = header("x-server")?;
    let name = header("x-filename")?;
    net.upload(&id, &name, data.clone()).await.map_err(e)
}

/// Downloads a media path into a file chosen by the user.
#[tauri::command]
async fn download(net: State<'_, Net>, id: String, path: String, dest: String) -> Res<()> {
    let (status, _, data) = net.fetch(&id, &path).await.map_err(e)?;
    if status != 200 {
        return Err(format!("下载失败（{status}）"));
    }
    tokio::fs::write(&dest, data).await.map_err(|err| err.to_string())
}

/// Raw bytes of a media path (to copy an avatar or a profile picture to
/// another server). Arrives in JS as an ArrayBuffer.
#[tauri::command]
async fn media_bytes(net: State<'_, Net>, id: String, path: String) -> Res<tauri::ipc::Response> {
    let (status, _, data) = net.fetch(&id, &path).await.map_err(e)?;
    if status != 200 {
        return Err(format!("取文件失败（{status}）"));
    }
    Ok(tauri::ipc::Response::new(data))
}

/// A request to an AI model provider; the reply streams back through `on_event`.
#[tauri::command]
async fn ai_request(url: String, headers: Vec<(String, String)>, body: String, on_event: Channel<ai_http::StreamEvent>) -> Res<u16> {
    ai_http::post(url, headers, body, on_event).await
}

// ---------- tools for AIs that operate this computer (agent.rs) ----------

#[tauri::command]
fn agent_list_dir(path: String, roots: Vec<String>) -> Res<Vec<agent::Entry>> {
    agent::list_dir(&path, &roots)
}

#[tauri::command]
fn agent_read_file(path: String, roots: Vec<String>, max: usize) -> Res<String> {
    agent::read_file(&path, &roots, max)
}

#[tauri::command]
fn agent_write_file(path: String, roots: Vec<String>, content: String, append: bool) -> Res<()> {
    agent::write_file(&path, &roots, &content, append)
}

#[tauri::command]
fn agent_trash(path: String, roots: Vec<String>) -> Res<()> {
    agent::trash(&path, &roots)
}

#[tauri::command]
async fn agent_run(command: String, cwd: Option<String>, timeout: u64) -> Res<agent::Output> {
    agent::run(&command, cwd.as_deref(), timeout).await
}

#[tauri::command]
fn agent_open(target: String) -> Res<()> {
    agent::open(&target)
}

#[tauri::command]
async fn agent_screenshot(max_width: u32) -> Res<agent::Shot> {
    tauri::async_runtime::spawn_blocking(move || agent::screenshot(max_width)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn agent_input(action: agent::Input, scale: f64, quiet_ms: u32) -> Res<()> {
    agent::input(action, scale, quiet_ms).await
}

/// F12 stops every AI that is operating the computer. Only held while one
/// is (games and other programs keep F12 the rest of the time).
#[tauri::command]
fn agent_stop_key(app: tauri::AppHandle, on: bool) -> Res<()> {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let gs = app.global_shortcut();
        let r = if on { if gs.is_registered("F12") { Ok(()) } else { gs.register("F12") } } else { gs.unregister("F12") };
        r.map_err(|e| e.to_string())?;
    }
    #[cfg(not(desktop))]
    let _ = (app, on);
    Ok(())
}

#[tauri::command]
fn secret_get(key: String) -> Res<Option<String>> {
    secrets::get(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Res<()> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_delete(key: String) -> Res<()> {
    secrets::delete(&key)
}

#[tauri::command]
async fn ws_open(net: State<'_, Net>, id: String, on_event: Channel<WsEvent>) -> Res<u64> {
    net.ws_open(&id, move |ev| {
        let _ = on_event.send(ev);
    })
    .await
    .map_err(e)
}

#[tauri::command]
fn ws_send(net: State<'_, Net>, handle: u64, data: String) -> Res<()> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|err| err.to_string())?;
    net.ws_send(handle, bytes).map_err(e)
}

#[tauri::command]
fn ws_close(net: State<'_, Net>, handle: u64) {
    net.ws_close(handle);
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn percent_decoding() {
        assert_eq!(super::percent_decode("%E5%9B%BE%E7%89%87.png"), "图片.png");
        assert_eq!(super::percent_decode("a%2"), "a%2");
        assert_eq!(super::percent_decode("100%"), "100%");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // A second start just brings the existing window to the front.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri::Emitter;
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = app.emit("agent-stop", ());
                    }
                })
                .build(),
        );
    }
    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Net::default())
        // Images in <img> tags: ammedia://localhost/<server id>/api/v1/media/<id>[/thumb]
        // fetched with the session token over the pinned connection.
        .register_asynchronous_uri_scheme_protocol("ammedia", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // convertFileSrc() URI-encodes the whole path ("s1%2Fapi%2Fv1…").
            let uri = percent_decode(request.uri().path());
            tauri::async_runtime::spawn(async move {
                let net = app.state::<Net>();
                let mut parts = uri.trim_start_matches('/').splitn(2, '/');
                let (id, path) = (parts.next().unwrap_or(""), format!("/{}", parts.next().unwrap_or("")));
                let resp = match net.fetch(id, &path).await {
                    Ok((status, mime, data)) => Response::builder()
                        .status(status)
                        .header("Content-Type", mime)
                        .header("Cache-Control", "private, max-age=31536000, immutable")
                        .body(data),
                    Err(err) => Response::builder()
                        .status(StatusCode::BAD_GATEWAY)
                        .header("Content-Type", "text/plain")
                        .body(err.0.into_bytes()),
                };
                responder.respond(resp.unwrap_or_else(|_| Response::new(Vec::new())));
            });
        })
        .invoke_handler(tauri::generate_handler![
            server_info, register_server, set_token, api, upload, download, media_bytes, secret_get, secret_set,
            secret_delete, ai_request, agent_list_dir, agent_read_file, agent_write_file, agent_trash, agent_run, agent_open,
            agent_screenshot, agent_input, agent_stop_key, ws_open, ws_send, ws_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running AM");
}
