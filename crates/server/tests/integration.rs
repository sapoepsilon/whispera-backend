//! End-to-end tests against the real router on a temp SQLite database.
//! No network: requests go through `tower::ServiceExt::oneshot`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use whispera_apns::PushOutcome;
use whispera_auth::{
    hash_token, AccountAuth, OidcAuth, OidcConfig, StaticTokenAuth, StaticTokenEntry,
};
use whispera_proto::keys::SigningKey;
use whispera_proto::sign::{new_nonce, SignedHeaders};
use whispera_proto::wire::ApnsEnv;
use whispera_server::{now, router, AppState, Pusher, Settings};
use whispera_store::Store;

const TOKEN: &str = "wst_test-token-for-integration";
const APNS_B: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

#[derive(Default)]
struct FakePusher {
    calls: Mutex<Vec<(String, ApnsEnv)>>,
    outcome: Mutex<Option<PushOutcome>>,
}

#[async_trait::async_trait]
impl Pusher for FakePusher {
    async fn push(&self, token: &str, env: ApnsEnv) -> PushOutcome {
        self.calls.lock().unwrap().push((token.into(), env));
        self.outcome
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(PushOutcome::Sent)
    }
}

struct App {
    _dir: tempfile::TempDir,
    router: Router,
    store: Store,
    pusher: Arc<FakePusher>,
}

async fn app_with(auth: Arc<dyn AccountAuth>, settings: Settings) -> App {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::connect(&format!("sqlite://{}", dir.path().join("s.db").display()))
        .await
        .unwrap();
    let pusher = Arc::new(FakePusher::default());
    let state = AppState::new(
        store.clone(),
        auth,
        Some(pusher.clone() as Arc<dyn Pusher>),
        settings,
    );
    App {
        _dir: dir,
        router: router(state),
        store,
        pusher,
    }
}

async fn app() -> App {
    let auth = StaticTokenAuth::new(vec![StaticTokenEntry {
        account: "me".into(),
        token_sha256: hash_token(TOKEN),
    }])
    .unwrap();
    app_with(Arc::new(auth), Settings::default()).await
}

async fn call(app: &App, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app.router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, v)
}

fn bearer(method: &str, path: &str, token: &str, body: Option<Value>) -> Request<Body> {
    let b = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"));
    match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    }
}

struct Dev {
    id: String,
    key: SigningKey,
}

impl Dev {
    fn req(&self, method: &str, target: &str, body: Option<Value>) -> Request<Body> {
        let bytes = body.map(|v| v.to_string().into_bytes()).unwrap_or_default();
        let h = SignedHeaders::sign(
            &self.key,
            &self.id,
            method,
            target,
            &bytes,
            now(),
            &new_nonce(),
        );
        let mut b = Request::builder().method(method).uri(target);
        for (k, v) in h.header_pairs() {
            b = b.header(k, v);
        }
        b.header("content-type", "application/json")
            .body(Body::from(bytes))
            .unwrap()
    }
}

async fn register(app: &App, token: &str, name: &str, extra: Value) -> Dev {
    let key = SigningKey::generate();
    let mut body = json!({
        "name": name,
        "platform": "macos",
        "link_pubkey": key.public_key().to_x963_b64(),
    });
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    let (s, v) = call(app, bearer("POST", "/v1/devices", token, Some(body))).await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    assert_eq!(v["link_fp"], key.public_key().fingerprint());
    Dev {
        id: v["device_id"].as_str().unwrap().into(),
        key,
    }
}

#[tokio::test]
async fn health_is_public() {
    let app = app().await;
    let (s, v) = call(
        &app,
        Request::get("/v1/health").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["ok"], true);
    assert_eq!(v["protocol"], 1);
    assert_eq!(v["apns"], "configured");
}

