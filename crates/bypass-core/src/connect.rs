//! Bounded, staggered dialing of already-resolved IP addresses.

use crate::BypassError;
use std::future::Future;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio::time::{sleep_until, timeout_at, Instant};

const STAGGER: Duration = Duration::from_millis(250);
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_ACTIVE: usize = 2;

pub(crate) async fn connect_to_ips(
    ips: &[String],
    port: u16,
    deadline: Instant,
) -> Result<TcpStream, BypassError> {
    let addresses = ips
        .iter()
        .filter_map(|ip| ip.parse::<IpAddr>().ok())
        .map(|ip| SocketAddr::new(ip, port))
        .collect();
    let stream = dial(addresses, deadline, TcpStream::connect)
        .await
        .map_err(|err| BypassError::ProxyError(format!("DoH IP connection failed: {err}")))?;
    stream.set_nodelay(true)?;
    Ok(stream)
}

async fn dial<T, F, Fut>(addresses: Vec<SocketAddr>, deadline: Instant, connect: F) -> io::Result<T>
where
    T: Send + 'static,
    F: Fn(SocketAddr) -> Fut,
    Fut: Future<Output = io::Result<T>> + Send + 'static,
{
    let mut attempts = JoinSet::new();
    let mut addresses = addresses.into_iter().peekable();
    let mut next_start = Instant::now();
    let mut last_error = io::Error::new(io::ErrorKind::InvalidInput, "no valid IP addresses");

    loop {
        if Instant::now() >= deadline {
            attempts.shutdown().await;
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "TCP connect deadline",
            ));
        }
        if addresses.peek().is_some()
            && attempts.len() < MAX_ACTIVE
            && (attempts.is_empty() || Instant::now() >= next_start)
        {
            let address = addresses.next().unwrap();
            let attempt_deadline = deadline.min(Instant::now() + ATTEMPT_TIMEOUT);
            let future = connect(address);
            attempts.spawn(async move {
                timeout_at(attempt_deadline, future)
                    .await
                    .unwrap_or_else(|_| {
                        Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "IP connect timeout",
                        ))
                    })
            });
            next_start = Instant::now() + STAGGER;
            continue;
        }
        if attempts.is_empty() {
            return Err(last_error);
        }
        let can_start = addresses.peek().is_some() && attempts.len() < MAX_ACTIVE;
        tokio::select! {
            biased;
            _ = sleep_until(deadline) => {
                attempts.shutdown().await;
                return Err(io::Error::new(io::ErrorKind::TimedOut, "TCP connect deadline"));
            }
            result = attempts.join_next() => {
                match result.unwrap() {
                    Ok(Ok(stream)) => {
                        // Drop losing sockets/futures before exposing the winner.
                        attempts.shutdown().await;
                        return Ok(stream);
                    }
                    Ok(Err(err)) => last_error = err,
                    Err(err) => last_error = io::Error::other(err),
                }
                next_start = Instant::now();
            }
            _ = sleep_until(next_start), if can_start => {}
        }
    }
    // JoinSet also aborts every outstanding attempt when the caller is cancelled.
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn addresses(count: u16) -> Vec<SocketAddr> {
        (1..=count)
            .map(|port| SocketAddr::from(([127, 0, 0, 1], port)))
            .collect()
    }

    struct Active(Arc<AtomicUsize>);
    impl Drop for Active {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn healthy_second_address_wins_before_stalled_first_timeout() {
        let active = Arc::new(AtomicUsize::new(0));
        let start = Instant::now();
        let result = dial(addresses(2), start + Duration::from_secs(10), |address| {
            let active = Arc::clone(&active);
            async move {
                active.fetch_add(1, Ordering::SeqCst);
                let _active = Active(active);
                if address.port() == 1 {
                    std::future::pending::<()>().await;
                }
                Ok(address.port())
            }
        })
        .await
        .unwrap();
        assert_eq!(result, 2);
        assert_eq!(start.elapsed(), STAGGER);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn bounded_attempts_advance_after_timeout_and_cancel_losers() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let start = Instant::now();
        let result = dial(addresses(3), start + Duration::from_secs(10), |address| {
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            async move {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                let _active = Active(active);
                if address.port() < 3 {
                    std::future::pending::<()>().await;
                }
                Ok(address.port())
            }
        })
        .await
        .unwrap();
        assert_eq!(result, 3);
        assert_eq!(start.elapsed(), ATTEMPT_TIMEOUT);
        assert_eq!(peak.load(Ordering::SeqCst), MAX_ACTIVE);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn immediate_failure_does_not_wait_for_stagger() {
        let start = Instant::now();
        let result = dial(
            addresses(2),
            start + Duration::from_secs(10),
            |address| async move {
                if address.port() == 1 {
                    Err(io::Error::new(io::ErrorKind::ConnectionRefused, "fixture"))
                } else {
                    Ok(address.port())
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(result, 2);
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn overall_deadline_drops_pending_attempt() {
        let start = Instant::now();
        let result = dial(
            addresses(2),
            start + Duration::from_millis(100),
            |_| async { std::future::pending::<io::Result<()>>().await },
        )
        .await;
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert_eq!(start.elapsed(), Duration::from_millis(100));
    }

    #[tokio::test]
    async fn cancelling_parent_drops_attempt_future() {
        let active = Arc::new(AtomicUsize::new(0));
        let task_active = Arc::clone(&active);
        let task = tokio::spawn(dial(
            addresses(2),
            Instant::now() + Duration::from_secs(10),
            move |_| {
                let active = Arc::clone(&task_active);
                async move {
                    active.fetch_add(1, Ordering::SeqCst);
                    let _active = Active(active);
                    std::future::pending::<io::Result<()>>().await
                }
            },
        ));
        tokio::time::timeout(Duration::from_secs(1), async {
            while active.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::task::yield_now().await;
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn literal_addresses_only_and_real_socket_keeps_nodelay() {
        let deadline = Instant::now() + Duration::from_secs(1);
        assert!(connect_to_ips(&[], 80, deadline).await.is_err());
        assert!(connect_to_ips(&["example.com".into()], 80, deadline)
            .await
            .is_err());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stream = connect_to_ips(
            &["127.0.0.1".into()],
            listener.local_addr().unwrap().port(),
            deadline,
        )
        .await
        .unwrap();
        assert!(stream.nodelay().unwrap());
        let (_accepted, _) = listener.accept().await.unwrap();
        let ipv6 = tokio::net::TcpListener::bind("[::1]:0").await.unwrap();
        let ipv6_stream =
            connect_to_ips(&["::1".into()], ipv6.local_addr().unwrap().port(), deadline)
                .await
                .unwrap();
        assert!(ipv6_stream.peer_addr().unwrap().is_ipv6());
        assert!(ipv6_stream.nodelay().unwrap());
    }

    #[tokio::test]
    async fn returns_last_error_when_all_candidates_fail() {
        let error = dial(
            addresses(2),
            Instant::now() + Duration::from_secs(1),
            |_| async {
                Err::<(), _>(io::Error::new(
                    io::ErrorKind::ConnectionRefused,
                    "fixture refusal",
                ))
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::ConnectionRefused);
    }
}
