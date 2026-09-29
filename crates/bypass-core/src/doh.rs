//! DNS-over-HTTPS resolver — bypasses ISP DNS poisoning.
//!
//! Providers: Cloudflare 1.1.1.1 (primary), Google 8.8.8.8 (fallback).
//! Uses IP addresses directly to avoid recursive DNS dependency.

use crate::BypassError;
use base64::{engine::general_purpose, Engine as _};
use serde::Deserialize;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{broadcast, Mutex, Semaphore};
use tokio::time::{sleep_until, timeout_at, Instant};

const MIN_TTL: Duration = Duration::from_secs(60);
const MAX_TTL: Duration = Duration::from_secs(3600);
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(6);
const PROVIDER_STAGGER: Duration = Duration::from_millis(250);
const MAX_DOH_LOOKUPS: usize = 2;
const PROVIDERS: [&str; 3] = [
    "https://1.1.1.1/dns-query", // Cloudflare primary
    "https://1.0.0.1/dns-query", // Cloudflare secondary
    "https://8.8.8.8/resolve",   // Google
];

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
    in_flight: Arc<StdMutex<HashMap<String, broadcast::Sender<Result<Vec<String>, String>>>>>,
    ech_in_flight:
        Arc<StdMutex<HashMap<String, broadcast::Sender<Result<Option<Vec<u8>>, String>>>>>,
    http_client: Arc<rquest::Client>,
    // Admission is per logical lookup, reserving capacity for all three hedges.
    // Two admitted lookups therefore own at most six live provider requests.
    query_slots: Arc<Semaphore>,
    providers: [String; 3],
}

// The owner removes the entry even when its future is dropped at an await.
// These locks protect only map operations; no I/O occurs while held.
struct LookupOwner<T: Clone> {
    entries: Arc<StdMutex<HashMap<String, broadcast::Sender<Result<T, String>>>>>,
    hostname: String,
    sender: broadcast::Sender<Result<T, String>>,
    complete: bool,
}

impl<T: Clone> LookupOwner<T> {
    fn finish(mut self, result: Result<T, String>) {
        self.entries.lock().unwrap().remove(&self.hostname);
        self.complete = true;
        let _ = self.sender.send(result);
    }
}

impl<T: Clone> Drop for LookupOwner<T> {
    fn drop(&mut self) {
        if !self.complete {
            self.entries.lock().unwrap().remove(&self.hostname);
            let _ = self.sender.send(Err("DoH lookup owner cancelled".into()));
        }
    }
}

