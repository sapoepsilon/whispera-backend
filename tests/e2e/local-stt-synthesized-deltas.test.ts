import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildTestApp, registerAndGetToken } from '../helpers.js';
import { waitFor } from '../fake-realtime-server.js';

/**
 * Synthesized-delta mode end to end, against a REAL OpenAI-Realtime-compatible
 * server: the proxy re-transcribing the growing utterance buffer through that
 * same server's batch endpoint and emitting LocalAgreement-2-confirmed deltas
 * ahead of the engine's own utterance-level result.
 *
 * `local-stt-realtime.test.ts` already proves the plain proxy path against a
 * live engine; this file is the thing this feature adds on top of it — text
 * arriving *before* `conversation.item.input_audio_transcription.completed`,
 * which nothing upstream of the synthesizer can produce on its own.
 *
 * Opt-in and skip-when-unreachable, like every other `local-stt-*` suite:
 *
 *   LOCAL_STT_BASE_URL=http://192.168.50.140:8000/v1 \
 *   LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3 \
 *   pnpm test tests/e2e/local-stt-synthesized-deltas.test.ts
 */
const baseUrl = process.env.LOCAL_STT_BASE_URL?.trim();
const model = process.env.LOCAL_STT_MODEL?.trim() || 'Systran/faster-distil-whisper-large-v3';
const SERVER_ID = 'local-stt-synth';

/** Rate speaches decodes `input_audio_buffer.append` payloads at. */
const ENGINE_SAMPLE_RATE = 24_000;
/** How the fixture is paced onto the wire, matching a real mic's cadence. */
const CHUNK_MS = 50;

const wav = readFileSync(fileURLToPath(new URL('../fixtures/spoken-sentence.wav', import.meta.url)));

/** Reads PCM16 out of a WAV by walking its chunks — see local-stt-realtime.test.ts. */
function readWavPcm16(buffer: Buffer): { samples: Int16Array; sampleRate: number } {
  let offset = 12;
  let sampleRate = 16_000;
  let data: Buffer | undefined;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, offset + 8 + size);

    if (id === 'fmt ') sampleRate = body.readUInt32LE(4);
    if (id === 'data') data = body;

    offset += 8 + size + (size % 2);
  }

  if (!data) throw new Error('fixture WAV has no data chunk');
  return {
    samples: new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2)),
    sampleRate,
  };
}

function resample(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return samples;
  const ratio = to / from;
  const out = new Int16Array(Math.floor(samples.length * ratio));
  for (let i = 0; i < out.length; i += 1) {
    const source = i / ratio;
    const lower = Math.floor(source);
    const upper = Math.min(lower + 1, samples.length - 1);
    const fraction = source - lower;
    out[i] = Math.round(samples[lower] * (1 - fraction) + samples[upper] * fraction);
  }
  return out;
}

function engineAudio(): Buffer {
  const { samples, sampleRate } = readWavPcm16(wav);
  const resampled = resample(samples, sampleRate, ENGINE_SAMPLE_RATE);
  return Buffer.from(resampled.buffer, resampled.byteOffset, resampled.byteLength);
}

/** Lowercased, punctuation-stripped word tokens — the granularity deltas confirm at. */
function normalizedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isPrefix(prefix: string[], whole: string[]): boolean {
  if (prefix.length > whole.length) return false;
  return prefix.every((word, i) => word === whole[i]);
}

interface TimedFrame {
  type: string;
  atMs: number;
  [key: string]: unknown;
}

