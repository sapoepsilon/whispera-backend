import { pgTable, varchar, text, uuid, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const oauthStates = pgTable('oauth_states', {
  state: varchar('state', { length: 64 }).primaryKey(),
  codeVerifier: text('code_verifier').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export type OAuthState = typeof oauthStates.$inferSelect;
export type NewOAuthState = typeof oauthStates.$inferInsert;
