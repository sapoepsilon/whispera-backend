//! Generic OIDC JWT verification.
//!
//! Works with any OpenID Connect provider that publishes a JWKS (Clerk,
//! Zitadel, Keycloak, Auth0, Google, ...). The provider is pure configuration:
//!
//! * **Clerk** session tokens carry no `aud` but carry `azp` (the origin of the
//!   frontend that minted them). Configure
//!   `issuer = "https://<your>.clerk.accounts.dev"`, leave `audiences` empty and
//!   set `authorized_parties = ["https://app.example.com", ...]`.
//! * **Zitadel / Keycloak / Auth0**: set `issuer` and `audiences` to the API's
//!   audience / client id (optionally `authorized_parties` too).
//!
//! # Audience rule
//!
//! A verifier that accepts tokens for *any* audience would accept tokens minted
//! for unrelated apps of the same issuer. Therefore construction fails when
//! `audiences` is empty **unless** `authorized_parties` is non-empty, in which
//! case `azp` is the binding check (Clerk-style) and `aud` is not checked.
//! When `audiences` is non-empty, the token's `aud` must intersect it.
//!
//! # Checks performed
//!
//! `alg` in the allow-list (`none` and `HS*` are never accepted), key lookup
//! by `kid` (unknown kid → one JWKS refetch, at most every
//! [`UNKNOWN_KID_REFETCH_INTERVAL`]), signature, `iss` exact match, `exp`
//! required, `nbf`/`iat` with leeway, `aud`/`azp` as above, non-empty `sub`.
//!
//! # Transport
//!
//! Discovery and JWKS URLs must be `https://`, except for loopback hosts
//! (`localhost`, `127.0.0.0/8`, `::1`) which may use `http://` for local
//! development and tests. HTTP requests time out after 10 s.

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::Deserialize;

use crate::{AccountAuth, AccountIdentity, AuthError, ConfigError};

/// Minimum spacing between JWKS refetches triggered by an unknown `kid`.
pub const UNKNOWN_KID_REFETCH_INTERVAL: Duration = Duration::from_secs(30);
/// Minimum spacing between TTL refreshes after a failed JWKS fetch.
pub const FAILED_REFRESH_BACKOFF: Duration = Duration::from_secs(30);
/// Timeout for discovery and JWKS HTTP requests.
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// Maximum accepted size of a discovery document or JWKS.
const MAX_DOC_BYTES: usize = 1024 * 1024;
/// Minimum RSA modulus size accepted from a JWKS (bits).
const MIN_RSA_BITS: usize = 2048;

fn default_leeway() -> u64 {
    30
}
fn default_ttl() -> u64 {
    600
}
fn default_algs() -> Vec<Algorithm> {
    vec![Algorithm::RS256, Algorithm::ES256]
}

/// OIDC verifier configuration.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct OidcConfig {
    /// Expected issuer, e.g. `https://example.clerk.accounts.dev`.
    pub issuer: String,
    /// Accepted audiences; the token's `aud` must intersect this list. May be
    /// empty only if `authorized_parties` is non-empty (see module docs).
    #[serde(default)]
    pub audiences: Vec<String>,
    /// `azp` allow-list. If non-empty, `azp` must be present and listed.
    #[serde(default)]
    pub authorized_parties: Vec<String>,
    /// JWKS URL. If set, discovery is skipped.
    #[serde(default)]
    pub jwks_uri: Option<String>,
    /// Clock skew tolerance for `exp`/`nbf`/`iat`, seconds (default 30).
    #[serde(default = "default_leeway")]
    pub leeway_s: u64,
    /// JWKS cache lifetime, seconds (default 600).
    #[serde(default = "default_ttl")]
    pub jwks_cache_ttl_s: u64,
    /// Accepted signature algorithms (default `[RS256, ES256]`). Supported:
    /// RS256/384/512, PS256/384/512, ES256, ES384.
    #[serde(default = "default_algs")]
    pub allowed_algs: Vec<Algorithm>,
}

