//! DNS-over-HTTPS resolver — bypasses ISP DNS poisoning.
//!
//! Providers: Cloudflare 1.1.1.1 (primary), Google 8.8.8.8 (fallback).
//! Uses IP addresses directly to avoid recursive DNS dependency.

use crate::BypassError;
use base64::{engine::general_purpose, Engine as _};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Mutex, Semaphore};

const MIN_TTL: Duration = Duration::from_secs(60);
const MAX_TTL: Duration = Duration::from_secs(3600);
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DOH_QUERIES: usize = 2;

#[derive(Debug, Clone)]
struct CacheEntry {
    ips: Vec<String>,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct EchCacheEntry {
    config_list: Option<Vec<u8>>,
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
    ech_cache: Arc<Mutex<HashMap<String, EchCacheEntry>>>,
    in_flight: Arc<Mutex<HashMap<String, broadcast::Sender<Result<Vec<String>, String>>>>>,
    ech_in_flight: Arc<Mutex<HashMap<String, broadcast::Sender<Result<Option<Vec<u8>>, String>>>>>,
    http_client: Arc<rquest::Client>,
    query_slots: Arc<Semaphore>,
}

enum ResolveRole {
    Leader(broadcast::Sender<Result<Vec<String>, String>>),
    Follower(broadcast::Receiver<Result<Vec<String>, String>>),
}

enum EchResolveRole {
    Leader(broadcast::Sender<Result<Option<Vec<u8>>, String>>),
    Follower(broadcast::Receiver<Result<Option<Vec<u8>>, String>>),
}

impl DohResolver {
    pub fn new() -> Self {
        let client = rquest::Client::builder()
            .timeout(QUERY_TIMEOUT)
            .connect_timeout(QUERY_TIMEOUT)
            .no_proxy()
            .build()
            .expect("Failed to build DoH HTTP client");

        Self {
            cache: Arc::new(Mutex::new(HashMap::new())),
            ech_cache: Arc::new(Mutex::new(HashMap::new())),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            ech_in_flight: Arc::new(Mutex::new(HashMap::new())),
            http_client: Arc::new(client),
            query_slots: Arc::new(Semaphore::new(MAX_DOH_QUERIES)),
        }
    }

    /// Resolve a hostname to an IP address via DoH.
    /// Uses caching with TTL and in-flight deduplication.
    pub async fn resolve(&self, hostname: &str) -> Result<String, BypassError> {
        self.resolve_all(hostname).await.and_then(|ips| {
            ips.into_iter()
                .next()
                .ok_or_else(|| BypassError::DohError("No A record in DoH response".into()))
        })
    }

    /// Resolve a hostname to all A records returned by DoH.
    /// Uses caching with TTL and in-flight deduplication.
    pub async fn resolve_all(&self, hostname: &str) -> Result<Vec<String>, BypassError> {
        let hostname = normalize_hostname(hostname);

        // Check cache
        {
            let cache = self.cache.lock().await;
            if let Some(entry) = cache.get(&hostname) {
                if Instant::now() < entry.expires_at {
                    return Ok(entry.ips.clone());
                }
            }
        }

        let role = {
            let mut in_flight = self.in_flight.lock().await;
            if let Some(tx) = in_flight.get(&hostname) {
                ResolveRole::Follower(tx.subscribe())
            } else {
                let (tx, _) = broadcast::channel::<Result<Vec<String>, String>>(1);
                in_flight.insert(hostname.clone(), tx.clone());
                ResolveRole::Leader(tx)
            }
        };

        let tx = match role {
            ResolveRole::Follower(mut rx) => {
                let result = rx
                    .recv()
                    .await
                    .map_err(|e| BypassError::DohError(format!("In-flight recv failed: {e}")))?;
                return result.map_err(BypassError::DohError);
            }
            ResolveRole::Leader(tx) => tx,
        };

        // Perform the actual resolution
        let result = self.fetch_from_doh(&hostname).await;

        // Cache on success
        if let Ok((ref ips, ref ttl)) = result {
            let mut cache = self.cache.lock().await;
            cache.insert(
                hostname.clone(),
                CacheEntry {
                    ips: ips.clone(),
                    expires_at: Instant::now() + *ttl,
                },
            );
        }

        // Remove before broadcasting: a late caller must not subscribe after
        // the one-shot result was already sent.
        {
            let mut in_flight = self.in_flight.lock().await;
            in_flight.remove(&hostname);
        }

        // Broadcast result to all waiters
        let broadcast_result = match &result {
            Ok((ips, _)) => Ok(ips.clone()),
            Err(e) => Err(e.to_string()),
        };
        let _ = tx.send(broadcast_result);

        result.map(|(ips, _)| ips)
    }

