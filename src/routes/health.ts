import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    return 'unknown';
  }
}

function getLlmsTxt(): string {
  try {
    return readFileSync(resolve(process.cwd(), 'llms.txt'), 'utf-8');
  } catch {
    return '# Whispera Backend\n\nllms.txt not found.\n';
  }
}

const version = getVersion();
const llmsTxt = getLlmsTxt();

const healthResponseSchema = z.object({
  status: z.literal('ok'),
  timestamp: z.string().datetime(),
  version: z.string(),
});

export default async function healthRoute(fastify: FastifyInstance) {
  fastify.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness probe',
        description: 'Returns service status, current timestamp, and package version.',
        response: { 200: healthResponseSchema },
      },
    },
    async () => ({
      status: 'ok' as const,
      timestamp: new Date().toISOString(),
      version,
    }),
  );

  fastify.get(
    '/llms.txt',
    {
      schema: {
        tags: ['health'],
        summary: 'LLM-readable service summary (llmstxt.org)',
        description:
          'Returns the llms.txt document describing this API for LLM and AI tooling consumption. ' +
          'Plain text response.',
        response: { 200: z.string() },
      },
    },
    async (_request, reply) => {
      reply.type('text/markdown; charset=utf-8');
      return llmsTxt;
    },
  );
}
