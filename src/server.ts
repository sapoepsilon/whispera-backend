import Fastify from 'fastify';
import fastifyEnv from '@fastify/env';
import fastifySensible from '@fastify/sensible';
import { fileURLToPath } from 'node:url';
import { envSchema } from './config/env.js';
import type { EnvConfig } from './config/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: EnvConfig;
  }
}

let _testTruncated = false;

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'silent' : process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  await app.register(fastifyEnv, { schema: envSchema, dotenv: true });
  await app.register(fastifySensible);

  const { default: dbPlugin } = await import('./plugins/db.js');
  await app.register(dbPlugin);

  if (process.env.NODE_ENV === 'test' && !_testTruncated) {
    _testTruncated = true;
    const { sql } = await import('drizzle-orm');
    await app.db.execute(sql`TRUNCATE users, recipes, executions, store_recipes, store_reviews, oauth_connections, credit_balances, credit_transactions, api_keys CASCADE`).catch((_e: unknown) => {});
  }

  const { default: authPlugin } = await import('./plugins/auth.js');
  await app.register(authPlugin);

  const { default: providerKeyPlugin } = await import('./plugins/provider-key.js');
  await app.register(providerKeyPlugin);

  const multipart = await import('@fastify/multipart');
  await app.register(multipart.default);

  const { default: healthRoute } = await import('./routes/health.js');
  await app.register(healthRoute);

  const { default: authRoutes } = await import('./routes/auth/index.js');
  await app.register(authRoutes);

  const { default: apiKeysRoutes } = await import('./routes/auth/api-keys.js');
  await app.register(apiKeysRoutes);

  const { default: openaiOAuthRoutes } = await import('./routes/auth/oauth/openai.js');
  await app.register(openaiOAuthRoutes);

  const { default: recipesRoutes } = await import('./routes/recipes/index.js');
  await app.register(recipesRoutes);

  const { default: storeRoutes } = await import('./routes/store/index.js');
  await app.register(storeRoutes);

  const { default: executionRoutes } = await import('./routes/executions.js');
  await app.register(executionRoutes);

  const { default: chatCompletionsRoute } = await import('./routes/chat/completions.js');
  await app.register(chatCompletionsRoute);

  const { default: billingCreditsRoutes } = await import('./routes/billing/credits.js');
  await app.register(billingCreditsRoutes);

  const { default: transcribeRoute } = await import('./routes/transcribe.js');
  await app.register(transcribeRoute);

  return app;
}

async function start() {
  const app = await buildApp();

  try {
    const address = await app.listen({
      port: app.config.PORT,
      host: app.config.HOST,
    });
    app.log.info(`Server listening at ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start();
}
