//! End-to-end encrypted relay mailbox and WL1 device authentication.
//!
//! The relay stores **opaque sealed blobs only**: clients encrypt end-to-end
//! and the server never parses, logs or transforms a ciphertext beyond base64
//! decoding it to enforce size caps. Delivery is by a per-recipient cursor
//! (`seq`); a recipient acks "everything up to N" and those rows are deleted.
//!
//! [`DeviceAuth`] authenticates every device call with a WL1 signature
//! (PROTOCOL §4) made with the device's registered link key, plus a replay
//! cache of `(device, nonce)` pairs.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use tokio::sync::watch;
use whispera_proto::error::ErrorCode;
use whispera_proto::keys::PublicKey;
use whispera_proto::sign::{self, SignedHeaders};
use whispera_proto::wire::{RelayMessage, RelaySendResponse};
use whispera_store::{Device, NewMessage, Store, StoreError};

/// Relay caps. All sizes are of the decoded ciphertext.
#[derive(Debug, Clone)]
pub struct RelayLimits {
    /// Largest accepted ciphertext, bytes.
    pub max_ciphertext_bytes: usize,
    /// TTL applied when the sender gives none, seconds.
    pub default_ttl_s: u32,
    /// Upper bound for a requested TTL (larger values are clamped), seconds.
    pub max_ttl_s: u32,
    /// Most live messages queued for one recipient device.
    pub max_messages_per_device: i64,
    /// Most live ciphertext bytes queued for one recipient device.
    pub max_bytes_per_device: i64,
    /// Most messages returned by one fetch.
    pub fetch_limit: i64,
    /// Longest long-poll wait, seconds.
    pub max_wait_s: u64,
}

impl Default for RelayLimits {
    fn default() -> Self {
        Self {
            max_ciphertext_bytes: 64 * 1024,
            default_ttl_s: 24 * 3600,
            max_ttl_s: 7 * 24 * 3600,
            max_messages_per_device: 1000,
            max_bytes_per_device: 16 * 1024 * 1024,
            fetch_limit: 100,
            max_wait_s: 30,
        }
    }
}

