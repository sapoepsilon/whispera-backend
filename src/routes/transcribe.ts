import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createTranscriptionProvider } from '../services/transcription/index.js';

const transcribeResponseSchema = z.object({
  text: z.string(),
  language: z.string(),
  duration: z.number(),
  provider: z.string(),
});

const errorSchema = z.object({ error: z.string() });

export default async function transcribeRoute(app: FastifyInstance) {
  // Built once at registration so bad provider config fails at boot. Which
  // implementation comes back is not this route's business.
  const transcriber = createTranscriptionProvider();

  app.post(
    '/transcribe',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['transcribe'],
        summary: 'Transcribe audio (multipart/form-data)',
        description:
          'Accepts a single audio file under any field name plus an optional `language` text field. ' +
          'Uses the configured transcription provider (OpenAI Whisper by default). ' +
          'Body is multipart/form-data; OpenAPI cannot fully express this — ' +
          'send a binary `file` field and an optional `language` text field.',
        security: [{ bearerAuth: [] }],
        consumes: ['multipart/form-data'],
        response: {
          200: transcribeResponseSchema,
          400: errorSchema,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let file;
      let language: string | undefined;

      try {
        const data = await request.file();
        if (!data) {
          return reply.code(400).send({ error: 'No audio file provided' });
        }
        file = data;

        const fields = data.fields;
        if (fields['language']) {
          const langField = fields['language'] as { value?: string };
          if (langField.value) {
            language = langField.value;
          }
        }
      } catch {
        return reply.code(400).send({ error: 'No audio file provided' });
      }

      if (!transcriber.supportsMimetype(file.mimetype)) {
        return reply.code(400).send({ error: 'Unsupported audio format' });
      }

      const buffer = await file.toBuffer();
      const result = await transcriber.transcribe({
        audio: buffer,
        mimetype: file.mimetype,
        language,
      });

      return reply.code(200).send(result);
    },
  );
}
