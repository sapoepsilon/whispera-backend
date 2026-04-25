# Whispera Backend

Voice-to-action backend service. Users speak, transcription happens on-device (Mac/iOS), and this backend runs "prompt recipes" (multi-step LLM pipelines) against providers like Claude and OpenAI.

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript (strict mode, ESM)
- **Framework**: Fastify 5.x with @fastify/autoload for routes and plugins
- **Database**: PostgreSQL 16 via Drizzle ORM (postgres.js driver)
- **Auth**: JWT (@fastify/jwt) with argon2 password hashing
- **Validation**: Zod schemas parsed in route handlers
- **LLM Providers**: @anthropic-ai/sdk (Claude), openai (OpenAI)
- **Payments**: Stripe (credits system)
- **Testing**: Vitest with Fastify inject()
- **Package Manager**: pnpm

## Project Structure

```
src/
  server.ts              # entry point, builds and starts Fastify
  config/env.ts          # env validation with @fastify/env + Zod
  db/
    index.ts             # database connection singleton
    schema/              # Drizzle table definitions (users, recipes, executions, etc.)
  plugins/               # Fastify plugins (auto-loaded before routes)
    db.ts                # decorates fastify.db
    auth.ts              # decorates fastify.authenticate preHandler
  routes/                # route handlers (auto-loaded, directory = prefix)
    health.ts            # GET /health
    transcribe.ts        # POST /transcribe (server-side speech-to-text via Whisper API)
    auth/index.ts        # /auth/register, /auth/login, /auth/refresh, /auth/me
    recipes/index.ts     # CRUD: /recipes
    executions.ts        # POST /recipes/:id/execute, GET /executions/:id
    store/index.ts       # public recipe store
    billing/credits.ts   # credits and Stripe webhooks
  services/
    auth/                # password hashing, token generation
    pipeline/            # step execution engine
      types.ts           # StepType, Step, PipelineContext, StepHandler interfaces
      registry.ts        # StepHandlerRegistry (maps step types to handlers)
      executor.ts        # PipelineExecutor (runs steps sequentially)
      context.ts         # ExecutionContext (tracks state across steps)
      handlers/llm.ts    # LLM step handler with template interpolation
    providers/           # LLM provider abstraction
      types.ts           # Message, LLMProvider, LLMResponse interfaces
      router.ts          # ProviderRouter (selects provider by user config)
      adapters/          # claude.ts, openai.ts, base.ts
    recipes/index.ts     # RecipeService (CRUD operations)
    store/index.ts       # StoreService (browse, publish, install)
    billing/             # CreditService, StripeService
    crypto/index.ts      # AES-256-GCM encrypt/decrypt for OAuth tokens only
tests/
  phase-1/ through phase-6/  # organized by implementation phase
```

## Architecture Patterns

- **Plugin autoload**: plugins/ loads before routes/ — plugins decorate fastify instance, routes consume decorators
- **Auth**: JWT access tokens (15min) + refresh tokens (7d rotation). `fastify.authenticate` preHandler on protected routes
- **Request validation**: Zod schemas parsed inside handlers, ZodError caught by global error handler returning 400
- **Database**: Drizzle ORM with typed schemas. Use `db.insert().returning()` and `db.update().where().returning()` for atomic operations
- **Soft deletes**: recipes use `deletedAt` column, always filter with `isNull(recipes.deletedAt)`
- **Provider routing**: ProviderRouter resolves keys in order: X-Provider-Key header (pass-through BYOK, never stored) → Codex OAuth (OpenAI only) → platform key + credits → error
- **Pipeline execution**: PipelineExecutor iterates steps sequentially, each StepHandler produces output that feeds the next step's input
- **SSE streaming**: use `reply.hijack()` + `reply.raw.writeHead()` for Server-Sent Events on execute endpoint

## Provider Integration

- **Claude**: Pass-through BYOK only (Anthropic bans third-party subscription OAuth). Client stores key in OS Keychain, sends via `X-Provider-Key` header per request. Backend never stores the key. SDK: `@anthropic-ai/sdk`
- **OpenAI**: Pass-through BYOK + Codex OAuth ("Sign in with ChatGPT"). Users can send API key via header OR authenticate via PKCE OAuth using their ChatGPT subscription. SDK: `openai`. Codex OAuth docs: developers.openai.com/codex/auth
- **Client-side Claude Code integration** (future, WHI-34): Mac app wraps local Claude Code CLI via `@anthropic-ai/claude-agent-sdk` for subscription access

