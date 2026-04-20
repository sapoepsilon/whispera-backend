import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/server.js';

const user1 = {
  email: 'store-author@example.com',
  password: 'ValidPass1',
  name: 'Store Author',
};

const user2 = {
  email: 'store-reviewer@example.com',
  password: 'ValidPass1',
  name: 'Store Reviewer',
};

async function registerAndGetToken(
  app: FastifyInstance,
  data: { email: string; password: string; name: string },
): Promise<{ accessToken: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: data,
  });
  const body = res.json();

  const meRes = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${body.accessToken}` },
  });

  return { accessToken: body.accessToken, userId: meRes.json().id };
}

async function createRecipe(
  app: FastifyInstance,
  token: string,
  payload: { name: string; steps: Array<{ type: string; config: Record<string, unknown> }> },
) {
  return app.inject({
    method: 'POST',
    url: '/recipes',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

async function publishRecipe(
  app: FastifyInstance,
  token: string,
  payload: {
    recipeId: string;
    description: string;
    category: string;
    tags?: string[];
  },
) {
  return app.inject({
    method: 'POST',
    url: '/store/publish',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

describe('GET /store (WHI-13)', () => {
  let app: FastifyInstance;
  let authorToken: string;
  let authorId: string;
  let publishedIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();

    const author = await registerAndGetToken(app, user1);
    authorToken = author.accessToken;
    authorId = author.userId;

    const recipes = [
      {
        name: 'Summarize Meetings',
        steps: [{ type: 'transcribe', config: {} }, { type: 'summarize', config: {} }],
      },
      {
        name: 'Code Review Helper',
        steps: [{ type: 'summarize', config: { style: 'technical' } }],
      },
      {
        name: 'Creative Writing Aid',
        steps: [{ type: 'summarize', config: { style: 'creative' } }],
      },
    ];

    const categories = ['productivity', 'coding', 'writing'];
    const tagSets = [['ai', 'meetings'], ['ai', 'coding'], ['ai', 'writing']];

    for (let i = 0; i < recipes.length; i++) {
      const recipeRes = await createRecipe(app, authorToken, recipes[i]);
      const recipeBody = recipeRes.json();

      const pubRes = await publishRecipe(app, authorToken, {
        recipeId: recipeBody.id,
        description: `A great recipe for ${recipes[i].name.toLowerCase()}`,
        category: categories[i],
        tags: tagSets[i],
      });

      publishedIds.push(pubRes.json().id);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with { data: [], pagination } when no recipes published', async () => {
    const freshApp = await buildApp();

    const response = await freshApp.inject({
      method: 'GET',
      url: '/store',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.data).toEqual([]);
    expect(body.pagination).toBeDefined();

    await freshApp.close();
  });

  it('does not require auth token (public endpoint)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store',
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns recipes with correct shape', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store',
    });

    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);

    const recipe = body.data[0];
    expect(recipe).toHaveProperty('id');
    expect(recipe).toHaveProperty('name');
    expect(recipe).toHaveProperty('description');
    expect(recipe).toHaveProperty('category');
    expect(recipe).toHaveProperty('tags');
    expect(recipe).toHaveProperty('installCount');
    expect(recipe).toHaveProperty('rating');
    expect(recipe).toHaveProperty('ratingCount');
    expect(recipe).toHaveProperty('author');
    expect(recipe.author).toHaveProperty('id');
    expect(recipe.author).toHaveProperty('name');
    expect(recipe).toHaveProperty('publishedAt');
  });

  it('filters by category: GET /store?category=coding returns only coding recipes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store?category=coding',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((r: { category: string }) => r.category === 'coding')).toBe(true);
  });

  it('filters by search: GET /store?search=summarize returns matching recipes (case-insensitive)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store?search=summarize',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);

    const hasMatch = body.data.every(
      (r: { name: string; description: string }) =>
        r.name.toLowerCase().includes('summarize') ||
        r.description.toLowerCase().includes('summarize'),
    );
    expect(hasMatch).toBe(true);
  });

  it('filters by tags: GET /store?tags=ai,writing returns recipes tagged with both', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store?tags=ai,writing',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(
      body.data.every(
        (r: { tags: string[] }) =>
          r.tags.includes('ai') && r.tags.includes('writing'),
      ),
    ).toBe(true);
  });

  it('sort=newest orders by publishedAt desc', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store?sort=newest',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const dates = body.data.map((r: { publishedAt: string }) => new Date(r.publishedAt).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  it('sort=top-rated orders by rating desc', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store?sort=top-rated',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const ratings = body.data.map((r: { rating: number }) => r.rating);
    for (let i = 1; i < ratings.length; i++) {
      expect(ratings[i - 1]).toBeGreaterThanOrEqual(ratings[i]);
    }
  });

  it('sort=popular (default) orders by installCount desc', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    const counts = body.data.map((r: { installCount: number }) => r.installCount);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i]);
    }
  });

  it('pagination: page=2&limit=5 returns correct page', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store?page=2&limit=5',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.pagination).toBeDefined();
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.limit).toBe(5);
    expect(body.pagination).toHaveProperty('total');
    expect(body.pagination).toHaveProperty('totalPages');
  });

  it('returns 400 when limit > 100', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store?limit=101',
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when page < 1', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store?page=0',
    });

    expect(response.statusCode).toBe(400);
  });

  it('never returns recipes with status != "published"', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    if (body.data.length > 0) {
      const allIds = body.data.map((r: { id: string }) => r.id);

      for (const id of allIds) {
        const detail = await app.inject({
          method: 'GET',
          url: `/store/${id}`,
        });
        const detailBody = detail.json();
        expect(detailBody.status).toBe('published');
      }
    }
  });

  it('returns 400 for invalid category value', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store?category=nonexistent-category',
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 for invalid sort value', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store?sort=invalid-sort',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /store/:id (WHI-23)', () => {
  let app: FastifyInstance;
  let authorToken: string;
  let reviewerToken: string;
  let publishedRecipeId: string;

  beforeAll(async () => {
    app = await buildApp();

    const author = await registerAndGetToken(app, {
      email: 'detail-author@example.com',
      password: 'ValidPass1',
      name: 'Detail Author',
    });
    authorToken = author.accessToken;

    const reviewer = await registerAndGetToken(app, user2);
    reviewerToken = reviewer.accessToken;

    const recipeRes = await createRecipe(app, authorToken, {
      name: 'Detail Test Recipe',
      steps: [
        { type: 'transcribe', config: {} },
        { type: 'summarize', config: { style: 'brief' } },
      ],
    });
    const recipeBody = recipeRes.json();

    const pubRes = await publishRecipe(app, authorToken, {
      recipeId: recipeBody.id,
      description: 'A detailed recipe for testing store detail endpoint',
      category: 'productivity',
      tags: ['testing', 'detail'],
    });

    publishedRecipeId = pubRes.json().id;

    await app.inject({
      method: 'POST',
      url: `/store/${publishedRecipeId}/reviews`,
      headers: { authorization: `Bearer ${reviewerToken}` },
      payload: {
        rating: 5,
        comment: 'Excellent recipe for meetings!',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with full recipe details including steps', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/store/${publishedRecipeId}`,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.id).toBe(publishedRecipeId);
    expect(body.name).toBeDefined();
    expect(body.description).toBeDefined();
    expect(body.category).toBeDefined();
    expect(body.tags).toBeDefined();
    expect(body.steps).toBeDefined();
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps.length).toBeGreaterThan(0);
  });

  it('response includes author: { id, name }', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/store/${publishedRecipeId}`,
    });

    const body = response.json();
    expect(body.author).toBeDefined();
    expect(body.author.id).toBeDefined();
    expect(body.author.name).toBe('Detail Author');
  });

  it('response includes reviews array (up to 10 most recent)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/store/${publishedRecipeId}`,
    });

    const body = response.json();
    expect(body.reviews).toBeDefined();
    expect(Array.isArray(body.reviews)).toBe(true);
    expect(body.reviews.length).toBeLessThanOrEqual(10);
  });

  it('each review has user: { id, name }, rating, comment, createdAt', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/store/${publishedRecipeId}`,
    });

    const body = response.json();
    expect(body.reviews.length).toBeGreaterThan(0);

    const review = body.reviews[0];
    expect(review).toHaveProperty('user');
    expect(review.user).toHaveProperty('id');
    expect(review.user).toHaveProperty('name');
    expect(review).toHaveProperty('rating');
    expect(review).toHaveProperty('comment');
    expect(review).toHaveProperty('createdAt');
  });

  it('returns 404 for non-existent UUID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store/00000000-0000-0000-0000-000000000000',
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for unpublished/flagged/removed recipe', async () => {
    const recipeRes = await createRecipe(app, authorToken, {
      name: 'Unpublished Recipe',
      steps: [{ type: 'transcribe', config: {} }],
    });
    const unpublishedRecipeId = recipeRes.json().id;

    const response = await app.inject({
      method: 'GET',
      url: `/store/${unpublishedRecipeId}`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for invalid (non-UUID) id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/store/not-a-valid-uuid',
    });

    expect(response.statusCode).toBe(400);
  });

  it('does not require auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/store/${publishedRecipeId}`,
    });

    expect(response.statusCode).toBe(200);
  });
});
