use bypass_core::BypassClient;
use std::collections::HashMap;

fn headers() -> HashMap<String, String> {
    let mut h = HashMap::new();
    h.insert("User-Agent".into(), "Mozilla/5.0".into());
    h.insert("Referer".into(), "https://hitomi.la/".into());
    h.insert("Origin".into(), "https://hitomi.la".into());
    h
}

/// download_to_file streams a real CDN response straight to disk and the file on
/// disk matches the returned byte count (no in-memory buffering of the whole body).
#[tokio::test]
async fn download_to_file_streams_to_disk() {
    let client = BypassClient::new().await.expect("Failed to create client");
    let dest = std::env::temp_dir().join("hipago-dl-stream-test.bin");
    let _ = std::fs::remove_file(&dest);

    let written = client
        .download_to_file(
            "https://ltn.gold-usergeneratedcontent.net/gg.js",
            Some(headers()),
            dest.to_str().unwrap(),
        )
        .await;

    match &written {
        Ok(n) => println!("[download_to_file] wrote {n} bytes to {}", dest.display()),
        Err(e) => println!("[download_to_file] ERROR: {e}"),
    }
    let n = written.expect("download_to_file should succeed");
    assert!(n > 0, "expected a non-empty body, wrote {n}");
    let meta = std::fs::metadata(&dest).expect("destination file should exist");
    assert_eq!(meta.len(), n, "on-disk size must equal the returned byte count");
    // No partial temp file left behind.
    assert!(!dest.with_extension("bin.part").exists());

    let _ = std::fs::remove_file(&dest);
    client.shutdown().await;
}

/// A non-2xx response errors and never leaves a (truncated) destination file that
/// would later read as a valid cache hit.
#[tokio::test]
async fn download_to_file_errors_and_cleans_up_on_404() {
    let client = BypassClient::new().await.expect("Failed to create client");
    let dest = std::env::temp_dir().join("hipago-dl-404-test.bin");
    let _ = std::fs::remove_file(&dest);

    let res = client
        .download_to_file(
            "https://ltn.gold-usergeneratedcontent.net/this-path-does-not-exist-hipago.js",
            Some(headers()),
            dest.to_str().unwrap(),
        )
        .await;

    println!("[download_to_file 404] result = {res:?}");
    assert!(res.is_err(), "a non-2xx response must error");
    assert!(!dest.exists(), "no destination file may be left behind on error");
    assert!(!std::path::Path::new(&format!("{}.part", dest.display())).exists());

    client.shutdown().await;
}
