//! APNs client tests against a local axum mock (no network to Apple).

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::{EncodePrivateKey as _, LineEnding};
use whispera_apns::{
    ApnsClient, ApnsConfig, ApnsEnv, ApnsError, Clock, PushOutcome, SecretKey, PAYLOAD,
};

const KEY_ID: &str = "ABC123DEFG";
const TEAM_ID: &str = "TEAM456XYZ";
const TOPIC: &str = "app.whispera.ios";
const T0: i64 = 1_700_000_000;

#[derive(Debug, Clone)]
struct Captured {
    method: Method,
    path: String,
    headers: HeaderMap,
    body: Bytes,
}

#[derive(Clone)]
struct Mock {
    requests: Arc<Mutex<Vec<Captured>>>,
    response: Arc<Mutex<(u16, String)>>,
}

impl Mock {
    fn set_response(&self, status: u16, body: &str) {
        *self.response.lock().unwrap() = (status, body.to_string());
    }
    fn requests(&self) -> Vec<Captured> {
        self.requests.lock().unwrap().clone()
    }
}

async fn handler(
    State(mock): State<Mock>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, String) {
    mock.requests.lock().unwrap().push(Captured {
        method,
        path: uri.path().to_string(),
        headers,
        body,
    });
    let (status, body) = mock.response.lock().unwrap().clone();
    (StatusCode::from_u16(status).unwrap(), body)
}

async fn start_mock() -> (Mock, String) {
    let mock = Mock {
        requests: Arc::default(),
        response: Arc::new(Mutex::new((200, String::new()))),
    };
    let app = Router::new().fallback(handler).with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (mock, format!("http://{addr}"))
}

struct TestClock(AtomicI64);

