//! Server configuration: an optional TOML file, then environment overrides.
//!
//! Default-closed: the server refuses to start without account auth configured.

use std::net::SocketAddr;
use std::path::PathBuf;

use serde::Deserialize;
use whispera_auth::static_token::parse_spec;
use whispera_auth::{AuthConfig, OidcConfig};
use whispera_relay::RelayLimits;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("cannot read config file {path}: {err}")]
    Read { path: String, err: std::io::Error },
    #[error("invalid config file: {0}")]
    Toml(String),
    #[error("{0}")]
    Invalid(String),
}

fn default_listen() -> SocketAddr {
    SocketAddr::from(([0, 0, 0, 0], 8080))
}
fn default_db() -> String {
    "sqlite://whispera.db".into()
}
fn default_skew() -> i64 {
    whispera_proto::sign::DEFAULT_CLOCK_SKEW_S
}
fn default_max_devices() -> i64 {
    50
}
fn default_max_body() -> usize {
    256 * 1024
}

/// Per-client-IP token bucket.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RateLimitConfig {
    /// Sustained requests per second per IP. 0 disables rate limiting.
    pub per_second: f64,
    /// Bucket size.
    pub burst: u32,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            per_second: 20.0,
            burst: 60,
        }
    }
}

/// Relay limits as they appear in TOML (all optional).
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RelayConfig {
    pub max_ciphertext_bytes: Option<usize>,
    pub default_ttl_s: Option<u32>,
    pub max_ttl_s: Option<u32>,
    pub max_messages_per_device: Option<i64>,
    pub max_bytes_per_device: Option<i64>,
    pub fetch_limit: Option<i64>,
    pub max_wait_s: Option<u64>,
}

impl RelayConfig {
    pub fn limits(&self) -> RelayLimits {
        let d = RelayLimits::default();
        RelayLimits {
            max_ciphertext_bytes: self.max_ciphertext_bytes.unwrap_or(d.max_ciphertext_bytes),
            default_ttl_s: self.default_ttl_s.unwrap_or(d.default_ttl_s),
            max_ttl_s: self.max_ttl_s.unwrap_or(d.max_ttl_s),
            max_messages_per_device: self
                .max_messages_per_device
                .unwrap_or(d.max_messages_per_device),
            max_bytes_per_device: self.max_bytes_per_device.unwrap_or(d.max_bytes_per_device),
            fetch_limit: self.fetch_limit.unwrap_or(d.fetch_limit),
            max_wait_s: self.max_wait_s.unwrap_or(d.max_wait_s),
        }
    }
}

/// APNs settings from TOML. The key itself is read from `key_path`, never inline.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ApnsFileConfig {
    pub key_path: PathBuf,
    pub key_id: String,
    pub team_id: String,
    pub topic: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default = "default_listen")]
    pub listen: SocketAddr,
    #[serde(default = "default_db")]
    pub database_url: String,
    /// Use `X-Forwarded-For` / `CF-Connecting-IP` for the client IP (rate limiting).
    /// Only enable behind a reverse proxy that sets them.
    #[serde(default)]
    pub trust_proxy_headers: bool,
    #[serde(default = "default_skew")]
    pub clock_skew_s: i64,
    #[serde(default = "default_max_devices")]
    pub max_devices_per_account: i64,
    #[serde(default = "default_max_body")]
    pub max_body_bytes: usize,
    #[serde(default)]
    pub auth: Option<AuthConfig>,
    #[serde(default)]
    pub rate_limit: RateLimitConfig,
    #[serde(default)]
    pub relay: RelayConfig,
    #[serde(default)]
    pub apns: Option<ApnsFileConfig>,
}

