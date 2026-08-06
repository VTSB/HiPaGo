use bypass_core::proxy;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[tokio::test]
async fn proxy_starts_and_listens() {
    let handle = proxy::start_proxy().await.expect("Failed to start proxy");
    let port = handle.port();
    assert!(port > 0, "Proxy should bind to a valid port");

    // Should be able to connect
    let stream = TcpStream::connect(format!("127.0.0.1:{port}")).await;
    assert!(stream.is_ok(), "Should connect to proxy");

    handle.shutdown().await;
}

#[tokio::test]
async fn proxy_rejects_non_socks5() {
    let handle = proxy::start_proxy().await.unwrap();
    let port = handle.port();

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();

    // Send invalid SOCKS version (0x04 instead of 0x05)
    stream.write_all(&[0x04, 0x01, 0x00]).await.unwrap();

    // Proxy should close/reset the connection for non-SOCKS5
    let mut buf = [0u8; 10];
    let result = stream.read(&mut buf).await;
    match result {
        Ok(0) => {} // Clean close
        Err(_) => {} // Connection reset — also acceptable
        Ok(n) => panic!("Expected connection close, got {n} bytes"),
    }

    handle.shutdown().await;
}

#[tokio::test]
async fn proxy_handles_socks5_handshake() {
    let handle = proxy::start_proxy().await.unwrap();
    let port = handle.port();

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();

    // SOCKS5 greeting: version 5, 1 auth method (no auth)
    stream.write_all(&[0x05, 0x01, 0x00]).await.unwrap();

    // Should respond with version 5, no auth required
    let mut buf = [0u8; 2];
    stream.read_exact(&mut buf).await.unwrap();
    assert_eq!(buf, [0x05, 0x00], "Should respond: SOCKS5, no auth");

    handle.shutdown().await;
}

#[tokio::test]
async fn proxy_connects_to_target_via_domain() {
    let handle = proxy::start_proxy().await.unwrap();
    let port = handle.port();

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();

    // SOCKS5 handshake
    stream.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
    let mut buf = [0u8; 2];
    stream.read_exact(&mut buf).await.unwrap();
    assert_eq!(buf, [0x05, 0x00]);

    // CONNECT request to example.com:80 (domain type 0x03)
    let domain = b"example.com";
    let mut connect_req = vec![
        0x05, // SOCKS version
        0x01, // CONNECT command
        0x00, // Reserved
        0x03, // Address type: domain
        domain.len() as u8,
    ];
    connect_req.extend_from_slice(domain);
    connect_req.extend_from_slice(&80u16.to_be_bytes()); // Port 80
    stream.write_all(&connect_req).await.unwrap();

    // Read SOCKS5 reply
    let mut reply = [0u8; 10];
    stream.read_exact(&mut reply).await.unwrap();
    assert_eq!(reply[0], 0x05, "SOCKS5 version");
    assert_eq!(reply[1], 0x00, "Success status (0x00)");

    // Connection established — send HTTP request
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();

    // Read HTTP response
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let response_str = String::from_utf8_lossy(&response);
    assert!(
        response_str.contains("HTTP/1.1"),
        "Should get HTTP response, got: {}",
        &response_str[..response_str.len().min(100)]
    );

    handle.shutdown().await;
}

#[tokio::test]
async fn proxy_returns_error_for_unreachable_host() {
    let handle = proxy::start_proxy().await.unwrap();
    let port = handle.port();

    let mut stream = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();

    // Handshake
    stream.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
    let mut buf = [0u8; 2];
    stream.read_exact(&mut buf).await.unwrap();

    // CONNECT to a domain that won't resolve
    let domain = b"this-domain-does-not-exist-xyz.invalid";
    let mut connect_req = vec![0x05, 0x01, 0x00, 0x03, domain.len() as u8];
    connect_req.extend_from_slice(domain);
    connect_req.extend_from_slice(&443u16.to_be_bytes());
    stream.write_all(&connect_req).await.unwrap();

    // Should get a failure reply (status != 0x00) or connection closed
    let mut reply = [0u8; 10];
    let result = stream.read_exact(&mut reply).await;
    if let Ok(_) = result {
        assert_ne!(reply[1], 0x00, "Should not succeed for invalid domain");
    }
    // Connection closed is also acceptable

    handle.shutdown().await;
}
