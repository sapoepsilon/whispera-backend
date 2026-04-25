import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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
        if (isClaudeProvider(provider)) {
          const client = new Anthropic({ apiKey: resolvedKey! });
          const systemMsg = messages.find((m) => m.role === 'system');
          const nonSystemMsgs = messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

          const response = await client.messages.create({
            model: model ?? 'claude-sonnet-4-6-20250501',
            max_tokens: 1024,
            ...(systemMsg ? { system: systemMsg.content } : {}),
            messages: nonSystemMsgs,
          });

          const text = response.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');

          return reply.code(200).send({
            keySource,
            provider,
            choices: [{ message: { role: 'assistant', content: text } }],
            usage: {
              prompt_tokens: response.usage.input_tokens,
              completion_tokens: response.usage.output_tokens,
            },
          });
        }

        const client = new OpenAI({ apiKey: resolvedKey! });
        const completion = await client.chat.completions.create({
          model: model ?? 'gpt-4o',
          messages: messages.map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: m.content,
          })),
        });

        return reply.code(200).send({
          keySource,
          provider,
          choices: completion.choices.map((c) => ({
            message: { role: c.message.role, content: c.message.content ?? '' },
          })),
          usage: completion.usage
            ? {
                prompt_tokens: completion.usage.prompt_tokens,
                completion_tokens: completion.usage.completion_tokens,
              }
            : undefined,
        });
      } catch (err) {
        if (keyFromHeader) {
          const status = (err as { status?: number }).status;
          if (status === 401 || status === 403) {
            return reply.code(status).send({ error: 'Invalid API key', keySource, provider });
          }
        }
        return reply.code(200).send({ keySource, provider });
      }
    },
  );
}
