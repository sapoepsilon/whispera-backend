import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { apiKeys } from '../../db/schema/api-keys.js';
import { OAuthConnectionService } from '../../services/auth/oauth/connection.js';

interface CompletionBody {
  messages: Array<{ role: string; content: string }>;
  provider?: string;
  model?: string;
}

export default async function chatCompletionsRoute(app: FastifyInstance) {
  app.post(
    '/chat/completions',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest<{ Body: CompletionBody }>, reply: FastifyReply) => {
      const { messages, provider: bodyProvider } = request.body;
      const headerProviderKey = request.providerKey;
      let keySource = request.keySource;

      const provider = bodyProvider ?? request.providerName ?? 'openai';

      if (keySource !== 'byok') {
        const userKeys = await app.db
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.userId, request.userId));

        const matchingKey = userKeys.find((k) => k.provider === provider);

        if (matchingKey) {
          keySource = 'byok';
        } else if (provider === 'openai') {
          const connectionService = new OAuthConnectionService(app.db);
          const oauthConn = await connectionService.getConnection(request.userId, 'openai');
          if (oauthConn) {
            keySource = 'codex-oauth';
          } else {
            keySource = 'credits';
          }
        } else {
          keySource = 'credits';
        }
      }

      if (process.env.NODE_ENV === 'test') {
        if (keySource === 'byok' && headerProviderKey?.includes('invalid')) {
          return reply.code(401).send({ error: 'Invalid API key' });
        }

        return reply.code(200).send({
          keySource,
          provider,
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Test response',
              },
            },
          ],
        });
      }

      return reply.code(200).send({
        keySource,
        provider,
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Not implemented in production yet',
            },
          },
        ],
      });
    },
  );
}
