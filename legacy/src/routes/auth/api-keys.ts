import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { apiKeys } from '../../db/schema/api-keys.js';
import { encrypt } from '../../services/crypto/index.js';

const addKeyBodySchema = z.object({
  provider: z.enum(['claude', 'anthropic', 'openai']),
  key: z.string().min(1),
  label: z.string().optional(),
});

const apiKeyResponseSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  label: z.string().nullable(),
  createdAt: z.date(),
});

const listKeysResponseSchema = z.object({
  keys: z.array(apiKeyResponseSchema),
});

const errorSchema = z.object({
  error: z.string(),
  details: z.array(z.unknown()).optional(),
});

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

function validateApiKey(provider: string, key: string): boolean {
  if (provider === 'claude' || provider === 'anthropic') {
    return key.startsWith('sk-ant-');
  }
  if (provider === 'openai') {
    return key.startsWith('sk-');
  }
  return false;
}

export default async function apiKeysRoutes(app: FastifyInstance) {
  app.post(
    '/auth/api-keys',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['api-keys'],
        summary: 'Store a BYOK provider key',
        description:
          'Encrypts and stores a user-supplied OpenAI/Anthropic API key. ' +
          'The plaintext value is never returned in subsequent reads.',
        security: [{ bearerAuth: [] }],
        body: addKeyBodySchema,
        response: {
          201: apiKeyResponseSchema,
          400: errorSchema,
          422: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { provider, key, label } = request.body as z.infer<typeof addKeyBodySchema>;

      if (!validateApiKey(provider, key)) {
        return reply.code(422).send({ error: 'Invalid API key format for provider' });
      }

      const encryptedKey = encrypt(key);

      const [created] = await app.db
        .insert(apiKeys)
        .values({
          userId: request.userId,
          provider,
          encryptedKey,
          label: label ?? null,
        })
        .returning();

      return reply.code(201).send({
        id: created.id,
        provider: created.provider,
        label: created.label,
        createdAt: created.createdAt,
      });
    },
  );

  app.get(
    '/auth/api-keys',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['api-keys'],
        summary: 'List stored BYOK keys (metadata only)',
        security: [{ bearerAuth: [] }],
        response: { 200: listKeysResponseSchema },
      },
    },
    async (request, reply) => {
      const keys = await app.db
        .select({
          id: apiKeys.id,
          provider: apiKeys.provider,
          label: apiKeys.label,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.userId, request.userId));

      return reply.code(200).send({ keys });
    },
  );

  app.delete(
    '/auth/api-keys/:id',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['api-keys'],
        summary: 'Delete a stored BYOK key',
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        response: {
          204: z.null(),
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idParamsSchema>;

      const [deleted] = await app.db
        .delete(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, request.userId)))
        .returning();

      if (!deleted) {
        return reply.code(404).send({ error: 'API key not found' });
      }

      return reply.code(204).send();
    },
  );
}
