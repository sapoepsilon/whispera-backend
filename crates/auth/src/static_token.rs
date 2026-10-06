//! Static bearer tokens for self-hosters.
//!
//! Tokens are never stored in plaintext: the config holds the lowercase hex
//! SHA-256 of each token. Generate one with [`generate_token`] and store
//! [`hash_token`] of it.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use subtle::{Choice, ConditionallySelectable, ConstantTimeEq};

use crate::{AccountAuth, AccountIdentity, AuthError, ConfigError};

/// Issuer reported for identities authenticated by [`StaticTokenAuth`].
pub const STATIC_ISSUER: &str = "static";

/// Prefix of tokens produced by [`generate_token`].
pub const TOKEN_PREFIX: &str = "wst_";

/// One accepted token.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct StaticTokenEntry {
    /// Account name; becomes [`AccountIdentity::subject`].
    pub account: String,
    /// Lowercase hex SHA-256 of the token.
    pub token_sha256: String,
}

/// SHA-256 of `token` as lowercase hex.
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Generate a fresh random token: `wst_` + base64url(32 random bytes).
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// Authenticator over a fixed set of hashed tokens.
pub struct StaticTokenAuth {
    entries: Vec<([u8; 32], String)>,
}

impl std::fmt::Debug for StaticTokenAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StaticTokenAuth")
            .field(
                "accounts",
                &self.entries.iter().map(|e| &e.1).collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl StaticTokenAuth {
    /// Build from entries. Rejects an empty list, empty account names,
    /// malformed hashes (must be 64 lowercase hex chars) and duplicate hashes.
    pub fn new(entries: Vec<StaticTokenEntry>) -> Result<Self, ConfigError> {
        if entries.is_empty() {
            return Err(ConfigError::Invalid(
                "static auth requires at least one token".into(),
            ));
        }
        let mut out: Vec<([u8; 32], String)> = Vec::with_capacity(entries.len());
        for (i, e) in entries.into_iter().enumerate() {
            if e.account.trim().is_empty() {
                return Err(ConfigError::Invalid(format!(
                    "static token #{i}: empty account"
                )));
            }
            let h = &e.token_sha256;
            if h.len() != 64
                || !h
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(ConfigError::Invalid(format!(
                    "static token #{i} ({}): token_sha256 must be 64 lowercase hex chars",
                    e.account
                )));
            }
            let mut hash = [0u8; 32];
            hex::decode_to_slice(h, &mut hash)
                .map_err(|err| ConfigError::Invalid(format!("static token #{i}: {err}")))?;
            if out.iter().any(|(existing, _)| *existing == hash) {
                return Err(ConfigError::Invalid(format!(
                    "static token #{i} ({}): duplicate token hash",
                    e.account
                )));
            }
            out.push((hash, e.account));
        }
        Ok(Self { entries: out })
    }

    /// Parse the env-var form `account1:sha256hex,account2:sha256hex`.
    /// Whitespace around items is ignored; the account is everything before
    /// the last `:`.
    pub fn from_spec(spec: &str) -> Result<Self, ConfigError> {
        Self::new(parse_spec(spec)?)
    }

    /// Number of configured tokens.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Always false (an empty config is rejected at construction).
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Parse `account:hex,account:hex` into entries (no validation of the hex).
pub fn parse_spec(spec: &str) -> Result<Vec<StaticTokenEntry>, ConfigError> {
    spec.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|item| {
            let (account, hash) = item.rsplit_once(':').ok_or_else(|| {
                ConfigError::Invalid("static token spec items must be `account:sha256hex`".into())
            })?;
            Ok(StaticTokenEntry {
                account: account.trim().to_string(),
                token_sha256: hash.trim().to_string(),
            })
        })
        .collect()
}

#[async_trait::async_trait]
impl AccountAuth for StaticTokenAuth {
    async fn authenticate(&self, bearer_token: &str) -> Result<AccountIdentity, AuthError> {
        if bearer_token.is_empty() {
            return Err(AuthError::Missing);
        }
        let digest: [u8; 32] = Sha256::digest(bearer_token.as_bytes()).into();
        // Compare against every entry without early exit.
        let mut found = Choice::from(0u8);
        let mut index = 0u64;
        for (i, (hash, _)) in self.entries.iter().enumerate() {
            let eq = hash.ct_eq(&digest);
            index = u64::conditional_select(&index, &(i as u64), eq);
            found |= eq;
        }
        if bool::from(found) {
            Ok(AccountIdentity {
                issuer: STATIC_ISSUER.to_string(),
                subject: self.entries[index as usize].1.clone(),
            })
        } else {
            Err(AuthError::Invalid("unknown_static_token".into()))
        }
    }

    fn kind(&self) -> &'static str {
        "static"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(account: &str, token: &str) -> StaticTokenEntry {
        StaticTokenEntry {
            account: account.into(),
            token_sha256: hash_token(token),
        }
    }

    #[tokio::test]
    async fn right_token_ok_wrong_token_invalid() {
        let a = generate_token();
        let b = generate_token();
        let auth = StaticTokenAuth::new(vec![entry("alice", &a), entry("bob", &b)]).unwrap();
        let id = auth.authenticate(&b).await.unwrap();
        assert_eq!(
            id,
            AccountIdentity {
                issuer: "static".into(),
                subject: "bob".into()
            }
        );
        assert_eq!(auth.authenticate(&a).await.unwrap().subject, "alice");
        assert!(matches!(
            auth.authenticate("wst_nope").await,
            Err(AuthError::Invalid(_))
        ));
        assert!(matches!(
            auth.authenticate("").await,
            Err(AuthError::Missing)
        ));
        // The hash itself is not a valid token.
        assert!(auth.authenticate(&hash_token(&a)).await.is_err());
    }

    #[test]
    fn config_validation() {
        assert!(StaticTokenAuth::new(vec![]).is_err());
        let bad = StaticTokenEntry {
            account: "a".into(),
            token_sha256: "zz".into(),
        };
        assert!(StaticTokenAuth::new(vec![bad]).is_err());
        let upper = StaticTokenEntry {
            account: "a".into(),
            token_sha256: hash_token("x").to_uppercase(),
        };
        assert!(StaticTokenAuth::new(vec![upper]).is_err());
        assert!(StaticTokenAuth::new(vec![entry("a", "x"), entry("b", "x")]).is_err());
        assert!(StaticTokenAuth::new(vec![entry("", "x")]).is_err());
    }

    #[test]
    fn token_helpers() {
        let t = generate_token();
        assert!(t.starts_with("wst_"));
        assert_eq!(t.len(), 4 + 43);
        assert_ne!(t, generate_token());
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[tokio::test]
    async fn from_spec_parsing() {
        let spec = format!(" alice:{} , bob:{},", hash_token("t1"), hash_token("t2"));
        let auth = StaticTokenAuth::from_spec(&spec).unwrap();
        assert_eq!(auth.len(), 2);
        assert_eq!(auth.authenticate("t2").await.unwrap().subject, "bob");
        assert_eq!(auth.authenticate("t1").await.unwrap().subject, "alice");
        assert!(StaticTokenAuth::from_spec("").is_err());
        assert!(StaticTokenAuth::from_spec("alice").is_err());
        assert!(StaticTokenAuth::from_spec("alice:xyz").is_err());
        assert!(StaticTokenAuth::from_spec(&format!(":{}", hash_token("t"))).is_err());
        // Account names may contain ':'.
        let a = StaticTokenAuth::from_spec(&format!("org:alice:{}", hash_token("t"))).unwrap();
        assert_eq!(a.authenticate("t").await.unwrap().subject, "org:alice");
    }
}
