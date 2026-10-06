//! Transcription server configuration (port of `servers.ts`).
//!
//! Reads `TRANSCRIPTION_SERVERS` (a JSON array of server entries) or, when it
//! is unset, rebuilds the legacy single-server `TRANSCRIPTION_*` configuration
//! as a one-entry list. Validation is strict and fails at boot.

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::types::{
    RealtimeGranularity, CUSTOM_TRANSCRIPTION_PROVIDER_NAME, DEFAULT_TRANSCRIPTION_MODEL,
    OPENAI_TRANSCRIPTION_PROVIDER_NAME,
};

/// Id given to the entry synthesised from the single-server vars.
pub const DEFAULT_SERVER_ID: &str = "default";

/// Path appended to a server's base URL for the WebSocket upgrade.
///
/// No trailing slash, deliberately: speaches answers HTTP 500 to an upgrade on
/// `/v1/realtime/`. Overridable per server.
pub const DEFAULT_REALTIME_PATH: &str = "/realtime";

/// Fallback when a server declares no base URL and `OPENAI_BASE_URL` is unset.
pub const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// What a configured server can be asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionCapability {
    /// `POST /transcribe`.
    Batch,
    /// The WebSocket proxy.
    Realtime,
}

impl TranscriptionCapability {
    pub const ALL: [TranscriptionCapability; 2] = [Self::Batch, Self::Realtime];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Batch => "batch",
            Self::Realtime => "realtime",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == value)
    }
}

impl fmt::Display for TranscriptionCapability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One configured transcription server, with defaults applied.
#[derive(Clone, PartialEq, Eq)]
pub struct TranscriptionServerConfig {
    /// Stable key the client passes to `/transcription/stream`. Unique.
    pub id: String,
    /// Human-facing name for a server picker.
    pub label: String,
    /// OpenAI-compatible root without a trailing slash. `None` means the stock
    /// OpenAI endpoint.
    pub base_url: Option<String>,
    /// Per-server key override. Never leaves the process.
    pub api_key: Option<String>,
    pub model: String,
    pub capabilities: Vec<TranscriptionCapability>,
    pub realtime_path: String,
    /// Opt-in synthesized-delta mode. Only ever true when `batch` is configured.
    pub synthesize_deltas: bool,
    /// Explicit granularity override; wins over derivation when set.
    pub granularity: Option<RealtimeGranularity>,
}

impl fmt::Debug for TranscriptionServerConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TranscriptionServerConfig")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("model", &self.model)
            .field("capabilities", &self.capabilities)
            .field("realtime_path", &self.realtime_path)
            .field("synthesize_deltas", &self.synthesize_deltas)
            .field("granularity", &self.granularity)
            .finish()
    }
}

/// The environment variables the server list is read from.
///
/// Built from a lookup function so tests never touch the process environment.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct TranscriptionServersEnv {
    pub transcription_servers: Option<String>,
    pub transcription_provider: Option<String>,
    pub transcription_base_url: Option<String>,
    pub transcription_api_key: Option<String>,
    pub transcription_model: Option<String>,
    pub openai_base_url: Option<String>,
}

impl fmt::Debug for TranscriptionServersEnv {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let redact = |v: &Option<String>| v.as_ref().map(|_| "<redacted>");
        f.debug_struct("TranscriptionServersEnv")
            // May embed per-server API keys.
            .field(
                "transcription_servers",
                &redact(&self.transcription_servers),
            )
            .field("transcription_provider", &self.transcription_provider)
            .field("transcription_base_url", &self.transcription_base_url)
            .field(
                "transcription_api_key",
                &redact(&self.transcription_api_key),
            )
            .field("transcription_model", &self.transcription_model)
            .field("openai_base_url", &self.openai_base_url)
            .finish()
    }
}

