import { describe, it, expect } from 'vitest';

import {
  INITIAL_AGREEMENT_STATE,
  advanceLocalAgreement,
  tokenize,
  type AgreementState,
} from '../../../src/services/transcription/realtime/local-agreement.js';

describe('tokenize', () => {
  it('splits on whitespace and drops empties', () => {
    expect(tokenize('the  quick   brown fox')).toEqual(['the', 'quick', 'brown', 'fox']);
  });

  it('returns an empty array for blank input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

/**
 * Each row is one hypothesis fed in sequence, starting from
 * `INITIAL_AGREEMENT_STATE`. `delta` is what that step must emit; `confirmed`
 * is the full confirmed text after that step, asserted as a cross-check that
 * concatenating every delta so far reproduces it.
 */
interface Step {
  hypothesis: string;
  delta: string;
  confirmed: string;
}

function run(steps: Step[]): void {
  let state: AgreementState = INITIAL_AGREEMENT_STATE;
  let accumulated = '';

  steps.forEach((step, index) => {
    const result = advanceLocalAgreement(state, step.hypothesis);
    state = result.state;
    accumulated += result.delta;

    expect(result.delta, `step ${index} delta`).toBe(step.delta);
    expect(state.confirmed.join(' '), `step ${index} confirmed`).toBe(step.confirmed);
    expect(accumulated, `step ${index} concatenated deltas`).toBe(step.confirmed);
  });
}

describe('advanceLocalAgreement', () => {
  it('confirms nothing on the first hypothesis — nothing to agree with yet', () => {
    run([{ hypothesis: 'the quick brown', delta: '', confirmed: '' }]);
  });

  it('confirms everything once two consecutive hypotheses agree in full', () => {
    run([
      { hypothesis: 'the quick brown', delta: '', confirmed: '' },
      { hypothesis: 'the quick brown', delta: 'the quick brown', confirmed: 'the quick brown' },
    ]);
  });

  it('confirms one word behind a steadily growing hypothesis', () => {
    run([
      { hypothesis: 'the', delta: '', confirmed: '' },
      { hypothesis: 'the quick', delta: 'the', confirmed: 'the' },
      { hypothesis: 'the quick brown', delta: ' quick', confirmed: 'the quick' },
      { hypothesis: 'the quick brown fox', delta: ' brown', confirmed: 'the quick brown' },
    ]);
  });

  it('withholds the unconfirmed tail when consecutive hypotheses disagree past it', () => {
    run([
      { hypothesis: 'the quick brown', delta: '', confirmed: '' },
      // Disagrees at word 2 ("brown" vs "browns"): only "the quick" is safe.
      { hypothesis: 'the quick browns fox', delta: 'the quick', confirmed: 'the quick' },
    ]);
  });

  it('rewrites the unconfirmed tail freely as long as it never touches confirmed text', () => {
    run([
      { hypothesis: 'i saw a', delta: '', confirmed: '' },
      { hypothesis: 'i saw a cat', delta: 'i saw a', confirmed: 'i saw a' },
      // "cat" -> "cap" is a rewrite of text that was never confirmed, so it is free.
      { hypothesis: 'i saw a cap on the', delta: '', confirmed: 'i saw a' },
      { hypothesis: 'i saw a cap on the table', delta: ' cap on the', confirmed: 'i saw a cap on the' },
    ]);
  });

  it('never emits a delta that contradicts an already-confirmed prefix', () => {
    let state: AgreementState = INITIAL_AGREEMENT_STATE;

    state = advanceLocalAgreement(state, 'the quick brown').state;
    const confirmStep = advanceLocalAgreement(state, 'the quick brown');
    state = confirmStep.state;
    expect(confirmStep.delta).toBe('the quick brown');

    // A wildly different hypothesis must not rewind what was already promised.
    const contradiction = advanceLocalAgreement(state, 'a completely different sentence');
    expect(contradiction.delta).toBe('');
    expect(contradiction.state.confirmed.join(' ')).toBe('the quick brown');

    // And it stays stuck on later hypotheses that still contradict the record,
    // rather than silently accepting a rewrite of confirmed text.
    const stillContradicts = advanceLocalAgreement(
      contradiction.state,
      'a completely different sentence indeed',
    );
    expect(stillContradicts.delta).toBe('');
    expect(stillContradicts.state.confirmed.join(' ')).toBe('the quick brown');
  });

  it('treats an empty hypothesis as vacuously agreeing with an empty confirmed prefix', () => {
    run([{ hypothesis: '', delta: '', confirmed: '' }]);
  });

  it('tolerates an empty hypothesis arriving mid-utterance without crashing or rewinding', () => {
    run([
      { hypothesis: 'hello', delta: '', confirmed: '' },
      { hypothesis: 'hello', delta: 'hello', confirmed: 'hello' },
      // Momentary silence/VAD hiccup producing an empty transcript: "hello" is
      // still a confirmed prefix of "" only if "" starts with "hello", which it
      // does not — so this is a contradiction, not a reset.
      { hypothesis: '', delta: '', confirmed: 'hello' },
      { hypothesis: 'hello there', delta: '', confirmed: 'hello' },
      { hypothesis: 'hello there', delta: ' there', confirmed: 'hello there' },
    ]);
  });

  it('collapses repeated whitespace the same way on every hypothesis', () => {
    run([
      { hypothesis: '  the   quick  ', delta: '', confirmed: '' },
      { hypothesis: 'the quick', delta: 'the quick', confirmed: 'the quick' },
    ]);
  });
});
