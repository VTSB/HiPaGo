//! In-process SOCKS5 proxy with DoH resolution and TLS ClientHello fragmentation.
//!
//! This lightweight proxy sits between the rquest HTTP client and the target server.
//! It handles:
//! 1. DNS resolution via DoH (bypasses ISP DNS poisoning)
//! 2. TCP connection with nodelay (ensures separate TCP segments)
//! 3. First-write fragmentation (splits TLS ClientHello at byte 5 to defeat SNI-based DPI)

use crate::connect::connect_to_ips;
use crate::doh::DohResolver;
use crate::BypassError;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::{timeout_at, Instant};

// Split TLS ClientHello at the record header boundary (byte 5).
// Fragment 1 = 5-byte TLS record header (content type, version, length) — too small for DPI to inspect.
// Fragment 2 = rest of ClientHello after delay — DPI reassembly timeout has expired.
// This is more robust than splitting at a fixed SNI offset (~120) which varies by TLS implementation.
// Strategy matches GoodbyeDPI / zapret proven approach.
const FIRST_SPLIT: usize = 5;
const FRAGMENT_DELAY_MS: u64 = 200;
const MAX_FRAGMENTED_HANDSHAKES: usize = 4;
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Handle to the running SOCKS5 proxy.
pub struct ProxyHandle {
    port: u16,
    shutdown: Arc<Notify>,
}

impl ProxyHandle {
    /// Get the port the proxy is listening on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Signal the proxy to shut down.
    pub async fn shutdown(&self) {
        self.shutdown.notify_waiters();
    }
}

/// Start the in-process SOCKS5 proxy on a random port.
pub async fn start_proxy() -> Result<ProxyHandle, BypassError> {
    start_proxy_with_resolver(DohResolver::new()).await
}

pub(crate) async fn start_proxy_with_resolver(
    resolver: DohResolver,
) -> Result<ProxyHandle, BypassError> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let shutdown = Arc::new(Notify::new());
    let fragment_slots = Arc::new(Semaphore::new(MAX_FRAGMENTED_HANDSHAKES));

    let shutdown_clone = shutdown.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, _)) => {
                            let deadline = Instant::now() + SETUP_TIMEOUT;
                            let resolver = resolver.clone();
                            let fragment_slots = fragment_slots.clone();
                            tokio::spawn(handle_client(stream, resolver, fragment_slots, deadline));
                        }
                        Err(e) => {
                            eprintln!("[bypass-proxy] accept error: {e}");
                        }
                    }
                }
                _ = shutdown_clone.notified() => {
                    break;
                }
            }
        }
    });

    Ok(ProxyHandle { port, shutdown })
}

/// Handle a single SOCKS5 client connection.
async fn handle_client(
    mut client: TcpStream,
    resolver: DohResolver,
    fragment_slots: Arc<Semaphore>,
    deadline: Instant,
) {
    if let Err(e) = handle_client_inner(&mut client, &resolver, fragment_slots, deadline).await {
        eprintln!("[bypass-proxy] connection error: {e}");
    }
}

async fn handle_client_inner(
    client: &mut TcpStream,
    resolver: &DohResolver,
    fragment_slots: Arc<Semaphore>,
    deadline: Instant,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (mut target, fragment_permit) = timeout_at(
        deadline,
        setup_client(client, resolver, fragment_slots, deadline),
    )
    .await
    .map_err(|_| setup_timeout())??;
    relay_with_fragmentation(client, &mut target, fragment_permit, deadline).await
}

fn setup_timeout() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::TimedOut, "SOCKS setup timed out")
}

/// Watch without consuming a pipelined ClientHello/request. Buffered bytes can
/// hide a FIN, so this ambiguous case remains bounded by the setup deadline.
async fn client_eof(client: &TcpStream) -> std::io::Result<()> {
    let mut byte = [0; 1];
    if client.peek(&mut byte).await? == 0 {
        return Ok(());
    }
    std::future::pending().await
}

