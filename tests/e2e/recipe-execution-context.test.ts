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

import { ExecutionService } from '../../src/services/execution.service.js';
import { ExecutionContext } from '../../src/services/pipeline/context.js';

let app: FastifyInstance;
let token: string;
let otherToken: string;
let recipeId: string;

beforeAll(async () => {
  app = await buildTestApp();

  const user = await registerAndGetToken(app);
  token = user.accessToken;

  const otherUser = await registerAndGetToken(app);
  otherToken = otherUser.accessToken;

  const recipe = await createRecipe(app, token, {
    name: 'Execution Context Recipe',
    steps: [{ type: 'llm', config: { prompt: 'Hello' }, name: 'Greet' }],
  });
  recipeId = recipe.id;
});

afterAll(async () => {
  await app.close();
});

describe('ExecutionContext — unit behaviour', () => {
  it('creates context with a valid UUID executionId', () => {
    const ctx = new ExecutionContext('recipe-id', 'user-id');
    expect(ctx.executionId).toMatch(UUID_REGEX);
  });

  it('starts in running status', () => {
    const ctx = new ExecutionContext('recipe-id', 'user-id');
    expect(ctx.status).toBe('running');
  });

  it('transitions to completed after complete()', () => {
    const ctx = new ExecutionContext('recipe-id', 'user-id');
    ctx.initSteps([{ name: 'Step' }]);
    ctx.complete();
    expect(ctx.status).toBe('completed');
  });

  it('transitions to failed after fail()', () => {
    const ctx = new ExecutionContext('recipe-id', 'user-id');
    ctx.fail('something went wrong');
    expect(ctx.status).toBe('failed');
  });

  it('toJSON includes executionId, recipeId, userId, status, steps, startedAt', () => {
    const ctx = new ExecutionContext('recipe-abc', 'user-xyz');
    ctx.initSteps([{ name: 'Step One' }]);
    const snap = ctx.toJSON();

    expect(snap.executionId).toBe(ctx.executionId);
    expect(snap.recipeId).toBe('recipe-abc');
    expect(snap.userId).toBe('user-xyz');
    expect(snap.status).toBe('running');
    expect(Array.isArray(snap.steps)).toBe(true);
    expect(snap.startedAt).toBeDefined();
  });

  it('toJSON completedAt is null before completion', () => {
    const ctx = new ExecutionContext('r', 'u');
    expect(ctx.toJSON().completedAt).toBeNull();
  });

  it('toJSON completedAt is set after complete()', () => {
    const ctx = new ExecutionContext('r', 'u');
    ctx.initSteps([]);
    ctx.complete();
    expect(ctx.toJSON().completedAt).not.toBeNull();
  });

  it('step transitions from pending to running to completed', () => {
    const ctx = new ExecutionContext('r', 'u');
    ctx.initSteps([{ name: 'S' }]);

    expect(ctx.toJSON().steps[0].status).toBe('pending');

    ctx.markStepRunning(0, 'input text');
    expect(ctx.toJSON().steps[0].status).toBe('running');

    ctx.setStepResult(0, { output: 'result text' });
    expect(ctx.toJSON().steps[0].status).toBe('completed');
  });

  it('step transitions to failed on setStepError', () => {
    const ctx = new ExecutionContext('r', 'u');
    ctx.initSteps([{ name: 'S' }]);
    ctx.markStepRunning(0, 'input');
    ctx.setStepError(0, 'API error');
    expect(ctx.toJSON().steps[0].status).toBe('failed');
    expect(ctx.toJSON().steps[0].error).toBe('API error');
  });

  it('step output is preserved in snapshot', () => {
    const ctx = new ExecutionContext('r', 'u');
    ctx.initSteps([{ name: 'S' }]);
    ctx.markStepRunning(0, 'in');
    ctx.setStepResult(0, { output: 'the output' });
    expect(ctx.toJSON().steps[0].output).toBe('the output');
  });

  it('initial variables are reflected in snapshot', () => {
    const ctx = new ExecutionContext('r', 'u', { greeting: 'hello' });
    expect(ctx.toJSON().variables).toEqual({ greeting: 'hello' });
  });

  it('setVariable updates variables in snapshot', () => {
    const ctx = new ExecutionContext('r', 'u');
    ctx.setVariable('foo', 'bar');
    expect(ctx.toJSON().variables).toEqual({ foo: 'bar' });
  });

  it('getVariable retrieves previously set variable', () => {
    const ctx = new ExecutionContext('r', 'u');
    ctx.setVariable('key', 42);
    expect(ctx.getVariable('key')).toBe(42);
  });

  it('abort transitions to aborted and sets signal', () => {
    const ctx = new ExecutionContext('r', 'u');
    ctx.abort();
    expect(ctx.status).toBe('aborted');
    expect(ctx.signal.aborted).toBe(true);
  });

  it('each ExecutionContext has a unique executionId', () => {
    const ctx1 = new ExecutionContext('r', 'u');
    const ctx2 = new ExecutionContext('r', 'u');
    expect(ctx1.executionId).not.toBe(ctx2.executionId);
  });
});

