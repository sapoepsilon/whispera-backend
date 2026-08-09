import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { polishModel } from '../config/models.js';
import { resolvePlatformApiKey } from '../services/billing/bypass.js';

const polishBodySchema = z.object({
  text: z.string().min(1),
});

const polishResponseSchema = z.object({
  polished: z.string(),
});

const errorSchema = z.object({ error: z.string() });

const POLISH_SYSTEM_PROMPT =
  "Rewrite this dictated text as a polite, well-formatted email body. Remove filler words, fix grammar and punctuation, structure into clear sentences and paragraphs, and keep the original meaning. Use a professional but warm tone. Do not add a subject line, greeting (Hi, Hello), or sign-off (Thanks, Best) unless the speaker dictated one. Output only the email body, no preamble or commentary.";

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
      const apiKey = byokKey || resolvePlatformApiKey(process.env.OPENAI_API_KEY);

      app.log.info(
        { userId: request.userId, byok: !!byokKey, inputChars: text.length },
        '/polish hit',
      );

      if (!apiKey) {
        app.log.error('/polish: no OpenAI key on server and no BYOK header');
        return reply.code(500).send({ error: 'No OpenAI key configured on the server' });
      }

      try {
        const start = Date.now();
        const modelId = polishModel();
        const model = createOpenAI({ apiKey })(modelId);
        const result = await generateText({
          model,
          messages: [
            { role: 'system', content: POLISH_SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
        });
        app.log.info(
          { ms: Date.now() - start, model: modelId, outputChars: result.text.length },
          '/polish ok',
        );
        return { polished: result.text };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error({ err }, '/polish failed');
        return reply.code(500).send({ error: message });
      }
    },
  );
}
