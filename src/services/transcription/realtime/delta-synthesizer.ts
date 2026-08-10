import { randomUUID } from 'node:crypto';

import type { TranscriptionProvider } from '../types.js';
import {
  advanceLocalAgreement,
  INITIAL_AGREEMENT_STATE,
  type AgreementState,
} from './local-agreement.js';
import type { RealtimeFrame } from './types.js';
import { pcm16ToWav } from './wav.js';

/** The engine's authoritative final for a turn. Resets synthesis state. */
const ENGINE_TRANSCRIPTION_COMPLETED = 'conversation.item.input_audio_transcription.completed';
/** The only client frame type synthesis reads; everything else passes by unseen. */
const CLIENT_AUDIO_APPEND = 'input_audio_buffer.append';
/** Event type synthesized deltas are sent as — the slot OpenAI Realtime reserves for this. */
const SYNTHESIZED_DELTA_TYPE = 'conversation.item.input_audio_transcription.delta';

export interface DeltaSynthesizerLogger {
  warn(obj: object, msg: string): void;
}

export interface DeltaSynthesizerOptions {
  /** Speaks this server's own batch endpoint — what gets re-transcribed against. */
  batchProvider: TranscriptionProvider;
  /** Must match what the client was told to send in `realtime.audio`. */
  sampleRate: number;
  channels?: number;
  /** How often the accumulated buffer is re-transcribed. */
  tickMs?: number;
  /** Per-utterance audio cap; synthesis freezes rather than growing forever. */
  maxUtteranceMs?: number;
  /** Pushes a frame toward the client, bypassing the bridge's own relay path. */
  send: (frame: RealtimeFrame) => void;
  logger?: DeltaSynthesizerLogger;
  context?: Record<string, unknown>;
  /** Test seam; production code uses the real timer functions. */
  setIntervalFn?: typeof globalThis.setInterval;
  clearIntervalFn?: typeof globalThis.clearInterval;
}

const DEFAULT_TICK_MS = 1_000;
const DEFAULT_MAX_UTTERANCE_MS = 60_000;
const BYTES_PER_SAMPLE = 2;

function parseJsonFrame(frame: RealtimeFrame): Record<string, unknown> | undefined {
  if (frame.isBinary) return undefined;
  try {
    const parsed: unknown = JSON.parse(String(frame.data));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The synthesized-delta engine, wired alongside a `RealtimeBridge` when a
 * server's config sets `synthesizeDeltas`.
 *
 * It only ever *observes* the frames the bridge is already relaying — client
 * audio in, engine events out — and, on its own schedule, re-transcribes the
 * growing utterance buffer through the server's batch endpoint to run
 * LocalAgreement-2 over consecutive hypotheses. Newly agreed text goes out as
 * synthesized `conversation.item.input_audio_transcription.delta` frames,
 * ahead of whatever the engine itself eventually reports for that turn.
 *
 * Every failure mode here degrades to doing nothing rather than touching the
 * underlying session: a batch error disables synthesis for the rest of this
 * instance (logged once), a full buffer just stops growing, and a request
 * still in flight when a tick fires is left alone rather than piled onto.
 */
export class DeltaSynthesizer {
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly tickMs: number;
  private readonly maxBytes: number;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;

  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private agreement: AgreementState = INITIAL_AGREEMENT_STATE;
  private itemId = randomUUID();
  /** Bumped on reset so a batch response for an abandoned utterance is dropped. */
  private generation = 0;
  private inFlight = false;
  private disabled = false;
  private loggedFailure = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: DeltaSynthesizerOptions) {
    this.sampleRate = options.sampleRate;
    this.channels = options.channels ?? 1;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    const maxSeconds = (options.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS) / 1000;
    this.maxBytes = Math.floor(maxSeconds * this.sampleRate * this.channels * BYTES_PER_SAMPLE);
    this.setIntervalFn = options.setIntervalFn ?? globalThis.setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? globalThis.clearInterval;
  }

  /** Begins the re-transcription timer. Call once the engine session is live. */
  start(): void {
    if (this.timer || this.disabled) return;
    this.timer = this.setIntervalFn(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  /** Stops the timer. Safe to call more than once. */
  stop(): void {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = undefined;
  }

  /**
   * Feed every frame the bridge relays from client to engine. Read-only: this
   * never influences whether or how the bridge forwards the frame.
   */
  onClientFrame(frame: RealtimeFrame): void {
    if (this.disabled) return;
    const parsed = parseJsonFrame(frame);
    if (parsed?.type !== CLIENT_AUDIO_APPEND) return;

    const audio = parsed.audio;
    if (typeof audio !== 'string' || audio.length === 0) return;
    if (this.bufferedBytes >= this.maxBytes) return; // capped; this utterance stops growing

    let pcm: Buffer;
    try {
      pcm = Buffer.from(audio, 'base64');
    } catch {
      return;
    }
    if (pcm.length === 0) return;

    const room = this.maxBytes - this.bufferedBytes;
    const clipped = pcm.length > room ? pcm.subarray(0, room) : pcm;
    this.chunks.push(clipped);
    this.bufferedBytes += clipped.length;
  }

  /**
   * Feed every frame the bridge relays from engine to client. Read-only: this
   * never delays or drops the frame the bridge is about to send.
   */
  onEngineFrame(frame: RealtimeFrame): void {
    const parsed = parseJsonFrame(frame);
    if (parsed?.type === ENGINE_TRANSCRIPTION_COMPLETED) this.reset();
  }

  /** Drops the current utterance's buffer and agreement state. */
  private reset(): void {
    this.chunks = [];
    this.bufferedBytes = 0;
    this.agreement = INITIAL_AGREEMENT_STATE;
    this.itemId = randomUUID();
    this.generation += 1;
  }

  private tick(): void {
    if (this.disabled || this.inFlight || this.bufferedBytes === 0) return;

    const generation = this.generation;
    const wav = pcm16ToWav(Buffer.concat(this.chunks), this.sampleRate, this.channels);
    this.inFlight = true;

    this.options.batchProvider
      .transcribe({ audio: wav, mimetype: 'audio/wav' })
      .then((result) => {
        // The utterance moved on while this request was in flight (the engine
        // committed and this synthesizer reset) — this hypothesis no longer
        // describes anything a client is waiting on.
        if (generation !== this.generation) return;
        this.applyHypothesis(result.text);
      })
      .catch((error: unknown) => {
        this.disabled = true;
        this.stop();
        if (!this.loggedFailure) {
          this.loggedFailure = true;
          this.options.logger?.warn(
            { ...this.options.context, err: error },
            'synthesized-delta re-transcription failed; this session falls back to ' +
              'utterance-level granularity from the engine',
          );
        }
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  private applyHypothesis(text: string): void {
    const { state, delta } = advanceLocalAgreement(this.agreement, text);
    this.agreement = state;
    if (delta === '') return;

    this.options.send({
      isBinary: false,
      data: JSON.stringify({
        type: SYNTHESIZED_DELTA_TYPE,
        // Synthetic ids: no real conversation item exists yet at this point in
        // the turn — the engine only creates one once it commits the audio.
        event_id: `evt_synth_${randomUUID()}`,
        item_id: `item_synth_${this.itemId}`,
        content_index: 0,
        delta,
      }),
    });
  }
}
