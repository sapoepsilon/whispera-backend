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
use whispera_apns::{PushKind, PushOutcome};
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
    kinds: Mutex<Vec<PushKind>>,
    outcome: Mutex<Option<PushOutcome>>,
}

#[async_trait::async_trait]
impl Pusher for FakePusher {
    async fn push(&self, token: &str, env: ApnsEnv, kind: &PushKind) -> PushOutcome {
        self.calls.lock().unwrap().push((token.into(), env));
        self.kinds.lock().unwrap().push(kind.clone());
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

/// `/v1/notify` with `kind`: approval (generic / named) and approval.resolved
/// reach the pusher as the matching typed kind; malformed bodies are 400.
#[tokio::test]
async fn notify_approval_kinds() {
    let app = app().await;
    let mac = register(&app, TOKEN, "Mac", json!({})).await;
    let phone = register(
        &app,
        TOKEN,
        "iPhone",
        json!({"platform": "ios", "apns": {"token": APNS_B, "env": "sandbox"}}),
    )
    .await;
    let id = "apr_0a1b2c3d4e5f";
    let sealed = "q83vASNFZ4kAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    for body in [
        json!({"device_id": phone.id, "kind": "approval", "request_id": id}),
        json!({"device_id": phone.id, "kind": "approval", "request_id": id, "sealed": sealed}),
        json!({"device_id": phone.id, "kind": "approval.resolved", "request_id": id}),
        json!({"device_id": phone.id}),
    ] {
        let (s, v) = call(&app, mac.req("POST", "/v1/notify", Some(body))).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(v["push"], "sent");
    }
    let rid = whispera_apns::RequestId::parse(id).unwrap();
    assert_eq!(
        app.pusher.kinds.lock().unwrap().as_slice(),
        &[
            PushKind::Approval {
                request_id: rid.clone(),
                sealed: None
            },
            PushKind::Approval {
                request_id: rid.clone(),
                sealed: Some(whispera_apns::SealedBlob::parse(sealed).unwrap()),
            },
            PushKind::Resolved { request_id: rid },
            PushKind::Legacy,
        ]
    );
    assert!(app
        .pusher
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|c| c == &(APNS_B.to_string(), ApnsEnv::Sandbox)));

    for (body, needle) in [
        (
            json!({"device_id": phone.id, "kind": "approval", "request_id": "apr_SHOUTING1"}),
            "request_id",
        ),
        (
            json!({"device_id": phone.id, "kind": "approval", "request_id": "apr_short"}),
            "request_id",
        ),
        (
            json!({"device_id": phone.id, "kind": "approval"}),
            "request_id",
        ),
        (
            json!({"device_id": phone.id, "kind": "approval.resolved", "request_id": id,
                   "sealed": sealed}),
            "sealed",
        ),
        (json!({"device_id": phone.id, "sealed": sealed}), "sealed"),
        (
            json!({"device_id": phone.id, "kind": "approval", "request_id": id,
                   "sealed": "A".repeat(2052)}),
            "sealed",
        ),
        (
            json!({"device_id": phone.id, "kind": "approval", "request_id": id,
                   "sealed": "not base64!"}),
            "sealed",
        ),
        (
            json!({"device_id": phone.id, "kind": "approval", "request_id": id,
                   "title": "free text"}),
            "unknown field",
        ),
        (
            json!({"device_id": phone.id, "kind": "nudge", "request_id": id}),
            "unknown variant",
        ),
    ] {
        let (s, v) = call(&app, mac.req("POST", "/v1/notify", Some(body.clone()))).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{body} -> {v}");
        assert_eq!(v["error"]["code"], "bad_request");
        let msg = v["error"]["message"].as_str().unwrap();
        assert!(msg.contains(needle), "{body} -> {msg}");
    }
    assert_eq!(app.pusher.kinds.lock().unwrap().len(), 4, "no push on 400");
}

