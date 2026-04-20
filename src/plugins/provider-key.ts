import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ProviderName } from '../types/index.js';

export type KeySource = 'byok' | 'codex-oauth' | 'credits';

declare module 'fastify' {
  interface FastifyRequest {
    providerKey: string | null;
    providerName: ProviderName | null;
    keySource: KeySource;
  }
}

function detectProvider(key: string): ProviderName {
  if (key.startsWith('sk-ant-')) return 'claude';
  return 'openai';
}

async function providerKeyPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest('providerKey', null);
  fastify.decorateRequest('providerName', null);
  fastify.decorateRequest('keySource', 'credits');

  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    const key = request.headers['x-provider-key'] as string | undefined;
    const providerOverride = request.headers['x-provider'] as string | undefined;

    if (key) {
      request.providerKey = key;
      request.keySource = 'byok';
      request.providerName = providerOverride
        ? (providerOverride as ProviderName)
        : detectProvider(key);
    } else {
      request.keySource = 'credits';
      request.providerName = providerOverride
        ? (providerOverride as ProviderName)
        : null;
    }
  });
}

export default fp(providerKeyPlugin, {
  name: 'provider-key',
});
