import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RecipeService } from '../../services/recipes/index.js';
import { RecipeSeedService } from '../../services/recipes/seed.js';
import { STEP_TYPES } from '../../types/index.js';

const stepSchema = z.object({
  type: z.enum(STEP_TYPES),
  config: z.record(z.string(), z.any()),
  name: z.string().optional(),
});

const createRecipeBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  triggerPhrase: z.string().nullable().optional(),
  steps: z.array(stepSchema).min(1),
  integrations: z.record(z.string(), z.any()).nullable().optional(),
  permissions: z.record(z.string(), z.any()).nullable().optional(),
  outputFormat: z.string().optional().default('text'),
  isPublic: z.boolean().optional().default(false),
});

const updateRecipeBodySchema = z.object({
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

const recipeResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  triggerPhrase: z.string().nullable(),
  steps: z.array(stepSchema),
  integrations: z.record(z.string(), z.any()).nullable(),
  permissions: z.record(z.string(), z.any()).nullable(),
  outputFormat: z.string(),
  isPublic: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
});

const listRecipesResponseSchema = z.object({
  data: z.array(recipeResponseSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
  }),
});

const errorSchema = z.object({
  error: z.string(),
  details: z.array(z.unknown()).optional(),
});

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

export default async function recipesRoutes(app: FastifyInstance) {
  const service = new RecipeService(app.db);
  const seedService = new RecipeSeedService(app.db);

  app.post(
    '/recipes/seed-defaults',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['recipes'],
        summary: 'Seed default starter recipes for the authenticated user',
        description:
          'Idempotent. If the user already has any non-deleted recipes, returns ' +
          '{ created: 0 } without inserting anything. Otherwise inserts the default set.',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({ created: z.number().int() }),
        },
      },
    },
    async (request) => {
      return seedService.seedDefaultsForUser(request.userId);
    },
  );

  app.post(
    '/recipes',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['recipes'],
        summary: 'Create a recipe',
        description: 'Creates a new recipe owned by the authenticated user.',
        security: [{ bearerAuth: [] }],
        body: createRecipeBodySchema,
        response: {
          201: recipeResponseSchema,
          400: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const data = request.body as z.infer<typeof createRecipeBodySchema>;
      const recipe = await service.create({
        ...data,
        userId: request.userId,
      });
      return reply.code(201).send(recipe);
    },
  );

  app.get(
    '/recipes',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['recipes'],
        summary: 'List the caller’s recipes (paginated)',
        security: [{ bearerAuth: [] }],
        querystring: listQuerySchema,
        response: { 200: listRecipesResponseSchema },
      },
    },
    async (request, reply) => {
      const { page, limit, search } = request.query as z.infer<typeof listQuerySchema>;
      const list = await service.listByUser(request.userId, { page, limit, search });
      return reply.code(200).send(list);
    },
  );

  app.put(
    '/recipes/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['recipes'],
        summary: 'Update a recipe',
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: updateRecipeBodySchema,
        response: {
          200: recipeResponseSchema,
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idParamsSchema>;
      const body = request.body as Record<string, unknown> | null;

      if (!body || Object.keys(body).length === 0) {
        return reply.code(400).send({ error: 'Request body cannot be empty' });
      }

      const updated = await service.update(
        id,
        request.userId,
        body as z.infer<typeof updateRecipeBodySchema>,
      );
      if (!updated) {
        return reply.code(404).send({ error: 'Recipe not found' });
      }

      return reply.code(200).send(updated);
    },
  );

  app.delete(
    '/recipes/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['recipes'],
        summary: 'Soft-delete a recipe',
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
      const deleted = await service.softDelete(id, request.userId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Recipe not found' });
      }
      return reply.code(204).send();
    },
  );
}