impl Default for OidcConfig {
    fn default() -> Self {
        Self {
            issuer: String::new(),
            audiences: Vec::new(),
            authorized_parties: Vec::new(),
            jwks_uri: None,
            leeway_s: default_leeway(),
            jwks_cache_ttl_s: default_ttl(),
            allowed_algs: default_algs(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyFamily {
    Rsa,
    P256,
    P384,
}

fn family_for(alg: Algorithm) -> Option<KeyFamily> {
    match alg {
        Algorithm::RS256
        | Algorithm::RS384
        | Algorithm::RS512
        | Algorithm::PS256
        | Algorithm::PS384
        | Algorithm::PS512 => Some(KeyFamily::Rsa),
        Algorithm::ES256 => Some(KeyFamily::P256),
        Algorithm::ES384 => Some(KeyFamily::P384),
        _ => None,
    }
}

struct KeyEntry {
    kid: Option<String>,
    family: KeyFamily,
    alg: Option<Algorithm>,
    key: DecodingKey,
}

struct KeySet {
    keys: Vec<KeyEntry>,
    fetched_at: Instant,
}

#[derive(Deserialize)]
struct RawJwk {
    kty: Option<String>,
    kid: Option<String>,
    alg: Option<String>,
    #[serde(rename = "use")]
    use_: Option<String>,
    crv: Option<String>,
    n: Option<String>,
    e: Option<String>,
    x: Option<String>,
    y: Option<String>,
}

#[derive(Deserialize)]
struct RawJwks {
    keys: Vec<serde_json::Value>,
}

fn b64(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok()
}

fn parse_jwk(v: serde_json::Value) -> Result<KeyEntry, String> {
    let jwk: RawJwk = serde_json::from_value(v).map_err(|e| e.to_string())?;
    if let Some(u) = &jwk.use_ {
        if u != "sig" {
            return Err(format!("use={u}"));
        }
    }
    let alg = match &jwk.alg {
        Some(a) => Some(
            a.parse::<Algorithm>()
                .map_err(|_| format!("unsupported alg {a}"))?,
        ),
        None => None,
    };
    let (family, key) = match jwk.kty.as_deref() {
        Some("RSA") => {
            let n = jwk.n.as_deref().and_then(b64).ok_or("bad n")?;
            let e = jwk.e.as_deref().and_then(b64).ok_or("bad e")?;
            let n_trim = n.iter().skip_while(|b| **b == 0).count();
            if n_trim * 8 < MIN_RSA_BITS {
                return Err("rsa key too small".into());
            }
            (KeyFamily::Rsa, DecodingKey::from_rsa_raw_components(&n, &e))
        }
        Some("EC") => {
            let (family, len) = match jwk.crv.as_deref() {
                Some("P-256") => (KeyFamily::P256, 32),
                Some("P-384") => (KeyFamily::P384, 48),
                other => return Err(format!("unsupported crv {other:?}")),
            };
            let (x, y) = (
                jwk.x.as_deref().ok_or("no x")?,
                jwk.y.as_deref().ok_or("no y")?,
            );
            if b64(x).map(|v| v.len()) != Some(len) || b64(y).map(|v| v.len()) != Some(len) {
                return Err("bad ec coordinates".into());
            }
            let key = DecodingKey::from_ec_components(x, y).map_err(|e| e.to_string())?;
            (family, key)
        }
        other => return Err(format!("unsupported kty {other:?}")),
    };
    if let Some(a) = alg {
        if family_for(a) != Some(family) {
            return Err("alg does not match key type".into());
        }
    }
    Ok(KeyEntry {
        kid: jwk.kid,
        family,
        alg,
        key,
    })
}

fn parse_jwks(json: &str) -> Result<Vec<KeyEntry>, String> {
    let raw: RawJwks = serde_json::from_str(json).map_err(|e| format!("invalid JWKS: {e}"))?;
    let mut keys = Vec::new();
    for v in raw.keys {
        match parse_jwk(v) {
            Ok(k) => keys.push(k),
            Err(e) => tracing::debug!(reason = %e, "skipping JWK"),
        }
    }
    if keys.is_empty() {
        return Err("JWKS contains no usable signing keys".into());
    }
    Ok(keys)
}

fn check_url(url: &str, what: &str) -> Result<(), String> {
    let u = url::Url::parse(url).map_err(|e| format!("{what}: invalid URL: {e}"))?;
    match u.scheme() {
        "https" => Ok(()),
        "http" => {
            let loopback = match u.host() {
                Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                None => false,
            };
            if loopback {
                Ok(())
            } else {
                Err(format!(
                    "{what}: must use https (http only allowed for loopback)"
                ))
            }
        }
        s => Err(format!("{what}: unsupported scheme {s}")),
    }
}

async fn fetch_text(http: &reqwest::Client, url: &str) -> Result<String, String> {
    let mut resp = http
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url}: HTTP {}", resp.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("GET {url}: {e}"))? {
        if body.len() + chunk.len() > MAX_DOC_BYTES {
            return Err(format!("GET {url}: response too large"));
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| format!("GET {url}: body is not UTF-8"))
}

struct Inner {
    cfg: OidcConfig,
    /// Exact `iss` value tokens must carry.
    issuer: String,
    jwks_uri: Option<String>,
    http: Option<reqwest::Client>,
    keys: RwLock<Arc<KeySet>>,
    /// Serialises refreshes and remembers when they last ran.
    refresh: tokio::sync::Mutex<RefreshState>,
}

#[derive(Default)]
struct RefreshState {
    /// Time of the last unknown-kid refetch.
    last_forced: Option<Instant>,
    /// Time of the last failed refetch; further TTL refreshes back off until
    /// [`FAILED_REFRESH_BACKOFF`] has passed, so an unreachable JWKS endpoint does
    /// not make every request wait for an HTTP timeout.
    last_failed: Option<Instant>,
}

/// OIDC JWT verifier. Cheap to clone.
#[derive(Clone)]
pub struct OidcAuth {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for OidcAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OidcAuth")
            .field("issuer", &self.inner.issuer)
            .field("jwks_uri", &self.inner.jwks_uri)
            .finish()
    }
}

fn validate_config(cfg: &OidcConfig) -> Result<(), ConfigError> {
    let bad = |m: String| Err(ConfigError::Invalid(m));
    if cfg.issuer.trim().is_empty() {
        return bad("oidc: issuer is required".into());
    }
    if cfg.audiences.is_empty() && cfg.authorized_parties.is_empty() {
        return bad(
            "oidc: audiences is empty; set audiences, or authorized_parties for azp-bound \
             tokens without aud (e.g. Clerk)"
                .into(),
        );
    }
    if cfg.audiences.iter().any(|a| a.is_empty())
        || cfg.authorized_parties.iter().any(|a| a.is_empty())
    {
        return bad("oidc: empty audience / authorized party".into());
    }
    if cfg.allowed_algs.is_empty() {
        return bad("oidc: allowed_algs is empty".into());
    }
    for a in &cfg.allowed_algs {
        if family_for(*a).is_none() {
            return bad(format!("oidc: algorithm {a:?} is not allowed"));
        }
    }
    Ok(())
}

impl OidcAuth {
    fn build(
        cfg: OidcConfig,
        issuer: String,
        jwks_uri: Option<String>,
        http: Option<reqwest::Client>,
        keys: Vec<KeyEntry>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                cfg,
                issuer,
                jwks_uri,
                http,
                keys: RwLock::new(Arc::new(KeySet {
                    keys,
                    fetched_at: Instant::now(),
                })),
                refresh: tokio::sync::Mutex::new(RefreshState::default()),
            }),
        }
    }

    /// Construct from a static JWKS document (no network; keys never refresh).
    /// The configured `issuer` is used verbatim as the expected `iss`.
    pub fn from_jwks(config: OidcConfig, jwks_json: &str) -> Result<Self, ConfigError> {
        validate_config(&config)?;
        let keys = parse_jwks(jwks_json).map_err(ConfigError::Invalid)?;
        let issuer = config.issuer.clone();
        Ok(Self::build(config, issuer, None, None, keys))
    }

    /// Discover the provider (unless `jwks_uri` is configured) and fetch its JWKS.
    ///
    /// Discovery fetches `{issuer}/.well-known/openid-configuration` (a trailing
    /// slash on `issuer` is ignored when building the URL) and requires the
    /// document's `issuer` to equal the configured one (modulo a trailing
    /// slash); the document's value then becomes the exact expected `iss`.
    pub async fn discover(config: OidcConfig) -> Result<Self, ConfigError> {
        validate_config(&config)?;
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .connect_timeout(HTTP_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()
            .map_err(|e| ConfigError::Discovery(format!("http client: {e}")))?;

        let (issuer, jwks_uri) = match &config.jwks_uri {
            Some(uri) => {
                check_url(uri, "jwks_uri").map_err(ConfigError::Invalid)?;
                (config.issuer.clone(), uri.clone())
            }
            None => {
                let base = config.issuer.trim_end_matches('/');
                check_url(base, "issuer").map_err(ConfigError::Invalid)?;
                let url = format!("{base}/.well-known/openid-configuration");
                let text = fetch_text(&http, &url)
                    .await
                    .map_err(ConfigError::Discovery)?;
                #[derive(Deserialize)]
                struct Discovery {
                    issuer: String,
                    jwks_uri: String,
                }
                let doc: Discovery = serde_json::from_str(&text).map_err(|e| {
                    ConfigError::Discovery(format!("invalid discovery document: {e}"))
                })?;
                if doc.issuer.trim_end_matches('/') != base {
                    return Err(ConfigError::Discovery(format!(
                        "discovery issuer mismatch: configured {}, document says {}",
                        config.issuer, doc.issuer
                    )));
                }
                check_url(&doc.jwks_uri, "jwks_uri").map_err(ConfigError::Discovery)?;
                (doc.issuer, doc.jwks_uri)
            }
        };

        let text = fetch_text(&http, &jwks_uri)
            .await
            .map_err(ConfigError::Discovery)?;
        let keys = parse_jwks(&text).map_err(ConfigError::Discovery)?;
        Ok(Self::build(
            config,
            issuer,
            Some(jwks_uri),
            Some(http),
            keys,
        ))
    }

    /// The exact `iss` value accepted.
    pub fn issuer(&self) -> &str {
        &self.inner.issuer
    }

    fn snapshot(&self) -> Arc<KeySet> {
        self.inner.keys.read().expect("key lock poisoned").clone()
    }

    /// Refetch the JWKS. `forced` = triggered by an unknown kid (rate-limited).
    /// Returns true if the key set was replaced.
    async fn refresh(&self, forced: bool, seen: Instant) -> bool {
        let (Some(http), Some(uri)) = (&self.inner.http, &self.inner.jwks_uri) else {
            return false;
        };
        let mut state = self.inner.refresh.lock().await;
        // Someone else refreshed while we waited.
        if self.snapshot().fetched_at > seen {
            return true;
        }
        if forced {
            if let Some(t) = state.last_forced {
                if t.elapsed() < UNKNOWN_KID_REFETCH_INTERVAL {
                    return false;
                }
            }
            state.last_forced = Some(Instant::now());
        } else if let Some(t) = state.last_failed {
            if t.elapsed() < FAILED_REFRESH_BACKOFF {
                return false;
            }
        }
        match fetch_text(http, uri).await.and_then(|t| parse_jwks(&t)) {
            Ok(keys) => {
                state.last_failed = None;
                *self.inner.keys.write().expect("key lock poisoned") = Arc::new(KeySet {
                    keys,
                    fetched_at: Instant::now(),
                });
                true
            }
            Err(e) => {
                state.last_failed = Some(Instant::now());
                tracing::warn!(error = %e, "JWKS refresh failed; keeping cached keys");
                false
            }
        }
    }

    fn find_key<'a>(
        set: &'a KeySet,
        kid: Option<&str>,
        alg: Algorithm,
        family: KeyFamily,
    ) -> Option<&'a KeyEntry> {
        let compatible =
            |k: &&KeyEntry| k.family == family && k.alg.map(|a| a == alg).unwrap_or(true);
        match kid {
            Some(kid) => set
                .keys
                .iter()
                .filter(compatible)
                .find(|k| k.kid.as_deref() == Some(kid)),
            None => {
                let mut it = set.keys.iter().filter(compatible);
                match (it.next(), it.next()) {
                    (Some(k), None) => Some(k),
                    _ => None,
                }
            }
        }
    }

    fn verify_with(
        &self,
        token: &str,
        alg: Algorithm,
        key: &DecodingKey,
    ) -> Result<AccountIdentity, AuthError> {
        let cfg = &self.inner.cfg;
        let mut v = Validation::new(alg);
        v.leeway = cfg.leeway_s;
        v.validate_exp = true;
        v.validate_nbf = true;
        v.set_issuer(&[&self.inner.issuer]);
        let mut required = vec!["exp", "iss", "sub"];
        if cfg.audiences.is_empty() {
            v.validate_aud = false;
        } else {
            v.set_audience(&cfg.audiences);
            required.push("aud");
        }
        v.set_required_spec_claims(&required);

        #[derive(Deserialize)]
        struct Claims {
            sub: Option<serde_json::Value>,
            azp: Option<serde_json::Value>,
            iat: Option<serde_json::Value>,
        }
        let data = jsonwebtoken::decode::<Claims>(token, key, &v).map_err(|e| {
            let code = match e.kind() {
                ErrorKind::InvalidSignature => "bad_signature".to_string(),
                ErrorKind::ExpiredSignature => "expired".to_string(),
                ErrorKind::ImmatureSignature => "not_yet_valid".to_string(),
                ErrorKind::InvalidIssuer => "wrong_issuer".to_string(),
                ErrorKind::InvalidAudience => "wrong_audience".to_string(),
                ErrorKind::InvalidAlgorithm => "alg_not_allowed".to_string(),
                ErrorKind::MissingRequiredClaim(c) => format!("missing_{c}"),
                _ => format!("malformed: {e}"),
            };
            AuthError::Invalid(code)
        })?;
        let claims = data.claims;

        if let Some(iat) = claims.iat {
            let iat = iat
                .as_u64()
                .ok_or_else(|| AuthError::Invalid("malformed_iat".into()))?;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if iat > now.saturating_add(cfg.leeway_s) {
                return Err(AuthError::Invalid("iat_in_future".into()));
            }
        }

        if !cfg.authorized_parties.is_empty() {
            match claims.azp {
                None => return Err(AuthError::Invalid("missing_azp".into())),
                Some(serde_json::Value::String(azp)) if cfg.authorized_parties.contains(&azp) => {}
                Some(_) => return Err(AuthError::Invalid("azp_not_allowed".into())),
            }
        }

        let sub = match claims.sub {
            Some(serde_json::Value::String(s)) if !s.is_empty() => s,
            _ => return Err(AuthError::Invalid("missing_sub".into())),
        };
        Ok(AccountIdentity {
            issuer: self.inner.issuer.clone(),
            subject: sub,
        })
    }
}

