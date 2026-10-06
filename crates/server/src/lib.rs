//! Whispera server: account-authenticated device registry, WL1-signed E2E
//! relay, and content-free APNs "notify device" pushes.
//!
//! Routes (all JSON, errors use the PROTOCOL §13 envelope):
//!
//! | Method | Path | Auth |
//! |---|---|---|
//! | GET | `/v1/health` | none |
//! | POST | `/v1/devices` | account bearer |
//! | GET | `/v1/devices` | account bearer |
//! | DELETE | `/v1/devices/{id}` | account bearer |
//! | GET | `/v1/device/peers` | WL1 device |
//! | POST | `/v1/relay/send` | WL1 device |
//! | GET | `/v1/relay/messages` | WL1 device (long-poll with `wait`) |
//! | POST | `/v1/relay/ack` | WL1 device |
//! | GET | `/v1/relay/stream` | WL1 device (SSE) |
//! | POST | `/v1/notify` | WL1 device |

pub mod config;
pub mod ratelimit;

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Deserialize;
use tower_http::trace::TraceLayer;
use whispera_apns::{ApnsClient, PushOutcome};
use whispera_auth::{bearer_from_header, AccountAuth, AuthError};
use whispera_proto::keys::PublicKey;
use whispera_proto::sign::{self, SignedHeaders};
use whispera_proto::wire::{
    apns_token_suffix, push_status, ApnsEnv, DeviceList, Health, NotifyRequest, NotifyResponse,
    PublicDevice, RegisterDeviceRequest, RelayAckRequest, RelayAckResponse, RelayFetchResponse,
    RelaySendRequest,
};
use whispera_proto::{ErrorCode, ErrorEnvelope};
use whispera_relay::{DeviceAuth, Relay, RelayError, RelayLimits};
use whispera_store::{Account, Device, Store};

pub use config::Config;

/// Wire protocol version reported by `/v1/health`.
pub const PROTOCOL_VERSION: u32 = 1;
/// Largest accepted KEM public key (decoded bytes); fits ML-KEM-1024.
pub const MAX_KEM_PUBKEY_BYTES: usize = 2048;

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- errors

/// An API error rendered as the §13 envelope.
#[derive(Debug)]
pub struct ApiError {
    code: ErrorCode,
    message: String,
    server_time: bool,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            server_time: false,
        }
    }

    fn code(code: ErrorCode) -> Self {
        let msg = match code {
            ErrorCode::AuthMissing => "missing WL1 signature headers",
            ErrorCode::AuthUnknownDevice => "unknown device",
            ErrorCode::AuthRevoked => "device revoked",
            ErrorCode::AuthClockSkew => "timestamp outside the allowed clock skew",
            ErrorCode::AuthBadSignature => "bad signature",
            ErrorCode::AuthReplay => "nonce already used",
            ErrorCode::AuthAccountMissing => "missing bearer token",
            ErrorCode::AuthAccountInvalid => "invalid bearer token",
            ErrorCode::AuthUnavailable => "account authentication temporarily unavailable",
            ErrorCode::NotFound => "not found",
            _ => "internal error",
        };
        Self {
            code,
            message: msg.into(),
            server_time: code == ErrorCode::AuthClockSkew,
        }
    }

    fn bad(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::BadRequest, message)
    }

    fn internal<E: std::fmt::Display>(e: E) -> Self {
        tracing::error!(error = %e, "internal error");
        Self::code(ErrorCode::Internal)
    }
}

impl From<RelayError> for ApiError {
    fn from(e: RelayError) -> Self {
        match e {
            RelayError::Store(s) => Self::internal(s),
            other => Self::new(other.code(), other.to_string()),
        }
    }
}

