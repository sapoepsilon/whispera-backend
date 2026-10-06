//! Port of the pure-logic cases in
//! tests/services/transcription/realtime-provider.test.ts
//! (TranscriptionServerRegistry, granularity in discovery, resolveGranularity,
//! the batch interface). Socket-level cases are skipped; see the crate report.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use whispera_stt::types::{
    CUSTOM_TRANSCRIPTION_PROVIDER_NAME, OPENAI_REALTIME_PROVIDER_NAME,
    OPENAI_TRANSCRIPTION_PROVIDER_NAME,
};
use whispera_stt::{
    read_transcription_servers, resolve_granularity, HealthProbe, ProbeError, RealtimeGranularity,
    RealtimeSummary, RegistryDeps, RegistryError, TranscriptionCapability,
    TranscriptionServerConfig, TranscriptionServerRegistry, TranscriptionServerStatus,
    TranscriptionServersEnv, REALTIME_AUDIO_FORMAT,
};

/// Records every call; answers with a fixed status or error.
struct FakeProbe {
    answer: Result<u16, String>,
    calls: Mutex<Vec<(String, Option<String>)>>,
}

impl FakeProbe {
    fn ok() -> Arc<Self> {
        Self::answering(Ok(200))
    }

    fn answering(answer: Result<u16, String>) -> Arc<Self> {
        Arc::new(Self {
            answer,
            calls: Mutex::new(Vec::new()),
        })
    }

