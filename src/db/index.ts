import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function createDb(connectionString: string) {
  const client = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return drizzle(client, { schema });
}

export function getDb(connectionString: string) {
  if (!dbInstance) {
    dbInstance = createDb(connectionString);
  }
  return dbInstance;
}

export type Database = ReturnType<typeof createDb>;