impl From<whispera_store::StoreError> for ApiError {
    fn from(e: whispera_store::StoreError) -> Self {
        Self::internal(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut env = ErrorEnvelope::new(self.code, self.message);
        if self.server_time {
            env = env.with_server_time(now());
        }
        let status = StatusCode::from_u16(self.code.http_status())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(env)).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

// ---------------------------------------------------------------- push

/// Sends a content-free push to one device token.
#[async_trait::async_trait]
pub trait Pusher: Send + Sync + 'static {
    async fn push(&self, token: &str, env: ApnsEnv) -> PushOutcome;
}

#[async_trait::async_trait]
impl Pusher for ApnsClient {
    async fn push(&self, token: &str, env: ApnsEnv) -> PushOutcome {
        self.notify(token, env).await
    }
}

// ---------------------------------------------------------------- state

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    pub auth: Arc<dyn AccountAuth>,
    pub relay: Arc<Relay>,
    pub device_auth: Arc<DeviceAuth>,
    pub pusher: Option<Arc<dyn Pusher>>,
    pub rate_limiter: Arc<ratelimit::RateLimiter>,
    pub trust_proxy_headers: bool,
    pub max_devices_per_account: i64,
    pub max_body_bytes: usize,
}

/// Knobs for [`AppState::new`] that are not services.
#[derive(Debug, Clone)]
pub struct Settings {
    pub clock_skew_s: i64,
    pub relay: RelayLimits,
    pub rate_per_second: f64,
    pub rate_burst: u32,
    pub trust_proxy_headers: bool,
    pub max_devices_per_account: i64,
    pub max_body_bytes: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            clock_skew_s: sign::DEFAULT_CLOCK_SKEW_S,
            relay: RelayLimits::default(),
            rate_per_second: 0.0,
            rate_burst: 1,
            trust_proxy_headers: false,
            max_devices_per_account: 50,
            max_body_bytes: 256 * 1024,
        }
    }
}

impl Settings {
    pub fn from_config(c: &Config) -> Self {
        Self {
            clock_skew_s: c.clock_skew_s,
            relay: c.relay.limits(),
            rate_per_second: c.rate_limit.per_second,
            rate_burst: c.rate_limit.burst,
            trust_proxy_headers: c.trust_proxy_headers,
            max_devices_per_account: c.max_devices_per_account,
            max_body_bytes: c.max_body_bytes,
        }
    }
}

impl AppState {
    pub fn new(
        store: Store,
        auth: Arc<dyn AccountAuth>,
        pusher: Option<Arc<dyn Pusher>>,
        s: Settings,
    ) -> Self {
        Self {
            relay: Arc::new(Relay::new(store.clone(), s.relay)),
            device_auth: Arc::new(DeviceAuth::new(store.clone(), s.clock_skew_s)),
            store,
            auth,
            pusher,
            rate_limiter: Arc::new(ratelimit::RateLimiter::new(s.rate_per_second, s.rate_burst)),
            trust_proxy_headers: s.trust_proxy_headers,
            max_devices_per_account: s.max_devices_per_account,
            max_body_bytes: s.max_body_bytes,
        }
    }
}

pub fn router(state: AppState) -> Router {
    let limit = state.max_body_bytes;
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/devices", post(register_device).get(list_devices))
        .route("/v1/devices/{id}", delete(revoke_device))
        .route("/v1/device/peers", get(peers))
        .route("/v1/relay/send", post(relay_send))
        .route("/v1/relay/messages", get(relay_fetch))
        .route("/v1/relay/ack", post(relay_ack))
        .route("/v1/relay/stream", get(relay_stream))
        .route("/v1/notify", post(notify))
        .fallback(|| async { ApiError::code(ErrorCode::NotFound) })
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            ratelimit::middleware,
        ))
        .layer(DefaultBodyLimit::max(limit))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Periodically drop expired relay messages.
pub fn spawn_maintenance(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            match state.relay.purge_expired(now()).await {
                Ok(0) => {}
                Ok(n) => tracing::debug!(purged = n, "expired relay messages"),
                Err(e) => tracing::warn!(error = %e, "relay purge failed"),
            }
        }
    })
}

// ---------------------------------------------------------------- auth helpers

