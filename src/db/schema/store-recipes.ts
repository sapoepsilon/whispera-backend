import { pgTable, uuid, varchar, text, jsonb, timestamp, integer } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { recipes } from './recipes.js';

export const VALID_CATEGORIES = [
  'productivity',
  'coding',
  'writing',
  'communication',
  'research',
  'creative',
  'education',
  'business',
  'other',
] as const;

export type StoreCategory = (typeof VALID_CATEGORIES)[number];

export const storeRecipes = pgTable('store_recipes', {
  id: uuid('id').primaryKey().defaultRandom(),
  originalRecipeId: uuid('original_recipe_id')
    .notNull()
    .references(() => recipes.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description').notNull(),
  category: varchar('category', { length: 50 }).notNull(),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  steps: jsonb('steps').$type<Array<{ type: string; config: Record<string, unknown> }>>().notNull(),
  version: integer('version').notNull().default(1),
  status: varchar('status', { length: 20 }).notNull().default('published'),
  installCount: integer('install_count').notNull().default(0),
  rating: integer('rating').notNull().default(0),
  ratingCount: integer('rating_count').notNull().default(0),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type StoreRecipe = typeof storeRecipes.$inferSelect;
export type NewStoreRecipe = typeof storeRecipes.$inferInsert;