fn ids(v: &Value) -> Vec<String> {
    let mut ids: Vec<String> = v["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["device_id"].as_str().unwrap().to_string())
        .collect();
    ids.sort();
    ids
}

fn sorted(ids: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
    v.sort();
    v
}

/// Account pairing isolation: two accounts, A with a Mac and an iPhone, B
/// with one device. Each account only ever sees its own devices; B can't
/// relay to, notify or revoke A's devices; revoking an A device keeps it in
/// A's lists as revoked and kills its WL1 access.
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
    let a2 = register(
        &app,
        TOKEN,
        "iPhone",
        json!({"platform": "ios", "apns": {"token": APNS_B, "env": "sandbox"}}),
    )
    .await;
    let x = register(&app, other, "Theirs", json!({})).await;

    // A's devices see each other, via the account list and WL1 peers.
    let want_a = sorted(&[&a.id, &a2.id]);
    let (_, v) = call(&app, bearer("GET", "/v1/devices", TOKEN, None)).await;
    assert_eq!(ids(&v), want_a);
    for d in [&a, &a2] {
        let (s, v) = call(&app, d.req("GET", "/v1/device/peers", None)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(ids(&v), want_a);
    }
    // B sees only its own device.
    let (_, v) = call(&app, bearer("GET", "/v1/devices", other, None)).await;
    assert_eq!(ids(&v), sorted(&[&x.id]));
    let (_, v) = call(&app, x.req("GET", "/v1/device/peers", None)).await;
    assert_eq!(ids(&v), sorted(&[&x.id]));

    // B can't relay to, notify or revoke A's devices.
    for target in [&a.id, &a2.id] {
        let (s, _) = call(
            &app,
            x.req(
                "POST",
                "/v1/relay/send",
                Some(json!({"to": target, "ciphertext": "AAEC"})),
            ),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _) = call(
            &app,
            x.req("POST", "/v1/notify", Some(json!({"device_id": target}))),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        let (s, _) = call(
            &app,
            bearer("DELETE", &format!("/v1/devices/{target}"), other, None),
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }
    // Not even with a well-formed approval kind.
    let (s, _) = call(
        &app,
        x.req(
            "POST",
            "/v1/notify",
            Some(json!({"device_id": a2.id, "kind": "approval", "request_id": "apr_0123abcd"})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert!(app.pusher.calls.lock().unwrap().is_empty(), "no push to A");
    assert!(app
        .store
        .mailbox_fetch(&a.id, 0, now(), 10)
        .await
        .unwrap()
        .is_empty());
    // And A can't reach B either.
    let (s, _) = call(
        &app,
        a.req(
            "POST",
            "/v1/relay/send",
            Some(json!({"to": x.id, "ciphertext": "AAEC"})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Revoke A's iPhone: it stays in A's peers marked revoked, and its WL1 calls fail.
    let (s, _) = call(
        &app,
        bearer("DELETE", &format!("/v1/devices/{}", a2.id), TOKEN, None),
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (_, v) = call(&app, a.req("GET", "/v1/device/peers", None)).await;
    assert_eq!(ids(&v), want_a);
    for d in v["devices"].as_array().unwrap() {
        let revoked = d["device_id"] == a2.id.as_str();
        assert_eq!(d["revoked_at"].is_i64(), revoked, "{d}");
        if revoked {
            assert_eq!(d["apns_token_suffix"], Value::Null);
        }
    }
    for req in [
        a2.req("GET", "/v1/device/peers", None),
        a2.req(
            "PUT",
            "/v1/device/apns",
            Some(json!({"apns": {"token": APNS_B, "env": "sandbox"}})),
        ),
    ] {
        let (s, v) = call(&app, req).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert_eq!(v["error"]["code"], "auth_revoked");
    }
    // B's view is unchanged.
    let (_, v) = call(&app, x.req("GET", "/v1/device/peers", None)).await;
    assert_eq!(ids(&v), sorted(&[&x.id]));
}

/// `PUT /v1/device/apns`: a device sets, replaces and clears its own APNs token.
#[tokio::test]
async fn device_updates_its_apns_registration() {
    let app = app().await;
    let mac = register(&app, TOKEN, "Mac", json!({})).await;
    let phone = register(&app, TOKEN, "iPhone", json!({"platform": "ios"})).await;
    let upper = APNS_B.to_ascii_uppercase();

    // Set (uppercase hex is normalised to lowercase).
    let (s, v) = call(
        &app,
        phone.req(
            "PUT",
            "/v1/device/apns",
            Some(json!({"apns": {"token": upper, "env": "production"}})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["device_id"], phone.id.as_str());
    assert_eq!(v["platform"], "ios");
    assert_eq!(v["apns_token_suffix"], &APNS_B[APNS_B.len() - 8..]);
    assert_eq!(v["apns_env"], "production");
    assert!(!v.to_string().to_ascii_lowercase().contains(APNS_B));
    let stored = app.store.get_device(&phone.id).await.unwrap().unwrap();
    assert_eq!(stored.apns_token.as_deref(), Some(APNS_B));
    // Peers see the suffix; notify now pushes to the new token.
    let (_, v) = call(
        &app,
        mac.req("POST", "/v1/notify", Some(json!({"device_id": phone.id}))),
    )
    .await;
    assert_eq!(v["push"], "sent");
    assert_eq!(
        app.pusher.calls.lock().unwrap().as_slice(),
        &[(APNS_B.to_string(), ApnsEnv::Production)]
    );

    // Clear.
    let (s, v) = call(
        &app,
        phone.req("PUT", "/v1/device/apns", Some(json!({"apns": null}))),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["apns_token_suffix"], Value::Null);
    assert_eq!(v["apns_env"], Value::Null);
    let (_, v) = call(
        &app,
        mac.req("POST", "/v1/notify", Some(json!({"device_id": phone.id}))),
    )
    .await;
    assert_eq!(v["push"], "no_token");

    // Only the caller's own record changes.
    let (s, v) = call(
        &app,
        mac.req(
            "PUT",
            "/v1/device/apns",
            Some(json!({"apns": {"token": APNS_B, "env": "sandbox"}})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["device_id"], mac.id.as_str());
    assert!(app
        .store
        .get_device(&phone.id)
        .await
        .unwrap()
        .unwrap()
        .apns_token
        .is_none());
}

#[tokio::test]
async fn apns_update_validation_and_auth() {
    let app = app().await;
    let phone = register(
        &app,
        TOKEN,
        "iPhone",
        json!({"apns": {"token": APNS_B, "env": "sandbox"}}),
    )
    .await;
    let short = "ab".repeat(31);
    let long = "ab".repeat(101);
    for body in [
        json!({"apns": {"token": "nothex", "env": "sandbox"}}),
        json!({"apns": {"token": short, "env": "sandbox"}}),
        json!({"apns": {"token": long, "env": "sandbox"}}),
        json!({"apns": {"token": APNS_B, "env": "staging"}}),
        json!({"apns": {"token": APNS_B}}),
        json!({}),
    ] {
        let (s, v) = call(&app, phone.req("PUT", "/v1/device/apns", Some(body))).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
        assert_eq!(v["error"]["type"], "invalid_request_error");
    }
    // Rejected bodies left the token alone.
    let stored = app.store.get_device(&phone.id).await.unwrap().unwrap();
    assert_eq!(stored.apns_token.as_deref(), Some(APNS_B));

    // Unsigned, account-bearer-only and tampered requests are refused.
    let body = json!({"apns": null});
    let unsigned = Request::put("/v1/device/apns")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let (s, v) = call(&app, unsigned).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "auth_missing");
    let (s, v) = call(&app, bearer("PUT", "/v1/device/apns", TOKEN, Some(body))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "auth_missing");
    let signed = phone.req("PUT", "/v1/device/apns", Some(json!({"apns": null})));
    let (parts, _) = signed.into_parts();
    let tampered = Request::from_parts(
        parts,
        Body::from(json!({"apns": {"token": APNS_B, "env": "production"}}).to_string()),
    );
    let (s, v) = call(&app, tampered).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "auth_bad_signature");

    // A revoked device can't set a token.
    let (s, _) = call(
        &app,
        bearer("DELETE", &format!("/v1/devices/{}", phone.id), TOKEN, None),
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, v) = call(
        &app,
        phone.req(
            "PUT",
            "/v1/device/apns",
            Some(json!({"apns": {"token": APNS_B, "env": "sandbox"}})),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "auth_revoked");
    assert!(app
        .store
        .get_device(&phone.id)
        .await
        .unwrap()
        .unwrap()
        .apns_token
        .is_none());
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

/// The server in OIDC mode against `whispera-dev-idp` over loopback HTTP,
/// configured the way the binary is (env → `Config` → discovery + JWKS).
#[tokio::test]
async fn oidc_mode_with_dev_idp_over_loopback() {
    use whispera_dev_idp::{pkce_challenge, spawn, DevIdp, IdpConfig, IdpKey};

    let loopback = "127.0.0.1:0".parse().unwrap();
    let (idp, _h1) = spawn(loopback, IdpConfig::new(""), IdpKey::generate())
        .await
        .unwrap();
    let (other_idp, _h2) = spawn(loopback, IdpConfig::new(""), IdpKey::generate())
        .await
        .unwrap();
    let issuer = idp.config().issuer.clone();
    assert!(issuer.starts_with("http://127.0.0.1:"));

    let cfg = whispera_server::Config::load(|k| match k {
        "WHISPERA_OIDC_ISSUER" => Some(issuer.clone()),
        "WHISPERA_OIDC_AUDIENCES" => Some("whispera".into()),
        _ => None,
    })
    .unwrap();
    let auth = whispera_auth::build_from_config(cfg.auth.as_ref().unwrap())
        .await
        .unwrap();
    assert_eq!(auth.kind(), "oidc");
    let app = app_with(auth, Settings::default()).await;

    // alice signs in through the real authorize + token endpoints (PKCE).
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let verifier = "a".repeat(20) + &"Z".repeat(23) + "-._~";
    let mut authorize = url::Url::parse(&format!("{issuer}/authorize")).unwrap();
    authorize
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", "whispera")
        .append_pair("redirect_uri", "whispera-mac://auth/callback")
        .append_pair("state", "s1")
        .append_pair("code_challenge", &pkce_challenge(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("scope", "openid offline_access")
        .append_pair("login_hint", "alice");
    let resp = http.get(authorize).send().await.unwrap();
    assert_eq!(resp.status(), 302);
    let loc = url::Url::parse(resp.headers()["location"].to_str().unwrap()).unwrap();
    assert_eq!(loc.scheme(), "whispera-mac");
    let code = loc
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .into_owned();
    let tokens: Value = http
        .post(format!("{issuer}/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", "whispera-mac://auth/callback"),
            ("client_id", "whispera"),
            ("code_verifier", &verifier),
        ])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let alice_id = tokens["id_token"].as_str().unwrap().to_string();
    let alice_at = tokens["access_token"].as_str().unwrap().to_string();

    // Both of alice's tokens are accepted and name the same account.
    let mac = register(&app, &alice_id, "Mac", json!({})).await;
    register(&app, &alice_at, "iPhone", json!({"platform": "ios"})).await;
    let (s, v) = call(&app, bearer("GET", "/v1/devices", &alice_at, None)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["devices"].as_array().unwrap().len(), 2);

    // bob (minted, as `whispera-dev-idp mint bob` does) is a different account.
    let bob = idp.mint_access_token("bob", "openid");
    let (s, v) = call(&app, bearer("GET", "/v1/devices", &bob, None)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["devices"], json!([]));
    let bob_dev = register(&app, &bob, "Bob's Mac", json!({})).await;
    let (_, v) = call(&app, bob_dev.req("GET", "/v1/device/peers", None)).await;
    assert_eq!(ids(&v), sorted(&[&bob_dev.id]));
    let (_, v) = call(&app, mac.req("GET", "/v1/device/peers", None)).await;
    assert_eq!(v["devices"].as_array().unwrap().len(), 2);
    let accounts: Vec<String> = account_ids(&app, &[&mac.id, &bob_dev.id]).await;
    assert_ne!(
        accounts[0], accounts[1],
        "alice and bob are different accounts"
    );

    // Tokens from a second dev-idp instance are refused: its own issuer...
    for t in [
        other_idp.mint_access_token("alice", "openid"),
        other_idp.mint_id_token("alice", None),
    ] {
        let (s, v) = call(&app, bearer("GET", "/v1/devices", &t, None)).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert_eq!(v["error"]["code"], "auth_account_invalid");
    }
    // ...and an impostor claiming the first issuer but holding a different key.
    let impostor = DevIdp::new(IdpConfig::new(issuer.clone()), IdpKey::generate());
    let (s, v) = call(
        &app,
        bearer(
            "GET",
            "/v1/devices",
            &impostor.mint_access_token("alice", "openid"),
            None,
        ),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "auth_account_invalid");
    // A token for another client id of the same provider is refused too.
    let mut cfg = IdpConfig::new(issuer.clone());
    cfg.client_id = "some-other-app".into();
    let other_client = DevIdp::new(cfg, idp.key().clone());
    let (s, _) = call(
        &app,
        bearer(
            "GET",
            "/v1/devices",
            &other_client.mint_access_token("alice", "openid"),
            None,
        ),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

/// Account ids owning the given devices.
async fn account_ids(app: &App, devices: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for d in devices {
        out.push(app.store.get_device(d).await.unwrap().unwrap().account_id);
    }
    out
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
