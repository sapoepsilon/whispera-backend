import { z } from 'zod';

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

export const zodEnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(32),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type EnvConfig = z.infer<typeof zodEnvSchema>;
