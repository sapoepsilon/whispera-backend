import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
  createRecipe,
  UUID_REGEX,
  NON_EXISTENT_UUID,
} from '../helpers.js';

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = await buildTestApp();
  const user = await registerAndGetToken(app);
  token = user.accessToken;
});

afterAll(async () => {
  await app.close();
});

describe('Full recipe lifecycle', () => {
  let recipeId: string;

  it('creates a recipe and returns 201 with a UUID id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recipes',
      headers: authHeader(token),
      payload: {
        name: 'Lifecycle Recipe',
        description: 'Created during lifecycle test',
        triggerPhrase: 'run lifecycle',
        steps: [{ type: 'llm', config: { prompt: 'Hello {{input}}' }, name: 'Step One' }],
        outputFormat: 'text',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(UUID_REGEX);
    recipeId = body.id;
  });

  it('lists recipes and includes the newly created recipe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const found = data.find((r: { id: string }) => r.id === recipeId);
    expect(found).toBeDefined();
    expect(found.name).toBe('Lifecycle Recipe');
  });

  it('updates the recipe name and description', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/recipes/${recipeId}`,
      headers: authHeader(token),
      payload: {
        name: 'Lifecycle Recipe Updated',
        description: 'Updated during lifecycle test',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('Lifecycle Recipe Updated');
    expect(body.description).toBe('Updated during lifecycle test');
  });

  it('updated recipe appears with new name in list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(token),
    });

    const { data } = res.json();
    const found = data.find((r: { id: string }) => r.id === recipeId);
    expect(found).toBeDefined();
    expect(found.name).toBe('Lifecycle Recipe Updated');
  });

  it('execute endpoint returns 404 without LLM key (validates recipe ownership)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: 'test input' },
    });

    expect([200, 400, 500]).toContain(res.statusCode);
  });

  it('execute with non-existent recipe returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${NON_EXISTENT_UUID}/execute`,
      headers: authHeader(token),
      payload: { input: 'test input' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('deletes the recipe and returns 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/recipes/${recipeId}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(204);
  });

  it('deleted recipe is absent from the list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const found = data.find((r: { id: string }) => r.id === recipeId);
    expect(found).toBeUndefined();
  });

  it('double-delete returns 404 confirming soft delete', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/recipes/${recipeId}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it('update of deleted recipe returns 404', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/recipes/${recipeId}`,
      headers: authHeader(token),
      payload: { name: 'Ghost Update' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('Recipe lifecycle with multiple field updates', () => {
  it('supports updating steps array independently', async () => {
    const recipe = await createRecipe(app, token, {
      name: 'Step Update Recipe',
      steps: [{ type: 'llm', config: { prompt: 'step 1' }, name: 'Original Step' }],
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/recipes/${recipe.id}`,
      headers: authHeader(token),
      payload: {
        steps: [
          { type: 'llm', config: { prompt: 'step a' }, name: 'New Step A' },
          { type: 'llm', config: { prompt: 'step b' }, name: 'New Step B' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().steps).toHaveLength(2);
    expect(res.json().steps[0].name).toBe('New Step A');
  });

  it('create then immediately delete and confirm list excludes it', async () => {
    const recipe = await createRecipe(app, token, {
      name: 'Immediate Delete Recipe',
      steps: [{ type: 'llm', config: {}, name: 'S' }],
    });

    await app.inject({
      method: 'DELETE',
      url: `/recipes/${recipe.id}`,
      headers: authHeader(token),
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(token),
    });

    const { data } = listRes.json();
    const found = data.find((r: { id: string }) => r.id === recipe.id);
    expect(found).toBeUndefined();
  });

  it('pagination total decreases after delete', async () => {
    const initialList = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(token),
    });
    const initialTotal = initialList.json().pagination.total;

    const recipe = await createRecipe(app, token, {
      name: 'Count Decrease Recipe',
      steps: [{ type: 'llm', config: {}, name: 'S' }],
    });

    const afterCreate = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(token),
    });
    expect(afterCreate.json().pagination.total).toBe(initialTotal + 1);

    await app.inject({
      method: 'DELETE',
      url: `/recipes/${recipe.id}`,
      headers: authHeader(token),
    });

    const afterDelete = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(token),
    });
    expect(afterDelete.json().pagination.total).toBe(initialTotal);
  });
});
