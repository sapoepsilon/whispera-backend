//! `whispera-apns-mock`: a local stand-in for Apple's APNs HTTP endpoint.
//!
//! Point `whispera-server` at it with `[apns] sandbox_url` / `production_url`
//! (or `APNS_SANDBOX_URL` / `APNS_PRODUCTION_URL`). Every `POST .../3/device/<token>`
//! is answered like Apple would (200, or 410 `Unregistered` for tokens listed
//! with `--unregistered`, 403 `InvalidProviderToken` when `--public-key` is set
//! and the provider JWT does not verify) and recorded as one JSON line:
//!
//! ```text
//! {"ts","path_token_suffix","token","env","headers":{apns-*},"jwt_ok":bool|null,"payload":{…}}
//! ```
//!
//! `env` is taken from the first path segment when it is `sandbox` or
//! `production` (so one mock can serve both, e.g. `sandbox_url =
//! "http://127.0.0.1:18082/sandbox"`), else from `--env` (default `sandbox`).
//! With `--exec '<cmd>'` the payload JSON is piped to `<cmd> <token>` (e.g. to
//! `xcrun simctl push`). Dev and test use only: it never talks to Apple.

use std::io::Write as _;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey as _;
use serde_json::{json, Value};

pub const USAGE: &str = "usage: whispera-apns-mock --listen <addr:port> --log <pushes.jsonl> \
[--public-key <key.pub.pem>] [--exec '<cmd>'] [--env sandbox|production] \
[--unregistered <token-suffix>]...";

/// Mock settings.
#[derive(Debug, Clone)]
pub struct Options {
    /// JSONL file every request is appended to.
    pub log: PathBuf,
    /// Verify the ES256 provider JWT with this key (`jwt_ok`); `None` → `jwt_ok: null`.
    pub public_key: Option<VerifyingKey>,
    /// Shell command run as `<cmd> <token>` with the payload JSON on stdin.
    pub exec: Option<String>,
    /// `env` recorded when the path does not start with `/sandbox` or `/production`.
    pub env: String,
    /// Tokens ending with any of these (case-insensitive) get `410 Unregistered`.
    pub unregistered: Vec<String>,
}

impl Options {
    pub fn new(log: impl Into<PathBuf>) -> Self {
        Options {
            log: log.into(),
            public_key: None,
            exec: None,
            env: "sandbox".into(),
            unregistered: Vec::new(),
        }
    }
}

/// Reads a SPKI PEM P-256 public key (`openssl ec -pubout`).
pub fn load_public_key(pem: &str) -> Result<VerifyingKey, String> {
    VerifyingKey::from_public_key_pem(pem.trim())
        .map_err(|_| "--public-key is not a PEM P-256 public key".to_string())
}

/// Parses command-line arguments (without the program name).
pub fn parse_args(args: &[String]) -> Result<(SocketAddr, Options), String> {
    let mut listen = None;
    let mut log = None;
    let mut opts = Options::new("");
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = || {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match flag.as_str() {
            "--listen" => {
                listen = Some(
                    value()?
                        .parse::<SocketAddr>()
                        .map_err(|_| "--listen must be <ip>:<port>".to_string())?,
                )
            }
            "--log" => log = Some(PathBuf::from(value()?)),
            "--public-key" => {
                let path = value()?;
                let pem = std::fs::read_to_string(&path)
                    .map_err(|e| format!("cannot read --public-key {path}: {e}"))?;
                opts.public_key = Some(load_public_key(&pem)?);
            }
            "--exec" => opts.exec = Some(value()?),
            "--env" => {
                let v = value()?;
                if v != "sandbox" && v != "production" {
                    return Err("--env must be sandbox or production".into());
                }
                opts.env = v;
            }
            "--unregistered" => opts.unregistered.push(value()?.to_ascii_lowercase()),
            "-h" | "--help" => return Err(USAGE.into()),
            other => return Err(format!("unknown argument {other:?}\n{USAGE}")),
        }
    }
    let listen = listen.ok_or_else(|| format!("--listen is required\n{USAGE}"))?;
    opts.log = log.ok_or_else(|| format!("--log is required\n{USAGE}"))?;
    Ok((listen, opts))
}

struct Inner {
    opts: Options,
    log: Mutex<std::fs::File>,
    seq: AtomicU64,
}

/// The mock's axum router. Opens (appends to) the log file.
pub fn router(opts: Options) -> std::io::Result<Router> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&opts.log)?;
    let inner = Arc::new(Inner {
        opts,
        log: Mutex::new(file),
        seq: AtomicU64::new(0),
    });
    Ok(Router::new().fallback(handle).with_state(inner))
}

/// Serves the mock on `listener` until the process ends.
pub async fn serve(listener: tokio::net::TcpListener, opts: Options) -> std::io::Result<()> {
    let app = router(opts)?;
    axum::serve(listener, app).await
}

fn reason(status: StatusCode, reason: &str) -> Response {
    (
        status,
        [("content-type", "application/json")],
        json!({ "reason": reason }).to_string(),
    )
        .into_response()
}

