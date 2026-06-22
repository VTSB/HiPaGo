use crate::client::StreamingResponse;
use crate::doh::DohResolver;
use crate::{BypassError, BypassResponse};
use rustls::client::{EchConfig, EchMode, EchStatus};
use rustls::crypto::aws_lc_rs;
use rustls::pki_types::{EchConfigListBytes, ServerName};
use rustls::{ClientConfig, RootCertStore};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;
use url::Url;

const READ_CHUNK_SIZE: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_CHUNK_LINE_BYTES: usize = 8 * 1024;
type RustlsTlsStream = TlsStream<TcpStream>;

#[derive(Clone)]
pub struct EchHttpClient {
    resolver: DohResolver,
}

impl EchHttpClient {
    pub fn new() -> Self {
        Self {
            resolver: DohResolver::new(),
        }
    }

    pub async fn fetch(
        &self,
        url: &str,
        headers: Option<&HashMap<String, String>>,
    ) -> Result<Option<BypassResponse>, BypassError> {
        let mut response = match self.open_stream(url, headers).await? {
            Some(response) => response,
            None => return Ok(None),
        };

        let mut body = Vec::new();
        while let Some(chunk) = response.body.next_chunk().await? {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(BypassError::HttpError(format!(
                    "ECH response exceeded {MAX_RESPONSE_BYTES} bytes"
                )));
            }
            body.extend_from_slice(&chunk);
        }

