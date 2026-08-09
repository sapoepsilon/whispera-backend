import { z } from 'zod';

import { DEFAULT_TRANSCRIPTION_MODEL } from './providers/base.js';
import { CUSTOM_TRANSCRIPTION_PROVIDER_NAME } from './providers/custom-base-url.js';
import { OPENAI_TRANSCRIPTION_PROVIDER_NAME } from './providers/openai.js';

/**
 * What a configured server can be asked to do. `batch` is POST /transcribe,
 * `realtime` is the WebSocket proxy. A server may advertise either or both.
 */
export const TRANSCRIPTION_CAPABILITIES = ['batch', 'realtime'] as const;
export type TranscriptionCapability = (typeof TRANSCRIPTION_CAPABILITIES)[number];

/** Id given to the entry synthesised from the single-server TRANSCRIPTION_* vars. */
export const DEFAULT_SERVER_ID = 'default';

/**
 * Path appended to a server's base URL for the WebSocket upgrade.
 *
 * No trailing slash, deliberately. speaches 307s the plain-HTTP
 * `GET /v1/realtime` to `/v1/realtime/`, but the *upgrade* to the slashed form
 * answers HTTP 500 — the redirect does not apply to the WS route. Verified on
 * the wire; overridable per server for engines that disagree.
 */
export const DEFAULT_REALTIME_PATH = '/realtime';

/** Fallback when a server declares no base URL and OPENAI_BASE_URL is unset. */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface TranscriptionServerConfig {
  /** Stable key the client passes to /transcription/stream. Unique. */
  readonly id: string;
  /** Human-facing name for a server picker. */
  readonly label: string;
  /**
   * OpenAI-compatible root, e.g. http://host:8000/v1. Undefined means "let the
   * AI SDK resolve it", which is what keeps the stock OpenAI path untouched.
   */
  readonly baseUrl?: string;
  /** Per-server key override. Never leaves the process. */
  readonly apiKey?: string;
  readonly model: string;
  readonly capabilities: readonly TranscriptionCapability[];
  readonly realtimePath: string;
}

export interface TranscriptionServersEnv {
  TRANSCRIPTION_SERVERS?: string;
  TRANSCRIPTION_PROVIDER?: string;
  TRANSCRIPTION_BASE_URL?: string;
  TRANSCRIPTION_API_KEY?: string;
  TRANSCRIPTION_MODEL?: string;
  OPENAI_BASE_URL?: string;
}

const trimmed = z.string().trim().min(1);

const serverEntrySchema = z
  .object({
    id: trimmed,
    label: trimmed.optional(),
    baseUrl: trimmed.optional(),
    apiKey: trimmed.optional(),
    model: trimmed.optional(),
    capabilities: z.array(z.enum(TRANSCRIPTION_CAPABILITIES)).min(1).optional(),
    realtimePath: trimmed.optional(),
  })
  .strict();

type TranscriptionServerEntry = z.infer<typeof serverEntrySchema>;

const serversSchema = z.array(serverEntrySchema).min(1);

function readOptional(value: string | undefined): string | undefined {
  const parsed = trimmed.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Same rejection the single-server factory applies to TRANSCRIPTION_BASE_URL:
 * new URL() accepts "localhost:8000" as a custom scheme, which would silently
 * produce an unreachable endpoint.
 */
function assertHttpUrl(raw: string, context: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${context} must be a valid URL, got "${raw}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${context} must be an http(s) URL, got "${raw}".`);
  }
  // A base URL that keeps its trailing slash would join to "//realtime".
  return raw.replace(/\/+$/, '');
}

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function toConfig(entry: TranscriptionServerEntry): TranscriptionServerConfig {
  const baseUrl = entry.baseUrl
    ? assertHttpUrl(entry.baseUrl, `TRANSCRIPTION_SERVERS[${entry.id}].baseUrl`)
    : undefined;

  return {
    id: entry.id,
    label: entry.label ?? entry.id,
    ...(baseUrl ? { baseUrl } : {}),
    ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
    model: entry.model ?? DEFAULT_TRANSCRIPTION_MODEL,
    capabilities: entry.capabilities ?? ['batch'],
    realtimePath: entry.realtimePath ?? DEFAULT_REALTIME_PATH,
  };
}

