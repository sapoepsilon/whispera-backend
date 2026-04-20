import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/server.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 status code', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns status "ok"', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    const body = response.json();
    expect(body.status).toBe('ok');
  });

  it('returns an ISO 8601 timestamp', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    const body = response.json();
    expect(body.timestamp).toBeDefined();
    expect(typeof body.timestamp).toBe('string');

    const parsed = new Date(body.timestamp);
    expect(parsed.toISOString()).toBe(body.timestamp);
  });

  it('returns a version string', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    const body = response.json();
    expect(body.version).toBeDefined();
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  it('responds with application/json content-type', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['content-type']).toContain('application/json');
  });
});
