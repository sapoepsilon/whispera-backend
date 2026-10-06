import fp from 'fastify-plugin';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
    return pkg.version as string;
  } catch {
    return '0.0.0';
  }
}

export default fp(async (app) => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Whispera Backend API',
        description:
          'Voice-to-action backend. Clients send transcribed audio or chat messages, ' +
          'execute multi-step recipe pipelines, and bring their own OpenAI/Anthropic keys (BYOK).',
        version: getVersion(),
      },
      servers: [
        { url: 'http://localhost:3000', description: 'Local development' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
          providerKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Provider-Key',
            description:
              'Pass-through BYOK key (Anthropic sk-ant-… or OpenAI sk-…). ' +
              'Backend never stores this value. Per-request only.',
          },
        },
      },
      tags: [
        { name: 'health', description: 'Liveness and version' },
        { name: 'auth', description: 'User identity (Clerk-backed)' },
        { name: 'api-keys', description: 'BYOK key management (encrypted at rest)' },
        { name: 'recipes', description: 'Recipe CRUD' },
        { name: 'executions', description: 'Recipe execution + history' },
        { name: 'chat', description: 'Direct LLM chat completions' },
        { name: 'transcribe', description: 'Whisper audio transcription' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
    staticCSP: true,
  });
});
