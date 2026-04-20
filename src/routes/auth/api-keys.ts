import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { apiKeys } from '../../db/schema/api-keys.js';
import { encrypt, decrypt } from '../../services/crypto/index.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const addKeySchema = z.object({
  provider: z.enum(['anthropic', 'openai']),
  key: z.string().min(1),
  label: z.string().optional(),
});

function validateApiKey(provider: string, key: string): boolean {
  if (provider === 'anthropic') {
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
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const result = addKeySchema.safeParse(request.body);
      if (!result.success) {
        return reply.code(400).send({ error: 'Validation failed', details: result.error.issues });
      }

      const { provider, key, label } = result.data;

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
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
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
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      if (!UUID_REGEX.test(id)) {
        return reply.code(400).send({ error: 'Invalid key ID' });
      }

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