#[tokio::test]
async fn default_closed_account_auth() {
    let app = app().await;
    let (s, v) = call(
        &app,
        Request::get("/v1/devices").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "auth_account_missing");
    let (s, v) = call(&app, bearer("GET", "/v1/devices", "wst_wrong", None)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "auth_account_invalid");
    // Unsigned device call.
    let (s, v) = call(
        &app,
        Request::get("/v1/relay/messages")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "auth_missing");
    let (s, _) = call(&app, Request::get("/nope").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

/// The acceptance scenario: register two devices, relay a sealed blob A→B,
/// B fetches and acks, revoke A → A's signed calls are rejected with 401.
#[tokio::test]
async fn two_devices_relay_ack_revoke() {
    let app = app().await;
    let a = register(&app, TOKEN, "Mac", json!({})).await;
    let b = register(
        &app,
        TOKEN,
        "iPhone",
        json!({
            "platform": "ios",
            "approve_pubkey": SigningKey::generate().public_key().to_x963_b64(),
            "kem_pubkey": "S0VNLXB1YmxpYy1rZXk=",
            "apns": {"token": APNS_B, "env": "sandbox"},
        }),
    )
    .await;

    // Both devices see each other (account list and device-signed peers).
    let (s, v) = call(&app, bearer("GET", "/v1/devices", TOKEN, None)).await;
    assert_eq!(s, StatusCode::OK);
    let mut ids: Vec<&str> = v["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["device_id"].as_str().unwrap())
        .collect();
    ids.sort();
    let mut want = [a.id.as_str(), b.id.as_str()];
    want.sort();
    assert_eq!(ids, want);
    let phone = v["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["device_id"] == b.id.as_str())
        .unwrap();
    assert_eq!(phone["apns_token_suffix"], &APNS_B[APNS_B.len() - 8..]);
    assert_eq!(phone["kem_pubkey"], "S0VNLXB1YmxpYy1rZXk=");
    assert!(
        !v.to_string().contains(APNS_B),
        "full APNs token never listed"
    );
    let (s, v) = call(&app, b.req("GET", "/v1/device/peers", None)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["devices"].as_array().unwrap().len(), 2);

    // A → B sealed blob.
    let sealed = b"\x00\x01opaque-sealed-envelope\xff";
    let sealed_b64 = base64_encode(sealed);
    let (s, v) = call(
        &app,
        a.req(
            "POST",
            "/v1/relay/send",
            Some(json!({"to": b.id, "ciphertext": sealed_b64})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    let seq = v["seq"].as_i64().unwrap();

    // Only the opaque bytes are stored.
    let stored = app.store.mailbox_fetch(&b.id, 0, now(), 10).await.unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].ciphertext, sealed);
    assert_eq!(stored[0].sender_device, a.id);

    // B fetches and acks.
    let (s, v) = call(&app, b.req("GET", "/v1/relay/messages?after=0", None)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["messages"][0]["seq"], seq);
    assert_eq!(v["messages"][0]["from"], a.id);
    assert_eq!(v["messages"][0]["ciphertext"], sealed_b64);
    let (s, v) = call(
        &app,
        b.req("POST", "/v1/relay/ack", Some(json!({"up_to_seq": seq}))),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["deleted"], 1);
    let (_, v) = call(&app, b.req("GET", "/v1/relay/messages", None)).await;
    assert_eq!(v["messages"], json!([]));

    // A replayed request is rejected.
    let req = b.req("GET", "/v1/relay/messages", None);
    let (k, sig) = (req.headers().clone(), req.headers()["x-wl-nonce"].clone());
    let _ = call(&app, req).await;
    let mut again = Request::get("/v1/relay/messages")
        .body(Body::empty())
        .unwrap();
    *again.headers_mut() = k;
    assert_eq!(again.headers()["x-wl-nonce"], sig);
    let (s, v) = call(&app, again).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "auth_replay");

    // Tampered target → bad signature.
    let mut req = a.req("GET", "/v1/relay/messages?after=0", None);
    *req.uri_mut() = "/v1/relay/messages?after=1".parse().unwrap();
    let (s, v) = call(&app, req).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "auth_bad_signature");

    // Revoke A → A's signed calls fail with 401, and B can't send to A.
    let (s, _) = call(
        &app,
        bearer("DELETE", &format!("/v1/devices/{}", a.id), TOKEN, None),
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    for req in [
        a.req("GET", "/v1/relay/messages", None),
        a.req(
            "POST",
            "/v1/relay/send",
            Some(json!({"to": b.id, "ciphertext": "AAEC"})),
        ),
        a.req("POST", "/v1/notify", Some(json!({"device_id": b.id}))),
        a.req("GET", "/v1/device/peers", None),
    ] {
        let (s, v) = call(&app, req).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert_eq!(v["error"]["code"], "auth_revoked");
    }
    let (s, _) = call(
        &app,
        b.req(
            "POST",
            "/v1/relay/send",
            Some(json!({"to": a.id, "ciphertext": "AAEC"})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // Revoking again is a 404.
    let (s, _) = call(
        &app,
        bearer("DELETE", &format!("/v1/devices/{}", a.id), TOKEN, None),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn registration_validation() {
    let app = app().await;
    let good = SigningKey::generate().public_key().to_x963_b64();
    for body in [
        json!({"name": "", "platform": "ios", "link_pubkey": good}),
        json!({"name": "x", "platform": "windows", "link_pubkey": good}),
        json!({"name": "x", "platform": "ios", "link_pubkey": "AAAA"}),
        json!({"name": "x", "platform": "ios", "link_pubkey": good, "approve_pubkey": "zz"}),
        json!({"name": "x", "platform": "ios", "link_pubkey": good, "kem_pubkey": "!!"}),
        json!({"name": "x", "platform": "ios", "link_pubkey": good,
               "apns": {"token": "nothex", "env": "sandbox"}}),
    ] {
        let (s, v) = call(&app, bearer("POST", "/v1/devices", TOKEN, Some(body))).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
        assert_eq!(v["error"]["type"], "invalid_request_error");
    }
}

#[tokio::test]
async fn notify_is_content_free_and_cleans_dead_tokens() {
    let app = app().await;
    let a = register(&app, TOKEN, "Mac", json!({})).await;
    let b = register(
        &app,
        TOKEN,
        "iPhone",
        json!({"apns": {"token": APNS_B, "env": "production"}}),
    )
    .await;
    let (s, v) = call(
        &app,
        a.req("POST", "/v1/notify", Some(json!({"device_id": b.id}))),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["push"], "sent");
    assert_eq!(
        app.pusher.calls.lock().unwrap().as_slice(),
        &[(APNS_B.to_string(), ApnsEnv::Production)]
    );
    // A has no token.
    let (_, v) = call(
        &app,
        b.req("POST", "/v1/notify", Some(json!({"device_id": a.id}))),
    )
    .await;
    assert_eq!(v["push"], "no_token");
    // APNs says the token is dead → it is cleared.
    *app.pusher.outcome.lock().unwrap() = Some(PushOutcome::Unregistered);
    let (_, v) = call(
        &app,
        a.req("POST", "/v1/notify", Some(json!({"device_id": b.id}))),
    )
    .await;
    assert_eq!(v["push"], "no_token");
    assert!(app
        .store
        .get_device(&b.id)
        .await
        .unwrap()
        .unwrap()
        .apns_token
        .is_none());
    // Unknown target.
    let (s, _) = call(
        &app,
        a.req(
            "POST",
            "/v1/notify",
            Some(json!({"device_id": "dev_aaaaaaaaaaaaaaaaaaaaaaaa"})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn other_account_is_isolated() {
    let other = "wst_other-account-token";
    let auth = StaticTokenAuth::new(vec![
        StaticTokenEntry {
            account: "me".into(),
            token_sha256: hash_token(TOKEN),
        },
        StaticTokenEntry {
            account: "them".into(),
            token_sha256: hash_token(other),
        },
    ])
    .unwrap();
    let app = app_with(Arc::new(auth), Settings::default()).await;
    let a = register(&app, TOKEN, "Mac", json!({})).await;
    let x = register(&app, other, "Theirs", json!({})).await;
    let (_, v) = call(&app, bearer("GET", "/v1/devices", other, None)).await;
    assert_eq!(v["devices"].as_array().unwrap().len(), 1);
    let (s, _) = call(
        &app,
        x.req(
            "POST",
            "/v1/relay/send",
            Some(json!({"to": a.id, "ciphertext": "AAEC"})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = call(
        &app,
        bearer("DELETE", &format!("/v1/devices/{}", a.id), other, None),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn long_poll_wakes_on_send() {
    let app = app().await;
    let a = register(&app, TOKEN, "Mac", json!({})).await;
    let b = register(&app, TOKEN, "iPhone", json!({})).await;
    let poll = app
        .router
        .clone()
        .oneshot(b.req("GET", "/v1/relay/messages?wait=10", None));
    let send = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        call(
            &app,
            a.req(
                "POST",
                "/v1/relay/send",
                Some(json!({"to": b.id, "ciphertext": "AAEC"})),
            ),
        )
        .await
    };
    let started = std::time::Instant::now();
    let (resp, (s, _)) = tokio::join!(poll, send);
    assert_eq!(s, StatusCode::CREATED);
    let body = resp
        .unwrap()
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["messages"][0]["ciphertext"], "AAEC");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn sse_stream_delivers_and_ends_on_revoke() {
    let app = app().await;
    let a = register(&app, TOKEN, "Mac", json!({})).await;
    let b = register(&app, TOKEN, "iPhone", json!({})).await;
    let (s, _) = call(
        &app,
        a.req(
            "POST",
            "/v1/relay/send",
            Some(json!({"to": b.id, "ciphertext": "AQID"})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    let resp = app
        .router
        .clone()
        .oneshot(b.req("GET", "/v1/relay/stream", None))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers()["content-type"], "text/event-stream");
    let mut body = resp.into_body();
    let mut text = String::new();
    // Queued message first.
    while !text.contains("AQID") {
        let f = next(&mut body).await.unwrap().unwrap();
        text.push_str(std::str::from_utf8(&f).unwrap());
    }
    assert!(text.contains("event: message"));
    // A live one.
    call(
        &app,
        a.req(
            "POST",
            "/v1/relay/send",
            Some(json!({"to": b.id, "ciphertext": "BAUG"})),
        ),
    )
    .await;
    while !text.contains("BAUG") {
        let f = next(&mut body).await.unwrap().unwrap();
        text.push_str(std::str::from_utf8(&f).unwrap());
    }
    // Revoking B ends its stream.
    call(
        &app,
        bearer("DELETE", &format!("/v1/devices/{}", b.id), TOKEN, None),
    )
    .await;
    assert!(next(&mut body).await.is_none(), "stream ended");
}

#[tokio::test]
async fn rate_limit_returns_429() {
    let auth = StaticTokenAuth::new(vec![StaticTokenEntry {
        account: "me".into(),
        token_sha256: hash_token(TOKEN),
    }])
    .unwrap();
    let app = app_with(
        Arc::new(auth),
        Settings {
            rate_per_second: 0.01,
            rate_burst: 2,
            ..Settings::default()
        },
    )
    .await;
    let health = || Request::get("/v1/health").body(Body::empty()).unwrap();
    assert_eq!(call(&app, health()).await.0, StatusCode::OK);
    assert_eq!(call(&app, health()).await.0, StatusCode::OK);
    let (s, v) = call(&app, health()).await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(v["error"]["code"], "rate_limited");
}

/// OIDC with a locally generated ES256 key and JWKS: no network.
#[tokio::test]
async fn oidc_account_auth_with_local_jwks() {
    use jsonwebtoken::{Algorithm, EncodingKey, Header};
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use p256::pkcs8::EncodePrivateKey;

    let iss = "https://auth.example.test";
    let sk = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let pt = sk.public_key().to_encoded_point(false);
    let b64u = |b: &[u8]| {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
    };
    let jwks = json!({"keys": [{
        "kty": "EC", "crv": "P-256", "kid": "k1", "use": "sig", "alg": "ES256",
        "x": b64u(pt.x().unwrap()), "y": b64u(pt.y().unwrap()),
    }]});
    let auth = OidcAuth::from_jwks(
        OidcConfig {
            issuer: iss.into(),
            audiences: vec!["whispera".into()],
            ..Default::default()
        },
        &jwks.to_string(),
    )
    .unwrap();
    let app = app_with(Arc::new(auth), Settings::default()).await;
    let enc = EncodingKey::from_ec_der(sk.to_pkcs8_der().unwrap().as_bytes());
    let mint = |sub: &str, aud: &str| {
        let mut h = Header::new(Algorithm::ES256);
        h.kid = Some("k1".into());
        jsonwebtoken::encode(
            &h,
            &json!({"iss": iss, "sub": sub, "aud": aud, "iat": now(), "exp": now() + 300}),
            &enc,
        )
        .unwrap()
    };
    let alice = mint("user_alice", "whispera");
    let a = register(&app, &alice, "Mac", json!({})).await;
    register(&app, &alice, "iPhone", json!({})).await;
    let (s, v) = call(&app, bearer("GET", "/v1/devices", &alice, None)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["devices"].as_array().unwrap().len(), 2);
    // Another subject sees nothing.
    let (_, v) = call(
        &app,
        bearer("GET", "/v1/devices", &mint("user_bob", "whispera"), None),
    )
    .await;
    assert_eq!(v["devices"], json!([]));
    // Wrong audience is rejected.
    let (s, v) = call(
        &app,
        bearer("GET", "/v1/devices", &mint("user_alice", "other-app"), None),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "auth_account_invalid");
    // The registered device then works with WL1 alone.
    let (s, _) = call(&app, a.req("GET", "/v1/device/peers", None)).await;
    assert_eq!(s, StatusCode::OK);
}

async fn next(body: &mut Body) -> Option<Result<axum::body::Bytes, axum::Error>> {
    tokio::time::timeout(Duration::from_secs(5), body.frame())
        .await
        .expect("frame in time")
        .map(|r| r.map(|f| f.into_data().unwrap_or_default()))
}

fn base64_encode(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}
