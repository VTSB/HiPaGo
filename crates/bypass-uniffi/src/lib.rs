//! UniFFI bindings for bypass-core.
//!
//! Generates Kotlin (Android) and Swift (iOS) bindings for the bypass client.
//! Used by Capacitor plugins on mobile platforms.

use bypass_core::{BypassClient, BypassError as CoreBypassError};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::runtime::Runtime;
use tokio::sync::RwLock;

// Pin the binding namespace to `bypass` (matches BypassPlugin.java's
// `import uniffi.bypass.*`). Without this, UniFFI proc-macro mode derives
// the namespace from the crate name (`bypass_uniffi`), producing
// `uniffi.bypass_uniffi.*` and breaking the Java imports.
uniffi::setup_scaffolding!("bypass");

fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| Runtime::new().expect("Failed to create tokio runtime"))
}

/// Resettable bypass client. Android can keep the process alive after a SOCKS
/// proxy/connect failure, so the next call must be able to create a fresh proxy
/// instead of reusing the failed global client forever.
static CLIENT: OnceLock<RwLock<Option<Arc<BypassClient>>>> = OnceLock::new();

fn client_lock() -> &'static RwLock<Option<Arc<BypassClient>>> {
    CLIENT.get_or_init(|| RwLock::new(None))
}

async fn get_client() -> Result<Arc<BypassClient>, BypassError> {
    {
        let guard = client_lock().read().await;
        if let Some(client) = guard.as_ref() {
            return Ok(Arc::clone(client));
        }
    }

    let mut guard = client_lock().write().await;
    if let Some(client) = guard.as_ref() {
        return Ok(Arc::clone(client));
    }

    let client = Arc::new(BypassClient::new().await.map_err(BypassError::from)?);
    *guard = Some(Arc::clone(&client));
    Ok(client)
}

async fn reset_client() {
    let mut guard = client_lock().write().await;
    if let Some(client) = guard.take() {
        client.shutdown().await;
    }
}

// NOTE: the variant field is named `reason`, not `message`. UniFFI's Kotlin
// generator emits a `val <field>` on the generated Exception subclass; a
// field named `message` collides with `kotlin.Throwable.message` and
// fails to compile ("hides member of supertype" + recursive type check).
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum BypassError {
    #[error("Bypass error: {reason}")]
    General { reason: String },
}

impl From<CoreBypassError> for BypassError {
    fn from(e: CoreBypassError) -> Self {
        BypassError::General {
            reason: e.to_string(),
        }
    }
}

// `status` is intentionally i32, not u16. UniFFI maps u16 → Kotlin UShort,
// which is `@JvmInline value class` and emits name-mangled getters
// (`getStatus-Mh2AYeg()` etc.) that Java callers cannot resolve.
// BypassPlugin.java is Java, so we expose a signed Int that yields a
// plain `int getStatus()` on the JVM. HTTP status fits in i32 trivially.
#[derive(Debug, Clone, uniffi::Record)]
pub struct BypassResponse {
    pub status: i32,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// Fetch a URL through the ISP bypass pipeline.
///
/// Combines DoH (DNS over HTTPS), TLS ClientHello fragmentation,
/// and Chrome TLS fingerprint impersonation.
#[uniffi::export]
pub fn bypass_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<BypassResponse, BypassError> {
    let rt = runtime();
    rt.block_on(async {
        for attempt in 0..2u8 {
            let client = get_client().await?;
            match client.fetch(&url, headers.clone()).await {
                Ok(resp) => {
                    return Ok(BypassResponse {
                        // bypass-core's HTTP status is u16; widen to i32 for FFI.
                        status: i32::from(resp.status),
                        headers: resp.headers,
                        body: resp.body,
                    });
                }
                Err(e) if attempt == 0 => {
                    eprintln!("[bypass-uniffi] fetch failed, resetting client: {e}");
                    reset_client().await;
                }
                Err(e) => return Err(BypassError::from(e)),
            }
        }
        unreachable!()
    })
}

/// Stream a URL's body straight to `dest_path` (one chunk at a time, bounded
/// memory). Returns total bytes written. Used by the persistent image cache so
/// big images are never materialised in the JS heap. `size` is i64 for the same
/// JVM-getter reason `status` is i32 (UniFFI maps u64 → ULong → mangled getters).
#[uniffi::export]
pub fn bypass_download_to_file(
    url: String,
    headers: Option<HashMap<String, String>>,
    dest_path: String,
) -> Result<i64, BypassError> {
    let rt = runtime();
    rt.block_on(async {
        for attempt in 0..2u8 {
            let client = get_client().await?;
            match client
                .download_to_file(&url, headers.clone(), &dest_path)
                .await
            {
                Ok(written) => return Ok(written as i64),
                Err(e) if attempt == 0 => {
                    eprintln!("[bypass-uniffi] download failed, resetting client: {e}");
                    reset_client().await;
                }
                Err(e) => return Err(BypassError::from(e)),
            }
        }
        unreachable!()
    })
}