        Ok(Some(BypassResponse {
            status: response.status,
            headers: response.headers,
            body,
        }))
    }

    pub async fn fetch_streaming(
        &self,
        url: &str,
        headers: Option<&HashMap<String, String>>,
    ) -> Result<Option<StreamingResponse>, BypassError> {
        let response = match self.open_stream(url, headers).await? {
            Some(response) => response,
            None => return Ok(None),
        };

        let status = response.status;
        let headers = response.headers;
        let mut body = response.body;
        let (tx, rx) = mpsc::channel::<Vec<u8>>(4);

        tokio::spawn(async move {
            loop {
                match body.next_chunk().await {
                    Ok(Some(chunk)) => {
                        if tx.send(chunk).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(err) => {
                        eprintln!("[bypass-ech] streaming body read failed: {err}");
                        break;
                    }
                }
            }
        });

        Ok(Some(StreamingResponse {
            status,
            headers,
            body_rx: rx,
        }))
    }

    pub async fn download_to_file(
        &self,
        url: &str,
        headers: Option<&HashMap<String, String>>,
        dest_path: &str,
    ) -> Result<Option<u64>, BypassError> {
        let mut response = match self.open_stream(url, headers).await? {
            Some(response) => response,
            None => return Ok(None),
        };

        if !(200..300).contains(&response.status) {
            return Err(BypassError::HttpError(format!(
                "Image fetch failed with HTTP {}",
                response.status
            )));
        }

        if let Some(parent) = std::path::Path::new(dest_path).parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let tmp_path = format!("{dest_path}.part");
        let mut file = tokio::fs::File::create(&tmp_path).await?;

        let result = async {
            let mut total: u64 = 0;
            while let Some(chunk) = response.body.next_chunk().await? {
                file.write_all(&chunk).await?;
                total += chunk.len() as u64;
            }
            file.flush().await?;
            Ok::<u64, BypassError>(total)
        }
        .await;

        match result {
            Ok(total) => {
                drop(file);
                tokio::fs::rename(&tmp_path, dest_path).await?;
                Ok(Some(total))
            }
            Err(err) => {
                drop(file);
                let _ = tokio::fs::remove_file(&tmp_path).await;
                Err(err)
            }
        }
    }

    async fn open_stream(
        &self,
        url: &str,
        headers: Option<&HashMap<String, String>>,
    ) -> Result<Option<EchResponseStream>, BypassError> {
        let parsed = Url::parse(url)
            .map_err(|e| BypassError::HttpError(format!("Invalid URL for ECH fetch: {e}")))?;

        if parsed.scheme() != "https" {
            return Ok(None);
        }

        let host = match parsed.host_str() {
            Some(host) => host.to_string(),
            None => return Ok(None),
        };
        let port = parsed.port_or_known_default().unwrap_or(443);

        let ech_config_list = match self.resolver.resolve_ech_config(&host).await {
            Ok(Some(config_list)) => config_list,
            Ok(None) => return Ok(None),
            Err(err) => {
                eprintln!("[bypass-ech] ECH config lookup failed for {host}: {err}");
                return Ok(None);
            }
        };

        match self
            .open_ech_stream(&parsed, &host, port, headers, ech_config_list)
            .await
        {
            Ok(response) => Ok(Some(response)),
            Err(err) => {
                eprintln!("[bypass-ech] ECH path failed for {host}; falling back: {err}");
                Ok(None)
            }
        }
    }

    async fn open_ech_stream(
        &self,
        parsed: &Url,
        host: &str,
        port: u16,
        headers: Option<&HashMap<String, String>>,
        ech_config_list: Vec<u8>,
    ) -> Result<EchResponseStream, BypassError> {
        let tcp = connect_via_doh(&self.resolver, host, port).await?;

        let ech_config = EchConfig::new(
            EchConfigListBytes::from(ech_config_list),
            aws_lc_rs::hpke::ALL_SUPPORTED_SUITES,
        )
        .map_err(|e| BypassError::HttpError(format!("ECH config rejected by rustls: {e}")))?;

        let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let mut tls_config =
            ClientConfig::builder_with_provider(aws_lc_rs::default_provider().into())
                .with_ech(EchMode::from(ech_config))
                .map_err(|e| BypassError::HttpError(format!("ECH TLS setup failed: {e}")))?
                .with_root_certificates(roots)
                .with_no_client_auth();
        tls_config.alpn_protocols = vec![b"http/1.1".to_vec()];

        let server_name = ServerName::try_from(host.to_string())
            .map_err(|e| BypassError::HttpError(format!("Invalid ECH server name {host}: {e}")))?;
        let connector = TlsConnector::from(Arc::new(tls_config));
        let mut tls = connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| BypassError::HttpError(format!("ECH TLS handshake failed: {e}")))?;

        if tls.get_ref().1.ech_status() != EchStatus::Accepted {
            return Err(BypassError::HttpError(format!(
                "ECH was offered but not accepted by {host}"
            )));
        }

        let request = build_get_request(parsed, host, port, headers)?;
        tls.write_all(request.as_bytes()).await?;
        tls.flush().await?;

        let (status, headers, body_mode, initial_body) = read_http_head(&mut tls).await?;
        Ok(EchResponseStream {
            status,
            headers,
            body: BodyChunkReader::new(tls, initial_body, body_mode),
        })
    }
}

struct EchResponseStream {
    status: u16,
    headers: HashMap<String, String>,
    body: BodyChunkReader<RustlsTlsStream>,
}

async fn connect_via_doh(
    resolver: &DohResolver,
    host: &str,
    port: u16,
) -> Result<TcpStream, BypassError> {
    let ips = resolver.resolve_all(host).await?;
    let mut last_err = None;

    for ip in &ips {
        match TcpStream::connect(format!("{ip}:{port}")).await {
            Ok(stream) => {
                stream.set_nodelay(true)?;
                return Ok(stream);
            }
            Err(err) => {
                last_err = Some(format!("{ip}:{port}: {err}"));
            }
        }
    }

    Err(BypassError::ProxyError(format!(
        "Failed to connect to {host}:{port} via DoH IPs [{}]: {}",
        ips.join(", "),
        last_err.unwrap_or_else(|| "no addresses attempted".into())
    )))
}

