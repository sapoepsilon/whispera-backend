import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
} from '../helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('Credits initial state', () => {
  it('new user starts with balance 0', async () => {
    const user = await registerAndGetToken(app);
    const res = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(user.accessToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().balance).toBe(0);
  });

  it('new user starts with empty transaction history', async () => {
    const user = await registerAndGetToken(app);
    const res = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(user.accessToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().transactions).toEqual([]);
  });
});

describe('Credits via Stripe webhook (test mode)', () => {
  it('checkout.session.completed adds credits and updates balance', async () => {
    const user = await registerAndGetToken(app);
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(user.accessToken),
    });
    const userId = meRes.json().id;

    await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: { 'stripe-signature': 'valid-test-signature', 'content-type': 'application/json' },
      payload: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_starter_${Date.now()}`,
            metadata: { userId, packageId: 'starter' },
          },
        },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(user.accessToken),
    });

    expect(res.json().balance).toBeGreaterThan(0);
  });

  it('balance matches the starter package credit amount (100)', async () => {
    const user = await registerAndGetToken(app);
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(user.accessToken),
    });
    const userId = meRes.json().id;

    await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: { 'stripe-signature': 'valid-test-signature', 'content-type': 'application/json' },
      payload: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_balance_check_${Date.now()}`,
            metadata: { userId, packageId: 'starter' },
          },
        },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(user.accessToken),
    });

    expect(res.json().balance).toBe(100);
  });

  it('transaction is recorded after credit addition', async () => {
    const user = await registerAndGetToken(app);
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(user.accessToken),
    });
    const userId = meRes.json().id;

    await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: { 'stripe-signature': 'valid-test-signature', 'content-type': 'application/json' },
      payload: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_tx_record_${Date.now()}`,
            metadata: { userId, packageId: 'starter' },
          },
        },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(user.accessToken),
    });

    expect(res.json().transactions.length).toBeGreaterThan(0);
  });

  it('duplicate session ID does not double-credit (idempotency)', async () => {
    const user = await registerAndGetToken(app);
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(user.accessToken),
    });
    const userId = meRes.json().id;
    const sessionId = `cs_idempotent_${Date.now()}`;

    const webhookBody = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          metadata: { userId, packageId: 'starter' },
        },
      },
    };
    const webhookHeaders = {
      'stripe-signature': 'valid-test-signature',
      'content-type': 'application/json',
    };

    await app.inject({ method: 'POST', url: '/billing/webhooks/stripe', headers: webhookHeaders, payload: webhookBody });
    await app.inject({ method: 'POST', url: '/billing/webhooks/stripe', headers: webhookHeaders, payload: webhookBody });

    const res = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(user.accessToken),
    });

    expect(res.json().balance).toBe(100);
    expect(res.json().transactions.length).toBe(1);
  });

  it('multiple different sessions accumulate balance correctly', async () => {
    const user = await registerAndGetToken(app);
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(user.accessToken),
    });
    const userId = meRes.json().id;

    const now = Date.now();

    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/billing/webhooks/stripe',
        headers: { 'stripe-signature': 'valid-test-signature', 'content-type': 'application/json' },
        payload: {
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_multi_${now}_${i}`,
              metadata: { userId, packageId: 'starter' },
            },
          },
        },
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(user.accessToken),
    });

    expect(res.json().balance).toBe(300);
    expect(res.json().transactions.length).toBe(3);
  });

  it('pro package adds 500 credits', async () => {
    const user = await registerAndGetToken(app);
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(user.accessToken),
    });
    const userId = meRes.json().id;

    await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: { 'stripe-signature': 'valid-test-signature', 'content-type': 'application/json' },
      payload: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_pro_${Date.now()}`,
            metadata: { userId, packageId: 'pro' },
          },
        },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(user.accessToken),
    });

    expect(res.json().balance).toBe(500);
  });

  it('enterprise package adds 2000 credits', async () => {
    const user = await registerAndGetToken(app);
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(user.accessToken),
    });
    const userId = meRes.json().id;

    await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: { 'stripe-signature': 'valid-test-signature', 'content-type': 'application/json' },
      payload: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_enterprise_${Date.now()}`,
            metadata: { userId, packageId: 'enterprise' },
          },
        },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(user.accessToken),
    });

    expect(res.json().balance).toBe(2000);
  });

  it('webhook with unknown packageId does not add credits', async () => {
    const user = await registerAndGetToken(app);
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(user.accessToken),
    });
    const userId = meRes.json().id;

    await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: { 'stripe-signature': 'valid-test-signature', 'content-type': 'application/json' },
      payload: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_unknown_${Date.now()}`,
            metadata: { userId, packageId: 'nonexistent' },
          },
        },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(user.accessToken),
    });

    expect(res.json().balance).toBe(0);
  });

  it('webhook returns 200 received:true even for unknown events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: { 'stripe-signature': 'valid-test-signature', 'content-type': 'application/json' },
      payload: {
        type: 'payment_intent.created',
        data: { object: {} },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
  });

  it('webhook without stripe-signature header returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: { type: 'checkout.session.completed', data: { object: {} } },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /billing/credits access control', () => {
  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/billing/credits',
    });

    expect(res.statusCode).toBe(401);
  });
});
