//! **DEV / TEST ONLY.** A tiny OpenID Connect provider for local Whispera
//! development and tests. It has no passwords: anyone who can reach it can sign
//! in as any configured user. It only ever binds loopback addresses.
//! Never deploy it, never point a production server at it.
//!
//! Endpoints (issuer = its base URL, e.g. `http://127.0.0.1:18081`):
//!
//! | Method | Path | |
//! |---|---|---|
//! | GET | `/.well-known/openid-configuration` | discovery |
//! | GET | `/jwks.json` | ES256 public key |
//! | GET | `/authorize` | authorization code + PKCE (S256 only, `state` required); HTML page with one button per user, or `login_hint=<user>` to approve at once |
//! | POST | `/authorize` | the page's form submit |
//! | POST | `/token` | `authorization_code` (with `code_verifier`) and `refresh_token` grants |
//!
//! Tokens are ES256 JWTs with `iss` = issuer, `aud` = client id, `sub` = user name.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Form, Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Default listen address / issuer port.
pub const DEFAULT_PORT: u16 = 18081;
/// Default OAuth client id (and token audience).
pub const DEFAULT_CLIENT_ID: &str = "whispera";
/// Default users.
pub const DEFAULT_USERS: &[&str] = &["alice", "bob"];
/// Default redirect URI allow-list.
pub const DEFAULT_REDIRECT_URIS: &[&str] =
    &["whispera://auth/callback", "whispera-mac://auth/callback"];
/// Default token lifetime (seconds).
pub const DEFAULT_TOKEN_TTL_S: i64 = 3600;
/// Authorization codes are single-use and live this long (seconds).
pub const CODE_TTL_S: i64 = 120;

