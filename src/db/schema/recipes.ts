import { pgTable, uuid, varchar, text, jsonb, timestamp, boolean } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  triggerPhrase: varchar('trigger_phrase', { length: 255 }),
  steps: jsonb('steps').$type<RecipeStep[]>().notNull(),
  integrations: jsonb('integrations').$type<Record<string, unknown>>(),
  permissions: jsonb('permissions').$type<Record<string, unknown>>(),
  outputFormat: varchar('output_format', { length: 50 }).notNull().default('text'),
  isPublic: boolean('is_public').notNull().default(false),
  installedFromStoreId: uuid('installed_from_store_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export interface RecipeStep {
  type: string;
  config: Record<string, unknown>;
  name: string;
}

export type Recipe = typeof recipes.$inferSelect;
export type NewRecipe = typeof recipes.$inferInsert;
