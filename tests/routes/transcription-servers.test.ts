import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildTestApp, registerAndGetToken, authHeader } from '../helpers.js';
import { startFakeRealtimeServer, type FakeRealtimeServer } from '../fake-realtime-server.js';

interface ServerSummary {
  id: string;
  label: string;
  model: string;
  capabilities: string[];
  default: boolean;
  status: string;
  detail: string | null;
  batchProvider: string | null;
  realtime: { protocol: string; path: string; audio: Record<string, unknown> } | null;
}

let app: FastifyInstance;
let token: string;
let engine: FakeRealtimeServer;
const previousServers = process.env.TRANSCRIPTION_SERVERS;

beforeAll(async () => {
  // A real listening HTTP server, so the liveness probe has something honest to
  // talk to. Its /v1/models 404s (it only handles upgrades), which is exactly
  // what an "offline" report should look like.
  engine = await startFakeRealtimeServer();

  process.env.TRANSCRIPTION_SERVERS = JSON.stringify([
    {
      id: 'speaches-lan',
      label: 'Speaches (LAN)',
      baseUrl: engine.baseUrl,
      apiKey: 'super-secret-key',
      model: 'Systran/faster-distil-whisper-large-v3',
      capabilities: ['batch', 'realtime'],
    },
    { id: 'cloud', label: 'OpenAI Whisper', capabilities: ['batch'] },
    {
      id: 'dead',
      label: 'Unplugged box',
      baseUrl: 'http://127.0.0.1:1/v1',
      capabilities: ['batch', 'realtime'],
    },
  ]);

  // Read at route registration, so it must be set before the app is built.
  app = await buildTestApp();
  token = (await registerAndGetToken(app)).accessToken;
});

afterAll(async () => {
  await app?.close();
  await engine?.close();
  if (previousServers === undefined) delete process.env.TRANSCRIPTION_SERVERS;
  else process.env.TRANSCRIPTION_SERVERS = previousServers;
});

async function listServers(): Promise<ServerSummary[]> {
  const res = await app.inject({
    method: 'GET',
    url: '/transcription/servers',
    headers: authHeader(token),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { servers: ServerSummary[] }).servers;
}

describe('GET /transcription/servers', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/transcription/servers' });
    expect(res.statusCode).toBe(401);
  });

  it('returns every configured server, in order', async () => {
    const servers = await listServers();
    expect(servers.map((s) => s.id)).toEqual(['speaches-lan', 'cloud', 'dead']);
  });

  it('advertises realtime for speaches, with the stream path and audio format', async () => {
    const [speaches] = await listServers();

    expect(speaches.capabilities).toContain('realtime');
    expect(speaches.realtime).not.toBeNull();
    expect(speaches.realtime?.path).toBe('/transcription/stream?server=speaches-lan');
    expect(speaches.realtime?.audio).toEqual({
      encoding: 'pcm16',
      // speaches decodes the append payload at 24 kHz; 16 kHz silently
      // time-compresses the audio instead of failing.
      sampleRate: 24_000,
      channels: 1,
      transport: 'base64-json',
    });
  });

  it('marks the first server as the default', async () => {
    const servers = await listServers();

    expect(servers.filter((s) => s.default).map((s) => s.id)).toEqual(['speaches-lan']);
  });

  it('reports a batch-only server with no realtime block', async () => {
    const cloud = (await listServers()).find((s) => s.id === 'cloud');

    expect(cloud?.capabilities).toEqual(['batch']);
    expect(cloud?.realtime).toBeNull();
    expect(cloud?.batchProvider).toBe('openai-whisper');
  });

  it('keeps an unreachable server in the list and says why', async () => {
    const dead = (await listServers()).find((s) => s.id === 'dead');

    expect(dead).toBeDefined();
    expect(dead?.status).toBe('offline');
    expect(dead?.detail).toBeTruthy();
  });

  it('admits it cannot probe the stock OpenAI endpoint', async () => {
    const cloud = (await listServers()).find((s) => s.id === 'cloud');

    expect(cloud?.status).toBe('unknown');
    expect(cloud?.detail).toContain('not probed');
  });

  it('never leaks a base URL or an API key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/transcription/servers',
      headers: authHeader(token),
    });

    expect(res.body).not.toContain('super-secret-key');
    expect(res.body).not.toContain(engine.baseUrl);
    expect(res.body).not.toContain('apiKey');
    expect(res.body).not.toContain('baseUrl');
  });
});

describe('POST /transcribe is unaffected by the multi-server config', () => {
  it('still rejects an unsupported upload the same way', async () => {
    const boundary = '----FormBoundaryStill';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\nhi\r\n--${boundary}--\r\n`,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/transcribe',
      headers: { ...authHeader(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Unsupported');
  });
});
