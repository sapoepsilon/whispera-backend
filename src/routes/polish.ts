import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const polishBodySchema = z.object({
  text: z.string().min(1),
});

const polishResponseSchema = z.object({
  polished: z.string(),
});

const errorSchema = z.object({ error: z.string() });

const POLISH_SYSTEM_PROMPT =
  "Clean up this dictated text. Remove filler words (um, uh, like, you know), fix grammar and punctuation, but preserve the speaker's meaning, tone, and voice. Do not make it more formal unless it already was. Output only the cleaned text, no preamble.";

export default async function polishRoute(app: FastifyInstance) {
  app.post(
    '/polish',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['polish'],
        summary: 'Polish dictated text via the platform LLM',
        description:
          'Cleans up filler words and grammar while preserving voice. Uses the platform OpenAI key by default; ' +
          'an X-Provider-Key header overrides for BYOK clients.',
        security: [{ bearerAuth: [] }],
        body: polishBodySchema,
        response: {
          200: polishResponseSchema,
          500: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { text } = request.body as z.infer<typeof polishBodySchema>;

      const byokKey =
        typeof request.headers['x-provider-key'] === 'string'
          ? request.headers['x-provider-key']
          : undefined;
      const apiKey = byokKey || process.env.OPENAI_API_KEY;

      if (!apiKey) {
        return reply.code(500).send({ error: 'No OpenAI key configured on the server' });
      }

      try {
        const model = createOpenAI({ apiKey })('gpt-4o-mini');
        const result = await generateText({
          model,
          messages: [
            { role: 'system', content: POLISH_SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
        });
        return { polished: result.text };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error({ err }, 'WHI-41: /polish failed');
        return reply.code(500).send({ error: message });
      }
    },
  );
}