async fn setup_client(
    client: &mut TcpStream,
    resolver: &DohResolver,
    fragment_slots: Arc<Semaphore>,
    deadline: Instant,
) -> Result<(TcpStream, Option<OwnedSemaphorePermit>), Box<dyn std::error::Error + Send + Sync>> {
    // --- SOCKS5 Handshake ---

    // Read version + nmethods
    let mut buf = [0u8; 2];
    client.read_exact(&mut buf).await?;

    if buf[0] != 0x05 {
        return Err("Not SOCKS5".into());
    }

    let nmethods = buf[1] as usize;
    let mut methods = vec![0u8; nmethods];
    client.read_exact(&mut methods).await?;

    // Reply: no authentication required
    client.write_all(&[0x05, 0x00]).await?;

    // --- SOCKS5 Connect Request ---
    // +----+-----+-------+------+----------+----------+
    // |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
    // +----+-----+-------+------+----------+----------+
    let mut header = [0u8; 4];
    client.read_exact(&mut header).await?;

    if header[0] != 0x05 || header[1] != 0x01 {
        // Only CONNECT (0x01) is supported
        // Send general failure reply
        client
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await?;
        return Err("Only CONNECT command supported".into());
    }

    let atyp = header[3];
    let hostname: String;
    let port: u16;

    match atyp {
        0x01 => {
            // IPv4
            let mut addr = [0u8; 4];
            client.read_exact(&mut addr).await?;
            let mut port_buf = [0u8; 2];
            client.read_exact(&mut port_buf).await?;
            port = u16::from_be_bytes(port_buf);
            hostname = format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3]);
        }
        0x03 => {
            // Domain name
            let mut len_buf = [0u8; 1];
            client.read_exact(&mut len_buf).await?;
            let domain_len = len_buf[0] as usize;
            let mut domain = vec![0u8; domain_len];
            client.read_exact(&mut domain).await?;
            let mut port_buf = [0u8; 2];
            client.read_exact(&mut port_buf).await?;
            port = u16::from_be_bytes(port_buf);
            hostname = String::from_utf8(domain)?;
        }
        0x04 => {
            // IPv6
            let mut addr = [0u8; 16];
            client.read_exact(&mut addr).await?;
            let mut port_buf = [0u8; 2];
            client.read_exact(&mut port_buf).await?;
            port = u16::from_be_bytes(port_buf);
            // Format IPv6
            let segments: Vec<String> = (0..8)
                .map(|i| format!("{:x}", u16::from_be_bytes([addr[i * 2], addr[i * 2 + 1]])))
                .collect();
            hostname = segments.join(":");
        }
        _ => {
            client
                .write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await?;
            return Err(format!("Unsupported address type: {atyp}").into());
        }
    }

    let connect = async {
        // --- Resolve DNS via DoH ---
        let resolved_ips = if atyp == 0x03 {
            // Domain name — resolve via DoH
            resolver
                .resolve_all(&hostname)
                .await
                .map_err(|e| format!("DoH resolution failed for {hostname}: {e}"))?
        } else {
            // Already an IP
            vec![hostname.clone()]
        };

        // Gate fragmented TLS handshakes before opening the upstream socket. Waiting
        // here holds only the local SOCKS connection, not a target TCP socket plus
        // relay buffers.
        let fragment_permit = if port == 443 {
            Some(fragment_slots.clone().acquire_owned().await.map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "fragment limiter closed")
            })?)
        } else {
            None
        };

        let target = connect_to_ips(&resolved_ips, port, deadline).await?;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>((target, fragment_permit))
    };
    let connected = tokio::select! {
        biased;
        result = client_eof(client) => {
            result?;
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted, "SOCKS caller disconnected during setup",
            ).into());
        }
        result = connect => result,
    };
    let (target, fragment_permit) = match connected {
        Ok(connected) => connected,
        Err(error) => {
            // Send connection refused reply
            client
                .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await?;
            return Err(error);
        }
    };

    // --- Send SOCKS5 success reply ---
    // Use 0.0.0.0:0 as bound address (doesn't matter for CONNECT)
    client
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await?;

    Ok((target, fragment_permit))
}