fn valid_token(t: &str) -> bool {
    (64..=200).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `None` when no key is configured; otherwise whether the bearer JWT is a
/// valid ES256 JWS from that key with a `kid` header and `iss`/`iat` claims.
fn check_jwt(key: Option<&VerifyingKey>, headers: &HeaderMap) -> Option<bool> {
    let key = key?;
    let ok = (|| {
        let auth = headers.get("authorization")?.to_str().ok()?;
        let jwt = auth.strip_prefix("bearer ")?;
        let mut parts = jwt.split('.');
        let (h, c, s) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(h).ok()?).ok()?;
        let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(c).ok()?).ok()?;
        if header["alg"] != "ES256" || !header["kid"].is_string() {
            return None;
        }
        if !claims["iss"].is_string() || !claims["iat"].is_i64() {
            return None;
        }
        let sig = Signature::from_slice(&URL_SAFE_NO_PAD.decode(s).ok()?).ok()?;
        key.verify(format!("{h}.{c}").as_bytes(), &sig).ok()
    })()
    .is_some();
    Some(ok)
}

/// RFC 3339 UTC timestamp with milliseconds.
fn timestamp() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        sod / 3600,
        sod % 3600 / 60,
        sod % 60,
        d.subsec_millis()
    )
}

async fn handle(
    State(inner): State<Arc<Inner>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri.path();
    let Some(idx) = path.find("/3/device/") else {
        return reason(StatusCode::NOT_FOUND, "BadPath");
    };
    if method != Method::POST {
        return reason(StatusCode::METHOD_NOT_ALLOWED, "MethodNotAllowed");
    }
    let token = &path[idx + "/3/device/".len()..];
    let env = match path[..idx].trim_start_matches('/').split('/').next() {
        Some(seg @ ("sandbox" | "production")) => seg.to_string(),
        _ => inner.opts.env.clone(),
    };
    let suffix = &token[token.len().saturating_sub(8)..];
    let apns_headers: serde_json::Map<String, Value> = headers
        .iter()
        .filter(|(k, _)| k.as_str().starts_with("apns-"))
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                Value::String(String::from_utf8_lossy(v.as_bytes()).into_owned()),
            )
        })
        .collect();
    let jwt_ok = check_jwt(inner.opts.public_key.as_ref(), &headers);
    let payload: Value = serde_json::from_slice(&body)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&body).into_owned()));

    let line = json!({
        "ts": timestamp(),
        "path_token_suffix": suffix,
        "token": token,
        "env": env,
        "headers": apns_headers,
        "jwt_ok": jwt_ok,
        "payload": payload,
    });
    if let Ok(mut f) = inner.log.lock() {
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
    // Not println!: a closed stdout must never take the mock down.
    let _ = writeln!(
        std::io::stdout(),
        "push env={env} token=…{suffix} type={} jwt_ok={jwt_ok:?}",
        apns_headers
            .get("apns-push-type")
            .and_then(Value::as_str)
            .unwrap_or("-")
    );

    if !valid_token(token) {
        return reason(StatusCode::BAD_REQUEST, "BadDeviceToken");
    }
    if jwt_ok == Some(false) {
        return reason(StatusCode::FORBIDDEN, "InvalidProviderToken");
    }
    let lower = token.to_ascii_lowercase();
    if inner
        .opts
        .unregistered
        .iter()
        .any(|s| !s.is_empty() && lower.ends_with(s.as_str()))
    {
        return reason(StatusCode::GONE, "Unregistered");
    }
    if let Some(cmd) = inner.opts.exec.clone() {
        run_exec(cmd, token.to_string(), body);
    }
    let n = inner.seq.fetch_add(1, Ordering::Relaxed);
    (
        StatusCode::OK,
        [("apns-id", format!("00000000-0000-4000-8000-{n:012x}"))],
    )
        .into_response()
}

/// Runs `<cmd> <token>` via `sh -c` in the background with the payload on stdin.
/// The token is passed as a positional argument, never spliced into the script.
fn run_exec(cmd: String, token: String, payload: Bytes) {
    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt as _;
        let child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(format!("{cmd} \"$1\""))
            .arg("sh")
            .arg(&token)
            .stdin(std::process::Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                eprintln!("exec failed to start: {e}");
                return;
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(&payload).await;
        }
        match child.wait().await {
            Ok(s) if s.success() => {}
            Ok(s) => eprintln!("exec exited with {s}"),
            Err(e) => eprintln!("exec failed: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args() {
        let a = |v: &[&str]| parse_args(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        let (addr, o) = a(&[
            "--listen",
            "127.0.0.1:18082",
            "--log",
            "p.jsonl",
            "--unregistered",
            "DEADBEEF",
            "--env",
            "production",
        ])
        .unwrap();
        assert_eq!(addr.port(), 18082);
        assert_eq!(o.log, PathBuf::from("p.jsonl"));
        assert_eq!(o.unregistered, ["deadbeef"]);
        assert_eq!(o.env, "production");
        assert!(a(&["--log", "x"]).is_err());
        assert!(a(&["--listen", "127.0.0.1:1"]).is_err());
        assert!(a(&["--listen", "127.0.0.1:1", "--log", "x", "--env", "dev"]).is_err());
        assert!(a(&["--listen", "127.0.0.1:1", "--log", "x", "--bogus"]).is_err());
    }

    #[test]
    fn ts_format() {
        let t = timestamp();
        assert_eq!(t.len(), 24, "{t}");
        assert!(t.ends_with('Z') && t.as_bytes()[10] == b'T', "{t}");
    }
}
