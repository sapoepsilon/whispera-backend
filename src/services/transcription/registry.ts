import { CustomBaseUrlTranscriptionProvider } from './providers/custom-base-url.js';
import { OpenAITranscriptionProvider } from './providers/openai.js';
import { OpenAIRealtimeTranscriptionProvider } from './realtime/openai-realtime.js';
import type { RealtimeGranularity, RealtimeTranscriptionProvider } from './realtime/types.js';
import {
  hasCapability,
  readTranscriptionServers,
  resolveBaseUrl,
  type TranscriptionCapability,
  type TranscriptionServerConfig,
  type TranscriptionServersEnv,
} from './servers.js';
import type { TranscriptionProvider } from './types.js';

/**
 * Audio a realtime client must send. speaches decodes the base64 payload of
 * `input_audio_buffer.append` as headerless PCM at 24 kHz; feeding it 16 kHz
 * makes it time-compress the audio rather than fail, so the discovery endpoint
 * states this explicitly instead of leaving the client to find out.
 */
export const REALTIME_AUDIO_FORMAT = {
  encoding: 'pcm16' as const,
  sampleRate: 24_000,
  channels: 1,
  /** Frames are base64-encoded JSON text; a raw binary frame ends the session. */
  transport: 'base64-json' as const,
};

/** Path a client opens for the streaming proxy. */
export const REALTIME_STREAM_PATH = '/transcription/stream';

/** How long a liveness result is trusted before the endpoint is probed again. */
export const PROBE_CACHE_MS = 10_000;

/** A discovery probe must never hold up the response for long. */
export const PROBE_TIMEOUT_MS = 2_000;

export type TranscriptionServerStatus = 'online' | 'offline' | 'unknown';

export interface TranscriptionServerSummary {
  id: string;
  label: string;
  model: string;
  capabilities: TranscriptionCapability[];
  /** True for the server a client should pick when it has no preference. */
  default: boolean;
  status: TranscriptionServerStatus;
  /** Why the status is not `online`. Null when there is nothing to explain. */
  detail: string | null;
  /** Provider id this server reports on batch results, or null. */
  batchProvider: string | null;
  realtime: {
    protocol: string;
    path: string;
    audio: typeof REALTIME_AUDIO_FORMAT;
    /**
     * How early this server can produce text. A client auto-choosing a server
     * should prefer `native-delta` over `synthesized-delta` over `utterance`.
     */
    granularity: RealtimeGranularity;
  } | null;
}

export interface TranscriptionRegistryDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  probeTimeoutMs?: number;
  probeCacheMs?: number;
}

interface ProbeResult {
  status: TranscriptionServerStatus;
  detail: string | null;
  at: number;
}

/**
 * Owns the configured transcription servers and hands out the right interface
 * for each capability. Routes hold this and never a concrete implementation.
 */
export class TranscriptionServerRegistry {
  private readonly configs: readonly TranscriptionServerConfig[];
  private readonly batch = new Map<string, TranscriptionProvider>();
  private readonly realtime = new Map<string, RealtimeTranscriptionProvider>();
  private readonly probes = new Map<string, ProbeResult>();
  private readonly deps: Required<TranscriptionRegistryDeps>;

  constructor(configs: readonly TranscriptionServerConfig[], deps: TranscriptionRegistryDeps = {}) {
    if (configs.length === 0) {
      throw new Error('At least one transcription server must be configured.');
    }
    this.configs = configs;
    this.deps = {
      fetch: deps.fetch ?? globalThis.fetch,
      now: deps.now ?? Date.now,
      probeTimeoutMs: deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      probeCacheMs: deps.probeCacheMs ?? PROBE_CACHE_MS,
    };
  }

  /** Built from the environment, failing fast the way the batch factory does. */
  static fromEnv(
    env: TranscriptionServersEnv = process.env,
    deps: TranscriptionRegistryDeps = {},
  ): TranscriptionServerRegistry {
    return new TranscriptionServerRegistry(readTranscriptionServers(env), deps);
  }

  list(): readonly TranscriptionServerConfig[] {
    return this.configs;
  }

  get(id: string): TranscriptionServerConfig | undefined {
    return this.configs.find((config) => config.id === id);
  }

  /** The server a client gets when it names none: the first configured entry. */
  get defaultServer(): TranscriptionServerConfig {
    return this.configs[0];
  }

  supports(id: string, capability: TranscriptionCapability): boolean {
    const config = this.get(id);
    return config !== undefined && hasCapability(config, capability);
  }

