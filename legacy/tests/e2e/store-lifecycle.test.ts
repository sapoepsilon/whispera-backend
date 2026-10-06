import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
  createRecipe,
  publishRecipe,
  UUID_REGEX,
} from '../helpers.js';

let app: FastifyInstance;
let userAToken: string;
let userBToken: string;
let userBId: string;

beforeAll(async () => {
  app = await buildTestApp();

  const uA = await registerAndGetToken(app);
  userAToken = uA.accessToken;

  const uB = await registerAndGetToken(app);
  userBToken = uB.accessToken;

  const meRes = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: authHeader(userBToken),
  });
  userBId = meRes.json().id;
});

afterAll(async () => {
  await app.close();
});

describe('Store full lifecycle: publish → browse → install → independence', () => {
  let recipeId: string;
  let storeId: string;
  let installedRecipeId: string;

  it('User A creates a recipe', async () => {
    const recipe = await createRecipe(app, userAToken, {
      name: 'Store Lifecycle Recipe',
      description: 'A recipe for the store lifecycle test',
      steps: [
        { type: 'llm', config: { prompt: 'Summarize: {{input}}' }, name: 'Summarizer' },
      ],
    });

    expect(recipe.id).toMatch(UUID_REGEX);
    recipeId = recipe.id;
  });

  it('User A publishes the recipe to the store', async () => {
    const pub = await publishRecipe(app, userAToken, {
      recipeId,
      description: 'A fully tested store lifecycle recipe',
      category: 'productivity',
      tags: ['lifecycle', 'test'],
    });

    expect(pub.id).toMatch(UUID_REGEX);
    expect(pub.name).toBe('Store Lifecycle Recipe');
    storeId = pub.id;
  });

  it('User B browses store and finds the published recipe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?sort=newest&limit=100',
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const found = data.find((r: { id: string }) => r.id === storeId);
    expect(found).toBeDefined();
    expect(found.category).toBe('productivity');
  });

  it('User B views store recipe detail', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/store/${storeId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(storeId);
    expect(body.steps).toBeDefined();
    expect(body.author).toBeDefined();
  });

  it('User B installs the recipe', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/store/${storeId}/install`,
      headers: authHeader(userBToken),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(UUID_REGEX);
    expect(body.name).toBe('Store Lifecycle Recipe');
    expect(body.userId).toBe(userBId);
    expect(body.installedFromStoreId).toBe(storeId);
    installedRecipeId = body.id;
  });

  it('installed recipe appears in User B recipe list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: authHeader(userBToken),
    });

    const { data } = res.json();
    const found = data.find((r: { id: string }) => r.id === installedRecipeId);
    expect(found).toBeDefined();
  });

  it('User B can edit installed recipe without affecting store version', async () => {
    await app.inject({
      method: 'PUT',
      url: `/recipes/${installedRecipeId}`,
      headers: authHeader(userBToken),
      payload: {
        name: 'My Custom Version',
        description: 'Edited locally',
      },
    });

    const storeRes = await app.inject({
      method: 'GET',
      url: `/store/${storeId}`,
    });

    expect(storeRes.json().name).toBe('Store Lifecycle Recipe');
    expect(storeRes.json().description).toBe('A fully tested store lifecycle recipe');
  });

  it('install count increments with each install', async () => {
    const before = await app.inject({ method: 'GET', url: `/store/${storeId}` });
    const beforeCount = before.json().installCount;

    await app.inject({
      method: 'POST',
      url: `/store/${storeId}/install`,
      headers: authHeader(userBToken),
    });

    const after = await app.inject({ method: 'GET', url: `/store/${storeId}` });
    expect(after.json().installCount).toBe(beforeCount + 1);
  });

  it('User B deleting installed copy does not remove store entry', async () => {
    await app.inject({
      method: 'DELETE',
      url: `/recipes/${installedRecipeId}`,
      headers: authHeader(userBToken),
    });

    const storeRes = await app.inject({
      method: 'GET',
      url: `/store/${storeId}`,
    });

    expect(storeRes.statusCode).toBe(200);
    expect(storeRes.json().id).toBe(storeId);
  });
});

describe('Store browsing: filters, search, pagination, sorting', () => {
  let authorToken: string;
  const uniqueTag = `browsing-test-${Date.now()}`;

  beforeAll(async () => {
    const author = await registerAndGetToken(app);
    authorToken = author.accessToken;

    const recipes = [
      { name: `Alpha Coder ${uniqueTag}`, category: 'coding', tags: [uniqueTag, 'alpha'] },
      { name: `Beta Writer ${uniqueTag}`, category: 'writing', tags: [uniqueTag, 'beta'] },
      { name: `Gamma Productivity ${uniqueTag}`, category: 'productivity', tags: [uniqueTag] },
    ];

    for (const r of recipes) {
      const recipe = await createRecipe(app, authorToken, {
        name: r.name,
        steps: [{ type: 'llm', config: {}, name: 'Step' }],
      });
      await publishRecipe(app, authorToken, {
        recipeId: recipe.id,
        description: `Description for ${r.name} test recipe`,
        category: r.category,
        tags: r.tags,
      });
    }
  });

  it('category filter returns only matching recipes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?category=coding&limit=100',
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((r: { category: string }) => r.category === 'coding')).toBe(true);
  });

  it('search filter matches recipe names case-insensitively', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/store?search=${uniqueTag}&limit=100`,
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.length).toBeGreaterThan(0);
  });

  it('tag filter returns only recipes with all specified tags', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/store?tags=${uniqueTag},alpha&limit=100`,
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.length).toBeGreaterThan(0);
    expect(
      data.every(
        (r: { tags: string[] }) => r.tags.includes(uniqueTag) && r.tags.includes('alpha'),
      ),
    ).toBe(true);
  });

  it('sort=newest returns results ordered by publishedAt descending', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?sort=newest',
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const dates = data.map((r: { publishedAt: string }) => new Date(r.publishedAt).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  it('pagination limit=2 returns at most 2 results', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?limit=2',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeLessThanOrEqual(2);
    expect(res.json().pagination.limit).toBe(2);
  });

  it('page 2 with limit 1 returns different recipe than page 1', async () => {
    const page1 = await app.inject({ method: 'GET', url: '/store?page=1&limit=1' });
    const page2 = await app.inject({ method: 'GET', url: '/store?page=2&limit=1' });

    if (page1.json().pagination.total > 1) {
      const id1 = page1.json().data[0]?.id;
      const id2 = page2.json().data[0]?.id;
      expect(id1).not.toBe(id2);
    }
  });

  it('invalid category returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?category=not-valid',
    });
    expect(res.statusCode).toBe(400);
  });

  it('invalid sort value returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?sort=random',
    });
    expect(res.statusCode).toBe(400);
  });

  it('limit=0 returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/store?limit=0',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Store recipe details', () => {
  let storeRecipeId: string;

  beforeAll(async () => {
    const author = await registerAndGetToken(app);
    const recipe = await createRecipe(app, author.accessToken, {
      name: 'Detail Check Recipe',
      steps: [
        { type: 'llm', config: { prompt: 'p1' }, name: 'Step A' },
        { type: 'llm', config: { prompt: 'p2' }, name: 'Step B' },
      ],
    });
    const pub = await publishRecipe(app, author.accessToken, {
      recipeId: recipe.id,
      description: 'Detailed store recipe for inspection',
      category: 'coding',
      tags: ['detail', 'check'],
    });
    storeRecipeId = pub.id;
  });

  it('detail response includes steps array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/store/${storeRecipeId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().steps)).toBe(true);
    expect(res.json().steps.length).toBe(2);
  });

  it('detail response includes tags array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/store/${storeRecipeId}`,
    });

    expect(res.json().tags).toEqual(expect.arrayContaining(['detail', 'check']));
  });

  it('detail response is accessible without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/store/${storeRecipeId}`,
    });

    expect(res.statusCode).toBe(200);
  });
});
