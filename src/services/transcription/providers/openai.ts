import { resolvePlatformApiKey } from '../../billing/bypass.js';
import { OpenAICompatibleTranscriptionProvider } from './base.js';

/** Provider id reported to clients; unchanged from the pre-pluggable route. */
export const OPENAI_TRANSCRIPTION_PROVIDER_NAME = 'openai-whisper';

/**
 * Default provider: stock OpenAI Whisper. Deliberately passes no baseURL so the
 * AI SDK keeps honouring OPENAI_BASE_URL exactly as it did before this layer
 * existed.
 */
export class OpenAITranscriptionProvider extends OpenAICompatibleTranscriptionProvider {
  readonly name = OPENAI_TRANSCRIPTION_PROVIDER_NAME;

  protected resolveApiKey(): string {
    const apiKey = this.config.apiKey ?? resolvePlatformApiKey(process.env.OPENAI_API_KEY);
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required for transcription');
    }
    return apiKey;
  }
}
