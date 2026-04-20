import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildApp } from '../../src/server.js';

const testUser = {
  email: 'transcribe-test@example.com',
  password: 'ValidPass1',
  name: 'Transcribe Test User',
};

let app: FastifyInstance;
let accessToken: string;

beforeAll(async () => {
  app = await buildApp();

  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: testUser,
  });
  accessToken = res.json().accessToken;
});

afterAll(async () => {
  await app.close();
});

function authHeader() {
  return { authorization: `Bearer ${accessToken}` };
}

function createAudioPayload(
  filename: string,
  mimetype: string,
  content: Buffer = Buffer.from('fake-audio-data'),
) {
  const boundary = '----FormBoundary' + Date.now();
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="audio"; filename="${filename}"\r\n` +
        `Content-Type: ${mimetype}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('POST /transcribe', () => {
  it('returns 200 with transcription result for valid audio', async () => {
    const { body, contentType } = createAudioPayload('test.wav', 'audio/wav');

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        ...authHeader(),
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
        ...authHeader(),
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
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for unsupported audio format', async () => {
    const { body, contentType } = createAudioPayload('test.txt', 'text/plain');

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        ...authHeader(),
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

  it('accepts wav format', async () => {
    const { body, contentType } = createAudioPayload('test.wav', 'audio/wav');

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { ...authHeader(), 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
  });

  it('accepts mp3 format', async () => {
    const { body, contentType } = createAudioPayload('test.mp3', 'audio/mpeg');

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { ...authHeader(), 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
  });

  it('accepts m4a format', async () => {
    const { body, contentType } = createAudioPayload('test.m4a', 'audio/x-m4a');

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { ...authHeader(), 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
  });

  it('accepts webm format', async () => {
    const { body, contentType } = createAudioPayload('test.webm', 'audio/webm');

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { ...authHeader(), 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
  });

  it('accepts optional language parameter', async () => {
    const boundary = '----FormBoundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="audio"; filename="test.wav"\r\n` +
          `Content-Type: audio/wav\r\n\r\n`,
      ),
      Buffer.from('fake-audio'),
      Buffer.from(
        `\r\n--${boundary}\r\n` +
          `Content-Disposition: form-data; name="language"\r\n\r\n` +
          `en`,
      ),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: {
        ...authHeader(),
        'content-type': `multipart/form-data; boundary=${boundary}`,
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
      headers: { ...authHeader(), 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.provider).toMatch(/openai-whisper|whisper/);
  });
});