#[derive(Debug, thiserror::Error)]
pub enum IdpError {
    #[error("refusing to bind {0}: whispera-dev-idp only listens on loopback addresses")]
    NotLoopback(SocketAddr),
    #[error("key file {path}: {msg}")]
    Key { path: String, msg: String },
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn random_token(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

/// Refuse anything but a loopback bind address.
pub fn ensure_loopback(addr: SocketAddr) -> Result<(), IdpError> {
    if addr.ip().is_loopback() {
        Ok(())
    } else {
        Err(IdpError::NotLoopback(addr))
    }
}

// ---------------------------------------------------------------- key

/// The provider's ES256 signing key.
#[derive(Clone)]
pub struct IdpKey {
    secret: p256::SecretKey,
    encoding: EncodingKey,
    kid: String,
}

impl IdpKey {
    fn from_secret(secret: p256::SecretKey) -> Self {
        let der = secret.to_pkcs8_der().expect("P-256 key encodes as PKCS#8");
        let point = secret.public_key().to_encoded_point(false);
        let kid = URL_SAFE_NO_PAD.encode(&Sha256::digest(point.as_bytes())[..12]);
        Self {
            encoding: EncodingKey::from_ec_der(der.as_bytes()),
            secret,
            kid,
        }
    }

    /// A fresh in-memory key.
    pub fn generate() -> Self {
        Self::from_secret(p256::SecretKey::random(&mut rand::rngs::OsRng))
    }

    /// Parse a PKCS#8 PEM P-256 private key.
    pub fn from_pem(pem: &str) -> Result<Self, String> {
        p256::SecretKey::from_pkcs8_pem(pem)
            .map(Self::from_secret)
            .map_err(|e| format!("not a PKCS#8 PEM P-256 private key: {e}"))
    }

    pub fn to_pem(&self) -> String {
        self.secret
            .to_pkcs8_pem(LineEnding::LF)
            .expect("P-256 key encodes as PEM")
            .to_string()
    }

    /// Load the key at `path`, creating it (mode 0600) if missing.
    /// Returns the key and whether it was just created.
    pub fn load_or_create(path: &Path) -> Result<(Self, bool), IdpError> {
        let err = |msg: String| IdpError::Key {
            path: path.display().to_string(),
            msg,
        };
        match std::fs::read_to_string(path) {
            Ok(pem) => return Self::from_pem(&pem).map(|k| (k, false)).map_err(err),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(err(e.to_string())),
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| err(e.to_string()))?;
        }
        let key = Self::generate();
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        match opts.open(path) {
            Ok(mut f) => {
                use std::io::Write;
                f.write_all(key.to_pem().as_bytes())
                    .map_err(|e| err(e.to_string()))?;
                Ok((key, true))
            }
            // Someone else created it in the meantime: use theirs.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Self::load_or_create(path),
            Err(e) => Err(err(e.to_string())),
        }
    }

    pub fn kid(&self) -> &str {
        &self.kid
    }

    /// The public JWKS document.
    pub fn jwks(&self) -> Value {
        let p = self.secret.public_key().to_encoded_point(false);
        json!({"keys": [{
            "kty": "EC", "crv": "P-256", "use": "sig", "alg": "ES256", "kid": self.kid,
            "x": URL_SAFE_NO_PAD.encode(p.x().expect("uncompressed")),
            "y": URL_SAFE_NO_PAD.encode(p.y().expect("uncompressed")),
        }]})
    }

    /// Sign `claims` as an ES256 JWT with this key's `kid`.
    pub fn sign(&self, claims: &Value) -> String {
        let mut h = Header::new(Algorithm::ES256);
        h.kid = Some(self.kid.clone());
        jsonwebtoken::encode(&h, claims, &self.encoding).expect("ES256 signing")
    }
}

// ---------------------------------------------------------------- provider

/// Provider settings.
#[derive(Debug, Clone)]
pub struct IdpConfig {
    /// Base URL; becomes `iss`. No trailing slash.
    pub issuer: String,
    pub client_id: String,
    pub users: Vec<String>,
    pub redirect_uris: Vec<String>,
    pub token_ttl_s: i64,
}

impl IdpConfig {
    /// Defaults for an issuer.
    pub fn new(issuer: impl Into<String>) -> Self {
        Self {
            issuer: issuer.into().trim_end_matches('/').to_string(),
            client_id: DEFAULT_CLIENT_ID.into(),
            users: DEFAULT_USERS.iter().map(|s| s.to_string()).collect(),
            redirect_uris: DEFAULT_REDIRECT_URIS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            token_ttl_s: DEFAULT_TOKEN_TTL_S,
        }
    }
}

struct CodeGrant {
    user: String,
    redirect_uri: String,
    challenge: String,
    scope: String,
    nonce: Option<String>,
    expires_at: i64,
}

struct RefreshGrant {
    user: String,
    scope: String,
}

/// The provider. Share it as `Arc<DevIdp>`.
pub struct DevIdp {
    cfg: IdpConfig,
    key: IdpKey,
    codes: Mutex<HashMap<String, CodeGrant>>,
    refresh: Mutex<HashMap<String, RefreshGrant>>,
}

/// Token endpoint response.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub id_token: String,
    pub refresh_token: String,
    pub token_type: String,
    pub expires_in: i64,
    pub scope: String,
}

