import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';

import {
  createTranscriptionProvider,
  CustomBaseUrlTranscriptionProvider,
  CUSTOM_TRANSCRIPTION_PROVIDER_NAME,
  DEFAULT_TRANSCRIPTION_MODEL,
  NO_AUTH_PLACEHOLDER_API_KEY,
  OpenAITranscriptionProvider,
  OPENAI_TRANSCRIPTION_PROVIDER_NAME,
  TRANSCRIPTION_PROVIDER_NAMES,
} from '../../../src/services/transcription/index.js';
import type {
  FetchImplementation,
  TranscriptionProvider,
} from '../../../src/services/transcription/index.js';

type FetchArgs = Parameters<FetchImplementation>;

interface WhisperResponseBody {
  text: string;
  language?: string;
  duration?: number;
}

function jsonResponse(body: WhisperResponseBody): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createFetchMock(body: WhisperResponseBody) {
  return vi.fn((..._args: FetchArgs) => Promise.resolve(jsonResponse(body)));
}

/** Bytes that match no audio signature, so the SDK falls back to audio/wav. */
function audioBuffer(): Buffer {
  return Buffer.from([0x00, 0x01, 0x02, 0x03]);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createTranscriptionProvider', () => {
  it('defaults to the OpenAI provider when nothing is configured', () => {
    const provider = createTranscriptionProvider({});

    expect(provider).toBeInstanceOf(OpenAITranscriptionProvider);
    expect(provider.name).toBe(OPENAI_TRANSCRIPTION_PROVIDER_NAME);
  });

  it('reads process.env when no env object is supplied', () => {
    vi.stubEnv('TRANSCRIPTION_PROVIDER', 'custom');
    vi.stubEnv('TRANSCRIPTION_BASE_URL', 'http://localhost:8000/v1');

    expect(createTranscriptionProvider()).toBeInstanceOf(CustomBaseUrlTranscriptionProvider);
  });

  it('treats a blank TRANSCRIPTION_PROVIDER as unset', () => {
    const provider = createTranscriptionProvider({ TRANSCRIPTION_PROVIDER: '   ' });

    expect(provider).toBeInstanceOf(OpenAITranscriptionProvider);
  });

  it('selects the OpenAI provider for "openai"', () => {
    const provider = createTranscriptionProvider({ TRANSCRIPTION_PROVIDER: 'openai' });

    expect(provider).toBeInstanceOf(OpenAITranscriptionProvider);
  });

  it('selects the custom provider for "custom"', () => {
    const provider = createTranscriptionProvider({
      TRANSCRIPTION_PROVIDER: 'custom',
      TRANSCRIPTION_BASE_URL: 'https://whisper.internal/v1',
    });

    expect(provider).toBeInstanceOf(CustomBaseUrlTranscriptionProvider);
    expect(provider.name).toBe(CUSTOM_TRANSCRIPTION_PROVIDER_NAME);
  });

  it('accepts provider names case-insensitively and trims whitespace', () => {
    const provider = createTranscriptionProvider({
      TRANSCRIPTION_PROVIDER: '  CUSTOM ',
      TRANSCRIPTION_BASE_URL: 'https://whisper.internal/v1',
    });

    expect(provider).toBeInstanceOf(CustomBaseUrlTranscriptionProvider);
  });

  it('throws on an unknown provider name and names the supported ones', () => {
    expect(() => createTranscriptionProvider({ TRANSCRIPTION_PROVIDER: 'deepgram' })).toThrow(
      /Unknown TRANSCRIPTION_PROVIDER "deepgram"/,
    );
    expect(() => createTranscriptionProvider({ TRANSCRIPTION_PROVIDER: 'deepgram' })).toThrow(
      new RegExp(TRANSCRIPTION_PROVIDER_NAMES.join(', ')),
    );
  });

  it('throws when the custom provider has no base URL', () => {
    expect(() => createTranscriptionProvider({ TRANSCRIPTION_PROVIDER: 'custom' })).toThrow(
      /TRANSCRIPTION_BASE_URL is required/,
    );
  });

  it('throws when the custom base URL is unparseable', () => {
    expect(() =>
      createTranscriptionProvider({
        TRANSCRIPTION_PROVIDER: 'custom',
        TRANSCRIPTION_BASE_URL: 'not a url',
      }),
    ).toThrow(/must be a valid URL/);
  });

  it('throws when the custom base URL has no http(s) scheme', () => {
    expect(() =>
      createTranscriptionProvider({
        TRANSCRIPTION_PROVIDER: 'custom',
        TRANSCRIPTION_BASE_URL: 'localhost:8000',
      }),
    ).toThrow(/must be an http\(s\) URL/);
  });

  it('defaults both providers to whisper-1', () => {
    const openai = createTranscriptionProvider({}) as OpenAITranscriptionProvider;
    const custom = createTranscriptionProvider({
      TRANSCRIPTION_PROVIDER: 'custom',
      TRANSCRIPTION_BASE_URL: 'https://whisper.internal/v1',
    }) as CustomBaseUrlTranscriptionProvider;

    expect(openai.model).toBe(DEFAULT_TRANSCRIPTION_MODEL);
    expect(openai.model).toBe('whisper-1');
    expect(custom.model).toBe('whisper-1');
  });

  it('applies TRANSCRIPTION_MODEL to the selected provider', () => {
    const provider = createTranscriptionProvider({
      TRANSCRIPTION_MODEL: 'gpt-4o-transcribe',
    }) as OpenAITranscriptionProvider;

    expect(provider.model).toBe('gpt-4o-transcribe');
  });

  it('leaves the default provider without a base URL override', () => {
    const provider = createTranscriptionProvider({}) as OpenAITranscriptionProvider;

    expect(provider.baseUrl).toBeUndefined();
  });
});

