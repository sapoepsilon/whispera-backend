import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { OpenAICodexOAuthService } from '../../../services/auth/oauth/openai-codex.js';
import { OAuthConnectionService } from '../../../services/auth/oauth/connection.js';
import { apiKeys } from '../../../db/schema/api-keys.js';

export default async function openaiOAuthRoutes(app: FastifyInstance) {
  const oauthService = new OpenAICodexOAuthService(app.db);
  const connectionService = new OAuthConnectionService(app.db);

  app.get(
    '/auth/oauth/openai',
    { preHandler: [app.authenticate], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { url } = await oauthService.generateAuthorizationUrl(request.userId);
      return reply.code(200).send({ url });
    },
  );

  app.get(
    '/auth/oauth/openai/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request: FastifyRequest<{ Querystring: { code?: string; state?: string } }>, reply: FastifyReply) => {
      const { code, state } = request.query as { code?: string; state?: string };
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

      if (!code || !state) {
        return reply.redirect(`${frontendUrl}/settings?status=error&message=missing_params`);
      }

      const pending = await oauthService.consumeState(state);
      if (!pending) {
        return reply.redirect(`${frontendUrl}/settings?status=error&message=invalid_state`);
      }

      try {
        const tokens = await oauthService.exchangeCodeForTokens(code, pending.codeVerifier);

        await connectionService.saveConnection(
          pending.userId,
          'openai',
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresIn,
        );

        return reply.redirect(`${frontendUrl}/settings?status=connected&oauth=openai`);
      } catch {
        return reply.redirect(`${frontendUrl}/settings?status=error&message=token_exchange_failed`);
      }
    },
  );

  app.delete(
    '/auth/oauth/openai',
    { preHandler: [app.authenticate], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await connectionService.deleteConnection(request.userId, 'openai');
      await app.db
        .delete(apiKeys)
        .where(and(eq(apiKeys.userId, request.userId), eq(apiKeys.provider, 'openai')));
      return reply.code(204).send();
    },
  );
}