/// Read `alg`/`kid` from the JOSE header without trusting anything else.
fn read_header(token: &str) -> Result<(String, Option<String>), AuthError> {
    let malformed = || AuthError::Invalid("malformed".into());
    let mut parts = token.split('.');
    let (Some(h), Some(_), Some(_), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(malformed());
    };
    let bytes = b64(h).ok_or_else(malformed)?;
    #[derive(Deserialize)]
    struct Header {
        alg: Option<String>,
        kid: Option<String>,
        crit: Option<serde_json::Value>,
    }
    let hdr: Header = serde_json::from_slice(&bytes).map_err(|_| malformed())?;
    if hdr.crit.is_some() {
        return Err(AuthError::Invalid("unsupported_crit".into()));
    }
    Ok((hdr.alg.ok_or_else(malformed)?, hdr.kid))
}

#[async_trait::async_trait]
impl AccountAuth for OidcAuth {
    async fn authenticate(&self, bearer_token: &str) -> Result<AccountIdentity, AuthError> {
        if bearer_token.is_empty() {
            return Err(AuthError::Missing);
        }
        let (alg_name, kid) = read_header(bearer_token)?;
        let alg = alg_name
            .parse::<Algorithm>()
            .ok()
            .filter(|a| self.inner.cfg.allowed_algs.contains(a))
            .ok_or_else(|| AuthError::Invalid("alg_not_allowed".into()))?;
        let family = family_for(alg).ok_or_else(|| AuthError::Invalid("alg_not_allowed".into()))?;

        let mut set = self.snapshot();
        let ttl = Duration::from_secs(self.inner.cfg.jwks_cache_ttl_s);
        if self.inner.jwks_uri.is_some() && set.fetched_at.elapsed() >= ttl {
            self.refresh(false, set.fetched_at).await;
            set = self.snapshot();
        }

        if Self::find_key(&set, kid.as_deref(), alg, family).is_none()
            && self.inner.jwks_uri.is_some()
            && self.refresh(true, set.fetched_at).await
        {
            set = self.snapshot();
        }
        let key = Self::find_key(&set, kid.as_deref(), alg, family)
            .ok_or_else(|| AuthError::Invalid("unknown_kid".into()))?;
        self.verify_with(bearer_token, alg, &key.key)
    }

    fn kind(&self) -> &'static str {
        "oidc"
    }
}
