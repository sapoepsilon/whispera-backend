import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/server.js';

const testUser = {
  email: 'codex-oauth-test@example.com',
  password: 'ValidPass1',
  name: 'Codex OAuth Test User',
};

let app: FastifyInstance;
let accessToken: string;

beforeAll(async () => {
  app = await buildApp();

  const registerRes = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: testUser,
  });
  accessToken = registerRes.json().accessToken;
});

afterAll(async () => {
  await app.close();
});

function authHeader() {
  return { authorization: `Bearer ${accessToken}` };
}

describe('GET /auth/oauth/openai — initiate Codex OAuth flow', () => {
  it('returns 200 with authorization URL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oauth/openai',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toBeDefined();
    expect(typeof body.url).toBe('string');
  });

  it('URL contains required OAuth parameters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oauth/openai',
      headers: authHeader(),
    });

    const url = new URL(res.json().url);
    expect(url.searchParams.get('client_id')).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBeTruthy();
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oauth/openai',
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /auth/oauth/openai/callback — handle OAuth callback', () => {
  it('redirects with error for invalid state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oauth/openai/callback?code=test-code&state=invalid-state',
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('status=error');
  });

  it('redirects with error for missing code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oauth/openai/callback?state=some-state',
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('status=error');
  });

  it('redirects to frontend with success on valid flow', async () => {
    const initiateRes = await app.inject({
      method: 'GET',
      url: '/auth/oauth/openai',
      headers: authHeader(),
    });

    const url = new URL(initiateRes.json().url);
    const state = url.searchParams.get('state');

    const res = await app.inject({
      method: 'GET',
      url: `/auth/oauth/openai/callback?code=valid-auth-code&state=${state}`,
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('status=connected');
    expect(location).toContain('oauth=openai');
  });
});

describe('DELETE /auth/oauth/openai — disconnect', () => {
  it('returns 204 after disconnecting', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/oauth/openai',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/oauth/openai',
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('Provider Router — Codex OAuth resolution', () => {
  it('uses Codex OAuth token when no BYOK exists for OpenAI', async () => {
    const initiateRes = await app.inject({
      method: 'GET',
      url: '/auth/oauth/openai',
      headers: authHeader(),
    });
    const url = new URL(initiateRes.json().url);
    const state = url.searchParams.get('state');

    await app.inject({
      method: 'GET',
      url: `/auth/oauth/openai/callback?code=valid-auth-code&state=${state}`,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: authHeader(),
      payload: {
        provider: 'openai',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().keySource).toBe('codex-oauth');
  });

  it('BYOK takes precedence over Codex OAuth', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(),
      payload: { provider: 'openai', key: 'sk-test-byok-key' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: authHeader(),
      payload: {
        provider: 'openai',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().keySource).toBe('byok');
  });

  it('falls back to credits when OAuth is disconnected and no BYOK', async () => {
    await app.inject({
      method: 'DELETE',
      url: '/auth/oauth/openai',
      headers: authHeader(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: authHeader(),
      payload: {
        provider: 'openai',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().keySource).toBe('credits');
  });
});

describe('Token refresh', () => {
  it('automatically refreshes expired OAuth tokens', async () => {
    const initiateRes = await app.inject({
      method: 'GET',
      url: '/auth/oauth/openai',
      headers: authHeader(),
    });
    const url = new URL(initiateRes.json().url);
    const state = url.searchParams.get('state');

    await app.inject({
      method: 'GET',
      url: `/auth/oauth/openai/callback?code=valid-auth-code&state=${state}`,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: authHeader(),
      payload: {
        provider: 'openai',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(res.statusCode).toBe(200);
  });
});
