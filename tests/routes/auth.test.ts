import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildTestApp, authHeader } from '../helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('GET /auth/me', () => {
  it('returns 200 with user profile when authenticated', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader('test-clerk-user-id-1'),
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.clerkId).toBe('test-clerk-user-id-1');
    expect(body.createdAt).toBeDefined();
  });

  it('auto-provisions user in local DB on first request', async () => {
    const uniqueId = `clerk-new-user-${Date.now()}`;
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(uniqueId),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.clerkId).toBe(uniqueId);

    const secondResponse = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(uniqueId),
    });

    expect(secondResponse.json().id).toBe(body.id);
  });

  it('returns 401 without Authorization header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 with empty token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer ' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('Auth middleware on protected routes', () => {
  it('protected routes return 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/recipes',
    });

    expect(response.statusCode).toBe(401);
  });

  it('protected routes work with valid auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader('test-clerk-user-protected'),
    });

    expect(response.statusCode).toBe(200);
  });
});
