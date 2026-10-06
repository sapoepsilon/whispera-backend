//! The dev provider's OAuth/OIDC flow, in-process (no network).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::Value;
use tower::ServiceExt;
use whispera_dev_idp::{ensure_loopback, pkce_challenge, DevIdp, IdpConfig, IdpKey};

const ISS: &str = "http://127.0.0.1:18081";
const REDIRECT: &str = "whispera://auth/callback";
const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

fn idp() -> (Arc<DevIdp>, Router) {
    let idp = DevIdp::new(IdpConfig::new(ISS), IdpKey::generate());
    (idp.clone(), idp.router())
}

async fn send(app: &Router, req: Request<Body>) -> (StatusCode, Option<String>, String) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let loc = resp
        .headers()
        .get(header::LOCATION)
        .map(|v| v.to_str().unwrap().to_string());
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    (status, loc, String::from_utf8(body.to_vec()).unwrap())
}

fn get(uri: &str) -> Request<Body> {
    Request::get(uri).body(Body::empty()).unwrap()
}

fn form(uri: &str, pairs: &[(&str, &str)]) -> Request<Body> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    Request::post(uri)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from(body))
        .unwrap()
}

fn authorize_uri(extra: &[(&str, &str)], skip: &[&str]) -> String {
    let challenge = pkce_challenge(VERIFIER);
    let base = [
        ("response_type", "code"),
        ("client_id", "whispera"),
        ("redirect_uri", REDIRECT),
        ("state", "st-123"),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("scope", "openid offline_access"),
    ];
    let q = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(base.iter().filter(|(k, _)| !skip.contains(k)))
        .extend_pairs(extra)
        .finish();
    format!("/authorize?{q}")
}

fn query(loc: &str) -> std::collections::HashMap<String, String> {
    url::Url::parse(loc)
        .unwrap()
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn verify(idp: &DevIdp, token: &str, aud: &str) -> Value {
    let jwk = &idp.key().jwks()["keys"][0];
    let key =
        DecodingKey::from_ec_components(jwk["x"].as_str().unwrap(), jwk["y"].as_str().unwrap())
            .unwrap();
    let mut v = Validation::new(Algorithm::ES256);
    v.set_issuer(&[ISS]);
    v.set_audience(&[aud]);
    let data = jsonwebtoken::decode::<Value>(token, &key, &v).unwrap();
    assert_eq!(data.header.kid.as_deref(), Some(idp.key().kid()));
    data.claims
}

async fn exchange(app: &Router, code: &str, verifier: &str) -> (StatusCode, Value) {
    let (s, _, body) = send(
        app,
        form(
            "/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", REDIRECT),
                ("client_id", "whispera"),
                ("code_verifier", verifier),
            ],
        ),
    )
    .await;
    (s, serde_json::from_str(&body).unwrap())
}

#[tokio::test]
async fn discovery_and_jwks() {
    let (_, app) = idp();
    let (s, _, body) = send(&app, get("/.well-known/openid-configuration")).await;
    assert_eq!(s, StatusCode::OK);
    let d: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(d["issuer"], ISS);
    assert_eq!(d["jwks_uri"], format!("{ISS}/jwks.json"));
    assert_eq!(d["token_endpoint"], format!("{ISS}/token"));
    assert_eq!(d["code_challenge_methods_supported"][0], "S256");
    let (s, _, body) = send(&app, get("/jwks.json")).await;
    assert_eq!(s, StatusCode::OK);
    let j: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(j["keys"][0]["kty"], "EC");
    assert_eq!(j["keys"][0]["alg"], "ES256");
}

#[tokio::test]
async fn login_hint_code_flow_and_refresh() {
    let (idp, app) = idp();
    let (s, loc, _) = send(
        &app,
        get(&authorize_uri(
            &[("login_hint", "alice"), ("nonce", "n-1")],
            &[],
        )),
    )
    .await;
    assert_eq!(s, StatusCode::FOUND);
    let loc = loc.unwrap();
    assert!(loc.starts_with("whispera://auth/callback?"), "{loc}");
    let q = query(&loc);
    assert_eq!(q["state"], "st-123");
    let code = &q["code"];

    // Wrong verifier fails and burns the code.
    let (s, v) = exchange(&app, code, &"x".repeat(43)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "invalid_grant");
    let (s, _) = exchange(&app, code, VERIFIER).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "codes are single-use");

    // A fresh code with the right verifier works once.
    let (_, loc, _) = send(
        &app,
        get(&authorize_uri(
            &[("login_hint", "alice"), ("nonce", "n-1")],
            &[],
        )),
    )
    .await;
    let code = query(&loc.unwrap())["code"].clone();
    let (s, t) = exchange(&app, &code, VERIFIER).await;
    assert_eq!(s, StatusCode::OK, "{t}");
    assert_eq!(t["token_type"], "Bearer");
    assert_eq!(t["expires_in"], 3600);
    let id = verify(&idp, t["id_token"].as_str().unwrap(), "whispera");
    assert_eq!(id["sub"], "alice");
    assert_eq!(id["nonce"], "n-1");
    assert_eq!(id["azp"], "whispera");
    let exp = id["exp"].as_i64().unwrap() - id["iat"].as_i64().unwrap();
    assert_eq!(exp, 3600);
    let at = verify(&idp, t["access_token"].as_str().unwrap(), "whispera");
    assert_eq!(at["sub"], "alice");
    assert_eq!(at["scope"], "openid offline_access");
    let (s, _) = exchange(&app, &code, VERIFIER).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "code reuse refused");

    // Refresh rotates.
    let rt = t["refresh_token"].as_str().unwrap();
    let refresh = |rt: &str| {
        form(
            "/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", rt),
                ("client_id", "whispera"),
            ],
        )
    };
    let (s, _, body) = send(&app, refresh(rt)).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let t2: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        verify(&idp, t2["access_token"].as_str().unwrap(), "whispera")["sub"],
        "alice"
    );
    assert_ne!(t2["refresh_token"], t["refresh_token"]);
    let (s, _, body) = send(&app, refresh(rt)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(body.contains("invalid_grant"));
    // Wrong client.
    let (s, _, body) = send(
        &app,
        form(
            "/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", t2["refresh_token"].as_str().unwrap()),
                ("client_id", "other"),
            ],
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(body.contains("invalid_client"));
}