async fn account(state: &AppState, headers: &HeaderMap) -> ApiResult<Account> {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let token =
        bearer_from_header(raw).ok_or_else(|| ApiError::code(ErrorCode::AuthAccountMissing))?;
    let id = state.auth.authenticate(token).await.map_err(|e| {
        tracing::debug!(reason = %e, "account auth failed");
        ApiError::code(match e {
            AuthError::Missing => ErrorCode::AuthAccountMissing,
            AuthError::Invalid(_) => ErrorCode::AuthAccountInvalid,
            AuthError::Unavailable(_) => ErrorCode::AuthUnavailable,
        })
    })?;
    Ok(state
        .store
        .upsert_account(&id.issuer, &id.subject, now())
        .await?)
}

fn header<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

/// Verify a WL1-signed request (PROTOCOL §4) and return the active device.
async fn signed(
    state: &AppState,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> ApiResult<Device> {
    let get = |n| header(headers, n).map(str::to_owned);
    let (Some(device_id), Some(timestamp), Some(nonce), Some(signature)) = (
        get(sign::HDR_DEVICE),
        get(sign::HDR_TIMESTAMP),
        get(sign::HDR_NONCE),
        get(sign::HDR_SIGNATURE),
    ) else {
        return Err(ApiError::code(ErrorCode::AuthMissing));
    };
    let target = uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or_else(|| uri.path());
    let h = SignedHeaders {
        device_id,
        timestamp,
        nonce,
        signature,
    };
    state
        .device_auth
        .verify(&h, method.as_str(), target, body, now())
        .await
        .map_err(ApiError::code)
}

fn json_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> ApiResult<T> {
    serde_json::from_slice(body).map_err(|e| ApiError::bad(format!("invalid JSON body: {e}")))
}

// ---------------------------------------------------------------- handlers

async fn health(State(state): State<AppState>) -> Response {
    let db_ok = state.store.ping().await.is_ok();
    let body = Health {
        ok: db_ok,
        service: "whispera-server".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        protocol: PROTOCOL_VERSION,
        server_time: now(),
        apns: if state.pusher.is_some() {
            "configured"
        } else {
            "unconfigured"
        }
        .into(),
    };
    let status = if db_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(body)).into_response()
}

fn parse_env(s: Option<&str>) -> Option<ApnsEnv> {
    match s? {
        "sandbox" => Some(ApnsEnv::Sandbox),
        "production" => Some(ApnsEnv::Production),
        _ => None,
    }
}

fn public_device(d: &Device) -> PublicDevice {
    let fp = |k: &str| PublicKey::from_x963_b64(k).map(|k| k.fingerprint()).ok();
    PublicDevice {
        device_id: d.id.clone(),
        name: d.name.clone(),
        platform: d
            .platform
            .parse()
            .unwrap_or(whispera_proto::wire::Platform::Other),
        link_pubkey: d.link_pub.clone(),
        approve_pubkey: d.approve_pub.clone(),
        kem_pubkey: d.kem_pub.clone(),
        link_fp: fp(&d.link_pub).unwrap_or_default(),
        approve_fp: d.approve_pub.as_deref().and_then(fp),
        apns_token_suffix: d.apns_token.as_deref().map(apns_token_suffix),
        apns_env: parse_env(d.apns_env.as_deref()),
        created_at: d.created_at,
        revoked_at: d.revoked_at,
    }
}

