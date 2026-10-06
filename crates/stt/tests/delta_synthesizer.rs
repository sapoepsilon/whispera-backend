//! Rust-only unit tests for the synthesized-delta state machine. The TS PR
//! covers `DeltaSynthesizer` only end-to-end (tests/e2e, live engine), so these
//! pin the same behaviour at unit level.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use serde_json::{json, Value};
use whispera_stt::delta_synthesizer::SYNTHESIZED_DELTA_TYPE;
use whispera_stt::{
    DeltaSynthesizer, DeltaSynthesizerOptions, RealtimeFrame, SynthesizerCore, TranscriptionError,
    TranscriptionProvider, TranscriptionRequest, TranscriptionResult,
};

fn options() -> DeltaSynthesizerOptions {
    DeltaSynthesizerOptions::new(24_000)
}

fn core_with(options: &DeltaSynthesizerOptions) -> SynthesizerCore {
    let mut n = 0;
    SynthesizerCore::with_id_source(
        options,
        Box::new(move || {
            n += 1;
            format!("id{n}")
        }),
    )
}

fn append(bytes: &[u8]) -> RealtimeFrame {
    RealtimeFrame::text(
        json!({
            "type": "input_audio_buffer.append",
            "audio": base64::engine::general_purpose::STANDARD.encode(bytes),
        })
        .to_string(),
    )
}

fn completed() -> RealtimeFrame {
    RealtimeFrame::text(
        json!({ "type": "conversation.item.input_audio_transcription.completed" }).to_string(),
    )
}

fn parse(frame: &RealtimeFrame) -> Value {
    match frame {
        RealtimeFrame::Text(t) => serde_json::from_str(t).unwrap(),
        RealtimeFrame::Binary(_) => panic!("synthesized frames are text"),
    }
}

/// One full tick against a fixed hypothesis.
fn tick(core: &mut SynthesizerCore, hypothesis: &str) -> Option<RealtimeFrame> {
    let request = core.begin_tick().expect("audio buffered");
    core.finish_tick(request.generation, Ok::<_, &str>(hypothesis))
}