    /// Look up an ECHConfigList from HTTPS/SVCB records via DoH.
    ///
    /// This prepares the data needed for real ECH. `rquest` 1.5.5 only exposes
    /// ECH GREASE publicly, so the returned config cannot be applied to the TLS
    /// handshake until the TLS client exposes `SSL_set1_ech_config_list` or an
    /// equivalent hook.
    pub async fn resolve_ech_config(&self, hostname: &str) -> Result<Option<Vec<u8>>, BypassError> {
        let hostname = normalize_hostname(hostname);

        {
            let cache = self.ech_cache.lock().await;
            if let Some(entry) = cache.get(&hostname) {
                if Instant::now() < entry.expires_at {
                    return Ok(entry.config_list.clone());
                }
            }
        }

        let role = {
            let mut in_flight = self.ech_in_flight.lock().await;
            if let Some(tx) = in_flight.get(&hostname) {
                EchResolveRole::Follower(tx.subscribe())
            } else {
                let (tx, _) = broadcast::channel::<Result<Option<Vec<u8>>, String>>(1);
                in_flight.insert(hostname.clone(), tx.clone());
                EchResolveRole::Leader(tx)
            }
        };

        let tx = match role {
            EchResolveRole::Follower(mut rx) => {
                let result = rx.recv().await.map_err(|e| {
                    BypassError::DohError(format!("ECH in-flight recv failed: {e}"))
                })?;
                return result.map_err(BypassError::DohError);
            }
            EchResolveRole::Leader(tx) => tx,
        };

        let result = self.fetch_ech_from_doh(&hostname).await;

        if let Ok((ref config_list, ref ttl)) = result {
            let mut cache = self.ech_cache.lock().await;
            cache.insert(
                hostname.clone(),
                EchCacheEntry {
                    config_list: config_list.clone(),
                    expires_at: Instant::now() + *ttl,
                },
            );
        }

        {
            let mut in_flight = self.ech_in_flight.lock().await;
            in_flight.remove(&hostname);
        }

        let broadcast_result = match &result {
            Ok((config_list, _)) => Ok(config_list.clone()),
            Err(e) => Err(e.to_string()),
        };
        let _ = tx.send(broadcast_result);

        result.map(|(config_list, _)| config_list)
    }

