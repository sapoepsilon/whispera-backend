//! Token bucket, keyed per client IP (default) or any other key (e.g. device id).

use std::collections::HashMap;
use std::hash::Hash;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Mutex;
use std::time::Instant;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use whispera_proto::ErrorCode;

use crate::{ApiError, AppState};

pub struct RateLimiter<K = IpAddr> {
    per_second: f64,
    burst: f64,
    buckets: Mutex<Buckets<K>>,
}

struct Buckets<K> {
    map: HashMap<K, (f64, Instant)>,
    last_prune: Instant,
}

impl<K: Hash + Eq> RateLimiter<K> {
    /// `per_second == 0` disables limiting.
    pub fn new(per_second: f64, burst: u32) -> Self {
        Self {
            per_second,
            burst: f64::from(burst),
            buckets: Mutex::new(Buckets {
                map: HashMap::new(),
                last_prune: Instant::now(),
            }),
        }
    }

    /// Take one token for `ip`. `Err(seconds)` = retry after.
    pub fn check(&self, ip: K) -> Result<(), u64> {
        if self.per_second <= 0.0 {
            return Ok(());
        }
        let now = Instant::now();
        let mut b = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        if now.duration_since(b.last_prune).as_secs() >= 60 {
            let full_after = self.burst / self.per_second;
            b.map
                .retain(|_, (_, t)| now.duration_since(*t).as_secs_f64() < full_after);
            b.last_prune = now;
        }
        let (tokens, last) = b.map.entry(ip).or_insert((self.burst, now));
        let refill = now.duration_since(*last).as_secs_f64() * self.per_second;
        *tokens = (*tokens + refill).min(self.burst);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            Ok(())
        } else {
            Err(((1.0 - *tokens) / self.per_second).ceil().max(1.0) as u64)
        }
    }
}

fn header_ip(headers: &HeaderMap) -> Option<IpAddr> {
    if let Some(v) = headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
    {
        if let Ok(ip) = v.trim().parse() {
            return Some(ip);
        }
    }
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .and_then(|v| v.trim().parse().ok())
}

pub fn client_ip(state: &AppState, req: &Request) -> IpAddr {
    if state.trust_proxy_headers {
        if let Some(ip) = header_ip(req.headers()) {
            return ip;
        }
    }
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

pub async fn middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let ip = client_ip(&state, &req);
    match state.rate_limiter.check(ip) {
        Ok(()) => next.run(req).await,
        Err(retry) => {
            let mut resp =
                ApiError::new(ErrorCode::RateLimited, "too many requests").into_response();
            resp.headers_mut()
                .insert("retry-after", retry.to_string().parse().expect("digits"));
            resp
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket() {
        let r = RateLimiter::new(1.0, 2);
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        assert!(r.check(ip).is_ok());
        assert!(r.check(ip).is_ok());
        assert_eq!(r.check(ip), Err(1));
        assert!(r.check("10.0.0.2".parse().unwrap()).is_ok());
        assert!(RateLimiter::new(0.0, 0).check(ip).is_ok());
    }
}
