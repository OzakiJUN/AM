//! Networking for the desktop app. Web pages cannot trust a self-signed
//! certificate by fingerprint, so all traffic to AM servers goes through
//! here: every server is pinned to the certificate hash from its join code
//! (or verified against the usual CA roots when it has a real certificate).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// Where a server is and how to trust it (from a join code).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Endpoint {
    /// host:port
    pub address: String,
    /// Plain HTTP (only for local testing servers).
    #[serde(default)]
    pub plain: bool,
    /// Start of the certificate SHA-256 (16 bytes in join codes, up to 32).
    #[serde(default)]
    pub pin: Option<Vec<u8>>,
}

impl Endpoint {
    pub fn base_url(&self) -> String {
        format!("{}://{}", if self.plain { "http" } else { "https" }, self.address)
    }
    fn ws_url(&self) -> String {
        format!("{}://{}/ws", if self.plain { "ws" } else { "wss" }, self.address)
    }
}

#[derive(Debug)]
pub struct NetError(pub String);

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn err(e: impl std::fmt::Display) -> NetError {
    NetError(e.to_string())
}

// ---------- TLS ----------

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Accepts exactly the certificate whose SHA-256 starts with `pin`. No CA
/// or host name check: the pin is the trust.
#[derive(Debug)]
struct PinVerifier {
    pin: Vec<u8>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let sum = Sha256::digest(end_entity.as_ref());
        if self.pin.len() >= 16 && self.pin.len() <= 32 && sum[..self.pin.len()] == self.pin[..] {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "server certificate does not match the join code (fingerprint mismatch)".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// TLS config for an endpoint, or None for plain HTTP.
fn tls_config(ep: &Endpoint) -> Result<Option<Arc<ClientConfig>>, NetError> {
    if ep.plain {
        return Ok(None);
    }
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(err)?;
    let cfg = match &ep.pin {
        Some(pin) => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinVerifier { pin: pin.clone(), provider }))
            .with_no_client_auth(),
        None => {
            let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
            builder.with_root_certificates(roots).with_no_client_auth()
        }
    };
    Ok(Some(Arc::new(cfg)))
}

fn http_client(ep: &Endpoint) -> Result<reqwest::Client, NetError> {
    let mut b = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .user_agent(concat!("AM-client/", env!("CARGO_PKG_VERSION")));
    if let Some(cfg) = tls_config(ep)? {
        b = b.tls_backend_preconfigured((*cfg).clone());
    }
    b.build().map_err(err)
}

// ---------- servers ----------

struct Conn {
    ep: Endpoint,
    http: reqwest::Client,
    token: Option<String>,
}

/// HTTP response handed to the UI: status plus body (protojson text).
#[derive(Serialize)]
pub struct Reply {
    pub status: u16,
    pub body: String,
}

/// Events from a WebSocket connection to the UI.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WsEvent {
    /// A binary frame (a protobuf ServerFrame), base64.
    Frame { data: String },
    Closed { reason: String },
}

#[derive(Default)]
pub struct Net {
    servers: RwLock<HashMap<String, Arc<Conn>>>,
    sockets: Mutex<HashMap<u64, mpsc::UnboundedSender<Option<Vec<u8>>>>>,
    next_socket: AtomicU64,
}

impl Net {
    /// Adds or replaces a server under the UI's id for it.
    pub fn register(&self, id: &str, ep: Endpoint, token: Option<String>) -> Result<(), NetError> {
        let http = http_client(&ep)?;
        self.servers.write().unwrap().insert(id.to_string(), Arc::new(Conn { ep, http, token }));
        Ok(())
    }

    pub fn set_token(&self, id: &str, token: Option<String>) -> Result<(), NetError> {
        let mut map = self.servers.write().unwrap();
        let old = map.get(id).ok_or_else(|| NetError("unknown server".into()))?;
        let conn = Conn { ep: old.ep.clone(), http: old.http.clone(), token };
        map.insert(id.to_string(), Arc::new(conn));
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Arc<Conn>, NetError> {
        self.servers.read().unwrap().get(id).cloned().ok_or_else(|| NetError("unknown server".into()))
    }

    /// GET /api/v1/server for an endpoint not registered yet (join screen).
    pub async fn server_info(ep: &Endpoint) -> Result<Reply, NetError> {
        let http = http_client(ep)?;
        let resp = http.get(format!("{}/api/v1/server", ep.base_url())).send().await.map_err(describe)?;
        Ok(Reply { status: resp.status().as_u16(), body: resp.text().await.map_err(err)? })
    }

    /// A JSON API call. `path` starts with /api/v1/.
    pub async fn api(&self, id: &str, method: &str, path: &str, body: Option<String>) -> Result<Reply, NetError> {
        let c = self.get(id)?;
        if !path.starts_with("/api/") {
            return Err(NetError("bad path".into()));
        }
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(err)?;
        let mut req = c.http.request(method, format!("{}{}", c.ep.base_url(), path));
        if let Some(t) = &c.token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.header("Content-Type", "application/json").body(b);
        }
        let resp = req.send().await.map_err(describe)?;
        Ok(Reply { status: resp.status().as_u16(), body: resp.text().await.map_err(err)? })
    }