fn list(v: &str) -> Vec<String> {
    v.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

impl Config {
    /// Load from `WHISPERA_CONFIG` (if set) and the environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::load(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
    }

    /// Load using `get` for environment lookups (testable).
    pub fn load(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let mut cfg: Config = match get("WHISPERA_CONFIG") {
            Some(path) => {
                let text = std::fs::read_to_string(&path)
                    .map_err(|err| ConfigError::Read { path, err })?;
                Self::from_toml(&text)?
            }
            None => Self::from_toml("")?,
        };
        cfg.apply_env(&get)?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn from_toml(text: &str) -> Result<Self, ConfigError> {
        toml::from_str(text).map_err(|e| ConfigError::Toml(e.to_string()))
    }

    fn apply_env(&mut self, get: &impl Fn(&str) -> Option<String>) -> Result<(), ConfigError> {
        let bad = |k: &str| ConfigError::Invalid(format!("{k}: invalid value"));
        if let Some(v) = get("WHISPERA_LISTEN") {
            self.listen = v.parse().map_err(|_| bad("WHISPERA_LISTEN"))?;
        }
        if let Some(v) = get("WHISPERA_DATABASE_URL") {
            self.database_url = v;
        }
        if let Some(v) = get("WHISPERA_TRUST_PROXY_HEADERS") {
            self.trust_proxy_headers = matches!(v.as_str(), "1" | "true" | "yes");
        }
        if let Some(v) = get("WHISPERA_RATE_LIMIT_PER_SECOND") {
            self.rate_limit.per_second = v
                .parse()
                .map_err(|_| bad("WHISPERA_RATE_LIMIT_PER_SECOND"))?;
        }
        if let Some(v) = get("WHISPERA_RATE_LIMIT_BURST") {
            self.rate_limit.burst = v.parse().map_err(|_| bad("WHISPERA_RATE_LIMIT_BURST"))?;
        }
        let tokens = get("WHISPERA_STATIC_TOKENS");
        let issuer = get("WHISPERA_OIDC_ISSUER");
        match (tokens, issuer) {
            (Some(_), Some(_)) => {
                return Err(ConfigError::Invalid(
                    "set only one of WHISPERA_STATIC_TOKENS and WHISPERA_OIDC_ISSUER".into(),
                ))
            }
            (Some(spec), None) => {
                let tokens = parse_spec(&spec).map_err(|e| ConfigError::Invalid(e.to_string()))?;
                self.auth = Some(AuthConfig::Static { tokens });
            }
            (None, Some(issuer)) => {
                let mut o = OidcConfig {
                    issuer,
                    ..Default::default()
                };
                if let Some(v) = get("WHISPERA_OIDC_AUDIENCES") {
                    o.audiences = list(&v);
                }
                if let Some(v) = get("WHISPERA_OIDC_AUTHORIZED_PARTIES") {
                    o.authorized_parties = list(&v);
                }
                o.jwks_uri = get("WHISPERA_OIDC_JWKS_URI");
                if let Some(v) = get("WHISPERA_OIDC_ALLOWED_ALGS") {
                    let algs = list(&v)
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect();
                    o.allowed_algs = serde_json::from_value(serde_json::Value::Array(algs))
                        .map_err(|_| bad("WHISPERA_OIDC_ALLOWED_ALGS"))?;
                }
                self.auth = Some(AuthConfig::Oidc(o));
            }
            (None, None) => {}
        }
        Ok(())
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.auth.is_none() {
            return Err(ConfigError::Invalid(
                "no account authentication configured (default-closed): set [auth] in the \
                 config file, WHISPERA_STATIC_TOKENS, or WHISPERA_OIDC_ISSUER"
                    .into(),
            ));
        }
        if self.clock_skew_s <= 0 || self.clock_skew_s > 600 {
            return Err(ConfigError::Invalid("clock_skew_s must be 1..=600".into()));
        }
        if self.rate_limit.per_second < 0.0 || !self.rate_limit.per_second.is_finite() {
            return Err(ConfigError::Invalid(
                "rate_limit.per_second must be >= 0".into(),
            ));
        }
        if self.rate_limit.per_second > 0.0 && self.rate_limit.burst == 0 {
            return Err(ConfigError::Invalid("rate_limit.burst must be >= 1".into()));
        }
        let l = self.relay.limits();
        if l.max_ciphertext_bytes == 0 || l.default_ttl_s == 0 || l.fetch_limit < 1 {
            return Err(ConfigError::Invalid("relay limits must be positive".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn default_closed_without_auth() {
        let e = Config::load(env(&[])).unwrap_err();
        assert!(e.to_string().contains("default-closed"));
    }

    #[test]
    fn static_tokens_from_env() {
        let h = whispera_auth::hash_token("t");
        let c = Config::load(env(&[
            ("WHISPERA_STATIC_TOKENS", &format!("me:{h}")),
            ("WHISPERA_LISTEN", "127.0.0.1:9000"),
        ]))
        .unwrap();
        assert_eq!(c.listen.port(), 9000);
        assert!(matches!(c.auth, Some(AuthConfig::Static { .. })));
    }

    #[test]
    fn oidc_from_env_and_conflict() {
        let c = Config::load(env(&[
            ("WHISPERA_OIDC_ISSUER", "https://x.clerk.accounts.dev"),
            ("WHISPERA_OIDC_AUTHORIZED_PARTIES", "https://a, https://b"),
            ("WHISPERA_OIDC_ALLOWED_ALGS", "ES384,RS256"),
        ]))
        .unwrap();
        match c.auth {
            Some(AuthConfig::Oidc(o)) => {
                assert_eq!(o.authorized_parties.len(), 2);
                assert_eq!(o.allowed_algs.len(), 2);
            }
            _ => panic!(),
        }
        assert!(Config::load(env(&[
            ("WHISPERA_OIDC_ISSUER", "https://x"),
            ("WHISPERA_STATIC_TOKENS", "a:b"),
        ]))
        .is_err());
    }

    #[test]
    fn toml_file() {
        let c = Config::from_toml(
            r#"
            listen = "127.0.0.1:8081"
            database_url = "postgres://u@h/db"
            [auth]
            mode = "oidc"
            issuer = "https://auth.example.com"
            audiences = ["whispera"]
            [rate_limit]
            per_second = 5
            burst = 10
            [relay]
            max_ttl_s = 60
            [apns]
            key_path = "/run/secrets/apns.p8"
            key_id = "K"
            team_id = "T"
            topic = "com.example.app"
            "#,
        )
        .unwrap();
        c.validate().unwrap();
        assert_eq!(c.relay.limits().max_ttl_s, 60);
        assert_eq!(c.rate_limit.burst, 10);
        assert!(c.apns.is_some());
        assert!(Config::from_toml("bogus = 1").is_err());
    }
}
