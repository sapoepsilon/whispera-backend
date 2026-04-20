import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  createRecipe,
  authHeader,
  parseSSEEvents,
  NON_EXISTENT_UUID,
} from '../helpers.js';

const sampleRecipe = {
  name: 'Test LLM Recipe',
  steps: [
    {
      type: 'llm',
      name: 'Summarize',
      config: {
        prompt: 'Summarize: {{input}}',
        model: 'claude-4',
      },
    },
  ],
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('POST /recipes/:id/execute', () => {
  let token: string;
  let otherToken: string;
  let recipeId: string;

  beforeAll(async () => {
    const first = await registerAndGetToken(app);
    token = first.accessToken;

    const second = await registerAndGetToken(app);
    otherToken = second.accessToken;

    const recipe = await createRecipe(app, token, sampleRecipe);
    recipeId = recipe.id;
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      payload: { input: 'hello' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for non-existent recipe', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${NON_EXISTENT_UUID}/execute`,
      headers: authHeader(token),
      payload: { input: 'hello' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for recipe not owned by user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(otherToken),
      payload: { input: 'hello' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('non-streaming: returns JSON with executionId, status, steps, output', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: 'Test article content' },
    });

    const body = res.json();
    expect(body.executionId).toBeDefined();
    expect(body.status).toBeDefined();
    expect(body.steps).toBeDefined();
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.output).toBeDefined();
  });

  it('non-streaming: execution is saved to database', async () => {
    const execRes = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: 'Persist test' },
    });

    const { executionId } = execRes.json();
    expect(executionId).toBeDefined();

    const getRes = await app.inject({
      method: 'GET',
      url: `/executions/${executionId}`,
      headers: authHeader(token),
    });

    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.data).toBeDefined();
    expect(body.data.id || body.data.executionId).toBeDefined();
  });

  it('non-streaming: on step failure, returns status "failed" with error', async () => {
    const failRecipe = await createRecipe(app, token, {
      name: 'Failing Recipe',
      steps: [
        {
          type: 'llm',
          name: 'Bad Step',
          config: {
            prompt: 'This will fail',
            provider: 'nonexistent-provider',
          },
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${failRecipe.id}/execute`,
      headers: authHeader(token),
      payload: { input: 'trigger failure' },
    });

    const body = res.json();
    expect(body.status).toBe('failed');
    expect(body.error).toBeDefined();
  });

  it('streaming: response has Content-Type text/event-stream', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: 'Stream test', stream: true },
    });

    expect(res.headers['content-type']).toContain('text/event-stream');
  });

  it('streaming: emits step:start, step:complete, execution:complete events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: 'Stream events test', stream: true },
    });

    const events = parseSSEEvents(res.body);
    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain('step:start');
    expect(eventTypes).toContain('step:complete');
    expect(eventTypes).toContain('execution:complete');
  });
});

describe('GET /recipes/:id/executions', () => {
  let token: string;
  let recipeId: string;

  beforeAll(async () => {
    const result = await registerAndGetToken(app);
    token = result.accessToken;

    const recipe = await createRecipe(app, token, {
      name: 'List Executions Recipe',
      steps: [
        {
          type: 'llm',
          name: 'Step',
          config: { prompt: 'Hello' },
        },
      ],
    });
    recipeId = recipe.id;

    await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: 'exec 1' },
    });
    await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: 'exec 2' },
    });
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/recipes/${recipeId}/executions`,
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for non-existent recipe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/recipes/${NON_EXISTENT_UUID}/executions`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns paginated list of executions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/recipes/${recipeId}/executions`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.page).toBeDefined();
    expect(body.pagination.limit).toBeDefined();
    expect(body.pagination.total).toBeDefined();
    expect(body.pagination.totalPages).toBeDefined();
  });

  it('defaults to page=1 and limit=20', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/recipes/${recipeId}/executions`,
      headers: authHeader(token),
    });

    const body = res.json();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(20);
  });

  it('respects custom page and limit parameters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/recipes/${recipeId}/executions?page=1&limit=1`,
      headers: authHeader(token),
    });

    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination.limit).toBe(1);
  });
});

describe('GET /executions/:id', () => {
  let token: string;
  let otherToken: string;
  let executionId: string;

  beforeAll(async () => {
    const first = await registerAndGetToken(app);
    token = first.accessToken;

    const second = await registerAndGetToken(app);
    otherToken = second.accessToken;

    const recipe = await createRecipe(app, token, {
      name: 'Detail Recipe',
      steps: [
        {
          type: 'llm',
          name: 'Generate',
          config: { prompt: 'Say hello' },
        },
      ],
    });

    const execRes = await app.inject({
      method: 'POST',
      url: `/recipes/${recipe.id}/execute`,
      headers: authHeader(token),
      payload: { input: 'detail test' },
    });

    executionId = execRes.json().executionId;
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/executions/${executionId}`,
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for non-existent execution', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/executions/${NON_EXISTENT_UUID}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for execution not owned by user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/executions/${executionId}`,
      headers: authHeader(otherToken),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns full execution record with steps, variables, metadata', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/executions/${executionId}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.steps).toBeDefined();
    expect(body.data.variables).toBeDefined();
    expect(body.data.metadata).toBeDefined();
  });
});
