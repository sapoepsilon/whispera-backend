//! Synthesized deltas (port of `realtime/delta-synthesizer.ts`).
//!
//! Observes the frames a realtime bridge relays (client audio in, engine
//! events out) and, on its own schedule, re-transcribes the growing utterance
//! buffer through the server's batch endpoint, running LocalAgreement-2 over
//! consecutive hypotheses. Newly agreed text goes to the client as synthesized
//! `conversation.item.input_audio_transcription.delta` frames.
//!
//! Split in two:
//! - [`SynthesizerCore`]: the synchronous state machine. A tick is
//!   [`SynthesizerCore::begin_tick`] (yields the WAV to transcribe) followed by
//!   [`SynthesizerCore::finish_tick`] (feeds the result back). No I/O.
//! - [`DeltaSynthesizer`]: the async driver that calls a
//!   [`TranscriptionProvider`] and runs the timer on tokio.
//!
//! Every failure degrades to doing nothing: a batch error disables synthesis
//! for the rest of the instance (logged once), a full buffer stops growing,
//! and a tick while a request is in flight is skipped.

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine as _;
use serde_json::{json, Value};
use tokio::task::JoinHandle;

use crate::local_agreement::{advance_local_agreement, AgreementState};
use crate::types::{RealtimeFrame, TranscriptionProvider, TranscriptionRequest};
use crate::wav::pcm16_to_wav;

/// The engine's authoritative final for a turn. Resets synthesis state.
pub const ENGINE_TRANSCRIPTION_COMPLETED: &str =
    "conversation.item.input_audio_transcription.completed";
/// The only client frame type synthesis reads.
pub const CLIENT_AUDIO_APPEND: &str = "input_audio_buffer.append";
/// Event type synthesized deltas are sent as.
pub const SYNTHESIZED_DELTA_TYPE: &str = "conversation.item.input_audio_transcription.delta";

pub const DEFAULT_TICK_MS: u64 = 1_000;
pub const DEFAULT_MAX_UTTERANCE_MS: u64 = 60_000;
const BYTES_PER_SAMPLE: u64 = 2;

/// Lenient like Node's `Buffer.from(s, 'base64')` about padding.
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// Synthesizer settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeltaSynthesizerOptions {
    /// Must match what the client was told to send in `realtime.audio`.
    pub sample_rate: u32,
    pub channels: u16,
    /// How often the accumulated buffer is re-transcribed.
    pub tick: Duration,
    /// Per-utterance audio cap; synthesis freezes rather than growing forever.
    pub max_utterance_ms: u64,
    /// Free-form label attached to the one failure log line (e.g. session id).
    pub context: Option<String>,
}

impl DeltaSynthesizerOptions {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            channels: 1,
            tick: Duration::from_millis(DEFAULT_TICK_MS),
            max_utterance_ms: DEFAULT_MAX_UTTERANCE_MS,
            context: None,
        }
    }
}

/// Audio to re-transcribe for one tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TickRequest {
    /// Hand back to [`SynthesizerCore::finish_tick`] unchanged.
    pub generation: u64,
    /// The whole utterance buffer so far, as a WAV file.
    pub wav: Vec<u8>,
}

/// Source of random ids (uuid v4 strings by default).
pub type IdSource = Box<dyn FnMut() -> String + Send>;

/// The synchronous synthesized-delta state machine.
pub struct SynthesizerCore {
    sample_rate: u32,
    channels: u16,
    max_bytes: usize,
    context: Option<String>,
    pcm: Vec<u8>,
    agreement: AgreementState,
    item_id: String,
    /// Bumped on reset so a batch response for an abandoned utterance is dropped.
    generation: u64,
    in_flight: bool,
    disabled: bool,
    logged_failure: bool,
    ids: IdSource,
}

impl fmt::Debug for SynthesizerCore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SynthesizerCore")
            .field("sample_rate", &self.sample_rate)
            .field("channels", &self.channels)
            .field("max_bytes", &self.max_bytes)
            .field("buffered_bytes", &self.pcm.len())
            .field("agreement", &self.agreement)
            .field("item_id", &self.item_id)
            .field("generation", &self.generation)
            .field("in_flight", &self.in_flight)
            .field("disabled", &self.disabled)
            .finish()
    }
}

/// A random RFC 4122 v4 uuid string.
pub fn random_uuid() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn parse_json_frame(frame: &RealtimeFrame) -> Option<serde_json::Map<String, Value>> {
    match frame {
        RealtimeFrame::Binary(_) => None,
        RealtimeFrame::Text(text) => match serde_json::from_str(text) {
            Ok(Value::Object(obj)) => Some(obj),
            _ => None,
        },
    }
}

