//! OIDC verifier tests with locally generated RSA and P-256 keys. No internet.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{json, Value};
use whispera_auth::{AccountAuth, AuthError, ConfigError, OidcAuth, OidcConfig};

const ISS: &str = "https://issuer.example.com";

struct Keys {
    rsa_enc: EncodingKey,
    rsa_jwk: Value,
    ec_enc: EncodingKey,
    ec_jwk: Value,
    ec2_enc: EncodingKey,
    ec2_jwk: Value,
}

fn b64(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

fn ec_key(kid: &str) -> (EncodingKey, Value) {
    use p256::pkcs8::EncodePrivateKey;
    let sk = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let der = sk.to_pkcs8_der().unwrap();
    let pt = p256::elliptic_curve::sec1::ToEncodedPoint::to_encoded_point(&sk.public_key(), false);
    let jwk = json!({
        "kty": "EC", "crv": "P-256", "kid": kid, "use": "sig", "alg": "ES256",
        "x": b64(pt.x().unwrap()), "y": b64(pt.y().unwrap()),
    });
    (EncodingKey::from_ec_der(der.as_bytes()), jwk)
}

fn keys() -> &'static Keys {
    static K: OnceLock<Keys> = OnceLock::new();
    K.get_or_init(|| {
        use rsa::pkcs1::EncodeRsaPrivateKey;
        use rsa::traits::PublicKeyParts;
        let sk = rsa::RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).unwrap();
        let der = sk.to_pkcs1_der().unwrap();
        let rsa_jwk = json!({
            "kty": "RSA", "kid": "rsa1", "use": "sig", "alg": "RS256",
            "n": b64(&sk.n().to_bytes_be()), "e": b64(&sk.e().to_bytes_be()),
        });
        let (ec_enc, ec_jwk) = ec_key("ec1");
        let (ec2_enc, ec2_jwk) = ec_key("ec2");
        Keys {
            rsa_enc: EncodingKey::from_rsa_der(der.as_bytes()),
            rsa_jwk,
            ec_enc,
            ec_jwk,
            ec2_enc,
            ec2_jwk,
        }
    })
}