/// Relay failure, mapped to a protocol [`ErrorCode`] by [`RelayError::code`].
#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    #[error("{0}")]
    BadRequest(&'static str),
    #[error("recipient not found")]
    RecipientNotFound,
    #[error("ciphertext too large")]
    TooLarge,
    #[error("recipient mailbox is full")]
    MailboxFull,
    #[error("storage error")]
    Store(#[from] StoreError),
}

impl RelayError {
    pub fn code(&self) -> ErrorCode {
        match self {
            RelayError::BadRequest(_) => ErrorCode::BadRequest,
            RelayError::RecipientNotFound => ErrorCode::NotFound,
            RelayError::TooLarge => ErrorCode::PayloadTooLarge,
            RelayError::MailboxFull => ErrorCode::MailboxFull,
            RelayError::Store(_) => ErrorCode::Internal,
        }
    }
}

/// The mailbox service. Share it behind an `Arc`.
pub struct Relay {
    store: Store,
    limits: RelayLimits,
    /// Per-recipient wake-up counters for long-poll and SSE.
    wakers: Mutex<HashMap<String, watch::Sender<u64>>>,
}

impl Relay {
    pub fn new(store: Store, limits: RelayLimits) -> Self {
        Self {
            store,
            limits,
            wakers: Mutex::new(HashMap::new()),
        }
    }

    pub fn limits(&self) -> &RelayLimits {
        &self.limits
    }

    /// A receiver that changes whenever mail arrives for (or the state of) `device_id`.
    /// Subscribe *before* reading the mailbox so no wake-up is missed.
    pub fn subscribe(&self, device_id: &str) -> watch::Receiver<u64> {
        let mut map = self.wakers.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(device_id.to_string())
            .or_insert_with(|| watch::channel(0).0)
            .subscribe()
    }

    /// Wake every waiter of `device_id` (new mail, revocation).
    pub fn wake(&self, device_id: &str) {
        let map = self.wakers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = map.get(device_id) {
            tx.send_modify(|v| *v = v.wrapping_add(1));
        }
    }

    /// Queue a sealed blob from `sender` to device `to` of the same account.
    pub async fn send(
        &self,
        sender: &Device,
        to: &str,
        ciphertext_b64: &str,
        ttl_s: Option<u32>,
        now: i64,
    ) -> Result<RelaySendResponse, RelayError> {
        // Cheap size pre-check before decoding (base64 is 4/3 the size).
        if ciphertext_b64.len() > self.limits.max_ciphertext_bytes.div_ceil(3) * 4 + 4 {
            return Err(RelayError::TooLarge);
        }
        let blob = STANDARD
            .decode(ciphertext_b64)
            .map_err(|_| RelayError::BadRequest("ciphertext must be standard base64"))?;
        if blob.is_empty() {
            return Err(RelayError::BadRequest("ciphertext is empty"));
        }
        if blob.len() > self.limits.max_ciphertext_bytes {
            return Err(RelayError::TooLarge);
        }
        let ttl = match ttl_s {
            Some(0) => return Err(RelayError::BadRequest("ttl_s must be positive")),
            Some(t) => t.min(self.limits.max_ttl_s),
            None => self.limits.default_ttl_s,
        };
        if to == sender.id {
            return Err(RelayError::BadRequest("cannot send to yourself"));
        }
        // Unknown, revoked and other-account recipients look the same.
        let recipient = match self.store.get_device(to).await? {
            Some(d) if d.account_id == sender.account_id && !d.is_revoked() => d,
            _ => return Err(RelayError::RecipientNotFound),
        };
        let usage = self.store.mailbox_usage(&recipient.id, now).await?;
        if usage.messages >= self.limits.max_messages_per_device
            || usage.bytes + blob.len() as i64 > self.limits.max_bytes_per_device
        {
            return Err(RelayError::MailboxFull);
        }
        let expires_at = now + i64::from(ttl);
        let (_, seq) = self
            .store
            .mailbox_insert(&NewMessage {
                recipient_device: &recipient.id,
                sender_device: &sender.id,
                ciphertext: &blob,
                created_at: now,
                expires_at,
            })
            .await?;
        self.wake(&recipient.id);
        Ok(RelaySendResponse { seq, expires_at })
    }

    /// Messages for `device` after `after_seq` (at most `limit`, capped by the config).
    pub async fn fetch(
        &self,
        device: &Device,
        after_seq: i64,
        limit: Option<i64>,
        now: i64,
    ) -> Result<Vec<RelayMessage>, RelayError> {
        let limit = limit
            .unwrap_or(self.limits.fetch_limit)
            .clamp(1, self.limits.fetch_limit);
        let rows = self
            .store
            .mailbox_fetch(&device.id, after_seq, now, limit)
            .await?;
        Ok(rows
            .into_iter()
            .map(|m| RelayMessage {
                seq: m.seq,
                from: m.sender_device,
                ciphertext: STANDARD.encode(&m.ciphertext),
                expires_at: m.expires_at,
                created_at: m.created_at,
            })
            .collect())
    }

    /// Delete `device`'s messages with `seq <= up_to_seq`.
    pub async fn ack(&self, device: &Device, up_to_seq: i64) -> Result<u64, RelayError> {
        Ok(self.store.mailbox_ack(&device.id, up_to_seq).await?)
    }

    /// Drop expired messages. Run periodically.
    pub async fn purge_expired(&self, now: i64) -> Result<u64, RelayError> {
        Ok(self.store.mailbox_purge_expired(now).await?)
    }
}

/// WL1 device request authentication with a replay cache.
pub struct DeviceAuth {
    store: Store,
    skew_s: i64,
    /// `(device, nonce)` → expiry (unix s).
    seen: Mutex<ReplayCache>,
}

#[derive(Default)]
struct ReplayCache {
    entries: HashMap<(String, String), i64>,
    last_prune: i64,
}

impl DeviceAuth {
    pub fn new(store: Store, skew_s: i64) -> Self {
        Self {
            store,
            skew_s,
            seen: Mutex::new(ReplayCache::default()),
        }
    }

    /// Verify a signed device request and return the (active) device.
    ///
    /// Order: id format → device lookup → revoked → nonce format → timestamp
    /// skew + signature → replay. The replay cache is only written after the
    /// signature verifies, so forged requests cannot burn nonces.
    pub async fn verify(
        &self,
        headers: &SignedHeaders,
        method: &str,
        target: &str,
        body: &[u8],
        now: i64,
    ) -> Result<Device, ErrorCode> {
        if !sign::is_valid_device_id(&headers.device_id) {
            return Err(ErrorCode::AuthUnknownDevice);
        }
        let device = self
            .store
            .get_device(&headers.device_id)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "device lookup failed");
                ErrorCode::Internal
            })?
            .ok_or(ErrorCode::AuthUnknownDevice)?;
        if device.is_revoked() {
            return Err(ErrorCode::AuthRevoked);
        }
        if !sign::is_valid_nonce(&headers.nonce) {
            return Err(ErrorCode::AuthBadSignature);
        }
        let pk = PublicKey::from_x963_b64(&device.link_pub).map_err(|_| ErrorCode::Internal)?;
        sign::verify_request(&pk, headers, method, target, body, now, self.skew_s)?;
        let mut cache = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if now - cache.last_prune > self.skew_s {
            cache.entries.retain(|_, exp| *exp > now);
            cache.last_prune = now;
        }
        let key = (device.id.clone(), headers.nonce.clone());
        if cache.entries.get(&key).is_some_and(|exp| *exp > now) {
            return Err(ErrorCode::AuthReplay);
        }
        // A timestamp is accepted for ±skew, so remember the nonce for 2×skew.
        cache.entries.insert(key, now + 2 * self.skew_s + 1);
        Ok(device)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use whispera_proto::keys::SigningKey;

    const NOW: i64 = 1_800_000_000;

    struct Fx {
        _dir: tempfile::TempDir,
        store: Store,
        a: Device,
        b: Device,
        ka: SigningKey,
    }

    async fn fx() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!("sqlite://{}", dir.path().join("r.db").display()))
            .await
            .unwrap();
        let acc = store.upsert_account("static", "me", NOW).await.unwrap();
        let ka = SigningKey::generate();
        let mk = |id: String, k: &SigningKey| Device {
            id,
            account_id: acc.id.clone(),
            name: "d".into(),
            platform: "macos".into(),
            link_pub: k.public_key().to_x963_b64(),
            approve_pub: None,
            kem_pub: None,
            apns_token: None,
            apns_env: None,
            created_at: NOW,
            revoked_at: None,
        };
        let a = mk(sign::new_device_id(), &ka);
        let b = mk(sign::new_device_id(), &SigningKey::generate());
        store.insert_device(&a).await.unwrap();
        store.insert_device(&b).await.unwrap();
        Fx {
            _dir: dir,
            store,
            a,
            b,
            ka,
        }
    }

    #[tokio::test]
    async fn send_fetch_ack_and_caps() {
        let f = fx().await;
        let limits = RelayLimits {
            max_ciphertext_bytes: 8,
            max_messages_per_device: 2,
            max_ttl_s: 100,
            ..Default::default()
        };
        let r = Relay::new(f.store.clone(), limits);
        let mut rx = r.subscribe(&f.b.id);
        let s1 = r.send(&f.a, &f.b.id, "AAEC", None, NOW).await.unwrap();
        assert!(rx.has_changed().unwrap());
        rx.mark_unchanged();
        assert_eq!(s1.expires_at, NOW + 24 * 3600);
        let s2 = r
            .send(&f.a, &f.b.id, "AAEC", Some(10_000), NOW)
            .await
            .unwrap();
        assert_eq!(s2.expires_at, NOW + 100, "ttl clamped");
        assert!(matches!(
            r.send(&f.a, &f.b.id, "AAEC", None, NOW).await,
            Err(RelayError::MailboxFull)
        ));
        assert!(matches!(
            r.send(&f.a, &f.b.id, "AAAAAAAAAAAA", None, NOW).await,
            Err(RelayError::TooLarge)
        ));
        assert!(matches!(
            r.send(&f.a, &f.b.id, "not base64!", None, NOW).await,
            Err(RelayError::BadRequest(_))
        ));
        assert!(matches!(
            r.send(&f.a, &f.a.id, "AAEC", None, NOW).await,
            Err(RelayError::BadRequest(_))
        ));
        assert!(matches!(
            r.send(&f.a, "dev_nobody", "AAEC", None, NOW).await,
            Err(RelayError::RecipientNotFound)
        ));
        let msgs = r.fetch(&f.b, 0, None, NOW).await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].from, f.a.id);
        assert_eq!(msgs[0].ciphertext, "AAEC");
        assert_eq!(
            r.fetch(&f.b, msgs[0].seq, None, NOW).await.unwrap().len(),
            1
        );
        assert_eq!(r.ack(&f.b, msgs[1].seq).await.unwrap(), 2);
        assert!(r.fetch(&f.b, 0, None, NOW).await.unwrap().is_empty());
        // Expired messages are invisible and purged.
        r.send(&f.a, &f.b.id, "AAEC", Some(5), NOW).await.unwrap();
        assert!(r.fetch(&f.b, 0, None, NOW + 5).await.unwrap().is_empty());
        assert_eq!(r.purge_expired(NOW + 5).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn other_account_or_revoked_recipient_not_found() {
        let f = fx().await;
        let r = Relay::new(f.store.clone(), RelayLimits::default());
        let other = f
            .store
            .upsert_account("static", "other", NOW)
            .await
            .unwrap();
        let mut c = f.b.clone();
        c.id = sign::new_device_id();
        c.account_id = other.id;
        f.store.insert_device(&c).await.unwrap();
        assert!(matches!(
            r.send(&f.a, &c.id, "AAEC", None, NOW).await,
            Err(RelayError::RecipientNotFound)
        ));
        f.store
            .revoke_device(&f.b.account_id, &f.b.id, NOW)
            .await
            .unwrap();
        assert!(matches!(
            r.send(&f.a, &f.b.id, "AAEC", None, NOW).await,
            Err(RelayError::RecipientNotFound)
        ));
    }

    #[tokio::test]
    async fn wl1_device_auth() {
        let f = fx().await;
        let auth = DeviceAuth::new(f.store.clone(), 60);
        let body = br#"{"x":1}"#;
        let h = SignedHeaders::sign(
            &f.ka,
            &f.a.id,
            "POST",
            "/v1/relay/send",
            body,
            NOW,
            &sign::new_nonce(),
        );
        let d = auth
            .verify(&h, "POST", "/v1/relay/send", body, NOW)
            .await
            .unwrap();
        assert_eq!(d.id, f.a.id);
        assert_eq!(
            auth.verify(&h, "POST", "/v1/relay/send", body, NOW).await,
            Err(ErrorCode::AuthReplay)
        );
        // Signed by the wrong key (b's id, a's key).
        let h2 = SignedHeaders::sign(&f.ka, &f.b.id, "GET", "/x", b"", NOW, &sign::new_nonce());
        assert_eq!(
            auth.verify(&h2, "GET", "/x", b"", NOW).await,
            Err(ErrorCode::AuthBadSignature)
        );
        let h3 = SignedHeaders::sign(&f.ka, &f.a.id, "GET", "/x", b"", NOW, &sign::new_nonce());
        assert_eq!(
            auth.verify(&h3, "GET", "/x", b"", NOW + 120).await,
            Err(ErrorCode::AuthClockSkew)
        );
        let h4 = SignedHeaders::sign(
            &f.ka,
            "dev_aaaaaaaaaaaaaaaaaaaaaaaa",
            "GET",
            "/x",
            b"",
            NOW,
            &sign::new_nonce(),
        );
        assert_eq!(
            auth.verify(&h4, "GET", "/x", b"", NOW).await,
            Err(ErrorCode::AuthUnknownDevice)
        );
        f.store
            .revoke_device(&f.a.account_id, &f.a.id, NOW)
            .await
            .unwrap();
        let h5 = SignedHeaders::sign(&f.ka, &f.a.id, "GET", "/x", b"", NOW, &sign::new_nonce());
        assert_eq!(
            auth.verify(&h5, "GET", "/x", b"", NOW).await,
            Err(ErrorCode::AuthRevoked)
        );
    }
}
