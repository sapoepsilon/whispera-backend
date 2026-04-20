import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { TranscriptionService } from '../services/transcription/index.js';

export default async function transcribeRoute(app: FastifyInstance) {
  const transcriptionService = new TranscriptionService();

  app.post(
    '/transcribe',
    { preHandler: [app.authenticate] },
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

      if (!transcriptionService.isSupportedMimetype(file.mimetype)) {
        return reply.code(400).send({ error: 'Unsupported audio format' });
      }

      const buffer = await file.toBuffer();
      const result = await transcriptionService.transcribe(
        buffer,
        file.mimetype,
        language,
      );

      return reply.code(200).send(result);
    },
  );
}
