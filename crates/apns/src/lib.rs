//! Content-free Apple Push Notification service (APNs) client.
//!
//! * Token-based auth: an ES256 provider JWT (`kid` = key id, `iss` = team id,
//!   `iat` = now), cached for 50 minutes and re-minted when Apple reports it
//!   expired or invalid.
//! * HTTP/2 to `api.push.apple.com` / `api.sandbox.push.apple.com`, chosen per
//!   request from [`ApnsEnv`].
//! * Payloads are built only from the typed [`PushKind`] (fixed strings plus a
//!   validated [`RequestId`] and an opaque end-to-end sealed [`SealedBlob`]);
//!   there is deliberately no API that accepts custom text, so nothing readable
//!   from a request can leak into a push.
//! * Key material is never logged or `Debug`-printed, and device tokens are only
//!   ever logged by their last 8 characters.

use std::fmt;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use p256::pkcs8::DecodePrivateKey as _;
use tokio::sync::Mutex;

pub use whispera_proto::wire::ApnsEnv;
use whispera_proto::wire::{is_valid_request_id, is_valid_sealed};

/// Production APNs endpoint.
pub const PRODUCTION_URL: &str = "https://api.push.apple.com";
/// Sandbox (development) APNs endpoint.
pub const SANDBOX_URL: &str = "https://api.sandbox.push.apple.com";

/// The legacy payload ([`PushKind::Legacy`]). Generic by design: no request
/// content, sender, or metadata is ever included.
pub const PAYLOAD: &str =
    r#"{"aps":{"alert":{"title":"Whispera","body":"You have a new request"},"sound":"default"}}"#;

/// Provider tokens are refreshed once they are this old (Apple rejects tokens
/// older than 60 minutes and throttles refreshes more often than every 20).
pub const TOKEN_MAX_AGE_SECS: i64 = 50 * 60;

/// `apns-expiration` is set to now + this many seconds (legacy pushes).
pub const EXPIRATION_SECS: i64 = 3600;

/// `apns-expiration` for approval pushes: the 5-minute approval window.
pub const APPROVAL_EXPIRATION_SECS: i64 = 300;

/// Notification category the iOS app registers for approval actions.
pub const APPROVAL_CATEGORY: &str = "WL_APPROVAL";
/// `thread-id` grouping approval alerts.
pub const APPROVAL_THREAD_ID: &str = "wl-approvals";

/// An approval request id, validated against `^apr_[a-z0-9]{8,64}$`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestId(String);

