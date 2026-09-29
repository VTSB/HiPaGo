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

/// Shared client: a request-local error does not invalidate other requests' state.
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
        let client = get_client().await?;
        let resp = client.fetch(&url, headers).await?;
        Ok(BypassResponse {
            // bypass-core's HTTP status is u16; widen to i32 for FFI.
            status: i32::from(resp.status),
            headers: resp.headers,
            body: resp.body,
        })
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
        let client = get_client().await?;
        let written = client.download_to_file(&url, headers, &dest_path).await?;
        Ok(written as i64)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Server {
        url: String,
        requests: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Server {
        fn start() -> Self {
            let listener = runtime()
                .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
                .unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(AtomicUsize::new(0));
            let count = Arc::clone(&requests);
            let task = runtime().spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    let mut chunk = [0; 512];
                    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        let read = socket.read(&mut chunk).await.unwrap();
                        assert!(read > 0 && request.len() < 8192);
                        request.extend_from_slice(&chunk[..read]);
                    }
                    count.fetch_add(1, Ordering::SeqCst);
                    let response: &[u8] = if request.starts_with(b"GET /missing ") {
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    } else if request.starts_with(b"GET /truncated ") {
                        b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\npart"
                    } else {
                        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndone"
                    };
                    socket.write_all(response).await.unwrap();
                }
            });
            Self {
                url,
                requests,
                task,
            }
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    #[test]
    fn request_errors_do_not_replace_client_or_replay_downloads() {
        let client = runtime().block_on(get_client()).unwrap();
        let invalid = bypass_fetch("not a URL".into(), None).unwrap_err();
        assert!(invalid.to_string().contains("Invalid URL"));
        assert!(Arc::ptr_eq(
            &client,
            &runtime().block_on(get_client()).unwrap()
        ));

        let server = Server::start();
        let directory = std::env::temp_dir().join(format!(
            "hipago-uniffi-request-errors-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let blocked_parent = directory.join("not-a-directory");
        std::fs::write(&blocked_parent, b"file").unwrap();
        let destination = directory.join("image");
        std::fs::write(&destination, b"previous").unwrap();

        for (path, target, expected_error) in [
            ("/missing", destination.clone(), "HTTP 404"),
            ("/ok", blocked_parent.join("image"), "IO error"),
            ("/truncated", destination.clone(), "Body read failed"),
        ] {
            let before = server.requests.load(Ordering::SeqCst);
            let error = bypass_download_to_file(
                format!("{}{path}", server.url),
                None,
                target.to_string_lossy().into_owned(),
            )
            .unwrap_err();
            assert!(error.to_string().contains(expected_error), "{error}");
            assert_eq!(server.requests.load(Ordering::SeqCst), before + 1);
            assert!(Arc::ptr_eq(
                &client,
                &runtime().block_on(get_client()).unwrap()
            ));
            assert_eq!(std::fs::read(&destination).unwrap(), b"previous");

            let healthy = bypass_fetch(format!("{}/ok", server.url), None).unwrap();
            assert_eq!(healthy.status, 200);
            assert_eq!(healthy.body, b"done");
            assert_eq!(server.requests.load(Ordering::SeqCst), before + 2);
        }

        let missing = bypass_fetch(format!("{}/missing", server.url), None).unwrap();
        assert_eq!(missing.status, 404);
        assert!(missing.body.is_empty());
        assert!(Arc::ptr_eq(
            &client,
            &runtime().block_on(get_client()).unwrap()
        ));
        let size = bypass_download_to_file(
            format!("{}/ok", server.url),
            None,
            destination.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(size, 4);
        assert_eq!(std::fs::read(&destination).unwrap(), b"done");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
