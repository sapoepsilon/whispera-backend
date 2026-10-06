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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotifyRequest {
    pub device_id: String,
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
