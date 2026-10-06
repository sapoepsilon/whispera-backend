//! Account-level authentication for the Whispera server.
//!
//! This crate answers one question: *which account is making this request?*
//! It is deliberately separate from device (WL1) request signing — an account
//! owns devices; a device proves possession of its key with WL1.
//!
//! Two backends are provided:
//!
//! * [`oidc::OidcAuth`] — verifies OIDC JWT access/session tokens (Clerk,
//!   Zitadel, Keycloak, Auth0, ...) against the issuer's JWKS.
//! * [`static_token::StaticTokenAuth`] — a fixed list of hashed bearer tokens
//!   for self-hosters who do not run an identity provider.
//!
//! The crate is **default-closed**: there is no allow-all / bypass
//! implementation and no environment switch that disables authentication.
//! Missing or invalid configuration is an error, never "open".

use std::sync::Arc;

use serde::Deserialize;

pub mod oidc;
pub mod static_token;

pub use oidc::{OidcAuth, OidcConfig};
pub use static_token::{generate_token, hash_token, StaticTokenAuth, StaticTokenEntry};

/// The authenticated account: the pair `(issuer, subject)` is globally unique.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountIdentity {
    /// Token issuer (`iss`), or the constant [`static_token::STATIC_ISSUER`].
    pub issuer: String,
    /// Account identifier within the issuer (`sub`, or the static account name).
    pub subject: String,
}

/// Authentication failure.
///
/// The string payloads are *internal* reasons intended for logs. When
/// responding to clients, map [`AuthError::Invalid`] to a generic 401 and
/// [`AuthError::Unavailable`] to a 503; do not echo the payload verbatim
/// (use [`AuthError::code`] if a short machine-readable code is wanted).
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    /// No credentials were presented.
    #[error("missing credentials")]
    Missing,
    /// Credentials were presented but rejected.
    #[error("invalid credentials: {0}")]
    Invalid(String),
    /// Credentials could not be checked (e.g. the JWKS endpoint is unreachable).
    #[error("authentication unavailable: {0}")]
    Unavailable(String),
}

impl AuthError {
    /// Short, client-safe code for this error.
    pub fn code(&self) -> &'static str {
        match self {
            AuthError::Missing => "auth_missing",
            AuthError::Invalid(_) => "auth_invalid",
            AuthError::Unavailable(_) => "auth_unavailable",
        }
    }
}

/// Configuration error raised while building an authenticator.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// The configuration itself is invalid.
    #[error("invalid auth configuration: {0}")]
    Invalid(String),
    /// OIDC discovery or the initial JWKS fetch failed.
    #[error("OIDC discovery failed: {0}")]
    Discovery(String),
}

/// An account authenticator.
#[async_trait::async_trait]
pub trait AccountAuth: Send + Sync + 'static {
    /// Authenticate a bearer token (already stripped of the `Bearer ` prefix).
    async fn authenticate(&self, bearer_token: &str) -> Result<AccountIdentity, AuthError>;
    /// Short name of the backend, e.g. `"oidc"` or `"static"`.
    fn kind(&self) -> &'static str;
}

/// Extract the token from an `Authorization` header value of the form
/// `Bearer <token>`. The scheme is matched case-insensitively. Returns `None`
/// when the header is absent, uses another scheme, or the token is empty or
/// contains whitespace.
pub fn bearer_from_header(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    let (scheme, rest) = value.split_once([' ', '\t'])?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim();
    if token.is_empty() || token.contains(char::is_whitespace) {
        return None;
    }
    Some(token)
}

/// Authentication configuration, selected by the `mode` tag.
///
/// ```json
/// {"mode": "oidc", "issuer": "https://example.clerk.accounts.dev",
///  "authorized_parties": ["https://app.example.com"]}
/// {"mode": "static", "tokens": [{"account": "me", "token_sha256": "<hex>"}]}
/// ```
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum AuthConfig {
    /// OIDC JWT verification.
    Oidc(OidcConfig),
    /// Static hashed bearer tokens.
    Static {
        /// Accepted tokens (stored as SHA-256 hashes).
        tokens: Vec<StaticTokenEntry>,
    },
}

/// Build an authenticator from a borrowed config. OIDC mode performs discovery
/// (network) unless `jwks_uri` is set, in which case only the JWKS is fetched.
pub async fn build_from_config(cfg: &AuthConfig) -> Result<Arc<dyn AccountAuth>, ConfigError> {
    match cfg {
        AuthConfig::Oidc(c) => Ok(Arc::new(OidcAuth::discover(c.clone()).await?)),
        AuthConfig::Static { tokens } => Ok(Arc::new(StaticTokenAuth::new(tokens.clone())?)),
    }
}

/// Build an authenticator from an owned config. See [`build_from_config`].
pub async fn build(cfg: AuthConfig) -> Result<Arc<dyn AccountAuth>, ConfigError> {
    build_from_config(&cfg).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_parsing() {
        assert_eq!(bearer_from_header(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer_from_header(Some("bearer abc")), Some("abc"));
        assert_eq!(bearer_from_header(Some("BEARER   abc  ")), Some("abc"));
        assert_eq!(bearer_from_header(Some("Basic abc")), None);
        assert_eq!(bearer_from_header(Some("Bearer")), None);
        assert_eq!(bearer_from_header(Some("Bearer ")), None);
        assert_eq!(bearer_from_header(Some("Bearer a b")), None);
        assert_eq!(bearer_from_header(Some("Bearerabc")), None);
        assert_eq!(bearer_from_header(None), None);
    }

    #[test]
    fn config_requires_mode() {
        assert!(serde_json::from_str::<AuthConfig>(r#"{"tokens":[]}"#).is_err());
        assert!(serde_json::from_str::<AuthConfig>(r#"{"mode":"none"}"#).is_err());
        let c: AuthConfig = serde_json::from_str(
            r#"{"mode":"oidc","issuer":"https://x.clerk.accounts.dev","authorized_parties":["https://a"]}"#,
        )
        .unwrap();
        match c {
            AuthConfig::Oidc(o) => {
                assert_eq!(o.leeway_s, 30);
                assert_eq!(o.jwks_cache_ttl_s, 600);
                assert_eq!(o.allowed_algs.len(), 2);
            }
            _ => panic!("wrong mode"),
        }
        let c: AuthConfig = serde_json::from_str(
            r#"{"mode":"static","tokens":[{"account":"a","token_sha256":"00"}]}"#,
        )
        .unwrap();
        assert!(matches!(c, AuthConfig::Static { .. }));
    }

    #[tokio::test]
    async fn build_static_rejects_empty() {
        let r = build(AuthConfig::Static { tokens: vec![] }).await;
        assert!(matches!(r, Err(ConfigError::Invalid(_))));
    }

    #[tokio::test]
    async fn build_static_ok() {
        let t = generate_token();
        let auth = build(AuthConfig::Static {
            tokens: vec![StaticTokenEntry {
                account: "me".into(),
                token_sha256: hash_token(&t),
            }],
        })
        .await
        .unwrap();
        assert_eq!(auth.kind(), "static");
        assert_eq!(auth.authenticate(&t).await.unwrap().subject, "me");
    }
}
