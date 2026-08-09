export const envSchema = {
  type: 'object' as const,
  required: ['DATABASE_URL', 'JWT_SECRET'],
  properties: {
    PORT: { type: 'number' as const, default: 3000 },
    HOST: { type: 'string' as const, default: '0.0.0.0' },
    DATABASE_URL: { type: 'string' as const },
    JWT_SECRET: { type: 'string' as const },
    NODE_ENV: {
      type: 'string' as const,
      default: 'development',
      enum: ['development', 'production', 'test'],
    },
    CLERK_SECRET_KEY: { type: 'string' as const },
    ENCRYPTION_KEY: { type: 'string' as const },
    STRIPE_SECRET_KEY: { type: 'string' as const },
    STRIPE_WEBHOOK_SECRET: { type: 'string' as const },
    FRONTEND_URL: { type: 'string' as const, default: 'http://localhost:5173' },
    OPENAI_CLIENT_ID: { type: 'string' as const },
    OPENAI_REDIRECT_URI: { type: 'string' as const },
    ANTHROPIC_API_KEY: { type: 'string' as const },
    OPENAI_API_KEY: { type: 'string' as const },
    // Base URLs for OpenAI-compatible / Anthropic-compatible proxies. Read
    // directly by the AI SDK providers; declared here so they are documented
    // and surfaced on fastify.config.
    OPENAI_BASE_URL: { type: 'string' as const },
    ANTHROPIC_BASE_URL: { type: 'string' as const },
    // Staging escape hatch: treat every request as a fully paid subscriber.
    // Absent or falsy means normal billing behaviour.
    BILLING_BYPASS: { type: 'string' as const },
    // Model ids used by seeded recipes and /polish. Default to gpt-4o-mini.
    DEFAULT_RECIPE_MODEL: { type: 'string' as const },
    POLISH_MODEL: { type: 'string' as const },
    // Pluggable transcription backend for POST /transcribe.
    // TRANSCRIPTION_PROVIDER: 'openai' (default) | 'custom'. An unknown value
    // makes the server fail to start.
    TRANSCRIPTION_PROVIDER: { type: 'string' as const },
    // Required for 'custom': OpenAI-compatible root, e.g. http://localhost:8000/v1.
    TRANSCRIPTION_BASE_URL: { type: 'string' as const },
    // Optional key override; both providers fall back to OPENAI_API_KEY.
    TRANSCRIPTION_API_KEY: { type: 'string' as const },
    // Optional model id override; defaults to whisper-1.
    TRANSCRIPTION_MODEL: { type: 'string' as const },
    // Multi-server transcription config: a JSON array of
    // { id, label?, baseUrl?, apiKey?, model?, capabilities?, realtimePath? }.
    // Drives GET /transcription/servers and WS /transcription/stream. When
    // absent, a single entry is synthesised from the TRANSCRIPTION_* vars above
    // so existing deployments are unchanged. A server must list "realtime" in
    // its capabilities before it can be streamed to.
    TRANSCRIPTION_SERVERS: { type: 'string' as const },
  },
};

export interface EnvConfig {
  PORT: number;
  HOST: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  NODE_ENV: 'development' | 'production' | 'test';
  CLERK_SECRET_KEY?: string;
  ENCRYPTION_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  FRONTEND_URL?: string;
  OPENAI_CLIENT_ID?: string;
  OPENAI_REDIRECT_URI?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  ANTHROPIC_BASE_URL?: string;
  BILLING_BYPASS?: string;
  DEFAULT_RECIPE_MODEL?: string;
  POLISH_MODEL?: string;
  TRANSCRIPTION_PROVIDER?: string;
  TRANSCRIPTION_BASE_URL?: string;
  TRANSCRIPTION_API_KEY?: string;
  TRANSCRIPTION_MODEL?: string;
  TRANSCRIPTION_SERVERS?: string;
}
