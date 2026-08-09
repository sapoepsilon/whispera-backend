import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import fastifyEnv from '@fastify/env';
import fastifySensible from '@fastify/sensible';
import { ZodError } from 'zod';
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

  const { isBillingBypassEnabled } = await import('./services/billing/bypass.js');
  if (isBillingBypassEnabled()) {
    const { defaultRecipeModel, polishModel } = await import('./config/models.js');
    app.log.warn(
      {
        billingBypass: true,
        defaultRecipeModel: defaultRecipeModel(),
        polishModel: polishModel(),
        openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      },
      'BILLING_BYPASS is enabled: every request is treated as a fully paid subscriber with unlimited credits. Do not use in production.',
    );
  }

  const { default: swaggerPlugin } = await import('./plugins/swagger.js');
  await app.register(swaggerPlugin);

  await app.register(import('@fastify/cors'), {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  await app.register(import('@fastify/helmet'), {
    contentSecurityPolicy: false,
  });

  const { default: dbPlugin } = await import('./plugins/db.js');
  await app.register(dbPlugin);

  if (process.env.NODE_ENV === 'test' && !_testTruncated) {
    _testTruncated = true;
    const { sql } = await import('drizzle-orm');
    await app.db.execute(sql`TRUNCATE users, recipes, executions, store_recipes, store_reviews, oauth_connections, oauth_states, credit_balances, credit_transactions, api_keys CASCADE`).catch((_e: unknown) => {});
  }

  const { default: authPlugin } = await import('./plugins/auth.js');
  await app.register(authPlugin);

  const { default: providerKeyPlugin } = await import('./plugins/provider-key.js');
  await app.register(providerKeyPlugin);

  const { default: rateLimitPlugin } = await import('./plugins/rate-limit.js');
  await app.register(rateLimitPlugin);

  const multipart = await import('@fastify/multipart');
  await app.register(multipart.default, { limits: { fileSize: 25 * 1024 * 1024 } });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    app.log.error(error);

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'Validation error',
        details: error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const statusCode = error.statusCode ?? 500;

    if (isProduction) {
      return reply.code(statusCode).send({
        error: statusCode >= 500 ? 'Internal Server Error' : error.message,
      });
    }

    return reply.code(statusCode).send({
      error: error.message,
      stack: error.stack,
    });
  });

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

  const { default: polishRoute } = await import('./routes/polish.js');
  await app.register(polishRoute);

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
