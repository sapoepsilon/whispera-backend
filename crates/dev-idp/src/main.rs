//! `whispera-dev-idp` — DEV/TEST ONLY local OpenID Connect provider.
//!
//! ```text
//! whispera-dev-idp [serve] [options]      run the provider (loopback only)
//! whispera-dev-idp mint <user> [options]  print a token signed with the same key
//!
//! options:
//!   --listen ADDR           bind address (default 127.0.0.1:18081; must be loopback)
//!   --issuer URL            iss / base URL (default http://<listen>)
//!   --client-id ID          OAuth client id and token audience (default whispera)
//!   --users a,b             users offered on the sign-in page (default alice,bob)
//!   --redirect-uris u1,u2   redirect URI allow-list
//!                           (default whispera://auth/callback,whispera-mac://auth/callback)
//!   --token-ttl SECONDS     token lifetime (default 3600)
//!   --key-file PATH         PKCS#8 PEM ES256 key, created if missing
//!                           (default $TMPDIR/whispera-dev-idp/es256.pem)
//!   --ephemeral-key         serve: use a fresh in-memory key (mint can't match it)
//!   --id-token              mint: print an id_token instead of an access token
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;

use tracing_subscriber::EnvFilter;
use whispera_dev_idp::{
    spawn, IdpConfig, IdpKey, DEFAULT_CLIENT_ID, DEFAULT_PORT, DEFAULT_REDIRECT_URIS,
    DEFAULT_TOKEN_TTL_S, DEFAULT_USERS,
};

const USAGE: &str = "\
whispera-dev-idp — DEV/TEST ONLY local OpenID Connect provider (no passwords, loopback only)

usage:
  whispera-dev-idp [serve] [--listen 127.0.0.1:18081] [--issuer URL] [--client-id whispera]
                   [--users alice,bob] [--redirect-uris URI,...] [--token-ttl 3600]
                   [--key-file PATH | --ephemeral-key]
  whispera-dev-idp mint <user> [--issuer URL] [--listen ADDR] [--client-id whispera]
                   [--token-ttl 3600] [--key-file PATH] [--id-token]

`mint` signs with the same key file as `serve` (default $TMPDIR/whispera-dev-idp/es256.pem),
so its tokens verify against a running provider's JWKS.";

struct Opts {
    command: String,
    user: Option<String>,
    listen: SocketAddr,
    issuer: Option<String>,
    client_id: String,
    users: Vec<String>,
    redirect_uris: Vec<String>,
    token_ttl_s: i64,
    key_file: PathBuf,
    ephemeral_key: bool,
    id_token: bool,
}

fn list(v: &str) -> Vec<String> {
    v.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

fn default_key_file() -> PathBuf {
    std::env::temp_dir()
        .join("whispera-dev-idp")
        .join("es256.pem")
}

fn parse(args: Vec<String>) -> Result<Opts, String> {
    let mut o = Opts {
        command: "serve".into(),
        user: None,
        listen: SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT)),
        issuer: None,
        client_id: DEFAULT_CLIENT_ID.into(),
        users: DEFAULT_USERS.iter().map(|s| s.to_string()).collect(),
        redirect_uris: DEFAULT_REDIRECT_URIS
            .iter()
            .map(|s| s.to_string())
            .collect(),
        token_ttl_s: DEFAULT_TOKEN_TTL_S,
        key_file: default_key_file(),
        ephemeral_key: false,
        id_token: false,
    };
    let mut it = args.into_iter().peekable();
    if let Some(c) = it.peek() {
        if c == "serve" || c == "mint" {
            o.command = it.next().unwrap();
        }
    }
    while let Some(a) = it.next() {
        let mut val = || it.next().ok_or_else(|| format!("{a} needs a value"));
        match a.as_str() {
            "-h" | "--help" => o.command = "help".into(),
            "--listen" => {
                o.listen = val()?
                    .parse()
                    .map_err(|_| "--listen: expected IP:PORT".to_string())?
            }
            "--issuer" => o.issuer = Some(val()?.trim_end_matches('/').to_string()),
            "--client-id" => o.client_id = val()?,
            "--users" => o.users = list(&val()?),
            "--redirect-uris" => o.redirect_uris = list(&val()?),
            "--token-ttl" => {
                o.token_ttl_s = val()?
                    .parse()
                    .ok()
                    .filter(|n| *n > 0)
                    .ok_or("--token-ttl: expected positive seconds")?
            }
            "--key-file" => o.key_file = PathBuf::from(val()?),
            "--ephemeral-key" => o.ephemeral_key = true,
            "--id-token" => o.id_token = true,
            s if !s.starts_with('-') && o.command == "mint" && o.user.is_none() => {
                o.user = Some(s.to_string())
            }
            s => return Err(format!("unknown argument {s:?}")),
        }
    }
    if o.users.is_empty() {
        return Err("--users: at least one user".into());
    }
    if let Some(i) = &o.issuer {
        url::Url::parse(i).map_err(|e| format!("--issuer: {e}"))?;
    }
    for u in &o.redirect_uris {
        url::Url::parse(u).map_err(|e| format!("--redirect-uris {u:?}: {e}"))?;
    }
    Ok(o)
}

fn config(o: &Opts) -> IdpConfig {
    let mut c = IdpConfig::new(
        o.issuer
            .clone()
            .unwrap_or_else(|| format!("http://{}", o.listen)),
    );
    c.client_id = o.client_id.clone();
    c.users = o.users.clone();
    c.redirect_uris = o.redirect_uris.clone();
    c.token_ttl_s = o.token_ttl_s;
    c
}

#[tokio::main]
async fn main() {
    let opts = match parse(std::env::args().skip(1).collect()) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("whispera-dev-idp: {e}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    let result = match opts.command.as_str() {
        "help" => {
            println!("{USAGE}");
            Ok(())
        }
        "mint" => mint(&opts),
        _ => serve(&opts).await,
    };
    if let Err(e) = result {
        eprintln!("whispera-dev-idp: {e}");
        std::process::exit(1);
    }
}

fn mint(o: &Opts) -> Result<(), String> {
    let user = o
        .user
        .as_deref()
        .ok_or("usage: whispera-dev-idp mint <user>")?;
    let (key, created) = IdpKey::load_or_create(&o.key_file).map_err(|e| e.to_string())?;
    if created {
        eprintln!(
            "whispera-dev-idp: created a new key at {}; restart a running `serve` so it uses it",
            o.key_file.display()
        );
    }
    let idp = whispera_dev_idp::DevIdp::new(config(o), key);
    let token = if o.id_token {
        idp.mint_id_token(user, None)
    } else {
        idp.mint_access_token(user, "openid")
    };
    println!("{token}");
    Ok(())
}

async fn serve(o: &Opts) -> Result<(), String> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let key = if o.ephemeral_key {
        IdpKey::generate()
    } else {
        IdpKey::load_or_create(&o.key_file)
            .map_err(|e| e.to_string())?
            .0
    };
    let cfg = config(o);
    let (idp, handle) = spawn(o.listen, cfg, key).await.map_err(|e| e.to_string())?;
    let c = idp.config();
    tracing::warn!("whispera-dev-idp is for DEVELOPMENT AND TESTS ONLY: anyone can sign in");
    tracing::info!(
        issuer = %c.issuer,
        client_id = %c.client_id,
        users = ?c.users,
        redirect_uris = ?c.redirect_uris,
        kid = %idp.key().kid(),
        key = %if o.ephemeral_key { "ephemeral".to_string() } else { o.key_file.display().to_string() },
        "listening"
    );
    tokio::select! {
        r = handle => r.map_err(|e| format!("server task: {e}")),
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}
