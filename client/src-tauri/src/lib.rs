//! AM desktop client: the window (Tauri) plus the networking the UI cannot
//! do itself (certificate pinning). The UI is the React app in ../src.

mod agent;
mod ai_http;
mod browser;
mod mcp;
mod music;
mod net;
mod notification_policy;
mod secrets;
mod uia;
mod update;

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
    let sticker_sync = header("x-sticker-sync").as_deref() == Ok("true");
    net.upload(&id, &name, data.clone(), sticker_sync).await.map_err(e)
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

#[tauri::command]
async fn save_edited_image(request: Request<'_>) -> Res<()> {
    let InvokeBody::Raw(data) = request.body() else { return Err("expected image bytes".into()); };
    let dest = request.headers().get("x-dest").and_then(|s| s.to_str().ok()).ok_or("missing destination")?;
    tokio::fs::write(percent_decode(dest), data).await.map_err(|e| e.to_string())
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

/// A plain GET to a model provider (balance lookups): status and body.
#[tauri::command]
async fn ai_get(url: String, headers: Vec<(String, String)>) -> Res<(u16, String)> {
    ai_http::get(url, headers).await
}

/// Downloads a workshop file (index or package) as raw bytes.
#[tauri::command]
async fn web_get_bytes(url: String, max: u64) -> Res<tauri::ipc::Response> {
    ai_http::get_bytes(url, max).await.map(tauri::ipc::Response::new)
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

// UI Automation (uia.rs): windows and their controls, read by name.

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn agent_ui_windows() -> Res<Vec<uia::Window>> {
    blocking(uia::windows).await
}

#[tauri::command]
async fn agent_ui_tree(handle: i64) -> Res<Vec<uia::Node>> {
    blocking(move || uia::tree(handle)).await
}

#[tauri::command]
async fn agent_ui_act(handle: i64, id: usize, expect: String, action: String, text: Option<String>) -> Res<String> {
    blocking(move || uia::act(handle, id, &expect, &action, text.as_deref())).await
}

#[tauri::command]
async fn agent_ui_activate(handle: i64) -> Res<()> {
    blocking(move || uia::activate(handle)).await
}

// The AI's own browsers (browser.rs), with their own profiles in the app
// data folder: the visible one, and the background one for its free time.

/// One of the AI's browsers; `proxy` = "system" / "direct" / an address,
/// absent = keep what it runs with.
fn ai_browser(app: &tauri::AppHandle, background: bool, proxy: Option<&str>) -> Res<browser::Browser> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let proxy = proxy.map(browser::Proxy::parse).transpose()?;
    Ok(browser::Browser::new(dir.join(if background { "ai-browser-bg" } else { "ai-browser" }), background).with_proxy(proxy))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn agent_browser(app: tauri::AppHandle, action: String, url: Option<String>, n: Option<u32>, text: Option<String>, submit: Option<bool>, pages: Option<f64>, background: Option<bool>, proxy: Option<String>) -> Res<String> {
    let b = ai_browser(&app, background.unwrap_or(false), proxy.as_deref())?;
    match action.as_str() {
        "open" => browser::open(&b, url.as_deref().unwrap_or("")).await,
        "read" => browser::snapshot(&b).await,
        "click" => browser::click(&b, n.ok_or("缺少元素编号")?).await,
        "type" => browser::type_text(&b, n.ok_or("缺少元素编号")?, text.as_deref().unwrap_or(""), submit.unwrap_or(false)).await,
        "scroll" => browser::scroll(&b, pages.unwrap_or(1.0)).await,
        "back" => browser::back(&b).await,
        "close" => {
            browser::close();
            Ok("浏览器关了".into())
        }
        _ => Err(format!("不认识的浏览器操作 {action}")),
    }
}

#[derive(serde::Serialize)]
struct BrowserMedia {
    text: String,
    images: Vec<String>,
}

/// Bilibili login for the AI's background browser (docs/design.md §9 上网冲浪).
#[tauri::command]
async fn agent_bili(app: tauri::AppHandle, action: String, key: Option<String>) -> Res<serde_json::Value> {
    // Always the background browser: that is where the AI surfs.
    browser::bili(&ai_browser(&app, true, None)?, &action, key.as_deref().unwrap_or("")).await
}

/// Watching a video page (details, subtitles, danmaku, comments, frames) or
/// a picture of the page.
#[tauri::command]
async fn agent_browser_media(app: tauri::AppHandle, action: String, url: Option<String>, frames: Option<u32>, background: Option<bool>, proxy: Option<String>) -> Res<BrowserMedia> {
    let b = ai_browser(&app, background.unwrap_or(false), proxy.as_deref())?;
    match action.as_str() {
        "watch" => {
            let (text, images) = browser::watch(&b, url.as_deref(), frames.unwrap_or(0)).await?;
            Ok(BrowserMedia { text, images })
        }
        "shot" => Ok(BrowserMedia { text: String::new(), images: vec![browser::screenshot(&b).await?] }),
        _ => Err(format!("不认识的浏览器操作 {action}")),
    }
}

// MCP tool servers (mcp.rs); `key` keeps each AI's servers apart.

#[tauri::command]
async fn mcp_tools(key: String, spec: Vec<String>, env: Vec<(String, String)>) -> Res<Vec<mcp::Tool>> {
    mcp::tools(&key, &spec, &env).await
}

#[tauri::command]
async fn mcp_call(key: String, spec: Vec<String>, env: Vec<(String, String)>, tool: String, args: serde_json::Value, timeout: u64) -> Res<mcp::CallResult> {
    mcp::call(&key, &spec, &env, &tool, args, timeout).await
}

#[tauri::command]
fn mcp_stop(prefix: String) {
    mcp::stop(&prefix);
}

/// Closing the window: hide it to the tray (default; AIs run by this device
/// stay online) or quit. Set from the UI's settings at start and on change.
/// Host mode (docs/design.md §10 托管): am-server starts this client with
/// `--host <file>` to run one AI without a window. The file (the AI's
/// login, the owner's model providers, its work folder, a browser data
/// folder of its own) is read once and deleted.
static HOST: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

fn host_file() -> Option<&'static String> {
    HOST.get_or_init(|| {
        let args: Vec<String> = std::env::args().collect();
        let i = args.iter().position(|a| a == "--host")?;
        let path = args.get(i + 1)?;
        let text = std::fs::read_to_string(path).ok()?;
        let _ = std::fs::remove_file(path);
        Some(text)
    })
    .as_ref()
}

/// The host file's JSON in host mode, null otherwise (lib/ai/host.ts).
#[tauri::command]
fn host_config() -> Option<String> {
    host_file().cloned()
}

/// Host mode: the AI's login ended; quit so am-server starts this client
/// again with a new one. Does nothing outside host mode.
/// Downloads the client installer of a verified release (update.rs).
#[tauri::command]
async fn update_download(net: State<'_, Net>, sources: Vec<update::Source>, version: String, portable: bool, size: u64, sha256: String, on_progress: Channel<u64>) -> Res<String> {
    update::download(&net, sources, version, portable, size, sha256, on_progress).await
}

/// "installed" or "portable" (which file an update needs).
#[tauri::command]
fn update_mode() -> &'static str {
    update::mode()
}

