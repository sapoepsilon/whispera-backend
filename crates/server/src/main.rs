//! `whispera-server` binary.
//!
//! ```text
//! whispera-server                 run the server (config: WHISPERA_CONFIG + env)
//! whispera-server gen-token NAME  print a new static token and its config line
//! ```

use std::net::SocketAddr;
use std::sync::Arc;

use tracing_subscriber::EnvFilter;
use whispera_apns::{ApnsClient, ApnsConfig};
use whispera_server::{router, spawn_maintenance, AppState, Config, Pusher, Settings};
use whispera_store::Store;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => {}
        Some("gen-token") => {
            let Some(name) = args.get(1) else {
                eprintln!("usage: whispera-server gen-token <account-name>");
                std::process::exit(2);
            };
            let token = whispera_auth::generate_token();
            println!("token (give to the client, shown once): {token}");
            println!(
                "WHISPERA_STATIC_TOKENS entry: {name}:{}",
                whispera_auth::hash_token(&token)
            );
            return;
        }
        Some("--version" | "-V") => {
            println!("whispera-server {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some(other) => {
            eprintln!("unknown argument {other:?}; usage: whispera-server [gen-token <name>]");
            std::process::exit(2);
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info,sqlx=warn")),
        )
        .init();

    if let Err(e) = run().await {
        tracing::error!("{e}");
        std::process::exit(1);
    }
}

fn apns_config(cfg: &Config) -> Result<Option<ApnsConfig>, String> {
    if let Some(c) = ApnsConfig::from_env().map_err(|e| format!("APNs config: {e}"))? {
        return Ok(Some(c));
    }
    match &cfg.apns {
        Some(a) => ApnsConfig::from_key_file(&a.key_path, &a.key_id, &a.team_id, &a.topic)
            .map(Some)
            .map_err(|e| format!("APNs config: {e}")),
        None => Ok(None),
    }
}

async fn run() -> Result<(), String> {
    let cfg = Config::from_env().map_err(|e| format!("config: {e}"))?;
    let auth = whispera_auth::build_from_config(cfg.auth.as_ref().expect("validated"))
        .await
        .map_err(|e| format!("auth: {e}"))?;
    let store = Store::connect(&cfg.database_url)
        .await
        .map_err(|e| format!("database: {e}"))?;
    let pusher: Option<Arc<dyn Pusher>> = match apns_config(&cfg)? {
        Some(c) => Some(Arc::new(
            ApnsClient::new(c).map_err(|e| format!("APNs: {e}"))?,
        )),
        None => {
            tracing::info!("APNs not configured; push disabled");
            None
        }
    };
    tracing::info!(
        auth = auth.kind(),
        db = ?store.backend(),
        push = pusher.is_some(),
        "starting whispera-server"
    );
    let state = AppState::new(store, auth, pusher, Settings::from_config(&cfg));
    spawn_maintenance(state.clone());
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(cfg.listen)
        .await
        .map_err(|e| format!("bind {}: {e}", cfg.listen))?;
    tracing::info!(addr = %cfg.listen, "listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await
    .map_err(|e| format!("server: {e}"))
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutting down");
}