fn frame_type(obj: &serde_json::Map<String, Value>) -> Option<&str> {
    obj.get("type").and_then(Value::as_str)
}

impl SynthesizerCore {
    pub fn new(options: &DeltaSynthesizerOptions) -> Self {
        Self::with_id_source(options, Box::new(random_uuid))
    }

    /// Like [`SynthesizerCore::new`] with a deterministic id source (tests).
    pub fn with_id_source(options: &DeltaSynthesizerOptions, mut ids: IdSource) -> Self {
        let max_seconds = options.max_utterance_ms as f64 / 1000.0;
        let max_bytes = (max_seconds
            * f64::from(options.sample_rate)
            * f64::from(options.channels)
            * BYTES_PER_SAMPLE as f64)
            .floor();
        // Saturating float -> int conversion is the intent here.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let max_bytes = max_bytes as usize;
        Self {
            sample_rate: options.sample_rate,
            channels: options.channels,
            max_bytes,
            context: options.context.clone(),
            pcm: Vec::new(),
            agreement: AgreementState::initial(),
            item_id: ids(),
            generation: 0,
            in_flight: false,
            disabled: false,
            logged_failure: false,
            ids,
        }
    }

    /// Feed every frame relayed client -> engine. Read-only with respect to
    /// the relay: it never influences forwarding.
    pub fn on_client_frame(&mut self, frame: &RealtimeFrame) {
        if self.disabled {
            return;
        }
        let Some(parsed) = parse_json_frame(frame) else {
            return;
        };
        if frame_type(&parsed) != Some(CLIENT_AUDIO_APPEND) {
            return;
        }
        let Some(audio) = parsed.get("audio").and_then(Value::as_str) else {
            return;
        };
        if audio.is_empty() || self.pcm.len() >= self.max_bytes {
            return; // nothing to add, or capped: this utterance stops growing
        }
        let Ok(pcm) = BASE64.decode(audio) else {
            return;
        };
        if pcm.is_empty() {
            return;
        }
        let room = self.max_bytes - self.pcm.len();
        let take = pcm.len().min(room);
        self.pcm.extend_from_slice(&pcm[..take]);
    }

    /// Feed every frame relayed engine -> client. Never delays or drops it.
    pub fn on_engine_frame(&mut self, frame: &RealtimeFrame) {
        if parse_json_frame(frame)
            .as_ref()
            .and_then(frame_type)
            .is_some_and(|t| t == ENGINE_TRANSCRIPTION_COMPLETED)
        {
            self.reset();
        }
    }

    /// Drops the current utterance's buffer and agreement state.
    fn reset(&mut self) {
        self.pcm.clear();
        self.agreement = AgreementState::initial();
        self.item_id = (self.ids)();
        self.generation += 1;
    }

    /// Starts a tick: `None` when disabled, a request is already in flight, or
    /// there is no audio. Otherwise marks a request in flight.
    pub fn begin_tick(&mut self) -> Option<TickRequest> {
        if self.disabled || self.in_flight || self.pcm.is_empty() {
            return None;
        }
        self.in_flight = true;
        Some(TickRequest {
            generation: self.generation,
            wav: pcm16_to_wav(&self.pcm, self.sample_rate, self.channels),
        })
    }

    /// Completes a tick with the batch result (`Ok(text)`) or failure.
    ///
    /// Returns the synthesized delta frame to send, if any. A failure disables
    /// the synthesizer; it is logged once. A result for an utterance that has
    /// since been reset is dropped.
    pub fn finish_tick<E: fmt::Display>(
        &mut self,
        generation: u64,
        result: Result<&str, E>,
    ) -> Option<RealtimeFrame> {
        self.in_flight = false;
        match result {
            Ok(text) => {
                if generation != self.generation {
                    return None;
                }
                self.apply_hypothesis(text)
            }
            Err(error) => {
                self.disabled = true;
                if !self.logged_failure {
                    self.logged_failure = true;
                    tracing::warn!(
                        context = self.context.as_deref().unwrap_or(""),
                        error = %error,
                        "synthesized-delta re-transcription failed; this session falls back to \
                         utterance-level granularity from the engine"
                    );
                }
                None
            }
        }
    }