impl RequestId {
    pub fn parse(s: &str) -> Option<Self> {
        is_valid_request_id(s).then(|| RequestId(s.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// An opaque, end-to-end sealed (WLP1) notification text: standard base64,
/// at most 2048 characters. The server cannot read it; only the phone's
/// Notification Service Extension can.
#[derive(Clone, PartialEq, Eq)]
pub struct SealedBlob(String);

impl SealedBlob {
    pub fn parse(s: &str) -> Option<Self> {
        is_valid_sealed(s).then(|| SealedBlob(s.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SealedBlob {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SealedBlob({} chars)", self.0.len())
    }
}

/// What to push. Every payload is derived from this enum alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushKind {
    /// The fixed generic alert ([`PAYLOAD`]).
    Legacy,
    /// An approval is waiting. With `sealed` the alert is "named": the phone's
    /// extension replaces the generic text with the decrypted one.
    Approval {
        request_id: RequestId,
        sealed: Option<SealedBlob>,
    },
    /// The approval was resolved elsewhere: silent background push.
    Resolved { request_id: RequestId },
}

impl PushKind {
    /// Short name for logs: `legacy`, `approval`, `approval.named`, `approval.resolved`.
    pub fn label(&self) -> &'static str {
        match self {
            PushKind::Legacy => "legacy",
            PushKind::Approval { sealed: None, .. } => "approval",
            PushKind::Approval {
                sealed: Some(_), ..
            } => "approval.named",
            PushKind::Resolved { .. } => "approval.resolved",
        }
    }

    /// The JSON body sent to APNs.
    pub fn payload(&self) -> String {
        use serde_json::json;
        match self {
            PushKind::Legacy => PAYLOAD.to_owned(),
            PushKind::Approval { request_id, sealed } => {
                let mut v = json!({
                    "aps": {
                        "alert": {"title": "Whispera", "body": "Approval requested"},
                        "sound": "default",
                        "category": APPROVAL_CATEGORY,
                        "thread-id": APPROVAL_THREAD_ID,
                    },
                    "wl": {"kind": "approval", "request_id": request_id.as_str()},
                });
                if let Some(sealed) = sealed {
                    v["aps"]["mutable-content"] = json!(1);
                    v["wl"]["sealed"] = json!(sealed.as_str());
                }
                v.to_string()
            }
            PushKind::Resolved { request_id } => json!({
                "aps": {"content-available": 1},
                "wl": {"kind": "approval.resolved", "request_id": request_id.as_str()},
            })
            .to_string(),
        }
    }

    /// `apns-push-type`.
    pub fn push_type(&self) -> &'static str {
        match self {
            PushKind::Resolved { .. } => "background",
            _ => "alert",
        }
    }

    /// `apns-priority` (background pushes must use 5).
    pub fn priority(&self) -> &'static str {
        match self {
            PushKind::Resolved { .. } => "5",
            _ => "10",
        }
    }

    /// `apns-collapse-id`: the request id for approval alerts, so a re-push of
    /// the same request replaces the banner instead of stacking.
    pub fn collapse_id(&self) -> Option<&str> {
        match self {
            PushKind::Approval { request_id, .. } => Some(request_id.as_str()),
            _ => None,
        }
    }

    /// Seconds from now until `apns-expiration`.
    pub fn expiration_secs(&self) -> i64 {
        match self {
            PushKind::Legacy => EXPIRATION_SECS,
            _ => APPROVAL_EXPIRATION_SECS,
        }
    }
}

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

const ENV_KEY_P8: &str = "APNS_AUTH_KEY_P8";
const ENV_KEY_P8_FILE: &str = "APNS_AUTH_KEY_P8_FILE";
const ENV_KEY_ID: &str = "APNS_KEY_ID";
const ENV_TEAM_ID: &str = "APNS_TEAM_ID";
const ENV_TOPIC: &str = "APNS_TOPIC";

/// Errors from configuration and client construction. Messages never contain
/// key material.
#[derive(Debug, thiserror::Error)]
pub enum ApnsError {
    /// Some, but not all, APNs variables were set. Holds variable *names*.
    #[error("incomplete APNs configuration; missing: {}", .0.join(", "))]
    MissingVars(Vec<String>),
    /// The `.p8` key file could not be read.
    #[error("failed to read APNs key file {path}: {kind}")]
    KeyFile {
        path: String,
        kind: std::io::ErrorKind,
    },
    /// The key is not a PKCS#8 PEM P-256 private key.
    #[error("APNs auth key is not a valid PKCS#8 PEM P-256 private key")]
    InvalidKey,
    /// A base URL was not http(s).
    #[error("invalid APNs base URL (must start with https:// or http://)")]
    InvalidUrl,
    /// The HTTP client could not be built.
    #[error("failed to build APNs HTTP client: {0}")]
    Http(String),
}

/// Result of a push attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushOutcome {
    /// Apple accepted the notification.
    Sent,
    /// The device token is no longer valid; the caller should clear it.
    Unregistered,
    /// Any other failure, with Apple's `reason` (or a short local reason).
    Failed(String),
}

/// PEM contents of the APNs `.p8` auth key. `Debug` never prints the value.
#[derive(Clone)]
pub struct SecretKey(String);

impl SecretKey {
    pub fn new(pem: impl Into<String>) -> Self {
        SecretKey(pem.into())
    }

    /// Exposes the PEM text. Never log the result.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

/// APNs token-auth configuration.
#[derive(Clone)]
pub struct ApnsConfig {
    pub key_p8: SecretKey,
    pub key_id: String,
    pub team_id: String,
    /// The app bundle id (sent as `apns-topic`).
    pub topic: String,
}

impl fmt::Debug for ApnsConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApnsConfig")
            .field("key_p8", &self.key_p8)
            .field("key_id", &self.key_id)
            .field("team_id", &self.team_id)
            .field("topic", &self.topic)
            .finish()
    }
}

fn read_key_file(path: &Path) -> Result<SecretKey, ApnsError> {
    std::fs::read_to_string(path)
        .map(SecretKey)
        .map_err(|e| ApnsError::KeyFile {
            path: path.display().to_string(),
            kind: e.kind(),
        })
}

impl ApnsConfig {
    /// Builds a config from a `.p8` key file path plus ids (e.g. from TOML).
    pub fn from_key_file(
        key_path: impl AsRef<Path>,
        key_id: impl Into<String>,
        team_id: impl Into<String>,
        topic: impl Into<String>,
    ) -> Result<Self, ApnsError> {
        Ok(ApnsConfig {
            key_p8: read_key_file(key_path.as_ref())?,
            key_id: key_id.into(),
            team_id: team_id.into(),
            topic: topic.into(),
        })
    }

