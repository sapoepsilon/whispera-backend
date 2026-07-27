export type {
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from './types.js';

export { SUPPORTED_MIMETYPES, isSupportedMimetype } from './mimetypes.js';

export {
  OpenAICompatibleTranscriptionProvider,
  DEFAULT_TRANSCRIPTION_MODEL,
} from './providers/base.js';
export type {
  OpenAICompatibleTranscriptionConfig,
  FetchImplementation,
} from './providers/base.js';

export {
  OpenAITranscriptionProvider,
  OPENAI_TRANSCRIPTION_PROVIDER_NAME,
} from './providers/openai.js';

export {
  CustomBaseUrlTranscriptionProvider,
  CUSTOM_TRANSCRIPTION_PROVIDER_NAME,
  NO_AUTH_PLACEHOLDER_API_KEY,
} from './providers/custom-base-url.js';
export type { CustomBaseUrlTranscriptionConfig } from './providers/custom-base-url.js';

export {
  createTranscriptionProvider,
  TRANSCRIPTION_PROVIDER_NAMES,
  DEFAULT_TRANSCRIPTION_PROVIDER,
} from './factory.js';
export type { TranscriptionProviderName, TranscriptionProviderEnv } from './factory.js';