    async fn fetch_from_doh(&self, hostname: &str) -> Result<(Vec<String>, Duration), BypassError> {
        let providers = [
            "https://1.1.1.1/dns-query", // Cloudflare primary
            "https://1.0.0.1/dns-query", // Cloudflare secondary
            "https://8.8.8.8/resolve",   // Google
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

    async fn fetch_ech_from_doh(
        &self,
        hostname: &str,
    ) -> Result<(Option<Vec<u8>>, Duration), BypassError> {
        let providers = [
            "https://1.1.1.1/dns-query", // Cloudflare primary
            "https://1.0.0.1/dns-query", // Cloudflare secondary
            "https://8.8.8.8/resolve",   // Google
        ];

        let mut last_err = None;
        for provider in &providers {
            match self.query_ech_provider(provider, hostname).await {
                Ok(result) => return Ok(result),
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err
            .unwrap_or_else(|| BypassError::DohError("All HTTPS/SVCB providers failed".into())))
    }

    async fn query_provider(
        &self,
        base_url: &str,
        hostname: &str,
    ) -> Result<(Vec<String>, Duration), BypassError> {
        let url = format!("{}?name={}&type=A", base_url, hostname);
        let _permit = self
            .query_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| BypassError::DohError("DoH limiter closed".into()))?;

        let resp = self
            .http_client
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

        let mut ips = Vec::new();
        let mut ttl_secs = MAX_TTL.as_secs();
        for answer in answers.iter().filter(|answer| answer.record_type == 1) {
            if !ips.contains(&answer.data) {
                ips.push(answer.data.clone());
            }
            ttl_secs = ttl_secs.min(answer.ttl);
        }

        if ips.is_empty() {
            return Err(BypassError::DohError("No A record in DoH response".into()));
        }

        let ttl_secs = ttl_secs.max(MIN_TTL.as_secs()).min(MAX_TTL.as_secs());
        Ok((ips, Duration::from_secs(ttl_secs)))
    }

    async fn query_ech_provider(
        &self,
        base_url: &str,
        hostname: &str,
    ) -> Result<(Option<Vec<u8>>, Duration), BypassError> {
        let url = format!("{}?name={}&type=HTTPS", base_url, hostname);
        let _permit = self
            .query_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| BypassError::DohError("DoH limiter closed".into()))?;

        let resp = self
            .http_client
            .get(&url)
            .header("Accept", "application/dns-json")
            .send()
            .await
            .map_err(|e| BypassError::DohError(format!("DoH HTTPS request failed: {e}")))?;

        if !resp.status().is_success() {
            return Err(BypassError::DohError(format!(
                "DoH HTTPS provider returned {}",
                resp.status()
            )));
        }

        let body = resp.text().await.map_err(|e| {
            BypassError::DohError(format!("Failed to read DoH HTTPS response: {e}"))
        })?;

        let data: DohResponse = serde_json::from_str(&body).map_err(|e| {
            BypassError::DohError(format!("Failed to parse DoH HTTPS response: {e}"))
        })?;

        if data.status != 0 {
            return Err(BypassError::DohError(format!(
                "DoH HTTPS query failed: status={}",
                data.status
            )));
        }

        let answers = match data.answer {
            Some(answers) => answers,
            None => return Ok((None, MIN_TTL)),
        };

        let mut ttl = MIN_TTL;
        for answer in answers.iter().filter(|answer| answer.record_type == 65) {
            ttl = Duration::from_secs(answer.ttl.max(MIN_TTL.as_secs()).min(MAX_TTL.as_secs()));
            if let Some(config_list) = parse_ech_config_from_https_rr(&answer.data) {
                return Ok((Some(config_list), ttl));
            }
        }

        Ok((None, ttl))
    }
}

fn normalize_hostname(hostname: &str) -> String {
    hostname.trim_end_matches('.').to_ascii_lowercase()
}

fn parse_ech_config_from_https_rr(data: &str) -> Option<Vec<u8>> {
    split_svcb_fields(data)
        .into_iter()
        .skip(2)
        .find_map(|field| field.strip_prefix("ech=").and_then(decode_ech_config_value))
}

fn split_svcb_fields(data: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut chars = data.chars().peekable();
    let mut in_quotes = false;

    while let Some(ch) = chars.next() {
        match ch {
            '"' => in_quotes = !in_quotes,
            '\\' => {
                if let Some(decoded) = decode_dns_escape(&mut chars) {
                    current.push(decoded);
                }
            }
            ch if ch.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    fields.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }

    if !current.is_empty() {
        fields.push(current);
    }

    fields
}

fn decode_dns_escape<I>(chars: &mut std::iter::Peekable<I>) -> Option<char>
where
    I: Iterator<Item = char>,
{
    let mut digits = String::new();
    for _ in 0..3 {
        match chars.peek() {
            Some(ch) if ch.is_ascii_digit() => digits.push(chars.next()?),
            _ => break,
        }
    }

    if digits.len() == 3 {
        digits
            .parse::<u8>()
            .ok()
            .and_then(|byte| char::from_u32(byte as u32))
    } else {
        chars.next()
    }
}

fn decode_ech_config_value(value: &str) -> Option<Vec<u8>> {
    let value = value.trim();
    general_purpose::STANDARD
        .decode(value)
        .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(value))
        .ok()
}

impl Default for DohResolver {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_ech_config_value, normalize_hostname, parse_ech_config_from_https_rr,
        split_svcb_fields,
    };

    #[test]
    fn normalizes_dns_names_for_cache_and_in_flight_dedup() {
        assert_eq!(
            normalize_hostname("LTN.GOLD-USERGENERATEDCONTENT.NET."),
            "ltn.gold-usergeneratedcontent.net"
        );
    }

    #[test]
    fn parses_ech_config_from_https_svcb_record() {
        let rr = "1 . alpn=h2,h3 ech=AQIDBA== ipv4hint=192.0.2.1";
        assert_eq!(parse_ech_config_from_https_rr(rr), Some(vec![1, 2, 3, 4]));
    }

    #[test]
    fn parses_quoted_ech_config_from_https_svcb_record() {
        let rr = r#"1 example.com. alpn="h2,h3" ech="AQIDBA" ipv4hint=192.0.2.1"#;
        assert_eq!(parse_ech_config_from_https_rr(rr), Some(vec![1, 2, 3, 4]));
    }

    #[test]
    fn returns_none_when_https_record_has_no_ech_param() {
        let rr = "1 . alpn=h2,h3 ipv4hint=192.0.2.1";
        assert_eq!(parse_ech_config_from_https_rr(rr), None);
    }

    #[test]
    fn splits_svcb_fields_with_quotes_and_dns_escapes() {
        let fields = split_svcb_fields(r#"1 . alpn="h2 h3" ech=AQID\066A=="#);
        assert_eq!(
            fields,
            vec![
                "1".to_string(),
                ".".to_string(),
                "alpn=h2 h3".to_string(),
                "ech=AQIDBA==".to_string(),
            ]
        );
    }

    #[test]
    fn decodes_padded_and_unpadded_ech_config_base64() {
        assert_eq!(decode_ech_config_value("AQIDBA=="), Some(vec![1, 2, 3, 4]));
        assert_eq!(decode_ech_config_value("AQIDBA"), Some(vec![1, 2, 3, 4]));
    }
}