    /// Reads `APNS_AUTH_KEY_P8` (PEM contents) or `APNS_AUTH_KEY_P8_FILE`
    /// (path), `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_TOPIC` via `get`.
    ///
    /// All absent → `Ok(None)` (push disabled). Partially present → error
    /// naming the missing variables. Empty values count as absent.
    pub fn from_env_map(
        get: impl Fn(&str) -> Option<String>,
    ) -> Result<Option<ApnsConfig>, ApnsError> {
        let get = |name: &str| get(name).filter(|v| !v.trim().is_empty());
        let key_inline = get(ENV_KEY_P8);
        let key_file = get(ENV_KEY_P8_FILE);
        let key_id = get(ENV_KEY_ID);
        let team_id = get(ENV_TEAM_ID);
        let topic = get(ENV_TOPIC);

        let has_key = key_inline.is_some() || key_file.is_some();
        if !has_key && key_id.is_none() && team_id.is_none() && topic.is_none() {
            return Ok(None);
        }

        let mut missing = Vec::new();
        if !has_key {
            missing.push(format!("{ENV_KEY_P8} or {ENV_KEY_P8_FILE}"));
        }
        for (name, v) in [
            (ENV_KEY_ID, &key_id),
            (ENV_TEAM_ID, &team_id),
            (ENV_TOPIC, &topic),
        ] {
            if v.is_none() {
                missing.push(name.to_string());
            }
        }
        if !missing.is_empty() {
            return Err(ApnsError::MissingVars(missing));
        }

        let key_p8 = match key_inline {
            // Allow single-line env values with literal "\n" escapes.
            Some(pem) => SecretKey(pem.replace("\\n", "\n")),
            None => read_key_file(Path::new(key_file.as_deref().unwrap_or_default()))?,
        };
        Ok(Some(ApnsConfig {
            key_p8,
            key_id: key_id.unwrap_or_default().trim().to_string(),
            team_id: team_id.unwrap_or_default().trim().to_string(),
            topic: topic.unwrap_or_default().trim().to_string(),
        }))
    }

    /// [`ApnsConfig::from_env_map`] over the process environment.
    pub fn from_env() -> Result<Option<ApnsConfig>, ApnsError> {
        Self::from_env_map(|name| std::env::var(name).ok())
    }
}

/// Source of the current Unix time (seconds). Injectable for tests.
pub trait Clock: Send + Sync {
    fn now_unix(&self) -> i64;
}

/// Wall-clock [`Clock`].
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }
}

struct CachedToken {
    jwt: String,
    iat: i64,
}

/// APNs client. Cheap to share behind an `Arc`; all methods take `&self`.
pub struct ApnsClient {
    http: reqwest::Client,
    signing_key: SigningKey,
    key_id: String,
    team_id: String,
    topic: String,
    production_url: String,
    sandbox_url: String,
    clock: Arc<dyn Clock>,
    token: Mutex<Option<CachedToken>>,
}

