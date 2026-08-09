import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

import { buildTestApp, registerAndGetToken } from '../helpers.js';
import {
  startFakeRealtimeServer,
  waitFor,
  type FakeRealtimeServer,
} from '../fake-realtime-server.js';

/**
 * The proxy end to end: a real client socket, a real Fastify server listening on
 * a real port, and a real upstream WebSocket. `app.inject()` cannot express an
 * upgrade, so nothing here is mocked.
 */
let app: FastifyInstance;
let token: string;
let port: number;
let engine: FakeRealtimeServer;
const previousServers = process.env.TRANSCRIPTION_SERVERS;
const openSockets: WebSocket[] = [];

beforeAll(async () => {
  engine = await startFakeRealtimeServer();

  process.env.TRANSCRIPTION_SERVERS = JSON.stringify([
    {
      id: 'speaches-lan',
      label: 'Speaches (LAN)',
      baseUrl: engine.baseUrl,
      apiKey: 'engine-key',
      model: 'Systran/faster-distil-whisper-large-v3',
      capabilities: ['batch', 'realtime'],
    },
    { id: 'batch-only', label: 'Batch only', capabilities: ['batch'] },
    {
      id: 'unreachable',
      label: 'Unplugged',
      // Port 1 is reserved, so the upstream handshake can never succeed.
      baseUrl: 'http://127.0.0.1:1/v1',
      capabilities: ['realtime'],
    },
  ]);

  app = await buildTestApp();
  token = (await registerAndGetToken(app)).accessToken;
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('app did not bind a port');
  port = address.port;
});

afterAll(async () => {
  for (const socket of openSockets) {
    if (socket.readyState !== WebSocket.CONNECTING) socket.terminate();
  }
  await app?.close();
  await engine?.close();
  if (previousServers === undefined) delete process.env.TRANSCRIPTION_SERVERS;
  else process.env.TRANSCRIPTION_SERVERS = previousServers;
});

/**
 * A client socket that records everything from the moment it is created.
 *
 * Attaching a listener only after `open` resolves is a race: the proxy answers
 * some requests (an unknown server id, say) with an error frame written
 * immediately after the upgrade, which can arrive in the same tick and would be
 * dropped by a late listener — making the proxy look broken when it is not.
 */
interface TestClient {
  socket: WebSocket;
  frames: string[];
  /** Resolves with frame number `index` (0-based), whenever it arrived. */
  frame(index: number, timeoutMs?: number): Promise<string>;
  /** Resolves with how the socket closed, even if it closed before this call. */
  closed(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  opened(timeoutMs?: number): Promise<void>;
}

function open(query = '?server=speaches-lan'): TestClient {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/transcription/stream${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  openSockets.push(socket);

  const frames: string[] = [];
  socket.on('message', (data: Buffer) => frames.push(data.toString()));

  // Recorded rather than awaited, for the same reason as the frames: the proxy
  // can refuse and close before a test gets a chance to listen.
  let closure: { code: number; reason: string } | undefined;
  socket.once('close', (code: number, reason: Buffer) => {
    closure = { code, reason: reason.toString() };
  });

  return {
    socket,
    frames,
    async frame(index, timeoutMs = 5_000) {
      await waitFor(() => frames.length > index, timeoutMs, `frame ${index}`);
      return frames[index];
    },
    async closed(timeoutMs = 5_000) {
      await waitFor(() => closure !== undefined, timeoutMs, 'socket close');
      return closure as { code: number; reason: string };
    },
    opened(timeoutMs = 5_000) {
      if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('socket did not open in time')), timeoutMs);
        socket.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    },
  };
}

/** Resolves with the HTTP status the upgrade was refused with. */
function refusedWith(socket: WebSocket, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('upgrade was neither accepted nor refused')),
      timeoutMs,
    );
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => {
      clearTimeout(timer);
      reject(new Error('upgrade was accepted when it should have been refused'));
    });
  });
}

