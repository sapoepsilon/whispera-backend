import { pgTable, uuid, varchar, jsonb, timestamp, text } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { recipes } from './recipes.js';

export const executions = pgTable('executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  recipeId: uuid('recipe_id')
    .notNull()
    .references(() => recipes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 50 }).notNull().default('running'),
  steps: jsonb('steps').$type<unknown[]>().notNull().default([]),
  variables: jsonb('variables').$type<Record<string, unknown>>().notNull().default({}),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export type Execution = typeof executions.$inferSelect;
export type NewExecution = typeof executions.$inferInsert;