impl fmt::Debug for ApnsClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApnsClient")
            .field("signing_key", &"[redacted]")
            .field("key_id", &self.key_id)
            .field("team_id", &self.team_id)
            .field("topic", &self.topic)
            .field("production_url", &self.production_url)
            .field("sandbox_url", &self.sandbox_url)
            .finish_non_exhaustive()
    }
}

fn parse_key(key: &SecretKey) -> Result<SigningKey, ApnsError> {
    p256::SecretKey::from_pkcs8_pem(key.expose().trim())
        .map(SigningKey::from)
        .map_err(|_| ApnsError::InvalidKey)
}

fn normalize_base(url: &str) -> Result<String, ApnsError> {
    let url = url.trim().trim_end_matches('/');
    if url.starts_with("https://") || url.starts_with("http://") {
        Ok(url.to_string())
    } else {
        Err(ApnsError::InvalidUrl)
    }
}

/// Last 8 characters of a device token, for logs.
fn token_suffix(token: &str) -> &str {
    let start = token.len().saturating_sub(8);
    token.get(start..).unwrap_or("")
}

fn valid_device_token(token: &str) -> bool {
    (64..=200).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Keeps Apple's reason short and printable.
fn sanitize_reason(reason: &str) -> String {
    reason
        .chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .take(100)
        .collect()
}

impl ApnsClient {
    /// Production client: Apple's endpoints, HTTP/2 only (ALPN `h2`).
    /// Fails if the key cannot be parsed.
    pub fn new(cfg: ApnsConfig) -> Result<Self, ApnsError> {
        let http = reqwest::Client::builder()
            .http2_prior_knowledge()
            .https_only(true)
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| ApnsError::Http(e.to_string()))?;
        Self::build(cfg, http, PRODUCTION_URL, SANDBOX_URL)
    }

    /// Client with custom base URLs (e.g. a local mock). Allows `http://` and
    /// negotiates the HTTP version normally (HTTP/1.1 over plain HTTP).
    pub fn with_base_urls(
        cfg: ApnsConfig,
        production_url: &str,
        sandbox_url: &str,
    ) -> Result<Self, ApnsError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| ApnsError::Http(e.to_string()))?;
        Self::build(cfg, http, production_url, sandbox_url)
    }

    /// Replaces the clock (tests).
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    fn build(
        cfg: ApnsConfig,
        http: reqwest::Client,
        production_url: &str,
        sandbox_url: &str,
    ) -> Result<Self, ApnsError> {
        let signing_key = parse_key(&cfg.key_p8)?;
        Ok(ApnsClient {
            http,
            signing_key,
            key_id: cfg.key_id,
            team_id: cfg.team_id,
            topic: cfg.topic,
            production_url: normalize_base(production_url)?,
            sandbox_url: normalize_base(sandbox_url)?,
            clock: Arc::new(SystemClock),
            token: Mutex::new(None),
        })
    }

    fn mint(&self, iat: i64) -> String {
        let header = serde_json::json!({ "alg": "ES256", "kid": self.key_id });
        let claims = serde_json::json!({ "iss": self.team_id, "iat": iat });
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        // JWS ES256: raw 64-byte r||s, not DER.
        let sig: Signature = self.signing_key.sign(signing_input.as_bytes());
        format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    /// Returns the cached provider token, minting a new one if absent or
    /// older than [`TOKEN_MAX_AGE_SECS`].
    async fn provider_token(&self) -> String {
        let now = self.clock.now_unix();
        let mut guard = self.token.lock().await;
        if let Some(t) = guard.as_ref() {
            let age = now - t.iat;
            if (0..TOKEN_MAX_AGE_SECS).contains(&age) {
                return t.jwt.clone();
            }
        }
        let jwt = self.mint(now);
        tracing::debug!("apns: minted new provider token");
        *guard = Some(CachedToken {
            jwt: jwt.clone(),
            iat: now,
        });
        jwt
    }

    /// Drops the cached token if it is still the one that Apple rejected.
    async fn invalidate(&self, jwt: &str) {
        let mut guard = self.token.lock().await;
        if guard.as_ref().is_some_and(|t| t.jwt == jwt) {
            *guard = None;
        }
    }

    /// Sends the fixed generic notification ([`PushKind::Legacy`]) to `device_token`.
    pub async fn notify(&self, device_token: &str, env: ApnsEnv) -> PushOutcome {
        self.send(device_token, env, &PushKind::Legacy).await
    }

    /// Sends the notification described by `kind` to `device_token`.
    pub async fn send(&self, device_token: &str, env: ApnsEnv, kind: &PushKind) -> PushOutcome {
        let suffix = token_suffix(device_token);
        if !valid_device_token(device_token) {
            tracing::warn!(token_suffix = %suffix, "apns: invalid device token, not sending");
            return PushOutcome::Failed("invalid token".into());
        }

        let base = match env {
            ApnsEnv::Production => &self.production_url,
            ApnsEnv::Sandbox => &self.sandbox_url,
        };
        let url = format!("{base}/3/device/{device_token}");
        let jwt = self.provider_token().await;
        let expiration = self.clock.now_unix() + kind.expiration_secs();

        let mut req = self
            .http
            .post(url)
            .header("authorization", format!("bearer {jwt}"))
            .header("apns-topic", &self.topic)
            .header("apns-push-type", kind.push_type())
            .header("apns-priority", kind.priority())
            .header("apns-expiration", expiration.to_string())
            .header("content-type", "application/json");
        if let Some(collapse) = kind.collapse_id() {
            req = req.header("apns-collapse-id", collapse);
        }
        let resp = req.body(kind.payload()).send().await;

        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                // without_url(): the URL contains the full device token.
                let e = e.without_url();
                tracing::warn!(token_suffix = %suffix, error = %e, "apns: request failed");
                return PushOutcome::Failed(format!("request error: {e}"));
            }
        };

        let status = resp.status().as_u16();
        if status == 200 {
            tracing::debug!(token_suffix = %suffix, env = env.as_str(), kind = kind.label(), "apns: sent");
            return PushOutcome::Sent;
        }

        let reason = resp
            .bytes()
            .await
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| {
                v.get("reason")
                    .and_then(|r| r.as_str())
                    .map(sanitize_reason)
            })
            .unwrap_or_default();

        tracing::warn!(token_suffix = %suffix, env = env.as_str(), status, reason = %reason, "apns: push rejected");

        match (status, reason.as_str()) {
            (410, _) | (400, "BadDeviceToken") | (400, "DeviceTokenNotForTopic") => {
                PushOutcome::Unregistered
            }
            (403, "ExpiredProviderToken") | (403, "InvalidProviderToken") => {
                self.invalidate(&jwt).await;
                PushOutcome::Failed(reason)
            }
            (_, "") => PushOutcome::Failed(format!("HTTP {status}")),
            _ => PushOutcome::Failed(reason),
        }
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn token_validation() {
        assert!(valid_device_token(&"a".repeat(64)));
        assert!(valid_device_token(&"F0".repeat(100)));
        assert!(!valid_device_token(&"a".repeat(63)));
        assert!(!valid_device_token(&"a".repeat(201)));
        assert!(!valid_device_token(&"g".repeat(64)));
        assert_eq!(token_suffix("0123456789abcdef"), "89abcdef");
        assert_eq!(token_suffix("abc"), "abc");
    }

    #[test]
    fn typed_values_are_validated() {
        assert!(RequestId::parse("apr_0123abcd").is_some());
        assert!(RequestId::parse("apr_\"}x\"").is_none());
        assert!(RequestId::parse("hello world").is_none());
        assert!(SealedBlob::parse("AAECAw==").is_some());
        assert!(SealedBlob::parse("not base64!").is_none());
        assert_eq!(
            format!("{:?}", SealedBlob::parse("AAECAw==").unwrap()),
            "SealedBlob(8 chars)"
        );
    }

    #[test]
    fn payload_is_valid_json() {
        let v: serde_json::Value = serde_json::from_str(PAYLOAD).unwrap();
        assert_eq!(v["aps"]["alert"]["title"], "Whispera");
    }
}
