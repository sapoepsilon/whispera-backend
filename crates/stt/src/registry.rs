//! Server lookup, provider selection and discovery (port of `registry.ts`).
//!
//! No clients are built here: the registry hands out *specs* describing which
//! provider a capability resolves to, and liveness probing goes through the
//! [`HealthProbe`] trait so the HTTP side lives elsewhere.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::Serialize;

use crate::servers::{
    has_capability, read_transcription_servers, resolve_base_url_with, ConfigError,
    TranscriptionCapability, TranscriptionServerConfig, TranscriptionServersEnv,
};
use crate::types::{
    is_supported_mimetype, RealtimeGranularity, CUSTOM_TRANSCRIPTION_PROVIDER_NAME,
    OPENAI_REALTIME_PROVIDER_NAME, OPENAI_TRANSCRIPTION_PROVIDER_NAME,
};

/// Audio a realtime client must send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeAudioFormat {
    pub encoding: &'static str,
    pub sample_rate: u32,
    pub channels: u16,
    /// Frames are base64-encoded JSON text; a raw binary frame ends the session.
    pub transport: &'static str,
}

/// speaches decodes `input_audio_buffer.append` as headerless PCM16 at 24 kHz;
/// 16 kHz silently time-compresses the audio, so discovery states it.
pub const REALTIME_AUDIO_FORMAT: RealtimeAudioFormat = RealtimeAudioFormat {
    encoding: "pcm16",
    sample_rate: 24_000,
    channels: 1,
    transport: "base64-json",
};

/// Path a client opens for the streaming proxy.
pub const REALTIME_STREAM_PATH: &str = "/transcription/stream";
/// How long a liveness result is trusted before the endpoint is probed again.
pub const PROBE_CACHE_MS: u64 = 10_000;
/// A discovery probe must never hold up the response for long.
pub const PROBE_TIMEOUT_MS: u64 = 2_000;

/// Liveness as reported to clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionServerStatus {
    Online,
    Offline,
    Unknown,
}

/// The realtime block of a server summary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RealtimeSummary {
    pub protocol: String,
    pub path: String,
    pub audio: RealtimeAudioFormat,
    /// Prefer `native-delta` over `synthesized-delta` over `utterance`.
    pub granularity: RealtimeGranularity,
}

/// The client-facing view of one server. Never carries a base URL or key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionServerSummary {
    pub id: String,
    pub label: String,
    pub model: String,
    pub capabilities: Vec<TranscriptionCapability>,
    /// True for the server a client should pick when it has no preference.
    pub default: bool,
    pub status: TranscriptionServerStatus,
    /// Why the status is not `online`; `None` when there is nothing to explain.
    pub detail: Option<String>,
    /// Provider id this server reports on batch results.
    pub batch_provider: Option<String>,
    pub realtime: Option<RealtimeSummary>,
}

/// A failed liveness request (transport error, timeout, ...).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ProbeError(pub String);

/// Issues `GET url` with an optional bearer token and returns the HTTP status.
#[async_trait]
pub trait HealthProbe: Send + Sync {
    async fn get(
        &self,
        url: &str,
        bearer: Option<&str>,
        timeout: Duration,
    ) -> Result<u16, ProbeError>;
}

/// Injectable dependencies (TS `TranscriptionRegistryDeps`).
#[derive(Clone)]
pub struct RegistryDeps {
    /// Liveness prober. `None` reports every server as `unknown`.
    pub probe: Option<Arc<dyn HealthProbe>>,
    /// Milliseconds clock.
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub probe_timeout_ms: u64,
    pub probe_cache_ms: u64,
    /// `OPENAI_BASE_URL`, used to resolve servers that declare no base URL.
    pub openai_base_url: Option<String>,
}

impl Default for RegistryDeps {
    fn default() -> Self {
        Self {
            probe: None,
            now: Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
                    .unwrap_or(0)
            }),
            probe_timeout_ms: PROBE_TIMEOUT_MS,
            probe_cache_ms: PROBE_CACHE_MS,
            openai_base_url: None,
        }
    }
}

impl RegistryDeps {
    /// Defaults plus a liveness prober.
    pub fn with_probe(probe: Arc<dyn HealthProbe>) -> Self {
        Self {
            probe: Some(probe),
            ..Self::default()
        }
    }
}

impl fmt::Debug for RegistryDeps {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegistryDeps")
            .field("probe", &self.probe.is_some())
            .field("probe_timeout_ms", &self.probe_timeout_ms)
            .field("probe_cache_ms", &self.probe_cache_ms)
            .field("openai_base_url", &self.openai_base_url)
            .finish()
    }
}

/// Registry lookup failures.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RegistryError {
    #[error("At least one transcription server must be configured.")]
    NoServers,
    #[error("Unknown transcription server \"{0}\".")]
    UnknownServer(String),
    #[error("Transcription server \"{id}\" does not support {capability}.")]
    Unsupported {
        id: String,
        capability: TranscriptionCapability,
    },
    #[error(transparent)]
    Config(#[from] ConfigError),
}