#[tokio::test]
async fn sign_in_page_buttons_and_form_submit() {
    let (idp, app) = idp();
    let (s, _, html) = send(&app, get(&authorize_uri(&[], &[]))).await;
    assert_eq!(s, StatusCode::OK);
    assert!(html.contains("DEV/TEST ONLY"));
    assert!(html.contains("Sign in as alice"));
    assert!(html.contains("Sign in as bob"));
    assert!(html.contains("name=\"state\" value=\"st-123\""));

    let challenge = pkce_challenge(VERIFIER);
    let fields = |extra: (&'static str, &'static str)| {
        vec![
            ("response_type", "code".to_string()),
            ("client_id", "whispera".into()),
            ("redirect_uri", REDIRECT.into()),
            ("state", "st-9".into()),
            ("code_challenge", challenge.clone()),
            ("code_challenge_method", "S256".into()),
            (extra.0, extra.1.into()),
        ]
    };
    let to_req = |f: Vec<(&str, String)>| {
        let pairs: Vec<(&str, &str)> = f.iter().map(|(k, v)| (*k, v.as_str())).collect();
        form("/authorize", &pairs)
    };
    let (s, loc, _) = send(&app, to_req(fields(("user", "bob")))).await;
    assert_eq!(s, StatusCode::FOUND);
    let q = query(&loc.unwrap());
    assert_eq!(q["state"], "st-9");
    let (s, t) = exchange(&app, &q["code"], VERIFIER).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        verify(&idp, t["id_token"].as_str().unwrap(), "whispera")["sub"],
        "bob"
    );

    let (s, loc, _) = send(&app, to_req(fields(("deny", "1")))).await;
    assert_eq!(s, StatusCode::FOUND);
    let q = query(&loc.unwrap());
    assert_eq!(q["error"], "access_denied");
    assert!(!q.contains_key("code"));

    let (s, loc, _) = send(&app, to_req(fields(("user", "mallory")))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(loc.is_none());
}

#[tokio::test]
async fn authorize_rejects_bad_requests_without_redirecting() {
    let (_, app) = idp();
    let cases = [
        authorize_uri(&[], &["code_challenge"]),
        authorize_uri(&[], &["code_challenge_method"]),
        authorize_uri(
            &[("code_challenge_method", "plain")],
            &["code_challenge_method"],
        ),
        authorize_uri(&[], &["state"]),
        authorize_uri(
            &[("redirect_uri", "https://evil.example/cb")],
            &["redirect_uri"],
        ),
        authorize_uri(&[("client_id", "other")], &["client_id"]),
        authorize_uri(&[("response_type", "token")], &["response_type"]),
        authorize_uri(&[("login_hint", "mallory")], &[]),
    ];
    for uri in cases {
        let (s, loc, _) = send(&app, get(&uri)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{uri}");
        assert!(loc.is_none(), "{uri}");
    }
}

#[tokio::test]
async fn custom_config_and_mint() {
    let mut cfg = IdpConfig::new(ISS);
    cfg.client_id = "custom".into();
    cfg.users = vec!["carol".into()];
    cfg.redirect_uris = vec!["http://127.0.0.1:9/cb".into()];
    cfg.token_ttl_s = 60;
    let idp = DevIdp::new(cfg, IdpKey::generate());
    let app = idp.clone().router();
    let challenge = pkce_challenge(VERIFIER);
    let q = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("response_type", "code"),
            ("client_id", "custom"),
            ("redirect_uri", "http://127.0.0.1:9/cb"),
            ("state", "s"),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("login_hint", "carol"),
        ])
        .finish();
    let (s, loc, _) = send(&app, get(&format!("/authorize?{q}"))).await;
    assert_eq!(s, StatusCode::FOUND);
    assert!(loc.unwrap().starts_with("http://127.0.0.1:9/cb?code="));
    // alice is not configured here.
    let (s, _, _) = send(&app, get(&authorize_uri(&[("login_hint", "alice")], &[]))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let c = verify(&idp, &idp.mint_access_token("carol", "openid"), "custom");
    assert_eq!(c["exp"].as_i64().unwrap() - c["iat"].as_i64().unwrap(), 60);
}

#[test]
fn loopback_only() {
    assert!(ensure_loopback("127.0.0.1:18081".parse::<SocketAddr>().unwrap()).is_ok());
    assert!(ensure_loopback("[::1]:18081".parse::<SocketAddr>().unwrap()).is_ok());
    assert!(ensure_loopback("0.0.0.0:18081".parse::<SocketAddr>().unwrap()).is_err());
    assert!(ensure_loopback("192.168.1.2:18081".parse::<SocketAddr>().unwrap()).is_err());
}

#[test]
fn key_file_persists() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sub/es256.pem");
    let (k1, created) = IdpKey::load_or_create(&path).unwrap();
    assert!(created);
    let (k2, created) = IdpKey::load_or_create(&path).unwrap();
    assert!(!created);
    assert_eq!(k1.kid(), k2.kid());
    assert_eq!(k1.jwks(), k2.jwks());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    std::fs::write(&path, "garbage").unwrap();
    assert!(IdpKey::load_or_create(&path).is_err());
}