fn build_get_request(
    url: &Url,
    host: &str,
    port: u16,
    headers: Option<&HashMap<String, String>>,
) -> Result<String, BypassError> {
    let path = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => {
            if url.path().is_empty() {
                "/".to_string()
            } else {
                url.path().to_string()
            }
        }
    };
    let host_header = if port == 443 {
        host.to_string()
    } else {
        format!("{host}:{port}")
    };

    let mut request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\nAccept-Encoding: identity\r\n"
    );

    if let Some(headers) = headers {
        for (key, value) in headers {
            if should_skip_header(key, value) {
                continue;
            }
            request.push_str(key);
            request.push_str(": ");
            request.push_str(value);
            request.push_str("\r\n");
        }
    }

    request.push_str("\r\n");
    Ok(request)
}

fn should_skip_header(key: &str, value: &str) -> bool {
    key.eq_ignore_ascii_case("host")
        || key.eq_ignore_ascii_case("connection")
        || key.eq_ignore_ascii_case("accept-encoding")
        || key
            .as_bytes()
            .iter()
            .any(|byte| matches!(byte, b'\r' | b'\n'))
        || value
            .as_bytes()
            .iter()
            .any(|byte| matches!(byte, b'\r' | b'\n'))
}

async fn read_http_head<R>(
    reader: &mut R,
) -> Result<(u16, HashMap<String, String>, BodyMode, Vec<u8>), BypassError>
where
    R: AsyncRead + Unpin,
{
    let mut raw = Vec::new();
    let mut buf = [0u8; READ_CHUNK_SIZE];

    loop {
        if let Some(header_end) = find_header_end(&raw) {
            let header_bytes = &raw[..header_end];
            let initial_body = raw[header_end + 4..].to_vec();
            let (status, headers) = parse_http_head(header_bytes)?;
            let body_mode = body_mode(&headers)?;
            return Ok((status, headers, body_mode, initial_body));
        }

        if raw.len() >= MAX_HEADER_BYTES {
            return Err(BypassError::HttpError(format!(
                "ECH HTTP headers exceeded {MAX_HEADER_BYTES} bytes"
            )));
        }

        let n = reader.read(&mut buf).await?;
        if n == 0 {
            return Err(BypassError::HttpError(
                "ECH HTTP response ended before headers completed".into(),
            ));
        }
        raw.extend_from_slice(&buf[..n]);
    }
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_http_head(header_bytes: &[u8]) -> Result<(u16, HashMap<String, String>), BypassError> {
    let header_text = std::str::from_utf8(header_bytes)
        .map_err(|e| BypassError::HttpError(format!("ECH HTTP headers were not UTF-8: {e}")))?;

    let mut lines = header_text.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| BypassError::HttpError("ECH HTTP response had no status line".into()))?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| {
            BypassError::HttpError(format!("Invalid ECH HTTP status line: {status_line}"))
        })?
        .parse::<u16>()
        .map_err(|e| BypassError::HttpError(format!("Invalid ECH HTTP status code: {e}")))?;

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    Ok((status, headers))
}

fn body_mode(headers: &HashMap<String, String>) -> Result<BodyMode, BypassError> {
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
    {
        return Ok(BodyMode::Chunked {
            remaining_in_chunk: 0,
            expect_crlf: false,
        });
    }

    if let Some(value) = headers.get("content-length") {
        let remaining = value
            .parse::<usize>()
            .map_err(|e| BypassError::HttpError(format!("Invalid Content-Length: {e}")))?;
        return Ok(BodyMode::ContentLength { remaining });
    }

    Ok(BodyMode::UntilEof)
}

enum BodyMode {
    Chunked {
        remaining_in_chunk: usize,
        expect_crlf: bool,
    },
    ContentLength {
        remaining: usize,
    },
    UntilEof,
    Done,
}

struct BodyChunkReader<R> {
    reader: R,
    pending: Vec<u8>,
    mode: BodyMode,
}

