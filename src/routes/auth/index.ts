import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema/users.js';

export default async function authRoutes(app: FastifyInstance) {
  app.get(
    '/auth/me',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
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
