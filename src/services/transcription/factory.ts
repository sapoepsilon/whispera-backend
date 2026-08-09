import { z } from 'zod';

import { CustomBaseUrlTranscriptionProvider } from './providers/custom-base-url.js';
import { OpenAITranscriptionProvider } from './providers/openai.js';
import type { TranscriptionProvider } from './types.js';

export const TRANSCRIPTION_PROVIDER_NAMES = ['openai', 'custom'] as const;
export type TranscriptionProviderName = (typeof TRANSCRIPTION_PROVIDER_NAMES)[number];

/** Absent configuration must behave exactly like the pre-pluggable route. */
export const DEFAULT_TRANSCRIPTION_PROVIDER: TranscriptionProviderName = 'openai';

export interface TranscriptionProviderEnv {
  TRANSCRIPTION_PROVIDER?: string;
  TRANSCRIPTION_BASE_URL?: string;
  TRANSCRIPTION_API_KEY?: string;
  TRANSCRIPTION_MODEL?: string;
}

const nonEmptyString = z.string().trim().min(1);

function readOptional(value: string | undefined): string | null {
  const parsed = nonEmptyString.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readProviderName(value: string | undefined): TranscriptionProviderName {
  const raw = readOptional(value);
  if (raw === null) return DEFAULT_TRANSCRIPTION_PROVIDER;

  const parsed = z.enum(TRANSCRIPTION_PROVIDER_NAMES).safeParse(raw.toLowerCase());
  if (!parsed.success) {
    throw new Error(
      `Unknown TRANSCRIPTION_PROVIDER "${raw}". Supported providers: ` +
        `${TRANSCRIPTION_PROVIDER_NAMES.join(', ')}.`,
    );
  }
  return parsed.data;
}

function readBaseUrl(value: string | undefined): string {
  const raw = readOptional(value);
  if (raw === null) {
    throw new Error(
      'TRANSCRIPTION_BASE_URL is required when TRANSCRIPTION_PROVIDER is "custom".',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`TRANSCRIPTION_BASE_URL must be a valid URL, got "${raw}".`);
  }

  // new URL() happily accepts "localhost:8000" as a custom scheme, which would
  // silently produce an unreachable endpoint.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`TRANSCRIPTION_BASE_URL must be an http(s) URL, got "${raw}".`);
  }
  return raw;
}

/**
 * Builds the provider POST /transcribe runs on. Throws on unknown provider
 * names and on incomplete provider-specific config so a typo fails at boot
 * rather than on the first upload.
 */
export function createTranscriptionProvider(
  env: TranscriptionProviderEnv = process.env,
): TranscriptionProvider {
  const name = readProviderName(env.TRANSCRIPTION_PROVIDER);
  // Undefined, not null: the providers treat it as "resolve from env at call
  // time", which is what keeps the default path lazy.
  const apiKey = readOptional(env.TRANSCRIPTION_API_KEY) ?? undefined;
  const model = readOptional(env.TRANSCRIPTION_MODEL) ?? undefined;

  switch (name) {
    case 'openai':
      return new OpenAITranscriptionProvider({ apiKey, model });
    case 'custom':
      return new CustomBaseUrlTranscriptionProvider({
        apiKey,
        model,
        baseUrl: readBaseUrl(env.TRANSCRIPTION_BASE_URL),
      });
  }
}