impl Clock for TestClock {
    fn now_unix(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Fixture {
    mock: Mock,
    client: ApnsClient,
    clock: Arc<TestClock>,
    verifying_key: VerifyingKey,
    pem: String,
}

fn throwaway_key() -> (String, VerifyingKey) {
    let sk = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let pem = sk.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
    let vk = VerifyingKey::from(sk.public_key());
    (pem, vk)
}

fn config(pem: &str) -> ApnsConfig {
    ApnsConfig {
        key_p8: SecretKey::new(pem),
        key_id: KEY_ID.into(),
        team_id: TEAM_ID.into(),
        topic: TOPIC.into(),
    }
}

async fn fixture() -> Fixture {
    let (mock, base) = start_mock().await;
    let (pem, verifying_key) = throwaway_key();
    let clock = Arc::new(TestClock(AtomicI64::new(T0)));
    let client = ApnsClient::with_base_urls(
        config(&pem),
        &format!("{base}/prod/"),
        &format!("{base}/sandbox"),
    )
    .unwrap()
    .with_clock(clock.clone());
    Fixture {
        mock,
        client,
        clock,
        verifying_key,
        pem,
    }
}

fn device_token() -> String {
    "0123456789abcdef".repeat(4)
}

fn bearer(req: &Captured) -> String {
    req.headers["authorization"]
        .to_str()
        .unwrap()
        .strip_prefix("bearer ")
        .expect("bearer prefix")
        .to_string()
}

/// Verifies the JWS with the public key and returns (header, claims).
fn verify_jwt(jwt: &str, vk: &VerifyingKey) -> (serde_json::Value, serde_json::Value) {
    let parts: Vec<&str> = jwt.split('.').collect();
    assert_eq!(parts.len(), 3);
    let sig_bytes = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
    assert_eq!(sig_bytes.len(), 64, "JWS ES256 signature must be raw r||s");
    let sig = Signature::from_slice(&sig_bytes).unwrap();
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    vk.verify(signing_input.as_bytes(), &sig)
        .expect("signature verifies");
    let header = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
    let claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    (header, claims)
}

#[tokio::test]
async fn sends_correct_request() {
    let f = fixture().await;
    let tok = device_token();

    assert_eq!(
        f.client.notify(&tok, ApnsEnv::Production).await,
        PushOutcome::Sent
    );
    assert_eq!(
        f.client.notify(&tok, ApnsEnv::Sandbox).await,
        PushOutcome::Sent
    );

    let reqs = f.mock.requests();
    assert_eq!(reqs.len(), 2);
    let r = &reqs[0];
    assert_eq!(r.method, Method::POST);
    assert_eq!(r.path, format!("/prod/3/device/{tok}"));
    assert_eq!(reqs[1].path, format!("/sandbox/3/device/{tok}"));
    assert_eq!(r.headers["apns-topic"], TOPIC);
    assert_eq!(r.headers["apns-push-type"], "alert");
    assert_eq!(r.headers["apns-priority"], "10");
    assert_eq!(
        r.headers["apns-expiration"],
        (T0 + 3600).to_string().as_str()
    );
    assert_eq!(r.body.as_ref(), PAYLOAD.as_bytes());
    let payload: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({"aps":{"alert":{"title":"Whispera","body":"You have a new request"},"sound":"default"}})
    );

    let (header, claims) = verify_jwt(&bearer(r), &f.verifying_key);
    assert_eq!(header["alg"], "ES256");
    assert_eq!(header["kid"], KEY_ID);
    assert_eq!(claims["iss"], TEAM_ID);
    assert_eq!(claims["iat"], T0);
}

#[tokio::test]
async fn token_cached_then_reminted_after_50_minutes() {
    let f = fixture().await;
    let tok = device_token();

    f.client.notify(&tok, ApnsEnv::Production).await;
    f.clock.0.store(T0 + 49 * 60, Ordering::SeqCst);
    f.client.notify(&tok, ApnsEnv::Production).await;
    f.clock.0.store(T0 + 50 * 60 + 1, Ordering::SeqCst);
    f.client.notify(&tok, ApnsEnv::Production).await;

    let reqs = f.mock.requests();
    let jwts: Vec<String> = reqs.iter().map(bearer).collect();
    assert_eq!(jwts[0], jwts[1], "token reused within 50 minutes");
    assert_ne!(jwts[1], jwts[2], "token re-minted after 50 minutes");
    let (_, claims) = verify_jwt(&jwts[2], &f.verifying_key);
    assert_eq!(claims["iat"], T0 + 50 * 60 + 1);
}

#[tokio::test]
async fn gone_is_unregistered() {
    let f = fixture().await;
    f.mock
        .set_response(410, r#"{"reason":"Unregistered","timestamp":1}"#);
    assert_eq!(
        f.client.notify(&device_token(), ApnsEnv::Production).await,
        PushOutcome::Unregistered
    );
}

#[tokio::test]
async fn bad_device_token_is_unregistered() {
    let f = fixture().await;
    f.mock.set_response(400, r#"{"reason":"BadDeviceToken"}"#);
    assert_eq!(
        f.client.notify(&device_token(), ApnsEnv::Sandbox).await,
        PushOutcome::Unregistered
    );
    f.mock
        .set_response(400, r#"{"reason":"DeviceTokenNotForTopic"}"#);
    assert_eq!(
        f.client.notify(&device_token(), ApnsEnv::Sandbox).await,
        PushOutcome::Unregistered
    );
    f.mock.set_response(400, r#"{"reason":"BadTopic"}"#);
    assert_eq!(
        f.client.notify(&device_token(), ApnsEnv::Sandbox).await,
        PushOutcome::Failed("BadTopic".into())
    );
}

#[tokio::test]
async fn expired_provider_token_fails_and_reminted() {
    let f = fixture().await;
    let tok = device_token();
    f.mock
        .set_response(403, r#"{"reason":"ExpiredProviderToken"}"#);
    assert_eq!(
        f.client.notify(&tok, ApnsEnv::Production).await,
        PushOutcome::Failed("ExpiredProviderToken".into())
    );
    // Same clock second: ECDSA signing is deterministic (RFC 6979), so advance
    // one second to make the fresh token observably different.
    f.clock.0.store(T0 + 1, Ordering::SeqCst);
    f.mock.set_response(200, "");
    assert_eq!(
        f.client.notify(&tok, ApnsEnv::Production).await,
        PushOutcome::Sent
    );

    let jwts: Vec<String> = f.mock.requests().iter().map(bearer).collect();
    assert_ne!(jwts[0], jwts[1]);
    let (_, claims) = verify_jwt(&jwts[1], &f.verifying_key);
    assert_eq!(claims["iat"], T0 + 1);
}

#[tokio::test]
async fn server_error_is_failed() {
    let f = fixture().await;
    f.mock
        .set_response(500, r#"{"reason":"InternalServerError"}"#);
    assert_eq!(
        f.client.notify(&device_token(), ApnsEnv::Production).await,
        PushOutcome::Failed("InternalServerError".into())
    );
    f.mock.set_response(503, "not json");
    assert_eq!(
        f.client.notify(&device_token(), ApnsEnv::Production).await,
        PushOutcome::Failed("HTTP 503".into())
    );
}

#[tokio::test]
async fn invalid_token_fails_without_request() {
    let f = fixture().await;
    for bad in ["", "zz", &"g".repeat(64), &"a".repeat(63), &"a".repeat(201)] {
        assert_eq!(
            f.client.notify(bad, ApnsEnv::Production).await,
            PushOutcome::Failed("invalid token".into())
        );
    }
    assert!(f.mock.requests().is_empty());
}

#[tokio::test]
async fn debug_never_contains_key_material() {
    let f = fixture().await;
    let cfg = config(&f.pem);
    let body_line = f.pem.lines().nth(1).unwrap().to_string();
    for dbg in [
        format!("{cfg:?}"),
        format!("{cfg:#?}"),
        format!("{:?}", cfg.key_p8),
        format!("{:?}", f.client),
    ] {
        assert!(!dbg.contains(&body_line), "leaked key: {dbg}");
        assert!(!dbg.contains("PRIVATE KEY"), "leaked key: {dbg}");
    }
    assert_eq!(format!("{:?}", cfg.key_p8), "[redacted]");
}

#[test]
fn bad_key_fails_at_construction_without_leaking() {
    let secret = "-----BEGIN PRIVATE KEY-----\nTOPSECRETNOTAKEY\n-----END PRIVATE KEY-----\n";
    let err = ApnsClient::new(config(secret)).unwrap_err();
    assert!(matches!(err, ApnsError::InvalidKey));
    assert!(!err.to_string().contains("TOPSECRET"));
    assert!(!format!("{err:?}").contains("TOPSECRET"));
}

#[test]
fn production_client_builds() {
    let (pem, _) = throwaway_key();
    let client = ApnsClient::new(config(&pem)).unwrap();
    assert!(format!("{client:?}").contains("https://api.push.apple.com"));
}

fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    move |k| map.get(k).cloned()
}

#[test]
fn from_env_map_all_absent_is_none() {
    assert!(ApnsConfig::from_env_map(env_of(&[])).unwrap().is_none());
    assert!(ApnsConfig::from_env_map(env_of(&[("APNS_TOPIC", "")]))
        .unwrap()
        .is_none());
}

#[test]
fn from_env_map_partial_lists_missing_names() {
    let err = ApnsConfig::from_env_map(env_of(&[("APNS_KEY_ID", "SECRETID99")])).unwrap_err();
    let msg = err.to_string();
    match &err {
        ApnsError::MissingVars(m) => assert_eq!(
            m,
            &[
                "APNS_AUTH_KEY_P8 or APNS_AUTH_KEY_P8_FILE",
                "APNS_TEAM_ID",
                "APNS_TOPIC"
            ]
        ),
        other => panic!("unexpected {other:?}"),
    }
    assert!(msg.contains("APNS_TEAM_ID") && msg.contains("APNS_TOPIC"));
    assert!(!msg.contains("SECRETID99"));

    let (pem, _) = throwaway_key();
    let err = ApnsConfig::from_env_map(env_of(&[
        ("APNS_AUTH_KEY_P8", &pem),
        ("APNS_TEAM_ID", TEAM_ID),
        ("APNS_TOPIC", TOPIC),
    ]))
    .unwrap_err();
    assert!(matches!(&err, ApnsError::MissingVars(m) if m == &["APNS_KEY_ID"]));
    assert!(!err.to_string().contains("PRIVATE KEY"));
}

#[test]
fn from_env_map_inline_and_file() {
    let (pem, _) = throwaway_key();
    let cfg = ApnsConfig::from_env_map(env_of(&[
        ("APNS_AUTH_KEY_P8", &pem.replace('\n', "\\n")),
        ("APNS_KEY_ID", KEY_ID),
        ("APNS_TEAM_ID", TEAM_ID),
        ("APNS_TOPIC", TOPIC),
    ]))
    .unwrap()
    .unwrap();
    assert_eq!(cfg.key_p8.expose(), pem);
    assert_eq!(cfg.key_id, KEY_ID);
    ApnsClient::new(cfg).unwrap();

    let path = std::env::temp_dir().join(format!("whispera-apns-test-{}.p8", std::process::id()));
    std::fs::write(&path, &pem).unwrap();
    let path_str = path.to_str().unwrap().to_string();
    let cfg = ApnsConfig::from_env_map(env_of(&[
        ("APNS_AUTH_KEY_P8_FILE", &path_str),
        ("APNS_KEY_ID", KEY_ID),
        ("APNS_TEAM_ID", TEAM_ID),
        ("APNS_TOPIC", TOPIC),
    ]))
    .unwrap()
    .unwrap();
    assert_eq!(cfg.key_p8.expose(), pem);
    let cfg2 = ApnsConfig::from_key_file(&path, KEY_ID, TEAM_ID, TOPIC).unwrap();
    assert_eq!(cfg2.key_p8.expose(), pem);
    std::fs::remove_file(&path).unwrap();

    let err = ApnsConfig::from_key_file(&path, KEY_ID, TEAM_ID, TOPIC).unwrap_err();
    assert!(matches!(err, ApnsError::KeyFile { .. }));
}
