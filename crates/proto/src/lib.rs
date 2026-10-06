//! whispera-proto: pure (no I/O) protocol pieces shared by the Whispera backend and its clients.
//!
//! - [`keys`]: P-256 public keys in X9.63 / SPKI / PEM form and fingerprints (PROTOCOL §2.1).
//! - [`sign`]: WL1 request signing and verification (PROTOCOL §4), id/nonce helpers.
//! - [`error`]: error codes and the OpenAI-compatible error envelope (PROTOCOL §13).
//! - [`wire`]: JSON request/response bodies used by the backend.

pub mod error;
pub mod keys;
pub mod sign;
pub mod wire;

pub use error::{ErrorBody, ErrorCode, ErrorEnvelope};
pub use keys::{PublicKey, SigningKey};
pub use sign::SignedHeaders;

/// Errors from parsing protocol values (keys, signatures, encodings).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtoError {
    #[error("invalid base64")]
    Base64,
    #[error("public key must be 65 bytes X9.63 uncompressed (0x04 prefix)")]
    KeyLength,
    #[error("not a valid P-256 point")]
    InvalidPoint,
    #[error("SPKI DER is not a P-256 named-curve public key")]
    SpkiPrefix,
    #[error("invalid PKCS#8 private key")]
    PrivateKey,
}
