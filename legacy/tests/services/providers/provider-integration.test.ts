import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildTestApp, registerAndGetToken, authHeader } from '../../helpers.js';

const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('BYOK key management (DB-only)', () => {
  let accessToken: string;

  beforeAll(async () => {
    ({ accessToken } = await registerAndGetToken(app));
  });

  it('adds a Claude API key and returns 201 with metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(accessToken),
      payload: {
        provider: 'anthropic',
        key: 'sk-ant-api03-test-claude-key-valid-1234567890abcdef',
        label: 'My Claude Key',
      },
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.provider).toBe('anthropic');
    expect(body.label).toBe('My Claude Key');
    expect(body.createdAt).toBeDefined();
  });

  it('adds an OpenAI API key and returns 201 with metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(accessToken),
      payload: {
        provider: 'openai',
        key: 'sk-test-openai-valid-key-1234567890abcdef',
        label: 'My OpenAI Key',
      },
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.provider).toBe('openai');
    expect(body.label).toBe('My OpenAI Key');
  });

  it('lists saved keys via GET /auth/api-keys', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: authHeader(accessToken),
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const providers = body.keys.map((k: { provider: string }) => k.provider);
    expect(providers).toContain('anthropic');
    expect(providers).toContain('openai');
  });
});

describe('Key validation on add (DB-only)', () => {
  let accessToken: string;

  beforeAll(async () => {
    ({ accessToken } = await registerAndGetToken(app));
  });

  it('rejects an invalid Anthropic key with 422', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(accessToken),
      payload: {
        provider: 'anthropic',
        key: 'totally-not-a-real-key',
        label: 'Bad Claude Key',
      },
    });

    expect(response.statusCode).toBe(422);
  });

  it('rejects an invalid OpenAI key with 422', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(accessToken),
      payload: {
        provider: 'openai',
        key: 'totally-not-a-real-key',
        label: 'Bad OpenAI Key',
      },
    });

    expect(response.statusCode).toBe(422);
  });

  it('rejects an empty key string with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(accessToken),
      payload: {
        provider: 'openai',
        key: '',
        label: 'Empty Key',
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('Provider Router resolution (DB-only)', () => {
  let accessToken: string;

  beforeAll(async () => {
    ({ accessToken } = await registerAndGetToken(app));
  });

  it('uses BYOK key when one exists for the requested provider', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(accessToken),
      payload: {
        provider: 'anthropic',
        key: 'sk-ant-api03-test-router-key-1234567890abcdef',
        label: 'Router Claude Key',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: authHeader(accessToken),
      payload: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6-20250501',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().keySource).toBe('byok');
  });

  it('falls back to credits when no BYOK key exists for the provider', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: authHeader(accessToken),
      payload: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().keySource).toBe('credits');
  });
});

describe('Key deletion falls back to credits (DB-only)', () => {
  let accessToken: string;
  let claudeKeyId: string;

  beforeAll(async () => {
    ({ accessToken } = await registerAndGetToken(app));

    const keyRes = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(accessToken),
      payload: {
        provider: 'anthropic',
        key: 'sk-ant-api03-test-deletion-key-1234567890abcdef',
        label: 'Deletion Claude Key',
      },
    });
    claudeKeyId = keyRes.json().id;
  });

  it('uses BYOK before deletion', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: authHeader(accessToken),
      payload: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6-20250501',
        messages: [{ role: 'user', content: 'Pre-delete test' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().keySource).toBe('byok');
  });

  it('deletes the Claude key successfully', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/auth/api-keys/${claudeKeyId}`,
      headers: authHeader(accessToken),
    });

    expect(response.statusCode).toBe(204);
  });

  it('falls back to credits after key deletion', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: authHeader(accessToken),
      payload: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6-20250501',
        messages: [{ role: 'user', content: 'Post-delete test' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().keySource).toBe('credits');
  });

  it('no longer lists the deleted key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: authHeader(accessToken),
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const ids = body.keys.map((k: { id: string }) => k.id);
    expect(ids).not.toContain(claudeKeyId);
  });
});

describe.skipIf(!hasOpenAIKey)('Real LLM calls via BYOK', () => {
  let accessToken: string;

  beforeAll(async () => {
    ({ accessToken } = await registerAndGetToken(app));
  });

  it('uses the BYOK OpenAI key for a real chat completion', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(accessToken),
      payload: {
        provider: 'openai',
        key: process.env.OPENAI_API_KEY,
        label: 'Real OpenAI Key',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: authHeader(accessToken),
      payload: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Say hello' }],
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.choices).toBeDefined();
    expect(body.choices.length).toBeGreaterThan(0);
    expect(body.choices[0].message.content).toBeDefined();
  });
});
