//! LocalAgreement-2 (port of `realtime/local-agreement.ts`).
//!
//! Re-transcribe the growing audio buffer on a timer and only ever commit the
//! longest prefix on which two *consecutive* hypotheses agree. Pure functions
//! over word lists: no audio, no sockets, no timers.

/// Splits on whitespace and drops empty tokens, so repeated spaces collapse.
pub fn tokenize(text: &str) -> Vec<String> {
    text.split_whitespace().map(str::to_owned).collect()
}

/// Agreement state for one utterance.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgreementState {
    /// Words already confirmed and handed to the caller. Never rewritten.
    pub confirmed: Vec<String>,
    /// The previous hypothesis, kept only to find agreement with the next one.
    pub previous_hypothesis: Vec<String>,
}

impl AgreementState {
    /// The state before any hypothesis has been seen for an utterance.
    pub fn initial() -> Self {
        Self::default()
    }

    /// The confirmed words joined by single spaces.
    pub fn confirmed_text(&self) -> String {
        self.confirmed.join(" ")
    }
}

/// Result of feeding one hypothesis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgreementStep {
    /// State to pass into the next call.
    pub state: AgreementState,
    /// Newly confirmed text, or `""`. Carries a leading space when it continues
    /// an already-confirmed prefix, so concatenating every delta in order
    /// reproduces the confirmed transcript exactly.
    pub delta: String,
}

fn common_prefix_len(a: &[String], b: &[String]) -> usize {
    a.iter().zip(b).take_while(|(x, y)| x == y).count()
}

/// Feeds one new hypothesis (the full transcript of the current utterance
/// buffer) into the agreement policy.
///
/// A hypothesis that no longer starts with the confirmed prefix confirms
/// nothing (it is kept for the next comparison), so a delta once sent is never
/// contradicted. The first hypothesis never confirms anything: there is no
/// previous one to agree with.
pub fn advance_local_agreement(state: &AgreementState, hypothesis_text: &str) -> AgreementStep {
    let hypothesis = tokenize(hypothesis_text);

    if !hypothesis.starts_with(&state.confirmed) {
        return AgreementStep {
            state: AgreementState {
                confirmed: state.confirmed.clone(),
                previous_hypothesis: hypothesis,
            },
            delta: String::new(),
        };
    }

    let agreement_len = common_prefix_len(&hypothesis, &state.previous_hypothesis);
    let confirmed_len = state.confirmed.len().max(agreement_len);
    let confirmed: Vec<String> = hypothesis[..confirmed_len].to_vec();
    let new_words = &confirmed[state.confirmed.len()..];

    let delta = if new_words.is_empty() {
        String::new()
    } else {
        let sep = if state.confirmed.is_empty() { "" } else { " " };
        format!("{sep}{}", new_words.join(" "))
    };

    AgreementStep {
        state: AgreementState {
            confirmed,
            previous_hypothesis: hypothesis,
        },
        delta,
    }
}
