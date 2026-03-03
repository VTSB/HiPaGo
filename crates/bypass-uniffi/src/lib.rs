//! UniFFI bindings for bypass-core.
//!
//! Generates Kotlin (Android) and Swift (iOS) bindings for the bypass client.
//! Used by Capacitor plugins on mobile platforms.

use bypass_core::{BypassClient, BypassError as CoreBypassError};
use std::collections::HashMap;
use std::sync::OnceLock;
use tokio::runtime::Runtime;
use tokio::sync::OnceCell;

uniffi::setup_scaffolding!();

fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        Runtime::new().expect("Failed to create tokio runtime")
    })
}

static CLIENT: OnceCell<BypassClient> = OnceCell::const_new();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum BypassError {
    #[error("Bypass error: {message}")]
    General { message: String },
}

impl From<CoreBypassError> for BypassError {
    fn from(e: CoreBypassError) -> Self {
        BypassError::General {
            message: e.to_string(),
        }
    }
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct BypassResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// Fetch a URL through the ISP bypass pipeline.
///
/// Combines DoH (DNS over HTTPS), TLS ClientHello fragmentation,
/// and Chrome TLS fingerprint impersonation.
#[uniffi::export]
pub fn bypass_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<BypassResponse, BypassError> {
    let rt = runtime();
    rt.block_on(async {
        let client = CLIENT
            .get_or_try_init(|| async {
                BypassClient::new().await.map_err(BypassError::from)
            })
            .await?;

        let resp = client.fetch(&url, headers).await?;

        Ok(BypassResponse {
            status: resp.status,
            headers: resp.headers,
            body: resp.body,
        })
    })
}
