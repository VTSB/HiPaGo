//! HTTP client with Chrome TLS fingerprint impersonation via rquest.
//!
//! Connects through the local SOCKS5 proxy for DoH + fragmentation,
//! while rquest handles BoringSSL TLS with Chrome-matching parameters.

use crate::{BypassError, BypassResponse};
use rquest::Impersonate;
use std::collections::HashMap;
use std::time::Duration;

/// HTTP client configured with Chrome TLS fingerprint and SOCKS5 proxy.
pub struct Client {
    inner: rquest::Client,
}

impl Client {
    /// Create a new client that routes through the local SOCKS5 proxy.
    pub fn new(proxy_port: u16) -> Result<Self, BypassError> {
        let proxy = rquest::Proxy::all(format!("socks5://127.0.0.1:{proxy_port}"))
            .map_err(|e| BypassError::HttpError(format!("Failed to create proxy: {e}")))?;

        let client = rquest::Client::builder()
            .impersonate(Impersonate::Chrome131)
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
            .map_err(|e| BypassError::HttpError(format!("Request failed: {e}")))?;

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
            .map_err(|e| BypassError::HttpError(format!("Failed to read body: {e}")))?
            .to_vec();

        Ok(BypassResponse {
            status,
            headers: resp_headers,
            body,
        })
    }
}
