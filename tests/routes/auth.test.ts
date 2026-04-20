import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerUser,
  registerAndGetToken,
  authHeader,
  DEFAULT_PASSWORD,
} from '../helpers.js';

const testUser = {
  email: 'test@example.com',
  password: DEFAULT_PASSWORD,
  name: 'Test User',
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('POST /auth/register', () => {
  it('returns 201 with accessToken and refreshToken for valid input', async () => {
    const response = await registerUser(app, testUser);

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('accessToken is a valid JWT string', async () => {
    const response = await registerUser(app, {
      email: 'jwt-check@example.com',
    });

    const body = response.json();
    const parts = body.accessToken.split('.');
    expect(parts).toHaveLength(3);
  });

  it('refreshToken is a 64-char hex string', async () => {
    const response = await registerUser(app, {
      email: 'refresh-check@example.com',
    });

    const body = response.json();
    expect(body.refreshToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns 400 for missing name', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testUser.email, password: testUser.password },
    });

    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['shorter than 8 chars', 'short-pw@example.com', 'short1A'],
    ['without uppercase', 'no-upper@example.com', 'alllowercase1'],
    ['without number', 'no-number@example.com', 'NoNumbersHere'],
  ])('returns 400 for password %s', async (_label, email, password) => {
    const response = await registerUser(app, { email, password });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 for invalid email format', async () => {
    const response = await registerUser(app, { email: 'not-an-email' });
    expect(response.statusCode).toBe(400);
  });

  it('returns 409 when registering with an already-used email', async () => {
    await registerUser(app, { email: 'duplicate@example.com' });
    const response = await registerUser(app, { email: 'duplicate@example.com' });
    expect(response.statusCode).toBe(409);
  });
});

describe('POST /auth/login', () => {
  beforeAll(async () => {
    await registerUser(app, testUser);
  });

  it('returns 200 with accessToken and refreshToken for correct credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: testUser.email, password: testUser.password },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('returns 401 with "Invalid email or password" for wrong password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: testUser.email, password: 'WrongPass1' },
    });

    expect(response.statusCode).toBe(401);

    const body = response.json();
    expect(body.message).toBe('Invalid email or password');
  });

  it('returns 401 with same message for non-existent email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: 'Whatever1' },
    });

    expect(response.statusCode).toBe(401);

    const body = response.json();
    expect(body.message).toBe('Invalid email or password');
  });

  it('returns 400 for missing fields', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /auth/refresh', () => {
  let validRefreshToken: string;

  beforeAll(async () => {
    const res = await registerUser(app, testUser);
    const body = res.json();
    validRefreshToken = body.refreshToken;
  });

  it('returns 200 with new token pair for valid refresh token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: validRefreshToken },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    expect(body.refreshToken).not.toBe(validRefreshToken);
  });

  it('old refresh token becomes invalid after rotation', async () => {
    const regRes = await registerUser(app, { email: 'rotation@example.com' });
    const originalToken = regRes.json().refreshToken;

    const firstRefresh = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: originalToken },
    });
    expect(firstRefresh.statusCode).toBe(200);

    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: originalToken },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('returns 401 for expired/invalid refresh token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: 'a'.repeat(64) },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 400 for empty refreshToken field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: '' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /auth/me', () => {
  let accessToken: string;

  beforeAll(async () => {
    const { accessToken: token } = await registerAndGetToken(app, testUser);
    accessToken = token;
  });

  it('returns 200 with user profile when authenticated', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(accessToken),
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.email).toBe(testUser.email);
    expect(body.name).toBe(testUser.name);
    expect(body.createdAt).toBeDefined();
  });

  it('response does NOT contain passwordHash', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(accessToken),
    });

    const body = response.json();
    expect(body.passwordHash).toBeUndefined();
  });

  it('returns 401 without Authorization header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 401 with expired/malformed JWT', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader('invalid.jwt.token'),
    });

    expect(response.statusCode).toBe(401);
  });
});
