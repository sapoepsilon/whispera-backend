import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
  createRecipe,
  NON_EXISTENT_UUID,
} from '../helpers.js';

let app: FastifyInstance;
let token: string;
let recipeId: string;

beforeAll(async () => {
  app = await buildTestApp();
  const user = await registerAndGetToken(app);
  token = user.accessToken;

  const recipe = await createRecipe(app, token, {
    name: 'Error Test Recipe',
    steps: [{ type: 'llm', config: {}, name: 'S' }],
  });
  recipeId = recipe.id;
});

afterAll(async () => {
  await app.close();
});

describe('Invalid UUID path params', () => {
  it('PUT /recipes/not-a-uuid returns 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/recipes/not-a-uuid',
      headers: authHeader(token),
      payload: { name: 'X' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('DELETE /recipes/not-a-uuid returns 400', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/recipes/not-a-uuid',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /store/not-a-uuid returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store/not-a-uuid',
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /store/not-a-uuid/install returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/not-a-uuid/install',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /recipes/not-a-uuid/execute returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recipes/not-a-uuid/execute',
      headers: authHeader(token),
      payload: { input: 'hello' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /recipes/not-a-uuid/executions returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/recipes/not-a-uuid/executions',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /executions/not-a-uuid returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/executions/not-a-uuid',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(400);
  });

  it('DELETE /auth/api-keys/not-a-uuid returns 400', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/api-keys/not-a-uuid',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('Non-existent resources return 404', () => {
  it('PUT /recipes/:nonExistentUUID returns 404', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/recipes/${NON_EXISTENT_UUID}`,
      headers: authHeader(token),
      payload: { name: 'Ghost' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('DELETE /recipes/:nonExistentUUID returns 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/recipes/${NON_EXISTENT_UUID}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it('GET /store/:nonExistentUUID returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/store/${NON_EXISTENT_UUID}`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('POST /store/:nonExistentUUID/install returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/store/${NON_EXISTENT_UUID}/install`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it('POST /recipes/:nonExistentUUID/execute returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${NON_EXISTENT_UUID}/execute`,
      headers: authHeader(token),
      payload: { input: 'test' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('GET /recipes/:nonExistentUUID/executions returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/recipes/${NON_EXISTENT_UUID}/executions`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it('GET /executions/:nonExistentUUID returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/executions/${NON_EXISTENT_UUID}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it('DELETE /auth/api-keys/:nonExistentUUID returns 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/auth/api-keys/${NON_EXISTENT_UUID}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('Missing required fields return 400', () => {
  it('POST /recipes without name returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recipes',
      headers: authHeader(token),
      payload: { steps: [{ type: 'llm', config: {}, name: 'S' }] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /recipes without steps returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recipes',
      headers: authHeader(token),
      payload: { name: 'Missing Steps' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /recipes with empty steps array returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recipes',
      headers: authHeader(token),
      payload: { name: 'Empty Steps', steps: [] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /store/publish without description returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: authHeader(token),
      payload: { recipeId, category: 'productivity' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /store/publish without category returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: authHeader(token),
      payload: { recipeId, description: 'A valid description here' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('POST /auth/api-keys without provider returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(token),
      payload: { key: 'sk-ant-api03-test' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('PUT /recipes/:id with empty body returns 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/recipes/${recipeId}`,
      headers: authHeader(token),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('Unauthorized access returns 401', () => {
  it('GET /recipes without auth returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/recipes' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /recipes without auth returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recipes',
      payload: { name: 'X', steps: [{ type: 'llm', config: {}, name: 'S' }] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('PUT /recipes/:id without auth returns 401', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/recipes/${recipeId}`,
      payload: { name: 'Y' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('DELETE /recipes/:id without auth returns 401', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/recipes/${recipeId}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /store/publish without auth returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/publish',
      payload: { recipeId, description: 'Test publish', category: 'productivity' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /store/:id/install without auth returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/store/${NON_EXISTENT_UUID}/install`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /billing/credits without auth returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/billing/credits' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /auth/api-keys without auth returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/api-keys' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /auth/api-keys without auth returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      payload: { provider: 'openai', key: 'sk-test' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /auth/me without auth returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /executions/:id without auth returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/executions/${NON_EXISTENT_UUID}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Query parameter validation', () => {
  it('GET /recipes?limit=101 returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/recipes?limit=101',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /store?limit=101 returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?limit=101',
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /store?page=0 returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?page=0',
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /store?category=invalid returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?category=invalid',
    });

    expect(res.statusCode).toBe(400);
  });

  it('GET /store?sort=invalid returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?sort=invalid',
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('Store publish validation', () => {
  it('description shorter than 10 chars returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: authHeader(token),
      payload: { recipeId, description: 'Short', category: 'productivity' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('description longer than 2000 chars returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: authHeader(token),
      payload: {
        recipeId,
        description: 'x'.repeat(2001),
        category: 'productivity',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('more than 10 tags returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: authHeader(token),
      payload: {
        recipeId,
        description: 'Valid description for tag test',
        category: 'productivity',
        tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('invalid category value returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: authHeader(token),
      payload: {
        recipeId,
        description: 'Valid description for category test',
        category: 'not-a-real-category',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('publishing another user recipe returns 404', async () => {
    const otherUser = await registerAndGetToken(app);
    const otherRecipe = await createRecipe(app, otherUser.accessToken, {
      name: 'Publish Isolation Recipe',
      steps: [{ type: 'llm', config: {}, name: 'S' }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: authHeader(token),
      payload: {
        recipeId: otherRecipe.id,
        description: 'Trying to publish others recipe',
        category: 'productivity',
      },
    });

    expect(res.statusCode).toBe(404);
  });
});