describe('WS /transcription/stream — authentication', () => {
  it('refuses the upgrade outright when no token is sent', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/transcription/stream?server=speaches-lan`);
    openSockets.push(socket);

    // Rejected at the HTTP handshake, so no WebSocket is ever established —
    // strictly better than accepting one and closing it afterwards.
    await expect(refusedWith(socket)).resolves.toBe(401);
  });

  it('refuses the upgrade for a bogus token', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/transcription/stream`, {
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    openSockets.push(socket);

    await expect(refusedWith(socket)).resolves.toBe(401);
  });

  it('never dials the engine for an unauthenticated client', async () => {
    const before = engine.paths.length;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/transcription/stream?server=speaches-lan`);
    openSockets.push(socket);

    await refusedWith(socket);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(engine.paths.length).toBe(before);
  });
});

describe('WS /transcription/stream — server selection', () => {
  it('closes with 4404 and an error frame for an unknown server', async () => {
    const client = open('?server=nope');

    const frame = JSON.parse(await client.frame(0));
    expect(frame.type).toBe('error');
    expect(frame.error.code).toBe('unknown_server');
    expect(frame.error.message).toContain('nope');

    await expect(client.closed()).resolves.toMatchObject({ code: 4404 });
  });

  it('closes with 4400 when the server cannot stream', async () => {
    const client = open('?server=batch-only');

    const frame = JSON.parse(await client.frame(0));
    expect(frame.error.code).toBe('realtime_not_supported');

    await expect(client.closed()).resolves.toMatchObject({ code: 4400 });
  });

  it('never dials an engine for a server that cannot stream', async () => {
    const before = engine.paths.length;
    const client = open('?server=batch-only');

    await client.closed();
    expect(engine.paths.length).toBe(before);
  });

  it('falls back to the default server when none is named', async () => {
    const before = engine.paths.length;
    const client = open('');
    await client.opened();

    await waitFor(() => engine.paths.length > before, 5_000, 'upstream dial');
    expect(engine.paths[before]).toContain('model=Systran%2Ffaster-distil-whisper-large-v3');
  });
});

describe('WS /transcription/stream — the upstream link', () => {
  it('dials the engine on the unslashed realtime path', async () => {
    const before = engine.paths.length;
    const client = open();
    await client.opened();

    await waitFor(() => engine.paths.length > before);
    // The fake engine answers HTTP 500 on the slashed form, exactly as speaches
    // does, so a regression here would surface as a failed connection too.
    expect(engine.paths[before].startsWith('/v1/realtime?')).toBe(true);
  });

  it('forwards the configured key upstream but never the client bearer token', async () => {
    const before = engine.authHeaders.length;
    const client = open();
    await client.opened();

    await waitFor(() => engine.authHeaders.length > before);
    expect(engine.authHeaders[before]).toBe('Bearer engine-key');
    expect(engine.authHeaders[before]).not.toContain(token);
  });

  it('lets the client override the model per session', async () => {
    const before = engine.paths.length;
    const client = open('?server=speaches-lan&model=tiny.en');
    await client.opened();

    await waitFor(() => engine.paths.length > before);
    expect(engine.paths[before]).toContain('model=tiny.en');
  });

  it('forwards unrecognised query parameters to the engine', async () => {
    const before = engine.paths.length;
    const client = open('?server=speaches-lan&language=en');
    await client.opened();

    await waitFor(() => engine.paths.length > before);
    expect(engine.paths[before]).toContain('language=en');
    // The proxy's own parameter must not leak into the engine's query.
    expect(engine.paths[before]).not.toContain('server=speaches-lan');
  });

  it('reports an unreachable engine with 1011 and an error frame', async () => {
    const client = open('?server=unreachable');

    const frame = JSON.parse(await client.frame(0, 15_000));
    expect(frame.type).toBe('error');
    expect(frame.error.code).toBe('upstream_unavailable');

    await expect(client.closed(15_000)).resolves.toMatchObject({ code: 1011 });
  }, 25_000);
});

describe('WS /transcription/stream — relaying frames', () => {
  it('relays the engine greeting down to the client', async () => {
    const client = open();

    expect(JSON.parse(await client.frame(0)).type).toBe('session.created');
  });

  it('relays a client frame up and the engine reply back down', async () => {
    const client = open();
    await client.frame(0); // session.created

    const before = engine.received.length;
    client.socket.send(JSON.stringify({ type: 'session.update', session: { modalities: ['text'] } }));

    expect(JSON.parse(await client.frame(1)).type).toBe('session.updated');
    expect(engine.received[before]).toContain('session.update');
  });

  it('does not lose frames sent before the upstream finished connecting', async () => {
    const client = open();
    const before = engine.received.length;

    // Sent the instant the client socket opens, which is well before the
    // upstream handshake completes. The proxy queues these rather than dropping
    // them, so they must still arrive — and in order.
    await client.opened();
    client.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'first' }));
    client.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: 'second' }));

    await waitFor(() => engine.received.length - before >= 2, 5_000, 'early frame delivery');
    expect(engine.received.slice(before, before + 2).map((raw) => JSON.parse(raw).audio)).toEqual([
      'first',
      'second',
    ]);
  });

  it('relays a burst in order', async () => {
    const client = open();
    await client.frame(0);

    const before = engine.received.length;
    for (let i = 0; i < 20; i += 1) {
      client.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: `chunk-${i}` }));
    }

    await waitFor(() => engine.received.length - before >= 20, 5_000, 'burst delivery');
    const seen = engine.received.slice(before, before + 20).map((raw) => JSON.parse(raw).audio);
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => `chunk-${i}`));
  });
});

describe('WS /transcription/stream — teardown', () => {
  it('closes the engine connection when the client drops', async () => {
    const client = open();
    await client.frame(0);
    await waitFor(() => engine.sockets.length >= 1);
    const upstreamCount = engine.sockets.length;

    client.socket.close(1000, 'done');

    // A dropped client must never leak the upstream connection.
    await waitFor(() => engine.sockets.length < upstreamCount, 5_000, 'upstream teardown');
  });

  it('closes the engine connection when the client is terminated abruptly', async () => {
    const client = open();
    await client.frame(0);
    await waitFor(() => engine.sockets.length >= 1);
    const upstreamCount = engine.sockets.length;

    client.socket.terminate();

    await waitFor(() => engine.sockets.length < upstreamCount, 5_000, 'upstream teardown');
  });

  it('closes the client when the engine drops mid-session', async () => {
    const client = open();
    await client.frame(0);
    await waitFor(() => engine.sockets.length >= 1);

    engine.dropAll(1011, 'engine went away');

    expect((await client.closed()).code).toBe(1011);
  });

  it('rewrites an unsendable engine close code instead of failing the client', async () => {
    const client = open();
    await client.frame(0);
    await waitFor(() => engine.sockets.length >= 1);

    // terminate() gives the proxy a synthetic 1006, which RFC 6455 forbids
    // putting on the wire; the client must still get a clean close.
    for (const upstream of [...engine.sockets]) upstream.terminate();

    expect((await client.closed()).code).toBe(1011);
  });
});
