//! P-256 key encodings (PROTOCOL §2.1).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePrivateKey;
use sha2::{Digest, Sha256};

use crate::ProtoError;

/// Fixed 26-byte SPKI DER prefix for a P-256 named-curve uncompressed public key.
pub const SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

/// Length of an X9.63 uncompressed P-256 point.
pub const X963_LEN: usize = 65;

/// A P-256 ECDSA verifying key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicKey {
    vk: VerifyingKey,
    x963: [u8; X963_LEN],
}

impl PublicKey {
    /// Parse standard-base64 (padded) X9.63 bytes.
    pub fn from_x963_b64(s: &str) -> Result<Self, ProtoError> {
        let bytes = STANDARD.decode(s.trim()).map_err(|_| ProtoError::Base64)?;
        Self::from_x963(&bytes)
    }

    /// Parse raw X9.63 bytes: exactly 65 bytes starting `0x04`, on the curve.
    pub fn from_x963(bytes: &[u8]) -> Result<Self, ProtoError> {
        if bytes.len() != X963_LEN || bytes[0] != 0x04 {
            return Err(ProtoError::KeyLength);
        }
        let vk = VerifyingKey::from_sec1_bytes(bytes).map_err(|_| ProtoError::InvalidPoint)?;
        let mut x963 = [0u8; X963_LEN];
        x963.copy_from_slice(bytes);
        Ok(Self { vk, x963 })
    }

    /// Parse a 91-byte SPKI DER with the fixed P-256 prefix.
    pub fn from_spki_der(der: &[u8]) -> Result<Self, ProtoError> {
        if der.len() != SPKI_PREFIX.len() + X963_LEN || der[..SPKI_PREFIX.len()] != SPKI_PREFIX {
            return Err(ProtoError::SpkiPrefix);
        }
        Self::from_x963(&der[SPKI_PREFIX.len()..])
    }

    fn from_verifying_key(vk: VerifyingKey) -> Self {
        let point = vk.to_encoded_point(false);
        let mut x963 = [0u8; X963_LEN];
        x963.copy_from_slice(point.as_bytes());
        Self { vk, x963 }
    }

    pub fn x963(&self) -> &[u8; X963_LEN] {
        &self.x963
    }

    pub fn to_x963_b64(&self) -> String {
        STANDARD.encode(self.x963)
    }

    pub fn verifying_key(&self) -> &VerifyingKey {
        &self.vk
    }

    /// SPKI DER: fixed prefix + 65 X9.63 bytes (91 bytes).
    pub fn spki_der(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(SPKI_PREFIX.len() + X963_LEN);
        v.extend_from_slice(&SPKI_PREFIX);
        v.extend_from_slice(&self.x963);
        v
    }

    /// PEM `PUBLIC KEY`, base64 wrapped at 64 columns, trailing newline.
    pub fn spki_pem(&self) -> String {
        let b64 = STANDARD.encode(self.spki_der());
        let mut out = String::from("-----BEGIN PUBLIC KEY-----\n");
        for chunk in b64.as_bytes().chunks(64) {
            // base64 output is ASCII
            out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
            out.push('\n');
        }
        out.push_str("-----END PUBLIC KEY-----\n");
        out
    }

    /// Lowercase hex SHA-256 of the SPKI DER (64 chars).
    pub fn fingerprint(&self) -> String {
        hex::encode(Sha256::digest(self.spki_der()))
    }

    /// First 16 hex chars of the fingerprint in groups of 4 joined by `-`.
    pub fn display_fingerprint(&self) -> String {
        display_fingerprint(&self.fingerprint())
    }
}

/// Display form of a 64-hex fingerprint: `xxxx-xxxx-xxxx-xxxx`.
pub fn display_fingerprint(fp_hex: &str) -> String {
    let head: Vec<char> = fp_hex.chars().take(16).collect();
    head.chunks(4)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

/// P-256 signing key wrapper for clients and tests (the server never holds device keys).
#[derive(Clone)]
pub struct SigningKey {
    inner: p256::ecdsa::SigningKey,
}

impl std::fmt::Debug for SigningKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SigningKey")
            .field("public", &self.public_key().fingerprint())
            .finish_non_exhaustive()
    }
}

impl SigningKey {
    pub fn generate() -> Self {
        Self {
            inner: p256::ecdsa::SigningKey::random(&mut rand::rngs::OsRng),
        }
    }

    /// Parse a PKCS#8 `PRIVATE KEY` PEM.
    pub fn from_pkcs8_pem(pem: &str) -> Result<Self, ProtoError> {
        let inner =
            p256::ecdsa::SigningKey::from_pkcs8_pem(pem).map_err(|_| ProtoError::PrivateKey)?;
        Ok(Self { inner })
    }

    pub fn public_key(&self) -> PublicKey {
        PublicKey::from_verifying_key(*self.inner.verifying_key())
    }

    /// ECDSA P-256 SHA-256 over `msg`, ASN.1 DER, standard base64.
    pub fn sign_der_b64(&self, msg: &[u8]) -> String {
        let sig: Signature = self.inner.sign(msg);
        STANDARD.encode(sig.to_der().as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_keys() {
        assert_eq!(
            PublicKey::from_x963_b64("not base64!"),
            Err(ProtoError::Base64)
        );
        assert_eq!(PublicKey::from_x963(&[4u8; 33]), Err(ProtoError::KeyLength));
        let k = SigningKey::generate().public_key();
        let mut compressed = k.x963().to_vec();
        compressed[0] = 0x02;
        assert_eq!(
            PublicKey::from_x963(&compressed),
            Err(ProtoError::KeyLength)
        );
        let mut off_curve = *k.x963();
        off_curve[64] ^= 1;
        assert_eq!(
            PublicKey::from_x963(&off_curve),
            Err(ProtoError::InvalidPoint)
        );
    }

    #[test]
    fn spki_roundtrip_and_prefix() {
        let k = SigningKey::generate().public_key();
        let der = k.spki_der();
        assert_eq!(der.len(), 91);
        assert_eq!(PublicKey::from_spki_der(&der).unwrap(), k);
        let mut bad = der.clone();
        bad[5] ^= 1;
        assert_eq!(PublicKey::from_spki_der(&bad), Err(ProtoError::SpkiPrefix));
        assert_eq!(
            PublicKey::from_x963_b64(&k.to_x963_b64())
                .unwrap()
                .fingerprint(),
            k.fingerprint()
        );
        let pem = k.spki_pem();
        assert!(pem.ends_with("-----END PUBLIC KEY-----\n"));
        assert!(pem.lines().all(|l| l.len() <= 64));
    }

    #[test]
    fn display_fp() {
        assert_eq!(
            display_fingerprint("087b057a375919bcae4ea650da18850dd4db7d684f448bd654d7bbcc97ab1af7"),
            "087b-057a-3759-19bc"
        );
    }
}