/// Bidirectional relay between client and target.
/// The first write from client to target (TLS ClientHello) is fragmented at the TLS record header boundary.
async fn relay_with_fragmentation(
    client: &mut TcpStream,
    target: &mut TcpStream,
    fragment_permit: Option<OwnedSemaphorePermit>,
    deadline: Instant,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (mut client_read, mut client_write) = tokio::io::split(client);
    let (mut target_read, mut target_write) = tokio::io::split(target);

    // Client → Target (with fragmentation on first write)
    let client_to_target = async move {
        let mut buf = vec![0u8; 65536];
        let first_write = async {
            // Ownership ends after the first forwarded write, including the
            // fragment delay. Cancellation/deadline drops the permit as well.
            let permit = fragment_permit;
            let n = match client_read.read(&mut buf).await {
                Ok(n) => n,
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::ConnectionReset {
                        return Ok(0);
                    }
                    return Err(e);
                }
            };

            if permit.is_some() && is_tls_client_hello(&buf[..n]) {
                // Fragment 1: TLS record header only (5 bytes) — DPI can't extract SNI from this.
                target_write.write_all(&buf[..FIRST_SPLIT]).await?;
                target_write.flush().await?;
                // Delay exceeds DPI reassembly timeout.
                tokio::time::sleep(std::time::Duration::from_millis(FRAGMENT_DELAY_MS)).await;
                // Fragment 2: rest of ClientHello including SNI — DPI already gave up reassembly.
                target_write.write_all(&buf[FIRST_SPLIT..n]).await?;
                target_write.flush().await?;
            } else {
                target_write.write_all(&buf[..n]).await?;
            }
            Ok::<_, std::io::Error>(n)
        };
        let first_size = timeout_at(deadline, first_write)
            .await
            .map_err(|_| setup_timeout())??;
        if first_size > 0 {
            tokio::io::copy(&mut client_read, &mut target_write).await?;
        }
        target_write.shutdown().await?;
        Ok::<(), std::io::Error>(())
    };

    // Target → Client (straight relay, no fragmentation)
    let target_to_client = async move {
        let mut buf = vec![0u8; 65536];
        loop {
            let n = match target_read.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::ConnectionReset {
                        break;
                    }
                    return Err(e);
                }
            };
            client_write.write_all(&buf[..n]).await?;
        }
        client_write.shutdown().await?;
        Ok::<(), std::io::Error>(())
    };

    // Retain the existing termination rule: a closed caller must also release
    // an upstream read that might otherwise remain stalled indefinitely.
    tokio::select! {
        result = client_to_target => { result?; }
        result = target_to_client => { result?; }
    }

    Ok(())
}

