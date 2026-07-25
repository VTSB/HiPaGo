use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;
use tokio::sync::OnceCell;
use url::Url;

static CLIENT: OnceCell<bypass_core::BypassClient> = OnceCell::const_new();

const ALLOWED_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "origin",
    "range",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "user-agent",
];

fn validate_bypass_url(raw_url: &str) -> Result<(), String> {
    let parsed = Url::parse(raw_url).map_err(|e| format!("Invalid bypass URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("Bypass URL must use HTTPS.".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Bypass URL must not contain user information.".into());
    }
    if parsed.fragment().is_some() {
        return Err("Bypass URL must not contain a fragment.".into());
    }
    if parsed.port_or_known_default() != Some(443) {
        return Err("Bypass URL must use HTTPS port 443.".into());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "Bypass URL must contain a host.".to_string())?
        .to_ascii_lowercase();
    let allowed = host == "hitomi.la"
        || host == "tagindex.hitomi.la"
        || (host.ends_with(".gold-usergeneratedcontent.net")
            && host != "gold-usergeneratedcontent.net");
    if !allowed {
        return Err(format!("Bypass URL host is not allowed: {host}"));
    }
    Ok(())
}

fn validate_headers(headers: &Option<HashMap<String, String>>) -> Result<(), String> {
    let Some(headers) = headers else {
        return Ok(());
    };
    if headers.len() > 16 {
        return Err("Too many bypass request headers.".into());
    }

    for (name, value) in headers {
        let lower_name = name.to_ascii_lowercase();
        if !ALLOWED_HEADERS.contains(&lower_name.as_str()) {
            return Err(format!("Bypass request header is not allowed: {name}"));
        }
        if name.len() > 64
            || value.len() > 4096
            || name.contains('\r')
            || name.contains('\n')
            || value.contains('\r')
            || value.contains('\n')
        {
            return Err(format!("Bypass request header is invalid: {name}"));
        }
        if lower_name == "range" && !is_valid_byte_range(value) {
            return Err("Bypass Range header must match bytes=<start>-<end>.".into());
        }
        if lower_name == "origin" && value != "https://hitomi.la" {
            return Err("Bypass Origin header must be https://hitomi.la.".into());
        }
        if lower_name == "referer" && value != "https://hitomi.la/" {
            return Err("Bypass Referer header must be https://hitomi.la/.".into());
        }
    }
    Ok(())
}

fn is_valid_byte_range(value: &str) -> bool {
    let Some(range) = value.strip_prefix("bytes=") else {
        return false;
    };
    let Some((start, end)) = range.split_once('-') else {
        return false;
    };
    !start.is_empty()
        && !end.is_empty()
        && start.bytes().all(|byte| byte.is_ascii_digit())
        && end.bytes().all(|byte| byte.is_ascii_digit())
        && start
            .parse::<u64>()
            .ok()
            .zip(end.parse::<u64>().ok())
            .is_some_and(|(start, end)| start <= end)
}

fn validate_cache_key(cache_key: &str) -> Result<(), String> {
    if cache_key.is_empty() || cache_key.len() > 200 || cache_key == "." || cache_key == ".." {
        return Err("Image cache key is empty, reserved, or too long.".into());
    }
    if !cache_key
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("Image cache key contains unsupported characters.".into());
    }
    Ok(())
}

fn image_cache_path(app: &tauri::AppHandle, cache_key: &str) -> Result<PathBuf, String> {
    validate_cache_key(cache_key)?;
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve the app cache directory: {e}"))?
        .join("image-cache");
    Ok(root.join(cache_key))
}

async fn get_client() -> Result<&'static bypass_core::BypassClient, String> {
    CLIENT
        .get_or_try_init(|| async {
            bypass_core::BypassClient::new()
                .await
                .map_err(|e| format!("Failed to init bypass client: {e}"))
        })
        .await
}

#[tauri::command]
async fn bypass_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    validate_bypass_url(&url)?;
    validate_headers(&headers)?;
    let client = get_client().await?;
    let resp = client
        .fetch(&url, headers)
        .await
        .map_err(|e| format!("Bypass fetch failed: {e}"))?;

    use base64::Engine;
    let body_b64 = base64::engine::general_purpose::STANDARD.encode(&resp.body);

    Ok(serde_json::json!({
        "status": resp.status,
        "headers": resp.headers,
        "body": body_b64
    }))
}