/// Which batch provider a server resolves to.
#[derive(Clone, PartialEq, Eq)]
pub enum BatchProviderSpec {
    /// An OpenAI-compatible endpoint at an explicit base URL.
    CustomBaseUrl {
        base_url: String,
        model: String,
        api_key: Option<String>,
    },
    /// The stock OpenAI endpoint.
    OpenAi {
        model: String,
        api_key: Option<String>,
    },
}

impl BatchProviderSpec {
    /// The provider id reported on results.
    pub fn name(&self) -> &'static str {
        match self {
            Self::CustomBaseUrl { .. } => CUSTOM_TRANSCRIPTION_PROVIDER_NAME,
            Self::OpenAi { .. } => OPENAI_TRANSCRIPTION_PROVIDER_NAME,
        }
    }

    /// The upload format check every OpenAI-compatible provider applies.
    pub fn supports_mimetype(&self, mimetype: &str) -> bool {
        is_supported_mimetype(mimetype)
    }
}

impl fmt::Debug for BatchProviderSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CustomBaseUrl {
                base_url,
                model,
                api_key,
            } => f
                .debug_struct("CustomBaseUrl")
                .field("base_url", base_url)
                .field("model", model)
                .field("api_key", &api_key.as_ref().map(|_| "<redacted>"))
                .finish(),
            Self::OpenAi { model, api_key } => f
                .debug_struct("OpenAi")
                .field("model", model)
                .field("api_key", &api_key.as_ref().map(|_| "<redacted>"))
                .finish(),
        }
    }
}

/// Where a server's realtime (OpenAI-Realtime WebSocket) session dials.
#[derive(Clone, PartialEq, Eq)]
pub struct RealtimeProviderSpec {
    /// Resolved base URL (server's own, else `OPENAI_BASE_URL`, else OpenAI).
    pub base_url: String,
    pub realtime_path: String,
    pub api_key: Option<String>,
}

impl RealtimeProviderSpec {
    pub fn name(&self) -> &'static str {
        OPENAI_REALTIME_PROVIDER_NAME
    }

    /// The generic OpenAI-Realtime provider declares no granularity of its own.
    pub fn granularity(&self) -> Option<RealtimeGranularity> {
        None
    }
}

impl fmt::Debug for RealtimeProviderSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RealtimeProviderSpec")
            .field("base_url", &self.base_url)
            .field("realtime_path", &self.realtime_path)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Debug, Clone)]
struct ProbeResult {
    status: TranscriptionServerStatus,
    detail: Option<String>,
    at: u64,
}

/// Owns the configured servers and resolves each capability to a provider.
pub struct TranscriptionServerRegistry {
    configs: Vec<TranscriptionServerConfig>,
    probes: Mutex<HashMap<String, ProbeResult>>,
    deps: RegistryDeps,
}

impl fmt::Debug for TranscriptionServerRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TranscriptionServerRegistry")
            .field("configs", &self.configs)
            .field("deps", &self.deps)
            .finish()
    }
}

impl TranscriptionServerRegistry {
    /// Fails on an empty list.
    pub fn new(
        configs: Vec<TranscriptionServerConfig>,
        deps: RegistryDeps,
    ) -> Result<Self, RegistryError> {
        if configs.is_empty() {
            return Err(RegistryError::NoServers);
        }
        Ok(Self {
            configs,
            probes: Mutex::new(HashMap::new()),
            deps,
        })
    }

    /// Built from the environment, failing fast. `deps.openai_base_url` is
    /// filled from `env` when unset.
    pub fn from_env(
        env: &TranscriptionServersEnv,
        mut deps: RegistryDeps,
    ) -> Result<Self, RegistryError> {
        if deps.openai_base_url.is_none() {
            deps.openai_base_url.clone_from(&env.openai_base_url);
        }
        Self::new(read_transcription_servers(env)?, deps)
    }

    pub fn list(&self) -> &[TranscriptionServerConfig] {
        &self.configs
    }

    pub fn get(&self, id: &str) -> Option<&TranscriptionServerConfig> {
        self.configs.iter().find(|c| c.id == id)
    }

    /// The server a client gets when it names none: the first configured entry.
    pub fn default_server(&self) -> &TranscriptionServerConfig {
        &self.configs[0]
    }

    pub fn supports(&self, id: &str, capability: TranscriptionCapability) -> bool {
        self.get(id)
            .is_some_and(|config| has_capability(config, capability))
    }

    /// The server `id`, provided it advertises `capability`.
    pub fn require_server(
        &self,
        id: &str,
        capability: TranscriptionCapability,
    ) -> Result<&TranscriptionServerConfig, RegistryError> {
        let config = self
            .get(id)
            .ok_or_else(|| RegistryError::UnknownServer(id.to_owned()))?;
        if !has_capability(config, capability) {
            return Err(RegistryError::Unsupported {
                id: id.to_owned(),
                capability,
            });
        }
        Ok(config)
    }

    /// Which batch provider serves `id`.
    pub fn batch_provider(&self, id: &str) -> Result<BatchProviderSpec, RegistryError> {
        let config = self.require_server(id, TranscriptionCapability::Batch)?;
        Ok(batch_spec(config))
    }