fn is_apns_token(t: &str) -> bool {
    (64..=200).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn register_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let acc = account(&state, &headers).await?;
    let req: RegisterDeviceRequest = json_body(&body)?;
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(ApiError::bad("name must be 1-64 printable characters"));
    }
    let link = PublicKey::from_x963_b64(&req.link_pubkey)
        .map_err(|e| ApiError::bad(format!("link_pubkey: {e}")))?;
    let approve = req
        .approve_pubkey
        .as_deref()
        .map(PublicKey::from_x963_b64)
        .transpose()
        .map_err(|e| ApiError::bad(format!("approve_pubkey: {e}")))?;
    if let Some(k) = &req.kem_pubkey {
        let ok = STANDARD
            .decode(k)
            .map(|b| !b.is_empty() && b.len() <= MAX_KEM_PUBKEY_BYTES)
            .unwrap_or(false);
        if !ok {
            return Err(ApiError::bad(format!(
                "kem_pubkey must be standard base64, 1-{MAX_KEM_PUBKEY_BYTES} bytes"
            )));
        }
    }
    if let Some(a) = &req.apns {
        if !is_apns_token(&a.token) {
            return Err(ApiError::bad("apns.token must be 64-200 hex characters"));
        }
    }
    if state.store.count_active_devices(&acc.id).await? >= state.max_devices_per_account {
        return Err(ApiError::new(
            ErrorCode::Forbidden,
            "device limit reached; revoke a device first",
        ));
    }
    let device = Device {
        id: sign::new_device_id(),
        account_id: acc.id,
        name: name.to_string(),
        platform: req.platform.as_str().to_string(),
        link_pub: link.to_x963_b64(),
        approve_pub: approve.map(|k| k.to_x963_b64()),
        kem_pub: req.kem_pubkey,
        apns_token: req.apns.as_ref().map(|a| a.token.to_ascii_lowercase()),
        apns_env: req.apns.as_ref().map(|a| a.env.as_str().to_string()),
        created_at: now(),
        revoked_at: None,
    };
    state.store.insert_device(&device).await?;
    tracing::info!(device = %device.id, platform = %device.platform, "device registered");
    Ok((StatusCode::CREATED, Json(public_device(&device))).into_response())
}

async fn device_list(state: &AppState, account_id: &str) -> ApiResult<DeviceList> {
    let devices = state.store.list_devices(account_id).await?;
    Ok(DeviceList {
        devices: devices.iter().map(public_device).collect(),
    })
}

async fn list_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<DeviceList>> {
    let acc = account(&state, &headers).await?;
    Ok(Json(device_list(&state, &acc.id).await?))
}

async fn revoke_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let acc = account(&state, &headers).await?;
    if !state.store.revoke_device(&acc.id, &id, now()).await? {
        return Err(ApiError::code(ErrorCode::NotFound));
    }
    // End this device's open long-polls and streams.
    state.relay.wake(&id);
    tracing::info!(device = %id, "device revoked");
    Ok(StatusCode::NO_CONTENT)
}