describe('TranscriptionProvider conformance', () => {
  const providers: Array<[string, TranscriptionProvider]> = [
    ['openai', new OpenAITranscriptionProvider()],
    ['custom', new CustomBaseUrlTranscriptionProvider({ baseUrl: 'https://whisper.internal/v1' })],
  ];

  for (const [label, provider] of providers) {
    it(`${label} exposes the full provider contract`, () => {
      expect(typeof provider.name).toBe('string');
      expect(provider.name.length).toBeGreaterThan(0);
      expect(typeof provider.supportsMimetype).toBe('function');
      expect(typeof provider.transcribe).toBe('function');
    });

    it(`${label} accepts the supported upload formats`, () => {
      expect(provider.supportsMimetype('audio/wav')).toBe(true);
      expect(provider.supportsMimetype('audio/mpeg')).toBe(true);
      expect(provider.supportsMimetype('audio/m4a')).toBe(true);
      expect(provider.supportsMimetype('audio/webm')).toBe(true);
    });

    it(`${label} rejects unsupported upload formats`, () => {
      expect(provider.supportsMimetype('text/plain')).toBe(false);
      expect(provider.supportsMimetype('application/pdf')).toBe(false);
    });
  }

  it('gives the two implementations distinct provider ids', () => {
    expect(OPENAI_TRANSCRIPTION_PROVIDER_NAME).not.toBe(CUSTOM_TRANSCRIPTION_PROVIDER_NAME);
  });
});

describe('POST /transcribe wiring', () => {
  it('refuses to register with an unknown provider configured', async () => {
    vi.stubEnv('TRANSCRIPTION_PROVIDER', 'deepgram');

    const { default: transcribeRoute } = await import('../../../src/routes/transcribe.js');
    const app = Fastify({ logger: false });
    void app.register(transcribeRoute);

    await expect(app.ready()).rejects.toThrow(/Unknown TRANSCRIPTION_PROVIDER "deepgram"/);
    await app.close();
  });

  it('refuses to register when the custom provider has no base URL', async () => {
    vi.stubEnv('TRANSCRIPTION_PROVIDER', 'custom');
    vi.stubEnv('TRANSCRIPTION_BASE_URL', undefined);

    const { default: transcribeRoute } = await import('../../../src/routes/transcribe.js');
    const app = Fastify({ logger: false });
    void app.register(transcribeRoute);

    await expect(app.ready()).rejects.toThrow(/TRANSCRIPTION_BASE_URL is required/);
    await app.close();
  });
});

