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
  },
};

export interface EnvConfig {
  PORT: number;
  HOST: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  NODE_ENV: 'development' | 'production' | 'test';
}
