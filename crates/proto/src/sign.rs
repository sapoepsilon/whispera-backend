//! WL1 request authentication (PROTOCOL §4) and the other signed messages (§3.3, §7.2).
//!
//! Replay caching and device lookup are the server's job; this module only does the pure
//! parts: string-to-sign, signature checks, timestamp skew, and id/nonce formats.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::Signature;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::error::ErrorCode;
use crate::keys::{PublicKey, SigningKey};

pub const HDR_DEVICE: &str = "x-wl-device";
pub const HDR_TIMESTAMP: &str = "x-wl-timestamp";
pub const HDR_NONCE: &str = "x-wl-nonce";
pub const HDR_SIGNATURE: &str = "x-wl-signature";
/// Pairing response signature header (§3.3).
pub const HDR_SERVER_SIGNATURE: &str = "x-wl-server-signature";

/// Default allowed clock skew in seconds (§4.3).
pub const DEFAULT_CLOCK_SKEW_S: i64 = 60;

/// Lowercase hex SHA-256 of raw bytes.
pub fn body_sha256_hex(body: &[u8]) -> String {
    hex::encode(Sha256::digest(body))
}

/// §4.2 string to sign: `WL1\nMETHOD\ntarget\nsha\nts\nnonce\ndevice`, no trailing newline.
pub fn string_to_sign(
    method: &str,
    request_target: &str,
    body: &[u8],
    timestamp: &str,
    nonce: &str,
    device_id: &str,
) -> String {
    format!(
        "WL1\n{}\n{}\n{}\n{}\n{}\n{}",
        method.to_ascii_uppercase(),
        request_target,
        body_sha256_hex(body),
        timestamp,
        nonce,
        device_id
    )
}

/// §3.3 link-key proof message: `WL1-PAIR-PROOF\n<code>\n<daemon_fp>\n<sha256hex(approve x963)>`.
pub fn pair_proof_message(code: &str, daemon_fp: &str, approve_pubkey: &PublicKey) -> String {
    format!(
        "WL1-PAIR-PROOF\n{}\n{}\n{}",
        code,
        daemon_fp,
        body_sha256_hex(approve_pubkey.x963())
    )
}

/// §3.3 approve-key proof message: `WL1-PAIR-APPROVE\n<code>\n<daemon_fp>`.
pub fn pair_approve_message(code: &str, daemon_fp: &str) -> String {
    format!("WL1-PAIR-APPROVE\n{code}\n{daemon_fp}")
}

/// §3.3 pairing response signature message: `WL1-PAIR-RESP\n<sha256hex(body)>`.
pub fn pair_response_message(body: &[u8]) -> String {
    format!("WL1-PAIR-RESP\n{}", body_sha256_hex(body))
}

/// §7.2 approval message: `WL1-APPROVE\n` + canonical bytes.
pub fn approval_message(canonical: &[u8]) -> Vec<u8> {
    let mut m = b"WL1-APPROVE\n".to_vec();
    m.extend_from_slice(canonical);
    m
}

/// Verify an ECDSA P-256 / SHA-256 ASN.1 DER signature (standard base64) over `msg`.
///
/// High-S signatures (as produced by CryptoKit/openssl) are accepted. Never panics.
pub fn verify_der_b64(pk: &PublicKey, msg: &[u8], sig_b64: &str) -> bool {
    let Ok(der) = STANDARD.decode(sig_b64.trim()) else {
        return false;
    };
    let Ok(sig) = Signature::from_der(&der) else {
        return false;
    };
    let sig = sig.normalize_s().unwrap_or(sig);
    pk.verifying_key().verify(msg, &sig).is_ok()
}

/// The four WL1 auth header values (§4.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedHeaders {
    pub device_id: String,
    pub timestamp: String,
    pub nonce: String,
    pub signature: String,
}

