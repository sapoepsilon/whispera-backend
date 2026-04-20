import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/server.js';

const testUser = {
  email: 'provider-integration@example.com',
  password: 'ValidPass1',
  name: 'Provider Integration User',
};

const multiKeyUser = {
  email: 'provider-multi@example.com',
  password: 'ValidPass1',
  name: 'Multi Provider User',
};

describe('BYOK works for Claude (Anthropic)', () => {
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

  it('adds a Claude API key and returns 201 with metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
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

  it('lists the Claude key via GET /auth/api-keys', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const claudeKeys = body.keys.filter(
      (k: { provider: string }) => k.provider === 'anthropic',
    );
    expect(claudeKeys.length).toBeGreaterThanOrEqual(1);
    expect(claudeKeys[0].label).toBe('My Claude Key');
  });

  it('uses the BYOK Claude key for a test chat completion', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
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

describe('BYOK works for OpenAI', () => {
  let app: FastifyInstance;
  let accessToken: string;

  beforeAll(async () => {
    app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'provider-openai@example.com',
        password: 'ValidPass1',
        name: 'OpenAI BYOK User',
      },
    });
    accessToken = res.json().accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('adds an OpenAI API key and returns 201 with metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
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
    expect(body.createdAt).toBeDefined();
  });

  it('lists the OpenAI key via GET /auth/api-keys', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const openaiKeys = body.keys.filter(
      (k: { provider: string }) => k.provider === 'openai',
    );
    expect(openaiKeys.length).toBeGreaterThanOrEqual(1);
    expect(openaiKeys[0].label).toBe('My OpenAI Key');
  });

  it('uses the BYOK OpenAI key for a test chat completion', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: { authorization: `Bearer ${accessToken}` },
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

describe('Provider Router resolution', () => {
  let app: FastifyInstance;
  let accessToken: string;

  beforeAll(async () => {
    app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'provider-router@example.com',
        password: 'ValidPass1',
        name: 'Router Test User',
      },
    });
    accessToken = res.json().accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('uses BYOK key when one exists for the requested provider', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'anthropic',
        key: 'sk-ant-api03-test-router-key-1234567890abcdef',
        label: 'Router Claude Key',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.keySource).toBe('byok');
  });

  it('falls back to credits when no BYOK key exists for the provider', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.keySource).toBe('credits');
  });
});

describe('Key validation on add', () => {
  let app: FastifyInstance;
  let accessToken: string;

  beforeAll(async () => {
    app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'provider-validation@example.com',
        password: 'ValidPass1',
        name: 'Validation User',
      },
    });
    accessToken = res.json().accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an invalid Anthropic key with 422', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
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
      headers: { authorization: `Bearer ${accessToken}` },
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
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'openai',
        key: '',
        label: 'Empty Key',
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('Multiple providers simultaneously', () => {
  let app: FastifyInstance;
  let accessToken: string;

  beforeAll(async () => {
    app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: multiKeyUser,
    });
    accessToken = res.json().accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('user can add both an Anthropic and an OpenAI key', async () => {
    const claudeRes = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'anthropic',
        key: 'sk-ant-api03-test-multi-claude-key-1234567890ab',
        label: 'Multi Claude Key',
      },
    });

    const openaiRes = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'openai',
        key: 'sk-test-multi-openai-key-1234567890abcdef',
        label: 'Multi OpenAI Key',
      },
    });

    expect(claudeRes.statusCode).toBe(201);
    expect(openaiRes.statusCode).toBe(201);
  });

  it('lists both keys in GET /auth/api-keys', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const providers = body.keys.map((k: { provider: string }) => k.provider);
    expect(providers).toContain('anthropic');
    expect(providers).toContain('openai');
  });

  it('routes Anthropic requests through the Anthropic BYOK key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello from Claude' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().keySource).toBe('byok');
  });

  it('routes OpenAI requests through the OpenAI BYOK key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello from OpenAI' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().keySource).toBe('byok');
  });
});

describe('Key deletion falls back to credits', () => {
  let app: FastifyInstance;
  let accessToken: string;
  let claudeKeyId: string;

  beforeAll(async () => {
    app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'provider-deletion@example.com',
        password: 'ValidPass1',
        name: 'Deletion User',
      },
    });
    accessToken = res.json().accessToken;

    const keyRes = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'anthropic',
        key: 'sk-ant-api03-test-deletion-key-1234567890abcdef',
        label: 'Deletion Claude Key',
      },
    });
    claudeKeyId = keyRes.json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('uses BYOK before deletion', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
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
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(204);
  });

  it('falls back to credits after key deletion', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
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
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const ids = body.keys.map((k: { id: string }) => k.id);
    expect(ids).not.toContain(claudeKeyId);
  });
});