impl<R> BodyChunkReader<R>
where
    R: AsyncRead + Unpin,
{
    fn new(reader: R, pending: Vec<u8>, mode: BodyMode) -> Self {
        Self {
            reader,
            pending,
            mode,
        }
    }

    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, BypassError> {
        match std::mem::replace(&mut self.mode, BodyMode::Done) {
            BodyMode::ContentLength { mut remaining } => {
                if remaining == 0 {
                    return Ok(None);
                }

                if !self.fill_pending_if_empty().await? {
                    return Err(BypassError::HttpError(
                        "ECH HTTP body ended before Content-Length was satisfied".into(),
                    ));
                }

                let n = remaining.min(self.pending.len()).min(READ_CHUNK_SIZE);
                let chunk = self.drain_pending(n);
                remaining -= n;
                self.mode = BodyMode::ContentLength { remaining };
                Ok(Some(chunk))
            }
            BodyMode::UntilEof => {
                if !self.fill_pending_if_empty().await? {
                    return Ok(None);
                }

                let n = self.pending.len().min(READ_CHUNK_SIZE);
                let chunk = self.drain_pending(n);
                self.mode = BodyMode::UntilEof;
                Ok(Some(chunk))
            }
            BodyMode::Chunked {
                mut remaining_in_chunk,
                mut expect_crlf,
            } => {
                if expect_crlf {
                    self.consume_crlf().await?;
                    expect_crlf = false;
                }

                if remaining_in_chunk == 0 {
                    let size_line = self.read_crlf_line().await?;
                    let size = parse_chunk_size(&size_line)?;
                    if size == 0 {
                        self.consume_trailers().await?;
                        return Ok(None);
                    }
                    remaining_in_chunk = size;
                }

                if !self.fill_pending_if_empty().await? {
                    return Err(BypassError::HttpError(
                        "Chunked ECH response ended mid-chunk".into(),
                    ));
                }

                let n = remaining_in_chunk
                    .min(self.pending.len())
                    .min(READ_CHUNK_SIZE);
                let chunk = self.drain_pending(n);
                remaining_in_chunk -= n;
                if remaining_in_chunk == 0 {
                    expect_crlf = true;
                }

                self.mode = BodyMode::Chunked {
                    remaining_in_chunk,
                    expect_crlf,
                };
                Ok(Some(chunk))
            }
            BodyMode::Done => Ok(None),
        }
    }

    async fn fill_pending_if_empty(&mut self) -> Result<bool, BypassError> {
        if !self.pending.is_empty() {
            return Ok(true);
        }
        self.read_more().await
    }

    async fn ensure_pending(&mut self, len: usize) -> Result<bool, BypassError> {
        while self.pending.len() < len {
            if !self.read_more().await? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    async fn read_more(&mut self) -> Result<bool, BypassError> {
        let mut buf = [0u8; READ_CHUNK_SIZE];
        let n = self.reader.read(&mut buf).await?;
        if n == 0 {
            return Ok(false);
        }
        self.pending.extend_from_slice(&buf[..n]);
        Ok(true)
    }

    async fn read_crlf_line(&mut self) -> Result<Vec<u8>, BypassError> {
        loop {
            if let Some(line_end) = self.pending.windows(2).position(|window| window == b"\r\n") {
                let mut line = self.drain_pending(line_end + 2);
                line.truncate(line_end);
                return Ok(line);
            }

            if self.pending.len() > MAX_CHUNK_LINE_BYTES {
                return Err(BypassError::HttpError(format!(
                    "ECH chunk line exceeded {MAX_CHUNK_LINE_BYTES} bytes"
                )));
            }

            if !self.read_more().await? {
                return Err(BypassError::HttpError(
                    "Chunked ECH response ended before line terminator".into(),
                ));
            }
        }
    }

    async fn consume_crlf(&mut self) -> Result<(), BypassError> {
        if !self.ensure_pending(2).await? {
            return Err(BypassError::HttpError(
                "Chunked ECH response ended before chunk terminator".into(),
            ));
        }

        let crlf = self.drain_pending(2);
        if crlf != b"\r\n" {
            return Err(BypassError::HttpError(
                "Chunked ECH response chunk missing CRLF terminator".into(),
            ));
        }
        Ok(())
    }

    async fn consume_trailers(&mut self) -> Result<(), BypassError> {
        loop {
            let line = self.read_crlf_line().await?;
            if line.is_empty() {
                return Ok(());
            }
        }
    }

    fn drain_pending(&mut self, len: usize) -> Vec<u8> {
        self.pending.drain(..len).collect()
    }
}

fn parse_chunk_size(line: &[u8]) -> Result<usize, BypassError> {
    let line = std::str::from_utf8(line)
        .map_err(|e| BypassError::HttpError(format!("Invalid chunk size line: {e}")))?;
    let size_hex = line.split(';').next().unwrap_or("").trim();
    usize::from_str_radix(size_hex, 16)
        .map_err(|e| BypassError::HttpError(format!("Invalid chunk size: {e}")))
}

#[cfg(test)]
mod tests {
    use super::{build_get_request, read_http_head, BodyChunkReader};
    use crate::{BypassError, BypassResponse};
    use std::collections::HashMap;
    use tokio::io::AsyncWriteExt;
    use url::Url;

    #[tokio::test]
    async fn parses_content_length_response() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Test: yes\r\n\r\nok".to_vec();
        let parsed = parse_raw_response(response).await.unwrap();

        assert_eq!(parsed.status, 200);
        assert_eq!(
            parsed.headers.get("x-test").map(String::as_str),
            Some("yes")
        );
        assert_eq!(parsed.body, b"ok");
    }

    #[tokio::test]
    async fn decodes_chunked_response() {
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nwiki\r\n5\r\npedia\r\n0\r\n\r\n".to_vec();
        let parsed = parse_raw_response(response).await.unwrap();

        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.body, b"wikipedia");
    }

    #[tokio::test]
    async fn streams_until_eof_without_content_length() {
        let response = b"HTTP/1.1 200 OK\r\nX-Test: yes\r\n\r\nhello".to_vec();
        let parsed = parse_raw_response(response).await.unwrap();

        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.body, b"hello");
    }

    #[test]
    fn build_get_request_forces_identity_encoding_and_skips_hop_headers() {
        let mut headers = HashMap::new();
        headers.insert("User-Agent".to_string(), "HiPaGo".to_string());
        headers.insert("Accept-Encoding".to_string(), "gzip".to_string());
        headers.insert("X-Bad".to_string(), "ok\r\nInjected: yes".to_string());
        let url = Url::parse("https://hitomi.la/allartists-a.html?x=1").unwrap();

        let request = build_get_request(&url, "hitomi.la", 443, Some(&headers)).unwrap();

        assert!(request.starts_with("GET /allartists-a.html?x=1 HTTP/1.1\r\n"));
        assert!(request.contains("Host: hitomi.la\r\n"));
        assert!(request.contains("Accept-Encoding: identity\r\n"));
        assert!(request.contains("User-Agent: HiPaGo\r\n"));
        assert!(!request.contains("gzip"));
        assert!(!request.contains("Injected"));
    }

    #[tokio::test]
    #[ignore = "live network test for real ECH acceptance"]
    async fn accepts_live_cloudflare_ech() {
        let client = super::EchHttpClient::new();
        let mut headers = HashMap::new();
        headers.insert("User-Agent".to_string(), "Mozilla/5.0".to_string());

        let response = client
            .fetch("https://cloudflare-ech.com/", Some(&headers))
            .await
            .expect("ECH fetch should not error")
            .expect("cloudflare-ech.com should publish and accept ECH");

        assert!(response.status < 500);
        assert!(!response.body.is_empty());
    }

    async fn parse_raw_response(raw: Vec<u8>) -> Result<BypassResponse, BypassError> {
        let (mut client, mut server) = tokio::io::duplex(raw.len() + 1);
        let writer = tokio::spawn(async move {
            server.write_all(&raw).await.unwrap();
        });

        let (status, headers, body_mode, initial_body) = read_http_head(&mut client).await?;
        let mut body = BodyChunkReader::new(client, initial_body, body_mode);
        let mut body_bytes = Vec::new();
        while let Some(chunk) = body.next_chunk().await? {
            body_bytes.extend_from_slice(&chunk);
        }
        let _ = writer.await;

        Ok(BypassResponse {
            status,
            headers,
            body: body_bytes,
        })
    }
}
