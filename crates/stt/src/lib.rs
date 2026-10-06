//! whispera-stt: the pure logic behind Whispera's transcription servers.
//!
//! Ported from the TypeScript backend (`src/services/transcription/**`):
//!
//! - [`servers`]: parsing and validating the multi-server `TRANSCRIPTION_SERVERS`
//!   config (or the legacy single-server `TRANSCRIPTION_*` vars), defaults, and
//!   the optional per-server realtime granularity declaration.
//! - [`registry`]: lookup/selection over the configured servers, which provider
//!   shape each capability resolves to, granularity resolution and the
//!   client-facing discovery view (liveness probing is abstracted behind
//!   [`registry::HealthProbe`]).
//! - [`local_agreement`]: the LocalAgreement-2 commit policy.
//! - [`delta_synthesizer`]: the synthesized-delta state machine, driven by any
//!   [`types::TranscriptionProvider`].
//! - [`wav`]: PCM16 -> WAV wrapping used by the synthesizer.
//!
//! No HTTP, WebSocket or OpenAI client code lives here.

pub mod delta_synthesizer;
pub mod local_agreement;
pub mod registry;
pub mod servers;
pub mod types;
pub mod wav;

pub use delta_synthesizer::{
    DeltaSynthesizer, DeltaSynthesizerOptions, SynthesizerCore, TickRequest,
};
pub use local_agreement::{advance_local_agreement, tokenize, AgreementState, AgreementStep};
pub use registry::{
    resolve_granularity, BatchProviderSpec, HealthProbe, ProbeError, RealtimeAudioFormat,
    RealtimeProviderSpec, RealtimeSummary, RegistryDeps, RegistryError,
    TranscriptionServerRegistry, TranscriptionServerStatus, TranscriptionServerSummary,
    REALTIME_AUDIO_FORMAT,
};
pub use servers::{
    has_capability, read_transcription_servers, resolve_base_url, ConfigError,
    TranscriptionCapability, TranscriptionServerConfig, TranscriptionServersEnv,
};
pub use types::{
    is_supported_mimetype, RealtimeFrame, RealtimeGranularity, TranscriptionError,
    TranscriptionProvider, TranscriptionRequest, TranscriptionResult,
};
pub use wav::pcm16_to_wav;
