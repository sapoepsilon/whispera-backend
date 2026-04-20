import { eq, and } from 'drizzle-orm';
import { oauthConnections } from '../../../db/schema/oauth-connections.js';
import { encrypt, decrypt } from '../../crypto/index.js';
import type { Database } from '../../../db/index.js';

export class OAuthConnectionService {
  constructor(private db: Database) {}

  async saveConnection(
    userId: string,
    provider: string,
    accessToken: string,
    refreshToken: string | null,
    expiresIn: number,
  ): Promise<void> {
    const encryptedAccess = encrypt(accessToken);
    const encryptedRefresh = refreshToken ? encrypt(refreshToken) : null;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    const [existing] = await this.db
      .select()
      .from(oauthConnections)
      .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, provider)))
      .limit(1);

    if (existing) {
      await this.db
        .update(oauthConnections)
        .set({
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          expiresAt,
        })
        .where(eq(oauthConnections.id, existing.id));
    } else {
      await this.db.insert(oauthConnections).values({
        userId,
        provider,
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        expiresAt,
      });
    }
  }

  async getConnection(userId: string, provider: string) {
    const [conn] = await this.db
      .select()
      .from(oauthConnections)
      .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, provider)))
      .limit(1);

    if (!conn) return null;

    return {
      ...conn,
      accessToken: decrypt(conn.accessToken),
      refreshToken: conn.refreshToken ? decrypt(conn.refreshToken) : null,
    };
  }

  async deleteConnection(userId: string, provider: string): Promise<void> {
    await this.db
      .delete(oauthConnections)
      .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, provider)));
  }

  async updateTokens(
    userId: string,
    provider: string,
    accessToken: string,
    refreshToken: string | null,
    expiresIn: number,
  ): Promise<void> {
    const encryptedAccess = encrypt(accessToken);
    const encryptedRefresh = refreshToken ? encrypt(refreshToken) : null;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    await this.db
      .update(oauthConnections)
      .set({
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        expiresAt,
      })
      .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, provider)));
  }
}
