//! HTTP client with ECH-capable HTTPS and Chrome TLS fallback via rquest.
//!
//! ECH-capable hosts use a direct rustls ECH transport. Other hosts, or ECH
//! attempts that fail before a response is exposed, fall back to the local
//! SOCKS5 proxy path for DoH + fragmentation.

use crate::doh::DohResolver;
use crate::ech_http::EchHttpClient;
use crate::{BypassError, BypassResponse};
use rquest::Impersonate;
use std::collections::HashMap;
use std::error::Error as StdError;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{timeout_at, Instant};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// HTTP client configured with Chrome TLS fingerprint and SOCKS5 proxy.
pub struct Client {
    inner: rquest::Client,
    ech: EchHttpClient,
}

impl Client {
    /// Create a new client that routes through the local SOCKS5 proxy.
    pub fn new(proxy_port: u16) -> Result<Self, BypassError> {
        Self::with_resolver(proxy_port, DohResolver::new())
    }

    pub(crate) fn with_resolver(
        proxy_port: u16,
        resolver: DohResolver,
    ) -> Result<Self, BypassError> {
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
            ech: EchHttpClient::with_resolver(resolver),
        })
    }

    /// Fetch a URL with bypass (DoH + fragmentation + Chrome fingerprint).
    pub async fn fetch(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
    ) -> Result<BypassResponse, BypassError> {
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        timeout_at(deadline, self.fetch_until(url, headers, deadline))
            .await
            .map_err(|_| request_timed_out())?
    }

    async fn fetch_until(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
        deadline: Instant,
    ) -> Result<BypassResponse, BypassError> {
        if let Some(response) = self.ech.fetch(url, headers.as_ref(), deadline).await? {
            return Ok(response);
        }

        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(request_timed_out)?;
        let mut request = self.inner.get(url).timeout(remaining);

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
        self.fetch_streaming_until(url, headers, Instant::now() + REQUEST_TIMEOUT)
            .await
    }

    async fn fetch_streaming_until(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
        deadline: Instant,
    ) -> Result<StreamingResponse, BypassError> {
        timeout_at(deadline, self.open_stream_until(url, headers, deadline))
            .await
            .map_err(|_| request_timed_out())?
    }

    async fn open_stream_until(
        &self,
        url: &str,
        headers: Option<HashMap<String, String>>,
        deadline: Instant,
    ) -> Result<StreamingResponse, BypassError> {
        if let Some(response) = self
            .ech
            .fetch_streaming(url, headers.as_ref(), deadline)
            .await?
        {
            return Ok(response);
        }

        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(request_timed_out)?;
        let mut request = self.inner.get(url).timeout(remaining);
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
            let failure = loop {
                if Instant::now() >= deadline {
                    break Some(request_timed_out());
                }
                // Check the next chunk/EOF before reserving a delivery slot.
                // Otherwise a final chunk filling the queue hides clean EOF and
                // turns a completed response into a timeout for slow consumers.
                // Buffering remains bounded: four queued chunks plus one here.
                let next = tokio::select! {
                    _ = tx.closed() => break None,
                    next = timeout_at(deadline, response.chunk()) => next,
                };
                match next {
                    Ok(Ok(Some(chunk))) => match timeout_at(deadline, tx.reserve()).await {
                        Ok(Ok(permit)) => permit.send(Ok(chunk.to_vec())),
                        Ok(Err(_)) => break None,
                        Err(_) => break Some(request_timed_out()),
                    },
                    Ok(Ok(None)) => break None,
                    Ok(Err(err)) => {
                        break Some(BypassError::HttpError(format_error_chain(
                            "Body read failed",
                            &err,
                        )))
                    }
                    Err(_) => break Some(request_timed_out()),
                }
            };
            // Release network resources before a slow consumer can delay the
            // terminal error. Previously accepted chunks remain readable.
            drop(response);
            if let Some(err) = failure {
                let _ = tx.send(Err(err)).await;
            }
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

fn request_timed_out() -> BypassError {
    BypassError::HttpError("Request network deadline exceeded".into())
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

    #[tokio::test]
    async fn fallback_headers_and_body_share_original_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket.read(&mut [0; 2048]).await.unwrap();
            tokio::time::sleep(Duration::from_millis(80)).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npart")
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2), socket.read(&mut [0; 1]))
                .await
                .unwrap()
                .unwrap()
        });
        let client = Client {
            inner: rquest::Client::builder().no_proxy().build().unwrap(),
            ech: EchHttpClient::new(),
        };
        let deadline = Instant::now() + Duration::from_millis(250);
        let mut response = client
            .fetch_streaming_until(&format!("http://{address}/"), None, deadline)
            .await
            .unwrap();
        assert_eq!(response.body_rx.recv().await.unwrap().unwrap(), b"part");
        assert!(response.body_rx.recv().await.unwrap().is_err());
        assert!(
            Instant::now() < deadline + Duration::from_millis(150),
            "body must not gain a fresh timeout after headers"
        );
        assert_eq!(peer.await.unwrap(), 0);
    }

    #[tokio::test]
    async fn full_fallback_queue_closes_socket_before_consumer_drains() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket.read(&mut [0; 2048]).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .await
                .unwrap();
            for _ in 0..8 {
                socket.write_all(b"4\r\npart\r\n").await.unwrap();
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            tokio::time::timeout(Duration::from_secs(2), socket.read(&mut [0; 1]))
                .await
                .unwrap()
                .unwrap()
        });
        let client = Client {
            inner: rquest::Client::builder().no_proxy().build().unwrap(),
            ech: EchHttpClient::new(),
        };
        let deadline = Instant::now() + Duration::from_millis(300);
        let mut response = client
            .fetch_streaming_until(&format!("http://{address}/"), None, deadline)
            .await
            .unwrap();
        // Do not drain until the peer has observed close while our queue is full.
        assert_eq!(peer.await.unwrap(), 0);
        let mut chunks = 0;
        let mut errors = 0;
        while let Some(chunk) = response.body_rx.recv().await {
            match chunk {
                Ok(_) => chunks += 1,
                Err(_) => errors += 1,
            }
        }
        assert_eq!(chunks, 4);
        assert_eq!(errors, 1);
    }

    #[tokio::test]
    async fn expired_budget_never_starts_fallback_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = Client {
            inner: rquest::Client::builder().no_proxy().build().unwrap(),
            ech: EchHttpClient::new(),
        };
        assert!(client
            .fetch_streaming_until(
                &format!("http://{}/", listener.local_addr().unwrap()),
                None,
                Instant::now()
            )
            .await
            .is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(25), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn ech_cutoff_and_real_socks_fallback_consume_one_budget() {
        use tokio::net::TcpListener;
        use tokio::time::timeout;
        let dns = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/dns-query", dns.local_addr().unwrap());
        let dns_task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = dns.accept().await.unwrap();
                let mut request = [0; 2048];
                let n = socket.read(&mut request).await.unwrap();
                let answer = if String::from_utf8_lossy(&request[..n]).contains("type=HTTPS") {
                    // Valid X25519 base-point test key, same config as the ECH
                    // handshake fixture; no TLS verification override.
                    r#"{"Status":0,"Answer":[{"type":65,"TTL":300,"data":"1 . ech=AD/+DQA7AAAgACAJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAEAAQAMZml4dHVyZS50ZXN0AAA="}]}"#
                } else {
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
        let (heads_tx, mut heads_rx) = mpsc::channel(2);
        let peer = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = target.accept().await.unwrap();
                assert!(socket.read(&mut [0; 8192]).await.unwrap() > 0);
                heads_tx.send(()).await.unwrap();
                // Stall each TLS handshake and observe caller cancellation.
                let mut tail = Vec::new();
                let _ = socket.read_to_end(&mut tail).await;
            }
        });
        let resolver = DohResolver::with_providers([endpoint.clone(), endpoint.clone(), endpoint]);
        let proxy = crate::proxy::start_proxy_with_resolver(resolver.clone())
            .await
            .unwrap();
        let client = Client::with_resolver(proxy.port(), resolver).unwrap();
        let start = Instant::now();
        // A shortened request budget makes a reset detectable before rquest's
        // separate10s connect limit could hide it. Production uses30s.
        let deadline = start + Duration::from_secs(12);
        let request =
            tokio::spawn(async move { client.fetch_streaming_until(&url, None, deadline).await });
        timeout(Duration::from_secs(2), heads_rx.recv())
            .await
            .unwrap()
            .unwrap();
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(10)).await;
        tokio::task::yield_now().await;
        tokio::time::resume();
        // Observe an actual second TCP/TLS connection via the SOCKS path.
        timeout(Duration::from_secs(1), heads_rx.recv())
            .await
            .unwrap()
            .unwrap();
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(2)).await;
        assert!(request.await.unwrap().is_err());
        assert!(
            start.elapsed() < Duration::from_secs(13),
            "fallback restarted the network budget"
        );
        tokio::time::resume();
        timeout(Duration::from_secs(1), peer)
            .await
            .unwrap()
            .unwrap();
        proxy.shutdown().await;
        dns_task.abort();
    }

    #[tokio::test]
    async fn completed_fallback_body_in_full_queue_keeps_clean_eof_after_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket.read(&mut [0; 2048]).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            for _ in 0..4 {
                socket.write_all(b"part").await.unwrap();
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
        let client = Client {
            inner: rquest::Client::builder().no_proxy().build().unwrap(),
            ech: EchHttpClient::new(),
        };
        let deadline = Instant::now() + Duration::from_millis(300);
        let mut response = client
            .fetch_streaming_until(&format!("http://{address}/"), None, deadline)
            .await
            .unwrap();
        peer.await.unwrap();
        assert_eq!(
            response.body_rx.len(),
            4,
            "fixture must fill the channel with the complete body"
        );
        tokio::time::sleep_until(deadline + Duration::from_millis(30)).await;
        let mut body = Vec::new();
        while let Some(chunk) = response.body_rx.recv().await {
            body.extend(chunk.expect("completed network body must retain clean EOF"));
        }
        assert_eq!(body, b"partpartpartpart");
    }
}