describe.skipIf(!baseUrl)('synthesized-delta granularity against a real STT server', () => {
  let app: FastifyInstance;
  let token: string;
  let port: number;
  const previousServers = process.env.TRANSCRIPTION_SERVERS;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    process.env.TRANSCRIPTION_SERVERS = JSON.stringify([
      {
        id: SERVER_ID,
        label: 'Local STT (synthesized deltas)',
        baseUrl,
        model,
        capabilities: ['batch', 'realtime'],
        synthesizeDeltas: true,
      },
    ]);

    app = await buildTestApp();
    token = (await registerAndGetToken(app)).accessToken;
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('app did not bind a port');
    port = address.port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await app?.close();
    if (previousServers === undefined) delete process.env.TRANSCRIPTION_SERVERS;
    else process.env.TRANSCRIPTION_SERVERS = previousServers;
  });

  function connect(): { socket: WebSocket; frames: TimedFrame[] } {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/transcription/stream?server=${SERVER_ID}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    sockets.push(socket);

    const frames: TimedFrame[] = [];
    socket.on('message', (data: Buffer) => {
      const atMs = Date.now();
      try {
        frames.push({ ...(JSON.parse(data.toString()) as Record<string, unknown>), atMs } as TimedFrame);
      } catch {
        frames.push({ type: '__unparseable__', raw: data.toString(), atMs });
      }
    });
    return { socket, frames };
  }

  /** Sends PCM16 as base64 JSON frames, paced like a real microphone. */
  async function streamPaced(socket: WebSocket, pcm: Buffer): Promise<void> {
    const bytesPerChunk = Math.floor((ENGINE_SAMPLE_RATE * (CHUNK_MS / 1000)) * 2);
    for (let offset = 0; offset < pcm.length; offset += bytesPerChunk) {
      socket.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pcm.subarray(offset, offset + bytesPerChunk).toString('base64'),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, CHUNK_MS));
    }
  }

  const seen = (frames: TimedFrame[], type: string) => frames.some((f) => f.type === type);

  it('advertises this server as synthesized-delta, not plain utterance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/transcription/servers',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const [server] = res.json().servers;
    expect(server.id).toBe(SERVER_ID);
    expect(server.realtime.granularity).toBe('synthesized-delta');
  });

  it(
    'delivers at least one delta before the engine finalises the turn, and every delta forms a prefix of it',
    async () => {
      const { socket, frames } = connect();
      await waitFor(() => seen(frames, 'session.created'), 15_000, 'session.created');

      socket.send(
        JSON.stringify({
          type: 'session.update',
          session: { modalities: ['text'], input_audio_transcription: { model, language: 'en' } },
        }),
      );
      await waitFor(() => seen(frames, 'session.updated'), 15_000, 'session.updated');

      const audioStartedAt = Date.now();
      await streamPaced(socket, engineAudio());
      // Server-side VAD needs trailing silence to decide the turn is over.
      await streamPaced(socket, Buffer.alloc(ENGINE_SAMPLE_RATE * 2 * 2));

      await waitFor(
        () => seen(frames, 'conversation.item.input_audio_transcription.completed'),
        90_000,
        'transcription.completed',
      );

      const deltaFrames = frames.filter(
        (f) => f.type === 'conversation.item.input_audio_transcription.delta',
      );
      const completedFrame = frames.find(
        (f) => f.type === 'conversation.item.input_audio_transcription.completed',
      );
      expect(completedFrame).toBeDefined();

      // The whole point of the feature: text before the final, not just at it.
      expect(deltaFrames.length).toBeGreaterThan(0);
      const firstDelta = deltaFrames[0];
      expect(firstDelta.atMs).toBeLessThan(completedFrame!.atMs);

      const concatenated = deltaFrames.map((f) => String(f.delta ?? '')).join('');
      const finalText = String(completedFrame!.transcript ?? '');

      expect(isPrefix(normalizedWords(concatenated), normalizedWords(finalText))).toBe(true);

      // Measured, not asserted — printed so a human can read timing off a run;
      // see DELTAS-RESULT.md for a recorded sample.
      // eslint-disable-next-line no-console
      console.info('[synthesized-deltas]', {
        timeToFirstDeltaMs: firstDelta.atMs - audioStartedAt,
        timeToFinalMs: completedFrame!.atMs - audioStartedAt,
        deltaCount: deltaFrames.length,
        concatenated,
        finalText,
      });
    },
    120_000,
  );
});
