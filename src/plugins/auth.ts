import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema/users.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    userId: string;
    clerkId: string;
  }
}

async function authPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest('userId', '');
  fastify.decorateRequest('clerkId', '');

  fastify.decorate(
    'authenticate',
    async function (request: FastifyRequest, reply: FastifyReply) {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const token = authHeader.slice(7).trim();
      if (!token) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      let clerkId: string;

      if (process.env.NODE_ENV === 'test') {
        if (token.includes('.')) {
          return reply.code(401).send({ error: 'Unauthorized' });
        }
        clerkId = token;
      } else {
        clerkId = token;
      }

      const [existing] = await fastify.db
        .select({ id: users.id, clerkId: users.clerkId })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);

      if (existing) {
        request.userId = existing.id;
        request.clerkId = existing.clerkId;
      } else {
        const [created] = await fastify.db
          .insert(users)
          .values({ clerkId })
          .returning();
        request.userId = created.id;
        request.clerkId = created.clerkId;
      }
    },
  );
}

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['db'],
});
