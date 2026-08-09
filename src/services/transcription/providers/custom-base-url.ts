import { resolvePlatformApiKey } from '../../billing/bypass.js';
import {
  OpenAICompatibleTranscriptionProvider,
  type OpenAICompatibleTranscriptionConfig,
} from './base.js';

/** Provider id reported to clients when a custom endpoint served the request. */
export const CUSTOM_TRANSCRIPTION_PROVIDER_NAME = 'openai-compatible';

/**
 * Bearer token sent when nothing is configured. Self-hosted whisper servers and
 * local proxies ignore it; it exists only because the AI SDK refuses to build a
 * client without one.
 */
export const NO_AUTH_PLACEHOLDER_API_KEY = 'custom-transcription-no-auth-required';

export interface CustomBaseUrlTranscriptionConfig
  extends Omit<OpenAICompatibleTranscriptionConfig, 'baseUrl'> {
  /** Required: the OpenAI-compatible root, e.g. http://localhost:8000/v1. */
  baseUrl: string;
}

/**
 * Speaks the OpenAI audio API against an arbitrary endpoint — a self-hosted
 * whisper server, an internal proxy, or any OpenAI-compatible gateway.
 */
export class CustomBaseUrlTranscriptionProvider extends OpenAICompatibleTranscriptionProvider {
  readonly name = CUSTOM_TRANSCRIPTION_PROVIDER_NAME;

  constructor(config: CustomBaseUrlTranscriptionConfig) {
    if (!config.baseUrl) {
      throw new Error('A base URL is required for the custom transcription provider');
    }
    super(config);
  }

  /** Never throws: an auth-free endpoint is a legitimate deployment. */
  protected resolveApiKey(): string {
    return (
      this.config.apiKey ??
      resolvePlatformApiKey(process.env.OPENAI_API_KEY) ??
      NO_AUTH_PLACEHOLDER_API_KEY
    );
  }
}
