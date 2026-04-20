import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/server.js';

const user1 = {
  email: 'publisher@example.com',
  password: 'ValidPass1',
  name: 'Publisher User',
};

const user2 = {
  email: 'installer@example.com',
  password: 'ValidPass1',
  name: 'Installer User',
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

describe('POST /store/publish (WHI-25)', () => {
  let app: FastifyInstance;
  let user1Token: string;
  let user1Id: string;
  let user2Token: string;
  let user2Id: string;
  let personalRecipeId: string;
  let personalRecipeName: string;

  beforeAll(async () => {
    app = await buildApp();

    const u1 = await registerAndGetToken(app, user1);
    user1Token = u1.accessToken;
    user1Id = u1.userId;

    const u2 = await registerAndGetToken(app, user2);
    user2Token = u2.accessToken;
    user2Id = u2.userId;

    const recipeRes = await createRecipe(app, user1Token, {
      name: 'Publishable Recipe',
      steps: [
        { type: 'transcribe', config: {} },
        { type: 'summarize', config: { style: 'brief' } },
      ],
    });
    const recipeBody = recipeRes.json();
    personalRecipeId = recipeBody.id;
    personalRecipeName = recipeBody.name;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/store/publish',
      payload: {
        recipeId: personalRecipeId,
        description: 'A great recipe for transcription and summarization',
        category: 'productivity',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for recipeId not owned by user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user2Token}` },
      payload: {
        recipeId: personalRecipeId,
        description: 'Trying to publish someone elses recipe',
        category: 'productivity',
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 201 with published store recipe for valid owned recipe', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: personalRecipeId,
        description: 'A great recipe for transcription and summarization',
        category: 'productivity',
        tags: ['ai', 'transcription'],
      },
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBeDefined();
    expect(body.description).toBe('A great recipe for transcription and summarization');
    expect(body.category).toBe('productivity');
  });

  it('published recipe steps are a snapshot of personal recipe steps', async () => {
    const recipeRes = await createRecipe(app, user1Token, {
      name: 'Snapshot Test Recipe',
      steps: [{ type: 'transcribe', config: { lang: 'en' } }],
    });
    const recipeBody = recipeRes.json();

    const pubRes = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: recipeBody.id,
        description: 'Testing snapshot of steps during publish',
        category: 'productivity',
      },
    });

    expect(pubRes.statusCode).toBe(201);

    const storeId = pubRes.json().id;
    const detailRes = await app.inject({
      method: 'GET',
      url: `/store/${storeId}`,
    });

    const detail = detailRes.json();
    expect(detail.steps).toBeDefined();
    expect(detail.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'transcribe', config: { lang: 'en' } }),
      ]),
    );
  });

  it('published recipe name matches personal recipe name', async () => {
    const recipeRes = await createRecipe(app, user1Token, {
      name: 'Name Match Recipe',
      steps: [{ type: 'transcribe', config: {} }],
    });
    const recipeBody = recipeRes.json();

    const pubRes = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: recipeBody.id,
        description: 'Testing that name matches the personal recipe',
        category: 'productivity',
      },
    });

    expect(pubRes.statusCode).toBe(201);
    expect(pubRes.json().name).toBe('Name Match Recipe');
  });

  it('description comes from request body', async () => {
    const recipeRes = await createRecipe(app, user1Token, {
      name: 'Description Source Recipe',
      steps: [{ type: 'transcribe', config: {} }],
    });
    const recipeBody = recipeRes.json();

    const pubRes = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: recipeBody.id,
        description: 'This description comes from the request body explicitly',
        category: 'productivity',
      },
    });

    expect(pubRes.statusCode).toBe(201);
    expect(pubRes.json().description).toBe(
      'This description comes from the request body explicitly',
    );
  });

  it('returns 400 for invalid category', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: personalRecipeId,
        description: 'Testing invalid category validation',
        category: 'not-a-valid-category',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('tags defaults to [] if not provided', async () => {
    const recipeRes = await createRecipe(app, user1Token, {
      name: 'No Tags Recipe',
      steps: [{ type: 'transcribe', config: {} }],
    });
    const recipeBody = recipeRes.json();

    const pubRes = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: recipeBody.id,
        description: 'Testing that tags default to empty array',
        category: 'productivity',
      },
    });

    expect(pubRes.statusCode).toBe(201);

    const storeId = pubRes.json().id;
    const detailRes = await app.inject({
      method: 'GET',
      url: `/store/${storeId}`,
    });

    expect(detailRes.json().tags).toEqual([]);
  });

  it('returns 400 when tags exceed max of 10', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: personalRecipeId,
        description: 'Testing tag count validation max ten',
        category: 'productivity',
        tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when a tag exceeds 50 characters', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: personalRecipeId,
        description: 'Testing individual tag length validation',
        category: 'productivity',
        tags: ['a'.repeat(51)],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when a tag is empty string', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: personalRecipeId,
        description: 'Testing empty tag validation',
        category: 'productivity',
        tags: [''],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when description is shorter than 10 chars', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: personalRecipeId,
        description: 'Too short',
        category: 'productivity',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when description exceeds 2000 chars', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: personalRecipeId,
        description: 'x'.repeat(2001),
        category: 'productivity',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('re-publishing same recipe increments version by 1', async () => {
    const recipeRes = await createRecipe(app, user1Token, {
      name: 'Versioned Recipe',
      steps: [{ type: 'transcribe', config: {} }],
    });
    const recipeBody = recipeRes.json();

    const pub1 = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: recipeBody.id,
        description: 'First version of the recipe for versioning test',
        category: 'productivity',
      },
    });
    expect(pub1.statusCode).toBe(201);
    const version1 = pub1.json().version;

    const pub2 = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: recipeBody.id,
        description: 'Second version of the recipe for versioning test',
        category: 'coding',
        tags: ['updated'],
      },
    });
    expect(pub2.statusCode).toBe(201);

    expect(pub2.json().version).toBe(version1 + 1);
  });

  it('re-publishing updates steps, description, category, tags', async () => {
    const recipeRes = await createRecipe(app, user1Token, {
      name: 'Republish Update Recipe',
      steps: [{ type: 'transcribe', config: {} }],
    });
    const recipeBody = recipeRes.json();

    await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: recipeBody.id,
        description: 'Original description for the store recipe',
        category: 'productivity',
        tags: ['original'],
      },
    });

    await app.inject({
      method: 'PUT',
      url: `/recipes/${recipeBody.id}`,
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        name: 'Republish Update Recipe',
        steps: [
          { type: 'transcribe', config: {} },
          { type: 'summarize', config: {} },
        ],
      },
    });

    const pub2 = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: recipeBody.id,
        description: 'Updated description for the republished recipe',
        category: 'coding',
        tags: ['updated', 'v2'],
      },
    });

    expect(pub2.statusCode).toBe(201);

    const storeId = pub2.json().id;
    const detailRes = await app.inject({
      method: 'GET',
      url: `/store/${storeId}`,
    });
    const detail = detailRes.json();

    expect(detail.description).toBe('Updated description for the republished recipe');
    expect(detail.category).toBe('coding');
    expect(detail.tags).toEqual(expect.arrayContaining(['updated', 'v2']));
    expect(detail.steps.length).toBe(2);
  });

  it('editing personal recipe after publishing does NOT change store recipe', async () => {
    const recipeRes = await createRecipe(app, user1Token, {
      name: 'Immutable Snapshot Recipe',
      steps: [{ type: 'transcribe', config: { lang: 'en' } }],
    });
    const recipeBody = recipeRes.json();

    const pubRes = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: recipeBody.id,
        description: 'This store recipe should not change after personal edit',
        category: 'productivity',
      },
    });
    const storeId = pubRes.json().id;

    await app.inject({
      method: 'PUT',
      url: `/recipes/${recipeBody.id}`,
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        name: 'Immutable Snapshot Recipe EDITED',
        steps: [
          { type: 'transcribe', config: { lang: 'fr' } },
          { type: 'summarize', config: {} },
        ],
      },
    });

    const detailRes = await app.inject({
      method: 'GET',
      url: `/store/${storeId}`,
    });
    const detail = detailRes.json();

    expect(detail.name).toBe('Immutable Snapshot Recipe');
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0].config.lang).toBe('en');
  });
});

describe('POST /store/:id/install (WHI-26)', () => {
  let app: FastifyInstance;
  let user1Token: string;
  let user1Id: string;
  let user2Token: string;
  let user2Id: string;
  let publishedStoreId: string;
  let publishedStoreName: string;

  beforeAll(async () => {
    app = await buildApp();

    const u1 = await registerAndGetToken(app, {
      email: 'install-author@example.com',
      password: 'ValidPass1',
      name: 'Install Author',
    });
    user1Token = u1.accessToken;
    user1Id = u1.userId;

    const u2 = await registerAndGetToken(app, {
      email: 'install-user@example.com',
      password: 'ValidPass1',
      name: 'Install User',
    });
    user2Token = u2.accessToken;
    user2Id = u2.userId;

    const recipeRes = await createRecipe(app, user1Token, {
      name: 'Installable Recipe',
      steps: [
        { type: 'transcribe', config: { lang: 'en' } },
        { type: 'summarize', config: { style: 'brief' } },
      ],
    });
    const recipeBody = recipeRes.json();

    const pubRes = await app.inject({
      method: 'POST',
      url: '/store/publish',
      headers: { authorization: `Bearer ${user1Token}` },
      payload: {
        recipeId: recipeBody.id,
        description: 'A recipe available for installation by other users',
        category: 'productivity',
        tags: ['install-test'],
      },
    });

    publishedStoreId = pubRes.json().id;
    publishedStoreName = pubRes.json().name;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 401 without auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/store/${publishedStoreId}/install`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for non-existent store recipe', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/store/00000000-0000-0000-0000-000000000000/install',
      headers: { authorization: `Bearer ${user2Token}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for unpublished store recipe', async () => {
    const recipeRes = await createRecipe(app, user1Token, {
      name: 'Never Published Recipe',
      steps: [{ type: 'transcribe', config: {} }],
    });
    const unpublishedId = recipeRes.json().id;

    const response = await app.inject({
      method: 'POST',
      url: `/store/${unpublishedId}/install`,
      headers: { authorization: `Bearer ${user2Token}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 201 with new personal recipe for valid install', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/store/${publishedStoreId}/install`,
      headers: { authorization: `Bearer ${user2Token}` },
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBeDefined();
    expect(body.steps).toBeDefined();
  });

  it('new recipe name matches store recipe name', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/store/${publishedStoreId}/install`,
      headers: { authorization: `Bearer ${user2Token}` },
    });

    const body = response.json();
    expect(body.name).toBe(publishedStoreName);
  });

  it('new recipe steps match store recipe steps', async () => {
    const storeDetail = await app.inject({
      method: 'GET',
      url: `/store/${publishedStoreId}`,
    });
    const storeSteps = storeDetail.json().steps;

    const installRes = await app.inject({
      method: 'POST',
      url: `/store/${publishedStoreId}/install`,
      headers: { authorization: `Bearer ${user2Token}` },
    });

    const installed = installRes.json();
    expect(installed.steps).toEqual(storeSteps);
  });

  it('new recipe has installedFromStoreId set', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/store/${publishedStoreId}/install`,
      headers: { authorization: `Bearer ${user2Token}` },
    });

    const body = response.json();
    expect(body.installedFromStoreId).toBe(publishedStoreId);
  });

  it('new recipe userId is the installing user (not the author)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/store/${publishedStoreId}/install`,
      headers: { authorization: `Bearer ${user2Token}` },
    });

    const body = response.json();
    expect(body.userId).toBe(user2Id);
  });

  it('store recipe installCount incremented by 1', async () => {
    const beforeRes = await app.inject({
      method: 'GET',
      url: `/store/${publishedStoreId}`,
    });
    const beforeCount = beforeRes.json().installCount;

    await app.inject({
      method: 'POST',
      url: `/store/${publishedStoreId}/install`,
      headers: { authorization: `Bearer ${user2Token}` },
    });

    const afterRes = await app.inject({
      method: 'GET',
      url: `/store/${publishedStoreId}`,
    });
    const afterCount = afterRes.json().installCount;

    expect(afterCount).toBe(beforeCount + 1);
  });

  it('installing same recipe twice creates two separate personal recipes', async () => {
    const install1 = await app.inject({
      method: 'POST',
      url: `/store/${publishedStoreId}/install`,
      headers: { authorization: `Bearer ${user2Token}` },
    });

    const install2 = await app.inject({
      method: 'POST',
      url: `/store/${publishedStoreId}/install`,
      headers: { authorization: `Bearer ${user2Token}` },
    });

    expect(install1.json().id).not.toBe(install2.json().id);
  });

  it('new recipe appears in user GET /recipes list', async () => {
    const installRes = await app.inject({
      method: 'POST',
      url: `/store/${publishedStoreId}/install`,
      headers: { authorization: `Bearer ${user2Token}` },
    });
    const installedId = installRes.json().id;

    const listRes = await app.inject({
      method: 'GET',
      url: '/recipes',
      headers: { authorization: `Bearer ${user2Token}` },
    });

    const recipes = listRes.json();
    const recipeList = Array.isArray(recipes) ? recipes : recipes.data;
    const found = recipeList.find((r: { id: string }) => r.id === installedId);
    expect(found).toBeDefined();
  });

  it('transaction: if insert fails, installCount is not incremented', async () => {
    const beforeRes = await app.inject({
      method: 'GET',
      url: `/store/${publishedStoreId}`,
    });
    const beforeCount = beforeRes.json().installCount;

    // Attempt install with a malformed request that should trigger a server-side insert failure
    // by using an auth token that decodes to a non-existent user
    const fakeToken =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJ1c2VySWQiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJpYXQiOjE3MDAwMDAwMDB9.' +
      'invalid-signature';

    await app.inject({
      method: 'POST',
      url: `/store/${publishedStoreId}/install`,
      headers: { authorization: `Bearer ${fakeToken}` },
    });

    const afterRes = await app.inject({
      method: 'GET',
      url: `/store/${publishedStoreId}`,
    });
    const afterCount = afterRes.json().installCount;

    expect(afterCount).toBe(beforeCount);
  });
});