    /// Uploads a file (multipart field "file"), returns the MediaInfo reply.
    pub async fn upload(&self, id: &str, name: &str, data: Vec<u8>) -> Result<Reply, NetError> {
        let c = self.get(id)?;
        let part = reqwest::multipart::Part::bytes(data).file_name(name.to_string());
        let form = reqwest::multipart::Form::new().part("file", part);
        let mut req = c.http.post(format!("{}/api/v1/media", c.ep.base_url())).multipart(form);
        if let Some(t) = &c.token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.map_err(describe)?;
        Ok(Reply { status: resp.status().as_u16(), body: resp.text().await.map_err(err)? })
    }

    /// Fetches a media path (/api/v1/media/...) with the session token.
    pub async fn fetch(&self, id: &str, path: &str) -> Result<(u16, String, Vec<u8>), NetError> {
        let c = self.get(id)?;
        // Media files and the server icon only (the token is attached).
        if !path.starts_with("/api/v1/media/") && !path.starts_with("/api/v1/server/icon") {
            return Err(NetError("bad media path".into()));
        }
        let mut req = c.http.get(format!("{}{}", c.ep.base_url(), path));
        if let Some(t) = &c.token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.map_err(describe)?;
        let status = resp.status().as_u16();
        let mime = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        Ok((status, mime, resp.bytes().await.map_err(err)?.to_vec()))
    }

    /// Opens the WebSocket. Frames and the final close go to `on_event`.
    /// Returns a handle for send / close.
    pub async fn ws_open<F>(&self, id: &str, on_event: F) -> Result<u64, NetError>
    where
        F: Fn(WsEvent) + Send + Sync + 'static,
    {
        use base64::Engine;
        let c = self.get(id)?;
        let url = c.ep.ws_url();
        let connector = tls_config(&c.ep)?.map(tokio_tungstenite::Connector::Rustls);
        let (ws, _) = tokio_tungstenite::connect_async_tls_with_config(url, None, false, connector)
            .await
            .map_err(|e| NetError(format!("cannot connect: {e}")))?;
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Option<Vec<u8>>>();
        let handle = self.next_socket.fetch_add(1, Ordering::Relaxed) + 1;
        self.sockets.lock().unwrap().insert(handle, tx);

        // Writer: frames from the UI; None closes.
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                match msg {
                    Some(data) => {
                        if sink.send(Message::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        let _ = sink.close().await;
                        break;
                    }
                }
            }
        });
        // Reader: binary frames to the UI. Pings are answered by tungstenite.
        tokio::spawn(async move {
            let b64 = base64::engine::general_purpose::STANDARD;
            let reason = loop {
                match stream.next().await {
                    Some(Ok(Message::Binary(data))) => on_event(WsEvent::Frame { data: b64.encode(&data) }),
                    Some(Ok(Message::Close(frame))) => {
                        break frame.map(|f| f.reason.to_string()).unwrap_or_else(|| "closed".into())
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break e.to_string(),
                    None => break "closed".into(),
                }
            };
            on_event(WsEvent::Closed { reason });
        });
        Ok(handle)
    }

    pub fn ws_send(&self, handle: u64, data: Vec<u8>) -> Result<(), NetError> {
        let map = self.sockets.lock().unwrap();
        let tx = map.get(&handle).ok_or_else(|| NetError("connection closed".into()))?;
        tx.send(Some(data)).map_err(|_| NetError("connection closed".into()))
    }

    pub fn ws_close(&self, handle: u64) {
        if let Some(tx) = self.sockets.lock().unwrap().remove(&handle) {
            let _ = tx.send(None);
        }
    }
}

/// Turns connection errors into something a person can act on.
fn describe(e: reqwest::Error) -> NetError {
    let mut msg = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        msg = format!("{msg}: {s}");
        src = s.source();
    }
    if msg.contains("fingerprint mismatch") {
        return NetError("服务器证书和加入码不一致（fingerprint mismatch）。服务器可能重装过，请向服主要新的服务器码".into());
    }
    if e.is_connect() || e.is_timeout() {
        return NetError(format!("连不上服务器，请检查网络或服务器是否开着（{msg}）"));
    }
    NetError(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Talks to a running am-server. Set AM_TEST_SERVER=host:port and
    /// AM_TEST_PIN=<hex sha256 prefix> (from the admin panel's fingerprint).
    #[tokio::test]
    async fn live_server_pinning() {
        let (Ok(addr), Ok(pin_hex)) = (std::env::var("AM_TEST_SERVER"), std::env::var("AM_TEST_PIN")) else {
            eprintln!("AM_TEST_SERVER / AM_TEST_PIN not set, skipping");
            return;
        };
        let pin: Vec<u8> = (0..pin_hex.len() / 2)
            .map(|i| u8::from_str_radix(&pin_hex[2 * i..2 * i + 2], 16).unwrap())
            .collect();
        let good = Endpoint { address: addr.clone(), plain: false, pin: Some(pin.clone()) };
        let r = Net::server_info(&good).await.expect("pinned request works");
        assert_eq!(r.status, 200, "{}", r.body);
        assert!(r.body.contains("name"), "{}", r.body);

        let mut wrong = pin.clone();
        wrong[0] ^= 0xff;
        let bad = Endpoint { address: addr, plain: false, pin: Some(wrong) };
        let e = Net::server_info(&bad).await.err().expect("wrong pin must fail");
        assert!(e.0.contains("fingerprint mismatch"), "{}", e.0);

        // WebSocket connects through the pinned TLS too (server closes it
        // after the auth timeout; we just check the handshake).
        let net = Net::default();
        net.register("s", good, None).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let h = net.ws_open("s", move |ev| { let _ = tx.send(ev); }).await.expect("ws handshake");
        net.ws_close(h);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await;
    }
}
