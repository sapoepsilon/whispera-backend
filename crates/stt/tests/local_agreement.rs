//! Port of tests/services/transcription/local-agreement.test.ts.

use whispera_stt::{advance_local_agreement, tokenize, AgreementState};

#[test]
fn splits_on_whitespace_and_drops_empties() {
    assert_eq!(
        tokenize("the  quick   brown fox"),
        ["the", "quick", "brown", "fox"]
    );
}

#[test]
fn returns_an_empty_array_for_blank_input() {
    assert!(tokenize("").is_empty());
    assert!(tokenize("   ").is_empty());
}

/// (hypothesis, delta that step must emit, full confirmed text after it).
type Step<'a> = (&'a str, &'a str, &'a str);

fn run(steps: &[Step<'_>]) {
    let mut state = AgreementState::initial();
    let mut accumulated = String::new();
    for (index, (hypothesis, delta, confirmed)) in steps.iter().enumerate() {
        let result = advance_local_agreement(&state, hypothesis);
        state = result.state;
        accumulated.push_str(&result.delta);

        assert_eq!(result.delta, *delta, "step {index} delta");
        assert_eq!(state.confirmed_text(), *confirmed, "step {index} confirmed");
        assert_eq!(accumulated, *confirmed, "step {index} concatenated deltas");
    }
}

#[test]
fn confirms_nothing_on_the_first_hypothesis_nothing_to_agree_with_yet() {
    run(&[("the quick brown", "", "")]);
}

#[test]
fn confirms_everything_once_two_consecutive_hypotheses_agree_in_full() {
    run(&[
        ("the quick brown", "", ""),
        ("the quick brown", "the quick brown", "the quick brown"),
    ]);
}

#[test]
fn confirms_one_word_behind_a_steadily_growing_hypothesis() {
    run(&[
        ("the", "", ""),
        ("the quick", "the", "the"),
        ("the quick brown", " quick", "the quick"),
        ("the quick brown fox", " brown", "the quick brown"),
    ]);
}

#[test]
fn withholds_the_unconfirmed_tail_when_consecutive_hypotheses_disagree_past_it() {
    run(&[
        ("the quick brown", "", ""),
        // Disagrees at word 2 ("brown" vs "browns"): only "the quick" is safe.
        ("the quick browns fox", "the quick", "the quick"),
    ]);
}

#[test]
fn rewrites_the_unconfirmed_tail_freely_as_long_as_it_never_touches_confirmed_text() {
    run(&[
        ("i saw a", "", ""),
        ("i saw a cat", "i saw a", "i saw a"),
        // "cat" -> "cap" rewrites text that was never confirmed, so it is free.
        ("i saw a cap on the", "", "i saw a"),
        (
            "i saw a cap on the table",
            " cap on the",
            "i saw a cap on the",
        ),
    ]);
}

#[test]
fn never_emits_a_delta_that_contradicts_an_already_confirmed_prefix() {
    let mut state = AgreementState::initial();
    state = advance_local_agreement(&state, "the quick brown").state;
    let confirm_step = advance_local_agreement(&state, "the quick brown");
    state = confirm_step.state;
    assert_eq!(confirm_step.delta, "the quick brown");

    // A wildly different hypothesis must not rewind what was already promised.
    let contradiction = advance_local_agreement(&state, "a completely different sentence");
    assert_eq!(contradiction.delta, "");
    assert_eq!(contradiction.state.confirmed_text(), "the quick brown");

    // And it stays stuck on later hypotheses that still contradict the record.
    let still_contradicts = advance_local_agreement(
        &contradiction.state,
        "a completely different sentence indeed",
    );
    assert_eq!(still_contradicts.delta, "");
    assert_eq!(still_contradicts.state.confirmed_text(), "the quick brown");
}

#[test]
fn treats_an_empty_hypothesis_as_vacuously_agreeing_with_an_empty_confirmed_prefix() {
    run(&[("", "", "")]);
}

#[test]
fn tolerates_an_empty_hypothesis_arriving_mid_utterance_without_crashing_or_rewinding() {
    run(&[
        ("hello", "", ""),
        ("hello", "hello", "hello"),
        // An empty transcript does not start with "hello": a contradiction, not a reset.
        ("", "", "hello"),
        ("hello there", "", "hello"),
        ("hello there", " there", "hello there"),
    ]);
}

#[test]
fn collapses_repeated_whitespace_the_same_way_on_every_hypothesis() {
    run(&[
        ("  the   quick  ", "", ""),
        ("the quick", "the quick", "the quick"),
    ]);
}