impl DevIdp {
    pub fn new(cfg: IdpConfig, key: IdpKey) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            key,
            codes: Mutex::new(HashMap::new()),
            refresh: Mutex::new(HashMap::new()),
        })
    }

    pub fn config(&self) -> &IdpConfig {
        &self.cfg
    }

    pub fn key(&self) -> &IdpKey {
        &self.key
    }

    fn base_claims(&self, user: &str) -> Value {
        let t = now();
        json!({
            "iss": self.cfg.issuer,
            "sub": user,
            "aud": self.cfg.client_id,
            "iat": t,
            "nbf": t,
            "exp": t + self.cfg.token_ttl_s,
            "preferred_username": user,
        })
    }

    /// An OIDC id_token for `user`.
    pub fn mint_id_token(&self, user: &str, nonce: Option<&str>) -> String {
        let mut c = self.base_claims(user);
        c["azp"] = json!(self.cfg.client_id);
        c["auth_time"] = json!(now());
        if let Some(n) = nonce {
            c["nonce"] = json!(n);
        }
        self.key.sign(&c)
    }

    /// A JWT access token for `user` (same `iss`/`aud`/`sub` as the id_token).
    pub fn mint_access_token(&self, user: &str, scope: &str) -> String {
        let mut c = self.base_claims(user);
        c["client_id"] = json!(self.cfg.client_id);
        c["scope"] = json!(scope);
        c["jti"] = json!(random_token(12));
        self.key.sign(&c)
    }

    fn issue(&self, user: &str, scope: &str, nonce: Option<&str>) -> TokenResponse {
        let refresh_token = random_token(32);
        self.refresh.lock().unwrap().insert(
            refresh_token.clone(),
            RefreshGrant {
                user: user.into(),
                scope: scope.into(),
            },
        );
        TokenResponse {
            access_token: self.mint_access_token(user, scope),
            id_token: self.mint_id_token(user, nonce),
            refresh_token,
            token_type: "Bearer".into(),
            expires_in: self.cfg.token_ttl_s,
            scope: scope.into(),
        }
    }

    pub fn discovery(&self) -> Value {
        let i = &self.cfg.issuer;
        json!({
            "issuer": i,
            "authorization_endpoint": format!("{i}/authorize"),
            "token_endpoint": format!("{i}/token"),
            "jwks_uri": format!("{i}/jwks.json"),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "subject_types_supported": ["public"],
            "id_token_signing_alg_values_supported": ["ES256"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"],
            "scopes_supported": ["openid", "profile", "offline_access"],
            "claims_supported": ["iss", "sub", "aud", "exp", "iat", "nonce", "preferred_username"],
        })
    }

    /// The HTTP API.
    pub fn router(self: Arc<Self>) -> Router {
        Router::new()
            .route("/.well-known/openid-configuration", get(discovery))
            .route("/jwks.json", get(jwks))
            .route("/authorize", get(authorize_page).post(authorize_submit))
            .route("/token", axum::routing::post(token))
            .route("/", get(index))
            .with_state(self)
    }
}

/// Bind `addr` (loopback only) and serve `cfg` in a background task. With
/// `issuer` empty in `cfg`, the issuer becomes `http://<bound addr>`.
/// Returns the provider and its join handle.
pub async fn spawn(
    addr: SocketAddr,
    mut cfg: IdpConfig,
    key: IdpKey,
) -> Result<(Arc<DevIdp>, tokio::task::JoinHandle<()>), IdpError> {
    ensure_loopback(addr)?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    if cfg.issuer.is_empty() {
        cfg.issuer = format!("http://{bound}");
    }
    let idp = DevIdp::new(cfg, key);
    let app = idp.clone().router();
    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!(error = %e, "dev idp server stopped");
        }
    });
    Ok((idp, handle))
}

// ---------------------------------------------------------------- handlers

type Idp = State<Arc<DevIdp>>;

async fn discovery(State(idp): Idp) -> Json<Value> {
    Json(idp.discovery())
}

async fn jwks(State(idp): Idp) -> Json<Value> {
    Json(idp.key.jwks())
}

