//! Shared transcription types (ports of `types.ts`, `realtime/types.ts` and
//! `mimetypes.ts`).

use std::fmt;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Provider id reported by the stock OpenAI batch provider.
pub const OPENAI_TRANSCRIPTION_PROVIDER_NAME: &str = "openai-whisper";
/// Provider id reported by a batch provider pointed at a custom base URL.
pub const CUSTOM_TRANSCRIPTION_PROVIDER_NAME: &str = "openai-compatible";
/// Provider id reported by the OpenAI-Realtime WebSocket provider.
pub const OPENAI_REALTIME_PROVIDER_NAME: &str = "openai-realtime";
/// Model used when a server names none.
pub const DEFAULT_TRANSCRIPTION_MODEL: &str = "whisper-1";

/// Formats the OpenAI audio API accepts.
pub const SUPPORTED_MIMETYPES: &[&str] = &[
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/x-m4a",
    "audio/m4a",
    "audio/webm",
    "audio/ogg",
];

/// True if `mimetype` is one the OpenAI audio API accepts.
pub fn is_supported_mimetype(mimetype: &str) -> bool {
    SUPPORTED_MIMETYPES.contains(&mimetype)
}

/// One WebSocket frame, with the text/binary distinction preserved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RealtimeFrame {
    Text(String),
    Binary(Vec<u8>),
}

impl RealtimeFrame {
    /// Builds a text frame.
    pub fn text(data: impl Into<String>) -> Self {
        Self::Text(data.into())
    }

    /// True for a binary frame.
    pub fn is_binary(&self) -> bool {
        matches!(self, Self::Binary(_))
    }
}

/// How early a realtime engine can produce useful text, in order of
/// preference for a client auto-choosing a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RealtimeGranularity {
    /// The engine emits its own transcription delta frames.
    NativeDelta,
    /// The proxy re-transcribes the growing buffer and emits
    /// LocalAgreement-2-confirmed deltas (see `DeltaSynthesizer`).
    SynthesizedDelta,
    /// Text arrives only once the engine finalises the turn.
    Utterance,
}

impl RealtimeGranularity {
    /// All values, in order of preference.
    pub const ALL: [RealtimeGranularity; 3] =
        [Self::NativeDelta, Self::SynthesizedDelta, Self::Utterance];

    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NativeDelta => "native-delta",
            Self::SynthesizedDelta => "synthesized-delta",
            Self::Utterance => "utterance",
        }
    }

    /// Parses the wire spelling.
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|g| g.as_str() == value)
    }
}

impl fmt::Display for RealtimeGranularity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Audio in for a batch transcription.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptionRequest {
    pub audio: Vec<u8>,
    pub mimetype: String,
    pub language: Option<String>,
}

/// Transcript out of a batch transcription.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptionResult {
    pub text: String,
    pub language: String,
    pub duration: f64,
    pub provider: String,
}

/// A batch transcription failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TranscriptionError {
    pub message: String,
}

impl TranscriptionError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// The batch contract: audio bytes in, transcript out.
#[async_trait]
pub trait TranscriptionProvider: Send + Sync {
    /// Value reported as `provider` on every result.
    fn name(&self) -> &str;

    /// Cheap format check performed before the upload is spent.
    fn supports_mimetype(&self, mimetype: &str) -> bool {
        is_supported_mimetype(mimetype)
    }

    async fn transcribe(
        &self,
        request: TranscriptionRequest,
    ) -> Result<TranscriptionResult, TranscriptionError>;
}
