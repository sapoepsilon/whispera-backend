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
    transcription/       # pluggable speech-to-text backend for POST /transcribe
      types.ts           # TranscriptionProvider/Request/Result interfaces
      mimetypes.ts       # accepted upload formats
      factory.ts         # createTranscriptionProvider() (env-driven selection)
      providers/         # base.ts (OpenAI audio API), openai.ts, custom-base-url.ts
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

## Transcription Providers (POST /transcribe)

The transcription backend is pluggable. `createTranscriptionProvider()` reads the
environment, validates it, and returns a `TranscriptionProvider`; the route only
sees that interface and never names an implementation. An unknown provider name
or incomplete provider config throws at route registration, so the server fails
to start rather than failing on the first upload.

```ts
interface TranscriptionProvider {
  readonly name: string;                                     // reported as `provider` in the response
  supportsMimetype(mimetype: string): boolean;
  transcribe(req: { audio: Buffer; mimetype: string; language?: string }):
    Promise<{ text: string; language: string; duration: number; provider: string }>;
}
```

Implementations (both speak the OpenAI audio API via `experimental_transcribe`):

- `OpenAITranscriptionProvider` — the default. Passes no `baseURL`, so the AI SDK
  keeps honouring `OPENAI_BASE_URL` exactly as before. Reports `openai-whisper`.
- `CustomBaseUrlTranscriptionProvider` — same wire protocol against an arbitrary
  endpoint (self-hosted whisper server, proxy, gateway). Reports `openai-compatible`.

Environment variables (all optional; absent config reproduces the previous
hard-coded OpenAI Whisper behaviour exactly):

| Variable | Default | Notes |
| --- | --- | --- |
| `TRANSCRIPTION_PROVIDER` | `openai` | `openai` or `custom`. Any other value fails at boot. |
| `TRANSCRIPTION_BASE_URL` | — | **Required for `custom`.** OpenAI-compatible root, e.g. `http://localhost:8000/v1`. Must be an `http(s)` URL. |
| `TRANSCRIPTION_API_KEY` | — | Key override. Both providers fall back to `OPENAI_API_KEY`; `custom` additionally falls back to a placeholder bearer for auth-free endpoints. |
| `TRANSCRIPTION_MODEL` | `whisper-1` | Model id posted to `/audio/transcriptions`. |

```bash
# Self-hosted whisper server
TRANSCRIPTION_PROVIDER=custom
TRANSCRIPTION_BASE_URL=http://localhost:8000/v1
TRANSCRIPTION_MODEL=faster-whisper-large-v3
```

## Streaming Transcription (`GET /transcription/servers`, `WS /transcription/stream`)

Batch is request/response, so streaming gets a sibling interface rather than a
reinterpretation of `TranscriptionProvider`. `TranscriptionServerRegistry` sits
above both and resolves a server id to whichever one a caller needs, so routes
never name an implementation.

```ts
interface RealtimeTranscriptionProvider {
  readonly name: string;
  connect(options, listeners): Promise<RealtimeTranscriptionSession>;
}

interface RealtimeTranscriptionSession {
  readonly provider: string;
  readonly open: boolean;
  readonly bufferedBytes: number;      // the proxy's backpressure signal
  send(frame: { data: string | Buffer; isBinary: boolean }): void;
  pause(): void; resume(): void;
  close(code?: number, reason?: string): void;
}
```

Frames are opaque: the OpenAI Realtime event shape is the contract between the
client and the engine, and the proxy carries it verbatim. An engine speaking a
different protocol (a streaming Nemotron checkpoint, say) implements
`RealtimeTranscriptionProvider` and translates inside itself — no route changes.

`TRANSCRIPTION_SERVERS` holds a JSON array; when absent, one entry is
synthesised from the `TRANSCRIPTION_*` vars above so existing deployments are
unchanged. That synthesised entry advertises only `batch` — nothing in the
legacy env says an endpoint speaks the Realtime API.

