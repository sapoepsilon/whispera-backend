import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '../../src': path.resolve(__dirname, 'src'),
      '../../../src': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      PORT: '3000',
      HOST: '0.0.0.0',
      DATABASE_URL: 'postgresql://whispera:whispera_secret@localhost:5432/whispera_test',
      JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
      NODE_ENV: 'test',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  },
});