describe('OpenAITranscriptionProvider', () => {
  it('reports the historical provider id', () => {
    expect(new OpenAITranscriptionProvider().name).toBe('openai-whisper');
  });

  it('throws the historical error when no platform key is configured', async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    vi.stubEnv('BILLING_BYPASS', undefined);

    await expect(
      new OpenAITranscriptionProvider().transcribe({
        audio: audioBuffer(),
        mimetype: 'audio/wav',
      }),
    ).rejects.toThrow('OPENAI_API_KEY environment variable is required for transcription');
  });

  it('posts to api.openai.com when no base URL is configured', async () => {
    vi.stubEnv('OPENAI_BASE_URL', undefined);

    const fetchMock = createFetchMock({ text: 'hello' });
    const provider = new OpenAITranscriptionProvider({
      apiKey: 'sk-test-key',
      fetch: fetchMock,
    });

    await provider.transcribe({ audio: audioBuffer(), mimetype: 'audio/wav' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/audio/transcriptions');
  });
});

describe('CustomBaseUrlTranscriptionProvider', () => {
  it('requires a base URL', () => {
    expect(() => new CustomBaseUrlTranscriptionProvider({ baseUrl: '' })).toThrow(
      /base URL is required/,
    );
  });

  it('posts to the configured base URL', async () => {
    const fetchMock = createFetchMock({ text: 'hi' });
    const provider = new CustomBaseUrlTranscriptionProvider({
      baseUrl: 'http://whisper.local:9000/v1',
      apiKey: 'local-key',
      fetch: fetchMock,
    });

    await provider.transcribe({ audio: audioBuffer(), mimetype: 'audio/wav' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://whisper.local:9000/v1/audio/transcriptions');
  });

  it('does not double up the slash when the base URL has a trailing one', async () => {
    const fetchMock = createFetchMock({ text: 'hi' });
    const provider = new CustomBaseUrlTranscriptionProvider({
      baseUrl: 'http://whisper.local:9000/v1/',
      apiKey: 'local-key',
      fetch: fetchMock,
    });

    await provider.transcribe({ audio: audioBuffer(), mimetype: 'audio/wav' });

    expect(fetchMock.mock.calls[0][0]).toBe('http://whisper.local:9000/v1/audio/transcriptions');
  });

  it('sends the configured key as a bearer token and the configured model', async () => {
    const fetchMock = createFetchMock({ text: 'hi' });
    const provider = new CustomBaseUrlTranscriptionProvider({
      baseUrl: 'http://whisper.local:9000/v1',
      apiKey: 'local-key',
      model: 'faster-whisper-large-v3',
      fetch: fetchMock,
    });

    await provider.transcribe({ audio: audioBuffer(), mimetype: 'audio/wav' });

    const init = fetchMock.mock.calls[0][1];
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer local-key');

    const body = init?.body as FormData;
    expect(body.get('model')).toBe('faster-whisper-large-v3');
  });

  it('forwards the requested language to the endpoint', async () => {
    const fetchMock = createFetchMock({ text: 'hola', language: 'spanish', duration: 2 });
    const provider = new CustomBaseUrlTranscriptionProvider({
      baseUrl: 'http://whisper.local:9000/v1',
      apiKey: 'local-key',
      fetch: fetchMock,
    });

    await provider.transcribe({ audio: audioBuffer(), mimetype: 'audio/wav', language: 'es' });

    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body.get('language')).toBe('es');
  });

  it('maps the endpoint response onto the shared result shape', async () => {
    const fetchMock = createFetchMock({ text: 'hola mundo', language: 'spanish', duration: 3.5 });
    const provider = new CustomBaseUrlTranscriptionProvider({
      baseUrl: 'http://whisper.local:9000/v1',
      apiKey: 'local-key',
      fetch: fetchMock,
    });

    const result = await provider.transcribe({
      audio: audioBuffer(),
      mimetype: 'audio/wav',
    });

    // "spanish" is normalised to the ISO code by the OpenAI-compatible layer.
    expect(result).toEqual({
      text: 'hola mundo',
      language: 'es',
      duration: 3.5,
      provider: CUSTOM_TRANSCRIPTION_PROVIDER_NAME,
    });
  });

  it('falls back to en and 0 when the endpoint omits language and duration', async () => {
    const fetchMock = createFetchMock({ text: 'bare response' });
    const provider = new CustomBaseUrlTranscriptionProvider({
      baseUrl: 'http://whisper.local:9000/v1',
      apiKey: 'local-key',
      fetch: fetchMock,
    });

    const result = await provider.transcribe({ audio: audioBuffer(), mimetype: 'audio/wav' });

    expect(result.language).toBe('en');
    expect(result.duration).toBe(0);
  });

  it('uses the no-auth placeholder when no key is configured anywhere', async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    vi.stubEnv('BILLING_BYPASS', undefined);

    const fetchMock = createFetchMock({ text: 'hi' });
    const provider = new CustomBaseUrlTranscriptionProvider({
      baseUrl: 'http://whisper.local:9000/v1',
      fetch: fetchMock,
    });

    await provider.transcribe({ audio: audioBuffer(), mimetype: 'audio/wav' });

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${NO_AUTH_PLACEHOLDER_API_KEY}`);
  });
});
