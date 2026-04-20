import type { FastifyInstance } from 'fastify';
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

export default async function healthRoute(fastify: FastifyInstance) {
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: getVersion(),
    };
  });
}
