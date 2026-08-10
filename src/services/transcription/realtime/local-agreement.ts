/**
 * LocalAgreement-2, the policy UFAL's whisper_streaming uses to turn a
 * batch-only Whisper model into something that can show words while someone
 * is still talking: re-transcribe the growing audio buffer on a timer, and
 * only ever commit the longest prefix on which two *consecutive* hypotheses
 * agree. A single noisy hypothesis can never push text to the client — it
 * takes the same words surviving one more pass over more audio.
 *
 * This module is the policy in isolation: pure functions over word lists, no
 * audio, no sockets, no timers. `DeltaSynthesizer` is what drives it from a
 * live session.
 */

/** Splits on whitespace and drops empty tokens, so repeated spaces collapse. */
export function tokenize(text: string): string[] {
  const trimmed = text.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

export interface AgreementState {
  /** Words already confirmed and handed to the caller. Never rewritten. */
  readonly confirmed: readonly string[];
  /** The previous hypothesis, kept only to find agreement with the next one. */
  readonly previousHypothesis: readonly string[];
}

/** The state before any hypothesis has been seen for an utterance. */
export const INITIAL_AGREEMENT_STATE: AgreementState = {
  confirmed: [],
  previousHypothesis: [],
};

export interface AgreementStep {
  /** State to pass into the next call. */
  state: AgreementState;
  /**
   * Newly confirmed text this step, or `''` when nothing new was confirmed.
   * Carries a leading space when it continues an already-confirmed prefix, so
   * concatenating every non-empty delta for an utterance, in order, with no
   * separator reproduces the confirmed transcript exactly.
   */
  delta: string;
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > words.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (words[i] !== prefix[i]) return false;
  }
  return true;
}

function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Feeds one new hypothesis — the full transcript of the current utterance
 * buffer, as it stands — into the agreement policy.
 *
 * Two hypotheses are compared: the one just received and the one from the
 * previous call. Their common prefix is a candidate for confirmation; it only
 * takes effect once it reaches further than what is already confirmed, and
 * only after checking the new hypothesis still starts with everything already
 * confirmed. That second check is what keeps a promise made to a client: once
 * a delta has gone out, no later hypothesis — however different — is allowed
 * to contradict it. A hypothesis that fails the check is kept for the next
 * round's comparison but confirms nothing this round, since there is nothing
 * safe to agree on with a hypothesis that already disagrees with the record.
 *
 * The very first hypothesis for an utterance never confirms anything: with no
 * prior hypothesis to agree with, `previousHypothesis` is empty and the common
 * prefix is necessarily zero-length. That is LocalAgreement-2 by
 * construction, not a special case bolted on — it needs two hypotheses to
 * agree on anything.
 */
export function advanceLocalAgreement(state: AgreementState, hypothesisText: string): AgreementStep {
  const hypothesis = tokenize(hypothesisText);

  if (!startsWith(hypothesis, state.confirmed)) {
    return {
      state: { confirmed: state.confirmed, previousHypothesis: hypothesis },
      delta: '',
    };
  }

  const agreementLength = commonPrefixLength(hypothesis, state.previousHypothesis);
  const confirmedLength = Math.max(state.confirmed.length, agreementLength);
  const confirmed = hypothesis.slice(0, confirmedLength);
  const newWords = confirmed.slice(state.confirmed.length);

  return {
    state: { confirmed, previousHypothesis: hypothesis },
    delta: newWords.length === 0 ? '' : (state.confirmed.length > 0 ? ' ' : '') + newWords.join(' '),
  };
}
