//! End to end: the real `whispera-server` binary, configured with
//! `[apns] sandbox_url` / `production_url` pointing at `whispera-apns-mock`,
//! signs real ES256 provider tokens with a throwaway P-256 key generated here
//! (never committed) and delivers legacy, approval (generic and named) and
//! approval.resolved pushes. The mock verifies every JWT and records JSONL.

use std::process::{Child, Command, Stdio};
use std::time::Duration;

use p256::pkcs8::{EncodePrivateKey as _, LineEnding};
use serde_json::{json, Value};
use whispera_proto::keys::SigningKey;
use whispera_proto::sign::{new_nonce, SignedHeaders};
use whispera_server::now;

const TOKEN: &str = "wst_e2e-apns-mock-token";
const KEY_ID: &str = "E2EKEY0001";
const TEAM_ID: &str = "E2ETEAM001";
const TOPIC: &str = "com.example.whispera";
const PHONE_TOKEN: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PROD_TOKEN: &str = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";
const DEAD_TOKEN: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbdeadbeef";
const REQ_ID: &str = "apr_e2e0a1b2c3d4";
const SEALED: &str = "q83vASNFZ4kAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Dev {
    id: String,
    key: SigningKey,
}

struct Ctx {
    http: reqwest::Client,
    base: String,
}

impl Ctx {
    async fn register(&self, name: &str, platform: &str, apns: Value) -> Dev {
        let key = SigningKey::generate();
        let mut body = json!({
            "name": name, "platform": platform,
            "link_pubkey": key.public_key().to_x963_b64(),
        });
        if !apns.is_null() {
            body["apns"] = apns;
        }
        let r = self
            .http
            .post(format!("{}/v1/devices", self.base))
            .bearer_auth(TOKEN)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 201);
        let v: Value = r.json().await.unwrap();
        Dev {
            id: v["device_id"].as_str().unwrap().into(),
            key,
        }
    }

    async fn notify(&self, from: &Dev, body: Value) -> (u16, Value) {
        let bytes = body.to_string().into_bytes();
        let h = SignedHeaders::sign(
            &from.key,
            &from.id,
            "POST",
            "/v1/notify",
            &bytes,
            now(),
            &new_nonce(),
        );
        let mut req = self
            .http
            .post(format!("{}/v1/notify", self.base))
            .header("content-type", "application/json");
        for (k, v) in h.header_pairs() {
            req = req.header(k, v);
        }
        let r = req.body(bytes).send().await.unwrap();
        (r.status().as_u16(), r.json().await.unwrap())
    }
}