impl TranscriptionServersEnv {
    /// Reads every variable through `lookup` (variable name -> value).
    pub fn from_lookup<F>(lookup: F) -> Self
    where
        F: Fn(&str) -> Option<String>,
    {
        Self {
            transcription_servers: lookup("TRANSCRIPTION_SERVERS"),
            transcription_provider: lookup("TRANSCRIPTION_PROVIDER"),
            transcription_base_url: lookup("TRANSCRIPTION_BASE_URL"),
            transcription_api_key: lookup("TRANSCRIPTION_API_KEY"),
            transcription_model: lookup("TRANSCRIPTION_MODEL"),
            openai_base_url: lookup("OPENAI_BASE_URL"),
        }
    }

    /// Reads every variable from a name -> value map.
    pub fn from_map(map: &HashMap<String, String>) -> Self {
        Self::from_lookup(|name| map.get(name).cloned())
    }

    /// Reads every variable from the process environment.
    pub fn from_process_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Convenience for a `TRANSCRIPTION_SERVERS`-only environment.
    pub fn with_servers(json: impl Into<String>) -> Self {
        Self {
            transcription_servers: Some(json.into()),
            ..Self::default()
        }
    }
}

/// Why the server configuration was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error(
        "TRANSCRIPTION_SERVERS must be a JSON array of server objects; it did not parse as JSON."
    )]
    InvalidJson,
    #[error("TRANSCRIPTION_SERVERS is not a valid server list: {0}.")]
    InvalidList(String),
    #[error("TRANSCRIPTION_SERVERS contains duplicate server id \"{0}\".")]
    DuplicateId(String),
    #[error("TRANSCRIPTION_BASE_URL is required when TRANSCRIPTION_PROVIDER is \"custom\".")]
    MissingLegacyBaseUrl,
    #[error("{context} must be a valid URL, got \"{raw}\".")]
    InvalidUrl { context: String, raw: String },
    #[error("{context} must be an http(s) URL, got \"{raw}\".")]
    NonHttpUrl { context: String, raw: String },
    #[error(
        "TRANSCRIPTION_SERVERS[{0}].synthesizeDeltas requires the \"batch\" capability, \
         since synthesis re-transcribes through the server's own batch endpoint."
    )]
    SynthesisWithoutBatch(String),
}

/// Trimmed, non-empty, or `None` (zod's `trimmed.safeParse`).
fn read_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// Rejects anything that is not an http(s) URL and strips trailing slashes.
///
/// WHATWG parsing reads `localhost:8000` as a custom scheme rather than failing,
/// which would silently produce an unreachable endpoint, hence the scheme check.
fn assert_http_url(raw: &str, context: &str) -> Result<String, ConfigError> {
    let parsed = url::Url::parse(raw).map_err(|_| ConfigError::InvalidUrl {
        context: context.to_owned(),
        raw: raw.to_owned(),
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ConfigError::NonHttpUrl {
            context: context.to_owned(),
            raw: raw.to_owned(),
        });
    }
    Ok(raw.trim_end_matches('/').to_owned())
}

/// A validated entry before defaults (the zod schema's output).
#[derive(Debug, Default)]
struct ServerEntry {
    id: String,
    label: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    capabilities: Option<Vec<TranscriptionCapability>>,
    realtime_path: Option<String>,
    synthesize_deltas: Option<bool>,
    granularity: Option<RealtimeGranularity>,
}

const ENTRY_KEYS: &[&str] = &[
    "id",
    "label",
    "baseUrl",
    "apiKey",
    "model",
    "capabilities",
    "realtimePath",
    "synthesizeDeltas",
    "granularity",
];

struct Issues(Vec<String>);

impl Issues {
    fn push(&mut self, path: &str, message: impl Into<String>) {
        let path = if path.is_empty() { "(root)" } else { path };
        self.0.push(format!("{path}: {}", message.into()));
    }
}

fn trimmed_string(
    obj: &Map<String, Value>,
    key: &str,
    path: &str,
    required: bool,
    issues: &mut Issues,
) -> Option<String> {
    let field_path = format!("{path}.{key}");
    match obj.get(key) {
        None if required => {
            issues.push(&field_path, "Required");
            None
        }
        None => None,
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                issues.push(&field_path, "String must contain at least 1 character(s)");
                None
            } else {
                Some(t.to_owned())
            }
        }
        Some(_) => {
            issues.push(&field_path, "Expected string");
            None
        }
    }
}

