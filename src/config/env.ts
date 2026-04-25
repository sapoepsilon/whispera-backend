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
}
