//! Conformance against docs/vectors/v1.json (copied from whispera-link; throwaway test keys).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::Value;
use whispera_proto::keys::{PublicKey, SigningKey, SPKI_PREFIX};
use whispera_proto::sign::{
    approval_message, body_sha256_hex, pair_approve_message, pair_proof_message,
    pair_response_message, string_to_sign, verify_der_b64, verify_request, SignedHeaders,
};
use whispera_proto::ErrorCode;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/v1.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("missing {k}"))
}

fn key(v: &Value, name: &str) -> PublicKey {
    PublicKey::from_x963_b64(s(&v[name], "public_x963_b64")).unwrap()
}

#[test]
fn warning_kept() {
    assert!(s(&vectors(), "_WARNING").contains("THROWAWAY"));
}

#[test]
fn spki_prefix() {
    assert_eq!(
        hex::encode(SPKI_PREFIX),
        s(&vectors(), "prefix_spki_p256_hex")
    );
}

#[test]
fn keys_match() {
    let v = vectors();
    for name in ["link", "approve", "daemon"] {
        let k = &v[name];
        let pk = key(&v, name);
        assert_eq!(
            STANDARD.encode(pk.spki_der()),
            s(k, "spki_der_b64"),
            "{name}"
        );
        assert_eq!(pk.fingerprint(), s(k, "fingerprint"), "{name}");
        assert_eq!(pk.to_x963_b64(), s(k, "public_x963_b64"), "{name}");
        let der = STANDARD.decode(s(k, "spki_der_b64")).unwrap();
        assert_eq!(PublicKey::from_spki_der(&der).unwrap(), pk, "{name}");
        let sk = SigningKey::from_pkcs8_pem(s(k, "private_pkcs8_pem")).unwrap();
        assert_eq!(sk.public_key(), pk, "{name}");
        // fresh signature from the PEM key verifies with the public key
        let sig = sk.sign_der_b64(b"hello");
        assert!(verify_der_b64(&pk, b"hello", &sig));
    }
    assert_eq!(
        key(&v, "daemon").display_fingerprint(),
        "087b-057a-3759-19bc"
    );
}

#[test]
fn request_auth() {
    let v = vectors();
    let r = &v["request_auth"];
    let body = s(r, "body_utf8").as_bytes();
    assert_eq!(body_sha256_hex(body), s(r, "body_sha256_hex"));
    let sts = string_to_sign(
        &s(r, "method").to_lowercase(),
        s(r, "path"),
        body,
        s(r, "timestamp"),
        s(r, "nonce"),
        s(r, "device_id"),
    );
    assert_eq!(sts, s(r, "string_to_sign_utf8"));
    let pk = key(&v, "link");
    assert!(verify_der_b64(
        &pk,
        sts.as_bytes(),
        s(r, "signature_der_b64")
    ));
    let mut tampered = sts.clone().into_bytes();
    tampered.push(b'x');
    assert!(!verify_der_b64(&pk, &tampered, s(r, "signature_der_b64")));
    assert!(!verify_der_b64(
        &key(&v, "approve"),
        sts.as_bytes(),
        s(r, "signature_der_b64")
    ));

    let headers = SignedHeaders {
        device_id: s(r, "device_id").into(),
        timestamp: s(r, "timestamp").into(),
        nonce: s(r, "nonce").into(),
        signature: s(r, "signature_der_b64").into(),
    };
    let now: i64 = s(r, "timestamp").parse().unwrap();
    assert_eq!(
        verify_request(&pk, &headers, "POST", s(r, "path"), body, now + 10, 60),
        Ok(())
    );
    assert_eq!(
        verify_request(&pk, &headers, "POST", s(r, "path"), body, now + 75, 60),
        Err(ErrorCode::AuthClockSkew)
    );
    assert_eq!(
        verify_request(
            &pk,
            &headers,
            "POST",
            "/v1/agents/w3:p1/prompt",
            body,
            now,
            60
        ),
        Err(ErrorCode::AuthBadSignature)
    );
}

#[test]
fn empty_body_sha() {
    assert_eq!(body_sha256_hex(b""), s(&vectors(), "empty_body_sha256_hex"));
}

#[test]
fn approval() {
    let v = vectors();
    let a = &v["approval"];
    let canonical = STANDARD.decode(s(a, "canonical_b64")).unwrap();
    assert_eq!(canonical, s(a, "canonical_utf8").as_bytes());
    let msg = approval_message(&canonical);
    assert_eq!(STANDARD.encode(&msg), s(a, "signed_message_b64"));
    let ak = key(&v, "approve");
    assert!(verify_der_b64(&ak, &msg, s(a, "signature_der_b64")));
    assert!(!verify_der_b64(&ak, &canonical, s(a, "signature_der_b64")));
    assert!(!verify_der_b64(
        &key(&v, "link"),
        &msg,
        s(a, "signature_der_b64")
    ));
}

#[test]
fn pairing_proofs() {
    let v = vectors();
    let p = &v["pairing"];
    let lk = key(&v, "link");
    let ak = key(&v, "approve");
    let proof = pair_proof_message(s(p, "code"), s(p, "daemon_fp"), &ak);
    assert_eq!(proof, s(p, "proof_message_utf8"));
    assert!(verify_der_b64(&lk, proof.as_bytes(), s(p, "proof_der_b64")));
    assert!(!verify_der_b64(
        &ak,
        proof.as_bytes(),
        s(p, "proof_der_b64")
    ));

    let ap = pair_approve_message(s(p, "code"), s(p, "daemon_fp"));
    assert_eq!(ap, s(p, "approve_proof_message_utf8"));
    assert!(verify_der_b64(
        &ak,
        ap.as_bytes(),
        s(p, "approve_proof_der_b64")
    ));
    assert!(!verify_der_b64(
        &lk,
        ap.as_bytes(),
        s(p, "approve_proof_der_b64")
    ));
    assert_eq!(s(p, "daemon_fp"), key(&v, "daemon").fingerprint());
}

#[test]
fn pair_response_sig() {
    let v = vectors();
    let r = &v["pair_response_sig"];
    let msg = pair_response_message(s(r, "body_utf8").as_bytes());
    assert_eq!(msg, s(r, "message_utf8"));
    let dk = key(&v, "daemon");
    assert!(verify_der_b64(
        &dk,
        msg.as_bytes(),
        s(r, "signature_der_b64")
    ));
    assert!(!verify_der_b64(
        &dk,
        b"WL1-PAIR-RESP\n00",
        s(r, "signature_der_b64")
    ));
}
