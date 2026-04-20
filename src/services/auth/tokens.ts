import { randomBytes } from 'node:crypto';
import { eq, and, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { refreshTokens } from '../../db/schema/refresh-tokens.js';
import type { Database } from '../../db/index.js';

export function generateAccessToken(
  app: FastifyInstance,
  payload: { sub: string; email: string },
): string {
  return app.jwt.sign(payload, { expiresIn: '15m' });
}

export async function generateRefreshToken(
  db: Database,
  userId: string,
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(refreshTokens).values({
    userId,
    token,
    expiresAt,
  });

  return token;
}

export async function verifyRefreshToken(
  db: Database,
  token: string,
): Promise<{ userId: string } | null> {
  const [record] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.token, token), isNull(refreshTokens.revokedAt)))
    .limit(1);

  if (!record || record.expiresAt < new Date()) {
    return null;
  }

  return { userId: record.userId };
}

export async function revokeRefreshToken(
  db: Database,
  token: string,
): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.token, token));
}
