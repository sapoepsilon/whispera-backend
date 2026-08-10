/**
 * The streaming sibling of `TranscriptionProvider`.
 *
 * Batch transcription is request/response, so its contract is "bytes in,
 * transcript out". Streaming is a live conversation, so its contract is a
 * session: frames go up, frames come down, either side may hang up.
 *
 * Frames are deliberately opaque. The wire format between the Mac client and
 * the engine is the OpenAI Realtime event shape; the proxy's job is to carry it
 * faithfully, not to understand it. An engine that speaks something else (a
 * streaming Nemotron checkpoint, say) implements this interface and does its
 * translation internally — nothing in the route layer changes.
 */

/** One WebSocket frame, with the text/binary distinction preserved. */
export interface RealtimeFrame {
  data: string | Buffer;
  /** speaches drops the session on an unexpected binary frame, so this matters. */
  isBinary: boolean;
}

/**
 * How early a realtime engine can produce useful text, in order of
 * preference for a client auto-choosing a server.
 *
 * - `native-delta`: the engine emits its own
 *   `conversation.item.input_audio_transcription.delta` frames while the
 *   speaker is still talking. No provider does this yet; the value exists so
 *   a future streaming-native engine (e.g. a NeMo checkpoint) has somewhere
 *   to report it without another discovery-schema change.
 * - `synthesized-delta`: nothing native streams, but the proxy re-transcribes
 *   the growing utterance buffer against the server's own batch endpoint and
 *   emits LocalAgreement-2-confirmed deltas ahead of the engine's own
 *   utterance-level result. See `DeltaSynthesizer`.
 * - `utterance`: text arrives only once the engine finalises the turn — every
 *   OpenAI-Realtime-compatible engine today, absent synthesis.
 */
export const REALTIME_GRANULARITIES = ['native-delta', 'synthesized-delta', 'utterance'] as const;
export type RealtimeGranularity = (typeof REALTIME_GRANULARITIES)[number];

export interface RealtimeConnectOptions {
  /** Engine-side model id, forwarded as the `model` query parameter. */
  model: string;
  /**
   * Query parameters copied from the client's request, minus the ones the proxy
   * owns. Lets a client tune the session without the proxy knowing the knobs.
   */
  query?: Record<string, string>;
  /** Abandon the upstream handshake after this many ms. */
  handshakeTimeoutMs?: number;
}

export interface RealtimeSessionListeners {
  /** Called for every frame the engine emits. */
  onFrame(frame: RealtimeFrame): void;
  /** Transport-level failure. Always followed by onClose. */
  onError(error: Error): void;
  onClose(code: number, reason: string): void;
}

export interface RealtimeTranscriptionSession {
  /** Identifier surfaced in logs and in the proxy's error frames. */
  readonly provider: string;
  /** False once the upstream link is closing or closed. */
  readonly open: boolean;
  /** Bytes queued on the upstream socket; the proxy's backpressure signal. */
  readonly bufferedBytes: number;

  send(frame: RealtimeFrame): void;
  /** Stop reading from the engine — used when the client cannot keep up. */
  pause(): void;
  resume(): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeTranscriptionProvider {
  /** Value reported as the engine's identity to clients and logs. */
  readonly name: string;
  /**
   * This provider's own streaming granularity, absent synthesis. Undefined is
   * equivalent to `'utterance'` — every provider today gets that for free by
   * simply not setting it.
   */
  readonly granularity?: RealtimeGranularity;
  /**
   * Resolves once the upstream session is established. Rejects if the engine
   * refuses the handshake, so the caller can answer the client honestly instead
   * of holding an open socket that will never produce anything.
   */
  connect(
    options: RealtimeConnectOptions,
    listeners: RealtimeSessionListeners,
  ): Promise<RealtimeTranscriptionSession>;
}
