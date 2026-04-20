import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/server.js';
import { encrypt, decrypt } from '../../src/services/crypto/index.js';

const testUser = {
  email: 'byok-test@example.com',
  password: 'ValidPass1',
  name: 'BYOK Test User',
};

const otherUser = {
  email: 'byok-other@example.com',
  password: 'ValidPass1',
  name: 'Other User',
};

describe('POST /auth/api-keys', () => {
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

  it('returns 201 with { id, provider, label, createdAt } for valid key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'openai',
        key: 'sk-test-valid-key-1234567890abcdef',
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

  it('response never contains the key value itself', async () => {
    const rawKey = 'sk-test-should-not-appear-in-response';
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'anthropic',
        key: rawKey,
        label: 'Secret Key',
      },
    });

    const body = response.json();
    expect(body.key).toBeUndefined();
    expect(body.encryptedKey).toBeUndefined();
    expect(body.iv).toBeUndefined();
    expect(body.authTag).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(rawKey);
  });

  it('returns 400 for missing provider', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        key: 'sk-test-1234567890abcdef',
        label: 'No Provider',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 for missing key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'openai',
        label: 'No Key',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 422 for invalid API key (validation fails)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'openai',
        key: 'not-a-valid-api-key',
        label: 'Bad Key',
      },
    });

    expect(response.statusCode).toBe(422);
  });

  it('returns 409 for duplicate provider+label combo', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'openai',
        key: 'sk-test-duplicate-check-key-1111',
        label: 'Duplicate Label',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'openai',
        key: 'sk-test-duplicate-check-key-2222',
        label: 'Duplicate Label',
      },
    });

    expect(response.statusCode).toBe(409);
  });

  it('returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      payload: {
        provider: 'openai',
        key: 'sk-test-no-auth-key-1234567890',
        label: 'No Auth',
      },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('GET /auth/api-keys', () => {
  let app: FastifyInstance;
  let accessToken: string;
  let freshAccessToken: string;

  beforeAll(async () => {
    app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: testUser,
    });
    accessToken = res.json().accessToken;

    await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'openai',
        key: 'sk-test-list-key-1234567890abcdef',
        label: 'List Test Key',
      },
    });

    const freshRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'byok-fresh@example.com',
        password: 'ValidPass1',
        name: 'Fresh User',
      },
    });
    freshAccessToken = freshRes.json().accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with { keys: [...] }', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.keys).toBeDefined();
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys.length).toBeGreaterThan(0);
    expect(body.keys[0].id).toBeDefined();
    expect(body.keys[0].provider).toBeDefined();
    expect(body.keys[0].label).toBeDefined();
  });

  it('listed keys never contain the encrypted key, iv, or authTag', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const body = response.json();
    for (const key of body.keys) {
      expect(key.encryptedKey).toBeUndefined();
      expect(key.key).toBeUndefined();
      expect(key.iv).toBeUndefined();
      expect(key.authTag).toBeUndefined();
      expect(key.ciphertext).toBeUndefined();
      expect(key.tag).toBeUndefined();
    }
  });

  it('returns empty array when no keys exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${freshAccessToken}` },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.keys).toEqual([]);
  });

  it('returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/api-keys',
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('DELETE /auth/api-keys/:id', () => {
  let app: FastifyInstance;
  let accessToken: string;
  let otherAccessToken: string;
  let keyId: string;
  let otherKeyId: string;

  beforeAll(async () => {
    app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: testUser,
    });
    accessToken = res.json().accessToken;

    const keyRes = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        provider: 'openai',
        key: 'sk-test-delete-key-1234567890abcd',
        label: 'Delete Test Key',
      },
    });
    keyId = keyRes.json().id;

    const otherRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: otherUser,
    });
    otherAccessToken = otherRes.json().accessToken;

    const otherKeyRes = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: { authorization: `Bearer ${otherAccessToken}` },
      payload: {
        provider: 'anthropic',
        key: 'sk-ant-test-other-user-key-123456',
        label: 'Other User Key',
      },
    });
    otherKeyId = otherKeyRes.json().id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 204 for successful deletion', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/auth/api-keys/${keyId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(204);
  });

  it('returns 404 for non-existent key', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/auth/api-keys/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 when trying to delete another user's key", async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/auth/api-keys/${otherKeyId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/auth/api-keys/${otherKeyId}`,
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('Encryption (encrypt/decrypt)', () => {
  it('encrypt() returns { ciphertext, iv, tag } - all hex strings', () => {
    const result = encrypt('test-api-key-value');

    expect(result.ciphertext).toBeDefined();
    expect(result.iv).toBeDefined();
    expect(result.tag).toBeDefined();

    const hexPattern = /^[a-f0-9]+$/;
    expect(result.ciphertext).toMatch(hexPattern);
    expect(result.iv).toMatch(hexPattern);
    expect(result.tag).toMatch(hexPattern);
  });

  it('decrypt(encrypt(plaintext)) returns original plaintext', () => {
    const plaintext = 'sk-my-secret-api-key-1234567890';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('decrypt with wrong key/iv/tag throws', () => {
    const encrypted = encrypt('test-value');

    expect(() =>
      decrypt({
        ciphertext: encrypted.ciphertext,
        iv: 'aa'.repeat(12),
        tag: encrypted.tag,
      }),
    ).toThrow();

    expect(() =>
      decrypt({
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: 'bb'.repeat(16),
      }),
    ).toThrow();
  });

  it('ciphertext is different from plaintext', () => {
    const plaintext = 'sk-plaintext-api-key';
    const encrypted = encrypt(plaintext);

    expect(encrypted.ciphertext).not.toBe(plaintext);
  });
});