impl SignedHeaders {
    /// Build signed headers for a request (clients/tests).
    pub fn sign(
        signing_key: &SigningKey,
        device_id: &str,
        method: &str,
        target: &str,
        body: &[u8],
        timestamp: i64,
        nonce: &str,
    ) -> Self {
        let ts = timestamp.to_string();
        let sts = string_to_sign(method, target, body, &ts, nonce, device_id);
        Self {
            device_id: device_id.to_owned(),
            timestamp: ts,
            nonce: nonce.to_owned(),
            signature: signing_key.sign_der_b64(sts.as_bytes()),
        }
    }

    /// `(header-name, value)` pairs, lowercase names.
    pub fn header_pairs(&self) -> [(&'static str, &str); 4] {
        [
            (HDR_DEVICE, &self.device_id),
            (HDR_TIMESTAMP, &self.timestamp),
            (HDR_NONCE, &self.nonce),
            (HDR_SIGNATURE, &self.signature),
        ]
    }
}

/// Parse a decimal Unix-seconds timestamp (ASCII digits only, optional leading `-`).
pub fn parse_timestamp(s: &str) -> Option<i64> {
    let digits = s.strip_prefix('-').unwrap_or(s);
    if digits.is_empty() || digits.len() > 18 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Check skew then signature (§4.3 steps 3 and 5). Device lookup, revocation, body limits
/// and replay cache are the caller's responsibility.
///
/// An unparsable timestamp is reported as `AuthClockSkew`.
pub fn verify_request(
    pk: &PublicKey,
    headers: &SignedHeaders,
    method: &str,
    target: &str,
    body: &[u8],
    now: i64,
    skew_s: i64,
) -> Result<(), ErrorCode> {
    let ts = parse_timestamp(&headers.timestamp).ok_or(ErrorCode::AuthClockSkew)?;
    if (i128::from(now) - i128::from(ts)).abs() > i128::from(skew_s) {
        return Err(ErrorCode::AuthClockSkew);
    }
    let sts = string_to_sign(
        method,
        target,
        body,
        &headers.timestamp,
        &headers.nonce,
        &headers.device_id,
    );
    if verify_der_b64(pk, sts.as_bytes(), &headers.signature) {
        Ok(())
    } else {
        Err(ErrorCode::AuthBadSignature)
    }
}

fn is_prefixed_id(s: &str, prefix: &str) -> bool {
    match s.strip_prefix(prefix) {
        Some(rest) => {
            rest.len() == 24 && rest.bytes().all(|b| matches!(b, b'a'..=b'z' | b'2'..=b'7'))
        }
        None => false,
    }
}

/// `^dev_[a-z2-7]{24}$`
pub fn is_valid_device_id(s: &str) -> bool {
    is_prefixed_id(s, "dev_")
}

/// `^[A-Za-z0-9_-]{22}$`
pub fn is_valid_nonce(s: &str) -> bool {
    s.len() == 22
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Lowercase RFC 4648 base32 without padding.
fn base32_lower(data: &[u8]) -> String {
    const ALPHA: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::with_capacity(data.len().div_ceil(5) * 8);
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for &b in data {
        buf = (buf << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHA[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHA[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// `<prefix>_` + lowercase base32 of 15 random bytes (24 chars).
pub fn new_prefixed_id(prefix: &str) -> String {
    let mut b = [0u8; 15];
    rand::rngs::OsRng.fill_bytes(&mut b);
    format!("{prefix}_{}", base32_lower(&b))
}

/// New `dev_…` id.
pub fn new_device_id() -> String {
    new_prefixed_id("dev")
}

/// 16 random bytes, base64url without padding (22 chars).
pub fn new_nonce() -> String {
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::elliptic_curve::ops::Neg;

    const NOW: i64 = 1_791_158_400;

    fn setup() -> (SigningKey, String) {
        (SigningKey::generate(), new_device_id())
    }

    #[test]
    fn verify_request_ok_skew_and_bad_sig() {
        let (sk, dev) = setup();
        let pk = sk.public_key();
        let body = br#"{"x":1}"#;
        let h = SignedHeaders::sign(&sk, &dev, "post", "/v1/x?a=b", body, NOW, &new_nonce());
        assert_eq!(
            verify_request(&pk, &h, "POST", "/v1/x?a=b", body, NOW + 60, 60),
            Ok(())
        );
        assert_eq!(
            verify_request(&pk, &h, "POST", "/v1/x?a=b", body, NOW - 61, 60),
            Err(ErrorCode::AuthClockSkew)
        );
        assert_eq!(
            verify_request(&pk, &h, "POST", "/v1/x?a=c", body, NOW, 60),
            Err(ErrorCode::AuthBadSignature)
        );
        assert_eq!(
            verify_request(&pk, &h, "POST", "/v1/x?a=b", b"{}", NOW, 60),
            Err(ErrorCode::AuthBadSignature)
        );
        let other = SigningKey::generate().public_key();
        assert_eq!(
            verify_request(&other, &h, "POST", "/v1/x?a=b", body, NOW, 60),
            Err(ErrorCode::AuthBadSignature)
        );
        for bad_ts in [
            "",
            "abc",
            "+1791158400",
            "1791158400 ",
            "99999999999999999999",
        ] {
            let mut h2 = h.clone();
            h2.timestamp = bad_ts.into();
            assert_eq!(
                verify_request(&pk, &h2, "POST", "/v1/x?a=b", body, NOW, 60),
                Err(ErrorCode::AuthClockSkew),
                "{bad_ts:?}"
            );
        }
        let mut h3 = h.clone();
        h3.timestamp = i64::MIN.to_string();
        assert_eq!(
            verify_request(&pk, &h3, "POST", "/v1/x?a=b", body, i64::MAX, 60),
            Err(ErrorCode::AuthClockSkew)
        );
    }

    #[test]
    fn garbage_signatures_never_panic() {
        let pk = SigningKey::generate().public_key();
        for s in ["", "!!!", "AAAA", "MAYCAQACAQA=", &"A".repeat(10_000)] {
            assert!(!verify_der_b64(&pk, b"m", s));
        }
    }

    #[test]
    fn high_s_accepted() {
        let sk = SigningKey::generate();
        let pk = sk.public_key();
        let msg = b"high-s test";
        let der = STANDARD.decode(sk.sign_der_b64(msg)).unwrap();
        let sig = Signature::from_der(&der).unwrap();
        let (r, s) = sig.split_scalars();
        let flipped = Signature::from_scalars(r.to_bytes(), s.as_ref().neg().to_bytes()).unwrap();
        // exactly one of sig / flipped is high-S
        assert_ne!(sig.normalize_s().is_some(), flipped.normalize_s().is_some());
        for v in [sig, flipped] {
            let b64 = STANDARD.encode(v.to_der().as_bytes());
            assert!(verify_der_b64(&pk, msg, &b64));
            assert!(!verify_der_b64(&pk, b"other", &b64));
        }
    }

    #[test]
    fn id_validators() {
        for _ in 0..50 {
            let d = new_device_id();
            assert!(is_valid_device_id(&d), "{d}");
            let n = new_nonce();
            assert!(is_valid_nonce(&n), "{n}");
        }
        assert!(is_valid_device_id("dev_aaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!is_valid_device_id("dev_aaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!is_valid_device_id("dev_aaaaaaaaaaaaaaaaaaaaaaa1"));
        assert!(!is_valid_device_id("dev_AAAAAAAAAAAAAAAAAAAAAAAA"));
        assert!(!is_valid_device_id("apr_aaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(is_valid_nonce("q2Vh8m0Zr8G0xk3p1n9Yxw"));
        assert!(!is_valid_nonce("q2Vh8m0Zr8G0xk3p1n9Yx="));
        assert!(!is_valid_nonce("q2Vh8m0Zr8G0xk3p1n9Yxwx"));
    }

    #[test]
    fn base32_rfc4648() {
        assert_eq!(base32_lower(b""), "");
        assert_eq!(base32_lower(b"f"), "my");
        assert_eq!(base32_lower(b"foobar"), "mzxw6ytboi");
    }
}
