import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { StoreService } from '../../services/store/index.js';
import { VALID_CATEGORIES } from '../../db/schema/store-recipes.js';
import { UUID_REGEX } from '../../utils/validation.js';

const VALID_SORTS = ['popular', 'newest', 'top-rated'] as const;

const browseQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  category: z.enum(VALID_CATEGORIES).optional(),
  search: z.string().optional(),
  tags: z.string().optional(),
  sort: z.enum(VALID_SORTS).optional(),
});

const publishSchema = z.object({
  recipeId: z.string().uuid(),
  description: z.string().min(10).max(2000),
  category: z.enum(VALID_CATEGORIES),
  tags: z
    .array(z.string().min(1).max(50))
    .max(10)
    .optional()
    .default([]),
});

export default async function storeRoutes(app: FastifyInstance) {
  const service = new StoreService(app.db);

  app.get('/store', async (request: FastifyRequest, reply: FastifyReply) => {
    const result = browseQuerySchema.safeParse(request.query);
    if (!result.success) {
      return reply.code(400).send({ error: 'Validation failed', details: result.error.issues });
    }

    const { page, limit, category, search, tags: tagsStr, sort } = result.data;
    const tags = tagsStr ? tagsStr.split(',').map((t) => t.trim()) : undefined;

    const data = await service.browse({ page, limit, category, search, tags, sort });
    return reply.code(200).send(data);
  });

  app.get<{ Params: { id: string } }>(
    '/store/:id',
    async (request, reply) => {
      const { id } = request.params;

      if (!UUID_REGEX.test(id)) {
        return reply.code(400).send({ error: 'Invalid store recipe ID' });
      }

      const recipe = await service.getById(id);
      if (!recipe) {
        return reply.code(404).send({ error: 'Store recipe not found' });
      }

      return reply.code(200).send(recipe);
    },
  );

  app.post(
    '/store/publish',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const result = publishSchema.safeParse(request.body);
      if (!result.success) {
        return reply.code(400).send({ error: 'Validation failed', details: result.error.issues });
      }

      const published = await service.publish(request.userId, result.data.recipeId, {
        description: result.data.description,
        category: result.data.category,
        tags: result.data.tags,
      });

      if (!published) {
        return reply.code(404).send({ error: 'Recipe not found or not owned by user' });
      }

      return reply.code(201).send(published);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/store/:id/install',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params;

      if (!UUID_REGEX.test(id)) {
        return reply.code(400).send({ error: 'Invalid store recipe ID' });
      }

      const installed = await service.install(id, request.userId);
      if (!installed) {
        return reply.code(404).send({ error: 'Store recipe not found' });
      }

      return reply.code(201).send(installed);
    },
  );

  app.post<{ Params: { id: string }; Body: { rating: number; comment?: string } }>(
    '/store/:id/reviews',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params;
      const { rating, comment } = request.body;

      const review = await service.addReview(id, request.userId, rating, comment);
      return reply.code(201).send(review);
    },
  );
}