async fn peers(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<DeviceList>> {
    let dev = signed(&state, &method, &uri, &headers, &body).await?;
    Ok(Json(device_list(&state, &dev.account_id).await?))
}

async fn relay_send(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let dev = signed(&state, &method, &uri, &headers, &body).await?;
    let req: RelaySendRequest = json_body(&body)?;
    let out = state
        .relay
        .send(&dev, &req.to, &req.ciphertext, req.ttl_s, now())
        .await?;
    Ok((StatusCode::CREATED, Json(out)).into_response())
}

#[derive(Debug, Deserialize)]
struct FetchQuery {
    #[serde(default)]
    after: i64,
    limit: Option<i64>,
    /// Long-poll: seconds to wait for a message when none is queued.
    #[serde(default)]
    wait: u64,
}

async fn device_still_active(state: &AppState, id: &str) -> ApiResult<()> {
    match state.store.get_device(id).await? {
        Some(d) if !d.is_revoked() => Ok(()),
        _ => Err(ApiError::code(ErrorCode::AuthRevoked)),
    }
}

async fn relay_fetch(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    Query(q): Query<FetchQuery>,
    body: Bytes,
) -> ApiResult<Json<RelayFetchResponse>> {
    let dev = signed(&state, &method, &uri, &headers, &body).await?;
    let wait = Duration::from_secs(q.wait.min(state.relay.limits().max_wait_s));
    let deadline = tokio::time::Instant::now() + wait;
    let mut rx = state.relay.subscribe(&dev.id);
    loop {
        let messages = state.relay.fetch(&dev, q.after, q.limit, now()).await?;
        if !messages.is_empty() || wait.is_zero() {
            return Ok(Json(RelayFetchResponse { messages }));
        }
        match tokio::time::timeout_at(deadline, rx.changed()).await {
            Ok(Ok(())) => device_still_active(&state, &dev.id).await?,
            _ => return Ok(Json(RelayFetchResponse { messages: vec![] })),
        }
    }
}

async fn relay_ack(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<RelayAckResponse>> {
    let dev = signed(&state, &method, &uri, &headers, &body).await?;
    let req: RelayAckRequest = json_body(&body)?;
    let deleted = state.relay.ack(&dev, req.up_to_seq).await?;
    Ok(Json(RelayAckResponse { deleted }))
}

#[derive(Debug, Deserialize)]
struct StreamQuery {
    after: Option<i64>,
}

struct StreamState {
    state: AppState,
    device: Device,
    rx: tokio::sync::watch::Receiver<u64>,
    cursor: i64,
    buf: VecDeque<whispera_proto::wire::RelayMessage>,
}

/// Server-sent events: one `message` event per relay message (`id` = seq).
/// Resume with `?after=N` or `Last-Event-ID`. Ends when the device is revoked.
async fn relay_stream(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    Query(q): Query<StreamQuery>,
    body: Bytes,
) -> ApiResult<Response> {
    let dev = signed(&state, &method, &uri, &headers, &body).await?;
    let last_event = header(&headers, "last-event-id").and_then(|v| v.trim().parse::<i64>().ok());
    let cursor = q.after.or(last_event).unwrap_or(0);
    let rx = state.relay.subscribe(&dev.id);
    let init = StreamState {
        state,
        device: dev,
        rx,
        cursor,
        buf: VecDeque::new(),
    };
    let stream = futures_util::stream::unfold(init, |mut s| async move {
        loop {
            if let Some(m) = s.buf.pop_front() {
                s.cursor = m.seq;
                let ev = Event::default()
                    .event("message")
                    .id(m.seq.to_string())
                    .json_data(&m)
                    .unwrap_or_else(|_| Event::default().comment("encode error"));
                return Some((Ok::<_, Infallible>(ev), s));
            }
            match s.state.store.get_device(&s.device.id).await {
                Ok(Some(d)) if !d.is_revoked() => {}
                _ => return None,
            }
            s.rx.mark_unchanged();
            match s.state.relay.fetch(&s.device, s.cursor, None, now()).await {
                Ok(msgs) if !msgs.is_empty() => s.buf.extend(msgs),
                Ok(_) => {
                    if s.rx.changed().await.is_err() {
                        return None;
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "relay stream fetch failed");
                    return None;
                }
            }
        }
    });
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response())
}

async fn notify(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<NotifyResponse>> {
    let dev = signed(&state, &method, &uri, &headers, &body).await?;
    let req: NotifyRequest = json_body(&body)?;
    let target = match state.store.get_device(&req.device_id).await? {
        Some(d) if d.account_id == dev.account_id && !d.is_revoked() => d,
        _ => return Err(ApiError::code(ErrorCode::NotFound)),
    };
    let reply = |s: &str| Ok(Json(NotifyResponse { push: s.into() }));
    let Some(pusher) = &state.pusher else {
        return reply(push_status::UNCONFIGURED);
    };
    let (Some(token), Some(env)) = (
        target.apns_token.as_deref(),
        parse_env(target.apns_env.as_deref()),
    ) else {
        return reply(push_status::NO_TOKEN);
    };
    match pusher.push(token, env).await {
        PushOutcome::Sent => reply(push_status::SENT),
        PushOutcome::Unregistered => {
            tracing::info!(device = %target.id, "APNs token unregistered; clearing it");
            state.store.clear_apns_token(&target.id, token).await?;
            reply(push_status::NO_TOKEN)
        }
        PushOutcome::Failed(reason) => {
            tracing::warn!(device = %target.id, %reason, "push failed");
            reply(push_status::FAILED)
        }
    }
}