fn validate_entry(value: &Value, index: usize, issues: &mut Issues) -> Option<ServerEntry> {
    let path = index.to_string();
    let Value::Object(obj) = value else {
        issues.push(&path, "Expected object");
        return None;
    };
    let before = issues.0.len();

    let unknown: Vec<String> = obj
        .keys()
        .filter(|k| !ENTRY_KEYS.contains(&k.as_str()))
        .map(|k| format!("'{k}'"))
        .collect();
    if !unknown.is_empty() {
        issues.push(
            &path,
            format!("Unrecognized key(s) in object: {}", unknown.join(", ")),
        );
    }

    let mut entry = ServerEntry {
        id: trimmed_string(obj, "id", &path, true, issues).unwrap_or_default(),
        label: trimmed_string(obj, "label", &path, false, issues),
        base_url: trimmed_string(obj, "baseUrl", &path, false, issues),
        api_key: trimmed_string(obj, "apiKey", &path, false, issues),
        model: trimmed_string(obj, "model", &path, false, issues),
        realtime_path: trimmed_string(obj, "realtimePath", &path, false, issues),
        ..ServerEntry::default()
    };

    match obj.get("capabilities") {
        None => {}
        Some(Value::Array(items)) => {
            let mut caps = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                match item.as_str().and_then(TranscriptionCapability::parse) {
                    Some(cap) => caps.push(cap),
                    None => issues.push(
                        &format!("{path}.capabilities.{i}"),
                        "Invalid enum value. Expected 'batch' | 'realtime'",
                    ),
                }
            }
            if items.is_empty() {
                issues.push(
                    &format!("{path}.capabilities"),
                    "Array must contain at least 1 element(s)",
                );
            }
            entry.capabilities = Some(caps);
        }
        Some(_) => issues.push(&format!("{path}.capabilities"), "Expected array"),
    }

    match obj.get("synthesizeDeltas") {
        None => {}
        Some(Value::Bool(b)) => entry.synthesize_deltas = Some(*b),
        Some(_) => issues.push(&format!("{path}.synthesizeDeltas"), "Expected boolean"),
    }

    match obj.get("granularity") {
        None => {}
        Some(v) => match v.as_str().and_then(RealtimeGranularity::parse) {
            Some(g) => entry.granularity = Some(g),
            None => issues.push(
                &format!("{path}.granularity"),
                "Invalid enum value. Expected 'native-delta' | 'synthesized-delta' | 'utterance'",
            ),
        },
    }

    (issues.0.len() == before).then_some(entry)
}

fn validate_list(value: &Value) -> Result<Vec<ServerEntry>, ConfigError> {
    let mut issues = Issues(Vec::new());
    let Value::Array(items) = value else {
        issues.push("", "Expected array");
        return Err(ConfigError::InvalidList(issues.0.join("; ")));
    };
    if items.is_empty() {
        issues.push("", "Array must contain at least 1 element(s)");
    }
    let entries: Vec<ServerEntry> = items
        .iter()
        .enumerate()
        .filter_map(|(i, item)| validate_entry(item, i, &mut issues))
        .collect();
    if issues.0.is_empty() {
        Ok(entries)
    } else {
        Err(ConfigError::InvalidList(issues.0.join("; ")))
    }
}

fn to_config(entry: ServerEntry) -> Result<TranscriptionServerConfig, ConfigError> {
    let base_url = entry
        .base_url
        .as_deref()
        .map(|raw| assert_http_url(raw, &format!("TRANSCRIPTION_SERVERS[{}].baseUrl", entry.id)))
        .transpose()?;
    let capabilities = entry
        .capabilities
        .unwrap_or_else(|| vec![TranscriptionCapability::Batch]);
    let synthesize_deltas = entry.synthesize_deltas.unwrap_or(false);

    if synthesize_deltas && !capabilities.contains(&TranscriptionCapability::Batch) {
        return Err(ConfigError::SynthesisWithoutBatch(entry.id));
    }

    Ok(TranscriptionServerConfig {
        label: entry.label.unwrap_or_else(|| entry.id.clone()),
        id: entry.id,
        base_url,
        api_key: entry.api_key,
        model: entry
            .model
            .unwrap_or_else(|| DEFAULT_TRANSCRIPTION_MODEL.to_owned()),
        capabilities,
        realtime_path: entry
            .realtime_path
            .unwrap_or_else(|| DEFAULT_REALTIME_PATH.to_owned()),
        synthesize_deltas,
        granularity: entry.granularity,
    })
}

