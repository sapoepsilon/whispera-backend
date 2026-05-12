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

import { buildTestApp, registerAndGetToken, authHeader } from '../helpers.js';

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

describe('Real OpenAI E2E — /chat/completions', () => {
  it('returns a real completion when X-Provider-Key header is used (BYOK pass-through)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: {
        ...authHeader(token),
        'x-provider-key': OPENAI_API_KEY!,
      },
      payload: {
        provider: 'openai',
        model: MODEL,
        messages: [
          {
            role: 'user',
            content:
              'Reply with the single word PONG and nothing else. No punctuation.',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.keySource).toBe('byok');
    expect(body.provider).toBe('openai');
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices.length).toBeGreaterThan(0);

    const content: string = body.choices[0].message.content;
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
    expect(content.toUpperCase()).toContain('PONG');

    expect(body.usage).toBeDefined();
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
  });

  it('returns a real completion when the key is stored via /auth/api-keys (DB BYOK)', async () => {
    const userB = await registerAndGetToken(app);
    const tokenB = userB.accessToken;

    const addKeyRes = await app.inject({
      method: 'POST',
      url: '/auth/api-keys',
      headers: authHeader(tokenB),
      payload: { provider: 'openai', key: OPENAI_API_KEY, label: 'e2e' },
    });
    expect(addKeyRes.statusCode).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: authHeader(tokenB),
      payload: {
        provider: 'openai',
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: 'Reply with the single word PONG and nothing else.',
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keySource).toBe('byok');
    expect(body.choices[0].message.content.toUpperCase()).toContain('PONG');
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('rejects an obviously invalid key with 401/403 when passed via header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat/completions',
      headers: {
        ...authHeader(token),
        'x-provider-key': 'sk-not-a-real-key-zzz',
      },
      payload: {
        provider: 'openai',
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect([401, 403]).toContain(res.statusCode);
    expect(res.json().error).toBeDefined();
  });
});
