import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
  createAudioPayload,
  createSilentWavBuffer,
} from '../helpers.js';

const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

let app: FastifyInstance;
let accessToken: string;

beforeAll(async () => {
  app = await buildTestApp();
  const result = await registerAndGetToken(app);
  accessToken = result.accessToken;
});

afterAll(async () => {
  await app.close();
});

describe('POST /transcribe — validation (no API key needed)', () => {
  it('returns 400 when no audio file is provided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: authHeader(accessToken),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for unsupported audio format', async () => {
    const { body, contentType } = createAudioPayload('test.txt', 'text/plain');

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        ...authHeader(accessToken),
        'content-type': contentType,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Unsupported');
  });

  it('returns 401 without auth', async () => {
    const { body, contentType } = createAudioPayload('test.wav', 'audio/wav');

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
  });
});

describe.skipIf(!hasOpenAIKey)('POST /transcribe — real Whisper API', () => {
  it('returns 200 with transcription result for a valid WAV', async () => {
    const wavBuffer = createSilentWavBuffer(0.5);
    const { body, contentType } = createAudioPayload('test.wav', 'audio/wav', wavBuffer);

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        ...authHeader(accessToken),
        'content-type': contentType,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(typeof json.text).toBe('string');
    expect(json.provider).toBeDefined();
  });

  it('response includes text, language, duration, and provider', async () => {
    const wavBuffer = createSilentWavBuffer(0.5);
    const { body, contentType } = createAudioPayload('test.wav', 'audio/wav', wavBuffer);

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        ...authHeader(accessToken),
        'content-type': contentType,
      },
      payload: body,
    });

    const json = res.json();
    expect(json).toHaveProperty('text');
    expect(json).toHaveProperty('language');
    expect(json).toHaveProperty('duration');
    expect(json).toHaveProperty('provider');
  });

  it('accepts optional language parameter', async () => {
    const wavBuffer = createSilentWavBuffer(0.5);
    const { body, contentType } = createAudioPayload(
      'test.wav',
      'audio/wav',
      wavBuffer,
      { language: 'en' },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        ...authHeader(accessToken),
        'content-type': contentType,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
  });
});
