//! Node.js bindings for bypass-core via napi-rs.
//!
//! Exposes `bypassFetch(url, headers?)` as an async function to Node.js.

use bypass_core::BypassClient;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::OnceLock;
use tokio::sync::OnceCell;

/// Global tokio runtime for the napi addon.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to create tokio runtime")
    })
}

/// Global bypass client (lazy-initialized on first call).
static CLIENT: OnceCell<BypassClient> = OnceCell::const_new();

async fn get_client() -> napi::Result<&'static BypassClient> {
    CLIENT
        .get_or_try_init(|| async {
            BypassClient::new()
                .await
                .map_err(|e| napi::Error::from_reason(format!("Failed to init bypass client: {e}")))
        })
        .await
}

#[napi(object)]
pub struct JsBypassResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Buffer,
}

/// Fetch a URL through the ISP bypass pipeline.
///
/// Combines DoH (DNS over HTTPS), TLS ClientHello fragmentation,
/// and Chrome TLS fingerprint impersonation.
#[napi]
pub async fn bypass_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> napi::Result<JsBypassResponse> {
    let client = get_client().await?;

    let resp = client
        .fetch(&url, headers)
        .await
        .map_err(|e| napi::Error::from_reason(format!("Bypass fetch failed: {e}")))?;

    Ok(JsBypassResponse {
        status: resp.status,
        headers: resp.headers,
        body: resp.body.into(),
    })
}

use tokio::sync::Mutex;

/// Streaming response — headers/status available immediately,
/// body chunks read one at a time via `read()`.
#[napi]
pub struct BypassResponseStream {
    status: u16,
    headers: HashMap<String, String>,
    receiver: Mutex<tokio::sync::mpsc::Receiver<Vec<u8>>>,
}

#[napi]
impl BypassResponseStream {
    #[napi(getter)]
    pub fn status(&self) -> u16 {
        self.status
    }

    #[napi(getter)]
    pub fn headers(&self) -> HashMap<String, String> {
        self.headers.clone()
    }

    /// Read the next body chunk. Returns null when the body is complete.
    #[napi]
    pub async fn read(&self) -> Option<Buffer> {
        self.receiver
            .lock()
            .await
            .recv()
            .await
            .map(|chunk| chunk.into())
    }
}

/// Streaming version of bypass_fetch — returns headers immediately,
/// body is read chunk-by-chunk via the returned stream object.
/// Memory usage per request = 1 chunk (~64KB) instead of entire body.
#[napi]
pub async fn bypass_fetch_streaming(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> napi::Result<BypassResponseStream> {
    let client = get_client().await?;

    let resp = client
        .fetch_streaming(&url, headers)
        .await
        .map_err(|e| napi::Error::from_reason(format!("Bypass fetch failed: {e}")))?;

    Ok(BypassResponseStream {
        status: resp.status,
        headers: resp.headers,
        receiver: Mutex::new(resp.body_rx),
    })
}
