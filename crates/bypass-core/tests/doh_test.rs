use bypass_core::doh::DohResolver;
use std::time::Instant;

#[tokio::test]
async fn resolves_known_domain() {
    let resolver = DohResolver::new();
    let ip = resolver.resolve("cloudflare.com").await;
    assert!(ip.is_ok(), "Failed to resolve cloudflare.com: {:?}", ip.err());
    let ip = ip.unwrap();
    // Should be a valid IPv4 address
    assert!(
        ip.split('.').count() == 4,
        "Expected IPv4 address, got: {ip}"
    );
    for octet in ip.split('.') {
        let n: u32 = octet.parse().expect("Invalid octet");
        assert!(n <= 255, "Octet out of range: {n}");
    }
}

#[tokio::test]
async fn caches_results() {
    let resolver = DohResolver::new();

    // First call — hits network
    let start = Instant::now();
    let ip1 = resolver.resolve("example.com").await.unwrap();
    let first_duration = start.elapsed();

    // Second call — should hit cache (much faster)
    let start = Instant::now();
    let ip2 = resolver.resolve("example.com").await.unwrap();
    let second_duration = start.elapsed();

    assert_eq!(ip1, ip2, "Cached IP should match");
    assert!(
        second_duration < first_duration / 2,
        "Cache hit should be much faster: first={:?}, second={:?}",
        first_duration,
        second_duration
    );
}

#[tokio::test]
async fn different_domains_resolve_to_different_ips() {
    let resolver = DohResolver::new();
    let ip1 = resolver.resolve("cloudflare.com").await.unwrap();
    let ip2 = resolver.resolve("example.com").await.unwrap();
    // These are almost certainly different IPs
    // (not guaranteed but extremely likely)
    assert_ne!(ip1, ip2, "Different domains should resolve to different IPs");
}

#[tokio::test]
async fn returns_error_for_nonexistent_domain() {
    let resolver = DohResolver::new();
    let result = resolver
        .resolve("this-domain-does-not-exist-12345.invalid")
        .await;
    assert!(result.is_err(), "Should fail for nonexistent domain");
}

#[tokio::test]
async fn concurrent_requests_for_same_domain() {
    let resolver = DohResolver::new();

    // Launch multiple concurrent requests for the same domain
    let mut handles = Vec::new();
    for _ in 0..5 {
        let r = resolver.clone();
        handles.push(tokio::spawn(async move {
            r.resolve("google.com").await
        }));
    }

    let mut results = Vec::new();
    for h in handles {
        results.push(h.await.unwrap());
    }

    // All should succeed with the same IP
    let first = results[0].as_ref().unwrap().clone();
    for (i, r) in results.iter().enumerate() {
        assert!(r.is_ok(), "Request {i} failed: {:?}", r.as_ref().err());
        assert_eq!(r.as_ref().unwrap(), &first, "All should resolve to same IP");
    }
}
