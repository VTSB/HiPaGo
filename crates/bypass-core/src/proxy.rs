//! In-process SOCKS5 proxy with DoH resolution and TLS ClientHello fragmentation.
//!
//! This lightweight proxy sits between the rquest HTTP client and the target server.
//! It handles:
//! 1. DNS resolution via DoH (bypasses ISP DNS poisoning)
//! 2. TCP connection with nodelay (ensures separate TCP segments)
//! 3. First-write fragmentation (splits TLS ClientHello at byte 5 to defeat SNI-based DPI)

use crate::doh::DohResolver;
use crate::BypassError;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

const SPLIT_POINT: usize = 5; // Split after 5-byte TLS record header

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
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let shutdown = Arc::new(Notify::new());
    let resolver = DohResolver::new();

    let shutdown_clone = shutdown.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, _)) => {
                            let resolver = resolver.clone();
                            tokio::spawn(handle_client(stream, resolver));
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
async fn handle_client(mut client: TcpStream, resolver: DohResolver) {
    if let Err(e) = handle_client_inner(&mut client, &resolver).await {
        eprintln!("[bypass-proxy] connection error: {e}");
    }
}

async fn handle_client_inner(
    client: &mut TcpStream,
    resolver: &DohResolver,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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

    // --- Resolve DNS via DoH ---
    let resolved_ip = if atyp == 0x03 {
        // Domain name — resolve via DoH
        resolver
            .resolve(&hostname)
            .await
            .map_err(|e| format!("DoH resolution failed for {hostname}: {e}"))?
    } else {
        // Already an IP
        hostname.clone()
    };

    // --- Connect to target ---
    let mut target = match TcpStream::connect(format!("{resolved_ip}:{port}")).await {
        Ok(stream) => stream,
        Err(e) => {
            // Send connection refused reply
            client
                .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await?;
            return Err(format!("Failed to connect to {resolved_ip}:{port}: {e}").into());
        }
    };

    // Set TCP_NODELAY to ensure each write becomes a separate TCP segment
    target.set_nodelay(true)?;

    // --- Send SOCKS5 success reply ---
    // Use 0.0.0.0:0 as bound address (doesn't matter for CONNECT)
    client
        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await?;

    // --- Bidirectional relay with first-write fragmentation ---
    relay_with_fragmentation(client, &mut target).await?;

    Ok(())
}

/// Bidirectional relay between client and target.
/// The first write from client to target (TLS ClientHello) is fragmented at byte 5.
async fn relay_with_fragmentation(
    client: &mut TcpStream,
    target: &mut TcpStream,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (mut client_read, mut client_write) = tokio::io::split(client);
    let (mut target_read, mut target_write) = tokio::io::split(target);

    // Client → Target (with fragmentation on first write)
    let client_to_target = async move {
        let mut buf = vec![0u8; 65536];
        let mut first_write = true;

        loop {
            let n = match client_read.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::ConnectionReset {
                        break;
                    }
                    return Err(e);
                }
            };

            if first_write && n > SPLIT_POINT {
                first_write = false;
                // Fragment: split at byte 5 (after TLS record header)
                target_write.write_all(&buf[..SPLIT_POINT]).await?;
                target_write.flush().await?;
                target_write.write_all(&buf[SPLIT_POINT..n]).await?;
                target_write.flush().await?;
            } else {
                first_write = false;
                target_write.write_all(&buf[..n]).await?;
            }
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

    // Run both directions concurrently
    tokio::select! {
        result = client_to_target => { result?; }
        result = target_to_client => { result?; }
    }

    Ok(())
}