fn join_lookup<T: Clone>(
    entries: &Arc<StdMutex<HashMap<String, broadcast::Sender<Result<T, String>>>>>,
    hostname: &str,
) -> (
    broadcast::Receiver<Result<T, String>>,
    Option<LookupOwner<T>>,
) {
    let mut entries_guard = entries.lock().unwrap();
    if let Some(sender) = entries_guard.get(hostname) {
        return (sender.subscribe(), None);
    }
    let (sender, receiver) = broadcast::channel(1);
    entries_guard.insert(hostname.to_owned(), sender.clone());
    (
        receiver,
        Some(LookupOwner {
            entries: Arc::clone(entries),
            hostname: hostname.to_owned(),
            sender,
            complete: false,
        }),
    )
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
            in_flight: Arc::new(StdMutex::new(HashMap::new())),
            ech_in_flight: Arc::new(StdMutex::new(HashMap::new())),
            http_client: Arc::new(client),
            query_slots: Arc::new(Semaphore::new(MAX_DOH_LOOKUPS)),
            providers: PROVIDERS.map(str::to_owned),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_providers(providers: [String; 3]) -> Self {
        Self {
            providers,
            ..Self::new()
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

        let (mut receiver, owner) = join_lookup(&self.in_flight, &hostname);
        let owner = match owner {
            Some(owner) => owner,
            None => {
                return receiver
                    .recv()
                    .await
                    .map_err(|e| BypassError::DohError(format!("In-flight recv failed: {e}")))?
                    .map_err(BypassError::DohError)
            }
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

        let broadcast_result = match &result {
            Ok((ips, _)) => Ok(ips.clone()),
            Err(e) => Err(e.to_string()),
        };
        owner.finish(broadcast_result);

        result.map(|(ips, _)| ips)
    }

    /// Look up an ECHConfigList from HTTPS/SVCB records via DoH.
    ///
    /// The ECH transport applies this config list directly through rustls.
    /// Callers that stay on `rquest` only get ECH GREASE.
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

        let (mut receiver, owner) = join_lookup(&self.ech_in_flight, &hostname);
        let owner = match owner {
            Some(owner) => owner,
            None => {
                return receiver
                    .recv()
                    .await
                    .map_err(|e| BypassError::DohError(format!("In-flight recv failed: {e}")))?
                    .map_err(BypassError::DohError)
            }
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

        let broadcast_result = match &result {
            Ok((config_list, _)) => Ok(config_list.clone()),
            Err(e) => Err(e.to_string()),
        };
        owner.finish(broadcast_result);

        result.map(|(config_list, _)| config_list)
    }

    async fn fetch_from_doh(&self, hostname: &str) -> Result<(Vec<String>, Duration), BypassError> {
        self.query_providers(|index| self.query_provider(&self.providers[index], hostname))
            .await
    }

    async fn fetch_ech_from_doh(
        &self,
        hostname: &str,
    ) -> Result<(Option<Vec<u8>>, Duration), BypassError> {
        self.query_providers(|index| self.query_ech_provider(&self.providers[index], hostname))
            .await
    }

    async fn query_providers<T, F, Fut>(&self, mut query: F) -> Result<T, BypassError>
    where
        F: FnMut(usize) -> Fut,
        Fut: Future<Output = Result<T, BypassError>>,
    {
        let deadline = Instant::now() + LOOKUP_TIMEOUT;
        timeout_at(deadline, async {
            let _permit = self
                .query_slots
                .acquire()
                .await
                .map_err(|_| BypassError::DohError("DoH limiter closed".into()))?;
            if Instant::now() >= deadline {
                return Err(BypassError::DohError("DoH lookup timed out".into()));
            }

            // Own the futures directly: winning, timing out or dropping this
            // lookup drops every losing HTTP request before releasing admission.
            let first = query(0);
            let second = query(1);
            let third = query(2);
            tokio::pin!(first, second, third);
            let mut started = 1;
            let mut finished = [false; 3];
            let mut next_start = Instant::now() + PROVIDER_STAGGER;
            loop {
                let (index, result) = tokio::select! {
                    biased;
                    result = &mut first, if !finished[0] => (0, result),
                    result = &mut second, if started >= 2 && !finished[1] => (1, result),
                    result = &mut third, if started >= 3 && !finished[2] => (2, result),
                    _ = sleep_until(next_start), if started < 3 => {
                        started += 1;
                        next_start = Instant::now() + PROVIDER_STAGGER;
                        continue;
                    }
                };
                match result {
                    Ok(answer) => return Ok(answer),
                    Err(error) => {
                        finished[index] = true;
                        if finished.iter().all(|done| *done) {
                            return Err(error);
                        }
                        // A known failure does not need to wait for the hedge timer.
                        if started < 3 {
                            started += 1;
                            next_start = Instant::now() + PROVIDER_STAGGER;
                        }
                    }
                }
            }
        })
        .await
        .map_err(|_| BypassError::DohError("DoH lookup timed out".into()))?
    }

    async fn query_provider(
        &self,
        base_url: &str,
        hostname: &str,
    ) -> Result<(Vec<String>, Duration), BypassError> {
        let url = format!("{}?name={}&type=A", base_url, hostname);

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
    if let Some(config_list) = parse_wire_https_rr_ech_config(data) {
        return Some(config_list);
    }

    split_svcb_fields(data)
        .into_iter()
        .skip(2)
        .find_map(|field| field.strip_prefix("ech=").and_then(decode_ech_config_value))
}

fn parse_wire_https_rr_ech_config(data: &str) -> Option<Vec<u8>> {
    let wire = parse_dns_wire_hex(data)?;
    parse_https_rdata_ech_config(&wire)
}

fn parse_dns_wire_hex(data: &str) -> Option<Vec<u8>> {
    let mut fields = data.split_whitespace();
    if fields.next()? != "\\#" {
        return None;
    }

    let expected_len = fields.next()?.parse::<usize>().ok()?;
    let mut wire = Vec::with_capacity(expected_len);
    for field in fields {
        if field.len() % 2 != 0 || !field.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return None;
        }

        let mut i = 0;
        while i < field.len() {
            wire.push(u8::from_str_radix(&field[i..i + 2], 16).ok()?);
            i += 2;
        }
    }

    (wire.len() == expected_len).then_some(wire)
}

fn parse_https_rdata_ech_config(wire: &[u8]) -> Option<Vec<u8>> {
    // HTTPS RR RDATA: SvcPriority(2), TargetName(wire DNS name), SvcParams.
    if wire.len() < 3 {
        return None;
    }

    let mut offset = 2;
    loop {
        let len = *wire.get(offset)? as usize;
        offset += 1;

        // DNS name compression pointers are not expected in HTTPS RDATA from
        // DoH JSON; refuse them instead of guessing where SvcParams begin.
        if len & 0xc0 != 0 {
            return None;
        }

        if len == 0 {
            break;
        }

        offset = offset.checked_add(len)?;
        if offset > wire.len() {
            return None;
        }
    }

    while offset + 4 <= wire.len() {
        let key = u16::from_be_bytes([wire[offset], wire[offset + 1]]);
        let value_len = u16::from_be_bytes([wire[offset + 2], wire[offset + 3]]) as usize;
        offset += 4;

        let end = offset.checked_add(value_len)?;
        if end > wire.len() {
            return None;
        }

        if key == 5 {
            return Some(wire[offset..end].to_vec());
        }

        offset = end;
    }

    None
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
        decode_ech_config_value, normalize_hostname, parse_dns_wire_hex,
        parse_ech_config_from_https_rr, split_svcb_fields,
    };

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::time::Instant;

    #[derive(Default)]
    struct Attempts {
        active: AtomicUsize,
        peak: AtomicUsize,
        starts: AtomicUsize,
    }

    struct ActiveAttempt(Arc<Attempts>);

    impl ActiveAttempt {
        fn new(attempts: &Arc<Attempts>) -> Self {
            attempts.starts.fetch_add(1, Ordering::SeqCst);
            let active = attempts.active.fetch_add(1, Ordering::SeqCst) + 1;
            attempts.peak.fetch_max(active, Ordering::SeqCst);
            Self(Arc::clone(attempts))
        }
    }

    impl Drop for ActiveAttempt {
        fn drop(&mut self) {
            self.0.active.fetch_sub(1, Ordering::SeqCst);
        }
    }

    async fn controlled_provider(
        index: usize,
        attempts: &Arc<Attempts>,
    ) -> Result<usize, crate::BypassError> {
        let _attempt = ActiveAttempt::new(attempts);
        if index == 0 {
            tokio::time::sleep(super::QUERY_TIMEOUT).await;
            Err(crate::BypassError::DohError(
                "controlled primary timeout".into(),
            ))
        } else {
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok(index)
        }
    }

    #[tokio::test(start_paused = true)]
    async fn slow_primary_hedge_beats_serial_baseline_and_drops_loser() {
        let attempts = Arc::new(Attempts::default());
        // Execute the old sequential selection over the identical controlled
        // provider futures; these are virtual timings, not public-network RTTs.
        let before = Instant::now();
        for index in 0..3 {
            if controlled_provider(index, &attempts).await.is_ok() {
                break;
            }
        }
        let serial = before.elapsed();
        assert_eq!(serial, Duration::from_millis(5_020));
        let resolver = super::DohResolver::new();
        let attempts = Arc::new(Attempts::default());
        let before = Instant::now();
        let result = resolver
            .query_providers(|index| controlled_provider(index, &attempts))
            .await;
        let hedged = before.elapsed();
        assert_eq!(result.unwrap(), 1);
        assert_eq!(hedged, Duration::from_millis(270));
        assert_eq!(attempts.starts.load(Ordering::SeqCst), 2);
        assert_eq!(attempts.active.load(Ordering::SeqCst), 0);
        assert_eq!(resolver.query_slots.available_permits(), 2);
        eprintln!("controlled DoH latency: serial={serial:?}, hedged={hedged:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn primary_success_and_immediate_failures_do_not_wait_for_stagger() {
        let resolver = super::DohResolver::new();
        for succeed_at in 0..3 {
            let starts = AtomicUsize::new(0);
            let before = Instant::now();
            let result = resolver
                .query_providers(|index| {
                    let starts = &starts;
                    async move {
                        starts.fetch_add(1, Ordering::SeqCst);
                        if index == succeed_at {
                            Ok(index)
                        } else {
                            Err(crate::BypassError::DohError("controlled failure".into()))
                        }
                    }
                })
                .await;
            assert_eq!(result.unwrap(), succeed_at);
            assert_eq!(before.elapsed(), Duration::ZERO);
            assert_eq!(starts.load(Ordering::SeqCst), succeed_at + 1);
        }
        let before = Instant::now();
        let result = resolver
            .query_providers(|_| async {
                Err::<(), _>(crate::BypassError::DohError("all fail".into()))
            })
            .await;
        assert!(result.unwrap_err().to_string().contains("all fail"));
        assert_eq!(before.elapsed(), Duration::ZERO);
        assert_eq!(resolver.query_slots.available_permits(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn saturated_lookups_reserve_hedges_and_bound_wire_work_and_queued_wait() {
        let resolver = super::DohResolver::new();
        let attempts = Arc::new(Attempts::default());
        let mut tasks = Vec::new();
        for _ in 0..3 {
            let resolver = resolver.clone();
            let attempts = Arc::clone(&attempts);
            tasks.push(tokio::spawn(async move {
                resolver
                    .query_providers(|_| {
                        let attempts = Arc::clone(&attempts);
                        async move {
                            let _active = ActiveAttempt::new(&attempts);
                            std::future::pending::<Result<(), crate::BypassError>>().await
                        }
                    })
                    .await
            }));
        }
        tokio::task::yield_now().await;
        assert_eq!(attempts.active.load(Ordering::SeqCst), 2);
        for expected in [4, 6] {
            tokio::time::advance(super::PROVIDER_STAGGER).await;
            tokio::task::yield_now().await;
            assert_eq!(attempts.active.load(Ordering::SeqCst), expected);
        }
        assert_eq!(resolver.query_slots.available_permits(), 0);
        tokio::time::advance(super::LOOKUP_TIMEOUT - 2 * super::PROVIDER_STAGGER).await;
        for task in tasks {
            assert!(task
                .await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("timed out"));
        }
        assert_eq!(attempts.starts.load(Ordering::SeqCst), 6);
        assert_eq!(attempts.peak.load(Ordering::SeqCst), 6);
        assert_eq!(attempts.active.load(Ordering::SeqCst), 0);
        assert_eq!(resolver.query_slots.available_permits(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_drops_all_provider_futures_and_releases_admission() {
        let resolver = super::DohResolver::new();
        let attempts = Arc::new(Attempts::default());
        let task = {
            let resolver = resolver.clone();
            let attempts = Arc::clone(&attempts);
            tokio::spawn(async move {
                resolver
                    .query_providers(|_| {
                        let attempts = Arc::clone(&attempts);
                        async move {
                            let _active = ActiveAttempt::new(&attempts);
                            std::future::pending::<Result<(), crate::BypassError>>().await
                        }
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;
        for _ in 0..2 {
            tokio::time::advance(super::PROVIDER_STAGGER).await;
            tokio::task::yield_now().await;
        }
        assert_eq!(attempts.active.load(Ordering::SeqCst), 3);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(attempts.active.load(Ordering::SeqCst), 0);
        assert_eq!(resolver.query_slots.available_permits(), 2);
    }

    enum FixtureResponse {
        Body(String),
        Stall,
        Disconnect,
    }

    struct ProviderFixture {
        url: String,
        requests: Arc<AtomicUsize>,
        closed: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for ProviderFixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn provider_fixture(response: fn(&str) -> FixtureResponse) -> ProviderFixture {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/dns-query", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicUsize::new(0));
        let task = {
            let requests = Arc::clone(&requests);
            let closed = Arc::clone(&closed);
            tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        accepted = listener.accept() => {
                            let (mut socket, _) = accepted.unwrap();
                            let requests = Arc::clone(&requests);
                            let closed = Arc::clone(&closed);
                            connections.spawn(async move {
                                let mut request = Vec::new();
                                let mut buf = [0; 1024];
                                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                                    let count = socket.read(&mut buf).await.unwrap();
                                    if count == 0 { return; }
                                    request.extend_from_slice(&buf[..count]);
                                }
                                requests.fetch_add(1, Ordering::SeqCst);
                                match response(&String::from_utf8_lossy(&request)) {
                                    FixtureResponse::Body(body) => {
                                        let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                                        socket.write_all(head.as_bytes()).await.unwrap();
                                        socket.write_all(body.as_bytes()).await.unwrap();
                                    }
                                    FixtureResponse::Stall => {
                                        let _ = socket.read_to_end(&mut Vec::new()).await;
                                        closed.fetch_add(1, Ordering::SeqCst);
                                    }
                                    FixtureResponse::Disconnect => {}
                                }
                            });
                        }
                        _ = connections.join_next(), if !connections.is_empty() => {}
                    }
                }
            })
        };
        ProviderFixture {
            url,
            requests,
            closed,
            task,
        }
    }

    fn dns_answer(request: &str) -> FixtureResponse {
        FixtureResponse::Body(if request.contains("type=HTTPS") {
            if request.contains("negative.test") {
                r#"{"Status":0}"#.into()
            } else {
                r#"{"Status":0,"Answer":[{"type":65,"TTL":1,"data":"1 . ech=AQIDBA=="}]}"#.into()
            }
        } else {
            r#"{"Status":0,"Answer":[{"type":1,"TTL":10000,"data":"192.0.2.1"}]}"#.into()
        })
    }

    #[tokio::test]
    async fn real_http_hedge_cancels_stalled_loser() {
        let stalled = provider_fixture(|_| FixtureResponse::Stall).await;
        let healthy = provider_fixture(dns_answer).await;
        let mut resolver = super::DohResolver::new();
        resolver.providers = [
            stalled.url.clone(),
            healthy.url.clone(),
            healthy.url.clone(),
        ];
        let result =
            tokio::time::timeout(Duration::from_secs(2), resolver.resolve_all("fixture.test"))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(result, vec!["192.0.2.1"]);
        assert_eq!(stalled.requests.load(Ordering::SeqCst), 1);
        assert_eq!(healthy.requests.load(Ordering::SeqCst), 1);
        tokio::time::timeout(Duration::from_secs(1), async {
            while stalled.closed.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(resolver.query_slots.available_permits(), 2);
    }

    #[tokio::test]
    async fn parsed_answers_keep_normalized_a_and_positive_negative_ech_caches_and_ttl() {
        let fixture = provider_fixture(dns_answer).await;
        let mut resolver = super::DohResolver::new();
        resolver.providers = [
            fixture.url.clone(),
            fixture.url.clone(),
            fixture.url.clone(),
        ];
        assert_eq!(
            resolver.resolve_all("FIXTURE.TEST.").await.unwrap(),
            vec!["192.0.2.1"]
        );
        let cached_at = Instant::now();
        let expires = resolver.cache.lock().await["fixture.test"].expires_at;
        assert!(expires <= cached_at + super::MAX_TTL);
        assert!(expires > cached_at + super::MAX_TTL - Duration::from_secs(1));
        let _permits = resolver.query_slots.acquire_many(2).await.unwrap();
        assert_eq!(
            resolver.resolve_all("fixture.test").await.unwrap(),
            vec!["192.0.2.1"]
        );
        drop(_permits);
        assert_eq!(fixture.requests.load(Ordering::SeqCst), 1);
        resolver
            .cache
            .lock()
            .await
            .get_mut("fixture.test")
            .unwrap()
            .expires_at = Instant::now();
        resolver.resolve_all("fixture.test").await.unwrap();
        assert_eq!(fixture.requests.load(Ordering::SeqCst), 2);
        for (host, expected) in [
            ("positive.test", Some(vec![1, 2, 3, 4])),
            ("negative.test", None),
        ] {
            let before = fixture.requests.load(Ordering::SeqCst);
            assert_eq!(resolver.resolve_ech_config(host).await.unwrap(), expected);
            assert_eq!(resolver.resolve_ech_config(host).await.unwrap(), expected);
            assert_eq!(fixture.requests.load(Ordering::SeqCst), before + 1);
            let cached_at = Instant::now();
            let expires = resolver.ech_cache.lock().await[host].expires_at;
            assert!(expires <= cached_at + super::MIN_TTL);
            assert!(expires > cached_at + super::MIN_TTL - Duration::from_secs(1));
            resolver
                .ech_cache
                .lock()
                .await
                .get_mut(host)
                .unwrap()
                .expires_at = Instant::now();
            assert_eq!(resolver.resolve_ech_config(host).await.unwrap(), expected);
            assert_eq!(fixture.requests.load(Ordering::SeqCst), before + 2);
        }
    }

    #[tokio::test]
    async fn malformed_answers_advance_and_transport_errors_are_not_cached() {
        let malformed = provider_fixture(|_| FixtureResponse::Body("invalid JSON".into())).await;
        let healthy = provider_fixture(dns_answer).await;
        let mut resolver = super::DohResolver::new();
        resolver.providers = [
            malformed.url.clone(),
            healthy.url.clone(),
            healthy.url.clone(),
        ];
        assert_eq!(
            resolver.resolve_all("fixture.test").await.unwrap(),
            vec!["192.0.2.1"]
        );
        assert_eq!(malformed.requests.load(Ordering::SeqCst), 1);
        assert_eq!(healthy.requests.load(Ordering::SeqCst), 1);
        let disconnected = provider_fixture(|_| FixtureResponse::Disconnect).await;
        resolver.providers = [
            disconnected.url.clone(),
            disconnected.url.clone(),
            disconnected.url.clone(),
        ];
        for ech in [false, true] {
            let before = disconnected.requests.load(Ordering::SeqCst);
            for _ in 0..2 {
                let result = if ech {
                    resolver.resolve_ech_config("error.test").await.map(|_| ())
                } else {
                    resolver.resolve_all("error.test").await.map(|_| ())
                };
                assert!(result.is_err());
            }
            assert_eq!(disconnected.requests.load(Ordering::SeqCst), before + 6);
        }
        assert!(!resolver.cache.lock().await.contains_key("error.test"));
        assert!(!resolver.ech_cache.lock().await.contains_key("error.test"));
    }

    #[tokio::test]
    async fn cancelled_dns_and_ech_owners_wake_followers_and_allow_new_owner() {
        for ech in [false, true] {
            let resolver = super::DohResolver::new();
            // Keep both logical lookup slots occupied; this never contacts the network.
            let _permits = resolver.query_slots.acquire_many(2).await.unwrap();
            let spawn_lookup = || {
                let resolver = resolver.clone();
                tokio::spawn(async move {
                    if ech {
                        resolver
                            .resolve_ech_config("example.test")
                            .await
                            .map(|_| ())
                    } else {
                        resolver.resolve_all("example.test").await.map(|_| ())
                    }
                })
            };
            let active = || {
                if ech {
                    resolver
                        .ech_in_flight
                        .lock()
                        .unwrap()
                        .contains_key("example.test")
                } else {
                    resolver
                        .in_flight
                        .lock()
                        .unwrap()
                        .contains_key("example.test")
                }
            };
            let leader = spawn_lookup();
            while !active() {
                tokio::task::yield_now().await;
            }
            let follower = spawn_lookup();
            // Wait for the real follower subscription, not a timing assumption.
            loop {
                let subscribers = if ech {
                    resolver.ech_in_flight.lock().unwrap()["example.test"].receiver_count()
                } else {
                    resolver.in_flight.lock().unwrap()["example.test"].receiver_count()
                };
                if subscribers >= 2 {
                    break;
                }
                tokio::task::yield_now().await;
            }
            leader.abort();
            let _ = leader.await;
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(1), follower)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
            assert!(!active());
            let next = spawn_lookup();
            while !active() {
                tokio::task::yield_now().await;
            }
            next.abort();
            let _ = next.await;
            assert!(!active());
        }
    }

    #[tokio::test]
    async fn cancelling_a_follower_does_not_remove_its_owner() {
        let entries = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::<
            String,
            tokio::sync::broadcast::Sender<Result<Vec<String>, String>>,
        >::new()));
        let (_, owner) = super::join_lookup(&entries, "example.test");
        let (follower, no_owner) = super::join_lookup(&entries, "example.test");
        assert!(no_owner.is_none());
        drop(follower);
        assert!(entries.lock().unwrap().contains_key("example.test"));
        let (mut remaining, _) = super::join_lookup(&entries, "example.test");
        owner.unwrap().finish(Ok(vec!["192.0.2.1".into()]));
        assert_eq!(remaining.recv().await.unwrap().unwrap(), vec!["192.0.2.1"]);
        assert!(entries.lock().unwrap().is_empty());
    }

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
    fn parses_ech_config_from_wire_format_https_record() {
        let rr = "\\# 106 00 01 00 00 01 00 06 02 68 33 02 68 32 00 04 00 04 b9 a5 a9 e7 00 05 00 3d 00 3b fe 0d 00 37 11 00 20 00 20 2b 02 ca a9 c8 8a 42 9b b3 2d 2c a3 6c b9 d4 a3 f0 35 16 6f 85 42 cf 5d 0c 9c 4c 42 71 89 fc 15 00 04 00 01 00 01 00 08 69 65 74 66 2e 6f 72 67 00 00 00 06 00 10 26 05 64 00 00 20 11 74 ce 4f 7c 31 82 d5 e2 3f";
        let config = parse_ech_config_from_https_rr(rr).expect("ECH config should parse");

        assert_eq!(config.len(), 61);
        assert_eq!(&config[..4], &[0x00, 0x3b, 0xfe, 0x0d]);
    }

    #[test]
    fn returns_none_when_https_record_has_no_ech_param() {
        let rr = "1 . alpn=h2,h3 ipv4hint=192.0.2.1";
        assert_eq!(parse_ech_config_from_https_rr(rr), None);
    }

    #[test]
    fn rejects_wire_format_with_mismatched_declared_length() {
        assert_eq!(parse_dns_wire_hex("\\# 4 00 01 02"), None);
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
