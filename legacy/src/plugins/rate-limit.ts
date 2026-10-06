import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

async function rateLimitPlugin(fastify: FastifyInstance) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });
}

export default fp(rateLimitPlugin, { name: 'rate-limit' });