## Key Conventions

- All routes export `default async function(fastify: FastifyInstance)`
- Services are classes instantiated at route registration, not singletons
- DB schemas in src/db/schema/ re-exported from src/db/schema/index.ts
- Type augmentations for Fastify via `declare module 'fastify'` in plugin files (not in a separate .d.ts — ambient declarations shadow the package types)
- Migrations generated via `pnpm db:generate`, applied via `pnpm db:migrate`
- Tests use `buildApp()` from src/server.ts and Fastify's `app.inject()` — no supertest

## Commands

```bash
pnpm dev          # start dev server with tsx watch
pnpm build        # compile TypeScript
pnpm test         # run all tests (vitest)
pnpm lint         # ESLint
pnpm typecheck    # tsc --noEmit
pnpm db:generate  # generate Drizzle migration
pnpm db:migrate   # apply migrations
pnpm db:push      # push schema directly (dev only)
pnpm db:studio    # Drizzle Studio GUI
```

## SDK Quick Reference (from Context7)

### Fastify — Route + Plugin Pattern
```ts
// Route file (auto-loaded from src/routes/)
import type { FastifyInstance } from 'fastify';
export default async function(fastify: FastifyInstance) {
  fastify.get('/example', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    return reply.send({ ok: true });
  });
}

// Plugin file (auto-loaded from src/plugins/)
import fp from 'fastify-plugin';
export default fp(async (fastify) => {
  fastify.decorate('myService', new MyService());
});

// Testing with inject()
const res = await app.inject({ method: 'GET', url: '/example', headers: { authorization: 'Bearer token' } });
expect(res.statusCode).toBe(200);
```

### Drizzle ORM — Schema + Queries
```ts
// Schema definition
import { pgTable, uuid, varchar, text, jsonb, timestamp, boolean } from 'drizzle-orm/pg-core';
export const recipes = pgTable('recipes', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  steps: jsonb('steps').$type<RecipeStep[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
type Recipe = typeof recipes.$inferSelect;
type NewRecipe = typeof recipes.$inferInsert;

// Queries
await db.insert(recipes).values({ ... }).returning();
await db.update(recipes).set({ name: 'new' }).where(eq(recipes.id, id)).returning();
await db.select().from(recipes).where(and(eq(recipes.userId, userId), isNull(recipes.deletedAt)));
```

### Anthropic SDK — Claude API
```ts
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: userApiKey });

// Non-streaming
const message = await client.messages.create({
  model: 'claude-sonnet-4-6-20250501',
  max_tokens: 1024,
  system: 'You are helpful.',
  messages: [{ role: 'user', content: 'Hello' }],
});
const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');

// Streaming
const stream = client.messages.stream({ model: 'claude-sonnet-4-6-20250501', max_tokens: 1024, messages });
for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
}
const final = await stream.finalMessage(); // usage: final.usage.input_tokens
```

### OpenAI SDK — Chat Completions
```ts
import OpenAI from 'openai';
const client = new OpenAI({ apiKey: userApiKey });

// Non-streaming
const completion = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'system', content: '...' }, { role: 'user', content: '...' }],
});
const text = completion.choices[0]?.message?.content ?? '';
// usage: completion.usage.prompt_tokens, completion.usage.completion_tokens

// Streaming
const stream = await client.chat.completions.create({ model: 'gpt-4o', messages, stream: true, stream_options: { include_usage: true } });
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content;
  if (delta) yield delta;
}
```

## Implementation Phases

Detailed plans in docs/:
1. **API Foundation** (WHI-5,6,7,8,9,10) — scaffold, health check, Docker, Drizzle, pipeline, provider router
2. **Auth** (WHI-21) — registration, login, JWT, refresh tokens
3. **Recipes CRUD** (WHI-11,14,15,16,18) — schema, create/read/update/delete
4. **Execution Engine** (WHI-12,17,19) — context tracking, LLM handler, execute endpoint, SSE
5. **Auth Extensions** (WHI-22,28,29) — BYOK (Claude + OpenAI), OpenAI Codex OAuth, credits/Stripe
6. **Recipe Store** (WHI-13,20,23,25,26) — browse, publish, install community recipes
