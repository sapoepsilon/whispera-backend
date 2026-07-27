import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildTestApp, registerAndGetToken, authHeader, createAudioPayload } from '../helpers.js';
import { createTranscriptionProvider } from '../../src/services/transcription/factory.js';

/**
 * The pluggable provider against a REAL OpenAI-compatible speech-to-text server.
 *
 * Every other transcription test mocks the AI SDK, so nothing exercised the
 * custom-base-URL provider over the wire: not the multipart parsing, not the
 * factory's env selection, not a model actually returning words.
 *
 * Opt-in by pointing it at any OpenAI-compatible endpoint:
 *
 *   LOCAL_STT_BASE_URL=http://192.168.50.140:8000/v1 \
 *   LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3 \
 *   pnpm test tests/e2e/local-stt-provider.test.ts
 *
 * Unlike the `real-openai-*` suites, this one SKIPS rather than throws when it is
 * not configured. It costs nothing to leave enabled against a local model, and it
 * must never turn CI red for want of a LAN it cannot reach.
 */
const baseUrl = process.env.LOCAL_STT_BASE_URL?.trim();
const model = process.env.LOCAL_STT_MODEL?.trim() || 'whisper-1';

// The fixture is five seconds of speech: "The quick brown fox jumps over the lazy
// dog. Whispera transcription end to end test." Any model worth wiring up gets
// the pangram right, which is what the assertions key off — the coined word
// "Whispera" is deliberately not asserted, since models render it differently.
const audio = readFileSync(fileURLToPath(new URL('../fixtures/spoken-sentence.wav', import.meta.url)));

describe.skipIf(!baseUrl)('transcription against a real local STT server', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    // read by the factory at route registration, so it must be set before the
    // app is built
    process.env.TRANSCRIPTION_PROVIDER = 'custom';
    process.env.TRANSCRIPTION_BASE_URL = baseUrl;
    process.env.TRANSCRIPTION_MODEL = model;
    process.env.TRANSCRIPTION_API_KEY ??= 'not-required-locally';

    app = await buildTestApp();
    token = (await registerAndGetToken(app)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('transcribes a real upload through POST /transcribe', async () => {
    const { body, contentType } = createAudioPayload('spoken-sentence.wav', 'audio/wav', audio);

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { ...authHeader(token), 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const result = res.json() as { text: string; provider: string; language: string };
    expect(result.text.toLowerCase()).toContain('quick brown fox');
    expect(result.text.toLowerCase()).toContain('lazy dog');
    // the route must be unaware of which implementation it got, but the response
    // still reports it — this is what proves the custom provider was selected
    expect(result.provider).toBe('openai-compatible');
  });

  it('reaches the same server through the provider directly', async () => {
    // if these two ever disagree, the route is doing something to the audio on
    // its way through
    const provider = createTranscriptionProvider({
      TRANSCRIPTION_PROVIDER: 'custom',
      TRANSCRIPTION_BASE_URL: baseUrl,
      TRANSCRIPTION_MODEL: model,
      TRANSCRIPTION_API_KEY: 'not-required-locally',
    });

    expect(provider.supportsMimetype('audio/wav')).toBe(true);
    const result = await provider.transcribe({ audio, mimetype: 'audio/wav' });
    expect(result.text.toLowerCase()).toContain('quick brown fox');
    expect(result.provider).toBe('openai-compatible');
  });

  it('still refuses an unsupported upload before spending the request', async () => {
    const { body, contentType } = createAudioPayload('notes.txt', 'text/plain', Buffer.from('hi'));

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { ...authHeader(token), 'content-type': contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Unsupported');
  });
});
