import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { storeRecipes } from './store-recipes.js';

export const storeReviews = pgTable('store_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeRecipeId: uuid('store_recipe_id')
    .notNull()
    .references(() => storeRecipes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type StoreReview = typeof storeReviews.$inferSelect;
export type NewStoreReview = typeof storeReviews.$inferInsert;