    /// Where a realtime session for `id` dials.
    pub fn realtime_provider(&self, id: &str) -> Result<RealtimeProviderSpec, RegistryError> {
        let config = self.require_server(id, TranscriptionCapability::Realtime)?;
        Ok(self.realtime_spec(config))
    }

    fn realtime_spec(&self, config: &TranscriptionServerConfig) -> RealtimeProviderSpec {
        RealtimeProviderSpec {
            base_url: resolve_base_url_with(config, self.deps.openai_base_url.as_deref()),
            realtime_path: config.realtime_path.clone(),
            api_key: config.api_key.clone(),
        }
    }

    /// The client-facing view: every configured server, probed concurrently,
    /// including broken ones.
    pub async fn describe(&self) -> Vec<TranscriptionServerSummary> {
        let futures = self
            .configs
            .iter()
            .enumerate()
            .map(|(index, config)| self.describe_one(config, index == 0));
        futures_util::future::join_all(futures).await
    }

    async fn describe_one(
        &self,
        config: &TranscriptionServerConfig,
        is_default: bool,
    ) -> TranscriptionServerSummary {
        let ProbeResult { status, detail, .. } = self.probe(config).await;

        let realtime = has_capability(config, TranscriptionCapability::Realtime).then(|| {
            let spec = self.realtime_spec(config);
            RealtimeSummary {
                protocol: spec.name().to_owned(),
                path: format!(
                    "{REALTIME_STREAM_PATH}?server={}",
                    encode_uri_component(&config.id)
                ),
                audio: REALTIME_AUDIO_FORMAT,
                granularity: resolve_granularity(config, spec.granularity()),
            }
        });

        TranscriptionServerSummary {
            id: config.id.clone(),
            label: config.label.clone(),
            model: config.model.clone(),
            capabilities: config.capabilities.clone(),
            default: is_default,
            status,
            detail,
            batch_provider: has_capability(config, TranscriptionCapability::Batch)
                .then(|| batch_spec(config).name().to_owned()),
            realtime,
        }
    }

    /// Only servers with an explicit base URL are probed: the stock OpenAI
    /// entry would need a live credential and a billable round trip.
    async fn probe(&self, config: &TranscriptionServerConfig) -> ProbeResult {
        let now = (self.deps.now)();
        let (Some(base_url), Some(prober)) = (&config.base_url, &self.deps.probe) else {
            let detail = if config.base_url.is_none() {
                "No base URL configured; liveness of the default OpenAI endpoint is not probed."
            } else {
                "No health probe configured; liveness is not probed."
            };
            return ProbeResult {
                status: TranscriptionServerStatus::Unknown,
                detail: Some(detail.to_owned()),
                at: now,
            };
        };

        if let Some(cached) = self.lock_probes().get(&config.id) {
            if now.saturating_sub(cached.at) < self.deps.probe_cache_ms {
                return cached.clone();
            }
        }

        let at = now;
        let result = match prober
            .get(
                &format!("{base_url}/models"),
                config.api_key.as_deref(),
                Duration::from_millis(self.deps.probe_timeout_ms),
            )
            .await
        {
            Ok(code) if (200..300).contains(&code) => ProbeResult {
                status: TranscriptionServerStatus::Online,
                detail: None,
                at,
            },
            Ok(code) => ProbeResult {
                status: TranscriptionServerStatus::Offline,
                detail: Some(format!("Health probe returned HTTP {code}.")),
                at,
            },
            Err(error) => ProbeResult {
                status: TranscriptionServerStatus::Offline,
                detail: Some(format!("Health probe failed: {error}")),
                at,
            },
        };
        self.lock_probes().insert(config.id.clone(), result.clone());
        result
    }

    fn lock_probes(&self) -> std::sync::MutexGuard<'_, HashMap<String, ProbeResult>> {
        // A poisoned cache only ever holds plain data; keep using it.
        self.probes.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn batch_spec(config: &TranscriptionServerConfig) -> BatchProviderSpec {
    match &config.base_url {
        Some(base_url) => BatchProviderSpec::CustomBaseUrl {
            base_url: base_url.clone(),
            model: config.model.clone(),
            api_key: config.api_key.clone(),
        },
        None => BatchProviderSpec::OpenAi {
            model: config.model.clone(),
            api_key: config.api_key.clone(),
        },
    }
}

/// The granularity reported to clients for a realtime-capable server.
///
/// The operator's explicit declaration wins; then a natively-streaming
/// provider; then configured synthesis; then the provider's own value, else
/// `utterance`.
pub fn resolve_granularity(
    config: &TranscriptionServerConfig,
    provider_granularity: Option<RealtimeGranularity>,
) -> RealtimeGranularity {
    if let Some(declared) = config.granularity {
        return declared;
    }
    if provider_granularity == Some(RealtimeGranularity::NativeDelta) {
        return RealtimeGranularity::NativeDelta;
    }
    if config.synthesize_deltas {
        return RealtimeGranularity::SynthesizedDelta;
    }
    provider_granularity.unwrap_or(RealtimeGranularity::Utterance)
}

/// JavaScript's `encodeURIComponent`.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
