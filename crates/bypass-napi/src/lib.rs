//! Node.js bindings for bypass-core via napi-rs.
//!
//! Exposes `bypassFetch(url, headers?)` as an async function to Node.js.

use bypass_core::BypassClient;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::RwLock;

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

/// Resettable bypass client — can be recreated if the proxy dies or a transient failure occurs.
static CLIENT: OnceLock<RwLock<Option<Arc<BypassClient>>>> = OnceLock::new();

fn client_lock() -> &'static RwLock<Option<Arc<BypassClient>>> {
    CLIENT.get_or_init(|| RwLock::new(None))
}

async fn get_client() -> napi::Result<Arc<BypassClient>> {
    // Fast path: client already initialized
    {
        let guard = client_lock().read().await;
        if let Some(ref client) = *guard {
            return Ok(Arc::clone(client));
        }
    }
    // Slow path: initialize
    let mut guard = client_lock().write().await;
    // Double-check after acquiring write lock
    if let Some(ref client) = *guard {
        return Ok(Arc::clone(client));
    }
    let client = Arc::new(
        BypassClient::new()
            .await
            .map_err(|e| napi::Error::from_reason(format!("Failed to init bypass client: {e}")))?,
    );
    *guard = Some(Arc::clone(&client));
    Ok(client)
}

/// Reset the client so the next call creates a fresh one (new proxy, new connections).
async fn reset_client() {
    let mut guard = client_lock().write().await;
    if let Some(client) = guard.take() {
        client.shutdown().await;
    }
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
pub async fn bypass_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> napi::Result<BypassResponseStream> {
    // Try with existing client, reset and retry once on failure
    for attempt in 0..2u8 {
        let client = get_client().await?;
        match client.fetch_streaming(&url, headers.clone()).await {
            Ok(resp) => {
                return Ok(BypassResponseStream {
                    status: resp.status,
                    headers: resp.headers,
                    receiver: Mutex::new(resp.body_rx),
                });
            }
            Err(e) => {
                if attempt == 0 {
                    eprintln!("[bypass-napi] streaming fetch failed, resetting client: {e}");
                    reset_client().await;
                } else {
                    return Err(napi::Error::from_reason(format!("Bypass fetch failed: {e}")));
                }
            }
        }
    }
    unreachable!()
}