| Field | Default | Notes |
| --- | --- | --- |
| `id` | — | **Required**, unique. What the client passes as `?server=`. |
| `label` | the `id` | Human-facing name for a server picker. |
| `baseUrl` | AI SDK resolution | OpenAI-compatible root. Must be `http(s)`. |
| `apiKey` | `OPENAI_API_KEY` | Per-server override. Never returned to a client. |
| `model` | `whisper-1` | Model id. |
| `capabilities` | `["batch"]` | `batch`, `realtime`, or both. |
| `realtimePath` | `/realtime` | Appended to `baseUrl` for the upgrade. |

```bash
TRANSCRIPTION_SERVERS='[{"id":"speaches-lan","label":"Speaches (LAN)","baseUrl":"http://192.168.50.140:8000/v1","model":"Systran/faster-distil-whisper-large-v3","capabilities":["batch","realtime"]}]'
```

Two things about speaches that the code depends on and that are easy to get
wrong (both verified on the wire):

- **The realtime path has no trailing slash.** `GET /v1/realtime` 307s to
  `/v1/realtime/`, but the *upgrade* to the slashed form answers HTTP 500.
- **Audio is 24 kHz** PCM16 mono LE, base64'd into `input_audio_buffer.append`.
  Sending 16 kHz is not rejected — it is time-compressed. `GET
  /transcription/servers` reports the required format in `realtime.audio` so
  clients do not have to know this.

Auth runs on the upgrade request, so an unauthenticated client is refused with
HTTP 401 and never reaches a WebSocket. Later refusals close with an application
code — 4404 unknown server, 4400 not realtime-capable, 1011 engine failure, 1013
a peer could not keep up — plus an error frame in the engine's own envelope.

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

### Vercel AI SDK — Unified Provider Interface
The backend uses `ai` with `@ai-sdk/openai` and `@ai-sdk/anthropic`. Per-request BYOK
is implemented by calling `createOpenAI({ apiKey })` / `createAnthropic({ apiKey })`
inside the handler so each request gets its own client.

```ts
import { generateText, streamText, experimental_transcribe as transcribe } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';

// Chat — Anthropic (BYOK)
const claude = createAnthropic({ apiKey: userKey })('claude-sonnet-4-6-20250501');
const result = await generateText({
  model: claude,
  system: 'You are helpful.',
  messages: [{ role: 'user', content: 'Hello' }],
  maxOutputTokens: 1024,
});
// result.text, result.usage.inputTokens, result.usage.outputTokens

// Chat — OpenAI (BYOK)
const gpt = createOpenAI({ apiKey: userKey })('gpt-4o');
const result2 = await generateText({ model: gpt, messages });

// Streaming — provider-agnostic
const stream = streamText({ model: claude, messages });
for await (const delta of stream.textStream) yield delta;

// Whisper transcription
const openai = createOpenAI({ apiKey: userKey });
const t = await transcribe({
  model: openai.transcription('whisper-1'),
  audio: new Uint8Array(buffer),
  providerOptions: { openai: { language: 'en' } },
});
// t.text, t.language, t.durationInSeconds
```

## Implementation Phases

Detailed plans in docs/:
1. **API Foundation** (WHI-5,6,7,8,9,10) — scaffold, health check, Docker, Drizzle, pipeline, provider router
2. **Auth** (WHI-21) — registration, login, JWT, refresh tokens
3. **Recipes CRUD** (WHI-11,14,15,16,18) — schema, create/read/update/delete
4. **Execution Engine** (WHI-12,17,19) — context tracking, LLM handler, execute endpoint, SSE
5. **Auth Extensions** (WHI-22,28,29) — BYOK (Claude + OpenAI), OpenAI Codex OAuth, credits/Stripe
6. **Recipe Store** (WHI-13,20,23,25,26) — browse, publish, install community recipes