  batchProvider(id: string): TranscriptionProvider {
    const cached = this.batch.get(id);
    if (cached) return cached;

    const config = this.requireServer(id, 'batch');
    const provider = config.baseUrl
      ? new CustomBaseUrlTranscriptionProvider({
          baseUrl: config.baseUrl,
          model: config.model,
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        })
      : new OpenAITranscriptionProvider({
          model: config.model,
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        });

    this.batch.set(id, provider);
    return provider;
  }

  realtimeProvider(id: string): RealtimeTranscriptionProvider {
    const cached = this.realtime.get(id);
    if (cached) return cached;

    const config = this.requireServer(id, 'realtime');
    const provider = new OpenAIRealtimeTranscriptionProvider({
      baseUrl: resolveBaseUrl(config),
      realtimePath: config.realtimePath,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });

    this.realtime.set(id, provider);
    return provider;
  }

  /**
   * The client-facing view. Probes liveness concurrently and reports every
   * configured server, including the broken ones — a silently omitted server
   * looks to a client exactly like a server that was never configured.
   */
  async describe(): Promise<TranscriptionServerSummary[]> {
    return Promise.all(this.configs.map((config, index) => this.describeOne(config, index === 0)));
  }

  private async describeOne(
    config: TranscriptionServerConfig,
    isDefault: boolean,
  ): Promise<TranscriptionServerSummary> {
    const { status, detail } = await this.probe(config);

    return {
      id: config.id,
      label: config.label,
      model: config.model,
      capabilities: [...config.capabilities],
      default: isDefault,
      status,
      detail,
      batchProvider: hasCapability(config, 'batch') ? this.batchProvider(config.id).name : null,
      realtime: hasCapability(config, 'realtime')
        ? {
            protocol: this.realtimeProvider(config.id).name,
            path: `${REALTIME_STREAM_PATH}?server=${encodeURIComponent(config.id)}`,
            audio: REALTIME_AUDIO_FORMAT,
            granularity: resolveGranularity(config, this.realtimeProvider(config.id)),
          }
        : null,
    };
  }

  /**
   * Cheap liveness check: the OpenAI-compatible `GET /models`, short-timeout.
   *
   * Only servers with an explicit base URL are probed. The stock OpenAI entry
   * would need a live credential and a billable round trip to answer, and a
   * 401 there would read as "offline", which is worse than admitting ignorance.
   */
  private async probe(config: TranscriptionServerConfig): Promise<ProbeResult> {
    if (!config.baseUrl) {
      return {
        status: 'unknown',
        detail: 'No base URL configured; liveness of the default OpenAI endpoint is not probed.',
        at: this.deps.now(),
      };
    }

    const cached = this.probes.get(config.id);
    if (cached && this.deps.now() - cached.at < this.deps.probeCacheMs) return cached;

    const result = await this.runProbe(config);
    this.probes.set(config.id, result);
    return result;
  }

  private async runProbe(config: TranscriptionServerConfig): Promise<ProbeResult> {
    const at = this.deps.now();
    try {
      const response = await this.deps.fetch(`${config.baseUrl}/models`, {
        method: 'GET',
        headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
        signal: AbortSignal.timeout(this.deps.probeTimeoutMs),
      });

      if (!response.ok) {
        return {
          status: 'offline',
          detail: `Health probe returned HTTP ${response.status}.`,
          at,
        };
      }
      return { status: 'online', detail: null, at };
    } catch (error) {
      // The message may name the host, which is fine: this is a private,
      // authenticated endpoint and the operator needs to know what failed.
      const reason = error instanceof Error ? error.message : String(error);
      return { status: 'offline', detail: `Health probe failed: ${reason}`, at };
    }
  }

  private requireServer(id: string, capability: TranscriptionCapability): TranscriptionServerConfig {
    const config = this.get(id);
    if (!config) {
      throw new Error(`Unknown transcription server "${id}".`);
    }
    if (!hasCapability(config, capability)) {
      throw new Error(`Transcription server "${id}" does not support ${capability}.`);
    }
    return config;
  }
}

/**
 * The granularity actually reported to clients for a realtime-capable server:
 * a provider that natively streams deltas wins over configured synthesis
 * (there is nothing for synthesis to add), which in turn wins over the bare
 * utterance-level default every provider gets without setting anything.
 */
export function resolveGranularity(
  config: TranscriptionServerConfig,
  provider: RealtimeTranscriptionProvider,
): RealtimeGranularity {
  if (provider.granularity === 'native-delta') return 'native-delta';
  if (config.synthesizeDeltas) return 'synthesized-delta';
  return provider.granularity ?? 'utterance';
}
