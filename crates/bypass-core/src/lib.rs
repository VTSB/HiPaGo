//! ISP bypass library for HiPaGo.
//!
//! Combines three bypass techniques:
//! 1. **DoH** (DNS over HTTPS) — resolves via Cloudflare 1.1.1.1 to bypass DNS poisoning
//! 2. **TLS ClientHello fragmentation** — splits first TLS packet to defeat SNI-based DPI
//! 3. **ECH when available** — applies HTTPS/SVCB ECHConfigList through rustls
//! 4. **Chrome TLS fingerprint fallback** — uses rquest for hosts without ECHConfigList

pub mod client;
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
        let proxy_handle = proxy::start_proxy().await?;
        let inner = client::Client::new(proxy_handle.port())?;
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
}
