//! Node.js bindings for bypass-core via napi-rs.
//!
//! Exposes `bypassFetch(url, headers?)` as an async function to Node.js.

use bypass_core::BypassClient;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::OnceLock;
use tokio::sync::OnceCell;

/// Global tokio runtime for the napi addon.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to create tokio runtime")
    })
}

/// Global bypass client (lazy-initialized on first call).
static CLIENT: OnceCell<BypassClient> = OnceCell::const_new();

async fn get_client() -> napi::Result<&'static BypassClient> {
    CLIENT
        .get_or_try_init(|| async {
            BypassClient::new()
                .await
                .map_err(|e| napi::Error::from_reason(format!("Failed to init bypass client: {e}")))
        })
        .await
}

#[napi(object)]
pub struct JsBypassResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Buffer,
}

/// Fetch a URL through the ISP bypass pipeline.
///
/// Combines DoH (DNS over HTTPS), TLS ClientHello fragmentation,
/// and Chrome TLS fingerprint impersonation.
#[napi]
pub async fn bypass_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> napi::Result<JsBypassResponse> {
    let client = get_client().await?;

    let resp = client
        .fetch(&url, headers)
        .await
        .map_err(|e| napi::Error::from_reason(format!("Bypass fetch failed: {e}")))?;

    Ok(JsBypassResponse {
        status: resp.status,
        headers: resp.headers,
        body: resp.body.into(),
    })
}
