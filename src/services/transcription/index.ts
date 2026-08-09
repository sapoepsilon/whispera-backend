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

export {
  readTranscriptionServers,
  resolveBaseUrl,
  hasCapability,
  TRANSCRIPTION_CAPABILITIES,
  DEFAULT_SERVER_ID,
  DEFAULT_REALTIME_PATH,
  OPENAI_DEFAULT_BASE_URL,
} from './servers.js';
export type {
  TranscriptionCapability,
  TranscriptionServerConfig,
  TranscriptionServersEnv,
} from './servers.js';

export {
  TranscriptionServerRegistry,
  REALTIME_AUDIO_FORMAT,
  REALTIME_STREAM_PATH,
  PROBE_CACHE_MS,
  PROBE_TIMEOUT_MS,
} from './registry.js';
export type {
  TranscriptionServerSummary,
  TranscriptionServerStatus,
  TranscriptionRegistryDeps,
} from './registry.js';

export type {
  RealtimeFrame,
  RealtimeConnectOptions,
  RealtimeSessionListeners,
  RealtimeTranscriptionProvider,
  RealtimeTranscriptionSession,
} from './realtime/types.js';

export {
  OpenAIRealtimeTranscriptionProvider,
  OPENAI_REALTIME_PROVIDER_NAME,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  toWebSocketUrl,
} from './realtime/openai-realtime.js';
export type { OpenAIRealtimeProviderConfig } from './realtime/openai-realtime.js';

export {
  RealtimeBridge,
  sanitiseCloseCode,
  realtimeErrorFrame,
  CLOSE_BAD_REQUEST,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNKNOWN_SERVER,
  CLOSE_UPSTREAM_FAILED,
  CLOSE_BACKPRESSURE,
} from './realtime/proxy.js';
export type { RealtimeProxyOptions, RealtimeProxyLogger } from './realtime/proxy.js';
