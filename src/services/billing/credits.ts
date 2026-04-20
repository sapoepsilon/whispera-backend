import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { creditBalances, creditTransactions } from '../../db/schema/credits.js';

export class CreditService {
  private get db() {
    return getDb(process.env.DATABASE_URL!);
  }

  async getBalance(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ balance: creditBalances.balance })
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .limit(1);

    return row?.balance ?? 0;
  }

  async getTransactions(userId: string) {
    return this.db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, userId))
      .orderBy(creditTransactions.createdAt);
  }

  async addCredits(userId: string, amount: number, stripeSessionId?: string): Promise<void> {
    await this.db
      .insert(creditBalances)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({
        target: creditBalances.userId,
        set: { balance: sql`${creditBalances.balance} + ${amount}` },
      });

    await this.db.insert(creditTransactions).values({
      userId,
      amount,
      type: 'credit',
      description: 'Credits purchased',
      stripeSessionId: stripeSessionId ?? null,
    });
  }

  async deductCredits(userId: string, amount: number): Promise<void> {
    const balance = await this.getBalance(userId);
    if (balance < amount) {
      throw new Error('InsufficientCreditsError');
    }

    await this.db
      .update(creditBalances)
      .set({ balance: sql`${creditBalances.balance} - ${amount}` })
      .where(eq(creditBalances.userId, userId));

    await this.db.insert(creditTransactions).values({
      userId,
      amount: -amount,
      type: 'debit',
      description: 'Credits used',
    });
  }

  async hasEnoughCredits(userId: string, amount: number): Promise<boolean> {
    const balance = await this.getBalance(userId);
    return balance >= amount;
  }

  async hasProcessedSession(stripeSessionId: string): Promise<boolean> {
    const [existing] = await this.db
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(eq(creditTransactions.stripeSessionId, stripeSessionId))
      .limit(1);

    return !!existing;
  }
}
