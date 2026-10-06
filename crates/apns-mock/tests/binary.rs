//! Runs the real `whispera-apns-mock` binary and checks its answers and JSONL.

use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};
use p256::pkcs8::{EncodePublicKey as _, LineEnding};
use serde_json::{json, Value};

struct Mock(Child);

impl Drop for Mock {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn jwt(key: &SigningKey) -> String {
    let h = URL_SAFE_NO_PAD.encode(json!({"alg": "ES256", "kid": "KID"}).to_string());
    let c = URL_SAFE_NO_PAD.encode(json!({"iss": "TEAM", "iat": 1}).to_string());
    let sig: Signature = key.sign(format!("{h}.{c}").as_bytes());
    format!("{h}.{c}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
}

fn lines(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[tokio::test]
async fn records_answers_and_execs() {
    let dir = std::env::temp_dir().join(format!("whispera-apns-mock-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("pushes.jsonl");
    let _ = std::fs::remove_file(&log);
    let exec_out = dir.join("exec.out");
    let _ = std::fs::remove_file(&exec_out);

    // Throwaway key, generated here and deleted with the directory.
    let key = SigningKey::random(&mut rand::rngs::OsRng);
    let pub_pem = dir.join("key.pub.pem");
    std::fs::write(
        &pub_pem,
        key.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .unwrap(),
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_whispera-apns-mock"))
        .args(["--listen", "127.0.0.1:0", "--log"])
        .arg(&log)
        .arg("--public-key")
        .arg(&pub_pem)
        .arg("--exec")
        .arg(format!("{{ cat; echo; }} > '{}'; echo", exec_out.display()))
        .args(["--unregistered", "DEADBEEF"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut first = String::new();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    out.read_line(&mut first).unwrap();
    std::thread::spawn(move || std::io::copy(&mut out, &mut std::io::sink()));
    let mock = Mock(child);
    let base = first
        .split_whitespace()
        .find(|w| w.starts_with("http://"))
        .expect("listening line")
        .to_string();

    let http = reqwest::Client::new();
    let good = "ab".repeat(32);
    let gone = format!("{}deadbeef", "0".repeat(56));
    let payload = json!({"aps": {"content-available": 1}});
    let send = |path: String, bearer: String| {
        http.post(format!("{base}{path}"))
            .header("authorization", format!("bearer {bearer}"))
            .header("apns-push-type", "background")
            .header("apns-priority", "5")
            .header("apns-topic", "t")
            .body(payload.to_string())
            .send()
    };
    let token = jwt(&key);

    let r = send(format!("/3/device/{good}"), token.clone())
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers().contains_key("apns-id"));
    let r = send(format!("/production/3/device/{good}"), token.clone())
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let r = send(format!("/3/device/{gone}"), token.clone())
        .await
        .unwrap();
    assert_eq!(r.status(), 410);
    assert_eq!(r.json::<Value>().await.unwrap()["reason"], "Unregistered");
    let other = SigningKey::random(&mut rand::rngs::OsRng);
    let r = send(format!("/3/device/{good}"), jwt(&other))
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    assert_eq!(
        r.json::<Value>().await.unwrap()["reason"],
        "InvalidProviderToken"
    );

    let got = lines(&log);
    assert_eq!(got.len(), 4);
    assert_eq!(got[0]["token"], good.as_str());
    assert_eq!(got[0]["path_token_suffix"], &good[good.len() - 8..]);
    assert_eq!(got[0]["env"], "sandbox");
    assert_eq!(got[1]["env"], "production");
    assert_eq!(got[0]["jwt_ok"], true);
    assert_eq!(got[3]["jwt_ok"], false);
    assert_eq!(got[0]["payload"], payload);
    assert_eq!(
        got[0]["headers"],
        json!({"apns-push-type": "background", "apns-priority": "5", "apns-topic": "t"})
    );
    assert!(got[0]["ts"].as_str().unwrap().ends_with('Z'));

    // --exec got the payload on stdin and the token as its last argument
    // (`echo` with no args here, so check the file it wrote).
    let mut out = String::new();
    for _ in 0..50 {
        out = std::fs::read_to_string(&exec_out).unwrap_or_default();
        if !out.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(out.trim(), payload.to_string());
    drop(mock);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn exec_receives_token_argument() {
    let dir = std::env::temp_dir().join(format!("whispera-apns-mock-arg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("p.jsonl");
    let out = dir.join("arg.out");
    let script = dir.join("record.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s ' \"$1\" > '{0}.tmp'; cat >> '{0}.tmp'; mv '{0}.tmp' '{0}'\n",
            out.display()
        ),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut opts = whispera_apns_mock::Options::new(&log);
    opts.exec = Some(format!("sh '{}'", script.display()));
    tokio::spawn(whispera_apns_mock::serve(listener, opts));

    let token = "cd".repeat(32);
    let r = reqwest::Client::new()
        .post(format!("http://{addr}/3/device/{token}"))
        .body(r#"{"aps":{}}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(lines(&log)[0]["jwt_ok"], Value::Null);
    let mut got = String::new();
    for _ in 0..50 {
        got = std::fs::read_to_string(&out).unwrap_or_default();
        if !got.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(got, format!(r#"{token} {{"aps":{{}}}}"#));
    std::fs::remove_dir_all(&dir).unwrap();
}
