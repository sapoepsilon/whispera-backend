import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
  completeOAuthFlow,
} from '../helpers.js';

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

describe('GET /auth/oauth/openai (URL generation, no external call)', () => {
  it('returns 200 with authorization URL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oauth/openai',
      headers: authHeader(accessToken),
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
      headers: authHeader(accessToken),
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

describe('GET /auth/oauth/openai/callback (state validation)', () => {
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

  it('redirects to frontend with success on valid state (test mode token exchange)', async () => {
    const state = await completeOAuthFlow(app, accessToken);

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

describe('DELETE /auth/oauth/openai', () => {
  it('returns 204 after disconnecting', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/oauth/openai',
      headers: authHeader(accessToken),
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

describe('Provider Router — Codex OAuth resolution (DB-only)', () => {
  it('uses Codex OAuth token when no BYOK exists for OpenAI', async () => {
    const state = await completeOAuthFlow(app, accessToken);

    await app.inject({
      method: 'GET',
      url: `/auth/oauth/openai/callback?code=valid-auth-code&state=${state}`,
    });

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
    expect(res.json().keySource).toBe('codex-oauth');
  });

  it('falls back to credits when OAuth is disconnected and no BYOK', async () => {
    await app.inject({
      method: 'DELETE',
      url: '/auth/oauth/openai',
      headers: authHeader(accessToken),
    });

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
});