/// Runs the downloaded installer and quits.
#[tauri::command]
fn update_install(app: tauri::AppHandle, path: String) -> Res<()> {
    update::install(&app, path)
}

#[tauri::command]
fn host_exit(app: tauri::AppHandle) {
    if host_file().is_some() {
        app.exit(3);
    }
}

static CLOSE_TO_TRAY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

#[tauri::command]
fn set_close_to_tray(on: bool) {
    CLOSE_TO_TRAY.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// Windows portable builds do not have an installer-created Start Menu
/// identity. Register a path-independent per-user sender and use that exact
/// identity for the toast. Other platforms keep their notification plugin.
#[tauri::command]
fn windows_notify(
    window: tauri::WebviewWindow,
    title: String,
    body: String,
    force: bool,
) -> Res<bool> {
    if notification_policy::suppress(
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(true),
        force,
    ) {
        return Ok(true);
    }
    #[cfg(target_os = "windows")]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let config = window.config();
        let id = &config.identifier;
        let path = format!(r"Software\Classes\AppUserModelId\{id}");
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(path).map_err(|e| e.to_string())?;
        key.set_value("DisplayName", &config.product_name.as_deref().unwrap_or("AM")).map_err(|e| e.to_string())?;
        tauri_winrt_notification::Toast::new(id).title(&title).text1(&body).show().map_err(|e| e.to_string())?;
        Ok(true)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (title, body);
        Ok(false)
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Tray icon: click to open the window, menu to open or quit.
#[cfg(desktop)]
fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let open = MenuItem::with_id(app, "open", "打开 AM", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut b = TrayIconBuilder::with_id("main").tooltip("AM").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.on_menu_event(|app, ev| match ev.id().as_ref() {
        "open" => show_main(app),
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|t, ev| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
            show_main(t.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

/// F12 stops every AI that is operating the computer. Only held while one
/// is (games and other programs keep F12 the rest of the time).
#[tauri::command]
fn agent_stop_key(app: tauri::AppHandle, on: bool) -> Res<()> {
    // Host mode: no global F12 (it would be taken from whoever uses this computer).
    #[cfg(desktop)]
    if host_file().is_none() {
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
    let host = host_file().is_some();
    if !host {
        update::after_update();
    }
    let mut builder = tauri::Builder::default().setup(move |app| {
        // The main window is made here (tauri.conf: create = false): in host
        // mode hidden, with its own browser data (localStorage) so it never
        // mixes with a normal AM client on the same computer.
        let conf = app.config().app.windows.iter().find(|w| w.label == "main").cloned().expect("main window in tauri.conf.json");
        let mut win = tauri::WebviewWindowBuilder::from_config(app.handle(), &conf)?;
        if host {
            let dir = host_file()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
                .and_then(|v| v.get("dataDir").and_then(|d| d.as_str()).map(std::path::PathBuf::from));
            win = win.visible(false).skip_taskbar(true);
            if let Some(dir) = dir {
                win = win.data_directory(dir);
            }
        }
        win.build()?;
        #[cfg(desktop)]
        if !host {
            tray(app)?;
        }
        Ok(())
    });
    #[cfg(desktop)]
    if !host {
        // A second start just brings the existing window to the front.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)));
        builder = builder.on_window_event(|w, ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                if w.label() == "main" && CLOSE_TO_TRAY.load(std::sync::atomic::Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        });
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
        // NetEase songs for the music widgets: ammusic://localhost/<song id> (music.rs).
        .register_asynchronous_uri_scheme_protocol("ammusic", |_ctx, request, responder| {
            let path = request.uri().path().to_string();
            let range = request.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_string);
            tauri::async_runtime::spawn(async move {
                responder.respond(music::serve(&path, range).await);
            });
        })
        .invoke_handler(tauri::generate_handler![
            save_edited_image, server_info, register_server, set_token, api, upload, download, media_bytes, secret_get, secret_set,
            secret_delete, ai_request, ai_get, web_get_bytes, agent_list_dir, agent_read_file, agent_write_file, agent_trash, agent_run, agent_open,
            agent_screenshot, agent_input, agent_stop_key, agent_ui_windows, agent_ui_tree, agent_ui_act, agent_ui_activate,
            agent_browser, agent_browser_media, agent_bili, mcp_tools, mcp_call, mcp_stop, set_close_to_tray, windows_notify, ws_open, ws_send, ws_close, host_config, host_exit,
            update_download, update_install, update_mode
        ])
        .run(tauri::generate_context!())
        .expect("error while running AM");
}
