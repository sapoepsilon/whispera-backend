import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
} from '../helpers.js';

const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

let app: FastifyInstance;
let accessToken: string;

beforeAll(async () => {
  app = await buildTestApp();
  const user = await registerAndGetToken(app);
  accessToken = user.accessToken;
});

afterAll(async () => {
  await app.close();
});

describe('BYOK key source resolution (no external API needed)', () => {
  it('falls back to credits when no X-Provider-Key header is present', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: authHeader(accessToken),
      payload: {
        provider: 'openai',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().keySource).toBe('credits');
  });

  it('key is not persisted — /auth/me never returns it', async () => {
    await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: {
        ...authHeader(accessToken),
        'x-provider-key': 'sk-should-never-be-stored',
      },
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(accessToken),
    });

    const body = meRes.json();
    expect(JSON.stringify(body)).not.toContain('sk-should-never-be-stored');
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: {
        'x-provider-key': 'sk-test-key-123',
      },
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('key is not included in error responses', async () => {
    const testKey = 'sk-ant-api03-secret-key-do-not-log';
    const res = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: {
        ...authHeader(accessToken),
        'x-provider-key': testKey,
      },
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    const responseText = res.payload;
    expect(responseText).not.toContain(testKey);
  });
});

describe.skipIf(!hasOpenAIKey)('BYOK with real provider calls', () => {
  it('returns provider error for invalid key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: {
        ...authHeader(accessToken),
        'x-provider-key': 'sk-invalid-key-that-will-401',
      },
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect([401, 403]).toContain(res.statusCode);
  });
});
