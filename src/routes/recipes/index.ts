import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RecipeService } from '../../services/recipes/index.js';

const VALID_STEP_TYPES = ['llm', 'transform', 'conditional', 'api', 'output', 'transcribe', 'summarize'];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stepSchema = z.object({
  type: z.enum(VALID_STEP_TYPES as [string, ...string[]]),
  config: z.record(z.string(), z.any()),
  name: z.string().optional(),
});

const createRecipeSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  triggerPhrase: z.string().nullable().optional(),
  steps: z.array(stepSchema).min(1),
  integrations: z.record(z.string(), z.any()).nullable().optional(),
  permissions: z.record(z.string(), z.any()).nullable().optional(),
  outputFormat: z.string().optional().default('text'),
  isPublic: z.boolean().optional().default(false),
});

const updateRecipeSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  triggerPhrase: z.string().nullable().optional(),
  steps: z.array(stepSchema).min(1).optional(),
  integrations: z.record(z.string(), z.any()).nullable().optional(),
  permissions: z.record(z.string(), z.any()).nullable().optional(),
  outputFormat: z.string().optional(),
  isPublic: z.boolean().optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
});

export default async function recipesRoutes(app: FastifyInstance) {
  const service = new RecipeService(app.db);

  app.post(
    '/recipes',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const result = createRecipeSchema.safeParse(request.body);
      if (!result.success) {
        return reply.code(400).send({ error: 'Validation failed', details: result.error.issues });
      }

      const recipe = await service.create({
        ...result.data,
        userId: request.userId,
      });

      return reply.code(201).send(recipe);
    },
  );

  app.get(
    '/recipes',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const result = listQuerySchema.safeParse(request.query);
      if (!result.success) {
        return reply.code(400).send({ error: 'Validation failed', details: result.error.issues });
      }

      const { page, limit, search } = result.data;
      const list = await service.listByUser(request.userId, { page, limit, search });

      return reply.code(200).send(list);
    },
  );

  app.put(
    '/recipes/:id',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      if (!UUID_REGEX.test(id)) {
        return reply.code(400).send({ error: 'Invalid recipe ID' });
      }

      const body = request.body as Record<string, unknown> | null;
      if (!body || Object.keys(body).length === 0) {
        return reply.code(400).send({ error: 'Request body cannot be empty' });
      }

      const result = updateRecipeSchema.safeParse(body);
      if (!result.success) {
        return reply.code(400).send({ error: 'Validation failed', details: result.error.issues });
      }

      const updated = await service.update(id, request.userId, result.data);
      if (!updated) {
        return reply.code(404).send({ error: 'Recipe not found' });
      }

      return reply.code(200).send(updated);
    },
  );

  app.delete(
    '/recipes/:id',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      if (!UUID_REGEX.test(id)) {
        return reply.code(400).send({ error: 'Invalid recipe ID' });
      }

      const deleted = await service.softDelete(id, request.userId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Recipe not found' });
      }

      return reply.code(204).send();
    },
  );
}