/**
 * Rebuilds the single-server TRANSCRIPTION_* configuration as a one-entry list,
 * so a deployment that never heard of TRANSCRIPTION_SERVERS behaves exactly as
 * it did before this layer existed.
 *
 * Only `batch` is advertised: nothing in the legacy env says an endpoint speaks
 * the Realtime API, and guessing would make the discovery route lie.
 */
function synthesiseLegacyServer(env: TranscriptionServersEnv): TranscriptionServerConfig {
  const provider = readOptional(env.TRANSCRIPTION_PROVIDER)?.toLowerCase();
  const baseUrl = readOptional(env.TRANSCRIPTION_BASE_URL);

  if (provider === 'custom') {
    if (!baseUrl) {
      throw new Error(
        'TRANSCRIPTION_BASE_URL is required when TRANSCRIPTION_PROVIDER is "custom".',
      );
    }
    return {
      id: DEFAULT_SERVER_ID,
      label: CUSTOM_TRANSCRIPTION_PROVIDER_NAME,
      baseUrl: assertHttpUrl(baseUrl, 'TRANSCRIPTION_BASE_URL'),
      ...(readOptional(env.TRANSCRIPTION_API_KEY)
        ? { apiKey: readOptional(env.TRANSCRIPTION_API_KEY) }
        : {}),
      model: readOptional(env.TRANSCRIPTION_MODEL) ?? DEFAULT_TRANSCRIPTION_MODEL,
      capabilities: ['batch'],
      realtimePath: DEFAULT_REALTIME_PATH,
    };
  }

  return {
    id: DEFAULT_SERVER_ID,
    label: OPENAI_TRANSCRIPTION_PROVIDER_NAME,
    ...(readOptional(env.TRANSCRIPTION_API_KEY)
      ? { apiKey: readOptional(env.TRANSCRIPTION_API_KEY) }
      : {}),
    model: readOptional(env.TRANSCRIPTION_MODEL) ?? DEFAULT_TRANSCRIPTION_MODEL,
    capabilities: ['batch'],
    realtimePath: DEFAULT_REALTIME_PATH,
  };
}

/**
 * Reads the configured transcription servers.
 *
 * Throws on malformed JSON, a failed schema check, duplicate ids and unusable
 * base URLs, so a typo fails at boot rather than on the first upload or socket.
 */
export function readTranscriptionServers(
  env: TranscriptionServersEnv = process.env,
): TranscriptionServerConfig[] {
  const raw = readOptional(env.TRANSCRIPTION_SERVERS);
  if (raw === undefined) return [synthesiseLegacyServer(env)];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'TRANSCRIPTION_SERVERS must be a JSON array of server objects; it did not parse as JSON.',
    );
  }

  const result = serversSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `TRANSCRIPTION_SERVERS is not a valid server list: ${formatIssues(result.error.issues)}.`,
    );
  }

  const configs = result.data.map(toConfig);

  const seen = new Set<string>();
  for (const config of configs) {
    if (seen.has(config.id)) {
      throw new Error(`TRANSCRIPTION_SERVERS contains duplicate server id "${config.id}".`);
    }
    seen.add(config.id);
  }

  return configs;
}

/** The endpoint a server's requests actually go to, once defaults are applied. */
export function resolveBaseUrl(
  config: TranscriptionServerConfig,
  env: Pick<TranscriptionServersEnv, 'OPENAI_BASE_URL'> = process.env,
): string {
  return config.baseUrl ?? readOptional(env.OPENAI_BASE_URL) ?? OPENAI_DEFAULT_BASE_URL;
}

export function hasCapability(
  config: TranscriptionServerConfig,
  capability: TranscriptionCapability,
): boolean {
  return config.capabilities.includes(capability);
}
