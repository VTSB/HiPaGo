use std::collections::HashMap;
use tokio::sync::OnceCell;

static CLIENT: OnceCell<bypass_core::BypassClient> = OnceCell::const_new();

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        // Auto-update from GitHub Releases. Endpoint + pubkey live in
        // tauri.conf.json's plugins.updater block. Signature verification
        // is enforced by the plugin against the embedded pubkey.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![bypass_fetch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
