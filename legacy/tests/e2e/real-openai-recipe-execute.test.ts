import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';

try {
  const parsed = parseEnv(readFileSync(resolve(process.cwd(), '.env'), 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v as string;
  }
} catch {}

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerAndGetToken,
  authHeader,
  UUID_REGEX,
} from '../helpers.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = 'gpt-4o-mini';

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for real-openai E2E tests. Set it in .env or skip this file.');
  }
  app = await buildTestApp();
  const user = await registerAndGetToken(app);
  token = user.accessToken;
});

afterAll(async () => {
  await app?.close();
});

async function createLLMRecipe(name: string, prompt: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/recipes',
    headers: authHeader(token),
    payload: {
      name,
      description: 'Real-provider E2E recipe',
      triggerPhrase: 'run e2e',
      outputFormat: 'text',
      steps: [
        {
          type: 'llm',
          name: 'Single LLM Step',
          config: {
            prompt,
            provider: 'openai',
            apiKey: OPENAI_API_KEY,
            model: MODEL,
          },
        },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.id).toMatch(UUID_REGEX);
  return body.id;
}

describe('Real OpenAI E2E — POST /recipes/:id/execute', () => {
  it('executes an LLM step against real OpenAI and persists the execution', async () => {
    const recipeId = await createLLMRecipe(
      'E2E Echo Recipe',
      'Reply with the single word PONG and nothing else. Input: {{input}}',
    );

    const execRes = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: 'ping' },
    });

    expect(execRes.statusCode).toBe(200);
    const body = execRes.json();
    expect(body.executionId).toMatch(UUID_REGEX);
    expect(body.status).toBe('completed');
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].status).toBe('completed');
    expect(typeof body.output).toBe('string');
    expect(body.output.length).toBeGreaterThan(0);
    expect(body.output.toUpperCase()).toContain('PONG');

    const getRes = await app.inject({
      method: 'GET',
      url: `/executions/${body.executionId}`,
      headers: authHeader(token),
    });
    expect(getRes.statusCode).toBe(200);
    const stored = getRes.json().data;
    expect(stored.id).toBe(body.executionId);
    expect(stored.status).toBe('completed');
  });

  it('substitutes {{input}} into the prompt so output reflects user input', async () => {
    const recipeId = await createLLMRecipe(
      'E2E Reverse Recipe',
      'You are a strict echo. Reply with exactly the input string in ALL CAPS and nothing else. Input: {{input}}',
    );

    const execRes = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: 'banana' },
    });

    expect(execRes.statusCode).toBe(200);
    const body = execRes.json();
    expect(body.status).toBe('completed');
    expect(body.output.toUpperCase()).toContain('BANANA');
  });

  it('records error status when the LLM step is given an invalid key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recipes',
      headers: authHeader(token),
      payload: {
        name: 'E2E Bad Key Recipe',
        outputFormat: 'text',
        steps: [
          {
            type: 'llm',
            name: 'Bad Key Step',
            config: {
              prompt: 'hi',
              provider: 'openai',
              apiKey: 'sk-not-a-real-key-zzz',
              model: MODEL,
            },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const recipeId = res.json().id;

    const execRes = await app.inject({
      method: 'POST',
      url: `/recipes/${recipeId}/execute`,
      headers: authHeader(token),
      payload: { input: '' },
    });

    expect(execRes.statusCode).toBe(200);
    const body = execRes.json();
    expect(body.status).toBe('failed');
    expect(body.error).toBeDefined();
    expect(body.steps[0].status).toBe('failed');
  });
});
