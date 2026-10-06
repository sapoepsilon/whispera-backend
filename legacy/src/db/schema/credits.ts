import { pgTable, uuid, varchar, integer, timestamp } from 'drizzle-orm/pg-core';

export const creditBalances = pgTable('credit_balances', {
  userId: varchar('user_id', { length: 255 }).primaryKey(),
  balance: integer('balance').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const creditTransactions = pgTable('credit_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  amount: integer('amount').notNull(),
  type: varchar('type', { length: 50 }).notNull(),
  description: varchar('description', { length: 500 }),
  stripeSessionId: varchar('stripe_session_id', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CreditBalance = typeof creditBalances.$inferSelect;
export type CreditTransaction = typeof creditTransactions.$inferSelect;
