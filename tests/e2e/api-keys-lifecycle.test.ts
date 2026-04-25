import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
  UUID_REGEX,
  NON_EXISTENT_UUID,
} from '../helpers.js';

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = await buildTestApp();
  const user = await registerAndGetToken(app);
  token = user.accessToken;
});

afterAll(async () => {
  await app.close();
});

describe('GET /auth/api-keys (initial state)', () => {
  it('returns 200 with empty keys array for new user', async () => {
    const freshUser = await registerAndGetToken(app);
    const res = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: authHeader(freshUser.accessToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().keys).toEqual([]);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/api-keys', () => {
  it('adds a Claude API key and returns 201 with id, provider, label, createdAt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(token),
      payload: { provider: 'claude', key: 'sk-ant-api03-valid-key', label: 'My Claude Key' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(UUID_REGEX);
    expect(body.provider).toBe('claude');
    expect(body.label).toBe('My Claude Key');
    expect(body.createdAt).toBeDefined();
  });

  it('adds an Anthropic provider key (alias for claude)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(token),
      payload: { provider: 'anthropic', key: 'sk-ant-api03-another', label: 'Anthropic Key' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().provider).toBe('anthropic');
  });

  it('adds an OpenAI API key and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(token),
      payload: { provider: 'openai', key: 'sk-valid-openai-key', label: 'OpenAI Key' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().provider).toBe('openai');
  });

  it('response never includes the raw key value', async () => {
    const rawKey = 'sk-ant-api03-secret-never-returned';
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(token),
      payload: { provider: 'claude', key: rawKey, label: 'Secret Key' },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.stringify(res.json())).not.toContain(rawKey);
  });

  it('label is optional — omitting it results in null label', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(token),
      payload: { provider: 'openai', key: 'sk-no-label-key' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().label).toBeNull();
  });

  it('returns 422 for Claude key without sk-ant- prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(token),
      payload: { provider: 'claude', key: 'not-a-valid-claude-key', label: 'Bad Key' },
    });

    expect(res.statusCode).toBe(422);
  });

  it('returns 422 for OpenAI key without sk- prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(token),
      payload: { provider: 'openai', key: 'invalid-openai-key' },
    });

    expect(res.statusCode).toBe(422);
  });

  it('returns 400 for unsupported provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(token),
      payload: { provider: 'gemini', key: 'some-key' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when key field is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(token),
      payload: { provider: 'openai' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when key is empty string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(token),
      payload: { provider: 'openai', key: '' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      payload: { provider: 'openai', key: 'sk-test' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /auth/api-keys (after additions)', () => {
  let userToken: string;
  let createdKeyId: string;

  beforeAll(async () => {
    const user = await registerAndGetToken(app);
    userToken = user.accessToken;

    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(userToken),
      payload: { provider: 'openai', key: 'sk-listed-key', label: 'Listed Key' },
    });
    createdKeyId = res.json().id;
  });

  it('lists the added key with id, provider, label, createdAt', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: authHeader(userToken),
    });

    expect(res.statusCode).toBe(200);
    const { keys } = res.json();
    expect(keys.length).toBeGreaterThanOrEqual(1);

    const found = keys.find((k: { id: string }) => k.id === createdKeyId);
    expect(found).toBeDefined();
    expect(found.provider).toBe('openai');
    expect(found.label).toBe('Listed Key');
    expect(found.createdAt).toBeDefined();
  });

  it('list response never exposes the encrypted or raw key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: authHeader(userToken),
    });

    const responseText = JSON.stringify(res.json());
    expect(responseText).not.toContain('sk-listed-key');
    expect(responseText).not.toContain('encryptedKey');
    expect(responseText).not.toContain('encrypted_key');
  });

  it('keys from other users are not visible', async () => {
    const otherUser = await registerAndGetToken(app);
    await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(otherUser.accessToken),
      payload: { provider: 'openai', key: 'sk-other-user-key', label: 'Other' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: authHeader(userToken),
    });

    const { keys } = res.json();
    const allLabels = keys.map((k: { label: string | null }) => k.label);
    expect(allLabels).not.toContain('Other');
  });

  it('adding same provider twice creates two separate entries', async () => {
    const freshUser = await registerAndGetToken(app);

    await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(freshUser.accessToken),
      payload: { provider: 'openai', key: 'sk-first-key', label: 'First' },
    });
    await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(freshUser.accessToken),
      payload: { provider: 'openai', key: 'sk-second-key', label: 'Second' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: authHeader(freshUser.accessToken),
    });

    const openaiKeys = res.json().keys.filter((k: { provider: string }) => k.provider === 'openai');
    expect(openaiKeys.length).toBe(2);
  });
});

describe('DELETE /auth/api-keys/:id', () => {
  let userToken: string;
  let keyId: string;

  beforeAll(async () => {
    const user = await registerAndGetToken(app);
    userToken = user.accessToken;

    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(userToken),
      payload: { provider: 'claude', key: 'sk-ant-api03-to-delete', label: 'Delete Me' },
    });
    keyId = res.json().id;
  });

  it('deletes an existing key and returns 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/auth/api-keys/${keyId}`,
      headers: authHeader(userToken),
    });

    expect(res.statusCode).toBe(204);
  });

  it('deleted key no longer appears in list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: authHeader(userToken),
    });

    const { keys } = res.json();
    const found = keys.find((k: { id: string }) => k.id === keyId);
    expect(found).toBeUndefined();
  });

  it('double-delete returns 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/auth/api-keys/${keyId}`,
      headers: authHeader(userToken),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for non-existent key UUID', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/auth/api-keys/${NON_EXISTENT_UUID}`,
      headers: authHeader(userToken),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for non-UUID key id', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/api-keys/not-a-uuid',
      headers: authHeader(userToken),
    });

    expect(res.statusCode).toBe(400);
  });

  it('User A cannot delete User B key (returns 404)', async () => {
    const otherUser = await registerAndGetToken(app);
    const createRes = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(otherUser.accessToken),
      payload: { provider: 'openai', key: 'sk-other-protected-key', label: 'Protected' },
    });
    const otherId = createRes.json().id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/auth/api-keys/${otherId}`,
      headers: authHeader(userToken),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/auth/api-keys/${NON_EXISTENT_UUID}`,
    });

    expect(res.statusCode).toBe(401);
  });
});