fn is_tls_client_hello(buf: &[u8]) -> bool {
    buf.len() > FIRST_SPLIT
        // TLS handshake record
        && buf[0] == 0x16
        // TLS record version family (TLS 1.0-1.3 ClientHello records use 0x03xx)
        && buf[1] == 0x03
        // Handshake message type: ClientHello
        && buf[5] == 0x01
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{sleep, sleep_until, timeout};

    async fn socket_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (peer, accepted) = tokio::join!(
            TcpStream::connect(listener.local_addr().unwrap()),
            listener.accept()
        );
        let peer = peer.unwrap();
        let stream = accepted.unwrap().0;
        peer.set_nodelay(true).unwrap();
        stream.set_nodelay(true).unwrap();
        (peer, stream)
    }

    fn spawn_connection(
        mut client: TcpStream,
        slots: Arc<Semaphore>,
        deadline: Instant,
    ) -> tokio::task::JoinHandle<Result<(), Box<dyn std::error::Error + Send + Sync>>> {
        tokio::spawn(async move {
            handle_client_inner(&mut client, &DohResolver::new(), slots, deadline).await
        })
    }

    async fn request_connect(peer: &mut TcpStream, port: u16, pipeline: &[u8]) {
        peer.write_all(&[5, 1, 0]).await.unwrap();
        let mut auth = [0; 2];
        peer.read_exact(&mut auth).await.unwrap();
        assert_eq!(auth, [5, 0]);
        let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
        request.extend_from_slice(&port.to_be_bytes());
        request.extend_from_slice(pipeline);
        peer.write_all(&request).await.unwrap();
    }

    #[tokio::test]
    async fn negotiation_read_uses_the_setup_deadline() {
        let (_peer, client) = socket_pair().await;
        let task = spawn_connection(
            client,
            Arc::new(Semaphore::new(MAX_FRAGMENTED_HANDSHAKES)),
            Instant::now() + Duration::from_millis(50),
        );
        let error = timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("SOCKS setup timed out"));
    }

    #[tokio::test]
    async fn four_stalled_first_writes_release_all_fragment_permits() {
        let slots = Arc::new(Semaphore::new(MAX_FRAGMENTED_HANDSHAKES));
        let mut peers = Vec::new();
        let mut tasks = Vec::new();
        for _ in 0..MAX_FRAGMENTED_HANDSHAKES {
            let (peer, mut client) = socket_pair().await;
            let (upstream, mut target) = socket_pair().await;
            peers.push((peer, upstream));
            let permit = slots.clone().acquire_owned().await.unwrap();
            tasks.push(tokio::spawn(async move {
                relay_with_fragmentation(
                    &mut client,
                    &mut target,
                    Some(permit),
                    Instant::now() + Duration::from_millis(100),
                )
                .await
            }));
        }
        assert_eq!(slots.available_permits(), 0);
        for task in tasks {
            let error = timeout(Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert!(error.to_string().contains("SOCKS setup timed out"));
        }
        assert_eq!(slots.available_permits(), MAX_FRAGMENTED_HANDSHAKES);
        for (mut peer, mut upstream) in peers {
            assert_eq!(peer.read(&mut [0; 1]).await.unwrap(), 0);
            assert_eq!(upstream.read(&mut [0; 1]).await.unwrap(), 0);
        }
    }

    #[tokio::test]
    async fn disconnected_caller_cancels_queued_permit_wait() {
        let slots = Arc::new(Semaphore::new(MAX_FRAGMENTED_HANDSHAKES));
        let held = slots
            .clone()
            .acquire_many_owned(MAX_FRAGMENTED_HANDSHAKES as u32)
            .await
            .unwrap();
        let (mut peer, client) = socket_pair().await;
        let task = spawn_connection(
            client,
            slots.clone(),
            Instant::now() + Duration::from_secs(10),
        );
        request_connect(&mut peer, 443, &[]).await;
        sleep(Duration::from_millis(20)).await;
        assert!(!task.is_finished());
        peer.shutdown().await.unwrap();
        let error = timeout(Duration::from_millis(500), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.to_string().contains("caller disconnected"));
        drop(held);
        assert!(slots
            .try_acquire_many_owned(MAX_FRAGMENTED_HANDSHAKES as u32)
            .is_ok());
    }

    #[tokio::test]
    async fn buffered_half_close_is_bounded_without_discarding_pipelined_bytes() {
        let slots = Arc::new(Semaphore::new(MAX_FRAGMENTED_HANDSHAKES));
        let _held = slots
            .clone()
            .acquire_many_owned(MAX_FRAGMENTED_HANDSHAKES as u32)
            .await
            .unwrap();
        let (mut peer, client) = socket_pair().await;
        let task = spawn_connection(client, slots, Instant::now() + Duration::from_millis(150));
        request_connect(&mut peer, 443, b"pipelined request").await;
        peer.shutdown().await.unwrap();
        let error = timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(
            error.to_string().contains("SOCKS setup timed out"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn pipelined_request_bytes_are_forwarded_before_half_close_terminates_relay() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let upstream = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).await.unwrap();
            assert_eq!(request, b"pipelined request");
        });
        let (mut peer, client) = socket_pair().await;
        let task = spawn_connection(
            client,
            Arc::new(Semaphore::new(MAX_FRAGMENTED_HANDSHAKES)),
            Instant::now() + Duration::from_secs(2),
        );
        request_connect(&mut peer, port, b"pipelined request").await;
        peer.shutdown().await.unwrap();
        let mut response = Vec::new();
        timeout(Duration::from_secs(3), peer.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&response[..10], &[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(response.len(), 10);
        task.await.unwrap().unwrap();
        upstream.await.unwrap();
    }

    const HELLO: &[u8] = &[0x16, 0x03, 0x03, 0, 5, 0x01, 0, 0, 1, 0];

    #[tokio::test]
    async fn fragmentation_keeps_the_five_byte_gap_and_half_closed_tail() {
        let slots = Arc::new(Semaphore::new(MAX_FRAGMENTED_HANDSHAKES));
        let permit = slots.clone().acquire_owned().await.unwrap();
        let (mut peer, mut client) = socket_pair().await;
        let (mut upstream, mut target) = socket_pair().await;
        let task = tokio::spawn(async move {
            relay_with_fragmentation(
                &mut client,
                &mut target,
                Some(permit),
                Instant::now() + Duration::from_secs(2),
            )
            .await
        });
        peer.write_all(HELLO).await.unwrap();
        peer.shutdown().await.unwrap();
        let mut first = [0; FIRST_SPLIT];
        upstream.read_exact(&mut first).await.unwrap();
        assert_eq!(first, HELLO[..FIRST_SPLIT]);
        assert_eq!(slots.available_permits(), MAX_FRAGMENTED_HANDSHAKES - 1);
        assert!(
            timeout(Duration::from_millis(100), upstream.read(&mut [0; 1]))
                .await
                .is_err()
        );
        let mut tail = Vec::new();
        timeout(Duration::from_secs(1), upstream.read_to_end(&mut tail))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tail, HELLO[FIRST_SPLIT..]);
        assert_eq!(slots.available_permits(), MAX_FRAGMENTED_HANDSHAKES);
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn cancellation_during_fragment_delay_releases_permit_and_socket() {
        let slots = Arc::new(Semaphore::new(MAX_FRAGMENTED_HANDSHAKES));
        let permit = slots.clone().acquire_owned().await.unwrap();
        let (mut peer, mut client) = socket_pair().await;
        let (mut upstream, mut target) = socket_pair().await;
        let task = tokio::spawn(async move {
            relay_with_fragmentation(
                &mut client,
                &mut target,
                Some(permit),
                Instant::now() + Duration::from_secs(2),
            )
            .await
        });
        peer.write_all(HELLO).await.unwrap();
        upstream.read_exact(&mut [0; FIRST_SPLIT]).await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(slots.available_permits(), MAX_FRAGMENTED_HANDSHAKES);
        assert_eq!(upstream.read(&mut [0; 1]).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn established_relay_outlives_the_setup_deadline() {
        let (mut peer, mut client) = socket_pair().await;
        let (mut upstream, mut target) = socket_pair().await;
        let deadline = Instant::now() + Duration::from_millis(500);
        let task = tokio::spawn(async move {
            relay_with_fragmentation(&mut client, &mut target, None, deadline).await
        });
        peer.write_all(b"first").await.unwrap();
        let mut bytes = [0; 5];
        upstream.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"first");
        sleep_until(deadline + Duration::from_millis(20)).await;
        assert!(!task.is_finished());
        peer.write_all(b"later").await.unwrap();
        upstream.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"later");
        upstream.write_all(b"reply").await.unwrap();
        peer.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"reply");
        peer.shutdown().await.unwrap();
        upstream.shutdown().await.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn closed_caller_releases_an_established_but_stalled_upstream() {
        let (mut peer, mut client) = socket_pair().await;
        let (mut upstream, mut target) = socket_pair().await;
        let task = tokio::spawn(async move {
            relay_with_fragmentation(
                &mut client,
                &mut target,
                None,
                Instant::now() + Duration::from_secs(10),
            )
            .await
        });
        peer.write_all(b"first").await.unwrap();
        upstream.read_exact(&mut [0; 5]).await.unwrap();
        drop(peer);
        timeout(Duration::from_millis(500), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(upstream.read(&mut [0; 1]).await.unwrap(), 0);
    }

    #[test]
    fn detects_tls_client_hello_records() {
        let buf = [0x16, 0x03, 0x03, 0x02, 0x00, 0x01, 0x00];
        assert!(is_tls_client_hello(&buf));
    }

    #[test]
    fn rejects_http_first_writes() {
        assert!(!is_tls_client_hello(b"GET / HTTP/1.1\r\n"));
    }

    #[test]
    fn rejects_short_tls_record_headers() {
        assert!(!is_tls_client_hello(&[0x16, 0x03, 0x03, 0x02, 0x00]));
    }
}
