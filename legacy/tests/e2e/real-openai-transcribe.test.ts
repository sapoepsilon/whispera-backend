import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';

try {
  const parsed = parseEnv(readFileSync(resolve(process.cwd(), '.env'), 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v as string;
  }
} catch {}

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
  createSilentWavBuffer,
  createAudioPayload,
} from '../helpers.js';

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for real-openai E2E tests. Set it in .env or skip this file.');
  }
  app = await buildTestApp();
  const user = await registerAndGetToken(app);
  token = user.accessToken;
});

afterAll(async () => {
  await app?.close();
});

function createToneWavBuffer(
  durationSeconds = 1.5,
  freqHz = 440,
  sampleRate = 16000,
): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataSize = numSamples * numChannels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
    const intSample = Math.round(sample * 0.3 * 0x7fff);
    buffer.writeInt16LE(intSample, 44 + i * bytesPerSample);
  }

  return buffer;
}

describe('Real Whisper E2E — POST /transcribe', () => {
  it('returns a 200 transcription response for a short audio buffer', async () => {
    const wav = createToneWavBuffer(1.5);
    const { body, contentType } = createAudioPayload(
      'test-tone.wav',
      'audio/wav',
      wav,
      { language: 'en' },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { ...authHeader(token), 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(typeof json.text).toBe('string');
    expect(typeof json.language).toBe('string');
    expect(typeof json.duration).toBe('number');
    expect(json.duration).toBeGreaterThan(0);
    expect(json.provider).toBe('openai-whisper');
  });

  it('accepts a silent WAV without throwing (Whisper may return empty text)', async () => {
    const wav = createSilentWavBuffer(1.5);
    const { body, contentType } = createAudioPayload(
      'silence.wav',
      'audio/wav',
      wav,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { ...authHeader(token), 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.provider).toBe('openai-whisper');
    expect(typeof json.text).toBe('string');
  });
});
