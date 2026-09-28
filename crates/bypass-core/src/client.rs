//! HTTP client with ECH-capable HTTPS and Chrome TLS fallback via rquest.
//!
//! ECH-capable hosts use a direct rustls ECH transport. Other hosts, or ECH
//! attempts that fail before a response is exposed, fall back to the local
//! SOCKS5 proxy path for DoH + fragmentation.

use crate::ech_http::EchHttpClient;
use crate::{BypassError, BypassResponse};
use rquest::Impersonate;
use std::collections::HashMap;
use std::error::Error as StdError;
use std::time::Duration;
use tokio::sync::mpsc;

/// HTTP client configured with Chrome TLS fingerprint and SOCKS5 proxy.
pub struct Client {
    inner: rquest::Client,
    ech: EchHttpClient,
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

        Ok(Self {
            inner: client,
            ech: EchHttpClient::new(),
        })
    }

    /// Fetch a URL with bypass (DoH + fragmentation + Chrome fingerprint).
    pub async fn fetch(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
    ) -> Result<BypassResponse, BypassError> {
        if let Some(response) = self.ech.fetch(url, headers.as_ref()).await? {
            return Ok(response);
        }

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
        if let Some(response) = self.ech.fetch_streaming(url, headers.as_ref()).await? {
            return Ok(response);
        }

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
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, BypassError>>(4);

        tokio::spawn(async move {
            let mut response = response;
            loop {
                let next = tokio::select! {
                    _ = tx.closed() => break,
                    next = response.chunk() => next,
                };
                match next {
                    Ok(Some(chunk)) => {
                        if tx.send(Ok(chunk.to_vec())).await.is_err() {
                            break; // receiver dropped (client disconnected)
                        }
                    }
                    Ok(None) => break, // body complete
                    Err(err) => {
                        let _ = tx
                            .send(Err(BypassError::HttpError(format_error_chain(
                                "Body read failed",
                                &err,
                            ))))
                            .await;
                        break;
                    }
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
    /// Each attempt owns a unique temporary file and publishes only at clean EOF.
    pub async fn download_to_file(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
        dest_path: &str,
    ) -> Result<u64, BypassError> {
        let response = self.fetch_streaming(url, headers).await?;
        crate::download::save_response(response, dest_path).await
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
    pub body_rx: mpsc::Receiver<Result<Vec<u8>, BypassError>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn fallback_stream_reports_content_length_truncation() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\npart")
                .await
                .unwrap();
        });
        // Use the exact fallback pump with a direct loopback client, avoiding
        // external DNS/TLS and the unrelated SOCKS handshake in this regression.
        let client = Client {
            inner: rquest::Client::builder().no_proxy().build().unwrap(),
            ech: EchHttpClient::new(),
        };
        let mut response = client
            .fetch_streaming(&format!("http://{address}/"), None)
            .await
            .unwrap();
        let mut bytes = Vec::new();
        let mut failure = None;
        while let Some(chunk) = response.body_rx.recv().await {
            match chunk {
                Ok(chunk) => bytes.extend_from_slice(&chunk),
                Err(err) => failure = Some(err),
            }
        }
        assert_eq!(bytes, b"part");
        assert!(failure.is_some());
    }
}
