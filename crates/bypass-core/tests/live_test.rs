use bypass_core::BypassClient;
use std::collections::HashMap;

#[tokio::test]
async fn test_hitomi_access() {
    let client = BypassClient::new().await.expect("Failed to create client");

    // Test 1: hitomi.la main page
    let mut h1 = HashMap::new();
    h1.insert("User-Agent".into(), "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36".into());
    h1.insert("Referer".into(), "https://hitomi.la/".into());

    let resp = client.fetch("https://hitomi.la/", Some(h1)).await;
    match &resp {
        Ok(r) => println!("[hitomi.la] status={}, body_len={}", r.status, r.body.len()),
        Err(e) => println!("[hitomi.la] ERROR: {e}"),
    }
    assert!(resp.is_ok(), "hitomi.la: {:?}", resp.err());
    let r = resp.unwrap();
    assert_eq!(r.status, 200);
    assert!(r.body.len() > 1000);

    // Test 2: tagindex.hitomi.la
    let mut h2 = HashMap::new();
    h2.insert("User-Agent".into(), "Mozilla/5.0".into());
    h2.insert("Referer".into(), "https://hitomi.la/".into());
    h2.insert("Origin".into(), "https://hitomi.la".into());

    let resp2 = client.fetch("https://tagindex.hitomi.la/", Some(h2)).await;
    match &resp2 {
        Ok(r) => println!(
            "[tagindex.hitomi.la] status={}, body_len={}",
            r.status,
            r.body.len()
        ),
        Err(e) => println!("[tagindex.hitomi.la] ERROR: {e}"),
    }
    assert!(resp2.is_ok(), "tagindex.hitomi.la: {:?}", resp2.err());

    // Test 3: gold-usergeneratedcontent.net CDN (gg.js)
    let mut h3 = HashMap::new();
    h3.insert("User-Agent".into(), "Mozilla/5.0".into());
    h3.insert("Referer".into(), "https://hitomi.la/".into());
    h3.insert("Origin".into(), "https://hitomi.la".into());

    let resp3 = client
        .fetch("https://ltn.gold-usergeneratedcontent.net/gg.js", Some(h3))
        .await;
    match &resp3 {
        Ok(r) => {
            let body_str = String::from_utf8_lossy(&r.body);
            println!(
                "[CDN gg.js] status={}, body_len={}, preview={}...",
                r.status,
                r.body.len(),
                &body_str[..body_str.len().min(200)]
            );
        }
        Err(e) => println!("[CDN gg.js] ERROR: {e}"),
    }
    assert!(resp3.is_ok(), "CDN gg.js: {:?}", resp3.err());
    let r3 = resp3.unwrap();
    assert_eq!(r3.status, 200, "CDN gg.js status: {}", r3.status);

    client.shutdown().await;
    println!("All 3 domains passed!");
}

#[tokio::test]
async fn test_cloudflare_ech_access() {
    let client = BypassClient::new().await.expect("Failed to create client");

    let mut headers = HashMap::new();
    headers.insert("User-Agent".into(), "Mozilla/5.0".into());

    let resp = client
        .fetch("https://cloudflare-ech.com/", Some(headers))
        .await;
    match &resp {
        Ok(r) => println!(
            "[cloudflare-ech.com] status={}, body_len={}",
            r.status,
            r.body.len()
        ),
        Err(e) => println!("[cloudflare-ech.com] ERROR: {e}"),
    }
    assert!(resp.is_ok(), "cloudflare-ech.com: {:?}", resp.err());

    client.shutdown().await;
}
