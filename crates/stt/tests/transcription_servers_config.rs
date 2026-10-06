//! Port of tests/services/transcription/transcription-servers-config.test.ts.

use serde_json::{json, Value};
use whispera_stt::servers::{DEFAULT_REALTIME_PATH, DEFAULT_SERVER_ID, OPENAI_DEFAULT_BASE_URL};
use whispera_stt::types::DEFAULT_TRANSCRIPTION_MODEL;
use whispera_stt::{
    has_capability, read_transcription_servers, resolve_base_url, RealtimeGranularity,
    TranscriptionCapability::{Batch, Realtime},
    TranscriptionServerConfig, TranscriptionServersEnv,
};

fn speaches() -> Value {
    json!({
        "id": "speaches-lan",
        "label": "Speaches (LAN)",
        "baseUrl": "http://192.168.50.140:8000/v1",
        "model": "Systran/faster-distil-whisper-large-v3",
        "capabilities": ["batch", "realtime"],
    })
}

fn with(mut base: Value, key: &str, value: Value) -> Value {
    base[key] = value;
    base
}

fn servers(entries: Value) -> TranscriptionServersEnv {
    TranscriptionServersEnv::with_servers(entries.to_string())
}

fn env(pairs: &[(&str, &str)]) -> TranscriptionServersEnv {
    let map = pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    TranscriptionServersEnv::from_map(&map)
}

fn read_ok(env: &TranscriptionServersEnv) -> Vec<TranscriptionServerConfig> {
    read_transcription_servers(env).expect("config should parse")
}

fn read_err(env: &TranscriptionServersEnv) -> String {
    read_transcription_servers(env)
        .expect_err("config should be rejected")
        .to_string()
}

// --- single-server fallback ---

#[test]
fn synthesises_one_openai_entry_when_nothing_is_configured() {
    let parsed = read_ok(&TranscriptionServersEnv::default());
    assert_eq!(parsed.len(), 1);
    let only = &parsed[0];
    assert_eq!(only.id, DEFAULT_SERVER_ID);
    assert_eq!(only.model, DEFAULT_TRANSCRIPTION_MODEL);
    assert_eq!(only.base_url, None);
    // Advertising realtime would make the discovery route lie.
    assert_eq!(only.capabilities, vec![Batch]);
}

#[test]
fn carries_the_legacy_custom_endpoint_vars_through_unchanged() {
    let only = read_ok(&env(&[
        ("TRANSCRIPTION_PROVIDER", "custom"),
        ("TRANSCRIPTION_BASE_URL", "http://localhost:8000/v1"),
        ("TRANSCRIPTION_MODEL", "faster-whisper-large-v3"),
        ("TRANSCRIPTION_API_KEY", "legacy-key"),
    ]))
    .remove(0);
    assert_eq!(only.base_url.as_deref(), Some("http://localhost:8000/v1"));
    assert_eq!(only.model, "faster-whisper-large-v3");
    assert_eq!(only.api_key.as_deref(), Some("legacy-key"));
    assert_eq!(only.capabilities, vec![Batch]);
}

#[test]
fn still_refuses_a_custom_provider_with_no_base_url() {
    let err = read_err(&env(&[("TRANSCRIPTION_PROVIDER", "custom")]));
    assert!(err.contains("TRANSCRIPTION_BASE_URL is required"), "{err}");
}

#[test]
fn rejects_a_legacy_base_url_that_is_not_http_s() {
    let err = read_err(&env(&[
        ("TRANSCRIPTION_PROVIDER", "custom"),
        ("TRANSCRIPTION_BASE_URL", "localhost:8000"),
    ]));
    assert!(err.contains("must be an http(s) URL"), "{err}");
}

// --- TRANSCRIPTION_SERVERS ---

#[test]
fn reads_the_multi_server_list_from_the_brief_verbatim() {
    let s = read_ok(&servers(json!([speaches()]))).remove(0);
    assert_eq!(s.id, "speaches-lan");
    assert_eq!(s.label, "Speaches (LAN)");
    assert_eq!(s.base_url.as_deref(), Some("http://192.168.50.140:8000/v1"));
    assert_eq!(s.model, "Systran/faster-distil-whisper-large-v3");
    assert!(has_capability(&s, Batch));
    assert!(has_capability(&s, Realtime));
}

#[test]
fn keeps_several_servers_in_declaration_order() {
    let parsed = read_ok(&servers(json!([
        speaches(),
        { "id": "cloud", "capabilities": ["batch"] }
    ])));
    let ids: Vec<&str> = parsed.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["speaches-lan", "cloud"]);
}

#[test]
fn defaults_label_model_capabilities_and_realtime_path() {
    let minimal = read_ok(&servers(json!([{ "id": "bare" }]))).remove(0);
    assert_eq!(minimal.label, "bare");
    assert_eq!(minimal.model, DEFAULT_TRANSCRIPTION_MODEL);
    assert_eq!(minimal.capabilities, vec![Batch]);
    assert_eq!(minimal.realtime_path, DEFAULT_REALTIME_PATH);
}

#[test]
fn strips_a_trailing_slash_from_the_base_url_so_paths_join_cleanly() {
    let trailing = read_ok(&servers(
        json!([{ "id": "x", "baseUrl": "http://host:8000/v1/" }]),
    ))
    .remove(0);
    assert_eq!(trailing.base_url.as_deref(), Some("http://host:8000/v1"));
}

#[test]
fn lets_a_server_override_the_realtime_path() {
    let odd = read_ok(&servers(json!([
        { "id": "x", "realtimePath": "/realtime/", "capabilities": ["realtime"] }
    ])))
    .remove(0);
    assert_eq!(odd.realtime_path, "/realtime/");
}