/// Rebuilds the single-server `TRANSCRIPTION_*` config as a one-entry list.
///
/// Only `batch` is advertised: nothing in the legacy env says an endpoint speaks
/// the Realtime API.
fn synthesise_legacy_server(
    env: &TranscriptionServersEnv,
) -> Result<TranscriptionServerConfig, ConfigError> {
    let provider = read_optional(env.transcription_provider.as_deref()).map(|p| p.to_lowercase());
    let api_key = read_optional(env.transcription_api_key.as_deref());
    let model = read_optional(env.transcription_model.as_deref())
        .unwrap_or_else(|| DEFAULT_TRANSCRIPTION_MODEL.to_owned());

    let (label, base_url) = if provider.as_deref() == Some("custom") {
        let raw = read_optional(env.transcription_base_url.as_deref())
            .ok_or(ConfigError::MissingLegacyBaseUrl)?;
        (
            CUSTOM_TRANSCRIPTION_PROVIDER_NAME,
            Some(assert_http_url(&raw, "TRANSCRIPTION_BASE_URL")?),
        )
    } else {
        (OPENAI_TRANSCRIPTION_PROVIDER_NAME, None)
    };

    Ok(TranscriptionServerConfig {
        id: DEFAULT_SERVER_ID.to_owned(),
        label: label.to_owned(),
        base_url,
        api_key,
        model,
        capabilities: vec![TranscriptionCapability::Batch],
        realtime_path: DEFAULT_REALTIME_PATH.to_owned(),
        synthesize_deltas: false,
        granularity: None,
    })
}

/// Reads the configured transcription servers.
///
/// Fails on malformed JSON, a failed schema check, duplicate ids and unusable
/// base URLs, so a typo fails at boot rather than on the first upload.
pub fn read_transcription_servers(
    env: &TranscriptionServersEnv,
) -> Result<Vec<TranscriptionServerConfig>, ConfigError> {
    let Some(raw) = read_optional(env.transcription_servers.as_deref()) else {
        return Ok(vec![synthesise_legacy_server(env)?]);
    };

    let parsed: Value = serde_json::from_str(&raw).map_err(|_| ConfigError::InvalidJson)?;
    let configs = validate_list(&parsed)?
        .into_iter()
        .map(to_config)
        .collect::<Result<Vec<_>, _>>()?;

    let mut seen = HashSet::new();
    for config in &configs {
        if !seen.insert(config.id.as_str()) {
            return Err(ConfigError::DuplicateId(config.id.clone()));
        }
    }
    Ok(configs)
}

/// The endpoint a server's requests actually go to, once defaults are applied.
pub fn resolve_base_url(
    config: &TranscriptionServerConfig,
    env: &TranscriptionServersEnv,
) -> String {
    resolve_base_url_with(config, env.openai_base_url.as_deref())
}

/// [`resolve_base_url`] given the raw `OPENAI_BASE_URL` value.
pub fn resolve_base_url_with(
    config: &TranscriptionServerConfig,
    openai_base_url: Option<&str>,
) -> String {
    config
        .base_url
        .clone()
        .or_else(|| read_optional(openai_base_url))
        .unwrap_or_else(|| OPENAI_DEFAULT_BASE_URL.to_owned())
}

/// True if the server advertises `capability`.
pub fn has_capability(
    config: &TranscriptionServerConfig,
    capability: TranscriptionCapability,
) -> bool {
    config.capabilities.contains(&capability)
}
