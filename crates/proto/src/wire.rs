//! JSON bodies used by the backend HTTP API (snake_case).
//!
//! Relay ciphertext is opaque to the server: clients seal envelopes end-to-end and the
//! server only stores and forwards the base64 string.

use serde::{Deserialize, Serialize};

/// Device platform. Serialized lowercase: `"ios" | "macos" | "linux" | "other"`.
/// Unknown strings are rejected by serde; clients on other platforms send `"other"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Ios,
    Macos,
    Linux,
    Other,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Ios => "ios",
            Platform::Macos => "macos",
            Platform::Linux => "linux",
            Platform::Other => "other",
        }
    }
}

impl std::str::FromStr for Platform {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, ()> {
        match s {
            "ios" => Ok(Platform::Ios),
            "macos" => Ok(Platform::Macos),
            "linux" => Ok(Platform::Linux),
            "other" => Ok(Platform::Other),
            _ => Err(()),
        }
    }
}

/// APNs environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApnsEnv {
    Sandbox,
    Production,
}

impl ApnsEnv {
    pub fn as_str(self) -> &'static str {
        match self {
            ApnsEnv::Sandbox => "sandbox",
            ApnsEnv::Production => "production",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApnsRegistration {
    /// Hex device token.
    pub token: String,
    pub env: ApnsEnv,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisterDeviceRequest {
    pub name: String,
    pub platform: Platform,
    /// X9.63 base64 link (request-signing) public key.
    pub link_pubkey: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approve_pubkey: Option<String>,
    /// Standard-base64 public key for sealing relay envelopes to this device.
    /// Opaque to the server (the KEM is chosen by the clients).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kem_pubkey: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apns: Option<ApnsRegistration>,
}

/// `PUT /v1/device/apns` body (WL1-signed): set or clear the calling device's
/// APNs registration. The `apns` key is required; `null` clears it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateApnsRequest {
    #[serde(deserialize_with = "Option::deserialize")]
    pub apns: Option<ApnsRegistration>,
}

/// Last 8 chars of an APNs token (the only part ever shown publicly).
pub fn apns_token_suffix(token: &str) -> String {
    let n = token.chars().count();
    token.chars().skip(n.saturating_sub(8)).collect()
}

/// Public device record (§3.4 public form).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicDevice {
    pub device_id: String,
    pub name: String,
    pub platform: Platform,
    pub link_pubkey: String,
    pub approve_pubkey: Option<String>,
    pub kem_pubkey: Option<String>,
    pub link_fp: String,
    pub approve_fp: Option<String>,
    /// Last 8 chars of the APNs token only.
    pub apns_token_suffix: Option<String>,
    pub apns_env: Option<ApnsEnv>,
    pub created_at: i64,
    pub revoked_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceList {
    pub devices: Vec<PublicDevice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelaySendRequest {
    /// Recipient device id.
    pub to: String,
    /// Base64 opaque sealed envelope.
    pub ciphertext: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_s: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelaySendResponse {
    pub seq: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayMessage {
    pub seq: i64,
    /// Sender device id.
    pub from: String,
    pub ciphertext: String,
    pub expires_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayFetchResponse {
    pub messages: Vec<RelayMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayAckRequest {
    pub up_to_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayAckResponse {
    /// Number of messages deleted.
    pub deleted: u64,
}

/// What a `/v1/notify` push is about. Absent = the legacy generic alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum NotifyKind {
    /// An approval request is waiting (visible alert).
    #[serde(rename = "approval")]
    Approval,
    /// An approval was decided/expired elsewhere (silent background push that
    /// clears the banner).
    #[serde(rename = "approval.resolved")]
    ApprovalResolved,
}

impl NotifyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NotifyKind::Approval => "approval",
            NotifyKind::ApprovalResolved => "approval.resolved",
        }
    }
}

/// Longest accepted `sealed` blob (characters of standard base64).
pub const MAX_SEALED_CHARS: usize = 2048;

/// `^apr_[a-z0-9]{8,64}$`.
pub fn is_valid_request_id(s: &str) -> bool {
    s.strip_prefix("apr_").is_some_and(|rest| {
        (8..=64).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    })
}

/// Non-empty, at most [`MAX_SEALED_CHARS`] characters, canonical standard
/// base64 (with padding) that decodes.
pub fn is_valid_sealed(s: &str) -> bool {
    use base64::Engine as _;
    !s.is_empty()
        && s.len() <= MAX_SEALED_CHARS
        && base64::engine::general_purpose::STANDARD.decode(s).is_ok()
}

/// `POST /v1/notify` body. No free text: `request_id` is a constrained id and
/// `sealed` an opaque end-to-end encrypted blob the server only forwards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotifyRequest {
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<NotifyKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed: Option<String>,
}

impl NotifyRequest {
    /// Checks the field combination and formats. The message is safe to
    /// return to the client (it never echoes field values).
    pub fn validate(&self) -> Result<(), &'static str> {
        match self.kind {
            None => {
                if self.request_id.is_some() || self.sealed.is_some() {
                    return Err("request_id and sealed require kind");
                }
            }
            Some(kind) => {
                let Some(id) = self.request_id.as_deref() else {
                    return Err("request_id is required with kind");
                };
                if !is_valid_request_id(id) {
                    return Err("request_id must match ^apr_[a-z0-9]{8,64}$");
                }
                if let Some(sealed) = self.sealed.as_deref() {
                    if kind != NotifyKind::Approval {
                        return Err("sealed is only allowed with kind \"approval\"");
                    }
                    if !is_valid_sealed(sealed) {
                        return Err("sealed must be standard base64, at most 2048 characters");
                    }
                }
            }
        }
        Ok(())
    }
}

/// Values of [`NotifyResponse::push`].
pub mod push_status {
    pub const SENT: &str = "sent";
    pub const UNCONFIGURED: &str = "unconfigured";
    pub const NO_TOKEN: &str = "no_token";
    pub const FAILED: &str = "failed";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotifyResponse {
    /// `"sent" | "unconfigured" | "no_token" | "failed"` (see [`push_status`]).
    pub push: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Health {
    pub ok: bool,
    pub service: String,
    pub version: String,
    pub protocol: u32,
    pub server_time: i64,
    /// `"configured" | "unconfigured"` or similar status string.
    pub apns: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn notify_request_validation() {
        let ok = |v: serde_json::Value| -> Result<(), String> {
            let r: NotifyRequest = serde_json::from_value(v).map_err(|e| e.to_string())?;
            r.validate().map_err(String::from)
        };
        let id = "apr_0123abcd";
        assert!(ok(json!({"device_id": "dev_x"})).is_ok());
        assert!(ok(json!({"device_id": "dev_x", "kind": "approval", "request_id": id})).is_ok());
        assert!(ok(
            json!({"device_id": "dev_x", "kind": "approval", "request_id": id,
                          "sealed": "AAECAw=="})
        )
        .is_ok());
        assert!(ok(json!({"device_id": "dev_x", "kind": "approval.resolved",
                          "request_id": format!("apr_{}", "a".repeat(64))}))
        .is_ok());
        for bad in [
            json!({"device_id": "dev_x", "title": "hi"}),
            json!({"device_id": "dev_x", "kind": "other", "request_id": id}),
            json!({"device_id": "dev_x", "request_id": id}),
            json!({"device_id": "dev_x", "sealed": "AAAA"}),
            json!({"device_id": "dev_x", "kind": "approval"}),
            json!({"device_id": "dev_x", "kind": "approval", "request_id": "apr_short"}),
            json!({"device_id": "dev_x", "kind": "approval", "request_id": "apr_ABCDEFGH"}),
            json!({"device_id": "dev_x", "kind": "approval", "request_id": "req_01234567"}),
            json!({"device_id": "dev_x", "kind": "approval",
                   "request_id": format!("apr_{}", "a".repeat(65))}),
            json!({"device_id": "dev_x", "kind": "approval.resolved", "request_id": id,
                   "sealed": "AAAA"}),
            json!({"device_id": "dev_x", "kind": "approval", "request_id": id, "sealed": ""}),
            json!({"device_id": "dev_x", "kind": "approval", "request_id": id, "sealed": "A-_B"}),
            json!({"device_id": "dev_x", "kind": "approval", "request_id": id, "sealed": "AAA"}),
            json!({"device_id": "dev_x", "kind": "approval", "request_id": id,
                   "sealed": "A".repeat(2052)}),
        ] {
            assert!(ok(bad.clone()).is_err(), "{bad}");
        }
        assert!(is_valid_sealed(&"A".repeat(2048)));
        // Legacy shape serializes without the optional fields.
        let r = NotifyRequest {
            device_id: "dev_x".into(),
            kind: None,
            request_id: None,
            sealed: None,
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({"device_id": "dev_x"})
        );
    }

    #[test]
    fn register_roundtrip() {
        let r: RegisterDeviceRequest = serde_json::from_value(json!({
            "name": "phone", "platform": "ios", "link_pubkey": "AA==",
            "apns": {"token": "abcd", "env": "sandbox"}
        }))
        .unwrap();
        assert_eq!(r.platform, Platform::Ios);
        assert_eq!(r.approve_pubkey, None);
        assert_eq!(r.apns.as_ref().unwrap().env, ApnsEnv::Sandbox);
        assert!(serde_json::from_value::<RegisterDeviceRequest>(
            json!({"name":"x","platform":"windows","link_pubkey":"AA=="})
        )
        .is_err());
    }

    #[test]
    fn update_apns_shapes() {
        let set: UpdateApnsRequest =
            serde_json::from_value(json!({"apns": {"token": "abcd", "env": "production"}}))
                .unwrap();
        assert_eq!(set.apns.unwrap().env, ApnsEnv::Production);
        let clear: UpdateApnsRequest = serde_json::from_value(json!({"apns": null})).unwrap();
        assert_eq!(clear.apns, None);
        assert_eq!(serde_json::to_value(&clear).unwrap(), json!({"apns": null}));
        // The key is required: `{}` is not a silent clear.
        assert!(serde_json::from_value::<UpdateApnsRequest>(json!({})).is_err());
        assert!(serde_json::from_value::<UpdateApnsRequest>(
            json!({"apns": {"token": "abcd", "env": "dev"}})
        )
        .is_err());
    }

    #[test]
    fn token_suffix() {
        assert_eq!(apns_token_suffix("0123456789abcdef"), "89abcdef");
        assert_eq!(apns_token_suffix("abc"), "abc");
    }

    #[test]
    fn relay_shapes() {
        let s = RelaySendRequest {
            to: "dev_x".into(),
            ciphertext: "Zm9v".into(),
            ttl_s: None,
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({"to":"dev_x","ciphertext":"Zm9v"})
        );
        let a: RelayAckRequest = serde_json::from_str(r#"{"up_to_seq":5}"#).unwrap();
        assert_eq!(a.up_to_seq, 5);
    }
}
