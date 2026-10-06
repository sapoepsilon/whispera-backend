import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
  createRecipe,
  publishRecipe,
  NON_EXISTENT_UUID,
} from '../helpers.js';

let app: FastifyInstance;
let userAToken: string;
let userBToken: string;
let userARecipeId: string;
let userBRecipeId: string;

beforeAll(async () => {
  app = await buildTestApp();

  const uA = await registerAndGetToken(app);
  userAToken = uA.accessToken;

  const uB = await registerAndGetToken(app);
  userBToken = uB.accessToken;

  const recipeA = await createRecipe(app, userAToken, {
    name: 'User A Private Recipe',
    steps: [{ type: 'llm', config: { prompt: 'hello' }, name: 'Step' }],
  });
  userARecipeId = recipeA.id;

  const recipeB = await createRecipe(app, userBToken, {
    name: 'User B Private Recipe',
    steps: [{ type: 'llm', config: { prompt: 'world' }, name: 'Step' }],
  });
  userBRecipeId = recipeB.id;
});

afterAll(async () => {
  await app.close();
});

describe('Recipe list isolation', () => {
  it('User A list does not include User B recipes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(userAToken),
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const found = data.find((r: { id: string }) => r.id === userBRecipeId);
    expect(found).toBeUndefined();
  });

  it('User B list does not include User A recipes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(userBToken),
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const found = data.find((r: { id: string }) => r.id === userARecipeId);
    expect(found).toBeUndefined();
  });

  it('User A list contains only their own recipes', async () => {
    const extraRecipe = await createRecipe(app, userAToken, {
      name: 'User A Second Recipe',
      steps: [{ type: 'llm', config: {}, name: 'S' }],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(userAToken),
    });

    const { data } = res.json();
    const foundOwn = data.find((r: { id: string }) => r.id === userARecipeId);
    const foundExtra = data.find((r: { id: string }) => r.id === extraRecipe.id);
    const foundOther = data.find((r: { id: string }) => r.id === userBRecipeId);

    expect(foundOwn).toBeDefined();
    expect(foundExtra).toBeDefined();
    expect(foundOther).toBeUndefined();
  });
});

describe('Recipe update isolation', () => {
  it('User A cannot update User B recipe (returns 404)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/recipes/${userBRecipeId}`,
      headers: authHeader(userAToken),
      payload: { name: 'Hijacked' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('User B cannot update User A recipe (returns 404)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/recipes/${userARecipeId}`,
      headers: authHeader(userBToken),
      payload: { name: 'Hijacked' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('cross-user update attempt does not change the recipe', async () => {
    const originalName = 'User A Private Recipe';

    await app.inject({
      method: 'PUT',
      url: `/recipes/${userARecipeId}`,
      headers: authHeader(userBToken),
      payload: { name: 'Tampered' },
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(userAToken),
    });

    const recipe = listRes.json().data.find((r: { id: string }) => r.id === userARecipeId);
    expect(recipe.name).toBe(originalName);
  });
});

describe('Recipe delete isolation', () => {
  it('User A cannot delete User B recipe (returns 404)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/recipes/${userBRecipeId}`,
      headers: authHeader(userAToken),
    });

    expect(res.statusCode).toBe(404);
  });

  it('User B recipe still exists after cross-user delete attempt', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(userBToken),
    });

    const { data } = res.json();
    const found = data.find((r: { id: string }) => r.id === userBRecipeId);
    expect(found).toBeDefined();
  });
});

describe('Recipe execute isolation', () => {
  it('User A cannot execute User B recipe (returns 404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${userBRecipeId}/execute`,
      headers: authHeader(userAToken),
      payload: { input: 'unauthorized execution' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('User B cannot execute User A recipe (returns 404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${userARecipeId}/execute`,
      headers: authHeader(userBToken),
      payload: { input: 'unauthorized execution' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('User A cannot list executions for User B recipe (returns 404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/recipes/${userBRecipeId}/executions`,
      headers: authHeader(userAToken),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('Store visibility: store recipes are public', () => {
  let storeRecipeId: string;

  beforeAll(async () => {
    const recipe = await createRecipe(app, userAToken, {
      name: 'Shared Store Recipe',
      steps: [{ type: 'llm', config: {}, name: 'S' }],
    });
    const pub = await publishRecipe(app, userAToken, {
      recipeId: recipe.id,
      description: 'A publicly visible store recipe',
      category: 'productivity',
    });
    storeRecipeId = pub.id;
  });

  it('User B can browse User A store recipe without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?sort=newest&limit=100',
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const found = data.find((r: { id: string }) => r.id === storeRecipeId);
    expect(found).toBeDefined();
  });

  it('User B can view User A store recipe detail', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/store/${storeRecipeId}`,
    });

    expect(res.statusCode).toBe(200);
  });

  it('User B can install User A store recipe', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/store/${storeRecipeId}/install`,
      headers: authHeader(userBToken),
    });

    expect(res.statusCode).toBe(201);
  });

  it('publish endpoint requires auth (401 without token)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/publish',
      payload: {
        recipeId: NON_EXISTENT_UUID,
        description: 'Attempting to publish without auth',
        category: 'productivity',
      },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('Credits isolation', () => {
  it('User A credits balance is independent from User B', async () => {
    const uA = await registerAndGetToken(app);
    const uB = await registerAndGetToken(app);

    const meA = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authHeader(uA.accessToken),
    });
    const userAId = meA.json().id;

    await app.inject({
      method: 'POST',
      url: '/billing/webhooks/stripe',
      headers: { 'stripe-signature': 'valid-test-signature', 'content-type': 'application/json' },
      payload: {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_isolation_${Date.now()}`,
            metadata: { userId: userAId, packageId: 'starter' },
          },
        },
      },
    });

    const resA = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(uA.accessToken),
    });
    const resB = await app.inject({
      method: 'GET',
      url: '/billing/credits',
      headers: authHeader(uB.accessToken),
    });

    expect(resA.json().balance).toBeGreaterThan(0);
    expect(resB.json().balance).toBe(0);
  });
});
