import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { generateText, APICallError, type ModelMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { apiKeys } from '../../db/schema/api-keys.js';
import { OAuthConnectionService } from '../../services/auth/oauth/connection.js';
import { decrypt } from '../../services/crypto/index.js';

const completionBodySchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().max(100000),
  })).min(1),
  provider: z.enum(['claude', 'anthropic', 'openai']).optional(),
  model: z.string().max(100).optional(),
  stream: z.boolean().optional(),
});

type CompletionBody = z.infer<typeof completionBodySchema>;

function isClaudeProvider(provider: string): boolean {
  return provider === 'claude' || provider === 'anthropic';
}

export default async function chatCompletionsRoute(app: FastifyInstance) {
  app.post<{ Body: CompletionBody }>(
    '/chat/completions',
    { preHandler: [app.authenticate], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = completionBodySchema.parse(request.body);
      const { messages, provider: bodyProvider, model } = parsed;
      const headerProviderKey = request.providerKey;
      let keySource = request.keySource;
      let resolvedKey: string | null = headerProviderKey;
      const keyFromHeader = !!headerProviderKey;

      const provider = bodyProvider ?? request.providerName ?? 'openai';

      if (keySource !== 'byok') {
        const [matchingKey] = await app.db
          .select({ provider: apiKeys.provider, encryptedKey: apiKeys.encryptedKey })
          .from(apiKeys)
          .where(and(eq(apiKeys.userId, request.userId), eq(apiKeys.provider, provider)))
          .limit(1);

        if (matchingKey) {
          keySource = 'byok';
          resolvedKey = decrypt(matchingKey.encryptedKey);
        } else if (provider === 'openai') {
          const connectionService = new OAuthConnectionService(app.db);
          const oauthConn = await connectionService.getConnection(request.userId, 'openai');
          if (oauthConn) {
            keySource = 'codex-oauth';
            resolvedKey = oauthConn.accessToken;
          } else {
            keySource = 'credits';
          }
        } else {
          keySource = 'credits';
        }
      }

      if (!resolvedKey && keySource !== 'credits') {
        return reply.code(402).send({ error: 'No API key available', keySource, provider });
      }

      if (keySource === 'credits') {
        const platformKey = isClaudeProvider(provider)
          ? process.env.ANTHROPIC_API_KEY
          : process.env.OPENAI_API_KEY;

        if (!platformKey) {
          return reply.code(200).send({ keySource, provider });
        }

        resolvedKey = platformKey;
      }

      try {
        const systemMsg = messages.find((m) => m.role === 'system');
        const nonSystemMsgs: ModelMessage[] = messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        const languageModel = isClaudeProvider(provider)
          ? createAnthropic({ apiKey: resolvedKey! })(model ?? 'claude-sonnet-4-6-20250501')
          : createOpenAI({ apiKey: resolvedKey! })(model ?? 'gpt-4o');

        const result = await generateText({
          model: languageModel,
          ...(systemMsg ? { system: systemMsg.content } : {}),
          messages: nonSystemMsgs,
          ...(isClaudeProvider(provider) ? { maxOutputTokens: 1024 } : {}),
        });

        return reply.code(200).send({
          keySource,
          provider,
          choices: [{ message: { role: 'assistant', content: result.text } }],
          usage: {
            prompt_tokens: result.usage.inputTokens,
            completion_tokens: result.usage.outputTokens,
          },
        });
      } catch (err) {
        if (keyFromHeader && APICallError.isInstance(err)) {
          const status = err.statusCode;
          if (status === 401 || status === 403) {
            return reply.code(status).send({ error: 'Invalid API key', keySource, provider });
          }
        }
        return reply.code(200).send({ keySource, provider });
      }
    },
  );
}
