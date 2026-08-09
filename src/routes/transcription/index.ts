import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';

import {
  REALTIME_AUDIO_FORMAT,
  TranscriptionServerRegistry,
} from '../../services/transcription/registry.js';
import {
  CLOSE_BAD_REQUEST,
  CLOSE_UNKNOWN_SERVER,
  CLOSE_UPSTREAM_FAILED,
  RealtimeBridge,
} from '../../services/transcription/realtime/proxy.js';
import { TRANSCRIPTION_CAPABILITIES } from '../../services/transcription/servers.js';

const realtimeAudioSchema = z.object({
  encoding: z.literal('pcm16'),
  sampleRate: z.number(),
  channels: z.number(),
  transport: z.literal('base64-json'),
});

const serverSchema = z.object({
  id: z.string(),
  label: z.string(),
  model: z.string(),
  capabilities: z.array(z.enum(TRANSCRIPTION_CAPABILITIES)),
  default: z.boolean(),
  status: z.enum(['online', 'offline', 'unknown']),
  detail: z.string().nullable(),
  batchProvider: z.string().nullable(),
  realtime: z
    .object({
      protocol: z.string(),
      path: z.string(),
      audio: realtimeAudioSchema,
    })
    .nullable(),
});

const serversResponseSchema = z.object({
  servers: z.array(serverSchema),
});

const streamQuerySchema = z.object({
  server: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
});

/** Query keys this route consumes; everything else is forwarded to the engine. */
const PROXY_OWNED_QUERY_KEYS: ReadonlySet<string> = new Set(['server', 'model']);

function forwardedQuery(request: FastifyRequest): Record<string, string> {
  const forwarded: Record<string, string> = {};
  const url = new URL(request.raw.url ?? '/', 'http://placeholder.invalid');
  for (const [key, value] of url.searchParams) {
    if (PROXY_OWNED_QUERY_KEYS.has(key)) continue;
    forwarded[key] = value;
  }
  return forwarded;
}

export default async function transcriptionRoutes(app: FastifyInstance) {
  // Built once at registration so bad server config fails at boot, exactly as
  // POST /transcribe does. Which engine backs any given id is not this route's
  // business — it only ever holds the registry's interfaces.
  const registry = TranscriptionServerRegistry.fromEnv();

  app.get(
    '/transcription/servers',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['transcribe'],
        summary: 'List the transcription servers this client may use',
        description:
          'Discovery endpoint the client calls before choosing a transcription backend. ' +
          'Reports every configured server, including unreachable ones — a silently omitted ' +
          'server is indistinguishable from one that was never configured. ' +
          'Base URLs and API keys are never returned. ' +
          'A server advertising the `realtime` capability can be streamed to over ' +
          'WS /transcription/stream using the audio format given in `realtime.audio`.',
        security: [{ bearerAuth: [] }],
        response: { 200: serversResponseSchema },
      },
    },
    async () => ({ servers: await registry.describe() }),
  );

  app.get(
    '/transcription/stream',
    {
      websocket: true,
      // Runs on the HTTP request that carries the upgrade: an unauthenticated
      // client is refused with 401 and never reaches a WebSocket at all.
      preHandler: [app.authenticate],
      schema: {
        tags: ['transcribe'],
        summary: 'Stream audio to a transcription engine (WebSocket)',
        description:
          'WebSocket endpoint, not a plain GET — send the bearer token on the upgrade request. ' +
          'Frames are relayed verbatim in both directions using the OpenAI Realtime event shape ' +
          '(`session.update`, `input_audio_buffer.append` with base64 PCM16 audio, ' +
          '`input_audio_buffer.commit`, and the transcription events the engine emits). ' +
          'Audio must match `realtime.audio` from GET /transcription/servers. ' +
          'Close codes: 4400 the server cannot stream, 4401 unauthenticated, ' +
          '4404 unknown server id, 1011 the engine failed, 1013 a peer could not keep up.',
        security: [{ bearerAuth: [] }],
        querystring: streamQuerySchema,
      },
    },
    async (socket: WebSocket, request: FastifyRequest) => {
      const query = request.query as z.infer<typeof streamQuerySchema>;
      const serverId = query.server ?? registry.defaultServer.id;
      const context = { userId: request.userId, serverId };

      // Built before the engine is dialled so a client that drops mid-handshake
      // still tears down whatever connection it triggered.
      const bridge = new RealtimeBridge(socket, { logger: app.log, context });

      const config = registry.get(serverId);
      if (!config) {
        app.log.warn(context, 'realtime stream requested for an unknown transcription server');
        bridge.fail(
          CLOSE_UNKNOWN_SERVER,
          `Unknown transcription server "${serverId}".`,
          'unknown_server',
        );
        return;
      }

      if (!registry.supports(serverId, 'realtime')) {
        bridge.fail(
          CLOSE_BAD_REQUEST,
          `Transcription server "${serverId}" does not support realtime streaming.`,
          'realtime_not_supported',
        );
        return;
      }

      try {
        const session = await registry.realtimeProvider(serverId).connect(
          {
            model: query.model ?? config.model,
            query: forwardedQuery(request),
          },
          bridge.listeners,
        );
        bridge.attach(session);
        app.log.info({ ...context, engine: session.provider }, 'realtime transcription session open');
      } catch (error) {
        app.log.error({ ...context, err: error }, 'failed to reach the transcription engine');
        bridge.fail(
          CLOSE_UPSTREAM_FAILED,
          error instanceof Error ? error.message : 'Transcription engine is unavailable.',
          'upstream_unavailable',
        );
      }
    },
  );
}

export { REALTIME_AUDIO_FORMAT };