#[test]
fn buffers_only_append_frames_and_ignores_everything_else() {
    let mut core = core_with(&options());
    core.on_client_frame(&append(&[1, 2, 3, 4]));
    core.on_client_frame(&RealtimeFrame::text(r#"{"type":"session.update"}"#));
    core.on_client_frame(&RealtimeFrame::text("not json"));
    core.on_client_frame(&RealtimeFrame::Binary(vec![9, 9]));
    core.on_client_frame(&RealtimeFrame::text(
        r#"{"type":"input_audio_buffer.append","audio":""}"#,
    ));
    assert_eq!(core.buffered_bytes(), 4);
}

#[test]
fn does_not_tick_without_audio() {
    let mut core = core_with(&options());
    assert!(core.begin_tick().is_none());
}

#[test]
fn tick_sends_the_buffer_as_wav() {
    let mut core = core_with(&options());
    core.on_client_frame(&append(&[1, 2, 3, 4]));
    let request = core.begin_tick().unwrap();
    assert_eq!(request.wav.len(), 44 + 4);
    assert_eq!(&request.wav[0..4], b"RIFF");
}

#[test]
fn emits_a_delta_frame_once_two_hypotheses_agree() {
    let mut core = core_with(&options());
    core.on_client_frame(&append(&[0; 8]));

    assert!(tick(&mut core, "hello world").is_none());
    let frame = tick(&mut core, "hello world").expect("agreed text");
    let v = parse(&frame);
    assert_eq!(v["type"], SYNTHESIZED_DELTA_TYPE);
    assert_eq!(v["delta"], "hello world");
    assert_eq!(v["content_index"], 0);
    assert_eq!(v["item_id"], "item_synth_id1");
    assert!(v["event_id"].as_str().unwrap().starts_with("evt_synth_"));
    assert_eq!(core.confirmed_text(), "hello world");
}

#[test]
fn skips_a_tick_while_a_request_is_in_flight() {
    let mut core = core_with(&options());
    core.on_client_frame(&append(&[0; 8]));
    let first = core.begin_tick().unwrap();
    assert!(core.begin_tick().is_none());
    core.finish_tick(first.generation, Ok::<_, &str>("x"));
    assert!(core.begin_tick().is_some());
}

#[test]
fn engine_completion_resets_and_drops_a_stale_result() {
    let mut core = core_with(&options());
    core.on_client_frame(&append(&[0; 8]));
    assert!(tick(&mut core, "hello").is_none());

    let stale = core.begin_tick().unwrap();
    core.on_engine_frame(&completed());
    assert_eq!(core.buffered_bytes(), 0);
    // Would have confirmed "hello", but the utterance has moved on.
    assert!(core
        .finish_tick(stale.generation, Ok::<_, &str>("hello"))
        .is_none());
    assert_eq!(core.confirmed_text(), "");

    // The next utterance starts agreement from scratch under a new item id.
    core.on_client_frame(&append(&[0; 8]));
    assert!(tick(&mut core, "bye").is_none());
    let v = parse(&tick(&mut core, "bye").unwrap());
    assert_eq!(v["item_id"], "item_synth_id2");
}

#[test]
fn a_batch_failure_disables_synthesis_for_the_session() {
    let mut core = core_with(&options());
    core.on_client_frame(&append(&[0; 8]));
    let request = core.begin_tick().unwrap();
    assert!(core
        .finish_tick(request.generation, Err::<&str, _>("HTTP 500"))
        .is_none());
    assert!(core.is_disabled());
    assert!(core.begin_tick().is_none());
    core.on_client_frame(&append(&[0; 8]));
    assert_eq!(
        core.buffered_bytes(),
        8,
        "disabled synthesizer stops buffering"
    );
}

#[test]
fn caps_the_utterance_buffer() {
    let opts = DeltaSynthesizerOptions {
        max_utterance_ms: 1,
        ..DeltaSynthesizerOptions::new(1_000)
    };
    // 0.001 s * 1000 Hz * 1 ch * 2 bytes = 2 bytes.
    let mut core = core_with(&opts);
    assert_eq!(core.max_bytes(), 2);
    core.on_client_frame(&append(&[1, 2, 3]));
    assert_eq!(core.buffered_bytes(), 2);
    core.on_client_frame(&append(&[4]));
    assert_eq!(core.buffered_bytes(), 2);
}

struct ScriptedProvider {
    replies: Mutex<Vec<Result<String, String>>>,
}

#[async_trait]
impl TranscriptionProvider for ScriptedProvider {
    fn name(&self) -> &str {
        "scripted"
    }

    async fn transcribe(
        &self,
        request: TranscriptionRequest,
    ) -> Result<TranscriptionResult, TranscriptionError> {
        assert_eq!(request.mimetype, "audio/wav");
        match self.replies.lock().unwrap().remove(0) {
            Ok(text) => Ok(TranscriptionResult {
                text,
                language: "en".to_owned(),
                duration: 0.0,
                provider: "scripted".to_owned(),
            }),
            Err(e) => Err(TranscriptionError::new(e)),
        }
    }
}

fn driver(replies: Vec<Result<String, String>>) -> (Arc<DeltaSynthesizer>, Arc<Mutex<Vec<Value>>>) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&sent);
    let synth = DeltaSynthesizer::new(
        Arc::new(ScriptedProvider {
            replies: Mutex::new(replies),
        }),
        Arc::new(move |frame| sink.lock().unwrap().push(parse(&frame))),
        &DeltaSynthesizerOptions {
            tick: Duration::from_millis(10),
            ..options()
        },
    );
    (synth, sent)
}

#[tokio::test]
async fn async_driver_sends_agreed_deltas_through_the_sink() {
    let (synth, sent) = driver(vec![Ok("one two".into()), Ok("one two three".into())]);
    synth.on_client_frame(&append(&[0; 8]));
    synth.tick().await;
    synth.tick().await;
    let sent = sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["delta"], "one two");
}

#[tokio::test]
async fn async_driver_timer_stops_after_a_failure() {
    let (synth, sent) = driver(vec![Err("boom".into())]);
    synth.on_client_frame(&append(&[0; 8]));
    synth.start();
    for _ in 0..100 {
        if synth.is_disabled() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(synth.is_disabled());
    assert!(sent.lock().unwrap().is_empty());
    synth.stop();
    synth.stop(); // idempotent
}