fn jwks(keys: &[&Value]) -> String {
    json!({ "keys": keys }).to_string()
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn claims() -> Value {
    json!({
        "iss": ISS, "sub": "user_123", "aud": "whispera-api",
        "azp": "https://app.example.com",
        "iat": now(), "nbf": now() - 5, "exp": now() + 300,
    })
}

fn sign(alg: Algorithm, kid: &str, key: &EncodingKey, claims: &Value) -> String {
    let mut h = Header::new(alg);
    h.kid = Some(kid.into());
    jsonwebtoken::encode(&h, claims, key).unwrap()
}

fn rs(c: &Value) -> String {
    sign(Algorithm::RS256, "rsa1", &keys().rsa_enc, c)
}
fn es(c: &Value) -> String {
    sign(Algorithm::ES256, "ec1", &keys().ec_enc, c)
}

fn config() -> OidcConfig {
    OidcConfig {
        issuer: ISS.into(),
        audiences: vec!["whispera-api".into()],
        ..Default::default()
    }
}

fn auth_with(cfg: OidcConfig) -> OidcAuth {
    let k = keys();
    OidcAuth::from_jwks(cfg, &jwks(&[&k.rsa_jwk, &k.ec_jwk])).unwrap()
}

fn auth() -> OidcAuth {
    auth_with(config())
}

fn with(mut c: Value, k: &str, v: Value) -> Value {
    c[k] = v;
    c
}

fn without(mut c: Value, k: &str) -> Value {
    c.as_object_mut().unwrap().remove(k);
    c
}

async fn invalid(a: &OidcAuth, token: &str) -> String {
    match a.authenticate(token).await {
        Err(AuthError::Invalid(r)) => r,
        other => panic!("expected Invalid, got {other:?}"),
    }
}

#[tokio::test]
async fn valid_rsa_and_ec_tokens() {
    let a = auth();
    assert_eq!(a.kind(), "oidc");
    for t in [rs(&claims()), es(&claims())] {
        let id = a.authenticate(&t).await.unwrap();
        assert_eq!(id.issuer, ISS);
        assert_eq!(id.subject, "user_123");
    }
    // aud as array that intersects.
    let c = with(claims(), "aud", json!(["other", "whispera-api"]));
    assert!(a.authenticate(&es(&c)).await.is_ok());
    assert!(matches!(a.authenticate("").await, Err(AuthError::Missing)));
}

#[tokio::test]
async fn wrong_issuer() {
    let c = with(claims(), "iss", json!("https://evil.example.com"));
    assert_eq!(invalid(&auth(), &rs(&c)).await, "wrong_issuer");
    let c = with(claims(), "iss", json!(format!("{ISS}/")));
    assert_eq!(invalid(&auth(), &rs(&c)).await, "wrong_issuer");
    assert_eq!(
        invalid(&auth(), &rs(&without(claims(), "iss"))).await,
        "missing_iss"
    );
}

#[tokio::test]
async fn wrong_audience() {
    let c = with(claims(), "aud", json!("someone-else"));
    assert_eq!(invalid(&auth(), &es(&c)).await, "wrong_audience");
    let c = with(claims(), "aud", json!(["a", "b"]));
    assert_eq!(invalid(&auth(), &es(&c)).await, "wrong_audience");
    assert_eq!(
        invalid(&auth(), &es(&without(claims(), "aud"))).await,
        "missing_aud"
    );
}

fn clerk_config() -> OidcConfig {
    OidcConfig {
        issuer: ISS.into(),
        authorized_parties: vec!["https://app.example.com".into()],
        ..Default::default()
    }
}

#[tokio::test]
async fn azp_rules() {
    // Clerk-style: no aud, azp required.
    let a = auth_with(clerk_config());
    let ok = without(claims(), "aud");
    assert!(a.authenticate(&rs(&ok)).await.is_ok());
    let c = with(ok.clone(), "azp", json!("https://evil.example.com"));
    assert_eq!(invalid(&a, &rs(&c)).await, "azp_not_allowed");
    assert_eq!(
        invalid(&a, &rs(&without(ok.clone(), "azp"))).await,
        "missing_azp"
    );
    // Both aud and azp configured: both enforced.
    let mut cfg = config();
    cfg.authorized_parties = vec!["https://app.example.com".into()];
    let a = auth_with(cfg);
    assert!(a.authenticate(&es(&claims())).await.is_ok());
    let c = with(claims(), "azp", json!("https://other"));
    assert_eq!(invalid(&a, &es(&c)).await, "azp_not_allowed");
    assert_eq!(
        invalid(&a, &es(&without(claims(), "azp"))).await,
        "missing_azp"
    );
}

#[tokio::test]
async fn time_claims() {
    let a = auth();
    let c = with(claims(), "exp", json!(now() - 120));
    assert_eq!(invalid(&a, &rs(&c)).await, "expired");
    // Within leeway (30 s) is accepted.
    let c = with(claims(), "exp", json!(now() - 10));
    assert!(a.authenticate(&rs(&c)).await.is_ok());
    assert_eq!(
        invalid(&a, &rs(&without(claims(), "exp"))).await,
        "missing_exp"
    );
    let c = with(claims(), "nbf", json!(now() + 600));
    assert_eq!(invalid(&a, &rs(&c)).await, "not_yet_valid");
    let c = with(claims(), "iat", json!(now() + 600));
    assert_eq!(invalid(&a, &rs(&c)).await, "iat_in_future");
}

fn unsigned(header: Value, claims: &Value, sig: &[u8]) -> String {
    format!(
        "{}.{}.{}",
        b64(header.to_string().as_bytes()),
        b64(claims.to_string().as_bytes()),
        b64(sig)
    )
}

#[tokio::test]
async fn alg_none_and_hmac_rejected() {
    let a = auth();
    let t = unsigned(json!({"alg": "none", "kid": "rsa1"}), &claims(), b"");
    assert_eq!(invalid(&a, &t).await, "alg_not_allowed");
    let t = format!("{}.", &t[..t.len() - 1]);
    assert_eq!(invalid(&a, &t).await, "alg_not_allowed");
    // HS256 keyed with the RSA modulus (classic key-confusion attempt).
    let n = keys().rsa_jwk["n"].as_str().unwrap().to_string();
    let mut h = Header::new(Algorithm::HS256);
    h.kid = Some("rsa1".into());
    let t = jsonwebtoken::encode(&h, &claims(), &EncodingKey::from_secret(n.as_bytes())).unwrap();
    assert_eq!(invalid(&a, &t).await, "alg_not_allowed");
    // An allowed-family alg not in the allow-list (RS384) is rejected too.
    let t = sign(Algorithm::RS384, "rsa1", &keys().rsa_enc, &claims());
    assert_eq!(invalid(&a, &t).await, "alg_not_allowed");
    // HS* can't even be configured.
    let mut cfg = config();
    cfg.allowed_algs = vec![Algorithm::HS256];
    assert!(OidcAuth::from_jwks(cfg, &jwks(&[&keys().rsa_jwk])).is_err());
}

#[tokio::test]
async fn unknown_kid() {
    let a = auth();
    let t = sign(Algorithm::ES256, "nope", &keys().ec_enc, &claims());
    assert_eq!(invalid(&a, &t).await, "unknown_kid");
    // kid of an RSA key with an EC alg: no compatible key.
    let t = sign(Algorithm::ES256, "rsa1", &keys().ec_enc, &claims());
    assert_eq!(invalid(&a, &t).await, "unknown_kid");
}

#[tokio::test]
async fn tampered_signature_and_payload() {
    let a = auth();
    for t in [rs(&claims()), es(&claims())] {
        let mut parts: Vec<String> = t.split('.').map(String::from).collect();
        let mut sig = URL_SAFE_NO_PAD.decode(&parts[2]).unwrap();
        sig[5] ^= 1;
        parts[2] = b64(&sig);
        assert_eq!(invalid(&a, &parts.join(".")).await, "bad_signature");
        // Swap payload for one with a different sub.
        let mut parts: Vec<String> = t.split('.').map(String::from).collect();
        parts[1] = b64(with(claims(), "sub", json!("admin")).to_string().as_bytes());
        assert_eq!(invalid(&a, &parts.join(".")).await, "bad_signature");
    }
    // Signed by a different EC key that claims kid ec1.
    let t = sign(Algorithm::ES256, "ec1", &keys().ec2_enc, &claims());
    assert_eq!(invalid(&a, &t).await, "bad_signature");
    assert_eq!(invalid(&a, "a.b").await, "malformed");
    assert_eq!(invalid(&a, "not-a-jwt").await, "malformed");
}

#[tokio::test]
async fn missing_or_empty_sub() {
    let a = auth();
    assert_eq!(
        invalid(&a, &rs(&without(claims(), "sub"))).await,
        "missing_sub"
    );
    let c = with(claims(), "sub", json!(""));
    assert_eq!(invalid(&a, &rs(&c)).await, "missing_sub");
}

#[test]
fn config_errors() {
    let j = jwks(&[&keys().ec_jwk]);
    // No audiences and no authorized parties: refuse.
    let cfg = OidcConfig {
        issuer: ISS.into(),
        ..Default::default()
    };
    assert!(matches!(
        OidcAuth::from_jwks(cfg, &j),
        Err(ConfigError::Invalid(_))
    ));
    assert!(OidcAuth::from_jwks(
        OidcConfig {
            issuer: String::new(),
            ..config()
        },
        &j
    )
    .is_err());
    assert!(OidcAuth::from_jwks(config(), r#"{"keys":[]}"#).is_err());
    // Unusable keys are skipped, usable ones kept.
    let mixed = json!({"keys": [{"kty": "oct", "k": "c2VjcmV0"}, keys().ec_jwk]}).to_string();
    assert!(OidcAuth::from_jwks(config(), &mixed).is_ok());
    let only_oct = json!({"keys": [{"kty": "oct", "k": "c2VjcmV0", "kid": "x"}]}).to_string();
    assert!(OidcAuth::from_jwks(config(), &only_oct).is_err());
}

// ---- discovery over a localhost server ----

struct Server {
    base: String,
    jwks: Arc<Mutex<String>>,
    jwks_hits: Arc<AtomicUsize>,
}

async fn serve(issuer_override: Option<String>) -> Server {
    use axum::{routing::get, Router};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let jwks_body = Arc::new(Mutex::new(jwks(&[&keys().ec_jwk])));
    let hits = Arc::new(AtomicUsize::new(0));
    let doc = json!({
        "issuer": issuer_override.unwrap_or_else(|| base.clone()),
        "jwks_uri": format!("{base}/jwks"),
    })
    .to_string();
    let (jb, h) = (jwks_body.clone(), hits.clone());
    let app = Router::new()
        .route(
            "/.well-known/openid-configuration",
            get(move || async move { doc }),
        )
        .route(
            "/jwks",
            get(move || {
                let (jb, h) = (jb.clone(), h.clone());
                async move {
                    h.fetch_add(1, Ordering::SeqCst);
                    let body = jb.lock().unwrap().clone();
                    body
                }
            }),
        );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        base,
        jwks: jwks_body,
        jwks_hits: hits,
    }
}

#[tokio::test]
async fn discovery_and_kid_rotation() {
    let s = serve(None).await;
    let cfg = OidcConfig {
        issuer: format!("{}/", s.base), // trailing slash is normalised
        audiences: vec!["whispera-api".into()],
        ..Default::default()
    };
    let a = OidcAuth::discover(cfg).await.unwrap();
    assert_eq!(a.issuer(), s.base);
    assert_eq!(s.jwks_hits.load(Ordering::SeqCst), 1);

    let c = with(claims(), "iss", json!(s.base));
    let id = a.authenticate(&es(&c)).await.unwrap();
    assert_eq!(id.issuer, s.base);
    assert_eq!(id.subject, "user_123");

    // Key rotation: server now also publishes ec2; unknown kid triggers one refetch.
    *s.jwks.lock().unwrap() = jwks(&[&keys().ec_jwk, &keys().ec2_jwk]);
    let t2 = sign(Algorithm::ES256, "ec2", &keys().ec2_enc, &c);
    assert!(a.authenticate(&t2).await.is_ok());
    assert_eq!(s.jwks_hits.load(Ordering::SeqCst), 2);

    // Another unknown kid within 30 s: no refetch (rate-limited).
    let t3 = sign(Algorithm::ES256, "ec3", &keys().ec2_enc, &c);
    assert_eq!(invalid(&a, &t3).await, "unknown_kid");
    assert_eq!(invalid(&a, &t3).await, "unknown_kid");
    assert_eq!(s.jwks_hits.load(Ordering::SeqCst), 2);

    // Via the config builder too.
    let auth = whispera_auth::build(
        serde_json::from_value(json!({
            "mode": "oidc", "issuer": s.base, "audiences": ["whispera-api"]
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(auth.authenticate(&t2).await.unwrap().subject, "user_123");
}

#[tokio::test]
async fn discovery_issuer_mismatch_rejected() {
    let s = serve(Some("https://someone-else.example.com".into())).await;
    let cfg = OidcConfig {
        issuer: s.base.clone(),
        audiences: vec!["x".into()],
        ..Default::default()
    };
    assert!(matches!(
        OidcAuth::discover(cfg).await,
        Err(ConfigError::Discovery(_))
    ));
}

#[tokio::test]
async fn explicit_jwks_uri_skips_discovery() {
    let s = serve(Some("https://ignored".into())).await;
    let cfg = OidcConfig {
        issuer: ISS.into(),
        audiences: vec!["whispera-api".into()],
        jwks_uri: Some(format!("{}/jwks", s.base)),
        ..Default::default()
    };
    let a = OidcAuth::discover(cfg).await.unwrap();
    assert_eq!(a.issuer(), ISS);
    assert!(a.authenticate(&es(&claims())).await.is_ok());
}

#[tokio::test]
async fn plain_http_non_loopback_rejected() {
    let cfg = OidcConfig {
        issuer: "http://idp.example.com".into(),
        audiences: vec!["x".into()],
        ..Default::default()
    };
    assert!(matches!(
        OidcAuth::discover(cfg).await,
        Err(ConfigError::Invalid(_))
    ));
}