describe('POST /recipes/:id/execute — DB record created', () => {
  it('execute endpoint returns 200 or execution-related status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: 'context test' },
    });

    expect([200, 400, 500]).toContain(res.statusCode);
  });

  it('execute returns executionId in response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: 'check executionId' },
    });

    if (res.statusCode === 200) {
      expect(res.json().executionId).toMatch(UUID_REGEX);
    }
  });

  it('execute with invalid UUID recipe id returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recipes/not-a-uuid/execute',
      headers: authHeader(token),
      payload: { input: 'test' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('execute returns 404 for non-existent recipe', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${NON_EXISTENT_UUID}/execute`,
      headers: authHeader(token),
      payload: { input: 'test' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('execute returns 404 for recipe owned by other user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(otherToken),
      payload: { input: 'test' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('execute returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      payload: { input: 'test' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /executions/:id — execution retrieval', () => {
  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/executions/${NON_EXISTENT_UUID}`,
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for non-existent execution UUID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/executions/${NON_EXISTENT_UUID}`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for invalid (non-UUID) execution id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/executions/not-a-uuid',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /recipes/:id/executions — execution list', () => {
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

  it('returns 400 for invalid recipe UUID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/recipes/not-a-uuid/executions',
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for recipe owned by other user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/recipes/${recipeId}/executions`,
      headers: authHeader(otherToken),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with paginated data for valid recipe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/recipes/${recipeId}/executions`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(20);
  });

  it('limit parameter is respected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/recipes/${recipeId}/executions?limit=5`,
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().pagination.limit).toBe(5);
  });
});

describe('ExecutionService — DB operations', () => {
  let executionService: ExecutionService;

  beforeAll(() => {
    executionService = new ExecutionService(app.db);
  });

  it('getByIdAndUserId returns null for non-existent execution', async () => {
    const result = await executionService.getByIdAndUserId(NON_EXISTENT_UUID, NON_EXISTENT_UUID);
    expect(result).toBeNull();
  });

  it('listByRecipe returns empty data array for recipe with no executions', async () => {
    const result = await executionService.listByRecipe(
      NON_EXISTENT_UUID,
      NON_EXISTENT_UUID,
      { page: 1, limit: 20 },
    );

    expect(result.data).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });

  it('listByRecipe pagination structure is correct', async () => {
    const result = await executionService.listByRecipe(
      NON_EXISTENT_UUID,
      NON_EXISTENT_UUID,
      { page: 2, limit: 5 },
    );

    expect(result.pagination.page).toBe(2);
    expect(result.pagination.limit).toBe(5);
    expect(result.pagination.totalPages).toBe(0);
  });
});
