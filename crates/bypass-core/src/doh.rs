//! DNS-over-HTTPS resolver — bypasses ISP DNS poisoning.
//!
//! Providers: Cloudflare 1.1.1.1 (primary), Google 8.8.8.8 (fallback).
//! Uses IP addresses directly to avoid recursive DNS dependency.

use crate::BypassError;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, broadcast};

const MIN_TTL: Duration = Duration::from_secs(60);
const MAX_TTL: Duration = Duration::from_secs(3600);
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
struct CacheEntry {
    ip: String,
    expires_at: Instant,
}

#[derive(Debug, Deserialize)]
struct DohResponse {
    #[serde(rename = "Status")]
    status: u32,
    #[serde(rename = "Answer")]
    answer: Option<Vec<DohAnswer>>,
}

#[derive(Debug, Deserialize)]
struct DohAnswer {
    #[serde(rename = "type")]
    record_type: u32,
    data: String,
    #[serde(rename = "TTL")]
    ttl: u64,
}

/// Thread-safe DoH resolver with caching, in-flight deduplication, and reusable HTTP client.
#[derive(Clone)]
pub struct DohResolver {
    cache: Arc<Mutex<HashMap<String, CacheEntry>>>,
    in_flight: Arc<Mutex<HashMap<String, broadcast::Sender<Result<String, String>>>>>,
    http_client: Arc<rquest::Client>,
}

impl DohResolver {
    pub fn new() -> Self {
        let client = rquest::Client::builder()
            .timeout(QUERY_TIMEOUT)
            .no_proxy()
            .build()
            .expect("Failed to build DoH HTTP client");

        Self {
            cache: Arc::new(Mutex::new(HashMap::new())),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            http_client: Arc::new(client),
        }
    }

    /// Resolve a hostname to an IP address via DoH.
    /// Uses caching with TTL and in-flight deduplication.
    pub async fn resolve(&self, hostname: &str) -> Result<String, BypassError> {
        // Check cache
        {
            let cache = self.cache.lock().await;
            if let Some(entry) = cache.get(hostname) {
                if Instant::now() < entry.expires_at {
                    return Ok(entry.ip.clone());
                }
            }
        }

        // Check if there's an in-flight request — if so, subscribe and wait
        {
            let in_flight = self.in_flight.lock().await;
            if let Some(tx) = in_flight.get(hostname) {
                let mut rx = tx.subscribe();
                drop(in_flight);
                let result = rx.recv().await.map_err(|e| {
                    BypassError::DohError(format!("In-flight recv failed: {e}"))
                })?;
                return result.map_err(BypassError::DohError);
            }
        }

        // We're the first — create a broadcast channel and register
        let (tx, _) = broadcast::channel::<Result<String, String>>(1);
        {
            let mut in_flight = self.in_flight.lock().await;
            in_flight.insert(hostname.to_string(), tx.clone());
        }

        // Perform the actual resolution
        let result = self.fetch_from_doh(hostname).await;

        // Cache on success
        if let Ok((ref ip, ref ttl)) = result {
            let mut cache = self.cache.lock().await;
            cache.insert(
                hostname.to_string(),
                CacheEntry {
                    ip: ip.clone(),
                    expires_at: Instant::now() + *ttl,
                },
            );
        }

        // Broadcast result to all waiters
        let broadcast_result = match &result {
            Ok((ip, _)) => Ok(ip.clone()),
            Err(e) => Err(e.to_string()),
        };
        let _ = tx.send(broadcast_result);

        // Cleanup in-flight
        {
            let mut in_flight = self.in_flight.lock().await;
            in_flight.remove(hostname);
        }

        result.map(|(ip, _)| ip)
    }

    async fn fetch_from_doh(
        &self,
        hostname: &str,
    ) -> Result<(String, Duration), BypassError> {
        let providers = [
            "https://1.1.1.1/dns-query",    // Cloudflare primary
            "https://1.0.0.1/dns-query",    // Cloudflare secondary
            "https://8.8.8.8/resolve",      // Google
        ];

        let mut last_err = None;
        for provider in &providers {
            match self.query_provider(provider, hostname).await {
                Ok(result) => return Ok(result),
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err.unwrap_or_else(|| BypassError::DohError("All DoH providers failed".into())))
    }

    async fn query_provider(
        &self,
        base_url: &str,
        hostname: &str,
    ) -> Result<(String, Duration), BypassError> {
        let url = format!("{}?name={}&type=A", base_url, hostname);

        let resp = self.http_client
            .get(&url)
            .header("Accept", "application/dns-json")
            .send()
            .await
            .map_err(|e| BypassError::DohError(format!("DoH request failed: {e}")))?;

        if !resp.status().is_success() {
            return Err(BypassError::DohError(format!(
                "DoH provider returned {}",
                resp.status()
            )));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| BypassError::DohError(format!("Failed to read DoH response: {e}")))?;

        let data: DohResponse = serde_json::from_str(&body)
            .map_err(|e| BypassError::DohError(format!("Failed to parse DoH response: {e}")))?;

        if data.status != 0 {
            return Err(BypassError::DohError(format!(
                "DoH query failed: status={}",
                data.status
            )));
        }

        let answers = data
            .answer
            .ok_or_else(|| BypassError::DohError("No answers in DoH response".into()))?;

        // Find first A record (type 1)
        let a_record = answers
            .iter()
            .find(|a| a.record_type == 1)
            .ok_or_else(|| BypassError::DohError("No A record in DoH response".into()))?;

        let ttl_secs = a_record.ttl.max(MIN_TTL.as_secs()).min(MAX_TTL.as_secs());
        Ok((a_record.data.clone(), Duration::from_secs(ttl_secs)))
    }
}

impl Default for DohResolver {
    fn default() -> Self {
        Self::new()
    }
}
