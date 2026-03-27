//! ISP bypass library for HiPaGo.
//!
//! Combines three bypass techniques:
//! 1. **DoH** (DNS over HTTPS) — resolves via Cloudflare 1.1.1.1 to bypass DNS poisoning
//! 2. **TLS ClientHello fragmentation** — splits first TLS packet to defeat SNI-based DPI
//! 3. **Chrome TLS fingerprint** — impersonates Chrome's TLS fingerprint via BoringSSL

pub mod client;
pub mod doh;
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

/// High-level bypass client combining DoH + SOCKS5 proxy + Chrome fingerprint.
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

    /// Shut down the SOCKS5 proxy.
    pub async fn shutdown(&self) {
        self.proxy_handle.shutdown().await;
    }
}
