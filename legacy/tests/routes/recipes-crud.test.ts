import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
  UUID_REGEX,
  NON_EXISTENT_UUID,
} from '../helpers.js';

const validRecipe = {
  name: 'Summarize Article',
  description: 'Summarizes any article URL',
  triggerPhrase: 'summarize this',
  steps: [
    { type: 'llm', config: { prompt: 'Summarize: {{input}}' }, name: 'Summarize' },
  ],
  outputFormat: 'markdown',
};

let app: FastifyInstance;
let accessToken: string;
let secondUserToken: string;

beforeAll(async () => {
  app = await buildTestApp();

  const first = await registerAndGetToken(app);
  accessToken = first.accessToken;

  const second = await registerAndGetToken(app);
  secondUserToken = second.accessToken;
});

afterAll(async () => {
  await app.close();
});

describe('Recipes CRUD', () => {
  describe('POST /recipes', () => {
    it('returns 201 with created recipe containing all fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: validRecipe,
      });

      expect(res.statusCode).toBe(201);

      const body = res.json();
      expect(body.name).toBe(validRecipe.name);
      expect(body.description).toBe(validRecipe.description);
      expect(body.triggerPhrase).toBe(validRecipe.triggerPhrase);
      expect(body.steps).toEqual(validRecipe.steps);
      expect(body.outputFormat).toBe(validRecipe.outputFormat);
      expect(body.createdAt).toBeDefined();
      expect(body.updatedAt).toBeDefined();
    });

    it('has auto-generated id in uuid format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: validRecipe,
      });

      const body = res.json();
      expect(body.id).toMatch(UUID_REGEX);
    });

    it('userId matches authenticated user', async () => {
      const meRes = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: authHeader(accessToken),
      });
      const userId = meRes.json().id;

      const res = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: validRecipe,
      });

      expect(res.json().userId).toBe(userId);
    });

    it('outputFormat defaults to "text" when omitted', async () => {
      const { outputFormat: _, ...withoutFormat } = validRecipe;

      const res = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: withoutFormat,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().outputFormat).toBe('text');
    });

    it('returns 400 for missing name', async () => {
      const { name: _, ...withoutName } = validRecipe;

      const res = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: withoutName,
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for empty steps array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: { ...validRecipe, steps: [] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid step type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: {
          ...validRecipe,
          steps: [{ type: 'invalid_type', config: {}, name: 'Bad Step' }],
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/recipes',
        payload: validRecipe,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /recipes', () => {
    it('returns 200 with data array and pagination object', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/recipes',
        headers: authHeader(accessToken),
      });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toBeDefined();
      expect(body.pagination).toHaveProperty('page');
      expect(body.pagination).toHaveProperty('limit');
      expect(body.pagination).toHaveProperty('total');
    });

    it('only returns recipes belonging to authenticated user', async () => {
      await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(secondUserToken),
        payload: { ...validRecipe, name: 'Second User Recipe' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/recipes',
        headers: authHeader(accessToken),
      });

      const body = res.json();
      const foreignRecipes = body.data.filter(
        (r: { name: string }) => r.name === 'Second User Recipe',
      );
      expect(foreignRecipes).toHaveLength(0);
    });

    it('soft-deleted recipes are excluded', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: { ...validRecipe, name: 'Will Be Deleted' },
      });
      const recipeId = createRes.json().id;

      await app.inject({
        method: 'DELETE',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
      });

      const listRes = await app.inject({
        method: 'GET',
        url: '/recipes',
        headers: authHeader(accessToken),
      });

      const found = listRes.json().data.find(
        (r: { id: string }) => r.id === recipeId,
      );
      expect(found).toBeUndefined();
    });

    it('search query param filters by name (case-insensitive)', async () => {
      await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: { ...validRecipe, name: 'Unique Banana Smoothie' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/recipes?search=banana',
        headers: authHeader(accessToken),
      });

      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(
        body.data.every((r: { name: string }) =>
          r.name.toLowerCase().includes('banana'),
        ),
      ).toBe(true);
    });

    it('default pagination: page=1, limit=20', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/recipes',
        headers: authHeader(accessToken),
      });

      const { pagination } = res.json();
      expect(pagination.page).toBe(1);
      expect(pagination.limit).toBe(20);
    });

    it('limit values above 100 return 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/recipes?limit=101',
        headers: authHeader(accessToken),
      });

      expect(res.statusCode).toBe(400);
    });

    it('pagination.total reflects filtered count', async () => {
      await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: { ...validRecipe, name: 'FilterTarget Alpha' },
      });
      await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: { ...validRecipe, name: 'FilterTarget Beta' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/recipes?search=FilterTarget',
        headers: authHeader(accessToken),
      });

      const { pagination, data } = res.json();
      expect(pagination.total).toBe(data.length);
      expect(pagination.total).toBeGreaterThanOrEqual(2);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/recipes',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('PUT /recipes/:id', () => {
    let recipeId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: validRecipe,
      });
      recipeId = res.json().id;
    });

    it('returns 200 with updated recipe', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
        payload: { name: 'Updated Name' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Updated Name');
    });

    it('partial update: sending only name updates name, leaves other fields unchanged', async () => {
      const before = await app.inject({
        method: 'GET',
        url: '/recipes',
        headers: authHeader(accessToken),
      });
      const original = before.json().data.find(
        (r: { id: string }) => r.id === recipeId,
      );

      const res = await app.inject({
        method: 'PUT',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
        payload: { name: 'Partial Update Name' },
      });

      const updated = res.json();
      expect(updated.name).toBe('Partial Update Name');
      expect(updated.description).toBe(original.description);
      expect(updated.triggerPhrase).toBe(original.triggerPhrase);
      expect(updated.steps).toEqual(original.steps);
      expect(updated.outputFormat).toBe(original.outputFormat);
    });

    it('updatedAt is refreshed', async () => {
      const before = await app.inject({
        method: 'GET',
        url: '/recipes',
        headers: authHeader(accessToken),
      });
      const original = before.json().data.find(
        (r: { id: string }) => r.id === recipeId,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      const res = await app.inject({
        method: 'PUT',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
        payload: { name: 'Timestamp Check' },
      });

      const updated = res.json();
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
        new Date(original.updatedAt).getTime(),
      );
    });

    it('returns 404 for non-existent recipe', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/recipes/${NON_EXISTENT_UUID}`,
        headers: authHeader(accessToken),
        payload: { name: 'Ghost' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for recipe owned by another user', async () => {
      const otherRes = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(secondUserToken),
        payload: { ...validRecipe, name: 'Other Owned' },
      });
      const otherId = otherRes.json().id;

      const res = await app.inject({
        method: 'PUT',
        url: `/recipes/${otherId}`,
        headers: authHeader(accessToken),
        payload: { name: 'Hijack Attempt' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for soft-deleted recipe', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: { ...validRecipe, name: 'Soon Deleted' },
      });
      const deletedId = createRes.json().id;

      await app.inject({
        method: 'DELETE',
        url: `/recipes/${deletedId}`,
        headers: authHeader(accessToken),
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/recipes/${deletedId}`,
        headers: authHeader(accessToken),
        payload: { name: 'Revive Attempt' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for empty body', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for invalid UUID', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/recipes/not-a-uuid',
        headers: authHeader(accessToken),
        payload: { name: 'Bad Id' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('nullable fields can be set to null', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
        payload: { description: null },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().description).toBeNull();
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/recipes/${recipeId}`,
        payload: { name: 'No Auth' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('DELETE /recipes/:id', () => {
    it('returns 204 with no body', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: { ...validRecipe, name: 'Delete Target' },
      });
      const recipeId = createRes.json().id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
      });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    });

    it('recipe is soft-deleted (deletedAt set)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: { ...validRecipe, name: 'Soft Delete Check' },
      });
      const recipeId = createRes.json().id;

      await app.inject({
        method: 'DELETE',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
      });

      const getRes = await app.inject({
        method: 'GET',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
      });

      if (getRes.statusCode === 200) {
        expect(getRes.json().deletedAt).not.toBeNull();
      } else {
        expect(getRes.statusCode).toBe(404);
      }
    });

    it('deleted recipe no longer appears in GET /recipes list', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: { ...validRecipe, name: 'Disappearing Recipe' },
      });
      const recipeId = createRes.json().id;

      await app.inject({
        method: 'DELETE',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
      });

      const listRes = await app.inject({
        method: 'GET',
        url: '/recipes',
        headers: authHeader(accessToken),
      });

      const found = listRes.json().data.find(
        (r: { id: string }) => r.id === recipeId,
      );
      expect(found).toBeUndefined();
    });

    it('returns 404 for non-existent recipe', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/recipes/${NON_EXISTENT_UUID}`,
        headers: authHeader(accessToken),
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for already-deleted recipe', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/recipes',
        headers: authHeader(accessToken),
        payload: { ...validRecipe, name: 'Double Delete' },
      });
      const recipeId = createRes.json().id;

      await app.inject({
        method: 'DELETE',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/recipes/${recipeId}`,
        headers: authHeader(accessToken),
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/recipes/${NON_EXISTENT_UUID}`,
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