async fn index(State(idp): Idp) -> Html<String> {
    Html(format!(
        "<!doctype html><meta charset=utf-8><title>whispera-dev-idp</title>\
         <p><b>whispera-dev-idp — DEV/TEST ONLY.</b> Issuer <code>{}</code>, client <code>{}</code>.\
         <p><a href=\"/.well-known/openid-configuration\">discovery</a>",
        esc(&idp.cfg.issuer),
        esc(&idp.cfg.client_id)
    ))
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn bad_request(msg: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Html(format!(
            "<!doctype html><meta charset=utf-8><title>error</title><p>whispera-dev-idp: {}",
            esc(msg)
        )),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
struct AuthorizeParams {
    response_type: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    state: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    scope: Option<String>,
    nonce: Option<String>,
    login_hint: Option<String>,
    /// Set by the HTML form.
    user: Option<String>,
    /// Set by the HTML form's cancel button.
    deny: Option<String>,
}

/// A validated authorization request.
struct AuthRequest {
    redirect_uri: String,
    state: String,
    challenge: String,
    scope: String,
    nonce: Option<String>,
}

fn is_b64url(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl DevIdp {
    /// Errors here are shown to the user, never redirected (the redirect
    /// target itself may be the problem).
    fn validate(&self, p: &AuthorizeParams) -> Result<AuthRequest, String> {
        if p.client_id.as_deref() != Some(self.cfg.client_id.as_str()) {
            return Err("unknown client_id".into());
        }
        let redirect_uri = p.redirect_uri.clone().unwrap_or_default();
        if !self.cfg.redirect_uris.contains(&redirect_uri) {
            return Err(format!("redirect_uri {redirect_uri:?} is not allow-listed"));
        }
        if p.response_type.as_deref() != Some("code") {
            return Err("response_type must be code".into());
        }
        let state = p.state.clone().filter(|s| !s.is_empty());
        let Some(state) = state else {
            return Err("state is required".into());
        };
        if p.code_challenge_method.as_deref() != Some("S256") {
            return Err("PKCE is required: code_challenge_method must be S256".into());
        }
        let challenge = p.code_challenge.clone().unwrap_or_default();
        if challenge.len() != 43 || !is_b64url(&challenge) {
            return Err("code_challenge must be BASE64URL(SHA256(code_verifier))".into());
        }
        Ok(AuthRequest {
            redirect_uri,
            state,
            challenge,
            scope: p.scope.clone().unwrap_or_else(|| "openid".into()),
            nonce: p.nonce.clone(),
        })
    }

    fn redirect_with(&self, uri: &str, params: &[(&str, &str)]) -> Response {
        let mut u = url::Url::parse(uri).expect("allow-listed redirect URIs parse");
        {
            let mut q = u.query_pairs_mut();
            for (k, v) in params {
                q.append_pair(k, v);
            }
        }
        (StatusCode::FOUND, [(header::LOCATION, u.to_string())]).into_response()
    }

    fn approve(&self, req: AuthRequest, user: &str) -> Response {
        let code = random_token(32);
        self.codes.lock().unwrap().insert(
            code.clone(),
            CodeGrant {
                user: user.into(),
                redirect_uri: req.redirect_uri.clone(),
                challenge: req.challenge,
                scope: req.scope,
                nonce: req.nonce,
                expires_at: now() + CODE_TTL_S,
            },
        );
        tracing::info!(%user, "dev idp: issued authorization code");
        self.redirect_with(&req.redirect_uri, &[("code", &code), ("state", &req.state)])
    }
}

async fn authorize_page(State(idp): Idp, Query(p): Query<AuthorizeParams>) -> Response {
    let req = match idp.validate(&p) {
        Ok(r) => r,
        Err(e) => return bad_request(&e),
    };
    if let Some(hint) = p.login_hint.as_deref().filter(|h| !h.is_empty()) {
        if !idp.cfg.users.iter().any(|u| u == hint) {
            return bad_request(&format!("login_hint {hint:?} is not a configured user"));
        }
        return idp.approve(req, hint);
    }
    let hidden = |name: &str, v: &str| {
        format!(
            "<input type=hidden name=\"{}\" value=\"{}\">",
            esc(name),
            esc(v)
        )
    };
    let mut fields = String::new();
    fields += &hidden("response_type", "code");
    fields += &hidden("client_id", &idp.cfg.client_id);
    fields += &hidden("redirect_uri", &req.redirect_uri);
    fields += &hidden("state", &req.state);
    fields += &hidden("code_challenge", &req.challenge);
    fields += &hidden("code_challenge_method", "S256");
    fields += &hidden("scope", &req.scope);
    if let Some(n) = &req.nonce {
        fields += &hidden("nonce", n);
    }
    let buttons: String = idp
        .cfg
        .users
        .iter()
        .map(|u| {
            format!(
                "<button type=submit name=user value=\"{0}\">Sign in as {0}</button>",
                esc(u)
            )
        })
        .collect();
    Html(format!(
        "<!doctype html><meta charset=utf-8>\
         <meta name=viewport content=\"width=device-width,initial-scale=1\">\
         <title>whispera-dev-idp sign-in</title>\
         <style>body{{font:16px system-ui;max-width:28rem;margin:2rem auto;padding:0 1rem}}\
         button{{display:block;width:100%;margin:.5rem 0;padding:.75rem;font-size:1rem}}\
         .warn{{background:#fee;border:1px solid #c33;padding:.5rem}}</style>\
         <p class=warn><b>DEV/TEST ONLY</b> — whispera-dev-idp has no passwords.\
         <p>Sign in to <code>{client}</code>:\
         <form method=post action=\"/authorize\">{fields}{buttons}\
         <button type=submit name=deny value=1>Cancel</button></form>",
        client = esc(&idp.cfg.client_id),
    ))
    .into_response()
}

async fn authorize_submit(State(idp): Idp, Form(p): Form<AuthorizeParams>) -> Response {
    let req = match idp.validate(&p) {
        Ok(r) => r,
        Err(e) => return bad_request(&e),
    };
    if p.deny.is_some() {
        return idp.redirect_with(
            &req.redirect_uri,
            &[("error", "access_denied"), ("state", &req.state)],
        );
    }
    match p.user.as_deref() {
        Some(u) if idp.cfg.users.iter().any(|x| x == u) => idp.approve(req, u),
        _ => bad_request("unknown user"),
    }
}

#[derive(Debug, Deserialize)]
struct TokenParams {
    grant_type: Option<String>,
    code: Option<String>,
    redirect_uri: Option<String>,
    client_id: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
}

fn oauth_error(error: &str, description: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"error": error, "error_description": description})),
    )
        .into_response()
}