// --- failing fast ---

#[test]
fn rejects_json_that_does_not_parse() {
    let err = read_err(&TranscriptionServersEnv::with_servers("{not json"));
    assert!(err.contains("must be a JSON array"), "{err}");
}

#[test]
fn rejects_a_list_with_no_entries() {
    let err = read_err(&servers(json!([])));
    assert!(err.contains("not a valid server list"), "{err}");
}

#[test]
fn rejects_an_entry_with_no_id() {
    let err = read_err(&servers(json!([{ "label": "nameless" }])));
    assert!(err.contains("not a valid server list"), "{err}");
}

#[test]
fn rejects_an_unknown_capability() {
    let err = read_err(&servers(
        json!([{ "id": "x", "capabilities": ["telepathy"] }]),
    ));
    assert!(err.contains("not a valid server list"), "{err}");
}

#[test]
fn names_the_offending_server_when_its_base_url_does_not_parse() {
    let err = read_err(&servers(json!([
        { "id": "speaches-lan", "baseUrl": "192.168.50.140:8000" }
    ])));
    assert!(
        err.contains("TRANSCRIPTION_SERVERS[speaches-lan].baseUrl must be a valid URL"),
        "{err}"
    );
}

#[test]
fn names_the_offending_server_when_its_base_url_is_not_http_s() {
    // WHATWG parsing reads "localhost:8000" as a custom scheme rather than failing.
    let err = read_err(&servers(json!([
        { "id": "speaches-lan", "baseUrl": "localhost:8000" }
    ])));
    assert!(
        err.contains("TRANSCRIPTION_SERVERS[speaches-lan].baseUrl must be an http(s) URL"),
        "{err}"
    );
}

#[test]
fn rejects_duplicate_ids_rather_than_silently_shadowing_one() {
    let err = read_err(&servers(json!([{ "id": "dup" }, { "id": "dup" }])));
    assert!(err.contains("duplicate server id \"dup\""), "{err}");
}

#[test]
fn rejects_an_unknown_field_so_a_typo_is_not_silently_ignored() {
    let err = read_err(&servers(json!([{ "id": "x", "bseUrl": "http://h/v1" }])));
    assert!(err.contains("not a valid server list"), "{err}");
}

// --- synthesizeDeltas ---

#[test]
fn synthesize_deltas_defaults_to_false_when_omitted() {
    let s = read_ok(&servers(json!([speaches()]))).remove(0);
    assert!(!s.synthesize_deltas);
}

#[test]
fn accepts_the_flag_when_the_server_also_has_batch() {
    let s = read_ok(&servers(json!([with(
        speaches(),
        "synthesizeDeltas",
        json!(true)
    )])))
    .remove(0);
    assert!(s.synthesize_deltas);
}

#[test]
fn accepts_the_flag_on_a_bare_entry_which_defaults_to_batch() {
    let bare = read_ok(&servers(json!([{ "id": "x", "synthesizeDeltas": true }]))).remove(0);
    assert_eq!(bare.capabilities, vec![Batch]);
    assert!(bare.synthesize_deltas);
}

#[test]
fn rejects_the_flag_on_a_server_with_only_realtime_since_there_is_no_batch_endpoint_to_synthesize_against(
) {
    let err = read_err(&servers(json!([
        { "id": "x", "capabilities": ["realtime"], "synthesizeDeltas": true }
    ])));
    assert!(
        err.contains("synthesizeDeltas requires the \"batch\" capability"),
        "{err}"
    );
}

#[test]
fn rejects_a_non_boolean_value() {
    let err = read_err(&servers(json!([{ "id": "x", "synthesizeDeltas": "yes" }])));
    assert!(err.contains("not a valid server list"), "{err}");
}

#[test]
fn never_sets_it_for_the_legacy_single_server_env_even_implicitly() {
    let only = read_ok(&TranscriptionServersEnv::default()).remove(0);
    assert!(!only.synthesize_deltas);
}

// --- resolveBaseUrl ---

#[test]
fn uses_the_server_base_url_when_it_has_one() {
    let s = read_ok(&servers(json!([speaches()]))).remove(0);
    assert_eq!(
        resolve_base_url(&s, &TranscriptionServersEnv::default()),
        "http://192.168.50.140:8000/v1"
    );
}

#[test]
fn falls_back_to_openai_base_url_then_to_the_public_openai_endpoint() {
    let bare = read_ok(&servers(json!([{ "id": "bare" }]))).remove(0);
    assert_eq!(
        resolve_base_url(&bare, &env(&[("OPENAI_BASE_URL", "http://proxy/v1")])),
        "http://proxy/v1"
    );
    assert_eq!(
        resolve_base_url(&bare, &TranscriptionServersEnv::default()),
        OPENAI_DEFAULT_BASE_URL
    );
}

// --- explicit granularity override ---

#[test]
fn carries_a_declared_native_delta_through_to_the_config() {
    let parsed = read_ok(&servers(json!([{
        "id": "nemo-stream",
        "baseUrl": "http://192.168.50.38:8001/v1",
        "model": "nvidia/nemotron-3.5-asr-streaming-0.6b",
        "capabilities": ["realtime"],
        "granularity": "native-delta",
    }])));
    assert_eq!(
        parsed[0].granularity,
        Some(RealtimeGranularity::NativeDelta)
    );
}

#[test]
fn rejects_an_unknown_granularity_value() {
    assert!(read_transcription_servers(&servers(json!([
        { "id": "x", "baseUrl": "http://h/v1", "granularity": "word-by-word" }
    ])))
    .is_err());
}
