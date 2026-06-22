//! HTTP client with Chrome TLS fingerprint impersonation via rquest.
//!
//! Connects through the local SOCKS5 proxy for DoH + fragmentation,
//! while rquest handles BoringSSL TLS with Chrome-matching parameters.

use crate::{BypassError, BypassResponse};
use rquest::Impersonate;
use std::collections::HashMap;
use std::error::Error as StdError;
use std::time::Duration;
use tokio::sync::mpsc;

/// HTTP client configured with Chrome TLS fingerprint and SOCKS5 proxy.
pub struct Client {
    inner: rquest::Client,
}

impl Client {
    /// Create a new client that routes through the local SOCKS5 proxy.
    pub fn new(proxy_port: u16) -> Result<Self, BypassError> {
        // Use socks5h so rquest passes hostnames to the local proxy. Plain
        // socks5 resolves locally first, bypassing our DoH resolver.
        let proxy = rquest::Proxy::all(format!("socks5h://127.0.0.1:{proxy_port}"))
            .map_err(|e| BypassError::HttpError(format!("Failed to create proxy: {e}")))?;

        let client = rquest::Client::builder()
            .impersonate(Impersonate::Chrome131)
            .enable_ech_grease(true)
            .proxy(proxy)
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| BypassError::HttpError(format!("Failed to build client: {e}")))?;

        Ok(Self { inner: client })
    }

    /// Fetch a URL with bypass (DoH + fragmentation + Chrome fingerprint).
    pub async fn fetch(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
    ) -> Result<BypassResponse, BypassError> {
        let mut request = self.inner.get(url);

        // Add custom headers
        if let Some(hdrs) = headers {
            for (key, value) in hdrs {
                request = request.header(&key, &value);
            }
        }

        let response = request
            .send()
            .await
            .map_err(|e| BypassError::HttpError(format_error_chain("Request failed", &e)))?;

        let status = response.status().as_u16();

        let mut resp_headers = HashMap::new();
        for (key, value) in response.headers() {
            if let Ok(v) = value.to_str() {
                resp_headers.insert(key.to_string(), v.to_string());
            }
        }

        let body = response
            .bytes()
            .await
            .map_err(|e| BypassError::HttpError(format_error_chain("Failed to read body", &e)))?
            .to_vec();

        Ok(BypassResponse {
            status,
            headers: resp_headers,
            body,
        })
    }

    /// Fetch with streaming body — headers/status return immediately,
    /// body chunks arrive via the mpsc receiver. Memory usage = 1 chunk at a time.
    pub async fn fetch_streaming(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
    ) -> Result<StreamingResponse, BypassError> {
        let mut request = self.inner.get(url);
        if let Some(hdrs) = headers {
            for (key, value) in hdrs {
                request = request.header(&key, &value);
            }
        }

        let response = request
            .send()
            .await
            .map_err(|e| BypassError::HttpError(format_error_chain("Request failed", &e)))?;

        let status = response.status().as_u16();
        let mut resp_headers = HashMap::new();
        for (key, value) in response.headers() {
            if let Ok(v) = value.to_str() {
                resp_headers.insert(key.to_string(), v.to_string());
            }
        }

        // Channel with small buffer — provides backpressure
        let (tx, rx) = mpsc::channel::<Vec<u8>>(4);

        tokio::spawn(async move {
            let mut response = response;
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        if tx.send(chunk.to_vec()).await.is_err() {
                            break; // receiver dropped (client disconnected)
                        }
                    }
                    Ok(None) => break, // body complete
                    Err(_) => break,   // read error — signal EOF
                }
            }
            // tx drops here → receiver gets None
        });

        Ok(StreamingResponse {
            status,
            headers: resp_headers,
            body_rx: rx,
        })
    }

    /// Stream a URL's body directly to `dest_path`, one chunk at a time, so the
    /// full payload never lives in memory (used by the image cache so big reader
    /// images are never materialised in the JS heap). Returns total bytes written.
    ///
    /// Writes to a `<dest_path>.part` temp file and renames on success, so an
    /// interrupted download never leaves a truncated file that later reads as a
    /// valid cache hit. On a non-2xx response (or read error) the partial file is
    /// removed and an error returned.
    pub async fn download_to_file(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
        dest_path: &str,
    ) -> Result<u64, BypassError> {
        use tokio::io::AsyncWriteExt;

        let mut request = self.inner.get(url);
        if let Some(hdrs) = headers {
            for (key, value) in hdrs {
                request = request.header(&key, &value);
            }
        }

        let mut response = request
            .send()
            .await
            .map_err(|e| BypassError::HttpError(format_error_chain("Request failed", &e)))?;

        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(BypassError::HttpError(format!(
                "Image fetch failed with HTTP {status}"
            )));
        }

        if let Some(parent) = std::path::Path::new(dest_path).parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let tmp_path = format!("{dest_path}.part");
        let mut file = tokio::fs::File::create(&tmp_path).await?;
        let mut total: u64 = 0;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    file.write_all(&chunk).await?;
                    total += chunk.len() as u64;
                }
                Ok(None) => break,
                Err(e) => {
                    drop(file);
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    return Err(BypassError::HttpError(format!("Body read failed: {e}")));
                }
            }
        }
        file.flush().await?;
        drop(file);
        tokio::fs::rename(&tmp_path, dest_path).await?;
        Ok(total)
    }
}

fn format_error_chain(context: &str, err: &dyn StdError) -> String {
    let mut message = format!("{context}: {err}");
    let mut source = err.source();
    while let Some(err) = source {
        message.push_str(&format!("; caused by: {err}"));
        source = err.source();
    }
    message
}

/// Response with streaming body via channel.
pub struct StreamingResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body_rx: mpsc::Receiver<Vec<u8>>,
}
