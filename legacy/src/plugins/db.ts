import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../db/schema/index.js';
import { getDb, type Database } from '../db/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

let _callCount = 0;

async function dbPlugin(fastify: FastifyInstance) {
  _callCount++;

  if (process.env.NODE_ENV === 'test' && _callCount > 1) {
    const schemaName = `test_fresh_${_callCount}`;
    const setupClient = postgres(fastify.config.DATABASE_URL, { max: 1 });

    await setupClient`CREATE SCHEMA IF NOT EXISTS ${setupClient(schemaName)}`;

    const tables = ['users', 'recipes', 'executions', 'store_recipes', 'store_reviews', 'oauth_connections', 'oauth_states', 'credit_balances', 'credit_transactions', 'api_keys'];
    for (const table of tables) {
      await setupClient.unsafe(`CREATE TABLE IF NOT EXISTS ${schemaName}.${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`).catch(() => {});
    }

    await setupClient.end();

    const client = postgres(fastify.config.DATABASE_URL, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      connection: {
        search_path: `${schemaName},public`,
      },
    });

    const db = drizzle(client, { schema }) as Database;
    fastify.decorate('db', db);

    fastify.addHook('onClose', async () => {
      const cleanup = postgres(fastify.config.DATABASE_URL, { max: 1 });
      await cleanup`DROP SCHEMA IF EXISTS ${cleanup(schemaName)} CASCADE`;
      await cleanup.end();
      await client.end();
    });
    return;
  }

  const db = getDb(fastify.config.DATABASE_URL);
  fastify.decorate('db', db);
}

export default fp(dbPlugin, {
  name: 'db',
  dependencies: [],
});