    fn apply_hypothesis(&mut self, text: &str) -> Option<RealtimeFrame> {
        let step = advance_local_agreement(&self.agreement, text);
        self.agreement = step.state;
        if step.delta.is_empty() {
            return None;
        }
        let event_id = format!("evt_synth_{}", (self.ids)());
        Some(RealtimeFrame::Text(
            json!({
                "type": SYNTHESIZED_DELTA_TYPE,
                // Synthetic ids: no real conversation item exists yet at this
                // point in the turn.
                "event_id": event_id,
                "item_id": format!("item_synth_{}", self.item_id),
                "content_index": 0,
                "delta": step.delta,
            })
            .to_string(),
        ))
    }

    pub fn is_disabled(&self) -> bool {
        self.disabled
    }

    pub fn is_in_flight(&self) -> bool {
        self.in_flight
    }

    pub fn buffered_bytes(&self) -> usize {
        self.pcm.len()
    }

    pub fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The confirmed transcript of the current utterance.
    pub fn confirmed_text(&self) -> String {
        self.agreement.confirmed_text()
    }
}

/// Pushes a frame toward the client, bypassing the bridge's relay path.
pub type FrameSink = Arc<dyn Fn(RealtimeFrame) + Send + Sync>;

/// Async driver: re-transcribes through `provider` on a tokio interval.
pub struct DeltaSynthesizer {
    core: Mutex<SynthesizerCore>,
    provider: Arc<dyn TranscriptionProvider>,
    send: FrameSink,
    tick: Duration,
    timer: Mutex<Option<JoinHandle<()>>>,
}

impl fmt::Debug for DeltaSynthesizer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeltaSynthesizer")
            .field("core", &self.core)
            .field("tick", &self.tick)
            .finish_non_exhaustive()
    }
}

impl DeltaSynthesizer {
    pub fn new(
        provider: Arc<dyn TranscriptionProvider>,
        send: FrameSink,
        options: &DeltaSynthesizerOptions,
    ) -> Arc<Self> {
        Self::from_core(provider, send, SynthesizerCore::new(options), options.tick)
    }

    /// Wraps a prepared core (e.g. one with a deterministic id source).
    pub fn from_core(
        provider: Arc<dyn TranscriptionProvider>,
        send: FrameSink,
        core: SynthesizerCore,
        tick: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            core: Mutex::new(core),
            provider,
            send,
            tick,
            timer: Mutex::new(None),
        })
    }

    fn core(&self) -> MutexGuard<'_, SynthesizerCore> {
        self.core.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn timer(&self) -> MutexGuard<'_, Option<JoinHandle<()>>> {
        self.timer.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn on_client_frame(&self, frame: &RealtimeFrame) {
        self.core().on_client_frame(frame);
    }

    pub fn on_engine_frame(&self, frame: &RealtimeFrame) {
        self.core().on_engine_frame(frame);
    }

    pub fn is_disabled(&self) -> bool {
        self.core().is_disabled()
    }

    /// Runs one re-transcription pass now (what the timer does each period).
    pub async fn tick(&self) {
        let Some(request) = self.core().begin_tick() else {
            return;
        };
        let result = self
            .provider
            .transcribe(TranscriptionRequest {
                audio: request.wav,
                mimetype: "audio/wav".to_owned(),
                language: None,
            })
            .await;
        let frame = {
            let mut core = self.core();
            match &result {
                Ok(r) => core.finish_tick(request.generation, Ok::<_, &str>(r.text.as_str())),
                Err(e) => core.finish_tick(request.generation, Err(e)),
            }
        };
        if let Some(frame) = frame {
            (self.send)(frame);
        }
    }

    /// Begins the re-transcription timer on the current tokio runtime. No-op if
    /// already running or disabled.
    pub fn start(self: &Arc<Self>) {
        let mut timer = self.timer();
        if timer.is_some() || self.is_disabled() {
            return;
        }
        // Weak, so dropping the last handle still stops the timer.
        let weak = Arc::downgrade(self);
        let period = self.tick;
        *timer = Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(period);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            interval.tick().await; // the first tick fires immediately; skip it
            loop {
                interval.tick().await;
                let Some(this) = weak.upgrade() else { break };
                this.tick().await;
                if this.is_disabled() {
                    break;
                }
            }
        }));
    }

    /// Stops the timer. Safe to call more than once.
    pub fn stop(&self) {
        if let Some(handle) = self.timer().take() {
            handle.abort();
        }
    }
}

impl Drop for DeltaSynthesizer {
    fn drop(&mut self) {
        self.stop();
    }
}
