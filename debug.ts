import { buildApp } from './src/server.js';

async function main() {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://whispera:whispera_secret@localhost:5432/whispera_test';
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const app = await buildApp();

  const meRes = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: 'Bearer test-clerk-debug-2' },
  });
  console.log('Auth status:', meRes.statusCode);

  const addKeyRes = await app.inject({
    method: 'POST',
    url: '/auth/api-keys',
    headers: { authorization: 'Bearer test-clerk-debug-2' },
    payload: {
      provider: 'anthropic',
      key: 'sk-ant-api03-test-claude-key-valid-1234567890abcdef',
      label: 'My Claude Key',
    },
  });
  console.log('Add key status:', addKeyRes.statusCode, addKeyRes.body);

  await app.close();
}

main().catch(console.error);
