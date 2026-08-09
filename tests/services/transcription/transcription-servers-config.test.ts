import { describe, it, expect } from 'vitest';

import {
  DEFAULT_REALTIME_PATH,
  DEFAULT_SERVER_ID,
  DEFAULT_TRANSCRIPTION_MODEL,
  OPENAI_DEFAULT_BASE_URL,
  hasCapability,
  readTranscriptionServers,
  resolveBaseUrl,
} from '../../../src/services/transcription/index.js';

const SPEACHES = {
  id: 'speaches-lan',
  label: 'Speaches (LAN)',
  baseUrl: 'http://192.168.50.140:8000/v1',
  model: 'Systran/faster-distil-whisper-large-v3',
  capabilities: ['batch', 'realtime'],
};

function servers(entries: unknown[]): { TRANSCRIPTION_SERVERS: string } {
  return { TRANSCRIPTION_SERVERS: JSON.stringify(entries) };
}

describe('readTranscriptionServers — single-server fallback', () => {
  it('synthesises one OpenAI entry when nothing is configured', () => {
    const [only, ...rest] = readTranscriptionServers({});

    expect(rest).toHaveLength(0);
    expect(only.id).toBe(DEFAULT_SERVER_ID);
    expect(only.model).toBe(DEFAULT_TRANSCRIPTION_MODEL);
    expect(only.baseUrl).toBeUndefined();
    // Nothing in the legacy env says an endpoint speaks the Realtime API, so
    // advertising it would make the discovery route lie.
    expect(only.capabilities).toEqual(['batch']);
  });

  it('carries the legacy custom-endpoint vars through unchanged', () => {
    const [only] = readTranscriptionServers({
      TRANSCRIPTION_PROVIDER: 'custom',
      TRANSCRIPTION_BASE_URL: 'http://localhost:8000/v1',
      TRANSCRIPTION_MODEL: 'faster-whisper-large-v3',
      TRANSCRIPTION_API_KEY: 'legacy-key',
    });

    expect(only.baseUrl).toBe('http://localhost:8000/v1');
    expect(only.model).toBe('faster-whisper-large-v3');
    expect(only.apiKey).toBe('legacy-key');
    expect(only.capabilities).toEqual(['batch']);
  });

  it('still refuses a custom provider with no base URL', () => {
    expect(() => readTranscriptionServers({ TRANSCRIPTION_PROVIDER: 'custom' })).toThrow(
      /TRANSCRIPTION_BASE_URL is required/,
    );
  });

  it('rejects a legacy base URL that is not http(s)', () => {
    expect(() =>
      readTranscriptionServers({
        TRANSCRIPTION_PROVIDER: 'custom',
        TRANSCRIPTION_BASE_URL: 'localhost:8000',
      }),
    ).toThrow(/must be an http\(s\) URL/);
  });
});

describe('readTranscriptionServers — TRANSCRIPTION_SERVERS', () => {
  it('reads the multi-server list from the brief verbatim', () => {
    const [speaches] = readTranscriptionServers(servers([SPEACHES]));

    expect(speaches.id).toBe('speaches-lan');
    expect(speaches.label).toBe('Speaches (LAN)');
    expect(speaches.baseUrl).toBe('http://192.168.50.140:8000/v1');
    expect(speaches.model).toBe('Systran/faster-distil-whisper-large-v3');
    expect(hasCapability(speaches, 'batch')).toBe(true);
    expect(hasCapability(speaches, 'realtime')).toBe(true);
  });

  it('keeps several servers in declaration order', () => {
    const parsed = readTranscriptionServers(
      servers([SPEACHES, { id: 'cloud', capabilities: ['batch'] }]),
    );

    expect(parsed.map((s) => s.id)).toEqual(['speaches-lan', 'cloud']);
  });

  it('defaults label, model, capabilities and realtime path', () => {
    const [minimal] = readTranscriptionServers(servers([{ id: 'bare' }]));

    expect(minimal.label).toBe('bare');
    expect(minimal.model).toBe(DEFAULT_TRANSCRIPTION_MODEL);
    expect(minimal.capabilities).toEqual(['batch']);
    expect(minimal.realtimePath).toBe(DEFAULT_REALTIME_PATH);
  });

  it('strips a trailing slash from the base URL so paths join cleanly', () => {
    const [trailing] = readTranscriptionServers(
      servers([{ id: 'x', baseUrl: 'http://host:8000/v1/' }]),
    );

    expect(trailing.baseUrl).toBe('http://host:8000/v1');
  });

  it('lets a server override the realtime path', () => {
    const [odd] = readTranscriptionServers(
      servers([{ id: 'x', realtimePath: '/realtime/', capabilities: ['realtime'] }]),
    );

    expect(odd.realtimePath).toBe('/realtime/');
  });
});

describe('readTranscriptionServers — failing fast', () => {
  it('rejects JSON that does not parse', () => {
    expect(() => readTranscriptionServers({ TRANSCRIPTION_SERVERS: '{not json' })).toThrow(
      /must be a JSON array/,
    );
  });

  it('rejects a list with no entries', () => {
    expect(() => readTranscriptionServers(servers([]))).toThrow(/not a valid server list/);
  });

  it('rejects an entry with no id', () => {
    expect(() => readTranscriptionServers(servers([{ label: 'nameless' }]))).toThrow(
      /not a valid server list/,
    );
  });

  it('rejects an unknown capability', () => {
    expect(() =>
      readTranscriptionServers(servers([{ id: 'x', capabilities: ['telepathy'] }])),
    ).toThrow(/not a valid server list/);
  });

  it('names the offending server when its base URL does not parse', () => {
    expect(() =>
      readTranscriptionServers(servers([{ id: 'speaches-lan', baseUrl: '192.168.50.140:8000' }])),
    ).toThrow(/TRANSCRIPTION_SERVERS\[speaches-lan\]\.baseUrl must be a valid URL/);
  });

  it('names the offending server when its base URL is not http(s)', () => {
    // new URL() reads "localhost:8000" as a custom scheme rather than failing,
    // which would silently produce an unreachable endpoint.
    expect(() =>
      readTranscriptionServers(servers([{ id: 'speaches-lan', baseUrl: 'localhost:8000' }])),
    ).toThrow(/TRANSCRIPTION_SERVERS\[speaches-lan\]\.baseUrl must be an http\(s\) URL/);
  });

  it('rejects duplicate ids rather than silently shadowing one', () => {
    expect(() => readTranscriptionServers(servers([{ id: 'dup' }, { id: 'dup' }]))).toThrow(
      /duplicate server id "dup"/,
    );
  });

  it('rejects an unknown field, so a typo is not silently ignored', () => {
    expect(() => readTranscriptionServers(servers([{ id: 'x', bseUrl: 'http://h/v1' }]))).toThrow(
      /not a valid server list/,
    );
  });
});

describe('resolveBaseUrl', () => {
  it('uses the server base URL when it has one', () => {
    const [speaches] = readTranscriptionServers(servers([SPEACHES]));
    expect(resolveBaseUrl(speaches, {})).toBe('http://192.168.50.140:8000/v1');
  });

  it('falls back to OPENAI_BASE_URL, then to the public OpenAI endpoint', () => {
    const [bare] = readTranscriptionServers(servers([{ id: 'bare' }]));

    expect(resolveBaseUrl(bare, { OPENAI_BASE_URL: 'http://proxy/v1' })).toBe('http://proxy/v1');
    expect(resolveBaseUrl(bare, {})).toBe(OPENAI_DEFAULT_BASE_URL);
  });
});