/// RFC 7636 §4.1: 43-128 chars of `[A-Za-z0-9-._~]`.
fn valid_verifier(v: &str) -> bool {
    (43..=128).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

/// `BASE64URL(SHA256(verifier))`.
pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

async fn token(State(idp): Idp, Form(p): Form<TokenParams>) -> Response {
    if p.client_id.as_deref() != Some(idp.cfg.client_id.as_str()) {
        return oauth_error("invalid_client", "unknown client_id");
    }
    let resp = match p.grant_type.as_deref() {
        Some("authorization_code") => {
            // Single use: the code is gone whatever happens next.
            let grant = p
                .code
                .as_deref()
                .and_then(|c| idp.codes.lock().unwrap().remove(c));
            let Some(g) = grant else {
                return oauth_error("invalid_grant", "unknown or used code");
            };
            if g.expires_at < now() {
                return oauth_error("invalid_grant", "code expired");
            }
            if p.redirect_uri.as_deref() != Some(g.redirect_uri.as_str()) {
                return oauth_error("invalid_grant", "redirect_uri mismatch");
            }
            let verifier = p.code_verifier.unwrap_or_default();
            if !valid_verifier(&verifier) || pkce_challenge(&verifier) != g.challenge {
                return oauth_error("invalid_grant", "PKCE verification failed");
            }
            idp.issue(&g.user, &g.scope, g.nonce.as_deref())
        }
        Some("refresh_token") => {
            // Rotation: each refresh token works once.
            let grant = p
                .refresh_token
                .as_deref()
                .and_then(|t| idp.refresh.lock().unwrap().remove(t));
            let Some(g) = grant else {
                return oauth_error("invalid_grant", "unknown or used refresh_token");
            };
            idp.issue(&g.user, &g.scope, None)
        }
        _ => {
            return oauth_error(
                "unsupported_grant_type",
                "use authorization_code or refresh_token",
            )
        }
    };
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(resp),
    )
        .into_response()
}