/// Stream a URL's body straight to `dest_path` (one chunk at a time, bounded
/// memory) for the persistent image cache. Returns total bytes written. The JS
/// adapter then serves the file via `convertFileSrc`, so big images never pass
/// through the JS heap.
#[tauri::command]
async fn bypass_download_to_file(
    app: tauri::AppHandle,
    url: String,
    headers: Option<HashMap<String, String>>,
    cache_key: String,
) -> Result<u64, String> {
    validate_bypass_url(&url)?;
    validate_headers(&headers)?;
    let dest_path = image_cache_path(&app, &cache_key)?;
    let dest_path_str = dest_path
        .to_str()
        .ok_or_else(|| "Image cache path is not valid UTF-8.".to_string())?;
    let client = get_client().await?;
    client
        .download_to_file(&url, headers, dest_path_str)
        .await
        .map_err(|e| format!("Bypass download failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{is_valid_byte_range, validate_bypass_url, validate_cache_key, validate_headers};
    use std::collections::HashMap;

    #[test]
    fn bypass_url_allows_only_production_hosts_over_https() {
        for url in [
            "https://hitomi.la/allartists-a.html",
            "https://tagindex.hitomi.la/global/t/e.json",
            "https://ltn.gold-usergeneratedcontent.net/gg.js",
            "https://a1.gold-usergeneratedcontent.net/images/a.webp",
        ] {
            assert!(
                validate_bypass_url(url).is_ok(),
                "expected allowed URL: {url}"
            );
        }

        for url in [
            "http://hitomi.la/",
            "file:///etc/passwd",
            "https://127.0.0.1/",
            "https://localhost/",
            "https://169.254.169.254/latest/meta-data/",
            "https://gold-usergeneratedcontent.net/",
            "https://evilgold-usergeneratedcontent.net/",
            "https://gold-usergeneratedcontent.net.evil.example/",
            "https://user@hitomi.la/",
            "https://hitomi.la:8443/",
            "https://hitomi.la/#fragment",
        ] {
            assert!(
                validate_bypass_url(url).is_err(),
                "expected rejected URL: {url}"
            );
        }
    }

    #[test]
    fn bypass_headers_are_allowlisted_and_structured_values_are_checked() {
        let mut allowed = HashMap::new();
        allowed.insert("Range".into(), "bytes=10-20".into());
        allowed.insert("Referer".into(), "https://hitomi.la/".into());
        allowed.insert("Origin".into(), "https://hitomi.la".into());
        allowed.insert("User-Agent".into(), "HiPaGo".into());
        assert!(validate_headers(&Some(allowed)).is_ok());

        for (name, value) in [
            ("Authorization", "Bearer secret"),
            ("Cookie", "session=secret"),
            ("Range", "bytes=20-10"),
            ("Origin", "https://evil.example"),
            ("X-Test", "ok\r\nInjected: yes"),
        ] {
            let headers = HashMap::from([(name.to_string(), value.to_string())]);
            assert!(validate_headers(&Some(headers)).is_err());
        }
        assert!(is_valid_byte_range("bytes=0-0"));
        assert!(!is_valid_byte_range("bytes=0-"));
    }

    #[test]
    fn cache_key_is_a_single_safe_filename() {
        for key in ["image.webp", "abc_123-9.avif", "sha256.deadbeef"] {
            assert!(validate_cache_key(key).is_ok());
        }
        for key in [
            "",
            ".",
            "..",
            "../escape",
            "nested/file",
            "C:\\escape",
            "bad key",
        ] {
            assert!(
                validate_cache_key(key).is_err(),
                "expected rejected key: {key}"
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        // Auto-update from GitHub Releases. Endpoint + pubkey live in
        // tauri.conf.json's plugins.updater block. Signature verification
        // is enforced by the plugin against the embedded pubkey.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            bypass_fetch,
            bypass_download_to_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