    fn calls(&self) -> Vec<(String, Option<String>)> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl HealthProbe for FakeProbe {
    async fn get(
        &self,
        url: &str,
        bearer: Option<&str>,
        _timeout: Duration,
    ) -> Result<u16, ProbeError> {
        self.calls
            .lock()
            .unwrap()
            .push((url.to_owned(), bearer.map(str::to_owned)));
        self.answer.clone().map_err(ProbeError)
    }
}

fn read(entries: Value) -> Vec<TranscriptionServerConfig> {
    read_transcription_servers(&TranscriptionServersEnv::with_servers(entries.to_string()))
        .expect("valid config")
}

fn configs() -> Vec<TranscriptionServerConfig> {
    read(json!([
        {
            "id": "speaches-lan",
            "label": "Speaches (LAN)",
            "baseUrl": "http://192.168.50.140:8000/v1",
            "model": "Systran/faster-distil-whisper-large-v3",
            "capabilities": ["batch", "realtime"],
        },
        { "id": "cloud", "label": "OpenAI", "capabilities": ["batch"] },
    ]))
}

fn registry_with(probe: Arc<FakeProbe>) -> TranscriptionServerRegistry {
    let deps = RegistryDeps {
        probe_cache_ms: 10_000,
        ..RegistryDeps::with_probe(probe)
    };
    TranscriptionServerRegistry::new(configs(), deps).unwrap()
}

fn registry_of(entries: Value, probe: Arc<FakeProbe>) -> TranscriptionServerRegistry {
    TranscriptionServerRegistry::new(read(entries), RegistryDeps::with_probe(probe)).unwrap()
}

// --- TranscriptionServerRegistry ---

#[test]
fn hands_out_the_batch_provider_matching_each_server_shape() {
    let registry = registry_with(FakeProbe::ok());
    assert_eq!(
        registry.batch_provider("speaches-lan").unwrap().name(),
        CUSTOM_TRANSCRIPTION_PROVIDER_NAME
    );
    assert_eq!(
        registry.batch_provider("cloud").unwrap().name(),
        OPENAI_TRANSCRIPTION_PROVIDER_NAME
    );
}

#[test]
fn refuses_a_realtime_provider_for_a_batch_only_server() {
    let registry = registry_with(FakeProbe::ok());
    let err = registry.realtime_provider("cloud").unwrap_err();
    assert!(
        err.to_string().contains("does not support realtime"),
        "{err}"
    );
    assert!(!registry.supports("cloud", TranscriptionCapability::Realtime));
    assert!(registry.supports("speaches-lan", TranscriptionCapability::Realtime));
}

#[test]
fn refuses_an_unknown_server_id() {
    let err = registry_with(FakeProbe::ok())
        .batch_provider("nope")
        .unwrap_err();
    assert!(
        err.to_string()
            .contains("Unknown transcription server \"nope\""),
        "{err}"
    );
}

#[test]
fn treats_the_first_configured_server_as_the_default() {
    assert_eq!(
        registry_with(FakeProbe::ok()).default_server().id,
        "speaches-lan"
    );
}

#[tokio::test]
async fn describes_a_reachable_server_as_online_with_realtime_details() {
    let registry = registry_with(FakeProbe::ok());
    let speaches = registry.describe().await.remove(0);

    assert_eq!(speaches.status, TranscriptionServerStatus::Online);
    assert_eq!(speaches.detail, None);
    assert!(speaches.default);
    assert_eq!(
        speaches.capabilities,
        [
            TranscriptionCapability::Batch,
            TranscriptionCapability::Realtime
        ]
    );
    assert_eq!(
        speaches.realtime,
        Some(RealtimeSummary {
            protocol: OPENAI_REALTIME_PROVIDER_NAME.to_owned(),
            path: "/transcription/stream?server=speaches-lan".to_owned(),
            audio: REALTIME_AUDIO_FORMAT,
            granularity: RealtimeGranularity::Utterance,
        })
    );
}

#[tokio::test]
async fn reports_an_unreachable_server_rather_than_hiding_it() {
    let registry = registry_with(FakeProbe::answering(Err("ECONNREFUSED".to_owned())));
    let speaches = registry.describe().await.remove(0);

    assert_eq!(speaches.id, "speaches-lan");
    assert_eq!(speaches.status, TranscriptionServerStatus::Offline);
    assert!(speaches.detail.unwrap().contains("ECONNREFUSED"));
}

#[tokio::test]
async fn reports_a_non_2xx_probe_as_offline_with_the_status_code() {
    let registry = registry_with(FakeProbe::answering(Ok(502)));
    let speaches = registry.describe().await.remove(0);

    assert_eq!(speaches.status, TranscriptionServerStatus::Offline);
    assert!(speaches.detail.unwrap().contains("502"));
}

#[tokio::test]
async fn admits_ignorance_for_the_stock_openai_entry_rather_than_guessing() {
    let registry = registry_with(FakeProbe::ok());
    let cloud = registry.describe().await.remove(1);

    assert_eq!(cloud.status, TranscriptionServerStatus::Unknown);
    assert_eq!(cloud.realtime, None);
    assert_eq!(
        cloud.batch_provider.as_deref(),
        Some(OPENAI_TRANSCRIPTION_PROVIDER_NAME)
    );
}

#[tokio::test]
async fn caches_probes_so_discovery_does_not_hammer_the_engine() {
    let probe = FakeProbe::ok();
    let registry = registry_with(Arc::clone(&probe));

    registry.describe().await;
    registry.describe().await;

    assert_eq!(probe.calls().len(), 1);
}

#[tokio::test]
async fn probes_the_openai_compatible_models_path_with_the_configured_key() {
    let probe = FakeProbe::ok();
    registry_with(Arc::clone(&probe)).describe().await;

    assert_eq!(probe.calls()[0].0, "http://192.168.50.140:8000/v1/models");
}

#[tokio::test]
async fn never_exposes_a_base_url_or_a_key_in_the_client_facing_view() {
    let registry = registry_of(
        json!([{ "id": "secret", "baseUrl": "http://internal:8000/v1", "apiKey": "sk-super-secret" }]),
        FakeProbe::ok(),
    );
    let serialised = serde_json::to_string(&registry.describe().await).unwrap();

    assert!(!serialised.contains("sk-super-secret"));
    assert!(!serialised.contains("internal:8000"));
}

// --- realtime granularity in discovery ---

#[tokio::test]
async fn reports_utterance_granularity_for_a_plain_realtime_server() {
    let registry = registry_of(
        json!([{
            "id": "speaches-lan",
            "baseUrl": "http://192.168.50.140:8000/v1",
            "capabilities": ["batch", "realtime"],
        }]),
        FakeProbe::ok(),
    );
    let speaches = registry.describe().await.remove(0);
    assert_eq!(
        speaches.realtime.map(|r| r.granularity),
        Some(RealtimeGranularity::Utterance)
    );
}

#[tokio::test]
async fn reports_synthesized_delta_granularity_once_a_server_opts_into_synthesis() {
    let registry = registry_of(
        json!([{
            "id": "speaches-lan",
            "baseUrl": "http://192.168.50.140:8000/v1",
            "capabilities": ["batch", "realtime"],
            "synthesizeDeltas": true,
        }]),
        FakeProbe::ok(),
    );
    let speaches = registry.describe().await.remove(0);
    assert_eq!(
        speaches.realtime.map(|r| r.granularity),
        Some(RealtimeGranularity::SynthesizedDelta)
    );
}

#[tokio::test]
async fn omits_granularity_for_a_batch_only_server_along_with_the_rest_of_the_realtime_block() {
    let registry = registry_of(
        json!([{ "id": "cloud", "capabilities": ["batch"] }]),
        FakeProbe::ok(),
    );
    let cloud = registry.describe().await.remove(0);
    assert_eq!(cloud.realtime, None);
}

// --- resolveGranularity ---

fn granularity_config() -> TranscriptionServerConfig {
    read(json!([{ "id": "x", "baseUrl": "http://host/v1", "capabilities": ["batch", "realtime"] }]))
        .remove(0)
}

#[test]
fn defaults_to_utterance_when_nothing_streams_natively_and_synthesis_is_off() {
    assert_eq!(
        resolve_granularity(&granularity_config(), None),
        RealtimeGranularity::Utterance
    );
}

#[test]
fn prefers_synthesized_delta_once_the_config_opts_in() {
    let config = TranscriptionServerConfig {
        synthesize_deltas: true,
        ..granularity_config()
    };
    assert_eq!(
        resolve_granularity(&config, None),
        RealtimeGranularity::SynthesizedDelta
    );
}

#[test]
fn lets_a_natively_streaming_provider_win_even_when_synthesis_is_also_configured() {
    let config = TranscriptionServerConfig {
        synthesize_deltas: true,
        ..granularity_config()
    };
    assert_eq!(
        resolve_granularity(&config, Some(RealtimeGranularity::NativeDelta)),
        RealtimeGranularity::NativeDelta
    );
}

/// Extra (commit 835817c has no registry-level TS test for it): the operator's
/// declaration wins over every derivation.
#[test]
fn declared_granularity_wins_over_provider_and_synthesis() {
    let config = TranscriptionServerConfig {
        synthesize_deltas: true,
        granularity: Some(RealtimeGranularity::Utterance),
        ..granularity_config()
    };
    assert_eq!(
        resolve_granularity(&config, Some(RealtimeGranularity::NativeDelta)),
        RealtimeGranularity::Utterance
    );
}

// --- the batch interface is untouched by the realtime sibling ---

#[test]
fn still_satisfies_transcription_provider_exactly() {
    let registry = TranscriptionServerRegistry::new(
        read_transcription_servers(&TranscriptionServersEnv::with_servers(r#"[{"id":"x"}]"#))
            .unwrap(),
        RegistryDeps::default(),
    )
    .unwrap();
    let provider = registry.batch_provider("x").unwrap();

    assert!(!provider.name().is_empty());
    assert!(provider.supports_mimetype("audio/wav"));
    assert!(!provider.supports_mimetype("text/plain"));
    // The "no realtime `send` on a batch provider" check is enforced by the
    // type system: BatchProviderSpec has no such method.
}

// --- Rust-only: constructor guard (registry.ts throws on an empty list) ---

#[test]
fn refuses_to_build_a_registry_with_no_servers() {
    assert_eq!(
        TranscriptionServerRegistry::new(Vec::new(), RegistryDeps::default()).unwrap_err(),
        RegistryError::NoServers
    );
}
