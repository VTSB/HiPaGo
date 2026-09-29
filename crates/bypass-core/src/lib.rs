//! ISP bypass library for HiPaGo.
//!
//! Combines three bypass techniques:
//! 1. **DoH** (DNS over HTTPS) — resolves via Cloudflare 1.1.1.1 to bypass DNS poisoning
//! 2. **TLS ClientHello fragmentation** — splits first TLS packet to defeat SNI-based DPI
//! 3. **ECH when available** — applies HTTPS/SVCB ECHConfigList through rustls
//! 4. **Chrome TLS fingerprint fallback** — uses rquest for hosts without ECHConfigList

pub mod client;
mod connect;
pub mod doh;
mod download;
mod ech_http;
pub mod proxy;

pub use client::StreamingResponse;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum BypassError {
    #[error("DoH resolution failed: {0}")]
    DohError(String),

    #[error("Proxy error: {0}")]
    ProxyError(String),

    #[error("HTTP request failed: {0}")]
    HttpError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BypassResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// High-level bypass client combining DoH + SOCKS5 proxy + ECH-capable HTTPS.
///
/// Usage:
/// ```no_run
/// # async fn example() -> Result<(), bypass_core::BypassError> {
/// let client = bypass_core::BypassClient::new().await?;
/// let resp = client.fetch("https://hitomi.la/", None).await?;
/// println!("Status: {}", resp.status);
/// client.shutdown().await;
/// # Ok(())
/// # }
/// ```
pub struct BypassClient {
    inner: client::Client,
    proxy_handle: proxy::ProxyHandle,
}

impl BypassClient {
    /// Create a new bypass client. Starts the in-process SOCKS5 proxy.
    pub async fn new() -> Result<Self, BypassError> {
        Self::with_resolver(doh::DohResolver::new()).await
    }

    async fn with_resolver(resolver: doh::DohResolver) -> Result<Self, BypassError> {
        let proxy_handle = proxy::start_proxy_with_resolver(resolver.clone()).await?;
        let inner = client::Client::with_resolver(proxy_handle.port(), resolver)?;
        Ok(Self {
            inner,
            proxy_handle,
        })
    }

    /// Fetch a URL through the bypass pipeline (DoH + fragmentation + Chrome fingerprint).
    pub async fn fetch(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
    ) -> Result<BypassResponse, BypassError> {
        self.inner.fetch(url, headers).await
    }

    /// Fetch with streaming body — headers/status return immediately,
    /// body chunks arrive via the mpsc receiver. Memory usage = 1 chunk at a time.
    pub async fn fetch_streaming(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
    ) -> Result<StreamingResponse, BypassError> {
        self.inner.fetch_streaming(url, headers).await
    }

    /// Stream a URL's body straight to `dest_path` (one chunk at a time, bounded
    /// memory). Returns total bytes written. Used by the persistent image cache so
    /// big images are never materialised in memory.
    pub async fn download_to_file(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
        dest_path: &str,
    ) -> Result<u64, BypassError> {
        self.inner.download_to_file(url, headers, dest_path).await
    }

    /// Shut down the SOCKS5 proxy.
    pub async fn shutdown(&self) {
        self.proxy_handle.shutdown().await;
    }
}

/// Remove only the failed generation; never shut a replacement down while holding the lock.
pub async fn reset_failed_client(
    clients: &tokio::sync::RwLock<Option<std::sync::Arc<BypassClient>>>,
    failed: &std::sync::Arc<BypassClient>,
) {
    let removed = {
        let mut guard = clients.write().await;
        if guard
            .as_ref()
            .is_some_and(|current| std::sync::Arc::ptr_eq(current, failed))
        {
            guard.take()
        } else {
            None
        }
    };
    if let Some(client) = removed {
        client.shutdown().await;
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    #[tokio::test]
    async fn stale_failure_does_not_reset_replacement() {
        let old = Arc::new(BypassClient::new().await.unwrap());
        let replacement = Arc::new(BypassClient::new().await.unwrap());
        let clients = RwLock::new(Some(Arc::clone(&replacement)));
        reset_failed_client(&clients, &old).await;
        assert!(Arc::ptr_eq(
            clients.read().await.as_ref().unwrap(),
            &replacement
        ));
        reset_failed_client(&clients, &replacement).await;
        assert!(clients.read().await.is_none());
        old.shutdown().await;
    }

    #[tokio::test]
    async fn ech_and_fallback_share_address_lookup_cache() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        use tokio::time::{timeout, Duration};
        let dns = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/dns-query", dns.local_addr().unwrap());
        let a_queries = Arc::new(AtomicUsize::new(0));
        let ech_queries = Arc::new(AtomicUsize::new(0));
        let a_count = a_queries.clone();
        let ech_count = ech_queries.clone();
        let dns_task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = dns.accept().await.unwrap();
                let mut request = [0; 2048];
                let n = socket.read(&mut request).await.unwrap();
                let query = String::from_utf8_lossy(&request[..n]);
                let answer = if query.contains("type=HTTPS") {
                    ech_count.fetch_add(1, Ordering::SeqCst);
                    r#"{"Status":0,"Answer":[{"type":65,"TTL":300,"data":"1 . ech=AA=="}]}"#
                } else {
                    a_count.fetch_add(1, Ordering::SeqCst);
                    r#"{"Status":0,"Answer":[{"type":1,"TTL":300,"data":"127.0.0.1"}]}"#
                };
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}", answer.len()).as_bytes()).await.unwrap();
            }
        });
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "https://fixture.test:{}/",
            target.local_addr().unwrap().port()
        );
        let connections = Arc::new(AtomicUsize::new(0));
        let target_connections = connections.clone();
        let target_task = tokio::spawn(async move {
            loop {
                let (socket, _) = target.accept().await.unwrap();
                target_connections.fetch_add(1, Ordering::SeqCst);
                drop(socket);
            }
        });
        let resolver =
            doh::DohResolver::with_providers([endpoint.clone(), endpoint.clone(), endpoint]);
        let client = BypassClient::with_resolver(resolver).await.unwrap();
        // ECH resolves A then rejects the intentionally invalid config. The
        // fallback connects through SOCKS and must reuse that same A lookup.
        assert!(timeout(Duration::from_secs(3), client.fetch(&url, None))
            .await
            .unwrap()
            .is_err());
        assert_eq!(ech_queries.load(Ordering::SeqCst), 1);
        assert_eq!(a_queries.load(Ordering::SeqCst), 1);
        assert_eq!(
            connections.load(Ordering::SeqCst),
            2,
            "both ECH and SOCKS must actually reach the target"
        );
        client.shutdown().await;
        dns_task.abort();
        target_task.abort();
    }
}
