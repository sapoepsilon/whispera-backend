import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  CUSTOM_TRANSCRIPTION_PROVIDER_NAME,
  OPENAI_REALTIME_PROVIDER_NAME,
  OPENAI_TRANSCRIPTION_PROVIDER_NAME,
  OpenAIRealtimeTranscriptionProvider,
  REALTIME_AUDIO_FORMAT,
  TranscriptionServerRegistry,
  readTranscriptionServers,
  sanitiseCloseCode,
  toWebSocketUrl,
} from '../../../src/services/transcription/index.js';
import type {
  RealtimeFrame,
  RealtimeSessionListeners,
  RealtimeTranscriptionSession,
} from '../../../src/services/transcription/index.js';
import { startFakeRealtimeServer, waitFor, type FakeRealtimeServer } from '../../fake-realtime-server.js';

const teardown: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (teardown.length > 0) await teardown.pop()?.();
  vi.unstubAllEnvs();
});

async function fakeServer(
  ...args: Parameters<typeof startFakeRealtimeServer>
): Promise<FakeRealtimeServer> {
  const server = await startFakeRealtimeServer(...args);
  teardown.push(() => server.close());
  return server;
}

function collector() {
  const frames: RealtimeFrame[] = [];
  const errors: Error[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const listeners: RealtimeSessionListeners = {
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
    onClose: (code, reason) => closes.push({ code, reason }),
  };
  return { frames, errors, closes, listeners };
}

function connectTo(server: FakeRealtimeServer, model = 'whisper-1') {
  const provider = new OpenAIRealtimeTranscriptionProvider({
    baseUrl: server.baseUrl,
    realtimePath: '/realtime',
    apiKey: 'test-key',
  });
  const sink = collector();
  return { provider, sink, connect: () => provider.connect({ model }, sink.listeners) };
}

describe('toWebSocketUrl', () => {
  it('joins the realtime path without a trailing slash and switches scheme', () => {
    // The live speaches server answers HTTP 500 on the slashed form, so this is
    // load-bearing, not cosmetic.
    expect(toWebSocketUrl('http://192.168.50.140:8000/v1', '/realtime').toString()).toBe(
      'ws://192.168.50.140:8000/v1/realtime',
    );
  });

  it('upgrades https to wss', () => {
    expect(toWebSocketUrl('https://api.openai.com/v1', '/realtime').protocol).toBe('wss:');
  });

  it('tolerates a base URL or path given without the separator', () => {
    expect(toWebSocketUrl('http://host/v1/', 'realtime').toString()).toBe('ws://host/v1/realtime');
  });
});

describe('sanitiseCloseCode', () => {
  it('passes through codes a server may put on the wire', () => {
    expect(sanitiseCloseCode(1000)).toBe(1000);
    expect(sanitiseCloseCode(1011)).toBe(1011);
    expect(sanitiseCloseCode(4404)).toBe(4404);
  });

  it('rewrites the codes that may never be sent', () => {
    // 1006 is what an engine that vanishes hands us; sending it is a protocol
    // error that would kill the client connection uncleanly.
    expect(sanitiseCloseCode(1006)).toBe(1011);
    expect(sanitiseCloseCode(1005)).toBe(1011);
    expect(sanitiseCloseCode(0)).toBe(1011);
  });
});

describe('OpenAIRealtimeTranscriptionProvider', () => {
  it('dials the unslashed realtime path and forwards the model', async () => {
    const server = await fakeServer();
    const { connect } = connectTo(server, 'Systran/faster-distil-whisper-large-v3');

    const session = await connect();
    teardown.push(() => session.close());

    expect(server.paths[0]).toBe(
      '/v1/realtime?model=Systran%2Ffaster-distil-whisper-large-v3',
    );
    expect(session.provider).toBe(OPENAI_REALTIME_PROVIDER_NAME);
    expect(session.open).toBe(true);
  });

  it('sends the configured key as a bearer token', async () => {
    const server = await fakeServer();
    const { connect } = connectTo(server);

    const session = await connect();
    teardown.push(() => session.close());

    expect(server.authHeaders[0]).toBe('Bearer test-key');
  });

  it('forwards extra query parameters but never the ones the proxy owns', async () => {
    const server = await fakeServer();
    const provider = new OpenAIRealtimeTranscriptionProvider({
      baseUrl: server.baseUrl,
      realtimePath: '/realtime',
    });

    const url = provider.buildUrl({
      model: 'whisper-1',
      query: { language: 'en', model: 'hijacked', server: 'hijacked' },
    });

    expect(url.searchParams.get('language')).toBe('en');
    expect(url.searchParams.get('model')).toBe('whisper-1');
    expect(url.searchParams.get('server')).toBeNull();
  });

  it('delivers engine frames to the listener as text', async () => {
    const server = await fakeServer();
    const { sink, connect } = connectTo(server);

    const session = await connect();
    teardown.push(() => session.close());

    await waitFor(() => sink.frames.length >= 1, 5_000, 'session.created');
    expect(sink.frames[0].isBinary).toBe(false);
    expect(JSON.parse(String(sink.frames[0].data)).type).toBe('session.created');
  });

  it('carries a client frame upstream and the reply back', async () => {
    const server = await fakeServer();
    const { sink, connect } = connectTo(server);

    const session = await connect();
    teardown.push(() => session.close());

    session.send({ data: JSON.stringify({ type: 'session.update' }), isBinary: false });

    await waitFor(() => sink.frames.some((f) => String(f.data).includes('session.updated')));
    expect(server.received[0]).toContain('session.update');
  });

  it('rejects when the engine refuses the upgrade', async () => {
    const server = await fakeServer({ refuseWithStatus: 503 });
    const { connect } = connectTo(server);

    await expect(connect()).rejects.toThrow(/refused the WebSocket upgrade with HTTP 503/);
  });

  it('rejects when the engine is not listening at all', async () => {
    const provider = new OpenAIRealtimeTranscriptionProvider({
      // Port 1 is reserved and never listening.
      baseUrl: 'http://127.0.0.1:1/v1',
      realtimePath: '/realtime',
    });

    await expect(provider.connect({ model: 'whisper-1' }, collector().listeners)).rejects.toThrow();
  });

  it('reports an engine that drops mid-session through onClose', async () => {
    const server = await fakeServer();
    const { sink, connect } = connectTo(server);

    const session = await connect();
    teardown.push(() => session.close());

    await waitFor(() => server.sockets.length === 1);
    server.dropAll(1011, 'engine went away');

    await waitFor(() => sink.closes.length === 1, 5_000, 'engine close');
    expect(sink.closes[0].code).toBe(1011);
    expect(session.open).toBe(false);
  });

  it('refuses to be constructed without a base URL', () => {
    expect(
      () => new OpenAIRealtimeTranscriptionProvider({ baseUrl: '', realtimePath: '/realtime' }),
    ).toThrow(/base URL is required/);
  });
});

describe('TranscriptionServerRegistry', () => {
  const configs = () =>
    readTranscriptionServers({
      TRANSCRIPTION_SERVERS: JSON.stringify([
        {
          id: 'speaches-lan',
          label: 'Speaches (LAN)',
          baseUrl: 'http://192.168.50.140:8000/v1',
          model: 'Systran/faster-distil-whisper-large-v3',
          capabilities: ['batch', 'realtime'],
        },
        { id: 'cloud', label: 'OpenAI', capabilities: ['batch'] },
      ]),
    });

  function registryWith(fetchImpl: typeof globalThis.fetch) {
    return new TranscriptionServerRegistry(configs(), { fetch: fetchImpl, probeCacheMs: 10_000 });
  }

  // Typed with fetch's own parameters so the recorded calls can be asserted on.
  const okFetch = () =>
    vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
      new Response('{}', { status: 200 }),
    );

  it('hands out the batch provider matching each server shape', () => {
    const registry = registryWith(okFetch());

    expect(registry.batchProvider('speaches-lan').name).toBe(CUSTOM_TRANSCRIPTION_PROVIDER_NAME);
    expect(registry.batchProvider('cloud').name).toBe(OPENAI_TRANSCRIPTION_PROVIDER_NAME);
  });

  it('memoises providers so a session never rebuilds a client', () => {
    const registry = registryWith(okFetch());

    expect(registry.batchProvider('cloud')).toBe(registry.batchProvider('cloud'));
    expect(registry.realtimeProvider('speaches-lan')).toBe(registry.realtimeProvider('speaches-lan'));
  });

  it('refuses a realtime provider for a batch-only server', () => {
    const registry = registryWith(okFetch());

    expect(() => registry.realtimeProvider('cloud')).toThrow(/does not support realtime/);
    expect(registry.supports('cloud', 'realtime')).toBe(false);
    expect(registry.supports('speaches-lan', 'realtime')).toBe(true);
  });

  it('refuses an unknown server id', () => {
    expect(() => registryWith(okFetch()).batchProvider('nope')).toThrow(
      /Unknown transcription server "nope"/,
    );
  });

  it('treats the first configured server as the default', () => {
    expect(registryWith(okFetch()).defaultServer.id).toBe('speaches-lan');
  });

  it('describes a reachable server as online, with realtime details', async () => {
    const registry = registryWith(okFetch());
    const [speaches] = await registry.describe();

    expect(speaches.status).toBe('online');
    expect(speaches.detail).toBeNull();
    expect(speaches.default).toBe(true);
    expect(speaches.capabilities).toEqual(['batch', 'realtime']);
    expect(speaches.realtime).toEqual({
      protocol: OPENAI_REALTIME_PROVIDER_NAME,
      path: '/transcription/stream?server=speaches-lan',
      audio: REALTIME_AUDIO_FORMAT,
    });
  });

  it('reports an unreachable server rather than hiding it', async () => {
    const registry = registryWith(vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const [speaches] = await registry.describe();

    expect(speaches.id).toBe('speaches-lan');
    expect(speaches.status).toBe('offline');
    expect(speaches.detail).toContain('ECONNREFUSED');
  });

  it('reports a non-2xx probe as offline with the status code', async () => {
    const registry = registryWith(vi.fn(async () => new Response('nope', { status: 502 })));
    const [speaches] = await registry.describe();

    expect(speaches.status).toBe('offline');
    expect(speaches.detail).toContain('502');
  });

  it('admits ignorance for the stock OpenAI entry rather than guessing', async () => {
    const registry = registryWith(okFetch());
    const [, cloud] = await registry.describe();

    expect(cloud.status).toBe('unknown');
    expect(cloud.realtime).toBeNull();
    expect(cloud.batchProvider).toBe(OPENAI_TRANSCRIPTION_PROVIDER_NAME);
  });

  it('caches probes so discovery does not hammer the engine', async () => {
    const fetchImpl = okFetch();
    const registry = registryWith(fetchImpl);

    await registry.describe();
    await registry.describe();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('probes the OpenAI-compatible /models path with the configured key', async () => {
    const fetchImpl = okFetch();
    await registryWith(fetchImpl).describe();

    expect(fetchImpl.mock.calls[0][0]).toBe('http://192.168.50.140:8000/v1/models');
  });

  it('never exposes a base URL or a key in the client-facing view', async () => {
    const registry = new TranscriptionServerRegistry(
      readTranscriptionServers({
        TRANSCRIPTION_SERVERS: JSON.stringify([
          { id: 'secret', baseUrl: 'http://internal:8000/v1', apiKey: 'sk-super-secret' },
        ]),
      }),
      { fetch: okFetch() },
    );

    const serialised = JSON.stringify(await registry.describe());

    expect(serialised).not.toContain('sk-super-secret');
    expect(serialised).not.toContain('internal:8000');
  });
});

describe('the batch interface is untouched by the realtime sibling', () => {
  it('still satisfies TranscriptionProvider exactly', () => {
    const registry = new TranscriptionServerRegistry(
      readTranscriptionServers({ TRANSCRIPTION_SERVERS: '[{"id":"x"}]' }),
    );
    const provider = registry.batchProvider('x');

    expect(typeof provider.name).toBe('string');
    expect(provider.supportsMimetype('audio/wav')).toBe(true);
    expect(provider.supportsMimetype('text/plain')).toBe(false);
    expect(typeof provider.transcribe).toBe('function');
    // The realtime session shape is deliberately absent from the batch contract.
    expect((provider as unknown as RealtimeTranscriptionSession).send).toBeUndefined();
  });
});
