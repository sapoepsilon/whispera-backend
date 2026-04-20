import type { FastifyInstance } from 'fastify';
import { buildApp as _buildApp } from '../src/server.js';

export const DEFAULT_PASSWORD = 'TestPassword123!';
export const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function buildTestApp(): Promise<FastifyInstance> {
  return _buildApp();
}

export function generateTestUserId(): string {
  return `test-clerk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function registerAndGetToken(
  app: FastifyInstance,
): Promise<{ accessToken: string }> {
  const clerkId = generateTestUserId();
  await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${clerkId}` },
  });
  return { accessToken: clerkId };
}

export function authHeader(clerkUserId: string) {
  return { authorization: `Bearer ${clerkUserId}` };
}

export async function createRecipe(
  app: FastifyInstance,
  token: string,
  payload: Record<string, unknown> = {},
) {
  const defaultPayload = {
    name: 'Test Recipe',
    steps: [{ type: 'llm', config: { prompt: 'test' }, name: 'Step 1' }],
    ...payload,
  };

  const res = await app.inject({
    method: 'POST',
    url: '/recipes',
    headers: authHeader(token),
    payload: defaultPayload,
  });

  return res.json();
}

export async function publishRecipe(
  app: FastifyInstance,
  token: string,
  payload: { recipeId: string; description: string; category: string; tags?: string[] },
) {
  const res = await app.inject({
    method: 'POST',
    url: '/store/publish',
    headers: authHeader(token),
    payload,
  });

  return res.json();
}

export function createAudioPayload(
  filename: string,
  mimetype: string,
  content: Buffer = Buffer.from('fake-audio-data'),
  extraFields?: Record<string, string>,
) {
  const boundary = '----FormBoundary' + Date.now();
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="audio"; filename="${filename}"\r\n` +
        `Content-Type: ${mimetype}\r\n\r\n`,
    ),
    content,
  ];

  if (extraFields) {
    for (const [key, value] of Object.entries(extraFields)) {
      parts.push(
        Buffer.from(
          `\r\n--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
            value,
        ),
      );
    }
  }

  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export function parseSSEEvents(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split('\n\n')
    .filter((block) => block.trim().length > 0 && !block.startsWith(':'))
    .map((block) => {
      const lines = block.split('\n');
      let event = '';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7);
        if (line.startsWith('data: ')) data = line.slice(6);
      }
      return { event, data: data ? JSON.parse(data) : null };
    });
}

export function createStripeWebhookPayload(
  sessionId: string,
  userId: string,
  credits: number,
) {
  return {
    id: `evt_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        payment_intent: `pi_${Date.now()}`,
        metadata: { userId, credits: String(credits) },
      },
    },
  };
}

export async function completeOAuthFlow(
  app: FastifyInstance,
  token: string,
): Promise<string> {
  const initiateRes = await app.inject({
    method: 'GET',
    url: '/auth/oauth/openai',
    headers: authHeader(token),
  });

  const url = new URL(initiateRes.json().url);
  return url.searchParams.get('state') ?? '';
}