fn read_jsonl(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[tokio::test]
async fn server_binary_pushes_through_apns_mock() {
    let dir = tempfile::tempdir().unwrap();

    // Throwaway APNs-style key: PKCS#8 PEM for the server, public key for the mock.
    let sk = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let pem = sk.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
    let key_path = dir.path().join("AuthKey_E2E.p8");
    std::fs::write(&key_path, &pem).unwrap();

    // The mock (same code as the whispera-apns-mock binary).
    let log = dir.path().join("pushes.jsonl");
    let mock_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_addr = mock_listener.local_addr().unwrap();
    let mut opts = whispera_apns_mock::Options::new(&log);
    opts.public_key = Some(p256::ecdsa::VerifyingKey::from(sk.public_key()));
    opts.unregistered = vec!["deadbeef".into()];
    tokio::spawn(whispera_apns_mock::serve(mock_listener, opts));

    // A free port for the server.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let config = dir.path().join("whispera.toml");
    std::fs::write(
        &config,
        format!(
            r#"
listen = "127.0.0.1:{port}"
database_url = "sqlite://{db}"
[auth]
mode = "static"
tokens = [{{ account = "me", token_sha256 = "{hash}" }}]
[apns]
key_path = "{key}"
key_id = "{KEY_ID}"
team_id = "{TEAM_ID}"
topic = "{TOPIC}"
sandbox_url = "http://{mock_addr}/sandbox"
production_url = "http://{mock_addr}/production"
"#,
            db = dir.path().join("s.db").display(),
            hash = whispera_auth::hash_token(TOKEN),
            key = key_path.display(),
        ),
    )
    .unwrap();

    let server_log = dir.path().join("server.log");
    let log_file = std::fs::File::create(&server_log).unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_whispera-server"));
    for (k, _) in std::env::vars() {
        if k.starts_with("APNS_") || k.starts_with("WHISPERA_") {
            cmd.env_remove(k);
        }
    }
    let server = Server(
        cmd.env("WHISPERA_CONFIG", &config)
            .env("RUST_LOG", "info")
            .env("NO_COLOR", "1")
            .stdout(Stdio::from(log_file.try_clone().unwrap()))
            .stderr(Stdio::from(log_file))
            .spawn()
            .unwrap(),
    );

    let ctx = Ctx {
        http: reqwest::Client::new(),
        base: format!("http://127.0.0.1:{port}"),
    };
    let mut health = Value::Null;
    for _ in 0..200 {
        if let Ok(r) = ctx.http.get(format!("{}/v1/health", ctx.base)).send().await {
            health = r.json().await.unwrap();
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        health["apns"],
        "configured",
        "server did not start: {}",
        std::fs::read_to_string(&server_log).unwrap_or_default()
    );

    let mac = ctx.register("Mac", "macos", Value::Null).await;
    let phone = ctx
        .register(
            "iPhone",
            "ios",
            json!({"token": PHONE_TOKEN, "env": "sandbox"}),
        )
        .await;
    let prod = ctx
        .register(
            "iPad",
            "ios",
            json!({"token": PROD_TOKEN, "env": "production"}),
        )
        .await;
    let dead = ctx
        .register("Old", "ios", json!({"token": DEAD_TOKEN, "env": "sandbox"}))
        .await;

    let calls = [
        (&phone, json!({"device_id": phone.id}), "sent"),
        (
            &phone,
            json!({"device_id": phone.id, "kind": "approval", "request_id": REQ_ID}),
            "sent",
        ),
        (
            &phone,
            json!({"device_id": phone.id, "kind": "approval", "request_id": REQ_ID,
                   "sealed": SEALED}),
            "sent",
        ),
        (
            &phone,
            json!({"device_id": phone.id, "kind": "approval.resolved", "request_id": REQ_ID}),
            "sent",
        ),
        (
            &prod,
            json!({"device_id": prod.id, "kind": "approval", "request_id": REQ_ID}),
            "sent",
        ),
        // The mock answers 410 Unregistered → the server clears the token.
        (
            &dead,
            json!({"device_id": dead.id, "kind": "approval", "request_id": REQ_ID}),
            "no_token",
        ),
    ];
    for (_, body, want) in &calls {
        let (s, v) = ctx.notify(&mac, body.clone()).await;
        assert_eq!(s, 200, "{body} -> {v}");
        assert_eq!(v["push"], *want, "{body} -> {v}");
    }
    // Bad request: never reaches the mock.
    let (s, v) = ctx
        .notify(
            &mac,
            json!({"device_id": phone.id, "kind": "approval", "request_id": "nope"}),
        )
        .await;
    assert_eq!(s, 400, "{v}");
    // The dead token is gone now.
    let (_, v) = ctx
        .notify(
            &mac,
            json!({"device_id": dead.id, "kind": "approval", "request_id": REQ_ID}),
        )
        .await;
    assert_eq!(v["push"], "no_token");

    let got = read_jsonl(&log);
    assert_eq!(got.len(), calls.len(), "{got:#?}");
    let generic_aps = json!({
        "alert": {"title": "Whispera", "body": "Approval requested"},
        "sound": "default", "category": "WL_APPROVAL", "thread-id": "wl-approvals",
    });
    let mut named_aps = generic_aps.clone();
    named_aps["mutable-content"] = json!(1);
    let want_payloads = [
        json!({"aps": {"alert": {"title": "Whispera", "body": "You have a new request"},
                       "sound": "default"}}),
        json!({"aps": generic_aps, "wl": {"kind": "approval", "request_id": REQ_ID}}),
        json!({"aps": named_aps,
               "wl": {"kind": "approval", "request_id": REQ_ID, "sealed": SEALED}}),
        json!({"aps": {"content-available": 1},
               "wl": {"kind": "approval.resolved", "request_id": REQ_ID}}),
        json!({"aps": generic_aps, "wl": {"kind": "approval", "request_id": REQ_ID}}),
        json!({"aps": generic_aps, "wl": {"kind": "approval", "request_id": REQ_ID}}),
    ];
    let want = [
        (PHONE_TOKEN, "sandbox", "alert", "10", None, 3600),
        (PHONE_TOKEN, "sandbox", "alert", "10", Some(REQ_ID), 300),
        (PHONE_TOKEN, "sandbox", "alert", "10", Some(REQ_ID), 300),
        (PHONE_TOKEN, "sandbox", "background", "5", None, 300),
        (PROD_TOKEN, "production", "alert", "10", Some(REQ_ID), 300),
        (DEAD_TOKEN, "sandbox", "alert", "10", Some(REQ_ID), 300),
    ];
    let t = now();
    for (i, line) in got.iter().enumerate() {
        let (token, env, push_type, prio, collapse, exp) = want[i];
        assert_eq!(line["token"], token, "line {i}");
        assert_eq!(line["path_token_suffix"], &token[token.len() - 8..]);
        assert_eq!(line["env"], env, "line {i}");
        assert_eq!(line["jwt_ok"], true, "line {i}");
        assert_eq!(line["payload"], want_payloads[i], "line {i}");
        let h = &line["headers"];
        assert_eq!(h["apns-topic"], TOPIC);
        assert_eq!(h["apns-push-type"], push_type, "line {i}");
        assert_eq!(h["apns-priority"], prio, "line {i}");
        assert_eq!(h["apns-collapse-id"].as_str(), collapse, "line {i}");
        let e: i64 = h["apns-expiration"].as_str().unwrap().parse().unwrap();
        assert!((e - (t + exp)).abs() <= 30, "line {i}: expiration {e}");
    }

    drop(server);
    let logs = std::fs::read_to_string(&server_log).unwrap();
    assert!(logs.contains("custom URL http://"), "{logs}");
    assert!(!logs.contains("PRIVATE KEY"), "key material logged");
    assert!(
        !logs.contains(pem.lines().nth(1).unwrap()),
        "key material logged"
    );
    assert!(!logs.contains(SEALED), "sealed blob logged");
}
