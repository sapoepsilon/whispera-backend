//! Port of the pure-logic cases in tests/routes/transcription-servers.test.ts,
//! exercised against `TranscriptionServerRegistry::describe` (the data the
//! `GET /transcription/servers` route serialises). HTTP-only cases (auth,
//! `POST /transcribe`) are skipped; see the crate report.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use whispera_stt::{
    HealthProbe, ProbeError, RegistryDeps, TranscriptionServerRegistry, TranscriptionServerStatus,
    TranscriptionServerSummary, TranscriptionServersEnv,
};

const ENGINE_BASE_URL: &str = "http://127.0.0.1:45678/v1";

/// Stands in for the real network: the fake engine's `/models` 404s (it only
/// handles upgrades) and port 1 refuses connections.
struct RouteProbe;

#[async_trait]
impl HealthProbe for RouteProbe {
    async fn get(
        &self,
        url: &str,
        _bearer: Option<&str>,
        _timeout: Duration,
    ) -> Result<u16, ProbeError> {
        if url.starts_with("http://127.0.0.1:1/") {
            Err(ProbeError("connect ECONNREFUSED 127.0.0.1:1".to_owned()))
        } else {
            Ok(404)
        }
    }
}

fn registry() -> TranscriptionServerRegistry {
    let env = TranscriptionServersEnv::with_servers(
        json!([
            {
                "id": "speaches-lan",
                "label": "Speaches (LAN)",
                "baseUrl": ENGINE_BASE_URL,
                "apiKey": "super-secret-key",
                "model": "Systran/faster-distil-whisper-large-v3",
                "capabilities": ["batch", "realtime"],
            },
            { "id": "cloud", "label": "OpenAI Whisper", "capabilities": ["batch"] },
            {
                "id": "dead",
                "label": "Unplugged box",
                "baseUrl": "http://127.0.0.1:1/v1",
                "capabilities": ["batch", "realtime"],
            },
        ])
        .to_string(),
    );
    TranscriptionServerRegistry::from_env(&env, RegistryDeps::with_probe(Arc::new(RouteProbe)))
        .unwrap()
}

async fn list_servers() -> Vec<TranscriptionServerSummary> {
    registry().describe().await
}

fn find<'a>(servers: &'a [TranscriptionServerSummary], id: &str) -> &'a TranscriptionServerSummary {
    servers.iter().find(|s| s.id == id).expect("server listed")
}

#[tokio::test]
async fn returns_every_configured_server_in_order() {
    let servers = list_servers().await;
    let ids: Vec<&str> = servers.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["speaches-lan", "cloud", "dead"]);
}

#[tokio::test]
async fn advertises_realtime_for_speaches_with_the_stream_path_and_audio_format() {
    let servers = list_servers().await;
    let speaches = serde_json::to_value(&servers[0]).unwrap();

    assert!(speaches["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("realtime")));
    assert!(!speaches["realtime"].is_null());
    assert_eq!(
        speaches["realtime"]["path"],
        "/transcription/stream?server=speaches-lan"
    );
    assert_eq!(
        speaches["realtime"]["audio"],
        json!({
            "encoding": "pcm16",
            // speaches decodes the append payload at 24 kHz.
            "sampleRate": 24_000,
            "channels": 1,
            "transport": "base64-json",
        })
    );
}

#[tokio::test]
async fn marks_the_first_server_as_the_default() {
    let servers = list_servers().await;
    let defaults: Vec<&str> = servers
        .iter()
        .filter(|s| s.default)
        .map(|s| s.id.as_str())
        .collect();
    assert_eq!(defaults, ["speaches-lan"]);
}

#[tokio::test]
async fn reports_a_batch_only_server_with_no_realtime_block() {
    let servers = list_servers().await;
    let cloud = serde_json::to_value(find(&servers, "cloud")).unwrap();

    assert_eq!(cloud["capabilities"], json!(["batch"]));
    assert_eq!(cloud["realtime"], Value::Null);
    assert_eq!(cloud["batchProvider"], "openai-whisper");
}

#[tokio::test]
async fn keeps_an_unreachable_server_in_the_list_and_says_why() {
    let servers = list_servers().await;
    let dead = find(&servers, "dead");

    assert_eq!(dead.status, TranscriptionServerStatus::Offline);
    assert!(dead.detail.as_deref().is_some_and(|d| !d.is_empty()));
}

#[tokio::test]
async fn admits_it_cannot_probe_the_stock_openai_endpoint() {
    let servers = list_servers().await;
    let cloud = find(&servers, "cloud");

    assert_eq!(cloud.status, TranscriptionServerStatus::Unknown);
    assert!(cloud.detail.as_deref().unwrap().contains("not probed"));
}

#[tokio::test]
async fn never_leaks_a_base_url_or_an_api_key() {
    let body =
        serde_json::to_string(&serde_json::json!({ "servers": list_servers().await })).unwrap();

    assert!(!body.contains("super-secret-key"));
    assert!(!body.contains(ENGINE_BASE_URL));
    assert!(!body.contains("apiKey"));
    assert!(!body.contains("baseUrl"));
}
