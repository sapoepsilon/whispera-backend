import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/server.js';
import { CreditService } from '../../src/services/billing/credits.js';

const testUser = {
  email: 'credits-test@example.com',
  password: 'ValidPass1',
  name: 'Credits Test User',
};

describe('GET /billing/credits', () => {
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

  it('returns 200 with { balance: 0, transactions: [] } for new user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.balance).toBe(0);
    expect(body.transactions).toEqual([]);
  });

  it('returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/billing/credits',
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /billing/credits/purchase', () => {
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

  it('returns 200 with { sessionId, url } for valid package', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/credits/purchase',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { packageId: 'starter' },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.sessionId).toBeDefined();
    expect(typeof body.sessionId).toBe('string');
    expect(body.url).toBeDefined();
    expect(typeof body.url).toBe('string');
  });

  it('returns 400 for invalid packageId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/credits/purchase',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { packageId: 'nonexistent-package' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/credits/purchase',
      payload: { packageId: 'starter' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /billing/webhooks/stripe', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();

    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: testUser,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 { received: true } for valid webhook', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: {
        'stripe-signature': 'valid-test-signature',
        'content-type': 'application/json',
      },
      payload: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session_001',
            metadata: {
              userId: 'test-user-id',
              packageId: 'starter',
            },
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.received).toBe(true);
  });

  it('credits are added after checkout.session.completed event', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'credits-webhook@example.com',
        password: 'ValidPass1',
        name: 'Webhook User',
      },
    });
    const accessToken = registerRes.json().accessToken;

    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const userId = meRes.json().id;

    await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: {
        'stripe-signature': 'valid-test-signature',
        'content-type': 'application/json',
      },
      payload: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session_credits',
            metadata: {
              userId,
              packageId: 'starter',
            },
          },
        },
      },
    });

    const creditsRes = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const body = creditsRes.json();
    expect(body.balance).toBeGreaterThan(0);
  });

  it('duplicate webhook does not double-credit (idempotency)', async () => {
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'credits-idempotent@example.com',
        password: 'ValidPass1',
        name: 'Idempotent User',
      },
    });
    const accessToken = registerRes.json().accessToken;

    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const userId = meRes.json().id;

    const webhookPayload = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_session_idempotent',
          metadata: {
            userId,
            packageId: 'starter',
          },
        },
      },
    };

    const webhookHeaders = {
      'stripe-signature': 'valid-test-signature',
      'content-type': 'application/json',
    };

    await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: webhookHeaders,
      payload: webhookPayload,
    });

    const firstCredits = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const balanceAfterFirst = firstCredits.json().balance;

    await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: webhookHeaders,
      payload: webhookPayload,
    });

    const secondCredits = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const balanceAfterSecond = secondCredits.json().balance;

    expect(balanceAfterSecond).toBe(balanceAfterFirst);
  });

  it('returns 400 for invalid signature', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: {
        'stripe-signature': 'invalid-signature',
        'content-type': 'application/json',
      },
      payload: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_bad_sig',
            metadata: {
              userId: 'test-user-id',
              packageId: 'starter',
            },
          },
        },
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('CreditService', () => {
  let creditService: CreditService;

  beforeAll(() => {
    creditService = new CreditService();
  });

  it('deductCredits() reduces balance', async () => {
    const userId = 'test-user-deduct';
    await creditService.addCredits(userId, 100);
    await creditService.deductCredits(userId, 30);

    const balance = await creditService.getBalance(userId);
    expect(balance).toBe(70);
  });

  it('deductCredits() throws InsufficientCreditsError when balance too low', async () => {
    const userId = 'test-user-insufficient';
    await creditService.addCredits(userId, 10);

    await expect(
      creditService.deductCredits(userId, 50),
    ).rejects.toThrow('InsufficientCreditsError');
  });

  it('hasEnoughCredits() returns true/false correctly', async () => {
    const userId = 'test-user-check';
    await creditService.addCredits(userId, 25);

    const hasEnough = await creditService.hasEnoughCredits(userId, 20);
    expect(hasEnough).toBe(true);

    const notEnough = await creditService.hasEnoughCredits(userId, 50);
    expect(notEnough).toBe(false);
  });
});
