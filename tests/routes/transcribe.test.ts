import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
  createAudioPayload,
} from '../helpers.js';

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

describe('POST /transcribe', () => {
  it('returns 200 with transcription result for valid audio', async () => {
    const { body, contentType } = createAudioPayload('test.wav', 'audio/wav');

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
    expect(json.text).toBeDefined();
    expect(typeof json.text).toBe('string');
    expect(json.provider).toBeDefined();
  });

  it('response includes text, language, duration, and provider', async () => {
    const { body, contentType } = createAudioPayload('test.mp3', 'audio/mpeg');

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

  it.each([
    ['wav', 'test.wav', 'audio/wav'],
    ['mp3', 'test.mp3', 'audio/mpeg'],
    ['m4a', 'test.m4a', 'audio/x-m4a'],
    ['webm', 'test.webm', 'audio/webm'],
  ])('accepts %s format', async (_label, filename, mimetype) => {
    const { body, contentType } = createAudioPayload(filename, mimetype);

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { ...authHeader(accessToken), 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
  });

  it('accepts optional language parameter', async () => {
    const { body, contentType } = createAudioPayload(
      'test.wav',
      'audio/wav',
      Buffer.from('fake-audio'),
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

  it('uses ProviderRouter for key resolution', async () => {
    const { body, contentType } = createAudioPayload('test.wav', 'audio/wav');

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { ...authHeader(accessToken), 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.provider).toMatch(/openai-whisper|whisper/);
  });
});
