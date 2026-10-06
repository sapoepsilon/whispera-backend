import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '../../db/schema/users.js';

const userResponseSchema = z.object({
  id: z.string().uuid(),
  clerkId: z.string(),
  email: z.string().email().nullable(),
  name: z.string().nullable(),
  createdAt: z.date(),
});

const errorSchema = z.object({ error: z.string() });

export default async function authRoutes(app: FastifyInstance) {
  app.get(
    '/auth/me',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Get the current authenticated user',
        description: 'Returns the user record matching the JWT subject.',
        security: [{ bearerAuth: [] }],
        response: {
          200: userResponseSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const [user] = await app.db
        .select({
          id: users.id,
          clerkId: users.clerkId,
          email: users.email,
          name: users.name,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, request.userId))
        .limit(1);

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return reply.code(200).send(user);
    },
  );
}
