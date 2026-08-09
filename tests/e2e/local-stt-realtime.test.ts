import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildTestApp, registerAndGetToken } from '../helpers.js';
import { waitFor } from '../fake-realtime-server.js';

/**
 * The realtime proxy against a REAL OpenAI-Realtime speech-to-text server.
 *
 * Every other realtime test talks to a fake engine, so nothing exercised the
 * actual wire: not the upgrade, not the path, not a real model producing events.
 *
 * Opt-in by pointing it at any OpenAI-Realtime-compatible endpoint:
 *
 *   LOCAL_STT_BASE_URL=http://192.168.50.140:8000/v1 \
 *   LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3 \
 *   pnpm test tests/e2e/local-stt-realtime.test.ts
 *
 * Like the batch sibling, this SKIPS rather than throws when unconfigured: it
 * must never turn CI red for want of a LAN it cannot reach.
 */
const baseUrl = process.env.LOCAL_STT_BASE_URL?.trim();
const model = process.env.LOCAL_STT_MODEL?.trim() || 'Systran/faster-distil-whisper-large-v3';
const SERVER_ID = 'local-stt';

/** Rate speaches decodes `input_audio_buffer.append` payloads at. */
const ENGINE_SAMPLE_RATE = 24_000;

const wav = readFileSync(fileURLToPath(new URL('../fixtures/spoken-sentence.wav', import.meta.url)));

/**
 * Reads PCM16 out of a WAV by walking its chunks. The fixture carries an `FLLR`
 * padding chunk before `data`, so the usual "skip 44 bytes" shortcut would feed
 * the engine garbage.
 */
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

/** Linear resample. Good enough for a 16 kHz fixture a whisper model must read. */
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

interface Frame {
  type: string;
  [key: string]: unknown;
}

describe.skipIf(!baseUrl)('realtime transcription through the proxy against a real STT server', () => {
  let app: FastifyInstance;
  let token: string;
  let port: number;
  const previousServers = process.env.TRANSCRIPTION_SERVERS;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    // Read by the registry at route registration, so it must be set before the
    // app is built.
    process.env.TRANSCRIPTION_SERVERS = JSON.stringify([
      {
        id: SERVER_ID,
        label: 'Local STT',
        baseUrl,
        model,
        capabilities: ['batch', 'realtime'],
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

  function connect(): { socket: WebSocket; frames: Frame[] } {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/transcription/stream?server=${SERVER_ID}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    sockets.push(socket);

    const frames: Frame[] = [];
    socket.on('message', (data: Buffer) => {
      try {
        frames.push(JSON.parse(data.toString()) as Frame);
      } catch {
        frames.push({ type: '__unparseable__', raw: data.toString() });
      }
    });
    return { socket, frames };
  }

  const seen = (frames: Frame[], type: string) => frames.some((f) => f.type === type);

  it('advertises the live server as realtime-capable and reachable', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/transcription/servers',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const [server] = res.json().servers;
    expect(server.id).toBe(SERVER_ID);
    expect(server.capabilities).toContain('realtime');
    expect(server.status).toBe('online');
    expect(server.realtime.audio.sampleRate).toBe(ENGINE_SAMPLE_RATE);
  });

  it('carries the engine session handshake through the proxy', async () => {
    const { frames } = connect();

    await waitFor(() => seen(frames, 'session.created'), 15_000, 'session.created');
    const created = frames.find((f) => f.type === 'session.created');
    // A real session id proves this came from the engine, not from the proxy.
    expect((created?.session as { id?: string })?.id).toMatch(/^sess_/);
  }, 30_000);

  it('round-trips a session.update to the engine and back', async () => {
    const { socket, frames } = connect();
    await waitFor(() => seen(frames, 'session.created'), 15_000, 'session.created');

    socket.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text'],
          input_audio_transcription: { model, language: 'en' },
        },
      }),
    );

    await waitFor(() => seen(frames, 'session.updated'), 15_000, 'session.updated');
    const updated = frames.find((f) => f.type === 'session.updated');
    const session = updated?.session as { input_audio_transcription?: { model?: string } };
    expect(session?.input_audio_transcription?.model).toBe(model);
  }, 30_000);

  it('streams audio and gets the engine voice-activity events back', async () => {
    const { socket, frames } = connect();
    await waitFor(() => seen(frames, 'session.created'), 15_000, 'session.created');

    socket.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text'],
          input_audio_transcription: { model, language: 'en' },
        },
      }),
    );
    await waitFor(() => seen(frames, 'session.updated'), 15_000, 'session.updated');

    const audio = engineAudio();
    const chunk = ENGINE_SAMPLE_RATE / 10 / 2; // 100 ms of PCM16
    for (let offset = 0; offset < audio.length; offset += chunk) {
      socket.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: audio.subarray(offset, offset + chunk).toString('base64'),
        }),
      );
    }
    // Server-side VAD needs trailing silence to decide the turn is over.
    const silence = Buffer.alloc(ENGINE_SAMPLE_RATE * 2 * 2);
    for (let offset = 0; offset < silence.length; offset += chunk) {
      socket.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: silence.subarray(offset, offset + chunk).toString('base64'),
        }),
      );
    }

    await waitFor(
      () => seen(frames, 'input_audio_buffer.speech_started'),
      20_000,
      'speech_started',
    );
    await waitFor(() => seen(frames, 'input_audio_buffer.committed'), 20_000, 'committed');

    const stopped = frames.find((f) => f.type === 'input_audio_buffer.speech_stopped');
    // ~5.2 s of speech; a wrong sample rate would report roughly two thirds of it.
    expect(stopped?.audio_end_ms as number).toBeGreaterThan(4_500);
  }, 60_000);

  it('delivers the transcript the engine produced', async () => {
    const { socket, frames } = connect();
    await waitFor(() => seen(frames, 'session.created'), 15_000, 'session.created');

    socket.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text'],
          input_audio_transcription: { model, language: 'en' },
        },
      }),
    );
    await waitFor(() => seen(frames, 'session.updated'), 15_000, 'session.updated');

    const audio = engineAudio();
    const chunk = ENGINE_SAMPLE_RATE / 10 / 2;
    for (let offset = 0; offset < audio.length; offset += chunk) {
      socket.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: audio.subarray(offset, offset + chunk).toString('base64'),
        }),
      );
    }
    const silence = Buffer.alloc(ENGINE_SAMPLE_RATE * 2 * 2);
    for (let offset = 0; offset < silence.length; offset += chunk) {
      socket.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: silence.subarray(offset, offset + chunk).toString('base64'),
        }),
      );
    }

    // Input transcription arrives as one terminal event carrying `transcript`;
    // the delta events belong to the assistant speech-to-speech path.
    await waitFor(
      () =>
        frames.some(
          (f) =>
            f.type === 'conversation.item.input_audio_transcription.completed' ||
            f.type === 'conversation.item.input_audio_transcription.delta',
        ),
      45_000,
      'transcription event',
    );

    const text = frames
      .filter((f) => String(f.type).startsWith('conversation.item.input_audio_transcription.'))
      .map((f) => String(f.transcript ?? f.delta ?? ''))
      .join(' ')
      .toLowerCase();

    expect(text).toContain('quick brown fox');
    expect(text).toContain('lazy dog');
  }, 90_000);
});
